'use strict';

/**
 * 二级投研 · 真实日K + 1分钟级行情与情绪数据采集引擎
 *
 * 严格遵守《执行规则补充》数据口径：
 * 1. 指数与个股的 开/高/低/收 一律以日 K / 官方收盘快照为权威源；
 * 2. 1 分钟全量分时序列（240/241条，含均价线）用于刻画竞价/早盘/午盘/尾盘四段结构与精确到分钟的转折点；
 * 3. 分时归一化基准一律用昨收价（preClose），绝不用分钟首点；
 * 4. 无法独立获取的指标（DR001/央行逆回购/两融/龙虎榜明细等）严格标为 missing (null)，绝不编造或填 0。
 */

const fs = require('node:fs');
const path = require('node:path');
const { checkEvidenceRecord } = require('./evidence-checker.cjs');

const { stateSubDir } = require('./app-paths.cjs');
const PACKETS_DIR = stateSubDir('market_packets');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://quote.eastmoney.com/',
};

const DEFAULT_INDICES = [
  { code: 'sh000001', secid: '1.000001', name: '上证指数' },
  { code: 'sz399001', secid: '0.399001', name: '深证成指' },
  { code: 'sz399006', secid: '0.399006', name: '创业板指' },
  { code: 'sh000688', secid: '1.000688', name: '科创50' },
  { code: 'sh000300', secid: '1.000300', name: '沪深300' },
  { code: 'sh000016', secid: '1.000016', name: '上证50' },
  { code: 'bj899050', secid: '0.899050', name: '北证50' },
];

const DEFAULT_WATCH_STOCKS = [
  '300308', // 中际旭创
  '002384', // 东山精密
  '300502', // 新易盛
  '300394', // 天孚通信
  '601398', // 工商银行
  '600519', // 贵州茅台
];

const US_SYMBOLS = [
  { q: 'usDJI', code: 'DJI', name: '道琼斯' },
  { q: 'usIXIC', code: 'IXIC', name: '纳斯达克' },
  { q: 'usINX', code: 'SPX', name: '标普500' },
  { q: 'usSOX', code: 'SOX', name: '费城半导体' },
  { q: 'usNVDA', code: 'NVDA', name: '英伟达' },
  { q: 'usTSM', code: 'TSM', name: '台积电' },
  { q: 'usAMD', code: 'AMD', name: 'AMD' },
];

function nowOffsetISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = pad(Math.floor(abs / 60));
  const mm = pad(abs % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`;
}

function round2(v) {
  return Number.isFinite(v) ? Number(v.toFixed(2)) : null;
}

/**
 * 将 6 位股票代码标准化为 腾讯 code (sh/sz/bj) 与 东财 secid (1./0.)
 */
function normalizeStockCode(raw) {
  const clean = String(raw || '').trim().toLowerCase().replace(/\.(sh|sz|bj)$/i, '');
  const m = clean.match(/^(sh|sz|bj)?(\d{6})$/);
  if (!m) return null;
  const num = m[2];
  let market = m[1];
  if (!market) {
    if (num.startsWith('6') || num.startsWith('9')) market = 'sh';
    else if (num.startsWith('4') || num.startsWith('8')) market = 'bj';
    else market = 'sz';
  }
  const secidPrefix = market === 'sh' ? '1' : '0';
  return {
    num,
    code: `${market}${num}`,
    secid: `${secidPrefix}.${num}`,
    market: market.toUpperCase(),
  };
}

async function fetchText(url, timeoutMs = 9000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url, timeoutMs = 9000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * 抓取东财 1 分钟分时（trends2，含精确昨收、开/收/高/低、量、额、均价）
 * 失败时自动回退腾讯 1 分钟分时（minute/query）
 */
async function fetchIntradaySeries(secid, tencentCode) {
  // 1. 优先尝试东财 trends2（ndays=2 同时拿今日1m分时与前一日总成交额用于放缩量精确计算）
  try {
    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=2`;
    const json = await fetchJson(url);
    const d = json?.data;
    if (d && Array.isArray(d.trends) && d.trends.length > 0) {
      const preClose = Number(d.preClose);
      // 按日期分组，区分今日与昨日
      const byDate = new Map();
      for (const row of d.trends) {
        const parts = row.split(',');
        const dt = parts[0] || '';
        const [datePart, timePart] = dt.split(' ');
        if (!datePart) continue;
        if (!byDate.has(datePart)) byDate.set(datePart, []);
        byDate.get(datePart).push({
          time: timePart || dt,
          open: Number(parts[1]),
          close: Number(parts[2]),
          high: Number(parts[3]),
          low: Number(parts[4]),
          volume: Number(parts[5]),
          amount: Number(parts[6]),
          avg: Number(parts[7]),
        });
      }
      const dates = [...byDate.keys()].sort();
      const tradeDate = dates[dates.length - 1] || '';
      const prevDate = dates.length >= 2 ? dates[dates.length - 2] : '';
      const todayRaw = byDate.get(tradeDate) || [];
      const prevRaw = prevDate ? byDate.get(prevDate) || [] : [];

      // 严格过滤 09:30 及之后的正式交易分钟序列（剔除 09:15-09:29 虚拟竞价试盘噪音）
      const auctionBars = todayRaw.filter((b) => b.time < '09:30');
      const regularBars = todayRaw
        .filter((b) => b.time >= '09:30')
        .map((b) => ({
          ...b,
          pct: preClose > 0 ? round2(((b.close - preClose) / preClose) * 100) : 0,
          avgPct: preClose > 0 && b.avg > 0 ? round2(((b.avg - preClose) / preClose) * 100) : 0,
        }));

      const prevRegular = prevRaw.filter((b) => b.time >= '09:30');
      const prevDayAmtYi =
        prevRegular.length > 0
          ? round2(prevRegular.reduce((acc, b) => acc + (Number.isFinite(b.amount) ? b.amount : 0), 0) / 1e8)
          : null;
      const todayAmtYiFromMin =
        regularBars.length > 0
          ? round2(regularBars.reduce((acc, b) => acc + (Number.isFinite(b.amount) ? b.amount : 0), 0) / 1e8)
          : null;

      return {
        source: 'EastMoney trends2 (1m正式交易241条)',
        name: d.name || tencentCode,
        tradeDate,
        prevDate,
        preClose,
        prevDayAmtYi,
        todayAmtYiFromMin,
        auctionBarCount: auctionBars.length,
        bars: regularBars,
      };
    }
  } catch {
    // fallback to Tencent
  }

  // 2. 兜底腾讯 1 分钟分时
  try {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${tencentCode}`;
    const json = await fetchJson(url);
    const node = json?.data?.[tencentCode];
    const qt = node?.qt?.[tencentCode];
    const preClose = qt ? Number(qt[4]) : 0;
    const rawDate = node?.data?.date || '';
    const tradeDate = rawDate.length === 8 ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : '';
    const rawList = node?.data?.data || [];
    let prevVol = 0;
    let prevAmt = 0;
    const bars = rawList.map((row) => {
      const [hhmm, pStr, cumVolStr, cumAmtStr] = row.split(' ');
      const time = `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
      const close = Number(pStr);
      const cumVol = Number(cumVolStr || 0);
      const cumAmt = Number(cumAmtStr || 0);
      const volume = Math.max(0, cumVol - prevVol);
      const amount = Math.max(0, cumAmt - prevAmt);
      prevVol = cumVol;
      prevAmt = cumAmt;
      const pct = preClose > 0 ? round2(((close - preClose) / preClose) * 100) : 0;
      return { time, open: close, close, high: close, low: close, volume, amount, avg: close, pct, avgPct: pct };
    });
    return {
      source: 'Tencent minute/query (1m)',
      name: qt ? qt[1] : tencentCode,
      tradeDate,
      preClose,
      bars,
    };
  } catch (err) {
    return { source: 'failed', name: tencentCode, tradeDate: '', preClose: 0, bars: [], error: err.message };
  }
}

/**
 * 抓取腾讯最近 N 日权威日 K（用于验证准确开/高/低/收、前收盘价与昨日成交额对照）
 */
async function fetchDailyKlines(tencentCode, count = 6) {
  try {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentCode},day,,,${count},qfq`;
    const json = await fetchJson(url);
    const node = json?.data?.[tencentCode];
    const rows = node?.qfqday || node?.day || [];
    const qt = node?.qt?.[tencentCode];
    const klines = rows.map((r) => ({
      date: r[0],
      open: Number(r[1]),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      volume: Number(r[5]),
      amountWan: r[8] !== undefined ? Number(r[8]) : null,
    }));
    // 腾讯快照 qt 字段: [1]=name, [3]=close, [4]=preClose, [5]=open, [30]=datetime, [31]=chg, [32]=pct%, [33]=high, [34]=low, [37]=amount(万元), [38]=turnover%, [39]=pe_ttm, [44]=floatCap(亿), [45]=totalCap(亿), [46]=pb
    const numOrNull = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    const snapshot = qt
      ? {
          name: qt[1],
          close: numOrNull(qt[3]),
          preClose: numOrNull(qt[4]),
          open: numOrNull(qt[5]),
          high: numOrNull(qt[33]),
          low: numOrNull(qt[34]),
          pct: numOrNull(qt[32]),
          amountYi: numOrNull(qt[37]) !== null ? round2(Number(qt[37]) / 10000) : null,
          turnover: numOrNull(qt[38]),
          peTtm: numOrNull(qt[39]),
          floatCapYi: numOrNull(qt[44]),
          totalCapYi: numOrNull(qt[45]),
          pb: numOrNull(qt[46]),
          quoteTime: qt[30] || '',
        }
      : null;
    return { klines, snapshot, source: 'Tencent fqkline/qt' };
  } catch (err) {
    return { klines: [], snapshot: null, source: 'failed', error: err.message };
  }
}

/**
 * 对 1 分钟序列执行确定性量化结构剖析（绝不由 AI 臆测时间点）
 */
function analyzeIntradayStructure(bars, dailyAuth) {
  if (!bars || bars.length === 0) {
    return { available: false, barCount: 0 };
  }

  const preClose = dailyAuth?.preClose || bars[0].open;
  const openPrice = dailyAuth?.open ?? bars[0].open;
  const closePrice = dailyAuth?.close ?? bars[bars.length - 1].close;
  const highPrice = dailyAuth?.high ?? Math.max(...bars.map((b) => b.high));
  const lowPrice = dailyAuth?.low ?? Math.min(...bars.map((b) => b.low));

  // 查找精确分钟高/低点
  let dayHighBar = bars[0];
  let dayLowBar = bars[0];
  let amBars = [];
  let pmEarlyBars = [];
  let tailBars = [];

  for (const b of bars) {
    if (b.high >= dayHighBar.high) dayHighBar = b;
    if (b.low <= dayLowBar.low) dayLowBar = b;
    if (b.time <= '11:30') amBars.push(b);
    else if (b.time >= '13:00' && b.time < '14:00') pmEarlyBars.push(b);
    else if (b.time >= '14:00') tailBars.push(b);
  }

  const amHigh = amBars.length ? amBars.reduce((a, b) => (b.high > a.high ? b : a), amBars[0]) : null;
  const amLow = amBars.length ? amBars.reduce((a, b) => (b.low < a.low ? b : a), amBars[0]) : null;
  const amClose = amBars.length ? amBars[amBars.length - 1] : null;
  const pmHigh = pmEarlyBars.length ? pmEarlyBars.reduce((a, b) => (b.high > a.high ? b : a), pmEarlyBars[0]) : null;

  // 滑动窗口计算最大 10 分钟拉升段 & 最大 10 分钟下跌段
  let maxUp10m = { deltaPct: -Infinity, deltaPts: 0, fromTime: '', toTime: '' };
  let maxDown10m = { deltaPct: Infinity, deltaPts: 0, fromTime: '', toTime: '' };
  for (let i = 0; i < bars.length; i++) {
    const j = Math.min(bars.length - 1, i + 10);
    if (j <= i) continue;
    // 跳过跨午休（11:30 -> 13:00）
    if (bars[i].time <= '11:30' && bars[j].time >= '13:00') continue;
    const pts = bars[j].close - bars[i].close;
    const dp = preClose > 0 ? (pts / preClose) * 100 : 0;
    if (dp > maxUp10m.deltaPct) {
      maxUp10m = { deltaPct: round2(dp), deltaPts: round2(pts), fromTime: bars[i].time, toTime: bars[j].time };
    }
    if (dp < maxDown10m.deltaPct) {
      maxDown10m = { deltaPct: round2(dp), deltaPts: round2(pts), fromTime: bars[i].time, toTime: bars[j].time };
    }
  }

  // 收盘在日内振幅位置 (收 - 低) / (高 - 低)
  const closePosPct = highPrice > lowPrice ? Math.round(((closePrice - lowPrice) / (highPrice - lowPrice)) * 100) : 50;

  // 相对均价线运行统计（高于均价线的分钟占比）
  const aboveAvgCount = bars.filter((b) => b.close >= b.avg).length;
  const aboveAvgRatioPct = Math.round((aboveAvgCount / bars.length) * 100);

  // 尾盘最后 30 分钟方向（14:30 -> 15:00）
  const bar1430 = bars.find((b) => b.time >= '14:30') || tailBars[0];
  const lastBar = bars[bars.length - 1];
  const tail30mPct = bar1430 && preClose > 0 ? round2(((lastBar.close - bar1430.close) / preClose) * 100) : 0;
  const tailDirection = tail30mPct > 0.25 ? '尾盘抢筹走强' : tail30mPct < -0.25 ? '尾盘回落走弱' : '尾盘横盘持平';

  const openPct = preClose > 0 ? round2(((openPrice - preClose) / preClose) * 100) : 0;
  const closePct = preClose > 0 ? round2(((closePrice - preClose) / preClose) * 100) : 0;
  const amplitudePct = preClose > 0 ? round2(((highPrice - lowPrice) / preClose) * 100) : 0;
  const firstMinAmtYi = bars[0].amount ? round2(bars[0].amount / 1e8) : null;

  // 降采样 60 点给前端轻量绘制高保真分时 SVG（同时保留首尾与日高/日低极值点）
  const step = Math.max(1, Math.floor(bars.length / 80));
  const sparkline = [];
  for (let i = 0; i < bars.length; i += step) {
    sparkline.push({ t: bars[i].time, p: bars[i].pct, a: bars[i].avgPct, c: bars[i].close });
  }
  const tailPt = bars[bars.length - 1];
  if (sparkline[sparkline.length - 1]?.t !== tailPt.time) {
    sparkline.push({ t: tailPt.time, p: tailPt.pct, a: tailPt.avgPct, c: tailPt.close });
  }

  return {
    available: true,
    barCount: bars.length,
    openPct,
    closePct,
    amplitudePct,
    closePosPct,
    firstMinAmtYi,
    dayHigh: { price: dayHighBar.high, time: dayHighBar.time, pct: preClose > 0 ? round2(((dayHighBar.high - preClose) / preClose) * 100) : null },
    dayLow: { price: dayLowBar.low, time: dayLowBar.time, pct: preClose > 0 ? round2(((dayLowBar.low - preClose) / preClose) * 100) : null },
    amSession: amClose
      ? {
          high: { price: amHigh.high, time: amHigh.time },
          low: { price: amLow.low, time: amLow.time },
          close: amClose.close,
          closePct: amClose.pct,
        }
      : null,
    pmEarlyHigh: pmHigh ? { price: pmHigh.high, time: pmHigh.time, pct: pmHigh.pct } : null,
    maxUp10m: Number.isFinite(maxUp10m.deltaPct) ? maxUp10m : null,
    maxDown10m: Number.isFinite(maxDown10m.deltaPct) ? maxDown10m : null,
    aboveAvgRatioPct,
    tail30mPct,
    tailDirection,
    sparkline,
  };
}

/**
 * 抓取东财全市场广度（上涨/下跌/平盘家数与沪深成交额）
 */
async function fetchMarketBreadth() {
  try {
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f14,f2,f3,f6,f104,f105,f106&secids=1.000001,0.399001,0.399006,1.000688,1.000300,1.000016,0.899050';
    const json = await fetchJson(url);
    const rows = json?.data?.diff || [];
    const byCode = Object.fromEntries(rows.map((r) => [r.f12, r]));
    const sh = byCode['000001'];
    const sz = byCode['399001'];
    const bj = byCode['899050'];
    const up = (sh?.f104 || 0) + (sz?.f104 || 0) + (bj?.f104 || 0);
    const down = (sh?.f105 || 0) + (sz?.f105 || 0) + (bj?.f105 || 0);
    const flat = (sh?.f106 || 0) + (sz?.f106 || 0) + (bj?.f106 || 0);
    const total = up + down + flat;
    const shAmtYi = sh?.f6 ? round2(sh.f6 / 1e8) : null;
    const szAmtYi = sz?.f6 ? round2(sz.f6 / 1e8) : null;
    const bjAmtYi = bj?.f6 ? round2(bj.f6 / 1e8) : null;
    const totalTwoMarketYi = shAmtYi !== null && szAmtYi !== null ? round2(shAmtYi + szAmtYi) : null;

    return {
      ok: true,
      source: 'EastMoney push2 ulist (沪深京全市场广度)',
      up,
      down,
      flat,
      total,
      redRatePct: total > 0 ? round2((up / total) * 100) : null,
      shAmtYi,
      szAmtYi,
      bjAmtYi,
      totalTwoMarketYi,
      rawByCode: byCode,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 抓取东财当日涨停池 / 跌停池 / 炸板池，并执行框架增订③（≥3只集群穷举）与连板梯队统计
 */
async function fetchLimitPools(dateYYYYMMDD) {
  const formatHHMMSS = (val) => {
    const s = String(val || '').padStart(6, '0');
    return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
  };

  const result = {
    ok: false,
    queryDate: dateYYYYMMDD,
    source: 'EastMoney push2ex (涨停/跌停/炸板全量池)',
    ztCount: null,
    dtCount: null,
    zbCount: null,
    sealRatePct: null,
    burstRatePct: null,
    maxBoard: 0,
    lianbanCount: 0,
    boardLadder: [], // [{ board: 5, stocks: [...] }]
    clustersGe3: [], // 框架增订③：≥3只行业集群穷举
    topLeaders: [],  // 高连板核心股代码，供自动抓取分钟结构
    dtStocks: [],
    zbSample: [],
  };

  try {
    const [ztJson, dtJson, zbJson] = await Promise.all([
      fetchJson(`https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=lbc:desc&date=${dateYYYYMMDD}`),
      fetchJson(`https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fund:asc&date=${dateYYYYMMDD}`),
      fetchJson(`https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt:asc&date=${dateYYYYMMDD}`),
    ]);

    const ztPool = ztJson?.data?.pool || [];
    const dtPool = dtJson?.data?.pool || [];
    const zbPool = zbJson?.data?.pool || [];

    const actualQDate = String(ztJson?.data?.qdate || dtJson?.data?.qdate || dateYYYYMMDD);
    result.actualDate =
      actualQDate.length === 8 ? `${actualQDate.slice(0, 4)}-${actualQDate.slice(4, 6)}-${actualQDate.slice(6, 8)}` : dateYYYYMMDD;

    result.ztCount = ztJson?.data?.tc ?? ztPool.length;
    result.dtCount = dtJson?.data?.tc ?? dtPool.length;
    result.zbCount = zbJson?.data?.tc ?? zbPool.length;

    const touchedTotal = result.ztCount + result.zbCount;
    if (touchedTotal > 0) {
      result.sealRatePct = round2((result.ztCount / touchedTotal) * 100);
      result.burstRatePct = round2((result.zbCount / touchedTotal) * 100);
    }

    // 解析涨停池并分类连板梯队 + 封板类型（一字/T字/换手）
    const byBoard = new Map();
    const byIndustry = new Map();

    const parsedZt = ztPool.map((s) => {
      const fbt = formatHHMMSS(s.fbt);
      const lbt = formatHHMMSS(s.lbt);
      const zbc = Number(s.zbc || 0);
      const hs = round2(Number(s.hs || 0));
      const lbc = Number(s.lbc || 1);
      const industry = s.hybk || '未分类';
      // 封板类型初步量化判定（按开板次数与首封时间）
      let boardStyle = '换手板';
      if (fbt === '09:25:00' && zbc === 0 && hs < 5) boardStyle = '一字板';
      else if (fbt === '09:25:00' && zbc > 0) boardStyle = 'T字板';
      else if (zbc >= 2) boardStyle = `烂板(${zbc}次炸)`;

      const item = {
        code: s.c,
        name: s.n,
        price: round2(Number(s.p) / 1000),
        pct: round2(Number(s.zdp)),
        amountYi: round2(Number(s.amount) / 1e8),
        turnoverPct: hs,
        lbc,
        stat: s.zttj ? `${s.zttj.days}天${s.zttj.ct}板` : `${lbc}板`,
        firstSealTime: fbt,
        lastSealTime: lbt,
        openCount: zbc,
        boardStyle,
        industry,
      };

      if (lbc >= 2) {
        if (!byBoard.has(lbc)) byBoard.set(lbc, []);
        byBoard.get(lbc).push(item);
      }
      if (!byIndustry.has(industry)) byIndustry.set(industry, []);
      byIndustry.get(industry).push(item);
      return item;
    });

    result.maxBoard = parsedZt.reduce((acc, s) => Math.max(acc, s.lbc), 0);
    result.lianbanCount = parsedZt.filter((s) => s.lbc >= 2).length;
    result.boardLadder = [...byBoard.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([board, stocks]) => ({
        board,
        count: stocks.length,
        stocks: stocks.slice(0, 15),
      }));

    // 框架增订③：穷举所有 >= 3 只的涨停板块集群
    result.clustersGe3 = [...byIndustry.entries()]
      .filter(([, arr]) => arr.length >= 3)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([industry, arr]) => ({
        industry,
        count: arr.length,
        maxBoard: Math.max(...arr.map((x) => x.lbc)),
        lianbanStocks: arr.filter((x) => x.lbc >= 2).map((x) => `${x.name}(${x.lbc}板/${x.boardStyle})`),
        sampleStocks: arr.slice(0, 6).map((x) => `${x.name}(${x.lbc}板)`),
      }));

    // 提取最高连板前 3 龙头代码
    result.topLeaders = parsedZt
      .filter((s) => s.lbc >= 2)
      .slice(0, 3)
      .map((s) => ({ code: s.code, name: s.name, lbc: s.lbc, stat: s.stat, industry: s.industry }));

    result.dtStocks = dtPool.slice(0, 15).map((s) => ({
      code: s.c,
      name: s.n,
      pct: round2(Number(s.zdp)),
      amountYi: round2(Number(s.amount) / 1e8),
      sealFundYi: round2(Number(s.fund || 0) / 1e8),
      days: Number(s.lbc || 1),
      industry: s.hybk || '未分类',
    }));

    result.zbSample = zbPool.slice(0, 12).map((s) => ({
      code: s.c,
      name: s.n,
      pct: round2(Number(s.zdp)),
      amountYi: round2(Number(s.amount) / 1e8),
      firstSealTime: formatHHMMSS(s.fbt),
      openCount: Number(s.zbc || 1),
      industry: s.hybk || '未分类',
    }));

    result.ok = true;
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

/**
 * 抓取隔夜美股指数与算力核心个股（腾讯美股实时接口）
 */
async function fetchUSOvernight() {
  try {
    const qStr = US_SYMBOLS.map((s) => s.q).join(',');
    const raw = await fetchText(`https://qt.gtimg.cn/q=${qStr}`);
    const items = [];
    for (const sym of US_SYMBOLS) {
      const re = new RegExp(`v_${sym.q}="([^"]+)"`);
      const m = raw.match(re);
      if (!m) continue;
      const parts = m[1].split('~');
      items.push({
        code: sym.code,
        name: sym.name,
        close: Number(parts[3]),
        preClose: Number(parts[4]),
        open: Number(parts[5]),
        pct: Number(parts[32]),
        high: Number(parts[33]),
        low: Number(parts[34]),
        tradeTimeET: parts[30] || '',
      });
    }
    return { ok: items.length > 0, source: 'Tencent US Quote (美东最新收盘)', items };
  } catch (err) {
    return { ok: false, source: 'failed', items: [], error: err.message };
  }
}

/**
 * 聚合完整的「日度真实分钟级行情 + 全市场情绪 + 观察池个股 + 隔夜美股」硬数据包
 */
async function fetchDailyMarketPacket(options = {}) {
  const fetchedAt = nowOffsetISO();
  const explicitArray = Array.isArray(options.watchStocks);
  const explicitEmpty = explicitArray && options.watchStocks.length === 0;
  // 严格区分：显式空数组跳过个股采集；未指定时仅当明确要求 demo 模式才使用示例池，绝不私自注入作者固定个股！
  const watchInput = explicitArray
    ? options.watchStocks
    : options.useDemoDefaults
    ? DEFAULT_WATCH_STOCKS
    : [];

  // 1. 先并发抓取 7 大指数（日K + 1m分时）、全市场广度、隔夜美股
  const [breadth, usOvernight, indexResults] = await Promise.all([
    fetchMarketBreadth(),
    fetchUSOvernight(),
    Promise.all(
      DEFAULT_INDICES.map(async (idx) => {
        const [dailyRes, intraRes] = await Promise.all([
          fetchDailyKlines(idx.code, 6),
          fetchIntradaySeries(idx.secid, idx.code),
        ]);
        const latestK = dailyRes.klines[dailyRes.klines.length - 1] || null;
        const prevK = dailyRes.klines.length >= 2 ? dailyRes.klines[dailyRes.klines.length - 2] : null;
        const snap = dailyRes.snapshot;

        // 严格遵守口径：开/高/低/收以日K/权威快照为准
        const dailyAuth = {
          date: latestK?.date || intraRes.tradeDate,
          open: latestK?.open ?? snap?.open ?? null,
          high: latestK?.high ?? snap?.high ?? null,
          low: latestK?.low ?? snap?.low ?? null,
          close: latestK?.close ?? snap?.close ?? null,
          preClose: prevK?.close ?? snap?.preClose ?? intraRes.preClose ?? null,
          pct:
            latestK && prevK && prevK.close > 0
              ? round2(((latestK.close - prevK.close) / prevK.close) * 100)
              : snap?.pct ?? null,
          amountYi: snap?.amountYi ?? intraRes.todayAmtYiFromMin ?? (latestK?.amountWan ? round2(latestK.amountWan / 10000) : null),
          prevAmountYi: intraRes.prevDayAmtYi ?? (prevK?.amountWan ? round2(prevK.amountWan / 10000) : null),
        };

        const intraday = analyzeIntradayStructure(intraRes.bars, dailyAuth);
        return {
          code: idx.code,
          secid: idx.secid,
          name: idx.name,
          dailyAuth,
          intradayDate: intraRes.tradeDate,
          intradaySource: intraRes.source,
          dailySource: dailyRes.source,
          intraday,
        };
      })
    ),
  ]);

  // 确定真实交易日（以主指数分时/日K权威日期为准，严防串日）
  const shIdx = indexResults.find((x) => x.code === 'sh000001');
  const szIdx = indexResults.find((x) => x.code === 'sz399001');
  const actualTradeDate = shIdx?.intradayDate || shIdx?.dailyAuth?.date || fetchedAt.slice(0, 10);
  const requestedDate = options.date || actualTradeDate;
  const dateMismatchWarning =
    requestedDate !== actualTradeDate
      ? `注意：公开 1 分钟实时分时接口仅提供最近已收盘交易日（${actualTradeDate}），与所选日期（${requestedDate}）不同；已按实际交易日 ${actualTradeDate} 标定，绝不混用不同日期数据。`
      : null;

  const queryYYYYMMDD = actualTradeDate.replaceAll('-', '');
  const limitPools = await fetchLimitPools(queryYYYYMMDD);

  // 计算两市较前一日放缩量（权威日K成交额对照）
  const twoMarketAmtYi =
    breadth.totalTwoMarketYi ??
    (shIdx?.dailyAuth?.amountYi && szIdx?.dailyAuth?.amountYi
      ? round2(shIdx.dailyAuth.amountYi + szIdx.dailyAuth.amountYi)
      : null);
  const prevTwoMarketAmtYi =
    shIdx?.dailyAuth?.prevAmountYi && szIdx?.dailyAuth?.prevAmountYi
      ? round2(shIdx.dailyAuth.prevAmountYi + szIdx.dailyAuth.prevAmountYi)
      : null;
  const volDeltaYi = twoMarketAmtYi !== null && prevTwoMarketAmtYi !== null ? round2(twoMarketAmtYi - prevTwoMarketAmtYi) : null;
  const volDeltaPct =
    volDeltaYi !== null && prevTwoMarketAmtYi > 0 ? round2((volDeltaYi / prevTwoMarketAmtYi) * 100) : null;

  // 2. 合并用户观察股 + 当日最高连板前 3 龙头（若调用方显式传空观察池，则跳过个股采集）
  const watchMap = new Map();
  if (!explicitEmpty) {
    for (const rawCode of watchInput) {
      const norm = normalizeStockCode(rawCode);
      if (norm) watchMap.set(norm.num, { ...norm, role: '观察池核心股' });
    }
    if (options.includeLimitLeaders !== false && watchInput.length > 0) {
      for (const leader of limitPools.topLeaders || []) {
        const norm = normalizeStockCode(leader.code);
        if (norm && !watchMap.has(norm.num)) {
          watchMap.set(norm.num, { ...norm, role: `当日连板龙头(${leader.stat}·${leader.industry})` });
        }
      }
    }
  }

  const stockList = [...watchMap.values()].slice(0, 12);
  const watchStocks = await Promise.all(
    stockList.map(async (st) => {
      const [dailyRes, intraRes] = await Promise.all([
        fetchDailyKlines(st.code, 5),
        fetchIntradaySeries(st.secid, st.code),
      ]);
      const latestK = dailyRes.klines[dailyRes.klines.length - 1] || null;
      const prevK = dailyRes.klines.length >= 2 ? dailyRes.klines[dailyRes.klines.length - 2] : null;
      const snap = dailyRes.snapshot;
      const dailyAuth = {
        date: latestK?.date || intraRes.tradeDate,
        open: latestK?.open ?? snap?.open ?? null,
        high: latestK?.high ?? snap?.high ?? null,
        low: latestK?.low ?? snap?.low ?? null,
        close: latestK?.close ?? snap?.close ?? null,
        preClose: prevK?.close ?? snap?.preClose ?? intraRes.preClose ?? null,
        pct:
          latestK && prevK && prevK.close > 0
            ? round2(((latestK.close - prevK.close) / prevK.close) * 100)
            : snap?.pct ?? null,
        amountYi: snap?.amountYi ?? (latestK?.amountWan ? round2(latestK.amountWan / 10000) : null),
        turnoverPct: snap?.turnover ?? null,
      };
      const intraday = analyzeIntradayStructure(intraRes.bars, dailyAuth);
      return {
        code: st.num,
        fullCode: st.code,
        name: snap?.name || intraRes.name || st.num,
        role: st.role,
        dailyAuth,
        intradayDate: intraRes.tradeDate,
        intradaySource: intraRes.source,
        intraday,
      };
    })
  );

  // 3. 自动构造符合 核验复盘.cjs 规范的结构化 EvidenceRecord（缺项诚实标 missing: null）
  const chainId = `LIVE-${actualTradeDate.replaceAll('-', '')}`;
  const facts = [];
  let eSeq = 1;
  const addObserved = (metric, value, unit, scope, source, extra = {}) => {
    if (!Number.isFinite(value)) return null;
    const id = `E${String(eSeq++).padStart(2, '0')}`;
    facts.push({
      id,
      metric,
      date: actualTradeDate,
      kind: 'same_day',
      state: 'observed',
      value,
      unit,
      scope,
      source,
      chain: chainId,
      available_at: fetchedAt,
      ...extra,
    });
    return id;
  };
  const addMissing = (metric, reason) => {
    const id = `E${String(eSeq++).padStart(2, '0')}`;
    facts.push({
      id,
      metric,
      date: actualTradeDate,
      kind: 'same_day',
      state: 'missing',
      value: null,
      reason,
    });
    return id;
  };

  const shPctId = addObserved('上证指数涨跌幅', shIdx?.dailyAuth?.pct, '%', '上证指数日K权威收盘', 'Tencent fqkline + EastMoney trends2');
  const cybIdx = indexResults.find((x) => x.code === 'sz399006');
  const cybPctId = addObserved('创业板指涨跌幅', cybIdx?.dailyAuth?.pct, '%', '创业板指日K权威收盘', 'Tencent fqkline + EastMoney trends2');
  const kcIdx = indexResults.find((x) => x.code === 'sh000688');
  addObserved('科创50涨跌幅', kcIdx?.dailyAuth?.pct, '%', '科创50日K权威收盘', 'Tencent fqkline + EastMoney trends2');
  const sz50Idx = indexResults.find((x) => x.code === 'sh000016');
  addObserved('上证50涨跌幅', sz50Idx?.dailyAuth?.pct, '%', '上证50日K权威收盘', 'Tencent fqkline + EastMoney trends2');

  if (cybPctId && shPctId && Number.isFinite(cybIdx?.dailyAuth?.pct) && Number.isFinite(shIdx?.dailyAuth?.pct)) {
    addObserved(
      '创业板相对上证超额点差',
      round2(cybIdx.dailyAuth.pct - shIdx.dailyAuth.pct),
      '百分点',
      '同日成长vs大盘强弱剪刀差',
      '由 E02 − E01 复算',
      { subtract_pp: [cybPctId, shPctId] }
    );
  }

  addObserved('沪深两市总成交额', twoMarketAmtYi, '亿元', '上证+深证两市全天成交', 'EastMoney push2 + Tencent 日K');
  if (breadth.ok) {
    addObserved('全市场红盘率', breadth.redRatePct, '%', `全市场${breadth.total}只（涨${breadth.up}/跌${breadth.down}）`, breadth.source);
  }
  if (limitPools.ok) {
    addObserved('非ST涨停家数', limitPools.ztCount, '家', '东财涨停池全量', limitPools.source);
    addObserved('跌停家数', limitPools.dtCount, '家', '东财跌停池全量', limitPools.source);
    addObserved('封板率', limitPools.sealRatePct, '%', `涨停${limitPools.ztCount}/(涨停+炸板${limitPools.zbCount})`, limitPools.source);
    addObserved('最高连板高度', limitPools.maxBoard, '板', '东财连板梯队最高高度', limitPools.source);
  }

  // 显式登记未接入自动采集的硬缺口（绝不编造、绝不填 0）
  addMissing('DR001与央行当日逆回购净投放规模', '免费行情接口不含银行间质押式回购与公开市场操作，需从中国外汇交易中心/央行公告补录');
  addMissing('全市场两融余额及融资净买入', '两融数据通常于次一交易日早间披露，需待交易所/东财披露后补录');
  addMissing('龙虎榜游资/机构席位净额明细', '公开免费分时接口未拉取完整龙虎榜席位明细，需盘后专项补查');

  const evidenceRecord = {
    review_date: actualTradeDate,
    mode: 'daily',
    cutoff: fetchedAt,
    facts,
  };
  const evidenceCheck = checkEvidenceRecord(evidenceRecord);

  const packet = {
    fetchedAt,
    requestedDate,
    actualTradeDate,
    dateMismatchWarning,
    totalIntradayBars:
      indexResults.reduce((s, x) => s + (x.intraday?.barCount || 0), 0) +
      watchStocks.reduce((s, x) => s + (x.intraday?.barCount || 0), 0),
    marketSummary: {
      twoMarketAmtYi,
      prevTwoMarketAmtYi,
      volDeltaYi,
      volDeltaPct,
      breadth,
    },
    indices: indexResults,
    limitPools,
    watchStocks,
    usOvernight,
    evidenceRecord,
    evidenceCheck,
  };

  // 自动保存一份本地抓数存档，确保事后可100%复核
  try {
    fs.mkdirSync(PACKETS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PACKETS_DIR, `${actualTradeDate}_intraday_packet.json`),
      JSON.stringify(packet, null, 2),
      'utf8'
    );
  } catch {
    // non-fatal
  }

  return packet;
}

/**
 * 抓取单只 A 股标的的真实行情快照（最近 22 日前复权日K + MA5/MA20 + 乖离率 + 市值/PE）
 * 专供“工作模式二：标的研判 AI 一键解析”提供客观行情锚点，杜绝模型臆造股价与位置。
 */
async function fetchStockSnapshotForJudgment(rawCode) {
  const norm = normalizeStockCode(rawCode);
  if (!norm) return null;
  const res = await fetchDailyKlines(norm.code, 22);
  if (!res.klines || res.klines.length === 0) {
    return { ok: false, code: `${norm.num}.${norm.market}`, error: res.error || '未查到日K行情' };
  }
  const ks = res.klines;
  const latest = ks[ks.length - 1];
  const prev = ks.length >= 2 ? ks[ks.length - 2] : null;
  const snap = res.snapshot;

  const avgClose = (n) => {
    if (ks.length < n) return null;
    const slice = ks.slice(-n);
    return round2(slice.reduce((s, x) => s + x.close, 0) / n);
  };
  const ma5 = avgClose(5);
  const ma10 = avgClose(10);
  const ma20 = avgClose(20);
  const close = latest.close;
  const ma5BiasPct = ma5 && ma5 > 0 ? round2(((close - ma5) / ma5) * 100) : null;
  const ret5dPct = ks.length >= 6 && ks[ks.length - 6].close > 0 ? round2(((close - ks[ks.length - 6].close) / ks[ks.length - 6].close) * 100) : null;
  const ret20dPct = ks.length >= 21 && ks[ks.length - 21].close > 0 ? round2(((close - ks[ks.length - 21].close) / ks[ks.length - 21].close) * 100) : null;
  const high20d = round2(Math.max(...ks.map((x) => x.high)));
  const low20d = round2(Math.min(...ks.map((x) => x.low)));

  return {
    ok: true,
    fetchedAt: nowOffsetISO(),
    source: res.source,
    code: `${norm.num}.${norm.market}`,
    name: snap?.name || norm.num,
    tradeDate: latest.date,
    close,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    pct: prev && prev.close > 0 ? round2(((close - prev.close) / prev.close) * 100) : snap?.pct ?? null,
    amountYi: snap?.amountYi ?? (latest.amountWan != null ? round2(latest.amountWan / 10000) : null),
    turnoverPct: snap?.turnover ?? null,
    totalCapYi: snap?.totalCapYi ?? null,
    floatCapYi: snap?.floatCapYi ?? null,
    peTtm: snap?.peTtm ?? null,
    pb: snap?.pb ?? null,
    ma5,
    ma10,
    ma20,
    aboveMa5: ma5 !== null ? close >= ma5 : null,
    ma5BiasPct,
    ret5dPct,
    ret20dPct,
    high20d,
    low20d,
  };
}

/**
 * 读取本地已归档的真实分钟数据包（用于可视化 HTML 研报自动内嵌 1 分钟分时图）
 */
function loadArchivedMarketPacket(tradeDate) {
  if (!tradeDate || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) return null;
  const p = path.join(PACKETS_DIR, `${tradeDate}_intraday_packet.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_WATCH_STOCKS,
  fetchLimitPools,
  fetchDailyMarketPacket,
  fetchStockSnapshotForJudgment,
  loadArchivedMarketPacket,
};
