'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { stateFile } = require('./app-paths.cjs');
const { atomicWriteFileSync } = require('./lru-cache.cjs');
const { encryptSecret, decryptSecret } = require('./secret-vault.cjs');
const CONFIG_PATH = stateFile('ai-config.local.json');

const OPENAI_COMPAT_PROVIDERS = ['deepseek', 'qwen', 'moonshot', 'zhipu', 'openai', 'custom'];
const VALID_PROVIDERS = ['codex_cli', 'gemini_cli', 'deepseek', 'qwen', 'moonshot', 'zhipu', 'gemini', 'openai', 'custom'];

// 旧版本在仅保存 AI 引擎时曾自动写入过固定的 6 只示例观察股，升级后按来源字段识别并待一次性确认
const LEGACY_HARDCODED_WATCH_STOCKS = ['300308', '002384', '300502', '300394', '601398', '600519'];

function isExactLegacyDefaultWatchStocks(arr) {
  if (!Array.isArray(arr)) return false;
  const cleaned = arr.map((s) => String(s || '').trim()).filter(Boolean);
  if (cleaned.length !== LEGACY_HARDCODED_WATCH_STOCKS.length) return false;
  return LEGACY_HARDCODED_WATCH_STOCKS.every((code, idx) => cleaned[idx] === code);
}

const PROVIDER_META = {
  codex_cli: { label: 'Codex 官方套餐', group: 'cli' },
  gemini_cli: { label: 'Gemini CLI', group: 'cli' },
  deepseek: { label: 'DeepSeek', group: 'cn_api' },
  qwen: { label: '通义千问 Qwen', group: 'cn_api' },
  moonshot: { label: 'Kimi (Moonshot)', group: 'cn_api' },
  zhipu: { label: '智谱 GLM', group: 'cn_api' },
  gemini: { label: 'Google Gemini API', group: 'intl_api' },
  openai: { label: 'OpenAI / GPT API', group: 'intl_api' },
  custom: { label: '自定义兼容 API', group: 'intl_api' },
};

const DEFAULT_CONFIG = {
  provider: 'deepseek',
  codex_cli: {
    command: 'codex',
    model: '',
    reasoningEffort: 'medium',
  },
  gemini_cli: {
    command: 'gemini',
    model: '',
  },
  deepseek: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  qwen: {
    apiKey: '',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  moonshot: {
    apiKey: '',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0711-preview',
  },
  zhipu: {
    apiKey: '',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
  },
  gemini: {
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-pro',
    enableGoogleSearch: true,
  },
  openai: {
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
  },
  custom: {
    label: '自定义网关 / 硅基流动 / OpenRouter / 豆包',
    apiKey: '',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
  },
  temperature: 0.2,
  watchStocks: [],
};

function maskKey(key) {
  if (!key || key.length < 8) return key ? '****' : '';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

const SAFE_CLI_BASENAMES = new Set(['codex', 'codex.exe', 'codex.cmd', 'gemini', 'gemini.exe', 'gemini.cmd']);

function sanitizeCliCommand(rawCmd, fallback) {
  const s = String(rawCmd || '').trim();
  if (!s || /[&|;<>^$`"\n\r]/.test(s)) return fallback;
  const base = path.basename(s).toLowerCase();
  if (SAFE_CLI_BASENAMES.has(s.toLowerCase())) return s;
  if (path.isAbsolute(s) && SAFE_CLI_BASENAMES.has(base) && fs.existsSync(s)) return s;
  return fallback;
}

/**
 * 在不启用 shell:true 的前提下，将 Windows .cmd npm shim 安全解析为 node + 入口脚本，
 * 或直接定位 PATH 中的可执行文件（彻底根除 DEP0190 与命令注入风险）。
 */
function resolveExecutableSpec(cmd) {
  const safe = String(cmd || '').trim();
  if (!safe || /[&|;<>^$`"\n\r]/.test(safe)) return null;
  const candidates = [];
  if (path.isAbsolute(safe)) {
    candidates.push(safe);
  } else {
    const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
    for (const dir of pathDirs) {
      for (const ext of exts) {
        const name = safe.toLowerCase().endsWith(ext) || !ext ? safe : `${safe}${ext}`;
        candidates.push(path.join(dir, name));
      }
    }
  }
  for (const full of candidates) {
    try {
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
      if (process.platform === 'win32' && /\.cmd$/i.test(full)) {
        // 解析 npm 生成的 .cmd 包装器中的 JS 入口路径，直接交由 node.exe 无 shell 执行
        const text = fs.readFileSync(full, 'utf8');
        const m = text.match(/"%dp0%\\([^"]+\.(?:js|mjs|cjs))"/i) || text.match(/%~dp0\\([^\s"]+\.(?:js|mjs|cjs))/i);
        if (m) {
          const jsPath = path.resolve(path.dirname(full), m[1]);
          if (fs.existsSync(jsPath)) {
            return { bin: process.execPath, prefixArgs: [jsPath], resolvedPath: full };
          }
        }
        continue;
      }
      return { bin: full, prefixArgs: [], resolvedPath: full };
    } catch {
      // ignore
    }
  }
  return null;
}

function runProbeAsync(cmd, args, timeoutMs = 4500) {
  return new Promise((resolve) => {
    const spec = resolveExecutableSpec(cmd);
    if (!spec) {
      resolve({ status: -1, output: '', error: 'command not found' });
      return;
    }
    execFile(
      spec.bin,
      [...spec.prefixArgs, ...args],
      { windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const combined = `${stdout || ''}\n${stderr || ''}`.trim();
        resolve({
          status: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          output: combined,
          error: err ? err.message : null,
        });
      }
    );
  });
}

let cachedCliStatus = {
  checkedAt: null,
  codex_cli: { installed: false, version: '', loggedIn: false, authStatus: '后台检测中...', command: 'codex' },
  gemini_cli: { installed: false, version: '', loggedIn: false, authStatus: '后台检测中...', command: 'gemini' },
};
let cachedCliAt = 0;
let cliProbeInFlight = null;

function refreshLocalClisAsync() {
  if (cliProbeInFlight) return cliProbeInFlight;
  const cfg = loadRawConfig();
  const codexCmd = sanitizeCliCommand(cfg.codex_cli.command, 'codex');
  const geminiCmd = sanitizeCliCommand(cfg.gemini_cli.command, 'gemini');

  cliProbeInFlight = (async () => {
    try {
      const [codexVer, geminiVer] = await Promise.all([
        runProbeAsync(codexCmd, ['--version']),
        runProbeAsync(geminiCmd, ['--version']),
      ]);
      const codexInstalled = codexVer.status === 0 && /codex/i.test(codexVer.output);
      let codexLoggedIn = false;
      let codexAuthText = codexInstalled ? '未登录（请在终端运行 codex login）' : '未检测到本机 codex 命令';
      if (codexInstalled) {
        const loginProbe = await runProbeAsync(codexCmd, ['login', 'status']);
        if (/logged in/i.test(loginProbe.output)) {
          codexLoggedIn = true;
          codexAuthText = loginProbe.output.split(/\r?\n/).find((l) => /logged in/i.test(l)) || 'Logged in';
        } else if (loginProbe.output) {
          codexAuthText = loginProbe.output.split(/\r?\n/)[0];
        }
      }
      const geminiInstalled =
        geminiVer.status === 0 &&
        geminiVer.output.length > 0 &&
        !/not recognized|不是内部或外部命令/i.test(geminiVer.output);

      cachedCliStatus = {
        checkedAt: new Date().toISOString(),
        codex_cli: {
          installed: codexInstalled,
          version: codexInstalled ? codexVer.output.split(/\r?\n/)[0].trim() : '',
          loggedIn: codexLoggedIn,
          authStatus: codexAuthText,
          command: codexCmd,
        },
        gemini_cli: {
          installed: geminiInstalled,
          version: geminiInstalled ? geminiVer.output.split(/\r?\n/)[0].trim() : '',
          loggedIn: geminiInstalled,
          authStatus: geminiInstalled ? '已检测到本机 Gemini CLI（将沿用当前 Google 登录态）' : '未检测到本机 gemini 命令',
          command: geminiCmd,
        },
      };
      cachedCliAt = Date.now();
    } finally {
      cliProbeInFlight = null;
    }
    return cachedCliStatus;
  })();
  return cliProbeInFlight;
}

function detectLocalClis(force = false) {
  // 非阻塞瞬时返回缓存并在后台异步刷新，绝不阻塞 Node 事件循环
  if (force || !cachedCliAt || Date.now() - cachedCliAt > 60000) {
    refreshLocalClisAsync().catch(() => {});
  }
  return cachedCliStatus;
}

function loadRawConfig() {
  let stored = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      stored = {};
    }
  }

  const envMap = {
    deepseek: process.env.DEEPSEEK_API_KEY || '',
    qwen: process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '',
    moonshot: process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || '',
    zhipu: process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || '',
    gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
    custom: process.env.CUSTOM_AI_API_KEY || '',
  };

  const mergeApi = (key) => ({
    ...(DEFAULT_CONFIG[key].label !== undefined ? { label: stored[key]?.label || DEFAULT_CONFIG[key].label } : {}),
    apiKey: decryptSecret(stored[key]?.apiKey) || envMap[key] || '',
    baseUrl: (stored[key]?.baseUrl || DEFAULT_CONFIG[key].baseUrl).replace(/\/+$/, ''),
    model: stored[key]?.model || DEFAULT_CONFIG[key].model,
  });

  const hasSavedConfig = fs.existsSync(CONFIG_PATH);
  const rawStoredWatch = Array.isArray(stored.watchStocks)
    ? stored.watchStocks.map((s) => String(s || '').trim()).filter(Boolean)
    : null;
  const rawSource = stored.watchStocksSource;

  let watchStocksSource = 'unset';
  let watchStocksConfigured = false;
  let watchStocksLegacyPendingConfirm = false;
  let legacyWatchStocks = [];
  let effectiveWatchStocks = [];

  if (rawSource === 'user' && rawStoredWatch !== null) {
    watchStocksSource = 'user';
    watchStocksConfigured = true;
    effectiveWatchStocks = rawStoredWatch;
  } else if (rawSource === 'unset') {
    watchStocksSource = 'unset';
    watchStocksConfigured = false;
  } else if (rawStoredWatch !== null) {
    if (isExactLegacyDefaultWatchStocks(rawStoredWatch)) {
      // 无来源标记且与旧版固定 6 股完全一致：确认前先按当前工作空间自选回退，不强覆盖用户当前空间自选
      watchStocksSource = 'legacy_unconfirmed';
      watchStocksConfigured = false;
      watchStocksLegacyPendingConfirm = true;
      legacyWatchStocks = rawStoredWatch;
      effectiveWatchStocks = [];
    } else {
      // 明确的自定义列表或显式空数组 []：尊重历史用户意图
      watchStocksSource = 'user';
      watchStocksConfigured = true;
      effectiveWatchStocks = rawStoredWatch;
    }
  }

  return {
    hasSavedConfig,
    watchStocksConfigured,
    watchStocksSource,
    watchStocksLegacyPendingConfirm,
    legacyWatchStocks,
    provider: VALID_PROVIDERS.includes(stored.provider) ? stored.provider : DEFAULT_CONFIG.provider,
    temperature: Number.isFinite(Number(stored.temperature)) ? Number(stored.temperature) : DEFAULT_CONFIG.temperature,
    watchStocks: effectiveWatchStocks,
    codex_cli: {
      command: stored.codex_cli?.command || DEFAULT_CONFIG.codex_cli.command,
      model: stored.codex_cli?.model ?? DEFAULT_CONFIG.codex_cli.model,
      reasoningEffort: stored.codex_cli?.reasoningEffort ?? DEFAULT_CONFIG.codex_cli.reasoningEffort,
    },
    gemini_cli: {
      command: stored.gemini_cli?.command || DEFAULT_CONFIG.gemini_cli.command,
      model: stored.gemini_cli?.model ?? DEFAULT_CONFIG.gemini_cli.model,
    },
    deepseek: mergeApi('deepseek'),
    qwen: mergeApi('qwen'),
    moonshot: mergeApi('moonshot'),
    zhipu: mergeApi('zhipu'),
    gemini: {
      ...mergeApi('gemini'),
      enableGoogleSearch:
        stored.gemini?.enableGoogleSearch !== undefined
          ? Boolean(stored.gemini.enableGoogleSearch)
          : DEFAULT_CONFIG.gemini.enableGoogleSearch,
    },
    openai: mergeApi('openai'),
    custom: mergeApi('custom'),
  };
}

function getSafeConfigForClient(forceCliRefresh = false) {
  const cfg = loadRawConfig();
  const localClis = detectLocalClis(forceCliRefresh);

  let effectiveProvider = cfg.provider;
  if (!cfg.hasSavedConfig) {
    if (cfg.deepseek.apiKey) effectiveProvider = 'deepseek';
    else if (cfg.qwen.apiKey) effectiveProvider = 'qwen';
    else if (cfg.moonshot.apiKey) effectiveProvider = 'moonshot';
    else if (cfg.gemini.apiKey) effectiveProvider = 'gemini';
    else if (cfg.openai.apiKey) effectiveProvider = 'openai';
    else if (cfg.zhipu.apiKey) effectiveProvider = 'zhipu';
    else if (cfg.custom.apiKey) effectiveProvider = 'custom';
    else effectiveProvider = 'deepseek';
  }

  const safeApi = (key) => ({
    ...(cfg[key].label !== undefined ? { label: cfg[key].label } : {}),
    hasApiKey: Boolean(cfg[key].apiKey),
    maskedKey: maskKey(cfg[key].apiKey),
    baseUrl: cfg[key].baseUrl,
    model: cfg[key].model,
  });

  return {
    hasSavedConfig: cfg.hasSavedConfig,
    watchStocksConfigured: cfg.watchStocksConfigured,
    watchStocksSource: cfg.watchStocksSource,
    watchStocksLegacyPendingConfirm: cfg.watchStocksLegacyPendingConfirm,
    legacyWatchStocks: cfg.legacyWatchStocks,
    provider: effectiveProvider,
    temperature: cfg.temperature,
    watchStocks: cfg.watchStocks,
    codex_cli: {
      ...cfg.codex_cli,
      ...localClis.codex_cli,
    },
    gemini_cli: {
      ...cfg.gemini_cli,
      ...localClis.gemini_cli,
    },
    deepseek: safeApi('deepseek'),
    qwen: safeApi('qwen'),
    moonshot: safeApi('moonshot'),
    zhipu: safeApi('zhipu'),
    gemini: {
      ...safeApi('gemini'),
      enableGoogleSearch: cfg.gemini.enableGoogleSearch,
    },
    openai: safeApi('openai'),
    custom: safeApi('custom'),
  };
}

function saveConfig(patch) {
  const current = loadRawConfig();

  const patchApi = (key) => ({
    ...(current[key].label !== undefined ? { label: (patch[key]?.label ?? current[key].label).trim() } : {}),
    apiKey: patch[key]?.clearApiKey
      ? ''
      : patch[key]?.apiKey && patch[key].apiKey.trim()
      ? patch[key].apiKey.trim()
      : current[key].apiKey,
    baseUrl: (patch[key]?.baseUrl || current[key].baseUrl).trim().replace(/\/+$/, ''),
    model: (patch[key]?.model || current[key].model).trim(),
  });

  let nextWatchStocks;
  let nextWatchStocksSource;
  if (patch.confirmLegacyWatchStocks === 'keep' || patch.confirmLegacyWatchStocks === 'use_watchlist') {
    if (!current.watchStocksLegacyPendingConfirm) {
      const err = new Error('旧版默认观察池迁移已完成或已被其他窗口修改，已拒绝过期确认覆盖，请刷新后查看最新配置');
      err.statusCode = 409;
      err.code = 'LEGACY_WATCH_STOCKS_ALREADY_RESOLVED';
      throw err;
    }
    if (patch.confirmLegacyWatchStocks === 'keep') {
      if (!Array.isArray(current.legacyWatchStocks) || current.legacyWatchStocks.length === 0) {
        const err = new Error('当前不存在待保留的旧版观察池记录，请刷新后重试');
        err.statusCode = 409;
        err.code = 'LEGACY_WATCH_STOCKS_ALREADY_RESOLVED';
        throw err;
      }
      nextWatchStocks = [...current.legacyWatchStocks];
      nextWatchStocksSource = 'user';
    } else {
      nextWatchStocks = undefined;
      nextWatchStocksSource = 'unset';
    }
  } else if (Array.isArray(patch.watchStocks)) {
    nextWatchStocks = patch.watchStocks.map((s) => String(s || '').trim()).filter(Boolean);
    nextWatchStocksSource = 'user';
  } else if (current.watchStocksSource === 'legacy_unconfirmed') {
    // 仅保存其他 AI 字段时，保持旧默认待确认状态，绝不静默升级为用户自定义
    nextWatchStocks = current.legacyWatchStocks;
    nextWatchStocksSource = undefined;
  } else if (current.watchStocksConfigured) {
    nextWatchStocks = current.watchStocks;
    nextWatchStocksSource = 'user';
  } else {
    nextWatchStocks = undefined;
    nextWatchStocksSource = current.watchStocksSource === 'unset' ? 'unset' : undefined;
  }

  const next = {
    provider: VALID_PROVIDERS.includes(patch.provider) ? patch.provider : current.provider,
    temperature: Number.isFinite(Number(patch.temperature)) ? Number(patch.temperature) : current.temperature,
    ...(nextWatchStocks !== undefined ? { watchStocks: nextWatchStocks } : {}),
    ...(nextWatchStocksSource !== undefined ? { watchStocksSource: nextWatchStocksSource } : {}),
    codex_cli: {
      command: sanitizeCliCommand(patch.codex_cli?.command ?? current.codex_cli.command, 'codex'),
      model: (patch.codex_cli?.model ?? current.codex_cli.model).trim(),
      reasoningEffort: (patch.codex_cli?.reasoningEffort ?? current.codex_cli.reasoningEffort).trim(),
    },
    gemini_cli: {
      command: sanitizeCliCommand(patch.gemini_cli?.command ?? current.gemini_cli.command, 'gemini'),
      model: (patch.gemini_cli?.model ?? current.gemini_cli.model).trim(),
    },
    deepseek: patchApi('deepseek'),
    qwen: patchApi('qwen'),
    moonshot: patchApi('moonshot'),
    zhipu: patchApi('zhipu'),
    gemini: {
      ...patchApi('gemini'),
      enableGoogleSearch:
        patch.gemini?.enableGoogleSearch !== undefined
          ? Boolean(patch.gemini.enableGoogleSearch)
          : current.gemini.enableGoogleSearch,
    },
    openai: patchApi('openai'),
    custom: patchApi('custom'),
  };

  const encryptedNext = { ...next };
  for (const k of ['deepseek', 'qwen', 'moonshot', 'zhipu', 'gemini', 'openai', 'custom']) {
    if (encryptedNext[k] && encryptedNext[k].apiKey) {
      encryptedNext[k] = { ...encryptedNext[k], apiKey: encryptSecret(encryptedNext[k].apiKey) };
    }
  }
  atomicWriteFileSync(CONFIG_PATH, JSON.stringify(encryptedNext, null, 2) + '\n', 'utf8', { mode: 0o600 });
  return getSafeConfigForClient(true);
}

module.exports = {
  CONFIG_PATH,
  VALID_PROVIDERS,
  OPENAI_COMPAT_PROVIDERS,
  PROVIDER_META,
  detectLocalClis,
  refreshLocalClisAsync,
  sanitizeCliCommand,
  resolveExecutableSpec,
  loadRawConfig,
  getSafeConfigForClient,
  saveConfig,
};
