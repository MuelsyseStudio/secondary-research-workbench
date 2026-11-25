'use strict';

/**
 * 二级投研 · 技术流派引擎：阶段性情绪/股价高点预警 + 多流派一键支撑压力位生成器
 *
 * 严格零编造原则：
 * - 所有技术指标（MA/乖离/MACD/RSI/BOLL/ATR/筹码POC/2B法则/威科夫量价背离/斐波那契/枢轴点）均基于
 *   真实 65 日前复权 K 线 + 实时报价实时计算；
 * - 所有市场情绪指标（两市成交额/红盘率/涨停/跌停/炸板率/封板率/最高连板）均直接来自公开实时盘面接口；
 * - 预警规则天然关联《方法论卡片库》真实卡号，支持从方法论卡片一键提取（规则引擎 + AI提炼）与手动自定义录入。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadWatchlistConfig, fetchDailyKlinesRobust, fetchMultiTimeframeKlines } = require('./watchlist-service.cjs');
const { resolveStockQuery } = require('./stock-researcher.cjs');
const { invokeModel, parseJsonFromModelOutput } = require('./ai-provider.cjs');

const { stateFile } = require('./app-paths.cjs');
const RULES_PATH = stateFile('technical-alerts.local.json');
const SENTIMENT_CHAIN_PATH = stateFile('sentiment-chain.local.json');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
};

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function round3(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(3)) : null;
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
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

function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ============================================================================
// 1. 可选指标字典 & 内置源自《方法论卡片库》的阶段性情绪/股价高点预警规则
// ============================================================================

const METRIC_CATALOG = [
  // 全市场阶段性情绪高点指标
  { key: 'burstRatePct', label: '涨停炸板率 (%)', scope: 'market_sentiment', unit: '%', desc: '炸板/(涨停+炸板)，高炸板率代表高位分歧松动' },
  { key: 'sealRatePct', label: '涨停封板率 (%)', scope: 'market_sentiment', unit: '%', desc: '封板成功率，过低代表接力承接衰竭' },
  { key: 'redRatePct', label: '全市场红盘率 (%)', scope: 'market_sentiment', unit: '%', desc: '上涨家数占比，>80%易现一致高潮次日分歧，<20%近冰点' },
  { key: 'maxBoard', label: '最高连板高度 (板)', scope: 'market_sentiment', unit: '板', desc: '短线最高连板高度，高位易遇监管/兑现天花板' },
  { key: 'ztCount', label: '涨停家数 (只)', scope: 'market_sentiment', unit: '只', desc: '全市场涨停数，>120常为短期情绪高潮' },
  { key: 'dtCount', label: '跌停家数 (只)', scope: 'market_sentiment', unit: '只', desc: '全市场跌停数，>=20代表亏钱效应扩散' },
  { key: 'twoMarketAmtYi', label: '两市成交额 (亿元)', scope: 'market_sentiment', unit: '亿', desc: '全市场量能水平，放巨量滞涨或缩破1.8万亿警示' },
  { key: 'sentimentScore', label: '综合情绪温度 (0-100)', scope: 'market_sentiment', unit: '分', desc: '结合红盘率/涨跌停/炸板率/连板高度的综合情绪热度' },
  // 个股阶段性股价高点 / 见顶 / 破位指标
  { key: 'ma5BiasPct', label: 'MA5 乖离率 (%)', scope: 'stock_peak', unit: '%', desc: '现价偏离5日线幅度（框架增订④：>8%不追高）' },
  { key: 'ma20BiasPct', label: 'MA20 乖离率 (%)', scope: 'stock_peak', unit: '%', desc: '现价偏离20日生命线幅度，>20%波段超买，<-1.5%破位' },
  { key: 'rsi6', label: 'RSI(6) 短线超买', scope: 'stock_peak', unit: '', desc: '6日相对强弱指标，>=82 进入短线过热高点区' },
  { key: 'rsi14', label: 'RSI(14) 波段超买', scope: 'stock_peak', unit: '', desc: '14日相对强弱指标，>=75 波段过热，<=28 超卖' },
  { key: 'bollPosPct', label: '布林带位置 (%)', scope: 'stock_peak', unit: '%', desc: '>=100% 刺破上轨超买区，<=0% 跌破下轨' },
  { key: 'volRatio5d', label: '量能倍数 (较5日均量)', scope: 'stock_peak', unit: '倍', desc: '当日成交量/5日均量，高位>=2.2倍警惕天量见顶' },
  { key: 'upperShadowPct', label: '上影线幅度 (%)', scope: 'stock_peak', unit: '%', desc: '(最高-实体顶)/昨收，>=3.5% 长上影抛压避雷针' },
  { key: 'turnoverPct', label: '当日换手率 (%)', scope: 'stock_peak', unit: '%', desc: '高位剧烈换手/死亡换手警示（卡片071/196）' },
  { key: 'ret5dPct', label: '近5日累计涨幅 (%)', scope: 'stock_peak', unit: '%', desc: '短期加速赶顶幅，>=20% 警惕获利盘集中兑现' },
  { key: 'ret20dPct', label: '近20日累计涨幅 (%)', scope: 'stock_peak', unit: '%', desc: '波段主升幅，>=45% 警惕阶段性拥挤高点' },
  { key: 'macdTopDivergence', label: 'MACD 顶背驰 (1=触发)', scope: 'stock_peak', unit: '信号', desc: '缠论/卡片055：价格创20日新高但MACD动能/DIF走低' },
  { key: 'is2BTopSignal', label: '2B 假突破见顶 (1=触发)', scope: 'stock_peak', unit: '信号', desc: '卡片061：盘中突破前20日高点后迅速回落至前高下方' },
  { key: 'isHighVolStall', label: '威科夫放量滞涨 (1=触发)', scope: 'stock_peak', unit: '信号', desc: '卡片054/196：放量>=1.8倍但收盘滞涨或长上影派发' },
  { key: 'vicUpBreakdown', label: '维克多上升趋势线跌破 (1=触发)', scope: 'stock_peak', unit: '信号', desc: '卡片061：跌破严格不穿K线的维克多上升支撑线（1-2-3反转第一步）' },
  { key: 'vicDownBreakout', label: '维克多下降趋势线突破 (1=触发)', scope: 'stock_peak', unit: '信号', desc: '卡片061：有效向上突破维克多下降压制趋势线（右侧转强信号）' },
  { key: 'tdDemandBreakdown', label: '德马克 TD 需求支撑线跌破 (1=触发)', scope: 'stock_peak', unit: '信号', desc: 'Tom DeMark TD线：跌破右侧最新两个需求低点连线（客观破位预警）' },
  { key: 'tdSupplyBreakout', label: '德马克 TD 供给压力线突破 (1=触发)', scope: 'stock_peak', unit: '信号', desc: 'Tom DeMark TD线：突破右侧最新两个供给高点连线（供给压力瓦解）' },
  { key: 'regChannelPosPct', label: '线性回归通道位置 (%)', scope: 'stock_peak', unit: '%', desc: 'OLS回归±2σ通道位置：>=96%触及上轨超买高点，<=4%触及下轨超卖支撑' },
];

const DEFAULT_ALERT_RULES = [
  {
    id: 'rule-mkt-burst',
    name: '高位炸板率攀升（情绪分歧见顶预警）',
    scope: 'market_sentiment',
    metric: 'burstRatePct',
    operator: '>=',
    threshold: 35,
    severity: 'high',
    enabled: true,
    sourceCardId: '067',
    sourceCardTitle: '短线体系（情绪周期）',
    actionAdvice: '短线筹码剧烈松动，停止追高接力，仅保留核心龙头低吸或降仓防御。',
  },
  {
    id: 'rule-mkt-height',
    name: '最高连板高度触及情绪极值区',
    scope: 'market_sentiment',
    metric: 'maxBoard',
    operator: '>=',
    threshold: 6,
    severity: 'medium',
    enabled: true,
    sourceCardId: '174',
    sourceCardTitle: '连板高度与监管天花板',
    actionAdvice: '短线进入高标监管/兑现敏感区，关注高位断板负反馈风险（卡片067/174）。',
  },
  {
    id: 'rule-mkt-red-euphoria',
    name: '全市场红盘率极端一致高潮',
    scope: 'market_sentiment',
    metric: 'redRatePct',
    operator: '>=',
    threshold: 80,
    severity: 'medium',
    enabled: true,
    sourceCardId: '071',
    sourceCardTitle: '短线体系（情绪极致一致）',
    actionAdvice: '全市场红盘率处于历史高分位一致区，触发情绪过热观察阈值（仅供参考，非投资建议）。',
  },
  {
    id: 'rule-mkt-dt-spread',
    name: '跌停家数扩散（亏钱效应负反馈）',
    scope: 'market_sentiment',
    metric: 'dtCount',
    operator: '>=',
    threshold: 18,
    severity: 'high',
    enabled: true,
    sourceCardId: '067',
    sourceCardTitle: '短线体系（情绪周期退潮）',
    actionAdvice: '跌停家数突破观察阈值，市场进入弱势负反馈风险统计区（仅供参考，请按个人风控纪律独立决策）。',
  },
  {
    id: 'rule-mkt-ice',
    name: '全市场红盘率跌入冰点观察区',
    scope: 'market_sentiment',
    metric: 'redRatePct',
    operator: '<=',
    threshold: 22,
    severity: 'info',
    enabled: true,
    sourceCardId: '181',
    sourceCardTitle: '情绪判定（趋势/情绪二元冰点）',
    actionAdvice: '红盘率处于历史低分位区间，仅作市场情绪温度统计观察（非操作建议）。',
  },
  {
    id: 'rule-stk-ma5-bias',
    name: 'MA5 正乖离超限（>8% 短线加速过热）',
    scope: 'stock_peak',
    metric: 'ma5BiasPct',
    operator: '>=',
    threshold: 8,
    severity: 'high',
    enabled: true,
    sourceCardId: '178',
    sourceCardTitle: '框架增订④ & 卡片178（乖离兑现检验）',
    actionAdvice: '当前价格偏离 MA5 超过设定阈值，属于短期高乖离统计区，提示关注波动放大风险（非操作建议）。',
  },
  {
    id: 'rule-stk-macd-div',
    name: '缠论 MACD 顶背驰（新高动能衰竭）',
    scope: 'stock_peak',
    metric: 'macdTopDivergence',
    operator: '==',
    threshold: 1,
    severity: 'high',
    enabled: true,
    sourceCardId: '055',
    sourceCardTitle: '技术分析（缠论背驰）',
    actionAdvice: '价格创新高但 MACD 动能柱面积回落，触发动量背离统计标记，请结合个人规则复核风险。',
  },
  {
    id: 'rule-stk-2b-top',
    name: '2B 法则假突破见顶预警',
    scope: 'stock_peak',
    metric: 'is2BTopSignal',
    operator: '==',
    threshold: 1,
    severity: 'high',
    enabled: true,
    sourceCardId: '061',
    sourceCardTitle: '投机经典（2B 法则与 1-2-3）',
    actionAdvice: '价格突破 20 日前高后回落至前高下方，触发 2B 结构形态统计标记（仅供参考，非投资建议）。',
  },
  {
    id: 'rule-stk-wyckoff-stall',
    name: '威科夫高位放量滞涨 / 避雷针派发',
    scope: 'stock_peak',
    metric: 'isHighVolStall',
    operator: '==',
    threshold: 1,
    severity: 'high',
    enabled: true,
    sourceCardId: '054',
    sourceCardTitle: '技术分析（量价/威科夫）& 卡片196',
    actionAdvice: '成交量显著放大而收盘涨幅受阻，触发量价背离风险观察标记（非投资建议）。',
  },
  {
    id: 'rule-stk-rsi6',
    name: 'RSI(6) 极端超买过热区',
    scope: 'stock_peak',
    metric: 'rsi6',
    operator: '>=',
    threshold: 82,
    severity: 'medium',
    enabled: true,
    sourceCardId: '058',
    sourceCardTitle: '技术分析（超买动量与位置互证）',
    actionAdvice: 'RSI(6) 进入高位统计区，短期动量偏热，请结合支撑阻力位独立评估风险。',
  },
  {
    id: 'rule-stk-ret5d',
    name: '5日短期急涨加速赶顶（拥挤度警报）',
    scope: 'stock_peak',
    metric: 'ret5dPct',
    operator: '>=',
    threshold: 20,
    severity: 'medium',
    enabled: true,
    sourceCardId: '071',
    sourceCardTitle: '获利盘拥挤与短线兑现风险',
    actionAdvice: '近 5 个交易日累计涨幅突破观察阈值，短期获利盘密集度升高（仅供参考）。',
  },
  {
    id: 'rule-stk-ma20-break',
    name: '跌破 MA20 波段生命线（趋势破位预警）',
    scope: 'stock_peak',
    metric: 'ma20BiasPct',
    operator: '<=',
    threshold: -1.5,
    severity: 'high',
    enabled: true,
    sourceCardId: '053',
    sourceCardTitle: '技术分析（支撑阻力互换与止损）',
    actionAdvice: '收盘价低于 MA20 超过设定阈值，触发趋势走弱统计提醒（非投资建议）。',
  },
  {
    id: 'rule-stk-vic-down',
    name: '维克多上升趋势线跌破（1-2-3 反转预警）',
    scope: 'stock_peak',
    metric: 'vicUpBreakdown',
    operator: '==',
    threshold: 1,
    severity: 'high',
    enabled: true,
    sourceCardId: '061',
    sourceCardTitle: '投机经典（维克多 1-2-3 趋势线法则）',
    actionAdvice: '收盘有效跌破严格上升趋势线，1-2-3 反转第一步已触发，高度警惕反抽不创新高后的主跌段。',
  },
  {
    id: 'rule-stk-td-demand-break',
    name: '德马克 TD 需求支撑线破位预警',
    scope: 'stock_peak',
    metric: 'tdDemandBreakdown',
    operator: '==',
    threshold: 1,
    severity: 'high',
    enabled: true,
    sourceCardId: '052',
    sourceCardTitle: 'Tom DeMark TD 客观切线 & 卡片052趋势确认',
    actionAdvice: '跌破右侧最新两个需求低点连线，短期多头承接斜率失效，防守下看下一共振支撑或减仓。',
  },
  {
    id: 'rule-stk-reg-upper',
    name: '触及线性回归 +2σ 通道上轨（超买见顶警戒）',
    scope: 'stock_peak',
    metric: 'regChannelPosPct',
    operator: '>=',
    threshold: 96,
    severity: 'medium',
    enabled: true,
    sourceCardId: '065',
    sourceCardTitle: '线性回归标准差通道 & 卡片065通道边界',
    actionAdvice: '价格进入统计 +2σ 通道上轨极值区，均值回归概率大增，持仓宜逢高锁盈而非追高。',
  },
  {
    id: 'rule-stk-vic-breakout',
    name: '维克多下降压制线向上突破（左侧转右侧提示）',
    scope: 'stock_peak',
    metric: 'vicDownBreakout',
    operator: '==',
    threshold: 1,
    severity: 'info',
    enabled: true,
    sourceCardId: '061',
    sourceCardTitle: '投机经典（维克多 1-2-3 趋势线反转）',
    actionAdvice: '放量突破下降压制线，观察回踩不破与放量站稳（卡片054/061）以确认空转多。',
  },
];

function sanitizeRule(raw, idx = 0) {
  if (!raw || !raw.metric) return null;
  const metricInfo = METRIC_CATALOG.find((m) => m.key === raw.metric);
  const scope = ['market_sentiment', 'stock_peak'].includes(raw.scope)
    ? raw.scope
    : metricInfo?.scope || 'stock_peak';
  const op = ['>=', '<=', '>', '<', '=='].includes(raw.operator) ? raw.operator : '>=';
  const threshold = Number(raw.threshold);
  if (!Number.isFinite(threshold)) return null;
  return {
    id: String(raw.id || `rule-custom-${Date.now()}-${idx}`),
    name: String(raw.name || metricInfo?.label || raw.metric).trim(),
    scope,
    metric: String(raw.metric),
    operator: op,
    threshold,
    severity: ['high', 'medium', 'info'].includes(raw.severity) ? raw.severity : 'medium',
    enabled: raw.enabled !== false,
    sourceCardId: String(raw.sourceCardId || '').replace(/[^\d]/g, '').slice(0, 3),
    sourceCardTitle: String(raw.sourceCardTitle || '').trim(),
    sourceCardHash: String(raw.sourceCardHash || '').trim(),
    actionAdvice: String(raw.actionAdvice || '').trim(),
  };
}

// ============================================================================
// P0-3A：方法论卡片 ↔ 技术预警规则 哈希漂移审计（源自 ai-mock-trade 手册漂移检测）
// ============================================================================

function computeCardFingerprint(card) {
  if (!card) return '';
  const body = `${card.title || ''}|${card.coreThesis || ''}|${card.applicableConditions || ''}|${card.invalidationSignals || ''}`;
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
}

function auditRuleCardDrift(workspace) {
  const { rules } = loadAlertRules();
  const cardMap = new Map((workspace?.methodology?.cards || []).map((c) => [c.id, c]));
  const driftedRules = [];
  let trackedCount = 0;

  for (const r of rules) {
    if (!r.sourceCardId) continue;
    const card = cardMap.get(r.sourceCardId);
    if (!card) continue;
    const currentHash = computeCardFingerprint(card);
    if (r.sourceCardHash) {
      trackedCount += 1;
      if (r.sourceCardHash !== currentHash) {
        driftedRules.push({
          ruleId: r.id,
          ruleName: r.name,
          sourceCardId: r.sourceCardId,
          sourceCardTitle: card.title,
          savedHash: r.sourceCardHash,
          currentHash,
          credibilityScore: card.credibilityScore,
        });
      }
    }
  }

  return {
    ok: true,
    trackedCount,
    totalCardLinked: rules.filter((r) => r.sourceCardId).length,
    driftedCount: driftedRules.length,
    driftedRules,
    cardVersion: workspace?.methodology?.meta?.version || '',
  };
}

function syncRuleCardHashes(workspace) {
  const { rules } = loadAlertRules();
  const cardMap = new Map((workspace?.methodology?.cards || []).map((c) => [c.id, c]));
  const next = rules.map((r) => {
    const card = r.sourceCardId ? cardMap.get(r.sourceCardId) : null;
    if (!card) return r;
    return {
      ...r,
      sourceCardTitle: card.title || r.sourceCardTitle,
      sourceCardHash: computeCardFingerprint(card),
    };
  });
  return saveAlertRules(next);
}

// ============================================================================
// P0-3B：跨日链式 10 态市场情绪节点状态机（源自 ai-mock-trade 00-market-node.md）
// 10态：冰点 / 连续冰点 / 冰点回暖 / 升温 / 连续升温 / 高潮 / 连续高潮 / 高潮降温 / 降温 / 连续降温
// ============================================================================

const MARKET_NODE_CHANNELS = {
  冰点: {
    channel: 'trial_only',
    channelLabel: '冰点试错 · 严控小仓左侧低吸',
    maxPositionPct: 25,
    colorTone: 'navy',
    boundCards: ['067', '181'],
    actionNote: '情绪进入短线冰点（卡片181），禁止追高杂毛，仅可小仓布局错杀核心趋势或等待次日回暖反核。',
  },
  连续冰点: {
    channel: 'trial_only',
    channelLabel: '连续冰点 · 左侧分批埋伏窗口',
    maxPositionPct: 35,
    colorTone: 'navy',
    boundCards: ['067', '181'],
    actionNote: '连续冰点杀跌动能衰减，盈亏比逐步转向有利，紧盯先于大盘企稳的主线核心。',
  },
  冰点回暖: {
    channel: 'attack_ok',
    channelLabel: '冰点回暖 · 高赔率进攻窗口',
    maxPositionPct: 60,
    colorTone: 'emerald',
    boundCards: ['067', '181'],
    actionNote: '情绪由冰点转暖修复，属于胜率与赔率共振的黄金试错/进攻阶段，聚焦放量领涨主线。',
  },
  升温: {
    channel: 'attack_ok',
    channelLabel: '主升升温 · 顺势进攻通道',
    maxPositionPct: 75,
    colorTone: 'emerald',
    boundCards: ['067', '071'],
    actionNote: '赚钱效应扩散，允许围绕核心主线顺势进攻；仍须严守 MA5 乖离 <8% 纪律（框架增订④）。',
  },
  连续升温: {
    channel: 'attack_ok',
    channelLabel: '连续升温 · 持有主升防加速过热',
    maxPositionPct: 70,
    colorTone: 'emerald',
    boundCards: ['067', '071', '178'],
    actionNote: '情绪连续走强，持仓享受主升溢价，但新开仓提高赔率门槛，警惕加速段一致见顶。',
  },
  高潮: {
    channel: 'realize_only',
    channelLabel: '一致高潮 · 逢高兑现 / 禁追新仓',
    maxPositionPct: 40,
    colorTone: 'crimson',
    boundCards: ['071', '174', '178'],
    actionNote: '全市场情绪进入一致高潮（卡片071），严防次日高开无人接力兑现，以高抛锁盈为主、禁追高开新仓！',
  },
  连续高潮: {
    channel: 'forbidden_new',
    channelLabel: '连续高潮 · 只卖不买红灯区',
    maxPositionPct: 25,
    colorTone: 'crimson',
    boundCards: ['071', '174', '178'],
    actionNote: '极端过热与高标监管天花板共振（卡片174），强制切换「只兑现不开新仓」模式，防范踩踏退潮！',
  },
  高潮降温: {
    channel: 'realize_only',
    channelLabel: '高潮降温 · 去弱留强防守兑现',
    maxPositionPct: 35,
    colorTone: 'amber',
    boundCards: ['067', '071'],
    actionNote: '高位分歧初现（炸板/回落增多），优先兑现后排跟风与高位破位票，切忌在分歧首日盲目重仓接飞刀。',
  },
  降温: {
    channel: 'trial_only',
    channelLabel: '退潮降温 · 收缩仓位控回撤',
    maxPositionPct: 30,
    colorTone: 'amber',
    boundCards: ['067', '181'],
    actionNote: '情绪处于退潮降温通道，停止接力中位股，保留现金等待新一轮冰点或主线切换确认。',
  },
  连续降温: {
    channel: 'forbidden_new',
    channelLabel: '连续退潮 · 防守为主等冰点',
    maxPositionPct: 20,
    colorTone: 'crimson',
    boundCards: ['067', '181'],
    actionNote: '亏钱效应持续外溢，严守防守红线，绝不逆势补仓亏损筹码，耐心等待情绪彻底出清至冰点。',
  },
};

function deriveMarketNodeState(sentiment, prevEntry = null) {
  const score = Number(sentiment?.sentimentScore ?? 50);
  const red = Number(sentiment?.redRatePct ?? 50);
  const burst = Number(sentiment?.burstRatePct ?? 20);
  const dt = Number(sentiment?.dtCount ?? 0);
  const prevNode = prevEntry?.node || null;
  const prevScore = Number.isFinite(Number(prevEntry?.sentimentScore)) ? Number(prevEntry.sentimentScore) : null;
  const delta = prevScore != null ? round2(score - prevScore) : 0;

  let node = '升温';
  const isIce = score <= 30 || red <= 22 || dt >= 28;
  const isClimax = score >= 76 || red >= 80;
  const isCooling = delta <= -8 || burst >= 38 || (score < 48 && delta < 0);

  if (isIce) {
    node = prevNode === '冰点' || prevNode === '连续冰点' ? '连续冰点' : '冰点';
  } else if (isClimax) {
    node = prevNode === '高潮' || prevNode === '连续高潮' ? '连续高潮' : '高潮';
  } else if ((prevNode === '冰点' || prevNode === '连续冰点') && score > 30) {
    node = '冰点回暖';
  } else if ((prevNode === '高潮' || prevNode === '连续高潮') && score < 76) {
    node = '高潮降温';
  } else if (isCooling || score < 46) {
    node = prevNode === '降温' || prevNode === '连续降温' || prevNode === '高潮降温' ? '连续降温' : '降温';
  } else if (prevNode === '升温' || prevNode === '连续升温' || prevNode === '冰点回暖') {
    node = delta >= -3 ? '连续升温' : '降温';
  } else {
    node = score >= 52 ? '升温' : '降温';
  }

  const meta = MARKET_NODE_CHANNELS[node] || MARKET_NODE_CHANNELS['升温'];
  return {
    node,
    prevNode,
    scoreDelta: delta,
    ...meta,
  };
}

function loadSentimentChain() {
  try {
    if (fs.existsSync(SENTIMENT_CHAIN_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SENTIMENT_CHAIN_PATH, 'utf8'));
      if (Array.isArray(raw.history)) {
        return { history: raw.history, updatedAt: raw.updatedAt || null };
      }
    }
  } catch {
    // fallback
  }
  return { history: [], updatedAt: null };
}

function recordSentimentNodeSnapshot(sentiment, dateOverride = null) {
  const chain = loadSentimentChain();
  const today = dateOverride || new Date().toISOString().slice(0, 10);
  const existingIdx = chain.history.findIndex((h) => h.date === today);
  const prevEntry =
    existingIdx > 0
      ? chain.history[existingIdx - 1]
      : existingIdx === -1 && chain.history.length > 0
      ? chain.history[chain.history.length - 1]
      : null;

  const derived = deriveMarketNodeState(sentiment, prevEntry);
  const entry = {
    date: today,
    recordedAt: nowOffsetISO(),
    sentimentScore: sentiment.sentimentScore,
    redRatePct: sentiment.redRatePct,
    ztCount: sentiment.ztCount,
    dtCount: sentiment.dtCount,
    burstRatePct: sentiment.burstRatePct,
    maxBoard: sentiment.maxBoard,
    twoMarketAmtYi: sentiment.twoMarketAmtYi,
    node: derived.node,
    prevNode: derived.prevNode,
    scoreDelta: derived.scoreDelta,
    channel: derived.channel,
    channelLabel: derived.channelLabel,
    maxPositionPct: derived.maxPositionPct,
    colorTone: derived.colorTone,
    boundCards: derived.boundCards,
    actionNote: derived.actionNote,
  };

  if (existingIdx >= 0) {
    chain.history[existingIdx] = entry;
  } else {
    chain.history.push(entry);
  }
  chain.history.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = chain.history.slice(-60);
  const payload = { updatedAt: nowOffsetISO(), history: trimmed };
  try {
    fs.writeFileSync(SENTIMENT_CHAIN_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch {
    // non-fatal
  }
  return { current: entry, history: trimmed, updatedAt: payload.updatedAt };
}

function loadAlertRules() {
  if (!fs.existsSync(RULES_PATH)) {
    return { rules: DEFAULT_ALERT_RULES, updatedAt: null, isDefault: true };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    const rules = Array.isArray(raw.rules) ? raw.rules.map(sanitizeRule).filter(Boolean) : DEFAULT_ALERT_RULES;
    return { rules, updatedAt: raw.updatedAt || null, isDefault: false };
  } catch {
    return { rules: DEFAULT_ALERT_RULES, updatedAt: null, isDefault: true };
  }
}

function saveAlertRules(rulesList) {
  const seen = new Set();
  const cleaned = [];
  for (let i = 0; i < (rulesList || []).length; i++) {
    const r = sanitizeRule(rulesList[i], i);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    cleaned.push(r);
  }
  const payload = { rules: cleaned, updatedAt: nowOffsetISO() };
  fs.writeFileSync(RULES_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { ...payload, isDefault: false };
}

function resetAlertRules() {
  const payload = { rules: DEFAULT_ALERT_RULES, updatedAt: nowOffsetISO() };
  fs.writeFileSync(RULES_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { ...payload, isDefault: true };
}

function evaluateCondition(val, operator, threshold) {
  if (val == null || !Number.isFinite(Number(val))) return false;
  const v = Number(val);
  const t = Number(threshold);
  if (operator === '>=') return v >= t;
  if (operator === '<=') return v <= t;
  if (operator === '>') return v > t;
  if (operator === '<') return v < t;
  if (operator === '==') return Math.abs(v - t) < 1e-6;
  return false;
}

// ============================================================================
// 2. 经典技术指标计算器（MA/MACD/RSI/BOLL/ATR/2B/威科夫/缠论背驰）
// ============================================================================

function computeEMA(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function computeRSI(closes, period = 14) {
  if (closes.length <= period) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return round2(100 - 100 / (1 + rs));
}

function computeATR(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high;
    const l = klines[i].low;
    const pc = klines[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  return round2(avg(recent));
}

function computeIndicatorsFromKlines(klines, liveQuote = null) {
  if (!klines || klines.length < 5) return null;

  // 若盘中实时价存在且不同于最后一日收盘，用实时价更新末根K线视图
  const bars = klines.map((k) => ({ ...k }));
  const last = bars[bars.length - 1];
  if (liveQuote && liveQuote.price != null) {
    last.close = liveQuote.price;
    if (liveQuote.high != null && liveQuote.high > last.high) last.high = liveQuote.high;
    if (liveQuote.low != null && liveQuote.low < last.low) last.low = liveQuote.low;
  }

  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.vol || 0);
  const price = closes[closes.length - 1];
  const prevBar = bars.length >= 2 ? bars[bars.length - 2] : last;
  const preClose = liveQuote?.preClose ?? prevBar.close;

  const ma5 = closes.length >= 5 ? round2(avg(closes.slice(-5))) : null;
  const ma10 = closes.length >= 10 ? round2(avg(closes.slice(-10))) : null;
  const ma20 = closes.length >= 20 ? round2(avg(closes.slice(-20))) : null;
  const ma60 = closes.length >= 60 ? round2(avg(closes.slice(-60))) : closes.length >= 30 ? round2(avg(closes)) : null;

  const ma5BiasPct = ma5 ? round2(((price - ma5) / ma5) * 100) : null;
  const ma20BiasPct = ma20 ? round2(((price - ma20) / ma20) * 100) : null;
  const ma60BiasPct = ma60 ? round2(((price - ma60) / ma60) * 100) : null;

  // MACD (12, 26, 9)
  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);
  const difSeries = ema12.map((v, i) => v - ema26[i]);
  const deaSeries = computeEMA(difSeries, 9);
  const histSeries = difSeries.map((v, i) => (v - deaSeries[i]) * 2);

  const macdDif = round3(difSeries[difSeries.length - 1]);
  const macdDea = round3(deaSeries[deaSeries.length - 1]);
  const macdHist = round3(histSeries[histSeries.length - 1]);

  // 缠论/卡片055 MACD 顶背驰检测：近5日高点 >= 前20日高点，但近5日最高DIF或红柱明显低于前段波峰
  let macdTopDivergence = 0;
  if (bars.length >= 25) {
    const recent5 = bars.slice(-5);
    const prior20 = bars.slice(-25, -5);
    const recentHigh = Math.max(...recent5.map((b) => b.high));
    const priorHigh = Math.max(...prior20.map((b) => b.high));
    const recentMaxDif = Math.max(...difSeries.slice(-5));
    const priorMaxDif = Math.max(...difSeries.slice(-25, -5));
    const recentMaxHist = Math.max(...histSeries.slice(-5));
    const priorMaxHist = Math.max(...histSeries.slice(-25, -5));
    if (
      recentHigh >= priorHigh * 0.992 &&
      priorMaxDif > 0 &&
      (recentMaxDif < priorMaxDif * 0.88 || (priorMaxHist > 0 && recentMaxHist < priorMaxHist * 0.72))
    ) {
      macdTopDivergence = 1;
    }
  }

  // RSI(6) & RSI(14)
  const rsi6 = computeRSI(closes, 6);
  const rsi14 = computeRSI(closes, 14);

  // 布林带 BOLL(20, 2)
  const slice20 = closes.slice(-20);
  const bollMid = slice20.length >= 20 ? round2(avg(slice20)) : ma20;
  const sd20 = slice20.length >= 20 ? stdDev(slice20) : 0;
  const bollUpper = bollMid != null ? round2(bollMid + 2 * sd20) : null;
  const bollLower = bollMid != null ? round2(bollMid - 2 * sd20) : null;
  const bollPosPct =
    bollUpper != null && bollLower != null && bollUpper > bollLower
      ? round2(((price - bollLower) / (bollUpper - bollLower)) * 100)
      : null;

  // ATR(14)
  const atr14 = computeATR(bars, 14);
  const atrPct = atr14 && price ? round2((atr14 / price) * 100) : null;

  // 成交量倍数 & 上影线 & 威科夫放量滞涨 & 2B 假突破见顶
  const prev5Vols = vols.slice(-6, -1).filter((v) => v > 0);
  const avgVol5d = prev5Vols.length ? avg(prev5Vols) : null;
  const curVol = liveQuote?.volume || last.vol || 0;
  const volRatio5d = avgVol5d && curVol > 0 ? round2(curVol / avgVol5d) : null;

  const bodyTop = Math.max(last.open, last.close);
  const upperShadowPct = preClose ? round2(((last.high - bodyTop) / preClose) * 100) : 0;
  const lowerShadowPct = preClose ? round2(((Math.min(last.open, last.close) - last.low) / preClose) * 100) : 0;
  const dayPct = liveQuote?.pct ?? (preClose ? round2(((price - preClose) / preClose) * 100) : 0);

  // 2B 假突破见顶（卡片061）：突破前20日高点但收盘跌回前高下方
  const prior20High = bars.length >= 21 ? Math.max(...bars.slice(-21, -1).map((b) => b.high)) : null;
  const is2BTopSignal =
    prior20High != null && last.high > prior20High * 1.003 && price < prior20High ? 1 : 0;

  // 威科夫高位放量滞涨（卡片054/196）：处于近20日高位区（距高点<8%），放量>=1.8倍且滞涨或长上影>=3%
  const high20 = Math.max(...bars.slice(-20).map((b) => b.high));
  const near20High = high20 > 0 && price >= high20 * 0.92;
  const isHighVolStall =
    near20High &&
    ((volRatio5d != null && volRatio5d >= 1.8 && dayPct < 1.5) ||
      (volRatio5d != null && volRatio5d >= 1.5 && upperShadowPct >= 3.2))
      ? 1
      : 0;

  const ret5dPct =
    closes.length >= 6 && closes[closes.length - 6] > 0
      ? round2(((price - closes[closes.length - 6]) / closes[closes.length - 6]) * 100)
      : null;
  const ret20dPct =
    closes.length >= 21 && closes[closes.length - 21] > 0
      ? round2(((price - closes[closes.length - 21]) / closes[closes.length - 21]) * 100)
      : null;

  // 连涨天数
  let consecutiveUpDays = 0;
  for (let i = closes.length - 1; i >= 1; i--) {
    if (closes[i] > closes[i - 1]) consecutiveUpDays++;
    else break;
  }

  return {
    price: round2(price),
    preClose: round2(preClose),
    pct: round2(dayPct),
    turnoverPct: liveQuote?.turnoverPct ?? last.turnoverPct ?? null,
    ma5,
    ma10,
    ma20,
    ma60,
    ma5BiasPct,
    ma20BiasPct,
    ma60BiasPct,
    macdDif,
    macdDea,
    macdHist,
    macdTopDivergence,
    rsi6,
    rsi14,
    bollUpper,
    bollMid,
    bollLower,
    bollPosPct,
    atr14,
    atrPct,
    volRatio5d,
    upperShadowPct,
    lowerShadowPct,
    is2BTopSignal,
    isHighVolStall,
    ret5dPct,
    ret20dPct,
    consecutiveUpDays,
    high20d: round2(high20),
    low20d: round2(Math.min(...bars.slice(-20).map((b) => b.low))),
    high60d: round2(Math.max(...bars.map((b) => b.high))),
    low60d: round2(Math.min(...bars.map((b) => b.low))),
    trendRegime:
      ma5 && ma10 && ma20 && price > ma5 && ma5 > ma10 && ma10 > ma20
        ? '多头排列主升'
        : ma20 && price < ma20 && ma5 && ma5 < ma20
        ? '空头排列弱势'
        : ma20 && price >= ma20
        ? '均线之上震荡'
        : '生命线下方修复',
  };
}

// ============================================================================
// 2.5 三大权威趋势线流派算法引擎（维克多 1-2-3 · 德马克 TD 线 · 线性回归 ±2σ 通道）
// ============================================================================

function projectLine(x1, y1, x2, y2, x) {
  if (x2 === x1) return y2;
  return y1 + ((y2 - y1) / (x2 - x1)) * (x - x1);
}

/**
 * 在最近分析窗口（默认最新 90 根 K 线，避免 2 年前噪音干扰当前波段）计算三大客观趋势线流派：
 * 1. 维克多·斯波朗迪严格切线（卡片061）：连接绝对极值与极值前最近有效转折点，数学保证不穿透区间内任何一根K线；
 * 2. 汤姆·德马克 TD 供给/需求线：从右向左锚定最新两个有效分形高点/低点，彻底消除画线主观性，并给突破测算目标位；
 * 3. 线性回归标准差通道（OLS ±2σ）：计算客观趋势斜率、拟合优度 R²、上下轨道及通道当前百分比位置，同时识别收敛楔形。
 */
function computeTrendlines(allBars, windowLen = 90) {
  const totalLen = allBars.length;
  if (totalLen < 12) {
    return {
      windowStartIdx: 0,
      victor: { downLine: null, upLine: null },
      demark: { supplyLine: null, demandLine: null },
      regressionChannel: null,
      patternLabel: '数据不足',
      signals: {
        vicUpBreakdown: 0,
        vicDownBreakout: 0,
        tdDemandBreakdown: 0,
        tdSupplyBreakout: 0,
        regChannelPosPct: null,
      },
      summaryLines: [],
    };
  }

  const startOffset = Math.max(0, totalLen - windowLen);
  const bars = allBars.slice(startOffset);
  const n = bars.length;
  const lastIdx = n - 1;
  const lastBar = bars[lastIdx];
  const lastPrice = lastBar.close;

  // --------------------------------------------------------------------------
  // 流派 1：维克多·斯波朗迪严格趋势线（Victor Sperandeo — 卡片 061）
  // 使用「最右侧有效凸包切线」：从极值出发向右构建绝不穿透任何中间 K 线的上/下凸包，
  // 取最贴近当前波段的活跃主切线（避免高位横盘肩部拉出过平的陈旧虚线！）
  // --------------------------------------------------------------------------
  let maxHighIdx = 0;
  let minLowIdx = 0;
  for (let i = 1; i < n; i++) {
    if (bars[i].high > bars[maxHighIdx].high) maxHighIdx = i;
    if (bars[i].low < bars[minLowIdx].low) minLowIdx = i;
  }

  // 1a. 维克多下降压制趋势线（上凸包向右递进，保证两点间零穿透）
  let vicDownLine = null;
  if (maxHighIdx <= n - 6) {
    let troughAfterPeak = maxHighIdx + 1;
    for (let i = maxHighIdx + 1; i < n; i++) {
      if (bars[i].low < bars[troughAfterPeak].low) troughAfterPeak = i;
    }
    const hullEnd = troughAfterPeak - maxHighIdx >= 5 ? troughAfterPeak - 1 : n - 2;
    const upperHull = [maxHighIdx];
    let cur = maxHighIdx;
    while (cur < hullEnd - 2) {
      let bestJ = -1;
      let bestSlope = -Infinity;
      for (let j = cur + 1; j <= hullEnd; j++) {
        const slope = (bars[j].high - bars[cur].high) / (j - cur);
        if (slope > bestSlope) {
          bestSlope = slope;
          bestJ = j;
        }
      }
      if (bestJ <= cur) break;
      upperHull.push(bestJ);
      cur = bestJ;
    }

    // 在上凸包边中，找最右侧且满足向下倾斜、跨度>=4根、当前投影价合理的活跃压制边
    for (let e = upperHull.length - 1; e >= 1; e--) {
      const a = upperHull[e - 1];
      const b = upperHull[e];
      if (b - a < 4) continue;
      const slope = (bars[b].high - bars[a].high) / (b - a);
      if (slope >= 0) continue;
      const currentVal = round2(projectLine(a, bars[a].high, b, bars[b].high, lastIdx));
      if (currentVal == null || currentVal <= 0 || currentVal > lastPrice * 1.65 || currentVal < lastPrice * 0.55) continue;
      const distPct = round2(((lastPrice - currentVal) / currentVal) * 100);
      const broken = lastPrice > currentVal * 1.008 && lastIdx - b >= 2;
      vicDownLine = {
        school: 'victor',
        kind: 'resistance',
        label: '维克多下降压制线 (1-2-3)',
        cardId: '061',
        x1: startOffset + a,
        y1: round2(bars[a].high),
        date1: bars[a].date,
        x2: startOffset + b,
        y2: round2(bars[b].high),
        date2: bars[b].date,
        endX: startOffset + lastIdx,
        currentPrice: currentVal,
        distPct,
        slopePerBar: round3(slope),
        status: broken ? '向上突破 (1-2-3第一步)' : distPct >= -3.0 ? '逼近压制线' : '线下承压运行',
        broken,
      };
      break;
    }
  }

  // 1b. 维克多上升支撑趋势线（下凸包向右递进，保证两点间零穿透）
  let vicUpLine = null;
  if (minLowIdx <= n - 6) {
    let peakAfterTrough = minLowIdx + 1;
    for (let i = minLowIdx + 1; i < n; i++) {
      if (bars[i].high > bars[peakAfterTrough].high) peakAfterTrough = i;
    }
    const hullEnd = peakAfterTrough - minLowIdx >= 5 ? peakAfterTrough - 1 : n - 2;
    const lowerHull = [minLowIdx];
    let cur = minLowIdx;
    while (cur < hullEnd - 2) {
      let bestJ = -1;
      let bestSlope = Infinity;
      for (let j = cur + 1; j <= hullEnd; j++) {
        const slope = (bars[j].low - bars[cur].low) / (j - cur);
        if (slope < bestSlope) {
          bestSlope = slope;
          bestJ = j;
        }
      }
      if (bestJ <= cur) break;
      lowerHull.push(bestJ);
      cur = bestJ;
    }

    for (let e = lowerHull.length - 1; e >= 1; e--) {
      const a = lowerHull[e - 1];
      const b = lowerHull[e];
      if (b - a < 4) continue;
      const slope = (bars[b].low - bars[a].low) / (b - a);
      if (slope <= 0) continue;
      const currentVal = round2(projectLine(a, bars[a].low, b, bars[b].low, lastIdx));
      if (currentVal == null || currentVal <= 0 || currentVal > lastPrice * 1.45 || currentVal < lastPrice * 0.5) continue;
      const distPct = round2(((lastPrice - currentVal) / currentVal) * 100);
      const broken = lastPrice < currentVal * 0.992 && lastIdx - b >= 2;
      vicUpLine = {
        school: 'victor',
        kind: 'support',
        label: '维克多上升支撑线 (1-2-3)',
        cardId: '061',
        x1: startOffset + a,
        y1: round2(bars[a].low),
        date1: bars[a].date,
        x2: startOffset + b,
        y2: round2(bars[b].low),
        date2: bars[b].date,
        endX: startOffset + lastIdx,
        currentPrice: currentVal,
        distPct,
        slopePerBar: round3(slope),
        status: broken ? '向下跌破 (反转警报!)' : distPct <= 3.0 ? '回踩支撑线' : '线上多头运行',
        broken,
      };
      break;
    }
  }

  // --------------------------------------------------------------------------
  // 流派 2：汤姆·德马克 TD 供给/需求线（Tom DeMark Right-to-Left Objective Pivots）
  // --------------------------------------------------------------------------
  const kWing = n >= 45 ? 3 : 2;
  const supplyPivots = [];
  const demandPivots = [];
  for (let i = kWing; i < n - kWing; i++) {
    let isHigh = true;
    let isLow = true;
    for (let d = 1; d <= kWing; d++) {
      if (bars[i].high < bars[i - d].high || bars[i].high <= bars[i + d].high) isHigh = false;
      if (bars[i].low > bars[i - d].low || bars[i].low >= bars[i + d].low) isLow = false;
    }
    if (isHigh) supplyPivots.push(i);
    if (isLow) demandPivots.push(i);
  }

  // TD Supply Line (下行压力线)：取最右侧供给点 P2，向左找第一个更高的供给点 P1
  let tdSupplyLine = null;
  if (supplyPivots.length >= 2) {
    for (let r = supplyPivots.length - 1; r >= 1 && !tdSupplyLine; r--) {
      const p2 = supplyPivots[r];
      for (let l = r - 1; l >= 0; l--) {
        const p1 = supplyPivots[l];
        if (bars[p1].high > bars[p2].high && p2 - p1 >= 3) {
          const currentVal = round2(projectLine(p1, bars[p1].high, p2, bars[p2].high, lastIdx));
          if (currentVal != null && currentVal > 0 && Math.abs((currentVal - lastPrice) / lastPrice) <= 0.65) {
            const distPct = round2(((lastPrice - currentVal) / currentVal) * 100);
            const broken = lastPrice > currentVal * 1.005;
            // DeMark 突破目标测算：连线下方最低点到该日连线的垂直距离，向上投射
            let maxVert = 0;
            for (let m = p1; m <= p2; m++) {
              const lineAtM = projectLine(p1, bars[p1].high, p2, bars[p2].high, m);
              const gap = lineAtM - bars[m].low;
              if (gap > maxVert) maxVert = gap;
            }
            tdSupplyLine = {
              school: 'demark',
              kind: 'resistance',
              label: '德马克 TD 供给压力线',
              cardId: '052',
              x1: startOffset + p1,
              y1: round2(bars[p1].high),
              date1: bars[p1].date,
              x2: startOffset + p2,
              y2: round2(bars[p2].high),
              date2: bars[p2].date,
              endX: startOffset + lastIdx,
              currentPrice: currentVal,
              distPct,
              targetPrice: round2(currentVal + maxVert * 0.618),
              slopePerBar: round3((bars[p2].high - bars[p1].high) / (p2 - p1)),
              status: broken ? '突破 TD 供给线' : distPct >= -2.5 ? '贴近 TD 压力' : '供给线压制中',
              broken,
            };
          }
          break;
        }
      }
    }
  }

  // TD Demand Line (上行支撑线)：取最右侧需求点 Q2，向左找第一个更低的需求点 Q1
  let tdDemandLine = null;
  if (demandPivots.length >= 2) {
    for (let r = demandPivots.length - 1; r >= 1 && !tdDemandLine; r--) {
      const q2 = demandPivots[r];
      for (let l = r - 1; l >= 0; l--) {
        const q1 = demandPivots[l];
        if (bars[q1].low < bars[q2].low && q2 - q1 >= 3) {
          const currentVal = round2(projectLine(q1, bars[q1].low, q2, bars[q2].low, lastIdx));
          if (currentVal != null && currentVal > 0 && Math.abs((currentVal - lastPrice) / lastPrice) <= 0.65) {
            const distPct = round2(((lastPrice - currentVal) / currentVal) * 100);
            const broken = lastPrice < currentVal * 0.995;
            let maxVert = 0;
            for (let m = q1; m <= q2; m++) {
              const lineAtM = projectLine(q1, bars[q1].low, q2, bars[q2].low, m);
              const gap = bars[m].high - lineAtM;
              if (gap > maxVert) maxVert = gap;
            }
            tdDemandLine = {
              school: 'demark',
              kind: 'support',
              label: '德马克 TD 需求支撑线',
              cardId: '052',
              x1: startOffset + q1,
              y1: round2(bars[q1].low),
              date1: bars[q1].date,
              x2: startOffset + q2,
              y2: round2(bars[q2].low),
              date2: bars[q2].date,
              endX: startOffset + lastIdx,
              currentPrice: currentVal,
              distPct,
              targetPrice: round2(Math.max(0.01, currentVal - maxVert * 0.618)),
              slopePerBar: round3((bars[q2].low - bars[q1].low) / (q2 - q1)),
              status: broken ? '跌破 TD 需求线!' : distPct <= 2.5 ? '回踩 TD 支撑' : '需求线支撑有效',
              broken,
            };
          }
          break;
        }
      }
    }
  }

  // 若处于单边下跌且无上行 TD 需求线，补算一条下行下轨连接（对应用户示意图的下降通道下轨！）
  let tdLowerChannel = null;
  if (!tdDemandLine && demandPivots.length >= 2) {
    const q2 = demandPivots[demandPivots.length - 1];
    for (let l = demandPivots.length - 2; l >= 0; l--) {
      const q1 = demandPivots[l];
      if (bars[q1].low > bars[q2].low && q2 - q1 >= 4) {
        const currentVal = round2(projectLine(q1, bars[q1].low, q2, bars[q2].low, lastIdx));
        if (currentVal != null && currentVal > 0 && Math.abs((currentVal - lastPrice) / lastPrice) <= 0.65) {
          const distPct = round2(((lastPrice - currentVal) / currentVal) * 100);
          tdLowerChannel = {
            school: 'demark',
            kind: 'support',
            label: '下降通道下轨支撑线',
            cardId: '065',
            x1: startOffset + q1,
            y1: round2(bars[q1].low),
            date1: bars[q1].date,
            x2: startOffset + q2,
            y2: round2(bars[q2].low),
            date2: bars[q2].date,
            endX: startOffset + lastIdx,
            currentPrice: currentVal,
            distPct,
            targetPrice: null,
            slopePerBar: round3((bars[q2].low - bars[q1].low) / (q2 - q1)),
            status: lastPrice < currentVal ? '跌穿通道下轨(加速)' : distPct <= 3 ? '逼近通道下轨(超卖)' : '通道下轨上方',
            broken: lastPrice < currentVal * 0.99,
          };
        }
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // 流派 3：线性回归标准差通道（OLS Linear Regression Channel ±2σ — 卡片 065）
  // --------------------------------------------------------------------------
  const regLen = Math.min(n, 60);
  const regOffset = n - regLen;
  const regBars = bars.slice(regOffset);
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < regLen; i++) {
    const y = regBars[i].close;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumXX += i * i;
  }
  const denom = regLen * sumXX - sumX * sumX || 1;
  const slope = (regLen * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / regLen;
  const meanY = sumY / regLen;

  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < regLen; i++) {
    const pred = intercept + slope * i;
    const diff = regBars[i].close - pred;
    ssRes += diff * diff;
    ssTot += (regBars[i].close - meanY) ** 2;
  }
  const sigma = Math.sqrt(ssRes / regLen);
  const rSquared = ssTot > 0 ? round2(1 - ssRes / ssTot) : 0;
  const widthSigma = 2.0;

  const startMid = intercept;
  const endMid = intercept + slope * (regLen - 1);
  const upperNow = round2(endMid + widthSigma * sigma);
  const lowerNow = round2(Math.max(0.01, endMid - widthSigma * sigma));
  const midNow = round2(endMid);
  const regChannelPosPct =
    upperNow > lowerNow ? round2(((lastPrice - lowerNow) / (upperNow - lowerNow)) * 100) : 50;
  const slopePctTotal = startMid > 0 ? round2(((endMid - startMid) / startMid) * 100) : 0;

  const regressionChannel = {
    school: 'regression',
    cardId: '065',
    startX: startOffset + regOffset,
    endX: startOffset + lastIdx,
    startDate: regBars[0].date,
    endDate: regBars[regLen - 1].date,
    startMid: round2(startMid),
    endMid: midNow,
    startUpper: round2(startMid + widthSigma * sigma),
    endUpper: upperNow,
    startLower: round2(Math.max(0.01, startMid - widthSigma * sigma)),
    endLower: lowerNow,
    sigma: round2(sigma),
    rSquared,
    slopePctTotal,
    posPct: regChannelPosPct,
    direction: slopePctTotal >= 5 ? '上行回归通道' : slopePctTotal <= -5 ? '下行回归通道' : '水平震荡箱体',
    zoneLabel:
      regChannelPosPct >= 96
        ? '通道上轨超买警戒区 (+2σ)'
        : regChannelPosPct >= 75
        ? '通道偏强上沿区'
        : regChannelPosPct <= 4
        ? '通道下轨超卖支撑区 (-2σ)'
        : regChannelPosPct <= 25
        ? '通道偏弱下沿区'
        : '通道中轴均衡区',
  };

  // 形态综合判定（严谨区分下降通道 / 下降楔形 / 对称收敛三角 / 上升通道）
  let patternLabel = regressionChannel.direction;
  const upperLine = vicDownLine || tdSupplyLine;
  const lowerLine = tdDemandLine || tdLowerChannel || vicUpLine;
  if (upperLine && lowerLine && upperLine.currentPrice && lowerLine.currentPrice && upperLine.currentPrice > lowerLine.currentPrice * 0.96) {
    if (upperLine.slopePerBar < 0 && lowerLine.slopePerBar > 0 && !upperLine.broken && !lowerLine.broken) {
      patternLabel = '对称收敛三角形（变盘临界）';
    } else if (upperLine.slopePerBar < 0 && lowerLine.slopePerBar < 0) {
      patternLabel =
        upperLine.slopePerBar < lowerLine.slopePerBar * 1.15
          ? '下降楔形收敛（关注上轨突破）'
          : '标准下降通道（上压下撑）';
    } else if (upperLine.slopePerBar > 0 && lowerLine.slopePerBar > 0) {
      patternLabel = '上升通道运行';
    }
  } else if (vicDownLine?.broken) {
    patternLabel = '突破下降压制线（1-2-3 反转观察）';
  } else if (vicUpLine?.broken) {
    patternLabel = '跌破上升趋势线（见顶破位警报）';
  }

  const signals = {
    vicUpBreakdown: vicUpLine?.broken ? 1 : 0,
    vicDownBreakout: vicDownLine?.broken ? 1 : 0,
    tdDemandBreakdown: tdDemandLine?.broken ? 1 : 0,
    tdSupplyBreakout: tdSupplyLine?.broken ? 1 : 0,
    regChannelPosPct,
  };

  return {
    windowStartIdx: startOffset,
    victor: { downLine: vicDownLine, upLine: vicUpLine },
    demark: { supplyLine: tdSupplyLine, demandLine: tdDemandLine, lowerChannel: tdLowerChannel },
    regressionChannel,
    patternLabel,
    signals,
  };
}

function computeVolumeProfile(bars, bucketCount = 24) {
  const minP = Math.min(...bars.map((b) => b.low));
  const maxP = Math.max(...bars.map((b) => b.high));
  if (!Number.isFinite(minP) || !Number.isFinite(maxP) || maxP <= minP) {
    return { bins: [], poc: null, vah: null, val: null };
  }
  const step = (maxP - minP) / bucketCount;
  const bins = Array.from({ length: bucketCount }, (_, i) => ({
    priceLow: round2(minP + i * step),
    priceHigh: round2(minP + (i + 1) * step),
    priceMid: round2(minP + (i + 0.5) * step),
    volume: 0,
  }));

  let totalVol = 0;
  for (const b of bars) {
    const v = Number(b.vol) || 1;
    const typical = (b.high + b.low + b.close * 2) / 4;
    const lowIdx = Math.max(0, Math.min(bucketCount - 1, Math.floor((b.low - minP) / step)));
    const highIdx = Math.max(0, Math.min(bucketCount - 1, Math.floor((b.high - minP) / step)));
    const typIdx = Math.max(0, Math.min(bucketCount - 1, Math.floor((typical - minP) / step)));
    // 60% 权重给典型成交价，40% 均分在当日高低区间
    bins[typIdx].volume += v * 0.6;
    const spanBins = highIdx - lowIdx + 1;
    for (let i = lowIdx; i <= highIdx; i++) {
      bins[i].volume += (v * 0.4) / spanBins;
    }
    totalVol += v;
  }

  let pocIdx = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].volume > bins[pocIdx].volume) pocIdx = i;
  }

  // 70% 价值区（VAH / VAL）
  let accVol = bins[pocIdx].volume;
  let lo = pocIdx;
  let hi = pocIdx;
  const targetVol = totalVol * 0.7;
  while (accVol < targetVol && (lo > 0 || hi < bins.length - 1)) {
    const leftVol = lo > 0 ? bins[lo - 1].volume : -1;
    const rightVol = hi < bins.length - 1 ? bins[hi + 1].volume : -1;
    if (rightVol >= leftVol) {
      hi++;
      accVol += bins[hi].volume;
    } else {
      lo--;
      accVol += bins[lo].volume;
    }
  }

  const maxBinVol = Math.max(...bins.map((b) => b.volume), 1);
  return {
    bins: bins.map((b) => ({
      ...b,
      volume: Math.round(b.volume),
      pctOfMax: round2((b.volume / maxBinVol) * 100),
    })),
    poc: bins[pocIdx].priceMid,
    vah: bins[hi].priceHigh,
    val: bins[lo].priceLow,
  };
}

function generateSupportResistance(bars, indicators, currencySymbol = '¥') {
  const price = indicators.price;
  const rawLevels = [];

  const pushLevel = (levelPrice, label, school, cardId, weight = 1) => {
    if (levelPrice == null || !Number.isFinite(levelPrice) || levelPrice <= 0) return;
    const distPct = round2(((levelPrice - price) / price) * 100);
    // 过滤离现价超过 ±45% 的极远点位
    if (Math.abs(distPct) > 45) return;
    rawLevels.push({
      price: round2(levelPrice),
      label,
      school,
      cardId,
      weight,
      distPct,
    });
  };

  // ① 筹码峰 Volume Profile（卡片056）：全60日分布 + 近30日活跃交投筹码峰（避免深跌股远古套牢峰失真）
  const vp60 = computeVolumeProfile(bars, 24);
  const vp30 = computeVolumeProfile(bars.slice(-30), 20);
  const pocFar = vp60.poc != null && Math.abs((vp60.poc - price) / price) > 0.32;
  const vp = pocFar && vp30.poc != null ? { ...vp60, poc: vp30.poc, vah: vp30.vah, val: vp30.val, pocScope: '30日' } : { ...vp60, pocScope: '60日' };
  if (vp.poc) pushLevel(vp.poc, `近${vp.pocScope}筹码密集峰 POC`, '筹码峰', '056', 2.2);
  if (vp.vah) pushLevel(vp.vah, `筹码价值区上沿 VAH`, '筹码峰', '056', 1.4);
  if (vp.val) pushLevel(vp.val, `筹码价值区下沿 VAL`, '筹码峰', '056', 1.4);

  // ② 均线防线 & 布林上下轨（框架增订④ / 卡片053）
  pushLevel(indicators.ma5, 'MA5 短期趋势线', '均线系统', '178', 1.3);
  pushLevel(indicators.ma10, 'MA10 强弱缓冲线', '均线系统', '053', 1.1);
  pushLevel(indicators.ma20, 'MA20 波段生命线', '均线系统', '053', 2.0);
  pushLevel(indicators.ma60, 'MA60 季线牛熊锚', '均线系统', '053', 1.8);
  pushLevel(indicators.bollUpper, 'BOLL(20) 上轨压制', '布林通道', '065', 1.2);
  pushLevel(indicators.bollLower, 'BOLL(20) 下轨支撑', '布林通道', '065', 1.2);

  // ③ 经典波段高低点 & 唐奇安通道（卡片052/053/063）
  pushLevel(indicators.high20d, '20日唐奇安前高', '形态颈线', '063', 2.0);
  pushLevel(indicators.low20d, '20日唐奇安前低', '形态颈线', '063', 1.8);
  if (indicators.high60d && Math.abs(indicators.high60d - indicators.high20d) / price > 0.015) {
    pushLevel(indicators.high60d, '60日波段大前高', '形态颈线', '052', 2.2);
  }
  if (indicators.low60d && Math.abs(indicators.low60d - indicators.low20d) / price > 0.015) {
    pushLevel(indicators.low60d, '60日波段大前低', '形态颈线', '052', 1.8);
  }

  // 分形波段枢轴高低点（左右各2根确认）
  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    if (h >= bars[i - 1].high && h >= bars[i - 2].high && h >= bars[i + 1].high && h >= bars[i + 2].high) {
      swingHighs.push({ price: h, date: bars[i].date });
    }
    if (l <= bars[i - 1].low && l <= bars[i - 2].low && l <= bars[i + 1].low && l <= bars[i + 2].low) {
      swingLows.push({ price: l, date: bars[i].date });
    }
  }
  for (const sh of swingHighs.slice(-3)) {
    pushLevel(sh.price, `波段高点 (${sh.date.slice(5)})`, '形态颈线', '053', 1.4);
  }
  for (const sl of swingLows.slice(-3)) {
    pushLevel(sl.price, `波段低点 (${sl.date.slice(5)})`, '形态颈线', '053', 1.4);
  }

  // ④ 斐波那契黄金分割回撤与扩展（卡片057 / 111）
  const range60 = (indicators.high60d || 0) - (indicators.low60d || 0);
  if (range60 > 0) {
    pushLevel(indicators.high60d - range60 * 0.382, '斐波那契 0.382 回撤位', '斐波那契', '057', 1.3);
    pushLevel(indicators.high60d - range60 * 0.5, '斐波那契 0.500 中轴位', '斐波那契', '057', 1.4);
    pushLevel(indicators.high60d - range60 * 0.618, '斐波那契 0.618 黄金位', '斐波那契', '057', 1.6);
    if (price > indicators.high60d * 0.94) {
      pushLevel(indicators.low60d + range60 * 1.272, '斐波那契 1.272 扩展目标', '斐波那契', '057', 1.3);
    }
  }

  // ⑤ 经典 Pivot 枢轴点（上一交易日 H/L/C）
  const prev = bars.length >= 2 ? bars[bars.length - 2] : bars[0];
  const pivot = (prev.high + prev.low + prev.close) / 3;
  const r1Pivot = 2 * pivot - prev.low;
  const s1Pivot = 2 * pivot - prev.high;
  pushLevel(pivot, '经典枢轴中轴 P', '枢轴点', '060', 1.0);
  pushLevel(r1Pivot, '经典枢轴 R1 阻力', '枢轴点', '060', 1.0);
  pushLevel(s1Pivot, '经典枢轴 S1 支撑', '枢轴点', '060', 1.0);

  // ⑥ 确认阳线箱体（卡片179）+ 海龟 2N 硬止损位（卡片063）
  const recentAvgVol = avg(bars.slice(-20).map((b) => b.vol || 0)) || 1;
  for (let i = bars.length - 1; i >= Math.max(1, bars.length - 20); i--) {
    const b = bars[i];
    const prevC = bars[i - 1].close;
    const gainPct = prevC ? ((b.close - prevC) / prevC) * 100 : 0;
    if (gainPct >= 3.5 && (b.vol || 0) >= recentAvgVol * 1.2) {
      pushLevel(b.low, `放量确认阳线底 (${b.date.slice(5)})`, '确认阳线', '179', 1.6);
      pushLevel(b.high, `放量确认阳线顶 (${b.date.slice(5)})`, '确认阳线', '179', 1.2);
      break;
    }
  }
  const turtleStop2N = indicators.atr14 ? round2(price - 2 * indicators.atr14) : null;
  if (turtleStop2N && turtleStop2N > 0) {
    pushLevel(turtleStop2N, '海龟 2N (2×ATR) 追踪硬止损', '海龟止损', '063', 1.5);
  }

  // 智能共振聚类：将间距 <= 1.35% 的多流派点位聚合成「强共振支撑/压力带」
  rawLevels.sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const lv of rawLevels) {
    const lastCluster = clusters[clusters.length - 1];
    if (lastCluster && Math.abs(lv.price - lastCluster.anchorPrice) / price <= 0.0135) {
      lastCluster.members.push(lv);
      const totalW = lastCluster.members.reduce((s, m) => s + m.weight, 0);
      lastCluster.price = round2(lastCluster.members.reduce((s, m) => s + m.price * m.weight, 0) / totalW);
      lastCluster.score = round2(totalW);
    } else {
      clusters.push({
        anchorPrice: lv.price,
        price: lv.price,
        score: round2(lv.weight),
        members: [lv],
      });
    }
  }

  const formatted = clusters.map((c) => {
    const schools = [...new Set(c.members.map((m) => m.school))];
    const cardIds = [...new Set(c.members.map((m) => m.cardId).filter(Boolean))];
    const distPct = round2(((c.price - price) / price) * 100);
    const kind = distPct > 0.6 ? 'resistance' : distPct < -0.6 ? 'support' : 'pivot';
    const strength =
      schools.length >= 3 || c.score >= 3.6
        ? '强共振'
        : schools.length >= 2 || c.score >= 2.0
        ? '中级'
        : '参考';
    return {
      price: c.price,
      distPct,
      kind,
      strength,
      resonanceCount: schools.length,
      score: c.score,
      schools,
      cardIds,
      labels: c.members.map((m) => m.label),
      primaryLabel: c.members.sort((a, b) => b.weight - a.weight)[0].label,
    };
  });

  // 按与现价的距离排序：压力位从近到远 R1->R4，支撑位从近到远 S1->S4
  const resistances = formatted
    .filter((x) => x.kind === 'resistance')
    .sort((a, b) => a.price - b.price)
    .slice(0, 4)
    .map((x, i) => ({ ...x, code: `R${i + 1}` }));

  const pivots = formatted
    .filter((x) => x.kind === 'pivot')
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => ({ ...x, code: '多空锚' }));

  const supports = formatted
    .filter((x) => x.kind === 'support')
    .sort((a, b) => b.price - a.price)
    .slice(0, 4)
    .map((x, i) => ({ ...x, code: `S${i + 1}` }));

  // 盈亏比参考（到 R1 空间 vs 到 S1 空间）
  const r1 = resistances[0];
  const s1 = supports[0];
  const rewardRiskRatio =
    r1 && s1 && Math.abs(s1.distPct) > 0.1
      ? round2(Math.abs(r1.distPct) / Math.abs(s1.distPct))
      : null;

  // 一键可复制/填入标的研判「三、交易结构」的标准化 Markdown 文本
  const mdLines = [
    `【技术点位速查｜现价 ${currencySymbol}${price}｜${indicators.trendRegime}】`,
    `- 上方压力：${resistances.map((r) => `${r.code} ${currencySymbol}${r.price} (${r.distPct > 0 ? '+' : ''}${r.distPct}%, ${r.strength}·${r.primaryLabel})`).join('；') || '上方无近端历史套牢压制（创新高区）'}`,
    `- 下方支撑：${supports.map((s) => `${s.code} ${currencySymbol}${s.price} (${s.distPct}%, ${s.strength}·${s.primaryLabel})`).join('；') || '下方无近端支撑'}`,
    `- 关键锚点：MA5=${currencySymbol}${indicators.ma5 ?? '-'} (乖离${indicators.ma5BiasPct ?? '-'}%)｜MA20=${currencySymbol}${indicators.ma20 ?? '-'}｜60日筹码峰POC=${currencySymbol}${vp.poc ?? '-'}｜海龟2N止损=${currencySymbol}${turtleStop2N ?? '-'}｜R1/S1空间盈亏比=${rewardRiskRatio ?? '-'}`,
  ];

  return {
    resistances,
    pivots,
    supports,
    volumeProfile: vp,
    turtleStop2N,
    rewardRiskRatio,
    markdownSummary: mdLines.join('\n'),
  };
}

// ============================================================================
// 4. 全市场实时阶段性情绪快照（供市场情绪高点预警使用）
// ============================================================================

async function fetchMarketSentimentSnapshot(opts = {}) {
  const ymd = todayYMD();
  const doFetchJson = typeof opts.fetchJsonImpl === 'function' ? opts.fetchJsonImpl : fetchJson;
  const [breadthRes, ztRes, dtRes, zbRes] = await Promise.allSettled([
    doFetchJson(
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f6,f12,f14,f104,f105,f106&secids=1.000001,0.399001',
      7000
    ),
    doFetchJson(`https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fbt:asc&date=${ymd}`, 7000),
    doFetchJson(`https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=150&sort=fund:desc&date=${ymd}`, 7000),
    doFetchJson(`https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt:asc&date=${ymd}`, 7000),
  ]);

  let up = null;
  let down = null;
  let flat = null;
  let redRatePct = null;
  let twoMarketAmtYi = null;

  if (breadthRes.status === 'fulfilled' && Array.isArray(breadthRes.value?.data?.diff)) {
    const rows = breadthRes.value.data.diff;
    let sumUp = 0;
    let sumDown = 0;
    let sumFlat = 0;
    let sumAmt = 0;
    for (const r of rows) {
      if (Number.isFinite(Number(r.f104))) sumUp += Number(r.f104);
      if (Number.isFinite(Number(r.f105))) sumDown += Number(r.f105);
      if (Number.isFinite(Number(r.f106))) sumFlat += Number(r.f106);
      if (Number.isFinite(Number(r.f6))) sumAmt += Number(r.f6);
    }
    const total = sumUp + sumDown + sumFlat;
    if (total > 0) {
      up = sumUp;
      down = sumDown;
      flat = sumFlat;
      redRatePct = round2((sumUp / total) * 100);
    }
    if (sumAmt > 0) twoMarketAmtYi = round2(sumAmt / 1e8);
  }

  const ztOk = ztRes.status === 'fulfilled' && ztRes.value?.data != null && Array.isArray(ztRes.value?.data?.pool);
  const dtOk = dtRes.status === 'fulfilled' && dtRes.value?.data != null && Array.isArray(dtRes.value?.data?.pool);
  const zbOk = zbRes.status === 'fulfilled' && zbRes.value?.data != null && Array.isArray(zbRes.value?.data?.pool);

  const ztPool = ztOk ? ztRes.value.data.pool : [];
  const dtPool = dtOk ? dtRes.value.data.pool : [];
  const zbPool = zbOk ? zbRes.value.data.pool : [];

  const ztCount = ztOk ? ztPool.length : null;
  const dtCount = dtOk ? dtPool.length : null;
  const zbCount = zbOk ? zbPool.length : null;

  const totalAttempt = ztCount != null && zbCount != null ? ztCount + zbCount : null;
  const sealRatePct = totalAttempt != null && totalAttempt > 0 ? round2((ztCount / totalAttempt) * 100) : null;
  const burstRatePct = totalAttempt != null && totalAttempt > 0 ? round2((zbCount / totalAttempt) * 100) : null;
  const maxBoard = ztOk ? (ztPool.length ? Math.max(...ztPool.map((x) => Number(x.lbc || 1))) : 0) : null;
  const lianbanCount = ztOk ? ztPool.filter((x) => Number(x.lbc || 1) >= 2).length : null;
  const topLeaders = ztOk
    ? ztPool
        .filter((x) => Number(x.lbc || 1) >= 2)
        .sort((a, b) => Number(b.lbc || 1) - Number(a.lbc || 1))
        .slice(0, 4)
        .map((x) => ({ code: x.c, name: x.n, board: Number(x.lbc || 1), industry: x.hybk || '' }))
    : [];

  const breadthOk = redRatePct != null || twoMarketAmtYi != null;
  const upstreamOkCount = [breadthOk, ztOk, dtOk, zbOk].filter(Boolean).length;
  // 只有实际获取到有效原始宽度或涨跌停字段时才计算情绪分；全部失败时严禁伪造 50 分！
  const hasEssentialInputs = redRatePct != null || ztCount != null || dtCount != null;

  let sentimentScore = null;
  let stage = null;
  if (hasEssentialInputs) {
    let score = 50;
    if (redRatePct != null) score += (redRatePct - 50) * 0.65;
    if (ztCount != null) score += Math.min(20, (ztCount - 45) * 0.25);
    if (dtCount != null) score -= Math.min(25, dtCount * 0.7);
    if (burstRatePct != null && burstRatePct > 30) score -= (burstRatePct - 30) * 0.35;
    if (maxBoard != null && maxBoard >= 5) score += Math.min(12, (maxBoard - 4) * 3);
    sentimentScore = Math.max(0, Math.min(100, Math.round(score)));

    stage =
      sentimentScore >= 78
        ? '情绪高潮过热（警惕一致兑现）'
        : sentimentScore >= 60
        ? '主升偏强（留意高位分歧）'
        : sentimentScore >= 40
        ? '结构震荡分化'
        : sentimentScore >= 25
        ? '弱势退潮偏冷'
        : '短线冰点观察区';
  }

  const rawQDate = String(ztRes.value?.data?.qdate || dtRes.value?.data?.qdate || zbRes.value?.data?.qdate || '');
  const formattedQDate =
    rawQDate.length === 8 ? `${rawQDate.slice(0, 4)}-${rawQDate.slice(4, 6)}-${rawQDate.slice(6, 8)}` : null;
  const sourceAsOf = hasEssentialInputs ? formattedQDate || nowOffsetISO() : null;

  return {
    valid: hasEssentialInputs,
    upstreamOkCount,
    fetchedAt: nowOffsetISO(),
    sourceAsOf,
    up,
    down,
    flat,
    redRatePct,
    twoMarketAmtYi,
    ztCount,
    dtCount,
    zbCount,
    sealRatePct,
    burstRatePct,
    maxBoard,
    lianbanCount,
    topLeaders,
    sentimentScore,
    stage,
  };
}

// ============================================================================
// 5. 统一分析接口：单标支撑压力位 + 技术诊断 + 规则扫描
// ============================================================================

const { getEditionInfo } = require('./edition.cjs');
const {
  inferMarketMetaFromSecid,
  isUnsupportedAssetSecid,
  isCryptoSecid,
  cryptoPairFromSecid,
  fetchCryptoTickers,
} = require('./global-markets.cjs');

async function analyzeSecurityTechnicals(rawQueryOrSecid, timeframe = 'day') {
  const input = String(rawQueryOrSecid || '').trim();
  if (!input) throw new Error('请输入标的名称、代码或 secid');
  if (isUnsupportedAssetSecid(input)) {
    throw new Error('当前版本不支持该资产类型');
  }
  const tf = ['day', 'week', '60m', '15m', '1m'].includes(timeframe) ? timeframe : 'day';
  const cryptoEnabled = getEditionInfo().features.crypto;

  let secid = '';
  let targetMeta = null;

  if (/^(?:\d+|crypto)\.[A-Za-z0-9._-]+$/i.test(input)) {
    secid = input;
    const inferred = inferMarketMetaFromSecid(secid);
    if (!cryptoEnabled && inferred.marketKind === 'CRYPTO') {
      throw new Error('当前版本不支持该资产类型');
    }
    targetMeta = {
      secid,
      code: inferred.code,
      secuCode: inferred.secuCode,
      name: inferred.name || inferred.code,
      marketKind: inferred.marketKind,
      currency: inferred.currency,
      exchange: inferred.exchange,
    };
  } else {
    const resolved = await resolveStockQuery(input);
    if (!resolved.resolved || !resolved.secid) {
      throw new Error(
        cryptoEnabled
          ? `未能识别标的：${input}（支持 A股/美股/港股/台/韩/法/英/日/德/全球期货及扩展市场）`
          : `未能识别证券或期货标的：${input}（支持 A股/美股/港股/台/韩/法/英/日/德与全球大宗期货）`
      );
    }
    if (!cryptoEnabled && (isUnsupportedAssetSecid(resolved.secid) || resolved.marketKind === 'CRYPTO')) {
      throw new Error('当前版本不支持该资产类型');
    }
    secid = resolved.secid;
    targetMeta = {
      secid: resolved.secid,
      code: resolved.code,
      secuCode: resolved.secuCode,
      name: resolved.name,
      marketKind: resolved.marketKind,
      currency: resolved.currency,
      exchange: resolved.market || resolved.marketKind,
    };
  }

  const quoteFields = 'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f23';
  const [qRes, cryptoMap, klines] = await Promise.all([
    isCryptoSecid(secid)
      ? Promise.resolve(null)
      : fetchJson(
          `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=${quoteFields}&secids=${encodeURIComponent(secid)}`,
          8000
        ).catch(() => null),
    isCryptoSecid(secid) ? fetchCryptoTickers([cryptoPairFromSecid(secid)]).catch(() => new Map()) : Promise.resolve(new Map()),
    fetchMultiTimeframeKlines(secid, targetMeta.marketKind, tf),
  ]);

  if (!klines || klines.length < 5) {
    throw new Error(`未能获取 ${targetMeta.name} (${targetMeta.secuCode}) 的 ${tf} 周期历史 K 线数据`);
  }

  const qRow = qRes?.data?.diff?.[0] || null;
  const cLive = isCryptoSecid(secid) ? cryptoMap.get(cryptoPairFromSecid(secid)) || null : null;
  if (qRow?.f14) targetMeta.name = qRow.f14;

  const liveQuote = cLive
    ? {
        price: cLive.price,
        pct: cLive.pct,
        high: cLive.high,
        low: cLive.low,
        open: cLive.open,
        preClose: cLive.preClose,
        volume: cLive.volume,
        turnoverPct: null,
        volumeRatio: null,
      }
    : qRow
    ? {
        price: qRow.f2 !== '-' ? round2(qRow.f2) : null,
        pct: qRow.f3 !== '-' ? round2(qRow.f3) : null,
        high: qRow.f15 !== '-' ? round2(qRow.f15) : null,
        low: qRow.f16 !== '-' ? round2(qRow.f16) : null,
        open: qRow.f17 !== '-' ? round2(qRow.f17) : null,
        preClose: qRow.f18 !== '-' ? round2(qRow.f18) : null,
        volume: qRow.f5 !== '-' ? Number(qRow.f5) : null,
        turnoverPct: qRow.f8 !== '-' ? round2(qRow.f8) : null,
        volumeRatio: qRow.f10 !== '-' ? round2(qRow.f10) : null,
      }
    : null;

  // 在日K下用实时报价更新末根K线；分钟级保留精确K线收盘避免跨分钟失真
  const indicators = computeIndicatorsFromKlines(klines, tf === 'day' ? liveQuote : null);
  if (liveQuote && tf !== 'day') {
    indicators.pct = liveQuote.pct ?? indicators.pct;
    indicators.turnoverPct = liveQuote.turnoverPct ?? indicators.turnoverPct;
  }

  // 计算三大趋势线流派并把趋势线信号合入 indicators 以便统一触发预警
  const trendlines = computeTrendlines(klines, tf === 'week' ? 80 : 90);
  Object.assign(indicators, trendlines.signals);

  const currSym = targetMeta.currency === 'USD' ? '$' : targetMeta.currency === 'HKD' ? 'HK$' : '¥';
  const levels = generateSupportResistance(klines.slice(-90), indicators, currSym);

  // 追加趋势线点位摘要到可复制 Markdown
  const tlSummary = [];
  if (trendlines.victor.downLine) {
    tlSummary.push(`维克多下降压制线=${currSym}${trendlines.victor.downLine.currentPrice} (${trendlines.victor.downLine.status})`);
  }
  if (trendlines.victor.upLine) {
    tlSummary.push(`维克多上升支撑线=${currSym}${trendlines.victor.upLine.currentPrice} (${trendlines.victor.upLine.status})`);
  }
  if (trendlines.demark.supplyLine) {
    tlSummary.push(`德马克TD供给线=${currSym}${trendlines.demark.supplyLine.currentPrice}`);
  }
  if (trendlines.demark.demandLine) {
    tlSummary.push(`德马克TD需求线=${currSym}${trendlines.demark.demandLine.currentPrice}`);
  }
  if (trendlines.regressionChannel) {
    tlSummary.push(
      `回归通道(${trendlines.regressionChannel.direction}, R²=${trendlines.regressionChannel.rSquared}) 上轨${currSym}${trendlines.regressionChannel.endUpper}/下轨${currSym}${trendlines.regressionChannel.endLower} (位置${trendlines.regressionChannel.posPct}%)`
    );
  }
  if (tlSummary.length > 0) {
    levels.markdownSummary += `\n- 趋势线流派（${trendlines.patternLabel}）：${tlSummary.join('｜')}`;
  }

  // 对照当前启用的个股高点/趋势线预警规则逐条核验
  const { rules } = loadAlertRules();
  const stockRules = rules.filter((r) => r.enabled && r.scope === 'stock_peak');
  const triggeredAlerts = [];
  for (const rule of stockRules) {
    const actualVal = indicators[rule.metric];
    if (evaluateCondition(actualVal, rule.operator, rule.threshold)) {
      triggeredAlerts.push({
        ruleId: rule.id,
        ruleName: rule.name,
        metric: rule.metric,
        actualValue: actualVal,
        operator: rule.operator,
        threshold: rule.threshold,
        severity: rule.severity,
        sourceCardId: rule.sourceCardId,
        sourceCardTitle: rule.sourceCardTitle,
        actionAdvice: rule.actionAdvice,
      });
    }
  }

  return {
    ok: true,
    analyzedAt: nowOffsetISO(),
    timeframe: tf,
    totalBars: klines.length,
    target: targetMeta,
    indicators,
    levels,
    trendlines,
    triggeredAlerts,
    klines,
  };
}

const radarCache = { ts: 0, key: '', data: null };
const RADAR_CACHE_TTL_MS = 120 * 1000;

function clearTechnicalRadarCache() {
  radarCache.ts = 0;
  radarCache.key = '';
  radarCache.data = null;
}

async function mapWithConcurrencyLimit(list, limit, worker) {
  const results = new Array(list.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (idx < list.length) {
      const cur = idx++;
      results[cur] = await worker(list[cur], cur);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 并发受控（<=4）+ 120s TTL 内存缓存的全市场情绪 & 自选股技术高点/破位预警雷达
 */
async function scanTechnicalRadar(force = false) {
  const fetchedAt = nowOffsetISO();
  const wlCfg = loadWatchlistConfig();
  const { items } = wlCfg;
  const { rules } = loadAlertRules();
  const cacheKey = `${items.map((x) => x.secid).join(',')}|${rules.filter((r) => r.enabled).map((r) => r.id).join(',')}`;
  if (!force && radarCache.data && radarCache.key === cacheKey && Date.now() - radarCache.ts < RADAR_CACHE_TTL_MS) {
    return radarCache.data;
  }
  const activeMarketRules = rules.filter((r) => r.enabled && r.scope === 'market_sentiment');
  const activeStockRules = rules.filter((r) => r.enabled && r.scope === 'stock_peak');

  const quoteFields = 'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18';
  const secidsStr = items.map((x) => x.secid).join(',');

  const [sentiment, quotesRes] = await Promise.all([
    fetchMarketSentimentSnapshot(),
    items.length > 0
      ? fetchJson(
          `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=${quoteFields}&secids=${encodeURIComponent(secidsStr)}`,
          8000
        ).catch(() => null)
      : Promise.resolve(null),
  ]);

  const quoteBySecid = new Map();
  for (const row of quotesRes?.data?.diff || []) {
    quoteBySecid.set(`${row.f13}.${row.f12}`, row);
  }

  // 1. 评估全市场情绪高点预警
  const marketAlerts = [];
  for (const rule of activeMarketRules) {
    const val = sentiment[rule.metric];
    if (evaluateCondition(val, rule.operator, rule.threshold)) {
      marketAlerts.push({
        ruleId: rule.id,
        ruleName: rule.name,
        scope: 'market_sentiment',
        metric: rule.metric,
        actualValue: val,
        operator: rule.operator,
        threshold: rule.threshold,
        severity: rule.severity,
        sourceCardId: rule.sourceCardId,
        sourceCardTitle: rule.sourceCardTitle,
        actionAdvice: rule.actionAdvice,
      });
    }
  }

  // 2. 限流并发（最多 4 路并发）拉取每只自选股 60 日 K 线并评估股价高点/破位预警
  const stockScans = await mapWithConcurrencyLimit(items, 4, async (item) => {
      try {
        const klines = await fetchDailyKlinesRobust(item.secid, item.marketKind, 95);
        const qRow = quoteBySecid.get(item.secid);
        const liveQuote = qRow
          ? {
              price: qRow.f2 !== '-' ? round2(qRow.f2) : null,
              pct: qRow.f3 !== '-' ? round2(qRow.f3) : null,
              high: qRow.f15 !== '-' ? round2(qRow.f15) : null,
              low: qRow.f16 !== '-' ? round2(qRow.f16) : null,
              preClose: qRow.f18 !== '-' ? round2(qRow.f18) : null,
              volume: qRow.f5 !== '-' ? Number(qRow.f5) : null,
              turnoverPct: qRow.f8 !== '-' ? round2(qRow.f8) : null,
            }
          : null;
        const ind = computeIndicatorsFromKlines(klines, liveQuote);
        if (!ind) return null;
        const tl = computeTrendlines(klines, 90);
        Object.assign(ind, tl.signals);

        const alerts = [];
        for (const rule of activeStockRules) {
          const val = ind[rule.metric];
          if (evaluateCondition(val, rule.operator, rule.threshold)) {
            alerts.push({
              ruleId: rule.id,
              ruleName: rule.name,
              scope: 'stock_peak',
              metric: rule.metric,
              actualValue: val,
              operator: rule.operator,
              threshold: rule.threshold,
              severity: rule.severity,
              sourceCardId: rule.sourceCardId,
              sourceCardTitle: rule.sourceCardTitle,
              actionAdvice: rule.actionAdvice,
            });
          }
        }

        return {
          secid: item.secid,
          code: item.code,
          secuCode: item.secuCode,
          name: qRow?.f14 || item.name,
          marketKind: item.marketKind,
          currency: item.currency,
          price: ind.price,
          pct: ind.pct,
          ma5BiasPct: ind.ma5BiasPct,
          ma20BiasPct: ind.ma20BiasPct,
          rsi6: ind.rsi6,
          volRatio5d: ind.volRatio5d,
          ret5dPct: ind.ret5dPct,
          macdTopDivergence: ind.macdTopDivergence,
          is2BTopSignal: ind.is2BTopSignal,
          isHighVolStall: ind.isHighVolStall,
          trendRegime: ind.trendRegime,
          alerts,
        };
      } catch {
        return null;
      }
    });

  const validScans = stockScans.filter(Boolean);
  const stockAlerts = [];
  for (const s of validScans) {
    for (const a of s.alerts) {
      stockAlerts.push({
        ...a,
        secid: s.secid,
        secuCode: s.secuCode,
        stockName: s.name,
        marketKind: s.marketKind,
        currency: s.currency,
        price: s.price,
        pct: s.pct,
      });
    }
  }

  // 高危优先排序
  const sevRank = { high: 0, medium: 1, info: 2 };
  marketAlerts.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9));
  stockAlerts.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9));

  // 自动更新跨日 10 态市场情绪节点状态机快照（仅在真实获取到有效原始市场宽度/涨跌停数据时记录）
  const sentimentChain = sentiment && sentiment.valid !== false ? recordSentimentNodeSnapshot(sentiment) : { current: null, ...loadSentimentChain() };

  const result = {
    ok: true,
    fetchedAt,
    sentiment,
    sentimentChain,
    marketAlerts,
    stockAlerts,
    stockScans: validScans,
    summary: {
      totalAlerts: marketAlerts.length + stockAlerts.length,
      highSeverityCount: [...marketAlerts, ...stockAlerts].filter((a) => a.severity === 'high').length,
      alertedStockCount: validScans.filter((s) => s.alerts.length > 0).length,
      scannedStockCount: validScans.length,
    },
  };
  radarCache.ts = Date.now();
  radarCache.key = cacheKey;
  radarCache.data = result;
  return result;
}

// ============================================================================
// 6. 从《方法论卡片库》一键提取预警规则（确定性规则提取 + 可选 AI 深度提炼）
// ============================================================================

function deterministicExtractRulesFromCards(cards) {
  const candidates = [];
  for (const card of cards) {
    const text = `${card.title} ${card.coreThesis} ${card.applicableConditions} ${card.invalidationSignals}`;
    const base = {
      sourceCardId: card.id,
      sourceCardTitle: card.title,
      sourceCardHash: computeCardFingerprint(card),
      enabled: true,
    };

    if (/背驰|顶背离|MACD/i.test(text)) {
      candidates.push({
        ...base,
        id: `ext-${card.id}-macd`,
        name: `卡片${card.id}｜MACD 顶背驰动能衰竭预警`,
        scope: 'stock_peak',
        metric: 'macdTopDivergence',
        operator: '==',
        threshold: 1,
        severity: 'high',
        actionAdvice: card.coreThesis.slice(0, 110),
      });
    }
    if (/2B|假突破|1-2-3|utad|突破失败|趋势线/i.test(text)) {
      candidates.push({
        ...base,
        id: `ext-${card.id}-2b`,
        name: `卡片${card.id}｜假突破回落见顶预警（2B/UTAD）`,
        scope: 'stock_peak',
        metric: 'is2BTopSignal',
        operator: '==',
        threshold: 1,
        severity: 'high',
        actionAdvice: card.coreThesis.slice(0, 110),
      });
      if (/1-2-3|趋势线/i.test(text)) {
        candidates.push({
          ...base,
          id: `ext-${card.id}-vicbreak`,
          name: `卡片${card.id}｜维克多上升趋势线破位预警（1-2-3）`,
          scope: 'stock_peak',
          metric: 'vicUpBreakdown',
          operator: '==',
          threshold: 1,
          severity: 'high',
          actionAdvice: card.coreThesis.slice(0, 110),
        });
      }
    }
    if (/通道|回归|轨道/i.test(text)) {
      candidates.push({
        ...base,
        id: `ext-${card.id}-regch`,
        name: `卡片${card.id}｜线性回归 +2σ 通道上轨超买警戒`,
        scope: 'stock_peak',
        metric: 'regChannelPosPct',
        operator: '>=',
        threshold: 96,
        severity: 'medium',
        actionAdvice: card.coreThesis.slice(0, 110),
      });
    }
    if (/量价背离|努力.*结果|高位.*换手|滞涨|上影|避雷针|天量/i.test(text)) {
      candidates.push({
        ...base,
        id: `ext-${card.id}-stall`,
        name: `卡片${card.id}｜高位放量滞涨/上影派发预警`,
        scope: 'stock_peak',
        metric: 'isHighVolStall',
        operator: '==',
        threshold: 1,
        severity: 'high',
        actionAdvice: card.coreThesis.slice(0, 110),
      });
    }
    if (/乖离|远离.*5\s*日线|大涨次日.*消化/i.test(text)) {
      const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
      const th = m && Number(m[1]) >= 4 && Number(m[1]) <= 25 ? Number(m[1]) : 8;
      candidates.push({
        ...base,
        id: `ext-${card.id}-ma5bias`,
        name: `卡片${card.id}｜MA5 正乖离超限（>=${th}%）`,
        scope: 'stock_peak',
        metric: 'ma5BiasPct',
        operator: '>=',
        threshold: th,
        severity: 'high',
        actionAdvice: card.coreThesis.slice(0, 110),
      });
    }
    if (/死亡换手|剧烈换手|换手.*%/i.test(text)) {
      const m = text.match(/(\d{2})\s*%/);
      const th = m && Number(m[1]) >= 15 && Number(m[1]) <= 80 ? Number(m[1]) : 25;
      candidates.push({
        ...base,
        id: `ext-${card.id}-turn`,
        name: `卡片${card.id}｜高位巨量换手过热（>=${th}%）`,
        scope: 'stock_peak',
        metric: 'turnoverPct',
        operator: '>=',
        threshold: th,
        severity: 'medium',
        actionAdvice: card.coreThesis.slice(0, 110),
      });
    }
    if (/炸板|封板|情绪周期|退潮/i.test(text)) {
      candidates.push({
        ...base,
        id: `ext-${card.id}-burst`,
        name: `卡片${card.id}｜全市场炸板率高位分歧预警`,
        scope: 'market_sentiment',
        metric: 'burstRatePct',
        operator: '>=',
        threshold: 35,
        severity: 'high',
        actionAdvice: card.coreThesis.slice(0, 110),
      });
    }
    if (/冰点|超跌|恐慌|杀跌/i.test(text)) {
      candidates.push({
        ...base,
        id: `ext-${card.id}-ice`,
        name: `卡片${card.id}｜全市场红盘率情绪冰点提示`,
        scope: 'market_sentiment',
        metric: 'redRatePct',
        operator: '<=',
        threshold: 22,
        severity: 'info',
        actionAdvice: card.coreThesis.slice(0, 110),
      });
    }
    if (/一致|高潮|泡沫|狂热|拥挤|利润垫/i.test(text)) {
      candidates.push({
        ...base,
        id: `ext-${card.id}-euphoria`,
        name: `卡片${card.id}｜市场情绪极致一致过热预警`,
        scope: 'market_sentiment',
        metric: 'redRatePct',
        operator: '>=',
        threshold: 80,
        severity: 'medium',
        actionAdvice: card.coreThesis.slice(0, 110),
      });
    }
    if (/支撑.*阻力|极性转换|止损|破位|颈线/i.test(text)) {
      candidates.push({
        ...base,
        id: `ext-${card.id}-ma20break`,
        name: `卡片${card.id}｜跌破 MA20 生命线防守预警`,
        scope: 'stock_peak',
        metric: 'ma20BiasPct',
        operator: '<=',
        threshold: -1.5,
        severity: 'high',
        actionAdvice: card.coreThesis.slice(0, 110),
      });
    }

    // 若卡片未命中上述显式关键词，按其系统类别提供一条贴合的默认候选规则供用户微调
    if (!candidates.some((c) => c.sourceCardId === card.id)) {
      const isMkt = /宏观|情绪|市场|周期|短线|泡沫|指数/.test(`${card.system} ${card.title}`);
      candidates.push({
        ...base,
        id: `ext-${card.id}-gen`,
        name: `卡片${card.id}｜${card.title.slice(0, 22)}（高点观察）`,
        scope: isMkt ? 'market_sentiment' : 'stock_peak',
        metric: isMkt ? 'sentimentScore' : 'rsi6',
        operator: '>=',
        threshold: isMkt ? 78 : 80,
        severity: 'medium',
        actionAdvice: card.coreThesis.slice(0, 110),
      });
    }
  }

  return candidates.map(sanitizeRule).filter(Boolean);
}

async function extractRulesFromMethodologyCards({ workspace, cardIds, useAi = false, providerOverride }) {
  const idSet = new Set((cardIds || []).map((id) => String(id).padStart(3, '0')));
  const cards = workspace.methodology.cards.filter((c) => !c.isRevoked && idSet.has(c.id));
  if (cards.length === 0) {
    throw new Error('请至少选择 1 张有效的方法论卡片。');
  }

  if (!useAi) {
    return {
      ok: true,
      mode: 'deterministic',
      extractedRules: deterministicExtractRulesFromCards(cards),
      sourceCards: cards.map((c) => ({ id: c.id, title: c.title })),
    };
  }

  const systemPrompt = `你是二级投研量化技术规则架构师。请将用户选定的《方法论卡片库》卡片，精准转化为可执行、可量化监控的「阶段性情绪高点 / 股价高点预警规则」JSON 数组。

【严格约束】
1. 每条规则的 metric 字段**只能**从以下系统已实时采集的指标 key 中选择：
${METRIC_CATALOG.map((m) => `- ${m.key} (${m.scope}): ${m.label} — ${m.desc}`).join('\n')}
2. operator 只能是 ">=", "<=", ">", "<", "=="；若选用布尔信号类指标（macdTopDivergence / is2BTopSignal / isHighVolStall），operator 必须为 "==" 且 threshold 为 1。
3. 每条规则必须忠实保留 sourceCardId（3位卡号）与贴合卡片原意的 actionAdvice（≤100字可执行交易纪律）。
4. 仅输出单个合法 JSON 对象：{"rules": [ ... ]}。`;

  const userPrompt = `请从以下 ${cards.length} 张方法论卡片中提炼 1–6 条高价值的阶段性情绪高点或股价高点预警规则：

${cards
  .map(
    (c) =>
      `### 卡片 ${c.id} | ${c.title} (可信度 ${c.credibilityScore ?? '-'})\n- 核心论断：${c.coreThesis}\n- 适用条件：${c.applicableConditions}\n- 失效信号：${c.invalidationSignals}`
  )
  .join('\n\n')}`;

  const modelRes = await invokeModel({
    providerOverride,
    systemPrompt,
    userPrompt,
    expectJson: true,
    timeoutMs: 120000,
  });

  const parsed = parseJsonFromModelOutput(modelRes.rawText);
  const rawArr = Array.isArray(parsed?.rules) ? parsed.rules : Array.isArray(parsed) ? parsed : [];
  const validMetrics = new Set(METRIC_CATALOG.map((m) => m.key));
  const cleaned = rawArr
    .filter((r) => r && validMetrics.has(r.metric))
    .map((r, i) => {
      const srcCard = cards.find((c) => c.id === String(r.sourceCardId || '').padStart(3, '0')) || cards[0];
      return sanitizeRule(
        {
          ...r,
          id: `ai-ext-${srcCard.id}-${Date.now()}-${i}`,
          sourceCardId: srcCard.id,
          sourceCardTitle: srcCard.title,
        },
        i
      );
    })
    .filter(Boolean);

  return {
    ok: true,
    mode: 'ai',
    provider: modelRes.provider,
    model: modelRes.model,
    latencyMs: modelRes.latencyMs,
    extractedRules: cleaned.length > 0 ? cleaned : deterministicExtractRulesFromCards(cards),
    sourceCards: cards.map((c) => ({ id: c.id, title: c.title })),
  };
}

module.exports = {
  METRIC_CATALOG,
  DEFAULT_ALERT_RULES,
  loadAlertRules,
  saveAlertRules,
  resetAlertRules,
  computeCardFingerprint,
  auditRuleCardDrift,
  syncRuleCardHashes,
  loadSentimentChain,
  recordSentimentNodeSnapshot,
  deriveMarketNodeState,
  computeTrendlines,
  fetchMarketSentimentSnapshot,
  clearTechnicalRadarCache,
  analyzeSecurityTechnicals,
  scanTechnicalRadar,
  extractRulesFromMethodologyCards,
};
