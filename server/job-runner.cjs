'use strict';

/**
 * 轻量级持久化后台异步任务管理器
 * - AI 复盘、文献转化、以及 Stage 4 Python 量化同步/回测/环境初始化全部在服务端后台异步执行；
 * - 支持实时进度百分比 (pct)、结构化日志环缓冲 (logs)、以及取消正在运行的任务 (cancelJob / ctx.onCancel)；
 * - 任务元数据持久化至 jobs_cache/，刷新页面也可随时恢复进度与结果。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { stateSubDir } = require('./app-paths.cjs');
const { atomicWriteFileSync } = require('./lru-cache.cjs');
const JOBS_DIR = stateSubDir('jobs_cache');
const MAX_MEM_JOBS = 25;
const MAX_DISK_JOBS = 40;
const jobs = new Map();
const cancelHandlers = new Map();

function ensureDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

function pruneJobCaches() {
  try {
    // 1. 限制内存 Map 上限，较老已完成任务剥离大体积 result（getJob 时按需从磁盘加载）
    if (jobs.size > MAX_MEM_JOBS) {
      const sorted = [...jobs.values()].sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
      for (const old of sorted) {
        if (jobs.size <= MAX_MEM_JOBS) break;
        if (old.status !== 'running') {
          jobs.delete(old.id);
        }
      }
    }
    const finished = [...jobs.values()]
      .filter((j) => j.status !== 'running' && j.result)
      .sort((a, b) => (b.finishedAt || b.startedAt || '').localeCompare(a.finishedAt || a.startedAt || ''));
    for (const old of finished.slice(5)) {
      old._resultOffloaded = true;
      old.result = null;
    }

    // 2. 限制磁盘 jobs_cache/ 滚动保留最新 40 份，避免长期运行无限膨胀
    if (fs.existsSync(JOBS_DIR)) {
      const files = fs
        .readdirSync(JOBS_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort();
      if (files.length > MAX_DISK_JOBS) {
        for (const f of files.slice(0, files.length - MAX_DISK_JOBS)) {
          try {
            fs.unlinkSync(path.join(JOBS_DIR, f));
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // non-fatal
  }
}

function persistJob(job) {
  try {
    ensureDir();
    atomicWriteFileSync(path.join(JOBS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2), 'utf8');
  } catch {
    // non-fatal
  }
}

// 启动时恢复最近 15 条历史任务（运行中因服务重启中断的标为 failed）
function loadPersistedJobs() {
  if (!fs.existsSync(JOBS_DIR)) return;
  const files = fs
    .readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .slice(-18);
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8'));
      if (data && data.id) {
        if (data.status === 'running') {
          data.status = 'failed';
          data.error = '本地服务已重启，该后台任务已中断，请重新发起。';
          data.finishedAt = new Date().toISOString();
        }
        if (typeof data.pct !== 'number') data.pct = data.status === 'completed' ? 100 : 0;
        if (!Array.isArray(data.logs)) data.logs = [];
        jobs.set(data.id, data);
      }
    } catch {
      // ignore corrupted
    }
  }
}

loadPersistedJobs();

/**
 * 启动一个后台异步任务，立即返回 job 摘要对象
 */
function startJob({ kind, title, meta = {}, runner }) {
  const id = `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const job = {
    id,
    kind, // 'daily_review' | 'ingest_methodology' | 'ingest_cognition' | 'judgment_draft' | 'intel_digest' | 'quant_sync' | 'quant_backtest' | 'quant_setup'
    title,
    stage: '',
    pct: 0,
    logs: [],
    status: 'running', // 'running' | 'completed' | 'failed' | 'cancelled'
    startedAt: new Date().toISOString(),
    finishedAt: null,
    meta,
    result: null,
    error: null,
  };
  jobs.set(id, job);
  cancelHandlers.set(id, []);
  persistJob(job);

  let lastPersistMs = Date.now();
  const maybePersist = (force = false) => {
    const now = Date.now();
    if (force || now - lastPersistMs >= 450) {
      lastPersistMs = now;
      persistJob(job);
    }
  };

  const ctx = {
    jobId: id,
    isCancelled() {
      return job.status === 'cancelled';
    },
    onCancel(fn) {
      if (typeof fn !== 'function') return;
      if (job.status === 'cancelled') {
        try {
          fn();
        } catch {
          // ignore
        }
        return;
      }
      const list = cancelHandlers.get(id);
      if (list) list.push(fn);
    },
    update(patch = {}) {
      if (job.status !== 'running') return;
      if (typeof patch.stage === 'string') job.stage = patch.stage;
      if (typeof patch.pct === 'number' && Number.isFinite(patch.pct)) {
        job.pct = Math.max(0, Math.min(100, Math.round(patch.pct * 10) / 10));
      }
      if (patch.meta && typeof patch.meta === 'object') {
        job.meta = { ...job.meta, ...patch.meta };
      }
      if (patch.log) {
        const entry =
          typeof patch.log === 'string'
            ? { time: new Date().toISOString(), level: 'info', msg: patch.log }
            : {
                time: new Date().toISOString(),
                level: patch.log.level || 'info',
                msg: String(patch.log.msg || ''),
              };
        if (entry.msg) {
          job.logs.push(entry);
          if (job.logs.length > 60) job.logs = job.logs.slice(-60);
        }
      }
      maybePersist(false);
    },
  };

  Promise.resolve()
    .then(() => runner(ctx))
    .then((result) => {
      cancelHandlers.delete(id);
      if (job.status === 'cancelled') return;
      job.status = 'completed';
      job.stage = '';
      job.pct = 100;
      job.finishedAt = new Date().toISOString();
      job.result = result;
      persistJob(job);
      pruneJobCaches();
    })
    .catch((err) => {
      cancelHandlers.delete(id);
      if (job.status === 'cancelled') return;
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = err?.message || String(err);
      persistJob(job);
      pruneJobCaches();
    });

  return summarizeJob(job);
}

/**
 * 取消一个正在运行的后台任务（会触发所有已注册的 ctx.onCancel 清理钩子，如终止 Python 子进程）
 */
function cancelJob(id, reason = '用户已手动取消任务') {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: '未找到指定任务' };
  if (job.status !== 'running') {
    return { ok: true, alreadyFinished: true, job: summarizeJob(job) };
  }
  job.status = 'cancelled';
  job.stage = '已取消';
  job.error = reason;
  job.finishedAt = new Date().toISOString();
  job.logs.push({ time: job.finishedAt, level: 'warn', msg: reason });
  if (job.logs.length > 60) job.logs = job.logs.slice(-60);

  const handlers = cancelHandlers.get(id) || [];
  cancelHandlers.delete(id);
  for (const fn of handlers) {
    try {
      fn();
    } catch {
      // non-fatal
    }
  }
  persistJob(job);
  return { ok: true, job: summarizeJob(job) };
}

function summarizeJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    stage: job.stage || '',
    pct: typeof job.pct === 'number' ? job.pct : job.status === 'completed' ? 100 : 0,
    logs: Array.isArray(job.logs) ? job.logs.slice(-15) : [],
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    meta: job.meta,
    error: job.error,
    hasResult: Boolean(job.result),
  };
}

function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
    .slice(0, 15)
    .map(summarizeJob);
}

function getJob(id) {
  const mem = jobs.get(id);
  if (mem && !mem._resultOffloaded) return mem;
  const p = path.join(JOBS_DIR, `${String(id || '').replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch {
    // fallback
  }
  return mem || null;
}

function cancelAllRunningJobs(reason = '服务端优雅关闭，正在中止后台任务') {
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      cancelJob(job.id, reason);
    }
  }
}

module.exports = {
  startJob,
  cancelJob,
  cancelAllRunningJobs,
  listJobs,
  getJob,
};
