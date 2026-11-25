'use strict';

/**
 * 短线模式核心后端引擎（对标 柚子 AI 盯盘 + 弈盘 连板/异动/题材/区间/全屏研究）
 *
 * 100% 免费零 API Key 公开数据源 + 本地历史快照自动累积 + 深度融合个人三库与交易账本：
 * 1) fetchShortTermDashboard()          -> 柚子 AI 风格全景看盘（12格温度计 + 大盘分时 + 实时异动电报 + 板块资金 + 6日主线轮动 + 6列快榜 + 4列迷你分时瀑布流）
 * 2) fetchBoardLadderAndCycle()         -> 弈盘风格连板天梯（含逐级晋级率/封板样式/首封时间/题材统计）+ 4联龙头情绪周期曲线
 * 3) fetchAnomalyCenter(query?)         -> 弈盘风格严重异动与重点监控雷达（10日+100% / 30日+200% 偏离值精确数学测算 + 公告抓取 + 卡片174联动）
 * 4) fetchThemeMatrixAndRangeStats()    -> 弈盘风格题材小表格（实时热点拆解 + 个人认知库产业链小表格）+ 大盘K线任意区间涨幅/板块统计
 * 5) fetchStockFullscreenDossier()      -> 弈盘风格个股全屏研究工作台（多周期K线技术面 + 异动偏离进度 + 三库研判/认知/交易账本联动）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PATHS, stateFile, workspaceStateFile } = require('./app-paths.cjs');
const { LruTtlCache, atomicWriteFileSync } = require('./lru-cache.cjs');
const { getEditionInfo } = require('./edition.cjs');
const { loadWorkspace } = require('./knowledge-store.cjs');
const { fetchLimitPools } = require('./market-fetcher.cjs');
const {
  loadWatchlistConfig,
  fetchIntradayWithVolume,
  fetchMultiTimeframeKlines,
} = require('./watchlist-service.cjs');
const { resolveStockQuery, fetchCrossMarketBenchmarks } = require('./stock-researcher.cjs');
const {
  fetchMarketSentimentSnapshot,
  recordSentimentNodeSnapshot,
  analyzeSecurityTechnicals,
} = require('./technical-engine.cjs');
const { loadRegulatoryWatchlist, checkRegulatoryRedline } = require('./reconcile-service.cjs');
const { computeTradeLedgerAnalytics } = require('./trade-ledger.cjs');
const { inferMarketMetaFromSecid } = require('./global-markets.cjs');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
  Accept: '*/*',
  Connection: 'close',
};

const CYCLE_HISTORY_PATH = stateFile('short-term-cycle.local.json');
const THEME_HISTORY_PATH = stateFile('theme-rotation-history.local.json');
const THEME_CATALOG_DISK_CACHE_PATH = stateFile('theme-catalog-cache.local.json');

const memCache = new LruTtlCache({ maxEntries: 180, defaultTtlMs: 30000 });

function getCachedMeta(key, ttlMs) {
  return memCache.getMeta(key, ttlMs);
}

function getCached(key, ttlMs) {
  return memCache.get(key, ttlMs);
}

function setCached(key, data) {
  return memCache.set(key, data);
}

function clearShortTermCaches() {
  memCache.clear();
}

/**
 * 在请求入口原子捕获当前工作空间、自选列表与监管红线快照，
 * 将异动中心与短线驾驶舱缓存在进程内按「工作空间 + 自选版本」严格隔离，防止跨空间串标或慢请求晚返回污染新空间。
 */
function captureWorkspaceWatchlistContext() {
  const projectRoot = path.resolve(PATHS.projectRoot).toLowerCase();
  const wl = loadWatchlistConfig();
  const regStore = loadRegulatoryWatchlist();
  const cnWatchSecids = (wl.items || [])
    .filter((w) => w && w.marketKind === 'CN' && w.secid)
    .map((w) => String(w.secid))
    .sort();
  const activeRegCodes = (regStore.items || [])
    .filter((r) => r && r.active !== false && r.code)
    .map((r) => String(r.code))
    .sort();
  const rawKey = JSON.stringify({
    projectRoot,
    configured: Boolean(wl.configured),
    isDemo: Boolean(wl.isDemo),
    updatedAt: wl.updatedAt || '',
    cnWatchSecids,
    activeRegCodes,
  });
  const scopeHash = crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
  return { projectRoot, wl, regStore, scopeHash };
}

function isCnMarketTradingHours(dateObj = new Date()) {
  const day = dateObj.getDay();
  if (day === 0 || day === 6) return false;
  const hhmm = dateObj.getHours() * 60 + dateObj.getMinutes();
  return (hhmm >= 555 && hhmm <= 695) || (hhmm >= 780 && hhmm <= 905);
}

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function toYi(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number((n / 1e8).toFixed(2)) : null;
}

function nowOffsetISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function formatYYYYMMDD(dateObj) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dateObj.getFullYear()}${pad(dateObj.getMonth() + 1)}${pad(dateObj.getDate())}`;
}

function prevWeekdayYYYYMMDD(baseDateStr) {
  const d = baseDateStr && /^\d{4}-\d{2}-\d{2}$/.test(baseDateStr) ? new Date(`${baseDateStr}T12:00:00`) : new Date();
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return formatYYYYMMDD(d);
}

async function fetchJson(url, timeoutMs = 8500) {
  const candidates = [url];
  if (typeof url === 'string' && url.startsWith('https://push2.eastmoney.com/')) {
    candidates.push(url.replace('https://push2.eastmoney.com/', 'https://push2delay.eastmoney.com/'));
    candidates.push(url.replace('https://push2.eastmoney.com/', 'http://push2.eastmoney.com/'));
  }
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const target = candidates[i];
    const perTryTimeout = i === 0 ? timeoutMs : Math.min(timeoutMs, 6000);
    try {
      const res = await fetch(target, { headers: HEADERS, signal: AbortSignal.timeout(perTryTimeout) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('fetchJson failed');
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      try {
        results[cur] = await fn(items[cur], cur);
      } catch (err) {
        results[cur] = { error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => worker()));
  return results;
}

function codeToSecid(code) {
  const c = String(code || '').replace(/\.(SH|SZ|BJ)$/i, '').trim();
  if (!/^\d{6}$/.test(c)) return '';
  return c.startsWith('6') || c.startsWith('9') ? `1.${c}` : `0.${c}`;
}

function boardTypeFromCode(code) {
  const c = String(code || '').trim();
  if (c.startsWith('30')) return { board: '创业板', benchSecid: '0.399006', benchName: '创业板指', is20cm: true };
  if (c.startsWith('688')) return { board: '科创板', benchSecid: '1.000688', benchName: '科创50', is20cm: true };
  if (c.startsWith('4') || c.startsWith('8') || c.startsWith('92')) return { board: '北交所', benchSecid: '0.899050', benchName: '北证50', is20cm: true };
  if (c.startsWith('60')) return { board: '沪主板', benchSecid: '1.000001', benchName: '上证指数', is20cm: false };
  return { board: '深主板', benchSecid: '0.399001', benchName: '深证成指', is20cm: false };
}

function readJsonSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // ignore
  }
  return fallback;
}

function writeJsonSafe(filePath, payload) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch {
    // non-fatal
  }
}

// ============================================================================
// 辅助拉取：东财全A快榜 / 板块资金 / 强势股 / 昨日涨停表现 / 实时电报
// ============================================================================

async function fetchClistRows(fsExpr, fid, po = 1, pz = 20, fields = 'f12,f13,f14,f2,f3,f4,f6,f7,f8,f10,f62,f184,f128,f136,f140', pn = 1) {
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pz}&po=${po}&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=${fid}&fs=${encodeURIComponent(fsExpr)}&fields=${fields}`;
  const json = await fetchJson(url, 8000);
  const diff = json?.data?.diff || [];
  return {
    total: Number(json?.data?.total || diff.length || 0),
    rows: Array.isArray(diff) ? diff : Object.values(diff),
  };
}

function mapStockRow(r) {
  const code = String(r.f12 || '').trim();
  const mkt = r.f13 != null ? String(r.f13) : code.startsWith('6') ? '1' : '0';
  return {
    secid: `${mkt}.${code}`,
    code,
    name: String(r.f14 || code).trim(),
    price: r.f2 !== '-' ? round2(r.f2) : null,
    pct: r.f3 !== '-' ? round2(r.f3) : null,
    amountYi: r.f6 !== '-' ? toYi(r.f6) : null,
    amplitudePct: r.f7 !== '-' ? round2(r.f7) : null,
    turnoverPct: r.f8 !== '-' ? round2(r.f8) : null,
    volumeRatio: r.f10 !== '-' ? round2(r.f10) : null,
    mainNetYi: r.f62 !== '-' ? toYi(r.f62) : null,
    mainNetPct: r.f184 !== '-' ? round2(r.f184) : null,
    is20cm: code.startsWith('30') || code.startsWith('688'),
  };
}

async function fetchYesterdayZtPool(dateYYYYMMDD) {
  try {
    const json = await fetchJson(
      `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=lbc:desc&date=${dateYYYYMMDD}`,
      7500
    );
    return {
      actualDate: String(json?.data?.qdate || dateYYYYMMDD),
      pool: json?.data?.pool || [],
    };
  } catch {
    return { actualDate: dateYYYYMMDD, pool: [] };
  }
}

async function fetchYesterdayZtPerformance(dateYYYYMMDD) {
  try {
    const json = await fetchJson(
      `https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=100&sort=fbt:asc&date=${dateYYYYMMDD}`,
      6000
    );
    const zbCount = json?.data?.pool?.length || 0;
    const prevRes = await fetchJson(
      `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=lbc:desc&date=${dateYYYYMMDD}`,
      6500
    ).catch(() => null);
    const prevPool = prevRes?.data?.pool || [];
    if (!prevPool.length) return { avgPct: null, lianbanAvgPct: null, sampleCount: 0, zbCount };

    const secids = prevPool.slice(0, 60).map((s) => codeToSecid(s.c)).filter(Boolean);
    const qRes = await fetchJson(
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f13,f3&secids=${encodeURIComponent(secids.join(','))}`,
      6500
    ).catch(() => null);
    const pctByCode = new Map();
    for (const r of qRes?.data?.diff || []) {
      if (r.f3 !== '-') pctByCode.set(String(r.f12), Number(r.f3));
    }
    const allPcts = [];
    const lbPcts = [];
    for (const s of prevPool.slice(0, 60)) {
      const p = pctByCode.get(String(s.c));
      if (!Number.isFinite(p)) continue;
      allPcts.push(p);
      if (Number(s.lbc || 1) >= 2) lbPcts.push(p);
    }
    const avg = (a) => (a.length ? round2(a.reduce((x, y) => x + y, 0) / a.length) : null);
    return {
      avgPct: avg(allPcts),
      lianbanAvgPct: avg(lbPcts),
      sampleCount: allPcts.length,
      zbCount,
    };
  } catch {
    return { avgPct: null, lianbanAvgPct: null, sampleCount: 0, zbCount: 0 };
  }
}

async function fetchLiveTelegraphStream(limit = 18) {
  const { getEditionInfo } = require('./edition.cjs');
  if (!getEditionInfo().features.allowCommunityScrapers) {
    return [];
  }
  const items = [];
  // 1) 华尔街见闻 A 股快讯
  try {
    const json = await fetchJson('https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=a-stock-channel&client=pc&limit=18', 6500);
    for (const row of json?.data?.items || []) {
      const ts = row.display_time ? new Date(row.display_time * 1000) : new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const hhmm = `${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
      const text = String(row.content_text || row.title || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      items.push({
        id: `wscn-${row.id}`,
        time: hhmm,
        timestamp: ts.getTime(),
        source: '华尔街见闻',
        title: String(row.title || text.slice(0, 48)).trim(),
        content: text.slice(0, 200),
        important: Number(row.score || 1) >= 2,
        tags: (row.global_channel_name ? [row.global_channel_name] : []).slice(0, 3),
      });
    }
  } catch {
    // ignore
  }

  // 2) 东方财富 7x24 快讯兜底/合并
  if (items.length < 8) {
    try {
      const json = await fetchJson('https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=14&req_trace=1', 6500);
      for (const row of json?.data?.fastNewsList || []) {
        const st = String(row.showTime || '');
        const hhmm = st.slice(11, 16) || '--:--';
        items.push({
          id: `em-${row.code || Math.random()}`,
          time: hhmm,
          timestamp: st ? Date.parse(st.replace(' ', 'T') + '+08:00') || Date.now() : Date.now(),
          source: '东方财富快讯',
          title: String(row.title || '').trim(),
          content: String(row.summary || row.title || '').trim().slice(0, 200),
          important: /涨停|异动|核查|算力|芯片|机器人|突破|重磅/.test(String(row.title || '')),
          tags: (row.stockList || []).slice(0, 3).map((s) => s.split('.')[1] || s),
        });
      }
    } catch {
      // ignore
    }
  }

  items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return items.slice(0, limit);
}

function recordThemeRotationDay(dateStr, topThemes) {
  if (!dateStr || !Array.isArray(topThemes) || topThemes.length === 0) return [];
  const store = readJsonSafe(THEME_HISTORY_PATH, { days: [] });
  const days = Array.isArray(store.days) ? store.days : [];
  const compact = topThemes.slice(0, 6).map((t) => ({
    code: t.code,
    name: t.name,
    pct: t.pct,
    mainNetYi: t.mainNetYi,
    leaderName: t.leaderName || '',
    leaderPct: t.leaderPct ?? null,
    ztCount: t.ztCount ?? 0,
  }));
  const idx = days.findIndex((d) => d.date === dateStr);
  if (idx >= 0) days[idx] = { date: dateStr, themes: compact };
  else days.push({ date: dateStr, themes: compact });
  days.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = days.slice(-10);
  writeJsonSafe(THEME_HISTORY_PATH, { updatedAt: nowOffsetISO(), days: trimmed });
  return trimmed.slice(-6);
}

// ============================================================================
// 1. 柚子 AI 风格全景看盘主数据（含顶部 12 格温度计 + 6列榜单 + 迷你分时瀑布流）
// ============================================================================

async function fetchShortTermDashboard(forceRefresh = false, opts = {}) {
  const ctx = opts.contextSnapshot || captureWorkspaceWatchlistContext();
  const cacheKey = `short_term_dashboard::${ctx.scopeHash}`;
  if (!forceRefresh) {
    const hit = getCachedMeta(cacheKey, 25000);
    if (hit) {
      return {
        ...hit.data,
        isCached: true,
        cacheAgeSec: hit.ageSec,
        dataStatus: hit.data.dataStatus === 'error' ? 'error' : 'cached',
      };
    }
  }

  const todayYYYYMMDD = formatYYYYMMDD(new Date());
  const sectionErrors = {};
  const track = (name, promise, fallback) =>
    promise.catch((err) => {
      sectionErrors[name] = err?.message || '上游请求失败';
      return fallback;
    });

  const [
    sentiment,
    limitPools,
    sseIntra,
    chinextIntra,
    telegraph,
    conceptFlows,
    industryFlows,
    gainersRes,
    losersRes,
    inflowRes,
    outflowRes,
    over5Res,
    under5Res,
    benchmarks,
  ] = await Promise.all([
    track('sentiment', fetchMarketSentimentSnapshot(), null),
    track('limitPools', fetchLimitPools(todayYYYYMMDD), null),
    track('indexIntraday', fetchIntradayWithVolume('1.000001', 'CN', 90), { available: false, points: [] }),
    track('indexIntraday', fetchIntradayWithVolume('0.399006', 'CN', 90), { available: false, points: [] }),
    track('telegraph', fetchLiveTelegraphStream(16), []),
    track('sectors', fetchClistRows('m:90+t:3+f:!50', 'f62', 1, 60), { total: 0, rows: [] }),
    track('sectors', fetchClistRows('m:90+t:2+f:!50', 'f62', 1, 16), { total: 0, rows: [] }),
    track('leaderboards', fetchClistRows('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', 'f3', 1, 20), { total: 0, rows: [] }),
    track('leaderboards', fetchClistRows('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', 'f3', 0, 20), { total: 0, rows: [] }),
    track('leaderboards', fetchClistRows('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', 'f62', 1, 20), { total: 0, rows: [] }),
    track('leaderboards', fetchClistRows('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', 'f62', 0, 20), { total: 0, rows: [] }),
    fetchClistRows('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', 'f3', 1, 1, 'f12,f3').catch(() => ({ total: 0, rows: [] })),
    fetchClistRows('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', 'f3', 0, 1, 'f12,f3').catch(() => ({ total: 0, rows: [] })),
    track('benchmarks', fetchCrossMarketBenchmarks(), []),
  ]);

  const actualDate = limitPools?.actualDate || nowOffsetISO().slice(0, 10);
  const prevDateYYYYMMDD = prevWeekdayYYYYMMDD(actualDate);
  const [yestPerf, anomalyBrief] = await Promise.all([
    fetchYesterdayZtPerformance(prevDateYYYYMMDD),
    fetchAnomalyCenter(null, { light: true, contextSnapshot: ctx }).catch(() => ({ items: [] })),
  ]);

  // 统计全市场主力净流入（基于主要行业汇总近似）与 20cm 涨停数
  const allZtStocks = [];
  for (const lvl of limitPools?.boardLadder || []) {
    for (const s of lvl.stocks || []) allZtStocks.push(s);
  }
  const zt20cmCount = (gainersRes.rows || []).filter((r) => {
    const c = String(r.f12 || '');
    const p = Number(r.f3);
    return (c.startsWith('30') || c.startsWith('688')) && Number.isFinite(p) && p >= 19.8;
  }).length;

  const industryNetSumYi = round2(
    (industryFlows.rows || []).reduce((acc, r) => acc + (r.f62 !== '-' ? Number(r.f62) / 1e8 : 0), 0)
  );

  // 估算全天成交额（若当前在盘中 09:30–15:00，按已交易分钟线性折算）
  const now = new Date();
  const hhmm = now.getHours() * 60 + now.getMinutes();
  let elapsedMin = 240;
  if (hhmm >= 570 && hhmm <= 690) elapsedMin = Math.max(5, hhmm - 570);
  else if (hhmm > 690 && hhmm < 780) elapsedMin = 120;
  else if (hhmm >= 780 && hhmm <= 900) elapsedMin = 120 + (hhmm - 780);
  const twoMarketAmtYi = sentiment?.twoMarketAmtYi ?? null;
  const estFullDayAmtYi =
    twoMarketAmtYi != null && elapsedMin < 238 ? round2((twoMarketAmtYi / elapsedMin) * 240) : twoMarketAmtYi;

  // 仅在情绪快照获取到真实有效原始字段时才记录情绪节点链（严禁把失败空值记为有效节点）
  const sentimentRawOk = Boolean(
    sentiment &&
      sentiment.valid !== false &&
      (sentiment.redRatePct != null || sentiment.ztCount != null || sentiment.dtCount != null || sentiment.twoMarketAmtYi != null)
  );
  const sentimentNode = sentimentRawOk ? recordSentimentNodeSnapshot(sentiment, actualDate) : null;

  const mapSector = (r) => ({
    secid: `90.${r.f12}`,
    code: String(r.f12 || ''),
    name: String(r.f14 || ''),
    pct: r.f3 !== '-' ? round2(r.f3) : null,
    mainNetYi: r.f62 !== '-' ? toYi(r.f62) : null,
    mainNetPct: r.f184 !== '-' ? round2(r.f184) : null,
    leaderName: String(r.f128 || ''),
    leaderPct: r.f136 !== '-' ? round2(r.f136) : null,
    leaderCode: String(r.f140 || ''),
    ztCount: (limitPools?.clustersGe3 || []).find((c) => c.industry === String(r.f14 || ''))?.count || 0,
  });

  const concepts = (conceptFlows.rows || [])
    .filter((r) => r.f14 && !NON_THEME_CONCEPT_RE.test(String(r.f14)))
    .slice(0, 16)
    .map(mapSector);
  const industries = (industryFlows.rows || []).map(mapSector);
  const themeRotation6d = recordThemeRotationDay(actualDate, concepts.length ? concepts : industries);

  const gainers = (gainersRes.rows || []).map(mapStockRow);
  const losers = (losersRes.rows || []).map(mapStockRow);
  const mainInflows = (inflowRes.rows || []).map(mapStockRow);
  const mainOutflows = (outflowRes.rows || []).map(mapStockRow);

  // 连板榜（按板高降序）
  const lianbanList = allZtStocks
    .sort((a, b) => (b.lbc || 1) - (a.lbc || 1) || String(a.firstSealTime || '').localeCompare(String(b.firstSealTime || '')))
    .slice(0, 20)
    .map((s) => ({
      secid: codeToSecid(s.code),
      code: s.code,
      name: s.name,
      price: s.price,
      pct: s.pct,
      lbc: s.lbc,
      stat: s.stat,
      boardStyle: s.boardStyle,
      firstSealTime: s.firstSealTime,
      industry: s.industry,
      amountYi: s.amountYi,
    }));

  // 4 列迷你分时瀑布流（Sparkline Intraday Wall，每列 6 只 = 24 只，并发限流抓分时）
  const sparkGroupsDef = [
    {
      id: 'lianban_leaders',
      titleZh: '连板情绪先锋',
      titleEn: 'Board Streak Leaders',
      stocks: lianbanList.slice(0, 6),
    },
    {
      id: 'main_inflow',
      titleZh: '主力净流入抢筹',
      titleEn: 'Top Capital Inflows',
      stocks: mainInflows.slice(0, 6),
    },
    {
      id: 'top_gainers',
      titleZh: '盘面大肉强势',
      titleEn: 'Top Intraday Gainers',
      stocks: gainers.slice(0, 6),
    },
    {
      id: 'top_losers',
      titleZh: '盘面大面承压',
      titleEn: 'Top Pullback / Risk',
      stocks: losers.slice(0, 6),
    },
  ];

  // 去重批量抓取分时曲线（最多 24 只，6 并发，速度 ~1s）
  const uniqueSparkSecids = [];
  const seenSpark = new Set();
  for (const g of sparkGroupsDef) {
    for (const s of g.stocks) {
      if (s.secid && !seenSpark.has(s.secid)) {
        seenSpark.add(s.secid);
        uniqueSparkSecids.push(s.secid);
      }
    }
  }
  const sparkIntraMap = new Map();
  const intraResults = await mapWithConcurrency(uniqueSparkSecids, 6, async (secid) => {
    const intra = await fetchIntradayWithVolume(secid, 'CN', 42);
    return { secid, intra };
  });
  for (const r of intraResults) {
    if (r && r.secid && r.intra) sparkIntraMap.set(r.secid, r.intra);
  }

  const sparklineWall = sparkGroupsDef.map((g) => ({
    id: g.id,
    titleZh: g.titleZh,
    titleEn: g.titleEn,
    items: g.stocks.map((s) => ({
      ...s,
      intraday: sparkIntraMap.get(s.secid) || { available: false, points: [] },
    })),
  }));

  const fetchedIso = nowOffsetISO();
  const benchmarksOk = Array.isArray(benchmarks) && benchmarks.length > 0;
  const sentimentOk = Boolean(
    sentiment &&
      sentiment.valid !== false &&
      (sentiment.redRatePct != null || sentiment.ztCount != null || sentiment.dtCount != null || sentiment.twoMarketAmtYi != null)
  );
  const limitPoolsOk = Boolean(limitPools && limitPools.actualDate);
  const sectorsOk = concepts.length > 0 || industries.length > 0;
  if (!benchmarksOk && !sectionErrors.benchmarks) sectionErrors.benchmarks = '核心指数未返回数据';
  if (!sentimentOk && !sectionErrors.sentiment) sectionErrors.sentiment = '市场宽度与情绪快照不可用';
  if (!limitPoolsOk && !sectionErrors.limitPools) sectionErrors.limitPools = '涨跌停与连板池不可用';
  if (!sectorsOk && !sectionErrors.sectors) sectionErrors.sectors = '热点板块与资金流不可用';

  const degradedSections = Object.keys(sectionErrors);
  const allCoreFailed = !benchmarksOk && !sentimentOk && !limitPoolsOk;
  const dataStatus = allCoreFailed
    ? 'error'
    : degradedSections.length > 0
    ? 'degraded'
    : isCnMarketTradingHours(now)
    ? 'live'
    : 'delayed';
  // 数据时点必须来源于真实上游行情时间戳，不可用服务端抓取墙钟伪装新鲜行情
  const intraAsOf =
    sseIntra?.available && sseIntra?.tradeDate && sseIntra?.lastTime
      ? `${sseIntra.tradeDate} ${sseIntra.lastTime}`
      : sseIntra?.available && sseIntra?.lastTime
      ? sseIntra.lastTime
      : null;
  const benchAsOf = benchmarksOk ? benchmarks.find((b) => b.tradeTime)?.tradeTime || null : null;
  const asOf = intraAsOf || benchAsOf || (sentimentOk ? sentiment?.sourceAsOf || null : null) || (limitPoolsOk ? limitPools.actualDate : null);

  // 同步记录今日周期快照（仅在真实获取到涨跌停/情绪数据时写入，不写入伪造值）
  if (sentimentOk || limitPoolsOk) {
    const cycleEntry = {
      date: actualDate,
      maxBoard: sentimentOk ? sentiment?.maxBoard ?? limitPools?.maxBoard ?? null : limitPools?.maxBoard ?? null,
      secondBoard: (limitPools?.boardLadder || [])[1]?.board ?? null,
      ztCount: sentimentOk ? sentiment?.ztCount ?? limitPools?.ztCount ?? null : limitPools?.ztCount ?? null,
      dtCount: sentimentOk ? sentiment?.dtCount ?? limitPools?.dtCount ?? null : limitPools?.dtCount ?? null,
      zbCount: sentimentOk ? sentiment?.zbCount ?? limitPools?.zbCount ?? null : limitPools?.zbCount ?? null,
      lianbanCount: sentimentOk ? sentiment?.lianbanCount ?? limitPools?.lianbanCount ?? null : limitPools?.lianbanCount ?? null,
      sealRatePct: sentimentOk ? sentiment?.sealRatePct ?? limitPools?.sealRatePct ?? null : limitPools?.sealRatePct ?? null,
      redRatePct: sentimentOk ? sentiment?.redRatePct ?? null : null,
      sentimentScore: sentimentOk ? sentiment?.sentimentScore ?? null : null,
      twoMarketAmtYi,
      yestZtPremiumPct: yestPerf.avgPct,
      yestLianbanPremiumPct: yestPerf.lianbanAvgPct,
    };
    upsertCycleSnapshot(cycleEntry);
  }

  const payload = {
    ok: !allCoreFailed,
    source: 'eastmoney_tencent_free',
    dataStatus,
    isCached: false,
    cacheAgeSec: 0,
    asOf,
    fetchedAt: fetchedIso,
    tradeDate: actualDate,
    degradedSections,
    sectionErrors,
    temperature: {
      sentimentScore: sentiment?.sentimentScore ?? null,
      stage: sentiment?.stage ?? null,
      node: sentimentNode?.current || null,
      twoMarketAmtYi,
      estFullDayAmtYi,
      mainNetSumYi: sectorsOk ? industryNetSumYi : null,
      up: sentiment?.up ?? null,
      down: sentiment?.down ?? null,
      flat: sentiment?.flat ?? null,
      redRatePct: sentiment?.redRatePct ?? null,
      ztCount: sentiment?.ztCount ?? limitPools?.ztCount ?? null,
      dtCount: sentiment?.dtCount ?? limitPools?.dtCount ?? null,
      zbCount: sentiment?.zbCount ?? limitPools?.zbCount ?? null,
      zt20cmCount: gainersRes.rows?.length ? zt20cmCount : null,
      sealRatePct: sentiment?.sealRatePct ?? limitPools?.sealRatePct ?? null,
      burstRatePct: sentiment?.burstRatePct ?? limitPools?.burstRatePct ?? null,
      lianbanCount: sentiment?.lianbanCount ?? limitPools?.lianbanCount ?? null,
      maxBoard: sentiment?.maxBoard ?? limitPools?.maxBoard ?? null,
      yestZtPremiumPct: yestPerf.avgPct,
      yestLianbanPremiumPct: yestPerf.lianbanAvgPct,
      totalMarketStocks: over5Res.total || under5Res.total || null,
    },
    benchmarks,
    indexIntraday: {
      sse: sseIntra,
      chinext: chinextIntra,
    },
    telegraph,
    concepts,
    industries,
    clustersGe3: limitPools?.clustersGe3 || [],
    themeRotation6d,
    leaderboards: {
      anomalies: (anomalyBrief.items || []).slice(0, 16),
      lianban: lianbanList,
      gainers,
      losers,
      mainInflows,
      mainOutflows,
    },
    sparklineWall,
  };
  return allCoreFailed ? payload : setCached(cacheKey, payload);
}

// ============================================================================
// 2. 弈盘风格：连板天梯 & 4 联短线龙头情绪周期
// ============================================================================

function upsertCycleSnapshot(entry) {
  if (!entry || !entry.date) return [];
  const store = readJsonSafe(CYCLE_HISTORY_PATH, { history: [] });
  let history = Array.isArray(store.history) ? store.history : [];

  // 首次初始化时可从《研判与复盘台账》历史日度复盘提取明确写出的真实字段，绝不用公式编造缺失指标（缺失一律严格标 null）
  if (history.length < 3) {
    try {
      const ws = loadWorkspace();
      for (const dr of ws.ledger.dailyReviews || []) {
        if (!dr.date || history.some((h) => h.date === dr.date)) continue;
        const text = dr.rawMarkdown || '';
        const ztM = text.match(/涨停[^\d]{0,6}(\d{1,3})/);
        const dtM = text.match(/跌停[^\d]{0,6}(\d{1,3})/);
        const zbM = text.match(/炸板[^\d]{0,6}(\d{1,3})/);
        const mbM = text.match(/(\d{1,2})\s*(?:连板|板高度|最高板)/);
        const amtM = text.match(/(\d(?:\.\d{1,2})?)\s*万亿/);
        const scoreVal = dr.score != null && Number.isFinite(Number(dr.score)) ? Math.round(Number(dr.score) * 10) : null;
        if (!ztM && !dtM && !mbM && !amtM && scoreVal == null) continue;
        history.push({
          date: dr.date,
          maxBoard: mbM ? Number(mbM[1]) : null,
          secondBoard: null,
          ztCount: ztM ? Number(ztM[1]) : null,
          dtCount: dtM ? Number(dtM[1]) : null,
          zbCount: zbM ? Number(zbM[1]) : null,
          lianbanCount: null,
          sealRatePct: null,
          redRatePct: null,
          sentimentScore: scoreVal,
          twoMarketAmtYi: amtM ? round2(Number(amtM[1]) * 10000) : null,
          yestZtPremiumPct: null,
          yestLianbanPremiumPct: null,
          fromLedger: true,
        });
      }
    } catch {
      // ignore
    }
  }

  const idx = history.findIndex((h) => h.date === entry.date);
  if (idx >= 0) history[idx] = { ...history[idx], ...entry, fromLedger: false };
  else history.push(entry);
  history.sort((a, b) => a.date.localeCompare(b.date));
  history = history.slice(-60);
  writeJsonSafe(CYCLE_HISTORY_PATH, { updatedAt: nowOffsetISO(), history });
  return history;
}

async function fetchBoardLadderAndCycle(dateParam = '') {
  const cleanDate = /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
    ? dateParam.replace(/-/g, '')
    : /^\d{8}$/.test(dateParam)
    ? dateParam
    : formatYYYYMMDD(new Date());

  const cacheKey = `ladder_${cleanDate}`;
  const hit = getCached(cacheKey, 20000);
  if (hit) return hit;

  // 拉取全量涨停池（含1板首板！比 market-fetcher 的 lbc>=2 更全）
  const [ztJson, dtJson, zbJson] = await Promise.all([
    fetchJson(`https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=lbc:desc&date=${cleanDate}`, 8500).catch(() => null),
    fetchJson(`https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fund:asc&date=${cleanDate}`, 8000).catch(() => null),
    fetchJson(`https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt:asc&date=${cleanDate}`, 8000).catch(() => null),
  ]);

  const rawQDate = String(ztJson?.data?.qdate || cleanDate);
  const actualDate =
    rawQDate.length === 8 ? `${rawQDate.slice(0, 4)}-${rawQDate.slice(4, 6)}-${rawQDate.slice(6, 8)}` : nowOffsetISO().slice(0, 10);

  // 拉取昨日涨停池用于精确计算逐级晋级率（如 3板晋级率 = 今日3板数 / 昨日2板数）
  const prevDateYYYYMMDD = prevWeekdayYYYYMMDD(actualDate);
  const yestRes = await fetchYesterdayZtPool(prevDateYYYYMMDD);
  const yestCountByBoard = new Map();
  for (const s of yestRes.pool || []) {
    const b = Number(s.lbc || 1);
    yestCountByBoard.set(b, (yestCountByBoard.get(b) || 0) + 1);
  }

  const fmtTime = (val) => {
    const s = String(val || '').padStart(6, '0');
    return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
  };

  const ztPool = ztJson?.data?.pool || [];
  const dtPool = dtJson?.data?.pool || [];
  const zbPool = zbJson?.data?.pool || [];

  const byBoard = new Map();
  const themeCounts = new Map();

  for (const s of ztPool) {
    const lbc = Number(s.lbc || 1);
    const fbt = fmtTime(s.fbt);
    const lbt = fmtTime(s.lbt);
    const zbc = Number(s.zbc || 0);
    const hs = round2(Number(s.hs || 0));
    const industry = String(s.hybk || '其他').trim();

    let boardStyle = '换手';
    if (fbt === '09:25' && zbc === 0 && (hs == null || hs < 5)) boardStyle = '一字';
    else if (fbt === '09:25' && zbc > 0) boardStyle = 'T字';
    else if (zbc >= 2) boardStyle = `烂板(${zbc}炸)`;

    const card = {
      secid: codeToSecid(s.c),
      code: String(s.c),
      name: String(s.n),
      price: round2(Number(s.p) / 1000),
      pct: round2(Number(s.zdp)),
      lbc,
      stat: s.zttj ? `${s.zttj.days}天${s.zttj.ct}板` : `${lbc}板`,
      firstSealTime: fbt,
      lastSealTime: lbt,
      openCount: zbc,
      turnoverPct: hs,
      amountYi: round2(Number(s.amount || 0) / 1e8),
      sealFundYi: round2(Number(s.fund || 0) / 1e8),
      boardStyle,
      industry,
      is20cm: String(s.c).startsWith('30') || String(s.c).startsWith('688'),
    };

    if (!byBoard.has(lbc)) byBoard.set(lbc, []);
    byBoard.get(lbc).push(card);
    themeCounts.set(industry, (themeCounts.get(industry) || 0) + 1);
  }

  const levels = [...byBoard.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([board, stocks]) => {
      stocks.sort((a, b) => a.firstSealTime.localeCompare(b.firstSealTime));
      const prevDenominator = board > 1 ? yestCountByBoard.get(board - 1) || 0 : 0;
      const promotionRatePct =
        board > 1 && prevDenominator > 0 ? round2((stocks.length / prevDenominator) * 100) : null;
      return {
        board,
        count: stocks.length,
        prevCount: prevDenominator,
        promotionRatePct,
        stocks,
      };
    });

  const themes = [...themeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const ztCount = ztPool.length;
  const dtCount = dtPool.length;
  const zbCount = zbPool.length;
  const sealRatePct = ztCount + zbCount > 0 ? round2((ztCount / (ztCount + zbCount)) * 100) : null;
  const maxBoard = levels.length ? levels[0].board : 0;
  const secondBoard = levels.length > 1 ? levels[1].board : Math.max(0, maxBoard - 1);
  const lianbanCount = ztPool.filter((s) => Number(s.lbc || 1) >= 2).length;

  const yestPerf = await fetchYesterdayZtPerformance(prevDateYYYYMMDD);
  const history = upsertCycleSnapshot({
    date: actualDate,
    maxBoard,
    secondBoard,
    ztCount,
    dtCount,
    zbCount,
    lianbanCount,
    sealRatePct,
    yestZtPremiumPct: yestPerf.avgPct,
    yestLianbanPremiumPct: yestPerf.lianbanAvgPct,
  });

  return setCached(cacheKey, {
    ok: true,
    fetchedAt: nowOffsetISO(),
    tradeDate: actualDate,
    summary: {
      ztCount,
      dtCount,
      zbCount,
      lianbanCount,
      maxBoard,
      sealRatePct,
      yestZtPremiumPct: yestPerf.avgPct,
      yestLianbanPremiumPct: yestPerf.lianbanAvgPct,
    },
    themes,
    levels,
    zbStocks: zbPool.slice(0, 24).map((s) => ({
      secid: codeToSecid(s.c),
      code: String(s.c),
      name: String(s.n),
      pct: round2(Number(s.zdp)),
      firstSealTime: fmtTime(s.fbt),
      openCount: Number(s.zbc || 1),
      industry: String(s.hybk || '其他'),
    })),
    dtStocks: dtPool.slice(0, 24).map((s) => ({
      secid: codeToSecid(s.c),
      code: String(s.c),
      name: String(s.n),
      pct: round2(Number(s.zdp)),
      days: Number(s.lbc || 1),
      industry: String(s.hybk || '其他'),
    })),
    cycleHistory: history,
  });
}

// ============================================================================
// 3. 弈盘风格异动中心：10日(+100%) / 30日(+200%) 严重异动精确测算 + 重点监控联动
// ============================================================================

async function fetchBenchmarkCloseMap(secid) {
  const key = `bench_k_${secid}`;
  const hit = getCached(key, 10 * 60 * 1000);
  if (hit) return hit;
  const klines = await fetchMultiTimeframeKlines(secid, 'CN', 'day', 45);
  const byDate = new Map();
  for (const k of klines) byDate.set(k.date, k.close);
  return setCached(key, { klines, byDate });
}

function calcDeviationWindow(stockKlines, benchByDate, windowDays) {
  if (!Array.isArray(stockKlines) || stockKlines.length < 3) return null;
  const n = Math.min(windowDays, stockKlines.length - 1);
  const last = stockKlines[stockKlines.length - 1];
  const base = stockKlines[stockKlines.length - 1 - n];
  if (!base || !base.close || base.close <= 0) return null;

  const stockRetPct = ((last.close - base.close) / base.close) * 100;
  const bLast = benchByDate.get(last.date);
  const bBase = benchByDate.get(base.date);
  const benchRetPct = bLast && bBase && bBase > 0 ? ((bLast - bBase) / bBase) * 100 : 0;
  const deviationPct = stockRetPct - benchRetPct;

  return {
    windowDays: n,
    startDate: base.date,
    endDate: last.date,
    stockRetPct: round2(stockRetPct),
    benchRetPct: round2(benchRetPct),
    deviationPct: round2(deviationPct),
  };
}

async function computeSingleStockAnomaly(secid, hintName = '', hintLbc = 0, regMap = new Map()) {
  const cleanSecid = String(secid || '').trim();
  const code = cleanSecid.split('.')[1] || '';
  if (!/^\d{6}$/.test(code)) return null;
  const bInfo = boardTypeFromCode(code);

  const [klines, benchData, qRes] = await Promise.all([
    fetchMultiTimeframeKlines(cleanSecid, 'CN', 'day', 40).catch(() => []),
    fetchBenchmarkCloseMap(bInfo.benchSecid).catch(() => ({ klines: [], byDate: new Map() })),
    fetchJson(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14,f8,f6&secids=${encodeURIComponent(cleanSecid)}`, 5500).catch(() => null),
  ]);
  if (!klines || klines.length < 4) return null;

  const q = qRes?.data?.diff?.[0];
  const name = q?.f14 || hintName || code;
  const price = q && q.f2 !== '-' ? round2(q.f2) : klines[klines.length - 1].close;
  const pct = q && q.f3 !== '-' ? round2(q.f3) : klines[klines.length - 1].pct;

  // 在滚动窗口内搜索最逼近 10日+100% 和 30日+200% 的窗口（交易所规则为连续10个交易日内任意点达+100%即触发）
  let maxDev10 = calcDeviationWindow(klines, benchData.byDate, 10);
  for (let w = 4; w <= Math.min(10, klines.length - 1); w++) {
    const cand = calcDeviationWindow(klines, benchData.byDate, w);
    if (cand && (!maxDev10 || cand.deviationPct > maxDev10.deviationPct)) maxDev10 = cand;
  }
  let maxDev30 = calcDeviationWindow(klines, benchData.byDate, 30);
  for (let w = 11; w <= Math.min(30, klines.length - 1); w++) {
    const cand = calcDeviationWindow(klines, benchData.byDate, w);
    if (cand && (!maxDev30 || cand.deviationPct > maxDev30.deviationPct)) maxDev30 = cand;
  }

  const dev10 = maxDev10?.deviationPct ?? 0;
  const dev30 = maxDev30?.deviationPct ?? 0;
  const gapTo100Pct = round2(100 - dev10);
  const gapTo200Pct = round2(200 - dev30);

  // 计算下个交易日触发 10 日严重异动参考涨幅近似值（仅供参考，非交易所官方标准）
  const limitPct = bInfo.is20cm ? 20 : 10;
  const nextDaySafeMaxPct = gapTo100Pct <= 0 ? 0 : round2(Math.min(limitPct, Math.max(0, (100 - dev10) / (1 + Math.max(0, maxDev10?.stockRetPct || 0) / 100))));

  // 统计近10日内触发3日偏离（扣减对应基准指数3日涨跌幅）>= 20%/30%（普通异动参考）次数
  let recentNormalAnomalies = 0;
  const tail12 = klines.slice(-13);
  for (let i = 3; i < tail12.length; i++) {
    const r3 = ((tail12[i].close - tail12[i - 3].close) / tail12[i - 3].close) * 100;
    const bEnd = benchData.byDate.get(tail12[i].date);
    const bStart = benchData.byDate.get(tail12[i - 3].date);
    const b3 = bEnd && bStart && bStart > 0 ? ((bEnd - bStart) / bStart) * 100 : 0;
    const dev3 = r3 - b3;
    if (dev3 >= (bInfo.is20cm ? 30 : 20)) recentNormalAnomalies += 1;
  }

  const regHit = regMap.get(code) || checkRegulatoryRedline(code, name);
  const isRegMonitored = Boolean(regHit && (regHit.hit || regHit.code));

  let riskLevel = 'safe';
  let statusText = '安全区间';
  if (dev10 >= 100 || dev30 >= 200 || isRegMonitored) {
    riskLevel = 'triggered';
    statusText = isRegMonitored ? '重点监控红线（卡片174）' : dev10 >= 100 ? '已触及10日+100%严重异动' : '已触及30日+200%严重异动';
  } else if (gapTo100Pct <= 15 || gapTo200Pct <= 25 || recentNormalAnomalies >= 4) {
    riskLevel = 'critical';
    statusText = gapTo100Pct <= 15 ? `距10日严重异动仅差 ${gapTo100Pct}%` : recentNormalAnomalies >= 4 ? `10日内${recentNormalAnomalies}次异动临近红线` : `距30日严重异动仅差 ${gapTo200Pct}%`;
  } else if (gapTo100Pct <= 35 || gapTo200Pct <= 55) {
    riskLevel = 'warning';
    statusText = `加速逼近异动阈值（余量 ${Math.min(gapTo100Pct, gapTo200Pct)}%）`;
  }

  return {
    secid: cleanSecid,
    code,
    name,
    board: bInfo.board,
    benchName: bInfo.benchName,
    price,
    pct,
    lbc: hintLbc,
    dev10dPct: dev10,
    dev30dPct: dev30,
    progress10Pct: round2(Math.min(120, Math.max(0, dev10))),
    progress30Pct: round2(Math.min(120, Math.max(0, (dev30 / 200) * 100))),
    gapTo100Pct,
    gapTo200Pct,
    nextDaySafeMaxPct,
    recentNormalAnomalies,
    isRegMonitored,
    regReason: regHit?.hits?.[0]?.reason || regHit?.reason || '',
    regEndDate: regHit?.hits?.[0]?.endDate || regHit?.endDate || '',
    riskLevel,
    statusText,
    window10: maxDev10,
    window30: maxDev30,
  };
}

async function fetchAnomalyAnnouncements(code) {
  try {
    const json = await fetchJson(
      `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=12&page_index=1&ann_type=A&client_source=web&stock_list=${encodeURIComponent(code)}&f_node=0&s_node=0`,
      6000
    );
    const list = json?.data?.list || [];
    return list
      .filter((a) => /异常波动|严重异常|停牌|核查|风险提示|监管/.test(String(a.title || '')))
      .slice(0, 4)
      .map((a) => ({
        date: String(a.notice_date || a.display_time || '').slice(0, 10),
        title: String(a.title || '').trim(),
        url: a.art_code ? `https://data.eastmoney.com/notices/detail/${code}/${a.art_code}.html` : '',
      }));
  } catch {
    return [];
  }
}

async function fetchAnomalyCenter(singleQuery = null, opts = {}) {
  // 1) 单股即时测算模式
  if (singleQuery && String(singleQuery).trim()) {
    const q = String(singleQuery).trim();
    let secid = /^\d+\.[A-Za-z0-9._-]+$/.test(q) ? q : '';
    let hintName = '';
    if (!secid) {
      const resolved = await resolveStockQuery(q);
      if (resolved?.resolved && resolved.marketKind === 'CN') {
        secid = resolved.secid;
        hintName = resolved.name;
      }
    }
    if (!secid) throw new Error(`未找到 A 股标的：${q}`);
    const item = await computeSingleStockAnomaly(secid, hintName, 0);
    if (!item) throw new Error(`未能获取 ${q} 的近30日K线进行偏离测算`);
    item.announcements = await fetchAnomalyAnnouncements(item.code);
    return { ok: true, single: item, fetchedAt: nowOffsetISO() };
  }

  const ctx = opts.contextSnapshot || captureWorkspaceWatchlistContext();
  const cacheKey = `${opts.light ? 'anomaly_center_light' : 'anomaly_center_full'}::${ctx.scopeHash}`;
  if (!opts.forceRefresh) {
    const hit = getCached(cacheKey, 60000);
    if (hit) return hit;
  }

  const todayYYYYMMDD = formatYYYYMMDD(new Date());
  const regStore = ctx.regStore;
  const wl = ctx.wl;
  const [limitPools, strongRes] = await Promise.all([
    fetchLimitPools(todayYYYYMMDD).catch(() => null),
    fetchJson(
      `https://push2ex.eastmoney.com/getTopicQSPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=40&sort=zdp:desc&date=${todayYYYYMMDD}`,
      7000
    ).catch(() => null),
  ]);

  const candidates = new Map(); // secid -> { name, lbc }
  // 加入本地卡片 174 监管红线标的
  for (const r of regStore.items || []) {
    if (r.active === false || !r.code) continue;
    const s = codeToSecid(r.code);
    if (s) candidates.set(s, { name: r.name, lbc: 0 });
  }
  // 加入所有高连板股（>=2板）
  for (const lvl of limitPools?.boardLadder || []) {
    for (const st of lvl.stocks || []) {
      const s = codeToSecid(st.code);
      if (s) candidates.set(s, { name: st.name, lbc: st.lbc || lvl.board });
    }
  }
  // 加入东财强势股池前 18 只
  for (const st of (strongRes?.data?.pool || []).slice(0, opts.light ? 8 : 18)) {
    const s = codeToSecid(st.c);
    if (s && !candidates.has(s)) candidates.set(s, { name: st.n, lbc: Number(st.zttj?.ct || 0) });
  }
  // 加入用户 A 股自选
  for (const w of wl.items || []) {
    if (w.marketKind === 'CN' && w.secid && !candidates.has(w.secid)) {
      candidates.set(w.secid, { name: w.name, lbc: 0 });
    }
  }

  const candList = [...candidates.entries()].slice(0, opts.light ? 14 : 32);
  const computed = await mapWithConcurrency(candList, 6, async ([secid, meta]) =>
    computeSingleStockAnomaly(secid, meta.name, meta.lbc)
  );

  const items = computed
    .filter((x) => x && !x.error)
    .sort((a, b) => {
      const rank = { triggered: 3, critical: 2, warning: 1, safe: 0 };
      return (
        rank[b.riskLevel] - rank[a.riskLevel] ||
        Math.max(b.dev10dPct, b.dev30dPct / 2) - Math.max(a.dev10dPct, a.dev30dPct / 2)
      );
    });

  // 为前 6 只高风险标的并发抓近期异动/核查公告
  if (!opts.light) {
    await mapWithConcurrency(items.slice(0, 6), 4, async (it) => {
      it.announcements = await fetchAnomalyAnnouncements(it.code);
    });
  }

  return setCached(cacheKey, {
    ok: true,
    fetchedAt: nowOffsetISO(),
    summary: {
      scannedCount: items.length,
      triggeredCount: items.filter((x) => x.riskLevel === 'triggered').length,
      criticalCount: items.filter((x) => x.riskLevel === 'critical').length,
      warningCount: items.filter((x) => x.riskLevel === 'warning').length,
      manualRedlineCount: (regStore.items || []).filter((x) => x.active !== false && x.code).length,
    },
    items,
    regulatoryList: regStore.items || [],
  });
}

// ============================================================================
// 4. 弈盘风格：题材小表格（产业链拆解）+ K 线拖拽区间统计
// ============================================================================

async function fetchThemeConstituents(boardCode, limit = 36) {
  const cleanCode = String(boardCode || '').replace(/^90\./, '').trim();
  if (!cleanCode) return [];
  const res = await fetchClistRows(`b:${cleanCode}+f:!50`, 'f3', 1, limit);
  return (res.rows || []).map(mapStockRow);
}

function buildCognitionChainTables() {
  try {
    const ws = loadWorkspace();
    const byTheme = new Map();
    for (const card of ws.cognition.cards || []) {
      if (card.status === '归档') continue;
      const domain = String(card.domain || '前沿产业').trim();
      if (!byTheme.has(domain)) byTheme.set(domain, []);
      const codes = new Set();
      const raw = `${card.title} ${card.mapping || ''} ${card.facts || ''}`;
      for (const m of raw.matchAll(/\b((?:00|30|60|68)\d{4})\b/g)) codes.add(m[1]);
      byTheme.get(domain).push({
        cardId: card.id,
        title: card.title,
        grade: card.grade,
        summary: String(card.facts || card.analysis || '').slice(0, 120),
        mappingText: String(card.mapping || '').slice(0, 140),
        codes: [...codes],
      });
    }
    return [...byTheme.entries()]
      .filter(([, cards]) => cards.length > 0)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 14)
      .map(([domain, cards]) => ({ domain, cardCount: cards.length, cards: cards.slice(0, 8) }));
  } catch {
    return [];
  }
}

const NON_THEME_CONCEPT_RE = /融资融券|深股通|沪股通|MSCI|富时罗素|标准普尔|机构重仓|基金重仓|基金减仓|大盘|小盘|中盘|微盘|昨日|HS300|深成500|创业板综|中证500|中证1000|破净|预盈|预增|中报|季报|年报|ST股|转债|百元股|低价股|高价股|证金|社保|QFII|送转|分红|AB股|风格|成长|价值|蓝筹|白马|次新|注册制|新股|涨停|跌停|高振幅|放量/;

function getCustomThemesFilePath() {
  return workspaceStateFile('custom-themes.local.json');
}

function loadCustomThemesStore() {
  const filePath = getCustomThemesFilePath();
  const raw = readJsonSafe(filePath, null);
  const pinnedCodes = Array.isArray(raw?.pinnedCodes)
    ? [...new Set(raw.pinnedCodes.map((x) => String(x || '').trim()).filter(Boolean))]
    : [];
  const customThemes = Array.isArray(raw?.customThemes)
    ? raw.customThemes
        .filter((t) => t && typeof t === 'object' && t.id && t.name)
        .map((t) => ({
          id: String(t.id),
          code: `custom:${t.id}`,
          name: String(t.name).trim(),
          thesis: String(t.thesis || '').trim(),
          kind: 'custom',
          stocks: Array.isArray(t.stocks)
            ? t.stocks
                .filter((s) => s && (s.secid || s.code))
                .map((s) => {
                  const code = String(s.code || String(s.secid || '').replace(/^\d+\./, '')).trim();
                  const secid = String(s.secid || codeToSecid(code)).trim();
                  return { secid, code, name: String(s.name || code).trim() };
                })
                .filter((s) => s.secid)
            : [],
          createdAt: t.createdAt || null,
          updatedAt: t.updatedAt || null,
        }))
    : [];
  return {
    updatedAt: raw?.updatedAt || null,
    pinnedCodes,
    customThemes,
  };
}

function saveCustomThemesStore(store) {
  const filePath = getCustomThemesFilePath();
  const payload = {
    updatedAt: nowOffsetISO(),
    pinnedCodes: [...new Set((store.pinnedCodes || []).map((x) => String(x || '').trim()).filter(Boolean))],
    customThemes: (store.customThemes || []).map((t) => ({
      id: t.id,
      name: t.name,
      thesis: t.thesis || '',
      stocks: t.stocks || [],
      createdAt: t.createdAt || nowOffsetISO(),
      updatedAt: t.updatedAt || nowOffsetISO(),
    })),
  };
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
  return loadCustomThemesStore();
}

function saveCustomTheme(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('题材名称不能为空');
  const thesis = String(input.thesis || '').trim().slice(0, 400);
  const rawStocks = Array.isArray(input.stocks) ? input.stocks : [];
  const dedup = new Map();
  for (const s of rawStocks) {
    if (!s) continue;
    const code = String(s.code || String(s.secid || '').replace(/^\d+\./, '')).replace(/\.(SH|SZ|BJ)$/i, '').trim();
    const secid = String(s.secid || codeToSecid(code)).trim();
    if (!secid) continue;
    dedup.set(secid, { secid, code: code || secid.replace(/^\d+\./, ''), name: String(s.name || code).trim() });
  }
  const stocks = [...dedup.values()].slice(0, 60);
  const store = loadCustomThemesStore();
  const now = nowOffsetISO();
  const rawId = String(input.id || '').replace(/^custom:/, '').trim();
  let targetId = rawId;
  const idx = rawId ? store.customThemes.findIndex((t) => t.id === rawId) : -1;
  if (idx >= 0) {
    store.customThemes[idx] = {
      ...store.customThemes[idx],
      name,
      thesis,
      stocks,
      updatedAt: now,
    };
  } else {
    targetId = `ct_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
    store.customThemes.unshift({
      id: targetId,
      code: `custom:${targetId}`,
      name,
      thesis,
      kind: 'custom',
      stocks,
      createdAt: now,
      updatedAt: now,
    });
  }
  const saved = saveCustomThemesStore(store);
  const theme = saved.customThemes.find((t) => t.id === targetId) || null;
  return { ok: true, theme, store: saved };
}

function deleteCustomTheme(rawId) {
  const cleanId = String(rawId || '').replace(/^custom:/, '').trim();
  if (!cleanId) throw new Error('缺少自定义题材 ID');
  const store = loadCustomThemesStore();
  const before = store.customThemes.length;
  store.customThemes = store.customThemes.filter((t) => t.id !== cleanId);
  store.pinnedCodes = store.pinnedCodes.filter((c) => c !== `custom:${cleanId}`);
  const saved = saveCustomThemesStore(store);
  return { ok: true, deleted: saved.customThemes.length < before, store: saved };
}

function togglePinTheme(code) {
  const cleanCode = String(code || '').trim();
  if (!cleanCode) throw new Error('缺少板块或题材代码');
  const store = loadCustomThemesStore();
  const exists = store.pinnedCodes.includes(cleanCode);
  if (exists) {
    store.pinnedCodes = store.pinnedCodes.filter((c) => c !== cleanCode);
  } else {
    store.pinnedCodes = [cleanCode, ...store.pinnedCodes].slice(0, 40);
  }
  const saved = saveCustomThemesStore(store);
  return { ok: true, pinned: !exists, code: cleanCode, store: saved };
}

function mapBoardCatalogRow(r, kind) {
  const code = String(r.f12 || '').trim();
  const name = String(r.f14 || '').trim();
  return {
    code,
    secid: `90.${code}`,
    name,
    kind,
    isIndexLike: kind === 'concept' ? NON_THEME_CONCEPT_RE.test(name) : false,
    pct: r.f3 !== '-' && r.f3 != null ? round2(r.f3) : null,
    mainNetYi: r.f62 !== '-' && r.f62 != null ? toYi(r.f62) : null,
    leaderName: String(r.f128 || ''),
    leaderPct: r.f136 !== '-' && r.f136 != null ? round2(r.f136) : null,
  };
}

async function fetchPaginatedBoards(fsExpr, kind, maxPages = 8) {
  const first = await fetchClistRows(fsExpr, 'f3', 1, 100, 'f12,f13,f14,f2,f3,f62,f128,f136', 1).catch(() => ({ total: 0, rows: [] }));
  const allRows = [...(first.rows || [])];
  const total = Number(first.total || allRows.length || 0);
  const pageCount = Math.min(maxPages, Math.ceil(total / 100));
  if (pageCount > 1) {
    const restPages = [];
    for (let p = 2; p <= pageCount; p++) restPages.push(p);
    const extras = await mapWithConcurrency(restPages, 2, async (pn) => {
      const r = await fetchClistRows(fsExpr, 'f3', 1, 100, 'f12,f13,f14,f2,f3,f62,f128,f136', pn).catch(() => ({ rows: [] }));
      return r.rows || [];
    });
    for (const chunk of extras) allRows.push(...chunk);
  }
  const seen = new Set();
  const out = [];
  for (const r of allRows) {
    const item = mapBoardCatalogRow(r, kind);
    if (!item.code || !item.name || seen.has(item.code)) continue;
    seen.add(item.code);
    out.push(item);
  }
  out.sort((a, b) => (b.pct ?? -999) - (a.pct ?? -999));
  return out;
}

/**
 * 全市场题材与行业板块目录（分页抓取东财全部概念 450+ 与行业 86+，单飞去重 + 5 分钟内存缓存 + 磁盘降级兜底）
 */
async function fetchFullThemeCatalog(force = false) {
  const cacheKey = 'full_theme_catalog_v1';
  if (!force) {
    const hit = getCached(cacheKey, 5 * 60 * 1000);
    if (hit && hit.totalBoards > 0) return hit;
  }
  return memCache.singleflight(
    `${cacheKey}:sf`,
    5 * 60 * 1000,
    async () => {
      const [concepts, industries] = await Promise.all([
        fetchPaginatedBoards('m:90+t:3+f:!50', 'concept', 7),
        fetchPaginatedBoards('m:90+t:2+f:!50', 'industry', 4),
      ]);
      const payload = {
        fetchedAt: nowOffsetISO(),
        concepts,
        industries,
        totalConcepts: concepts.length,
        totalIndustries: industries.length,
        totalBoards: concepts.length + industries.length,
      };
      if (payload.totalBoards > 0) {
        setCached(cacheKey, payload);
        try {
          atomicWriteFileSync(THEME_CATALOG_DISK_CACHE_PATH, JSON.stringify(payload));
        } catch {
          // non-fatal disk cache write failure
        }
        return payload;
      }
      // 峰值时段上游瞬断时回退最近一次成功快照，避免目录归零
      const diskFallback = readJsonSafe(THEME_CATALOG_DISK_CACHE_PATH, null);
      if (diskFallback && Number(diskFallback.totalBoards) > 0) {
        return { ...diskFallback, isStaleFallback: true };
      }
      return payload;
    },
    { force, negTtlMs: 10000 }
  );
}

async function fetchCustomThemeConstituentsLive(stocks = []) {
  const secids = (stocks || []).map((s) => s.secid).filter(Boolean);
  if (!secids.length) return [];
  try {
    const fields = 'f12,f13,f14,f2,f3,f4,f6,f7,f8,f10,f62,f184';
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=${fields}&secids=${encodeURIComponent(secids.join(','))}`;
    const json = await fetchJson(url, 8000);
    const rows = Array.isArray(json?.data?.diff) ? json.data.diff : [];
    const bySecid = new Map();
    for (const r of rows) {
      const mapped = mapStockRow(r);
      bySecid.set(mapped.secid, mapped);
    }
    return stocks
      .map((s) => bySecid.get(s.secid) || {
        secid: s.secid,
        code: s.code,
        name: s.name || s.code,
        price: null,
        pct: null,
        amountYi: null,
        amplitudePct: null,
        turnoverPct: null,
        volumeRatio: null,
        mainNetYi: null,
        mainNetPct: null,
        is20cm: s.code.startsWith('30') || s.code.startsWith('688'),
      })
      .sort((a, b) => (b.pct ?? -999) - (a.pct ?? -999));
  } catch {
    return stocks.map((s) => ({
      secid: s.secid,
      code: s.code,
      name: s.name || s.code,
      price: null,
      pct: null,
      amountYi: null,
      amplitudePct: null,
      turnoverPct: null,
      volumeRatio: null,
      mainNetYi: null,
      mainNetPct: null,
      is20cm: s.code.startsWith('30') || s.code.startsWith('688'),
    }));
  }
}

async function searchThemeCatalog({ q = '', kind = 'all', limit = 80, includeIndexLike = true } = {}) {
  const catalog = await fetchFullThemeCatalog(false);
  const store = loadCustomThemesStore();
  const pinnedSet = new Set(store.pinnedCodes);
  const needle = String(q || '').trim().toLowerCase();
  const maxItems = Math.max(10, Math.min(200, Number(limit) || 80));

  const pool = [];
  if (kind === 'all' || kind === 'custom') {
    for (const ct of store.customThemes) {
      pool.push({
        code: ct.code,
        id: ct.id,
        secid: ct.code,
        name: ct.name,
        kind: 'custom',
        thesis: ct.thesis,
        stockCount: ct.stocks.length,
        stocks: ct.stocks,
        pct: null,
        mainNetYi: null,
        leaderName: ct.stocks[0]?.name || '',
        pinned: true,
      });
    }
  }
  if (kind === 'all' || kind === 'concept') {
    for (const c of catalog.concepts) {
      if (!needle && !includeIndexLike && c.isIndexLike) continue;
      pool.push({ ...c, pinned: pinnedSet.has(c.code) });
    }
  }
  if (kind === 'all' || kind === 'industry') {
    for (const ind of catalog.industries) {
      pool.push({ ...ind, pinned: pinnedSet.has(ind.code) });
    }
  }

  let matched = pool;
  if (needle) {
    matched = pool.filter((it) => {
      const hay = `${it.name} ${it.code} ${it.leaderName || ''} ${it.thesis || ''} ${(it.stocks || []).map((s) => `${s.name} ${s.code}`).join(' ')}`.toLowerCase();
      return hay.includes(needle);
    });
    matched.sort((a, b) => {
      const aExact = a.name.toLowerCase() === needle ? 0 : a.name.toLowerCase().startsWith(needle) ? 1 : 2;
      const bExact = b.name.toLowerCase() === needle ? 0 : b.name.toLowerCase().startsWith(needle) ? 1 : 2;
      if (aExact !== bExact) return aExact - bExact;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.pct ?? -999) - (a.pct ?? -999);
    });
  } else {
    matched.sort((a, b) => {
      if (a.kind === 'custom' && b.kind !== 'custom') return -1;
      if (b.kind === 'custom' && a.kind !== 'custom') return 1;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.pct ?? -999) - (a.pct ?? -999);
    });
  }

  return {
    ok: true,
    fetchedAt: catalog.fetchedAt,
    query: q,
    kind,
    totalCatalogCount: catalog.totalBoards + store.customThemes.length,
    totalConcepts: catalog.totalConcepts,
    totalIndustries: catalog.totalIndustries,
    customCount: store.customThemes.length,
    matchedTotal: matched.length,
    pinnedCodes: store.pinnedCodes,
    items: matched.slice(0, maxItems),
  };
}

async function fetchThemeMatrixAndRangeStats(params = {}) {
  const indexSecid = String(params.indexSecid || '1.000001').trim();
  const [catalog, indexKlines] = await Promise.all([
    fetchFullThemeCatalog(false).catch(() => ({ fetchedAt: nowOffsetISO(), concepts: [], industries: [], totalConcepts: 0, totalIndustries: 0, totalBoards: 0 })),
    fetchMultiTimeframeKlines(indexSecid, 'CN', 'day', 120).catch(() => []),
  ]);

  const customStore = loadCustomThemesStore();
  const pinnedSet = new Set(customStore.pinnedCodes);
  const allBoardsByCode = new Map();
  for (const b of [...catalog.concepts, ...catalog.industries]) {
    allBoardsByCode.set(b.code, b);
  }

  const hotThemes = catalog.concepts
    .filter((r) => r.name && !r.isIndexLike)
    .slice(0, 40)
    .map((r) => ({ ...r, pinned: pinnedSet.has(r.code) }));
  const hotIndustries = catalog.industries.map((r) => ({ ...r, pinned: pinnedSet.has(r.code) }));
  const pinnedThemes = customStore.pinnedCodes
    .map((code) => {
      const b = allBoardsByCode.get(code);
      return b ? { ...b, pinned: true } : null;
    })
    .filter(Boolean);

  const themePool = hotThemes.length > 0 ? hotThemes : hotIndustries;
  const requestedCode = String(params.themeCode || '').trim();
  const selectedThemeCode = requestedCode || pinnedThemes[0]?.code || themePool[0]?.code || '';

  let selectedThemeMeta = null;
  let constituents = [];

  if (selectedThemeCode.startsWith('custom:')) {
    const customId = selectedThemeCode.slice('custom:'.length);
    const ct = customStore.customThemes.find((x) => x.id === customId) || null;
    if (ct) {
      constituents = await fetchCustomThemeConstituentsLive(ct.stocks);
      const validPcts = constituents.map((s) => s.pct).filter((v) => v != null && Number.isFinite(v));
      const avgPct = validPcts.length ? round2(validPcts.reduce((a, b) => a + b, 0) / validPcts.length) : null;
      selectedThemeMeta = {
        id: ct.id,
        code: ct.code,
        secid: ct.code,
        name: ct.name,
        kind: 'custom',
        thesis: ct.thesis,
        stocks: ct.stocks,
        pct: avgPct,
        mainNetYi: round2(constituents.reduce((a, s) => a + (Number(s.mainNetYi) || 0), 0)),
        pinned: true,
      };
    }
  }

  if (!selectedThemeMeta) {
    selectedThemeMeta =
      allBoardsByCode.get(selectedThemeCode) ||
      themePool[0] ||
      null;
    if (selectedThemeMeta) {
      selectedThemeMeta = { ...selectedThemeMeta, pinned: pinnedSet.has(selectedThemeMeta.code) };
      constituents = await fetchThemeConstituents(selectedThemeMeta.code, 48).catch(() => []);
    }
  }

  // 按弈盘“题材小表格”逻辑分层拆解成分股
  const tiers = [
    {
      tier: '涨停 / 大肉先锋（≥+7%）',
      tierEn: 'Limit-Up & Pioneers (>= +7%)',
      stocks: constituents.filter((s) => (s.pct ?? -99) >= 7),
    },
    {
      tier: '主力强势趋势（+2% ~ +7%）',
      tierEn: 'Strong Trend (+2% ~ +7%)',
      stocks: constituents.filter((s) => (s.pct ?? -99) >= 2 && (s.pct ?? -99) < 7),
    },
    {
      tier: '容量中军 / 资金聚焦（成交≥10亿）',
      tierEn: 'Heavyweight Liquidity (>= 1B CNY)',
      stocks: constituents.filter((s) => (s.amountYi ?? 0) >= 10 && (s.pct ?? -99) < 7),
    },
    {
      tier: '跟风与低吸观察（< +2%）',
      tierEn: 'Laggards & Pullback Watch (< +2%)',
      stocks: constituents.filter((s) => (s.pct ?? 99) < 2).slice(0, 16),
    },
  ].filter((t) => t.stocks.length > 0);

  // 区间统计（按指定 startDate ~ endDate 或默认最近 10 个交易日）
  let startDate = String(params.startDate || '').trim();
  let endDate = String(params.endDate || '').trim();
  if (indexKlines.length >= 2) {
    if (!endDate) endDate = indexKlines[indexKlines.length - 1].date;
    if (!startDate) startDate = indexKlines[Math.max(0, indexKlines.length - 11)].date;
  }

  let indexRangePct = null;
  if (indexKlines.length >= 2 && startDate && endDate) {
    const slice = indexKlines.filter((k) => k.date >= startDate && k.date <= endDate);
    if (slice.length >= 2 && slice[0].open > 0) {
      indexRangePct = round2(((slice[slice.length - 1].close - slice[0].open) / slice[0].open) * 100);
    }
  }

  // 聚合候选池做真实区间涨幅统计：当前热点成分 + 用户自选 + 全A成交额前20核心容量票
  const topLiquidRes = await fetchClistRows('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', 'f6', 1, 20).catch(() => ({ rows: [] }));
  const wl = loadWatchlistConfig();
  const rangeCandidates = new Map();
  for (const s of (topLiquidRes.rows || []).map(mapStockRow)) {
    rangeCandidates.set(s.secid, { secid: s.secid, code: s.code, name: s.name, tag: '核心成交' });
  }
  for (const s of constituents.slice(0, 10)) {
    if (!rangeCandidates.has(s.secid)) {
      rangeCandidates.set(s.secid, { secid: s.secid, code: s.code, name: s.name, tag: selectedThemeMeta?.name || '热点题材' });
    }
  }
  for (const w of wl.items || []) {
    if (w.marketKind === 'CN' && !rangeCandidates.has(w.secid)) {
      rangeCandidates.set(w.secid, { secid: w.secid, code: w.code, name: w.name, tag: w.group || '自选' });
    }
  }

  const rangeStocks = (
    await mapWithConcurrency([...rangeCandidates.values()].slice(0, 26), 6, async (c) => {
      const ks = await fetchMultiTimeframeKlines(c.secid, 'CN', 'day', 120);
      const sl = ks.filter((k) => (!startDate || k.date >= startDate) && (!endDate || k.date <= endDate));
      if (sl.length < 2 || !sl[0].open) return null;
      const startClose = sl[0].open;
      const endClose = sl[sl.length - 1].close;
      const rangePct = round2(((endClose - startClose) / startClose) * 100);
      const maxH = Math.max(...sl.map((x) => x.high));
      const minL = Math.min(...sl.map((x) => x.low));
      const totalAmtYi = round2(sl.reduce((a, x) => a + (Number(x.amt) || 0), 0) / 1e8);
      return {
        ...c,
        startPrice: round2(startClose),
        endPrice: round2(endClose),
        rangePct,
        alphaVsIndexPct: indexRangePct != null && rangePct != null ? round2(rangePct - indexRangePct) : null,
        maxAmpPct: minL > 0 ? round2(((maxH - minL) / minL) * 100) : null,
        totalAmtYi,
        bars: sl.length,
      };
    })
  )
    .filter((x) => x && !x.error)
    .sort((a, b) => (b.rangePct ?? -999) - (a.rangePct ?? -999));

  // 热门板块区间涨幅（用 90.xxx 板块日 K 算区间收益）
  const rangeSectors = (
    await mapWithConcurrency(hotIndustries.slice(0, 12), 6, async (sec) => {
      const ks = await fetchMultiTimeframeKlines(sec.secid, 'CN', 'day', 120);
      const sl = ks.filter((k) => (!startDate || k.date >= startDate) && (!endDate || k.date <= endDate));
      if (sl.length < 2 || !sl[0].open) return null;
      const rangePct = round2(((sl[sl.length - 1].close - sl[0].open) / sl[0].open) * 100);
      return {
        ...sec,
        rangePct,
        alphaVsIndexPct: indexRangePct != null && rangePct != null ? round2(rangePct - indexRangePct) : null,
      };
    })
  )
    .filter((x) => x && !x.error)
    .sort((a, b) => (b.rangePct ?? -999) - (a.rangePct ?? -999));

  const themeHistoryStore = readJsonSafe(THEME_HISTORY_PATH, { days: [] });

  return {
    ok: true,
    fetchedAt: nowOffsetISO(),
    catalogStats: {
      totalConcepts: catalog.totalConcepts,
      totalIndustries: catalog.totalIndustries,
      totalBoards: catalog.totalBoards,
      customCount: customStore.customThemes.length,
      pinnedCount: pinnedThemes.length,
    },
    pinnedCodes: customStore.pinnedCodes,
    pinnedThemes,
    customThemes: customStore.customThemes,
    hotThemes,
    hotIndustries,
    selectedTheme: selectedThemeMeta,
    themeTiers: tiers,
    constituents,
    themeRotation6d: (themeHistoryStore.days || []).slice(-6),
    cognitionChains: buildCognitionChainTables(),
    rangeStats: {
      indexSecid,
      startDate,
      endDate,
      indexRangePct,
      indexKlines: indexKlines.slice(-90),
      stocks: rangeStocks,
      sectors: rangeSectors,
    },
  };
}

// ============================================================================
// 5. 弈盘风格：个股全屏研究工作台一站式数据包（技术面 + 异动 + 三库联动 + 交易账本）
// ============================================================================

async function fetchStockFullscreenDossier(rawQueryOrSecid, timeframe = 'day') {
  const tech = await analyzeSecurityTechnicals(rawQueryOrSecid, timeframe);
  const { target } = tech;
  const secid = target.secid;
  const meta = inferMarketMetaFromSecid(secid);

  const [intraday, anomaly, announcements] = await Promise.all([
    fetchIntradayWithVolume(secid, target.marketKind, 130, tech.indicators?.price || null, 1).catch(() => ({ available: false, points: [] })),
    target.marketKind === 'CN' ? computeSingleStockAnomaly(secid, target.name, 0).catch(() => null) : Promise.resolve(null),
    target.marketKind === 'CN' ? fetchAnomalyAnnouncements(target.code).catch(() => []) : Promise.resolve([]),
  ]);

  // 检索个人三库（认知卡、研判台账假设、相关方法论卡）与交易账本历史盈亏
  const ws = loadWorkspace();
  const qTokens = [target.name, target.code, target.secuCode].filter((x) => x && x.length >= 2);
  const matchesText = (str) => {
    const s = String(str || '').toLowerCase();
    return qTokens.some((tk) => s.includes(tk.toLowerCase()));
  };

  const matchedJudgments = (ws.ledger.judgments || [])
    .filter((j) => matchesText(`${j.title} ${j.target} ${j.rawMarkdown || ''}`))
    .slice(0, 6)
    .map((j) => ({
      id: j.id,
      title: j.title,
      date: j.date,
      direction: j.direction,
      status: j.status,
      coreThesis: String(j.coreThesis || '').slice(0, 180),
      invalidation: String(j.invalidation || '').slice(0, 160),
    }));

  const matchedCognition = (ws.cognition.cards || [])
    .filter((c) => matchesText(`${c.title} ${c.domain} ${c.mapping || ''} ${c.facts || ''}`))
    .slice(0, 6)
    .map((c) => ({
      id: c.id,
      domain: c.domain,
      title: c.title,
      grade: c.grade,
      facts: String(c.facts || '').slice(0, 160),
    }));

  let tradeHistory = null;
  try {
    const ledger = await computeTradeLedgerAnalytics(ws, { withMarketData: false });
    const openPos = (ledger.openPositions || []).find((p) => matchesText(`${p.symbol} ${p.name}`));
    const trades = (ledger.trades || []).filter((t) => matchesText(`${t.symbol} ${t.name}`)).slice(0, 10);
    if (openPos || trades.length > 0) {
      tradeHistory = { openPosition: openPos || null, recentTrades: trades };
    }
  } catch {
    // ignore
  }

  return {
    ok: true,
    fetchedAt: nowOffsetISO(),
    target: { ...target, exchange: meta.exchange },
    technical: tech,
    intraday,
    anomaly,
    announcements,
    threeLibraryLinks: {
      judgments: matchedJudgments,
      cognitionCards: matchedCognition,
      tradeHistory,
    },
  };
}

/**
 * 轻量顶部行情条专用接口（替代原先每 30 秒穿透全景 ~85 次外网请求的重接口）：
 * - 单飞去重 + 25s TTL + 20s 负缓存熔断；
 * - 仅拉取 5 大核心指数 + 盘面宽度（最多 2 次上游请求）；
 * - 国内商业版在未配置外部行情源时，诚实返回内置脱敏演示行情包，避免违规默认直连免费爬取源。
 */
async function fetchMarketTickerStrip(force = false) {
  const ed = getEditionInfo();
  if (ed.isCommercial) {
    const { loadRawDataSourceConfig } = require('./data-source-config.cjs');
    const dsCfg = loadRawDataSourceConfig();
    if (dsCfg?.cn_quotes?.mode === 'default') {
      const demoPath = path.join(PATHS.appRoot, 'templates', 'demo-market-packet', 'demo-daily-packet.json');
      let demoBench = [
        { secid: '1.000001', code: '000001', name: '上证指数', price: 3368.42, pct: 0.45, amountYi: 4920 },
        { secid: '0.399001', code: '399001', name: '深证成指', price: 10812.15, pct: 0.82, amountYi: 6810 },
        { secid: '0.399006', code: '399006', name: '创业板指', price: 2245.30, pct: 1.16, amountYi: 3120 },
        { secid: '1.000688', code: '000688', name: '科创50', price: 982.60, pct: 0.94, amountYi: 980 },
        { secid: '0.899050', code: '899050', name: '北证50', price: 1218.75, pct: 0.31, amountYi: 215 },
      ];
      if (fs.existsSync(demoPath)) {
        try {
          const rawDemo = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
          if (Array.isArray(rawDemo?.indices) && rawDemo.indices.length > 0) {
            demoBench = rawDemo.indices.slice(0, 5).map((idx, i) => ({
              secid: idx.secid || `1.00000${i + 1}`,
              code: idx.code || `00000${i + 1}`,
              name: idx.name || '示例指数',
              price: Number(idx.close ?? idx.price ?? 3000),
              pct: Number(idx.pct ?? 0),
              amountYi: Number(idx.amountYi ?? 3500),
            }));
          }
        } catch {
          // use fallback demoBench
        }
      }
      return {
        ok: true,
        isDemo: true,
        source: '内置脱敏演示数据（请在「数据源」配置合规接口）',
        dataStatus: 'demo',
        asOf: null,
        fetchedAt: nowOffsetISO(),
        benchmarks: demoBench,
        temperature: {
          sentimentScore: 58,
          stage: '演示态',
          up: 2860,
          down: 2140,
          redRatePct: 57.2,
          ztCount: 62,
          zbCount: 14,
          dtCount: 8,
          maxBoard: 4,
          twoMarketAmtYi: 11730,
          estFullDayAmtYi: 11730,
        },
        degradedSections: [],
      };
    }
  }

  return memCache.singleflight(
    'market:ticker-strip',
    25000,
    async () => {
      const [benchRes, sentRes] = await Promise.all([
        fetchCrossMarketBenchmarks().catch(() => []),
        fetchMarketSentimentSnapshot().catch(() => null),
      ]);
      const rawBenchList = Array.isArray(benchRes) ? benchRes : Array.isArray(benchRes?.benchmarks) ? benchRes.benchmarks : [];
      const cnBench = rawBenchList.filter((b) => b && (b.marketKind === 'CN' || /^[01]\.(000|399|899)/.test(String(b.secid || '')))).slice(0, 5);
      const benchmarks = cnBench.length > 0 ? cnBench : rawBenchList.slice(0, 5);
      const degradedSections = [];
      if (benchmarks.length === 0) degradedSections.push('benchmarks');
      if (!sentRes || sentRes.valid === false) degradedSections.push('temperature');
      const twoMarketAmtYi =
        sentRes?.twoMarketAmtYi ??
        (benchmarks.length >= 2
          ? round2((Number(benchmarks[0]?.amountYi || 0) + Number(benchmarks[1]?.amountYi || 0)) || 0)
          : null);
      const hasAnyLiveData = benchmarks.length > 0 || (sentRes && sentRes.valid !== false);
      return {
        ok: hasAnyLiveData,
        source: '公开实时摘要源',
        dataStatus: degradedSections.length === 0 ? 'live' : hasAnyLiveData ? 'degraded' : 'error',
        asOf: hasAnyLiveData ? nowOffsetISO() : null,
        fetchedAt: nowOffsetISO(),
        benchmarks,
        temperature: {
          sentimentScore: sentRes?.sentimentScore ?? null,
          stage: sentRes?.stage || '平稳',
          up: sentRes?.up ?? null,
          down: sentRes?.down ?? null,
          redRatePct: sentRes?.redRatePct ?? null,
          ztCount: sentRes?.ztCount ?? null,
          zbCount: sentRes?.zbCount ?? null,
          dtCount: sentRes?.dtCount ?? null,
          maxBoard: sentRes?.maxBoard ?? null,
          twoMarketAmtYi,
          estFullDayAmtYi: sentRes?.estFullDayAmtYi ?? twoMarketAmtYi,
        },
        degradedSections,
      };
    },
    { force, negTtlMs: 20000 }
  );
}

module.exports = {
  fetchShortTermDashboard,
  fetchMarketTickerStrip,
  clearShortTermCaches,
  fetchBoardLadderAndCycle,
  fetchAnomalyCenter,
  fetchFullThemeCatalog,
  searchThemeCatalog,
  loadCustomThemesStore,
  saveCustomTheme,
  deleteCustomTheme,
  togglePinTheme,
  fetchThemeMatrixAndRangeStats,
  fetchStockFullscreenDossier,
  captureWorkspaceWatchlistContext,
  _setCacheForTest: setCached,
  _getCacheForTest: getCached,
};
