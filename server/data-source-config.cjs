'use strict';

/**
 * 可插拔数据源配置中心（参考 ai-config.cjs 本地安全存储与脱敏模式）
 *
 * - 持久化文件：data-sources.local.json（打包发布与 Git 均排除）
 * - 4 条独立通道管理「用户自定义主源 → 免费公开回退源」：
 *   1. cn_quotes      : A股实时行情 / 分时 / K线 / 五档与 L2 十档盘口 / 逐笔成交
 *   2. cn_short_term  : A股短线特色数据（短线精灵 / 竞价抢筹 / 涨停封单分时 / 龙虎榜席位 / 筹码）
 *   3. news_feeds     : 短线实时新闻与舆情流（主动 JSON Feed 轮询 + 被动 Webhook Ingest + 社区深度贴槽位）
 *   4. global_markets : 海外股市与全球期货（Finnhub / Polygon / Alpha Vantage / 通用自定义 HTTP JSON 网关）
 * - API 返回给前端时自动对 Key / Token / AuthHeader 脱敏；绝不编造缺失的高阶行情字段。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { stateFile } = require('./app-paths.cjs');
const { atomicWriteFileSync } = require('./lru-cache.cjs');
const { encryptSecret, decryptSecret } = require('./secret-vault.cjs');
const { getEditionInfo } = require('./edition.cjs');
const { getMarketExtension } = require('./extensions/index.cjs');

const CONFIG_PATH = stateFile('data-sources.local.json');
const CHANNEL_IDS = ['cn_quotes', 'cn_short_term', 'news_feeds', 'global_markets'];

function normalizeChannelId(cid) {
  const s = String(cid || '').trim();
  if (s === 'global_crypto') return 'global_markets';
  return s;
}

const CHANNEL_PRESETS = {
  cn_quotes: [
    {
      id: 'default_eastmoney',
      label: '免费默认（东财 + 腾讯五档）',
      mode: 'default',
      desc: '零 Key 开箱即用：实时报价、1分钟分时、多周期 K 线、五档盘口与分笔明细。十档/L2 逐笔留槽位待接付费源。',
    },
    {
      id: 'tushare_pro',
      label: 'Tushare Pro Token',
      mode: 'custom',
      baseUrl: 'https://api.tushare.pro',
      quotePath: '',
      orderbookPath: '',
      tickPath: '',
      intradayPath: '',
      klinePath: '',
      authHeaderName: '',
      authHeaderPrefix: '',
      desc: '填入 Tushare Pro Token 接入官方行情/复权日线接口，未覆盖的盘中五档自动回退免费源。',
    },
    {
      id: 'mairui_canghai',
      label: '麦蕊 / 沧海 / 聚合 HTTP 行情',
      mode: 'custom',
      baseUrl: 'https://api.mairuiapi.com',
      quotePath: '/hsrl/ssjy/{code}/{token}',
      orderbookPath: '/hsrl/mm/{code}/{token}',
      tickPath: '/hsrl/fsjy/{code}/{token}',
      intradayPath: '',
      klinePath: '',
      authHeaderName: '',
      authHeaderPrefix: '',
      desc: '支持 URL 模板占位符 {secid} / {code} / {symbol} / {token}，适配常见国内付费 HTTP 行情商。',
    },
    {
      id: 'custom_gateway',
      label: '同花顺 iFinD / Choice / 自建量化网关',
      mode: 'custom',
      baseUrl: 'http://127.0.0.1:8899',
      quotePath: '/api/quote?secid={secid}',
      orderbookPath: '/api/l2/orderbook?secid={secid}',
      tickPath: '/api/l2/ticks?secid={secid}',
      intradayPath: '/api/intraday?secid={secid}',
      klinePath: '/api/kline?secid={secid}&tf={tf}',
      authHeaderName: 'Authorization',
      authHeaderPrefix: 'Bearer ',
      desc: '最推荐用于 L2 十档盘口、逐笔大单与低延迟行情：按契约文档返回标准 JSON 即可零改前端直接点亮。',
    },
  ],
  cn_short_term: [
    {
      id: 'default_eastmoney',
      label: '免费默认（东财短线精灵/涨停池/龙虎榜）',
      mode: 'default',
      desc: '零 Key 开箱即用：盘口短线精灵、涨跌停池、连板天梯与龙虎榜。封单金额分时曲线等高阶数据留槽位。',
    },
    {
      id: 'custom_http',
      label: '自定义高速短线数据接口',
      mode: 'custom',
      baseUrl: 'http://127.0.0.1:8899',
      spritePath: '/api/short-term/sprite?side={side}&limit={limit}',
      auctionPath: '/api/short-term/auction',
      sealFlowPath: '/api/short-term/seal-flow?secid={secid}',
      lhbPath: '/api/short-term/lhb',
      chipPath: '/api/short-term/chips?secid={secid}',
      authHeaderName: 'Authorization',
      authHeaderPrefix: 'Bearer ',
      desc: '支持配置 JSON Path 映射字段，用于点亮封单金额分时曲线、高速竞价抢筹与游资席位。',
    },
  ],
  news_feeds: [
    {
      id: 'default_public',
      label: '默认演示与本地 Webhook（POST /api/feeds/ingest）',
      mode: 'default',
      desc: '商业版默认不抓取未授权社区站点，始终开启本地 POST /api/feeds/ingest 被动推送入口与合规 RSS 订阅。',
    },
    {
      id: 'custom_json_poll',
      label: '自定义 JSON 情报流主动轮询 + Webhook',
      mode: 'custom',
      pollUrl: 'http://127.0.0.1:8899/api/news/live',
      communityUrl: '',
      authHeaderName: 'Authorization',
      authHeaderPrefix: 'Bearer ',
      desc: '定时拉取您自备的合规财经快讯、公告或研究简报 JSON 接口，支持自定义字段路径映射，并与本地 Webhook 合并。',
    },
  ],
  global_markets: [
    {
      id: 'default_eastmoney_global',
      label: '免费默认（东财全球股市 / 大宗期货）',
      mode: 'default',
      desc: '零 Key 覆盖美股/港股/台/韩/法/英/日/德主流股市与全球大宗期货宏观研究。',
    },
    {
      id: 'finnhub',
      label: 'Finnhub API（美股/全球低延迟报价）',
      mode: 'custom',
      baseUrl: 'https://finnhub.io/api/v1',
      desc: '填入 Finnhub API Key 获取美股实时盘前/盘中报价，失败自动回退默认源。',
    },
    {
      id: 'polygon',
      label: 'Polygon.io API（美股/期权行情）',
      mode: 'custom',
      baseUrl: 'https://api.polygon.io',
      desc: '填入 Polygon.io API Key 获取美股聚合报价与 K 线。',
    },
    {
      id: 'alpha_vantage',
      label: 'Alpha Vantage API',
      mode: 'custom',
      baseUrl: 'https://www.alphavantage.co',
      desc: '填入 Alpha Vantage API Key 获取海外市场数据。',
    },
    {
      id: 'custom_global',
      label: '通用自定义 HTTP JSON 适配网关',
      mode: 'custom',
      baseUrl: 'http://127.0.0.1:8899',
      desc: '通过自建标准 HTTP JSON 网关统一转发美股/欧亚股市与全球大宗期货行情。',
    },
  ],
};

function getEffectivePresets() {
  const ext = getMarketExtension('crypto');
  const baseGlobal = CHANNEL_PRESETS.global_markets.map((p) => ({ ...p }));
  if (ext && Array.isArray(ext.DATA_SOURCE_PRESETS)) {
    const customIdx = baseGlobal.findIndex((p) => p.id === 'custom_global');
    const mergedGlobal =
      customIdx >= 0
        ? [...baseGlobal.slice(0, customIdx), ...ext.DATA_SOURCE_PRESETS, ...baseGlobal.slice(customIdx)]
        : [...baseGlobal, ...ext.DATA_SOURCE_PRESETS];
    return {
      ...CHANNEL_PRESETS,
      global_markets: mergedGlobal,
    };
  }
  return {
    ...CHANNEL_PRESETS,
    global_markets: baseGlobal,
  };
}

function generateWebhookToken() {
  return `srw_feed_${crypto.randomBytes(18).toString('hex')}`;
}

function maskSecret(str) {
  const s = String(str || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function createDefaultConfig() {
  return {
    version: 1,
    updatedAt: null,
    cn_quotes: {
      mode: 'default',
      preset: 'default_eastmoney',
      label: '免费默认（东财 + 腾讯五档）',
      fallbackOnError: true,
      baseUrl: '',
      quotePath: '/api/quote?secid={secid}',
      orderbookPath: '/api/l2/orderbook?secid={secid}',
      tickPath: '/api/l2/ticks?secid={secid}',
      intradayPath: '/api/intraday?secid={secid}',
      klinePath: '/api/kline?secid={secid}&tf={tf}',
      wsUrl: '',
      apiKey: '',
      authHeaderName: 'Authorization',
      authHeaderPrefix: 'Bearer ',
      timeoutMs: 6500,
    },
    cn_short_term: {
      mode: 'default',
      preset: 'default_eastmoney',
      label: '免费默认（东财短线引擎）',
      fallbackOnError: true,
      baseUrl: '',
      spritePath: '/api/short-term/sprite?side={side}&limit={limit}',
      auctionPath: '/api/short-term/auction',
      sealFlowPath: '/api/short-term/seal-flow?secid={secid}',
      lhbPath: '/api/short-term/lhb',
      chipPath: '/api/short-term/chips?secid={secid}',
      apiKey: '',
      authHeaderName: 'Authorization',
      authHeaderPrefix: 'Bearer ',
      timeoutMs: 6500,
      jsonPaths: {
        spriteItems: 'items',
        sealSeries: 'series',
        lhbItems: 'items',
      },
    },
    news_feeds: {
      mode: 'default',
      preset: 'default_public',
      label: '免费默认（华尔街见闻 + 东财7×24 + Webhook）',
      fallbackOnError: true,
      pollUrl: '',
      communityUrl: '',
      pollIntervalSec: 30,
      apiKey: '',
      authHeaderName: 'Authorization',
      authHeaderPrefix: 'Bearer ',
      timeoutMs: 6500,
      webhookEnabled: true,
      webhookToken: generateWebhookToken(),
      fieldMap: {
        itemsPath: 'items',
        titleField: 'title',
        contentField: 'content',
        timeField: 'time',
        sourceField: 'source',
        urlField: 'url',
        importantField: 'important',
      },
    },
    global_markets: {
      mode: 'default',
      preset: 'default_eastmoney_global',
      label: '免费默认（东财全球股市 / 大宗期货）',
      fallbackOnError: true,
      baseUrl: '',
      proxyUrl: '',
      cryptoExchange: '',
      apiKey: '',
      authHeaderName: 'Authorization',
      authHeaderPrefix: 'Bearer ',
      timeoutMs: 7000,
    },
    lastChecks: {},
  };
}

const BLOCKED_EXTERNAL_HOST_DIGESTS = new Set([
  'b82b7f4dca3f8e6f',
  '8529e14f1ef897f1',
  '20f661b1940c3470',
  'b06bcfc845e4d556',
  'c495dab5e59dca71',
  '5ff16c740a71ed80',
  '1c9e8bb0732a07f1',
  '3578b95088f1755f',
  'a57f31c787c2cfd8',
  'cf4e79f12c8d0f0e',
  '3f91d06128a841d8',
  '8b7dc0fc641c7af9',
  'e27d61b4e99de0ed',
  '3f375085332cac4f',
  '2e7bf94e7aaffcf0',
  '621c1d7bf9f5a360',
]);

const OFFICIAL_EQUITY_PROVIDER_HOSTS = {
  finnhub: /(?:^|\.)finnhub\.io$/i,
  polygon: /(?:^|\.)polygon\.io$/i,
  alpha_vantage: /(?:^|\.)alphavantage\.co$/i,
};

function hostDigest16(hostname) {
  return crypto.createHash('sha256').update(String(hostname || '').toLowerCase()).digest('hex').slice(0, 16);
}

function parseUrlHostname(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  try {
    const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    return new URL(withProto).hostname.toLowerCase();
  } catch {
    const m = s.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/:?#\s]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
}

function isLocalOrPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  return false;
}

function isBlockedExternalExchangeUrl(rawUrl) {
  const host = parseUrlHostname(rawUrl);
  if (!host) return false;
  if (BLOCKED_EXTERNAL_HOST_DIGESTS.has(hostDigest16(host))) return true;
  const parts = host.split('.').filter(Boolean);
  if (parts.length >= 2) {
    const root2 = parts.slice(-2).join('.');
    if (BLOCKED_EXTERNAL_HOST_DIGESTS.has(hostDigest16(root2))) return true;
  }
  return false;
}

function validateGlobalMarketsForEdition(ch, { fromLegacyKey = false, requireConfirmedInCn = false } = {}) {
  const ed = getEditionInfo();
  if (ed.features.crypto) {
    return { compatible: true, reason: '' };
  }
  const src = ch && typeof ch === 'object' ? ch : {};
  const allowedPresetIds = new Set(CHANNEL_PRESETS.global_markets.map((p) => p.id));
  const preset = String(src.preset || 'default_eastmoney_global').trim();
  if (!allowedPresetIds.has(preset)) {
    return {
      compatible: false,
      reason: '当前国内版不支持该海外扩展预设，已停用并回退免费默认源，请重新配置合规海外股市/期货数据源。',
    };
  }
  if (String(src.cryptoExchange || '').trim()) {
    return {
      compatible: false,
      reason: '检测到旧版不支持的扩展交易所选项，当前国内版已自动停用该通道，请重新配置合规海外股市/期货数据源。',
    };
  }
  for (const field of ['baseUrl', 'proxyUrl']) {
    if (src[field] && isBlockedExternalExchangeUrl(src[field])) {
      return {
        compatible: false,
        reason: '当前国内版禁止指向该外部交易所端点，已自动停用；请配置合规海外股市/期货网关。',
      };
    }
  }
  if (src.mode === 'custom') {
    const isConfirmedEquities = src.assetScope === 'equities_futures';
    if (preset === 'custom_global') {
      if (fromLegacyKey || (requireConfirmedInCn && !isConfirmedEquities)) {
        return {
          compatible: false,
          reason: '检测到旧版或未确认用途的自定义海外网关，国内版已停用并回退默认源，请核对后在数据中心重新保存确认。',
        };
      }
    } else if (OFFICIAL_EQUITY_PROVIDER_HOSTS[preset]) {
      if (fromLegacyKey || (requireConfirmedInCn && !isConfirmedEquities)) {
        const officialRe = OFFICIAL_EQUITY_PROVIDER_HOSTS[preset];
        for (const field of ['baseUrl', 'proxyUrl']) {
          const val = String(src[field] || '').trim();
          if (!val) continue;
          const host = parseUrlHostname(val);
          if (!officialRe.test(host) && !isLocalOrPrivateHost(host)) {
            return {
              compatible: false,
              reason: '检测到旧配置使用非官方第三方代理地址且未确认用途，国内版已停用并回退默认源，请重新核对并配置。',
            };
          }
        }
      }
    }
  }
  return { compatible: true, reason: '' };
}

function getCnNeutralPresetLabel(presetId) {
  const found = CHANNEL_PRESETS.global_markets.find((p) => p.id === presetId);
  return found ? found.label : '免费默认（东财全球股市 / 大宗期货）';
}

const NEUTRAL_GLOBAL_PROBE_PREFIXES = [
  /^Finnhub 美股:[✓✗]/,
  /^Polygon 美股:[✓✗]/,
  /^Alpha Vantage:[✓✗]/,
  /^自建海外网关\(\/quote\):[✓✗]/,
];

function isConfirmedNeutralGlobalCheck(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.assetScope && rec.assetScope !== 'equities_futures') return false;
  if (Array.isArray(rec.endpoints) && rec.endpoints.length > 0) {
    if (rec.endpoints.some((e) => e && e.scope && e.scope !== 'equities_futures')) {
      return false;
    }
  }
  const msg = String(rec.message || '').trim();
  if (!msg) return false;
  // 纯白名单判定：1) 免费默认源单句探测
  if (/^海外股市与大宗期货免费默认源连通正常：/.test(msg) && !/[;；]/.test(msg)) {
    return true;
  }
  // 2) 自定义源分段探测：必须每一段都属于严格白名单中的合规海外股市/期货探针，禁止任何混合扩展探测记录混入
  const customMatch = msg.match(/^(?:自定义源全部契约校验通过|部分\/全部端点校验失败)（\d+ms）：(.+)$/);
  if (customMatch && customMatch[1]) {
    const segments = customMatch[1]
      .split(/[;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) return false;
    return segments.every((seg) => {
      if (!NEUTRAL_GLOBAL_PROBE_PREFIXES.some((re) => re.test(seg))) return false;
      // 防止段尾夹带被禁外部域名
      const urls = seg.match(/https?:\/\/[^\s)）]+/gi) || [];
      return urls.every((u) => !isBlockedExternalExchangeUrl(u));
    });
  }
  return false;
}

function sanitizeLastChecks(rawChecks) {
  if (!rawChecks || typeof rawChecks !== 'object') return {};
  const cryptoEnabled = getEditionInfo().features.crypto;
  const out = {};
  for (const cid of ['cn_quotes', 'cn_short_term', 'news_feeds']) {
    if (rawChecks[cid] && typeof rawChecks[cid] === 'object') {
      out[cid] = rawChecks[cid];
    }
  }
  const gmCheck =
    rawChecks.global_markets && typeof rawChecks.global_markets === 'object'
      ? rawChecks.global_markets
      : rawChecks.global_crypto && typeof rawChecks.global_crypto === 'object'
      ? rawChecks.global_crypto
      : null;
  if (gmCheck) {
    if (cryptoEnabled || isConfirmedNeutralGlobalCheck(gmCheck)) {
      out.global_markets = gmCheck;
    }
  }
  return out;
}

/**
 * 持久化层读取：严格原样读取磁盘 JSON（不做国内版过滤与覆盖），用于保存/测活时保护其他通道及个人版配置。
 */
function loadStoredDataSourceConfig() {
  const def = createDefaultConfig();
  let stored = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      stored = null;
    }
  }
  if (!stored || typeof stored !== 'object') {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(def, null, 2) + '\n', 'utf8');
    } catch {
      // ignore
    }
    return def;
  }
  const out = {
    version: stored.version || 1,
    updatedAt: stored.updatedAt || null,
    cn_quotes: { ...def.cn_quotes, ...(stored.cn_quotes || {}) },
    cn_short_term: {
      ...def.cn_short_term,
      ...(stored.cn_short_term || {}),
      jsonPaths: { ...def.cn_short_term.jsonPaths, ...((stored.cn_short_term && stored.cn_short_term.jsonPaths) || {}) },
    },
    news_feeds: {
      ...def.news_feeds,
      ...(stored.news_feeds || {}),
      fieldMap: { ...def.news_feeds.fieldMap, ...((stored.news_feeds && stored.news_feeds.fieldMap) || {}) },
    },
    lastChecks: stored.lastChecks && typeof stored.lastChecks === 'object' ? { ...stored.lastChecks } : {},
  };
  if (!out.news_feeds.webhookToken) {
    out.news_feeds.webhookToken = generateWebhookToken();
  }
  if (stored.global_markets && typeof stored.global_markets === 'object') {
    out.global_markets = { ...def.global_markets, ...stored.global_markets };
  }
  if (stored.global_crypto && typeof stored.global_crypto === 'object') {
    // 完整保留旧个人版键名与内容，避免国内版修改无关通道时将其破坏
    out.global_crypto = { ...stored.global_crypto };
  }
  if (!out.global_markets && !out.global_crypto) {
    out.global_markets = { ...def.global_markets };
  }
  return out;
}

function loadRawDataSourceConfig() {
  const def = createDefaultConfig();
  const stored = loadStoredDataSourceConfig();

  const mergeChan = (id) => {
    const base = def[id];
    const hasGlobalMarkets = Boolean(stored.global_markets && typeof stored.global_markets === 'object');
    const hasLegacyGlobalCrypto = Boolean(stored.global_crypto && typeof stored.global_crypto === 'object');
    const fromLegacyKey = id === 'global_markets' && !hasGlobalMarkets && hasLegacyGlobalCrypto;
    // 向下兼容旧版 data-sources.local.json 中的 global_crypto 键名，自动迁移读取至 global_markets
    const rawSrc =
      id === 'global_markets'
        ? hasGlobalMarkets
          ? stored.global_markets
          : hasLegacyGlobalCrypto
          ? stored.global_crypto
          : {}
        : stored[id] && typeof stored[id] === 'object'
        ? stored[id]
        : {};
    const merged = { ...base, ...rawSrc };
    if (merged.apiKey) merged.apiKey = decryptSecret(merged.apiKey);
    if (merged.webhookToken) merged.webhookToken = decryptSecret(merged.webhookToken);
    if (base.jsonPaths) {
      merged.jsonPaths = { ...base.jsonPaths, ...(rawSrc.jsonPaths || {}) };
    }
    if (base.fieldMap) {
      merged.fieldMap = { ...base.fieldMap, ...(rawSrc.fieldMap || {}) };
    }
    if (id === 'news_feeds' && !merged.webhookToken) {
      merged.webhookToken = generateWebhookToken();
    }
    merged.mode = merged.mode === 'custom' ? 'custom' : 'default';
    merged.fallbackOnError = merged.fallbackOnError !== false;

    if (id === 'global_markets') {
      const ed = getEditionInfo();
      if (!ed.features.crypto) {
        const compat = validateGlobalMarketsForEdition(merged, { fromLegacyKey, requireConfirmedInCn: true });
        merged.cryptoExchange = '';
        if (!compat.compatible) {
          merged.mode = 'default';
          merged.preset = 'default_eastmoney_global';
          merged.label = '免费默认（东财全球股市 / 大宗期货）';
          merged.baseUrl = '';
          merged.proxyUrl = '';
          merged.needsReconfigure = true;
          merged.migrationNotice = compat.reason;
        } else if (merged.mode === 'default') {
          merged.preset = 'default_eastmoney_global';
          merged.label = '免费默认（东财全球股市 / 大宗期货）';
        } else if (fromLegacyKey || merged.assetScope !== 'equities_futures') {
          // 清理可能夹带旧扩展文案的自定义标签，统一使用合规预设标签
          merged.label = getCnNeutralPresetLabel(merged.preset);
        }
      }
    }
    return merged;
  };

  return {
    version: 1,
    updatedAt: stored.updatedAt || null,
    cn_quotes: mergeChan('cn_quotes'),
    cn_short_term: mergeChan('cn_short_term'),
    news_feeds: mergeChan('news_feeds'),
    global_markets: mergeChan('global_markets'),
    lastChecks: sanitizeLastChecks(stored.lastChecks),
  };
}

function computeCapabilities(cfg) {
  const ext = getMarketExtension('crypto');
  const gm = cfg.global_markets || {};
  const qCustom = cfg.cn_quotes.mode === 'custom' && Boolean(cfg.cn_quotes.baseUrl || cfg.cn_quotes.apiKey || cfg.cn_quotes.wsUrl);
  const stCustom = cfg.cn_short_term.mode === 'custom' && Boolean(cfg.cn_short_term.baseUrl);
  const nfCustom = cfg.news_feeds.mode === 'custom' && Boolean(cfg.news_feeds.pollUrl || cfg.news_feeds.communityUrl);
  const gcCustom =
    gm.mode === 'custom' &&
    Boolean(gm.baseUrl || gm.proxyUrl || gm.apiKey || (ext && ext.hasCustomCryptoConfig(gm)));

  return {
    customChannelCount: [qCustom, stCustom, nfCustom, gcCustom].filter(Boolean).length,
    cnQuotesSource: qCustom ? `自定义 (${cfg.cn_quotes.preset})` : '免费默认 (东财/腾讯)',
    orderbook5Level: {
      available: true,
      tier: qCustom ? 'custom' : 'free',
      label: qCustom ? '自定义盘口源' : '五档盘口（腾讯免费实时）',
    },
    l2Orderbook10: {
      available: qCustom && Boolean(cfg.cn_quotes.orderbookPath),
      tier: qCustom && Boolean(cfg.cn_quotes.orderbookPath) ? 'custom' : 'slot_required',
      channel: 'cn_quotes',
      label: qCustom && Boolean(cfg.cn_quotes.orderbookPath) ? 'L2 十档盘口已接入' : '十档盘口 · 待接入付费源',
    },
    l2TickByTick: {
      available: qCustom && Boolean(cfg.cn_quotes.tickPath),
      tier: qCustom && Boolean(cfg.cn_quotes.tickPath) ? 'custom' : 'slot_required',
      channel: 'cn_quotes',
      label: qCustom && Boolean(cfg.cn_quotes.tickPath) ? 'L2 逐笔大单已接入' : '逐笔大单检测 · 待接入付费源',
    },
    sealFlowIntraday: {
      available: stCustom && Boolean(cfg.cn_short_term.sealFlowPath),
      tier: stCustom && Boolean(cfg.cn_short_term.sealFlowPath) ? 'custom' : 'slot_required',
      channel: 'cn_short_term',
      label: stCustom && Boolean(cfg.cn_short_term.sealFlowPath) ? '封单金额分时已接入' : '封单金额分时曲线 · 待接入付费源',
    },
    communityDeepPost: {
      available: (nfCustom && Boolean(cfg.news_feeds.communityUrl)) || Boolean(cfg.news_feeds.webhookEnabled),
      hasCommunityPull: nfCustom && Boolean(cfg.news_feeds.communityUrl),
      hasWebhook: Boolean(cfg.news_feeds.webhookEnabled),
      tier: nfCustom && Boolean(cfg.news_feeds.communityUrl) ? 'custom' : 'slot_required',
      channel: 'news_feeds',
      label: nfCustom && Boolean(cfg.news_feeds.communityUrl) ? '自定义研究快讯流已接入' : '外部研究简报/深度快讯 · 待接入合规源或 Webhook 推送',
    },
    globalPremium: {
      available: gcCustom,
      tier: gcCustom ? 'custom' : 'free',
      channel: 'global_markets',
      label: gcCustom ? `自定义 (${gm.preset})` : '免费默认 (东财全球股市/期货)',
    },
  };
}

const URL_OR_PATH_FIELDS = [
  'baseUrl',
  'quotePath',
  'orderbookPath',
  'tickPath',
  'intradayPath',
  'klinePath',
  'wsUrl',
  'spritePath',
  'auctionPath',
  'sealFlowPath',
  'lhbPath',
  'chipPath',
  'pollUrl',
  'communityUrl',
  'proxyUrl',
];

function maskUrlCredentials(rawVal) {
  if (typeof rawVal !== 'string' || !rawVal) return rawVal;
  let s = rawVal;
  // 1. 屏蔽 URL 中的 Basic Auth user:pass@ 与单段 userinfo@
  s = s.replace(/(https?|wss?):\/\/([^/\s:@]+):([^/\s@]+)@/gi, '$1://***:***@');
  s = s.replace(/(https?|wss?):\/\/(?!\*\*\*:\*\*\*@)([^/\s@]+)@/gi, '$1://***@');
  // 2. 屏蔽查询参数中的明文凭据（保留模板占位符 {token} / {apiKey}）
  s = s.replace(
    /([?&](?:token|apikey|api_key|api-key|x-api-key|key|secret|auth|auth_token|password|pass|pwd|access_token|access-token|appkey|app_key|appsecret|app_secret|client_secret|private_key|signature|bearer)=)(?!\{[^}]+\})([^&#\s]+)/gi,
    '$1***'
  );
  return s;
}

function sanitizeChannelForClient(id, ch) {
  const out = {
    ...ch,
    hasApiKey: Boolean(ch.apiKey),
    maskedApiKey: maskSecret(ch.apiKey),
  };
  for (const f of URL_OR_PATH_FIELDS) {
    if (typeof out[f] === 'string' && out[f]) {
      out[f] = maskUrlCredentials(out[f]);
    }
  }
  delete out.apiKey;
  if (id === 'news_feeds') {
    out.hasWebhookToken = Boolean(ch.webhookToken);
    out.maskedWebhookToken = maskSecret(ch.webhookToken);
    delete out.webhookToken;
  }
  return out;
}

function getSafeDataSourceConfig(port = 3721) {
  const cfg = loadRawDataSourceConfig();
  return {
    version: cfg.version,
    updatedAt: cfg.updatedAt,
    webhookUrl: `http://127.0.0.1:${port}/api/feeds/ingest`,
    presets: getEffectivePresets(),
    capabilities: computeCapabilities(cfg),
    lastChecks: sanitizeLastChecks(cfg.lastChecks),
    channels: {
      cn_quotes: sanitizeChannelForClient('cn_quotes', cfg.cn_quotes),
      cn_short_term: sanitizeChannelForClient('cn_short_term', cfg.cn_short_term),
      news_feeds: sanitizeChannelForClient('news_feeds', cfg.news_feeds),
      global_markets: sanitizeChannelForClient('global_markets', cfg.global_markets),
    },
  };
}

/**
 * 无任何磁盘写入副作用的 Webhook Token 读取器，专用于外部推流鉴权门禁。
 * 若本地配置文件缺失、损坏或未初始化 token，返回空字符串而不创建/覆写磁盘文件。
 */
function readPersistedWebhookTokenRaw() {
  if (!fs.existsSync(CONFIG_PATH)) return '';
  try {
    const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!stored || typeof stored !== 'object') return '';
    const tok = stored.news_feeds && typeof stored.news_feeds.webhookToken === 'string'
      ? decryptSecret(stored.news_feeds.webhookToken).trim()
      : '';
    return tok;
  } catch {
    return '';
  }
}

function getWebhookTokenRaw() {
  const cfg = loadRawDataSourceConfig();
  return cfg.news_feeds.webhookToken;
}

function normalizeAuthHeaderPrefix(rawPrefix) {
  if (typeof rawPrefix !== 'string') return '';
  const cleaned = rawPrefix.replace(/^\s+/, '');
  if (!cleaned) return '';
  // Preserve explicit trailing space; automatically append single space for bare scheme keywords like "Bearer" / "Token" / "Basic"
  if (/\s$/.test(cleaned)) return cleaned.replace(/\s+$/, ' ');
  if (/^[A-Za-z0-9_-]+$/.test(cleaned)) return `${cleaned} `;
  return cleaned;
}

function normalizeChannelPatch(cid, cur, p = {}) {
  const next = { ...cur };
  if (!p || typeof p !== 'object') return next;

  if (p.mode === 'default' || p.mode === 'custom') next.mode = p.mode;
  if (typeof p.preset === 'string' && p.preset.trim()) next.preset = p.preset.trim();
  if (typeof p.label === 'string') next.label = p.label.trim();
  if (typeof p.fallbackOnError === 'boolean') next.fallbackOnError = p.fallbackOnError;

  const strFields = [
    'baseUrl',
    'quotePath',
    'orderbookPath',
    'tickPath',
    'intradayPath',
    'klinePath',
    'wsUrl',
    'spritePath',
    'auctionPath',
    'sealFlowPath',
    'lhbPath',
    'chipPath',
    'pollUrl',
    'communityUrl',
    'proxyUrl',
    'cryptoExchange',
    'authHeaderName',
    'authHeaderPrefix',
  ];
  for (const f of strFields) {
    if (f in cur && typeof p[f] === 'string') {
      const trimmedVal = p[f].trim();
      const isBaseField = f === 'baseUrl' || f === 'proxyUrl';
      const normalizedIncoming = isBaseField ? trimmedVal.replace(/\/+$/, '') : trimmedVal;
      const normalizedMaskedCur = cur[f]
        ? isBaseField
          ? maskUrlCredentials(cur[f]).replace(/\/+$/, '')
          : maskUrlCredentials(cur[f])
        : '';
      if (URL_OR_PATH_FIELDS.includes(f) && cur[f] && normalizedIncoming === normalizedMaskedCur) {
        // 前端原样回传了脱敏后的 URL/路径，保留本地未脱敏原值不覆盖
        next[f] = cur[f];
        continue;
      }
      if (isBaseField) {
        next[f] = normalizedIncoming;
      } else if (f === 'authHeaderPrefix') {
        next[f] = normalizeAuthHeaderPrefix(p[f]);
      } else {
        next[f] = trimmedVal;
      }
    }
  }

  if (typeof p.timeoutMs === 'number' && Number.isFinite(p.timeoutMs)) {
    next.timeoutMs = Math.max(1500, Math.min(25000, Math.round(p.timeoutMs)));
  }
  if (cid === 'news_feeds') {
    if (typeof p.pollIntervalSec === 'number' && Number.isFinite(p.pollIntervalSec)) {
      next.pollIntervalSec = Math.max(10, Math.min(300, Math.round(p.pollIntervalSec)));
    }
    if (typeof p.webhookEnabled === 'boolean') next.webhookEnabled = p.webhookEnabled;
    if (p.fieldMap && typeof p.fieldMap === 'object') {
      next.fieldMap = { ...cur.fieldMap, ...p.fieldMap };
    }
  }
  if (cid === 'cn_short_term' && p.jsonPaths && typeof p.jsonPaths === 'object') {
    next.jsonPaths = { ...cur.jsonPaths, ...p.jsonPaths };
  }

  if (p.clearApiKey) {
    next.apiKey = '';
  } else if (typeof p.apiKey === 'string' && p.apiKey.trim()) {
    next.apiKey = p.apiKey.trim();
  }

  return next;
}

function saveDataSourceConfig(patch = {}, port = 3721) {
  // 持久化层读写分离：从原始磁盘文件读取，只改目标通道，绝不因国内版运行视图过滤而覆盖个人版其他通道配置
  const persisted = loadStoredDataSourceConfig();
  const def = createDefaultConfig();
  const ed = getEditionInfo();

  // 单通道一键恢复默认（兼容旧 global_crypto 别名）
  if (patch.resetChannel) {
    const cid = normalizeChannelId(patch.resetChannel);
    if (CHANNEL_IDS.includes(cid)) {
      const keepToken = cid === 'news_feeds' ? persisted.news_feeds.webhookToken : undefined;
      persisted[cid] = { ...def[cid] };
      if (cid === 'global_markets') {
        if (!ed.features.crypto) {
          persisted.global_markets.assetScope = 'equities_futures';
        }
        delete persisted.global_crypto;
      }
      if (keepToken) persisted.news_feeds.webhookToken = encryptSecret(keepToken);
      persisted.updatedAt = new Date().toISOString();
      atomicWriteFileSync(CONFIG_PATH, JSON.stringify(persisted, null, 2) + '\n', 'utf8', { mode: 0o600 });
      return getSafeDataSourceConfig(port);
    }
  }

  if (patch.regenerateWebhookToken) {
    persisted.news_feeds.webhookToken = generateWebhookToken();
  }

  const incomingChannels = patch.channels && typeof patch.channels === 'object' ? patch.channels : patch;
  for (const cid of CHANNEL_IDS) {
    const p =
      incomingChannels[cid] && typeof incomingChannels[cid] === 'object'
        ? incomingChannels[cid]
        : cid === 'global_markets' && incomingChannels.global_crypto && typeof incomingChannels.global_crypto === 'object'
        ? incomingChannels.global_crypto
        : null;
    if (!p) continue;
    const baseChan =
      cid === 'global_markets'
        ? persisted.global_markets || { ...def.global_markets, ...(persisted.global_crypto || {}) }
        : persisted[cid] || def[cid];
    const nextChan = normalizeChannelPatch(cid, baseChan, p);
    if (cid === 'global_markets' && !ed.features.crypto) {
      const compat = validateGlobalMarketsForEdition(nextChan, { fromLegacyKey: false, requireConfirmedInCn: false });
      if (!compat.compatible) {
        throw new Error(compat.reason);
      }
      nextChan.cryptoExchange = '';
      nextChan.assetScope = 'equities_futures';
      delete nextChan.needsReconfigure;
      delete nextChan.migrationNotice;
    }
    persisted[cid] = nextChan;
  }

  persisted.updatedAt = new Date().toISOString();
  const toDisk = JSON.parse(JSON.stringify(persisted));
  for (const cid of CHANNEL_IDS) {
    if (toDisk[cid]?.apiKey) toDisk[cid].apiKey = encryptSecret(toDisk[cid].apiKey);
    if (toDisk[cid]?.webhookToken) toDisk[cid].webhookToken = encryptSecret(toDisk[cid].webhookToken);
  }
  atomicWriteFileSync(CONFIG_PATH, JSON.stringify(toDisk, null, 2) + '\n', 'utf8', { mode: 0o600 });
  return getSafeDataSourceConfig(port);
}

function recordChannelCheck(channelId, result) {
  const cid = normalizeChannelId(channelId);
  if (!CHANNEL_IDS.includes(cid)) return;
  // 持久化层读写分离：只更新目标通道的 lastChecks，完整保留磁盘中其余通道与个人版原始配置
  const persisted = loadStoredDataSourceConfig();
  const ed = getEditionInfo();
  const baseChan =
    cid === 'global_markets'
      ? persisted.global_markets || persisted.global_crypto || createDefaultConfig().global_markets
      : persisted[cid] || createDefaultConfig()[cid];
  const endpointsMeta = Array.isArray(result.endpoints)
    ? result.endpoints.map((ep) => ({
        endpoint: String(ep.endpoint || ''),
        ok: Boolean(ep.ok),
        scope: ep.scope || 'equities_futures',
      }))
    : undefined;
  persisted.lastChecks = {
    ...(persisted.lastChecks || {}),
    [cid]: {
      checkedAt: new Date().toISOString(),
      ok: Boolean(result.ok),
      latencyMs: result.latencyMs ?? null,
      mode: result.mode || baseChan.mode,
      edition: ed.edition,
      preset: result.preset || baseChan.preset || '',
      assetScope: result.assetScope || (cid === 'global_markets' && !ed.features.crypto ? 'equities_futures' : undefined),
      ...(endpointsMeta ? { endpoints: endpointsMeta } : {}),
      message: String(result.message || ''),
    },
  };
  try {
    atomicWriteFileSync(CONFIG_PATH, JSON.stringify(persisted, null, 2) + '\n', 'utf8', { mode: 0o600 });
  } catch {
    // non-fatal
  }
}

module.exports = {
  CONFIG_PATH,
  CHANNEL_IDS,
  CHANNEL_PRESETS,
  normalizeChannelId,
  getEffectivePresets,
  normalizeAuthHeaderPrefix,
  normalizeChannelPatch,
  maskUrlCredentials,
  isBlockedExternalExchangeUrl,
  validateGlobalMarketsForEdition,
  isConfirmedNeutralGlobalCheck,
  loadStoredDataSourceConfig,
  loadRawDataSourceConfig,
  getSafeDataSourceConfig,
  readPersistedWebhookTokenRaw,
  getWebhookTokenRaw,
  saveDataSourceConfig,
  recordChannelCheck,
  computeCapabilities,
};
