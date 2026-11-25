import {
  registerIndicator,
  registerOverlay,
  utils,
  type Coordinate,
  type KLineData,
  type OverlayFigure,
} from 'klinecharts';
import type { DailyKlinePoint, VolumeProfileBin } from '../types';

export type MainIndicatorKey = 'MA' | 'EMA' | 'BOLL' | 'NONE';
export type SubIndicatorKey = 'VOL' | 'MACD' | 'KDJ' | 'RSI' | 'BIAS' | 'TURNOVER';
export type YAxisScaleKey = 'normal' | 'logarithm' | 'percentage';

export interface IndicatorParamsMap {
  MA: number[];
  EMA: number[];
  BOLL: number[];
  VOL: number[];
  MACD: number[];
  KDJ: number[];
  RSI: number[];
  BIAS: number[];
  TURNOVER: number[];
}

export interface ChartTemplateConfig {
  id: string;
  name: string;
  builtin?: boolean;
  mainIndicator: MainIndicatorKey;
  subIndicators: SubIndicatorKey[];
  params: Partial<IndicatorParamsMap>;
  showSR: boolean;
  showVictor: boolean;
  showDemark: boolean;
  showRegression: boolean;
  showTradeMarkers: boolean;
}

export const DEFAULT_INDICATOR_PARAMS: IndicatorParamsMap = {
  MA: [5, 10, 20, 60],
  EMA: [5, 20, 60],
  BOLL: [20, 2],
  VOL: [5, 10],
  MACD: [12, 26, 9],
  KDJ: [9, 3, 3],
  RSI: [6, 12, 24],
  BIAS: [6, 12, 24],
  TURNOVER: [5, 10],
};

export const BUILTIN_CHART_TEMPLATES: ChartTemplateConfig[] = [
  {
    id: 'short_term_board',
    name: 'A股短线打板模板',
    builtin: true,
    mainIndicator: 'MA',
    subIndicators: ['VOL', 'MACD'],
    params: { MA: [5, 10, 20], VOL: [5, 10], MACD: [12, 26, 9] },
    showSR: true,
    showVictor: false,
    showDemark: false,
    showRegression: false,
    showTradeMarkers: true,
  },
  {
    id: 'swing_trend',
    name: '波段趋势模板(6流派)',
    builtin: true,
    mainIndicator: 'MA',
    subIndicators: ['VOL', 'MACD', 'RSI'],
    params: { MA: [5, 20, 60], VOL: [5, 10], MACD: [12, 26, 9], RSI: [6, 12, 24] },
    showSR: true,
    showVictor: true,
    showDemark: true,
    showRegression: true,
    showTradeMarkers: true,
  },
  {
    id: 'naked_price',
    name: '裸K纯净模板',
    builtin: true,
    mainIndicator: 'NONE',
    subIndicators: ['VOL'],
    params: { VOL: [5, 10] },
    showSR: false,
    showVictor: false,
    showDemark: false,
    showRegression: false,
    showTradeMarkers: true,
  },
];

const PREFS_STORAGE_KEY = 'srw-klinecharts-prefs-v1';

export interface StoredChartPrefs {
  params: IndicatorParamsMap;
  customTemplates: ChartTemplateConfig[];
}

export function loadStoredChartPrefs(): StoredChartPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { params: { ...DEFAULT_INDICATOR_PARAMS }, customTemplates: [] };
    const parsed = JSON.parse(raw);
    return {
      params: { ...DEFAULT_INDICATOR_PARAMS, ...(parsed.params || {}) },
      customTemplates: Array.isArray(parsed.customTemplates) ? parsed.customTemplates : [],
    };
  } catch {
    return { params: { ...DEFAULT_INDICATOR_PARAMS }, customTemplates: [] };
  }
}

export function saveStoredChartPrefs(prefs: StoredChartPrefs) {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage quota
  }
}

export interface ExtendedKLineData extends KLineData {
  dateStr: string;
  turnoverRate?: number | null;
  pct?: number | null;
}

export function parseKlineDateToTs(dateStr: string, fallbackIdx: number): number {
  const s = String(dateStr || '').trim();
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s)) {
    const iso = s.replace(' ', 'T') + (s.length === 16 ? ':00+08:00' : '+08:00');
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}T15:00:00+08:00`);
    if (Number.isFinite(ms)) return ms;
  }
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return ms;
  return Date.now() - (500 - fallbackIdx) * 86400000;
}

export function toKLineDataList(klines: DailyKlinePoint[]): ExtendedKLineData[] {
  let prevTs = 0;
  return klines.map((k, idx) => {
    let ts = parseKlineDateToTs(k.date, idx);
    if (ts <= prevTs) ts = prevTs + 60000;
    prevTs = ts;
    return {
      timestamp: ts,
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: k.vol != null ? Number(k.vol) : undefined,
      turnover: k.amt != null ? Number(k.amt) : undefined,
      dateStr: k.date,
      turnoverRate: k.turnoverPct ?? null,
      pct: k.pct ?? null,
    };
  });
}

let extensionsRegistered = false;

export function ensureKlineExtensionsRegistered() {
  if (extensionsRegistered) return;
  extensionsRegistered = true;

  // 1. 自定义副图指标：换手率 (%) + 5/10 均值
  registerIndicator<{ tr?: number; ma1?: number; ma2?: number }, number>({
    name: 'TURNOVER',
    shortName: '换手率%',
    precision: 2,
    calcParams: [5, 10],
    figures: [
      {
        key: 'tr',
        title: '换手%: ',
        type: 'bar',
        baseValue: 0,
        styles: ({ data }) => {
          const val = data.current?.tr ?? 0;
          return {
            color: val >= 10 ? 'rgba(239, 68, 68, 0.78)' : val >= 5 ? 'rgba(245, 158, 11, 0.75)' : 'rgba(56, 189, 248, 0.65)',
          };
        },
      },
      { key: 'ma1', title: 'MA5: ', type: 'line', styles: () => ({ color: '#f59e0b', size: 1.2 }) },
      { key: 'ma2', title: 'MA10: ', type: 'line', styles: () => ({ color: '#a78bfa', size: 1.2 }) },
    ],
    calc: (dataList, indicator) => {
      const p1 = Number(indicator.calcParams[0] || 5);
      const p2 = Number(indicator.calcParams[1] || 10);
      let s1 = 0;
      let s2 = 0;
      return dataList.map((bar, i) => {
        const raw = Number((bar as ExtendedKLineData).turnoverRate ?? 0);
        const tr = Number.isFinite(raw) ? raw : 0;
        s1 += tr;
        s2 += tr;
        if (i >= p1) s1 -= Number((dataList[i - p1] as ExtendedKLineData).turnoverRate ?? 0) || 0;
        if (i >= p2) s2 -= Number((dataList[i - p2] as ExtendedKLineData).turnoverRate ?? 0) || 0;
        return {
          tr,
          ma1: i >= p1 - 1 ? Number((s1 / p1).toFixed(2)) : undefined,
          ma2: i >= p2 - 1 ? Number((s2 / p2).toFixed(2)) : undefined,
        };
      });
    },
  });

  // 2. 自定义水平线覆盖物（支撑压力位 / POC / 2N止损 / 持仓成本 / Bot预警 / 持久化水平线）
  registerOverlay<{
    label?: string;
    color?: string;
    bgColor?: string;
    dashed?: boolean;
    lineWidth?: number;
    align?: 'left' | 'right';
    alertId?: string;
  }>({
    name: 'srLevelLine',
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      if (!coordinates[0]) return [];
      const y = coordinates[0].y;
      if (y < -20 || y > bounding.height + 20) return [];
      const ext = overlay.extendData || {};
      const color = ext.color || '#f59e0b';
      const bgColor = ext.bgColor || 'rgba(15, 23, 42, 0.86)';
      const align = ext.align || 'right';
      const figures: OverlayFigure[] = [
        {
          type: 'line',
          attrs: {
            coordinates: [
              { x: 0, y },
              { x: bounding.width, y },
            ],
          },
          styles: {
            style: ext.dashed === false ? 'solid' : 'dashed',
            color,
            size: ext.lineWidth || 1.2,
            dashedValue: [5, 3],
          },
        },
      ];
      if (ext.label) {
        figures.push({
          type: 'text',
          attrs: {
            x: align === 'left' ? 8 : Math.max(8, bounding.width - 8),
            y: y - 3,
            text: ext.label,
            align: align === 'left' ? 'left' : 'right',
            baseline: 'bottom',
          },
          styles: {
            color,
            backgroundColor: bgColor,
            borderColor: color,
            borderSize: 0.7,
            borderRadius: 3,
            paddingLeft: 5,
            paddingRight: 5,
            paddingTop: 2,
            paddingBottom: 2,
            size: 10,
            weight: '700',
            family: 'ui-monospace, Consolas, monospace',
          },
        });
      }
      return figures;
    },
  });

  // 3. 自定义筹码分布直方图（右侧半透明水平柱 + POC 紫峰高亮）
  registerOverlay<{ bins?: VolumeProfileBin[]; poc?: number | null }>({
    name: 'volumeProfileOverlay',
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ bounding, yAxis, overlay }) => {
      const ext = overlay.extendData || {};
      const bins = ext.bins || [];
      const poc = ext.poc ?? null;
      if (!yAxis || bins.length === 0) return [];
      const maxW = Math.min(130, bounding.width * 0.2);
      const figs: OverlayFigure[] = [];
      for (const bin of bins) {
        const yTop = yAxis.convertToPixel(bin.priceHigh);
        const yBot = yAxis.convertToPixel(bin.priceLow);
        if (!Number.isFinite(yTop) || !Number.isFinite(yBot)) continue;
        if (yBot < 0 || yTop > bounding.height) continue;
        const clampedTop = Math.max(0, Math.min(yTop, yBot));
        const clampedBot = Math.min(bounding.height, Math.max(yTop, yBot));
        const bh = Math.max(1.5, clampedBot - clampedTop - 1);
        const bw = Math.max(2, (bin.pctOfMax / 100) * maxW);
        const isPoc = poc != null && poc >= bin.priceLow && poc <= bin.priceHigh;
        figs.push({
          type: 'rect',
          ignoreEvent: true,
          attrs: {
            x: bounding.width - bw,
            y: clampedTop,
            width: bw,
            height: bh,
          },
          styles: {
            style: 'fill',
            color: isPoc ? 'rgba(139, 92, 246, 0.36)' : 'rgba(148, 163, 184, 0.14)',
          },
        });
      }
      return figs;
    },
  });

  // 4. 三大流派趋势线 / 持久化趋势线（支持向右无限延伸 + 锚点圆点 + 标签）
  registerOverlay<{
    label?: string;
    color?: string;
    dashed?: boolean;
    extendRight?: boolean;
    lineWidth?: number;
  }>({
    name: 'schoolTrendOverlay',
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      if (coordinates.length < 2) return [];
      const [c1, c2] = coordinates;
      const ext = overlay.extendData || {};
      const color = ext.color || '#3b82f6';
      let endCoord: Coordinate = c2;
      if (ext.extendRight !== false && Math.abs(c2.x - c1.x) > 0.5) {
        const targetX = c2.x >= c1.x ? bounding.width : 0;
        const targetY = utils.getLinearYFromCoordinates(c1, c2, { x: targetX, y: 0 });
        if (Number.isFinite(targetY)) {
          endCoord = { x: targetX, y: targetY };
        }
      }
      const figs: OverlayFigure[] = [
        {
          type: 'line',
          attrs: { coordinates: [c1, endCoord] },
          styles: {
            style: ext.dashed ? 'dashed' : 'solid',
            color,
            size: ext.lineWidth || 1.8,
            dashedValue: [6, 3],
          },
        },
        {
          type: 'circle',
          ignoreEvent: true,
          attrs: { x: c1.x, y: c1.y, r: 3.5 },
          styles: { style: 'stroke_fill', color, borderColor: '#ffffff', borderSize: 1.2 },
        },
        {
          type: 'circle',
          ignoreEvent: true,
          attrs: { x: c2.x, y: c2.y, r: 3.5 },
          styles: { style: 'stroke_fill', color, borderColor: '#ffffff', borderSize: 1.2 },
        },
      ];
      if (ext.label) {
        figs.push({
          type: 'text',
          ignoreEvent: true,
          attrs: {
            x: Math.min(bounding.width - 10, Math.max(10, c2.x + 6)),
            y: Math.max(14, Math.min(bounding.height - 10, c2.y - 6)),
            text: ext.label,
            align: 'left',
            baseline: 'bottom',
          },
          styles: {
            color,
            backgroundColor: 'rgba(15, 23, 42, 0.78)',
            borderRadius: 3,
            paddingLeft: 4,
            paddingRight: 4,
            paddingTop: 1,
            paddingBottom: 1,
            size: 10,
            weight: '700',
          },
        });
      }
      return figs;
    },
  });

  // 5. 线性回归标准差通道 (±2σ)
  registerOverlay<{
    startUpper: number;
    endUpper: number;
    startMid: number;
    endMid: number;
    startLower: number;
    endLower: number;
    color?: string;
  }>({
    name: 'regressionChannelOverlay',
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, yAxis, overlay }) => {
      if (coordinates.length < 2 || !yAxis) return [];
      const ext = overlay.extendData;
      if (!ext) return [];
      const x1 = coordinates[0].x;
      const x2 = coordinates[1].x;
      const u1 = yAxis.convertToPixel(ext.startUpper);
      const u2 = yAxis.convertToPixel(ext.endUpper);
      const m1 = yAxis.convertToPixel(ext.startMid);
      const m2 = yAxis.convertToPixel(ext.endMid);
      const l1 = yAxis.convertToPixel(ext.startLower);
      const l2 = yAxis.convertToPixel(ext.endLower);
      const col = ext.color || '#6366f1';
      return [
        {
          type: 'polygon',
          ignoreEvent: true,
          attrs: {
            coordinates: [
              { x: x1, y: u1 },
              { x: x2, y: u2 },
              { x: x2, y: l2 },
              { x: x1, y: l1 },
            ],
          },
          styles: { style: 'fill', color: 'rgba(99, 102, 241, 0.09)' },
        },
        {
          type: 'line',
          ignoreEvent: true,
          attrs: { coordinates: [{ x: x1, y: u1 }, { x: x2, y: u2 }] },
          styles: { style: 'dashed', color: col, size: 1.25, dashedValue: [5, 3] },
        },
        {
          type: 'line',
          ignoreEvent: true,
          attrs: { coordinates: [{ x: x1, y: m1 }, { x: x2, y: m2 }] },
          styles: { style: 'dashed', color: col, size: 1, dashedValue: [2, 3] },
        },
        {
          type: 'line',
          ignoreEvent: true,
          attrs: { coordinates: [{ x: x1, y: l1 }, { x: x2, y: l2 }] },
          styles: { style: 'dashed', color: col, size: 1.25, dashedValue: [5, 3] },
        },
      ];
    },
  });

  // 6. 实盘/回放 B/S 买卖点标记
  registerOverlay<{ side: 'BUY' | 'SELL'; label?: string; isSim?: boolean }>({
    name: 'tradeBsMarker',
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      if (!coordinates[0]) return [];
      const ext = overlay.extendData || { side: 'BUY' as const };
      const isBuy = ext.side === 'BUY';
      const x = coordinates[0].x;
      const y = isBuy ? coordinates[0].y + 15 : coordinates[0].y - 15;
      const fill = isBuy ? '#dc2626' : ext.isSim ? '#16a34a' : '#0f766e';
      return [
        {
          type: 'circle',
          ignoreEvent: true,
          attrs: { x, y, r: 8.5 },
          styles: { style: 'stroke_fill', color: fill, borderColor: '#ffffff', borderSize: 1.4 },
        },
        {
          type: 'text',
          ignoreEvent: true,
          attrs: { x, y: y + 0.5, text: isBuy ? 'B' : 'S', align: 'center', baseline: 'middle' },
          styles: { color: '#ffffff', backgroundColor: 'transparent', size: 10, weight: '800' },
        },
      ];
    },
  });

  // 6b. 量化策略提取 B/S 实时指标标记（与实盘账本 B/S 视觉区分：紫红「策B」/ 湖蓝「策S」胶囊）
  registerOverlay<{ side: 'BUY' | 'SELL'; reason?: string }>({
    name: 'strategyBsMarker',
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      if (!coordinates[0]) return [];
      const ext = overlay.extendData || { side: 'BUY' as const };
      const isBuy = ext.side === 'BUY';
      const x = coordinates[0].x;
      // 偏移到账本 B/S 外侧，双图层同时开启不互相遮挡
      const y = isBuy ? coordinates[0].y + 28 : coordinates[0].y - 28;
      const fill = isBuy ? '#7c3aed' : '#0284c7';
      return [
        {
          type: 'text',
          ignoreEvent: true,
          attrs: { x, y, text: isBuy ? '策B' : '策S', align: 'center', baseline: 'middle' },
          styles: {
            color: '#ffffff',
            backgroundColor: fill,
            borderColor: '#ffffff',
            borderSize: 1.1,
            borderRadius: 4,
            paddingLeft: 4,
            paddingRight: 4,
            paddingTop: 1.5,
            paddingBottom: 1.5,
            size: 9.5,
            weight: '800',
          },
        },
      ];
    },
  });

  // 7. TradingView 风格交互测距尺（框选两根 K 线自动显示涨跌幅、振幅、K线根数、累计成交额）
  registerOverlay({
    name: 'measureRuler',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ chart, coordinates, overlay, bounding }) => {
      if (coordinates.length < 2) return [];
      const [c1, c2] = coordinates;
      const pts = overlay.points || [];
      const p1 = pts[0];
      const p2 = pts[1];
      const v1 = Number(p1?.value ?? 0);
      const v2 = Number(p2?.value ?? 0);
      const diff = v2 - v1;
      const pct = v1 > 0 ? (diff / v1) * 100 : 0;
      const up = diff >= 0;
      const accent = up ? '#ef4444' : '#22c55e';
      const fill = up ? 'rgba(239, 68, 68, 0.14)' : 'rgba(34, 197, 94, 0.14)';

      const dataList = chart.getDataList() || [];
      const idx1 = Math.max(0, Math.min(dataList.length - 1, Number(p1?.dataIndex ?? 0)));
      const idx2 = Math.max(0, Math.min(dataList.length - 1, Number(p2?.dataIndex ?? idx1)));
      const loIdx = Math.min(idx1, idx2);
      const hiIdx = Math.max(idx1, idx2);
      const barCount = Math.abs(hiIdx - loIdx) + 1;

      let hiVal = Math.max(v1, v2);
      let loVal = Math.min(v1, v2);
      let sumAmt = 0;
      for (let i = loIdx; i <= hiIdx; i++) {
        const b = dataList[i];
        if (!b) continue;
        if (b.high > hiVal) hiVal = b.high;
        if (b.low < loVal) loVal = b.low;
        sumAmt += Number(b.turnover || 0);
      }
      const ampPct = loVal > 0 ? ((hiVal - loVal) / loVal) * 100 : 0;
      const amtText = sumAmt >= 1e8 ? `${(sumAmt / 1e8).toFixed(2)}亿` : sumAmt >= 1e4 ? `${(sumAmt / 1e4).toFixed(0)}万` : '';

      const rx = Math.min(c1.x, c2.x);
      const ry = Math.min(c1.y, c2.y);
      const rw = Math.max(2, Math.abs(c2.x - c1.x));
      const rh = Math.max(2, Math.abs(c2.y - c1.y));
      const summary = `${up ? '+' : ''}${diff.toFixed(2)} (${up ? '+' : ''}${pct.toFixed(2)}%) | 振幅 ${ampPct.toFixed(1)}% | ${barCount}根${amtText ? ` | 额 ${amtText}` : ''}`;

      const labelX = Math.max(12, Math.min(bounding.width - 12, rx + rw / 2));
      const labelY = ry > 28 ? ry - 6 : Math.min(bounding.height - 16, ry + rh + 16);

      return [
        {
          type: 'rect',
          attrs: { x: rx, y: ry, width: rw, height: rh },
          styles: {
            style: 'stroke_fill',
            color: fill,
            borderColor: accent,
            borderSize: 1.2,
            borderStyle: 'dashed',
            borderDashedValue: [4, 3],
          },
        },
        {
          type: 'line',
          attrs: { coordinates: [c1, c2] },
          styles: { style: 'solid', color: accent, size: 1.2 },
        },
        {
          type: 'text',
          attrs: { x: labelX, y: labelY, text: summary, align: 'center', baseline: 'bottom' },
          styles: {
            color: '#f8fafc',
            backgroundColor: 'rgba(11, 15, 23, 0.92)',
            borderColor: accent,
            borderSize: 1,
            borderRadius: 4,
            paddingLeft: 7,
            paddingRight: 7,
            paddingTop: 3,
            paddingBottom: 3,
            size: 10.5,
            weight: '700',
            family: 'ui-monospace, Consolas, monospace',
          },
        },
      ];
    },
  });
}

export function computeCandleCountdown(timeframe: 'day' | 'week' | '60m' | '15m' | '1m'): string | null {
  if (timeframe !== '1m' && timeframe !== '15m' && timeframe !== '60m') return null;
  const now = new Date();
  const spanMin = timeframe === '1m' ? 1 : timeframe === '15m' ? 15 : 60;
  const secOfHour = now.getMinutes() * 60 + now.getSeconds();
  const periodSec = spanMin * 60;
  const rem = periodSec - (secOfHour % periodSec);
  const mm = Math.floor(rem / 60);
  const ss = rem % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
