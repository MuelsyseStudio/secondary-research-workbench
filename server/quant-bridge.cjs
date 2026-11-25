'use strict';

/**
 * Stage 4C · Node ↔ Python (quant_engine) 量化回测与 DuckDB 数据仓桥接层
 *
 * 设计原则：
 * 1. 零破坏与零 Python 容错：未安装 Python 时模块正常加载、工作台其他所有页面零报错；
 * 2. 强制 UTF-8 + NDJSON 流式进度：向 job-runner 实时回传 pct / stage / logs，并支持一键取消终止子进程；
 * 3. DuckDB 单写锁串行保护：写操作（sync / import-csv）串行排队，读操作（summary / bars / backtest）支持多并发只读；
 * 4. 复用 Stage 1 数据源配置（Tushare/自定义REST）与三库风控数据（卡片174黑名单 / 情绪周期 / 方法论卡片 AI 策略生成）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { APP_ROOT, stateFile, stateSubDir } = require('./app-paths.cjs');
const { getEditionInfo } = require('./edition.cjs');
const { startJob } = require('./job-runner.cjs');
const { loadRawDataSourceConfig } = require('./data-source-config.cjs');
const { loadRegulatoryWatchlist } = require('./reconcile-service.cjs');
const { loadSentimentChain } = require('./technical-engine.cjs');
const { loadWorkspace } = require('./knowledge-store.cjs');
const { invokeModel, parseJsonFromModelOutput } = require('./ai-provider.cjs');

const ENGINE_ROOT = path.join(APP_ROOT, 'quant_engine');
const TEMPLATES_DIR = path.join(ENGINE_ROOT, 'quant_engine', 'templates');
const CONFIG_FILE = stateFile('quant-config.local.json');
const DEFAULT_DATA_DIR = stateSubDir('quant_data');

const IS_WIN = process.platform === 'win32';
const VENV_DIR = path.join(ENGINE_ROOT, '.venv');
const VENV_PYTHON = IS_WIN
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');
const VENV_PIP = IS_WIN
  ? path.join(VENV_DIR, 'Scripts', 'pip.exe')
  : path.join(VENV_DIR, 'bin', 'pip');

const BUILTIN_TEMPLATE_META = {
  dual_ma: {
    id: 'builtin_dual_ma',
    file: 'dual_ma.py',
    name: '双均线趋势跟踪 (MA5/MA20 + 均线过滤)',
    market: 'CN',
    description: '经典趋势跟随模板：收盘价站上慢线且快线上穿慢线建仓，死叉离场；天然适配 A股/美股/港股与期货。',
    cardRefs: ['053', '062'],
    defaultParams: { fast: 5, slow: 20, trend: 60, weight: 0.45 },
  },
  rsi_rebound: {
    id: 'builtin_rsi_rebound',
    file: 'rsi_rebound.py',
    name: 'RSI 超卖反弹 + MA20 止盈',
    market: 'CN',
    description: '短线左侧均值回归模板：RSI(6) 跌破超卖阈值且缩量企稳试错低吸，反抽超买或盈利达标分批兑现。',
    cardRefs: ['059', '067'],
    defaultParams: { rsi_period: 6, buy_rsi: 25, sell_rsi: 72, weight: 0.35 },
  },
  bias_2n_stop: {
    id: 'builtin_bias_2n_stop',
    file: 'bias_2n_stop.py',
    name: '乖离过滤 + 2×ATR 动态跟踪止损 (方法论融合)',
    market: 'CN',
    description: '融合方法论纪律：禁止在 MA5 乖离率 > 8% 处追高，突破 20 日新高放量介入，持仓用 2×ATR(14) 跟踪止损。',
    cardRefs: ['001', '053', '061'],
    defaultParams: { breakout_days: 20, max_bias_pct: 8.0, atr_mult: 2.0, weight: 0.45 },
  },
};

// DuckDB 单写进程锁（防并发同步冲突）
let duckWriteLocked = false;
let duckWriteLockOwner = '';

function loadQuantConfig() {
  const defaults = {
    pythonPath: '',
    dataDir: DEFAULT_DATA_DIR,
    defaultMarket: 'CN',
    defaultInitialCash: 1000000,
    updatedAt: null,
  };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return {
        ...defaults,
        ...raw,
        dataDir: raw.dataDir && String(raw.dataDir).trim() ? path.resolve(String(raw.dataDir).trim()) : DEFAULT_DATA_DIR,
        pythonPath: typeof raw.pythonPath === 'string' ? raw.pythonPath.trim() : '',
      };
    }
  } catch {
    // fallback
  }
  return defaults;
}

function saveQuantConfig(patch = {}) {
  const cur = loadQuantConfig();
  const next = { ...cur };
  if (typeof patch.pythonPath === 'string') {
    next.pythonPath = patch.pythonPath.trim();
  }
  if (typeof patch.dataDir === 'string') {
    const trimmed = patch.dataDir.trim();
    next.dataDir = trimmed ? path.resolve(trimmed) : DEFAULT_DATA_DIR;
  }
  if (typeof patch.defaultMarket === 'string' && patch.defaultMarket.trim()) {
    next.defaultMarket = patch.defaultMarket.trim().toUpperCase();
  }
  if (patch.defaultInitialCash !== undefined && Number.isFinite(Number(patch.defaultInitialCash))) {
    next.defaultInitialCash = Math.max(1000, Number(patch.defaultInitialCash));
  }
  next.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

function getDataDir() {
  const cfg = loadQuantConfig();
  const dir = cfg.dataDir || DEFAULT_DATA_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getStrategiesDir() {
  const dir = path.join(getDataDir(), 'strategies');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRunsDir() {
  const dir = path.join(getDataDir(), 'runs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function buildPythonEnv() {
  const existingPyPath = process.env.PYTHONPATH || '';
  const pyPath = existingPyPath ? `${ENGINE_ROOT}${path.delimiter}${existingPyPath}` : ENGINE_ROOT;
  const ed = getEditionInfo();
  return {
    ...process.env,
    PYTHONPATH: pyPath,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    SRW_EDITION: ed.edition,
  };
}

function parsePythonVersion(text) {
  const m = String(text || '').match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return null;
  return {
    raw: `${m[1]}.${m[2]}.${m[3]}`,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

function probePythonExecutable(exe, extraArgs = []) {
  try {
    const r = spawnSync(exe, [...extraArgs, '--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    if (r.error || r.status !== 0) return null;
    const ver = parsePythonVersion(`${r.stdout || ''} ${r.stderr || ''}`);
    if (!ver) return null;
    if (ver.major < 3 || (ver.major === 3 && ver.minor < 10)) return null;
    // Resolve absolute executable path
    const pRes = spawnSync(exe, [...extraArgs, '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const absPath = pRes.status === 0 && pRes.stdout ? pRes.stdout.trim().split(/\r?\n/)[0] : exe;
    return { executable: absPath, version: ver.raw };
  } catch {
    return null;
  }
}

function findSystemPython() {
  const candidates = IS_WIN
    ? [
        ['py', ['-3']],
        ['python', []],
        ['python3', []],
      ]
    : [
        ['python3', []],
        ['python', []],
      ];
  for (const [cmd, args] of candidates) {
    const probed = probePythonExecutable(cmd, args);
    if (probed) return probed;
  }
  return null;
}

function resolvePythonExecutable(overridePath = null) {
  const cfg = loadQuantConfig();
  const custom = overridePath !== null ? String(overridePath || '').trim() : cfg.pythonPath;

  // 1. 用户显式配置了 pythonPath -> 严格校验该路径（便于诊断和零 Python 回退测试）
  if (custom) {
    const probed = probePythonExecutable(custom);
    if (probed) {
      return { found: true, source: 'custom', ...probed, isVenv: false };
    }
    return {
      found: false,
      source: 'custom',
      reason: `自定义 Python 路径不可用或版本低于 3.10：${custom}`,
    };
  }

  // 2. 优先使用项目内置隔离虚拟环境 quant_engine/.venv
  if (fs.existsSync(VENV_PYTHON)) {
    const probed = probePythonExecutable(VENV_PYTHON);
    if (probed) {
      return { found: true, source: 'venv', ...probed, isVenv: true };
    }
  }

  // 3. 回退本机系统 Python >= 3.10
  const sysPy = findSystemPython();
  if (sysPy) {
    return { found: true, source: 'system', ...sysPy, isVenv: false };
  }

  return {
    found: false,
    source: 'none',
    reason: '未检测到 Python 3.10+ 环境（不影响工作台其他页面使用）。请先安装 Python 3.10+ 或在设置中指定本地 Python 路径。',
  };
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000 });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

/**
 * 同步调用短耗时 CLI（doctor / summary / bars），绝不阻塞事件循环过久
 */
function runPythonJsonCommand(args, timeoutMs = 15000, overridePythonPath = null) {
  const resolved = resolvePythonExecutable(overridePythonPath);
  if (!resolved.found) {
    return { ok: false, pythonUnavailable: true, error: resolved.reason, resolved };
  }
  try {
    const res = spawnSync(resolved.executable, ['-m', 'quant_engine', ...args], {
      cwd: ENGINE_ROOT,
      env: buildPythonEnv(),
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (res.error) {
      return { ok: false, error: `执行 quant_engine 失败: ${res.error.message}`, resolved };
    }
    const rawOut = String(res.stdout || '').trim();
    const lines = rawOut.split(/\r?\n/).filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    try {
      const parsed = JSON.parse(lastLine);
      return { ok: res.status === 0 && parsed.ok !== false, data: parsed, resolved, stderr: (res.stderr || '').trim() };
    } catch {
      return {
        ok: false,
        error: (res.stderr || rawOut || `Python 进程异常退出 (code=${res.status})`).slice(0, 600),
        resolved,
      };
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err), resolved };
  }
}

/**
 * 异步流式调用 NDJSON CLI（sync / backtest / import-csv），对接 job-runner 进度与取消
 */
function runPythonStreamCommand(args, ctx, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const resolved = resolvePythonExecutable();
    if (!resolved.found) {
      reject(new Error(resolved.reason));
      return;
    }

    const child = spawn(resolved.executable, ['-m', 'quant_engine', ...args], {
      cwd: ENGINE_ROOT,
      env: buildPythonEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let buf = '';
    let stderrText = '';
    let donePayload = null;
    let lastErrorMsg = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      reject(new Error(`量化任务执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    if (ctx && typeof ctx.onCancel === 'function') {
      ctx.onCancel(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killProcessTree(child);
      });
    }

    const handleLine = (line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        ctx?.update?.({ log: { level: 'info', msg: trimmed.slice(0, 300) } });
        return;
      }
      if (msg.type === 'progress') {
        ctx?.update?.({ pct: Number(msg.pct) || 0, stage: String(msg.stage || '') });
      } else if (msg.type === 'log') {
        ctx?.update?.({ log: { level: msg.level || 'info', msg: String(msg.msg || '') } });
      } else if (msg.type === 'done') {
        donePayload = msg;
      } else if (msg.type === 'error') {
        lastErrorMsg = String(msg.msg || '执行错误');
        ctx?.update?.({ log: { level: 'error', msg: lastErrorMsg } });
      }
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrText += text;
      if (stderrText.length > 6000) stderrText = stderrText.slice(-6000);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`启动 Python 量化引擎失败: ${err.message}`));
    });

    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ctx?.isCancelled?.()) {
        reject(new Error('任务已取消'));
        return;
      }
      if (code === 0 && donePayload) {
        resolve(donePayload);
        return;
      }
      const errDetail = lastErrorMsg || stderrText.trim().slice(-600) || `Python 量化引擎异常退出 (exit=${code})`;
      reject(new Error(errDetail));
    });
  });
}

// ============================================================================
// 1. 环境诊断 & 一键初始化隔离 .venv
// ============================================================================

function detectQuantEnv(overridePythonPath = null) {
  const cfg = loadQuantConfig();
  const dataDir = cfg.dataDir || DEFAULT_DATA_DIR;
  const resolved = resolvePythonExecutable(overridePythonPath);
  const sysPy = findSystemPython();

  if (!resolved.found) {
    return {
      ok: false,
      available: false,
      pythonFound: Boolean(sysPy && !overridePythonPath && !cfg.pythonPath),
      canAutoSetup: Boolean(sysPy),
      systemPython: sysPy,
      venvPath: VENV_DIR,
      venvExists: fs.existsSync(VENV_PYTHON),
      reason: resolved.reason,
      dataDir,
      config: cfg,
      engineRoot: ENGINE_ROOT,
      dependencies: {},
    };
  }

  const doc = runPythonJsonCommand(['doctor', '--data-dir', dataDir], 12000, overridePythonPath);
  if (!doc.ok || !doc.data) {
    return {
      ok: false,
      available: false,
      pythonFound: true,
      pythonVersion: resolved.version,
      pythonExecutable: resolved.executable,
      pythonSource: resolved.source,
      isVenv: Boolean(resolved.isVenv),
      canAutoSetup: Boolean(sysPy || resolved.found),
      systemPython: sysPy,
      venvPath: VENV_DIR,
      venvExists: fs.existsSync(VENV_PYTHON),
      reason: doc.error || 'Python 已检测到，但 DuckDB / quant_engine 依赖尚未安装完成，请点击「一键初始化隔离环境」。',
      dataDir,
      config: cfg,
      engineRoot: ENGINE_ROOT,
      dependencies: doc.data?.dependencies || {},
    };
  }

  return {
    ok: true,
    available: true,
    pythonFound: true,
    pythonSource: resolved.source,
    isVenv: Boolean(resolved.isVenv),
    canAutoSetup: !resolved.isVenv && Boolean(sysPy),
    venvPath: VENV_DIR,
    venvExists: fs.existsSync(VENV_PYTHON),
    ...doc.data,
    dataDir,
    config: cfg,
    engineRoot: ENGINE_ROOT,
  };
}

function startQuantEnvSetupJob() {
  return startJob({
    kind: 'quant_setup',
    title: '初始化 Python 量化隔离环境 (.venv + DuckDB)',
    meta: { engineRoot: ENGINE_ROOT, venvPath: VENV_DIR },
    runner: async (ctx) => {
      const cfg = loadQuantConfig();
      const basePy = (cfg.pythonPath && probePythonExecutable(cfg.pythonPath)) || findSystemPython();
      if (!basePy) {
        throw new Error('未在本机检测到 Python 3.10+。请先从 python.org 安装 Python 3.10/3.12（勾选 Add to PATH），再重试初始化。');
      }

      const runStep = (cmd, args, label, startPct, endPct) =>
        new Promise((resolve, reject) => {
          ctx.update({ stage: label, pct: startPct, log: { level: 'info', msg: `${label}: ${cmd} ${args.join(' ')}` } });
          const child = spawn(cmd, args, {
            cwd: ENGINE_ROOT,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let outTail = '';
          ctx.onCancel(() => killProcessTree(child));
          const onData = (chunk) => {
            const txt = chunk.toString('utf8');
            outTail = (outTail + txt).slice(-2000);
            const lines = txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            for (const ln of lines.slice(-3)) {
              ctx.update({ log: { level: 'info', msg: ln.slice(0, 220) } });
            }
          };
          child.stdout.on('data', onData);
          child.stderr.on('data', onData);
          child.on('error', (err) => reject(err));
          child.on('close', (code) => {
            if (ctx.isCancelled()) return reject(new Error('初始化已取消'));
            if (code !== 0) return reject(new Error(`${label} 失败 (code=${code}): ${outTail.slice(-400)}`));
            ctx.update({ pct: endPct });
            resolve();
          });
        });

      if (!fs.existsSync(VENV_PYTHON)) {
        await runStep(basePy.executable, ['-m', 'venv', VENV_DIR], '创建独立 Python 虚拟环境 (.venv)', 10, 35);
      } else {
        ctx.update({ stage: '检测到已有 .venv，开始校验与更新依赖', pct: 35 });
      }

      await runStep(
        VENV_PIP,
        ['install', '--disable-pip-version-check', '-e', '.[dev]'],
        '安装 MIT/Apache/BSD 商业友好量化依赖 (duckdb / pandas / numpy / baostock / yfinance)',
        40,
        92
      );

      ctx.update({ stage: '正在运行 quant_engine doctor 自检...', pct: 95 });
      const env = detectQuantEnv();
      if (!env.available) {
        throw new Error(env.reason || '环境安装后自检未通过');
      }
      return { ok: true, env };
    },
  });
}

// ============================================================================
// 2. 本地 DuckDB 数据仓摘要、增量同步、离线 CSV/Parquet 导入、K 线读取
// ============================================================================

function getDataSummary() {
  const dataDir = getDataDir();
  const ed = getEditionInfo();
  const res = runPythonJsonCommand(['summary', '--data-dir', dataDir], 12000);
  if (!res.ok || !res.data) {
    return {
      ok: false,
      available: !res.pythonUnavailable,
      error: res.error || '无法读取 DuckDB 摘要',
      dataDir,
      dbPath: path.join(dataDir, 'duckdb', 'market.duckdb'),
      dbSizeMb: 0,
      totalSeries: 0,
      marketsCount: {},
      benchmarksReady: ed.features.crypto ? { CN: false, US: false, CRYPTO: false } : { CN: false, US: false },
      calendars: {},
      items: [],
      writeLocked: duckWriteLocked,
    };
  }
  return {
    ...res.data,
    available: true,
    dataDir,
    writeLocked: duckWriteLocked,
  };
}

const BASE_QUANT_MARKETS = new Set(['CN', 'US', 'HK', 'TW', 'KR', 'JP', 'FR', 'UK', 'DE', 'FUT']);
const BLOCKED_QUOTE_SUFFIX_DIGESTS = new Set([
  'ca9006bd3fb03d35',
  '8591ee9090c0c02c',
  'bd4ef74463ac3c61',
  '42e52be5cde97422',
  'ed26f35d2079033b',
]);

function sha16Upper(val) {
  return crypto.createHash('sha256').update(String(val || '').toUpperCase()).digest('hex').slice(0, 16);
}

function assertSupportedQuantInputs(symbols, market = '') {
  const ed = getEditionInfo();
  if (ed.features.crypto) return;
  const mkt = String(market || '').trim().toUpperCase();
  if (mkt && !BASE_QUANT_MARKETS.has(mkt)) {
    throw new Error(`当前国内版不支持市场类型 (${mkt})，仅支持 A 股及全球主流股市与期货`);
  }
  const list = Array.isArray(symbols) ? symbols : [symbols];
  for (const raw of list) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const up = s.toUpperCase();
    const unsupported =
      up.startsWith('CRYPTO.') ||
      up.endsWith('.CRYPTO') ||
      up.includes('/') ||
      /^[A-Z0-9]{2,12}_[A-Z]{3,6}$/.test(up) ||
      /^[A-Z0-9]{2,12}-[A-Z]{3,6}$/.test(up) ||
      (/^[A-Z0-9]{6,14}$/.test(up) &&
        (BLOCKED_QUOTE_SUFFIX_DIGESTS.has(sha16Upper(up.slice(-4))) ||
          (up.length >= 7 && BLOCKED_QUOTE_SUFFIX_DIGESTS.has(sha16Upper(up.slice(-5))))));
    if (unsupported) {
      throw new Error(`当前国内版不支持该资产标识 (${s})`);
    }
  }
}

function getSymbolBars({ symbol, market = '', start = '', end = '', freq = '1d' }) {
  try {
    assertSupportedQuantInputs([symbol], market);
  } catch (err) {
    return { ok: false, error: err.message, bars: [] };
  }
  const dataDir = getDataDir();
  const args = ['bars', '--data-dir', dataDir, '--symbol', String(symbol || '').trim(), '--freq', freq || '1d'];
  if (market) args.push('--market', String(market).toUpperCase());
  if (start) args.push('--start', String(start).slice(0, 10));
  if (end) args.push('--end', String(end).slice(0, 10));
  const res = runPythonJsonCommand(args, 15000);
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error || '读取本地 DuckDB K 线失败', bars: [] };
  }
  return res.data;
}

function buildPaidSourceTempConfig(source) {
  if (source !== 'tushare' && source !== 'custom_rest') return null;
  let dsCfg = null;
  try {
    dsCfg = loadRawDataSourceConfig();
  } catch {
    return null;
  }
  const payload = {};
  if (source === 'tushare') {
    const ch = dsCfg?.cn_quotes || {};
    payload.tushareToken = ch.apiKey || '';
    payload.tushareBaseUrl = ch.baseUrl || 'https://api.tushare.pro';
  } else if (source === 'custom_rest') {
    const ch = dsCfg?.cn_quotes?.mode === 'custom' ? dsCfg.cn_quotes : dsCfg?.global_markets || {};
    payload.baseUrl = ch.baseUrl || '';
    payload.pathTemplate = ch.klinePath || '/api/history?symbol={symbol}&start={start}&end={end}&freq={freq}';
    payload.apiKey = ch.apiKey || '';
    payload.authHeaderName = ch.authHeaderName || 'Authorization';
    payload.authHeaderPrefix = ch.authHeaderPrefix || 'Bearer ';
  }
  const tmpFile = path.join(os.tmpdir(), `srw-quant-src-${crypto.randomBytes(5).toString('hex')}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf8');
  return tmpFile;
}

function startDataSyncJob(params = {}) {
  const rawSymbols = Array.isArray(params.symbols)
    ? params.symbols
    : String(params.symbols || '')
        .split(/[\s,，;；]+/)
        .filter(Boolean);
  const symbols = [...new Set(rawSymbols.map((s) => String(s).trim()).filter(Boolean))];
  if (!symbols.length) {
    throw new Error('请至少提供 1 个标的代码');
  }
  if (duckWriteLocked) {
    throw new Error(`本地 DuckDB 正在执行写入任务（${duckWriteLockOwner}），请等待当前同步完成后再发起。`);
  }

  const market = params.market ? String(params.market).toUpperCase() : '';
  assertSupportedQuantInputs(symbols, market);
  const start = params.start ? String(params.start).slice(0, 10) : '';
  const end = params.end ? String(params.end).slice(0, 10) : '';
  const freq = params.freq || '1d';
  const source = String(params.source || 'auto').toLowerCase();
  const force = Boolean(params.force);
  const dataDir = getDataDir();

  return startJob({
    kind: 'quant_sync',
    title: `DuckDB 历史数据同步 (${symbols.slice(0, 3).join(', ')}${symbols.length > 3 ? ` 等${symbols.length}只` : ''})`,
    meta: { symbols, market, start, end, freq, source, force },
    runner: async (ctx) => {
      duckWriteLocked = true;
      duckWriteLockOwner = `${symbols.slice(0, 2).join(',')} (${ctx.jobId})`;
      const tmpCfg = buildPaidSourceTempConfig(source);
      try {
        const args = ['sync', '--data-dir', dataDir, '--symbols', symbols.join(','), '--freq', freq, '--source', source];
        if (market) args.push('--market', market);
        if (start) args.push('--start', start);
        if (end) args.push('--end', end);
        if (force) args.push('--force');
        if (tmpCfg) args.push('--config-json', tmpCfg);
        return await runPythonStreamCommand(args, ctx, 10 * 60 * 1000);
      } finally {
        duckWriteLocked = false;
        duckWriteLockOwner = '';
        if (tmpCfg) {
          try {
            fs.unlinkSync(tmpCfg);
          } catch {
            // ignore
          }
        }
      }
    },
  });
}

async function importCsvHistory(params = {}) {
  const symbol = String(params.symbol || '').trim();
  if (!symbol) throw new Error('请填写标的代码（如 300308.SZ / NVDA.US / 00700.HK）');
  const reqMkt = params.market ? String(params.market).toUpperCase() : '';
  assertSupportedQuantInputs([symbol], reqMkt);
  if (duckWriteLocked) {
    throw new Error(`本地 DuckDB 正在执行写入任务（${duckWriteLockOwner}），请稍后再导入。`);
  }

  let targetFile = params.filePath ? path.resolve(String(params.filePath).trim()) : '';
  let createdTemp = false;
  if (!targetFile && params.csvText) {
    const ext = String(params.fileName || '').toLowerCase().endsWith('.parquet') ? '.parquet' : '.csv';
    targetFile = path.join(os.tmpdir(), `srw-quant-import-${crypto.randomBytes(5).toString('hex')}${ext}`);
    fs.writeFileSync(targetFile, String(params.csvText), 'utf8');
    createdTemp = true;
  }
  if (!targetFile || !fs.existsSync(targetFile)) {
    throw new Error('请上传 CSV 文件内容或提供存在的本地 CSV/Parquet 文件路径');
  }

  const dataDir = getDataDir();
  const args = ['import-csv', '--data-dir', dataDir, '--file', targetFile, '--symbol', symbol, '--freq', params.freq || '1d'];
  if (params.market) args.push('--market', String(params.market).toUpperCase());
  if (params.colMap && typeof params.colMap === 'object') args.push('--col-map', JSON.stringify(params.colMap));
  if (params.volumeMultiplier) args.push('--volume-multiplier', String(params.volumeMultiplier));
  if (params.name) args.push('--name', String(params.name));

  duckWriteLocked = true;
  duckWriteLockOwner = `CSV导入 ${symbol}`;
  try {
    const res = runPythonJsonCommand(args, 60000);
    if (!res.ok || !res.data) {
      throw new Error(res.error || '离线 CSV/Parquet 导入失败');
    }
    return { ok: true, ...res.data };
  } finally {
    duckWriteLocked = false;
    duckWriteLockOwner = '';
    if (createdTemp) {
      try {
        fs.unlinkSync(targetFile);
      } catch {
        // ignore
      }
    }
  }
}

// ============================================================================
// 3. 策略模板 & 用户策略 CRUD + 从《方法论卡片库》AI 生成策略
// ============================================================================

function listStrategies() {
  const builtins = [];
  for (const [key, meta] of Object.entries(BUILTIN_TEMPLATE_META)) {
    const fp = path.join(TEMPLATES_DIR, meta.file);
    let code = '';
    try {
      code = fs.readFileSync(fp, 'utf8');
    } catch {
      code = '';
    }
    builtins.push({
      ...meta,
      key,
      mode: 'python',
      builtin: true,
      code,
      ruleConfig: null,
      updatedAt: null,
    });
  }

  const userList = [];
  const dir = getStrategiesDir();
  if (fs.existsSync(dir)) {
    for (const fname of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const item = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8'));
        if (item && item.id) {
          userList.push({ ...item, builtin: false });
        }
      } catch {
        // ignore
      }
    }
  }
  userList.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { ok: true, strategies: [...builtins, ...userList] };
}

function saveStrategy(payload = {}) {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('策略名称不能为空');
  const rawId = String(payload.id || '').trim();
  const isNew = !rawId || rawId.startsWith('builtin_');
  const safeId = isNew
    ? `strat_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`
    : rawId.replace(/[^a-zA-Z0-9_\-]/g, '_');

  const record = {
    id: safeId,
    name,
    description: String(payload.description || '').trim(),
    mode: payload.mode === 'visual' ? 'visual' : 'python',
    market: String(payload.market || 'CN').toUpperCase(),
    code: String(payload.code || ''),
    ruleConfig: payload.ruleConfig || null,
    cardRefs: Array.isArray(payload.cardRefs) ? payload.cardRefs.map(String) : [],
    defaultParams: payload.defaultParams && typeof payload.defaultParams === 'object' ? payload.defaultParams : {},
    updatedAt: new Date().toISOString(),
  };

  const target = path.join(getStrategiesDir(), `${safeId}.json`);
  fs.writeFileSync(target, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return { ok: true, strategy: { ...record, builtin: false } };
}

function deleteStrategy(id) {
  const safeId = String(id || '').trim();
  if (!safeId || safeId.startsWith('builtin_') || !/^[a-zA-Z0-9_\-]+$/.test(safeId)) {
    throw new Error('内置策略模板不可删除或策略 ID 非法');
  }
  const target = path.join(getStrategiesDir(), `${safeId}.json`);
  if (!fs.existsSync(target)) {
    throw new Error('未找到指定策略');
  }
  fs.unlinkSync(target);
  return { ok: true, deletedId: safeId };
}

async function generateStrategyFromCards({ cardIds = [], market = 'CN', extraRequirements = '', providerOverride = null }) {
  const ws = loadWorkspace();
  const allCards = ws?.methodology?.cards || [];
  const wanted = new Set((Array.isArray(cardIds) ? cardIds : []).map((x) => String(x).trim().padStart(3, '0')));
  const picked = allCards.filter((c) => wanted.has(String(c.id || '').padStart(3, '0')) || wanted.has(String(c.id || '')));
  if (!picked.length) {
    throw new Error('请至少选择 1 张有效的方法论卡片');
  }

  const cardText = picked
    .map(
      (c) =>
        `【卡片 ${c.id} | ${c.title}】\n- 核心论断：${c.coreThesis || c.coreClaim || ''}\n- 逻辑链条：${c.logicChain || ''}\n- 适用条件：${c.applicableConditions || c.conditions || ''}\n- 失效信号：${c.invalidationSignals || c.invalidation || ''}`
    )
    .join('\n\n');

  const systemPrompt = `你是二级投研量化策略工程师。请根据用户选中的方法论卡片，生成一份可直接在本系统 quant_engine 中运行的原创 Python 回测策略脚本。
严格遵守以下 SDK 契约与安全红线：
1. 必须定义模块级常量：
   STRATEGY_NAME = "策略名称"
   CARD_REFS = [${picked.map((c) => `"${c.id}"`).join(', ')}]
2. 必须定义：
   def init(ctx): ...
   def on_bar(ctx, bar_dt): ...
3. 可用上下文与内置指标（不要 import os/sys/subprocess/requests/open）：
   - ctx.symbols (list[str])
   - ctx.params (dict)
   - ctx.state (dict)
   - ctx.position(sym) -> None 或含 .quantity / .avg_cost / .sellable_qty
   - ctx.history(sym, count=60) -> pandas DataFrame（严格截断 <= bar_dt，含 open/high/low/close/volume/amount）
   - ctx.ind: sma(arr, n), ema(arr, n), rsi(arr, n), macd(arr), boll(arr, n, k), atr(h, l, c, n), bias(arr, n), highest(arr, n), lowest(arr, n), crossover(a, b), crossunder(a, b)
   - ctx.order_target_percent(sym, target_pct, reason="...")
   - ctx.close_position(sym, reason="...")
   - ctx.log(msg)
   - 全局已注入 np, pd, math, ind，无需导入第三方库。
4. 零未来函数：只能使用 ctx.history 返回的末尾 [-1] / [-2] 数据判断，严禁使用未来数据。
5. 只输出合法 JSON 对象，格式如下：
{
  "name": "策略中文名",
  "description": "简述本策略如何落地所选卡片的逻辑与风控规则",
  "cardRefs": ["053"],
  "defaultParams": { "weight": 0.45 },
  "code": "完整可执行的 Python 代码字符串"
}`;

  const userPrompt = `目标市场：${String(market || 'CN').toUpperCase()}
用户补充要求：${extraRequirements || '保持逻辑清晰、带止损纪律与中文注释，说明对应方法论卡号。'}

所选方法论卡片内容：
${cardText}`;

  const res = await invokeModel({
    providerOverride,
    systemPrompt,
    userPrompt,
    expectJson: true,
    timeoutMs: 120000,
  });

  const parsed = parseJsonFromModelOutput(res.rawText);
  if (!parsed || typeof parsed.code !== 'string' || !parsed.code.includes('def on_bar')) {
    throw new Error('AI 返回结果未包含合法的 `def on_bar(ctx, bar_dt):` 策略代码，请重试。');
  }

  return {
    ok: true,
    provider: res.provider,
    model: res.model,
    latencyMs: res.latencyMs,
    draft: {
      name: String(parsed.name || `卡片${picked.map((c) => c.id).join('+')}量化策略`),
      description: String(parsed.description || '').trim(),
      cardRefs: Array.isArray(parsed.cardRefs) && parsed.cardRefs.length ? parsed.cardRefs.map(String) : picked.map((c) => String(c.id)),
      defaultParams: parsed.defaultParams && typeof parsed.defaultParams === 'object' ? parsed.defaultParams : {},
      code: parsed.code,
    },
  };
}

// ============================================================================
// 4. 启动多市场回测任务 + 历史回测归档查询/删除
// ============================================================================

function buildSentimentExposureCaps() {
  const caps = {};
  try {
    const chain = loadSentimentChain();
    const list = Array.isArray(chain?.snapshots) ? chain.snapshots : Array.isArray(chain) ? chain : [];
    for (const snap of list) {
      const d = String(snap.date || snap.tradeDate || '').slice(0, 10);
      const score = Number(snap.sentimentScore ?? snap.score ?? snap.temperature);
      if (!d || !Number.isFinite(score)) continue;
      if (score <= 28) caps[d] = 0.35;       // 冰点退潮：控仓防御
      else if (score <= 45) caps[d] = 0.6;   // 分歧弱势：半仓精选
      else if (score >= 82) caps[d] = 0.8;   // 一致高潮：防次日大面
      else caps[d] = 0.95;
    }
  } catch {
    // non-fatal
  }
  return caps;
}

function buildRegulatoryBlacklistForBacktest() {
  try {
    const wl = loadRegulatoryWatchlist();
    return (wl.items || [])
      .filter((x) => x && x.active !== false && x.code)
      .map((x) => ({
        code: String(x.code || '').trim(),
        name: String(x.name || '').trim(),
        level: x.level || 'ban',
        startDate: x.startDate || '',
        endDate: x.endDate || '',
        reason: x.reason || '卡片174重点监管红线',
      }));
  } catch {
    return [];
  }
}

function startBacktestJob(rawSpec = {}) {
  const env = detectQuantEnv();
  if (!env.available) {
    throw new Error(env.reason || 'Python 量化环境未就绪，请先完成一键初始化。');
  }

  const universeMode = String(rawSpec.universeMode || 'explicit').toLowerCase();
  const symbols = Array.isArray(rawSpec.symbols)
    ? rawSpec.symbols.map((s) => String(s).trim()).filter(Boolean)
    : String(rawSpec.symbols || '')
        .split(/[\s,，;；]+/)
        .filter(Boolean);
  if (!symbols.length && universeMode === 'explicit') {
    throw new Error('请至少选择 1 个回测标的，或切换到「DuckDB 全库自动选股轮动」模式');
  }

  const market = String(rawSpec.market || 'CN').toUpperCase();
  const ed = getEditionInfo();
  assertSupportedQuantInputs(
    rawSpec.benchmark ? [...symbols, rawSpec.benchmark] : symbols,
    market
  );
  const strategyMode = rawSpec.strategyMode === 'visual' ? 'visual' : 'python';
  if (strategyMode === 'python' && !String(rawSpec.code || '').trim()) {
    throw new Error('Python 策略代码不能为空');
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const runId = `bt_${stamp}_${crypto.randomBytes(2).toString('hex')}`;
  const outDir = path.join(getRunsDir(), runId);
  fs.mkdirSync(outDir, { recursive: true });

  const risk = { ...(rawSpec.risk || {}) };
  if (risk.enableCard174Guard && (!Array.isArray(risk.regulatoryBlacklist) || !risk.regulatoryBlacklist.length)) {
    risk.regulatoryBlacklist = buildRegulatoryBlacklistForBacktest();
  }
  if (risk.enableSentimentCap && (!risk.sentimentCaps || !Object.keys(risk.sentimentCaps).length)) {
    risk.sentimentCaps = buildSentimentExposureCaps();
  }

  const spec = {
    runId,
    edition: ed.edition,
    dataDir: getDataDir(),
    market,
    universeMode,
    screener: rawSpec.screener && typeof rawSpec.screener === 'object' ? rawSpec.screener : null,
    symbols,
    startDate: String(rawSpec.startDate || '2025-01-01').slice(0, 10),
    endDate: String(rawSpec.endDate || new Date().toISOString().slice(0, 10)).slice(0, 10),
    freq: rawSpec.freq || '1d',
    adjust: rawSpec.adjust || 'qfq',
    matchMode: rawSpec.matchMode === 'close' ? 'close' : 'next_open',
    initialCash: Math.max(1000, Number(rawSpec.initialCash) || 1000000),
    benchmark: rawSpec.benchmark || '',
    strategyId: rawSpec.strategyId || '',
    strategyName: String(rawSpec.strategyName || '未命名策略').trim(),
    strategyMode,
    code: rawSpec.code || '',
    ruleConfig: rawSpec.ruleConfig || null,
    cardRefs: Array.isArray(rawSpec.cardRefs) ? rawSpec.cardRefs : [],
    params: rawSpec.params && typeof rawSpec.params === 'object' ? rawSpec.params : {},
    risk,
    feeOverrides: rawSpec.feeOverrides && typeof rawSpec.feeOverrides === 'object' ? rawSpec.feeOverrides : {},
  };

  const specPath = path.join(outDir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

  return startJob({
    kind: 'quant_backtest',
    title: `[${market}] ${spec.strategyName} (${
      symbols.length
        ? `${symbols.slice(0, 2).join(',')}${symbols.length > 2 ? ` 等${symbols.length}只` : ''}`
        : universeMode === 'screener'
        ? `全库动态选股Top${spec.screener?.topK || 5}`
        : '全库多标的'
    })`,
    meta: { runId, market, strategyName: spec.strategyName, symbols, startDate: spec.startDate, endDate: spec.endDate },
    runner: async (ctx) => {
      const done = await runPythonStreamCommand(['backtest', '--spec', specPath, '--out', outDir], ctx, 10 * 60 * 1000);
      return {
        ok: true,
        runId,
        summary: done.summary || {},
        meta: done.meta || {},
      };
    },
  });
}

function isCryptoTokenSymbol(sym) {
  const s = String(sym || '').trim().toUpperCase();
  return s.endsWith('.CRYPTO') || s.startsWith('CRYPTO.') || /_USDT\b/.test(s);
}

function isRunBlockedByEdition(parsedRun) {
  const ed = getEditionInfo();
  if (ed.features.crypto) return false;
  if (!parsedRun || typeof parsedRun !== 'object') return false;
  const meta = parsedRun.meta && typeof parsedRun.meta === 'object' ? parsedRun.meta : parsedRun;
  if (String(meta.market || '').toUpperCase() === 'CRYPTO') return true;
  const syms = Array.isArray(meta.symbols) ? meta.symbols : [];
  if (syms.some((s) => isCryptoTokenSymbol(s))) return true;
  const trades = Array.isArray(parsedRun.trades) ? parsedRun.trades : [];
  if (trades.some((t) => isCryptoTokenSymbol(t?.symbol))) return true;
  return false;
}

function listBacktestRuns() {
  const dir = getRunsDir();
  if (!fs.existsSync(dir)) return { ok: true, runs: [] };
  const runs = [];
  for (const name of fs.readdirSync(dir)) {
    const resPath = path.join(dir, name, 'result.json');
    if (!fs.existsSync(resPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(resPath, 'utf8'));
      if (isRunBlockedByEdition(parsed)) continue;
      runs.push({
        runId: parsed.runId || name,
        createdAt: parsed.createdAt || null,
        meta: parsed.meta || {},
        metrics: parsed.metrics || {},
        tradeCount: Array.isArray(parsed.trades) ? parsed.trades.length : 0,
        rejectCount: Array.isArray(parsed.rejects) ? parsed.rejects.length : 0,
      });
    } catch {
      // ignore corrupted
    }
  }
  runs.sort((a, b) => String(b.createdAt || b.runId).localeCompare(String(a.createdAt || a.runId)));
  return { ok: true, runs: runs.slice(0, 100) };
}

function getBacktestRun(runId) {
  const safeId = String(runId || '').trim();
  if (!safeId || !/^[a-zA-Z0-9_\-]+$/.test(safeId)) {
    throw new Error('非法的 runId');
  }
  const resPath = path.join(getRunsDir(), safeId, 'result.json');
  if (!fs.existsSync(resPath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(resPath, 'utf8'));
  if (isRunBlockedByEdition(parsed)) {
    return null;
  }
  return parsed;
}

function deleteBacktestRun(runId) {
  const safeId = String(runId || '').trim();
  if (!safeId || !/^[a-zA-Z0-9_\-]+$/.test(safeId)) {
    throw new Error('非法的 runId');
  }
  const targetDir = path.join(getRunsDir(), safeId);
  if (!fs.existsSync(targetDir)) {
    throw new Error('未找到指定回测记录');
  }
  const resPath = path.join(targetDir, 'result.json');
  if (fs.existsSync(resPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resPath, 'utf8'));
      if (isRunBlockedByEdition(parsed)) {
        throw new Error('当前版本不支持操作该市场类型的回测归档');
      }
    } catch (e) {
      if (String(e.message || '').includes('当前版本不支持')) throw e;
    }
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  return { ok: true, deletedRunId: safeId };
}

function getRunCsvContent(runId, kind = 'trades') {
  const safeId = String(runId || '').trim();
  if (!safeId || !/^[a-zA-Z0-9_\-]+$/.test(safeId)) return null;
  const runDir = path.join(getRunsDir(), safeId);
  const resPath = path.join(runDir, 'result.json');
  const specPath = path.join(runDir, 'spec.json');
  for (const metaPath of [resPath, specPath]) {
    if (fs.existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (isRunBlockedByEdition(parsed)) return null;
      } catch {
        // ignore
      }
    }
  }
  const fname = kind === 'equity' ? 'equity.csv' : 'trades.csv';
  const fp = path.join(runDir, fname);
  if (!fs.existsSync(fp)) return null;
  return { fileName: `${safeId}_${fname}`, content: fs.readFileSync(fp, 'utf8') };
}

module.exports = {
  detectQuantEnv,
  loadQuantConfig,
  saveQuantConfig,
  startQuantEnvSetupJob,
  getDataSummary,
  getSymbolBars,
  startDataSyncJob,
  importCsvHistory,
  listStrategies,
  saveStrategy,
  deleteStrategy,
  generateStrategyFromCards,
  startBacktestJob,
  listBacktestRuns,
  getBacktestRun,
  deleteBacktestRun,
  getRunCsvContent,
};
