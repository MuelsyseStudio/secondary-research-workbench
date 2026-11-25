'use strict';

/**
 * 方案 A 本地优先桌面应用 · 统一动态路径与多工作空间管理器
 *
 * 兼容两种运行模式：
 * 1. 开发者原位模式（未设置 SRW_DATA_DIR 且上级目录存在现行三库）：自动复用上级目录「现行三库」；独立开源克隆首次启动则自动初始化 ./data/现行三库。
 * 2. 桌面便携 / 商业分发模式（设置 SRW_DATA_DIR，如 <AppDir>/data）：
 *    - 所有用户三库、备份、交易账本、AI 配置、画线、推送日志全部隔离保存在 SRW_DATA_DIR 中；
 *    - 支持在 UI 内自由切换本地任意投研文件夹（含 Obsidian / Git / iCloud 同步目录），或一键新建空白/示例工作空间。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync } = require('./lru-cache.cjs');

const workspaceChangeHooks = new Set();

function registerWorkspaceChangeHook(fn) {
  if (typeof fn === 'function') workspaceChangeHooks.add(fn);
}

function notifyWorkspaceChanged() {
  for (const fn of workspaceChangeHooks) {
    try {
      fn();
    } catch {
      // non-fatal
    }
  }
}

const APP_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PROJECT_ROOT = path.resolve(APP_ROOT, '..');
const LOCAL_FALLBACK_DATA_DIR = path.join(APP_ROOT, 'data');
const ENV_DATA_DIR = process.env.SRW_DATA_DIR ? path.resolve(process.env.SRW_DATA_DIR) : null;
const ENV_STATE_DIR = process.env.SRW_STATE_DIR ? path.resolve(process.env.SRW_STATE_DIR) : null;
const IS_PORTABLE_MODE = Boolean(ENV_DATA_DIR);

// 状态文件存放目录（ai-config.local.json / trade-ledger.local.json / backups / jobs_cache 等）
const BASE_STATE_DIR = ENV_STATE_DIR || ENV_DATA_DIR || APP_ROOT;
const PROFILE_FILE = path.join(BASE_STATE_DIR, 'workspace-profile.local.json');
const STARTER_TEMPLATE_DIR = path.join(APP_ROOT, 'templates', 'starter-workspace');

const BLANK_METHODOLOGY_MD = `# 方法论卡片库

> 版本：v1.0（${new Date().toISOString().slice(0, 10)}）。
> 同步日期：${new Date().toISOString().slice(0, 10)}；基线：v1.0。
> 配套现行文件：[行业前沿认知库 v1.0](行业前沿认知库.md)；[研判与复盘台账 v1.0](研判与复盘台账.md)。

## 完整目录

| 层级 | 标题 | 状态 | 备注 |
| :--- | :--- | :--- | :--- |
| H1 | [第一编 风控与交易纪律](#sec-1) | 现行 | 001 |
| H2 | [卡片 001 \| 交易风控（以损定仓与单笔硬止损）](#method-001) | 0.85 | 底线卡 |
| H2 | [冲突 1（v1.0）：左侧低吸 vs 右侧突破确认](#conflict-1) | 现行 | 示例 |

---

<a id="sec-1"></a>

# 第一编 风控与交易纪律

<a id="method-001"></a>
## 卡片 001 | 交易风控（以损定仓与单笔硬止损）

- 核心论断：任何开仓必须在入场前锁定硬止损价与最大亏损比例（1R ≤ 总资金 1.5%），触发即无条件执行，禁止把短线错单扛成长线。
- 逻辑链条：事前确定止损价 → 测算每股止损距离 → 倒推精确可买股数 → 杜绝单笔致命回撤。
- 适用条件：A股、美股、港股所有方向性交易。
- 失效信号：无失效（账户生存红线）。
- 可信度：0.85（核心底线卡）
- 来源：空白工作空间初始卡

---

# 冲突解决矩阵

<a id="conflict-1"></a>
## 冲突 1（v1.0）：左侧低吸 vs 右侧突破确认

- 双方：卡片 001 与趋势右侧追击策略
- 冲突点：左侧低吸价格便宜但可能面临阴跌，右侧突破胜率高但止损距离拉大。
- 折中思路：左侧仅允许小仓分批试错，放量突破并站稳关键支撑位后再按 R 倍数补足主仓。
`;

const BLANK_COGNITION_MD = `# 行业前沿认知库

> 版本：v1.0（${new Date().toISOString().slice(0, 10)}）。
> 同步日期：${new Date().toISOString().slice(0, 10)}；全库共1张。
> 配套现行文件：[方法论卡片库 v1.0](方法论卡片库.md)；[研判与复盘台账 v1.0](研判与复盘台账.md)。

## 完整目录

| 层级 | 标题 | 状态 | 备注 |
| :--- | :--- | :--- | :--- |
| H1 | [第一编 初始认知批次](#cog-sec-1) | 现行 | 001 |
| H2 | [认知卡 001 \| ${new Date().toISOString().slice(0, 10)} 入库 \| 示例：请在此沉淀可验证的产业硬事实](#cognition-001) | A级 | 初始 |

---

<a id="cog-sec-1"></a>

# 第一编 初始认知批次

<a id="cognition-001"></a>
## 认知卡 001 | ${new Date().toISOString().slice(0, 10)} 入库 | 示例：请在此沉淀可验证的产业硬事实

- 事实：请严格区分「A/B 级客观产业事实」与「主观推演」，支持使用「AI 文献/语音转化」一键解析研报或调研纪要。
- 来源：工作空间初始模板
- 证据等级：A级
- 产业含义：跟踪核心产业链供需拐点与资本开支方向。
- A股映射：记录核心受益环节、竞争壁垒与证伪观测指标。
- 置信度：中
- 失效/更新条件：行业资本开支大幅下修或毛利率连续两季下滑。
`;

const BLANK_LEDGER_MD = `# 研判与复盘台账

> 版本：v1.0（${new Date().toISOString().slice(0, 10)} 初始台账）。
> 同步日期：${new Date().toISOString().slice(0, 10)}；基线：v1.0，最新日度正文为-。
> 关联文件：[方法论卡片库.md](方法论卡片库.md) v1.0；[行业前沿认知库.md](行业前沿认知库.md) v1.0。

---

# 一、标的研判与验证台账

（尚未录入标的研判，请点击「发起标的研判」体验 AI 联网深度分析或投委会多空对抗）

---

# 二、每日 A 股复盘台账

（尚未录入日度复盘，请点击「录入日度复盘」采集真实 1 分钟 K 线并一键生成复盘）
`;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

const PORTABLE_DATA_MARKER = '__PORTABLE_DATA__';
const SUB_WS_PREFIX = '__SUB_WS__:';

function getDefaultProjectRoot() {
  if (ENV_DATA_DIR) return ENV_DATA_DIR;
  if (hasThreeLibraries(DEFAULT_PROJECT_ROOT)) return DEFAULT_PROJECT_ROOT;
  return LOCAL_FALLBACK_DATA_DIR;
}

function encodePortableWorkspacePath(absDir) {
  if (!absDir) return null;
  const resolved = path.resolve(absDir);
  const defRoot = path.resolve(getDefaultProjectRoot());
  if (resolved.toLowerCase() === defRoot.toLowerCase()) {
    return PORTABLE_DATA_MARKER;
  }
  const subWsRoot = path.resolve(BASE_STATE_DIR, 'workspaces');
  const rel = path.relative(subWsRoot, resolved);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !/[\\/]/.test(rel)) {
    return `${SUB_WS_PREFIX}${rel}`;
  }
  return resolved;
}

function decodePortableWorkspacePath(storedPath) {
  const raw = String(storedPath || '').trim();
  if (!raw) return null;
  const defRoot = path.resolve(getDefaultProjectRoot());
  if (raw === PORTABLE_DATA_MARKER) return defRoot;
  if (raw.startsWith(SUB_WS_PREFIX)) {
    const name = raw.slice(SUB_WS_PREFIX.length).replace(/[\\/:*?"<>|]/g, '_');
    return path.resolve(BASE_STATE_DIR, 'workspaces', name);
  }
  return path.resolve(raw);
}

function loadProfile() {
  try {
    if (fs.existsSync(PROFILE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        const decodedActive = decodePortableWorkspacePath(raw.activeProjectRoot);
        const decodedSaved = Array.isArray(raw.savedWorkspaces)
          ? raw.savedWorkspaces
              .map((w) => (w && w.path ? { ...w, path: decodePortableWorkspacePath(w.path) } : null))
              .filter((w) => w && w.path)
          : [];
        // 便携版跨目录升级防脑裂：若已复制 data/ 到新版目录，且旧 profile 里存的是外部绝对路径，自动识别并优先采用当前 data/ 目录（除非是当前目录内的子空间）
        let finalActive = decodedActive;
        if (IS_PORTABLE_MODE && raw.activeProjectRoot && raw.activeProjectRoot !== PORTABLE_DATA_MARKER && !String(raw.activeProjectRoot).startsWith(SUB_WS_PREFIX)) {
          const defRoot = path.resolve(ENV_DATA_DIR || DEFAULT_PROJECT_ROOT);
          const relToState = path.relative(path.resolve(BASE_STATE_DIR), decodedActive || '');
          const isInsideState = relToState && !relToState.startsWith('..') && !path.isAbsolute(relToState);
          if (!isInsideState && hasThreeLibraries(defRoot) && /[/\\]data[/\\]?$/i.test(String(raw.activeProjectRoot))) {
            finalActive = defRoot;
          }
        }
        return { activeProjectRoot: finalActive, savedWorkspaces: decodedSaved };
      }
    }
  } catch {
    // ignore
  }
  return { activeProjectRoot: null, savedWorkspaces: [] };
}

function saveProfile(profile) {
  ensureDir(BASE_STATE_DIR);
  const encoded = {
    activeProjectRoot: encodePortableWorkspacePath(profile.activeProjectRoot),
    savedWorkspaces: (Array.isArray(profile.savedWorkspaces) ? profile.savedWorkspaces : []).map((w) => ({
      ...w,
      path: encodePortableWorkspacePath(w.path),
    })),
  };
  atomicWriteFileSync(PROFILE_FILE, JSON.stringify(encoded, null, 2) + '\n', 'utf8');
}

function hasLegacyThreeLibraries(projectRoot) {
  if (!projectRoot) return false;
  const cur = path.join(projectRoot, '现行三库');
  return (
    fs.existsSync(path.join(cur, '方法论卡片库.md')) &&
    fs.existsSync(path.join(cur, '行业前沿认知库.md')) &&
    fs.existsSync(path.join(cur, '研判与复盘台账.md'))
  );
}

function hasKbV2(projectRoot) {
  if (!projectRoot) return false;
  const kbDir = path.join(projectRoot, 'kb');
  return (
    fs.existsSync(path.join(kbDir, 'kb.manifest.yaml')) &&
    fs.existsSync(path.join(kbDir, 'cards'))
  );
}

function detectKbMode(projectRoot) {
  return hasKbV2(projectRoot) ? 'v2' : 'v1';
}

function hasThreeLibraries(projectRoot) {
  return hasLegacyThreeLibraries(projectRoot) || hasKbV2(projectRoot);
}

function copyDirRecursive(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function initializeWorkspaceDir(targetDir, template = 'starter') {
  const resolved = path.resolve(targetDir);
  const currentDir = path.join(resolved, '现行三库');
  ensureDir(currentDir);

  if (template === 'starter' && fs.existsSync(path.join(STARTER_TEMPLATE_DIR, '现行三库'))) {
    copyDirRecursive(path.join(STARTER_TEMPLATE_DIR, '现行三库'), currentDir);
  } else {
    const files = [
      ['方法论卡片库.md', BLANK_METHODOLOGY_MD],
      ['行业前沿认知库.md', BLANK_COGNITION_MD],
      ['研判与复盘台账.md', BLANK_LEDGER_MD],
    ];
    for (const [name, content] of files) {
      const target = path.join(currentDir, name);
      if (!fs.existsSync(target)) {
        fs.writeFileSync(target, content, 'utf8');
      }
    }
  }
  return resolved;
}

function getActiveProjectRoot() {
  const profile = loadProfile();
  if (profile.activeProjectRoot && hasThreeLibraries(profile.activeProjectRoot)) {
    return path.resolve(profile.activeProjectRoot);
  }
  if (ENV_DATA_DIR) {
    if (!hasThreeLibraries(ENV_DATA_DIR)) {
      initializeWorkspaceDir(ENV_DATA_DIR, 'starter');
    }
    return ENV_DATA_DIR;
  }
  if (hasThreeLibraries(DEFAULT_PROJECT_ROOT)) {
    return DEFAULT_PROJECT_ROOT;
  }
  // 开源独立克隆或首次无上级三库目录启动：自动在 ./data/ 初始化标准示例三库，做到 clone 即用
  if (!hasThreeLibraries(LOCAL_FALLBACK_DATA_DIR)) {
    initializeWorkspaceDir(LOCAL_FALLBACK_DATA_DIR, 'starter');
  }
  return LOCAL_FALLBACK_DATA_DIR;
}

function getStateDir() {
  ensureDir(BASE_STATE_DIR);
  return BASE_STATE_DIR;
}

function stateFile(fileName) {
  return path.join(getStateDir(), fileName);
}

/**
 * 按当前激活工作空间隔离状态文件：
 * - 默认工作空间沿用原文件名（确保已有用户自选零丢失、100% 兼容）；
 * - 位于 data/workspaces/<name> 的内置子空间优先使用与绝对路径无关的可移植哈希前缀（基于子空间名），
 *   跨盘符/升级目录复制后零丢失，并透明兼容旧绝对路径哈希迁移；
 * - 外部挂载目录按规范路径哈希隔离，互不串库。
 */
function workspaceStateFile(fileName) {
  const activeResolved = path.resolve(getActiveProjectRoot());
  const active = activeResolved.toLowerCase();
  const defRoot = path.resolve(getDefaultProjectRoot()).toLowerCase();
  if (active === defRoot) {
    return stateFile(fileName);
  }
  const subWsRoot = path.resolve(BASE_STATE_DIR, 'workspaces');
  const relSub = path.relative(subWsRoot, activeResolved);
  if (relSub && !relSub.startsWith('..') && !path.isAbsolute(relSub) && !/[\\/]/.test(relSub)) {
    const portableHash = crypto.createHash('sha256').update(`sub:${relSub.toLowerCase()}`).digest('hex').slice(0, 12);
    const portablePath = stateFile(`ws-sub-${portableHash}-${fileName}`);
    if (fs.existsSync(portablePath)) return portablePath;
    const legacyHash = crypto.createHash('sha256').update(active).digest('hex').slice(0, 12);
    const legacyPath = stateFile(`ws-${legacyHash}-${fileName}`);
    if (fs.existsSync(legacyPath)) {
      try {
        fs.copyFileSync(legacyPath, portablePath);
      } catch {
        return legacyPath;
      }
    }
    return portablePath;
  }
  const hash = crypto.createHash('sha256').update(active).digest('hex').slice(0, 12);
  return stateFile(`ws-${hash}-${fileName}`);
}

function stateSubDir(dirName) {
  const full = path.join(getStateDir(), dirName);
  ensureDir(full);
  return full;
}

function getDynamicPaths() {
  const projectRoot = getActiveProjectRoot();
  const currentDir = path.join(projectRoot, '现行三库');
  const kbDir = path.join(projectRoot, 'kb');
  const kbMode = detectKbMode(projectRoot);
  const reviewCandidate = path.join(projectRoot, '日度复盘工作台_2026-11-23');
  const reviewWorkbenchDir = fs.existsSync(reviewCandidate)
    ? reviewCandidate
    : path.join(projectRoot, '复盘证据工作台');

  return {
    appRoot: APP_ROOT,
    stateDir: getStateDir(),
    projectRoot,
    currentDir,
    kbMode,
    kbDir,
    kbSqlitePath: path.join(kbDir, '.index', 'knowledge.sqlite'),
    kbTopicsDir: path.join(kbDir, 'topics'),
    kbEventsDir: path.join(kbDir, 'events'),
    methodology: path.join(currentDir, '方法论卡片库.md'),
    cognition: path.join(currentDir, '行业前沿认知库.md'),
    ledger: path.join(currentDir, '研判与复盘台账.md'),
    entry: path.join(projectRoot, '00_项目入口.md'),
    reviewWorkbenchDir,
    exportHtmlDir: path.join(projectRoot, '复盘简报HTML'),
    periodicHtmlDir: path.join(projectRoot, '周期复盘HTML'),
    backupsDir: path.join(getStateDir(), 'backups'),
    jobsDir: path.join(getStateDir(), 'jobs_cache'),
    packetsDir: path.join(getStateDir(), 'market_packets'),
    isPortableMode: IS_PORTABLE_MODE,
  };
}

/**
 * 动态代理 PATHS 对象，使既有代码读取 PATHS.methodology / PATHS.backupsDir 等永远反映当前激活的工作空间！
 */
const PATHS = new Proxy(
  {},
  {
    get(_target, prop) {
      return getDynamicPaths()[prop];
    },
    ownKeys() {
      return Object.keys(getDynamicPaths());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const val = getDynamicPaths()[prop];
      if (val === undefined) return undefined;
      return { enumerable: true, configurable: true, value: val };
    },
  }
);

function getWorkspaceProfileInfo() {
  const profile = loadProfile();
  const active = getActiveProjectRoot();
  const defaultRoot = getDefaultProjectRoot();
  const saved = Array.isArray(profile.savedWorkspaces) ? profile.savedWorkspaces : [];
  const seen = new Set();
  const list = [];

  const pushEntry = (dirPath, label) => {
    const abs = path.resolve(dirPath);
    const key = abs.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({
      path: abs,
      label: label || path.basename(abs),
      exists: hasThreeLibraries(abs),
      kbMode: detectKbMode(abs),
      isActive: abs.toLowerCase() === active.toLowerCase(),
      isDefault: abs.toLowerCase() === defaultRoot.toLowerCase(),
    });
  };

  pushEntry(defaultRoot, IS_PORTABLE_MODE ? '内置便携三库空间' : '主投研三库空间');
  for (const w of saved) {
    if (w && w.path) pushEntry(w.path, w.label);
  }
  pushEntry(active, path.basename(active));

  let appVersion = '1.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    appVersion = pkg.version || '1.0.0';
  } catch {
    // ignore
  }

  return {
    ok: true,
    appVersion,
    isPortableMode: IS_PORTABLE_MODE,
    kbMode: detectKbMode(active),
    activeProjectRoot: active,
    activeCurrentDir: path.join(active, '现行三库'),
    activeKbDir: path.join(active, 'kb'),
    stateDir: getStateDir(),
    workspaces: list,
  };
}

function switchActiveWorkspace({ targetDir, label, initIfMissing = false, template = 'starter' }) {
  const raw = String(targetDir || '').trim();
  if (!raw) throw new Error('请填写本地工作空间文件夹路径');
  const resolved = path.resolve(raw);

  if (!hasThreeLibraries(resolved)) {
    if (!initIfMissing) {
      throw new Error(`目录 "${resolved}" 下未检测到「现行三库/」三大 Markdown 文件或「kb/kb.manifest.yaml」卡片库；如需在该目录初始化新三库，请勾选「不存在时自动初始化」。`);
    }
    initializeWorkspaceDir(resolved, template);
  }

  const profile = loadProfile();
  const saved = Array.isArray(profile.savedWorkspaces) ? profile.savedWorkspaces : [];
  const cleanLabel = String(label || path.basename(resolved)).trim() || '自定义空间';
  const filtered = saved.filter((w) => w && w.path && path.resolve(w.path).toLowerCase() !== resolved.toLowerCase());
  filtered.unshift({ path: resolved, label: cleanLabel, updatedAt: new Date().toISOString() });

  saveProfile({
    activeProjectRoot: resolved,
    savedWorkspaces: filtered.slice(0, 12),
  });
  notifyWorkspaceChanged();

  return getWorkspaceProfileInfo();
}

function createSubWorkspace({ name, template = 'starter' }) {
  const safeName = String(name || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_');
  if (!safeName) throw new Error('请输入新工作空间名称（如：2026实盘空间 / 美股科技专题）');
  const baseParent = path.join(getStateDir(), 'workspaces');
  ensureDir(baseParent);
  const targetDir = path.join(baseParent, safeName);
  initializeWorkspaceDir(targetDir, template);
  return switchActiveWorkspace({ targetDir, label: safeName, initIfMissing: true, template });
}

module.exports = {
  APP_ROOT,
  IS_PORTABLE_MODE,
  STARTER_TEMPLATE_DIR,
  PATHS,
  getDynamicPaths,
  getStateDir,
  stateFile,
  workspaceStateFile,
  stateSubDir,
  registerWorkspaceChangeHook,
  notifyWorkspaceChanged,
  hasLegacyThreeLibraries,
  hasKbV2,
  detectKbMode,
  hasThreeLibraries,
  initializeWorkspaceDir,
  getWorkspaceProfileInfo,
  switchActiveWorkspace,
  createSubWorkspace,
};
