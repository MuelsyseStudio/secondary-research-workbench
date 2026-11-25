'use strict';

/**
 * 统一可插拔数据源路由适配层（4 通道生产级主源 + WebSocket 实时订阅 + 免费回退 + Webhook 推流 + L2 盘口）
 *
 * 严格遵循诚实数据边界与安全契约：
 * 1. 免费默认源开箱即用；自定义主源（含 A股 HTTP / WebSocket、短线全接口、新闻主动轮询、海外与全球市场）真实切源，
 *    严格遵守 fallbackOnError 开关；
 * 2. 区分「上游合法空结果」与「非空映射失败 / 上游请求失败」，绝不在合法空结果或关闭回退时静默混入默认数据；
 * 3. 缺失或无效字段一律归一化为 null（vol / amt / avgPrice / orders / amountWan / totalCap 等绝不补 0 或 1）；
 * 4. 所有错误摘要与连接测试消息严格执行密钥/Token 脱敏；保存与探测共用同一套规范化、路由解析与契约校验。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { stateFile } = require('./app-paths.cjs');
const {
  CHANNEL_IDS,
  normalizeChannelId,
  normalizeAuthHeaderPrefix,
  normalizeChannelPatch,
  maskUrlCredentials,
  validateGlobalMarketsForEdition,
  loadRawDataSourceConfig,
  readPersistedWebhookTokenRaw,
  getWebhookTokenRaw,
  recordChannelCheck,
  computeCapabilities,
} = require('./data-source-config.cjs');
const { getMarketExtension } = require('./extensions/index.cjs');

const INGEST_PATH = stateFile('feeds-ingest.local.json');
const MAX_INGEST_ITEMS = 200;

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
};

const memCache = new Map();
function getCached(key, ttlMs) {
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  return null;
}
function setCached(key, data) {
  memCache.set(key, { ts: Date.now(), data });
  return data;
}

function toNullableNum(v) {
  if (v === null || v === undefined || v === '' || v === '-' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNullableInt(v) {
  const n = toNullableNum(v);
  return n != null ? Math.round(n) : null;
}

function round2(v) {
  const n = toNullableNum(v);
  return n != null ? Number(n.toFixed(2)) : null;
}

function nowOffsetISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 脱敏所有已配置的密钥 / Webhook Token / URL 内嵌凭据，防止上游错误或 URL 泄漏至前端或持久化日志
 */
function redactSecrets(rawMsg, extraSecrets = []) {
  let text = String(rawMsg || '').trim();
  if (!text) return '';
  const secrets = new Set();
  try {
    const cfg = loadRawDataSourceConfig();
    for (const cid of CHANNEL_IDS) {
      if (cfg[cid]?.apiKey) secrets.add(String(cfg[cid].apiKey));
    }
    if (cfg.news_feeds?.webhookToken) secrets.add(String(cfg.news_feeds.webhookToken));
  } catch {
    // ignore
  }
  for (const s of extraSecrets || []) {
    if (typeof s === 'string' && s.trim().length >= 4) secrets.add(s.trim());
  }
  for (const sec of secrets) {
    if (sec.length < 4) continue;
    text = text.replace(new RegExp(escapeRegExp(sec), 'g'), '***REDACTED***');
    const enc = encodeURIComponent(sec);
    if (enc !== sec) {
      text = text.replace(new RegExp(escapeRegExp(enc), 'g'), '***REDACTED***');
    }
  }
  text = maskUrlCredentials(text);
  text = text.replace(/(Bearer\s+|Token\s+|Basic\s+)[A-Za-z0-9._\-+/=]{6,}/gi, '$1***');
  return text.slice(0, 220);
}

function safeClientWsUrl(qCfg) {
  if (qCfg?.mode !== 'custom' || !qCfg?.wsUrl) return null;
  const raw = String(qCfg.wsUrl).trim();
  if (!raw || raw.includes('{token}') || maskUrlCredentials(raw) !== raw) return null;
  return raw;
}

function getByJsonPath(obj, pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return obj;
  const clean = pathStr.replace(/^\$\.?/, '').trim();
  if (!clean) return obj;
  const parts = clean.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function buildAuthHeaders(channelCfg) {
  const headers = { ...DEFAULT_HEADERS, Accept: 'application/json' };
  const name = String(channelCfg?.authHeaderName || '').trim();
  const key = String(channelCfg?.apiKey || '').trim();
  if (name && key) {
    const prefix = normalizeAuthHeaderPrefix(String(channelCfg?.authHeaderPrefix || ''));
    headers[name] = `${prefix}${key}`;
  }
  return headers;
}

function resolveTemplateUrl(baseUrl, pathTpl, vars = {}) {
  const tpl = String(pathTpl || '').trim();
  if (!tpl) return '';
  let full = /^https?:\/\//i.test(tpl)
    ? tpl
    : `${String(baseUrl || '').replace(/\/+$/, '')}/${tpl.replace(/^\/+/, '')}`;
  for (const [k, v] of Object.entries(vars)) {
    full = full.replace(new RegExp(`\\{${k}\\}`, 'g'), encodeURIComponent(String(v ?? '')));
  }
  return full;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 6500, extraSecrets = []) {
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`上游 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    }
    return await res.json();
  } catch (err) {
    throw new Error(redactSecrets(err?.message || String(err), extraSecrets));
  }
}

function secidToTencentSym(secid) {
  const s = String(secid || '').trim();
  const [mkt, ...rest] = s.split('.');
  const code = rest.join('.');
  if (!code) return '';
  if (mkt === '1') return `sh${code}`;
  if (mkt === '0') {
    if (code.startsWith('4') || code.startsWith('8') || code.startsWith('92')) return `bj${code}`;
    return `sz${code}`;
  }
  if (mkt === '116') return `hk${code}`;
  return '';
}

function secidToCode(secid) {
  const parts = String(secid || '').split('.');
  return parts.length > 1 ? parts.slice(1).join('.') : String(secid || '');
}

function secidToTsCode(secid) {
  const [mkt, ...rest] = String(secid || '').split('.');
  const code = rest.join('.');
  if (mkt === '1') return `${code}.SH`;
  if (mkt === '0') return code.startsWith('4') || code.startsWith('8') || code.startsWith('92') ? `${code}.BJ` : `${code}.SZ`;
  return code;
}

function isCnSecid(secid) {
  return /^(0|1)\.\d{6}$/.test(String(secid || '').trim());
}

// ============================================================================
// 0. A 股自定义 WebSocket 实时订阅适配层（真实订阅 / 切票重订 / 断线回退）
// ============================================================================

const wsClients = new Map(); // wsUrl -> { ws, state, subscribed: Set<string>, dataBySecid: Map<string, { quote, orderbook, ticks, updatedAt }>, waiters: Map<string, Function[]> }

function closeWsConnections() {
  for (const client of wsClients.values()) {
    try {
      client.ws?.close?.();
    } catch {
      // ignore
    }
    for (const list of client.waiters.values()) {
      for (const fn of list) fn(null);
    }
    client.waiters.clear();
  }
  wsClients.clear();
}

function clearRouterCaches() {
  memCache.clear();
  closeWsConnections();
}

function normalizeCustomQuoteNode(secid, d, sourceTier = 'custom') {
  if (!d || typeof d !== 'object') return null;
  const code = secidToCode(secid);
  const price = round2(d.price ?? d.last ?? d.p);
  const preClose = round2(d.preClose ?? d.prevClose ?? d.yc);
  if (price == null && !d.name) return null;
  return {
    secid,
    code: String(d.code || code),
    name: String(d.name || ''),
    price,
    preClose,
    open: round2(d.open ?? d.o),
    high: round2(d.high ?? d.h),
    low: round2(d.low ?? d.l),
    pct: round2(d.pct ?? d.pc ?? (price != null && preClose ? ((price - preClose) / preClose) * 100 : null)),
    chg: round2(d.chg ?? (price != null && preClose != null ? price - preClose : null)),
    volume: toNullableNum(d.volume ?? d.vol ?? d.v),
    amount: toNullableNum(d.amount ?? d.amt),
    amplitudePct: round2(d.amplitudePct ?? d.zf),
    turnoverPct: round2(d.turnoverPct ?? d.hs),
    volumeRatio: round2(d.volumeRatio ?? d.lb),
    peTtm: round2(d.peTtm ?? d.pe),
    pb: round2(d.pb),
    totalCap: toNullableNum(d.totalCap),
    sourceTier,
  };
}

function normalizeCustomOrderBookNode(secid, data, presetLabel = 'custom', sourceTier = 'custom') {
  if (!data || (!Array.isArray(data.bids) && !Array.isArray(data.asks))) return null;
  const code = secidToCode(secid);
  const allBids = normalizeOrderBookLevels(data.bids);
  const allAsks = normalizeOrderBookLevels(data.asks);
  return {
    secid,
    code: String(data.code || code),
    name: String(data.name || code),
    last: round2(data.last ?? data.price),
    preClose: round2(data.preClose),
    open: round2(data.open),
    high: round2(data.high),
    low: round2(data.low),
    chg: round2(data.chg),
    pct: round2(data.pct),
    avgPrice: round2(data.avgPrice),
    volumeLots: toNullableInt(data.volumeLots),
    amountYi: round2(data.amountYi),
    outVol: toNullableInt(data.outVol),
    inVol: toNullableInt(data.inVol),
    turnoverPct: round2(data.turnoverPct),
    peTtm: round2(data.peTtm),
    amplitudePct: round2(data.amplitudePct),
    circCapYi: round2(data.circCapYi),
    totalCapYi: round2(data.totalCapYi),
    limitUp: round2(data.limitUp),
    limitDown: round2(data.limitDown),
    volumeRatio: round2(data.volumeRatio),
    weibi: round2(data.weibi),
    weicha: toNullableInt(data.weicha),
    orderbookDepth: Math.max(allBids.length, allAsks.length),
    bids: allBids.slice(0, 5),
    asks: allAsks.slice(0, 5),
    bids6to10: allBids.length > 5 ? allBids.slice(5, 10) : null,
    asks6to10: allAsks.length > 5 ? allAsks.slice(5, 10) : null,
    sourceTier,
    sourceLabel: sourceTier === 'custom_ws' ? `WebSocket 实时盘口 (${presetLabel})` : `自定义盘口源 (${presetLabel})`,
  };
}

function ingestWsMessage(client, rawData, presetLabel) {
  let msg;
  try {
    msg = JSON.parse(typeof rawData === 'string' ? rawData : String(rawData));
  } catch {
    return;
  }
  const payload = msg?.data && typeof msg.data === 'object' && !Array.isArray(msg.data) ? msg.data : msg;
  if (!payload || typeof payload !== 'object') return;
  const rawCode = String(payload.code || '').trim();
  const secid = String(
    payload.secid ||
      msg.secid ||
      (rawCode ? (rawCode.startsWith('6') || rawCode.startsWith('9') ? `1.${rawCode}` : `0.${rawCode}`) : '')
  ).trim();
  if (!secid) return;

  const entry = client.dataBySecid.get(secid) || { quote: null, orderbook: null, ticks: null, updatedAt: 0 };
  const qNorm = normalizeCustomQuoteNode(secid, payload, 'custom');
  if (qNorm) entry.quote = qNorm;
  const obNorm = normalizeCustomOrderBookNode(secid, payload, presetLabel, 'custom_ws');
  if (obNorm) entry.orderbook = obNorm;
  const tickArr = Array.isArray(payload.ticks) ? payload.ticks : payload.tick ? [payload.tick] : null;
  if (tickArr) {
    const mapped = tickArr.map(normalizeCustomTick);
    entry.ticks = [...mapped, ...(entry.ticks || [])].slice(0, 50);
  }
  entry.updatedAt = Date.now();
  client.dataBySecid.set(secid, entry);

  const waiters = client.waiters.get(secid);
  if (waiters && waiters.length > 0) {
    client.waiters.delete(secid);
    for (const fn of waiters) fn(entry);
  }
}

async function requestCnWsSnapshot(qCfg, secid, waitMs = 1500) {
  const rawWsUrl = String(qCfg?.wsUrl || '').trim();
  if (!rawWsUrl || typeof globalThis.WebSocket !== 'function') {
    throw new Error('未配置 WebSocket 地址或当前运行环境不支持原生 WebSocket');
  }
  const wsUrl = rawWsUrl.replace(/\{token\}/g, encodeURIComponent(String(qCfg?.apiKey || '')));

  let client = wsClients.get(wsUrl);
  const sendSub = (c, targetSecid) => {
    if (!c.ws || c.ws.readyState !== 1) return;
    if (c.activeSecid && c.activeSecid !== targetSecid) {
      try {
        c.ws.send(JSON.stringify({ action: 'unsubscribe', secid: c.activeSecid, code: secidToCode(c.activeSecid) }));
      } catch {
        // ignore
      }
    }
    c.activeSecid = targetSecid;
    c.subscribed.add(targetSecid);
    try {
      c.ws.send(
        JSON.stringify({
          action: 'subscribe',
          secid: targetSecid,
          code: secidToCode(targetSecid),
          ...(qCfg.apiKey ? { token: qCfg.apiKey } : {}),
        })
      );
    } catch {
      // ignore
    }
  };

  if (!client || client.state === 'closed' || client.state === 'error') {
    client = {
      ws: null,
      state: 'connecting',
      activeSecid: '',
      subscribed: new Set(),
      dataBySecid: new Map(),
      waiters: new Map(),
      openPromise: null,
      lastError: null,
    };
    wsClients.set(wsUrl, client);

    client.openPromise = new Promise((resolve, reject) => {
      let settled = false;
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.state = 'error';
        client.lastError = 'WebSocket 连接超时';
        try {
          client.ws?.close?.();
        } catch {
          // ignore
        }
        reject(new Error('WebSocket 连接超时'));
      }, Math.min(waitMs + 1000, qCfg.timeoutMs || 5000));

      try {
        const ws = new globalThis.WebSocket(wsUrl);
        client.ws = ws;
        ws.addEventListener('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          client.state = 'open';
          resolve(client);
        });
        ws.addEventListener('message', (ev) => {
          ingestWsMessage(client, ev.data, qCfg.preset || 'ws');
        });
        ws.addEventListener('error', () => {
          client.state = 'error';
          client.lastError = 'WebSocket 连接异常';
          if (!settled) {
            settled = true;
            clearTimeout(t);
            reject(new Error('WebSocket 连接异常'));
          }
          for (const list of client.waiters.values()) {
            for (const fn of list) fn(null);
          }
          client.waiters.clear();
        });
        ws.addEventListener('close', () => {
          client.state = 'closed';
          for (const list of client.waiters.values()) {
            for (const fn of list) fn(null);
          }
          client.waiters.clear();
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          client.state = 'error';
          reject(err);
        }
      }
    });
  }

  if (client.state === 'connecting') {
    await client.openPromise;
  }
  if (client.state !== 'open') {
    throw new Error(client.lastError || 'WebSocket 未连接');
  }

  // 若已有该标的 5 秒内新鲜推送则直接返回；切票时立即重订
  const existing = client.dataBySecid.get(secid);
  if (client.activeSecid !== secid || !existing) {
    sendSub(client, secid);
  }
  if (existing && Date.now() - existing.updatedAt < 5000) {
    return existing;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const list = client.waiters.get(secid) || [];
      client.waiters.set(secid, list.filter((f) => f !== onData));
      const latest = client.dataBySecid.get(secid);
      if (latest) resolve(latest);
      else reject(new Error('WebSocket 订阅已建立但等待推送超时'));
    }, waitMs);

    const onData = (entry) => {
      clearTimeout(timer);
      if (entry) resolve(entry);
      else reject(new Error('WebSocket 连接已断开'));
    };

    const arr = client.waiters.get(secid) || [];
    arr.push(onData);
    client.waiters.set(secid, arr);
  });
}

// ============================================================================
// 1. Webhook 被动推流存储 & 时间戳解析（POST /api/feeds/ingest）
// ============================================================================

function loadIngestedFeeds() {
  if (!fs.existsSync(INGEST_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(INGEST_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveIngestedFeeds(items) {
  try {
    fs.writeFileSync(INGEST_PATH, JSON.stringify(items.slice(0, MAX_INGEST_ITEMS), null, 2) + '\n', 'utf8');
  } catch {
    // ignore
  }
}

function timingSafeTokenEqual(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function verifyBearerWebhookToken(reqHeaders) {
  const auth = String(reqHeaders?.authorization || reqHeaders?.Authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!bearer) return { ok: false, error: '缺少 Authorization: Bearer <token> 请求头' };
  const expected = readPersistedWebhookTokenRaw();
  if (!expected) return { ok: false, error: '服务端未初始化 Webhook Token' };
  if (!timingSafeTokenEqual(bearer, expected)) return { ok: false, error: 'Webhook Bearer Token 校验失败' };
  return { ok: true };
}

function verifyWebhookAuth(reqHeaders, { allowLegacyHeader = false } = {}) {
  const auth = String(reqHeaders?.authorization || reqHeaders?.Authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const xToken = allowLegacyHeader
    ? String(reqHeaders?.['x-feed-token'] || reqHeaders?.['X-Feed-Token'] || '').trim()
    : '';
  const candidate = bearer || xToken;
  if (!candidate) {
    return {
      ok: false,
      error: allowLegacyHeader
        ? '缺少 Authorization: Bearer <token> 或 X-Feed-Token 请求头'
        : '缺少有效的 Authorization: Bearer <token> 请求头',
    };
  }
  const expected = readPersistedWebhookTokenRaw();
  if (!expected) return { ok: false, error: '服务端未初始化 Webhook Token' };
  if (!timingSafeTokenEqual(candidate, expected)) return { ok: false, error: 'Webhook Token 校验失败' };
  return { ok: true };
}

function parseItemTimestampAndLabel(raw) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  let ts = null;
  let explicitTimeLabel = '';

  if (typeof raw?.timestamp === 'number' && Number.isFinite(raw.timestamp)) {
    ts = raw.timestamp > 1e12 ? raw.timestamp : raw.timestamp * 1000;
  } else if (typeof raw?.time === 'number' && Number.isFinite(raw.time)) {
    ts = raw.time > 1e12 ? raw.time : raw.time * 1000;
  } else if (raw?.publishedAt || raw?.createdAt) {
    const parsed = Date.parse(String(raw.publishedAt || raw.createdAt));
    if (Number.isFinite(parsed)) ts = parsed;
  }

  if (typeof raw?.time === 'string' && raw.time.trim()) {
    const s = raw.time.trim();
    const hm = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (hm) {
      const hh = Number(hm[1]);
      const mm = Number(hm[2]);
      const ss = Number(hm[3] || 0);
      explicitTimeLabel = `${pad(hh)}:${pad(mm)}${hm[3] ? `:${pad(ss)}` : ''}`;
      if (ts == null && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && ss >= 0 && ss <= 59) {
        ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, ss).getTime();
      }
    } else {
      const normalizedIso = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s;
      const parsed = Date.parse(normalizedIso);
      if (Number.isFinite(parsed)) {
        if (ts == null) ts = parsed;
        const dt = new Date(parsed);
        explicitTimeLabel = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
      } else {
        explicitTimeLabel = s.slice(0, 8);
      }
    }
  }

  if (ts == null) ts = now.getTime();
  const d = new Date(ts);
  const timeStr = explicitTimeLabel || `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { timestamp: ts, time: timeStr };
}

function normalizeFeedItem(raw, defaultSource = 'Webhook推送', defaultChannel = 'webhook') {
  const now = new Date();
  const title = raw?.title != null ? String(raw.title).trim() : '';
  const bodyCandidate = raw?.content ?? raw?.body ?? raw?.text ?? raw?.summary ?? '';
  const fullContent = String(bodyCandidate || '').trim();
  if (!title && !fullContent) return null;

  const effectiveContent = (fullContent || title).slice(0, 12000);
  const { timestamp, time } = parseItemTimestampAndLabel(raw);

  return {
    id: String(raw?.id || `wh-${timestamp}-${Math.random().toString(36).slice(2, 7)}`),
    time,
    timestamp,
    source: String(raw?.source || defaultSource).trim(),
    channel: String(raw?.channel || defaultChannel).trim(),
    title: (title || effectiveContent.slice(0, 60)).slice(0, 160),
    summary: effectiveContent.slice(0, 240),
    content: effectiveContent,
    url: typeof raw?.url === 'string' && raw.url.trim() ? raw.url.trim() : null,
    important: Boolean(raw?.important || raw?.level === 'high' || raw?.priority === 'high'),
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String).slice(0, 8) : [],
    secids: Array.isArray(raw?.secids) ? raw.secids.map(String).slice(0, 8) : [],
    isCommunity: Boolean(raw?.isCommunity || raw?.channel === 'community' || raw?.channel === 'jygs'),
    ingestedAt: now.toISOString(),
  };
}

function ingestWebhookFeeds(payload, { bypassAuth = false, reqHeaders = {}, allowLegacyHeader = false } = {}) {
  const cfg = loadRawDataSourceConfig();
  if (!cfg.news_feeds.webhookEnabled && !bypassAuth) {
    return { ok: false, status: 403, error: 'Webhook 被动推流已在数据源配置中关闭' };
  }
  if (!bypassAuth) {
    const authRes = verifyWebhookAuth(reqHeaders, { allowLegacyHeader });
    if (!authRes.ok) return { ok: false, status: 401, error: authRes.error };
  }

  const rawList = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
    ? payload.items
    : payload && typeof payload === 'object'
    ? [payload]
    : [];

  const accepted = [];
  for (const raw of rawList.slice(0, 50)) {
    const item = normalizeFeedItem(raw, raw?.source || 'Webhook电报', raw?.channel || 'webhook');
    if (item) accepted.push(item);
  }
  if (accepted.length === 0) {
    return { ok: false, status: 400, error: '未解析到有效快讯条目（请至少包含 title 或 content 字段）' };
  }

  const existing = loadIngestedFeeds();
  const seen = new Set(accepted.map((x) => x.id));
  const merged = [...accepted, ...existing.filter((x) => !seen.has(x.id))].slice(0, MAX_INGEST_ITEMS);
  saveIngestedFeeds(merged);

  return {
    ok: true,
    status: 200,
    acceptedCount: accepted.length,
    totalStored: merged.length,
    latest: accepted[0],
  };
}

function listIngestedFeeds(limit = 50) {
  return loadIngestedFeeds().slice(0, Math.max(1, Math.min(200, limit)));
}

function clearIngestedFeeds() {
  saveIngestedFeeds([]);
  return { ok: true, totalStored: 0 };
}

// ============================================================================
// 2. 通道 1：A 股实时行情 / 分时 / K 线 / 五档与 L2 十档盘口 / 逐笔成交
// ============================================================================

function normalizeOrderBookLevels(arr) {
  return (arr || []).slice(0, 10).map((r, i) => ({
    level: toNullableInt(r?.level) ?? i + 1,
    price: round2(r?.price ?? r?.p),
    volume: toNullableInt(r?.volume ?? r?.v ?? r?.lots),
  }));
}

function normalizeCustomTick(t) {
  const price = round2(t?.price ?? t?.p);
  const volume = toNullableInt(t?.volume ?? t?.v ?? t?.lots);
  const orders = toNullableInt(t?.orders ?? t?.count);
  let amountWan = round2(t?.amountWan);
  if (amountWan == null && price != null && volume != null) {
    const unit = String(t?.volumeUnit || 'lots').toLowerCase();
    if (unit === 'lots') {
      amountWan = round2((price * volume * 100) / 10000);
    } else if (unit === 'shares') {
      amountWan = round2((price * volume) / 10000);
    }
  }
  const sideRaw = String(t?.side || '').toLowerCase();
  const side = sideRaw === 'buy' || sideRaw === 'b' ? 'buy' : sideRaw === 'sell' || sideRaw === 's' ? 'sell' : 'neutral';
  return {
    time: String(t?.time || ''),
    price,
    volume,
    orders,
    side,
    amountWan,
    isBigOrder: typeof t?.isBigOrder === 'boolean' ? t.isBigOrder : amountWan != null ? amountWan >= 100 : false,
  };
}

function parseCustomIntradayPayload(raw) {
  const node = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
  const ptsRaw = Array.isArray(node)
    ? node
    : Array.isArray(node?.points)
    ? node.points
    : Array.isArray(node?.items)
    ? node.items
    : null;
  if (!Array.isArray(ptsRaw)) return null;
  const points = ptsRaw
    .map((pt, idx) => {
      const p = round2(pt?.p ?? pt?.price ?? pt?.close);
      const prevP = idx > 0 ? round2(ptsRaw[idx - 1]?.p ?? ptsRaw[idx - 1]?.price ?? ptsRaw[idx - 1]?.close) : p;
      return {
        t: String(pt?.t || pt?.time || ''),
        p,
        // 严禁把现价冒充均价：上游未返回均价字段时明确保留 null
        a: round2(pt?.a ?? pt?.avg ?? pt?.avgPrice),
        v: toNullableNum(pt?.v ?? pt?.vol ?? pt?.volume),
        up: typeof pt?.up === 'boolean' ? pt.up : p != null && prevP != null ? p >= prevP : true,
      };
    })
    .filter((x) => x.t && x.p != null);
  return {
    available: points.length > 0,
    barCount: points.length,
    preClose: round2(node?.preClose),
    tradeDate: String(node?.tradeDate || ''),
    points,
  };
}

function parseCustomKlinesPayload(raw) {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.klines)
    ? raw.klines
    : Array.isArray(raw?.bars)
    ? raw.bars
    : Array.isArray(raw?.data)
    ? raw.data
    : null;
  if (!Array.isArray(arr)) return null;
  let prevClose = null;
  return arr
    .map((r) => {
      const open = round2(r?.open ?? r?.o);
      const close = round2(r?.close ?? r?.c);
      const high = round2(r?.high ?? r?.h);
      const low = round2(r?.low ?? r?.l);
      // 严禁将缺失成交量/成交额补 0：明确区分 null（未知）与 0（明确返回零）
      const vol = toNullableNum(r?.vol ?? r?.volume ?? r?.v);
      const amt = toNullableNum(r?.amt ?? r?.amount);
      const chg = close != null && prevClose != null ? round2(close - prevClose) : round2(r?.chg);
      const pct = close != null && prevClose ? round2(((close - prevClose) / prevClose) * 100) : round2(r?.pct);
      prevClose = close ?? prevClose;
      return {
        date: String(r?.date || r?.time || r?.t || ''),
        open,
        close,
        high,
        low,
        vol,
        amt,
        ampPct: open && high != null && low != null ? round2(((high - low) / open) * 100) : round2(r?.ampPct),
        pct,
        chg,
        turnoverPct: round2(r?.turnoverPct),
      };
    })
    .filter((k) => k.date && k.close != null);
}

async function fetchFreeTencentOrderBook(secid) {
  const sym = secidToTencentSym(secid);
  if (!sym || (!sym.startsWith('sh') && !sym.startsWith('sz') && !sym.startsWith('bj'))) {
    return null;
  }
  const res = await fetch(`https://qt.gtimg.cn/q=${encodeURIComponent(sym)}`, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(6500),
  });
  if (!res.ok) throw new Error(`Tencent HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = new TextDecoder('gbk').decode(buf);
  const parts = text.split('~');
  if (parts.length < 48) throw new Error('腾讯行情字段不足');

  const num = (idx) => toNullableNum(parts[idx]);

  const bids = [];
  for (let i = 0; i < 5; i++) {
    const price = num(9 + i * 2);
    const volume = toNullableInt(parts[10 + i * 2]);
    if (price != null && price > 0) {
      bids.push({ level: i + 1, price: round2(price), volume });
    }
  }
  const asks = [];
  for (let i = 0; i < 5; i++) {
    const price = num(19 + i * 2);
    const volume = toNullableInt(parts[20 + i * 2]);
    if (price != null && price > 0) {
      asks.push({ level: i + 1, price: round2(price), volume });
    }
  }

  const validBids = bids.filter((x) => x.volume != null);
  const validAsks = asks.filter((x) => x.volume != null);
  const bidSum = validBids.reduce((acc, x) => acc + x.volume, 0);
  const askSum = validAsks.reduce((acc, x) => acc + x.volume, 0);
  const weicha = validBids.length || validAsks.length ? bidSum - askSum : null;
  const weibi = weicha != null && bidSum + askSum > 0 ? round2((weicha / (bidSum + askSum)) * 100) : null;
  const amountWan = num(37);

  return {
    secid,
    code: parts[2] || secidToCode(secid),
    name: parts[1] || secidToCode(secid),
    last: round2(num(3)),
    preClose: round2(num(4)),
    open: round2(num(5)),
    high: round2(num(33)),
    low: round2(num(34)),
    chg: round2(num(31)),
    pct: round2(num(32)),
    avgPrice: round2(num(51)),
    volumeLots: toNullableInt(parts[6]),
    amountYi: amountWan != null ? round2(amountWan / 10000) : null,
    outVol: toNullableInt(parts[7]),
    inVol: toNullableInt(parts[8]),
    turnoverPct: round2(num(38)),
    peTtm: round2(num(39)),
    amplitudePct: round2(num(43)),
    circCapYi: round2(num(44)),
    totalCapYi: round2(num(45)),
    limitUp: round2(num(47)),
    limitDown: round2(num(48)),
    volumeRatio: round2(num(49)),
    weibi,
    weicha,
    orderbookDepth: 5,
    bids,
    asks,
    bids6to10: null,
    asks6to10: null,
    sourceTier: 'free',
    sourceLabel: '腾讯实时五档（免费默认）',
  };
}

async function fetchFreeEastmoneyTicks(secid, limit = 24) {
  try {
    const url = `https://push2.eastmoney.com/api/qt/stock/details/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55&pos=-${Math.min(limit, 40)}&secid=${encodeURIComponent(secid)}`;
    const json = await fetchJsonWithTimeout(url, { headers: DEFAULT_HEADERS }, 6000);
    const details = json?.data?.details || [];
    return details
      .map((line) => {
        const [time, priceStr, volStr, ordersStr, sideStr] = String(line || '').split(',');
        const price = round2(priceStr);
        const volume = toNullableInt(volStr);
        const orders = toNullableInt(ordersStr);
        const sideCode = toNullableInt(sideStr);
        const side = sideCode === 2 ? 'buy' : sideCode === 1 ? 'sell' : 'neutral';
        const amountWan = price != null && volume != null ? round2((price * volume * 100) / 10000) : null;
        return { time, price, volume, orders, side, amountWan, isBigOrder: amountWan != null ? amountWan >= 100 : false };
      })
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 生产路径：A 股实时快照报价路由（支持 WebSocket 优先 + 自定义 HTTP + 回退免费源）
 */
async function routeCnQuotesBatch(cnSecids, defaultFetcher) {
  const cfg = loadRawDataSourceConfig();
  const qCfg = cfg.cn_quotes;
  const list = (cnSecids || []).filter(isCnSecid);
  const resultMap = new Map();

  if (qCfg.mode === 'custom' && list.length > 0 && (qCfg.wsUrl || qCfg.quotePath || qCfg.preset === 'tushare_pro')) {
    const headers = buildAuthHeaders(qCfg);
    let anyErr = null;

    // 优先使用 WebSocket 实时订阅缓存/即时帧
    if (qCfg.wsUrl) {
      for (const secid of list) {
        try {
          const snap = await requestCnWsSnapshot(qCfg, secid, 1200);
          if (snap?.quote) resultMap.set(secid, snap.quote);
        } catch (err) {
          anyErr = err.message;
        }
      }
    }

    // 未被 WS 覆盖的标的尝试自定义 HTTP quotePath
    const needHttp = list.filter((s) => !resultMap.has(s));
    if (needHttp.length > 0 && qCfg.quotePath && qCfg.baseUrl) {
      await Promise.all(
        needHttp.map(async (secid) => {
          try {
            const code = secidToCode(secid);
            const url = resolveTemplateUrl(qCfg.baseUrl, qCfg.quotePath, {
              secid,
              code,
              symbol: code,
              token: qCfg.apiKey || '',
            });
            const raw = await fetchJsonWithTimeout(url, { headers }, qCfg.timeoutMs || 6500, [qCfg.apiKey]);
            const d = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
            const norm = normalizeCustomQuoteNode(secid, d, 'custom');
            if (norm) resultMap.set(secid, norm);
          } catch (err) {
            anyErr = err.message;
          }
        })
      );
    }

    const missing = list.filter((s) => !resultMap.has(s));
    if (missing.length === 0) {
      return { map: resultMap, sourceTier: 'custom', fallbackError: null };
    }
    if (!qCfg.fallbackOnError) {
      return { map: resultMap, sourceTier: 'custom', fallbackError: anyErr ? redactSecrets(anyErr, [qCfg.apiKey]) : null };
    }
    const fbMap = await defaultFetcher(missing).catch(() => new Map());
    for (const [k, v] of fbMap.entries()) {
      if (!resultMap.has(k)) resultMap.set(k, v);
    }
    return { map: resultMap, sourceTier: resultMap.size > fbMap.size ? 'mixed' : 'free', fallbackError: anyErr ? redactSecrets(anyErr, [qCfg.apiKey]) : null };
  }

  const defMap = await defaultFetcher(list).catch(() => new Map());
  return { map: defMap, sourceTier: 'free', fallbackError: null };
}

/**
 * 生产路径：A 股分时图路由
 */
async function routeCnIntraday(secid, defaultFetcher) {
  const cfg = loadRawDataSourceConfig();
  const qCfg = cfg.cn_quotes;
  if (isCnSecid(secid) && qCfg.mode === 'custom' && qCfg.baseUrl && qCfg.intradayPath) {
    try {
      const code = secidToCode(secid);
      const url = resolveTemplateUrl(qCfg.baseUrl, qCfg.intradayPath, {
        secid,
        code,
        symbol: code,
        token: qCfg.apiKey || '',
      });
      const raw = await fetchJsonWithTimeout(url, { headers: buildAuthHeaders(qCfg) }, qCfg.timeoutMs || 6500, [qCfg.apiKey]);
      const parsed = parseCustomIntradayPayload(raw);
      if (parsed) {
        return {
          ...parsed,
          sourceTier: 'custom',
          wsUrl: safeClientWsUrl(qCfg),
        };
      }
      throw new Error('自定义分时接口未返回 points 数组');
    } catch (err) {
      if (!qCfg.fallbackOnError) {
        return { available: false, barCount: 0, preClose: null, tradeDate: '', points: [], sourceTier: 'custom', fallbackError: redactSecrets(err.message, [qCfg.apiKey]) };
      }
    }
  }
  const defRes = await defaultFetcher();
  return { ...defRes, sourceTier: 'free', wsUrl: safeClientWsUrl(qCfg) };
}

/**
 * 生产路径：A 股多周期 K 线路由（支持自定义 klinePath 与 Tushare Pro 日线，缺失量额严格保留 null）
 */
async function routeCnKlines(secid, timeframe, defaultFetcher) {
  const cfg = loadRawDataSourceConfig();
  const qCfg = cfg.cn_quotes;
  if (isCnSecid(secid) && qCfg.mode === 'custom') {
    const code = secidToCode(secid);
    const headers = buildAuthHeaders(qCfg);
    let customAttempted = false;
    try {
      if (qCfg.klinePath && qCfg.baseUrl) {
        customAttempted = true;
        const url = resolveTemplateUrl(qCfg.baseUrl, qCfg.klinePath, {
          secid,
          code,
          symbol: code,
          tf: timeframe,
          timeframe,
          token: qCfg.apiKey || '',
        });
        const raw = await fetchJsonWithTimeout(url, { headers }, qCfg.timeoutMs || 6500, [qCfg.apiKey]);
        const parsed = parseCustomKlinesPayload(raw);
        if (!parsed) throw new Error('自定义 K 线接口未返回数组');
        return parsed;
      } else if (qCfg.preset === 'tushare_pro' && qCfg.apiKey && timeframe === 'day') {
        customAttempted = true;
        const tsUrl = qCfg.baseUrl || 'https://api.tushare.pro';
        const raw = await fetchJsonWithTimeout(
          tsUrl,
          {
            method: 'POST',
            headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_name: 'daily',
              token: qCfg.apiKey,
              params: { ts_code: secidToTsCode(secid), limit: 300 },
              fields: 'trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount',
            }),
          },
          qCfg.timeoutMs || 8000,
          [qCfg.apiKey]
        );
        if (raw?.code !== 0 || !raw?.data?.items) {
          throw new Error(raw?.msg || 'Tushare daily 响应异常');
        }
        const f = raw.data.fields || [];
        const idx = (name) => f.indexOf(name);
        return raw.data.items
          .map((row) => {
            const dRaw = String(row[idx('trade_date')] || '');
            const date = dRaw.length === 8 ? `${dRaw.slice(0, 4)}-${dRaw.slice(4, 6)}-${dRaw.slice(6, 8)}` : dRaw;
            const open = round2(row[idx('open')]);
            const high = round2(row[idx('high')]);
            const low = round2(row[idx('low')]);
            const close = round2(row[idx('close')]);
            const preClose = round2(row[idx('pre_close')]);
            const vol = toNullableNum(row[idx('vol')]);
            const amt = toNullableNum(row[idx('amount')]);
            return {
              date,
              open,
              close,
              high,
              low,
              vol: vol != null ? vol * 100 : null,
              amt: amt != null ? amt * 1000 : null,
              ampPct: preClose && high != null && low != null ? round2(((high - low) / preClose) * 100) : null,
              pct: round2(row[idx('pct_chg')]),
              chg: round2(row[idx('change')]),
              turnoverPct: null,
            };
          })
          .reverse();
      }
    } catch {
      if (customAttempted && !qCfg.fallbackOnError) {
        return [];
      }
    }
  }
  return defaultFetcher();
}

async function fetchStockOrderBookAndTicks(secid) {
  const cfg = loadRawDataSourceConfig();
  const qCfg = cfg.cn_quotes;
  const code = secidToCode(secid);

  // WS 模式下不做 4s HTTP 缓存以免吞掉最新实时帧
  const cacheKey = `ob_${secid}`;
  if (!(qCfg.mode === 'custom' && qCfg.wsUrl)) {
    const hit = getCached(cacheKey, 4000);
    if (hit) return hit;
  }

  let customOb = null;
  let customTicks = null;
  let customTicksValidEmpty = false;
  let customError = null;

  if (qCfg.mode === 'custom') {
    const headers = buildAuthHeaders(qCfg);

    // 1) 若配置了 wsUrl，优先从 WebSocket 实时订阅获取盘口/逐笔
    if (qCfg.wsUrl) {
      try {
        const wsSnap = await requestCnWsSnapshot(qCfg, secid, 1400);
        if (wsSnap?.orderbook) customOb = wsSnap.orderbook;
        if (wsSnap?.ticks) customTicks = wsSnap.ticks;
      } catch (err) {
        customError = redactSecrets(err.message, [qCfg.apiKey]);
      }
    }

    // 2) HTTP 自定义盘口
    if (!customOb && qCfg.baseUrl && qCfg.orderbookPath) {
      try {
        const url = resolveTemplateUrl(qCfg.baseUrl, qCfg.orderbookPath, {
          secid,
          code,
          symbol: code,
          token: qCfg.apiKey || '',
        });
        const raw = await fetchJsonWithTimeout(url, { headers }, qCfg.timeoutMs || 6500, [qCfg.apiKey]);
        const data = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
        const ob = normalizeCustomOrderBookNode(secid, data, qCfg.preset, 'custom');
        if (ob) customOb = ob;
        else customError = '自定义盘口响应缺少 bids/asks 数组';
      } catch (err) {
        customError = redactSecrets(err.message, [qCfg.apiKey]);
      }
    }

    // 3) HTTP 自定义逐笔
    if (customTicks == null && qCfg.baseUrl && qCfg.tickPath) {
      try {
        const url = resolveTemplateUrl(qCfg.baseUrl, qCfg.tickPath, {
          secid,
          code,
          symbol: code,
          token: qCfg.apiKey || '',
        });
        const raw = await fetchJsonWithTimeout(url, { headers }, qCfg.timeoutMs || 6500, [qCfg.apiKey]);
        const list = Array.isArray(raw) ? raw : Array.isArray(raw?.ticks) ? raw.ticks : Array.isArray(raw?.data) ? raw.data : null;
        if (Array.isArray(list)) {
          customTicks = list.slice(0, 50).map(normalizeCustomTick);
          if (list.length === 0) customTicksValidEmpty = true;
        }
      } catch (err) {
        customError = customError || redactSecrets(err.message, [qCfg.apiKey]);
      }
    }
  }

  let baseOb = customOb;
  if (!baseOb && (qCfg.mode !== 'custom' || qCfg.fallbackOnError)) {
    baseOb = await fetchFreeTencentOrderBook(secid).catch(() => null);
  }
  const hasCustomTickSrc = Boolean(qCfg.mode === 'custom' && (qCfg.tickPath || qCfg.wsUrl));
  const allowFreeTicks = customTicks == null && !customTicksValidEmpty && (!hasCustomTickSrc || qCfg.fallbackOnError);
  const freeTicks = allowFreeTicks ? await fetchFreeEastmoneyTicks(secid, 28) : null;
  const ticks = customTicks ?? freeTicks ?? [];

  const [sealFlow, chips] = await Promise.all([fetchSealFlowIntraday(secid), fetchShortTermChips(secid)]);

  const payload = {
    ok: Boolean(baseOb),
    secid,
    fetchedAt: nowOffsetISO(),
    orderbook: baseOb,
    ticks,
    tickSourceTier: customTicks != null ? 'custom_l2' : allowFreeTicks ? 'free_3s_snapshot' : 'unavailable',
    tickSourceLabel: customTicks != null ? '自定义 L2 逐笔源' : allowFreeTicks ? '东财 3 秒分笔快照（免费）' : '自定义逐笔源未返回数据',
    sealFlow,
    chips,
    wsUrl: safeClientWsUrl(qCfg),
    fallbackError: customError ? redactSecrets(customError, [qCfg.apiKey]) : null,
    slots: {
      l2Orderbook10: {
        available: Boolean(baseOb?.bids6to10 || baseOb?.asks6to10),
        channel: 'cn_quotes',
        label: '十档盘口 (买6-10 / 卖6-10) · 待接入付费源',
      },
      l2BigOrderTicks: {
        available: customTicks != null,
        channel: 'cn_quotes',
        label: 'L2 逐笔大单拆单检测 · 待接入付费源',
      },
      sealFlowIntraday: sealFlow.slot,
      chipsDistribution: chips.slot,
    },
  };

  return qCfg.mode === 'custom' && qCfg.wsUrl ? payload : setCached(cacheKey, payload);
}

// ============================================================================
// 3. 通道 2：短线特色数据（精灵 / 封单分时 / 竞价 / 龙虎榜 / 筹码）
// ============================================================================

function parseSealFlowPayload(raw, stCfg) {
  if (!raw || typeof raw !== 'object' || raw.ok === false || raw.error) return null;
  const series = getByJsonPath(raw, stCfg?.jsonPaths?.sealSeries || 'series') ?? raw?.series ?? raw?.data;
  if (!Array.isArray(series)) return null;
  const validPoints = series
    .map((pt) => ({
      t: String(pt?.t || pt?.time || '').trim(),
      sealYi: round2(pt?.sealYi ?? pt?.amountYi ?? pt?.value),
    }))
    .filter((pt) => pt.t && pt.sealYi != null);
  return validPoints;
}

async function fetchSealFlowIntraday(secid) {
  const cfg = loadRawDataSourceConfig();
  const stCfg = cfg.cn_short_term;
  if (stCfg.mode === 'custom' && stCfg.baseUrl && stCfg.sealFlowPath) {
    try {
      const url = resolveTemplateUrl(stCfg.baseUrl, stCfg.sealFlowPath, {
        secid,
        code: secidToCode(secid),
        token: stCfg.apiKey || '',
      });
      const raw = await fetchJsonWithTimeout(url, { headers: buildAuthHeaders(stCfg) }, stCfg.timeoutMs || 6500, [stCfg.apiKey]);
      const validPoints = parseSealFlowPayload(raw, stCfg);
      if (validPoints && validPoints.length > 0) {
        return {
          available: true,
          series: validPoints,
          slot: { available: true, channel: 'cn_short_term', label: '封单金额分时（自定义源）' },
        };
      }
    } catch {
      // fall through to unavailable slot
    }
  }
  return {
    available: false,
    series: null,
    slot: {
      available: false,
      channel: 'cn_short_term',
      label: '封单金额分时曲线 · 待接入付费源',
    },
  };
}

function parseChipsPayload(raw, stCfg) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.ok === false || raw.error) return null;
  const node = getByJsonPath(raw, stCfg?.jsonPaths?.chipData || 'data') ?? raw;
  if (!node || typeof node !== 'object' || Array.isArray(node) || node.ok === false || node.error) return null;
  const profitRatioPct = round2(node.profitRatioPct ?? node.profitRatio);
  const avgCost = round2(node.avgCost);
  const concentration90Pct = round2(node.concentration90Pct ?? node.concentration90);
  const bins = Array.isArray(node.bins) && node.bins.length > 0 ? node.bins : null;
  if (profitRatioPct == null && avgCost == null && concentration90Pct == null && !bins) {
    return null;
  }
  return { profitRatioPct, avgCost, concentration90Pct, bins };
}

async function fetchShortTermChips(secid) {
  const cfg = loadRawDataSourceConfig();
  const stCfg = cfg.cn_short_term;
  if (stCfg.mode === 'custom' && stCfg.baseUrl && stCfg.chipPath) {
    try {
      const url = resolveTemplateUrl(stCfg.baseUrl, stCfg.chipPath, {
        secid,
        code: secidToCode(secid),
        token: stCfg.apiKey || '',
      });
      const raw = await fetchJsonWithTimeout(url, { headers: buildAuthHeaders(stCfg) }, stCfg.timeoutMs || 6500, [stCfg.apiKey]);
      const data = parseChipsPayload(raw, stCfg);
      if (data) {
        return {
          available: true,
          sourceTier: 'custom',
          data,
          slot: { available: true, channel: 'cn_short_term', label: '筹码分布（自定义源）' },
        };
      }
    } catch {
      // unavailable
    }
  }
  return {
    available: false,
    sourceTier: 'unavailable',
    data: null,
    slot: {
      available: false,
      channel: 'cn_short_term',
      label: '筹码分布与获利盘 · 待接入付费源',
    },
  };
}

async function routeShortTermSprite(defaultFetcher, pageSize = 40, sideFilter = 'all') {
  const cfg = loadRawDataSourceConfig();
  const stCfg = cfg.cn_short_term;
  if (stCfg.mode === 'custom' && stCfg.baseUrl && stCfg.spritePath) {
    try {
      const url = resolveTemplateUrl(stCfg.baseUrl, stCfg.spritePath, {
        side: sideFilter,
        limit: pageSize,
        token: stCfg.apiKey || '',
      });
      const raw = await fetchJsonWithTimeout(url, { headers: buildAuthHeaders(stCfg) }, stCfg.timeoutMs || 6500, [stCfg.apiKey]);
      const arr = getByJsonPath(raw, stCfg.jsonPaths?.spriteItems || 'items') ?? raw?.items ?? raw?.data;
      if (Array.isArray(arr)) {
        const items = arr.slice(0, pageSize).map((r, i) => ({
          id: String(r.id || `csp-${i}-${Date.now()}`),
          time: String(r.time || '--:--:--'),
          code: String(r.code || ''),
          secid: String(r.secid || (String(r.code || '').startsWith('6') ? `1.${r.code}` : `0.${r.code}`)),
          name: String(r.name || r.code || ''),
          typeCode: toNullableInt(r.typeCode) ?? 0,
          typeLabel: String(r.typeLabel || r.signal || '异动'),
          typeLabelEn: String(r.typeLabelEn || r.typeLabel || 'Signal'),
          side: r.side === 'bear' ? 'bear' : 'bull',
          infoRaw: String(r.infoRaw || ''),
          price: round2(r.price),
          pct: round2(r.pct),
        }));
        return {
          ok: true,
          sourceTier: 'custom',
          totalCount: items.length,
          fetchedAt: nowOffsetISO(),
          items,
        };
      }
      throw new Error('自定义短线精灵未返回有效数组');
    } catch (err) {
      if (!stCfg.fallbackOnError) {
        return {
          ok: false,
          sourceTier: 'custom',
          totalCount: 0,
          fetchedAt: nowOffsetISO(),
          items: [],
          fallbackError: redactSecrets(err.message, [stCfg.apiKey]),
        };
      }
    }
  }
  const defRes = await defaultFetcher(pageSize, sideFilter);
  return { ...defRes, sourceTier: 'free' };
}

async function routeShortTermAuction(defaultFetcher) {
  const cfg = loadRawDataSourceConfig();
  const stCfg = cfg.cn_short_term;
  if (stCfg.mode === 'custom' && stCfg.baseUrl && stCfg.auctionPath) {
    try {
      const url = resolveTemplateUrl(stCfg.baseUrl, stCfg.auctionPath, { token: stCfg.apiKey || '' });
      const raw = await fetchJsonWithTimeout(url, { headers: buildAuthHeaders(stCfg) }, stCfg.timeoutMs || 6500, [stCfg.apiKey]);
      const customItems = getByJsonPath(raw, stCfg.jsonPaths?.auctionItems || 'items') ?? raw?.items ?? raw?.openMovers ?? raw?.auctionSeals;
      if (Array.isArray(customItems) || Array.isArray(raw?.topSealAmount) || Array.isArray(raw?.topSealRatio)) {
        const normItem = (s) => ({
          secid: String(s.secid || (String(s.code || '').startsWith('6') ? `1.${s.code}` : `0.${s.code}`)),
          code: String(s.code || ''),
          name: String(s.name || s.code || ''),
          price: round2(s.price),
          pct: round2(s.pct),
          lbc: toNullableInt(s.lbc),
          sealFundYi: round2(s.sealFundYi ?? s.sealYi),
          floatCapYi: round2(s.floatCapYi),
          sealRatioPct: round2(s.sealRatioPct),
          openGapPct: round2(s.openGapPct),
          volumeRatio: round2(s.volumeRatio),
          amountYi: round2(s.amountYi),
          mainNetYi: round2(s.mainNetYi),
          turnoverPct: round2(s.turnoverPct),
          firstSealTime: s.firstSealTime ? String(s.firstSealTime) : null,
          isAuctionSeal: Boolean(s.isAuctionSeal),
          industry: String(s.industry || ''),
        });
        const list = Array.isArray(customItems) ? customItems.map(normItem) : [];
        // 严格按各自口径筛选有效值并降序取前十，无有效指标时返回空榜，绝不把未排序通用列表冒充封单榜
        const topSealAmount = Array.isArray(raw?.topSealAmount)
          ? raw.topSealAmount.map(normItem)
          : list
              .filter((x) => x.sealFundYi != null)
              .sort((a, b) => b.sealFundYi - a.sealFundYi)
              .slice(0, 10);
        const topSealRatio = Array.isArray(raw?.topSealRatio)
          ? raw.topSealRatio.map(normItem)
          : list
              .filter((x) => x.sealRatioPct != null)
              .sort((a, b) => b.sealRatioPct - a.sealRatioPct)
              .slice(0, 10);
        return {
          ok: true,
          sourceTier: 'custom',
          fetchedAt: nowOffsetISO(),
          topSealAmount,
          topSealRatio,
          auctionSeals: Array.isArray(raw?.auctionSeals) ? raw.auctionSeals.map(normItem) : list.filter((x) => x.isAuctionSeal),
          openMovers: Array.isArray(raw?.openMovers) ? raw.openMovers.map(normItem) : list,
        };
      }
      throw new Error('自定义竞价接口未返回有效数组');
    } catch (err) {
      if (!stCfg.fallbackOnError) {
        return {
          ok: false,
          sourceTier: 'custom',
          fetchedAt: nowOffsetISO(),
          topSealAmount: [],
          topSealRatio: [],
          auctionSeals: [],
          openMovers: [],
          fallbackError: redactSecrets(err.message, [stCfg.apiKey]),
        };
      }
    }
  }
  const defRes = await defaultFetcher();
  return { ...defRes, sourceTier: 'free' };
}

async function routeShortTermLhb(defaultFetcher, daysBack = 14) {
  const cfg = loadRawDataSourceConfig();
  const stCfg = cfg.cn_short_term;
  if (stCfg.mode === 'custom' && stCfg.baseUrl && stCfg.lhbPath) {
    try {
      const url = resolveTemplateUrl(stCfg.baseUrl, stCfg.lhbPath, {
        days: daysBack,
        token: stCfg.apiKey || '',
      });
      const raw = await fetchJsonWithTimeout(url, { headers: buildAuthHeaders(stCfg) }, stCfg.timeoutMs || 6500, [stCfg.apiKey]);
      const list = getByJsonPath(raw, stCfg.jsonPaths?.lhbItems || 'items') ?? raw?.items ?? raw?.data;
      if (Array.isArray(list)) {
        const items = list.map((r) => ({
          secid: String(r.secid || (String(r.code || '').startsWith('6') ? `1.${r.code}` : `0.${r.code}`)),
          code: String(r.code || ''),
          name: String(r.name || r.code || ''),
          date: String(r.date || nowOffsetISO().slice(0, 10)),
          price: round2(r.price),
          pct: round2(r.pct),
          turnoverPct: round2(r.turnoverPct),
          buyYi: round2(r.buyYi),
          sellYi: round2(r.sellYi),
          netYi: round2(r.netYi),
          reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : r.reason ? [String(r.reason)] : [],
          isThreeDay: Boolean(r.isThreeDay),
          tags: Array.isArray(r.tags) ? r.tags.map(String) : ['自定义龙虎榜'],
          seats: Array.isArray(r.seats) ? r.seats : null,
        }));
        return {
          ok: true,
          sourceTier: 'custom',
          fetchedAt: nowOffsetISO(),
          latestDate: String(raw?.latestDate || items[0]?.date || ''),
          trend: Array.isArray(raw?.trend) ? raw.trend : [],
          items,
        };
      }
      throw new Error('自定义龙虎榜接口未返回有效数组');
    } catch (err) {
      if (!stCfg.fallbackOnError) {
        return {
          ok: false,
          sourceTier: 'custom',
          fetchedAt: nowOffsetISO(),
          latestDate: '',
          trend: [],
          items: [],
          fallbackError: redactSecrets(err.message, [stCfg.apiKey]),
        };
      }
    }
  }
  const defRes = await defaultFetcher(daysBack);
  return { ...defRes, sourceTier: 'free' };
}

// ============================================================================
// 4. 通道 3：短线新闻与舆情流（业务与连接测试共用映射与校验逻辑）
// ============================================================================

function parseMappedNewsItems(raw, nf, isCommunity = false) {
  if (!raw || typeof raw !== 'object' || raw.ok === false || raw.error) {
    throw new Error(String(raw?.error || raw?.message || '上游返回业务错误'));
  }
  const fm = nf?.fieldMap || {};
  const list = isCommunity
    ? Array.isArray(raw)
      ? raw
      : raw?.items ?? raw?.data
    : Array.isArray(raw)
    ? raw
    : getByJsonPath(raw, fm.itemsPath || 'items') ?? raw?.data;

  if (!Array.isArray(list)) {
    throw new Error(`路径 "${isCommunity ? 'items' : fm.itemsPath || 'items'}" 未解析出数组`);
  }
  if (list.length === 0) {
    return { status: 'empty', items: [] };
  }

  const mapped = [];
  for (const row of list.slice(0, isCommunity ? 30 : 40)) {
    const rawItem = isCommunity
      ? row
      : {
          id: row?.id,
          title: getByJsonPath(row, fm.titleField || 'title'),
          content: getByJsonPath(row, fm.contentField || 'content'),
          time: getByJsonPath(row, fm.timeField || 'time'),
          timestamp: row?.timestamp,
          publishedAt: row?.publishedAt,
          source: getByJsonPath(row, fm.sourceField || 'source') || '自定义电报源',
          url: getByJsonPath(row, fm.urlField || 'url'),
          important: Boolean(getByJsonPath(row, fm.importantField || 'important')),
        };
    const item = normalizeFeedItem(
      rawItem,
      isCommunity ? row?.source || '自定义社区深度流' : '自定义电报源',
      isCommunity ? 'community' : 'custom_poll'
    );
    if (item) mapped.push(isCommunity ? { ...item, isCommunity: true } : item);
  }

  // 非空列表全部无法映射标题或正文 -> 明确判定为字段映射失败，触发错误与回退！
  if (mapped.length === 0) {
    throw new Error(`列表含 ${list.length} 条记录但全部无法映射出 title/content，请检查 fieldMap 字段配置`);
  }
  return { status: 'ok', items: mapped };
}

async function fetchCustomPulledNews() {
  const cfg = loadRawDataSourceConfig();
  const nf = cfg.news_feeds;
  const ttlMs = Math.max(10, Math.min(300, Number(nf.pollIntervalSec) || 30)) * 1000;
  const cacheKey = `custom_news_pull:${nf.mode}:${nf.pollUrl || ''}:${nf.communityUrl || ''}:${ttlMs}`;
  const hit = getCached(cacheKey, ttlMs);
  if (hit) return hit;

  const out = {
    liveStatus: nf.mode === 'custom' && nf.pollUrl ? 'pending' : 'default',
    communityStatus: nf.mode === 'custom' && nf.communityUrl ? 'pending' : 'default',
    customLive: [],
    customCommunity: [],
    error: null,
  };

  if (nf.mode === 'custom' && nf.pollUrl) {
    try {
      const raw = await fetchJsonWithTimeout(nf.pollUrl, { headers: buildAuthHeaders(nf) }, nf.timeoutMs || 6500, [nf.apiKey]);
      const parsed = parseMappedNewsItems(raw, nf, false);
      out.customLive = parsed.items;
      out.liveStatus = parsed.status;
    } catch (err) {
      out.liveStatus = 'error';
      out.error = redactSecrets(err.message, [nf.apiKey]);
    }
  }

  if (nf.mode === 'custom' && nf.communityUrl) {
    try {
      const raw = await fetchJsonWithTimeout(nf.communityUrl, { headers: buildAuthHeaders(nf) }, nf.timeoutMs || 6500, [nf.apiKey]);
      const parsed = parseMappedNewsItems(raw, nf, true);
      out.customCommunity = parsed.items;
      out.communityStatus = parsed.status;
    } catch (err) {
      out.communityStatus = 'error';
      out.error = out.error || redactSecrets(err.message, [nf.apiKey]);
    }
  }

  return setCached(cacheKey, out);
}

async function mergeRoutedNewsFeeds(defaultLiveNewsOrFn = [], defaultCatalystsOrFn = [], rssFetcher = null) {
  const cfg = loadRawDataSourceConfig();
  const nf = cfg.news_feeds;
  const webhookItems = nf.webhookEnabled !== false ? loadIngestedFeeds() : [];
  const pulled = await fetchCustomPulledNews();

  const needDefaultLive =
    pulled.liveStatus === 'default' || (pulled.liveStatus === 'error' && nf.fallbackOnError !== false);
  const needDefaultCommunity =
    pulled.communityStatus === 'default' || (pulled.communityStatus === 'error' && nf.fallbackOnError !== false);

  let defaultLive = [];
  if (needDefaultLive) {
    defaultLive = typeof defaultLiveNewsOrFn === 'function' ? await defaultLiveNewsOrFn() : defaultLiveNewsOrFn || [];
    if (typeof rssFetcher === 'function') {
      const rssItems = await rssFetcher().catch(() => []);
      if (Array.isArray(rssItems) && rssItems.length > 0) {
        defaultLive = [...defaultLive, ...rssItems];
      }
    }
  }

  let defaultCatalysts = [];
  if (needDefaultCommunity) {
    defaultCatalysts =
      typeof defaultCatalystsOrFn === 'function' ? await defaultCatalystsOrFn() : defaultCatalystsOrFn || [];
  }

  const webhookLive = webhookItems.filter((x) => !x.isCommunity);
  const webhookCommunity = webhookItems.filter((x) => x.isCommunity);

  const liveNews = [...webhookLive, ...pulled.customLive, ...defaultLive]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 60);

  const communityPosts = [...webhookCommunity, ...pulled.customCommunity].sort(
    (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
  );
  const catalysts = [...communityPosts, ...defaultCatalysts].slice(0, 30);

  return {
    liveNews,
    companyCatalysts: catalysts,
    webhookCount: webhookItems.length,
    customPollCount: pulled.customLive.length,
    sourceTier: pulled.liveStatus === 'ok' || pulled.liveStatus === 'empty' ? 'custom' : needDefaultLive ? 'free' : 'custom_error',
    fallbackError: pulled.error,
    communitySlot: {
      available: communityPosts.length > 0 || (nf.mode === 'custom' && Boolean(nf.communityUrl) && pulled.communityStatus !== 'error'),
      channel: 'news_feeds',
      webhookCount: webhookItems.length,
      label:
        communityPosts.length > 0
          ? `已接入 ${communityPosts.length} 条社区/Webhook 深度全文`
          : '合规深度简报/快讯全文 · 待接入自定义源或 Webhook 推送',
    },
  };
}

// ============================================================================
// 5. 通道 4：海外股市与全球期货生产级适配器（扩展资产适配器动态插件化）
// ============================================================================

function resolveCryptoAdapterSpec(gc) {
  const ext = getMarketExtension('crypto');
  if (!ext) return { exchange: 'disabled', host: '' };
  return ext.resolveCryptoAdapterSpec(gc);
}

function buildGlobalCustomQuoteUrl(base, secid, sym, apiKey) {
  if (base.includes('{symbol}') || base.includes('{secid}') || base.includes('{code}')) {
    return resolveTemplateUrl(base, base, { secid, symbol: sym, code: sym, token: apiKey || '' });
  }
  return `${base}/quote?secid=${encodeURIComponent(secid)}&symbol=${encodeURIComponent(sym)}`;
}

async function routeCryptoTickers(pairs, defaultFetcher) {
  const ext = getMarketExtension('crypto');
  if (!ext) return new Map();
  const cfg = loadRawDataSourceConfig();
  const gc = cfg.global_markets || {};
  return ext.routeCryptoTickersWithConfig(pairs, gc, defaultFetcher, {
    fetchJsonWithTimeout,
    buildAuthHeaders,
    resolveTemplateUrl,
  });
}

async function routeGlobalEquityQuotes(items, defaultFetcher) {
  const cfg = loadRawDataSourceConfig();
  const gc = cfg.global_markets || {};
  const list = Array.isArray(items) ? items : [];
  const globalCompat = validateGlobalMarketsForEdition(gc, { fromLegacyKey: false, requireConfirmedInCn: true });
  if (
    gc.mode === 'custom' &&
    globalCompat.compatible &&
    list.length > 0 &&
    ['finnhub', 'polygon', 'alpha_vantage', 'custom_global'].includes(gc.preset)
  ) {
    const headers = buildAuthHeaders(gc);
    const timeout = gc.timeoutMs || 6500;
    const base = gc.proxyUrl || gc.baseUrl || '';
    const map = new Map();
    const targetItems = list.filter((it) => it.marketKind === 'US' || gc.preset === 'custom_global').slice(0, 18);

    await Promise.all(
      targetItems.map(async (it) => {
        try {
          const sym = String(it.code || secidToCode(it.secid)).toUpperCase();
          if (gc.preset === 'finnhub' && gc.apiKey) {
            const host = base || 'https://finnhub.io/api/v1';
            const d = await fetchJsonWithTimeout(
              `${host}/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(gc.apiKey)}`,
              { headers },
              timeout,
              [gc.apiKey]
            );
            if (d?.error || toNullableNum(d?.c) == null || Number(d.c) <= 0) return;
            map.set(it.secid, {
              price: round2(d.c),
              chg: round2(d.d),
              pct: round2(d.dp),
              high: round2(d.h),
              low: round2(d.l),
              open: round2(d.o),
              preClose: round2(d.pc),
              volume: null,
              sourceTier: 'custom',
            });
          } else if (gc.preset === 'polygon' && gc.apiKey) {
            const host = base || 'https://api.polygon.io';
            let snap = null;
            try {
              snap = await fetchJsonWithTimeout(
                `${host}/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}?apiKey=${encodeURIComponent(gc.apiKey)}`,
                { headers },
                timeout,
                [gc.apiKey]
              );
            } catch {
              snap = null;
            }
            const tkr = snap?.ticker;
            const snapPrevClose = toNullableNum(tkr?.prevDay?.c);
            const snapPrice = toNullableNum(tkr?.lastTrade?.p ?? tkr?.day?.c ?? tkr?.min?.c);
            if (snapPrevClose != null && snapPrice != null && snapPrice > 0) {
              const chg = toNullableNum(tkr?.todaysChange) ?? round2(snapPrice - snapPrevClose);
              const pct =
                toNullableNum(tkr?.todaysChangePerc) ??
                (snapPrevClose > 0 ? round2(((snapPrice - snapPrevClose) / snapPrevClose) * 100) : null);
              map.set(it.secid, {
                price: round2(snapPrice),
                close: round2(snapPrice),
                open: round2(tkr?.day?.o),
                high: round2(tkr?.day?.h),
                low: round2(tkr?.day?.l),
                preClose: round2(snapPrevClose),
                chg: round2(chg),
                pct: round2(pct),
                volume: toNullableNum(tkr?.day?.v),
                sourceTier: 'custom',
              });
            } else {
              const d = Array.isArray(snap?.results)
                ? snap
                : await fetchJsonWithTimeout(
                    `${host}/v2/aggs/ticker/${encodeURIComponent(sym)}/prev?apiKey=${encodeURIComponent(gc.apiKey)}`,
                    { headers },
                    timeout,
                    [gc.apiKey]
                  );
              const r = Array.isArray(d?.results) ? d.results[0] : null;
              if (!r || toNullableNum(r.c) == null) return;
              const closePrice = round2(r.c);
              const openPrice = round2(r.o);
              const barDate =
                typeof r.t === 'number' && Number.isFinite(r.t)
                  ? new Date(r.t).toISOString().slice(0, 10)
                  : typeof r.date === 'string'
                  ? r.date.slice(0, 10)
                  : null;
              map.set(it.secid, {
                price: closePrice,
                close: closePrice,
                open: openPrice,
                high: round2(r.h),
                low: round2(r.l),
                barDate,
                preClose: null,
                chg: null,
                pct: null,
                volume: toNullableNum(r.v),
                quoteNote:
                  '当前 Polygon /prev 仅提供上一交易日聚合日线（不含前一日昨收），昨收及涨跌字段已返回 null；如需真实昨收与涨跌口径，请配置 Finnhub / Alpha Vantage 或开启 Polygon Snapshot 权限。',
                sourceTier: 'custom',
              });
            }
          } else if (gc.preset === 'alpha_vantage' && gc.apiKey) {
            const host = base || 'https://www.alphavantage.co';
            const d = await fetchJsonWithTimeout(
              `${host}/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(gc.apiKey)}`,
              { headers },
              timeout,
              [gc.apiKey]
            );
            const gq = d?.['Global Quote'];
            if (!gq || toNullableNum(gq['05. price']) == null) return;
            map.set(it.secid, {
              price: round2(gq['05. price']),
              open: round2(gq['02. open']),
              high: round2(gq['03. high']),
              low: round2(gq['04. low']),
              preClose: round2(gq['08. previous close']),
              chg: round2(gq['09. change']),
              pct: round2(String(gq['10. change percent'] || '').replace('%', '')),
              volume: toNullableNum(gq['06. volume']),
              sourceTier: 'custom',
            });
          } else if (gc.preset === 'custom_global' && base) {
            const url = buildGlobalCustomQuoteUrl(base, it.secid, sym, gc.apiKey);
            const raw = await fetchJsonWithTimeout(url, { headers }, timeout, [gc.apiKey]);
            const d = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
            if (d && toNullableNum(d.price ?? d.last ?? d.c) != null) {
              map.set(it.secid, {
                price: round2(d.price ?? d.last ?? d.c),
                open: round2(d.open ?? d.o),
                high: round2(d.high ?? d.h),
                low: round2(d.low ?? d.l),
                preClose: round2(d.preClose ?? d.pc),
                chg: round2(d.chg ?? d.d),
                pct: round2(d.pct ?? d.dp),
                volume: toNullableNum(d.volume ?? d.v),
                sourceTier: 'custom',
              });
            }
          }
        } catch {
          // handled below via fallbackOnError
        }
      })
    );

    const missing = list.filter((it) => !map.has(it.secid));
    if (missing.length === 0) return map;
    if (!gc.fallbackOnError) return map;
    const fbMap = await defaultFetcher(missing).catch(() => new Map());
    for (const [k, v] of fbMap.entries()) {
      if (!map.has(k)) map.set(k, v);
    }
    return map;
  }

  return defaultFetcher(list);
}

// ============================================================================
// 6. 通道连通性实测（逐项探测所有已配置端点 + 业务共用校验器 + 严格脱敏）
// ============================================================================

async function testChannelConnection(rawChannelId, draftPatch = null) {
  const channelId = normalizeChannelId(rawChannelId);
  if (!CHANNEL_IDS.includes(channelId)) {
    return { ok: false, channel: rawChannelId, message: `未知通道: ${rawChannelId}` };
  }
  const cfg = loadRawDataSourceConfig();
  const ch = draftPatch && typeof draftPatch === 'object' ? normalizeChannelPatch(channelId, cfg[channelId], draftPatch) : cfg[channelId];
  const secretsToMask = [ch.apiKey, cfg[channelId]?.apiKey].filter(Boolean);

  const startedAt = Date.now();
  try {
    if (ch.mode === 'default') {
      if (channelId === 'cn_quotes') {
        const ob = await fetchFreeTencentOrderBook('0.300308');
        const latencyMs = Date.now() - startedAt;
        const ok = Boolean(ob && ob.last != null && ob.bids.length > 0);
        const res = {
          ok,
          channel: channelId,
          mode: 'default',
          latencyMs,
          message: ok
            ? `免费默认源连通正常：${ob.name} 现价 ${ob.last}，五档盘口完整（${latencyMs}ms）`
            : '腾讯免费五档响应为空',
        };
        recordChannelCheck(channelId, res);
        return res;
      }
      if (channelId === 'cn_short_term') {
        const json = await fetchJsonWithTimeout(
          'https://push2ex.eastmoney.com/getAllStockChanges?type=8201,8193,4&pageindex=0&pagesize=5&ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wzchanges',
          { headers: DEFAULT_HEADERS },
          6500
        );
        const latencyMs = Date.now() - startedAt;
        const count = (json?.data?.allstock || []).length;
        const res = {
          ok: true,
          channel: channelId,
          mode: 'default',
          latencyMs,
          message: `东财短线精灵免费源连通正常：返回 ${count} 条实时异动样本（${latencyMs}ms）`,
        };
        recordChannelCheck(channelId, res);
        return res;
      }
      if (channelId === 'news_feeds') {
        if (!getEditionInfo().features.allowCommunityScrapers) {
          const res = {
            ok: true,
            channel: channelId,
            mode: 'default',
            latencyMs: Date.now() - startedAt,
            message: '商业版默认关闭内置第三方社区/快讯直连，本地合规 Webhook 推送入口已就绪',
          };
          recordChannelCheck(channelId, res);
          return res;
        }
        const json = await fetchJsonWithTimeout(
          'https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=a-stock-channel&client=pc&limit=5',
          { headers: DEFAULT_HEADERS },
          6500
        );
        const latencyMs = Date.now() - startedAt;
        const count = (json?.data?.items || []).length;
        const res = {
          ok: count > 0,
          channel: channelId,
          mode: 'default',
          latencyMs,
          message: `华尔街见闻 7×24 快讯连通正常（${count} 条样本，${latencyMs}ms），本地 Webhook 推流就绪`,
        };
        recordChannelCheck(channelId, res);
        return res;
      }
      if (channelId === 'global_markets') {
        const cryptoExt = getMarketExtension('crypto');
        if (cryptoExt) {
          const probe = await cryptoExt.testDefaultCryptoProbe(fetchJsonWithTimeout, DEFAULT_HEADERS, startedAt);
          const res = {
            ok: probe.ok,
            channel: channelId,
            mode: 'default',
            preset: ch.preset,
            assetScope: 'mixed',
            latencyMs: probe.latencyMs,
            message: probe.message,
          };
          recordChannelCheck(channelId, res);
          return res;
        }
        const json = await fetchJsonWithTimeout(
          'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f12,f14&secids=101.GC00Y,105.NVDA',
          { headers: DEFAULT_HEADERS },
          6500
        );
        const latencyMs = Date.now() - startedAt;
        const sample = (json?.data?.diff || []).find((x) => x && x.f2 !== '-' && x.f2 != null);
        const res = {
          ok: Boolean(sample),
          channel: channelId,
          mode: 'default',
          preset: 'default_eastmoney_global',
          assetScope: 'equities_futures',
          latencyMs,
          message: sample
            ? `海外股市与大宗期货免费默认源连通正常：${sample.f14 || sample.f12} = ${sample.f2}（${latencyMs}ms）`
            : '东财全球行情响应为空',
        };
        recordChannelCheck(channelId, res);
        return res;
      }
    }

    // 自定义模式：按实际已配置端点构建统一探测任务，与生产请求共用解析器与校验器
    const headers = buildAuthHeaders(ch);
    const timeout = ch.timeoutMs || 6500;
    const probes = [];
    const sampleVars = { secid: '0.300308', code: '300308', symbol: '300308', tf: 'day', timeframe: 'day', side: 'all', limit: 5, days: 7, token: ch.apiKey || '' };

    if (channelId === 'cn_quotes') {
      if (ch.preset === 'tushare_pro') {
        if (!ch.apiKey) throw new Error('请先填入 Tushare Pro Token');
        probes.push({
          name: 'Tushare Pro',
          run: async () => {
            const data = await fetchJsonWithTimeout(
              ch.baseUrl || 'https://api.tushare.pro',
              {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_name: 'trade_cal', token: ch.apiKey, params: { limit: 1 }, fields: 'cal_date,is_open' }),
              },
              timeout,
              secretsToMask
            );
            if (data?.code !== 0 || !data?.data) throw new Error(data?.msg || `Tushare 返回错误码 ${data?.code}`);
            return 'Tushare 交易日历校验通过';
          },
        });
      } else {
        if (ch.wsUrl) {
          probes.push({
            name: 'WebSocket 推流',
            run: async () => {
              const snap = await requestCnWsSnapshot(ch, '0.300308', Math.min(2500, timeout));
              if (!snap?.quote && !snap?.orderbook && !snap?.ticks) throw new Error('WS 响应未包含可解析行情');
              return 'WS 实时订阅校验通过';
            },
          });
        }
        if (ch.baseUrl && ch.orderbookPath) {
          probes.push({
            name: '盘口(orderbookPath)',
            run: async () => {
              const raw = await fetchJsonWithTimeout(resolveTemplateUrl(ch.baseUrl, ch.orderbookPath, sampleVars), { headers }, timeout, secretsToMask);
              const d = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
              const ob = normalizeCustomOrderBookNode('0.300308', d, ch.preset, 'custom');
              if (!ob) throw new Error('缺少 bids/asks 数组');
              return `买${ob.bids.length + (ob.bids6to10?.length || 0)}/卖${ob.asks.length + (ob.asks6to10?.length || 0)}档`;
            },
          });
        }
        if (ch.baseUrl && ch.quotePath) {
          probes.push({
            name: '报价(quotePath)',
            run: async () => {
              const raw = await fetchJsonWithTimeout(resolveTemplateUrl(ch.baseUrl, ch.quotePath, sampleVars), { headers }, timeout, secretsToMask);
              const d = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
              if (!normalizeCustomQuoteNode('0.300308', d, 'custom')) throw new Error('缺少 last/price 报价字段');
              return '报价契约通过';
            },
          });
        }
        if (ch.baseUrl && ch.tickPath) {
          probes.push({
            name: '逐笔(tickPath)',
            run: async () => {
              const raw = await fetchJsonWithTimeout(resolveTemplateUrl(ch.baseUrl, ch.tickPath, sampleVars), { headers }, timeout, secretsToMask);
              const list = Array.isArray(raw) ? raw : Array.isArray(raw?.ticks) ? raw.ticks : Array.isArray(raw?.data) ? raw.data : null;
              if (!Array.isArray(list)) throw new Error('未返回 ticks 数组');
              return `逐笔 ${list.length} 条`;
            },
          });
        }
        if (ch.baseUrl && ch.intradayPath) {
          probes.push({
            name: '分时(intradayPath)',
            run: async () => {
              const raw = await fetchJsonWithTimeout(resolveTemplateUrl(ch.baseUrl, ch.intradayPath, sampleVars), { headers }, timeout, secretsToMask);
              const parsed = parseCustomIntradayPayload(raw);
              if (!parsed) throw new Error('未返回合法 points 数组');
              return `分时 ${parsed.barCount} 点`;
            },
          });
        }
        if (ch.baseUrl && ch.klinePath) {
          probes.push({
            name: 'K线(klinePath)',
            run: async () => {
              const raw = await fetchJsonWithTimeout(resolveTemplateUrl(ch.baseUrl, ch.klinePath, sampleVars), { headers }, timeout, secretsToMask);
              const parsed = parseCustomKlinesPayload(raw);
              if (!parsed) throw new Error('未返回合法 klines 数组');
              return `K线 ${parsed.length} 根`;
            },
          });
        }
        if (probes.length === 0) throw new Error('请先填写自定义行情 Base URL + 至少一个能力路径，或填写 WebSocket 地址');
      }
    } else if (channelId === 'cn_short_term') {
      if (!ch.baseUrl) throw new Error('请先填写短线接口 Base URL');
      if (ch.spritePath) {
        probes.push({
          name: '短线精灵',
          run: async () => {
            const raw = await fetchJsonWithTimeout(resolveTemplateUrl(ch.baseUrl, ch.spritePath, sampleVars), { headers }, timeout, secretsToMask);
            const arr = getByJsonPath(raw, ch.jsonPaths?.spriteItems || 'items') ?? raw?.items ?? raw?.data;
            if (!Array.isArray(arr)) throw new Error('未解析出精灵数组');
            return `${arr.length} 条`;
          },
        });
      }
      if (ch.sealFlowPath) {
        probes.push({
          name: '封单分时',
          run: async () => {
            const raw = await fetchJsonWithTimeout(resolveTemplateUrl(ch.baseUrl, ch.sealFlowPath, sampleVars), { headers }, timeout, secretsToMask);
            const pts = parseSealFlowPayload(raw, ch);
            if (!pts || pts.length === 0) throw new Error('无有效数值封单点');
            return `${pts.length} 点`;
          },
        });
      }
      if (ch.auctionPath) {
        probes.push({
          name: '竞价抢筹',
          run: async () => {
            const raw = await fetchJsonWithTimeout(resolveTemplateUrl(ch.baseUrl, ch.auctionPath, sampleVars), { headers }, timeout, secretsToMask);
            const arr = getByJsonPath(raw, ch.jsonPaths?.auctionItems || 'items') ?? raw?.items ?? raw?.openMovers ?? raw?.topSealAmount;
            if (!Array.isArray(arr)) throw new Error('未返回合法竞价数组');
            return `${arr.length} 条`;
          },
        });
      }
      if (ch.lhbPath) {
        probes.push({
          name: '龙虎榜',
          run: async () => {
            const raw = await fetchJsonWithTimeout(resolveTemplateUrl(ch.baseUrl, ch.lhbPath, sampleVars), { headers }, timeout, secretsToMask);
            const arr = getByJsonPath(raw, ch.jsonPaths?.lhbItems || 'items') ?? raw?.items ?? raw?.data;
            if (!Array.isArray(arr)) throw new Error('未返回合法龙虎榜数组');
            return `${arr.length} 条`;
          },
        });
      }
      if (ch.chipPath) {
        probes.push({
          name: '筹码分布',
          run: async () => {
            const raw = await fetchJsonWithTimeout(resolveTemplateUrl(ch.baseUrl, ch.chipPath, sampleVars), { headers }, timeout, secretsToMask);
            if (!parseChipsPayload(raw, ch)) throw new Error('未返回有效筹码指标');
            return '筹码契约通过';
          },
        });
      }
      if (probes.length === 0) throw new Error('请至少配置一个短线能力路径（精灵/封单/竞价/龙虎榜/筹码）');
    } else if (channelId === 'news_feeds') {
      if (ch.pollUrl) {
        probes.push({
          name: '主动电报(pollUrl)',
          run: async () => {
            const raw = await fetchJsonWithTimeout(ch.pollUrl, { headers }, timeout, secretsToMask);
            const parsed = parseMappedNewsItems(raw, ch, false);
            return `映射通过 (${parsed.items.length} 条)`;
          },
        });
      }
      if (ch.communityUrl) {
        probes.push({
          name: '社区深度流(communityUrl)',
          run: async () => {
            const raw = await fetchJsonWithTimeout(ch.communityUrl, { headers }, timeout, secretsToMask);
            const parsed = parseMappedNewsItems(raw, ch, true);
            return `社区映射通过 (${parsed.items.length} 条)`;
          },
        });
      }
      if (probes.length === 0) throw new Error('请填写主动新闻 pollUrl 或社区流 communityUrl（若仅用 Webhook，保持免费默认模式即可）');
    } else if (channelId === 'global_markets') {
      const globalCompat = validateGlobalMarketsForEdition(ch, { fromLegacyKey: false, requireConfirmedInCn: false });
      if (!globalCompat.compatible) {
        throw new Error(globalCompat.reason);
      }
      const host = ch.proxyUrl || ch.baseUrl || '';
      const cryptoExt = getMarketExtension('crypto');

      // 1) 海外股票供应商或自建海外网关
      if (ch.preset === 'finnhub') {
        if (!ch.apiKey) throw new Error('请先填写 Finnhub API Key');
        probes.push({
          name: 'Finnhub 美股',
          scope: 'equities_futures',
          run: async () => {
            const d = await fetchJsonWithTimeout(`${host || 'https://finnhub.io/api/v1'}/quote?symbol=NVDA&token=${encodeURIComponent(ch.apiKey)}`, { headers }, timeout, secretsToMask);
            if (d?.error || toNullableNum(d?.c) == null || Number(d.c) <= 0) throw new Error('Finnhub 无效报价或额度受限');
            return `NVDA=${d.c}`;
          },
        });
      } else if (ch.preset === 'polygon') {
        if (!ch.apiKey) throw new Error('请先填写 Polygon.io API Key');
        probes.push({
          name: 'Polygon 美股',
          scope: 'equities_futures',
          run: async () => {
            const d = await fetchJsonWithTimeout(`${host || 'https://api.polygon.io'}/v2/aggs/ticker/NVDA/prev?apiKey=${encodeURIComponent(ch.apiKey)}`, { headers }, timeout, secretsToMask);
            if (d?.status === 'ERROR' || !Array.isArray(d?.results)) throw new Error('Polygon 权限或契约异常');
            return `${d.results.length} 条`;
          },
        });
      } else if (ch.preset === 'alpha_vantage') {
        if (!ch.apiKey) throw new Error('请先填写 Alpha Vantage API Key');
        probes.push({
          name: 'Alpha Vantage',
          scope: 'equities_futures',
          run: async () => {
            const d = await fetchJsonWithTimeout(`${host || 'https://www.alphavantage.co'}/query?function=GLOBAL_QUOTE&symbol=NVDA&apikey=${encodeURIComponent(ch.apiKey)}`, { headers }, timeout, secretsToMask);
            if (d?.['Error Message'] || d?.['Note'] || !d?.['Global Quote']?.['05. price']) throw new Error('Alpha Vantage 无效报价');
            return `NVDA=${d['Global Quote']['05. price']}`;
          },
        });
      } else if (ch.preset === 'custom_global' && host) {
        probes.push({
          name: '自建海外网关(/quote)',
          scope: 'equities_futures',
          run: async () => {
            const url = buildGlobalCustomQuoteUrl(host, '105.NVDA', 'NVDA', ch.apiKey);
            const raw = await fetchJsonWithTimeout(url, { headers }, timeout, secretsToMask);
            const d = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
            if (!d || toNullableNum(d.price ?? d.last ?? d.c) == null) throw new Error('未返回有效 price/last/c');
            return `NVDA=${d.price ?? d.last ?? d.c}`;
          },
        });
      }

      // 2) 可选扩展市场探针（仅在启用对应扩展的版本中加载）
      if (cryptoExt) {
        const extProbes = cryptoExt
          .buildCustomCryptoProbes(ch, {
            fetchJsonWithTimeout,
            resolveTemplateUrl,
            headers,
            timeout,
            secretsToMask,
          })
          .map((p) => ({ ...p, scope: 'crypto' }));
        probes.push(...extProbes);
      }

      if (probes.length === 0) throw new Error('请填写海外行情网关 Base URL、Proxy URL 或选择有效供应商');
    }

    const endpointResults = [];
    for (const p of probes) {
      try {
        const detail = await p.run();
        endpointResults.push({ endpoint: p.name, ok: true, detail, scope: p.scope || 'equities_futures' });
      } catch (err) {
        endpointResults.push({
          endpoint: p.name,
          ok: false,
          detail: redactSecrets(err?.message || String(err), secretsToMask),
          scope: p.scope || 'equities_futures',
        });
      }
    }

    const allOk = endpointResults.every((r) => r.ok);
    const latencyMs = Date.now() - startedAt;
    const summaryText = endpointResults.map((r) => `${r.endpoint}:${r.ok ? `✓${r.detail}` : `✗${r.detail}`}`).join('；');
    const hasCryptoProbe = endpointResults.some((r) => r.scope === 'crypto');
    const res = {
      ok: allOk,
      channel: channelId,
      mode: 'custom',
      preset: ch.preset,
      assetScope: hasCryptoProbe ? 'mixed' : 'equities_futures',
      latencyMs,
      endpoints: endpointResults,
      message: `${allOk ? '自定义源全部契约校验通过' : '部分/全部端点校验失败'}（${latencyMs}ms）：${summaryText}`,
    };
    recordChannelCheck(channelId, res);
    return res;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const safeErr = redactSecrets(err?.message || String(err), secretsToMask);
    const res = {
      ok: false,
      channel: channelId,
      mode: ch.mode,
      latencyMs,
      message: `连接失败（${latencyMs}ms）：${safeErr}`,
    };
    recordChannelCheck(channelId, res);
    return res;
  }
}

// ============================================================================
// 7. 标准 JSON 接口契约文档（全能力覆盖）
// ============================================================================

function getAdapterContracts(port = 3721) {
  const base = `http://127.0.0.1:${port}`;
  return [
    {
      channel: 'news_feeds',
      title: '被动推送 Webhook（POST /api/feeds/ingest）· 实时打入短线快讯与研究简报流',
      curl: `curl -X POST "${base}/api/feeds/ingest" \\\n  -H "Authorization: Bearer <你的本地Webhook Token>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"items":[{"title":"合规快讯示例：某光通信企业披露订单公告","content":"具体公开公告摘要...","source":"自定义快讯源","time":"10:18","important":true,"secids":["0.300308"],"isCommunity":false}]}'`,
      responseSample: `{\n  "ok": true,\n  "acceptedCount": 1,\n  "totalStored": 12\n}`,
    },
    {
      channel: 'cn_quotes',
      title: 'A股 L2 十档盘口 / 实时报价 / 逐笔契约（GET {baseUrl}{orderbookPath|quotePath|tickPath}）',
      curl: `curl -H "Authorization: Bearer <你的Token>" "http://127.0.0.1:8899/api/l2/orderbook?secid=0.300308"`,
      responseSample: `{\n  "code": "300308", "name": "中际旭创", "last": 417.0, "preClose": 417.2,\n  "weibi": 85.6, "limitUp": 500.64, "limitDown": 333.76,\n  "bids": [{"level":1,"price":417.0,"volume":1286}, "... up to level 10"],\n  "asks": [{"level":1,"price":417.01,"volume":2}, "... up to level 10"]\n}`,
    },
    {
      channel: 'cn_quotes',
      title: 'A股分时 / K 线 / WebSocket 推流契约（intradayPath / klinePath / wsUrl）',
      curl: `curl -H "Authorization: Bearer <你的Token>" "http://127.0.0.1:8899/api/intraday?secid=0.300308"\n# WebSocket 连接后发送: {"action":"subscribe","secid":"0.300308","code":"300308"}`,
      responseSample: `// intradayPath:\n{"preClose":417.2,"points":[{"t":"09:30","p":418.0,"a":417.8,"v":1200}]}\n// klinePath:\n{"klines":[{"date":"2026-11-24","open":415,"high":420,"low":412,"close":417,"volume":150000,"amount":62500000}]}`,
    },
    {
      channel: 'cn_short_term',
      title: '短线精灵 / 封单分时 / 竞价 / 龙虎榜 / 筹码分布契约（cn_short_term）',
      curl: `curl -H "Authorization: Bearer <你的Token>" "http://127.0.0.1:8899/api/short-term/seal-flow?secid=0.002384"\ncurl -H "Authorization: Bearer <你的Token>" "http://127.0.0.1:8899/api/short-term/chips?secid=0.002384"`,
      responseSample: `// sealFlowPath:\n{"series":[{"t":"09:30","sealYi":12.4},{"t":"09:35","sealYi":18.9}]}\n// chipPath:\n{"data":{"profitRatioPct":78.4,"avgCost":71.2,"concentration90Pct":11.5}}`,
    },
    {
      channel: 'news_feeds',
      title: '主动新闻轮询 & 社区深度流契约（pollUrl / communityUrl）',
      curl: `curl -H "Authorization: Bearer <你的Token>" "http://127.0.0.1:8899/api/news/live"\ncurl -H "Authorization: Bearer <你的Token>" "http://127.0.0.1:8899/api/community/posts"`,
      responseSample: `{\n  "items": [\n    {"id":"p1","title":"主线逻辑拆解","content":"完整研究摘要...","time":"10:32","source":"自定义研究简报","url":"https://...","important":true}\n  ]\n}`,
    },
    {
      channel: 'global_markets',
      title: '通用海外股市与大宗期货自定义 HTTP JSON 网关契约（{baseUrl}/quote）',
      curl: `curl -H "Authorization: Bearer <你的Token>" "http://127.0.0.1:8899/quote?secid=105.NVDA&symbol=NVDA"`,
      responseSample: `{"price":148.2,"open":146.0,"high":149.1,"low":145.5,"preClose":145.1,"pct":2.14,"chg":3.1,"volume":45200000}`,
    },
    ...(getMarketExtension('crypto')?.CRYPTO_CONTRACT_DOC ? [getMarketExtension('crypto').CRYPTO_CONTRACT_DOC] : []),
  ];
}

module.exports = {
  getByJsonPath,
  redactSecrets,
  buildAuthHeaders,
  clearRouterCaches,
  closeWsConnections,
  resolveCryptoAdapterSpec,
  verifyBearerWebhookToken,
  ingestWebhookFeeds,
  listIngestedFeeds,
  clearIngestedFeeds,
  routeCnQuotesBatch,
  routeCnIntraday,
  routeCnKlines,
  fetchStockOrderBookAndTicks,
  fetchSealFlowIntraday,
  fetchShortTermChips,
  routeShortTermSprite,
  routeShortTermAuction,
  routeShortTermLhb,
  mergeRoutedNewsFeeds,
  routeCryptoTickers,
  routeGlobalEquityQuotes,
  testChannelConnection,
  getAdapterContracts,
  computeCapabilities,
};
