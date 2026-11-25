'use strict';

/**
 * 量化策略实时信号提取与全市场选股引擎（Live Strategy Signal Overlay + A-Share Market Screener）
 *
 * 解决两大核心痛点：
 * 1. 回测好的策略指标可一键「提取并发布」到本地工作空间（published-strategies.local.json），
 *    随后无需启动 Python，直接用 100% 确定性纯 JS 指标内核（与 quant_engine/core/indicators.py 数学口径一致）
 *    在全市场任意标的（A股/美股/港股/期货，任意周期）的盯盘页面与 K 线图上实时绘制 `策B` / `策S` 信号点！
 * 2. 提供「全市场实时量化选股器」：先按价格/成交额/涨跌幅/换手/量比/排除ST 从实时全 A 股池初筛，
 *    再可选叠加已发布的策略信号对候选股实时计算 B/S 触发状态，一键加入自选、打开全屏 K 线或批量同步 DuckDB 回测！
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { workspaceStateFile } = require('./app-paths.cjs');
const { fetchMultiTimeframeKlines } = require('./watchlist-service.cjs');

const BATCH_CACHE = new Map();
const BATCH_CACHE_MAX = 120;

function nowIso() {
  return new Date().toISOString();
}

function getPublishedStorePath() {
  return workspaceStateFile('published-strategies.local.json');
}

function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

// ============================================================================
// 1. 指标计算数学内核（严格对齐 quant_engine/core/indicators.py）
// ============================================================================

function calcSma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  const p = Math.max(1, Math.floor(Number(period) || 5));
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= p) sum -= values[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

function calcEma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  if (n === 0) return out;
  const p = Math.max(1, Math.floor(Number(period) || 12));
  const k = 2 / (p + 1);
  out[0] = values[0];
  for (let i = 1; i < n; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function calcRsi(values, period = 14) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  const p = Math.max(2, Math.floor(Number(period) || 14));
  if (n <= p) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= p; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= p;
  avgLoss /= p;
  out[p] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = p + 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (p - 1) + g) / p;
    avgLoss = (avgLoss * (p - 1) + l) / p;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function calcBias(values, period = 5) {
  const ma = calcSma(values, period);
  return values.map((v, i) => (Number.isFinite(ma[i]) && ma[i] > 0 ? ((v - ma[i]) / ma[i]) * 100 : NaN));
}

function calcMacd(values, fast = 12, slow = 26, sig = 9) {
  const ef = calcEma(values, fast);
  const es = calcEma(values, slow);
  const dif = values.map((_, i) => ef[i] - es[i]);
  const dea = calcEma(dif, sig);
  const hist = dif.map((d, i) => (d - dea[i]) * 2);
  return { dif, dea, hist };
}

function calcBoll(values, period = 20, mult = 2) {
  const mid = calcSma(values, period);
  const p = Math.max(2, Math.floor(Number(period) || 20));
  const upper = new Array(values.length).fill(NaN);
  const lower = new Array(values.length).fill(NaN);
  for (let i = p - 1; i < values.length; i++) {
    const m = mid[i];
    let sq = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const diff = values[j] - m;
      sq += diff * diff;
    }
    const std = Math.sqrt(sq / p);
    upper[i] = m + mult * std;
    lower[i] = m - mult * std;
  }
  return { upper, mid, lower };
}

function calcAtr(highs, lows, closes, period = 14) {
  const n = closes.length;
  const tr = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i === 0) tr[i] = highs[i] - lows[i];
    else {
      tr[i] = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
    }
  }
  return calcSma(tr, period);
}

function isCrossAbove(a, b, i) {
  if (i < 1) return false;
  return (
    Number.isFinite(a[i - 1]) &&
    Number.isFinite(b[i - 1]) &&
    Number.isFinite(a[i]) &&
    Number.isFinite(b[i]) &&
    a[i - 1] <= b[i - 1] &&
    a[i] > b[i]
  );
}

function isCrossBelow(a, b, i) {
  if (i < 1) return false;
  return (
    Number.isFinite(a[i - 1]) &&
    Number.isFinite(b[i - 1]) &&
    Number.isFinite(a[i]) &&
    Number.isFinite(b[i]) &&
    a[i - 1] >= b[i - 1] &&
    a[i] < b[i]
  );
}

// ============================================================================
// 2. 从内置 / 自定义 Python 策略或可视化规则推断可执行实时指标规格
// ============================================================================

function inferStrategySignalSpec(input = {}) {
  if (input.engineKind && input.engineKind !== 'auto') {
    return {
      engineKind: input.engineKind,
      ruleConfig: input.ruleConfig || null,
      params: input.params || {},
    };
  }
  if (input.strategyMode === 'visual' && input.ruleConfig) {
    return {
      engineKind: 'visual_rule',
      ruleConfig: input.ruleConfig,
      params: input.params || {},
    };
  }
  const sid = String(input.strategyId || '').toLowerCase();
  const code = String(input.code || '');
  const extractNum = (key, def) => {
    const m = code.match(new RegExp(`["']${key}["']\\s*,\\s*([0-9.]+)`));
    return m ? Number(m[1]) : def;
  };
  if (sid.includes('rsi') || /rsi_period|oversold|overbought/i.test(code)) {
    return {
      engineKind: 'builtin_rsi_rebound',
      ruleConfig: null,
      params: {
        rsi_period: extractNum('rsi_period', 14),
        oversold: extractNum('oversold', 30),
        overbought: extractNum('overbought', 72),
        ...(input.params || {}),
      },
    };
  }
  if (sid.includes('bias') || /ma5_bias_max|atr_mult/i.test(code)) {
    return {
      engineKind: 'builtin_bias_2n_stop',
      ruleConfig: null,
      params: {
        ma_trend: extractNum('ma_trend', 20),
        ma5_bias_max: extractNum('ma5_bias_max', 8),
        ma5_bias_take_profit: extractNum('ma5_bias_take_profit', 15),
        atr_mult: extractNum('atr_mult', 2),
        ...(input.params || {}),
      },
    };
  }
  // 默认或双均线类策略（自动提取源码里的 fast / slow 参数）
  return {
    engineKind: 'builtin_dual_ma',
    ruleConfig: null,
    params: {
      fast: extractNum('fast', 5),
      slow: extractNum('slow', 20),
      ...(input.params || {}),
    },
  };
}

// ============================================================================
// 3. 实时策略发布持久化管理（workspace-scoped）
// ============================================================================

const DEFAULT_PRESET_STRATEGIES = [
  {
    id: 'preset_dual_ma_5_20',
    strategyId: 'builtin_dual_ma',
    name: '双均线趋势跟踪 (MA5/MA20)',
    description: 'MA5 上穿 MA20 触发策B，下穿触发策S',
    engineKind: 'builtin_dual_ma',
    ruleConfig: null,
    params: { fast: 5, slow: 20 },
    metricsSummary: null,
    builtinPreset: true,
    enabledDefault: false,
    publishedAt: null,
  },
  {
    id: 'preset_bias_2n',
    strategyId: 'builtin_bias_2n_stop',
    name: '均线乖离过滤 + 2N海龟止损',
    description: '站稳 MA20 且 MA5 乖离可控触发策B；跌破 2N 止损/MA20 或高乖离止盈触发策S',
    engineKind: 'builtin_bias_2n_stop',
    ruleConfig: null,
    params: { ma_trend: 20, ma5_bias_max: 8, ma5_bias_take_profit: 15, atr_mult: 2 },
    metricsSummary: null,
    builtinPreset: true,
    enabledDefault: false,
    publishedAt: null,
  },
  {
    id: 'preset_rsi_rebound',
    strategyId: 'builtin_rsi_rebound',
    name: 'RSI(14) 超跌反弹',
    description: 'RSI <= 30 超跌触发策B，RSI >= 72 过热触发策S',
    engineKind: 'builtin_rsi_rebound',
    ruleConfig: null,
    params: { rsi_period: 14, oversold: 30, overbought: 72 },
    metricsSummary: null,
    builtinPreset: true,
    enabledDefault: false,
    publishedAt: null,
  },
];

function loadPublishedStrategiesStore() {
  const filePath = getPublishedStorePath();
  let stored = null;
  try {
    if (fs.existsSync(filePath)) {
      stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    stored = null;
  }
  const userItems = Array.isArray(stored?.items) ? stored.items : [];
  const defaultActiveId = typeof stored?.defaultActiveId === 'string' ? stored.defaultActiveId : '';
  return {
    updatedAt: stored?.updatedAt || null,
    defaultActiveId,
    items: userItems,
    presets: DEFAULT_PRESET_STRATEGIES,
    allStrategies: [...userItems, ...DEFAULT_PRESET_STRATEGIES],
  };
}

function publishLiveStrategy(payload = {}) {
  const name = String(payload.name || payload.strategyName || '').trim();
  if (!name) throw new Error('请填写策略名称');
  const spec = inferStrategySignalSpec(payload);
  const store = loadPublishedStrategiesStore();
  const existingId = String(payload.id || '').trim();
  const now = nowIso();
  const record = {
    id: existingId && !existingId.startsWith('preset_') ? existingId : `ps_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
    strategyId: String(payload.strategyId || ''),
    name,
    description: String(payload.description || '').trim(),
    engineKind: spec.engineKind,
    ruleConfig: spec.ruleConfig,
    params: spec.params,
    metricsSummary: payload.metricsSummary || null,
    sourceRunId: payload.sourceRunId || null,
    builtinPreset: false,
    publishedAt: now,
  };
  const nextItems = [record, ...store.items.filter((x) => x.id !== record.id)].slice(0, 40);
  const defaultActiveId = payload.setDefault !== false ? record.id : store.defaultActiveId;
  atomicWriteJson(getPublishedStorePath(), {
    updatedAt: now,
    defaultActiveId,
    items: nextItems,
  });
  BATCH_CACHE.clear();
  return { ok: true, strategy: record, store: loadPublishedStrategiesStore() };
}

function deletePublishedStrategy(id) {
  const cleanId = String(id || '').trim();
  if (!cleanId) throw new Error('缺少策略 ID');
  const store = loadPublishedStrategiesStore();
  const nextItems = store.items.filter((x) => x.id !== cleanId);
  const nextDefault = store.defaultActiveId === cleanId ? '' : store.defaultActiveId;
  atomicWriteJson(getPublishedStorePath(), {
    updatedAt: nowIso(),
    defaultActiveId: nextDefault,
    items: nextItems,
  });
  BATCH_CACHE.clear();
  return { ok: true, deleted: nextItems.length < store.items.length, store: loadPublishedStrategiesStore() };
}

function findStrategyById(strategyId) {
  const store = loadPublishedStrategiesStore();
  const id = String(strategyId || '').trim();
  if (!id) return null;
  return store.allStrategies.find((s) => s.id === id || s.strategyId === id) || null;
}

// ============================================================================
// 4. 在任意标的 K 线序列上实时计算策略 B/S 信号点
// ============================================================================

function computeOperandSeries(opSpec, seriesCache) {
  const kind = String(opSpec?.type || 'CONST').toUpperCase();
  const period = Math.max(1, Math.floor(Number(opSpec?.period) || 20));
  const val = Number(opSpec?.value) || 0;
  const key = `${kind}:${period}:${val}`;
  if (seriesCache.has(key)) return seriesCache.get(key);

  const { closes, vols } = seriesCache.raw;
  const n = closes.length;
  let arr;
  if (kind === 'CONST') arr = new Array(n).fill(val);
  else if (kind === 'CLOSE') arr = closes;
  else if (kind === 'MA') arr = calcSma(closes, period);
  else if (kind === 'EMA') arr = calcEma(closes, period);
  else if (kind === 'RSI') arr = calcRsi(closes, period);
  else if (kind === 'BIAS') arr = calcBias(closes, period);
  else if (kind === 'MACD_HIST') arr = calcMacd(closes).hist;
  else if (kind === 'MACD_DIF') arr = calcMacd(closes).dif;
  else if (kind === 'MACD_DEA') arr = calcMacd(closes).dea;
  else if (kind === 'BOLL_UPPER') arr = calcBoll(closes, period).upper;
  else if (kind === 'BOLL_LOWER') arr = calcBoll(closes, period).lower;
  else if (kind === 'VOL_RATIO') {
    const vma = calcSma(vols, period);
    arr = vols.map((v, i) => (Number.isFinite(vma[i]) && vma[i] > 0 ? v / vma[i] : NaN));
  } else if (kind === 'PCT_CHG') {
    arr = closes.map((c, i) => (i > 0 && closes[i - 1] > 0 ? ((c - closes[i - 1]) / closes[i - 1]) * 100 : NaN));
  } else {
    arr = new Array(n).fill(NaN);
  }
  seriesCache.set(key, arr);
  return arr;
}

function normalizeConditionOperands(cond) {
  if (cond && cond.left && typeof cond.left === 'object' && cond.right && typeof cond.right === 'object') {
    return [cond.left, cond.right];
  }
  const left = {
    type: String(cond?.indicator || 'CLOSE').toUpperCase(),
    period: Number(cond?.period) || 20,
  };
  const rhsType = String(cond?.rhsType || 'value').toLowerCase();
  const right =
    rhsType === 'indicator'
      ? { type: String(cond?.rhsIndicator || 'MA').toUpperCase(), period: Number(cond?.rhsPeriod) || 20 }
      : { type: 'CONST', value: Number(cond?.value) || 0 };
  return [left, right];
}

function evalConditionAt(cond, i, seriesCache) {
  const [leftSpec, rightSpec] = normalizeConditionOperands(cond || {});
  const left = computeOperandSeries(leftSpec, seriesCache);
  const right = computeOperandSeries(rightSpec, seriesCache);
  const op = String(cond.op || '>').trim().toLowerCase();
  if (op === 'cross_above') return isCrossAbove(left, right, i);
  if (op === 'cross_below') return isCrossBelow(left, right, i);
  const a = left[i];
  const b = right[i];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (op === '>') return a > b;
  if (op === '>=') return a >= b;
  if (op === '<') return a < b;
  if (op === '<=') return a <= b;
  if (op === '==' || op === '=') return Math.abs(a - b) < 1e-6;
  return false;
}

function evaluateStrategyOnKlines(strategy, klines = []) {
  if (!strategy || !Array.isArray(klines) || klines.length < 6) {
    return { signals: [], latestSignal: null, inPosition: false, buyCount: 0, sellCount: 0 };
  }
  const closes = klines.map((k) => Number(k.close));
  const highs = klines.map((k) => Number(k.high));
  const lows = klines.map((k) => Number(k.low));
  const vols = klines.map((k) => Number(k.vol ?? k.volume ?? 0));
  const n = klines.length;
  const signals = [];
  let inPos = false;
  let highestSinceEntry = 0;

  const kind = strategy.engineKind || 'builtin_dual_ma';
  const params = strategy.params || {};

  if (kind === 'visual_rule' && strategy.ruleConfig) {
    const rc = strategy.ruleConfig;
    const entryLogic = String(rc.entryLogic || 'AND').toUpperCase();
    const exitLogic = String(rc.exitLogic || 'OR').toUpperCase();
    const entryConds = Array.isArray(rc.entryConditions) ? rc.entryConditions : [];
    const exitConds = Array.isArray(rc.exitConditions) ? rc.exitConditions : [];
    const cache = new Map();
    cache.raw = { closes, highs, lows, vols };

    for (let i = 2; i < n; i++) {
      if (inPos && exitConds.length > 0) {
        const res = exitConds.map((c) => evalConditionAt(c, i, cache));
        const shouldExit = exitLogic === 'AND' ? res.every(Boolean) : res.some(Boolean);
        if (shouldExit) {
          inPos = false;
          signals.push({
            date: String(klines[i].date),
            barIndex: i,
            side: 'SELL',
            price: closes[i],
            reason: '触发可视化规则离场条件',
            strategyId: strategy.id,
            strategyName: strategy.name,
          });
          continue;
        }
      }
      if (!inPos && entryConds.length > 0) {
        const res = entryConds.map((c) => evalConditionAt(c, i, cache));
        const shouldEnter = entryLogic === 'AND' ? res.every(Boolean) : res.some(Boolean);
        if (shouldEnter) {
          inPos = true;
          signals.push({
            date: String(klines[i].date),
            barIndex: i,
            side: 'BUY',
            price: closes[i],
            reason: '触发可视化规则入场条件',
            strategyId: strategy.id,
            strategyName: strategy.name,
          });
        }
      }
    }
  } else if (kind === 'builtin_rsi_rebound') {
    const p = Math.max(2, Math.floor(Number(params.rsi_period) || 14));
    const oversold = Number(params.oversold ?? 30);
    const overbought = Number(params.overbought ?? 72);
    const rsiArr = calcRsi(closes, p);
    for (let i = p + 1; i < n; i++) {
      const rv = rsiArr[i];
      if (!Number.isFinite(rv)) continue;
      if (!inPos && rv <= oversold) {
        inPos = true;
        signals.push({
          date: String(klines[i].date),
          barIndex: i,
          side: 'BUY',
          price: closes[i],
          reason: `RSI(${p})=${rv.toFixed(1)} <= ${oversold} 超跌吸筹`,
          strategyId: strategy.id,
          strategyName: strategy.name,
        });
      } else if (inPos && rv >= overbought) {
        inPos = false;
        signals.push({
          date: String(klines[i].date),
          barIndex: i,
          side: 'SELL',
          price: closes[i],
          reason: `RSI(${p})=${rv.toFixed(1)} >= ${overbought} 过热止盈`,
          strategyId: strategy.id,
          strategyName: strategy.name,
        });
      }
    }
  } else if (kind === 'builtin_bias_2n_stop') {
    const maTrend = Math.max(5, Math.floor(Number(params.ma_trend) || 20));
    const biasMax = Number(params.ma5_bias_max ?? 8);
    const biasTp = Number(params.ma5_bias_take_profit ?? 15);
    const atrMult = Number(params.atr_mult ?? 2);
    const ma5 = calcSma(closes, 5);
    const maN = calcSma(closes, maTrend);
    const bias5 = calcBias(closes, 5);
    const atr14 = calcAtr(highs, lows, closes, 14);
    for (let i = maTrend + 1; i < n; i++) {
      if (!Number.isFinite(maN[i]) || !Number.isFinite(maN[i - 1]) || !Number.isFinite(ma5[i])) continue;
      const c = closes[i];
      const curBias = bias5[i];
      const curAtr = Number.isFinite(atr14[i]) ? atr14[i] : 0;
      if (!inPos) {
        if (c > maN[i] && maN[i] >= maN[i - 1] && c >= ma5[i] && curBias <= biasMax) {
          inPos = true;
          highestSinceEntry = highs[i];
          signals.push({
            date: String(klines[i].date),
            barIndex: i,
            side: 'BUY',
            price: c,
            reason: `站稳MA${maTrend}且MA5乖离+${curBias.toFixed(1)}%可控`,
            strategyId: strategy.id,
            strategyName: strategy.name,
          });
        }
      } else {
        if (highs[i] > highestSinceEntry) highestSinceEntry = highs[i];
        const stopPx = highestSinceEntry - atrMult * curAtr;
        if (curAtr > 0 && c <= stopPx) {
          inPos = false;
          signals.push({
            date: String(klines[i].date),
            barIndex: i,
            side: 'SELL',
            price: c,
            reason: `跌破${atrMult}N海龟移动止损(${stopPx.toFixed(2)})`,
            strategyId: strategy.id,
            strategyName: strategy.name,
          });
        } else if (curBias >= biasTp) {
          inPos = false;
          signals.push({
            date: String(klines[i].date),
            barIndex: i,
            side: 'SELL',
            price: c,
            reason: `MA5乖离+${curBias.toFixed(1)}%触发高位止盈`,
            strategyId: strategy.id,
            strategyName: strategy.name,
          });
        } else if (c < maN[i]) {
          inPos = false;
          signals.push({
            date: String(klines[i].date),
            barIndex: i,
            side: 'SELL',
            price: c,
            reason: `跌破MA${maTrend}生命线离场`,
            strategyId: strategy.id,
            strategyName: strategy.name,
          });
        }
      }
    }
  } else {
    // builtin_dual_ma
    const fast = Math.max(2, Math.floor(Number(params.fast) || 5));
    const slow = Math.max(fast + 1, Math.floor(Number(params.slow) || 20));
    const maF = calcSma(closes, fast);
    const maS = calcSma(closes, slow);
    for (let i = slow; i < n; i++) {
      if (!inPos && isCrossAbove(maF, maS, i)) {
        inPos = true;
        signals.push({
          date: String(klines[i].date),
          barIndex: i,
          side: 'BUY',
          price: closes[i],
          reason: `MA${fast}上穿MA${slow}金叉`,
          strategyId: strategy.id,
          strategyName: strategy.name,
        });
      } else if (inPos && isCrossBelow(maF, maS, i)) {
        inPos = false;
        signals.push({
          date: String(klines[i].date),
          barIndex: i,
          side: 'SELL',
          price: closes[i],
          reason: `MA${fast}下穿MA${slow}死叉`,
          strategyId: strategy.id,
          strategyName: strategy.name,
        });
      }
    }
  }

  const last = signals.length ? signals[signals.length - 1] : null;
  const latestSignal = last
    ? {
        ...last,
        barsAgo: Math.max(0, n - 1 - last.barIndex),
      }
    : null;

  return {
    signals,
    latestSignal,
    inPosition: inPos,
    buyCount: signals.filter((s) => s.side === 'BUY').length,
    sellCount: signals.filter((s) => s.side === 'SELL').length,
  };
}

async function evaluateStrategyBatch({ strategyId, secids = [], timeframe = 'day' }) {
  const strategy = findStrategyById(strategyId);
  if (!strategy) throw new Error('未找到指定的策略指标');
  const unique = [...new Set((secids || []).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 40);
  const results = {};

  let idx = 0;
  const workers = Array.from({ length: Math.min(5, unique.length) }, async () => {
    while (idx < unique.length) {
      const secid = unique[idx++];
      const cacheKey = `${strategy.id}|${secid}|${timeframe}`;
      const hit = BATCH_CACHE.get(cacheKey);
      if (hit && Date.now() - hit.ts < 60 * 1000) {
        results[secid] = hit.val;
        continue;
      }
      try {
        const marketKind = secid.startsWith('105.') || secid.startsWith('106.') || secid.startsWith('107.')
          ? 'US'
          : secid.startsWith('116.')
          ? 'HK'
          : 'CN';
        const klines = await fetchMultiTimeframeKlines(secid, marketKind, timeframe, 120);
        const evalOut = evaluateStrategyOnKlines(strategy, klines);
        const summary = {
          secid,
          latestSignal: evalOut.latestSignal,
          inPosition: evalOut.inPosition,
          buyCount: evalOut.buyCount,
          sellCount: evalOut.sellCount,
        };
        if (BATCH_CACHE.size >= BATCH_CACHE_MAX) {
          const oldest = BATCH_CACHE.keys().next().value;
          if (oldest) BATCH_CACHE.delete(oldest);
        }
        BATCH_CACHE.set(cacheKey, { ts: Date.now(), val: summary });
        results[secid] = summary;
      } catch {
        results[secid] = { secid, latestSignal: null, inPosition: false, buyCount: 0, sellCount: 0 };
      }
    }
  });
  await Promise.all(workers);

  return {
    ok: true,
    strategy: { id: strategy.id, name: strategy.name, engineKind: strategy.engineKind },
    timeframe,
    results,
  };
}

// ============================================================================
// 5. 全市场实时 A 股智能选股扫描（初筛 + 可选策略 B/S 信号复筛）
// ============================================================================

async function screenLiveMarketStocks(params = {}) {
  const minPrice = Number(params.minPrice) || 0;
  const maxPrice = Number(params.maxPrice) || 0;
  const minAmountYi = Number(params.minAmountYi) || 3;
  const minPct = params.minPct !== undefined && params.minPct !== '' ? Number(params.minPct) : -10;
  const maxPct = params.maxPct !== undefined && params.maxPct !== '' ? Number(params.maxPct) : 21;
  const minTurnover = Number(params.minTurnover) || 0;
  const minVolRatio = Number(params.minVolRatio) || 0;
  const excludeSt = params.excludeSt !== false;
  const sortField = String(params.sortBy || 'f6'); // f6成交额 | f3涨幅 | f10量比 | f8换手 | f62主力净流
  const strategyId = String(params.strategyId || '').trim();
  const signalFilter = String(params.signalFilter || 'any'); // any | buy_recent | in_position
  const limit = Math.max(5, Math.min(50, Number(params.limit) || 25));

  const fsExpr = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
  const fields = 'f12,f13,f14,f2,f3,f6,f7,f8,f10,f62,f184';
  const fid = ['f3', 'f6', 'f8', 'f10', 'f62'].includes(sortField) ? sortField : 'f6';
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=150&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=${fid}&fs=${encodeURIComponent(fsExpr)}&fields=${fields}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(9000),
  });
  const json = await res.json();
  const rows = Array.isArray(json?.data?.diff) ? json.data.diff : [];

  const candidates = [];
  for (const r of rows) {
    const code = String(r.f12 || '').trim();
    const name = String(r.f14 || '').trim();
    if (!code || !name) continue;
    if (excludeSt && /ST|退/i.test(name)) continue;
    const price = r.f2 !== '-' ? Number(r.f2) : NaN;
    const pct = r.f3 !== '-' ? Number(r.f3) : NaN;
    const amtYi = r.f6 !== '-' ? Number(r.f6) / 1e8 : 0;
    const turn = r.f8 !== '-' ? Number(r.f8) : 0;
    const volRatio = r.f10 !== '-' ? Number(r.f10) : 0;
    const mainNetYi = r.f62 !== '-' ? Number(r.f62) / 1e8 : null;
    if (!Number.isFinite(price) || price <= 0) continue;
    if (minPrice > 0 && price < minPrice) continue;
    if (maxPrice > 0 && price > maxPrice) continue;
    if (minAmountYi > 0 && amtYi < minAmountYi) continue;
    if (Number.isFinite(pct) && (pct < minPct || pct > maxPct)) continue;
    if (minTurnover > 0 && turn < minTurnover) continue;
    if (minVolRatio > 0 && volRatio < minVolRatio) continue;
    const mkt = String(r.f13 ?? (code.startsWith('6') ? '1' : '0'));
    const suffix = code.startsWith('6') ? 'SH' : code.startsWith('8') || code.startsWith('4') ? 'BJ' : 'SZ';
    candidates.push({
      secid: `${mkt}.${code}`,
      code,
      symbol: `${code}.${suffix}`,
      name,
      price: Number(price.toFixed(2)),
      pct: Number.isFinite(pct) ? Number(pct.toFixed(2)) : null,
      amountYi: Number(amtYi.toFixed(2)),
      turnoverPct: Number(turn.toFixed(2)),
      volumeRatio: Number(volRatio.toFixed(2)),
      mainNetYi: mainNetYi != null ? Number(mainNetYi.toFixed(2)) : null,
      latestSignal: null,
      inPosition: false,
    });
  }

  let output = candidates;
  const strategy = strategyId ? findStrategyById(strategyId) : null;
  if (strategy && candidates.length > 0) {
    const toScan = candidates.slice(0, 32);
    const batch = await evaluateStrategyBatch({
      strategyId: strategy.id,
      secids: toScan.map((c) => c.secid),
      timeframe: 'day',
    });
    for (const c of toScan) {
      const ev = batch.results[c.secid];
      if (ev) {
        c.latestSignal = ev.latestSignal;
        c.inPosition = ev.inPosition;
      }
    }
    output = toScan.filter((c) => {
      if (signalFilter === 'buy_recent') {
        return c.latestSignal && c.latestSignal.side === 'BUY' && c.latestSignal.barsAgo <= 5;
      }
      if (signalFilter === 'in_position') {
        return c.inPosition;
      }
      return true;
    });
  }

  return {
    ok: true,
    scannedAt: nowIso(),
    totalPoolScanned: rows.length,
    matchedCount: output.length,
    strategyApplied: strategy ? { id: strategy.id, name: strategy.name } : null,
    items: output.slice(0, limit),
  };
}

module.exports = {
  loadPublishedStrategiesStore,
  publishLiveStrategy,
  deletePublishedStrategy,
  findStrategyById,
  evaluateStrategyOnKlines,
  evaluateStrategyBatch,
  screenLiveMarketStocks,
};
