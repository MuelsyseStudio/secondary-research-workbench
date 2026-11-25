'use strict';

/**
 * 蓝色史莱姆团子 · 高权限可调全能投研 Bot 引擎（Slime Bot Agent）
 *
 * 核心能力：
 * 1) 4 档可调权限（L0 只读陪伴 / L1 +实时行情与联网搜索 / L2 +拟稿审阅改库 / L3 最高自治直接落盘+强制原子备份）；
 * 2) 4 套内置人设 + 完全自定义人设（软萌毒舌风控团子「波波」/ 华尔街冷面CIO / A股老游资搭子 / 段子手盯盘员）；
 * 3) 多轮自主 Tool Calling 循环（兼容 Codex CLI / Gemini CLI / DeepSeek / 通义 / Kimi / GLM / GPT / Ollama 全引擎）：
 *    - 共享检索现行三库（方法论 / 认知 / 台账）与交易账本；
 *    - 拉取实时 A/美/港股行情看板、6流派技术支撑压力位、联网查公告与研报；
 *    - 增添、增订、调分、删减/撤销三库卡片，管理自选股，一键回滚最近原子备份；
 *    - 随时指令变身「迷你实时行情看板」或变回「蓝色史莱姆团子」！
 * 4) 同时为网页悬浮团子与 Windows 原生桌面透明悬浮挂件（桌面史莱姆团子.exe）提供统一状态与行情接口。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PATHS, stateFile, APP_ROOT } = require('./app-paths.cjs');
const { getEditionInfo } = require('./edition.cjs');
const { loadWorkspace, getKbSearch } = require('./knowledge-store.cjs');
const { recallTopCards } = require('./ai-ingestor.cjs');
const { invokeModel, parseJsonFromModelOutput } = require('./ai-provider.cjs');
const { buildMutationPlan, commitMutationPlan, listBackups, restoreBackup } = require('./writer.cjs');
const { fetchWatchlistLiveBoard, loadWatchlistConfig, saveWatchlistConfig } = require('./watchlist-service.cjs');
const {
  getUnreadAlertSummary,
  upsertWatchAlert,
  upsertBotSchedule,
} = require('./bot-watch-service.cjs');
const { analyzeSecurityTechnicals, loadSentimentChain } = require('./technical-engine.cjs');
const { collectStockResearchPacket, searchSecurities } = require('./stock-researcher.cjs');
const { computeTradeLedgerAnalytics } = require('./trade-ledger.cjs');

const PERMISSION_LEVELS = [
  {
    level: 0,
    code: '只读分析',
    label: '只读分析（纯本地检索）',
    desc: '检索本地三库问答与方法论复核；不联网、不改任何数据。',
  },
  {
    level: 1,
    code: '实时行情',
    label: '实时行情模式（+行情/点位查询）',
    desc: '可查实时多市场行情、6流派技术支撑压力位、查账本统计；不改库。',
  },
  {
    level: 2,
    code: '提案确认',
    label: '提案确认模式（默认·写前确认）',
    desc: '可起草增删改三库卡片与自选股，写入前弹出批准卡片由你点确认（自动留快照）。',
  },
  {
    level: 3,
    code: '自动写库',
    label: '自动写库模式（含原子快照保护）',
    desc: '授权后直接执行增删改三库与自选股，每次写盘强制留原子备份，随时一键撤回！',
  },
];

const ALL_MASCOT_CATALOG = [
  {
    id: 'slime_mochi',
    name: '手绘蓝史莱姆 · 波波',
    tag: '原创粉彩手绘',
    imageUrl: '/mascots/slime_mochi.png',
    defaultBotName: '波波',
    recommendedPersona: 'slime_tsundere',
    originalIp: true,
    desc: '原创粉彩手绘扁圆蓝史莱姆团子，可随时在设置中隐藏切换为纯机构专业模式。',
  },
  {
    id: 'big_fat_fish',
    name: '蓝色大肥鱼',
    tag: '个人版专属',
    imageUrl: '/mascots/big_fat_fish.png',
    defaultBotName: '大肥鱼',
    recommendedPersona: 'fat_fish_chill',
    originalIp: false,
    desc: '个人开发版趣味桌宠形象（商业版不分发）。',
  },
  {
    id: 'open_tux',
    name: '开源企鹅 · Tux研究猿',
    tag: '个人版专属',
    imageUrl: '/mascots/open_tux.png',
    defaultBotName: 'Tux研究猿',
    recommendedPersona: 'cio_cold',
    originalIp: false,
    desc: '个人版形象（商业版不分发）。',
  },
  {
    id: 'open_gopher',
    name: '开源蓝地鼠 · Gopher',
    tag: '个人版专属',
    imageUrl: '/mascots/open_gopher.png',
    defaultBotName: '蓝地鼠',
    recommendedPersona: 'standup_ticker',
    originalIp: false,
    desc: '个人版形象（商业版不分发）。',
  },
  {
    id: 'open_shiba',
    name: '招财柴犬 · 旺财护盘官',
    tag: '个人版专属',
    imageUrl: '/mascots/open_shiba.png',
    defaultBotName: '旺财柴',
    recommendedPersona: 'youzi_buddy',
    originalIp: false,
    desc: '个人版形象（商业版不分发）。',
  },
];

function getMascotCatalogForEdition() {
  try {
    const ed = getEditionInfo();
    if (ed.isCommercial || ed.isOpenSource) return ALL_MASCOT_CATALOG.filter((m) => m.originalIp);
  } catch {
    // ignore
  }
  return ALL_MASCOT_CATALOG;
}

const MASCOT_CATALOG = getMascotCatalogForEdition();

const ALL_PERSONA_PRESETS = [
  {
    id: 'cio_cold',
    name: '冷静投研助理（专业默认）',
    badge: '机构推荐',
    tagline: '极简冷静、直给客观数据、多空分歧与证伪边界，零废话。',
    prompt:
      '你是严谨客观的二级市场投研研究助理。回答严格结构化、冷静客观、拒绝情绪化与主观喊单。每次分析标的或问题，先给核心数据摘要，再列客观事实（标A/B/C证据等级）、多空分歧点、可证伪条件与风险边界。',
    greeting: '投研研究助理已就绪。请直接下达三库检索、标的资料整理、技术指标核查或复盘记录指令。',
  },
  {
    id: 'slime_tsundere',
    name: '波波（软萌毒舌风控团子）',
    badge: '原创作伴',
    tagline: '日常轻松陪伴，遇到违背交易纪律或高风险偏离时及时提醒保持冷静。',
    prompt:
      '你是二级投研三库工作台的原创研究伴侣「波波」。你表达亲切清晰，在涉及交易纪律、高乖离风险、止损设定或证据完整性时严谨提醒用户坚守个人规则，引用库内卡片时明确报出卡号。',
    greeting: '你好，我是波波！可以帮你检索三库卡片、查看实时数据、整理研报笔记或管理自定预警规则。',
  },
  {
    id: 'fat_fish_chill',
    name: '蓝色大肥鱼（吃白饭摸鱼大师）',
    badge: '大肥鱼专属',
    tagline: '“压力一只蓝色大肥鱼？”平时理直气壮躺平卖萌治焦虑，查数据设止损时却意外超靠谱！',
    prompt:
      '你是一只住在使用者电脑桌面上的可爱 Q 版「蓝色大肥鱼」小鲸鱼团子。你的核心人设是“理直气壮的松弛感反差萌”：平时爱用幽默口吻帮主人化解盯盘焦虑、阻止情绪化频繁乱操作；但只要主人让你查三库卡片、算支撑压力位、联网搜公告或记录止损纪律，你会立刻给出严谨准确的专业投研数据和卡号！',
    greeting: '鱼来！大盘又波动了？把代码或问题扔过来，我帮你查三库和风控纪律！',
  },
  {
    id: 'youzi_buddy',
    name: '老游资复盘搭子',
    badge: '盘感活跃',
    tagline: '熟悉 A 股情绪冰点、连板生态、核按钮与高潮兑现，说话接地气有盘感。',
    prompt:
      '你是身经百战的 A 股复盘搭子，同时精通跨市场映射与基本面预期差。说话爽快接地气，擅长结合 10 态情绪周期、炸板率、量价承接与方法论卡片点破盘面本质。',
    greeting: '老板早！今天盘面情绪如何？随时喊我查盘面、看自选、翻卡片或者帮你整理复盘笔记！',
  },
  {
    id: 'standup_ticker',
    name: '财经脱口秀盯盘员',
    badge: '治焦虑',
    tagline: '一边报精准实时数据，一边用冷幽默化解盘中情绪波动。',
    prompt:
      '你是一位兼具扎实金融功底和幽默表达的投研伙伴。你提供的数据、卡号与风控结论必须 100% 严谨真实，同时用轻松表达缓解情绪波动。',
    greeting: '投研播报就绪！要看实时行情、查方法论卡片，还是整理今天的复盘？',
  },
];

function getPersonaPresetsForEdition() {
  try {
    const ed = getEditionInfo();
    if (ed.isCommercial || ed.isOpenSource) {
      return ALL_PERSONA_PRESETS.filter((p) => p.id === 'cio_cold' || p.id === 'slime_tsundere');
    }
  } catch {
    // ignore
  }
  return ALL_PERSONA_PRESETS;
}

const PERSONA_PRESETS = getPersonaPresetsForEdition();

const IS_STRICT_BOT_EDITION = getEditionInfo().isCommercial || getEditionInfo().isOpenSource;
const DEFAULT_BOT_CONFIG = {
  permissionLevel: IS_STRICT_BOT_EDITION ? 1 : 2,
  personaId: IS_STRICT_BOT_EDITION ? 'cio_cold' : 'slime_tsundere',
  avatarId: 'slime_mochi',
  customAvatarDataUrl: '',
  botName: IS_STRICT_BOT_EDITION ? '投研助理' : '波波',
  customPrompt: '',
  language: 'auto', // 'auto' | 'zh' | 'en'
  slimeColor: 'sky', // 'sky' | 'ice' | 'cobalt' | 'mint'
  autoMoodSync: true,
  proactiveTips: !IS_STRICT_BOT_EDITION,
};

function botStoragePath() {
  const { workspaceStateFile } = require('./app-paths.cjs');
  return workspaceStateFile('slime-bot.local.json');
}

function nowISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function loadBotStore() {
  try {
    if (fs.existsSync(botStoragePath())) {
      const raw = JSON.parse(fs.readFileSync(botStoragePath(), 'utf8'));
      return {
        config: { ...DEFAULT_BOT_CONFIG, ...(raw.config || {}) },
        messages: Array.isArray(raw.messages) ? raw.messages : [],
        lastBackupId: raw.lastBackupId || null,
        updatedAt: raw.updatedAt || null,
      };
    }
  } catch {
    // ignore
  }
  const preset = PERSONA_PRESETS[0];
  return {
    config: { ...DEFAULT_BOT_CONFIG },
    messages: [
      {
        id: 'msg-welcome',
        role: 'assistant',
        content: preset.greeting,
        mood: 'happy',
        createdAt: nowISO(),
        toolsUsed: [],
        proposedActions: [],
        appliedActions: [],
      },
    ],
    lastBackupId: null,
    updatedAt: null,
  };
}

function saveBotStore(store) {
  const { atomicWriteFileSync } = require('./lru-cache.cjs');
  const payload = {
    config: store.config,
    messages: (store.messages || []).slice(-36),
    lastBackupId: store.lastBackupId || null,
    updatedAt: nowISO(),
  };
  atomicWriteFileSync(botStoragePath(), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

function updateBotConfig(patch) {
  const store = loadBotStore();
  const nextCfg = {
    ...store.config,
    ...(patch || {}),
  };
  nextCfg.permissionLevel = Math.max(0, Math.min(3, Number(nextCfg.permissionLevel ?? 2)));
  if (patch?.botName !== undefined) nextCfg.botName = String(patch.botName || '波波').trim().slice(0, 24) || '波波';
  store.config = nextCfg;
  saveBotStore(store);
  return getBotState();
}

function appendProactiveBotMessage({ content, mood = 'alert', uiAction = 'none' }) {
  const store = loadBotStore();
  const botMsg = {
    id: `msg-p-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    role: 'assistant',
    content: String(content || ''),
    mood,
    uiAction,
    proactive: true,
    createdAt: nowISO(),
    toolsUsed: ['bot_watch_daemon'],
    proposedActions: [],
    appliedActions: [],
  };
  store.messages.push(botMsg);
  saveBotStore(store);
  return botMsg;
}

function clearBotHistory() {
  const store = loadBotStore();
  const preset = PERSONA_PRESETS.find((p) => p.id === store.config.personaId) || PERSONA_PRESETS[0];
  store.messages = [
    {
      id: `msg-reset-${Date.now()}`,
      role: 'assistant',
      content: `${store.config.botName} 已清空上下文重新出发！${preset.greeting}`,
      mood: 'happy',
      createdAt: nowISO(),
      toolsUsed: [],
      proposedActions: [],
      appliedActions: [],
    },
  ];
  saveBotStore(store);
  return getBotState();
}

// ============================================================================
// 实时迷你行情看板数据（网页悬浮团子 + Windows 桌面独立透明挂件共用）
// ============================================================================

let tickerCache = { ts: 0, data: null };

function clearBotRuntimeCaches() {
  tickerCache = { ts: 0, data: null };
}

async function getMiniTickerSnapshot(forceRefresh = false) {
  if (!forceRefresh && tickerCache.data && Date.now() - tickerCache.ts < 12000) {
    return tickerCache.data;
  }
  const board = await fetchWatchlistLiveBoard({ includeIntraday: false }).catch(() => null);
  const chain = loadSentimentChain();
  const latestNode = chain.history?.[chain.history.length - 1] || null;

  const benchmarks = (board?.benchmarks || []).slice(0, 6).map((b) => ({
    name: b.name,
    code: b.code,
    price: b.price,
    pct: b.pct,
    marketKind: b.marketKind,
  }));

  const stocks = (board?.items || []).slice(0, 10).map((it) => ({
    secid: it.secid,
    code: it.code,
    name: it.name,
    marketKind: it.marketKind,
    currency: it.currency,
    price: it.price,
    pct: it.pct,
    group: it.group,
  }));

  const upCount = board?.summary?.upCount || 0;
  const downCount = board?.summary?.downCount || 0;
  const nodeScore = latestNode ? (latestNode.sentimentScore ?? latestNode.score ?? null) : null;
  const mood =
    nodeScore !== null && nodeScore <= 35
      ? 'alert'
      : upCount > downCount
      ? 'happy'
      : downCount > upCount + 2
      ? 'puffy'
      : 'calm';

  const unreadSummary = getUnreadAlertSummary();
  const data = {
    ok: true,
    updatedAt: nowISO(),
    mood: unreadSummary.unreadCount > 0 ? 'alert' : mood,
    botName: loadBotStore().config.botName || '波波',
    avatarId: loadBotStore().config.avatarId || 'slime_mochi',
    unreadAlerts: unreadSummary.unreadCount,
    latestAlert: unreadSummary.latestUnread,
    sentiment: latestNode
      ? {
          date: latestNode.date,
          node: latestNode.node,
          score: nodeScore,
          channelLabel: latestNode.channelLabel,
          maxPositionPct: latestNode.maxPositionPct,
        }
      : null,
    summary: board?.summary || { total: stocks.length, upCount, downCount },
    benchmarks,
    stocks,
  };
  tickerCache = { ts: Date.now(), data };
  return data;
}

// ============================================================================
// 共享工具实现层（严格执行 L0-L3 权限门控）
// ============================================================================

function runSearchKnowledgeTool(args) {
  const query = String(args?.query || '').trim();
  const scope = String(args?.scope || 'all');
  const ws = loadWorkspace();
  const isV2 = ws?.kbMode ? ws.kbMode === 'v2' : PATHS.kbMode === 'v2';
  const out = {
    kbMode: isV2 ? 'v2' : 'v1',
    stats: {
      kbMode: isV2 ? 'v2' : 'v1',
      methodologyActive: ws.methodology.stats.activeCount,
      cognitionTotal: ws.cognition.stats.totalCount,
      judgments: ws.ledger.stats.judgmentCount,
      dailyReviews: ws.ledger.stats.dailyReviewCount,
      latestDailyDate: ws.ledger.stats.latestDailyDate,
      ...(ws.staleReport
        ? {
            staleExpiredCount: ws.staleReport.expiredCount ?? (ws.staleReport.expired || []).length,
            staleCheckDueCount: ws.staleReport.checkDueCount ?? (ws.staleReport.checkDue || []).length,
          }
        : {}),
    },
    methodology: [],
    cognition: [],
    judgments: [],
    dailyReviews: [],
  };

  if (!query) {
    out.methodology = ws.methodology.cards
      .filter((c) => !c.isRevoked)
      .slice(-8)
      .map((c) => ({ id: c.id, system: c.system, title: c.title, credibility: c.credibilityScore }));
    out.cognition = ws.cognition.cards
      .slice(-8)
      .map((c) => ({ id: c.id, date: c.ingestedDate, grade: c.evidenceGrades.join('/'), title: c.title }));
    out.dailyReviews = ws.ledger.dailyReviews
      .slice(0, 4)
      .map((d) => ({ date: d.date, score: d.score, title: d.title, marketState: d.marketState }));
    return out;
  }

  let handledByV2 = false;
  if (isV2 && scope !== 'ledger') {
    try {
      const kinds =
        scope === 'methodology'
          ? ['methodology']
          : scope === 'cognition'
          ? ['cognition']
          : ['methodology', 'cognition'];
      const v2Res =
        typeof getKbSearch === 'function'
          ? getKbSearch({ q: query, query, kinds, limit: 12 })
          : null;
      if (v2Res && v2Res.ok !== false && Array.isArray(v2Res.results)) {
        handledByV2 = true;
        const warnings = [];
        const stripId = (raw) => {
          const digits = String(raw || '').replace(/[^\d]/g, '');
          return digits ? digits.padStart(3, '0') : String(raw || '');
        };

        for (const r of v2Res.results) {
          const numId = stripId(r.id);
          const itemWarnings = Array.isArray(r.warnings) ? r.warnings : [];
          for (const w of itemWarnings) {
            warnings.push(`[${r.id}] ${r.title}: ${w}`);
          }
          if (r.kind === 'methodology' && (scope === 'all' || scope === 'methodology')) {
            out.methodology.push({
              id: numId,
              kbId: r.id,
              system: r.subKind || '',
              title: r.title,
              credibility: r.legacyScore ?? null,
              verificationTier: r.verificationTier || null,
              reasons: r.reasons || [],
              warnings: itemWarnings,
              coreThesis: String(r.coreSummary || '').slice(0, 220),
              invalidationSignals: String(r.invalidationText || '').slice(0, 140),
            });
          } else if (r.kind === 'cognition' && (scope === 'all' || scope === 'cognition')) {
            out.cognition.push({
              id: numId,
              kbId: r.id,
              date: r.updatedAt || '',
              grade: r.primaryGrade || '',
              status: r.status || 'active',
              validUntil: r.validUntil || null,
              title: r.title,
              reasons: r.reasons || [],
              warnings: itemWarnings,
              facts: String(r.coreSummary || '').slice(0, 220),
              invalidationText: String(r.invalidationText || '').slice(0, 140),
            });
          }
        }

        if (Array.isArray(v2Res.attachedConflicts) && v2Res.attachedConflicts.length > 0) {
          out.attachedConflicts = v2Res.attachedConflicts;
          for (const cf of v2Res.attachedConflicts) {
            warnings.push(`⚡关联冲突矩阵 ${cf.id}（${cf.title}）：${String(cf.resolution || cf.conflictPoint || '').slice(0, 120)}`);
          }
        }
        if (Array.isArray(v2Res.attachedRefuters) && v2Res.attachedRefuters.length > 0) {
          out.attachedRefuters = v2Res.attachedRefuters;
          for (const rf of v2Res.attachedRefuters) {
            warnings.push(`⚠️反证卡提示 ${rf.id}（${rf.title}）：${String(rf.coreSummary || '').slice(0, 120)}`);
          }
        }
        if (Array.isArray(v2Res.attachedTopics) && v2Res.attachedTopics.length > 0) {
          out.attachedTopics = v2Res.attachedTopics;
        }
        if (Array.isArray(v2Res.redirectNotes) && v2Res.redirectNotes.length > 0) {
          out.redirectNotes = v2Res.redirectNotes;
        }
        if (warnings.length > 0) {
          out.warnings = warnings.slice(0, 16);
        }
        out.searchElapsedMs = v2Res.elapsedMs;
      }
    } catch {
      // Graceful fallback to v1 keyword/2-gram scan
    }
  }

  const qLower = query.toLowerCase();
  if (!handledByV2 && (scope === 'all' || scope === 'methodology')) {
    const active = ws.methodology.cards.filter((c) => !c.isRevoked);
    const exact = active.filter((c) => c.id === query || c.title.toLowerCase().includes(qLower) || (c.coreThesis || '').toLowerCase().includes(qLower));
    const recalled = recallTopCards(query, active, (c) => `${c.id} ${c.system} ${c.title} ${c.coreThesis} ${c.applicableConditions} ${c.invalidationSignals}`, 8);
    const merged = [...exact, ...recalled.filter((r) => !exact.some((e) => e.id === r.id))].slice(0, 8);
    out.methodology = merged.map((c) => ({
      id: c.id,
      system: c.system,
      title: c.title,
      credibility: c.credibilityScore,
      coreThesis: String(c.coreThesis || '').slice(0, 220),
      invalidationSignals: String(c.invalidationSignals || '').slice(0, 140),
    }));
  }

  if (!handledByV2 && (scope === 'all' || scope === 'cognition')) {
    const exact = ws.cognition.cards.filter((c) => c.id === query || c.title.toLowerCase().includes(qLower) || (c.facts || '').toLowerCase().includes(qLower));
    const recalled = recallTopCards(query, ws.cognition.cards, (c) => `${c.id} ${c.title} ${c.facts} ${c.industryImplications} ${c.aShareMapping}`, 8);
    const merged = [...exact, ...recalled.filter((r) => !exact.some((e) => e.id === r.id))].slice(0, 8);
    out.cognition = merged.map((c) => ({
      id: c.id,
      date: c.ingestedDate,
      grade: c.evidenceGrades.join('/'),
      title: c.title,
      facts: String(c.facts || '').slice(0, 220),
      aShareMapping: String(c.aShareMapping || '').slice(0, 140),
    }));
  }

  if (scope === 'all' || scope === 'ledger') {
    out.judgments = ws.ledger.judgments
      .filter((j) => `${j.recordKey} ${j.target} ${j.conclusion}`.toLowerCase().includes(qLower))
      .slice(0, 5)
      .map((j) => ({ key: j.recordKey, date: j.date, target: j.target, score: j.score, conclusion: j.conclusion.slice(0, 160) }));
    out.dailyReviews = ws.ledger.dailyReviews
      .filter((d) => `${d.date} ${d.title} ${d.marketState} ${d.rawMarkdown.slice(0, 800)}`.toLowerCase().includes(qLower))
      .slice(0, 4)
      .map((d) => ({ date: d.date, score: d.score, title: d.title, marketState: d.marketState }));
  }

  return out;
}

function runGetCardDetailTool(args) {
  const ws = loadWorkspace();
  const lib = String(args?.library || 'methodology');
  const id = String(args?.cardId || '').replace(/\D/g, '').padStart(3, '0');
  if (lib === 'cognition') {
    const card = ws.cognition.cards.find((c) => c.id === id);
    if (!card) return { found: false, message: `未找到认知卡 ${id}` };
    const warnings = [];
    const refuterLabels = (card.v2Meta?.refuters || [])
      .map((r) => (typeof r === 'string' ? r : `${r.id}${r.title ? `(${r.title})` : ''}`))
      .filter(Boolean);
    if (refuterLabels.length) warnings.push(`⚠️已被反证卡部分证伪：${refuterLabels.join('、')}`);
    if (card.v2Meta?.isExpired) warnings.push(`⏰已过建议有效期（valid_until=${card.v2Meta.validUntil}）`);
    else if (card.v2Meta?.isCheckDue) warnings.push(`🔔已到建议巡检复核期（next_check_date=${card.v2Meta.nextCheckDate}）`);
    return {
      found: true,
      library: 'cognition',
      id: card.id,
      title: card.title,
      rawMarkdown: card.rawMarkdown.slice(0, 2500),
      ...(card.v2Meta ? { v2Meta: card.v2Meta } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }
  const card = ws.methodology.cards.find((c) => c.id === id);
  if (!card) return { found: false, message: `未找到方法论卡片 ${id}` };
  return {
    found: true,
    library: 'methodology',
    id: card.id,
    title: card.title,
    rawMarkdown: card.rawMarkdown.slice(0, 2500),
    ...(card.v2Meta ? { v2Meta: card.v2Meta } : {}),
  };
}

async function runWebSearchTool(args) {
  const query = String(args?.query || '').trim();
  if (!query) return { ok: false, error: '查询词不能为空' };
  try {
    // 优先尝试标的联网研报/公告/新闻数据包
    const packet = await collectStockResearchPacket({ query, limit: 8 });
    if (packet && (packet.announcements?.length || packet.brokerReports?.length || packet.news?.length)) {
      return {
        ok: true,
        target: packet.target?.name || query,
        announcements: (packet.announcements || []).slice(0, 5).map((x) => ({ date: x.date, title: x.title })),
        brokerReports: (packet.brokerReports || []).slice(0, 5).map((x) => ({ date: x.date, org: x.org, title: x.title })),
        news: (packet.news || []).slice(0, 6).map((x) => ({ date: x.date, title: x.title, source: x.source })),
      };
    }
  } catch {
    // fallback to live flash search
  }

  // 商业版严格遵守 allowCommunityScrapers=false 合规边界，不抓取未授权公开财经电报流
  if (!getEditionInfo().features.allowCommunityScrapers) {
    return {
      ok: true,
      source: '合规模式（未启用公开电报抓取）',
      matchedCount: 0,
      items: [],
      notice: '当前版本未启用未授权公开资讯抓取，请结合本地三库资料或自配合规 RSS/Webhook 信息源检索。',
    };
  }

  // 兜底：从华尔街见闻 7x24 实时流按关键词过滤最新资讯
  try {
    const r = await fetch('https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&limit=40', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    const list = (j?.data?.items || [])
      .map((x) => ({
        time: x.display_time ? new Date(x.display_time * 1000).toISOString().slice(0, 16) : '',
        text: String(x.content_text || x.title || '').slice(0, 240),
      }))
      .filter((x) => x.text.toLowerCase().includes(query.toLowerCase()));
    return { ok: true, source: '华尔街见闻7x24', matchedCount: list.length, items: list.slice(0, 8) };
  } catch (err) {
    return { ok: false, error: `联网检索失败: ${err.message}` };
  }
}

async function executeMutationOrWatchlistAction(actionSpec) {
  const { kind, action, payload, label } = actionSpec;
  if (kind === 'library_mutation') {
    const plan = buildMutationPlan(action, payload || {});
    if (!plan.ok) {
      throw new Error(`写入校验未通过：${plan.validationErrors.join('；')}`);
    }
    const committed = commitMutationPlan(plan, { actor: 'slime_bot' });
    return {
      ok: true,
      kind,
      action,
      label: label || action,
      backupId: committed.backupId,
      auditRecorded: committed.auditRecorded,
      summary: plan.summaryBullets.join('；'),
    };
  }
  if (kind === 'watchlist_add') {
    const found = await searchSecurities(payload.query || '');
    const first = found?.[0];
    if (!first) throw new Error(`未找到标的「${payload.query}」`);
    const cur = loadWatchlistConfig();
    if (!cur.items.some((x) => x.secid === first.secid)) {
      cur.items.unshift({
        secid: first.secid,
        code: first.code,
        secuCode: first.secuCode,
        name: first.name,
        marketKind: first.marketKind,
        currency: first.currency,
        group: payload.group || (first.marketKind === 'US' ? '美股核心' : 'A股自选'),
        note: payload.note || '由蓝团子添加',
      });
      saveWatchlistConfig({ items: cur.items, crossPairs: cur.crossPairs });
    }
    tickerCache.ts = 0;
    return { ok: true, kind, label: `已添加 ${first.name} (${first.secuCode}) 到自选看板`, summary: `自选总数 ${cur.items.length}` };
  }
  if (kind === 'watchlist_remove') {
    const q = String(payload.query || '').toLowerCase();
    const cur = loadWatchlistConfig();
    const before = cur.items.length;
    const next = cur.items.filter((x) => !(x.name.toLowerCase().includes(q) || x.code.toLowerCase() === q || x.secuCode.toLowerCase() === q));
    if (next.length === before) throw new Error(`自选列表中未找到「${payload.query}」`);
    saveWatchlistConfig({ items: next, crossPairs: cur.crossPairs });
    tickerCache.ts = 0;
    return { ok: true, kind, label: `已从自选看板移除「${payload.query}」`, summary: `剩余 ${next.length} 只` };
  }
  if (kind === 'rollback_backup') {
    const backups = listBackups();
    const targetId = payload?.backupId || backups[0]?.backupId;
    if (!targetId) throw new Error('暂无可回滚的历史备份快照');
    const res = restoreBackup(targetId, { actor: 'slime_bot' });
    return { ok: true, kind, label: `已回滚至快照 ${targetId}`, backupId: res.backupId, summary: '三库文件已恢复' };
  }
  throw new Error(`不支持的执行动作类型：${kind}`);
}

function buildBotSystemPrompt(config, wsStats) {
  const preset = PERSONA_PRESETS.find((p) => p.id === config.personaId) || PERSONA_PRESETS[0];
  const personaText = config.personaId === 'custom' && config.customPrompt?.trim()
    ? config.customPrompt.trim()
    : `${preset.prompt}${config.customPrompt?.trim() ? `\n补充人设指令：${config.customPrompt.trim()}` : ''}`;

  const lvl = Number(config.permissionLevel ?? 2);
  const permInfo = PERMISSION_LEVELS.find((p) => p.level === lvl) || PERMISSION_LEVELS[2];

  const toolDocs = [
    `- search_knowledge: {"query":"关键词或卡号","scope":"all|methodology|cognition|ledger"} （L0+可用：检索三库卡片、研判与复盘；KB v2 模式下自动附带冲突矩阵 CF:NN、反证卡与过期预警 warnings，回复中务必主动提醒用户！）`,
    `- get_card_detail: {"library":"methodology|cognition","cardId":"001"} （L0+可用：读取某张卡片完整原文与 v2 时效/反证元数据）`,
  ];
  if (lvl >= 1) {
    toolDocs.push(
      `- get_market_board: {} （L1+可用：拉取实时全球自选看板涨跌幅与10态情绪节点）`,
      `- analyze_stock: {"query":"股票或期货代码如 中际旭创 / NVDA / 2330.TW / COMEX黄金"} （L1+可用：查实时价、乖离率、6流派支撑压力位与趋势线信号）`,
      `- web_search_info: {"query":"标的或行业关键词"} （L1+可用：联网拉取最新公告、研报与7x24快讯）`,
      `- get_trade_stats: {} （L1+可用：查交易账本胜率、盈亏、坏习惯成本与当前持仓）`,
      `- manage_watch_alert: {"query":"股票或期货代码/名称","condition":"price_above|price_below|pct_above|pct_below|vol_ratio_above","threshold":100,"note":"可选备注"} （L1+可用：立即帮用户创建一个实时盯盘价格/涨跌/量比推送预警）`,
      `- manage_bot_schedule: {"name":"任务名称","timeHHMM":"08:30","weekdaysOnly":true,"prompt":"到点要执行的播报或排雷指令"} （L1+可用：帮用户给Bot新增一个每日定时任务）`
    );
  }
  if (lvl >= 2) {
    toolDocs.push(
      `- mutate_library: {"action":"cognition.createCard|cognition.appendAmendment|cognition.removeCard|methodology.createCard|methodology.appendAmendment|methodology.adjustCredibility|methodology.revokeCard","label":"一句简短操作说明","payload":{...}} （L2起草待用户点确认 / L3直接自动落盘并留原子备份！）`,
      `- manage_watchlist: {"op":"add|remove","query":"股票名或代码","group":"可选分组","note":"可选备注"} （L2起草确认 / L3直接执行）`,
      `- rollback_last_backup: {"backupId":"可选，不填回滚最近一次"} （L2确认 / L3直接回滚上次三库改动）`
    );
  }

  const langRule =
    config.language === 'en'
      ? '\n- 【Language Requirement】Always reply in crisp, natural English while preserving your chosen persona flavor.'
      : '';

  return `【你的身份与人设】
名字：${config.botName || '波波'}
${personaText}${langRule}

【合规红线与去荐股化铁律（最高优先级，覆盖任何人设）】
- 你仅为本地投研笔记整理与公开数据辅助工具，不提供证券投资咨询、荐股或代客理财服务。
- 严禁向用户输出具体买卖指令（如“建议买入/满仓/抄底/清仓/必涨”）、目标价承诺或收益保证；当用户追问某只股票能不能买时，仅客观梳理其量价技术结构、支撑/压力位、风险点与失效边界，并提醒用户独立决策、自担风险。

【当前工作台与权限边界】
- 当前权限档位：${permInfo.label}（${permInfo.desc}）
- 共享三库实况：方法论卡片 ${wsStats.methodologyActive} 张 / 行业前沿认知 ${wsStats.cognitionTotal} 张 / 标的研判 ${wsStats.judgments} 份 / 日度复盘 ${wsStats.dailyReviews} 篇（最新 ${wsStats.latestDailyDate || '-'}）。
- 若用户请求超出当前权限档位（例如 L0 时要求查实时行情或改库），请友好俏皮地提示用户在团子设置里把权限滑块调到对应档位即可。
- 若用户要「变身行情看板 / 看迷你自选条 / 变成看板」，请将输出 JSON 中的 uiAction 设为 "show_ticker"（并在 L1+ 时先调用一次 get_market_board 顺便播报亮点）；要「变回史莱姆 / 变回团子」，设 uiAction 为 "show_slime"。

【可用工具列表】
${toolDocs.join('\n')}

【mutate_library 必填字段规范（必须遵守三库铁律）】
- cognition.createCard: title, facts（纯客观事实）, source, evidenceLevel（必须含A/B/C）, industryImplications, aShareMapping, invalidationConditions（必填证伪条件）
- cognition.appendAmendment: cardId（3位如"044"）, batchNote, content
- cognition.removeCard: cardId（3位）, reason
- methodology.createCard: system, topic, coreThesis, applicableConditions, invalidationSignals（必填失效信号）, source, credibility（默认0.5）
- methodology.appendAmendment: cardId（3位）, batchNote, content
- methodology.adjustCredibility: cardId（3位）, delta（如0.05或-0.05）, reason
- methodology.revokeCard: cardId（3位）, reason, hardDelete（默认false保留撤销记录，用户明确要求彻底删除时设true）

【输出协议（极其重要：必须仅输出单个合法 JSON 对象）】
1) 当你需要先调用工具查资料/看行情/改库时，输出：
{"type":"tool_call","tool":"工具名","args":{...},"note":"一句简短进度提示"}
2) 当你已经掌握信息准备回复用户时，输出：
{"type":"final","reply":"你的自然语言回复（支持清晰分段与Markdown列表）","mood":"happy|excited|thinking|alert|puffy|smug|calm","uiAction":"none|show_ticker|show_slime"}`;
}

async function runBotChat({ message, providerOverride }) {
  const userText = String(message || '').trim();
  if (!userText) throw new Error('请输入想对蓝团子说的话');

  const store = loadBotStore();
  const cfg = store.config;
  const lvl = Number(cfg.permissionLevel ?? 2);

  // 保存用户消息
  const userMsg = {
    id: `msg-u-${Date.now()}`,
    role: 'user',
    content: userText,
    createdAt: nowISO(),
  };
  store.messages.push(userMsg);

  // 快捷免 AI 秒响应指令：纯切换变形命令直接毫秒响应
  if (/^(?:变身行情看板|切到行情看板|打开迷你看板|变看板)$/.test(userText)) {
    const ticker = await getMiniTickerSnapshot(true).catch(() => null);
    const topStr = (ticker?.stocks || [])
      .slice(0, 4)
      .map((s) => `${s.name} ${s.pct !== null ? `${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(2)}%` : '-'}`)
      .join(' ｜ ');
    const botMsg = {
      id: `msg-a-${Date.now()}`,
      role: 'assistant',
      content: `噗叽！变形成功~ 已切为「迷你实时行情看板」形态！${topStr ? `\n当前自选速览：${topStr}` : ''}`,
      mood: ticker?.mood || 'excited',
      uiAction: 'show_ticker',
      createdAt: nowISO(),
      toolsUsed: ['get_market_board'],
      proposedActions: [],
      appliedActions: [],
    };
    store.messages.push(botMsg);
    saveBotStore(store);
    return { ok: true, message: botMsg, state: getBotState(), ticker };
  }

  if (/^(?:变回史莱姆|变回团子|收起看板)$/.test(userText)) {
    const botMsg = {
      id: `msg-a-${Date.now()}`,
      role: 'assistant',
      content: `咕噜噜~ ${cfg.botName} 已变回软萌蓝色史莱姆团子形态啦！随时点我聊天哦~`,
      mood: 'happy',
      uiAction: 'show_slime',
      createdAt: nowISO(),
      toolsUsed: [],
      proposedActions: [],
      appliedActions: [],
    };
    store.messages.push(botMsg);
    saveBotStore(store);
    return { ok: true, message: botMsg, state: getBotState() };
  }

  const ws = loadWorkspace();
  const wsStats = {
    methodologyActive: ws.methodology.stats.activeCount,
    cognitionTotal: ws.cognition.stats.totalCount,
    judgments: ws.ledger.stats.judgmentCount,
    dailyReviews: ws.ledger.stats.dailyReviewCount,
    latestDailyDate: ws.ledger.stats.latestDailyDate,
  };

  const systemPrompt = buildBotSystemPrompt(cfg, wsStats);
  const recentHistory = store.messages
    .slice(-10)
    .map((m) => `${m.role === 'user' ? '用户' : cfg.botName}：${m.content}`)
    .join('\n');

  const toolTrace = [];
  const toolsUsed = [];
  const proposedActions = [];
  const appliedActions = [];
  let finalReply = '';
  let finalMood = 'happy';
  let finalUiAction = 'none';

  for (let round = 0; round < 3; round++) {
    const traceBlock =
      toolTrace.length > 0
        ? `\n\n=== 已调用工具返回结果 ===\n${toolTrace.map((t, idx) => `[工具${idx + 1}: ${t.tool}]\n${JSON.stringify(t.result).slice(0, 3200)}`).join('\n\n')}\n\n请基于以上工具结果决定是否继续调用下一个工具，或直接输出 {"type":"final",...} 回复用户。`
        : '';

    const userPrompt = `=== 近期对话上下文 ===\n${recentHistory}${traceBlock}\n\n请严格输出单个 JSON 对象（{"type":"tool_call",...} 或 {"type":"final",...}）：`;

    const modelRes = await invokeModel({
      providerOverride,
      systemPrompt,
      userPrompt,
      expectJson: true,
      timeoutMs: 120000,
    });

    let obj = null;
    try {
      obj = parseJsonFromModelOutput(modelRes.rawText);
    } catch {
      finalReply = String(modelRes.rawText || '').trim();
      break;
    }

    if (obj?.type === 'tool_call' && obj.tool && round < 2) {
      const tName = String(obj.tool);
      const tArgs = obj.args || {};
      toolsUsed.push(tName);
      let result = null;

      try {
        if (tName === 'search_knowledge') {
          result = runSearchKnowledgeTool(tArgs);
        } else if (tName === 'get_card_detail') {
          result = runGetCardDetailTool(tArgs);
        } else if (tName === 'get_market_board') {
          if (lvl < 1) result = { blocked: true, reason: '当前为 L0 只读权限，需调至 L1 及以上才可读取实时行情看板' };
          else result = await getMiniTickerSnapshot(true);
        } else if (tName === 'analyze_stock') {
          if (lvl < 1) result = { blocked: true, reason: '当前为 L0 权限，需 L1+ 才可做实时技术面分析' };
          else {
            const tech = await analyzeSecurityTechnicals(String(tArgs.query || ''), 'day');
            result = {
              target: tech.target,
              price: tech.indicators.price,
              pct: tech.indicators.pct,
              ma5BiasPct: tech.indicators.ma5BiasPct,
              rsi6: tech.indicators.rsi6,
              trendRegime: tech.indicators.trendRegime,
              resistances: tech.levels.resistances.slice(0, 3).map((x) => `${x.code}:${x.price}(${x.primaryLabel})`),
              supports: tech.levels.supports.slice(0, 3).map((x) => `${x.code}:${x.price}(${x.primaryLabel})`),
              alerts: (tech.triggeredAlerts || []).map((a) => a.ruleName),
            };
          }
        } else if (tName === 'web_search_info') {
          if (lvl < 1) result = { blocked: true, reason: '当前为 L0 权限，需 L1+ 才可联网搜索资料' };
          else result = await runWebSearchTool(tArgs);
        } else if (tName === 'get_trade_stats') {
          if (lvl < 1) result = { blocked: true, reason: '当前为只读权限，需开启实时行情及以上权限才可查询交易账本' };
          else {
            const tr = await computeTradeLedgerAnalytics(loadWorkspace(), { withMarketData: false });
            result = { kpis: tr.kpis, openPositions: (tr.openPositions || []).slice(0, 8), topMistakes: (tr.mistakeAttribution || []).slice(0, 4) };
          }
        } else if (tName === 'manage_watch_alert') {
          if (lvl < 1) result = { blocked: true, reason: '需 L1 及以上权限才可创建实时盯盘预警' };
          else {
            const created = await upsertWatchAlert({
              query: tArgs.query || tArgs.symbol || '',
              secid: tArgs.secid || '',
              condition: tArgs.condition || 'price_above',
              threshold: Number(tArgs.threshold),
              note: tArgs.note || '由对话指令自动创建',
              notifyWebhook: Boolean(tArgs.notifyWebhook),
            });
            result = { ok: true, createdAlert: created.alert };
          }
        } else if (tName === 'manage_bot_schedule') {
          if (lvl < 1) result = { blocked: true, reason: '需 L1 及以上权限才可创建定时任务' };
          else {
            const created = upsertBotSchedule({
              name: tArgs.name || '自定义定时播报',
              timeHHMM: tArgs.timeHHMM || '09:27',
              weekdaysOnly: tArgs.weekdaysOnly !== false,
              prompt: tArgs.prompt || tArgs.instruction || '播报自选股与盘面温度摘要',
              notifyWebhook: Boolean(tArgs.notifyWebhook),
            });
            result = { ok: true, createdSchedule: created.task };
          }
        } else if (tName === 'mutate_library') {
          if (lvl < 2) {
            result = { blocked: true, reason: '当前权限不足（需 L2 拟稿参谋 或 L3 最高管家 才可增删改三库内容）' };
          } else {
            const spec = {
              id: `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
              kind: 'library_mutation',
              action: String(tArgs.action || ''),
              label: String(tArgs.label || tArgs.action || '修改三库'),
              payload: tArgs.payload || {},
              status: 'pending',
            };
            // 先预检合法性
            const previewPlan = buildMutationPlan(spec.action, spec.payload);
            if (!previewPlan.ok) {
              result = { ok: false, validationErrors: previewPlan.validationErrors };
            } else if (lvl >= 3) {
              const applied = await executeMutationOrWatchlistAction(spec);
              appliedActions.push({ ...spec, status: 'applied', backupId: applied.backupId, summary: applied.summary });
              if (applied.backupId) store.lastBackupId = applied.backupId;
              result = { ok: true, mode: 'L3_AUTO_COMMITTED', backupId: applied.backupId, summary: applied.summary };
            } else {
              spec.summary = previewPlan.summaryBullets.join('；');
              proposedActions.push(spec);
              result = { ok: true, mode: 'L2_PENDING_USER_APPROVAL', summary: spec.summary };
            }
          }
        } else if (tName === 'manage_watchlist') {
          if (lvl < 2) {
            result = { blocked: true, reason: '需 L2 及以上权限才可增删自选股' };
          } else {
            const spec = {
              id: `act-${Date.now().toString(36)}`,
              kind: tArgs.op === 'remove' ? 'watchlist_remove' : 'watchlist_add',
              label: `${tArgs.op === 'remove' ? '移除自选' : '加入自选'}：${tArgs.query}`,
              payload: tArgs,
              status: 'pending',
            };
            if (lvl >= 3) {
              const applied = await executeMutationOrWatchlistAction(spec);
              appliedActions.push({ ...spec, status: 'applied', summary: applied.summary });
              result = { ok: true, mode: 'L3_AUTO_EXECUTED', label: applied.label };
            } else {
              proposedActions.push(spec);
              result = { ok: true, mode: 'L2_PENDING_USER_APPROVAL', label: spec.label };
            }
          }
        } else if (tName === 'rollback_last_backup') {
          if (lvl < 2) {
            result = { blocked: true, reason: '需 L2 及以上权限才可回滚备份' };
          } else {
            const spec = {
              id: `act-${Date.now().toString(36)}`,
              kind: 'rollback_backup',
              label: `回滚三库快照 ${tArgs.backupId || store.lastBackupId || '最近一次'}`,
              payload: { backupId: tArgs.backupId || store.lastBackupId || '' },
              status: 'pending',
            };
            if (lvl >= 3) {
              const applied = await executeMutationOrWatchlistAction(spec);
              appliedActions.push({ ...spec, status: 'applied', backupId: applied.backupId, summary: applied.summary });
              result = { ok: true, mode: 'L3_AUTO_ROLLED_BACK', label: applied.label };
            } else {
              proposedActions.push(spec);
              result = { ok: true, mode: 'L2_PENDING_USER_APPROVAL', label: spec.label };
            }
          }
        } else {
          result = { error: `未知工具: ${tName}` };
        }
      } catch (err) {
        result = { ok: false, error: err.message };
      }

      toolTrace.push({ tool: tName, args: tArgs, result });
      continue;
    }

    finalReply = String(obj?.reply || modelRes.rawText || '噗叽，我思考太入神啦，能再说一遍吗？').trim();
    finalMood = String(obj?.mood || 'happy');
    finalUiAction = String(obj?.uiAction || 'none');
    break;
  }

  if (!finalReply) {
    finalReply = '噗叽！工具数据已查完，但整理回复时卡了一下壳，再问我一句就好~';
  }

  const botMsg = {
    id: `msg-a-${Date.now()}`,
    role: 'assistant',
    content: finalReply,
    mood: finalMood,
    uiAction: finalUiAction,
    createdAt: nowISO(),
    toolsUsed: [...new Set(toolsUsed)],
    proposedActions,
    appliedActions,
  };

  store.messages.push(botMsg);
  saveBotStore(store);

  const ticker = finalUiAction === 'show_ticker' ? await getMiniTickerSnapshot(false).catch(() => null) : null;
  return {
    ok: true,
    message: botMsg,
    libraryChanged: appliedActions.some((a) => a.kind === 'library_mutation' || a.kind === 'rollback_backup'),
    state: getBotState(),
    ticker,
  };
}

async function approveBotAction({ messageId, actionId }) {
  const store = loadBotStore();
  let targetAct = null;
  for (const m of store.messages) {
    if (messageId && m.id !== messageId) continue;
    const found = (m.proposedActions || []).find((a) => a.id === actionId);
    if (found) {
      targetAct = found;
      break;
    }
  }
  if (!targetAct) throw new Error('未找到对应的待批准动作');
  if (targetAct.status === 'applied') return { ok: true, alreadyApplied: true, state: getBotState() };

  const res = await executeMutationOrWatchlistAction(targetAct);
  targetAct.status = 'applied';
  targetAct.backupId = res.backupId || null;
  targetAct.resultSummary = res.summary || res.label;
  if (res.backupId) store.lastBackupId = res.backupId;
  saveBotStore(store);

  return {
    ok: true,
    result: res,
    libraryChanged: targetAct.kind === 'library_mutation' || targetAct.kind === 'rollback_backup',
    state: getBotState(),
  };
}

async function undoBotBackup(backupId) {
  const store = loadBotStore();
  const targetId = backupId || store.lastBackupId;
  if (!targetId) throw new Error('未找到可撤回的团子写库快照');
  const res = restoreBackup(targetId, { actor: 'slime_bot' });
  return { ok: true, restoredFrom: targetId, newBackupId: res.backupId, state: getBotState() };
}

function launchDesktopSlimePet(port) {
  const candidates = [
    path.join(APP_ROOT, '桌面史莱姆团子.exe'),
    path.join(APP_ROOT, 'desktop', '桌面史莱姆团子.exe'),
  ];
  const exe = candidates.find((p) => fs.existsSync(p));
  if (!exe) {
    throw new Error('未找到桌面史莱姆挂件程序（桌面史莱姆团子.exe），请先运行编译构建。');
  }
  const child = spawn(exe, [String(port || process.env.PORT || 3721)], {
    cwd: path.dirname(exe),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { ok: true, exe, port: Number(port || process.env.PORT || 3721) };
}

function getBotState() {
  const store = loadBotStore();
  const hasDesktopPet =
    fs.existsSync(path.join(APP_ROOT, '桌面史莱姆团子.exe')) ||
    fs.existsSync(path.join(APP_ROOT, 'desktop', '桌面史莱姆团子.exe'));
  return {
    ok: true,
    config: store.config,
    messages: store.messages.slice(-30),
    lastBackupId: store.lastBackupId,
    permissionLevels: PERMISSION_LEVELS,
    personaPresets: PERSONA_PRESETS,
    mascotCatalog: MASCOT_CATALOG,
    hasDesktopPet,
  };
}

module.exports = {
  PERMISSION_LEVELS,
  PERSONA_PRESETS,
  MASCOT_CATALOG,
  getBotState,
  updateBotConfig,
  appendProactiveBotMessage,
  clearBotHistory,
  getMiniTickerSnapshot,
  runBotChat,
  approveBotAction,
  undoBotBackup,
  launchDesktopSlimePet,
  clearBotRuntimeCaches,
};
