'use strict';

/**
 * P1-1：实盘 / 模拟交易账本与交割单归因引擎
 * 融合 TradeZella + Edgewonk + Journedge + eJournal + A股 trade-journal + ai-mock-trade 精华：
 * - 手动快录 / 券商 CSV 交割单导入 / AI 识别交割单截图一键入账；
 * - A 股精确费率（佣金万2.5最低5元 + 卖出印花税0.05% + 过户费0.001%）& 美股/港股支持；
 * - FIFO 先进先出精确盈亏配对 + 盘中「做T」自动识别配对；
 * - 持仓实时盈亏 + 同方向多标签集中度红线校验（源自 ai-mock-trade 五重钳制）；
 * - 卖后 T+1 / T+5 / T+20「卖飞 vs 逃顶」择时审计 + 持仓区间 MFE/MAE 买卖点效率；
 * - Playbook 方法论卡片实盘胜率矩阵 + Edgewonk 风格「坏习惯亏钱榜（Mistake Cost）」；
 * - 为 InteractiveKlineChart 提供精准的 B/S 买卖点箭头与成本/止损线数据。
 */

const fs = require('node:fs');
const path = require('node:path');
const { invokeModel, parseJsonFromModelOutput } = require('./ai-provider.cjs');
const { getDailySeriesForQuery } = require('./judgment-tracker.cjs');

const { workspaceStateFile } = require('./app-paths.cjs');
const { atomicWriteFileSync } = require('./lru-cache.cjs');
function getLedgerFile() {
  return workspaceStateFile('trade-ledger.local.json');
}

const EMOTION_TAGS = [
  '按计划执行',
  'FOMO追高',
  '扛单不止损',
  '过早止盈卖飞',
  '逆势盲目补仓',
  '违背红线/情绪化',
  '试错按纪律止损',
];

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function round2OrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowOffsetISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function inferMarketKind(code) {
  const c = String(code || '').trim().toUpperCase();
  if (/^\d{6}(\.(SH|SZ|BJ))?$/.test(c)) return 'CN';
  if (/^\d{5}(\.HK)?$/.test(c)) return 'HK';
  if (/^[A-Z]{1,6}(\.(US|O|N|NASDAQ|NYSE))?$/.test(c)) return 'US';
  return 'CN';
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\.(SH|SZ|BJ|US|HK|O|N)$/i, '');
}

function computeTradeFee(side, price, quantity, marketKind, commissionRate = 0.00025) {
  const amount = Math.abs(Number(price) * Number(quantity));
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (marketKind === 'CN') {
    const commission = Math.max(5, amount * commissionRate);
    const stampDuty = side === 'SELL' ? amount * 0.0005 : 0;
    const transferFee = amount * 0.00001;
    return round2(commission + stampDuty + transferFee);
  }
  if (marketKind === 'HK') {
    return round2(Math.max(15, amount * 0.0013));
  }
  // 美股默认零佣或极低平台费
  return round2(Math.max(1, Number(quantity) * 0.005));
}

function loadRawTradeLedger() {
  try {
    const ledgerPath = getLedgerFile();
    if (fs.existsSync(ledgerPath)) {
      const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      return {
        accountCapital: Number(raw.accountCapital) > 0 ? Number(raw.accountCapital) : 500000,
        commissionRate: Number(raw.commissionRate) > 0 ? Number(raw.commissionRate) : 0.00025,
        maxSinglePct: Number(raw.maxSinglePct) > 0 ? Number(raw.maxSinglePct) : 25,
        maxThemePct: Number(raw.maxThemePct) > 0 ? Number(raw.maxThemePct) : 45,
        updatedAt: raw.updatedAt || null,
        trades: Array.isArray(raw.trades) ? raw.trades : [],
      };
    }
  } catch {
    // fallback
  }
  return {
    accountCapital: 500000,
    commissionRate: 0.00025,
    maxSinglePct: 25,
    maxThemePct: 45,
    updatedAt: null,
    trades: [],
  };
}

function saveRawTradeLedger(data) {
  const next = {
    accountCapital: Number(data.accountCapital) > 0 ? Number(data.accountCapital) : 500000,
    commissionRate: Number(data.commissionRate) > 0 ? Number(data.commissionRate) : 0.00025,
    maxSinglePct: Number(data.maxSinglePct) > 0 ? Number(data.maxSinglePct) : 25,
    maxThemePct: Number(data.maxThemePct) > 0 ? Number(data.maxThemePct) : 45,
    updatedAt: nowOffsetISO(),
    trades: Array.isArray(data.trades) ? data.trades : [],
  };
  atomicWriteFileSync(getLedgerFile(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

function sanitizeTradeInput(raw, defaultCommRate = 0.00025) {
  const code = normalizeCode(raw.code);
  const name = String(raw.name || code).trim();
  const marketKind = ['CN', 'US', 'HK'].includes(raw.marketKind) ? raw.marketKind : inferMarketKind(code);
  const side = String(raw.side || 'BUY').toUpperCase().includes('S') || String(raw.side || '').includes('卖') ? 'SELL' : 'BUY';
  const price = Number(raw.price);
  const quantity = Math.abs(Number(raw.quantity));
  if (!code || !Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`交易记录字段非法（代码=${code || '空'} 价格=${raw.price} 数量=${raw.quantity}）`);
  }
  const dateStr = String(raw.date || todayISO()).trim().replace(/\//g, '-').slice(0, 10);
  const timeStr = String(raw.time || (side === 'BUY' ? '10:00' : '14:30')).trim().slice(0, 8);
  const feeNum = Number(raw.fee);
  const fee = Number.isFinite(feeNum) && feeNum >= 0 ? round2(feeNum) : computeTradeFee(side, price, quantity, marketKind, defaultCommRate);
  const stopLossPrice = Number.isFinite(Number(raw.stopLossPrice)) && Number(raw.stopLossPrice) > 0 ? round2(raw.stopLossPrice) : null;
  const targetPrice = Number.isFinite(Number(raw.targetPrice)) && Number(raw.targetPrice) > 0 ? round2(raw.targetPrice) : null;

  const cardIds = Array.isArray(raw.cardIds)
    ? raw.cardIds.map((c) => String(c).replace(/[^\d]/g, '').padStart(3, '0')).filter((c) => c.length === 3)
    : String(raw.cardIds || '')
        .split(/[,，/\s]+/)
        .map((c) => c.replace(/[^\d]/g, ''))
        .filter(Boolean)
        .map((c) => c.padStart(3, '0'));

  const themes = Array.isArray(raw.themes)
    ? raw.themes.map((t) => String(t).trim()).filter(Boolean)
    : String(raw.themes || raw.direction || '')
        .split(/[,，/、\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);

  return {
    id: String(raw.id || `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
    accountType: raw.accountType === 'sim' ? 'sim' : 'real',
    date: dateStr,
    time: timeStr,
    code,
    name,
    marketKind,
    currency: marketKind === 'US' ? 'USD' : marketKind === 'HK' ? 'HKD' : 'CNY',
    side,
    price: round2(price),
    quantity,
    fee,
    stopLossPrice,
    targetPrice,
    cardIds: [...new Set(cardIds)],
    themes: [...new Set(themes)],
    emotionTag: String(raw.emotionTag || '按计划执行').trim(),
    planScore: Number.isFinite(Number(raw.planScore)) ? Math.max(1, Math.min(10, Number(raw.planScore))) : 8,
    note: String(raw.note || '').trim(),
    createdAt: raw.createdAt || nowOffsetISO(),
  };
}

function addTrades(entries) {
  const data = loadRawTradeLedger();
  const list = Array.isArray(entries) ? entries : [entries];
  const added = [];
  for (const item of list) {
    const clean = sanitizeTradeInput(item, data.commissionRate);
    data.trades.push(clean);
    added.push(clean);
  }
  data.trades.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  saveRawTradeLedger(data);
  return { added, total: data.trades.length };
}

function updateTrade(id, patch) {
  const data = loadRawTradeLedger();
  const idx = data.trades.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error('未找到指定交易记录');
  const merged = sanitizeTradeInput({ ...data.trades[idx], ...patch, id }, data.commissionRate);
  data.trades[idx] = merged;
  data.trades.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  saveRawTradeLedger(data);
  return merged;
}

function deleteTrade(id) {
  const data = loadRawTradeLedger();
  const before = data.trades.length;
  data.trades = data.trades.filter((t) => t.id !== id);
  saveRawTradeLedger(data);
  return { deleted: data.trades.length !== before, total: data.trades.length };
}

function updateTradeSettings(patch) {
  const data = loadRawTradeLedger();
  return saveRawTradeLedger({ ...data, ...patch });
}

// ============================================================================
// 券商交割单 CSV / 制表符文本智能解析器（支持同花顺/东财/华泰/中信/富途/IBKR）
// ============================================================================

function parseBrokerCsvText(csvText) {
  const lines = String(csvText || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error('交割单文本至少需包含表头行与 1 条成交记录');
  }
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(sep).map((h) => h.replace(/^["']|["']$/g, '').trim());

  const findCol = (patterns) =>
    headers.findIndex((h) => patterns.some((p) => p.test(h)));

  const colDate = findCol([/日期|成交日期|发生日期|date/i]);
  const colTime = findCol([/时间|成交时间|time/i]);
  const colCode = findCol([/代码|证券代码|symbol|ticker/i]);
  const colName = findCol([/名称|简称|证券名称|name/i]);
  const colSide = findCol([/买卖|方向|操作|业务名称|side|action/i]);
  const colPrice = findCol([/成交均?价|价格|price/i]);
  const colQty = findCol([/成交数量|数量|股数|qty|quantity|volume/i]);
  const colFee = findCol([/手续费|佣金|总费用|fee|commission/i]);
  const colTax = findCol([/印花税|税费|tax/i]);
  const colNote = findCol([/备注|理由|note/i]);

  if (colCode === -1 || colPrice === -1 || colQty === -1) {
    throw new Error(`未能识别必要列（需包含代码/价格/数量），当前识别表头：${headers.join(' | ')}`);
  }

  const parsed = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep).map((c) => c.replace(/^["']|["']$/g, '').trim());
    try {
      const rawSide = colSide >= 0 ? cols[colSide] : 'BUY';
      if (/红利|利息|转账|申购|配号|逆回购/.test(rawSide)) continue;
      const side = /卖|sell|S\b/i.test(rawSide) ? 'SELL' : 'BUY';
      let rawDate = colDate >= 0 ? cols[colDate] : todayISO();
      if (/^\d{8}$/.test(rawDate)) {
        rawDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
      }
      const feeA = colFee >= 0 ? Number(cols[colFee]) || 0 : 0;
      const feeB = colTax >= 0 ? Number(cols[colTax]) || 0 : 0;
      const feeTotal = feeA + feeB > 0 ? round2(feeA + feeB) : undefined;
      parsed.push(
        sanitizeTradeInput({
          date: rawDate,
          time: colTime >= 0 ? cols[colTime] : undefined,
          code: cols[colCode],
          name: colName >= 0 ? cols[colName] : cols[colCode],
          side,
          price: Number(cols[colPrice]),
          quantity: Math.abs(Number(cols[colQty])),
          fee: feeTotal,
          note: colNote >= 0 ? cols[colNote] : '交割单CSV导入',
        })
      );
    } catch (err) {
      errors.push(`第 ${i + 1} 行跳过：${err.message}`);
    }
  }
  return { trades: parsed, errors };
}

// ============================================================================
// AI 识别交割单截图 / 成交短信文本一键入账
// ============================================================================

async function parseTradesWithAi({ text = '', imageBase64 = '', imageMimeType = 'image/png', providerOverride }) {
  if (!text.trim() && !imageBase64) {
    throw new Error('请上传券商交割单/成交截图，或粘贴成交短信/流水文本');
  }

  const systemPrompt = `你是专业二级投研交割单数据提取引擎。请从用户提供的券商成交截图或文本流水中，精准提取每一笔股票买入/卖出成交记录，输出单个合法 JSON 对象：
{"trades":[{"date":"YYYY-MM-DD","time":"HH:MM","code":"6位A股代码或美股Ticker如NVDA","name":"标的中文名","marketKind":"CN|US|HK","side":"BUY|SELL","price":0,"quantity":0,"fee":0,"note":"如有补充可写"}]}
严格禁止编造未出现在图片或文本中的成交记录；若未标明日期则填今日 ${todayISO()}；若未标明手续费则 fee 填 -1（由后端按精确费率自动核算）。`;

  const userPrompt = text.trim()
    ? `请提取以下成交记录文本中的全部股票买卖记录：\n\n${text.trim()}`
    : '请仔细识别附带图片中的全部股票买入/卖出成交记录（包含日期、代码、名称、方向、成交价、成交数量、费用），以 JSON 输出。';

  const res = await invokeModel({
    providerOverride,
    systemPrompt,
    userPrompt,
    expectJson: true,
    timeoutMs: 120000,
    imageInput: imageBase64 ? { base64: imageBase64, mimeType: imageMimeType } : null,
  });

  const parsed = parseJsonFromModelOutput(res.rawText);
  const rawArr = Array.isArray(parsed?.trades) ? parsed.trades : Array.isArray(parsed) ? parsed : [];
  const data = loadRawTradeLedger();
  const cleaned = [];
  for (const r of rawArr) {
    try {
      cleaned.push(
        sanitizeTradeInput(
          {
            ...r,
            fee: Number(r.fee) >= 0 ? Number(r.fee) : undefined,
            note: r.note || 'AI截图/文本识别导入',
          },
          data.commissionRate
        )
      );
    } catch {
      // skip invalid row
    }
  }
  return {
    ok: true,
    provider: res.provider,
    model: res.model,
    latencyMs: res.latencyMs,
    trades: cleaned,
  };
}

// ============================================================================
// 核心 FIFO 撮合 + 盘中做T识别 + 卖飞/逃顶审计 + MFE/MAE + 卡片与错因归因
// ============================================================================

async function computeTradeLedgerAnalytics(workspace, opts = {}) {
  const data = loadRawTradeLedger();
  const trades = [...data.trades].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  // 1) 为所有涉及标的并发拉取日K序列（带15分钟缓存，支持实盘现价、MFE/MAE、卖后T+1/T+5/T+20）
  const uniqueCodes = [...new Set(trades.map((t) => t.code))];
  const seriesMap = new Map();
  const seriesErrors = [];
  const fetchSeriesFn = typeof opts.fetchDailySeries === 'function' ? opts.fetchDailySeries : getDailySeriesForQuery;
  if (opts.withMarketData !== false && uniqueCodes.length > 0) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, uniqueCodes.length) }, async () => {
      while (cursor < uniqueCodes.length) {
        const code = uniqueCodes[cursor++];
        try {
          const s = await fetchSeriesFn(code, Boolean(opts.forceRefresh));
          if (s) seriesMap.set(code, s);
        } catch (err) {
          seriesErrors.push(`${code}: ${err?.message || '行情获取失败'}`);
        }
      }
    });
    await Promise.all(workers);
  }

  // 2) FIFO 撮合 + 日内做T自动识别
  // 按标的维护买入批次队列 lotsByCode[code] = [{ trade, remainingQty }]
  const lotsByCode = new Map();
  const closedMatches = []; // 每笔卖出产生的配对归因记录
  const enrichedTrades = [];

  // 预检同日同标的既有 BUY 又有 SELL（盘中做T标志）
  const daySideMap = new Map();
  for (const t of trades) {
    const k = `${t.date}::${t.code}`;
    if (!daySideMap.has(k)) daySideMap.set(k, { buy: 0, sell: 0 });
    const entry = daySideMap.get(k);
    if (t.side === 'BUY') entry.buy += 1;
    else entry.sell += 1;
  }

  for (const t of trades) {
    const dayPair = daySideMap.get(`${t.date}::${t.code}`);
    const isDayT = Boolean(dayPair && dayPair.buy > 0 && dayPair.sell > 0);
    const series = seriesMap.get(t.code);

    if (t.side === 'BUY') {
      if (!lotsByCode.has(t.code)) lotsByCode.set(t.code, []);
      lotsByCode.get(t.code).push({ trade: t, remainingQty: t.quantity });
      enrichedTrades.push({
        ...t,
        isDayT,
        realizedPnl: null,
        returnPct: null,
        rMultiple: null,
        holdingDays: null,
        mfePct: null,
        maePct: null,
        exitAudit: null,
      });
    } else {
      // SELL：FIFO 消耗买入批次
      let remainSell = t.quantity;
      const lots = lotsByCode.get(t.code) || [];
      let matchedCost = 0;
      let matchedBuyFees = 0;
      let matchedQty = 0;
      let weightedRiskR = 0;
      let firstEntryDate = null;
      let entryStopLoss = null;
      const mergedCardIds = new Set(t.cardIds || []);
      const mergedThemes = new Set(t.themes || []);
      let entryEmotion = t.emotionTag;

      while (remainSell > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(remainSell, lot.remainingQty);
        if (!firstEntryDate) firstEntryDate = lot.trade.date;
        if (!entryStopLoss && lot.trade.stopLossPrice) entryStopLoss = lot.trade.stopLossPrice;
        (lot.trade.cardIds || []).forEach((cid) => mergedCardIds.add(cid));
        (lot.trade.themes || []).forEach((th) => mergedThemes.add(th));
        if (lot.trade.emotionTag && lot.trade.emotionTag !== '按计划执行' && entryEmotion === '按计划执行') {
          entryEmotion = lot.trade.emotionTag;
        }

        const ratio = take / lot.trade.quantity;
        matchedCost += take * lot.trade.price;
        matchedBuyFees += lot.trade.fee * ratio;
        if (lot.trade.stopLossPrice && lot.trade.price > lot.trade.stopLossPrice) {
          weightedRiskR += take * (lot.trade.price - lot.trade.stopLossPrice);
        }
        matchedQty += take;
        lot.remainingQty -= take;
        remainSell -= take;
        if (lot.remainingQty <= 0.0001) lots.shift();
      }

      const sellProceeds = matchedQty > 0 ? matchedQty * t.price : t.quantity * t.price;
      const sellFeePortion = matchedQty > 0 ? t.fee * (matchedQty / t.quantity) : t.fee;
      const realizedPnl = matchedQty > 0 ? round2(sellProceeds - matchedCost - matchedBuyFees - sellFeePortion) : 0;
      const returnPct = matchedCost > 0 ? round2((realizedPnl / matchedCost) * 100) : 0;
      const rMultiple = weightedRiskR > 0 ? round2(realizedPnl / weightedRiskR) : null;
      const holdingDays = firstEntryDate
        ? Math.max(0, Math.round((new Date(`${t.date}T00:00:00Z`) - new Date(`${firstEntryDate}T00:00:00Z`)) / 86400000))
        : 0;

      // MFE / MAE（买入日→卖出日之间的最大浮盈/最大浮亏%）
      let mfePct = null;
      let maePct = null;
      let exitAudit = null;
      if (series && Array.isArray(series.klines) && series.klines.length > 0) {
        const klines = series.klines;
        if (firstEntryDate && matchedQty > 0) {
          const avgEntryP = matchedCost / matchedQty;
          const windowBars = klines.filter((k) => k.date >= firstEntryDate && k.date <= t.date);
          if (windowBars.length > 0 && avgEntryP > 0) {
            const maxH = Math.max(...windowBars.map((k) => k.high));
            const minL = Math.min(...windowBars.map((k) => k.low));
            mfePct = round2(((maxH - avgEntryP) / avgEntryP) * 100);
            maePct = round2(((minL - avgEntryP) / avgEntryP) * 100);
          }
        }
        // 卖后 T+1 / T+5 / T+20 卖飞 vs 逃顶审计
        const sellIdx = klines.findIndex((k) => k.date >= t.date);
        if (sellIdx >= 0 && t.price > 0) {
          const afterPct = (offset) => {
            const idx = sellIdx + offset;
            if (idx >= klines.length) return null;
            return round2(((klines[idx].close - t.price) / t.price) * 100);
          };
          const t1 = afterPct(1);
          const t5 = afterPct(5);
          const t20 = afterPct(20);
          const refPct = t5 ?? t1;
          let verdict = '跟踪中';
          if (refPct != null) {
            if (refPct <= -6) verdict = '神级逃顶';
            else if (refPct <= -1.5) verdict = '有效止盈/避险';
            else if (refPct <= 3.5) verdict = '合理落袋';
            else if (refPct <= 10) verdict = '小幅卖飞';
            else verdict = '严重卖飞';
          }
          exitAudit = { afterT1Pct: t1, afterT5Pct: t5, afterT20Pct: t20, verdict };
        }
      }

      const enriched = {
        ...t,
        isDayT,
        realizedPnl,
        returnPct,
        rMultiple,
        holdingDays,
        mfePct,
        maePct,
        exitAudit,
        matchedEntryDate: firstEntryDate,
        cardIds: [...mergedCardIds],
        themes: [...mergedThemes],
        effectiveEmotionTag: entryEmotion,
      };
      enrichedTrades.push(enriched);
      if (matchedQty > 0) closedMatches.push(enriched);
    }
  }

  // 3) 当前在途持仓 + 实时浮盈 + 止损距离 + 同方向集中度暴露
  const holdings = [];
  const holdingStopAlerts = [];
  const holdingStopUnverified = [];
  const themeExposureMap = new Map();
  const quoteDates = [];
  let totalMarketValue = 0;
  let totalUnrealizedPnl = 0;
  let verifiedStopCount = 0;
  let unverifiedStopCount = 0;

  for (const [code, lots] of lotsByCode.entries()) {
    const qty = lots.reduce((s, l) => s + l.remainingQty, 0);
    if (qty <= 0.0001) continue;
    const costAmt = lots.reduce((s, l) => s + l.remainingQty * l.trade.price, 0);
    const avgCost = round2(costAmt / qty);
    const latestLot = lots[lots.length - 1].trade;
    const series = seriesMap.get(code);
    const lastBar = series?.klines?.[series.klines.length - 1];
    const hasLiveQuote = Boolean(lastBar && Number.isFinite(Number(lastBar.close)) && Number(lastBar.close) > 0);
    const quoteDate = hasLiveQuote ? String(lastBar.date || '') : null;
    if (quoteDate) quoteDates.push(quoteDate);
    const currentPrice = hasLiveQuote ? round2(lastBar.close) : avgCost;
    const marketValue = round2(currentPrice * qty);
    const unrealizedPnl = hasLiveQuote ? round2((currentPrice - avgCost) * qty) : 0;
    const unrealizedPct = hasLiveQuote && avgCost > 0 ? round2(((currentPrice - avgCost) / avgCost) * 100) : 0;
    const stopLossPrice = [...lots].reverse().find((l) => l.trade.stopLossPrice)?.trade.stopLossPrice || null;
    const stopDistPct =
      hasLiveQuote && stopLossPrice && currentPrice > 0 ? round2(((currentPrice - stopLossPrice) / currentPrice) * 100) : null;
    const allThemes = [...new Set(lots.flatMap((l) => l.trade.themes || []))];
    const allCards = [...new Set(lots.flatMap((l) => l.trade.cardIds || []))];
    const weightPct = data.accountCapital > 0 ? round2((marketValue / data.accountCapital) * 100) : 0;

    totalMarketValue += marketValue;
    totalUnrealizedPnl += unrealizedPnl;

    for (const th of allThemes.length ? allThemes : ['未分组']) {
      themeExposureMap.set(th, (themeExposureMap.get(th) || 0) + marketValue);
    }

    let hitStop = false;
    let stopCheckStatus = 'no_stop';
    if (stopLossPrice != null) {
      if (hasLiveQuote) {
        verifiedStopCount += 1;
        hitStop = currentPrice <= stopLossPrice;
        stopCheckStatus = hitStop ? 'triggered' : 'verified_ok';
        if (hitStop) {
          holdingStopAlerts.push({
            code,
            name: series?.name || latestLot.name,
            currentPrice,
            stopLossPrice,
            quoteDate,
            detail: `现价 ${currentPrice}（行情 ${quoteDate || '最新'}）已触破入场预设止损价 ${stopLossPrice}（浮盈 ${unrealizedPct}%），请严格执行离场纪律！`,
          });
        }
      } else {
        unverifiedStopCount += 1;
        stopCheckStatus = 'unverified';
        holdingStopUnverified.push({
          code,
          name: series?.name || latestLot.name,
          avgCost,
          stopLossPrice,
          detail:
            opts.withMarketData === false
              ? `未开启实时行情校验，无法核验预设止损价 ${stopLossPrice}（严禁以成本价 ${avgCost} 替代现价）。`
              : `未能拉取有效最新报价，预设止损价 ${stopLossPrice} 处于待核验状态（未用成本价 ${avgCost} 代替现价）。`,
        });
      }
    }

    holdings.push({
      code,
      secid: series?.secid || '',
      name: series?.name || latestLot.name,
      marketKind: latestLot.marketKind,
      currency: latestLot.currency,
      quantity: qty,
      avgCost,
      currentPrice,
      quoteVerified: hasLiveQuote,
      quoteDate,
      marketValue,
      weightPct,
      unrealizedPnl,
      unrealizedPct,
      stopLossPrice,
      stopDistPct,
      hitStop,
      stopCheckStatus,
      exceedsSingleCap: weightPct > data.maxSinglePct,
      themes: allThemes,
      cardIds: allCards,
      firstEntryDate: lots[0].trade.date,
    });
  }

  const trackedStopCount = verifiedStopCount + unverifiedStopCount;
  const quoteAsOf = quoteDates.length ? [...quoteDates].sort().slice(-1)[0] : null;
  const stopLossCoverage = {
    withMarketData: opts.withMarketData !== false,
    openHoldingsCount: holdings.length,
    trackedStopCount,
    verifiedCount: verifiedStopCount,
    unverifiedCount: unverifiedStopCount,
    triggeredCount: holdingStopAlerts.length,
    quoteAsOf,
    status:
      trackedStopCount === 0
        ? 'no_stop_holdings'
        : holdingStopAlerts.length > 0
        ? 'triggered'
        : unverifiedStopCount > 0
        ? 'unverified'
        : 'verified_ok',
    error: seriesErrors.length > 0 ? seriesErrors.slice(0, 3).join('；') : null,
  };

  const themeExposure = [...themeExposureMap.entries()]
    .map(([theme, value]) => {
      const pct = data.accountCapital > 0 ? round2((value / data.accountCapital) * 100) : 0;
      return {
        theme,
        marketValue: round2(value),
        weightPct: pct,
        exceedsThemeCap: pct > data.maxThemePct,
      };
    })
    .sort((a, b) => b.weightPct - a.weightPct);

  // 4) 汇总核心 KPI + 月度盈亏热力日历（PnL Calendar）
  const wins = closedMatches.filter((m) => m.realizedPnl > 0);
  const losses = closedMatches.filter((m) => m.realizedPnl < 0);
  const totalRealizedPnl = round2(closedMatches.reduce((s, m) => s + m.realizedPnl, 0));
  const grossWin = wins.reduce((s, m) => s + m.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, m) => s + m.realizedPnl, 0));
  const winRatePct = closedMatches.length ? round2((wins.length / closedMatches.length) * 100) : null;
  const profitFactor = grossLoss > 0 ? round2(grossWin / grossLoss) : grossWin > 0 ? 9.99 : null;
  const rVals = closedMatches.map((m) => m.rMultiple).filter((v) => v != null);
  const avgR = rVals.length ? round2(rVals.reduce((a, b) => a + b, 0) / rVals.length) : null;
  const avgWin = wins.length ? round2(grossWin / wins.length) : 0;
  const avgLoss = losses.length ? round2(grossLoss / losses.length) : 0;
  const dayTTrades = closedMatches.filter((m) => m.isDayT);
  const dayTPnl = round2(dayTTrades.reduce((s, m) => s + m.realizedPnl, 0));

  // Edge Score (0-100)：综合胜率、盈亏比与纪律执行分
  const avgPlanScore = trades.length ? round2(trades.reduce((s, t) => s + (t.planScore || 7), 0) / trades.length) : 7;
  let edgeScore = 50;
  if (closedMatches.length > 0) {
    const wrPart = Math.min(35, ((winRatePct || 0) / 100) * 50);
    const pfPart = Math.min(35, ((Math.min(profitFactor || 0, 3)) / 3) * 35);
    const discPart = (avgPlanScore / 10) * 30;
    edgeScore = Math.round(Math.max(5, Math.min(100, wrPart + pfPart + discPart)));
  }

  // 月度盈亏日历（按卖出结算日期聚合）
  const calMap = new Map();
  for (const m of closedMatches) {
    if (!calMap.has(m.date)) calMap.set(m.date, { date: m.date, pnl: 0, count: 0, wins: 0, losses: 0, dayTCount: 0 });
    const c = calMap.get(m.date);
    c.pnl = round2(c.pnl + m.realizedPnl);
    c.count += 1;
    if (m.realizedPnl > 0) c.wins += 1;
    if (m.realizedPnl < 0) c.losses += 1;
    if (m.isDayT) c.dayTCount += 1;
  }
  const pnlCalendar = [...calMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // 5) Playbook 方法论卡片归因矩阵（哪张卡片实战最赚钱！）
  const cardTitleMap = new Map((workspace?.methodology?.cards || []).map((c) => [c.id, c.title]));
  const cardMap = new Map();
  for (const m of closedMatches) {
    const ids = m.cardIds && m.cardIds.length ? m.cardIds : ['未标卡'];
    for (const cid of ids) {
      if (!cardMap.has(cid)) {
        cardMap.set(cid, {
          cardId: cid,
          cardTitle: cardTitleMap.get(cid) || (cid === '未标卡' ? '未关联方法论卡片' : `卡片 ${cid}`),
          count: 0,
          wins: 0,
          totalPnl: 0,
          rSum: 0,
          rCount: 0,
        });
      }
      const row = cardMap.get(cid);
      row.count += 1;
      if (m.realizedPnl > 0) row.wins += 1;
      row.totalPnl = round2(row.totalPnl + m.realizedPnl);
      if (m.rMultiple != null) {
        row.rSum += m.rMultiple;
        row.rCount += 1;
      }
    }
  }
  const cardAttribution = [...cardMap.values()]
    .map((r) => ({
      cardId: r.cardId,
      cardTitle: r.cardTitle,
      count: r.count,
      winRatePct: r.count ? round2((r.wins / r.count) * 100) : 0,
      avgR: r.rCount ? round2(r.rSum / r.rCount) : null,
      totalPnl: r.totalPnl,
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  // 6) Edgewonk 行为错因成本榜（Mistake Cost）
  const mistakeMap = new Map();
  let totalMistakeCost = 0;
  for (const m of closedMatches) {
    const tag = m.effectiveEmotionTag || m.emotionTag || '按计划执行';
    if (!mistakeMap.has(tag)) mistakeMap.set(tag, { tag, count: 0, wins: 0, totalPnl: 0, lossOnly: 0 });
    const row = mistakeMap.get(tag);
    row.count += 1;
    if (m.realizedPnl > 0) row.wins += 1;
    row.totalPnl = round2(row.totalPnl + m.realizedPnl);
    if (m.realizedPnl < 0) row.lossOnly = round2(row.lossOnly + Math.abs(m.realizedPnl));
    if (tag !== '按计划执行' && tag !== '试错按纪律止损' && m.realizedPnl < 0) {
      totalMistakeCost = round2(totalMistakeCost + Math.abs(m.realizedPnl));
    }
  }
  const mistakeAttribution = [...mistakeMap.values()]
    .map((r) => ({
      tag: r.tag,
      count: r.count,
      winRatePct: r.count ? round2((r.wins / r.count) * 100) : 0,
      totalPnl: r.totalPnl,
      lossCost: r.lossOnly,
      isDiscipline: r.tag === '按计划执行' || r.tag === '试错按纪律止损',
    }))
    .sort((a, b) => a.totalPnl - b.totalPnl);

  return {
    ok: true,
    updatedAt: data.updatedAt,
    settings: {
      accountCapital: data.accountCapital,
      commissionRate: data.commissionRate,
      maxSinglePct: data.maxSinglePct,
      maxThemePct: data.maxThemePct,
    },
    emotionTagOptions: EMOTION_TAGS,
    kpi: {
      totalTrades: trades.length,
      closedCount: closedMatches.length,
      openHoldingsCount: holdings.length,
      totalRealizedPnl,
      totalUnrealizedPnl: round2(totalUnrealizedPnl),
      totalPnl: round2(totalRealizedPnl + totalUnrealizedPnl),
      totalMarketValue: round2(totalMarketValue),
      positionRatioPct: data.accountCapital > 0 ? round2((totalMarketValue / data.accountCapital) * 100) : 0,
      winRatePct,
      profitFactor,
      avgR,
      avgWin,
      avgLoss,
      avgPlanScore,
      edgeScore,
      dayTCount: dayTTrades.length,
      dayTPnl,
      totalMistakeCost,
    },
    holdings,
    holdingStopAlerts,
    holdingStopUnverified,
    stopLossCoverage,
    themeExposure,
    trades: [...enrichedTrades].reverse(),
    pnlCalendar,
    cardAttribution,
    mistakeAttribution,
  };
}

/**
 * 为 K 线图返回某标的的全部 B/S 买卖点标记与在途均价/止损线
 */
function getTradeMarkersForSymbol(codeOrSecid) {
  const norm = normalizeCode(String(codeOrSecid || '').replace(/^\d+\./, ''));
  if (!norm) return { markers: [], avgCostPrice: null, stopLossPrice: null, holdingQty: 0 };
  const data = loadRawTradeLedger();
  const matched = data.trades.filter((t) => normalizeCode(t.code) === norm);
  let qty = 0;
  let cost = 0;
  let stopLoss = null;
  for (const t of matched) {
    if (t.side === 'BUY') {
      cost += t.price * t.quantity;
      qty += t.quantity;
      if (t.stopLossPrice) stopLoss = t.stopLossPrice;
    } else if (qty > 0) {
      const avgP = cost / qty;
      const take = Math.min(qty, t.quantity);
      qty -= take;
      cost = Math.max(0, cost - take * avgP);
    }
  }
  return {
    code: norm,
    markers: matched.map((t) => ({
      id: t.id,
      date: t.date,
      time: t.time,
      side: t.side,
      price: t.price,
      quantity: t.quantity,
      emotionTag: t.emotionTag,
      cardIds: t.cardIds,
      note: t.note,
    })),
    holdingQty: qty,
    avgCostPrice: qty > 0 ? round2(cost / qty) : null,
    stopLossPrice: qty > 0 ? stopLoss : null,
  };
}

module.exports = {
  EMOTION_TAGS,
  loadRawTradeLedger,
  addTrades,
  updateTrade,
  deleteTrade,
  updateTradeSettings,
  parseBrokerCsvText,
  parseTradesWithAi,
  computeTradeLedgerAnalytics,
  getTradeMarkersForSymbol,
};
