'use strict';

/**
 * 情报信源与定时进化中心（Intel Hub Engine）
 *
 * 面向“个人深度集成 + 发给朋友也能自主选源对接”双场景设计：
 * - 四大可插拔信源通道：
 *   1) 知识星球（动态调用本机 zsxq-cli，自动探测当前账号所有已开通 Skill 权限的星球，按星球配置路由轨道）
 *   2) 微信公众号订阅中心（双向桥接「微信文章清洗工具」，读 subscriptions.json & 公众号清洗归档/index.json，支持工作台内安全增量同步 + 一键打开 4546 扫码搜号界面）
 *   3) 本地研报/日报目录监听（支持监听 信息搜集/reports、Obsidian 剪藏、研报 PDF/DOCX/MD/HTML 目录）
 *   4) 免费公开实时电报 & 自定义 RSS/Atom（华尔街见闻全球/A股、东方财富要闻/公告、Semiconductor Engineering / Techmeme 等，免配置开箱即用）
 * - 三轨严格分流：
 *   - cognition   -> 行业前沿认知库（A/B/C 证据分级 + 事实/分析/映射分离 + 既有卡跨源互证增订）
 *   - methodology -> 方法论卡片库（宁缺毋滥，只提炼新规则、新边界增量与冲突矩阵）
 *   - sentiment   -> 日度情绪与主线风向摘要（供每日复盘参考，绝不污染方法论库）
 * - 治理铁律：所有 AI 产出先进入「候选收件箱（Intel Inbox）」，推送飞书/企微/钉钉/Bark 提醒，由用户在工作台勾选后走 Diff 确认门 + 原子快照备份写入现行三库。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { PATHS, IS_PORTABLE_MODE, stateFile } = require('./app-paths.cjs');
const { getEditionInfo } = require('./edition.cjs');
const { loadWorkspace } = require('./knowledge-store.cjs');
const { runAiIngestion } = require('./ai-ingestor.cjs');
const { extractDocumentText } = require('./doc-extractor.cjs');

const ROUTE_OPTIONS = ['cognition', 'methodology', 'both', 'sentiment'];

const PUBLIC_FEED_CATALOG = [
  {
    id: 'wscn_global',
    name: '华尔街见闻 · 全球宏观与科技 7×24',
    kind: 'wscn',
    channel: 'global-channel',
    route: 'cognition',
    minScore: 2,
    desc: '海外宏观利率、美股科技巨头、AI 算力与大宗商品重磅快讯（仅抓取重要标红条目）',
  },
  {
    id: 'wscn_astock',
    name: '华尔街见闻 · A 股核心快讯',
    kind: 'wscn',
    channel: 'a-stock-channel',
    route: 'sentiment',
    minScore: 2,
    desc: 'A 股盘面异动、政策表态、重磅行业催化与盘后要闻',
  },
  {
    id: 'em_important',
    name: '东方财富 · 产业与宏观要闻',
    kind: 'eastmoney',
    fastColumn: '102',
    route: 'cognition',
    desc: '国内宏观政策、产业部委动态与产业链供需快讯',
  },
  {
    id: 'em_company',
    name: '东方财富 · 上市公司重磅公告',
    kind: 'eastmoney',
    fastColumn: '103',
    route: 'cognition',
    desc: 'A 级一手信源：回购、业绩预告、大额订单、产能扩建与并购重组快讯',
  },
];

const RSS_PRESET_CATALOG = [
  {
    id: 'rss_semieng',
    name: 'Semiconductor Engineering（半导体工程深度）',
    url: 'https://semiengineering.com/feed/',
    route: 'cognition',
    category: '硬科技/半导体',
    desc: '全球顶级半导体先进制程、CoWoS 封装、HBM 与芯片架构深度技术报道',
  },
  {
    id: 'rss_techmeme',
    name: 'Techmeme（全球科技与 AI 头条聚合）',
    url: 'https://www.techmeme.com/feed.xml',
    route: 'cognition',
    category: '海外AI/科技',
    desc: '硅谷一线 AI 大模型、云厂商 CapEx 与科技巨头要闻实时聚合',
  },
  {
    id: 'rss_arxiv_ai',
    name: 'arXiv cs.AI（前沿人工智能论文日更）',
    url: 'https://rss.arxiv.org/rss/cs.AI',
    route: 'cognition',
    category: 'AI前沿技术',
    desc: '前沿架构创新、推理加速与 Agent 研究一手论文摘要',
  },
];

function configPath() {
  return stateFile('intel-hub-config.local.json');
}

function inboxPath() {
  return stateFile('intel-hub-inbox.local.json');
}

function watermarksPath() {
  return stateFile('intel-hub-watermarks.local.json');
}

function nowOffsetISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function todayISO(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sha1Short(text) {
  return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 14);
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function execFileAsync(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 25 * 1024 * 1024,
        windowsHide: true,
        timeout: opts.timeout || 60000,
        cwd: opts.cwd,
        env: opts.env || process.env,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? err.code || 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err ? err.message : '',
        });
      }
    );
  });
}

// ============================================================================
// 默认配置构建（便携版零私人数据；开发者本机自动发现相邻工具目录）
// ============================================================================

function detectLocalWechatToolDir() {
  if (IS_PORTABLE_MODE) return '';
  const candidates = [
    path.resolve(PATHS.projectRoot, '微信文章清洗工具'),
    path.resolve(PATHS.appRoot, '..', '微信文章清洗工具'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'cli.mjs')) && fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
  }
  return '';
}

function detectLocalReportFolders() {
  if (IS_PORTABLE_MODE) return [];
  const folders = [];
  const desktopParent = path.resolve(PATHS.projectRoot, '..');
  const zsxqReports = path.join(desktopParent, '信息搜集', 'reports');
  if (fs.existsSync(zsxqReports)) {
    folders.push({
      id: 'local_zsxq_reports',
      name: '知识星球每日投研总结报告（信息搜集/reports）',
      dirPath: zsxqReports,
      route: 'both',
      extensions: ['.md', '.txt'],
      nameIncludes: '每日投研总结报告',
      maxAgeDays: 2,
      enabled: true,
    });
  }
  return folders;
}

function buildDefaultConfig() {
  const detectedWechatDir = detectLocalWechatToolDir();
  const detectedFolders = detectLocalReportFolders();

  return {
    version: '1.0',
    schedule: {
      enabled: false,
      dailyHour: 20,
      dailyMinute: 30,
      autoAiDistill: true,
      autoWechatSync: false, // 默认谨慎：避免无意识触碰微信读书频控，用户可在 UI 一键开启
      pushWebhookSummary: true,
      lookbackDays: 1,
      lastRunDate: null,
      lastRunAt: null,
    },
    zsxq: {
      enabled: !IS_PORTABLE_MODE,
      groups: [], // 由「探测我的星球」自动填充或用户勾选；便携版默认为空，绝不硬编码他人星球 ID
      maxTopicsPerGroup: 60,
      minChars: 45,
    },
    wechat: {
      enabled: Boolean(detectedWechatDir),
      toolDir: detectedWechatDir,
      webPort: 4546,
      minChars: 180,
      accountRoutes: {}, // { [bookIdOrName]: { enabled: true, route: 'cognition' | 'methodology' | 'both' | 'sentiment' } }
    },
    localFolders: detectedFolders,
    publicFeeds: PUBLIC_FEED_CATALOG.map((f) => ({
      id: f.id,
      name: f.name,
      route: f.route,
      enabled:
        getEditionInfo().features.allowCommunityScrapers &&
        (f.id === 'wscn_global' || f.id === 'em_important' || f.id === 'em_company'),
    })),
    rssFeeds: [
      {
        id: 'rss_semieng',
        name: 'Semiconductor Engineering（半导体工程深度）',
        url: 'https://semiengineering.com/feed/',
        route: 'cognition',
        enabled: true,
      },
      {
        id: 'rss_techmeme',
        name: 'Techmeme（全球科技与 AI 头条聚合）',
        url: 'https://www.techmeme.com/feed.xml',
        route: 'cognition',
        enabled: false,
      },
    ],
    updatedAt: null,
  };
}

function loadIntelConfig() {
  const def = buildDefaultConfig();
  const p = configPath();
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const mergedPublic = PUBLIC_FEED_CATALOG.map((cat) => {
        const existing = (raw.publicFeeds || []).find((x) => x.id === cat.id);
        return existing
          ? { id: cat.id, name: cat.name, route: ROUTE_OPTIONS.includes(existing.route) ? existing.route : cat.route, enabled: Boolean(existing.enabled) }
          : def.publicFeeds.find((x) => x.id === cat.id);
      });
      return {
        ...def,
        ...raw,
        schedule: { ...def.schedule, ...(raw.schedule || {}) },
        zsxq: { ...def.zsxq, ...(raw.zsxq || {}), groups: Array.isArray(raw.zsxq?.groups) ? raw.zsxq.groups : def.zsxq.groups },
        wechat: {
          ...def.wechat,
          ...(raw.wechat || {}),
          accountRoutes: { ...(raw.wechat?.accountRoutes || {}) },
        },
        localFolders: Array.isArray(raw.localFolders) ? raw.localFolders : def.localFolders,
        publicFeeds: mergedPublic,
        rssFeeds: Array.isArray(raw.rssFeeds) ? raw.rssFeeds : def.rssFeeds,
      };
    }
  } catch {
    // fallback
  }
  return def;
}

function saveIntelConfig(patch) {
  const cur = loadIntelConfig();
  const next = {
    ...cur,
    ...(patch || {}),
    schedule: { ...cur.schedule, ...(patch?.schedule || {}) },
    zsxq: {
      ...cur.zsxq,
      ...(patch?.zsxq || {}),
      groups: Array.isArray(patch?.zsxq?.groups) ? patch.zsxq.groups : cur.zsxq.groups,
    },
    wechat: {
      ...cur.wechat,
      ...(patch?.wechat || {}),
      accountRoutes: patch?.wechat?.accountRoutes
        ? { ...cur.wechat.accountRoutes, ...patch.wechat.accountRoutes }
        : cur.wechat.accountRoutes,
    },
    localFolders: Array.isArray(patch?.localFolders) ? patch.localFolders : cur.localFolders,
    publicFeeds: Array.isArray(patch?.publicFeeds) ? patch.publicFeeds : cur.publicFeeds,
    rssFeeds: Array.isArray(patch?.rssFeeds) ? patch.rssFeeds : cur.rssFeeds,
    updatedAt: nowOffsetISO(),
  };
  next.schedule.dailyHour = Math.max(0, Math.min(23, Number(next.schedule.dailyHour ?? 20)));
  next.schedule.dailyMinute = Math.max(0, Math.min(59, Number(next.schedule.dailyMinute ?? 30)));
  next.schedule.lookbackDays = Math.max(1, Math.min(14, Number(next.schedule.lookbackDays ?? 1)));
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

function loadWatermarks() {
  try {
    if (fs.existsSync(watermarksPath())) {
      const raw = JSON.parse(fs.readFileSync(watermarksPath(), 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    }
  } catch {
    // ignore
  }
  return { seen: {} };
}

function saveWatermarks(wm) {
  const entries = Object.entries(wm.seen || {});
  if (entries.length > 5000) {
    entries.sort((a, b) => String(b[1]).localeCompare(String(a[1])));
    wm.seen = Object.fromEntries(entries.slice(0, 4000));
  }
  fs.writeFileSync(watermarksPath(), JSON.stringify(wm, null, 2) + '\n', 'utf8');
}

function loadInbox() {
  try {
    if (fs.existsSync(inboxPath())) {
      const raw = JSON.parse(fs.readFileSync(inboxPath(), 'utf8'));
      if (raw && Array.isArray(raw.batches)) return raw;
    }
  } catch {
    // ignore
  }
  return { batches: [], updatedAt: null };
}

function saveInbox(inbox) {
  const trimmed = {
    batches: (inbox.batches || []).slice(0, 20),
    updatedAt: nowOffsetISO(),
  };
  fs.writeFileSync(inboxPath(), JSON.stringify(trimmed, null, 2) + '\n', 'utf8');
  return trimmed;
}

// ============================================================================
// 通道 1：知识星球 zsxq-cli 探测与增量抓取
// ============================================================================

function resolveZsxqRunner() {
  const appdata = process.env.APPDATA || '';
  if (appdata) {
    const jsEntry = path.join(appdata, 'npm', 'node_modules', 'zsxq-cli', 'npm', 'scripts', 'zsxq-cli.js');
    if (fs.existsSync(jsEntry)) {
      return { bin: process.execPath, prefixArgs: [jsEntry], mode: 'node_js' };
    }
    const cmdPath = path.join(appdata, 'npm', 'zsxq-cli.cmd');
    if (fs.existsSync(cmdPath)) {
      return { bin: 'cmd.exe', prefixArgs: ['/c', cmdPath], mode: 'cmd' };
    }
  }
  return null;
}

async function runZsxqJson(args, timeout = 30000) {
  const runner = resolveZsxqRunner();
  if (!runner) {
    return { ok: false, notInstalled: true, error: '本机未检测到 zsxq-cli（请先 npm i -g zsxq-cli 并扫码登录）' };
  }
  const res = await execFileAsync(runner.bin, [...runner.prefixArgs, ...args], { timeout });
  if (!res.ok || !res.stdout.trim()) {
    return { ok: false, error: (res.stderr || res.stdout || res.error || 'zsxq-cli 执行失败').trim().slice(0, 240) };
  }
  try {
    return { ok: true, data: JSON.parse(res.stdout) };
  } catch (err) {
    return { ok: false, error: `zsxq-cli 输出解析失败: ${err.message}` };
  }
}

function cleanZsxqText(raw) {
  if (!raw) return { text: '', hashtags: [] };
  const hashtags = [];
  let s = String(raw).replace(/<e[^>]*type="([^"]*)"[^>]*title="([^"]*)"[^>]*\/?>/g, (_m, etype, title) => {
    let decoded = title || '';
    try { decoded = decodeURIComponent(decoded); } catch {}
    if (etype === 'hashtag') {
      const clean = decoded.replace(/^#+|#+$/g, '').trim();
      if (clean && !hashtags.includes(clean)) hashtags.push(clean);
      return `#${clean}# `;
    }
    return decoded;
  });
  s = s.replace(/<e[^>]*title="([^"]*)"[^>]*\/?>/g, (_m, title) => {
    try { return decodeURIComponent(title || ''); } catch { return title || ''; }
  });
  s = s.replace(/<[^>]+>/g, '');
  try { s = decodeURIComponent(s); } catch {}
  s = s.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text: s, hashtags };
}

function guessDefaultZsxqRoute(name) {
  const s = String(name || '');
  if (/Mark|策略|方法|宏观|体系/i.test(s)) return 'both';
  if (/情绪|打板|短线|复盘/i.test(s)) return 'sentiment';
  return 'cognition';
}

async function probeZsxqGroups({ testAccess = true } = {}) {
  const runner = resolveZsxqRunner();
  if (!runner) {
    return {
      ok: true,
      installed: false,
      authenticated: false,
      groups: [],
      message: '未检测到本机 zsxq-cli。如需接入知识星球，请运行 npm i -g zsxq-cli 并执行 zsxq-cli auth login 后重新探测。',
    };
  }
  const listRes = await runZsxqJson(['group', '+list', '--limit', '50', '--json'], 25000);
  if (!listRes.ok) {
    return {
      ok: true,
      installed: true,
      authenticated: false,
      groups: [],
      message: `zsxq-cli 已安装，但拉取星球列表失败（可能未登录或凭证过期）：${listRes.error}`,
    };
  }

  const rawGroups = listRes.data?.groups || [];
  const cfg = loadIntelConfig();
  const existingMap = new Map((cfg.zsxq.groups || []).map((g) => [String(g.groupId), g]));
  const results = [];

  for (const g of rawGroups) {
    const groupId = String(g.group_id || '');
    const name = String(g.name || groupId);
    const memberCount = Number(g.statistics?.members?.count || 0);
    const type = String(g.type || 'pay');
    const prev = existingMap.get(groupId);
    let readable = prev?.readable ?? null;
    let latestDate = prev?.latestDate || '';
    let accessError = '';

    if (testAccess && groupId) {
      const probe = await runZsxqJson(['group', '+topics', '--group-id', groupId, '--limit', '2', '--json'], 15000);
      if (probe.ok) {
        const items = probe.data?.topics_brief || probe.data?.topics || [];
        readable = true;
        latestDate = items[0]?.create_time ? String(items[0].create_time).slice(0, 10) : '';
      } else {
        readable = false;
        accessError = probe.error || '未开通 Skill 权限';
      }
    }

    const activeAndUseful = readable && (Boolean(latestDate) || memberCount > 2);
    results.push({
      groupId,
      name,
      type,
      memberCount,
      readable: Boolean(readable),
      latestDate,
      accessError,
      enabled: prev ? Boolean(prev.enabled) : Boolean(activeAndUseful),
      route: prev?.route || guessDefaultZsxqRoute(name),
    });
  }

  // 自动把探测到的可读星球合并进本地配置（若用户尚未配置过任何星球）
  if (cfg.zsxq.groups.length === 0 && results.some((r) => r.readable)) {
    saveIntelConfig({
      zsxq: {
        ...cfg.zsxq,
        enabled: true,
        groups: results.filter((r) => r.readable && (r.latestDate || r.memberCount > 1)),
      },
    });
  }

  return {
    ok: true,
    installed: true,
    authenticated: true,
    totalCount: results.length,
    readableCount: results.filter((r) => r.readable).length,
    groups: results,
  };
}

async function fetchZsxqItems(cfg, sinceDate) {
  const items = [];
  const errors = [];
  if (!cfg.zsxq?.enabled) return { items, errors };
  const groups = (cfg.zsxq.groups || []).filter((g) => g.enabled && g.groupId);
  if (groups.length === 0) return { items, errors };

  const runner = resolveZsxqRunner();
  if (!runner) {
    errors.push('知识星球通道已启用，但本机未检测到 zsxq-cli');
    return { items, errors };
  }

  const maxPerGroup = Math.max(10, Math.min(120, Number(cfg.zsxq.maxTopicsPerGroup || 60)));
  const minChars = Math.max(20, Number(cfg.zsxq.minChars || 45));

  for (const g of groups) {
    let endTime = '';
    const collected = [];
    let failed = false;

    for (let page = 0; page < 4; page++) {
      const args = ['group', '+topics', '--group-id', String(g.groupId), '--limit', '30', '--json'];
      if (endTime) args.push('--end-time', endTime);
      const res = await runZsxqJson(args, 20000);
      if (!res.ok) {
        errors.push(`星球「${g.name}」拉取失败: ${res.error}`);
        failed = true;
        break;
      }
      const list = res.data?.topics_brief || res.data?.topics || [];
      if (list.length === 0) break;

      let reachedOlder = false;
      for (const t of list) {
        const ct = String(t.create_time || '');
        const d = ct.slice(0, 10);
        if (d && d < sinceDate) {
          reachedOlder = true;
          continue;
        }
        collected.push(t);
      }

      if (reachedOlder || collected.length >= maxPerGroup || !res.data?.has_more) break;
      const nxt = res.data?.next_end_time || list[list.length - 1]?.create_time || '';
      if (!nxt || nxt === endTime) break;
      endTime = nxt;
    }

    if (failed && collected.length === 0) continue;

    for (const t of collected.slice(0, maxPerGroup)) {
      const tid = String(t.topic_id || '');
      const ct = String(t.create_time || '');
      const rawText = t.content || t.title || '';
      const { text, hashtags } = cleanZsxqText(rawText);
      const plainNoTags = text.replace(/#[^#\s]+#/g, '').trim();
      if (plainNoTags.length < minChars) continue;

      const author = t.owner?.name || g.name;
      items.push({
        itemKey: `zsxq:${g.groupId}:${tid || sha1Short(text)}`,
        channel: 'zsxq',
        sourceName: `星球 · ${g.name}`,
        sourceId: String(g.groupId),
        route: g.route || 'cognition',
        title: plainNoTags.split(/\r?\n/)[0].slice(0, 72),
        author,
        publishedAt: ct.slice(0, 16).replace('T', ' '),
        date: ct.slice(0, 10) || todayISO(),
        url: tid ? `https://wx.zsxq.com/group/${g.groupId}/topic/${tid}` : '',
        tags: hashtags,
        wordCount: plainNoTags.length,
        content: text.slice(0, 5000),
      });
    }
  }

  return { items, errors };
}

// ============================================================================
// 通道 2：微信公众号订阅中心（双向桥接「微信文章清洗工具」）
// ============================================================================

function guessDefaultWechatRoute(accountName, category = '') {
  const s = `${accountName} ${category}`;
  if (/复盘|短线|打板|情绪|盘面/.test(s)) return 'sentiment';
  if (/方法|策略|宏观|买方|框架|价值/.test(s)) return 'methodology';
  return 'cognition';
}

async function isPortAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

async function getWechatBridgeStatus(cfgInput) {
  const cfg = cfgInput || loadIntelConfig();
  const toolDir = String(cfg.wechat?.toolDir || '').trim();
  const webPort = Number(cfg.wechat?.webPort || 4546);
  const webUiUrl = `http://127.0.0.1:${webPort}`;

  if (!toolDir || !fs.existsSync(toolDir)) {
    return {
      ok: true,
      connected: false,
      toolDir,
      webUiUrl,
      webUiRunning: await isPortAlive(webPort),
      accounts: [],
      totalArchived: 0,
      message: toolDir
        ? `指定目录不存在：${toolDir}`
        : '尚未配置「微信文章清洗工具」目录。如已下载该工具，请在下方填入文件夹路径即可双向桥接订阅与归档。',
    };
  }

  const cliPath = path.join(toolDir, 'cli.mjs');
  const subFile = path.join(toolDir, 'data', 'subscriptions.json');
  const archiveDir = path.join(toolDir, '公众号清洗归档');
  const indexFile = path.join(archiveDir, 'index.json');

  let subs = { accounts: [], scheduler: {}, recentRuns: [] };
  if (fs.existsSync(subFile)) {
    try {
      subs = JSON.parse(fs.readFileSync(subFile, 'utf8'));
    } catch {}
  }

  let totalArchived = 0;
  let latestArchivedDate = '';
  const accountRecentCounts = new Map();
  if (fs.existsSync(indexFile)) {
    try {
      const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      const arts = Array.isArray(idx.articles) ? idx.articles : [];
      totalArchived = arts.length;
      const cutoff7 = todayISO(-7);
      for (const a of arts) {
        if (a.date && a.date > latestArchivedDate) latestArchivedDate = a.date;
        if (a.date && a.date >= cutoff7) {
          const k = a.weread_book_id || a.account || '';
          accountRecentCounts.set(k, (accountRecentCounts.get(k) || 0) + 1);
        }
      }
    } catch {}
  }

  const routeMap = cfg.wechat?.accountRoutes || {};
  const accounts = (subs.accounts || []).map((a) => {
    const key = a.bookId || a.id || a.name;
    const savedRoute = routeMap[key] || routeMap[a.name];
    return {
      id: key,
      bookId: a.bookId || a.id || '',
      name: a.name || key,
      category: a.category || '默认订阅',
      sourceEnabled: Boolean(a.enabled),
      enabled: savedRoute ? Boolean(savedRoute.enabled) : Boolean(a.enabled),
      route: savedRoute?.route || guessDefaultWechatRoute(a.name, a.category),
      lastArticleDate: a.lastArticleDate || '',
      lastArticleTitle: a.lastArticleTitle || '',
      totalSynced: Number(a.totalSynced || 0),
      recent7dCount: accountRecentCounts.get(key) || accountRecentCounts.get(a.name) || 0,
      lastStatus: a.lastStatus || 'idle',
      lastError: a.lastError || '',
    };
  });

  return {
    ok: true,
    connected: fs.existsSync(cliPath),
    toolDir,
    archiveDir,
    webUiUrl,
    webUiRunning: await isPortAlive(webPort),
    totalArchived,
    latestArchivedDate,
    accounts,
    lastGlobalCheckAt: subs.scheduler?.lastGlobalCheckAt || '',
  };
}

async function launchWechatWebUi(cfgInput) {
  const cfg = cfgInput || loadIntelConfig();
  const toolDir = String(cfg.wechat?.toolDir || '').trim();
  const webPort = Number(cfg.wechat?.webPort || 4546);
  const webUiUrl = `http://127.0.0.1:${webPort}`;

  if (await isPortAlive(webPort)) {
    return { ok: true, alreadyRunning: true, webUiUrl };
  }
  const serverScript = path.join(toolDir, 'web-server.mjs');
  if (!toolDir || !fs.existsSync(serverScript)) {
    throw new Error('未找到微信文章清洗工具的 web-server.mjs，请先在信源配置中填写正确路径');
  }

  const child = spawn(process.execPath, [serverScript, '--port', String(webPort)], {
    cwd: toolDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isPortAlive(webPort)) {
      return { ok: true, started: true, webUiUrl };
    }
  }
  return { ok: true, started: true, webUiUrl, note: '服务正在启动中，请稍等 1-2 秒刷新' };
}

async function triggerWechatIncrementalSync(cfgInput, bookId = '') {
  const cfg = cfgInput || loadIntelConfig();
  const toolDir = String(cfg.wechat?.toolDir || '').trim();
  const cliPath = path.join(toolDir, 'cli.mjs');
  if (!toolDir || !fs.existsSync(cliPath)) {
    throw new Error('未配置有效的「微信文章清洗工具」目录，无法执行公众号增量同步');
  }

  const args = [cliPath, 'sub-sync', '--json'];
  if (bookId) args.push('--book-id', String(bookId));
  const res = await execFileAsync(process.execPath, args, { cwd: toolDir, timeout: 180000 });
  let parsed = null;
  try {
    const jsonStart = res.stdout.indexOf('{');
    if (jsonStart >= 0) parsed = JSON.parse(res.stdout.slice(jsonStart));
  } catch {}

  if (!res.ok && !parsed) {
    throw new Error(`公众号增量同步失败：${(res.stderr || res.stdout || res.error).slice(0, 260)}`);
  }
  return {
    ok: true,
    summary: parsed || { rawOutput: res.stdout.slice(0, 600) },
    bridgeStatus: await getWechatBridgeStatus(cfg),
  };
}

function stripYamlFrontmatter(md) {
  const s = String(md || '');
  if (s.startsWith('---')) {
    const end = s.indexOf('\n---', 3);
    if (end > 0) return s.slice(end + 4).trim();
  }
  return s.trim();
}

function fetchWechatArchivedItems(cfg, sinceDate) {
  const items = [];
  const errors = [];
  if (!cfg.wechat?.enabled || !cfg.wechat?.toolDir) return { items, errors };

  const archiveDir = path.join(cfg.wechat.toolDir, '公众号清洗归档');
  const indexFile = path.join(archiveDir, 'index.json');
  if (!fs.existsSync(indexFile)) {
    errors.push(`未找到公众号归档索引：${indexFile}`);
    return { items, errors };
  }

  let articles = [];
  try {
    const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    articles = Array.isArray(idx.articles) ? idx.articles : [];
  } catch (err) {
    errors.push(`读取公众号索引失败：${err.message}`);
    return { items, errors };
  }

  const routeMap = cfg.wechat.accountRoutes || {};
  const minChars = Math.max(80, Number(cfg.wechat.minChars || 180));

  const recent = articles
    .filter((a) => a.date && a.date >= sinceDate)
    .sort((a, b) => String(b.published_at || b.date).localeCompare(String(a.published_at || a.date)))
    .slice(0, 60);

  for (const a of recent) {
    const key = a.weread_book_id || a.account || '';
    const rCfg = routeMap[key] || routeMap[a.account];
    if (rCfg && rCfg.enabled === false) continue;

    const fullPath = a.relative_path ? path.join(archiveDir, a.relative_path) : '';
    if (!fullPath || !fs.existsSync(fullPath)) continue;

    let body = '';
    try {
      body = stripYamlFrontmatter(fs.readFileSync(fullPath, 'utf8'));
    } catch {
      continue;
    }
    if (body.length < minChars) continue;

    const route = rCfg?.route || guessDefaultWechatRoute(a.account || '', '');
    items.push({
      itemKey: `wx:${a.content_sha256 || a.article_key || sha1Short(a.title + a.date)}`,
      channel: 'wechat',
      sourceName: `公众号 · ${a.account || '未知号'}`,
      sourceId: key,
      route,
      title: a.title || path.basename(fullPath, '.md'),
      author: a.author || a.account || '',
      publishedAt: a.published_at || a.date,
      date: a.date,
      url: a.source_url || '',
      tags: [a.account || '公众号'].filter(Boolean),
      wordCount: body.length,
      readNum: a.read_num || null,
      likeNum: a.like_num || null,
      content: body.slice(0, 7000),
    });
  }

  return { items, errors };
}

// ============================================================================
// 通道 3：本地研报 / 日报文件夹监听
// ============================================================================

async function fetchLocalFolderItems(cfg, sinceDate) {
  const items = [];
  const errors = [];
  const folders = (cfg.localFolders || []).filter((f) => f.enabled && f.dirPath);

  for (const folder of folders) {
    const dir = path.resolve(String(folder.dirPath));
    if (!fs.existsSync(dir)) {
      errors.push(`本地监听目录不存在：${dir}`);
      continue;
    }
    const exts = new Set(
      (Array.isArray(folder.extensions) && folder.extensions.length > 0 ? folder.extensions : ['.md', '.txt', '.html', '.pdf', '.docx']).map((e) =>
        String(e).toLowerCase().startsWith('.') ? String(e).toLowerCase() : `.${String(e).toLowerCase()}`
      )
    );
    const maxAgeDays = Math.max(1, Number(folder.maxAgeDays || 3));
    const cutoffMs = Date.now() - maxAgeDays * 86400000;
    const nameFilter = String(folder.nameIncludes || '').trim();

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
    } catch (err) {
      errors.push(`扫描目录失败 ${dir}: ${err.message}`);
      continue;
    }

    for (const entry of entries) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!exts.has(ext)) continue;
      if (nameFilter && !entry.name.includes(nameFilter)) continue;

      const fullPath = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      // 优先以文件名中的 YYYY-MM-DD 或修改时间过滤
      const dm = entry.name.match(/(\d{4}-\d{2}-\d{2})/);
      const fileDate = dm ? dm[1] : new Date(stat.mtimeMs).toISOString().slice(0, 10);
      if (fileDate < sinceDate && stat.mtimeMs < cutoffMs) continue;

      let text = '';
      try {
        if (ext === '.pdf' || ext === '.docx') {
          const buf = fs.readFileSync(fullPath);
          const extracted = await extractDocumentText({ fileName: entry.name, base64: buf.toString('base64') });
          text = extracted.text || '';
        } else {
          const raw = fs.readFileSync(fullPath, 'utf8');
          text = ext === '.html' || ext === '.htm' ? stripHtml(raw) : stripYamlFrontmatter(raw);
        }
      } catch (err) {
        errors.push(`解析本地文件失败 ${entry.name}: ${err.message}`);
        continue;
      }

      if (text.trim().length < 120) continue;

      items.push({
        itemKey: `local:${sha1Short(fullPath)}:${Math.floor(stat.mtimeMs / 1000)}`,
        channel: 'local_folder',
        sourceName: `本地目录 · ${folder.name || path.basename(dir)}`,
        sourceId: folder.id || dir,
        route: folder.route || 'cognition',
        title: entry.name.replace(/\.[^.]+$/, ''),
        author: folder.name || '本地文档',
        publishedAt: new Date(stat.mtimeMs).toISOString().slice(0, 16).replace('T', ' '),
        date: fileDate,
        url: '',
        tags: ['本地报告'],
        wordCount: text.length,
        content: text.slice(0, 14000),
      });
    }
  }

  return { items, errors };
}

// ============================================================================
// 通道 4：免费公开实时电报 & 零依赖 XML RSS/Atom 解析器 & 单篇链接快采
// ============================================================================

async function fetchPublicFeeds(cfg, sinceDate) {
  const items = [];
  const errors = [];
  if (!getEditionInfo().features.allowCommunityScrapers) {
    return {
      items,
      errors: [],
      notice: '当前商业版已按合规边界关闭第三方资讯站公开抓取，请改用合法授权 RSS / 本地研报目录 / 合规 Webhook 推送。',
    };
  }
  const enabledList = (cfg.publicFeeds || []).filter((f) => f.enabled);

  for (const fCfg of enabledList) {
    const meta = PUBLIC_FEED_CATALOG.find((c) => c.id === fCfg.id);
    if (!meta) continue;

    try {
      if (meta.kind === 'wscn') {
        const url = `https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=${encodeURIComponent(meta.channel)}&limit=30`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const rawItems = j?.data?.items || [];
        for (const it of rawItems) {
          const score = Number(it.score || 1);
          if (meta.minScore && score < meta.minScore && rawItems.length > 8) continue;
          const dt = it.display_time ? new Date(it.display_time * 1000) : new Date();
          const pad = (n) => String(n).padStart(2, '0');
          const dStr = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
          const tStr = `${dStr} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
          if (dStr < sinceDate) continue;
          const body = stripHtml(it.content_text || it.content || '');
          if (body.length < 30) continue;
          const title = String(it.title || body.slice(0, 65)).trim();
          items.push({
            itemKey: `wscn:${meta.channel}:${it.id || sha1Short(body)}`,
            channel: 'public_feed',
            sourceName: meta.name,
            sourceId: meta.id,
            route: fCfg.route || meta.route,
            title,
            author: '华尔街见闻',
            publishedAt: tStr,
            date: dStr,
            url: it.uri || '',
            tags: score >= 2 ? ['重要标红', '7x24电报'] : ['7x24电报'],
            wordCount: body.length,
            content: body.slice(0, 2000),
          });
        }
      } else if (meta.kind === 'eastmoney') {
        const url = `https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=${meta.fastColumn}&sortEnd=&pageSize=25&req_trace=${Date.now()}`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const list = j?.data?.fastNewsList || [];
        for (const it of list) {
          const showTime = String(it.showTime || '');
          const dStr = showTime.slice(0, 10) || todayISO();
          if (dStr < sinceDate) continue;
          const title = stripHtml(it.title || '');
          const summary = stripHtml(it.summary || '');
          const body = summary && summary !== title ? `${title}\n${summary}` : title;
          if (body.length < 25) continue;
          items.push({
            itemKey: `em:${meta.fastColumn}:${it.code || sha1Short(body)}`,
            channel: 'public_feed',
            sourceName: meta.name,
            sourceId: meta.id,
            route: fCfg.route || meta.route,
            title: title.slice(0, 75),
            author: '东方财富快讯',
            publishedAt: showTime.slice(0, 16),
            date: dStr,
            url: it.code ? `https://finance.eastmoney.com/a/${it.code}.html` : '',
            tags: meta.fastColumn === '103' ? ['公司公告'] : ['产业要闻'],
            wordCount: body.length,
            content: body.slice(0, 2000),
          });
        }
      }
    } catch (err) {
      errors.push(`公开源「${meta.name}」抓取失败: ${err.message}`);
    }
  }

  return { items, errors };
}

function extractXmlTag(block, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1];
  return v.trim();
}

function parseRssOrAtomXml(xmlText) {
  const entries = [];
  const itemMatches = xmlText.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of itemMatches.slice(0, 25)) {
    const title = stripHtml(extractXmlTag(block, 'title'));
    const link = stripHtml(extractXmlTag(block, 'link') || extractXmlTag(block, 'guid'));
    const pubDate = stripHtml(extractXmlTag(block, 'pubDate') || extractXmlTag(block, 'dc:date'));
    const desc = stripHtml(extractXmlTag(block, 'content:encoded') || extractXmlTag(block, 'description'));
    if (title || desc) entries.push({ title, link, pubDate, content: desc });
  }
  if (entries.length > 0) return entries;

  const atomMatches = xmlText.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of atomMatches.slice(0, 25)) {
    const title = stripHtml(extractXmlTag(block, 'title'));
    const linkHref = (block.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    const pubDate = stripHtml(extractXmlTag(block, 'updated') || extractXmlTag(block, 'published'));
    const desc = stripHtml(extractXmlTag(block, 'content') || extractXmlTag(block, 'summary'));
    if (title || desc) entries.push({ title, link: linkHref, pubDate, content: desc });
  }
  return entries;
}

async function fetchRssFeeds(cfg, sinceDate) {
  const items = [];
  const errors = [];
  const feeds = (cfg.rssFeeds || []).filter((r) => r.enabled && r.url);

  for (const feed of feeds) {
    try {
      const r = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 SecondaryResearchWorkbench/1.0' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const xml = await r.text();
      const parsed = parseRssOrAtomXml(xml);
      if (parsed.length === 0) {
        errors.push(`RSS「${feed.name}」未解析到条目（可能非标准 XML/Atom 格式）`);
        continue;
      }
      for (const e of parsed.slice(0, 15)) {
        let dStr = todayISO();
        let pStr = dStr;
        if (e.pubDate) {
          const dt = new Date(e.pubDate);
          if (!Number.isNaN(dt.getTime())) {
            dStr = dt.toISOString().slice(0, 10);
            pStr = dt.toISOString().slice(0, 16).replace('T', ' ');
          }
        }
        // RSS 科技周更源放宽到 7 天，避免国外深度源在 1 天窗口为空
        const rssCutoff = sinceDate < todayISO(-7) ? sinceDate : todayISO(-7);
        if (dStr < rssCutoff) continue;

        const body = e.content && e.content.length > 30 ? `${e.title}\n${e.content}` : e.title;
        items.push({
          itemKey: `rss:${feed.id || sha1Short(feed.url)}:${sha1Short(e.link || e.title)}`,
          channel: 'rss',
          sourceName: `RSS · ${feed.name}`,
          sourceId: feed.id || feed.url,
          route: feed.route || 'cognition',
          title: e.title.slice(0, 100),
          author: feed.name,
          publishedAt: pStr,
          date: dStr,
          url: e.link || feed.url,
          tags: ['RSS订阅'],
          wordCount: body.length,
          content: body.slice(0, 4000),
        });
      }
    } catch (err) {
      errors.push(`RSS「${feed.name}」抓取失败: ${err.message}`);
    }
  }

  return { items, errors };
}

async function fetchSinglePublicUrl(rawUrl, route = 'cognition') {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('请输入有效的 http:// 或 https:// 文章链接');

  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`抓取链接失败：HTTP ${r.status}`);
  const html = await r.text();

  const titleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripHtml(titleMatch ? titleMatch[1] : url).slice(0, 100);

  // 针对微信公众号公开页优先提取 js_content
  let bodyHtml = html;
  const wxBody = html.match(/<div[^>]+id="js_content"[^>]*>([\s\S]*?)<\/div>\s*(?:<script|<div[^>]+id="js_tags")/i);
  if (wxBody) bodyHtml = wxBody[1];
  const text = stripHtml(bodyHtml);
  if (text.length < 80) {
    throw new Error('页面正文过短或需要登录/人机校验，建议通过「微信文章清洗工具」或手动粘贴文本处理');
  }

  return {
    itemKey: `url:${sha1Short(url)}`,
    channel: 'manual_url',
    sourceName: '单篇快采链接',
    sourceId: url,
    route: ROUTE_OPTIONS.includes(route) ? route : 'cognition',
    title: title || '外部网页文章',
    author: new URL(url).hostname,
    publishedAt: nowOffsetISO().slice(0, 16).replace('T', ' '),
    date: todayISO(),
    url,
    tags: ['单篇快采'],
    wordCount: text.length,
    content: text.slice(0, 12000),
  };
}

// ============================================================================
// 三轨聚合打包 + AI 提纯 + 候选收件箱（Intel Inbox）
// ============================================================================

function buildTrackDigestText(items, maxChars = 26000) {
  // 优先高密度来源（本地日报 > 知识星球 > 公众号长文 > RSS > 公开电报）
  const weight = { local_folder: 5, manual_url: 5, zsxq: 4, wechat: 3, rss: 2, public_feed: 1 };
  const sorted = [...items].sort((a, b) => (weight[b.channel] || 0) - (weight[a.channel] || 0) || (b.wordCount || 0) - (a.wordCount || 0));

  const chunks = [];
  let used = 0;
  let includedCount = 0;
  for (const it of sorted) {
    const block = [
      `---`,
      `【来源】${it.sourceName} | 【日期】${it.publishedAt || it.date} | 【标题】${it.title}`,
      it.url ? `【链接】${it.url}` : null,
      it.content,
    ]
      .filter(Boolean)
      .join('\n');
    const slice = block.slice(0, Math.min(block.length, 6500));
    if (used + slice.length > maxChars && includedCount > 0) break;
    chunks.push(slice);
    used += slice.length;
    includedCount += 1;
  }
  return { text: chunks.join('\n\n'), includedCount, totalChars: used };
}

function cleanExcerpt(text, maxLen = 180) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function buildSentimentDigest(sentimentItems) {
  if (!sentimentItems || sentimentItems.length === 0) return null;
  const bySource = new Map();
  for (const it of sentimentItems) {
    const arr = bySource.get(it.sourceName) || [];
    arr.push(it);
    bySource.set(it.sourceName, arr);
  }
  const sourceHighlights = [];
  for (const [src, arr] of bySource.entries()) {
    sourceHighlights.push({
      sourceName: src,
      count: arr.length,
      latestTitle: arr[0]?.title || '',
      latestDate: arr[0]?.publishedAt || arr[0]?.date || '',
      excerpt: cleanExcerpt(arr[0]?.content || '', 160),
      url: arr[0]?.url || '',
    });
  }
  // 简单高频赛道词频统计（辅助每日复盘观察共识主线）
  const kwList = ['算力', '光模块', '半导体', '存储', '机器人', '人形', '储能', '电网', '医药', 'CXO', '商业航天', '固态电池', '红利', '银行', '黄金', '有色', 'AI应用', '液冷', 'PCB', '国产替代'];
  const fullText = sentimentItems.map((x) => `${x.title} ${x.content}`).join('\n');
  const hotThemes = kwList
    .map((kw) => ({ kw, hits: (fullText.match(new RegExp(kw, 'gi')) || []).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 10);

  return {
    itemCount: sentimentItems.length,
    sourceHighlights,
    hotThemes,
  };
}

function normalizeCandidateItem(kind, targetLibrary, rawObj, sourceTag) {
  const cid = `cand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (targetLibrary === 'cognition' && kind === 'new_card') {
    return {
      cid,
      targetLibrary: 'cognition',
      kind: 'new_card',
      action: 'cognition.createCard',
      title: rawObj.title || '未命名认知候选卡',
      subtitle: `${rawObj.evidenceLevel || 'B级'} · ${rawObj.categoryTag || '情报自动提纯'}`,
      status: 'pending',
      sourceTag,
      payload: {
        title: rawObj.title || '',
        categoryTag: rawObj.categoryTag || '日常情报增补',
        batchName: rawObj.batchName || sourceTag,
        facts: rawObj.facts || '',
        source: rawObj.source || sourceTag,
        evidenceLevel: rawObj.evidenceLevel || 'B级（情报信源汇总）',
        industryImplications: rawObj.industryImplications || '',
        aShareMapping: rawObj.aShareMapping || '',
        confidence: rawObj.confidence || '中',
        invalidationConditions: rawObj.invalidationConditions || '',
        relatedMethodIds: rawObj.relatedMethodIds || '',
        relatedCognitionIds: rawObj.relatedCognitionIds || '',
      },
    };
  }
  if (targetLibrary === 'cognition' && kind === 'amendment') {
    return {
      cid,
      targetLibrary: 'cognition',
      kind: 'amendment',
      action: 'cognition.appendAmendment',
      title: `增订认知卡 ${rawObj.cardId} · ${rawObj.cardTitle || ''}`,
      subtitle: rawObj.batchNote || sourceTag,
      status: 'pending',
      sourceTag,
      payload: {
        cardId: rawObj.cardId,
        batchNote: rawObj.batchNote || sourceTag,
        content: rawObj.content || '',
      },
    };
  }
  if (targetLibrary === 'methodology' && kind === 'new_card') {
    return {
      cid,
      targetLibrary: 'methodology',
      kind: 'new_card',
      action: 'methodology.createCard',
      title: `${rawObj.system || '综合'}（${rawObj.topic || '未命名方法论'}）`,
      subtitle: `初始可信度 ${rawObj.credibility ?? 0.5}`,
      status: 'pending',
      sourceTag,
      payload: {
        system: rawObj.system || '投研框架',
        topic: rawObj.topic || '',
        batchNote: rawObj.batchNote || sourceTag,
        coreThesis: rawObj.coreThesis || '',
        logicChain: rawObj.logicChain || '',
        applicableConditions: rawObj.applicableConditions || '',
        invalidationSignals: rawObj.invalidationSignals || '',
        historicalCases: rawObj.historicalCases || '待实盘验证补充',
        credibility: Number(rawObj.credibility ?? 0.5),
        source: rawObj.source || sourceTag,
      },
    };
  }
  if (targetLibrary === 'methodology' && kind === 'amendment') {
    return {
      cid,
      targetLibrary: 'methodology',
      kind: 'amendment',
      action: 'methodology.appendAmendment',
      title: `增订方法论卡片 ${rawObj.cardId} · ${rawObj.cardTitle || ''}`,
      subtitle: rawObj.batchNote || sourceTag,
      status: 'pending',
      sourceTag,
      payload: {
        cardId: rawObj.cardId,
        batchNote: rawObj.batchNote || sourceTag,
        content: rawObj.content || '',
      },
    };
  }
  return {
    cid,
    targetLibrary: 'methodology',
    kind: 'conflict',
    action: 'methodology.createConflict',
    title: `冲突候选：${rawObj.title || '新冲突'}`,
    subtitle: rawObj.sides || '',
    status: 'pending',
    sourceTag,
    payload: {
      title: rawObj.title || '',
      sides: rawObj.sides || '',
      conflictPoint: rawObj.conflictPoint || '',
      resolution: rawObj.resolution || '',
    },
  };
}

async function runIntelPipeline(options = {}) {
  const cfg = loadIntelConfig();
  const lookbackDays = Math.max(1, Math.min(14, Number(options.lookbackDays ?? cfg.schedule.lookbackDays ?? 1)));
  const sinceDate = options.sinceDate || todayISO(-(lookbackDays - 1));
  const runAi = options.runAi !== false;
  const ignoreWatermarks = Boolean(options.ignoreWatermarks);
  const triggerWechatSync = Boolean(options.syncWechatFirst);
  const selectedChannels = Array.isArray(options.channels) && options.channels.length > 0
    ? new Set(options.channels)
    : new Set(['zsxq', 'wechat', 'local_folder', 'public_feed', 'rss']);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const errors = [];
  let wechatSyncSummary = null;

  // 可选：先触发微信公众号安全增量同步
  if (triggerWechatSync && selectedChannels.has('wechat') && cfg.wechat?.enabled && cfg.wechat?.toolDir) {
    onProgress({ stage: '正在执行微信公众号安全增量追更...' });
    try {
      const sRes = await triggerWechatIncrementalSync(cfg);
      wechatSyncSummary = sRes.summary;
    } catch (err) {
      errors.push(`微信增量同步提示: ${err.message}`);
    }
  }

  onProgress({ stage: `正在并发采集各信源（自 ${sinceDate} 起）...` });

  const [zsxqRes, wxRes, localRes, pubRes, rssRes] = await Promise.all([
    selectedChannels.has('zsxq') ? fetchZsxqItems(cfg, sinceDate) : Promise.resolve({ items: [], errors: [] }),
    selectedChannels.has('wechat') ? Promise.resolve(fetchWechatArchivedItems(cfg, sinceDate)) : Promise.resolve({ items: [], errors: [] }),
    selectedChannels.has('local_folder') ? fetchLocalFolderItems(cfg, sinceDate) : Promise.resolve({ items: [], errors: [] }),
    selectedChannels.has('public_feed') ? fetchPublicFeeds(cfg, sinceDate) : Promise.resolve({ items: [], errors: [] }),
    selectedChannels.has('rss') ? fetchRssFeeds(cfg, sinceDate) : Promise.resolve({ items: [], errors: [] }),
  ]);

  errors.push(...zsxqRes.errors, ...wxRes.errors, ...localRes.errors, ...pubRes.errors, ...rssRes.errors);

  const extraItems = Array.isArray(options.extraItems) ? options.extraItems : [];
  const allFetched = [...extraItems, ...localRes.items, ...zsxqRes.items, ...wxRes.items, ...rssRes.items, ...pubRes.items];

  // 水印去重
  const wm = loadWatermarks();
  const freshItems = [];
  const seenInBatch = new Set();
  for (const it of allFetched) {
    if (seenInBatch.has(it.itemKey)) continue;
    seenInBatch.add(it.itemKey);
    if (!ignoreWatermarks && wm.seen[it.itemKey]) continue;
    freshItems.push(it);
  }

  // 若全部已被水印消费，且是手动执行且未强制忽略，保留最新 25 条原始列表供展示但标注 newCount=0
  const effectiveItems = freshItems.length > 0 ? freshItems : ignoreWatermarks ? allFetched : [];

  const cogItems = effectiveItems.filter((i) => i.route === 'cognition' || i.route === 'both');
  const methodItems = effectiveItems.filter((i) => i.route === 'methodology' || i.route === 'both');
  const sentimentItems = effectiveItems.filter((i) => i.route === 'sentiment' || i.route === 'both');

  const sentimentDigest = buildSentimentDigest(sentimentItems);
  const candidates = [];
  const discarded = [];
  let aiSummaries = { cognition: '', methodology: '' };
  let aiMeta = { provider: options.provider || '', cognitionLatencyMs: 0, methodologyLatencyMs: 0 };

  if (runAi && effectiveItems.length > 0) {
    const ws = loadWorkspace();
    const batchTag = `${todayISO()} 情报定时提纯`;

    if (cogItems.length > 0) {
      onProgress({ stage: `AI 正在将 ${cogItems.length} 条一手产业情报提纯为《行业前沿认知库》候选...` });
      const digest = buildTrackDigestText(cogItems, 28000);
      try {
        const res = await runAiIngestion({
          targetLibrary: 'cognition',
          workspace: ws,
          sourceText: digest.text,
          meta: {
            sourceName: `${batchTag}（共 ${digest.includedCount} 条精选情报）`,
            batchNote: batchTag,
            hint: '这是今日多渠道（知识星球/公众号/研报/电报/RSS）聚合情报，请严格遵守 A/B/C 证据定级与事实/映射分离铁律，优先识别可与库内既有认知卡跨源互证的增订，宁缺毋滥，果断丢弃重复快讯与情绪口水。',
          },
          providerOverride: options.provider,
        });
        aiSummaries.cognition = res.result.summary || '';
        aiMeta.provider = res.auditTrail?.provider || aiMeta.provider;
        aiMeta.cognitionLatencyMs = res.auditTrail?.latencyMs || 0;
        for (const c of res.result.newCards || []) {
          candidates.push(normalizeCandidateItem('new_card', 'cognition', c, batchTag));
        }
        for (const a of res.result.amendments || []) {
          if (a.valid !== false) candidates.push(normalizeCandidateItem('amendment', 'cognition', a, batchTag));
        }
        for (const d of res.result.discarded || []) {
          discarded.push({ targetLibrary: 'cognition', ...d });
        }
      } catch (err) {
        errors.push(`认知库 AI 提纯失败: ${err.message}`);
      }
    }

    // 方法论轨道仅接受深度材料（>= 350 字），避免短电报污染方法论库
    const deepMethodItems = methodItems.filter((x) => (x.wordCount || 0) >= 350);
    if (deepMethodItems.length > 0) {
      onProgress({ stage: `AI 正在从 ${deepMethodItems.length} 篇深度材料提炼《方法论卡片库》候选...` });
      const digest = buildTrackDigestText(deepMethodItems, 22000);
      try {
        const res = await runAiIngestion({
          targetLibrary: 'methodology',
          workspace: ws,
          sourceText: digest.text,
          meta: {
            sourceName: `${batchTag}（深度框架材料 ${digest.includedCount} 篇）`,
            batchNote: batchTag,
            hint: '严控方法论库纯度：日常行情评论一律丢弃，仅当材料中出现可跨周期复用的新交易/研究规则、对既有卡片的新适用边界或明确反例/冲突时，才产出新卡或增订候选。',
          },
          providerOverride: options.provider,
        });
        aiSummaries.methodology = res.result.summary || '';
        aiMeta.provider = res.auditTrail?.provider || aiMeta.provider;
        aiMeta.methodologyLatencyMs = res.auditTrail?.latencyMs || 0;
        for (const c of res.result.newCards || []) {
          candidates.push(normalizeCandidateItem('new_card', 'methodology', c, batchTag));
        }
        for (const a of res.result.amendments || []) {
          if (a.valid !== false) candidates.push(normalizeCandidateItem('amendment', 'methodology', a, batchTag));
        }
        for (const cf of res.result.conflicts || []) {
          candidates.push(normalizeCandidateItem('conflict', 'methodology', cf, batchTag));
        }
        for (const d of res.result.discarded || []) {
          discarded.push({ targetLibrary: 'methodology', ...d });
        }
      } catch (err) {
        errors.push(`方法论库 AI 提纯失败: ${err.message}`);
      }
    }
  }

  // 仅在真正运行了 AI 提纯或明确要求落水印时记录已消费水印（纯预览拉取不消耗水印，方便用户先拉取再决定 AI 提纯）
  if (runAi && freshItems.length > 0) {
    const stamp = nowOffsetISO();
    for (const it of freshItems) wm.seen[it.itemKey] = stamp;
    saveWatermarks(wm);
  }

  const byChannel = {
    zsxq: zsxqRes.items.length,
    wechat: wxRes.items.length,
    local_folder: localRes.items.length,
    public_feed: pubRes.items.length,
    rss: rssRes.items.length,
    manual_url: extraItems.length,
  };

  const batch = {
    id: `intel-${Date.now().toString(36)}`,
    createdAt: nowOffsetISO(),
    date: todayISO(),
    sinceDate,
    trigger: options.trigger || 'manual',
    runAi,
    stats: {
      totalFetched: allFetched.length,
      freshCount: effectiveItems.length,
      byChannel,
      candidateCount: candidates.length,
      cognitionCandidateCount: candidates.filter((c) => c.targetLibrary === 'cognition').length,
      methodologyCandidateCount: candidates.filter((c) => c.targetLibrary === 'methodology').length,
      discardedCount: discarded.length,
    },
    aiSummaries,
    aiMeta,
    sentimentDigest,
    candidates,
    discarded: discarded.slice(0, 40),
    rawItems: allFetched.slice(0, 80).map((x) => ({
      ...x,
      excerpt: cleanExcerpt(x.content, 200),
      content: x.content.slice(0, 4500),
    })),
    errors,
    wechatSyncSummary,
  };

  const inbox = loadInbox();
  inbox.batches.unshift(batch);
  saveInbox(inbox);

  saveIntelConfig({
    schedule: {
      ...cfg.schedule,
      lastRunDate: todayISO(),
      lastRunAt: nowOffsetISO(),
    },
  });

  return { ok: true, batch };
}

function updateCandidateStatus(batchId, cid, status) {
  const inbox = loadInbox();
  let updated = null;
  for (const b of inbox.batches) {
    if (batchId && b.id !== batchId) continue;
    const target = (b.candidates || []).find((c) => c.cid === cid);
    if (target) {
      target.status = status;
      target.updatedAt = nowOffsetISO();
      updated = target;
      break;
    }
  }
  if (!updated) throw new Error('未找到对应的候选条目');
  saveInbox(inbox);
  return { ok: true, candidate: updated };
}

function resetWatermarks() {
  saveWatermarks({ seen: {} });
  return { ok: true };
}

function getIntelHubOverview() {
  const config = loadIntelConfig();
  const inbox = loadInbox();
  const wm = loadWatermarks();
  const pendingCandidatesCount = (inbox.batches || []).reduce(
    (sum, b) => sum + (b.candidates || []).filter((c) => c.status === 'pending').length,
    0
  );
  return {
    ok: true,
    isPortableMode: IS_PORTABLE_MODE,
    config,
    publicFeedCatalog: PUBLIC_FEED_CATALOG,
    rssPresetCatalog: RSS_PRESET_CATALOG,
    batches: inbox.batches || [],
    pendingCandidatesCount,
    watermarkCount: Object.keys(wm.seen || {}).length,
  };
}

module.exports = {
  PUBLIC_FEED_CATALOG,
  RSS_PRESET_CATALOG,
  loadIntelConfig,
  saveIntelConfig,
  getIntelHubOverview,
  probeZsxqGroups,
  getWechatBridgeStatus,
  launchWechatWebUi,
  triggerWechatIncrementalSync,
  fetchSinglePublicUrl,
  fetchRssFeeds,
  runIntelPipeline,
  updateCandidateStatus,
  resetWatermarks,
};
