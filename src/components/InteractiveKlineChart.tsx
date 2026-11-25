import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  dispose,
  init,
  type Chart,
  type Crosshair,
  type OverlayMode,
  type Period,
} from 'klinecharts';
import {
  AlertTriangle,
  ArrowUpRight,
  BookmarkPlus,
  Crosshair as CrosshairIcon,
  Eye,
  EyeOff,
  FastForward,
  GitCommitHorizontal,
  Layers,
  Loader2,
  Magnet,
  Maximize2,
  Minimize2,
  Minus,
  Pause,
  Play,
  RotateCcw,
  Ruler,
  Settings2,
  SkipForward,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { requireClientFeature } from '../config/entitlements';
import type {
  ChartDrawing,
  ChartDrawingAlert,
  DailyKlinePoint,
  KlineTimeframe,
  SupportResistanceLevel,
  SymbolTradeMarkers,
  TrendlineAnalysis,
  VolumeProfileBin,
} from '../types';
import {
  BUILTIN_CHART_TEMPLATES,
  DEFAULT_INDICATOR_PARAMS,
  computeCandleCountdown,
  ensureKlineExtensionsRegistered,
  loadStoredChartPrefs,
  saveStoredChartPrefs,
  toKLineDataList,
  type ChartTemplateConfig,
  type ExtendedKLineData,
  type IndicatorParamsMap,
  type MainIndicatorKey,
  type SubIndicatorKey,
  type YAxisScaleKey,
} from './klineExtensions';

export const TIMEFRAME_OPTIONS: { key: KlineTimeframe; label: string; short: string }[] = [
  { key: 'week', label: '周K', short: '周K' },
  { key: 'day', label: '日K (500日)', short: '日K' },
  { key: '60m', label: '60分钟', short: '60分' },
  { key: '15m', label: '15分钟', short: '15分' },
  { key: '1m', label: '1分钟', short: '1分' },
];

type DrawToolId =
  | 'none'
  | 'trendline'
  | 'rayLine'
  | 'hline'
  | 'parallelStraightLine'
  | 'fibonacciLine'
  | 'measureRuler';

interface InteractiveKlineChartProps {
  secid?: string;
  title?: string;
  klines: DailyKlinePoint[];
  timeframe: KlineTimeframe;
  onChangeTimeframe?: (tf: KlineTimeframe) => void;
  loadingTimeframe?: boolean;
  currencySymbol?: string;
  // 6流派支撑压力位与筹码峰叠加
  resistances?: SupportResistanceLevel[];
  supports?: SupportResistanceLevel[];
  poc?: number | null;
  volumeProfileBins?: VolumeProfileBin[];
  turtleStop2N?: number | null;
  // 三大趋势线流派叠加
  trendlines?: TrendlineAnalysis | null;
  // 实盘/模拟交易 B/S 买卖点标记与成本/止损线
  tradeMarkers?: SymbolTradeMarkers | null;
  // 持久化自定义画线与突破预警
  initialDrawings?: ChartDrawing[];
  initialDrawingAlerts?: ChartDrawingAlert[];
  // Bot 盯盘快捷价格预警线（悬停价格轴 + 一键添加，右键/点击移除）
  botPriceAlerts?: { id: string; price: number; condition: 'price_above' | 'price_below'; note?: string }[];
  onAddBotPriceAlert?: (price: number, condition: 'price_above' | 'price_below') => void;
  onDeleteBotPriceAlert?: (id: string) => void;
  onToast?: (msg: string) => void;
  defaultShowSR?: boolean;
  defaultShowVictor?: boolean;
  defaultShowDemark?: boolean;
  defaultShowRegression?: boolean;
  compact?: boolean;
  compactToolbar?: boolean;
  height?: number;
  fillHeight?: boolean;
  hideFullscreenBtn?: boolean;
  isActive?: boolean;
}

const ACTIVE_LIVE_STRATEGY_STORAGE_KEY = 'srw_active_live_strategy_id_v1';

interface LiveStrategySignalPoint {
  date: string;
  barIndex: number;
  side: 'BUY' | 'SELL';
  price: number;
  reason: string;
  strategyId: string;
  strategyName: string;
}

interface PublishedStrategyOption {
  id: string;
  name: string;
  builtinPreset?: boolean;
  metricsSummary?: { totalReturnPct?: number; winRatePct?: number } | null;
}

let cachedPublishedStrategies: PublishedStrategyOption[] | null = null;
let publishedStrategiesInFlight: Promise<PublishedStrategyOption[]> | null = null;

async function fetchPublishedStrategyOptions(force = false): Promise<PublishedStrategyOption[]> {
  if (!force && cachedPublishedStrategies) return cachedPublishedStrategies;
  if (!force && publishedStrategiesInFlight) return publishedStrategiesInFlight;
  publishedStrategiesInFlight = api
    .listPublishedStrategies()
    .then((res) => {
      cachedPublishedStrategies = (res.allStrategies || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        builtinPreset: Boolean(s.builtinPreset),
        metricsSummary: s.metricsSummary || null,
      }));
      return cachedPublishedStrategies;
    })
    .catch(() => cachedPublishedStrategies || [])
    .finally(() => {
      publishedStrategiesInFlight = null;
    });
  return publishedStrategiesInFlight;
}

function readStoredActiveStrategyId(): string {
  try {
    return localStorage.getItem(ACTIVE_LIVE_STRATEGY_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

interface ReplaySimTrade {
  barIdx: number;
  date: string;
  side: 'BUY' | 'SELL';
  price: number;
  pnlPct?: number;
}

const SUB_INDICATOR_OPTIONS: { key: SubIndicatorKey; label: string }[] = [
  { key: 'VOL', label: 'VOL' },
  { key: 'MACD', label: 'MACD' },
  { key: 'KDJ', label: 'KDJ' },
  { key: 'RSI', label: 'RSI' },
  { key: 'BIAS', label: '乖离' },
  { key: 'TURNOVER', label: '换手' },
];

function periodFromTimeframe(tf: KlineTimeframe): Period {
  if (tf === 'week') return { type: 'week', span: 1 };
  if (tf === '60m') return { type: 'minute', span: 60 };
  if (tf === '15m') return { type: 'minute', span: 15 };
  if (tf === '1m') return { type: 'minute', span: 1 };
  return { type: 'day', span: 1 };
}

interface KlineCanvasCoreProps {
  chartHeight: number;
  bars: ExtendedKLineData[];
  timeframe: KlineTimeframe;
  secid?: string;
  currencySymbol: string;
  upColor: string;
  downColor: string;
  mainIndicator: MainIndicatorKey;
  subIndicators: SubIndicatorKey[];
  indicatorParams: IndicatorParamsMap;
  yAxisScale: YAxisScaleKey;
  magnetMode: OverlayMode;
  activeDrawTool: DrawToolId;
  onDrawToolConsumed: () => void;
  drawingsVisible: boolean;
  // Overlay data
  replayActive: boolean;
  showSR: boolean;
  showVictor: boolean;
  showDemark: boolean;
  showRegression: boolean;
  showTradeMarkers: boolean;
  resistances: SupportResistanceLevel[];
  supports: SupportResistanceLevel[];
  poc: number | null;
  volumeProfileBins: VolumeProfileBin[];
  turtleStop2N: number | null;
  trendlines: TrendlineAnalysis | null;
  tradeMarkers: SymbolTradeMarkers | null;
  strategySignals: LiveStrategySignalPoint[];
  simTrades: ReplaySimTrade[];
  simPosPrice: number | null;
  persistedDrawings: ChartDrawing[];
  onDrawingCreated: (d: ChartDrawing) => void;
  botPriceAlerts: { id: string; price: number; condition: 'price_above' | 'price_below'; note?: string }[];
  onAddBotPriceAlert?: (price: number, condition: 'price_above' | 'price_below') => void;
  onDeleteBotPriceAlert?: (id: string) => void;
  chartApiRef: React.MutableRefObject<Chart | null>;
}

const KlineCanvasCore: React.FC<KlineCanvasCoreProps> = ({
  chartHeight,
  bars,
  timeframe,
  secid,
  currencySymbol,
  upColor,
  downColor,
  mainIndicator,
  subIndicators,
  indicatorParams,
  yAxisScale,
  magnetMode,
  activeDrawTool,
  onDrawToolConsumed,
  drawingsVisible,
  replayActive,
  showSR,
  showVictor,
  showDemark,
  showRegression,
  showTradeMarkers,
  resistances,
  supports,
  poc,
  volumeProfileBins,
  turtleStop2N,
  trendlines,
  tradeMarkers,
  strategySignals,
  simTrades,
  simPosPrice,
  persistedDrawings,
  onDrawingCreated,
  botPriceAlerts,
  onAddBotPriceAlert,
  onDeleteBotPriceAlert,
  chartApiRef,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const barsRef = useRef<ExtendedKLineData[]>(bars);
  const subPaneIdsRef = useRef<Map<SubIndicatorKey, string>>(new Map());
  const onDeleteAlertRef = useRef(onDeleteBotPriceAlert);
  const onDrawingCreatedRef = useRef(onDrawingCreated);
  const onDrawToolConsumedRef = useRef(onDrawToolConsumed);

  const [hoverAxisPrice, setHoverAxisPrice] = useState<{ y: number; price: number } | null>(null);
  const [isDarkSurface, setIsDarkSurface] = useState<boolean>(false);

  barsRef.current = bars;
  onDeleteAlertRef.current = onDeleteBotPriceAlert;
  onDrawingCreatedRef.current = onDrawingCreated;
  onDrawToolConsumedRef.current = onDrawToolConsumed;

  // 跟随工作台全局亮/暗主题，保持与工作台整体视觉一致
  useEffect(() => {
    const checkDark = () => {
      const rootDark = document.documentElement.getAttribute('data-theme') === 'dark';
      setIsDarkSurface(rootDark);
    };
    checkDark();
    const obs = new MutationObserver(checkDark);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  // 1. 初始化 klinecharts 实例
  useEffect(() => {
    ensureKlineExtensionsRegistered();
    const el = hostRef.current;
    if (!el) return;

    const chart = init(el, {
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      zoomAnchor: 'cursor',
    });
    if (!chart) return;
    chartRef.current = chart;
    chartApiRef.current = chart;

    // 预留主图顶部留白，避免高点 K 线柱与左上角 OHLC/MA 图例文字重叠
    try {
      chart.overrideYAxis({
        paneId: 'candle_pane',
        gap: { top: 0.24, bottom: 0.1 },
      });
    } catch {
      // ignore if older build
    }

    chart.setDataLoader({
      getBars: ({ type, callback }) => {
        if (type === 'init') {
          callback(barsRef.current, false);
        } else {
          callback([], false);
        }
      },
    });

    // 十字光标变化 -> 驱动右侧价格轴快捷 + Bot 价格预警按钮
    const onCross = (data?: unknown) => {
      const cross = data as Crosshair | undefined;
      if (!cross || cross.y == null || (cross.paneId && cross.paneId !== 'candle_pane')) {
        setHoverAxisPrice(null);
        return;
      }
      const pt = chart.convertFromPixel([{ y: cross.y }], { paneId: 'candle_pane' });
      const first = Array.isArray(pt) ? pt[0] : pt;
      const val = Number(first?.value);
      if (Number.isFinite(val) && val > 0) {
        setHoverAxisPrice({ y: cross.y, price: Number(val.toFixed(2)) });
      } else {
        setHoverAxisPrice(null);
      }
    };
    chart.subscribeAction('onCrosshairChange', onCross);

    const ro = new ResizeObserver(() => {
      chart.resize();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.unsubscribeAction('onCrosshairChange', onCross);
      chartRef.current = null;
      chartApiRef.current = null;
      subPaneIdsRef.current.clear();
      dispose(el);
    };
  }, [chartApiRef]);

  // 2. 应用主题风格 + 涨跌色（支持红涨绿跌 / 国际绿涨红跌 + 暗黑盯盘深炭质感）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const gridCol = isDarkSurface ? 'rgba(30, 39, 54, 0.72)' : 'rgba(203, 213, 225, 0.55)';
    const textCol = isDarkSurface ? '#94a3b8' : '#64748b';
    const axisBorder = isDarkSurface ? '#1e2736' : '#cbd5e1';
    const crossCol = isDarkSurface ? '#64748b' : '#475569';
    const tooltipBg = isDarkSurface ? 'rgba(11, 15, 23, 0.92)' : 'rgba(255, 255, 255, 0.95)';

    chart.setStyles({
      grid: {
        show: true,
        horizontal: { show: true, size: 1, color: gridCol, style: 'dashed', dashedValue: [2, 3] },
        vertical: { show: true, size: 1, color: gridCol, style: 'dashed', dashedValue: [2, 3] },
      },
      candle: {
        type: 'candle_solid',
        bar: {
          compareRule: 'current_open',
          upColor,
          downColor,
          noChangeColor: '#94a3b8',
          upBorderColor: upColor,
          downBorderColor: downColor,
          noChangeBorderColor: '#94a3b8',
          upWickColor: upColor,
          downWickColor: downColor,
          noChangeWickColor: '#94a3b8',
        },
        priceMark: {
          show: true,
          high: { show: true, color: textCol, textSize: 10 },
          low: { show: true, color: textCol, textSize: 10 },
          last: {
            show: true,
            upColor,
            downColor,
            noChangeColor: '#94a3b8',
            line: { show: true, style: 'dashed', dashedValue: [4, 3], size: 1 },
            text: { show: true, size: 11, color: '#ffffff', weight: '700' },
          },
        },
        tooltip: {
          showRule: 'always',
          showType: 'standard',
          rect: { color: tooltipBg, borderColor: axisBorder },
          legend: {
            size: 11,
            color: isDarkSurface ? '#cbd5e1' : '#334155',
            family: 'ui-monospace, Consolas, monospace',
          },
        },
      },
      indicator: {
        ohlc: { upColor, downColor, noChangeColor: '#94a3b8' },
        bars: [
          { style: 'fill', borderStyle: 'solid', borderSize: 1, borderDashedValue: [2, 2], upColor: `${upColor}b0`, downColor: `${downColor}b0`, noChangeColor: '#64748b' },
        ],
        lines: [
          { style: 'solid', smooth: false, size: 1.25, dashedValue: [2, 2], color: '#f59e0b' },
          { style: 'solid', smooth: false, size: 1.25, dashedValue: [2, 2], color: '#38bdf8' },
          { style: 'solid', smooth: false, size: 1.25, dashedValue: [2, 2], color: '#a78bfa' },
          { style: 'solid', smooth: false, size: 1.2, dashedValue: [2, 2], color: '#ec4899' },
        ],
        tooltip: {
          showRule: 'always',
          showType: 'standard',
          title: { show: true, showName: true, showParams: true, color: textCol, size: 10.5 },
          legend: { size: 10.5, color: textCol, family: 'ui-monospace, Consolas, monospace' },
        },
      },
      xAxis: {
        axisLine: { color: axisBorder },
        tickLine: { color: axisBorder },
        tickText: { color: textCol, size: 10.5, family: 'ui-monospace, Consolas, monospace' },
      },
      yAxis: {
        axisLine: { color: axisBorder },
        tickLine: { color: axisBorder },
        tickText: { color: textCol, size: 10.5, family: 'ui-monospace, Consolas, monospace' },
      },
      separator: { size: 1, color: axisBorder, fill: true, activeBackgroundColor: 'rgba(56, 189, 248, 0.25)' },
      crosshair: {
        show: true,
        horizontal: {
          show: true,
          line: { show: true, style: 'dashed', dashedValue: [3, 2], size: 1, color: crossCol },
          text: { show: true, size: 10.5, color: '#ffffff', backgroundColor: '#1e293b', family: 'ui-monospace, Consolas, monospace' },
        },
        vertical: {
          show: true,
          line: { show: true, style: 'dashed', dashedValue: [3, 2], size: 1, color: crossCol },
          text: { show: true, size: 10.5, color: '#ffffff', backgroundColor: '#1e293b', family: 'ui-monospace, Consolas, monospace' },
        },
      },
    });
  }, [isDarkSurface, upColor, downColor]);

  // 3. 同步数据、标的与周期（盲测回放时严格仅喂入 effectiveKlines，绝无未来函数）
  const dataSig = `${secid || ''}|${timeframe}|${bars.length}|${bars[0]?.timestamp || 0}|${bars[bars.length - 1]?.timestamp || 0}|${bars[bars.length - 1]?.close || 0}`;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const samplePrice = bars[bars.length - 1]?.close ?? 10;
    const pricePrecision = samplePrice >= 1000 ? 2 : samplePrice >= 1 ? 2 : 4;
    chart.setSymbol({
      ticker: secid || 'SYMBOL',
      pricePrecision,
      volumePrecision: 0,
    });
    chart.setPeriod(periodFromTimeframe(timeframe));
    chart.resetData();
  }, [dataSig, secid, timeframe, bars]);

  // 4. 同步 Y 轴坐标模式（普通 / 对数 / 百分比）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.overrideYAxis({ paneId: 'candle_pane', name: yAxisScale });
  }, [yAxisScale]);

  // 5. 同步主图指标（MA / EMA / BOLL / NONE）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const name of ['MA', 'EMA', 'BOLL'] as const) {
      chart.removeIndicator({ paneId: 'candle_pane', name });
    }
    if (mainIndicator !== 'NONE') {
      chart.createIndicator(
        {
          name: mainIndicator,
          paneId: 'candle_pane',
          calcParams: indicatorParams[mainIndicator] || DEFAULT_INDICATOR_PARAMS[mainIndicator],
        },
        true
      );
    }
  }, [mainIndicator, indicatorParams]);

  // 6. 同步 1–3 个副图指标（VOL / MACD / KDJ / RSI / BIAS / TURNOVER）与高度
  const subKeySig = subIndicators.join(',');
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // 移除不再开启的副图
    for (const [key, paneId] of Array.from(subPaneIdsRef.current.entries())) {
      if (!subIndicators.includes(key)) {
        chart.removeIndicator({ paneId, name: key });
        subPaneIdsRef.current.delete(key);
      }
    }
    // 新增或更新已开启的副图
    const subH = subIndicators.length >= 3 ? 72 : subIndicators.length === 2 ? 84 : 90;
    for (const key of subIndicators) {
      const params = indicatorParams[key] || DEFAULT_INDICATOR_PARAMS[key];
      const existingPaneId = subPaneIdsRef.current.get(key);
      if (existingPaneId) {
        chart.overrideIndicator({ name: key, paneId: existingPaneId, calcParams: params });
        chart.setPaneOptions({ id: existingPaneId, height: subH });
      } else {
        const paneId = chart.createIndicator({ name: key, calcParams: params }, false);
        if (paneId) {
          subPaneIdsRef.current.set(key, paneId);
          chart.setPaneOptions({ id: paneId, height: subH, minHeight: 54 });
        }
      }
    }
    chart.resize();
  }, [subKeySig, subIndicators, indicatorParams]);

  // 7. 高度变化时触发 resize
  useEffect(() => {
    chartRef.current?.resize();
  }, [chartHeight]);

  // 8. 同步所有业务叠加图层（6流派S/R、筹码峰、三大趋势线、交易账本B/S、盲测B/S、持久化画线、Bot价格预警线）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || bars.length === 0) return;

    // 清除旧的托管图层（保留用户正在手绘的临时分析图形 groupId='user_free'）
    chart.removeOverlay({ groupId: 'srw_managed' });

    const lastBar = bars[bars.length - 1];
    const dateToBar = new Map<string, ExtendedKLineData>();
    bars.forEach((b) => {
      dateToBar.set(b.dateStr, b);
      const d10 = b.dateStr.slice(0, 10);
      if (!dateToBar.has(d10)) dateToBar.set(d10, b);
    });
    const barByIdx = (idx: number) => bars[Math.max(0, Math.min(bars.length - 1, idx))];

    // 8A. 筹码分布直方图 + 6流派支撑/压力位 + POC + 海龟2N止损（盲测模式自动屏蔽防未来泄露）
    if (!replayActive && showSR) {
      if (volumeProfileBins.length > 0) {
        chart.createOverlay({
          name: 'volumeProfileOverlay',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          zLevel: -2,
          points: [{ timestamp: lastBar.timestamp, value: lastBar.close }],
          extendData: { bins: volumeProfileBins, poc },
        });
      }
      resistances.slice(0, 3).forEach((lv) => {
        chart.createOverlay({
          name: 'srLevelLine',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [{ timestamp: lastBar.timestamp, value: lv.price }],
          extendData: {
            label: `${lv.code} ${currencySymbol}${lv.price.toFixed(2)} (${lv.distPct >= 0 ? '+' : ''}${lv.distPct}%)`,
            color: '#ef4444',
            bgColor: 'rgba(127, 29, 29, 0.85)',
            dashed: lv.strength !== '强共振',
            lineWidth: lv.strength === '强共振' ? 1.5 : 1.0,
          },
        });
      });
      supports.slice(0, 3).forEach((lv) => {
        chart.createOverlay({
          name: 'srLevelLine',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [{ timestamp: lastBar.timestamp, value: lv.price }],
          extendData: {
            label: `${lv.code} ${currencySymbol}${lv.price.toFixed(2)} (${lv.distPct >= 0 ? '+' : ''}${lv.distPct}%)`,
            color: '#22c55e',
            bgColor: 'rgba(20, 83, 45, 0.85)',
            dashed: lv.strength !== '强共振',
            lineWidth: lv.strength === '强共振' ? 1.5 : 1.0,
          },
        });
      });
      if (poc != null) {
        chart.createOverlay({
          name: 'srLevelLine',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [{ timestamp: lastBar.timestamp, value: poc }],
          extendData: {
            label: `POC筹码峰 ${currencySymbol}${poc.toFixed(2)}`,
            color: '#a78bfa',
            bgColor: 'rgba(76, 29, 149, 0.85)',
            dashed: true,
            lineWidth: 1.4,
          },
        });
      }
      if (turtleStop2N != null) {
        chart.createOverlay({
          name: 'srLevelLine',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [{ timestamp: lastBar.timestamp, value: turtleStop2N }],
          extendData: {
            label: `2N止损 ${currencySymbol}${turtleStop2N.toFixed(2)}`,
            color: '#f59e0b',
            bgColor: 'rgba(120, 53, 15, 0.85)',
            dashed: true,
            lineWidth: 1.1,
            align: 'left',
          },
        });
      }
    }

    // 8B. 三大流派趋势线（Victor 1-2-3 / DeMark TD / Linear Regression ±2σ）
    if (!replayActive && trendlines) {
      const addSeg = (seg: any, color: string, dashed: boolean) => {
        if (!seg) return;
        const b1 = dateToBar.get(seg.date1) || barByIdx(seg.x1);
        const b2 = dateToBar.get(seg.date2) || barByIdx(seg.x2);
        if (!b1 || !b2 || b1.timestamp === b2.timestamp) return;
        chart.createOverlay({
          name: 'schoolTrendOverlay',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [
            { timestamp: b1.timestamp, value: seg.y1 },
            { timestamp: b2.timestamp, value: seg.y2 },
          ],
          extendData: { label: seg.label, color, dashed, extendRight: true, lineWidth: 1.8 },
        });
      };
      if (showVictor && trendlines.victor) {
        addSeg(trendlines.victor.downLine, '#f43f5e', false);
        addSeg(trendlines.victor.upLine, '#10b981', false);
      }
      if (showDemark && trendlines.demark) {
        addSeg(trendlines.demark.supplyLine, '#f59e0b', true);
        addSeg(trendlines.demark.demandLine, '#14b8a6', true);
        addSeg(trendlines.demark.lowerChannel, '#14b8a6', true);
      }
      if (showRegression && trendlines.regressionChannel) {
        const reg = trendlines.regressionChannel;
        const b1 = dateToBar.get(reg.startDate) || barByIdx(reg.startX);
        const b2 = dateToBar.get(reg.endDate) || barByIdx(reg.endX);
        if (b1 && b2 && b1.timestamp !== b2.timestamp) {
          chart.createOverlay({
            name: 'regressionChannelOverlay',
            groupId: 'srw_managed',
            paneId: 'candle_pane',
            lock: true,
            zLevel: -1,
            points: [
              { timestamp: b1.timestamp, value: reg.startMid },
              { timestamp: b2.timestamp, value: reg.endMid },
            ],
            extendData: {
              startUpper: reg.startUpper,
              endUpper: reg.endUpper,
              startMid: reg.startMid,
              endMid: reg.endMid,
              startLower: reg.startLower,
              endLower: reg.endLower,
              color: '#6366f1',
            },
          });
        }
      }
    }

    // 8C. 实盘交易账本 B/S 买卖点 + 成本线 + 预设硬止损线
    if (!replayActive && showTradeMarkers && tradeMarkers) {
      if (tradeMarkers.avgCostPrice != null) {
        chart.createOverlay({
          name: 'srLevelLine',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [{ timestamp: lastBar.timestamp, value: tradeMarkers.avgCostPrice }],
          extendData: {
            label: `持仓成本 ${currencySymbol}${tradeMarkers.avgCostPrice.toFixed(2)} (${tradeMarkers.holdingQty}股)`,
            color: '#14b8a6',
            bgColor: 'rgba(15, 118, 110, 0.88)',
            dashed: true,
            lineWidth: 1.4,
            align: 'left',
          },
        });
      }
      if (tradeMarkers.stopLossPrice != null) {
        chart.createOverlay({
          name: 'srLevelLine',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [{ timestamp: lastBar.timestamp, value: tradeMarkers.stopLossPrice }],
          extendData: {
            label: `预设硬止损 ${currencySymbol}${tradeMarkers.stopLossPrice.toFixed(2)}`,
            color: '#fb7185',
            bgColor: 'rgba(136, 19, 55, 0.88)',
            dashed: true,
            lineWidth: 1.4,
            align: 'left',
          },
        });
      }
      for (const m of tradeMarkers.markers || []) {
        const b = dateToBar.get(m.date) || dateToBar.get(m.date.slice(0, 10));
        if (!b) continue;
        chart.createOverlay({
          name: 'tradeBsMarker',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [{ timestamp: b.timestamp, value: m.side === 'BUY' ? b.low : b.high }],
          extendData: { side: m.side, isSim: false },
        });
      }
    }

    // 8C-2. 量化策略实时提取 B/S 信号点（全市场任意标的/周期通用叠加）
    if (!replayActive && strategySignals.length > 0) {
      for (const sig of strategySignals) {
        const b = dateToBar.get(sig.date) || dateToBar.get(sig.date.slice(0, 10)) || barByIdx(sig.barIndex);
        if (!b) continue;
        chart.createOverlay({
          name: 'strategyBsMarker',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [{ timestamp: b.timestamp, value: sig.side === 'BUY' ? b.low : b.high }],
          extendData: { side: sig.side, reason: sig.reason },
        });
      }
    }

    // 8D. 盲测回放模拟持仓成本线与模拟 B/S 买卖点
    if (replayActive) {
      if (simPosPrice != null) {
        chart.createOverlay({
          name: 'srLevelLine',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [{ timestamp: lastBar.timestamp, value: simPosPrice }],
          extendData: {
            label: `模拟买入价 ${currencySymbol}${simPosPrice.toFixed(2)}`,
            color: '#ef4444',
            bgColor: 'rgba(127, 29, 29, 0.9)',
            dashed: true,
            lineWidth: 1.5,
            align: 'left',
          },
        });
      }
      for (const sm of simTrades) {
        const b = barByIdx(sm.barIdx);
        if (!b) continue;
        chart.createOverlay({
          name: 'tradeBsMarker',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [{ timestamp: b.timestamp, value: sm.side === 'BUY' ? b.low : b.high }],
          extendData: { side: sm.side, isSim: true },
        });
      }
    }

    // 8E. 持久化用户自定义画线（hline + trendline）
    if (!replayActive && drawingsVisible) {
      for (const d of persistedDrawings) {
        if (d.type === 'hline' && d.price != null) {
          chart.createOverlay({
            name: 'srLevelLine',
            groupId: 'srw_managed',
            paneId: 'candle_pane',
            lock: true,
            points: [{ timestamp: lastBar.timestamp, value: d.price }],
            extendData: {
              label: `★ ${d.label || `预警线 ${d.price}`}`,
              color: d.color || '#f59e0b',
              bgColor: 'rgba(120, 53, 15, 0.88)',
              dashed: true,
              lineWidth: 1.8,
              align: 'left',
            },
          });
        } else if (d.type === 'trendline' && d.date1 && d.date2 && d.price1 != null && d.price2 != null) {
          const b1 = dateToBar.get(d.date1) || dateToBar.get(d.date1.slice(0, 10));
          const b2 = dateToBar.get(d.date2) || dateToBar.get(d.date2.slice(0, 10));
          if (!b1 || !b2 || b1.timestamp === b2.timestamp) continue;
          chart.createOverlay({
            name: 'schoolTrendOverlay',
            groupId: 'srw_managed',
            paneId: 'candle_pane',
            lock: true,
            points: [
              { timestamp: b1.timestamp, value: d.price1 },
              { timestamp: b2.timestamp, value: d.price2 },
            ],
            extendData: {
              label: `★ ${d.label || '手绘趋势线'}`,
              color: d.color || '#3b82f6',
              dashed: false,
              extendRight: d.extendRight !== false,
              lineWidth: 2.1,
            },
          });
        }
      }
    }

    // 8F. Bot 盯盘快捷价格预警线（支持右键删除）
    if (!replayActive) {
      for (const al of botPriceAlerts) {
        const col = al.condition === 'price_above' ? '#f59e0b' : '#38bdf8';
        chart.createOverlay({
          name: 'srLevelLine',
          groupId: 'srw_managed',
          paneId: 'candle_pane',
          lock: true,
          points: [{ timestamp: lastBar.timestamp, value: al.price }],
          extendData: {
            label: `🔔 Bot预警 ${al.condition === 'price_above' ? '≥' : '≤'}${al.price.toFixed(2)} (右键删)`,
            color: col,
            bgColor: 'rgba(11, 15, 23, 0.92)',
            dashed: true,
            lineWidth: 1.5,
            align: 'left',
            alertId: al.id,
          },
          onRightClick: () => {
            onDeleteAlertRef.current?.(al.id);
          },
        });
      }
    }
  }, [
    bars,
    replayActive,
    showSR,
    showVictor,
    showDemark,
    showRegression,
    showTradeMarkers,
    resistances,
    supports,
    poc,
    volumeProfileBins,
    turtleStop2N,
    trendlines,
    tradeMarkers,
    strategySignals,
    simTrades,
    simPosPrice,
    persistedDrawings,
    drawingsVisible,
    botPriceAlerts,
    currencySymbol,
  ]);

  // 9. 响应左侧竖排专业画线工具栏激活（含持久化 trendline/hline 与原生射线/平行通道/斐波那契/测距尺）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || activeDrawTool === 'none') return;

    const mapPointToDate = (pt: { dataIndex?: number; timestamp?: number }) => {
      const list = barsRef.current;
      if (pt.dataIndex != null && list[pt.dataIndex]) return list[pt.dataIndex].dateStr;
      if (pt.timestamp != null) {
        const hit = list.find((b) => b.timestamp === pt.timestamp);
        if (hit) return hit.dateStr;
      }
      return list[list.length - 1]?.dateStr || '';
    };

    if (activeDrawTool === 'hline') {
      chart.createOverlay({
        name: 'horizontalStraightLine',
        groupId: 'user_temp_persist',
        paneId: 'candle_pane',
        mode: magnetMode,
        onDrawEnd: (ev) => {
          const p = ev.overlay.points[0];
          if (p?.value != null) {
            const price = Number(Number(p.value).toFixed(2));
            chart.removeOverlay({ id: ev.overlay.id });
            onDrawingCreatedRef.current({
              id: `dl-${Date.now()}`,
              type: 'hline',
              label: `预警线 ${price}`,
              color: '#f59e0b',
              price,
              alertEnabled: true,
              createdAt: new Date().toISOString(),
            });
          }
          onDrawToolConsumedRef.current();
        },
      });
      return;
    }

    if (activeDrawTool === 'trendline') {
      chart.createOverlay({
        name: 'rayLine',
        groupId: 'user_temp_persist',
        paneId: 'candle_pane',
        mode: magnetMode,
        onDrawEnd: (ev) => {
          const pts = ev.overlay.points;
          if (pts.length >= 2 && pts[0]?.value != null && pts[1]?.value != null) {
            const d1 = mapPointToDate(pts[0]);
            const d2 = mapPointToDate(pts[1]);
            const p1 = Number(Number(pts[0].value).toFixed(2));
            const p2 = Number(Number(pts[1].value).toFixed(2));
            chart.removeOverlay({ id: ev.overlay.id });
            if (d1 && d2 && d1 !== d2) {
              const firstEarlier = d1 <= d2;
              onDrawingCreatedRef.current({
                id: `dl-${Date.now()}`,
                type: 'trendline',
                label: '手绘趋势线',
                color: '#3b82f6',
                date1: firstEarlier ? d1 : d2,
                price1: firstEarlier ? p1 : p2,
                date2: firstEarlier ? d2 : d1,
                price2: firstEarlier ? p2 : p1,
                extendRight: true,
                alertEnabled: true,
                createdAt: new Date().toISOString(),
              });
            }
          }
          onDrawToolConsumedRef.current();
        },
      });
      return;
    }

    // 射线 / 平行通道 / 斐波那契回撤 / 测距尺（直接交由 klinecharts 原生交互与磁吸管理）
    chart.createOverlay({
      name: activeDrawTool,
      groupId: 'user_free',
      paneId: 'candle_pane',
      mode: magnetMode,
      onDrawEnd: () => {
        onDrawToolConsumedRef.current();
      },
    });
  }, [activeDrawTool, magnetMode]);

  // 10. 显隐用户自由画线（user_free）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const freeOverlays = chart.getOverlays({ groupId: 'user_free' });
    freeOverlays.forEach((ov) => {
      chart.overrideOverlay({ id: ov.id, visible: drawingsVisible });
    });
  }, [drawingsVisible]);

  const lastClose = bars[bars.length - 1]?.close ?? null;

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0, height: chartHeight }}>
      <div
        ref={hostRef}
        style={{
          width: '100%',
          height: '100%',
          background: isDarkSurface ? '#080c14' : '#ffffff',
          borderRadius: 6,
          overflow: 'hidden',
        }}
        onDoubleClick={() => {
          // 双击自动复位自适应视图
          chartRef.current?.scrollToRealTime(160);
        }}
      />

      {/* 悬停右侧价格轴快捷 + 创建 Bot 价格预警按钮 */}
      {!replayActive && onAddBotPriceAlert && hoverAxisPrice && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const cond = lastClose != null && hoverAxisPrice.price < lastClose ? 'price_below' : 'price_above';
            onAddBotPriceAlert(hoverAxisPrice.price, cond);
          }}
          title={`点击在 ${hoverAxisPrice.price.toFixed(2)} 添加 Bot 盯盘价格预警线`}
          className="mono"
          style={{
            position: 'absolute',
            right: 4,
            top: Math.max(8, Math.min(chartHeight - 36, hoverAxisPrice.y - 11)),
            zIndex: 12,
            border: '1px solid #f59e0b',
            background: '#f59e0b',
            color: '#0b0f17',
            borderRadius: 4,
            padding: '1px 6px',
            fontSize: 10.5,
            fontWeight: 800,
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          + {hoverAxisPrice.price.toFixed(2)}
        </button>
      )}
    </div>
  );
};

export const InteractiveKlineChart: React.FC<InteractiveKlineChartProps> = ({
  secid,
  title,
  klines,
  timeframe,
  onChangeTimeframe,
  loadingTimeframe = false,
  currencySymbol = '¥',
  resistances = [],
  supports = [],
  poc = null,
  volumeProfileBins = [],
  turtleStop2N = null,
  trendlines = null,
  tradeMarkers = null,
  initialDrawings = [],
  initialDrawingAlerts = [],
  botPriceAlerts = [],
  onAddBotPriceAlert,
  onDeleteBotPriceAlert,
  onToast,
  defaultShowSR = true,
  defaultShowVictor = true,
  defaultShowDemark = true,
  defaultShowRegression = true,
  compact = false,
  compactToolbar = false,
  height = 360,
  fillHeight = false,
  hideFullscreenBtn = false,
  isActive = true,
}) => {
  const { upColor, downColor } = useI18n();
  const chartApiRef = useRef<Chart | null>(null);
  const canvasRowRef = useRef<HTMLDivElement | null>(null);
  const fsCanvasRowRef = useRef<HTMLDivElement | null>(null);
  const [measuredH, setMeasuredH] = useState<number>(height);
  const [fsMeasuredH, setFsMeasuredH] = useState<number>(640);

  // -------------------------------------------------------------------------
  // 盲测回放 Bar Replay（严格零未来函数）
  // -------------------------------------------------------------------------
  const [replayActive, setReplayActive] = useState(false);
  const [replayCutIdx, setReplayCutIdx] = useState<number>(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeedMs, setReplaySpeedMs] = useState<number>(650);
  const [simPosPrice, setSimPosPrice] = useState<number | null>(null);
  const [simTrades, setSimTrades] = useState<ReplaySimTrade[]>([]);
  const [simEquity, setSimEquity] = useState<number>(100);
  const [simPeakEquity, setSimPeakEquity] = useState<number>(100);
  const [simMaxDD, setSimMaxDD] = useState<number>(0);
  const [replayStartIdx, setReplayStartIdx] = useState<number>(0);
  const [replaySummary, setReplaySummary] = useState<{
    totalRetPct: number;
    buyHoldPct: number;
    maxDdPct: number;
    tradesCount: number;
    winRatePct: number | null;
  } | null>(null);

  const effectiveKlines = useMemo(() => {
    if (!replayActive) return klines;
    const end = Math.max(15, Math.min(klines.length - 1, replayCutIdx));
    return klines.slice(0, end + 1);
  }, [klines, replayActive, replayCutIdx]);

  const bars = useMemo(() => toKLineDataList(effectiveKlines), [effectiveKlines]);

  // -------------------------------------------------------------------------
  // 专业技术分析状态：主图/副图组合、参数记忆、模板预设、坐标、画线工具栏、磁吸
  // -------------------------------------------------------------------------
  const [storedPrefs, setStoredPrefs] = useState(() => loadStoredChartPrefs());
  const [mainIndicator, setMainIndicator] = useState<MainIndicatorKey>('MA');
  const [subIndicators, setSubIndicators] = useState<SubIndicatorKey[]>(['VOL']);
  const [yAxisScale, setYAxisScale] = useState<YAxisScaleKey>('normal');
  const [magnetMode, setMagnetMode] = useState<OverlayMode>('weak_magnet');
  const [activeDrawTool, setActiveDrawTool] = useState<DrawToolId>('none');
  const [drawingsVisible, setDrawingsVisible] = useState(true);
  const [showParamEditor, setShowParamEditor] = useState(false);
  const [expandCompactBar, setExpandCompactBar] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateNameDraft, setTemplateNameDraft] = useState('');

  // 图层叠加开关
  const [showSR, setShowSR] = useState(defaultShowSR && (resistances.length > 0 || supports.length > 0));
  const [showVictor, setShowVictor] = useState(defaultShowVictor);
  const [showDemark, setShowDemark] = useState(defaultShowDemark);
  const [showRegression, setShowRegression] = useState(defaultShowRegression);
  const [showTradeMarkers, setShowTradeMarkers] = useState(true);

  // 持久化自定义画线状态
  const [drawings, setDrawings] = useState<ChartDrawing[]>(initialDrawings);
  const [drawingAlerts, setDrawingAlerts] = useState<ChartDrawingAlert[]>(initialDrawingAlerts);
  const [savingDrawing, setSavingDrawing] = useState(false);

  // 盘中分钟级 K 线收线倒计时
  const [countdownText, setCountdownText] = useState<string | null>(() => computeCandleCountdown(timeframe));
  useEffect(() => {
    if (!isActive) return;
    setCountdownText(computeCandleCountdown(timeframe));
    if (timeframe !== '1m' && timeframe !== '15m' && timeframe !== '60m') return;
    const id = setInterval(() => setCountdownText(computeCandleCountdown(timeframe)), 1000);
    return () => clearInterval(id);
  }, [isActive, timeframe]);

  useEffect(() => {
    setDrawings(initialDrawings || []);
    setDrawingAlerts(initialDrawingAlerts || []);
  }, [secid, timeframe, initialDrawings, initialDrawingAlerts]);

  useEffect(() => {
    if (defaultShowSR && (resistances.length > 0 || supports.length > 0)) {
      setShowSR(true);
    }
  }, [defaultShowSR, resistances.length, supports.length]);

  const baseSeriesSig = `${secid || ''}|${timeframe}|${klines.length}|${klines[klines.length - 1]?.date || ''}`;
  useEffect(() => {
    setReplayActive(false);
    setReplayPlaying(false);
    setReplaySummary(null);
    setActiveDrawTool('none');
  }, [baseSeriesSig]);

  useEffect(() => {
    if (!isActive || !replayActive || !replayPlaying) return;
    const timer = setInterval(() => {
      setReplayCutIdx((prev) => {
        if (prev >= klines.length - 1) {
          setReplayPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, replaySpeedMs);
    return () => clearInterval(timer);
  }, [isActive, replayActive, replayPlaying, replaySpeedMs, klines.length]);

  const persistDrawings = async (nextList: ChartDrawing[], msg?: string) => {
    setDrawings(nextList);
    if (!secid) {
      if (msg) onToast?.(msg);
      return;
    }
    setSavingDrawing(true);
    try {
      await api.saveChartDrawings(secid, timeframe, nextList);
      if (msg) onToast?.(msg);
    } catch (err: any) {
      onToast?.(`保存自定义画线失败：${err.message}`);
    } finally {
      setSavingDrawing(false);
    }
  };

  const handleDrawingCreated = (d: ChartDrawing) => {
    persistDrawings([...drawings, d], `已保存${d.type === 'hline' ? '水平预警线' : '手绘趋势线'}并接入盘中突破检测！`);
  };

  const handleClearAllDrawings = () => {
    chartApiRef.current?.removeOverlay({ groupId: 'user_free' });
    if (drawings.length > 0) {
      persistDrawings([], '已清空该标的当前周期的全部自定义画线');
    } else {
      onToast?.('已清空画布上的分析画线');
    }
  };

  const toggleSubIndicator = (key: SubIndicatorKey) => {
    setSubIndicators((prev) => {
      if (prev.includes(key)) {
        return prev.length <= 1 ? prev : prev.filter((x) => x !== key);
      }
      if (prev.length >= 3) {
        return [...prev.slice(1), key];
      }
      return [...prev, key];
    });
  };

  const updateIndicatorParam = (key: keyof IndicatorParamsMap, raw: string) => {
    const nums = raw
      .split(/[,，\s]+/)
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= 300);
    if (nums.length === 0) return;
    const nextPrefs = {
      ...storedPrefs,
      params: { ...storedPrefs.params, [key]: nums },
    };
    setStoredPrefs(nextPrefs);
    saveStoredChartPrefs(nextPrefs);
  };

  // Full-market live strategy B/S overlay selector (synced across all charts)
  const [strategyOptions, setStrategyOptions] = useState<PublishedStrategyOption[]>(() => cachedPublishedStrategies || []);
  const [activeStrategyId, setActiveStrategyId] = useState<string>(() => readStoredActiveStrategyId());
  const [strategySignals, setStrategySignals] = useState<LiveStrategySignalPoint[]>([]);

  useEffect(() => {
    let alive = true;
    fetchPublishedStrategyOptions(false).then((list) => {
      if (alive) setStrategyOptions(list);
    });
    const onChanged = () => {
      cachedPublishedStrategies = null;
      fetchPublishedStrategyOptions(true).then((list) => {
        if (alive) setStrategyOptions(list);
      });
      setActiveStrategyId(readStoredActiveStrategyId());
    };
    window.addEventListener('srw-published-strategies-changed', onChanged);
    return () => {
      alive = false;
      window.removeEventListener('srw-published-strategies-changed', onChanged);
    };
  }, []);

  const klinesEvalSig = `${activeStrategyId}|${secid || ''}|${timeframe}|${klines.length}|${klines[klines.length - 1]?.date || ''}|${klines[klines.length - 1]?.close || ''}`;
  useEffect(() => {
    if (!activeStrategyId || replayActive || klines.length < 10) {
      setStrategySignals([]);
      return;
    }
    let cancelled = false;
    api
      .evaluateStrategySignals({
        strategyId: activeStrategyId,
        klines: klines.slice(-260),
      })
      .then((res) => {
        if (!cancelled && res.ok) setStrategySignals(res.signals || []);
      })
      .catch(() => {
        if (!cancelled) setStrategySignals([]);
      });
    return () => {
      cancelled = true;
    };
  }, [klinesEvalSig, activeStrategyId, replayActive, klines]);

  const handleChangeLiveStrategy = (nextId: string) => {
    setActiveStrategyId(nextId);
    try {
      if (nextId) localStorage.setItem(ACTIVE_LIVE_STRATEGY_STORAGE_KEY, nextId);
      else localStorage.removeItem(ACTIVE_LIVE_STRATEGY_STORAGE_KEY);
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event('srw-published-strategies-changed'));
  };

  const applyTemplate = (tpl: ChartTemplateConfig) => {
    setMainIndicator(tpl.mainIndicator);
    setSubIndicators(tpl.subIndicators.slice(0, 3));
    if (tpl.params) {
      const nextPrefs = {
        ...storedPrefs,
        params: { ...storedPrefs.params, ...tpl.params },
      };
      setStoredPrefs(nextPrefs);
      saveStoredChartPrefs(nextPrefs);
    }
    setShowSR(tpl.showSR);
    setShowVictor(tpl.showVictor);
    setShowDemark(tpl.showDemark);
    setShowRegression(tpl.showRegression);
    setShowTradeMarkers(tpl.showTradeMarkers);
    onToast?.(`已应用图表模板「${tpl.name}」`);
  };

  const handleSaveCustomTemplate = () => {
    setTemplateNameDraft(`自定义模板 ${storedPrefs.customTemplates.length + 1}`);
    setTemplateModalOpen(true);
  };

  const handleConfirmSaveTemplate = () => {
    const cleanName = templateNameDraft.trim();
    if (!cleanName) {
      onToast?.('请输入有效的指标模板名称');
      return;
    }
    const tpl: ChartTemplateConfig = {
      id: `custom-${Date.now()}`,
      name: cleanName,
      mainIndicator,
      subIndicators,
      params: {
        MA: storedPrefs.params.MA,
        EMA: storedPrefs.params.EMA,
        BOLL: storedPrefs.params.BOLL,
        VOL: storedPrefs.params.VOL,
        MACD: storedPrefs.params.MACD,
        KDJ: storedPrefs.params.KDJ,
        RSI: storedPrefs.params.RSI,
        BIAS: storedPrefs.params.BIAS,
        TURNOVER: storedPrefs.params.TURNOVER,
      },
      showSR,
      showVictor,
      showDemark,
      showRegression,
      showTradeMarkers,
    };
    const nextPrefs = {
      ...storedPrefs,
      customTemplates: [...storedPrefs.customTemplates, tpl],
    };
    setStoredPrefs(nextPrefs);
    saveStoredChartPrefs(nextPrefs);
    setTemplateModalOpen(false);
    onToast?.(`已保存自定义指标模板「${tpl.name}」`);
  };

  // Blind Replay Actions
  const startBlindReplay = () => {
    if (!requireClientFeature('bar_replay_trainer')) return;
    if (klines.length < 30) {
      onToast?.('当前 K 线根数少于 30 根，暂不适合盲测回放');
      return;
    }
    const startIdx = Math.max(20, klines.length - Math.min(45, Math.floor(klines.length * 0.4)));
    setReplayStartIdx(startIdx);
    setReplayCutIdx(startIdx);
    setReplayActive(true);
    setReplayPlaying(false);
    setSimPosPrice(null);
    setSimTrades([]);
    setSimEquity(100);
    setSimPeakEquity(100);
    setSimMaxDD(0);
    setReplaySummary(null);
    setActiveDrawTool('none');
    onToast?.(`已进入盲测回放：右侧 ${klines.length - 1 - startIdx} 根未来 K 线已严格遮蔽！`);
  };

  const handleSimBuy = () => {
    if (!replayActive || simPosPrice != null) return;
    const cur = effectiveKlines[effectiveKlines.length - 1];
    if (!cur) return;
    setSimPosPrice(cur.close);
    setSimTrades((prev) => [...prev, { barIdx: effectiveKlines.length - 1, date: cur.date, side: 'BUY', price: cur.close }]);
  };

  const handleSimSell = () => {
    if (!replayActive || simPosPrice == null) return;
    const cur = effectiveKlines[effectiveKlines.length - 1];
    if (!cur) return;
    const pnlPct = ((cur.close - simPosPrice) / simPosPrice) * 100;
    const nextEq = simEquity * (1 + pnlPct / 100);
    const nextPeak = Math.max(simPeakEquity, nextEq);
    const dd = nextPeak > 0 ? ((nextPeak - nextEq) / nextPeak) * 100 : 0;
    setSimEquity(nextEq);
    setSimPeakEquity(nextPeak);
    setSimMaxDD((prev) => Math.max(prev, dd));
    setSimPosPrice(null);
    setSimTrades((prev) => [
      ...prev,
      { barIdx: effectiveKlines.length - 1, date: cur.date, side: 'SELL', price: cur.close, pnlPct: Number(pnlPct.toFixed(2)) },
    ]);
  };

  const finishBlindReplay = () => {
    const startPx = klines[replayStartIdx]?.close || 1;
    const endPx = effectiveKlines[effectiveKlines.length - 1]?.close || startPx;
    let finalEq = simEquity;
    const trades = [...simTrades];
    if (simPosPrice != null) {
      const pnlPct = ((endPx - simPosPrice) / simPosPrice) * 100;
      finalEq = simEquity * (1 + pnlPct / 100);
      trades.push({ barIdx: effectiveKlines.length - 1, date: effectiveKlines[effectiveKlines.length - 1].date, side: 'SELL', price: endPx, pnlPct: Number(pnlPct.toFixed(2)) });
    }
    const sells = trades.filter((t) => t.side === 'SELL');
    const wins = sells.filter((t) => (t.pnlPct ?? 0) > 0).length;
    setReplaySummary({
      totalRetPct: Number((finalEq - 100).toFixed(2)),
      buyHoldPct: Number((((endPx - startPx) / startPx) * 100).toFixed(2)),
      maxDdPct: Number(simMaxDD.toFixed(2)),
      tradesCount: sells.length,
      winRatePct: sells.length > 0 ? Number(((wins / sells.length) * 100).toFixed(1)) : null,
    });
    setReplayActive(false);
    setReplayPlaying(false);
  };

  const cycleMagnet = () => {
    setMagnetMode((cur) => (cur === 'normal' ? 'weak_magnet' : cur === 'weak_magnet' ? 'strong_magnet' : 'normal'));
  };

  useEffect(() => {
    if (!fillHeight) return;
    const el = canvasRowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const syncH = () => {
      const h = Math.max(160, Math.floor(el.getBoundingClientRect().height));
      setMeasuredH((prev) => (Math.abs(prev - h) > 2 ? h : prev));
    };
    syncH();
    const ro = new ResizeObserver(syncH);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fillHeight]);

  useEffect(() => {
    if (!isActive || !isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    const el = fsCanvasRowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return () => window.removeEventListener('keydown', onKey);
    }
    const syncFs = () => {
      const h = Math.max(360, Math.floor(el.getBoundingClientRect().height));
      setFsMeasuredH((prev) => (Math.abs(prev - h) > 2 ? h : prev));
    };
    syncFs();
    const ro = new ResizeObserver(syncFs);
    ro.observe(el);
    return () => {
      window.removeEventListener('keydown', onKey);
      ro.disconnect();
    };
  }, [isActive, isFullscreen]);

  const allTemplates = [...BUILTIN_CHART_TEMPLATES, ...storedPrefs.customTemplates];

  const renderChartBody = (bodyH: number, isFs: boolean, useFill: boolean) => {
    const isUltraCompact = compact && !isFs;
    const useSingleRowBar = compactToolbar && !isFs && !expandCompactBar && !replayActive;
    const showSideToolbar = !isUltraCompact && (isFs || bodyH >= 200);
    const extraSubH = isUltraCompact ? 0 : Math.max(0, (subIndicators.length - 1) * 76);
    const effectiveH = useFill
      ? Math.max(160, isFs ? fsMeasuredH : measuredH)
      : Math.max(isUltraCompact ? 150 : 210, bodyH + (isFs ? 0 : Math.min(extraSubH, 150)));

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: isUltraCompact || useSingleRowBar ? 3 : 5,
          ...(useFill ? { flex: 1, height: '100%', minHeight: 0 } : {}),
        }}
      >
        {/* Single-Row Slim Toolbar for Embedded Cockpit Panes (reclaims ~85px pure K-line height!) */}
        {!isUltraCompact && useSingleRowBar && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexWrap: 'nowrap', overflowX: 'auto', scrollbarWidth: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
              {onChangeTimeframe && (
                <div style={{ display: 'inline-flex', gap: 1, padding: 1, borderRadius: 5, background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>
                  {TIMEFRAME_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      className={`btn btn-sm ${timeframe === opt.key ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ padding: '1px 5px', fontSize: 10.5, height: 20 }}
                      disabled={loadingTimeframe}
                      onClick={() => onChangeTimeframe(opt.key)}
                    >
                      {opt.short}
                    </button>
                  ))}
                </div>
              )}
              {loadingTimeframe && <Loader2 size={12} className="spin" color="var(--navy)" />}
              <span style={{ width: 1, height: 12, background: 'var(--border)', margin: '0 2px' }} />
              {(['MA', 'BOLL'] as MainIndicatorKey[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`btn btn-sm ${mainIndicator === m ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ height: 20, padding: '0 5px', fontSize: 10 }}
                  onClick={() => setMainIndicator(mainIndicator === m ? 'NONE' : m)}
                >
                  {m}
                </button>
              ))}
              {(['VOL', 'MACD', 'KDJ'] as SubIndicatorKey[]).map((k) => {
                const active = subIndicators.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    className={`btn btn-sm ${active ? 'btn-teal' : 'btn-ghost'}`}
                    style={{ height: 20, padding: '0 5px', fontSize: 10 }}
                    onClick={() => toggleSubIndicator(k)}
                  >
                    {k}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ height: 20, padding: '0 4px', fontSize: 10 }}
                onClick={() => chartApiRef.current?.scrollToRealTime(160)}
                title="自动复位视图"
              >
                Auto
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ height: 20, padding: '0 5px', fontSize: 10 }}
                onClick={() => setExpandCompactBar(true)}
                title="展开完整指标模板、盲测回放与 6 流派叠加栏"
              >
                <Settings2 size={11} /> 更多
              </button>
              {!hideFullscreenBtn && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ height: 20, padding: '0 5px' }}
                  onClick={() => setIsFullscreen(true)}
                  title="纯 K 线铺满全屏（ESC 退出）"
                >
                  <Maximize2 size={11} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Row 1: Timeframe + Countdown + Templates + Scale + Replay + Fullscreen */}
        {!isUltraCompact && !useSingleRowBar && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            {onChangeTimeframe && (
              <div style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 6, background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>
                {TIMEFRAME_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={`btn btn-sm ${timeframe === opt.key ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ padding: '2px 7px', fontSize: 11, height: 22 }}
                    disabled={loadingTimeframe}
                    onClick={() => onChangeTimeframe(opt.key)}
                  >
                    {opt.short}
                  </button>
                ))}
              </div>
            )}
            {loadingTimeframe && <Loader2 size={13} className="spin" color="var(--navy)" />}
            {countdownText && !replayActive && (
              <span className="badge badge-amber mono" style={{ fontSize: 10.5, padding: '1px 6px' }} title="当前分钟级别 K 线收线倒计时">
                ⏱ {countdownText}
              </span>
            )}
            {/* Template Preset Dropdown */}
            <select
              className="input"
              style={{ width: 'auto', height: 24, fontSize: 11, padding: '0 6px' }}
              value=""
              onChange={(e) => {
                const hit = allTemplates.find((x) => x.id === e.target.value);
                if (hit) applyTemplate(hit);
              }}
              title="一键套用预设或自定义指标模板"
            >
              <option value="" disabled>
                指标模板...
              </option>
              {allTemplates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.builtin ? '★ ' : '● '}
                  {tpl.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ height: 24, padding: '0 6px', fontSize: 11 }}
              onClick={handleSaveCustomTemplate}
              title="将当前主图/副图/流派开关与参数保存为自定义模板"
            >
              <BookmarkPlus size={12} />
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            {/* Scale Mode: Normal / Logarithm / Percentage */}
            <div style={{ display: 'inline-flex', gap: 1, padding: 1, borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-soft)' }}>
              {[
                { k: 'normal', l: '普通' },
                { k: 'logarithm', l: '对数' },
                { k: 'percentage', l: '%' },
              ].map((sc) => (
                <button
                  key={sc.k}
                  type="button"
                  className={`btn btn-sm ${yAxisScale === sc.k ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ height: 20, padding: '0 5px', fontSize: 10 }}
                  onClick={() => setYAxisScale(sc.k as YAxisScaleKey)}
                >
                  {sc.l}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ height: 24, padding: '0 5px' }}
              onClick={() => chartApiRef.current?.zoomAtCoordinate(0.25, undefined, 120)}
              title="放大 K 线"
            >
              <ZoomIn size={12} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ height: 24, padding: '0 5px' }}
              onClick={() => chartApiRef.current?.zoomAtCoordinate(-0.25, undefined, 120)}
              title="缩小 K 线"
            >
              <ZoomOut size={12} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ height: 24, padding: '0 6px', fontSize: 10.5 }}
              onClick={() => chartApiRef.current?.scrollToRealTime(160)}
              title="自动复位视图（也可双击图表复位）"
            >
              Auto
            </button>

            {!replayActive ? (
              <button
                type="button"
                className="btn btn-sm"
                style={{ height: 24, padding: '0 7px', fontSize: 11 }}
                onClick={startBlindReplay}
                title="遮蔽右侧未来 K 线，逐根推进演练盘感与交易纪律"
              >
                <FastForward size={12} /> 盲测回放
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-amber btn-sm"
                style={{ height: 24, padding: '0 7px', fontSize: 11 }}
                onClick={finishBlindReplay}
              >
                结束盲测并结算
              </button>
            )}

            {compactToolbar && !isFs && expandCompactBar && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ height: 24, padding: '0 6px', fontSize: 10.5 }}
                onClick={() => setExpandCompactBar(false)}
                title="收起为精简单行工具栏"
              >
                收起
              </button>
            )}

            {!isFs && !hideFullscreenBtn && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ height: 24, padding: '0 6px' }}
                onClick={() => setIsFullscreen(true)}
                title="纯 K 线铺满全屏（ESC 退出）"
              >
                <Maximize2 size={12} />
              </button>
            )}
          </div>
        </div>
        )}

        {/* Row 2: Main Indicator + Multi Sub-Panes (1-3) + Parameter Gear + 6-School & B/S Toggles */}
        {!isUltraCompact && !useSingleRowBar && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>主图:</span>
            {(['MA', 'EMA', 'BOLL', 'NONE'] as MainIndicatorKey[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`btn btn-sm ${mainIndicator === m ? 'btn-primary' : 'btn-ghost'}`}
                style={{ height: 21, padding: '0 6px', fontSize: 10.5 }}
                onClick={() => setMainIndicator(m)}
              >
                {m === 'NONE' ? '无' : m}
              </button>
            ))}

            <span style={{ color: 'var(--text-muted)', fontSize: 10.5, marginLeft: 4 }}>副图(1-3):</span>
            {SUB_INDICATOR_OPTIONS.map((opt) => {
              const active = subIndicators.includes(opt.key);
              return (
                <button
                  key={opt.key}
                  type="button"
                  className={`btn btn-sm ${active ? 'btn-teal' : 'btn-ghost'}`}
                  style={{ height: 21, padding: '0 6px', fontSize: 10.5 }}
                  onClick={() => toggleSubIndicator(opt.key)}
                >
                  {opt.label}
                </button>
              );
            })}
            <button
              type="button"
              className={`btn btn-sm ${showParamEditor ? 'btn-primary' : 'btn-ghost'}`}
              style={{ height: 21, padding: '0 5px' }}
              onClick={() => setShowParamEditor((v) => !v)}
              title="自定义主图与副图指标参数（自动记忆到本地）"
            >
              <Settings2 size={11} />
            </button>
          </div>

          {!replayActive && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
              {(resistances.length > 0 || supports.length > 0 || poc != null || volumeProfileBins.length > 0) && (
                <button
                  type="button"
                  className={`btn btn-sm ${showSR ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ height: 21, padding: '0 6px', fontSize: 10.5 }}
                  onClick={() => setShowSR((v) => !v)}
                >
                  <Layers size={10} /> 6流派/筹码
                </button>
              )}
              {trendlines?.victor && (
                <button
                  type="button"
                  className={`btn btn-sm ${showVictor ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ height: 21, padding: '0 6px', fontSize: 10.5 }}
                  onClick={() => setShowVictor((v) => !v)}
                >
                  维克多
                </button>
              )}
              {trendlines?.demark && (
                <button
                  type="button"
                  className={`btn btn-sm ${showDemark ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ height: 21, padding: '0 6px', fontSize: 10.5 }}
                  onClick={() => setShowDemark((v) => !v)}
                >
                  德马克
                </button>
              )}
              {trendlines?.regressionChannel && (
                <button
                  type="button"
                  className={`btn btn-sm ${showRegression ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ height: 21, padding: '0 6px', fontSize: 10.5 }}
                  onClick={() => setShowRegression((v) => !v)}
                >
                  回归通道
                </button>
              )}
              {tradeMarkers && (tradeMarkers.markers.length > 0 || tradeMarkers.avgCostPrice != null) && (
                <button
                  type="button"
                  className={`btn btn-sm ${showTradeMarkers ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ height: 21, padding: '0 6px', fontSize: 10.5 }}
                  onClick={() => setShowTradeMarkers((v) => !v)}
                >
                  B/S账本({tradeMarkers.markers.length})
                </button>
              )}
              {strategyOptions.length > 0 && (
                <select
                  className="input"
                  value={activeStrategyId}
                  onChange={(e) => handleChangeLiveStrategy(e.target.value)}
                  title="将量化回测提取的策略实时叠加到全市场任意标的 K 线上，显示「策B / 策S」买卖信号点"
                  style={{
                    height: 21,
                    padding: '0 6px',
                    fontSize: 10.5,
                    maxWidth: 158,
                    borderColor: activeStrategyId ? '#7c3aed' : 'var(--border)',
                    color: activeStrategyId ? '#7c3aed' : 'var(--text-secondary)',
                    fontWeight: activeStrategyId ? 700 : 500,
                  }}
                >
                  <option value="">策略B/S: 关闭</option>
                  {strategyOptions.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.builtinPreset ? '★ ' : '⚡ '}
                      {st.name}
                    </option>
                  ))}
                </select>
              )}
              {activeStrategyId && strategySignals.length > 0 && (
                <span
                  className="badge mono"
                  style={{ fontSize: 10, padding: '1px 5px', background: 'rgba(124, 58, 237, 0.14)', color: '#7c3aed' }}
                  title={strategySignals.slice(-3).map((s) => `${s.date} ${s.side === 'BUY' ? '策B' : '策S'} @${s.price}: ${s.reason}`).join('\n')}
                >
                  策B:{strategySignals.filter((s) => s.side === 'BUY').length}/策S:{strategySignals.filter((s) => s.side === 'SELL').length}
                </span>
              )}
            </div>
          )}
        </div>
        )}

        {/* Optional Inline Parameter Gear Panel */}
        {showParamEditor && (
          <div
            style={{
              padding: '7px 10px',
              borderRadius: 6,
              border: '1px solid var(--border-strong)',
              background: 'var(--bg-soft)',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 8,
              fontSize: 11,
            }}
          >
            {(['MA', 'EMA', 'BOLL', 'MACD', 'KDJ', 'RSI', 'BIAS'] as (keyof IndicatorParamsMap)[]).map((k) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <strong className="mono" style={{ minWidth: 36 }}>{k}</strong>
                <input
                  className="input mono"
                  style={{ height: 24, padding: '2px 6px', fontSize: 11 }}
                  defaultValue={(storedPrefs.params[k] || DEFAULT_INDICATOR_PARAMS[k]).join(',')}
                  onBlur={(e) => updateIndicatorParam(k, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') updateIndicatorParam(k, (e.target as HTMLInputElement).value);
                  }}
                />
              </label>
            ))}
          </div>
        )}

        {/* Blind Replay Control Strip */}
        {replayActive && (
          <div
            style={{
              padding: '6px 10px',
              borderRadius: 7,
              background: 'rgba(245, 158, 11, 0.14)',
              border: '1px solid rgba(245, 158, 11, 0.45)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              flexWrap: 'wrap',
              fontSize: 11.5,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <strong style={{ color: '#f59e0b' }}>盲测回放中</strong>
              <span className="mono">
                {effectiveKlines[effectiveKlines.length - 1]?.date} ({replayCutIdx + 1}/{klines.length})
              </span>
              <button type="button" className="btn btn-sm btn-primary" style={{ height: 24 }} onClick={() => setReplayPlaying((v) => !v)}>
                {replayPlaying ? <Pause size={12} /> : <Play size={12} />} {replayPlaying ? '暂停' : '播放'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                style={{ height: 24 }}
                onClick={() => setReplayCutIdx((prev) => Math.min(klines.length - 1, prev + 1))}
              >
                <SkipForward size={12} /> +1根
              </button>
              <select
                className="input"
                style={{ width: 72, height: 24, fontSize: 11, padding: '0 4px' }}
                value={replaySpeedMs}
                onChange={(e) => setReplaySpeedMs(Number(e.target.value))}
              >
                <option value={1200}>慢速</option>
                <option value={650}>标准</option>
                <option value={300}>极速</option>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-danger btn-sm" style={{ height: 24 }} disabled={simPosPrice != null} onClick={handleSimBuy}>
                模拟买入
              </button>
              <button type="button" className="btn btn-teal btn-sm" style={{ height: 24 }} disabled={simPosPrice == null} onClick={handleSimSell}>
                模拟卖出
              </button>
              <span className="mono" style={{ fontWeight: 700 }}>
                净值 {simEquity.toFixed(1)} · 回撤 {simMaxDD.toFixed(1)}%
              </span>
            </div>
          </div>
        )}

        {/* Blind Replay Final Summary */}
        {replaySummary && !replayActive && (
          <div
            style={{
              padding: '6px 10px',
              borderRadius: 7,
              background: 'rgba(16, 185, 129, 0.12)',
              border: '1px solid rgba(16, 185, 129, 0.35)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: 11.5,
            }}
          >
            <span>
              <strong>盲测战绩：</strong> 模拟收益 <b className="mono">{replaySummary.totalRetPct >= 0 ? '+' : ''}{replaySummary.totalRetPct}%</b> vs 买入持有{' '}
              <b className="mono">{replaySummary.buyHoldPct >= 0 ? '+' : ''}{replaySummary.buyHoldPct}%</b> · 最大回撤{' '}
              <b className="mono">{replaySummary.maxDdPct}%</b> · 成交 {replaySummary.tradesCount} 笔
              {replaySummary.winRatePct != null ? ` · 胜率 ${replaySummary.winRatePct}%` : ''}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplaySummary(null)}>
              <X size={12} />
            </button>
          </div>
        )}

        {/* Persistent Drawing Breakout Alerts */}
        {!replayActive && drawingAlerts.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {drawingAlerts.map((al, i) => (
              <span key={al.id || i} className="badge badge-crimson" style={{ fontSize: 11 }} title={al.actionAdvice}>
                <AlertTriangle size={11} /> {al.ruleName}（现 {al.actualValue} / 线 {al.threshold}）
              </span>
            ))}
          </div>
        )}

        {/* Main Canvas Row: Left Vertical Professional Drawing Toolbar + klinecharts Canvas */}
        <div
          ref={isFs ? fsCanvasRowRef : canvasRowRef}
          style={{
            display: 'flex',
            gap: 5,
            alignItems: 'stretch',
            ...(useFill ? { flex: 1, minHeight: 160 } : {}),
          }}
        >
          {showSideToolbar && !replayActive && (
            <div
              style={{
                width: 30,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 3,
                padding: '4px 2px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-soft)',
              }}
            >
              {[
                { id: 'none' as const, icon: <CrosshairIcon size={13} />, title: '十字光标 / 退出画线' },
                { id: 'trendline' as const, icon: <TrendingUp size={13} />, title: '趋势线（自动持久保存并参与盘中突破预警）' },
                { id: 'rayLine' as const, icon: <ArrowUpRight size={13} />, title: '射线（Ray Line）' },
                { id: 'hline' as const, icon: <Minus size={13} />, title: '水平支撑/压力预警线（自动持久保存）' },
                { id: 'parallelStraightLine' as const, icon: <SlidersHorizontal size={13} />, title: '平行通道（Parallel Channel）' },
                { id: 'fibonacciLine' as const, icon: <GitCommitHorizontal size={13} />, title: '斐波那契回撤（Fibonacci）' },
                { id: 'measureRuler' as const, icon: <Ruler size={13} />, title: '测距尺（自动计算涨跌幅/振幅/K线根数/累计成交额）' },
              ].map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  onClick={() => setActiveDrawTool(tool.id)}
                  title={tool.title}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 4,
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: activeDrawTool === tool.id ? 'var(--navy)' : 'transparent',
                    color: activeDrawTool === tool.id ? '#ffffff' : 'var(--text-secondary)',
                  }}
                >
                  {tool.icon}
                </button>
              ))}

              <div style={{ width: 18, height: 1, background: 'var(--border)', margin: '2px 0' }} />

              <button
                type="button"
                onClick={cycleMagnet}
                title={`磁吸模式：${magnetMode === 'strong_magnet' ? '强磁吸(紧贴K线OHLC)' : magnetMode === 'weak_magnet' ? '弱磁吸' : '关闭'}（点击切换）`}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: magnetMode !== 'normal' ? 'rgba(245, 158, 11, 0.2)' : 'transparent',
                  color: magnetMode === 'strong_magnet' ? '#f59e0b' : magnetMode === 'weak_magnet' ? '#38bdf8' : 'var(--text-muted)',
                }}
              >
                <Magnet size={13} />
              </button>

              <button
                type="button"
                onClick={() => setDrawingsVisible((v) => !v)}
                title={drawingsVisible ? '一键隐藏画线' : '显示画线'}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'transparent',
                  color: drawingsVisible ? 'var(--text-secondary)' : '#f59e0b',
                }}
              >
                {drawingsVisible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>

              <button
                type="button"
                onClick={handleClearAllDrawings}
                disabled={savingDrawing}
                title="清空画线"
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'transparent',
                  color: 'var(--crimson)',
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )}

          {bars.length === 0 ? (
            <div style={{ flex: 1, height: effectiveH, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
              暂无 K 线数据
            </div>
          ) : (
            <KlineCanvasCore
              chartHeight={effectiveH}
              bars={bars}
              timeframe={timeframe}
              secid={secid}
              currencySymbol={currencySymbol}
              upColor={upColor}
              downColor={downColor}
              mainIndicator={mainIndicator}
              subIndicators={subIndicators}
              indicatorParams={storedPrefs.params}
              yAxisScale={yAxisScale}
              magnetMode={magnetMode}
              activeDrawTool={activeDrawTool}
              onDrawToolConsumed={() => setActiveDrawTool('none')}
              drawingsVisible={drawingsVisible}
              replayActive={replayActive}
              showSR={showSR}
              showVictor={showVictor}
              showDemark={showDemark}
              showRegression={showRegression}
              showTradeMarkers={showTradeMarkers}
              resistances={resistances}
              supports={supports}
              poc={poc}
              volumeProfileBins={volumeProfileBins}
              turtleStop2N={turtleStop2N}
              trendlines={trendlines}
              tradeMarkers={tradeMarkers}
              strategySignals={strategySignals}
              simTrades={simTrades}
              simPosPrice={simPosPrice}
              persistedDrawings={drawings}
              onDrawingCreated={handleDrawingCreated}
              botPriceAlerts={botPriceAlerts}
              onAddBotPriceAlert={onAddBotPriceAlert}
              onDeleteBotPriceAlert={onDeleteBotPriceAlert}
              chartApiRef={chartApiRef}
            />
          )}
        </div>

        {/* Active Persisted Drawings & Bot Alert Chips Bar (click × to remove effortlessly) */}
        {!replayActive && (drawings.length > 0 || botPriceAlerts.length > 0) && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', fontSize: 10.5 }}>
            {botPriceAlerts.map((al) => (
              <span
                key={`chip-al-${al.id}`}
                className="badge badge-amber mono"
                style={{ fontSize: 10, padding: '1px 6px', cursor: onDeleteBotPriceAlert ? 'pointer' : 'default' }}
                onClick={() => onDeleteBotPriceAlert?.(al.id)}
                title="点击移除该 Bot 价格预警线"
              >
                🔔 {al.condition === 'price_above' ? '≥' : '≤'}
                {al.price.toFixed(2)} ×
              </span>
            ))}
            {drawings.map((d) => (
              <span
                key={`chip-dr-${d.id}`}
                className="badge badge-navy mono"
                style={{ fontSize: 10, padding: '1px 6px', cursor: 'pointer' }}
                onClick={() => persistDrawings(drawings.filter((x) => x.id !== d.id), `已删除画线「${d.label}」`)}
                title="点击删除该持久化预警画线"
              >
                ★ {d.label || (d.type === 'hline' ? `水平线 ${d.price}` : '趋势线')} ×
              </span>
            ))}
          </div>
        )}

        {activeDrawTool !== 'none' && (
          <div style={{ fontSize: 11, color: '#f59e0b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>
              画线模式已激活：请在 K 线图上点击定位锚点（当前磁吸：
              {magnetMode === 'strong_magnet' ? '强磁吸' : magnetMode === 'weak_magnet' ? '弱磁吸' : '关'}）
            </span>
            <button type="button" className="btn btn-ghost btn-sm" style={{ height: 20, fontSize: 10.5 }} onClick={() => setActiveDrawTool('none')}>
              <RotateCcw size={10} /> 取消
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {!isFullscreen && renderChartBody(height, false, fillHeight)}

      {isFullscreen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            width: '100vw',
            height: '100vh',
            zIndex: 1550,
            background: 'var(--bg-elev)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: 40,
              flexShrink: 0,
              padding: '0 14px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-sidebar)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <strong style={{ fontSize: 13.5, color: 'var(--text)' }}>
              {title || '专业 K 线引擎'} · 全屏 K 线视图（盲测回放 / 6流派点位 / 筹码峰 / 画线预警 / B/S 账本）
            </strong>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setIsFullscreen(false)}
              title="退出全屏 (ESC)"
            >
              <Minimize2 size={13} /> 退出全屏 (ESC)
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, padding: '8px 12px', display: 'flex', flexDirection: 'column' }}>
            {renderChartBody(fsMeasuredH, true, true)}
          </div>
        </div>
      )}

      {templateModalOpen && (
        <div className="modal-backdrop" style={{ zIndex: 1700 }} onClick={() => setTemplateModalOpen(false)}>
          <div className="modal-box" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong style={{ fontSize: 14 }}>保存自定义图表指标模板</strong>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTemplateModalOpen(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="modal-body">
              <label className="field-label">模板名称（例如：龙头低吸模板）</label>
              <input
                className="input"
                autoFocus
                value={templateNameDraft}
                onChange={(e) => setTemplateNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirmSaveTemplate();
                }}
              />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-sm" onClick={() => setTemplateModalOpen(false)}>
                取消
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={handleConfirmSaveTemplate}>
                保存模板
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
