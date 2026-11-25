'use strict';

/**
 * 二级投研 · 跨市场标的联网实时资料搜集引擎（支持 A 股 / 美股 / 港股 + 跨市场联动基准）
 *
 * 自动并发从权威公开金融源实时抓取并按《三库格式契约》标定证据等级：
 * - [A股] 腾讯前复权 22 日 K 线 + MA5/MA10/MA20 乖离 + 东财 F10 公司概况/财报/主营拆分/股东筹码与解禁/交易所公告/券商研报/实时新闻
 * - [美股] 东财美股 22 日前复权 K 线 + 实时美元行情/市值/PE/PB/MA5乖离 + 东财美股 F10(GAAP) 近6期季报财报 + 美股公司概况 + 中文实时财经新闻
 * - [港股] 东财港股 22 日前复权 K 线 + 实时港元行情/市值/PE/PB + 实时财经新闻
 * - [跨市场联动] 同步采集 A 股主要指数（上证/创业板/科创50）与美股核心基准（纳指100/标普500/道指/费城半导体 SOX/恒生指数）
 */

const { fetchStockSnapshotForJudgment } = require('./market-fetcher.cjs');
const {
  FUTURES_EXCHANGE_BY_MKT,
  inferMarketMetaFromSecid,
  searchCuratedGlobalCatalog,
} = require('./global-markets.cjs');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
};

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function toYi(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number((n / 1e8).toFixed(2)) : null;
}

function toBillion(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number((n / 1e9).toFixed(3)) : null;
}

function toMillion(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number((n / 1e6).toFixed(2)) : null;
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

async function fetchJson(url, timeoutMs = 9000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url, timeoutMs = 9000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function inferMarketFromCode(num) {
  if (num.startsWith('6') || num.startsWith('9')) return 'SH';
  if (num.startsWith('4') || num.startsWith('8') || num.startsWith('92')) return 'BJ';
  return 'SZ';
}

function normalizeSuggestItem(item) {
  if (!item || !item.Code) return null;
  const code = String(item.Code).trim();
  const mktNum = String(item.MktNum ?? '').trim();
  const classify = String(item.Classify || '').trim();
  const secType = String(item.SecurityTypeName || '').trim();
  const jys = String(item.JYS || '').trim();
  const name = String(item.Name || code).trim();

  // A 股（沪深京 6 位代码）
  if (['1', '0'].includes(mktNum) && /^\d{6}$/.test(code) && (classify === 'AStock' || /A股|科创|创业|主板|北交所|沪A|深A|ETF|基金/i.test(secType))) {
    const market = mktNum === '1' ? 'SH' : inferMarketFromCode(code);
    return {
      resolved: true,
      marketKind: 'CN',
      currency: 'CNY',
      mktNum,
      secid: `${mktNum}.${code}`,
      code,
      market,
      secuCode: `${code}.${market}`,
      f10Code: `${market}${code}`,
      usF10Code: '',
      name,
      boardType: secType || (market === 'SH' ? '沪A' : market === 'BJ' ? '北交所' : '深A'),
      classify,
    };
  }

  // 美股（NASDAQ=105, NYSE=106, AMEX=107）
  if (['105', '106', '107'].includes(mktNum) && (classify === 'UsStock' || /美股|粉单|NASDAQ|NYSE|AMEX/i.test(`${secType} ${jys}`))) {
    const suffix = mktNum === '105' ? 'O' : mktNum === '106' ? 'N' : 'A';
    const exchange = jys || (mktNum === '105' ? 'NASDAQ' : mktNum === '106' ? 'NYSE' : 'AMEX');
    return {
      resolved: true,
      marketKind: 'US',
      currency: 'USD',
      mktNum,
      secid: `${mktNum}.${code}`,
      code,
      market: exchange,
      secuCode: `${code}.US`,
      f10Code: '',
      usF10Code: `${code}.${suffix}`,
      name,
      boardType: `美股 · ${exchange}`,
      classify,
    };
  }

  // 港股（MktNum=116）
  if (mktNum === '116' && /^\d{5}$/.test(code)) {
    return {
      resolved: true,
      marketKind: 'HK',
      currency: 'HKD',
      mktNum,
      secid: `116.${code}`,
      code,
      market: 'HK',
      secuCode: `${code}.HK`,
      f10Code: '',
      usF10Code: '',
      name,
      boardType: secType || '港股',
      classify,
    };
  }

  // 台湾证交所 TWSE (178) / 韩国 KRX (177) / 法国泛欧 XPAR (186) / 英国 LSE (155,156) / 日本 JPX (176) / 德国 XETR (185)
  const intlMap = {
    '178': { marketKind: 'TW', currency: 'TWD', suffix: '.TW', ex: 'TWSE', label: '台股 · TWSE' },
    '177': { marketKind: 'KR', currency: 'KRW', suffix: '.KS', ex: 'KRX', label: '韩股 · KRX' },
    '186': { marketKind: 'FR', currency: 'EUR', suffix: '.PA', ex: 'Euronext Paris', label: '法股 · 泛欧巴黎' },
    '155': { marketKind: 'UK', currency: 'GBp', suffix: '.L', ex: 'LSE', label: '英股 · 伦敦LSE' },
    '156': { marketKind: 'UK', currency: 'GBp', suffix: '.L', ex: 'LSE-IOB', label: '英股 · 伦敦国际板' },
    '176': { marketKind: 'JP', currency: 'JPY', suffix: '.T', ex: 'JPX', label: '日股 · 东京JPX' },
    '185': { marketKind: 'DE', currency: 'EUR', suffix: '.DE', ex: 'XETR', label: '德股 · 法兰克福' },
  };
  if (intlMap[mktNum]) {
    const im = intlMap[mktNum];
    return {
      resolved: true,
      marketKind: im.marketKind,
      currency: im.currency,
      mktNum,
      secid: `${mktNum}.${code}`,
      code,
      market: im.ex,
      secuCode: `${code}${im.suffix}`,
      f10Code: '',
      usF10Code: '',
      name,
      boardType: im.label,
      classify: classify || im.ex,
    };
  }

  // 全球期货交易所 (COMEX / NYMEX / CBOT / SGX / ICE / LME / SHFE / DCE / CZCE / INE / GFEX / CFFEX)
  if (FUTURES_EXCHANGE_BY_MKT[mktNum]) {
    const fm = FUTURES_EXCHANGE_BY_MKT[mktNum];
    return {
      resolved: true,
      marketKind: 'FUT',
      currency: fm.currency,
      mktNum,
      secid: `${mktNum}.${code}`,
      code,
      market: fm.exchange,
      secuCode: `${fm.exchange}.${code}`,
      f10Code: '',
      usF10Code: '',
      name,
      boardType: `期货 · ${fm.labelZh}`,
      classify: 'FUT',
    };
  }

  return null;
}

/**
 * 统一全球跨市场证券与期货搜索（支持 A股 / 美股 / 港股 / 台股 / 韩股 / 法股 / 英股 / 日股 / 德股 / 世界期货）
 */
async function searchSecurities(rawQuery, count = 14) {
  const q = String(rawQuery || '').trim();
  if (!q) return [];
  const seen = new Set();
  const results = [];

  // 1) 优先合并精选全球龙头 & 世界各地期货目录（支持中文别名/英文名/Ticker，如 LVMH/TSMC/Samsung/Shell/Gold/WTI/A50）
  for (const hit of searchCuratedGlobalCatalog(q)) {
    if (seen.has(hit.secid)) continue;
    seen.add(hit.secid);
    results.push(hit);
  }

  // 2) 东财全市场 Suggest API（支持全球 10+ 交易所 + 期货合约实时搜索）
  try {
    const cleanQ = q.replace(/\.(TW|KS|PA|L|T|DE|US|HK|SH|SZ|BJ)$/i, '');
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(cleanQ)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=${Math.min(Math.max(count, 6), 24)}`;
    const json = await fetchJson(url, 6000);
    const rawList = json?.QuotationCodeTable?.Data || [];
    for (const item of rawList) {
      const norm = normalizeSuggestItem(item);
      if (!norm || seen.has(norm.secid)) continue;
      seen.add(norm.secid);
      results.push(norm);
    }
  } catch {
    // keep curated hits even if suggest times out
  }

  return results.slice(0, Math.max(count, 14));
}

/**
 * 将用户输入解析为标准 A 股 / 美股 / 港股标的身份
 * 支持：
 * - A股：「强一股份」「688809」「东山精密（002384.SZ）」「中际旭创 300308」
 * - 美股：「NVDA」「英伟达」「台积电（TSM.US）」「AVGO」「COHR」「AAPL」「美光」
 * - 港股：「00700」「腾讯控股」「00700.HK」
 */
async function resolveStockQuery(rawQuery) {
  const q = String(rawQuery || '').trim();
  if (!q) return { resolved: false, rawQuery: '', marketKind: 'CN', currency: 'CNY' };

  const cnCodeMatch = q.match(/\b(\d{6})\b/);
  const hkCodeMatch = !cnCodeMatch && (q.match(/\b(\d{5})\.HK\b/i) || q.match(/^(\d{5})$/));
  const usExplicitMatch = q.match(/\b([A-Za-z][A-Za-z0-9.\-]{0,5})\.(?:US|O|N|A|NASDAQ|NYSE)\b/i);
  const pureTickerMatch = !cnCodeMatch && !hkCodeMatch && q.match(/^([A-Za-z]{1,6}(?:\.[A-Za-z])?)$/);
  const bracketTickerMatch = !cnCodeMatch && q.match(/[（(]\s*([A-Za-z]{1,6})(?:\.(?:US|O|N|A))?\s*[）)]/i);

  const preferredMarket = cnCodeMatch
    ? 'CN'
    : usExplicitMatch || pureTickerMatch || bracketTickerMatch
    ? 'US'
    : hkCodeMatch
    ? 'HK'
    : '';

  const cleanedName = q
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/\b(?:sh|sz|bj)?\d{6}(?:\.(?:sh|sz|bj))?\b/gi, ' ')
    .replace(/\b[A-Za-z]{1,6}\.(?:US|O|N|A|NASDAQ|NYSE)\b/gi, ' ')
    .trim();

  const searchKey = cnCodeMatch
    ? cnCodeMatch[1]
    : usExplicitMatch
    ? usExplicitMatch[1].toUpperCase()
    : pureTickerMatch
    ? pureTickerMatch[1].toUpperCase()
    : bracketTickerMatch
    ? bracketTickerMatch[1].toUpperCase()
    : hkCodeMatch
    ? hkCodeMatch[1]
    : cleanedName || q;

  try {
    const candidates = await searchSecurities(searchKey, 12);
    if (candidates.length > 0) {
      const upperKey = searchKey.toUpperCase();
      let picked = null;

      if (preferredMarket === 'US') {
        picked =
          candidates.find((c) => c.marketKind === 'US' && c.code.toUpperCase() === upperKey) ||
          candidates.find((c) => c.marketKind === 'US') ||
          candidates[0];
      } else if (preferredMarket === 'CN') {
        picked =
          candidates.find((c) => c.marketKind === 'CN' && c.code === searchKey) ||
          candidates.find((c) => c.marketKind === 'CN') ||
          candidates[0];
      } else if (preferredMarket === 'HK') {
        picked =
          candidates.find((c) => c.marketKind === 'HK' && c.code === searchKey) ||
          candidates.find((c) => c.marketKind === 'HK') ||
          candidates[0];
      } else {
        // 中文名或混合搜索：优先精确名称命中，其次核心股票（A股/美股/港股）
        picked =
          candidates.find((c) => c.name === cleanedName && (c.marketKind === 'CN' || c.marketKind === 'US' || c.marketKind === 'HK')) ||
          candidates.find((c) => c.code.toUpperCase() === upperKey) ||
          candidates.find((c) => c.marketKind === 'CN' && c.classify === 'AStock') ||
          candidates.find((c) => c.marketKind === 'US' && c.classify === 'UsStock') ||
          candidates[0];
      }

      if (picked) {
        return {
          ...picked,
          rawQuery: q,
        };
      }
    }
  } catch {
    // fallback below
  }

  if (cnCodeMatch) {
    const num = cnCodeMatch[1];
    const market = inferMarketFromCode(num);
    const mktNum = market === 'SH' ? '1' : '0';
    return {
      resolved: true,
      rawQuery: q,
      marketKind: 'CN',
      currency: 'CNY',
      mktNum,
      secid: `${mktNum}.${num}`,
      code: num,
      market,
      secuCode: `${num}.${market}`,
      f10Code: `${market}${num}`,
      usF10Code: '',
      name: cleanedName || num,
      boardType: '',
    };
  }

  return {
    resolved: false,
    rawQuery: q,
    marketKind: preferredMarket || 'CN',
    currency: preferredMarket === 'US' ? 'USD' : preferredMarket === 'HK' ? 'HKD' : 'CNY',
    mktNum: '',
    secid: '',
    code: '',
    market: '',
    secuCode: '',
    f10Code: '',
    usF10Code: '',
    name: cleanedName || q,
    boardType: '',
  };
}

/**
 * 抓取美股/港股（及通用东财 secid）22日 K 线 + 实时估值快照
 */
async function fetchEastMoneyStockSnapshot(target) {
  const secid = target.secid;
  if (!secid) return { ok: false, error: '缺少 secid' };

  const quoteFields = 'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23';
  const tencentSym =
    target.marketKind === 'US'
      ? `us${target.code}.${target.mktNum === '106' ? 'N' : target.mktNum === '107' ? 'A' : 'OQ'}`
      : `hk${target.code}`;
  const tencentKlineUrl =
    target.marketKind === 'US'
      ? `https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=${encodeURIComponent(tencentSym)},day,,,22,qfq`
      : `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(tencentSym)},day,,,22,qfq`;

  const [tRes, qRes] = await Promise.allSettled([
    fetchJson(tencentKlineUrl, 8000),
    fetchJson(
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=${quoteFields}&secids=${encodeURIComponent(secid)}`,
      8000
    ),
  ]);

  let klines = [];
  if (tRes.status === 'fulfilled') {
    const node = tRes.value?.data?.[tencentSym];
    const arr = node?.qfqday || node?.day || [];
    klines = arr
      .map((row, idx) => {
        const close = Number(row[2]);
        const prevClose = idx > 0 ? Number(arr[idx - 1][2]) : Number(row[1]);
        return {
          date: String(row[0]),
          open: Number(row[1]),
          close,
          high: Number(row[3]),
          low: Number(row[4]),
          vol: Number(row[5]) || 0,
          amt: 0,
          ampPct: prevClose ? round2(((Number(row[3]) - Number(row[4])) / prevClose) * 100) : null,
          pct: prevClose ? round2(((close - prevClose) / prevClose) * 100) : null,
          chg: prevClose ? round2(close - prevClose) : null,
          turnoverPct: null,
        };
      })
      .filter((k) => Number.isFinite(k.close));
  }

  // 若腾讯日K空，再兜底东财日K
  if (klines.length === 0) {
    try {
      const kJson = await fetchJson(
        `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=22`,
        7000
      );
      klines = (kJson?.data?.klines || [])
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
            ampPct: Number(p[7]),
            pct: Number(p[8]),
            chg: Number(p[9]),
            turnoverPct: Number(p[10]),
          };
        })
        .filter(Boolean);
    } catch {
      // keep empty
    }
  }

  const qItem = qRes.status === 'fulfilled' ? qRes.value?.data?.diff?.[0] : null;
  const kData = null;

  if (!klines.length && !qItem) {
    return {
      ok: false,
      code: target.code,
      name: target.name,
      currency: target.currency,
      marketKind: target.marketKind,
      error: '东财行情与日K暂不可达',
    };
  }

  const latestK = klines[klines.length - 1] || null;
  const closes = klines.map((k) => k.close);
  const livePrice = qItem && qItem.f2 !== '-' && Number.isFinite(Number(qItem.f2)) ? Number(qItem.f2) : latestK?.close ?? null;
  const livePct = qItem && qItem.f3 !== '-' && Number.isFinite(Number(qItem.f3)) ? Number(qItem.f3) : latestK?.pct ?? null;

  const ma5 = closes.length >= 5 ? round2(avg(closes.slice(-5))) : null;
  const ma10 = closes.length >= 10 ? round2(avg(closes.slice(-10))) : null;
  const ma20 = closes.length >= 20 ? round2(avg(closes.slice(-20))) : null;
  const ret5dPct =
    closes.length >= 6 && closes[closes.length - 6] > 0 && livePrice != null
      ? round2(((livePrice - closes[closes.length - 6]) / closes[closes.length - 6]) * 100)
      : null;
  const ret20dPct =
    closes.length >= 20 && closes[0] > 0 && livePrice != null
      ? round2(((livePrice - closes[0]) / closes[0]) * 100)
      : null;

  const rawCap = qItem && qItem.f20 !== '-' ? Number(qItem.f20) : null;
  const rawAmt = qItem && qItem.f6 !== '-' ? Number(qItem.f6) : latestK?.amt ?? null;
  const isUS = target.marketKind === 'US';

  return {
    ok: true,
    fetchedAt: nowOffsetISO(),
    source: isUS ? '东方财富美股实时行情 + 前复权22日K' : '东方财富港股实时行情 + 前复权22日K',
    marketKind: target.marketKind,
    currency: target.currency,
    secid,
    code: target.code,
    name: qItem?.f14 || kData?.name || target.name,
    tradeDate: latestK?.date || nowOffsetISO().slice(0, 10),
    close: round2(livePrice),
    open: round2(qItem && qItem.f17 !== '-' ? qItem.f17 : latestK?.open),
    high: round2(qItem && qItem.f15 !== '-' ? qItem.f15 : latestK?.high),
    low: round2(qItem && qItem.f16 !== '-' ? qItem.f16 : latestK?.low),
    preClose: round2(qItem && qItem.f18 !== '-' ? qItem.f18 : null),
    pct: round2(livePct),
    amountYi: isUS ? null : toYi(rawAmt),
    amountUsdM: isUS ? toMillion(rawAmt) : null,
    amountUsdB: isUS ? toBillion(rawAmt) : null,
    volume: qItem && qItem.f5 !== '-' ? Number(qItem.f5) : latestK?.vol ?? null,
    turnoverPct: round2(qItem && qItem.f8 !== '-' ? qItem.f8 : latestK?.turnoverPct),
    volumeRatio: round2(qItem && qItem.f10 !== '-' ? qItem.f10 : null),
    amplitudePct: round2(qItem && qItem.f7 !== '-' ? qItem.f7 : latestK?.ampPct),
    totalCapYi: isUS ? null : toYi(rawCap),
    totalCapUsdB: isUS ? toBillion(rawCap) : null,
    floatCapYi: null,
    peTtm: round2(qItem && qItem.f9 !== '-' ? qItem.f9 : null),
    pb: round2(qItem && qItem.f23 !== '-' ? qItem.f23 : null),
    ma5,
    ma10,
    ma20,
    aboveMa5: livePrice != null && ma5 != null ? livePrice >= ma5 : null,
    ma5BiasPct: livePrice != null && ma5 ? round2(((livePrice - ma5) / ma5) * 100) : null,
    ret5dPct,
    ret20dPct,
    high20d: klines.length ? round2(Math.max(...klines.map((k) => k.high))) : null,
    low20d: klines.length ? round2(Math.min(...klines.map((k) => k.low))) : null,
  };
}

/**
 * 抓取跨市场核心基准指数快照（A股 + 美股 + SOX + 恒生），用于单标研判中的跨市场联动分析
 */
async function fetchCrossMarketBenchmarks() {
  const benchmarkDefs = [
    { secid: '1.000001', code: '000001.SH', name: '上证指数', nameEn: 'SSE Comp', marketKind: 'CN' },
    { secid: '0.399001', code: '399001.SZ', name: '深证成指', nameEn: 'SZSE Comp', marketKind: 'CN' },
    { secid: '0.399006', code: '399006.SZ', name: '创业板指', nameEn: 'ChiNext', marketKind: 'CN' },
    { secid: '1.000688', code: '000688.SH', name: '科创50', nameEn: 'STAR 50', marketKind: 'CN' },
    { secid: '0.899050', code: '899050.BJ', name: '北证50', nameEn: 'BSE 50', marketKind: 'CN' },
    { secid: '1.000300', code: '000300.SH', name: '沪深300', nameEn: 'CSI 300', marketKind: 'CN' },
    { secid: '100.NDX', code: 'NDX', name: '纳斯达克100', nameEn: 'NASDAQ 100', marketKind: 'US' },
    { secid: '100.SPX', code: 'SPX', name: '标普500', nameEn: 'S&P 500', marketKind: 'US' },
    { secid: '251.SOX', code: 'SOX', name: '费城半导体', nameEn: 'PHLX Semi', marketKind: 'US' },
    { secid: '100.HSI', code: 'HSI', name: '恒生指数', nameEn: 'Hang Seng', marketKind: 'HK' },
    { secid: '100.TWII', code: 'TWII', name: '台湾加权', nameEn: 'TAIEX', marketKind: 'TW' },
    { secid: '100.KS11', code: 'KS11', name: '韩国综合', nameEn: 'KOSPI', marketKind: 'KR' },
    { secid: '100.FCHI', code: 'FCHI', name: '法国CAC40', nameEn: 'CAC 40', marketKind: 'FR' },
    { secid: '100.FTSE', code: 'FTSE', name: '英国富时100', nameEn: 'FTSE 100', marketKind: 'UK' },
    { secid: '100.N225', code: 'N225', name: '日经225', nameEn: 'Nikkei 225', marketKind: 'JP' },
    { secid: '100.GDAXI', code: 'GDAXI', name: '德国DAX', nameEn: 'DAX 40', marketKind: 'DE' },
    { secid: '101.GC00Y', code: 'GC00Y', name: 'COMEX黄金', nameEn: 'COMEX Gold', marketKind: 'FUT' },
    { secid: '102.CL00Y', code: 'CL00Y', name: 'WTI原油', nameEn: 'WTI Crude', marketKind: 'FUT' },
    { secid: '104.CN00Y', code: 'CN00Y', name: '富时A50期指', nameEn: 'SGX A50', marketKind: 'FUT' },
  ];

  const secidsStr = benchmarkDefs.map((b) => b.secid).join(',');
  const emData = await fetchJson(
    `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f4,f6,f7,f12,f13,f14,f15,f16,f18&secids=${encodeURIComponent(secidsStr)}`,
    7000
  );

  const bySecid = new Map();
  if (Array.isArray(emData?.data?.diff)) {
    for (const row of emData.data.diff) {
      bySecid.set(`${row.f13}.${row.f12}`, row);
    }
  }

  const items = [];
  for (const def of benchmarkDefs) {
    const row = bySecid.get(def.secid);
    if (!row || row.f2 === '-') continue;
    items.push({
      secid: def.secid,
      code: def.code,
      name: def.name,
      nameEn: def.nameEn || def.name,
      marketKind: def.marketKind,
      price: round2(row.f2),
      pct: round2(row.f3),
      chg: round2(row.f4),
      high: round2(row.f15),
      low: round2(row.f16),
      preClose: round2(row.f18),
      amplitudePct: round2(row.f7),
      amountYi: def.marketKind === 'CN' ? toYi(row.f6) : null,
    });
  }

  return items;
}

async function fetchEastMoneyNews(keyword, pageSize = 10) {
  const param = {
    uid: '',
    keyword,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: {
      cmsArticleWebOld: {
        searchScope: 'default',
        sort: 'default',
        pageIndex: 1,
        pageSize,
        preTag: '',
        postTag: '',
      },
    },
  };
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(JSON.stringify(param))}`;
  const raw = await fetchText(url, 9000);
  const m = raw.match(/^cb\(([\s\S]*)\)\s*;?$/);
  if (!m) throw new Error('新闻接口返回格式异常');
  const json = JSON.parse(m[1]);
  const rows = json?.result?.cmsArticleWebOld || [];
  return rows.map((r) => ({
    date: String(r.date || '').slice(0, 16),
    title: String(r.title || '').replace(/<[^>]+>/g, '').trim(),
    media: String(r.mediaName || '东方财富网').trim(),
    summary: String(r.content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 260),
    url: r.url || '',
    grade: 'B/C',
  }));
}

/**
 * 联网并发搜集单只标的（A股 / 美股 / 港股）的全维事实资料包 + 跨市场基准
 */
async function collectStockResearchPacket(rawQuery) {
  const collectedAt = nowOffsetISO();
  const target = await resolveStockQuery(rawQuery);
  const errors = [];

  if (!target.resolved) {
    const [newsRes, benchRes] = await Promise.allSettled([
      fetchEastMoneyNews(target.name || rawQuery, 12),
      fetchCrossMarketBenchmarks(),
    ]);
    const news = newsRes.status === 'fulfilled' ? newsRes.value : [];
    if (newsRes.status === 'rejected') errors.push(`财经新闻搜索失败：${newsRes.reason?.message}`);
    const crossMarketBenchmarks = benchRes.status === 'fulfilled' ? benchRes.value : [];
    return {
      ok: news.length > 0,
      collectedAt,
      target,
      snapshot: null,
      profile: null,
      concepts: [],
      coreHighlights: [],
      financials: [],
      businessBreakdown: [],
      shareholders: null,
      announcements: [],
      brokerReports: [],
      news,
      crossMarketBenchmarks,
      counts: {
        financialPeriods: 0,
        announcements: 0,
        brokerReports: 0,
        news: news.length,
      },
      errors,
    };
  }

  // ---------------------------------------------------------------------------
  // 美股（NASDAQ / NYSE / AMEX）权威数据采集管道
  // ---------------------------------------------------------------------------
  if (target.marketKind === 'US') {
    const usF10Code = target.usF10Code || `${target.code}.O`;
    const filterEncoded = encodeURIComponent(`(SECUCODE="${usF10Code}")`);
    const newsKeyword = target.name && /[\u4e00-\u9fa5]/.test(target.name) ? target.name : target.code;

    const [snapRes, profRes, finRes, newsPrimaryRes, newsTickerRes, benchRes] = await Promise.allSettled([
      fetchEastMoneyStockSnapshot(target),
      fetchJson(
        `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_USF10_INFO_ORGPROFILE&columns=ALL&filter=${filterEncoded}&pageNumber=1&pageSize=1`
      ),
      fetchJson(
        `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_USF10_FN_GMAININDICATOR&columns=ALL&filter=${filterEncoded}&pageNumber=1&pageSize=6&sortTypes=-1&sortColumns=REPORT_DATE`
      ),
      fetchEastMoneyNews(newsKeyword, 10),
      newsKeyword !== target.code ? fetchEastMoneyNews(target.code, 6) : Promise.resolve([]),
      fetchCrossMarketBenchmarks(),
    ]);

    const snapshot = snapRes.status === 'fulfilled' ? snapRes.value : null;
    if (snapRes.status === 'rejected') errors.push(`美股实时日K行情：${snapRes.reason?.message}`);

    let profile = null;
    if (profRes.status === 'fulfilled' && profRes.value?.result?.data?.[0]) {
      const p = profRes.value.result.data[0];
      profile = {
        orgName: p.ORG_NAME || p.ORG_EN_ABBR || target.name,
        secType: `美股 · ${p.BELONG_MARKET || target.market}`,
        emIndustry: p.BELONG_INDUSTRY || '',
        csrcIndustry: p.BELONG_MARKET || target.market,
        hShareCode: null,
        chairman: p.CHAIRMAN || '',
        mainBusiness: String(p.ORG_PROFILE || p.MAIN_BUSINESS || p.BUSINESS_SCOPE || `${p.ORG_NAME || target.name} (${target.code}) · ${p.BELONG_INDUSTRY || '美股上市企业'}`).slice(0, 380),
        grade: 'A',
      };
    } else if (profRes.status === 'rejected') {
      errors.push(`美股公司概况F10：${profRes.reason?.message}`);
    }

    let financials = [];
    if (finRes.status === 'fulfilled' && Array.isArray(finRes.value?.result?.data)) {
      financials = finRes.value.result.data.slice(0, 6).map((f) => {
        const curr = f.CURRENCY || '美元';
        return {
          period: f.REPORT_TYPE || String(f.REPORT_DATE || '').slice(0, 10),
          noticeDate: f.NOTICE_DATE ? String(f.NOTICE_DATE).slice(0, 10) : '',
          currency: curr,
          revenueYi: null,
          revenueUsdB: toBillion(f.OPERATE_INCOME),
          revenueYoyPct: round2(f.OPERATE_INCOME_YOY),
          parentNetProfitYi: null,
          parentNetProfitUsdB: toBillion(f.PARENT_HOLDER_NETPROFIT),
          parentNetProfitYoyPct: round2(f.PARENT_HOLDER_NETPROFIT_YOY),
          deductNetProfitYi: null,
          deductNetProfitYoyPct: null,
          grossMarginPct: round2(f.GROSS_PROFIT_RATIO),
          netMarginPct: round2(f.NET_PROFIT_RATIO),
          roePct: round2(f.ROE_AVG),
          debtRatioPct: round2(f.DEBT_ASSET_RATIO),
          eps: round2(f.BASIC_EPS),
          ocfPerShare: null,
          currentRatio: round2(f.CURRENT_RATIO),
          inventoryDays: round2(f.INVENTORY_TDAYS),
          grade: 'A',
        };
      });
    } else if (finRes.status === 'rejected') {
      errors.push(`美股GAAP核心财报F10：${finRes.reason?.message}`);
    }

    const newsSeen = new Set();
    const news = [];
    for (const r of [newsPrimaryRes, newsTickerRes]) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        for (const item of r.value) {
          if (!item.title || newsSeen.has(item.title)) continue;
          newsSeen.add(item.title);
          news.push(item);
        }
      }
    }
    const crossMarketBenchmarks = benchRes.status === 'fulfilled' ? benchRes.value : [];

    return {
      ok: Boolean(snapshot?.ok || financials.length > 0 || news.length > 0),
      collectedAt,
      target,
      snapshot,
      profile,
      concepts: [target.boardType, profile?.emIndustry].filter(Boolean),
      coreHighlights: [],
      financials,
      businessBreakdown: [],
      shareholders: null,
      announcements: [],
      brokerReports: [],
      news: news.slice(0, 14),
      crossMarketBenchmarks,
      counts: {
        financialPeriods: financials.length,
        announcements: 0,
        brokerReports: 0,
        news: Math.min(news.length, 14),
      },
      errors,
    };
  }

  // ---------------------------------------------------------------------------
  // 港股采集管道
  // ---------------------------------------------------------------------------
  if (target.marketKind === 'HK') {
    const [snapRes, newsRes, benchRes] = await Promise.allSettled([
      fetchEastMoneyStockSnapshot(target),
      fetchEastMoneyNews(target.name || target.code, 12),
      fetchCrossMarketBenchmarks(),
    ]);
    const snapshot = snapRes.status === 'fulfilled' ? snapRes.value : null;
    const news = newsRes.status === 'fulfilled' ? newsRes.value : [];
    const crossMarketBenchmarks = benchRes.status === 'fulfilled' ? benchRes.value : [];
    return {
      ok: Boolean(snapshot?.ok || news.length > 0),
      collectedAt,
      target,
      snapshot,
      profile: {
        orgName: target.name,
        secType: target.boardType,
        emIndustry: '',
        csrcIndustry: '香港交易所',
        hShareCode: target.code,
        chairman: '',
        mainBusiness: `${target.name}（${target.secuCode}）港股上市标的`,
        grade: 'A',
      },
      concepts: [target.boardType].filter(Boolean),
      coreHighlights: [],
      financials: [],
      businessBreakdown: [],
      shareholders: null,
      announcements: [],
      brokerReports: [],
      news,
      crossMarketBenchmarks,
      counts: {
        financialPeriods: 0,
        announcements: 0,
        brokerReports: 0,
        news: news.length,
      },
      errors,
    };
  }

  // ---------------------------------------------------------------------------
  // A 股权威全维资料采集管道（+ 跨市场联动基准）
  // ---------------------------------------------------------------------------
  const { code, f10Code, name } = target;
  const nowYear = new Date().getFullYear();
  const beginDate = `${nowYear - 1}-01-01`;
  const endDate = `${nowYear + 1}-12-31`;

  const [snapRes, surveyRes, concRes, finRes, bizRes, shRes, annRes, rptRes, newsRes, benchRes] = await Promise.allSettled([
    fetchStockSnapshotForJudgment(code),
    fetchJson(`https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${f10Code}`),
    fetchJson(`https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=${f10Code}`),
    fetchJson(`https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=${f10Code}`),
    fetchJson(`https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/PageAjax?code=${f10Code}`),
    fetchJson(`https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=${f10Code}`),
    fetchJson(`https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=12&page_index=1&ann_type=A&stock_list=${code}&f_node=0&s_node=0`),
    fetchJson(`https://reportapi.eastmoney.com/report/list?industryCode=*&pageSize=8&industry=*&rating=&ratingChange=&beginTime=${beginDate}&endTime=${endDate}&pageNo=1&fields=&qType=0&orgCode=&code=${code}&rcode=`),
    fetchEastMoneyNews(name, 10),
    fetchCrossMarketBenchmarks(),
  ]);

  const snapshot = snapRes.status === 'fulfilled'
    ? { ...snapRes.value, marketKind: 'CN', currency: 'CNY' }
    : null;
  if (snapRes.status === 'rejected') errors.push(`实时日K行情：${snapRes.reason?.message}`);
  if (snapshot?.ok && snapshot.name && target.name === code) {
    target.name = snapshot.name;
  }

  let profile = null;
  if (surveyRes.status === 'fulfilled' && surveyRes.value?.jbzl?.[0]) {
    const jb = surveyRes.value.jbzl[0];
    profile = {
      orgName: jb.ORG_NAME || '',
      secType: jb.SECURITY_TYPE || target.boardType,
      emIndustry: jb.EM2016 || '',
      csrcIndustry: jb.INDUSTRYCSRC1 || '',
      hShareCode: jb.STR_CODEH || null,
      chairman: jb.CHAIRMAN || '',
      mainBusiness: String(jb.MAIN_BUSINESS || jb.BUSINESS_SCOPE || '').slice(0, 320),
      grade: 'A',
    };
  } else if (surveyRes.status === 'rejected') {
    errors.push(`公司概况F10：${surveyRes.reason?.message}`);
  }

  let concepts = [];
  let coreHighlights = [];
  if (concRes.status === 'fulfilled' && concRes.value) {
    concepts = (concRes.value.ssbk || []).slice(0, 12).map((x) => x.BOARD_NAME).filter(Boolean);
    coreHighlights = (concRes.value.hxtc || [])
      .filter((x) => x.KEYWORD && x.KEYWORD !== '经营范围')
      .slice(0, 5)
      .map((x) => ({
        keyword: x.KEYWORD,
        detail: String(x.MAINPOINT_CONTENT || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      }));
  }

  let financials = [];
  if (finRes.status === 'fulfilled' && Array.isArray(finRes.value?.data)) {
    financials = finRes.value.data.slice(0, 5).map((f) => ({
      period: f.REPORT_DATE_NAME || String(f.REPORT_DATE || '').slice(0, 10),
      noticeDate: f.NOTICE_DATE ? String(f.NOTICE_DATE).slice(0, 10) : '',
      currency: '人民币',
      revenueYi: toYi(f.TOTALOPERATEREVE),
      revenueUsdB: null,
      revenueYoyPct: round2(f.TOTALOPERATEREVETZ),
      parentNetProfitYi: toYi(f.PARENTNETPROFIT),
      parentNetProfitUsdB: null,
      parentNetProfitYoyPct: round2(f.PARENTNETPROFITTZ),
      deductNetProfitYi: toYi(f.KCFJCXSYJLR),
      deductNetProfitYoyPct: round2(f.KCFJCXSYJLRTZ),
      grossMarginPct: round2(f.XSMLL),
      netMarginPct: round2(f.XSJLL),
      roePct: round2(f.ROEJQ),
      debtRatioPct: round2(f.ZCFZL),
      eps: round2(f.EPSJB),
      ocfPerShare: round2(f.MGJYXJJE),
      grade: 'A',
    }));
  } else if (finRes.status === 'rejected') {
    errors.push(`核心财报F10：${finRes.reason?.message}`);
  }

  let businessBreakdown = [];
  if (bizRes.status === 'fulfilled' && Array.isArray(bizRes.value?.zygcfx) && bizRes.value.zygcfx.length > 0) {
    const latestDate = bizRes.value.zygcfx[0].REPORT_DATE;
    businessBreakdown = bizRes.value.zygcfx
      .filter((x) => x.REPORT_DATE === latestDate && x.ITEM_NAME && x.ITEM_NAME !== '分部间抵销')
      .slice(0, 10)
      .map((x) => ({
        reportDate: String(x.REPORT_DATE || '').slice(0, 10),
        dimension: x.MAINOP_TYPE === '3' ? '按地区' : x.MAINOP_TYPE === '1' ? '按行业' : '按产品',
        item: x.ITEM_NAME,
        revenueYi: toYi(x.MAIN_BUSINESS_INCOME),
        revenueSharePct: x.MBI_RATIO != null ? round2(Number(x.MBI_RATIO) * 100) : null,
        grossMarginPct: x.GROSS_RPOFIT_RATIO != null ? round2(Number(x.GROSS_RPOFIT_RATIO) * 100) : null,
        grade: 'A',
      }));
  }

  let shareholders = null;
  if (shRes.status === 'fulfilled' && shRes.value) {
    const gdrs = (shRes.value.gdrs || []).slice(0, 3).map((g) => ({
      endDate: String(g.END_DATE || '').slice(0, 10),
      holderCount: g.HOLDER_TOTAL_NUM ?? null,
      holderChangePct: round2(g.TOTAL_NUM_RATIO),
      concentration: g.HOLD_FOCUS || '',
      avgHoldAmtWan: g.AVG_HOLD_AMT != null ? round2(Number(g.AVG_HOLD_AMT) / 10000) : null,
    }));
    const lockups = (shRes.value.xsjj || []).slice(0, 4).map((l) => ({
      unlockDate: String(l.FREE_DATE || '').slice(0, 10),
      sharesWan: l.FREE_SHARES != null ? round2(Number(l.FREE_SHARES) / 10000) : null,
      ratioOfTotalPct: l.TOTAL_RATIO != null ? round2(Number(l.TOTAL_RATIO) * 100) : null,
      type: l.SHARES_TYPE || '',
    }));
    const topHolders = (shRes.value.sdltgd || []).slice(0, 5).map((h) => ({
      name: h.HOLDER_NAME || '',
      ratioPct: round2(h.FREE_HOLDNUM_RATIO),
      change: h.HOLDNUM_CHANGE_NAME || '',
    }));
    shareholders = { gdrs, lockups, topHolders, grade: 'A' };
  }

  let announcements = [];
  if (annRes.status === 'fulfilled' && Array.isArray(annRes.value?.data?.list)) {
    announcements = annRes.value.data.list.slice(0, 12).map((a) => ({
      date: String(a.notice_date || a.display_time || '').slice(0, 10),
      category: a.columns?.[0]?.column_name || '公司公告',
      title: String(a.title || '').trim(),
      url: a.art_code ? `https://data.eastmoney.com/notices/detail/${code}/${a.art_code}.html` : '',
      grade: 'A',
    }));
  } else if (annRes.status === 'rejected') {
    errors.push(`交易所公告：${annRes.reason?.message}`);
  }

  let brokerReports = [];
  if (rptRes.status === 'fulfilled' && Array.isArray(rptRes.value?.data)) {
    brokerReports = rptRes.value.data.slice(0, 8).map((r) => ({
      date: String(r.publishDate || '').slice(0, 10),
      org: r.orgSName || r.orgName || '',
      title: String(r.title || '').trim(),
      rating: r.emRatingName || '',
      epsThisYear: r.predictThisYearEps !== '' && r.predictThisYearEps != null ? round2(r.predictThisYearEps) : null,
      peThisYear: r.predictThisYearPe !== '' && r.predictThisYearPe != null ? round2(r.predictThisYearPe) : null,
      epsNextYear: r.predictNextYearEps !== '' && r.predictNextYearEps != null ? round2(r.predictNextYearEps) : null,
      peNextYear: r.predictNextYearPe !== '' && r.predictNextYearPe != null ? round2(r.predictNextYearPe) : null,
      epsNextTwoYear: r.predictNextTwoYearEps !== '' && r.predictNextTwoYearEps != null ? round2(r.predictNextTwoYearEps) : null,
      url: r.infoCode ? `https://data.eastmoney.com/report/zw_stock.jshtml?infocode=${r.infoCode}` : '',
      grade: 'B',
    }));
  } else if (rptRes.status === 'rejected') {
    errors.push(`券商研报列表：${rptRes.reason?.message}`);
  }

  let news = [];
  if (newsRes.status === 'fulfilled') {
    news = newsRes.value;
  } else if (newsRes.status === 'rejected') {
    errors.push(`财经新闻检索：${newsRes.reason?.message}`);
  }

  const crossMarketBenchmarks = benchRes.status === 'fulfilled' ? benchRes.value : [];

  return {
    ok: Boolean(snapshot?.ok || financials.length > 0 || announcements.length > 0 || news.length > 0),
    collectedAt,
    target,
    snapshot,
    profile,
    concepts,
    coreHighlights,
    financials,
    businessBreakdown,
    shareholders,
    announcements,
    brokerReports,
    news,
    crossMarketBenchmarks,
    counts: {
      financialPeriods: financials.length,
      announcements: announcements.length,
      brokerReports: brokerReports.length,
      news: news.length,
    },
    errors,
  };
}

module.exports = {
  searchSecurities,
  resolveStockQuery,
  fetchEastMoneyStockSnapshot,
  fetchCrossMarketBenchmarks,
  collectStockResearchPacket,
};
