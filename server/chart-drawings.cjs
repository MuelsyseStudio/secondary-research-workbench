'use strict';

/**
 * P2-3：交互 K 线手动自定义画线持久化 + 自定义画线突破/破位实时预警检测
 * 支持三类专业画线：
 * - trendline：两点斜率趋势线（支持向右自动射线延展，实时检测收盘价突破/跌破斜线！）
 * - hline：水平支撑/压力预警线（支持上穿/下破/双向实时触发！）
 * - note：K 线关键节点文字批注
 */

const fs = require('node:fs');
const path = require('node:path');
const { fetchMultiTimeframeKlines } = require('./watchlist-service.cjs');

const { stateFile } = require('./app-paths.cjs');
const DRAWINGS_PATH = stateFile('chart-drawings.local.json');

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function nowOffsetISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function loadAllDrawingsStore() {
  try {
    if (fs.existsSync(DRAWINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DRAWINGS_PATH, 'utf8'));
      if (raw && typeof raw.byKey === 'object') return raw;
    }
  } catch {
    // fallback
  }
  return { updatedAt: null, byKey: {} };
}

function saveAllDrawingsStore(store) {
  const payload = { updatedAt: nowOffsetISO(), byKey: store.byKey || {} };
  fs.writeFileSync(DRAWINGS_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

function makeKey(secid, timeframe = 'day') {
  return `${String(secid || '').trim()}::${String(timeframe || 'day').trim()}`;
}

function getChartDrawings(secid, timeframe = 'day') {
  const store = loadAllDrawingsStore();
  const key = makeKey(secid, timeframe);
  return {
    ok: true,
    secid,
    timeframe,
    drawings: Array.isArray(store.byKey[key]) ? store.byKey[key] : [],
    updatedAt: store.updatedAt,
  };
}

function saveChartDrawings(secid, timeframe = 'day', drawings = []) {
  if (!secid) throw new Error('缺少 secid');
  const store = loadAllDrawingsStore();
  const key = makeKey(secid, timeframe);
  const cleaned = (Array.isArray(drawings) ? drawings : [])
    .filter((d) => d && ['trendline', 'hline', 'note'].includes(d.type))
    .map((d, idx) => ({
      id: String(d.id || `drw-${Date.now()}-${idx}`),
      type: d.type,
      color: String(d.color || (d.type === 'hline' ? '#d97706' : '#2563eb')),
      label: String(d.label || '').trim(),
      alertEnabled: d.alertEnabled !== false,
      alertDirection: ['above', 'below', 'both'].includes(d.alertDirection) ? d.alertDirection : 'both',
      extendRight: d.extendRight !== false,
      // trendline points (date strings + price)
      date1: d.date1 ? String(d.date1) : undefined,
      price1: Number.isFinite(Number(d.price1)) ? round2(d.price1) : undefined,
      date2: d.date2 ? String(d.date2) : undefined,
      price2: Number.isFinite(Number(d.price2)) ? round2(d.price2) : undefined,
      // hline / note
      date: d.date ? String(d.date) : undefined,
      price: Number.isFinite(Number(d.price)) ? round2(d.price) : undefined,
      text: d.text ? String(d.text).trim() : undefined,
      createdAt: d.createdAt || nowOffsetISO(),
    }));
  store.byKey[key] = cleaned;
  const saved = saveAllDrawingsStore(store);
  return { ok: true, secid, timeframe, drawings: cleaned, updatedAt: saved.updatedAt };
}

/**
 * 评估某标的当前 K 线是否触发了用户手动画出的趋势线或水平预警线
 */
function evaluateDrawingsOnKlines(secid, stockName, drawings, klines) {
  if (!Array.isArray(drawings) || drawings.length === 0 || !Array.isArray(klines) || klines.length < 2) {
    return [];
  }
  const latest = klines[klines.length - 1];
  const prev = klines[klines.length - 2];
  const lastIdx = klines.length - 1;
  const prevIdx = klines.length - 2;
  const alerts = [];

  for (const d of drawings) {
    if (d.alertEnabled === false) continue;

    if (d.type === 'hline' && Number.isFinite(d.price) && d.price > 0) {
      const crossedUp = prev.close < d.price && latest.close >= d.price;
      const crossedDown = prev.close > d.price && latest.close <= d.price;
      if (crossedUp && (d.alertDirection === 'above' || d.alertDirection === 'both')) {
        alerts.push({
          id: `drw-alert-${d.id}`,
          ruleId: `drawing-${d.id}`,
          secid,
          stockName: stockName || secid,
          ruleName: `手动水平线向上突破（${d.label || d.price}）`,
          actualValue: round2(latest.close),
          threshold: d.price,
          severity: 'high',
          actionAdvice: `收盘价 ${latest.close} 站上你手动画出的水平线 ${d.price}，关注放量突破确认！`,
        });
      } else if (crossedDown && (d.alertDirection === 'below' || d.alertDirection === 'both')) {
        alerts.push({
          id: `drw-alert-${d.id}`,
          ruleId: `drawing-${d.id}`,
          secid,
          stockName: stockName || secid,
          ruleName: `手动水平线向下跌破（${d.label || d.price}）`,
          actualValue: round2(latest.close),
          threshold: d.price,
          severity: 'high',
          actionAdvice: `收盘价 ${latest.close} 跌破你手动画出的支撑/防守线 ${d.price}，严守止损或防守纪律！`,
        });
      }
    }

    if (d.type === 'trendline' && d.date1 && d.date2 && Number.isFinite(d.price1) && Number.isFinite(d.price2)) {
      const i1 = klines.findIndex((k) => k.date === d.date1);
      const i2 = klines.findIndex((k) => k.date === d.date2);
      if (i1 >= 0 && i2 >= 0 && i1 !== i2) {
        const slope = (d.price2 - d.price1) / (i2 - i1);
        const lineAtPrev = d.price1 + slope * (prevIdx - i1);
        const lineAtLast = d.price1 + slope * (lastIdx - i1);
        const isUpSlope = slope >= 0;
        const brokeDown = prev.close >= lineAtPrev * 0.998 && latest.close < lineAtLast * 0.995;
        const brokeUp = prev.close <= lineAtPrev * 1.002 && latest.close > lineAtLast * 1.005;

        if (brokeDown && (d.alertDirection === 'below' || d.alertDirection === 'both')) {
          alerts.push({
            id: `drw-alert-${d.id}`,
            ruleId: `drawing-${d.id}`,
            secid,
            stockName: stockName || secid,
            ruleName: `手动${isUpSlope ? '上升' : ''}趋势线跌破（${d.label || '自绘斜线'} @ ${round2(lineAtLast)}）`,
            actualValue: round2(latest.close),
            threshold: round2(lineAtLast),
            severity: 'high',
            actionAdvice: `现价 ${latest.close} 有效跌破你手绘趋势线映射位 ${round2(lineAtLast)}，警惕趋势转弱！`,
          });
        } else if (brokeUp && (d.alertDirection === 'above' || d.alertDirection === 'both')) {
          alerts.push({
            id: `drw-alert-${d.id}`,
            ruleId: `drawing-${d.id}`,
            secid,
            stockName: stockName || secid,
            ruleName: `手动${!isUpSlope ? '下降压制' : ''}趋势线突破（${d.label || '自绘斜线'} @ ${round2(lineAtLast)}）`,
            actualValue: round2(latest.close),
            threshold: round2(lineAtLast),
            severity: 'medium',
            actionAdvice: `现价 ${latest.close} 向上突破你手绘趋势线映射位 ${round2(lineAtLast)}，观察量能配合确认！`,
          });
        }
      }
    }
  }
  return alerts;
}

/**
 * 定时巡检用：扫描所有已存日线画线标的
 */
async function evaluateAllDrawingAlerts(stockScans = []) {
  const store = loadAllDrawingsStore();
  const scanNameMap = new Map(stockScans.map((s) => [s.secid, s.name]));
  const allAlerts = [];
  for (const [key, list] of Object.entries(store.byKey || {})) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const [secid, tf] = key.split('::');
    if (!secid || tf !== 'day') continue;
    const hasAlertable = list.some((d) => d.alertEnabled !== false && (d.type === 'hline' || d.type === 'trendline'));
    if (!hasAlertable) continue;
    try {
      const marketKind = secid.startsWith('105.') || secid.startsWith('106.') || secid.startsWith('107.') ? 'US' : secid.startsWith('116.') ? 'HK' : 'CN';
      const klines = await fetchMultiTimeframeKlines(secid, marketKind, 'day');
      const hits = evaluateDrawingsOnKlines(secid, scanNameMap.get(secid) || secid, list, klines);
      allAlerts.push(...hits);
    } catch {
      // ignore single symbol failure
    }
  }
  return allAlerts;
}

module.exports = {
  getChartDrawings,
  saveChartDrawings,
  evaluateDrawingsOnKlines,
  evaluateAllDrawingAlerts,
};
