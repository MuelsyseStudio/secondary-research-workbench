'use strict';

/**
 * 二级投研 · 跨市场实时盯盘看板服务（A股 + 美股 + 港股）
 * - 本地持久化自选股列表与中美联动观察组（watchlist.local.json，不改动三库 md）
 * - 单次批量拉取全部自选股与全球核心指数实时报价（价格、涨跌幅、成交额、成交量、换手率、量比、振幅、市值、PE）
 * - 并发抓取盘中 1 分钟分时走势 + 均价线(VWAP) + 分钟成交量柱（A股/美股/港股全支持）
 * - 提供单标详细弹窗的完整分时 + 22日K线数据
 */

const fs = require('node:fs');
const path = require('node:path');
const { fetchCrossMarketBenchmarks } = require('./stock-researcher.cjs');
const { getEditionInfo } = require('./edition.cjs');
const {
  getValidMarketKinds,
  getValidCurrencies,
  isUnsupportedAssetSecid,
  isCryptoSecid,
  cryptoPairFromSecid,
  fetchCryptoTickers,
  fetchCryptoKlines,
  inferMarketMetaFromSecid,
} = require('./global-markets.cjs');
const {
  routeCnQuotesBatch,
  routeCnIntraday,
  routeCnKlines,
  routeGlobalEquityQuotes,
} = require('./data-source-router.cjs');

const { PATHS, workspaceStateFile } = require('./app-paths.cjs');
const { LruTtlCache, atomicWriteFileSync } = require('./lru-cache.cjs');
function getStorePath() {
  return workspaceStateFile('watchlist.local.json');
}
function getActiveWorkspaceRoot() {
  return path.resolve(PATHS.projectRoot);
}
const intradayCache = new LruTtlCache({ maxEntries: 200, defaultTtlMs: 30000 });

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
};

const DEFAULT_WATCHLIST = [
  { secid: '0.300308', code: '300308', secuCode: '300308.SZ', name: '中际旭创', marketKind: 'CN', currency: 'CNY', group: 'AI算力/光模块', note: 'NVDA光模块核心映射' },
  { secid: '0.300502', code: '300502', secuCode: '300502.SZ', name: '新易盛', marketKind: 'CN', currency: 'CNY', group: 'AI算力/光模块', note: '1.6T光模块弹性标的' },
  { secid: '0.002384', code: '002384', secuCode: '002384.SZ', name: '东山精密', marketKind: 'CN', currency: 'CNY', group: 'PCB/AI硬件', note: 'PCB与AI硬件核心标的' },
  { secid: '0.300394', code: '300394', secuCode: '300394.SZ', name: '天孚通信', marketKind: 'CN', currency: 'CNY', group: 'AI算力/光模块', note: '光引擎核心上游' },
  { secid: '1.688809', code: '688809', secuCode: '688809.SH', name: '强一股份', marketKind: 'CN', currency: 'CNY', group: '半导体/测试', note: '探针卡与半导体测试设备' },
  { secid: '1.688256', code: '688256', secuCode: '688256.SH', name: '寒武纪', marketKind: 'CN', currency: 'CNY', group: '国产算力', note: '国产AI芯片趋势龙头' },
  { secid: '105.NVDA', code: 'NVDA', secuCode: 'NVDA.US', name: '英伟达', marketKind: 'US', currency: 'USD', group: '美股算力核心', note: '全球AI算力定价总锚' },
  { secid: '106.TSM', code: 'TSM', secuCode: 'TSM.US', name: '台积电', marketKind: 'US', currency: 'USD', group: '美股半导体', note: '先进制程与CoWoS风向标' },
  { secid: '105.AVGO', code: 'AVGO', secuCode: 'AVGO.US', name: '博通', marketKind: 'US', currency: 'USD', group: '美股算力核心', note: 'ASIC与高速网络龙头' },
  { secid: '106.COHR', code: 'COHR', secuCode: 'COHR.US', name: 'Coherent', marketKind: 'US', currency: 'USD', group: '美股光通信', note: '海外光器件直连映射' },
  { secid: '105.AMD', code: 'AMD', secuCode: 'AMD.US', name: 'AMD', marketKind: 'US', currency: 'USD', group: '美股算力核心', note: '数据中心GPU次龙头' },
  { secid: '105.MU', code: 'MU', secuCode: 'MU.US', name: '美光科技', marketKind: 'US', currency: 'USD', group: '美股存储/HBM', note: 'HBM与存储景气风向标' },
];

const DEFAULT_CROSS_PAIRS = [
  {
    id: 'pair-ai-optical',
    title: 'AI 算力 & 光通信中美映射',
    usSecids: ['105.NVDA', '106.COHR'],
    cnSecids: ['0.300308', '0.300502', '0.300394', '0.002384'],
    methodCards: ['159', '192'],
    note: '观察美股算力/光模块龙头对A股光模块与PCB链条的开盘溢价兑现与剪刀差背离',
  },
  {
    id: 'pair-semi-foundry',
    title: '先进制程 & 芯片产业链映射',
    usSecids: ['106.TSM', '105.AVGO'],
    cnSecids: ['1.688809', '1.688256'],
    methodCards: ['159', '192'],
    note: '观察台积电/博通景气传导与国产算力/半导体测试设备的强弱分化',
  },
  {
    id: 'pair-hbm-compute',
    title: '存储 HBM & 二线算力联动',
    usSecids: ['105.MU', '105.AMD'],
    cnSecids: ['0.002384', '1.688256'],
    methodCards: ['159', '192'],
    note: '跟踪美股存储与二线GPU动量对A股硬件与算力板块的风险偏好传导',
  },
];

function toStrictNum(v) {
  if (v === null || v === undefined || v === '' || v === '-' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  const n = toStrictNum(v);
  return n != null ? Number(n.toFixed(2)) : null;
}

function toYi(v) {
  const n = toStrictNum(v);
  return n != null ? Number((n / 1e8).toFixed(2)) : null;
}

function toBillion(v) {
  const n = toStrictNum(v);
  return n != null ? Number((n / 1e9).toFixed(2)) : null;
}

function toMillion(v) {
  const n = toStrictNum(v);
  return n != null ? Number((n / 1e6).toFixed(2)) : null;
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function nowOffsetISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url, timeoutMs = 8000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function toTencentSymbol(secid) {
  const [mktNum, ...rest] = String(secid || '').split('.');
  const code = rest.join('.');
  if (mktNum === '1') return `sh${code}`;
  if (mktNum === '0') {
    const prefix = code.startsWith('4') || code.startsWith('8') || code.startsWith('92') ? 'bj' : 'sz';
    return `${prefix}${code}`;
  }
  if (mktNum === '116') return `hk${code}`;
  if (mktNum === '105') return `us${code}.OQ`;
  if (mktNum === '106') return `us${code}.N`;
  if (mktNum === '107') return `us${code}.A`;
  return `us${code}`;
}

function downsampleBars(parsed, preClose, maxBuckets) {
  const aboveAvgBars = parsed.filter((b) => b.p >= b.a).length;
  let points;
  if (parsed.length <= maxBuckets) {
    points = parsed.map((b, i) => ({
      t: b.t,
      p: round2(b.p),
      a: round2(b.a),
      v: Math.round(b.v),
      up: i === 0 ? (preClose ? b.p >= preClose : b.p >= (b.o || b.p)) : b.p >= parsed[i - 1].p,
    }));
  } else {
    points = [];
    const bucketSize = parsed.length / maxBuckets;
    let prevPrice = preClose || parsed[0].o || parsed[0].p;
    for (let i = 0; i < maxBuckets; i++) {
      const start = Math.floor(i * bucketSize);
      const end = Math.min(parsed.length, Math.floor((i + 1) * bucketSize));
      const slice = parsed.slice(start, Math.max(end, start + 1));
      const last = slice[slice.length - 1];
      const volSum = slice.reduce((acc, x) => acc + x.v, 0);
      points.push({
        t: last.t,
        p: round2(last.p),
        a: round2(last.a),
        v: Math.round(volSum),
        up: last.p >= prevPrice,
      });
      prevPrice = last.p;
    }
  }
  return {
    available: true,
    barCount: parsed.length,
    preClose: round2(preClose),
    tradeDate: parsed[parsed.length - 1].dt.slice(0, 10),
    firstTime: parsed[0].t,
    lastTime: parsed[parsed.length - 1].t,
    aboveAvgRatioPct: round2((aboveAvgBars / parsed.length) * 100),
    points,
  };
}

/**
 * 腾讯 1 分钟分时 + 成交量 + VWAP（A股/港股主源，零限频稳定）
 */
async function fetchTencentIntradayCNHK(secid, marketKind, maxBuckets) {
  const sym = toTencentSymbol(secid);
  const hosts = [
    `https://ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(sym)}`,
    `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(sym)}`,
  ];
  let json = null;
  for (const url of hosts) {
    try {
      const candidate = await fetchJson(url, 6500);
      if (candidate?.data?.[sym]?.data?.data?.length >= 2) {
        json = candidate;
        break;
      }
    } catch {
      // try next mirror
    }
  }
  const node = json?.data?.[sym];
  const rows = node?.data?.data;
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('腾讯分时数据为空');
  }
  const qt = node?.qt?.[sym] || [];
  const preClose = Number(qt[4] || 0) || null;
  const rawDate = String(node?.data?.date || '');
  const tradeDate = rawDate.length === 8 ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : nowOffsetISO().slice(0, 10);

  const parsed = [];
  let prevCumVol = 0;
  for (const line of rows) {
    const p = String(line).trim().split(/\s+/);
    if (p.length < 3) continue;
    const hhmmRaw = p[0];
    if (hhmmRaw.length !== 4) continue;
    const hhmm = `${hhmmRaw.slice(0, 2)}:${hhmmRaw.slice(2, 4)}`;
    if (marketKind === 'CN' && hhmm < '09:30') continue;
    const price = Number(p[1]);
    const cumVol = Number(p[2]);
    const cumAmt = p[3] != null ? Number(p[3]) : null;
    if (!Number.isFinite(price) || price <= 0) continue;
    const barVol = Math.max(0, Number.isFinite(cumVol) ? cumVol - prevCumVol : 0);
    if (Number.isFinite(cumVol)) prevCumVol = cumVol;

    // A股 cumVol 单位是手(100股)，港股是股
    const shareMult = marketKind === 'CN' ? 100 : 1;
    let vwap = price;
    if (cumAmt != null && Number.isFinite(cumAmt) && cumAmt > 0 && cumVol > 0) {
      const calc = cumAmt / (cumVol * shareMult);
      if (Number.isFinite(calc) && calc > price * 0.5 && calc < price * 1.5) vwap = calc;
    }

    parsed.push({
      dt: `${tradeDate} ${hhmm}`,
      t: hhmm,
      o: price,
      p: price,
      v: barVol,
      a: vwap,
    });
  }
  if (parsed.length < 2) throw new Error('腾讯分时有效点数不足');
  return downsampleBars(parsed, preClose, maxBuckets);
}

/**
 * 新浪美股盘中分时 + 成交量 + VWAP（美股主源，零限频稳定，美东时间 09:30–16:00）
 */
async function fetchSinaIntradayUS(secid, preCloseHint, maxBuckets, intervalMin = 5) {
  const code = String(secid).split('.').slice(1).join('.');
  const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/cb/US_MinKService.getMinK?symbol=${encodeURIComponent(code)}&type=${intervalMin}&___qn=3`;
  const text = await fetchText(url, 8000);
  const m = text.match(/cb\((\[[\s\S]*\])\)\s*;?\s*$/);
  if (!m) throw new Error('新浪美股分时返回格式异常');
  const rows = JSON.parse(m[1]);
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('新浪美股分时为空');

  const latestDate = String(rows[rows.length - 1].d || '').slice(0, 10);
  const sameDay = rows.filter((r) => String(r.d || '').startsWith(latestDate));
  const useRows = sameDay.length >= 4 ? sameDay : rows.slice(-78);

  const parsed = [];
  let cumVol = 0;
  let cumAmt = 0;
  for (const r of useRows) {
    const dt = String(r.d || '');
    const hhmm = dt.slice(11, 16);
    const open = Number(r.o);
    const close = Number(r.c);
    const vol = Number(r.v) || 0;
    const amt = Number(r.a) || close * vol;
    if (!Number.isFinite(close) || close <= 0) continue;
    cumVol += vol;
    cumAmt += amt;
    const vwap = cumVol > 0 ? cumAmt / cumVol : close;
    parsed.push({
      dt,
      t: hhmm,
      o: Number.isFinite(open) ? open : close,
      p: close,
      v: vol,
      a: vwap,
    });
  }
  if (parsed.length < 2) throw new Error('新浪美股分时有效点不足');
  return downsampleBars(parsed, preCloseHint || parsed[0].o, maxBuckets);
}

function inferMetaFromSecid(secid) {
  return inferMarketMetaFromSecid(secid);
}

function sanitizeWatchlistItem(raw) {
  if (!raw || !raw.secid) return null;
  const secid = String(raw.secid).trim();
  if (!/^(?:\d+|crypto)\.[A-Za-z0-9._-]+$/i.test(secid)) return null;
  const cryptoEnabled = getEditionInfo().features.crypto;
  if (!cryptoEnabled && (isUnsupportedAssetSecid(secid) || String(raw.marketKind || '').toUpperCase() === 'CRYPTO')) {
    return null;
  }
  const inferred = inferMetaFromSecid(secid);
  const validKinds = getValidMarketKinds();
  const validCurrencies = getValidCurrencies();
  const defaultGroupMap = {
    CN: 'A股自选',
    US: '美股自选',
    HK: '港股自选',
    TW: '台股 · TWSE',
    KR: '韩股 · KRX',
    FR: '法股 · 泛欧巴黎',
    UK: '英股 · 伦敦LSE',
    JP: '日股 · 东京JPX',
    DE: '德股 · 法兰克福',
    FUT: '全球期货',
    ...(cryptoEnabled ? { CRYPTO: '扩展资产 24/7' } : {}),
  };
  const mk = validKinds.includes(raw.marketKind) ? raw.marketKind : inferred.marketKind;
  if (!validKinds.includes(mk)) return null;
  return {
    secid,
    code: String(raw.code || inferred.code).trim(),
    secuCode: String(raw.secuCode || inferred.secuCode).trim(),
    name: String(raw.name || inferred.name || inferred.code).trim(),
    marketKind: mk,
    currency: validCurrencies.includes(raw.currency) ? raw.currency : inferred.currency,
    exchange: String(raw.exchange || inferred.exchange || mk).trim(),
    group: String(raw.group || defaultGroupMap[mk] || '全球自选').trim(),
    note: String(raw.note || '').trim(),
  };
}

function loadWatchlistConfig() {
  const storePath = getStorePath();
  const workspaceRoot = getActiveWorkspaceRoot();
  if (!fs.existsSync(storePath)) {
    return {
      workspaceRoot,
      items: [],
      crossPairs: [],
      updatedAt: null,
      isDefault: true,
      configured: false,
      isDemo: false,
      demoSampleCount: DEFAULT_WATCHLIST.length,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const hasItems = Array.isArray(raw.items);
    const items = hasItems ? raw.items.map(sanitizeWatchlistItem).filter(Boolean) : [];
    const crossPairs = Array.isArray(raw.crossPairs) ? raw.crossPairs : [];
    return {
      workspaceRoot,
      items,
      crossPairs,
      updatedAt: raw.updatedAt || null,
      isDefault: false,
      configured: true,
      isDemo: Boolean(raw.isDemo),
      demoSampleCount: DEFAULT_WATCHLIST.length,
    };
  } catch {
    return {
      workspaceRoot,
      items: [],
      crossPairs: [],
      updatedAt: null,
      isDefault: true,
      configured: false,
      isDemo: false,
      demoSampleCount: DEFAULT_WATCHLIST.length,
    };
  }
}

function saveWatchlistConfig(patch = {}) {
  const current = loadWatchlistConfig();
  const workspaceRoot = getActiveWorkspaceRoot();
  let nextItems = current.items;
  if (Array.isArray(patch.items)) {
    const seen = new Set();
    nextItems = [];
    for (const raw of patch.items) {
      const item = sanitizeWatchlistItem(raw);
      if (!item || seen.has(item.secid)) continue;
      seen.add(item.secid);
      nextItems.push(item);
    }
  }
  const nextPairs = Array.isArray(patch.crossPairs) ? patch.crossPairs : current.crossPairs;
  const saved = {
    items: nextItems,
    crossPairs: nextPairs,
    updatedAt: nowOffsetISO(),
    isDemo: Boolean(patch.isDemo),
  };
  fs.writeFileSync(getStorePath(), JSON.stringify(saved, null, 2) + '\n', 'utf8');
  return { workspaceRoot, ...saved, isDefault: false, configured: true, demoSampleCount: DEFAULT_WATCHLIST.length };
}

function addWatchlistItem(rawItem, opts = {}) {
  const item = sanitizeWatchlistItem(rawItem);
  if (!item) {
    throw new Error('无效的证券标的参数，无法加入自选');
  }
  const current = loadWatchlistConfig();
  const workspaceRoot = getActiveWorkspaceRoot();
  const existing = current.items.find((x) => x.secid === item.secid);
  if (existing) {
    return {
      workspaceRoot,
      ...current,
      added: false,
      alreadyExists: true,
      item: existing,
    };
  }
  const nextItems = opts.prepend !== false ? [item, ...current.items] : [...current.items, item];
  const saved = {
    items: nextItems,
    crossPairs: current.crossPairs,
    updatedAt: nowOffsetISO(),
    isDemo: false,
  };
  fs.writeFileSync(getStorePath(), JSON.stringify(saved, null, 2) + '\n', 'utf8');
  return {
    workspaceRoot,
    ...saved,
    isDefault: false,
    configured: true,
    demoSampleCount: DEFAULT_WATCHLIST.length,
    added: true,
    alreadyExists: false,
    item,
  };
}

function resetWatchlistConfig(opts = {}) {
  const loadDemo = opts?.empty ? false : true;
  const workspaceRoot = getActiveWorkspaceRoot();
  const saved = {
    items: loadDemo ? DEFAULT_WATCHLIST.map(sanitizeWatchlistItem).filter(Boolean) : [],
    crossPairs: loadDemo ? DEFAULT_CROSS_PAIRS : [],
    updatedAt: nowOffsetISO(),
    isDemo: loadDemo,
  };
  fs.writeFileSync(getStorePath(), JSON.stringify(saved, null, 2) + '\n', 'utf8');
  return { workspaceRoot, ...saved, isDefault: false, configured: true, demoSampleCount: DEFAULT_WATCHLIST.length };
}

/**
 * 抓取单只标的盘中分时 + 均价(VWAP) + 成交量柱
 * - A股 / 港股：腾讯分时主源（零限频）→ 东财 trends2 兜底 → 内存缓存兜底
 * - 美股：新浪美股分时主源（零限频）→ 东财 trends2 兜底 → 内存缓存兜底
 */
async function fetchIntradayWithVolume(secid, marketKind, maxBuckets = 76, preCloseHint = null, usIntervalMin = 5) {
  // 0. 可选 24/7 扩展市场分时（仅在对应版本特性启用时执行）
  if (getEditionInfo().features.crypto && (marketKind === 'CRYPTO' || isCryptoSecid(secid))) {
    try {
      const ks = await fetchCryptoKlines(secid, '15m', 96);
      if (ks.length >= 2) {
        let cumV = 0;
        let cumA = 0;
        const parsed = ks.map((k) => {
          cumV += k.vol || 0;
          cumA += k.amt || k.close * (k.vol || 0);
          return {
            dt: k.date,
            t: k.date.slice(11, 16),
            o: k.open,
            p: k.close,
            v: k.vol || 0,
            a: cumV > 0 ? cumA / cumV : k.close,
          };
        });
        const res = downsampleBars(parsed, preCloseHint || parsed[0].o, maxBuckets);
        intradayCache.set(secid, { data: res, cachedAt: Date.now() });
        return res;
      }
    } catch {
      // fall through
    }
  }

  // 1. A股/港股/美股优先使用高稳定性主源（彻底规避东财 push2his 并发限频导致的空白闪烁）
  if (marketKind === 'CN' || marketKind === 'HK' || marketKind === 'US') {
    try {
      const primary =
        marketKind === 'US'
          ? await fetchSinaIntradayUS(secid, preCloseHint, maxBuckets, usIntervalMin)
          : await fetchTencentIntradayCNHK(secid, marketKind, maxBuckets);
      if (primary && primary.available) {
        intradayCache.set(secid, { data: primary, cachedAt: Date.now() });
        return primary;
      }
    } catch {
      // fall through to EastMoney fallback
    }
  }

  // 2. 东财 trends2 备源
  try {
    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1`;
    const json = await fetchJson(url, 6000);
    const data = json?.data;
    if (data && Array.isArray(data.trends) && data.trends.length >= 2) {
      const preClose = Number(data.preClose || 0) || preCloseHint || null;
      const parsed = [];
      for (const row of data.trends) {
        const p = String(row).split(',');
        if (p.length < 8) continue;
        const dt = p[0];
        const hhmm = dt.slice(11, 16);
        if (marketKind === 'CN' && hhmm < '09:30') continue;
        const open = Number(p[1]);
        const close = Number(p[2]);
        const vol = Number(p[5]);
        const vwap = Number(p[7]);
        if (!Number.isFinite(close) || close <= 0) continue;
        parsed.push({
          dt,
          t: hhmm,
          o: open,
          p: close,
          v: Number.isFinite(vol) ? vol : 0,
          a: Number.isFinite(vwap) && vwap > 0 ? vwap : close,
        });
      }
      if (parsed.length >= 2) {
        const result = downsampleBars(parsed, preClose, maxBuckets);
        intradayCache.set(secid, { data: result, cachedAt: Date.now() });
        return result;
      }
    }
  } catch {
    // fall through to cache
  }

  const cached = intradayCache.get(secid);
  if (cached?.data) return cached.data;
  return { available: false, barCount: 0, preClose: preCloseHint, tradeDate: '', points: [] };
}

function formatTencentMinTime(raw) {
  const s = String(raw || '').trim();
  if (/^\d{12}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
  }
  return s;
}

function finalizeKlineSeries(rawList) {
  const out = [];
  for (let i = 0; i < rawList.length; i++) {
    const k = rawList[i];
    if (!k || !Number.isFinite(k.close) || k.close <= 0) continue;
    const prevClose = i > 0 ? rawList[i - 1].close : k.open;
    const chg = prevClose ? round2(k.close - prevClose) : null;
    const pct = prevClose ? round2(((k.close - prevClose) / prevClose) * 100) : null;
    const ampPct = prevClose ? round2(((k.high - k.low) / prevClose) * 100) : null;
    out.push({
      date: k.date,
      open: round2(k.open),
      close: round2(k.close),
      high: round2(k.high),
      low: round2(k.low),
      vol: Number(k.vol) || 0,
      amt: Number(k.amt) || 0,
      ampPct: k.ampPct ?? ampPct,
      pct: k.pct ?? pct,
      chg: k.chg ?? chg,
      turnoverPct: k.turnoverPct ?? null,
    });
  }
  return out;
}

/**
 * 统一多周期前复权 K 线抓取引擎（支持 A股 / 美股 / 港股）
 * timeframe: 'day' (最多500日≈2年) | 'week' (150周≈3年) | '60m' | '15m' | '1m'
 */
async function fetchMultiTimeframeKlines(secid, marketKind, timeframe = 'day', limitOverride = null) {
  const tf = ['day', 'week', '60m', '15m', '1m'].includes(timeframe) ? timeframe : 'day';
  if (marketKind === 'CN') {
    return routeCnKlines(secid, tf, () => fetchDefaultMultiTimeframeKlines(secid, marketKind, tf, limitOverride));
  }
  return fetchDefaultMultiTimeframeKlines(secid, marketKind, tf, limitOverride);
}

async function fetchDefaultMultiTimeframeKlines(secid, marketKind, timeframe = 'day', limitOverride = null) {
  const tf = ['day', 'week', '60m', '15m', '1m'].includes(timeframe) ? timeframe : 'day';
  if (isUnsupportedAssetSecid(secid) || (marketKind === 'CRYPTO' && !getEditionInfo().features.crypto)) {
    return [];
  }
  if (getEditionInfo().features.crypto && (marketKind === 'CRYPTO' || isCryptoSecid(secid))) {
    return fetchCryptoKlines(secid, tf, limitOverride || (tf === 'week' ? 120 : 240));
  }
  const sym = toTencentSymbol(secid);
  const code = String(secid).split('.').slice(1).join('.');

  // 1. 日K / 周K（A股/美股/港股优先腾讯前复权；台/韩/法/英/日/德/全球期货直走东财 push2his）
  if (tf === 'day' || tf === 'week') {
    const limit = limitOverride || (tf === 'week' ? 150 : 500);
    const periodKey = tf === 'week' ? 'week' : 'day';
    if (marketKind === 'CN' || marketKind === 'US' || marketKind === 'HK') {
      const endpoints =
        marketKind === 'US'
          ? [
              `https://ifzq.gtimg.cn/appstock/app/usfqkline/get?param=${encodeURIComponent(sym)},${periodKey},,,${limit},qfq`,
              `https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=${encodeURIComponent(sym)},${periodKey},,,${limit},qfq`,
            ]
          : [
              `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${encodeURIComponent(sym)},${periodKey},,,${limit},qfq`,
              `https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(sym)},${periodKey},,,${Math.min(limit, 320)},qfq`,
              `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(sym)},${periodKey},,,${limit},qfq`,
            ];

      for (const endpoint of endpoints) {
        try {
          const json = await fetchJson(endpoint, 7500);
          const node = json?.data?.[sym];
          const arr = node?.[`qfq${periodKey}`] || node?.[periodKey] || [];
          if (Array.isArray(arr) && arr.length >= 2) {
            const raw = arr.map((row) => ({
              date: String(row[0]),
              open: Number(row[1]),
              close: Number(row[2]),
              high: Number(row[3]),
              low: Number(row[4]),
              vol: Number(row[5]) || 0,
              amt: 0,
            }));
            return finalizeKlineSeries(raw);
          }
        } catch {
          // try next endpoint mirror
        }
      }
    }

    // 东财日/周K备源
    try {
      const klt = tf === 'week' ? 102 : 101;
      const json = await fetchJson(
        `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=1&end=20500101&lmt=${limit}`,
        8000
      );
      const kRaw = json?.data?.klines || [];
      return finalizeKlineSeries(
        kRaw
          .map((line) => {
            const p = String(line).split(',');
            if (p.length < 11) return null;
            return {
              date: p[0],
              open: Number(p[1]),
              close: Number(p[2]),
              high: Number(p[3]),
              low: Number(p[4]),
              vol: Number(p[5]),
              amt: Number(p[6]),
              ampPct: round2(p[7]),
              pct: round2(p[8]),
              chg: round2(p[9]),
              turnoverPct: round2(p[10]),
            };
          })
          .filter(Boolean)
      );
    } catch {
      return [];
    }
  }

  // 2. 分钟级 K 线（60m / 15m / 1m）
  const minNum = tf === '60m' ? 60 : tf === '15m' ? 15 : 1;
  const limit = limitOverride || 320;

  // 美股：新浪美股分钟 K 线主源（零限频，60m长达7个月/15m达2个月/1m达多日）
  if (marketKind === 'US') {
    try {
      const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/cb/US_MinKService.getMinK?symbol=${encodeURIComponent(code)}&type=${minNum}&___qn=3`;
      const text = await fetchText(url, 9000);
      const m = text.match(/cb\((\[[\s\S]*\])\)\s*;?\s*$/);
      if (m) {
        const rows = JSON.parse(m[1]);
        if (Array.isArray(rows) && rows.length >= 2) {
          const sliced = rows.slice(-limit);
          return finalizeKlineSeries(
            sliced.map((r) => ({
              date: String(r.d || '').slice(0, 16),
              open: Number(r.o),
              close: Number(r.c),
              high: Number(r.h),
              low: Number(r.l),
              vol: Number(r.v) || 0,
              amt: Number(r.a) || 0,
            }))
          );
        }
      }
    } catch {
      // fallback below
    }
  }

  // A 股：腾讯 mkline 主源（m60/m15/m1 全部稳定 320 根）
  if (marketKind === 'CN') {
    try {
      const mKey = `m${minNum}`;
      const json = await fetchJson(
        `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${encodeURIComponent(sym)},${mKey},,${limit}`,
        8000
      );
      const arr = json?.data?.[sym]?.[mKey];
      if (Array.isArray(arr) && arr.length >= 2) {
        return finalizeKlineSeries(
          arr.map((row) => ({
            date: formatTencentMinTime(row[0]),
            open: Number(row[1]),
            close: Number(row[2]),
            high: Number(row[3]),
            low: Number(row[4]),
            vol: Number(row[5]) || 0,
            amt: Number(row[7]) || 0,
          }))
        );
      }
    } catch {
      // fallback to Sina CN below
    }

    // 新浪 A 股 60m / 15m 兜底
    if (minNum === 60 || minNum === 15) {
      try {
        const rows = await fetchJson(
          `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${encodeURIComponent(sym)}&scale=${minNum}&ma=no&datalen=${limit}`,
          8000
        );
        if (Array.isArray(rows) && rows.length >= 2) {
          return finalizeKlineSeries(
            rows.map((r) => ({
              date: String(r.day || '').slice(0, 16),
              open: Number(r.open),
              close: Number(r.close),
              high: Number(r.high),
              low: Number(r.low),
              vol: Number(r.volume) || 0,
              amt: 0,
            }))
          );
        }
      } catch {
        // fallback to EastMoney below
      }
    }
  }

  // 港股或其他兜底：先试东财 klt=60/15/1，再由腾讯 1m 分时聚合
  try {
    const json = await fetchJson(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${minNum}&fqt=1&end=20500101&lmt=${limit}`,
      7000
    );
    const kRaw = json?.data?.klines || [];
    if (kRaw.length >= 2) {
      return finalizeKlineSeries(
        kRaw
          .map((line) => {
            const p = String(line).split(',');
            if (p.length < 7) return null;
            return {
              date: p[0],
              open: Number(p[1]),
              close: Number(p[2]),
              high: Number(p[3]),
              low: Number(p[4]),
              vol: Number(p[5]),
              amt: Number(p[6]),
            };
          })
          .filter(Boolean)
      );
    }
  } catch {
    // final fallback for HK 1m
  }

  if (marketKind === 'HK') {
    try {
      const intra = await fetchTencentIntradayCNHK(secid, 'HK', 240);
      if (intra.available && intra.points.length >= 2) {
        const grouped = [];
        for (let i = 0; i < intra.points.length; i += minNum) {
          const sl = intra.points.slice(i, i + minNum);
          grouped.push({
            date: `${intra.tradeDate} ${sl[sl.length - 1].t}`,
            open: sl[0].p,
            close: sl[sl.length - 1].p,
            high: Math.max(...sl.map((x) => x.p)),
            low: Math.min(...sl.map((x) => x.p)),
            vol: sl.reduce((s, x) => s + x.v, 0),
            amt: 0,
          });
        }
        return finalizeKlineSeries(grouped);
      }
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * 抓取近期前复权日K（兼容旧调用方，直接委托给多周期引擎）
 */
async function fetchDailyKlinesRobust(secid, marketKind, limit = 25) {
  return fetchMultiTimeframeKlines(secid, marketKind, 'day', limit);
}

/**
 * 带并发上限的批量异步执行
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      try {
        results[current] = await fn(items[current], current);
      } catch (err) {
        results[current] = { error: err.message };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 获取完整跨市场实时盯盘看板数据（指数 + 全部自选实时行情 + 分时成交量曲线 + 中美联动剪刀差）
 */
async function fetchWatchlistLiveBoard(options = {}) {
  const fetchedAt = nowOffsetISO();
  const config = loadWatchlistConfig();
  const items = Array.isArray(options.items) ? options.items.map(sanitizeWatchlistItem).filter(Boolean) : config.items;
  const includeIntraday = options.includeIntraday !== false;

  const quoteFields = 'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23';
  const cnItems = items.filter((x) => x.marketKind === 'CN');
  const globalNonCryptoItems = items.filter((x) => !isCryptoSecid(x.secid) && x.marketKind !== 'CN');
  const cryptoItems = items.filter((x) => isCryptoSecid(x.secid));

  const fetchEmRawMap = async (secidList) => {
    const m = new Map();
    if (!secidList || secidList.length === 0) return m;
    const qRes = await fetchJson(
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=${quoteFields}&secids=${encodeURIComponent(secidList.join(','))}`,
      8000
    ).catch(() => null);
    for (const row of qRes?.data?.diff || []) {
      m.set(`${row.f13}.${row.f12}`, row);
    }
    return m;
  };

  const [benchmarksRes, cnRouted, globalRoutedMap, cryptoMap] = await Promise.all([
    fetchCrossMarketBenchmarks().catch(() => []),
    cnItems.length > 0
      ? routeCnQuotesBatch(
          cnItems.map((x) => x.secid),
          fetchEmRawMap
        ).catch(() => ({ map: new Map(), sourceTier: 'free' }))
      : Promise.resolve({ map: new Map(), sourceTier: 'free' }),
    globalNonCryptoItems.length > 0
      ? routeGlobalEquityQuotes(globalNonCryptoItems, (subItems) =>
          fetchEmRawMap((subItems || []).map((x) => x.secid))
        ).catch(() => new Map())
      : Promise.resolve(new Map()),
    cryptoItems.length > 0
      ? fetchCryptoTickers(cryptoItems.map((c) => cryptoPairFromSecid(c.secid))).catch(() => new Map())
      : Promise.resolve(new Map()),
  ]);

  const quoteBySecid = new Map([...(cnRouted.map || new Map()).entries(), ...(globalRoutedMap || new Map()).entries()]);

  const intradayList =
    includeIntraday && items.length > 0
      ? await mapWithConcurrency(items, 6, async (it) => {
          const q = quoteBySecid.get(it.secid);
          const preCloseHint =
            q?.preClose ?? (q && q.f18 !== '-' && q.f18 !== undefined ? Number(q.f18) : cryptoMap.get(cryptoPairFromSecid(it.secid))?.preClose ?? null);
          if (it.marketKind === 'CN') {
            return routeCnIntraday(it.secid, () => fetchIntradayWithVolume(it.secid, it.marketKind, 72, preCloseHint, 5));
          }
          return fetchIntradayWithVolume(it.secid, it.marketKind, 72, preCloseHint, 5);
        })
      : items.map(() => null);

  const enrichedItems = items.map((item, idx) => {
    const intra = intradayList[idx] && !intradayList[idx].error ? intradayList[idx] : null;
    if (isCryptoSecid(item.secid)) {
      const cLive = cryptoMap.get(cryptoPairFromSecid(item.secid)) || {};
      return {
        ...item,
        price: cLive.price ?? intra?.points?.[intra.points.length - 1]?.p ?? null,
        preClose: cLive.preClose ?? null,
        open: cLive.open ?? null,
        high: cLive.high ?? null,
        low: cLive.low ?? null,
        pct: cLive.pct ?? null,
        chg: cLive.chg ?? null,
        volume: cLive.volume ?? null,
        amount: null,
        amountYi: null,
        amountUsdM: cLive.amountUsdM ?? null,
        amountUsdB: cLive.amountUsdB ?? null,
        amplitudePct: cLive.amplitudePct ?? null,
        turnoverPct: null,
        peTtm: null,
        volumeRatio: null,
        pb: null,
        totalCapYi: null,
        totalCapUsdB: null,
        closePosPct:
          cLive.price != null && cLive.high != null && cLive.low != null && cLive.high > cLive.low
            ? round2(((cLive.price - cLive.low) / (cLive.high - cLive.low)) * 100)
            : null,
        intraday: intra,
      };
    }
    const q = quoteBySecid.get(item.secid);
    const isUS = item.marketKind === 'US';
    const isCustomNorm = Boolean(q && q.sourceTier === 'custom');

    const price = isCustomNorm ? q.price ?? null : q && q.f2 !== '-' ? round2(q.f2) : intra?.points?.[intra.points.length - 1]?.p ?? null;
    const preClose = isCustomNorm ? q.preClose ?? null : q && q.f18 !== '-' ? round2(q.f18) : intra?.preClose ?? null;
    const pct = isCustomNorm
      ? q.pct ?? null
      : q && q.f3 !== '-'
      ? round2(q.f3)
      : price != null && preClose
      ? round2(((price - preClose) / preClose) * 100)
      : null;
    const chg = isCustomNorm
      ? q.chg ?? null
      : q && q.f4 !== '-'
      ? round2(q.f4)
      : price != null && preClose != null
      ? round2(price - preClose)
      : null;
    const high = isCustomNorm ? q.high ?? null : q && q.f15 !== '-' ? round2(q.f15) : null;
    const low = isCustomNorm ? q.low ?? null : q && q.f16 !== '-' ? round2(q.f16) : null;
    const open = isCustomNorm ? q.open ?? null : q && q.f17 !== '-' ? round2(q.f17) : null;
    const rawVol = isCustomNorm ? q.volume ?? null : q && q.f5 !== '-' ? Number(q.f5) : null;
    const rawAmt = isCustomNorm ? q.amount ?? null : q && q.f6 !== '-' ? Number(q.f6) : null;
    const rawCap = isCustomNorm ? q.totalCap ?? null : q && q.f20 !== '-' ? Number(q.f20) : null;

    const closePosPct =
      price != null && high != null && low != null && high > low
        ? round2(((price - low) / (high - low)) * 100)
        : null;

    return {
      ...item,
      name: (isCustomNorm ? q.name : q?.f14) || item.name,
      sourceTier: isCustomNorm ? 'custom' : 'free',
      barDate: isCustomNorm ? q.barDate ?? null : null,
      quoteNote: isCustomNorm ? q.quoteNote ?? null : null,
      price,
      preClose,
      open,
      high,
      low,
      pct,
      chg,
      volume: Number.isFinite(rawVol) ? rawVol : null,
      amount: Number.isFinite(rawAmt) ? rawAmt : null,
      amountYi: isUS ? null : toYi(rawAmt),
      amountUsdM: isUS ? toMillion(rawAmt) : null,
      amountUsdB: isUS ? toBillion(rawAmt) : null,
      amplitudePct: isCustomNorm ? q.amplitudePct : q && q.f7 !== '-' ? round2(q.f7) : null,
      turnoverPct: isCustomNorm ? q.turnoverPct : q && q.f8 !== '-' ? round2(q.f8) : null,
      peTtm: isCustomNorm ? q.peTtm : q && q.f9 !== '-' ? round2(q.f9) : null,
      volumeRatio: isCustomNorm ? q.volumeRatio : q && q.f10 !== '-' ? round2(q.f10) : null,
      pb: isCustomNorm ? q.pb : q && q.f23 !== '-' ? round2(q.f23) : null,
      totalCapYi: isUS ? null : toYi(rawCap),
      totalCapUsdB: isUS ? toBillion(rawCap) : null,
      closePosPct,
      intraday: intra,
    };
  });

  // 计算跨市场联动组实时剪刀差（美股龙头均值 vs A股映射均值）
  const bySecid = new Map(enrichedItems.map((x) => [x.secid, x]));
  const crossPairs = (config.crossPairs || DEFAULT_CROSS_PAIRS).map((pair) => {
    const usLegs = (pair.usSecids || []).map((s) => bySecid.get(s)).filter(Boolean);
    const cnLegs = (pair.cnSecids || []).map((s) => bySecid.get(s)).filter(Boolean);
    const usPcts = usLegs.map((x) => x.pct).filter((v) => v != null);
    const cnPcts = cnLegs.map((x) => x.pct).filter((v) => v != null);
    const usAvgPct = usPcts.length ? round2(avg(usPcts)) : null;
    const cnAvgPct = cnPcts.length ? round2(avg(cnPcts)) : null;
    const spreadPct = usAvgPct != null && cnAvgPct != null ? round2(cnAvgPct - usAvgPct) : null;

    let signal = '数据待同步';
    let signalTone = 'muted';
    if (usAvgPct != null && cnAvgPct != null) {
      if (usAvgPct >= 1.5 && cnAvgPct >= 1.5) {
        signal = '中美共振走强';
        signalTone = 'crimson';
      } else if (usAvgPct >= 1.5 && cnAvgPct < 0.3) {
        signal = '美强A弱 · 警惕159兑现/192背离';
        signalTone = 'amber';
      } else if (usAvgPct <= -1.2 && cnAvgPct >= 0.8) {
        signal = '美弱A强 · 独立韧性（观察192）';
        signalTone = 'teal';
      } else if (usAvgPct <= -1.5 && cnAvgPct <= -1.5) {
        signal = '中美共振回撤 · 严守止损线';
        signalTone = 'emerald';
      } else if (Math.abs(spreadPct || 0) >= 2.5) {
        signal = spreadPct > 0 ? 'A股超额走强' : 'A股明显滞涨';
        signalTone = 'navy';
      } else {
        signal = '联动平稳震荡';
        signalTone = 'muted';
      }
    }

    return {
      ...pair,
      usLegs: usLegs.map((x) => ({ secid: x.secid, code: x.code, name: x.name, price: x.price, pct: x.pct })),
      cnLegs: cnLegs.map((x) => ({ secid: x.secid, code: x.code, name: x.name, price: x.price, pct: x.pct })),
      usAvgPct,
      cnAvgPct,
      spreadPct,
      signal,
      signalTone,
    };
  });

  const cnCount = enrichedItems.filter((x) => x.marketKind === 'CN').length;
  const usCount = enrichedItems.filter((x) => x.marketKind === 'US').length;
  const hkCount = enrichedItems.filter((x) => x.marketKind === 'HK').length;
  const globalCount = enrichedItems.filter((x) => ['TW', 'KR', 'FR', 'UK', 'JP', 'DE'].includes(x.marketKind)).length;
  const futCount = enrichedItems.filter((x) => x.marketKind === 'FUT').length;
  const cryptoCount = enrichedItems.filter((x) => x.marketKind === 'CRYPTO').length;

  return {
    ok: true,
    workspaceRoot: config.workspaceRoot,
    fetchedAt,
    benchmarks: benchmarksRes || [],
    items: enrichedItems,
    crossPairs,
    summary: {
      total: enrichedItems.length,
      cnCount,
      usCount,
      hkCount,
      globalCount,
      futCount,
      cryptoCount,
      upCount: enrichedItems.filter((x) => (x.pct ?? 0) > 0).length,
      downCount: enrichedItems.filter((x) => (x.pct ?? 0) < 0).length,
    },
  };
}

/**
 * 获取单只自选股完整弹窗详情：高清分时成交量 + 长周期多级别 K 线（周K/500日K/60m/15m/1m）+ 均线技术面
 */
async function fetchSecurityDetailChart(secid, timeframe = 'day') {
  const cleanSecid = String(secid || '').trim();
  if (isUnsupportedAssetSecid(cleanSecid)) {
    throw new Error('当前版本不支持该资产类型');
  }
  if (!/^(?:\d+|crypto)\.[A-Za-z0-9._-]+$/i.test(cleanSecid)) {
    throw new Error('无效的证券或资产代码 secid');
  }
  const tf = ['day', 'week', '60m', '15m', '1m'].includes(timeframe) ? timeframe : 'day';
  const meta = inferMetaFromSecid(cleanSecid);
  const quoteFields = 'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23';

  let q = null;
  let cLive = null;
  let routedCustomQ = null;
  const fetchEmSingleMap = async (secidList) => {
    const m = new Map();
    if (!secidList || !secidList.length) return m;
    const qData = await fetchJson(
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=${quoteFields}&secids=${encodeURIComponent(secidList.join(','))}`,
      8000
    ).catch(() => null);
    const row = qData?.data?.diff?.[0];
    if (row) m.set(`${row.f13}.${row.f12}`, row);
    return m;
  };

  if (isCryptoSecid(cleanSecid)) {
    const cm = await fetchCryptoTickers([cryptoPairFromSecid(cleanSecid)]).catch(() => new Map());
    cLive = cm.get(cryptoPairFromSecid(cleanSecid)) || null;
  } else if (meta.marketKind === 'CN') {
    const routed = await routeCnQuotesBatch([cleanSecid], fetchEmSingleMap).catch(() => ({ map: new Map() }));
    const hit = routed.map.get(cleanSecid) || null;
    if (hit && hit.sourceTier === 'custom') routedCustomQ = hit;
    else q = hit;
  } else {
    const gMap = await routeGlobalEquityQuotes([{ secid: cleanSecid, code: meta.code, marketKind: meta.marketKind }], (sub) =>
      fetchEmSingleMap((sub || []).map((x) => x.secid))
    ).catch(() => new Map());
    const hit = gMap.get(cleanSecid) || null;
    if (hit && hit.sourceTier === 'custom') routedCustomQ = hit;
    else q = hit;
  }
  const preCloseHint = routedCustomQ?.preClose ?? cLive?.preClose ?? (q && q.f18 !== '-' ? Number(q.f18) : null);

  const [intraRes, klinesRes] = await Promise.allSettled([
    meta.marketKind === 'CN'
      ? routeCnIntraday(cleanSecid, () => fetchIntradayWithVolume(cleanSecid, meta.marketKind, 130, preCloseHint, 1))
      : fetchIntradayWithVolume(cleanSecid, meta.marketKind, 130, preCloseHint, 1),
    fetchMultiTimeframeKlines(cleanSecid, meta.marketKind, tf),
  ]);

  const intraday = intraRes.status === 'fulfilled' ? intraRes.value : { available: false, barCount: 0, points: [] };
  const klines = klinesRes.status === 'fulfilled' ? klinesRes.value : [];

  const closes = klines.map((k) => k.close);
  const useCustomGroup = Boolean(routedCustomQ);
  const price = useCustomGroup
    ? routedCustomQ.price ?? null
    : cLive
    ? cLive.price ?? null
    : q && q.f2 !== '-'
    ? round2(q.f2)
    : closes[closes.length - 1] ?? null;
  const ma5 = closes.length >= 5 ? round2(avg(closes.slice(-5))) : null;
  const ma10 = closes.length >= 10 ? round2(avg(closes.slice(-10))) : null;
  const ma20 = closes.length >= 20 ? round2(avg(closes.slice(-20))) : null;
  const isUS = meta.marketKind === 'US' || meta.marketKind === 'CRYPTO';

  return {
    ok: true,
    fetchedAt: nowOffsetISO(),
    timeframe: tf,
    secid: cleanSecid,
    code: meta.code,
    secuCode: meta.secuCode,
    marketKind: meta.marketKind,
    currency: meta.currency,
    sourceTier: routedCustomQ?.sourceTier || cLive?.sourceTier || intraday.sourceTier || 'free',
    wsUrl: intraday.wsUrl || null,
    name: routedCustomQ?.name || q?.f14 || meta.name || meta.code,
    quote: {
      price,
      preClose: useCustomGroup
        ? routedCustomQ.preClose ?? null
        : cLive
        ? cLive.preClose ?? null
        : q && q.f18 !== '-'
        ? round2(q.f18)
        : intraday.preClose ?? null,
      open: useCustomGroup ? routedCustomQ.open ?? null : cLive ? cLive.open ?? null : q && q.f17 !== '-' ? round2(q.f17) : null,
      high: useCustomGroup ? routedCustomQ.high ?? null : cLive ? cLive.high ?? null : q && q.f15 !== '-' ? round2(q.f15) : null,
      low: useCustomGroup ? routedCustomQ.low ?? null : cLive ? cLive.low ?? null : q && q.f16 !== '-' ? round2(q.f16) : null,
      pct: useCustomGroup ? routedCustomQ.pct ?? null : cLive ? cLive.pct ?? null : q && q.f3 !== '-' ? round2(q.f3) : null,
      chg: useCustomGroup ? routedCustomQ.chg ?? null : cLive ? cLive.chg ?? null : q && q.f4 !== '-' ? round2(q.f4) : null,
      volume: useCustomGroup ? routedCustomQ.volume ?? null : cLive ? cLive.volume ?? null : q && q.f5 !== '-' ? Number(q.f5) : null,
      barDate: useCustomGroup ? routedCustomQ.barDate ?? null : null,
      quoteNote: useCustomGroup ? routedCustomQ.quoteNote ?? null : null,
      amountYi: isUS ? null : toYi(useCustomGroup ? routedCustomQ.amount : q?.f6),
      amountUsdM: cLive?.amountUsdM ?? (isUS ? toMillion(useCustomGroup ? routedCustomQ.amount : q?.f6) : null),
      amplitudePct: useCustomGroup ? routedCustomQ.amplitudePct ?? null : cLive ? cLive.amplitudePct ?? null : q && q.f7 !== '-' ? round2(q.f7) : null,
      turnoverPct: useCustomGroup ? routedCustomQ.turnoverPct ?? null : q && q.f8 !== '-' ? round2(q.f8) : null,
      volumeRatio: useCustomGroup ? routedCustomQ.volumeRatio ?? null : q && q.f10 !== '-' ? round2(q.f10) : null,
      peTtm: useCustomGroup ? routedCustomQ.peTtm ?? null : q && q.f9 !== '-' ? round2(q.f9) : null,
      pb: useCustomGroup ? routedCustomQ.pb ?? null : q && q.f23 !== '-' ? round2(q.f23) : null,
      totalCapYi: isUS ? null : toYi(useCustomGroup ? routedCustomQ.totalCap : q?.f20),
      totalCapUsdB: isUS ? toBillion(useCustomGroup ? routedCustomQ.totalCap : q?.f20) : null,
      ma5,
      ma10,
      ma20,
      ma5BiasPct: price != null && ma5 ? round2(((price - ma5) / ma5) * 100) : null,
      ret5dPct:
        closes.length >= 6 && closes[closes.length - 6] > 0 && price != null
          ? round2(((price - closes[closes.length - 6]) / closes[closes.length - 6]) * 100)
          : null,
      ret20dPct:
        closes.length >= 20 && closes[0] > 0 && price != null
          ? round2(((price - closes[0]) / closes[0]) * 100)
          : null,
    },
    intraday,
    klines,
  };
}

module.exports = {
  DEFAULT_WATCHLIST,
  DEFAULT_CROSS_PAIRS,
  loadWatchlistConfig,
  saveWatchlistConfig,
  addWatchlistItem,
  resetWatchlistConfig,
  fetchIntradayWithVolume,
  fetchDailyKlinesRobust,
  fetchMultiTimeframeKlines,
  fetchWatchlistLiveBoard,
  fetchSecurityDetailChart,
};
