'use strict';

/**
 * 脱敏诊断包导出服务（GET /api/maintenance/diagnostic-zip）
 *
 * 合规与隐私铁律：
 * - 零外部 npm 依赖，使用 Node.js 内置 zlib 实现标准 PKZIP (DEFLATE) 归档；
 * - 严格排除所有 API Key、Webhook Token、Ed25519 私钥、本机用户路径、三库正文 Markdown 与交易账本交割明细；
 * - 仅导出版本/系统摘要、质检计数、数据源模式状态（脱敏）、量化环境就绪布尔值与脱敏清单说明。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { getStateDir } = require('./app-paths.cjs');
const { getEditionInfo } = require('./edition.cjs');
const { getLicenseStatus } = require('./license-service.cjs');
const { getEntitlementsSnapshot } = require('./entitlement-guard.cjs');
const { getEulaStatus } = require('./eula-service.cjs');
const { loadWorkspace } = require('./knowledge-store.cjs');
const { runQualityAudit } = require('./auditor.cjs');
const { getSafeConfigForClient } = require('./ai-config.cjs');
const { getSafeDataSourceConfig } = require('./data-source-config.cjs');
const { detectQuantEnv } = require('./quant-bridge.cjs');
const { listJobs } = require('./job-runner.cjs');

const RECENT_ERROR_BUFFER = [];
const MAX_RECENT_ERRORS = 30;

// Standard IEEE 802.3 CRC32 table
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 构建标准 PKZIP 缓冲区（兼容 Windows 资源管理器 / macOS / Python zipfile）
 */
function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((Math.floor(now.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
    const rawBuf = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), 'utf8');
    const compBuf = zlib.deflateRawSync(rawBuf, { level: 6 });
    const crc = crc32(rawBuf);

    // Local File Header (30 bytes)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // signature
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    lfh.writeUInt16LE(8, 8); // method: deflate
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compBuf.length, 18);
    lfh.writeUInt32LE(rawBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len

    localParts.push(lfh, nameBuf, compBuf);

    // Central Directory Header (46 bytes)
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8); // UTF-8 flag
    cdh.writeUInt16LE(8, 10); // deflate
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compBuf.length, 20);
    cdh.writeUInt32LE(rawBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra len
    cdh.writeUInt16LE(0, 32); // comment len
    cdh.writeUInt16LE(0, 34); // disk start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + compBuf.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function redactPathsAndSecrets(str) {
  return String(str || '')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|SRW[12]\.[A-Za-z0-9_.-]{16,})\b/g, '<REDACTED_SECRET>')
    .replace(/(https?:\/\/[^\s"'<>]*?(?:hook|webhook|token|key|secret)=?)[^\s"'&<>]+/gi, '$1<REDACTED>')
    .replace(/[A-Za-z]:[\\/][^\s"',;]+/g, '<REDACTED_LOCAL_PATH>')
    .replace(/\/Users\/[^\s"',;]+/g, '<REDACTED_LOCAL_PATH>');
}

function recordServerError(err, context = 'server') {
  try {
    const message = redactPathsAndSecrets(err?.message || String(err || 'Unknown error')).slice(0, 500);
    const stack = redactPathsAndSecrets(err?.stack || '').split('\n').slice(0, 8).join('\n').slice(0, 1200);
    RECENT_ERROR_BUFFER.push({
      at: new Date().toISOString(),
      context: String(context || 'server').slice(0, 120),
      message,
      stack,
    });
    if (RECENT_ERROR_BUFFER.length > MAX_RECENT_ERRORS) {
      RECENT_ERROR_BUFFER.splice(0, RECENT_ERROR_BUFFER.length - MAX_RECENT_ERRORS);
    }
  } catch {
    // non-fatal
  }
}

function readRedactedLauncherLogTail(maxBytes = 16384) {
  const stateDir = getStateDir();
  const crashFiles = (() => {
    try {
      return fs
        .readdirSync(stateDir)
        .filter((f) => /^launcher-crash-.*\.log$/i.test(f))
        .sort()
        .slice(-3);
    } catch {
      return [];
    }
  })();
  const candidates = ['launcher.log', 'launcher.prev.log', ...crashFiles];
  const sections = [];
  for (const name of candidates) {
    const filePath = path.join(stateDir, name);
    try {
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      if (stat.size <= 0) continue;
      const readLen = Math.min(stat.size, maxBytes);
      const start = Math.max(0, stat.size - readLen);
      const buf = Buffer.alloc(readLen);
      const fd = fs.openSync(filePath, 'r');
      try {
        fs.readSync(fd, buf, 0, readLen, start);
      } finally {
        fs.closeSync(fd);
      }
      sections.push(`===== ${name} (tail ${readLen} bytes) =====\n${redactPathsAndSecrets(buf.toString('utf8'))}`);
    } catch {
      // ignore
    }
  }
  return sections.length > 0 ? sections.join('\n\n') : '(当前状态目录无 launcher.log 或以纯命令行模式运行)';
}

function collectSanitizedDiagnostics(port = 3721) {
  const ed = getEditionInfo();
  const lic = getLicenseStatus();
  const ents = getEntitlementsSnapshot(lic);
  const eula = getEulaStatus();

  let wsStats = null;
  let auditSummary = null;
  try {
    const ws = loadWorkspace();
    wsStats = {
      methodologyVersion: ws.methodology?.meta?.version || null,
      methodologyActiveCount: ws.methodology?.stats?.activeCount ?? null,
      cognitionVersion: ws.cognition?.meta?.version || null,
      cognitionTotalCount: ws.cognition?.stats?.totalCount ?? null,
      ledgerVersion: ws.ledger?.meta?.version || null,
      dailyReviewCount: ws.ledger?.stats?.dailyReviewCount ?? null,
      judgmentCount: ws.ledger?.stats?.judgmentCount ?? null,
    };
    const audit = runQualityAudit(ws);
    auditSummary = {
      checkedAt: audit.summary?.checkedAt || new Date().toISOString(),
      errorCount: audit.summary?.errorCount ?? 0,
      warningCount: audit.summary?.warningCount ?? 0,
      infoCount: audit.summary?.infoCount ?? 0,
      issueCodes: (audit.issues || []).slice(0, 50).map((it) => ({
        severity: it.severity,
        category: it.category,
        rule: it.rule || '',
      })),
    };
  } catch (err) {
    wsStats = { error: redactPathsAndSecrets(err.message) };
  }

  let aiSafe = null;
  try {
    const cfg = getSafeConfigForClient();
    aiSafe = {
      activeProvider: cfg.provider,
      hasDeepseekKey: Boolean(cfg.deepseek?.hasApiKey),
      hasOpenaiKey: Boolean(cfg.openai?.hasApiKey),
      hasGeminiKey: Boolean(cfg.gemini?.hasApiKey),
      hasQwenKey: Boolean(cfg.qwen?.hasApiKey),
      hasKimiKey: Boolean(cfg.moonshot?.hasApiKey),
      hasGlmKey: Boolean(cfg.zhipu?.hasApiKey),
      hasCustomKey: Boolean(cfg.custom?.hasApiKey),
      codexCliReady: Boolean(cfg.codex_cli?.installed),
      geminiCliReady: Boolean(cfg.gemini_cli?.installed),
    };
  } catch {
    aiSafe = { unavailable: true };
  }

  let dataSourcesSafe = null;
  try {
    const ds = getSafeDataSourceConfig(port);
    const channels = {};
    for (const [k, v] of Object.entries(ds.channels || {})) {
      channels[k] = {
        mode: v.mode,
        preset: v.preset,
        hasApiKey: Boolean(v.hasApiKey),
        fallbackOnError: Boolean(v.fallbackOnError),
      };
    }
    dataSourcesSafe = {
      channels,
      capabilities: ds.capabilities || {},
    };
  } catch {
    dataSourcesSafe = { unavailable: true };
  }

  let quantSafe = null;
  try {
    const qEnv = detectQuantEnv();
    quantSafe = {
      pythonFound: Boolean(qEnv.pythonFound),
      pythonVersion: qEnv.pythonVersion || null,
      depsReady: Boolean(qEnv.depsReady),
      duckdbReady: Boolean(qEnv.packages?.duckdb),
      pandasReady: Boolean(qEnv.packages?.pandas),
      numpyReady: Boolean(qEnv.packages?.numpy),
    };
  } catch {
    quantSafe = { unavailable: true };
  }

  const mem = process.memoryUsage();
  let recentFailedJobs = [];
  try {
    recentFailedJobs = (listJobs() || [])
      .filter((j) => j.status === 'failed')
      .slice(0, 15)
      .map((j) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        error: redactPathsAndSecrets(j.error || ''),
      }));
  } catch {
    recentFailedJobs = [];
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    runtime: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      nodeVersion: process.version,
      uptimeSec: Math.round(process.uptime()),
      memoryGb: Number((os.totalmem() / (1024 ** 3)).toFixed(1)),
      processMemoryMb: {
        rss: Math.round(mem.rss / (1024 * 1024)),
        heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
        heapTotal: Math.round(mem.heapTotal / (1024 * 1024)),
      },
    },
    edition: {
      id: ed.edition,
      label: ed.editionLabel,
      buildDate: ed.buildDate,
      features: ed.features,
    },
    license: {
      activated: lic.activated,
      valid: lic.valid,
      tier: lic.tier,
      enforcementMode: lic.enforcementMode,
      schemaVersion: lic.schemaVersion || 2,
      updatesUntil: lic.updatesUntil || null,
      perpetualFallback: Boolean(lic.perpetualFallback),
      perpetualFallbackActive: Boolean(lic.perpetualFallbackActive),
      machineCode: lic.machineCode || '',
      unlockedTiers: ents.unlockedTiers,
    },
    eula: {
      required: eula.required,
      accepted: eula.accepted,
      version: eula.version,
    },
    workspaceStats: wsStats,
    aiProviders: aiSafe,
    dataSources: dataSourcesSafe,
    diagnosticsHealth: {
      recentServerErrorCount: RECENT_ERROR_BUFFER.length,
      recentFailedJobCount: recentFailedJobs.length,
    },
  };

  const redactionNotice = [
    '二级投研 · 三库研究工作台 —— 脱敏诊断包说明',
    `生成时间: ${summary.generatedAt}`,
    '',
    '为严格保护您的个人研究与隐私资产，本诊断包已自动排除以下内容：',
    '1. 所有大模型 API Key、数据源 API Key、Webhook Token 与本机授权密钥正文；',
    '2. 所有 Ed25519 私钥与本地敏感路径；',
    '3. 现行三库 Markdown 正文、标的研判笔记、每日复盘正文与研究假设；',
    '4. 实盘/模拟交易账本交割明细、券商账户信息与自选持仓成本。',
    '',
    '仅包含软件版本、操作系统、内存占用、最近脱敏错误栈、启动日志尾部、授权档位（不含密钥）、功能就绪状态与结构化质检计数，可用于售后排障。',
  ].join('\n');

  return {
    summary,
    auditReport: auditSummary || { note: 'audit unavailable' },
    quantEnv: quantSafe,
    recentErrors: {
      serverErrors: RECENT_ERROR_BUFFER.slice(),
      failedJobs: recentFailedJobs,
    },
    launcherLogTail: readRedactedLauncherLogTail(16384),
    redactionNotice,
  };
}

function buildDiagnosticZipBuffer(port = 3721) {
  const diag = collectSanitizedDiagnostics(port);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const zipBuffer = buildZipBuffer([
    { name: 'summary.json', content: JSON.stringify(diag.summary, null, 2) + '\n' },
    { name: 'audit-report.json', content: JSON.stringify(diag.auditReport, null, 2) + '\n' },
    { name: 'quant-env.json', content: JSON.stringify(diag.quantEnv, null, 2) + '\n' },
    { name: 'recent-errors.json', content: JSON.stringify(diag.recentErrors, null, 2) + '\n' },
    { name: 'logs/launcher-tail.txt', content: diag.launcherLogTail + '\n' },
    { name: 'redaction-notice.txt', content: diag.redactionNotice + '\n' },
  ]);
  return {
    fileName: `research-workbench-diagnostic-${stamp}.zip`,
    buffer: zipBuffer,
    summary: diag.summary,
  };
}

module.exports = {
  buildZipBuffer,
  recordServerError,
  collectSanitizedDiagnostics,
  buildDiagnosticZipBuffer,
};
