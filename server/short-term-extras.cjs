'use strict';

/**
 * A 股特色短线扩展模块（全面补齐弈盘精华 + 实时信息流）
 *
 * 1) fetchShortTermSprite()          -> 东财「短线精灵」实时盘口异动流（火箭发射/大笔买入/封涨停板/打开涨停/急速跳水等22种盘口信号）
 * 2) fetchHotRankBoard()             -> 东财人气热股榜 Top 25（实时排名 + 现价/涨跌幅/连板/换手）
 * 3) fetchShortTermNewsFeeds()       -> 短线专属实时信息流（短线精灵 + 华尔街见闻A股/全球 + 东财7×24 + 韭研公社热议直连摘要）
 * 4) fetchCloudTreemapData()         -> 弈盘双云图：题材云图（成交额面积×涨跌色）+ 情绪云图（涨停封单金额面积×题材分组）
 * 5) fetchAuctionSealRadar()         -> 弈盘竞价与封单强度雷达（早盘竞价抢筹/涨停封单Top10/封流比Top10）
 * 6) fetchDragonTigerList()          -> 弈盘风格龙虎榜（近10日上榜数与净额趋势 + 机构/游资/深沪股通标签明细）
 * 7) fetchSectorRotationQuadrant()   -> 弈盘板块轮动四象限（60日/20日涨幅 vs 近5日涨幅：高强/低强潜伏/高弱/低弱）
 * 8) loadReviewTraining / saveReviewTraining -> 弈盘复盘训练营（每日3步盘感打卡：情绪周期6态 + 主线/次主线 + 总龙头/题材龙头/中军/跟风）
 */

const fs = require('node:fs');
const path = require('node:path');
const { stateFile } = require('./app-paths.cjs');
const { getEditionInfo } = require('./edition.cjs');
const { fetchMultiTimeframeKlines } = require('./watchlist-service.cjs');
const {
  routeShortTermSprite,
  routeShortTermAuction,
  routeShortTermLhb,
  mergeRoutedNewsFeeds,
} = require('./data-source-router.cjs');
const { loadIntelConfig, fetchRssFeeds } = require('./intel-hub.cjs');

let cachedCommunityExt = undefined;
function getCommunityScrapersExt() {
  if (!getEditionInfo().features.allowCommunityScrapers) return null;
  if (cachedCommunityExt !== undefined) return cachedCommunityExt;
  try {
    const extPath = path.join(__dirname, 'extensions', 'community-scrapers.cjs');
    if (fs.existsSync(extPath)) {
      const dynamicRequire = eval('require');
      cachedCommunityExt = dynamicRequire(extPath);
      return cachedCommunityExt;
    }
  } catch {
    // ignore missing optional personal extension
  }
  cachedCommunityExt = null;
  return null;
}

const TRAINING_PATH = stateFile('review-training.local.json');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
};

const SPRITE_TYPE_MAP = {
  8201: { label: '火箭发射', labelEn: 'Rocket Surge', side: 'bull' },
  8202: { label: '快速反弹', labelEn: 'Quick Rebound', side: 'bull' },
  8193: { label: '大笔买入', labelEn: 'Big Buy Block', side: 'bull' },
  4: { label: '封涨停板', labelEn: 'Limit-Up Sealed', side: 'bull' },
  32: { label: '打开跌停', labelEn: 'Limit-Down Opened', side: 'bull' },
  64: { label: '有大买盘', labelEn: 'Large Bid Wall', side: 'bull' },
  8207: { label: '竞价上涨', labelEn: 'Auction Up', side: 'bull' },
  8209: { label: '高开5日线', labelEn: 'Gap Above MA5', side: 'bull' },
  8211: { label: '向上缺口', labelEn: 'Gap Up', side: 'bull' },
  8213: { label: '60日新高', labelEn: '60D New High', side: 'bull' },
  8215: { label: '60日大涨', labelEn: '60D Surge', side: 'bull' },
  8204: { label: '加速下跌', labelEn: 'Accel Drop', side: 'bear' },
  8203: { label: '高台跳水', labelEn: 'Flash Dive', side: 'bear' },
  8194: { label: '大笔卖出', labelEn: 'Big Sell Block', side: 'bear' },
  8: { label: '封跌停板', labelEn: 'Limit-Down Sealed', side: 'bear' },
  16: { label: '打开涨停', labelEn: 'Limit-Up Opened', side: 'bear' },
  128: { label: '有大卖盘', labelEn: 'Large Ask Wall', side: 'bear' },
  8208: { label: '竞价下跌', labelEn: 'Auction Down', side: 'bear' },
  8210: { label: '低开5日线', labelEn: 'Gap Below MA5', side: 'bear' },
  8212: { label: '向下缺口', labelEn: 'Gap Down', side: 'bear' },
  8214: { label: '60日新低', labelEn: '60D New Low', side: 'bear' },
  8216: { label: '60日大跌', labelEn: '60D Plunge', side: 'bear' },
};

const memCache = new Map();
function getCached(key, ttlMs) {
  const h = memCache.get(key);
  if (h && Date.now() - h.ts < ttlMs) return h.data;
  return null;
}
function setCached(key, data) {
  memCache.set(key, { ts: Date.now(), data });
  return data;
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
function todayYYYYMMDD() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
function codeToSecid(code) {
  const c = String(code || '').replace(/^(SH|SZ|BJ)/i, '').trim();
  if (!/^\d{6}$/.test(c)) return '';
  return c.startsWith('6') || c.startsWith('9') ? `1.${c}` : `0.${c}`;
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { ...HEADERS, ...(opts.headers || {}) },
    body: opts.body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ============================================================================
// 1. A 股短线精灵（盘口实时异动信号流）
// ============================================================================

async function fetchDefaultShortTermSprite(pageSize = 40, sideFilter = 'all') {
  const cacheKey = `sprite_${pageSize}_${sideFilter}`;
  const hit = getCached(cacheKey, 12000);
  if (hit) return hit;

  const bullTypes = '8201,8202,8193,4,32,64,8207,8209,8211,8213,8215';
  const bearTypes = '8204,8203,8194,8,16,128,8208,8210,8212,8214,8216';
  const limitTypes = '4,8,16,32';
  const types =
    sideFilter === 'bull' ? bullTypes : sideFilter === 'bear' ? bearTypes : sideFilter === 'limit' ? limitTypes : `${bullTypes},${bearTypes}`;

  const url = `https://push2ex.eastmoney.com/getAllStockChanges?type=${types}&pageindex=0&pagesize=${Math.min(pageSize, 80)}&ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wzchanges`;
  const json = await fetchJson(url, {}, 7500);
  const raw = json?.data?.allstock || [];

  const items = raw.map((r, idx) => {
    const tmStr = String(r.tm || '').padStart(6, '0');
    const time = `${tmStr.slice(0, 2)}:${tmStr.slice(2, 4)}:${tmStr.slice(4, 6)}`;
    const tCode = Number(r.t);
    const meta = SPRITE_TYPE_MAP[tCode] || { label: `异动(${tCode})`, labelEn: `Signal(${tCode})`, side: 'bull' };
    const infoParts = String(r.i || '').split(',');
    const price = infoParts[1] ? round2(Number(infoParts[1])) : null;
    const pct = infoParts[2] ? round2(Number(infoParts[2]) * 100) : null;
    const mkt = Number(r.m) === 1 ? '1' : '0';
    return {
      id: `sp-${r.c}-${r.tm}-${idx}`,
      time,
      code: String(r.c || ''),
      secid: `${mkt}.${r.c}`,
      name: String(r.n || ''),
      typeCode: tCode,
      typeLabel: meta.label,
      typeLabelEn: meta.labelEn,
      side: meta.side,
      infoRaw: String(r.i || ''),
      price,
      pct,
    };
  });

  return setCached(cacheKey, {
    ok: true,
    totalCount: Number(json?.data?.tc || items.length),
    fetchedAt: nowOffsetISO(),
    items,
  });
}

async function fetchShortTermSprite(pageSize = 40, sideFilter = 'all') {
  return routeShortTermSprite(fetchDefaultShortTermSprite, pageSize, sideFilter);
}

// ============================================================================
// 2. 东财人气热股榜（对标弈盘顶部四平台热股榜）
// ============================================================================

async function fetchHotRankBoard(pageSize = 25) {
  const cacheKey = `hot_rank_${pageSize}`;
  const hit = getCached(cacheKey, 25000);
  if (hit) return hit;

  const json = await fetchJson(
    'https://emappdata.eastmoney.com/stockrank/getAllCurrentList',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'appId01',
        globalId: '786e4c21-70dc-435a-93bb-38',
        marketType: '',
        pageNo: 1,
        pageSize: Math.min(pageSize, 40),
      }),
    },
    7500
  );

  const list = json?.data || [];
  const secids = list.map((x) => codeToSecid(x.sc)).filter(Boolean);
  const qRes = secids.length
    ? await fetchJson(
        `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f6,f8,f12,f13,f14,f100&secids=${encodeURIComponent(secids.join(','))}`,
        7000
      ).catch(() => null)
    : null;

  const bySecid = new Map();
  for (const r of qRes?.data?.diff || []) bySecid.set(`${r.f13}.${r.f12}`, r);

  const items = list.map((x) => {
    const secid = codeToSecid(x.sc);
    const q = bySecid.get(secid) || {};
    const code = String(x.sc || '').replace(/^(SH|SZ|BJ)/i, '');
    return {
      rank: Number(x.rk || 0),
      rankChange: Number(x.rc || 0),
      hisRankChange: Number(x.hisRc || 0),
      secid,
      code,
      name: String(q.f14 || code),
      industry: String(q.f100 || ''),
      price: q.f2 !== '-' ? round2(q.f2) : null,
      pct: q.f3 !== '-' ? round2(q.f3) : null,
      amountYi: q.f6 !== '-' ? toYi(q.f6) : null,
      turnoverPct: q.f8 !== '-' ? round2(q.f8) : null,
      platform: '东方财富人气',
    };
  });

  return setCached(cacheKey, { ok: true, fetchedAt: nowOffsetISO(), items });
}

// ============================================================================
// 3. 短线专属多源实时信息流（个人版启用扩展快讯；商业版严禁抓取未授权社区站点，仅走合规适配器/Webhook/RSS）
// ============================================================================

async function fetchDefaultNewsStreams() {
  const ed = getEditionInfo();
  if (!ed.features.allowCommunityScrapers) {
    return { defaultLiveNews: [], defaultCatalysts: [] };
  }
  const hit = getCached('st_news_default_streams', 20000);
  if (hit) return hit;

  const ext = getCommunityScrapersExt();
  if (!ext || typeof ext.fetchPersonalCommunityNewsStreams !== 'function') {
    return { defaultLiveNews: [], defaultCatalysts: [] };
  }
  const res = await ext.fetchPersonalCommunityNewsStreams().catch(() => ({
    defaultLiveNews: [],
    defaultCatalysts: [],
  }));
  return setCached('st_news_default_streams', res);
}

async function fetchDefaultRssShortTermItems() {
  const hit = getCached('st_news_rss_default', 180000);
  if (hit) return hit;
  try {
    const intelCfg = loadIntelConfig();
    const since = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const rssRes = await Promise.race([
      fetchRssFeeds(intelCfg, since),
      new Promise((resolve) => setTimeout(() => resolve({ items: [] }), 3500)),
    ]);
    const mapped = (rssRes?.items || []).slice(0, 12).map((it) => {
      const ts = Date.parse(String(it.publishedAt || it.date || '').replace(' ', 'T')) || Date.now();
      return {
        id: `rss-${it.itemKey}`,
        time: String(it.publishedAt || '').slice(11, 16) || String(it.date || '').slice(5, 10) || '--:--',
        timestamp: ts,
        source: it.sourceName || 'RSS订阅',
        channel: 'rss',
        title: String(it.title || '').trim(),
        summary: String(it.content || '').slice(0, 240),
        content: String(it.content || '').slice(0, 4000),
        url: it.url || null,
        important: false,
      };
    });
    return setCached('st_news_rss_default', mapped);
  } catch {
    return [];
  }
}

async function fetchShortTermNewsFeeds() {
  const [spriteRes, hotRes, merged] = await Promise.all([
    fetchShortTermSprite(36, 'all').catch(() => ({ items: [], totalCount: 0 })),
    fetchHotRankBoard(20).catch(() => ({ items: [] })),
    mergeRoutedNewsFeeds(
      async () => (await fetchDefaultNewsStreams()).defaultLiveNews,
      async () => (await fetchDefaultNewsStreams()).defaultCatalysts,
      fetchDefaultRssShortTermItems
    ),
  ]);

  const ext = getCommunityScrapersExt();
  const communityLinks = ext && typeof ext.getPersonalCommunityLinks === 'function' ? ext.getPersonalCommunityLinks() : [];

  return {
    ok: true,
    fetchedAt: nowOffsetISO(),
    sprite: spriteRes,
    hotRanks: hotRes.items || [],
    liveNews: merged.liveNews,
    companyCatalysts: merged.companyCatalysts,
    webhookCount: merged.webhookCount,
    customPollCount: merged.customPollCount,
    sourceTier: merged.sourceTier,
    fallbackError: merged.fallbackError,
    communitySlot: merged.communitySlot,
    communityLinks,
  };
}

// ============================================================================
// 4. 弈盘双云图：题材云图（成交额面积×涨跌色）+ 情绪云图（封单金额面积×题材分组）
// ============================================================================

const NON_THEME_CONCEPT_RE = /融资融券|深股通|沪股通|MSCI|富时罗素|标准普尔|机构重仓|基金重仓|基金减仓|大盘|小盘|中盘|微盘|昨日|HS300|深成500|创业板综|中证500|中证1000|上证|国企改革|央国企|破净|预盈|预增|中报|季报|年报|ST股|转债|百元股|低价股|高价股|证金|社保|QFII|送转|分红|AB股|独角兽|风格|成长|价值|蓝筹|白马|次新|注册制|新股|专精特新|证监|股权|参股|举牌|增持|回购|摘帽|解禁|板块|沪企|深企|京企|浙企|粤企|苏企|鲁企|川渝|长三角|珠三角|雄安|自贸|地方|标准|高股息|红利|出海|并购|重组|活跃股|连板|涨停|跌停|高振幅|放量/;

async function fetchCloudTreemapData() {
  const hit = getCached('cloud_treemap', 25000);
  if (hit) return hit;

  const [conceptRes, ztRes] = await Promise.all([
    fetchJson(
      'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=140&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f6&fs=m:90+t:3+f:!50&fields=f12,f14,f2,f3,f6,f62,f104,f105,f128,f136',
      8500
    ).catch(() => null),
    fetchJson(
      `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fund:desc&date=${todayYYYYMMDD()}`,
      8500
    ).catch(() => null),
  ]);

  const rawConcepts = conceptRes?.data?.diff || [];
  const themeBlocks = rawConcepts
    .filter((r) => r.f6 !== '-' && Number(r.f6) > 0 && !NON_THEME_CONCEPT_RE.test(String(r.f14 || '')))
    .slice(0, 32)
    .map((r) => ({
      code: String(r.f12 || ''),
      secid: `90.${r.f12}`,
      name: String(r.f14 || ''),
      pct: r.f3 !== '-' ? round2(r.f3) : 0,
      amountYi: toYi(r.f6) || 0,
      mainNetYi: r.f62 !== '-' ? toYi(r.f62) : null,
      upCount: Number(r.f104 || 0),
      downCount: Number(r.f105 || 0),
      totalCount: Number(r.f104 || 0) + Number(r.f105 || 0),
      leaderName: String(r.f128 || ''),
      leaderPct: r.f136 !== '-' ? round2(r.f136) : null,
    }));

  const ztPool = ztRes?.data?.pool || [];
  let totalSealYi = 0;
  const byGroup = new Map();
  for (const s of ztPool) {
    const sealYi = round2(Number(s.fund || 0) / 1e8) || 0;
    const floatCapYi = round2(Number(s.ltsz || 0) / 1e8) || 0;
    const sealToFloatPct = floatCapYi > 0 ? round2((sealYi / floatCapYi) * 100) : null;
    totalSealYi += sealYi;
    const theme = String(s.hybk || '其他').trim();
    if (!byGroup.has(theme)) byGroup.set(theme, { theme, totalSealYi: 0, stocks: [] });
    const g = byGroup.get(theme);
    g.totalSealYi = round2(g.totalSealYi + sealYi);
    g.stocks.push({
      secid: codeToSecid(s.c),
      code: String(s.c || ''),
      name: String(s.n || ''),
      lbc: Number(s.lbc || 1),
      sealFundYi: sealYi,
      floatCapYi,
      sealToFloatPct,
      amountYi: round2(Number(s.amount || 0) / 1e8),
      pct: round2(Number(s.zdp)),
    });
  }

  const emotionGroups = [...byGroup.values()]
    .map((g) => ({
      ...g,
      stocks: g.stocks.sort((a, b) => b.sealFundYi - a.sealFundYi),
    }))
    .sort((a, b) => b.totalSealYi - a.totalSealYi);

  return setCached('cloud_treemap', {
    ok: true,
    fetchedAt: nowOffsetISO(),
    themeBlocks,
    emotionSummary: {
      ztCount: ztPool.length,
      totalSealYi: round2(totalSealYi),
      groupCount: emotionGroups.length,
    },
    emotionGroups,
  });
}

// ============================================================================
// 5. 弈盘竞价与封单强度雷达（涨停委买/封单额 Top10 + 封流比 Top10 + 竞价高开抢筹榜）
// ============================================================================

async function fetchDefaultAuctionSealRadar() {
  const hit = getCached('auction_radar', 25000);
  if (hit) return hit;

  const [ztRes, openGapRes] = await Promise.all([
    fetchJson(
      `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fund:desc&date=${todayYYYYMMDD()}`,
      8000
    ).catch(() => null),
    fetchJson(
      'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=40&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f10&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f13,f14,f2,f3,f6,f8,f10,f17,f18,f21,f62,f100',
      8000
    ).catch(() => null),
  ]);

  const ztItems = (ztRes?.data?.pool || []).map((s) => {
    const sealYi = round2(Number(s.fund || 0) / 1e8) || 0;
    const floatCapYi = round2(Number(s.ltsz || 0) / 1e8) || 0;
    const sealRatioPct = floatCapYi > 0 ? round2((sealYi / floatCapYi) * 100) : 0;
    const fbtRaw = String(s.fbt || '').padStart(6, '0');
    const firstSealTime = `${fbtRaw.slice(0, 2)}:${fbtRaw.slice(2, 4)}`;
    return {
      secid: codeToSecid(s.c),
      code: String(s.c || ''),
      name: String(s.n || ''),
      price: round2(Number(s.p || 0) / 1000),
      pct: round2(Number(s.zdp)),
      lbc: Number(s.lbc || 1),
      sealFundYi: sealYi,
      floatCapYi,
      sealRatioPct,
      amountYi: round2(Number(s.amount || 0) / 1e8),
      turnoverPct: round2(Number(s.hs)),
      firstSealTime,
      isAuctionSeal: firstSealTime === '09:25',
      industry: String(s.hybk || ''),
    };
  });

  const topSealAmount = [...ztItems].sort((a, b) => b.sealFundYi - a.sealFundYi).slice(0, 10);
  const topSealRatio = [...ztItems].sort((a, b) => b.sealRatioPct - a.sealRatioPct).slice(0, 10);

  const openMovers = (openGapRes?.data?.diff || [])
    .map((r) => {
      const open = r.f17 !== '-' ? Number(r.f17) : null;
      const preClose = r.f18 !== '-' ? Number(r.f18) : null;
      const openGapPct = open != null && preClose && preClose > 0 ? round2(((open - preClose) / preClose) * 100) : null;
      return {
        secid: `${r.f13}.${r.f12}`,
        code: String(r.f12 || ''),
        name: String(r.f14 || ''),
        price: r.f2 !== '-' ? round2(r.f2) : null,
        pct: r.f3 !== '-' ? round2(r.f3) : null,
        openGapPct,
        volumeRatio: r.f10 !== '-' ? round2(r.f10) : null,
        amountYi: r.f6 !== '-' ? toYi(r.f6) : null,
        mainNetYi: r.f62 !== '-' ? toYi(r.f62) : null,
        floatCapYi: r.f21 !== '-' ? toYi(r.f21) : null,
        turnoverPct: r.f8 !== '-' ? round2(r.f8) : null,
        industry: String(r.f100 || ''),
      };
    })
    .filter((x) => x.openGapPct != null)
    .sort((a, b) => (b.openGapPct ?? -99) - (a.openGapPct ?? -99))
    .slice(0, 24);

  return setCached('auction_radar', {
    ok: true,
    fetchedAt: nowOffsetISO(),
    topSealAmount,
    topSealRatio,
    auctionSeals: ztItems.filter((x) => x.isAuctionSeal).slice(0, 20),
    openMovers,
  });
}

async function fetchAuctionSealRadar() {
  return routeShortTermAuction(fetchDefaultAuctionSealRadar);
}

// ============================================================================
// 6. 弈盘风格龙虎榜（近10日上榜趋势 + 当日全部明细 + 机构/游资标签）
// ============================================================================

async function fetchDefaultDragonTigerList(daysBack = 14) {
  const hit = getCached(`lhb_${daysBack}`, 60000);
  if (hit) return hit;

  const since = new Date(Date.now() - daysBack * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  const sinceStr = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`;

  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE,BILLBOARD_NET_AMT&sortTypes=-1,-1&pageSize=300&pageNumber=1&reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_DATE,EXPLAIN,CLOSE_PRICE,CHANGE_RATE,BILLBOARD_NET_AMT,BILLBOARD_BUY_AMT,BILLBOARD_SELL_AMT,TURNOVERRATE,ACCUM_AMOUNT,D1_CLOSE_ADJCHRATE&filter=(TRADE_DATE%3E%3D%27${sinceStr}%27)`;
  const json = await fetchJson(url, {}, 9000);
  const rows = json?.result?.data || [];

  // 按交易日聚合近10日趋势
  const byDate = new Map();
  for (const r of rows) {
    const dt = String(r.TRADE_DATE || '').slice(0, 10);
    if (!dt) continue;
    if (!byDate.has(dt)) byDate.set(dt, { date: dt, codes: new Set(), netAmtYi: 0, buyAmtYi: 0, items: [] });
    const bucket = byDate.get(dt);
    const code = String(r.SECURITY_CODE || '');
    bucket.codes.add(code);
    const netYi = Number(r.BILLBOARD_NET_AMT || 0) / 1e8;
    const buyYi = Number(r.BILLBOARD_BUY_AMT || 0) / 1e8;
    const sellYi = Number(r.BILLBOARD_SELL_AMT || 0) / 1e8;
    bucket.netAmtYi += netYi;
    bucket.buyAmtYi += buyYi;

    // 避免同日多条上榜原因重复展示：合并原因
    const existing = bucket.items.find((x) => x.code === code);
    const reason = String(r.EXPLAIN || '').trim();
    if (existing) {
      if (reason && !existing.reasons.includes(reason)) existing.reasons.push(reason);
    } else {
      bucket.items.push({
        secid: codeToSecid(code),
        code,
        name: String(r.SECURITY_NAME_ABBR || code),
        date: dt,
        price: round2(r.CLOSE_PRICE),
        pct: round2(r.CHANGE_RATE),
        turnoverPct: round2(r.TURNOVERRATE),
        buyYi: round2(buyYi),
        sellYi: round2(sellYi),
        netYi: round2(netYi),
        reasons: reason ? [reason] : [],
        isThreeDay: /三个交易日/.test(reason),
        tags: [
          /三个交易日/.test(reason) ? '三日榜' : '单日榜',
          netYi >= 1 ? '大额净买≥1亿' : netYi <= -1 ? '大额净卖' : '',
          Number(r.CHANGE_RATE) >= 19.5 ? '20cm涨停' : Number(r.CHANGE_RATE) >= 9.7 ? '涨停上榜' : '',
        ].filter(Boolean),
      });
    }
  }

  const trend = [...byDate.values()]
    .map((b) => ({
      date: b.date,
      stockCount: b.codes.size,
      netAmtYi: round2(b.netAmtYi),
      buyAmtYi: round2(b.buyAmtYi),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-10);

  const latestDate = trend.length ? trend[trend.length - 1].date : '';
  const latestItems = latestDate ? (byDate.get(latestDate)?.items || []).sort((a, b) => (b.netYi ?? 0) - (a.netYi ?? 0)) : [];

  return setCached(`lhb_${daysBack}`, {
    ok: true,
    fetchedAt: nowOffsetISO(),
    latestDate,
    trend,
    items: latestItems,
  });
}

async function fetchDragonTigerList(daysBack = 14) {
  return routeShortTermLhb(fetchDefaultDragonTigerList, daysBack);
}

// ============================================================================
// 7. 弈盘板块轮动四象限（60日涨幅 vs 近5日涨幅：高强/低强/高弱/低弱）
// ============================================================================

async function fetchSectorRotationQuadrant() {
  const hit = getCached('sector_rotation_quad', 120000);
  if (hit) return hit;

  const res = await fetchJson(
    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=32&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f6&fs=m:90+t:2+f:!50&fields=f12,f14,f3,f6,f62',
    8500
  ).catch(() => null);
  const boards = (res?.data?.diff || []).slice(0, 28);

  const items = [];
  const batchSize = 6;
  for (let i = 0; i < boards.length; i += batchSize) {
    const chunk = boards.slice(i, i + batchSize);
    const out = await Promise.all(
      chunk.map(async (b) => {
        const secid = `90.${b.f12}`;
        const ks = await fetchMultiTimeframeKlines(secid, 'CN', 'day', 65).catch(() => []);
        if (!ks || ks.length < 10) return null;
        const last = ks[ks.length - 1].close;
        const p5 = ks[Math.max(0, ks.length - 6)].close;
        const p60 = ks[0].close;
        const ret5dPct = p5 > 0 ? round2(((last - p5) / p5) * 100) : 0;
        const ret60dPct = p60 > 0 ? round2(((last - p60) / p60) * 100) : 0;
        const quadrant =
          ret60dPct >= 0 && ret5dPct >= 0
            ? 'high_strong' // 高位走强（主线主升）
            : ret60dPct < 0 && ret5dPct >= 0
            ? 'low_strong' // 低位转强（潜伏轮动/超跌修复）
            : ret60dPct >= 0 && ret5dPct < 0
            ? 'high_weak' // 高位转弱（分歧兑现）
            : 'low_weak'; // 低位走弱（弱势回避）
        return {
          secid,
          code: String(b.f12),
          name: String(b.f14),
          todayPct: b.f3 !== '-' ? round2(b.f3) : 0,
          mainNetYi: b.f62 !== '-' ? toYi(b.f62) : null,
          amountYi: b.f6 !== '-' ? toYi(b.f6) : null,
          ret5dPct,
          ret60dPct,
          quadrant,
        };
      })
    );
    for (const x of out) if (x) items.push(x);
  }

  return setCached('sector_rotation_quad', {
    ok: true,
    fetchedAt: nowOffsetISO(),
    items,
    counts: {
      high_strong: items.filter((x) => x.quadrant === 'high_strong').length,
      low_strong: items.filter((x) => x.quadrant === 'low_strong').length,
      high_weak: items.filter((x) => x.quadrant === 'high_weak').length,
      low_weak: items.filter((x) => x.quadrant === 'low_weak').length,
    },
  });
}

// ============================================================================
// 8. 弈盘复盘训练营（每日 3 步盘感打卡与历史回溯）
// ============================================================================

function loadReviewTrainingStore() {
  try {
    if (fs.existsSync(TRAINING_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TRAINING_PATH, 'utf8'));
      if (raw && Array.isArray(raw.entries)) return raw;
    }
  } catch {
    // ignore
  }
  return { entries: [], updatedAt: null };
}

function saveReviewTrainingEntry(entry = {}) {
  const store = loadReviewTrainingStore();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(entry.date || '')) ? entry.date : nowOffsetISO().slice(0, 10);
  const clean = {
    date,
    cycleStage: String(entry.cycleStage || '').trim(), // 冰点期|修复期|发酵期|高潮期|分歧期|退潮期
    mainThemes: Array.isArray(entry.mainThemes) ? entry.mainThemes.slice(0, 3) : [],
    subThemes: Array.isArray(entry.subThemes) ? entry.subThemes.slice(0, 3) : [],
    marketLeader: String(entry.marketLeader || '').trim(),
    themeLeaders: String(entry.themeLeaders || '').trim(),
    midCapArmy: String(entry.midCapArmy || '').trim(),
    followers: String(entry.followers || '').trim(),
    nextDayPlan: String(entry.nextDayPlan || '').trim().slice(0, 600),
    savedAt: nowOffsetISO(),
  };
  const idx = store.entries.findIndex((e) => e.date === date);
  if (idx >= 0) store.entries[idx] = clean;
  else store.entries.unshift(clean);
  store.entries.sort((a, b) => b.date.localeCompare(a.date));
  store.entries = store.entries.slice(0, 90);
  store.updatedAt = clean.savedAt;
  fs.writeFileSync(TRAINING_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return { ok: true, entry: clean, store };
}

module.exports = {
  fetchShortTermSprite,
  fetchHotRankBoard,
  fetchShortTermNewsFeeds,
  fetchCloudTreemapData,
  fetchAuctionSealRadar,
  fetchDragonTigerList,
  fetchSectorRotationQuadrant,
  loadReviewTrainingStore,
  saveReviewTrainingEntry,
};
