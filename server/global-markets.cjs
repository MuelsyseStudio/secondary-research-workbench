'use strict';

const { routeCryptoTickers, routeGlobalEquityQuotes } = require('./data-source-router.cjs');
const { getEditionInfo } = require('./edition.cjs');
const { getMarketExtension } = require('./extensions/index.cjs');

/**
 * 全球股票交易所 & 世界各地期货交易所统一市场协议层
 *
 * 实测直连零 API Key 覆盖：
 * - 股票交易所：A股(CN)、美股(US)、港股(HK)、台湾(TW/TWSE m:178)、韩国(KR/KRX m:177)、
 *              法国(FR/Euronext Paris m:186)、英国(UK/LSE m:155/156)、日本(JP/JPX m:176)、德国(DE/XETR m:185)
 * - 世界期货交易所：COMEX(101)、NYMEX(102)、CBOT/CME(103)、SGX(104)、ICE(108/112)、LME(109)、
 *                  SHFE上期所(113)、DCE大商所(114)、CZCE郑商所(115)、SGE上金所(118)、INE上期能源(142)、
 *                  CFFEX中金所(220)、GFEX广期所(225)、VIX/美债宏观锚(167/171)
 */

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
};

const BASE_MARKET_KINDS = ['CN', 'US', 'HK', 'TW', 'KR', 'FR', 'UK', 'JP', 'DE', 'FUT'];
const BASE_CURRENCIES = ['CNY', 'USD', 'HKD', 'TWD', 'KRW', 'EUR', 'GBP', 'GBp', 'JPY', 'PTS'];

function getCryptoExt() {
  const ed = getEditionInfo();
  if (!ed.features.crypto) return null;
  return getMarketExtension('crypto');
}

function getValidMarketKinds() {
  const ext = getCryptoExt();
  return ext && Array.isArray(ext.extraMarketKinds)
    ? [...BASE_MARKET_KINDS, ...ext.extraMarketKinds]
    : [...BASE_MARKET_KINDS];
}

function getValidCurrencies() {
  const ext = getCryptoExt();
  return ext && Array.isArray(ext.extraCurrencies)
    ? [...BASE_CURRENCIES, ...ext.extraCurrencies]
    : [...BASE_CURRENCIES];
}

const VALID_MARKET_KINDS = getValidMarketKinds();
const VALID_CURRENCIES = getValidCurrencies();

const FUTURES_EXCHANGE_BY_MKT = {
  '101': { exchange: 'COMEX', labelZh: '纽约COMEX', labelEn: 'COMEX', currency: 'USD' },
  '102': { exchange: 'NYMEX', labelZh: '纽约NYMEX', labelEn: 'NYMEX', currency: 'USD' },
  '103': { exchange: 'CBOT', labelZh: '芝加哥CBOT/CME', labelEn: 'CBOT/CME', currency: 'USD' },
  '104': { exchange: 'SGX', labelZh: '新加坡SGX', labelEn: 'SGX', currency: 'USD' },
  '108': { exchange: 'ICE', labelZh: '洲际ICE', labelEn: 'ICE', currency: 'USD' },
  '109': { exchange: 'LME', labelZh: '伦敦LME', labelEn: 'LME', currency: 'USD' },
  '112': { exchange: 'ICE-EU', labelZh: '欧洲ICE', labelEn: 'ICE EU', currency: 'USD' },
  '113': { exchange: 'SHFE', labelZh: '上海期货SHFE', labelEn: 'SHFE', currency: 'CNY' },
  '114': { exchange: 'DCE', labelZh: '大连商品DCE', labelEn: 'DCE', currency: 'CNY' },
  '115': { exchange: 'CZCE', labelZh: '郑州商品CZCE', labelEn: 'CZCE', currency: 'CNY' },
  '118': { exchange: 'SGE', labelZh: '上海金交所SGE', labelEn: 'SGE', currency: 'CNY' },
  '142': { exchange: 'INE', labelZh: '上期能源INE', labelEn: 'INE', currency: 'CNY' },
  '220': { exchange: 'CFFEX', labelZh: '中金所CFFEX', labelEn: 'CFFEX', currency: 'CNY' },
  '225': { exchange: 'GFEX', labelZh: '广期所GFEX', labelEn: 'GFEX', currency: 'CNY' },
  '167': { exchange: 'CBOE', labelZh: 'CBOE波动率', labelEn: 'CBOE', currency: 'PTS' },
  '171': { exchange: 'UST', labelZh: '美国国债收益率', labelEn: 'US Treasury', currency: 'PTS' },
};

const CURATED_GLOBAL_STOCKS = [
  // Taiwan (TWSE m:178)
  { secid: '178.2330', code: '2330', secuCode: '2330.TW', name: '台积电', nameEn: 'TSMC', marketKind: 'TW', currency: 'TWD', exchange: 'TWSE', group: '台股 · 台湾证交所', aliases: ['tsmc', 'taiwan semiconductor', '2330.tw', '台积电'] },
  { secid: '178.2317', code: '2317', secuCode: '2317.TW', name: '鸿海', nameEn: 'Hon Hai (Foxconn)', marketKind: 'TW', currency: 'TWD', exchange: 'TWSE', group: '台股 · 台湾证交所', aliases: ['foxconn', 'hon hai', '2317.tw', '鸿海', '富士康'] },
  { secid: '178.2454', code: '2454', secuCode: '2454.TW', name: '联发科', nameEn: 'MediaTek', marketKind: 'TW', currency: 'TWD', exchange: 'TWSE', group: '台股 · 台湾证交所', aliases: ['mediatek', '2454.tw', '联发科'] },
  { secid: '178.2308', code: '2308', secuCode: '2308.TW', name: '台达电', nameEn: 'Delta Electronics', marketKind: 'TW', currency: 'TWD', exchange: 'TWSE', group: '台股 · 台湾证交所', aliases: ['delta', '2308.tw', '台达电'] },
  { secid: '178.2382', code: '2382', secuCode: '2382.TW', name: '广达', nameEn: 'Quanta Computer', marketKind: 'TW', currency: 'TWD', exchange: 'TWSE', group: '台股 · 台湾证交所', aliases: ['quanta', '2382.tw', '广达'] },

  // Korea (KRX m:177)
  { secid: '177.005930', code: '005930', secuCode: '005930.KS', name: '三星电子', nameEn: 'Samsung Electronics', marketKind: 'KR', currency: 'KRW', exchange: 'KRX', group: '韩股 · 韩国交易所', aliases: ['samsung', '005930.ks', '三星', '三星电子'] },
  { secid: '177.000660', code: '000660', secuCode: '000660.KS', name: 'SK海力士', nameEn: 'SK Hynix', marketKind: 'KR', currency: 'KRW', exchange: 'KRX', group: '韩股 · 韩国交易所', aliases: ['sk hynix', 'hynix', '000660.ks', '海力士', 'sk海力士'] },
  { secid: '177.005380', code: '005380', secuCode: '005380.KS', name: '现代汽车', nameEn: 'Hyundai Motor', marketKind: 'KR', currency: 'KRW', exchange: 'KRX', group: '韩股 · 韩国交易所', aliases: ['hyundai', '005380.ks', '现代汽车'] },
  { secid: '177.035420', code: '035420', secuCode: '035420.KS', name: 'NAVER', nameEn: 'NAVER Corp', marketKind: 'KR', currency: 'KRW', exchange: 'KRX', group: '韩股 · 韩国交易所', aliases: ['naver', '035420.ks'] },
  { secid: '177.373220', code: '373220', secuCode: '373220.KS', name: 'LG新能源', nameEn: 'LG Energy Solution', marketKind: 'KR', currency: 'KRW', exchange: 'KRX', group: '韩股 · 韩国交易所', aliases: ['lg energy', 'lges', '373220.ks', 'lg新能源'] },

  // France (Euronext Paris m:186)
  { secid: '186.MC', code: 'MC', secuCode: 'MC.PA', name: '路易威登 LVMH', nameEn: 'LVMH Moet Hennessy', marketKind: 'FR', currency: 'EUR', exchange: 'Euronext Paris', group: '法股 · 泛欧巴黎', aliases: ['lvmh', 'mc.pa', 'louis vuitton', '路易威登', '路威酩轩'] },
  { secid: '186.TTE', code: 'TTE', secuCode: 'TTE.PA', name: '道达尔能源', nameEn: 'TotalEnergies', marketKind: 'FR', currency: 'EUR', exchange: 'Euronext Paris', group: '法股 · 泛欧巴黎', aliases: ['totalenergies', 'total', 'tte.pa', '道达尔'] },
  { secid: '186.OR', code: 'OR', secuCode: 'OR.PA', name: '欧莱雅', nameEn: "L'Oreal", marketKind: 'FR', currency: 'EUR', exchange: 'Euronext Paris', group: '法股 · 泛欧巴黎', aliases: ['loreal', "l'oreal", 'or.pa', '欧莱雅'] },
  { secid: '186.SU', code: 'SU', secuCode: 'SU.PA', name: '施耐德电气', nameEn: 'Schneider Electric', marketKind: 'FR', currency: 'EUR', exchange: 'Euronext Paris', group: '法股 · 泛欧巴黎', aliases: ['schneider', 'su.pa', '施耐德'] },
  { secid: '186.AIR', code: 'AIR', secuCode: 'AIR.PA', name: '空中客车', nameEn: 'Airbus SE', marketKind: 'FR', currency: 'EUR', exchange: 'Euronext Paris', group: '法股 · 泛欧巴黎', aliases: ['airbus', 'air.pa', '空客', '空中客车'] },
  { secid: '186.RMS', code: 'RMS', secuCode: 'RMS.PA', name: '爱马仕', nameEn: 'Hermes International', marketKind: 'FR', currency: 'EUR', exchange: 'Euronext Paris', group: '法股 · 泛欧巴黎', aliases: ['hermes', 'rms.pa', '爱马仕'] },

  // UK (London Stock Exchange m:155)
  { secid: '155.SHEL', code: 'SHEL', secuCode: 'SHEL.L', name: '壳牌 (UK)', nameEn: 'Shell plc (LSE)', marketKind: 'UK', currency: 'GBp', exchange: 'LSE', group: '英股 · 伦敦交易所', aliases: ['shell', 'shel.l', '壳牌'] },
  { secid: '155.AZN', code: 'AZN', secuCode: 'AZN.L', name: '阿斯利康 (UK)', nameEn: 'AstraZeneca (LSE)', marketKind: 'UK', currency: 'GBp', exchange: 'LSE', group: '英股 · 伦敦交易所', aliases: ['astrazeneca', 'azn.l', '阿斯利康'] },
  { secid: '155.HSBA', code: 'HSBA', secuCode: 'HSBA.L', name: '汇丰控股 (UK)', nameEn: 'HSBC Holdings (LSE)', marketKind: 'UK', currency: 'GBp', exchange: 'LSE', group: '英股 · 伦敦交易所', aliases: ['hsbc', 'hsba.l', '汇丰', '汇丰控股'] },
  { secid: '155.ULVR', code: 'ULVR', secuCode: 'ULVR.L', name: '联合利华 (UK)', nameEn: 'Unilever (LSE)', marketKind: 'UK', currency: 'GBp', exchange: 'LSE', group: '英股 · 伦敦交易所', aliases: ['unilever', 'ulvr.l', '联合利华'] },
  { secid: '155.BP.', code: 'BP.', secuCode: 'BP.L', name: '英国石油 BP', nameEn: 'BP plc (LSE)', marketKind: 'UK', currency: 'GBp', exchange: 'LSE', group: '英股 · 伦敦交易所', aliases: ['bp', 'bp.l', '英国石油'] },
  { secid: '155.RIO', code: 'RIO', secuCode: 'RIO.L', name: '力拓 (UK)', nameEn: 'Rio Tinto (LSE)', marketKind: 'UK', currency: 'GBp', exchange: 'LSE', group: '英股 · 伦敦交易所', aliases: ['rio tinto', 'rio.l', '力拓'] },

  // Japan & Germany bonus global leaders
  { secid: '176.7203', code: '7203', secuCode: '7203.T', name: '丰田汽车', nameEn: 'Toyota Motor', marketKind: 'JP', currency: 'JPY', exchange: 'JPX', group: '日股 · 东京证交所', aliases: ['toyota', '7203.t', '丰田'] },
  { secid: '176.8035', code: '8035', secuCode: '8035.T', name: '东京电子', nameEn: 'Tokyo Electron', marketKind: 'JP', currency: 'JPY', exchange: 'JPX', group: '日股 · 东京证交所', aliases: ['tokyo electron', 'tel', '8035.t', '东京电子'] },
  { secid: '185.SAP', code: 'SAP', secuCode: 'SAP.DE', name: 'SAP SE', nameEn: 'SAP SE (XETRA)', marketKind: 'DE', currency: 'EUR', exchange: 'XETR', group: '德股 · 法兰克福', aliases: ['sap', 'sap.de'] },
  { secid: '185.SIE', code: 'SIE', secuCode: 'SIE.DE', name: '西门子', nameEn: 'Siemens AG', marketKind: 'DE', currency: 'EUR', exchange: 'XETR', group: '德股 · 法兰克福', aliases: ['siemens', 'sie.de', '西门子'] },
];

const CURATED_GLOBAL_FUTURES = [
  // Precious Metals
  { secid: '101.GC00Y', code: 'GC00Y', secuCode: 'COMEX.GC', name: 'COMEX黄金', nameEn: 'COMEX Gold', category: 'precious', categoryZh: '贵金属', categoryEn: 'Precious Metals', exchange: 'COMEX', currency: 'USD', aliases: ['gold', 'gc=f', 'comex黄金', '纽约金', '黄金'] },
  { secid: '101.SI00Y', code: 'SI00Y', secuCode: 'COMEX.SI', name: 'COMEX白银', nameEn: 'COMEX Silver', category: 'precious', categoryZh: '贵金属', categoryEn: 'Precious Metals', exchange: 'COMEX', currency: 'USD', aliases: ['silver', 'si=f', 'comex白银', '白银'] },
  { secid: '113.aum', code: 'aum', secuCode: 'SHFE.AU', name: '沪金主连', nameEn: 'SHFE Gold Continuous', category: 'precious', categoryZh: '贵金属', categoryEn: 'Precious Metals', exchange: 'SHFE', currency: 'CNY', aliases: ['shfe gold', '沪金', '黄金期货'] },
  { secid: '113.agm', code: 'agm', secuCode: 'SHFE.AG', name: '沪银主连', nameEn: 'SHFE Silver Continuous', category: 'precious', categoryZh: '贵金属', categoryEn: 'Precious Metals', exchange: 'SHFE', currency: 'CNY', aliases: ['shfe silver', '沪银'] },

  // Energy
  { secid: '102.CL00Y', code: 'CL00Y', secuCode: 'NYMEX.CL', name: 'WTI原油', nameEn: 'NYMEX WTI Crude', category: 'energy', categoryZh: '能源化工', categoryEn: 'Energy', exchange: 'NYMEX', currency: 'USD', aliases: ['wti', 'crude', 'oil', 'cl=f', '原油', '美油'] },
  { secid: '112.B00Y', code: 'B00Y', secuCode: 'ICE.BRENT', name: '布伦特原油', nameEn: 'ICE Brent Crude', category: 'energy', categoryZh: '能源化工', categoryEn: 'Energy', exchange: 'ICE', currency: 'USD', aliases: ['brent', 'bz=f', '布油', '布伦特原油'] },
  { secid: '102.NG00Y', code: 'NG00Y', secuCode: 'NYMEX.NG', name: 'NYMEX天然气', nameEn: 'NYMEX Natural Gas', category: 'energy', categoryZh: '能源化工', categoryEn: 'Energy', exchange: 'NYMEX', currency: 'USD', aliases: ['natural gas', 'ng=f', '天然气'] },
  { secid: '142.scm', code: 'scm', secuCode: 'INE.SC', name: 'INE原油主连', nameEn: 'INE Crude Oil', category: 'energy', categoryZh: '能源化工', categoryEn: 'Energy', exchange: 'INE', currency: 'CNY', aliases: ['ine crude', '上海原油', 'sc原油'] },

  // Industrial Metals & New Energy
  { secid: '101.HG00Y', code: 'HG00Y', secuCode: 'COMEX.HG', name: 'COMEX铜', nameEn: 'COMEX Copper', category: 'metals', categoryZh: '工业金属与新能源', categoryEn: 'Industrial Metals', exchange: 'COMEX', currency: 'USD', aliases: ['copper', 'hg=f', '美铜', 'comex铜'] },
  { secid: '109.LCAD', code: 'LCAD', secuCode: 'LME.CA', name: 'LME伦铜3月', nameEn: 'LME Copper 3M', category: 'metals', categoryZh: '工业金属与新能源', categoryEn: 'Industrial Metals', exchange: 'LME', currency: 'USD', aliases: ['lme copper', '伦铜'] },
  { secid: '109.LZNT', code: 'LZNT', secuCode: 'LME.ZN', name: 'LME伦锌3月', nameEn: 'LME Zinc 3M', category: 'metals', categoryZh: '工业金属与新能源', categoryEn: 'Industrial Metals', exchange: 'LME', currency: 'USD', aliases: ['lme zinc', '伦锌'] },
  { secid: '109.LTNT', code: 'LTNT', secuCode: 'LME.SN', name: 'LME伦锡3月', nameEn: 'LME Tin 3M', category: 'metals', categoryZh: '工业金属与新能源', categoryEn: 'Industrial Metals', exchange: 'LME', currency: 'USD', aliases: ['lme tin', '伦锡'] },
  { secid: '113.cum', code: 'cum', secuCode: 'SHFE.CU', name: '沪铜主连', nameEn: 'SHFE Copper', category: 'metals', categoryZh: '工业金属与新能源', categoryEn: 'Industrial Metals', exchange: 'SHFE', currency: 'CNY', aliases: ['shfe copper', '沪铜'] },
  { secid: '225.lcm', code: 'lcm', secuCode: 'GFEX.LC', name: '碳酸锂主连', nameEn: 'GFEX Lithium Carbonate', category: 'metals', categoryZh: '工业金属与新能源', categoryEn: 'Industrial Metals', exchange: 'GFEX', currency: 'CNY', aliases: ['lithium', '碳酸锂'] },
  { secid: '114.im', code: 'im', secuCode: 'DCE.I', name: '铁矿石主连', nameEn: 'DCE Iron Ore', category: 'metals', categoryZh: '工业金属与新能源', categoryEn: 'Industrial Metals', exchange: 'DCE', currency: 'CNY', aliases: ['iron ore', '铁矿石'] },

  // Equity Index & Macro Futures
  { secid: '104.CN00Y', code: 'CN00Y', secuCode: 'SGX.A50', name: '富时A50期指', nameEn: 'SGX FTSE China A50', category: 'index', categoryZh: '全球期指与宏观', categoryEn: 'Index & Macro', exchange: 'SGX', currency: 'PTS', aliases: ['a50', 'ftse a50', '富时a50', '新加坡a50'] },
  { secid: '103.YM00Y', code: 'YM00Y', secuCode: 'CBOT.YM', name: '小型道指期货', nameEn: 'E-mini Dow Futures', category: 'index', categoryZh: '全球期指与宏观', categoryEn: 'Index & Macro', exchange: 'CBOT', currency: 'PTS', aliases: ['dow futures', 'ym=f', '道指期货'] },
  { secid: '103.NQ00Y', code: 'NQ00Y', secuCode: 'CME.NQ', name: '小型纳指期货', nameEn: 'E-mini Nasdaq 100', category: 'index', categoryZh: '全球期指与宏观', categoryEn: 'Index & Macro', exchange: 'CME', currency: 'PTS', aliases: ['nasdaq futures', 'nq=f', '纳指期货'] },
  { secid: '103.ES00Y', code: 'ES00Y', secuCode: 'CME.ES', name: '小型标普期货', nameEn: 'E-mini S&P 500', category: 'index', categoryZh: '全球期指与宏观', categoryEn: 'Index & Macro', exchange: 'CME', currency: 'PTS', aliases: ['sp500 futures', 'es=f', '标普期货'] },
  { secid: '167.VIX', code: 'VIX', secuCode: 'CBOE.VIX', name: 'VIX恐慌指数', nameEn: 'CBOE VIX Index', category: 'index', categoryZh: '全球期指与宏观', categoryEn: 'Index & Macro', exchange: 'CBOE', currency: 'PTS', aliases: ['vix', '恐慌指数'] },
  { secid: '171.US10Y', code: 'US10Y', secuCode: 'UST.10Y', name: '美债10年收益率', nameEn: 'US 10Y Treasury Yield', category: 'index', categoryZh: '全球期指与宏观', categoryEn: 'Index & Macro', exchange: 'UST', currency: 'PTS', aliases: ['us10y', '10y yield', '美债', '十年美债'] },

  // Agriculture & Chemicals
  { secid: '103.ZS00Y', code: 'ZS00Y', secuCode: 'CBOT.ZS', name: 'CBOT大豆', nameEn: 'CBOT Soybeans', category: 'agri', categoryZh: '农产品与化工', categoryEn: 'Agriculture & Chem', exchange: 'CBOT', currency: 'USD', aliases: ['soybean', 'zs=f', '美豆', '大豆'] },
  { secid: '103.ZC00Y', code: 'ZC00Y', secuCode: 'CBOT.ZC', name: 'CBOT玉米', nameEn: 'CBOT Corn', category: 'agri', categoryZh: '农产品与化工', categoryEn: 'Agriculture & Chem', exchange: 'CBOT', currency: 'USD', aliases: ['corn', 'zc=f', '玉米'] },
  { secid: '115.MAM', code: 'MAM', secuCode: 'CZCE.MA', name: '甲醇主连', nameEn: 'CZCE Methanol', category: 'agri', categoryZh: '农产品与化工', categoryEn: 'Agriculture & Chem', exchange: 'CZCE', currency: 'CNY', aliases: ['methanol', '甲醇'] },
  { secid: '114.mm', code: 'mm', secuCode: 'DCE.M', name: '豆粕主连', nameEn: 'DCE Soybean Meal', category: 'agri', categoryZh: '农产品与化工', categoryEn: 'Agriculture & Chem', exchange: 'DCE', currency: 'CNY', aliases: ['soybean meal', '豆粕'] },
];

function getCuratedAll() {
  const ext = getCryptoExt();
  return [
    ...CURATED_GLOBAL_STOCKS,
    ...CURATED_GLOBAL_FUTURES.map((f) => ({
      ...f,
      marketKind: 'FUT',
      group: `全球期货 · ${f.exchange}`,
    })),
    ...(ext ? ext.curatedAssets : []),
  ];
}

function isUnsupportedAssetSecid(secid) {
  const s = String(secid || '').trim();
  if (!/^crypto\.[A-Za-z0-9_-]+$/i.test(s)) return false;
  return !getCryptoExt();
}

function isCryptoSecid(secid) {
  const ext = getCryptoExt();
  return ext ? ext.isCryptoSecid(secid) : false;
}

function cryptoPairFromSecid(secid) {
  const ext = getCryptoExt();
  return ext ? ext.cryptoPairFromSecid(secid) : '';
}

async function fetchCryptoTickers(pairs = null) {
  const ext = getCryptoExt();
  if (!ext) return new Map();
  const targetPairs = Array.isArray(pairs) && pairs.length > 0 ? pairs : ext.curatedAssets.map((c) => c.pair);
  return routeCryptoTickers(targetPairs, ext.fetchDefaultGateCryptoTickers);
}

async function fetchCryptoKlines(secid, timeframe = 'day', limit = 240) {
  const ext = getCryptoExt();
  if (!ext) return [];
  return ext.fetchCryptoKlines(secid, timeframe, limit);
}

function inferMarketMetaFromSecid(secid) {
  const clean = String(secid || '').trim();
  const curated = getCuratedAll().find((x) => x.secid.toLowerCase() === clean.toLowerCase());
  if (curated) {
    return {
      marketKind: curated.marketKind,
      currency: curated.currency,
      secuCode: curated.secuCode,
      code: curated.code,
      exchange: curated.exchange,
      name: curated.name,
      nameEn: curated.nameEn || curated.name,
    };
  }

  const ext = getCryptoExt();
  if (ext) {
    const extMeta = ext.inferCryptoMeta(clean);
    if (extMeta) return extMeta;
  }
  const [mktNum, ...rest] = clean.split('.');
  const code = rest.join('.');
  if (mktNum === '1') {
    return { marketKind: 'CN', currency: 'CNY', secuCode: `${code}.SH`, code, exchange: 'SSE' };
  }
  if (mktNum === '0') {
    const mkt = code.startsWith('4') || code.startsWith('8') || code.startsWith('92') ? 'BJ' : 'SZ';
    return { marketKind: 'CN', currency: 'CNY', secuCode: `${code}.${mkt}`, code, exchange: mkt === 'BJ' ? 'BSE' : 'SZSE' };
  }
  if (['105', '106', '107', '153'].includes(mktNum)) {
    const ex = mktNum === '105' ? 'NASDAQ' : mktNum === '106' ? 'NYSE' : mktNum === '107' ? 'AMEX' : 'OTC';
    return { marketKind: 'US', currency: 'USD', secuCode: `${code}.US`, code, exchange: ex };
  }
  if (mktNum === '116' || mktNum === '128') {
    return { marketKind: 'HK', currency: 'HKD', secuCode: `${code}.HK`, code, exchange: 'HKEX' };
  }
  if (mktNum === '178') {
    return { marketKind: 'TW', currency: 'TWD', secuCode: `${code}.TW`, code, exchange: 'TWSE' };
  }
  if (mktNum === '177') {
    return { marketKind: 'KR', currency: 'KRW', secuCode: `${code}.KS`, code, exchange: 'KRX' };
  }
  if (mktNum === '186') {
    return { marketKind: 'FR', currency: 'EUR', secuCode: `${code}.PA`, code, exchange: 'Euronext Paris' };
  }
  if (mktNum === '155' || mktNum === '156') {
    return { marketKind: 'UK', currency: 'GBp', secuCode: `${code}.L`, code, exchange: 'LSE' };
  }
  if (mktNum === '176') {
    return { marketKind: 'JP', currency: 'JPY', secuCode: `${code}.T`, code, exchange: 'JPX' };
  }
  if (mktNum === '185') {
    return { marketKind: 'DE', currency: 'EUR', secuCode: `${code}.DE`, code, exchange: 'XETR' };
  }
  if (FUTURES_EXCHANGE_BY_MKT[mktNum]) {
    const fm = FUTURES_EXCHANGE_BY_MKT[mktNum];
    return {
      marketKind: 'FUT',
      currency: fm.currency,
      secuCode: `${fm.exchange}.${code}`,
      code,
      exchange: fm.exchange,
    };
  }
  return { marketKind: 'CN', currency: 'CNY', secuCode: code, code, exchange: 'GLOBAL' };
}

function searchCuratedGlobalCatalog(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const item of getCuratedAll()) {
    const hay = [
      item.secid,
      item.code,
      item.secuCode,
      item.name,
      item.nameEn || '',
      item.exchange || '',
      ...(item.aliases || []),
    ]
      .join(' ')
      .toLowerCase();
    if (hay.includes(q)) {
      hits.push({
        resolved: true,
        marketKind: item.marketKind,
        currency: item.currency,
        mktNum: item.secid.split('.')[0],
        secid: item.secid,
        code: item.code,
        market: item.exchange,
        secuCode: item.secuCode,
        f10Code: '',
        usF10Code: '',
        name: item.name,
        nameEn: item.nameEn || item.name,
        boardType: `${item.exchange} · ${item.marketKind === 'FUT' ? '期货' : item.marketKind}`,
        classify: item.marketKind,
      });
    }
  }
  return hits;
}

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 拉取全球期货大宗 + 亚欧美核心个股实时矩阵看板
 */
async function fetchGlobalMarketsOverview() {
  const futureSecids = CURATED_GLOBAL_FUTURES.map((x) => x.secid);
  const fields = 'f2,f3,f4,f5,f6,f7,f12,f13,f14,f15,f16,f17,f18';

  const fetchEmQuoteMap = async (items) => {
    const m = new Map();
    const secids = (items || []).map((x) => x.secid).filter(Boolean);
    if (!secids.length) return m;
    const res = await fetchJson(
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=${fields}&secids=${encodeURIComponent(secids.join(','))}`,
      8500
    ).catch(() => null);
    for (const q of res?.data?.diff || []) {
      const price = q && q.f2 !== '-' ? round2(q.f2) : null;
      const preClose = q && q.f18 !== '-' ? round2(q.f18) : null;
      m.set(`${q.f13}.${q.f12}`, {
        name: q.f14,
        price,
        preClose,
        pct: q && q.f3 !== '-' ? round2(q.f3) : price != null && preClose ? round2(((price - preClose) / preClose) * 100) : null,
        chg: q && q.f4 !== '-' ? round2(q.f4) : null,
        high: q && q.f15 !== '-' ? round2(q.f15) : null,
        low: q && q.f16 !== '-' ? round2(q.f16) : null,
        open: q && q.f17 !== '-' ? round2(q.f17) : null,
        volume: q && q.f5 !== '-' ? Number(q.f5) : null,
        amplitudePct: q && q.f7 !== '-' ? round2(q.f7) : null,
      });
    }
    return m;
  };

  const ext = getCryptoExt();
  const [futMap, stkMap, cryptoMap] = await Promise.all([
    fetchEmQuoteMap(CURATED_GLOBAL_FUTURES),
    routeGlobalEquityQuotes(CURATED_GLOBAL_STOCKS, fetchEmQuoteMap).catch(() => new Map()),
    ext ? fetchCryptoTickers().catch(() => new Map()) : Promise.resolve(new Map()),
  ]);

  const bySecid = new Map([...futMap.entries(), ...stkMap.entries()]);

  const mapLive = (item) => {
    const q = bySecid.get(item.secid) || {};
    return {
      ...item,
      name: item.name || q.name || item.code,
      price: q.price ?? null,
      pct: q.pct ?? null,
      chg: q.chg ?? null,
      high: q.high ?? null,
      low: q.low ?? null,
      open: q.open ?? null,
      preClose: q.preClose ?? null,
      volume: q.volume ?? null,
      amplitudePct: q.amplitudePct ?? null,
      barDate: q.barDate ?? null,
      quoteNote: q.quoteNote ?? null,
      sourceTier: q.sourceTier || 'free',
    };
  };

  const cryptos = ext
    ? ext.curatedAssets.map((c) => {
        const live = cryptoMap.get(c.pair) || {};
        return {
          ...c,
          price: live.price ?? null,
          pct: live.pct ?? null,
          chg: live.chg ?? null,
          high: live.high ?? null,
          low: live.low ?? null,
          open: live.open ?? null,
          preClose: live.preClose ?? null,
          volume: live.volume ?? null,
          amountUsdM: live.amountUsdM ?? null,
          amplitudePct: live.amplitudePct ?? null,
        };
      })
    : [];

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    futures: CURATED_GLOBAL_FUTURES.map((f) => mapLive({ ...f, marketKind: 'FUT' })),
    globalStocks: CURATED_GLOBAL_STOCKS.map(mapLive),
    cryptos,
    exchanges: [
      { code: 'TW', nameZh: '台湾证交所 (TWSE)', nameEn: 'Taiwan (TWSE)', currency: 'TWD' },
      { code: 'KR', nameZh: '韩国交易所 (KRX)', nameEn: 'Korea (KRX)', currency: 'KRW' },
      { code: 'FR', nameZh: '法国泛欧巴黎 (XPAR)', nameEn: 'France (Euronext Paris)', currency: 'EUR' },
      { code: 'UK', nameZh: '英国伦敦交易所 (LSE)', nameEn: 'UK (LSE)', currency: 'GBp' },
      { code: 'JP', nameZh: '日本东京证交所 (JPX)', nameEn: 'Japan (JPX)', currency: 'JPY' },
      { code: 'DE', nameZh: '德国法兰克福 (XETR)', nameEn: 'Germany (XETRA)', currency: 'EUR' },
      { code: 'FUT', nameZh: '全球期货 (COMEX/NYMEX/CME/LME/ICE/SGX/国内五所)', nameEn: 'World Futures (COMEX/NYMEX/CME/LME/ICE/SGX/CN)', currency: 'MULTI' },
      ...(ext ? [ext.MARKET_DIRECTORY_ENTRY] : []),
    ],
  };
}

module.exports = {
  VALID_MARKET_KINDS,
  VALID_CURRENCIES,
  getValidMarketKinds,
  getValidCurrencies,
  FUTURES_EXCHANGE_BY_MKT,
  CURATED_GLOBAL_STOCKS,
  CURATED_GLOBAL_FUTURES,
  isUnsupportedAssetSecid,
  isCryptoSecid,
  cryptoPairFromSecid,
  fetchCryptoTickers,
  fetchCryptoKlines,
  inferMarketMetaFromSecid,
  searchCuratedGlobalCatalog,
  fetchGlobalMarketsOverview,
};
