import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BellPlus,
  BookOpen,
  Calculator,
  Columns2,
  Database,
  ExternalLink,
  Flame,
  Gauge,
  Grid2x2,
  LayoutGrid,
  Loader2,
  Lock,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  RefreshCw,
  RotateCcw,
  Rows2,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { requireClientFeature } from '../config/entitlements';
import type { DataSourceChannelId, KlineTimeframe, SecurityDetailData, StockOrderBookResponse, WatchlistQuoteItem } from '../types';
import { IntradayVolumeChart } from '../components/IntradayVolumeChart';
import { InteractiveKlineChart } from '../components/InteractiveKlineChart';
import { OrderBookPanel } from '../components/OrderBookPanel';
import { MultiChartTile } from '../components/MultiChartTile';
import { TradePlanCardModal } from '../components/TradePlanCardModal';
import { useSlimeBot } from '../contexts/SlimeBotContext';

interface ShortTermWatchPageProps {
  isActive?: boolean;
  externalSelectedSecid?: string | null;
  onConsumeExternalSelect?: () => void;
  onActiveStockChange?: (info: { secid: string; code: string; name: string }) => void;
  onOpenFullscreenStock: (secidOrQuery: string) => void;
  onOpenDataSources?: (channel?: DataSourceChannelId) => void;
  onNavigateTab?: (tab: any) => void;
  onOpenUnifiedReview?: () => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

type LayoutScreens = '1' | '2h' | '2v' | '4';
type LeftPoolTab = 'constituents' | 'lianban' | 'auction' | 'seal' | 'gainers' | 'inflow' | 'anomaly' | 'losers';
type RightDockTab = 'sprite' | 'watchlist' | 'hot' | 'news' | 'catalyst';
type WidgetId = 'sectors' | 'pool' | 'temp' | 'orderbook' | 'signals' | 'watchlist';
type RowDensity = 'compact' | 'comfort';

interface CockpitPrefs {
  leftWidth: number;
  rightWidth: number;
  leftSplitPct: number;
  centerSplitPct: number;
  rightSplitPct: number;
  showLeft: boolean;
  showRight: boolean;
  showIntraday: boolean;
  showKline: boolean;
  density: RowDensity;
  screens: LayoutScreens;
  slots: {
    leftTop: WidgetId;
    leftBottom: WidgetId;
    rightTop: WidgetId;
    rightBottom: WidgetId;
  };
}

const PREFS_KEY = 'srw_st_cockpit_layout_v2';

const DEFAULT_PREFS: CockpitPrefs = {
  leftWidth: 292,
  rightWidth: 326,
  leftSplitPct: 43,
  centerSplitPct: 44,
  rightSplitPct: 50,
  showLeft: true,
  showRight: true,
  showIntraday: true,
  showKline: true,
  density: 'compact',
  screens: '1',
  slots: {
    leftTop: 'sectors',
    leftBottom: 'pool',
    rightTop: 'orderbook',
    rightBottom: 'signals',
  },
};

const COCKPIT_PRESETS: { id: string; labelZh: string; labelEn: string; descZh: string; descEn: string; patch: Partial<CockpitPrefs> }[] = [
  {
    id: 'balanced',
    labelZh: '全能三栏',
    labelEn: 'Balanced 3-Col',
    descZh: '左板块+股池 · 中分时+K线 · 右盘口+精灵',
    descEn: 'Left Sectors+Pool · Center Intraday+K-Line · Right Book+Feed',
    patch: {
      leftWidth: 292,
      rightWidth: 326,
      leftSplitPct: 43,
      centerSplitPct: 44,
      rightSplitPct: 50,
      showLeft: true,
      showRight: true,
      showIntraday: true,
      showKline: true,
      screens: '1',
      density: 'compact',
      slots: { leftTop: 'sectors', leftBottom: 'pool', rightTop: 'orderbook', rightBottom: 'signals' },
    },
  },
  {
    id: 'daban',
    labelZh: '龙头打板',
    labelEn: 'Limit-Up Trader',
    descZh: '强化连板梯队、封单竞价、五档盘口与短线精灵',
    descEn: 'Focus on streaks, auction/seals, order book & tape sprite',
    patch: {
      leftWidth: 332,
      rightWidth: 350,
      leftSplitPct: 36,
      centerSplitPct: 52,
      rightSplitPct: 48,
      showLeft: true,
      showRight: true,
      showIntraday: true,
      showKline: true,
      screens: '1',
      density: 'compact',
      slots: { leftTop: 'sectors', leftBottom: 'pool', rightTop: 'orderbook', rightBottom: 'signals' },
    },
  },
  {
    id: 'chart_focus',
    labelZh: '大图精研',
    labelEn: 'Chart Focus',
    descZh: '收起左侧池，最大化主图分时与K线空间',
    descEn: 'Hide left pool to maximize intraday & K-line canvas',
    patch: {
      leftWidth: 270,
      rightWidth: 310,
      centerSplitPct: 38,
      rightSplitPct: 54,
      showLeft: false,
      showRight: true,
      showIntraday: true,
      showKline: true,
      screens: '1',
      density: 'comfort',
      slots: { leftTop: 'sectors', leftBottom: 'pool', rightTop: 'orderbook', rightBottom: 'signals' },
    },
  },
  {
    id: 'quad',
    labelZh: '四屏同看',
    labelEn: 'Quad Monitor',
    descZh: '分时 + 15m + 日K + 上证大盘四屏同步',
    descEn: 'Intraday + 15m + Daily + SSE Index quad sync',
    patch: {
      leftWidth: 266,
      rightWidth: 310,
      showLeft: true,
      showRight: true,
      screens: '4',
    },
  },
];

const WIDGET_LABELS: Record<WidgetId, { zh: string; en: string }> = {
  sectors: { zh: '主线板块与温度', en: 'Leading Sectors & Temp' },
  pool: { zh: '联动核心股池', en: 'Linked Stock Pool' },
  temp: { zh: '微观盘面温度 9 格', en: 'Market Micro Temp (9-Grid)' },
  orderbook: { zh: '五档/L2 盘口与分笔', en: 'Order Book & Ticks' },
  signals: { zh: '精灵/自选/热股/电报', en: 'Sprite / Watch / Hot / News' },
  watchlist: { zh: '我的自选盯盘', en: 'My Watchlist' },
};

function loadCockpitPrefs(): CockpitPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw);
    return {
      ...DEFAULT_PREFS,
      ...p,
      leftWidth: Math.max(210, Math.min(440, Number(p.leftWidth) || DEFAULT_PREFS.leftWidth)),
      rightWidth: Math.max(250, Math.min(460, Number(p.rightWidth) || DEFAULT_PREFS.rightWidth)),
      leftSplitPct: Math.max(24, Math.min(72, Number(p.leftSplitPct) || DEFAULT_PREFS.leftSplitPct)),
      centerSplitPct: Math.max(24, Math.min(72, Number(p.centerSplitPct) || DEFAULT_PREFS.centerSplitPct)),
      rightSplitPct: Math.max(26, Math.min(74, Number(p.rightSplitPct) || DEFAULT_PREFS.rightSplitPct)),
      slots: { ...DEFAULT_PREFS.slots, ...(p.slots || {}) },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const MiniSparkline: React.FC<{ points: { p: number }[]; preClose?: number | null; color: string }> = ({
  points,
  preClose,
  color,
}) => {
  if (!points || points.length < 2) {
    return <div style={{ height: 34, display: 'flex', alignItems: 'center', fontSize: 10, color: 'var(--text-muted)' }}>--</div>;
  }
  const vals = points.map((x) => x.p);
  const base = preClose && preClose > 0 ? preClose : vals[0];
  const minV = Math.min(...vals, base);
  const maxV = Math.max(...vals, base);
  const span = Math.max(0.0001, maxV - minV);
  const w = 132;
  const h = 34;
  const d = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - 3 - ((v - minV) / span) * (h - 6);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const baseY = h - 3 - ((base - minV) / span) * (h - 6);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
      <line x1={0} y1={baseY} x2={w} y2={baseY} stroke="var(--border-strong)" strokeDasharray="2 2" strokeWidth={0.8} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
};

export const ShortTermWatchPage: React.FC<ShortTermWatchPageProps> = ({
  isActive = true,
  externalSelectedSecid,
  onConsumeExternalSelect,
  onActiveStockChange,
  onOpenFullscreenStock,
  onOpenDataSources,
  onNavigateTab,
  onOpenUnifiedReview,
  onToast,
}) => {
  const { t, pctColor, formatPct, formatYi, upColor, downColor } = useI18n();
  const { watchState, setContextPill, addPriceAlertQuick, deleteWatchAlertQuick } = useSlimeBot();

  const [viewMode, setViewMode] = useState<'cockpit' | 'panoramic'>('cockpit');
  const [prefs, setPrefs] = useState<CockpitPrefs>(() => loadCockpitPrefs());
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [showPlanCard, setShowPlanCard] = useState(false);
  const [draggingHandle, setDraggingHandle] = useState<string | null>(null);

  const [data, setData] = useState<any | null>(null);
  const [feeds, setFeeds] = useState<any | null>(null);
  const [auctionData, setAuctionData] = useState<any | null>(null);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistQuoteItem[]>([]);
  const [subSourceErrors, setSubSourceErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoSec, setAutoSec] = useState<number>(30);

  // Cross-module Sector -> Constituents linkage
  const [sectorKind, setSectorKind] = useState<'concept' | 'industry'>('concept');
  const [selectedSector, setSelectedSector] = useState<{ code: string; name: string; pct?: number | null } | null>(null);
  const [sectorConstituents, setSectorConstituents] = useState<any[]>([]);
  const [loadingConstituents, setLoadingConstituents] = useState(false);

  const [leftPoolTab, setLeftPoolTab] = useState<LeftPoolTab>('lianban');
  const [rightDockTab, setRightDockTab] = useState<RightDockTab>('sprite');
  const [spriteSide, setSpriteSide] = useState<'all' | 'bull' | 'bear' | 'limit'>('all');

  // Linked Primary Symbol & Multi-Chart Pane Overrides（零作者硬编码：从当前空间自选或实时榜单动态初始化）
  const [selectedSecid, setSelectedSecid] = useState<string>(() => externalSelectedSecid || '');
  const [selectedNameHint, setSelectedNameHint] = useState<string>('');
  const [primaryTf, setPrimaryTf] = useState<KlineTimeframe>('day');
  const [primaryDetail, setPrimaryDetail] = useState<SecurityDetailData | null>(null);
  const [loadingPrimary, setLoadingPrimary] = useState(false);
  const [activeOrderBook, setActiveOrderBook] = useState<StockOrderBookResponse | null>(null);
  const [expandedFeedIds, setExpandedFeedIds] = useState<Record<string, boolean>>({});

  // Multi-Chart independent pane config
  const [paneLinked, setPaneLinked] = useState<Record<string, boolean>>({ p1: true, p2: true, p3: true, p4: false });
  const [paneSecids, setPaneSecids] = useState<Record<string, string>>({
    p1: '',
    p2: '',
    p3: '',
    p4: '1.000001',
  });

  // Refs for drag-resizing columns & splits
  const leftColRef = useRef<HTMLDivElement | null>(null);
  const centerColRef = useRef<HTMLDivElement | null>(null);
  const rightColRef = useRef<HTMLDivElement | null>(null);

  // Quick Ticker Switcher ('/' hotkey)
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);

  // Panoramic sub-states
  const [indexView, setIndexView] = useState<'sse' | 'chinext'>('sse');

  const updatePrefs = useCallback((updater: Partial<CockpitPrefs> | ((prev: CockpitPrefs) => CockpitPrefs)) => {
    setPrefs((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // ignore storage quota errors
      }
      return next;
    });
  }, []);

  // Stable callback refs so parent re-renders (e.g. 2s job polling or error toasts) NEVER retrigger full-page market fetches
  const onActiveStockChangeRef = useRef(onActiveStockChange);
  onActiveStockChangeRef.current = onActiveStockChange;
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const tRef = useRef(t);
  tRef.current = t;
  const loadAllInFlightRef = useRef<Promise<void> | null>(null);
  const loadAllSeqRef = useRef(0);
  // 区分「页内自动初始化默认图表标的」与「用户主动点选/搜索/跳转标的」，自动回退绝不污染全屏研股的最近查看历史
  const userInitiatedSelectionRef = useRef(false);

  const selectStock = useCallback((secid: string, name?: string) => {
    if (!secid) return;
    userInitiatedSelectionRef.current = true;
    setSelectedSecid((prev) => {
      if (prev !== secid) setActiveOrderBook(null);
      return secid;
    });
    if (name) setSelectedNameHint(name);
    onActiveStockChangeRef.current?.({
      secid,
      code: secid.replace(/^\d+\./, ''),
      name: name || '',
    });
    setSearchOpen(false);
    setSearchQuery('');
  }, []);

  // Click Sector -> Fetch real constituent stocks & focus sector leader!
  const handleSelectSector = useCallback(
    async (sec: { code: string; name: string; pct?: number | null; leaderCode?: string; leaderName?: string }) => {
      setSelectedSector({ code: sec.code, name: sec.name, pct: sec.pct });
      setLeftPoolTab('constituents');
      setLoadingConstituents(true);
      if (sec.leaderCode) {
        const leaderSecid = sec.leaderCode.startsWith('6') ? `1.${sec.leaderCode}` : `0.${sec.leaderCode}`;
        selectStock(leaderSecid, sec.leaderName || sec.name);
      }
      try {
        const res = await api.getShortTermThemesRange({ themeCode: sec.code });
        const flattened: any[] = [];
        for (const tier of res?.themeTiers || []) {
          for (const st of tier.stocks || []) {
            flattened.push({ ...st, tierLabel: tier.tier });
          }
        }
        setSectorConstituents(flattened);
        if (!sec.leaderCode && flattened[0]?.secid) {
          selectStock(flattened[0].secid, flattened[0].name);
        }
      } catch {
        setSectorConstituents([]);
      } finally {
        setLoadingConstituents(false);
      }
    },
    [selectStock]
  );

  // Smooth Pointer Drag Resizing for Columns & Vertical Splits
  const startVerticalDrag = (side: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === 'left' ? prefs.leftWidth : prefs.rightWidth;
    setDraggingHandle(side);
    const onMove = (mv: MouseEvent) => {
      const dx = mv.clientX - startX;
      if (side === 'left') {
        updatePrefs((p) => ({ ...p, leftWidth: Math.max(210, Math.min(440, Math.round(startW + dx))) }));
      } else {
        updatePrefs((p) => ({ ...p, rightWidth: Math.max(250, Math.min(460, Math.round(startW - dx))) }));
      }
    };
    const onUp = () => {
      setDraggingHandle(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startHorizontalDrag = (
    col: 'left' | 'center' | 'right',
    containerRef: React.RefObject<HTMLDivElement | null>,
    e: React.MouseEvent
  ) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    setDraggingHandle(`${col}-h`);
    const onMove = (mv: MouseEvent) => {
      const pct = Math.round(((mv.clientY - rect.top) / rect.height) * 100);
      const clamped = Math.max(24, Math.min(74, pct));
      if (col === 'left') updatePrefs((p) => ({ ...p, leftSplitPct: clamped }));
      else if (col === 'center') updatePrefs((p) => ({ ...p, centerSplitPct: clamped }));
      else updatePrefs((p) => ({ ...p, rightSplitPct: clamped }));
    };
    const onUp = () => {
      setDraggingHandle(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  useEffect(() => {
    if (externalSelectedSecid) {
      selectStock(externalSelectedSecid);
      onConsumeExternalSelect?.();
    }
  }, [externalSelectedSecid, selectStock, onConsumeExternalSelect]);

  const loadAll = useCallback(async (force = false) => {
    // 非强制刷新时复用正在进行中的同轮请求，避免高频切票或定时器重入并发轰炸
    if (!force && loadAllInFlightRef.current) {
      return loadAllInFlightRef.current;
    }
    const reqSeq = ++loadAllSeqRef.current;
    if (force) setRefreshing(true);

    const runPromise = (async () => {
      const nextErrors: Record<string, string> = {};
      const tr = tRef.current;
      try {
        const [dashRes, newsRes, wlRes, aucRes] = await Promise.allSettled([
          api.getShortTermDashboard(force),
          api.getShortTermNewsFeeds(),
          api.getWatchlistLive(false),
          api.getAuctionRadar(),
        ]);

        // 忽略已被更新请求替代的过期响应
        if (reqSeq !== loadAllSeqRef.current) return;

        let dash: any = null;
        if (dashRes.status === 'fulfilled') {
          dash = dashRes.value;
          setData(dash);
          if (dash?.dataStatus === 'error' || dash?.ok === false) {
            nextErrors.dash =
              Object.values(dash?.sectionErrors || {}).join('；') || tr('核心盘面数据源异常', 'Core market feed error');
          } else if (Array.isArray(dash?.degradedSections) && dash.degradedSections.length > 0) {
            nextErrors.dash = `${tr('部分降级：', 'Partial degradation: ')}${dash.degradedSections.join(', ')}`;
          }
        } else {
          nextErrors.dash = dashRes.reason?.message || tr('核心盘面加载失败', 'Core dashboard failed');
        }

        if (newsRes.status === 'fulfilled' && newsRes.value) {
          setFeeds(newsRes.value);
        } else {
          nextErrors.news =
            newsRes.status === 'rejected'
              ? newsRes.reason?.message || tr('短线精灵/快讯源异常', 'Tape sprite & news feed failed')
              : tr('短线精灵/快讯返回为空', 'Empty news feed');
        }

        let liveWl: WatchlistQuoteItem[] = [];
        if (wlRes.status === 'fulfilled' && wlRes.value) {
          liveWl = wlRes.value.items || [];
          setWatchlistItems(liveWl);
        } else {
          nextErrors.watchlist =
            wlRes.status === 'rejected'
              ? wlRes.reason?.message || tr('自选报价源异常', 'Watchlist quote feed failed')
              : tr('自选报价不可用', 'Watchlist unavailable');
        }

        if (aucRes.status === 'fulfilled' && aucRes.value) {
          setAuctionData(aucRes.value);
        } else {
          nextErrors.auction =
            aucRes.status === 'rejected'
              ? aucRes.reason?.message || tr('竞价/封单源异常', 'Auction & seal feed failed')
              : tr('竞价/封单不可用', 'Auction data unavailable');
        }

        setSubSourceErrors(nextErrors);

        // 动态选定首个真实焦点标的（优先当前空间自选 -> 其次实时连板/涨幅榜，绝不硬编码作者私股）
        const fallbackPool = [
          ...liveWl.map((x) => ({ secid: x.secid, name: x.name })),
          ...((dash?.leaderboards?.lianban || []) as any[]).map((x) => ({ secid: x.secid, name: x.name })),
          ...((dash?.leaderboards?.gainers || []) as any[]).map((x) => ({ secid: x.secid, name: x.name })),
        ].filter((x) => x && x.secid);

        if (fallbackPool.length > 0) {
          setSelectedSecid((prev) => {
            if (prev) return prev;
            const first = fallbackPool[0];
            setSelectedNameHint(first.name || '');
            // 仅初始化页内图表焦点，不写入全局最近查看历史，避免覆盖用户历史或在空白空间跳过搜索框
            return first.secid;
          });
          setPaneSecids((prev) => ({
            p1: prev.p1 || fallbackPool[0]?.secid || '',
            p2: prev.p2 || fallbackPool[1]?.secid || fallbackPool[0]?.secid || '',
            p3: prev.p3 || fallbackPool[2]?.secid || fallbackPool[0]?.secid || '',
            p4: prev.p4 || '1.000001',
          }));
        }

        if (Object.keys(nextErrors).length === 4) {
          onToastRef.current(
            tr('全部短线行情子源拉取失败，请检查网络或切换自定义数据源', 'All short-term feeds failed — check network or data sources'),
            'error'
          );
        }
      } catch (err: any) {
        if (reqSeq !== loadAllSeqRef.current) return;
        onToastRef.current(err.message || tr('加载短线看盘数据失败', 'Failed to load short-term cockpit'), 'error');
      } finally {
        if (reqSeq === loadAllSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();

    loadAllInFlightRef.current = runPromise;
    try {
      await runPromise;
    } finally {
      if (loadAllInFlightRef.current === runPromise) {
        loadAllInFlightRef.current = null;
      }
    }
  }, []);

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const prevActiveRef = useRef(isActive);

  useEffect(() => {
    loadAll(false);
  }, [loadAll]);

  // 从其他标签页切回驾驶舱时主动刷新行情，同时完整保留当前布局、筛选与选中标的
  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      loadAll(false);
    }
    prevActiveRef.current = isActive;
  }, [isActive, loadAll]);

  useEffect(() => {
    if (!isActive || !autoSec) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      loadAll(false);
    }, autoSec * 1000);
    return () => clearInterval(timer);
  }, [isActive, autoSec, loadAll]);

  // Load linked stock Intraday + K-line detail whenever selectedSecid or timeframe changes (cancelled immediately when hidden)
  useEffect(() => {
    if (!isActive || !selectedSecid || viewMode !== 'cockpit') return;
    let alive = true;
    setLoadingPrimary(true);
    api
      .getSecurityDetail(selectedSecid, primaryTf)
      .then((res) => {
        if (!alive || !isActiveRef.current) return;
        setPrimaryDetail(res);
        if (userInitiatedSelectionRef.current) {
          setContextPill({
            label: `${res.name} ${res.code}`,
            secid: res.secid,
            code: res.code,
            name: res.name,
            price: res.quote?.price ?? null,
          });
          onActiveStockChangeRef.current?.({ secid: res.secid, code: res.code, name: res.name });
        }
      })
      .catch(() => {
        if (alive) setPrimaryDetail(null);
      })
      .finally(() => {
        if (alive) setLoadingPrimary(false);
      });
    return () => {
      alive = false;
    };
  }, [isActive, selectedSecid, primaryTf, viewMode, setContextPill]);

  // Live ticker search debounce
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchSecurities(q)
        .then((res) => setSearchResults((res.items || []).slice(0, 8)))
        .catch(() => setSearchResults([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const lbs = data?.leaderboards || {};
  const leftRows = useMemo(() => {
    if (leftPoolTab === 'constituents') return sectorConstituents.slice(0, 40);
    if (leftPoolTab === 'lianban') return (lbs.lianban || []).slice(0, 30);
    if (leftPoolTab === 'auction') return (auctionData?.openMovers || []).slice(0, 30);
    if (leftPoolTab === 'seal') return (auctionData?.topSealAmount || []).slice(0, 30);
    if (leftPoolTab === 'gainers') return (lbs.gainers || []).slice(0, 30);
    if (leftPoolTab === 'inflow') return (lbs.mainInflows || []).slice(0, 30);
    if (leftPoolTab === 'anomaly') return (lbs.anomalies || []).slice(0, 30);
    return (lbs.losers || []).slice(0, 30);
  }, [lbs, leftPoolTab, sectorConstituents, auctionData]);

  const navStocks = useMemo(() => {
    const src =
      rightDockTab === 'watchlist' && watchlistItems.length > 0
        ? watchlistItems
        : rightDockTab === 'hot' && (feeds?.hotRanks || []).length > 0
        ? feeds.hotRanks
        : leftRows;
    return (src || []).filter((x: any) => x && x.secid);
  }, [rightDockTab, watchlistItems, feeds?.hotRanks, leftRows]);

  // Keyboard shortcuts: '/' focuses ticker search (works in BOTH cockpit and panoramic views); ArrowUp/ArrowDown flips stocks
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (e.key === '/' && !isInput) {
        e.preventDefault();
        e.stopPropagation();
        if (viewMode !== 'cockpit') {
          setViewMode('cockpit');
          window.requestAnimationFrame(() => {
            searchInputRef.current?.focus();
            setSearchOpen(true);
          });
        } else {
          searchInputRef.current?.focus();
          setSearchOpen(true);
        }
        return;
      }
      if (viewMode === 'cockpit' && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !isInput && navStocks.length > 0) {
        e.preventDefault();
        const curIdx = navStocks.findIndex((s: any) => s.secid === selectedSecid);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const nextIdx = curIdx < 0 ? 0 : (curIdx + delta + navStocks.length) % navStocks.length;
        const nextStock = navStocks[nextIdx];
        if (nextStock?.secid) {
          selectStock(nextStock.secid, nextStock.name);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, viewMode, navStocks, selectedSecid, selectStock]);

  const reloadSprite = async (side: 'all' | 'bull' | 'bear' | 'limit') => {
    setSpriteSide(side);
    try {
      const sp = await api.getShortTermSprite(side, 45);
      setFeeds((prev: any) => ({ ...(prev || {}), sprite: sp }));
    } catch {
      // ignore
    }
  };

  if (loading && !data) {
    return (
      <div className="st-terminal-scope" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 40, color: 'var(--text-muted)' }}>
        <Loader2 size={18} className="spin" />
        {t('正在加载一体化短线盯盘驾驶舱、主线板块与实时盘口...', 'Loading A-share tape-reading cockpit...')}
      </div>
    );
  }

  const temp = data?.temperature || {};
  const node = temp.node;
  const spriteItems = feeds?.sprite?.items || [];
  const liveNews = feeds?.liveNews || data?.telegraph || [];
  const hotRanks = feeds?.hotRanks || [];
  const catalysts = feeds?.companyCatalysts || [];
  const sectorList = sectorKind === 'concept' ? data?.concepts || [] : data?.industries || [];

  const primaryAlerts = (watchState?.alertsStore?.alerts || [])
    .filter((a) => a.secid === selectedSecid && (a.condition === 'price_above' || a.condition === 'price_below') && a.enabled)
    .map((a) => ({
      id: a.id,
      price: a.threshold,
      condition: a.condition as 'price_above' | 'price_below',
      note: a.note,
    }));

  const activeName = primaryDetail?.name || selectedNameHint || selectedSecid;
  const activePrice = primaryDetail?.quote?.price ?? null;
  const activePct = primaryDetail?.quote?.pct ?? null;

  // =========================================================================
  // 可插拔模块渲染器（供左侧/右侧 4 个可定制槽位自由编排）
  // =========================================================================
  const renderDockWidget = (widgetId: WidgetId) => {
    if (widgetId === 'sectors') {
      return (
        <div className="st-term-pane" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <div className="st-pane-hdr">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                className={`st-mini-tab ${sectorKind === 'concept' ? 'active' : ''}`}
                onClick={() => setSectorKind('concept')}
              >
                {t('热点概念', 'Hot Concepts')}
              </button>
              <button
                type="button"
                className={`st-mini-tab ${sectorKind === 'industry' ? 'active' : ''}`}
                onClick={() => setSectorKind('industry')}
              >
                {t('行业板块', 'Industries')}
              </button>
            </div>
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: temp.sentimentScore == null ? 'var(--text-muted)' : temp.sentimentScore >= 60 ? upColor : 'var(--amber)',
              }}
            >
              {t('温度', 'Temp')} {temp.sentimentScore != null ? temp.sentimentScore : '—'} ·{' '}
              {node?.node || temp.stage || t('行情降级', 'Degraded')}
            </span>
          </div>

          {/* Compact 3-cell sentiment pulse bar */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, padding: '4px 6px', borderBottom: '1px solid var(--border)', background: 'var(--bg-soft)' }}>
            {[
              { k: t('昨涨停溢价', 'Yest ZT'), v: formatPct(temp.yestZtPremiumPct), c: pctColor(temp.yestZtPremiumPct) },
              { k: t('昨连板溢价', 'Yest LB'), v: formatPct(temp.yestLianbanPremiumPct), c: pctColor(temp.yestLianbanPremiumPct) },
              {
                k: t('封板率', 'Seal %'),
                v: temp.sealRatePct != null ? `${temp.sealRatePct}%` : '—',
                c: temp.sealRatePct == null ? 'var(--text-muted)' : temp.sealRatePct >= 70 ? upColor : downColor,
              },
            ].map((c) => (
              <div key={c.k} style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', padding: '3px 6px', borderRadius: 5 }}>
                <div style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{c.k}</div>
                <div className="mono" style={{ fontSize: 11, fontWeight: 800, color: c.c }}>{c.v}</div>
              </div>
            ))}
          </div>

          <div
            className="mono"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 52px 54px',
              padding: '3px 8px',
              fontSize: 10,
              color: 'var(--text-muted)',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-sidebar)',
            }}
          >
            <span>{t('板块（点击联动成分股）', 'Sector (click for members)')}</span>
            <span style={{ textAlign: 'right' }}>{t('涨幅', 'Chg%')}</span>
            <span style={{ textAlign: 'right' }}>{t('主力净额', 'Net Flow')}</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {sectorList.slice(0, 18).map((s: any) => {
              const isSelected = selectedSector?.code === s.code;
              return (
                <div
                  key={s.code}
                  className={`st-dense-row ${isSelected ? 'active' : ''}`}
                  style={{ gridTemplateColumns: '1fr 52px 54px' }}
                  onClick={() => handleSelectSector(s)}
                  title={`点击联动查看「${s.name}」全部分层成分股，并切至领涨股 ${s.leaderName || ''}`}
                >
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontWeight: 700, color: isSelected ? 'var(--navy)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.name}
                    </span>
                    {s.leaderName && (
                      <span style={{ fontSize: 9.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        领涨：{s.leaderName} {s.leaderPct != null ? formatPct(s.leaderPct) : ''}
                      </span>
                    )}
                  </div>
                  <span className="mono" style={{ textAlign: 'right', fontWeight: 700, color: pctColor(s.pct) }}>
                    {formatPct(s.pct)}
                  </span>
                  <span className="mono" style={{ textAlign: 'right', color: pctColor(s.mainNetYi), fontSize: 10.5 }}>
                    {formatYi(s.mainNetYi)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    if (widgetId === 'temp') {
      return (
        <div className="st-term-pane" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <div className="st-pane-hdr">
            <strong style={{ fontSize: 11.5, color: 'var(--text)' }}>{t('全市场微观盘面温度', 'Market Micro Temperature')}</strong>
            <span className="badge badge-navy mono" style={{ fontSize: 10 }}>
              {temp.sentimentScore != null ? `${temp.sentimentScore}${t('分', 'pt')}` : '—'} · {node?.node || temp.stage || t('降级', 'Degraded')}
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 6, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 5, alignContent: 'start' }}>
            {[
              { k: t('两市成交', 'Turnover'), v: formatYi(temp.twoMarketAmtYi), sub: temp.estFullDayAmtYi ? `${t('预', 'Est')} ${formatYi(temp.estFullDayAmtYi)}` : '', c: 'var(--navy)' },
              {
                k: t('涨跌家数', 'Adv / Dec'),
                v: `${temp.up ?? '-'}:${temp.down ?? '-'}`,
                sub: `${t('红盘', 'Adv%')} ${temp.redRatePct ?? '-'}%`,
                c: temp.redRatePct == null ? 'var(--text-muted)' : pctColor(temp.redRatePct - 50),
              },
              { k: t('主力净流', 'Main Flow'), v: formatYi(temp.mainNetSumYi), sub: t('核心板块', 'Sectors'), c: pctColor(temp.mainNetSumYi) },
              { k: t('涨停 / 跌停', 'ZT / DT'), v: `${temp.ztCount ?? '-'} / ${temp.dtCount ?? '-'}`, sub: `20cm ${temp.zt20cmCount ?? '—'}`, c: upColor },
              {
                k: t('封板 / 炸板', 'Seal / Burst'),
                v: temp.sealRatePct != null ? `${temp.sealRatePct}%` : '—',
                sub: `${t('炸板', 'Burst')} ${temp.zbCount ?? '-'}`,
                c: temp.sealRatePct == null ? 'var(--text-muted)' : temp.sealRatePct >= 70 ? upColor : downColor,
              },
              { k: t('连板 / 高度', 'Streak / Max'), v: `${temp.lianbanCount ?? '—'} / ${temp.maxBoard ?? '—'}${t('板', 'B')}`, sub: t('空间高度', 'Max Board'), c: 'var(--amber)' },
              { k: t('昨涨停溢价', 'Yest ZT'), v: formatPct(temp.yestZtPremiumPct), sub: t('接力情绪', 'Follow'), c: pctColor(temp.yestZtPremiumPct) },
              { k: t('昨连板溢价', 'Yest LB'), v: formatPct(temp.yestLianbanPremiumPct), sub: t('高标反馈', 'Leaders'), c: pctColor(temp.yestLianbanPremiumPct) },
              { k: t('仓位纪律', 'Pos Cap'), v: node?.maxPositionPct != null ? `${node.maxPositionPct}%` : '—', sub: node?.channelLabel || t('控制回撤', 'Risk Cap'), c: 'var(--teal)' },
            ].map((cell) => (
              <div key={cell.k} style={{ padding: '5px 6px', borderRadius: 6, background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{cell.k}</div>
                <div className="mono" style={{ fontSize: 12, fontWeight: 800, color: cell.c, marginTop: 1 }}>{cell.v}</div>
                <div style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{cell.sub}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (widgetId === 'pool') {
      const poolTabs: { id: LeftPoolTab; label: string }[] = [
        ...(selectedSector ? [{ id: 'constituents' as const, label: t('成分', 'Mem') }] : []),
        { id: 'lianban', label: t('连板', 'Streak') },
        { id: 'auction', label: t('竞价', 'Auct') },
        { id: 'seal', label: t('封单', 'Seal') },
        { id: 'gainers', label: t('涨幅', 'Gain') },
        { id: 'inflow', label: t('主力', 'Flow') },
        { id: 'anomaly', label: t('异动', 'Anom') },
        { id: 'losers', label: t('大面', 'Drop') },
      ];
      return (
        <div className="st-term-pane" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <div className="st-pane-hdr" style={{ padding: '4px 5px', gap: 1, overflowX: 'auto', scrollbarWidth: 'none' }}>
            {poolTabs.map((tb) => (
              <button
                key={tb.id}
                type="button"
                className={`st-mini-tab ${leftPoolTab === tb.id ? 'active' : ''}`}
                style={{ padding: '2px 4.5px', fontSize: 10.5, flexShrink: 0 }}
                onClick={() => setLeftPoolTab(tb.id)}
              >
                {tb.label}
              </button>
            ))}
          </div>

          {leftPoolTab === 'constituents' && selectedSector && (
            <div
              style={{
                padding: '4px 8px',
                background: 'var(--navy-soft)',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 11,
              }}
            >
              <span style={{ fontWeight: 700, color: 'var(--navy)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                联动板块：{selectedSector.name} ({sectorConstituents.length}只)
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ padding: '0 4px', height: 20, fontSize: 10.5 }}
                onClick={() => {
                  setSelectedSector(null);
                  setSectorConstituents([]);
                  setLeftPoolTab('lianban');
                }}
              >
                <X size={11} /> 清除
              </button>
            </div>
          )}

          <div
            className="mono"
            style={{
              display: 'grid',
              gridTemplateColumns: '52px 1fr 52px 48px',
              padding: '3px 8px',
              fontSize: 10,
              color: 'var(--text-muted)',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-sidebar)',
            }}
          >
            <span>{t('代码', 'Code')}</span>
            <span>{t('名称（双击全屏）', 'Name (dbl-click)')}</span>
            <span style={{ textAlign: 'right' }}>
              {leftPoolTab === 'inflow'
                ? t('净流', 'Flow')
                : leftPoolTab === 'anomaly'
                ? t('10日偏', '10d Dev')
                : leftPoolTab === 'auction'
                ? t('高开', 'Gap')
                : leftPoolTab === 'seal'
                ? t('封单', 'Seal')
                : t('涨幅', 'Chg%')}
            </span>
            <span style={{ textAlign: 'right' }}>
              {leftPoolTab === 'lianban' || leftPoolTab === 'seal'
                ? t('板高', 'Brd')
                : leftPoolTab === 'auction'
                ? t('涨幅', 'Chg%')
                : t('成交额', 'Amt')}
            </span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {leftPoolTab === 'constituents' && loadingConstituents ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11.5 }}>
                <Loader2 size={14} className="spin" /> 正在加载板块成分股...
              </div>
            ) : leftRows.length === 0 ? (
              <div style={{ padding: 18, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11.5 }}>
                当前分类暂无数据，点击上方板块或切换排行查看
              </div>
            ) : (
              leftRows.map((r: any, idx: number) => {
                const isActive = r.secid === selectedSecid;
                return (
                  <div
                    key={`${r.secid || r.code}-${idx}`}
                    className={`st-dense-row ${isActive ? 'active' : ''}`}
                    style={{ gridTemplateColumns: '52px 1fr 52px 48px' }}
                    onClick={() => r.secid && selectStock(r.secid, r.name)}
                    onDoubleClick={() => r.secid && onOpenFullscreenStock(r.secid)}
                    title="单击联动看分时/K线与五档盘口；双击铺满全屏 K 线"
                  >
                    <span className="mono" style={{ color: 'var(--navy)', fontSize: 10.5 }}>{r.code}</span>
                    <span style={{ color: isActive ? 'var(--navy)' : 'var(--text)', fontWeight: isActive ? 800 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.name}
                    </span>
                    <span
                      className="mono"
                      style={{
                        textAlign: 'right',
                        fontWeight: 700,
                        color:
                          leftPoolTab === 'inflow'
                            ? pctColor(r.mainNetYi)
                            : leftPoolTab === 'anomaly'
                            ? 'var(--amber)'
                            : leftPoolTab === 'seal'
                            ? upColor
                            : leftPoolTab === 'auction'
                            ? pctColor(r.openGapPct)
                            : pctColor(r.pct),
                      }}
                    >
                      {leftPoolTab === 'inflow'
                        ? formatYi(r.mainNetYi)
                        : leftPoolTab === 'anomaly'
                        ? `${r.dev10dPct ?? '--'}%`
                        : leftPoolTab === 'seal'
                        ? `${r.sealFundYi ?? '--'}亿`
                        : leftPoolTab === 'auction'
                        ? formatPct(r.openGapPct)
                        : formatPct(r.pct)}
                    </span>
                    <span className="mono" style={{ textAlign: 'right', fontSize: 10, color: leftPoolTab === 'lianban' || leftPoolTab === 'seal' ? 'var(--amber)' : leftPoolTab === 'auction' ? pctColor(r.pct) : 'var(--text-muted)', fontWeight: leftPoolTab === 'lianban' ? 700 : 500 }}>
                      {leftPoolTab === 'lianban' || leftPoolTab === 'seal'
                        ? `${r.lbc || 1}板`
                        : leftPoolTab === 'auction'
                        ? formatPct(r.pct)
                        : r.amountYi != null
                        ? `${r.amountYi}亿`
                        : r.turnoverPct != null
                        ? `${r.turnoverPct}%`
                        : '--'}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      );
    }

    if (widgetId === 'orderbook') {
      return (
        <OrderBookPanel
          secid={selectedSecid}
          stockName={activeName}
          isActive={isActive}
          onOpenDataSources={onOpenDataSources}
          onOrderBookData={(ob) => setActiveOrderBook(ob && ob.secid === selectedSecid ? ob : null)}
        />
      );
    }

    if (widgetId === 'watchlist') {
      return (
        <div className="st-term-pane" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <div className="st-pane-hdr">
            <strong style={{ fontSize: 11.5 }}>{t(`自选股快盯 (${watchlistItems.length})`, `Watchlist (${watchlistItems.length})`)}</strong>
            <button type="button" className="st-mini-tab" onClick={() => onNavigateTab?.('watchlist')}>
              {t('管理自选 →', 'Manage →')}
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {watchlistItems.map((w) => (
              <div
                key={w.secid}
                className={`st-dense-row ${w.secid === selectedSecid ? 'active' : ''}`}
                style={{ gridTemplateColumns: '54px 1fr 56px 56px' }}
                onClick={() => selectStock(w.secid, w.name)}
                onDoubleClick={() => onOpenFullscreenStock(w.secid)}
              >
                <span className="mono" style={{ color: 'var(--navy)', fontSize: 10.5 }}>{w.code}</span>
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                <span className="mono" style={{ textAlign: 'right' }}>{w.price != null ? w.price.toFixed(2) : '--'}</span>
                <span className="mono" style={{ textAlign: 'right', fontWeight: 700, color: pctColor(w.pct) }}>{formatPct(w.pct)}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    // Default: 'signals' (短线精灵 / 自选股 / 热股 / 7×24电报 / 深度催化)
    return (
      <div className="st-term-pane" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div className="st-pane-hdr" style={{ padding: '4px 5px', gap: 2 }}>
          {[
            { id: 'sprite', label: t('短线精灵', 'Sprite') },
            { id: 'watchlist', label: t('自选股', 'Watch') },
            { id: 'hot', label: t('热股', 'Hot') },
            { id: 'news', label: `${t('电报', 'News')}${feeds?.webhookCount ? `(${feeds.webhookCount})` : ''}` },
            { id: 'catalyst', label: t('催化', 'Intel') },
          ].map((tb) => (
            <button
              key={tb.id}
              type="button"
              className={`st-mini-tab ${rightDockTab === tb.id ? 'active' : ''}`}
              style={{ flex: 1, justifyContent: 'center', padding: '2px 3px', fontSize: 10.5 }}
              onClick={() => setRightDockTab(tb.id as RightDockTab)}
            >
              {tb.label}
            </button>
          ))}
        </div>

        {rightDockTab === 'sprite' && (
          <div style={{ display: 'flex', gap: 3, padding: '3px 6px', borderBottom: '1px solid var(--border)', background: 'var(--bg-soft)' }}>
            {[
              { id: 'all', l: t('全部', 'All') },
              { id: 'bull', l: t('拉升/大买', 'Bull') },
              { id: 'bear', l: t('砸盘/大卖', 'Bear') },
              { id: 'limit', l: t('封板/开板', 'Limit') },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                className={`st-mini-tab ${spriteSide === f.id ? 'active' : ''}`}
                style={{ fontSize: 10, padding: '1.5px 6px' }}
                onClick={() => reloadSprite(f.id as any)}
              >
                {f.l}
              </button>
            ))}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {rightDockTab === 'sprite' &&
            spriteItems.map((sp: any) => (
              <div
                key={sp.id}
                className={`st-dense-row ${sp.secid === selectedSecid ? 'active' : ''}`}
                style={{ gridTemplateColumns: '52px 72px 66px 1fr' }}
                onClick={() => selectStock(sp.secid, sp.name)}
                onDoubleClick={() => onOpenFullscreenStock(sp.secid)}
              >
                <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 10 }}>{sp.time}</span>
                <span style={{ color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sp.name}
                </span>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: sp.side === 'bull' ? upColor : downColor }}>
                  {sp.typeLabel}
                </span>
                <span className="mono" style={{ textAlign: 'right', fontWeight: 700, color: pctColor(sp.pct), fontSize: 10.5 }}>
                  {formatPct(sp.pct)}
                </span>
              </div>
            ))}

          {rightDockTab === 'watchlist' &&
            watchlistItems.map((w) => (
              <div
                key={w.secid}
                className={`st-dense-row ${w.secid === selectedSecid ? 'active' : ''}`}
                style={{ gridTemplateColumns: '54px 1fr 54px 54px' }}
                onClick={() => selectStock(w.secid, w.name)}
                onDoubleClick={() => onOpenFullscreenStock(w.secid)}
              >
                <span className="mono" style={{ color: 'var(--navy)', fontSize: 10 }}>{w.code}</span>
                <span style={{ color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {w.name}
                </span>
                <span className="mono" style={{ textAlign: 'right', color: 'var(--text)' }}>
                  {w.price != null ? w.price.toFixed(2) : '--'}
                </span>
                <span className="mono" style={{ textAlign: 'right', fontWeight: 700, color: pctColor(w.pct) }}>
                  {formatPct(w.pct)}
                </span>
              </div>
            ))}

          {rightDockTab === 'hot' &&
            hotRanks.map((h: any) => (
              <div
                key={h.secid}
                className={`st-dense-row ${h.secid === selectedSecid ? 'active' : ''}`}
                style={{ gridTemplateColumns: '22px 1fr 56px 54px' }}
                onClick={() => selectStock(h.secid, h.name)}
                onDoubleClick={() => onOpenFullscreenStock(h.secid)}
              >
                <span className="mono" style={{ fontWeight: 800, color: h.rank <= 3 ? upColor : 'var(--amber)' }}>{h.rank}</span>
                <span style={{ color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {h.name}
                </span>
                <span className="mono" style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>
                  {formatYi(h.amountYi)}
                </span>
                <span className="mono" style={{ textAlign: 'right', fontWeight: 700, color: pctColor(h.pct) }}>
                  {formatPct(h.pct)}
                </span>
              </div>
            ))}

          {rightDockTab === 'news' && (
            <div style={{ padding: '6px 7px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button type="button" className="st-slot-pill" onClick={() => onOpenDataSources?.('news_feeds')}>
                <Radio size={10} /> 接入自定义合规快讯源 / 本地消息推送
              </button>
              {liveNews.map((n: any) => {
                const expanded = Boolean(expandedFeedIds[n.id]);
                const hasLongBody = Boolean(n.content && n.content !== n.title && n.content.length > 10);
                return (
                  <div
                    key={n.id}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: n.channel === 'webhook' ? 'var(--navy-soft)' : n.important ? 'var(--crimson-soft)' : 'var(--bg-soft)',
                      border: `1px solid ${n.channel === 'webhook' ? 'color-mix(in srgb, var(--navy) 30%, transparent)' : n.important ? 'color-mix(in srgb, var(--crimson) 28%, transparent)' : 'var(--border)'}`,
                      fontSize: 11.5,
                      cursor: hasLongBody ? 'pointer' : 'default',
                    }}
                    onClick={() => hasLongBody && setExpandedFeedIds((prev) => ({ ...prev, [n.id]: !prev[n.id] }))}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', gap: 4 }}>
                      <span className="mono">{n.time} · {n.source}</span>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        {n.channel === 'webhook' && <b style={{ color: 'var(--navy)' }}>Webhook</b>}
                        {n.url && (
                          <a
                            href={n.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ color: 'var(--navy)', textDecoration: 'none', fontWeight: 600 }}
                          >
                            原文 <ExternalLink size={9} />
                          </a>
                        )}
                      </span>
                    </div>
                    <div style={{ color: 'var(--text)', fontWeight: 600, marginTop: 2, lineHeight: 1.4 }}>{n.title}</div>
                    {Array.isArray(n.secids) && n.secids.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                        {n.secids.slice(0, 4).map((sc: string) => (
                          <button
                            key={sc}
                            type="button"
                            className="ref-chip ref-chip-method"
                            style={{ fontSize: 10 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              selectStock(sc);
                            }}
                          >
                            {sc}
                          </button>
                        ))}
                      </div>
                    )}
                    {hasLongBody && (
                      <div
                        style={{
                          color: 'var(--text-secondary)',
                          fontSize: 10.5,
                          marginTop: 3,
                          lineHeight: 1.45,
                          whiteSpace: expanded ? 'pre-wrap' : 'normal',
                        }}
                      >
                        {expanded ? n.content : `${(n.summary || n.content).slice(0, 90)}${n.content.length > 90 ? '… [展开]' : ''}`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {rightDockTab === 'catalyst' && (
            <div style={{ padding: '6px 7px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button type="button" className="st-slot-pill" onClick={() => onOpenDataSources?.('news_feeds')}>
                <Lock size={10} /> {feeds?.communitySlot?.label || '付费社区深度贴 · 待接入源或 Webhook 推送'}
              </button>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {(feeds?.communityLinks || []).map((lk: any) => (
                  <a
                    key={lk.url}
                    href={lk.url}
                    target="_blank"
                    rel="noreferrer"
                    className="st-strip-btn"
                    style={{ textDecoration: 'none', fontSize: 10.5 }}
                  >
                    {lk.name} <ExternalLink size={9} />
                  </a>
                ))}
              </div>
              {catalysts.map((c: any) => {
                const expanded = Boolean(expandedFeedIds[c.id]);
                const bodyText = String(c.content || c.summary || '').trim();
                const hasBody = Boolean(bodyText && bodyText !== c.title);
                return (
                  <div
                    key={c.id}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: c.isCommunity ? 'var(--teal-soft)' : 'var(--bg-soft)',
                      border: `1px solid ${c.isCommunity ? 'color-mix(in srgb, var(--teal) 30%, transparent)' : 'var(--border)'}`,
                      fontSize: 11.5,
                      cursor: hasBody ? 'pointer' : 'default',
                    }}
                    onClick={() => hasBody && setExpandedFeedIds((prev) => ({ ...prev, [c.id]: !prev[c.id] }))}
                  >
                    <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', gap: 6 }}>
                      <span>{c.time} · {c.source}</span>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        {hasBody && <span style={{ color: 'var(--navy)', fontWeight: 600 }}>{expanded ? '收起' : '全文'}</span>}
                        {c.url && (
                          <a
                            href={c.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ color: 'var(--teal)', textDecoration: 'none', fontWeight: 600 }}
                          >
                            原文 <ExternalLink size={9} />
                          </a>
                        )}
                      </span>
                    </div>
                    <div style={{ color: 'var(--text)', fontWeight: 600, marginTop: 2, lineHeight: 1.4 }}>{c.title}</div>
                    {hasBody && (
                      <div
                        style={{
                          color: 'var(--text-secondary)',
                          fontSize: 10.5,
                          marginTop: 3,
                          lineHeight: 1.45,
                          whiteSpace: expanded ? 'pre-wrap' : 'normal',
                          wordBreak: 'break-word',
                        }}
                      >
                        {expanded ? bodyText : `${(c.summary || bodyText).slice(0, 120)}${bodyText.length > 120 ? '…' : ''}`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  // =========================================================================
  // 视图 1：与工作台视觉统一、可拖拽缩放、全页联动的专业 A 股盯盘驾驶舱
  // =========================================================================
  if (viewMode === 'cockpit') {
    const densityCls = prefs.density === 'comfort' ? 'st-density-comfort' : 'st-density-compact';
    return (
      <div
        className={`st-terminal-scope ${densityCls}`}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: 8,
          gap: 6,
        }}
      >
        {/* Top Cockpit Control Bar */}
        <div
          className="st-term-pane"
          style={{
            padding: '5px 10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            flexWrap: 'wrap',
            flexShrink: 0,
            overflow: 'visible',
          }}
        >
          {/* Left: Instant '/' Ticker Search + Linked Focus Stock Quote */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, position: 'relative', flexWrap: 'wrap', minWidth: 0 }}>
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                <Search size={12} color="var(--text-muted)" style={{ position: 'absolute', left: 8, pointerEvents: 'none' }} />
                <input
                  ref={searchInputRef}
                  className="st-inline-input mono"
                  style={{ width: 178, paddingLeft: 26, height: 27, fontSize: 11.5 }}
                  value={searchQuery}
                  onFocus={() => setSearchOpen(true)}
                  onBlur={() => setTimeout(() => setSearchOpen(false), 180)}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSearchOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && searchResults[0]?.secid) {
                      selectStock(searchResults[0].secid, searchResults[0].name);
                    } else if (e.key === 'Escape') {
                      setSearchOpen(false);
                      searchInputRef.current?.blur();
                    }
                  }}
                  placeholder={t('按 / 切票 · 代码/拼音', 'Press / to switch ticker')}
                />
              </div>
              {searchOpen && searchResults.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    marginTop: 4,
                    width: 272,
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--navy)',
                    borderRadius: 8,
                    boxShadow: 'var(--shadow-lg)',
                    zIndex: 80,
                    overflow: 'hidden',
                  }}
                >
                  {searchResults.map((item) => (
                    <div
                      key={item.secid}
                      onMouseDown={() => selectStock(item.secid, item.name)}
                      className="st-dense-row"
                      style={{ gridTemplateColumns: '64px 1fr 48px', padding: '6px 9px' }}
                    >
                      <span className="mono" style={{ color: 'var(--navy)' }}>{item.code}</span>
                      <strong style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.name}
                      </strong>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>{item.marketKind}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
              <strong style={{ color: 'var(--text)', fontSize: 14.5 }}>
                {activeName || t('未选定标的（输入代码搜索）', 'No Symbol Selected')}
              </strong>
              {selectedSecid && (
                <span className="mono" style={{ color: 'var(--navy)', fontSize: 11.5 }}>{primaryDetail?.code || selectedSecid}</span>
              )}
              <span className="mono" style={{ fontSize: 14.5, fontWeight: 800, color: pctColor(activePct) }}>
                {activePrice != null ? activePrice.toFixed(2) : '—'}
              </span>
              <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: pctColor(activePct) }}>
                {activePct != null ? formatPct(activePct) : '—'}
              </span>
              {primaryDetail?.quote?.turnoverPct != null && (
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {t('换', 'TO')} {primaryDetail.quote.turnoverPct}% · {t('额', 'Amt')} {formatYi(primaryDetail.quote.amountYi)}
                </span>
              )}
              {selectedSector && (
                <span className="badge badge-navy" style={{ fontSize: 10.5 }}>
                  {t('板块联动：', 'Sector: ')}
                  {selectedSector.name}
                </span>
              )}
              {Object.keys(subSourceErrors).length > 0 && (
                <button
                  type="button"
                  className="badge badge-amber"
                  style={{ cursor: 'pointer', border: '1px solid var(--amber)', fontSize: 10.5 }}
                  onClick={() => loadAll(true)}
                  title={Object.entries(subSourceErrors)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' | ')}
                >
                  {t(
                    `子源降级(${Object.keys(subSourceErrors)
                      .map((k) => ({ dash: '盘面', news: '精灵/快讯', watchlist: '自选', auction: '竞价' }[k] || k))
                      .join('/')}) · 点击重试`,
                    `Degraded(${Object.keys(subSourceErrors).join('/')}) · Retry`
                  )}
                </button>
              )}
            </div>
            <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
              {t('↑/↓ 翻股 · 双击铺满全屏K线', '↑/↓ Step · Dbl-click Fullscreen')}
            </span>
          </div>

          {/* Right: Quick Presets + Multi-Screen + Customizer + Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', position: 'relative' }}>
            {/* Multi-Chart 1 / 2H / 2V / 4 */}
            <div style={{ display: 'inline-flex', gap: 2, padding: 2, background: 'var(--bg-soft)', borderRadius: 6, border: '1px solid var(--border)' }}>
              {[
                { id: '1', label: t('1屏', '1x'), icon: <Square size={11} /> },
                { id: '2h', label: t('2屏左右', '2x H'), icon: <Columns2 size={11} /> },
                { id: '2v', label: t('2屏上下', '2x V'), icon: <Rows2 size={11} /> },
                { id: '4', label: t('4屏', '4x'), icon: <Grid2x2 size={11} /> },
              ].map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`st-mini-tab ${prefs.screens === m.id ? 'active' : ''}`}
                  onClick={() => {
                    if (m.id !== '1' && !requireClientFeature('multi_chart')) return;
                    updatePrefs({ screens: m.id as LayoutScreens });
                  }}
                  title={t(`切换至 ${m.label} 同屏模式`, `Switch to ${m.label} chart layout`)}
                >
                  {m.icon} {m.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="st-strip-btn"
              onClick={() => onOpenFullscreenStock(selectedSecid)}
              title={t('全屏铺满当前标的 K 线工作台', 'Open fullscreen K-line workspace for current symbol')}
            >
              <Maximize2 size={11} color="var(--navy)" /> {t('全屏K线', 'Fullscreen')}
            </button>

            <button
              type="button"
              className="st-strip-btn"
              onClick={() => setShowPlanCard(true)}
              title={t('按当前焦点标的打开 A 股半自动交易计划卡（仓位/止损测算与一键复制）', 'Open position sizing & stop-loss trade plan card')}
            >
              <Calculator size={11} color="var(--teal)" /> {t('计划卡', 'Plan Card')}
            </button>

            {activePrice != null && (
              <button
                type="button"
                className="st-strip-btn"
                onClick={() =>
                  addPriceAlertQuick({
                    secid: selectedSecid,
                    name: activeName,
                    price: Number((activePrice * 1.02).toFixed(2)),
                    condition: 'price_above',
                    note: t('盯盘快捷突破预警', 'Quick cockpit breakout alert'),
                  })
                }
                title={t('一键为当前标的设定 +2% Bot 突破预警', 'Set quick +2% breakout alert')}
              >
                <BellPlus size={11} color="var(--amber)" /> {t('预警', 'Alert')}
              </button>
            )}

            <button
              type="button"
              className="st-strip-btn"
              onClick={() => (onOpenUnifiedReview ? onOpenUnifiedReview() : onNavigateTab?.('ledger'))}
              title={t('前往统一投研+短线复盘台账（沉淀今日情绪、题材趋势与产业逻辑）', 'Open unified review ledger')}
            >
              <BookOpen size={11} color="var(--navy)" /> {t('记入复盘', 'Review')}
            </button>

            <button
              type="button"
              className={`st-strip-btn ${customizerOpen ? 'active' : ''}`}
              onClick={() => setCustomizerOpen((v) => !v)}
              title={t('自由定制看板预设、模块槽位、显示开关与行距密度', 'Customize cockpit layout, widget slots & density')}
            >
              <SlidersHorizontal size={11} /> {t('定制布局', 'Layout')}
            </button>

            <button
              type="button"
              className="st-strip-btn"
              onClick={() => updatePrefs((p) => ({ ...p, showLeft: !p.showLeft }))}
              title={prefs.showLeft ? t('隐藏左侧板块与股池', 'Hide left panel') : t('展开左侧板块与股池', 'Show left panel')}
            >
              {prefs.showLeft ? <PanelLeftClose size={11} /> : <PanelLeftOpen size={11} />}
            </button>
            <button
              type="button"
              className="st-strip-btn"
              onClick={() => updatePrefs((p) => ({ ...p, showRight: !p.showRight }))}
              title={prefs.showRight ? t('隐藏右侧盘口与精灵', 'Hide right panel') : t('展开右侧盘口与精灵', 'Show right panel')}
            >
              {prefs.showRight ? <PanelRightClose size={11} /> : <PanelRightOpen size={11} />}
            </button>

            <select
              className="st-inline-input"
              style={{ height: 25, fontSize: 10.5, padding: '0 5px' }}
              value={autoSec}
              onChange={(e) => setAutoSec(Number(e.target.value))}
            >
              <option value={15}>15s</option>
              <option value={30}>30s</option>
              <option value={60}>60s</option>
              <option value={0}>{t('手动', 'Manual')}</option>
            </select>
            <button type="button" className="st-strip-btn" disabled={refreshing} onClick={() => loadAll(true)} title={t('立即刷新', 'Refresh now')}>
              <RefreshCw size={11} className={refreshing ? 'spin' : ''} />
            </button>
            <button
              type="button"
              className="st-strip-btn"
              onClick={() => setViewMode('panoramic')}
              title={t('切换至全景热力总览（9格温度 + 6日主线轮动 + 6列快榜 + 24只迷你分时墙）', 'Switch to panoramic market overview')}
            >
              <LayoutGrid size={11} /> {t('全景热力', 'Overview')}
            </button>

            {/* Interactive Layout Customizer Popover */}
            {customizerOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 6,
                  width: 390,
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 10,
                  boxShadow: 'var(--shadow-lg)',
                  padding: 12,
                  zIndex: 90,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 11,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: 7 }}>
                  <strong style={{ fontSize: 13 }}>{t('定制盯盘驾驶舱布局（自动记忆）', 'Customize Cockpit Layout (Auto-Saved)')}</strong>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: 11 }}
                      onClick={() => {
                        updatePrefs(DEFAULT_PREFS);
                        onToast(t('已恢复默认三栏盯盘布局', 'Reset to default 3-column layout'), 'info');
                      }}
                    >
                      <RotateCcw size={11} /> {t('重置', 'Reset')}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCustomizerOpen(false)}>
                      <X size={13} />
                    </button>
                  </div>
                </div>

                {/* Preset Layouts */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 5 }}>{t('一键布局预设', 'Layout Presets')}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                    {COCKPIT_PRESETS.map((pr) => (
                      <button
                        key={pr.id}
                        type="button"
                        className="btn btn-sm"
                        style={{ flexDirection: 'column', alignItems: 'flex-start', height: 'auto', padding: '6px 8px', whiteSpace: 'normal', textAlign: 'left' }}
                        onClick={() => {
                          if (pr.patch.screens && pr.patch.screens !== '1' && !requireClientFeature('multi_chart')) return;
                          updatePrefs((p) => ({ ...p, ...pr.patch }));
                          onToast(t(`已切换至「${pr.labelZh}」布局`, `Switched to "${pr.labelEn}" layout`), 'info');
                        }}
                      >
                        <strong style={{ fontSize: 11.5 }}>{t(pr.labelZh, pr.labelEn)}</strong>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{t(pr.descZh, pr.descEn)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Module Slot Mapping */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 5 }}>
                    {t('自由分配 4 大停靠槽位（列宽与上下高度可直接拖动分隔条调整）', 'Assign 4 Dock Slots (drag dividers to resize)')}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {(
                      [
                        { key: 'leftTop', label: t('左上槽位', 'Top-Left') },
                        { key: 'rightTop', label: t('右上槽位', 'Top-Right') },
                        { key: 'leftBottom', label: t('左下槽位', 'Bottom-Left') },
                        { key: 'rightBottom', label: t('右下槽位', 'Bottom-Right') },
                      ] as const
                    ).map((sl) => (
                      <label key={sl.key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{sl.label}</span>
                        <select
                          className="select"
                          style={{ padding: '4px 6px', fontSize: 11.5 }}
                          value={prefs.slots[sl.key]}
                          onChange={(e) =>
                            updatePrefs((p) => ({
                              ...p,
                              slots: { ...p.slots, [sl.key]: e.target.value as WidgetId },
                            }))
                          }
                        >
                          {(Object.keys(WIDGET_LABELS) as WidgetId[]).map((wid) => (
                            <option key={wid} value={wid}>
                              {t(WIDGET_LABELS[wid].zh, WIDGET_LABELS[wid].en)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Visibility & Density */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div style={{ display: 'flex', gap: 10, fontSize: 11.5, flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                      <input type="checkbox" checked={prefs.showIntraday} onChange={(e) => updatePrefs({ showIntraday: e.target.checked })} />
                      {t('主图分时', 'Intraday')}
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                      <input type="checkbox" checked={prefs.showKline} onChange={(e) => updatePrefs({ showKline: e.target.checked })} />
                      {t('主图K线', 'K-Line')}
                    </label>
                  </div>
                  <div className="seg-tabs" style={{ padding: 2 }}>
                    <button
                      type="button"
                      className={`seg-tab ${prefs.density === 'compact' ? 'active' : ''}`}
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => updatePrefs({ density: 'compact' })}
                    >
                      {t('紧凑盘口', 'Compact')}
                    </button>
                    <button
                      type="button"
                      className={`seg-tab ${prefs.density === 'comfort' ? 'active' : ''}`}
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => updatePrefs({ density: 'comfort' })}
                    >
                      {t('标准舒适', 'Comfort')}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Main Drag-Resizable 3-Column Unified Cockpit */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            overflow: 'hidden',
          }}
        >
          {/* LEFT COLUMN (Resizable Width + Resizable Top/Bottom Split) */}
          {prefs.showLeft && (
            <>
              <div
                ref={leftColRef}
                style={{
                  width: prefs.leftWidth,
                  flexShrink: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  overflow: 'hidden',
                }}
              >
                <div style={{ height: `${prefs.leftSplitPct}%`, minHeight: 140, display: 'flex', flexDirection: 'column' }}>
                  {renderDockWidget(prefs.slots.leftTop)}
                </div>
                <div
                  className={`st-splitter-h ${draggingHandle === 'left-h' ? 'dragging' : ''}`}
                  onMouseDown={(e) => startHorizontalDrag('left', leftColRef, e)}
                  title="上下拖动调整左侧模块高度比例"
                />
                <div style={{ flex: 1, minHeight: 140, display: 'flex', flexDirection: 'column' }}>
                  {renderDockWidget(prefs.slots.leftBottom)}
                </div>
              </div>
              <div
                className={`st-splitter-v ${draggingHandle === 'left' ? 'dragging' : ''}`}
                onMouseDown={(e) => startVerticalDrag('left', e)}
                title="左右拖动调整左侧栏宽度"
              />
            </>
          )}

          {/* CENTER STAGE: Responsive Fill-Height Intraday + K-Line OR Multi-Chart 2H / 2V / 4 */}
          <div
            ref={centerColRef}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {prefs.screens === '1' && (
              <>
                {prefs.showIntraday && (
                  <div
                    className="st-term-pane"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      ...(prefs.showKline ? { height: `${prefs.centerSplitPct}%`, minHeight: 155 } : { flex: 1, minHeight: 200 }),
                    }}
                  >
                    <div className="st-pane-hdr">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <strong style={{ fontSize: 12, color: 'var(--text)' }}>{t('分时走势', 'Intraday')} · {activeName}</strong>
                        <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                          {t('昨收', 'Prev')} {primaryDetail?.quote?.preClose?.toFixed(2) ?? '—'} · {t('虚线基准 / 橙线均价', 'Dash Ref / Orange VWAP')}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {activeOrderBook &&
                        activeOrderBook.secid === selectedSecid &&
                        activeOrderBook.sealFlow?.available &&
                        activeOrderBook.sealFlow.series &&
                        activeOrderBook.sealFlow.series.some((p) => p.sealYi != null) ? (
                          (() => {
                            const pts = activeOrderBook.sealFlow.series!.filter((p) => p.sealYi != null);
                            const vals = pts.map((p) => p.sealYi as number);
                            const latest = vals[vals.length - 1];
                            const realMax = Math.max(...vals);
                            const realMin = Math.min(...vals, 0);
                            const span = Math.max(0.01, realMax - realMin);
                            const w = 96;
                            const h = 16;
                            const pathD = vals
                              .map((v, idx) => {
                                const x = vals.length <= 1 ? w / 2 : (idx / (vals.length - 1)) * w;
                                const y = h - 2 - ((v - realMin) / span) * (h - 4);
                                return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
                              })
                              .join(' ');
                            return (
                              <div
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 5,
                                  padding: '1px 7px',
                                  borderRadius: 5,
                                  background: 'var(--teal-soft)',
                                  border: '1px solid color-mix(in srgb, var(--teal) 35%, transparent)',
                                }}
                                title={`封单金额分时曲线 (${pts[0]?.t || ''} ~ ${pts[pts.length - 1]?.t || ''})`}
                              >
                                <span className="mono" style={{ fontSize: 10, color: 'var(--teal)', fontWeight: 700 }}>
                                  封单 {latest != null ? `${latest.toFixed(2)}亿` : '--'} (峰 {realMax.toFixed(2)}亿)
                                </span>
                                <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
                                  <path d={pathD} fill="none" stroke="var(--teal)" strokeWidth={1.5} />
                                </svg>
                              </div>
                            );
                          })()
                        ) : (
                          <button
                            type="button"
                            className="st-slot-pill"
                            style={{ width: 'auto', padding: '1px 7px', fontSize: 10 }}
                            onClick={() => onOpenDataSources?.('cn_short_term')}
                            title="在数据源管理 → 通道2配置封单分时接口即可点亮涨停封单金额分时曲线"
                          >
                            <Lock size={9} /> {t('封单分时 · 付费槽位', 'Seal Flow · Paid Slot')}
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, padding: '4px 8px' }}>
                      <IntradayVolumeChart
                        intraday={primaryDetail?.intraday || null}
                        preClose={primaryDetail?.quote?.preClose}
                        pct={primaryDetail?.quote?.pct}
                        currencySymbol=""
                        fillHeight
                        interactive
                      />
                    </div>
                  </div>
                )}

                {prefs.showIntraday && prefs.showKline && (
                  <div
                    className={`st-splitter-h ${draggingHandle === 'center-h' ? 'dragging' : ''}`}
                    onMouseDown={(e) => startHorizontalDrag('center', centerColRef, e)}
                    title="上下拖动调整分时图与 K 线图高度占比"
                  />
                )}

                {prefs.showKline && (
                  <div
                    className="st-term-pane"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      flex: 1,
                      minHeight: 200,
                      overflow: 'hidden',
                      padding: '5px 8px 4px',
                    }}
                  >
                    <InteractiveKlineChart
                      secid={selectedSecid}
                      title={activeName}
                      klines={primaryDetail?.klines || []}
                      timeframe={primaryTf}
                      isActive={isActive}
                      onChangeTimeframe={(tf) => setPrimaryTf(tf)}
                      loadingTimeframe={loadingPrimary}
                      trendlines={primaryDetail?.trendlines || null}
                      tradeMarkers={primaryDetail?.tradeMarkers || null}
                      initialDrawings={primaryDetail?.drawings || []}
                      initialDrawingAlerts={primaryDetail?.drawingAlerts || []}
                      botPriceAlerts={primaryAlerts}
                      onAddBotPriceAlert={(price, cond) =>
                        addPriceAlertQuick({ secid: selectedSecid, name: activeName, price, condition: cond })
                      }
                      onDeleteBotPriceAlert={(id) => deleteWatchAlertQuick(id)}
                      onToast={onToast}
                      defaultShowSR={false}
                      defaultShowVictor={false}
                      defaultShowDemark={false}
                      defaultShowRegression={false}
                      compactToolbar
                      fillHeight
                    />
                  </div>
                )}

                {!prefs.showIntraday && !prefs.showKline && (
                  <div className="st-term-pane" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)' }}>
                    <div>已关闭中心主图，点击右上角「定制布局」重新开启分时或 K 线。</div>
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => updatePrefs({ showIntraday: true, showKline: true })}>
                      恢复分时与 K 线
                    </button>
                  </div>
                )}
              </>
            )}

            {prefs.screens === '2h' && (
              <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <MultiChartTile
                  paneLabel="左屏"
                  secid={paneLinked.p1 ? selectedSecid : paneSecids.p1}
                  linked={paneLinked.p1}
                  onToggleLink={() => setPaneLinked((p) => ({ ...p, p1: !p.p1 }))}
                  onChangeSecid={(s) => setPaneSecids((p) => ({ ...p, p1: s }))}
                  initialMode="15m"
                  height={380}
                  isActive={isActive}
                  onOpenFullscreen={onOpenFullscreenStock}
                  onToast={onToast}
                />
                <MultiChartTile
                  paneLabel="右屏"
                  secid={paneLinked.p2 ? selectedSecid : paneSecids.p2}
                  linked={paneLinked.p2}
                  onToggleLink={() => setPaneLinked((p) => ({ ...p, p2: !p.p2 }))}
                  onChangeSecid={(s) => setPaneSecids((p) => ({ ...p, p2: s }))}
                  initialMode="day"
                  height={380}
                  isActive={isActive}
                  onOpenFullscreen={onOpenFullscreenStock}
                  onToast={onToast}
                />
              </div>
            )}

            {prefs.screens === '2v' && (
              <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: '1fr 1fr', gap: 6 }}>
                <MultiChartTile
                  paneLabel="上屏·大盘"
                  secid={paneLinked.p4 ? selectedSecid : paneSecids.p4}
                  linked={paneLinked.p4}
                  onToggleLink={() => setPaneLinked((p) => ({ ...p, p4: !p.p4 }))}
                  onChangeSecid={(s) => setPaneSecids((p) => ({ ...p, p4: s }))}
                  initialMode="intraday"
                  height={195}
                  compact
                  isActive={isActive}
                  onOpenFullscreen={onOpenFullscreenStock}
                  onToast={onToast}
                />
                <MultiChartTile
                  paneLabel="下屏·个股"
                  secid={paneLinked.p1 ? selectedSecid : paneSecids.p1}
                  linked={paneLinked.p1}
                  onToggleLink={() => setPaneLinked((p) => ({ ...p, p1: !p.p1 }))}
                  onChangeSecid={(s) => setPaneSecids((p) => ({ ...p, p1: s }))}
                  initialMode="day"
                  height={215}
                  compact
                  isActive={isActive}
                  onOpenFullscreen={onOpenFullscreenStock}
                  onToast={onToast}
                />
              </div>
            )}

            {prefs.screens === '4' && (
              <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 6 }}>
                {[
                  { key: 'p1', label: '屏1·分时', initMode: 'intraday' as const },
                  { key: 'p2', label: '屏2·15分', initMode: '15m' as const },
                  { key: 'p3', label: '屏3·日K', initMode: 'day' as const },
                  { key: 'p4', label: '屏4·大盘', initMode: 'intraday' as const },
                ].map((tile) => (
                  <MultiChartTile
                    key={tile.key}
                    paneLabel={tile.label}
                    secid={paneLinked[tile.key] ? selectedSecid : paneSecids[tile.key]}
                    linked={paneLinked[tile.key]}
                    onToggleLink={() => setPaneLinked((p) => ({ ...p, [tile.key]: !p[tile.key] }))}
                    onChangeSecid={(s) => setPaneSecids((p) => ({ ...p, [tile.key]: s }))}
                    initialMode={tile.initMode}
                    height={175}
                    compact
                    isActive={isActive}
                    onOpenFullscreen={onOpenFullscreenStock}
                    onToast={onToast}
                  />
                ))}
              </div>
            )}
          </div>

          {/* RIGHT COLUMN (Resizable Width + Resizable Top/Bottom Split) */}
          {prefs.showRight && (
            <>
              <div
                className={`st-splitter-v ${draggingHandle === 'right' ? 'dragging' : ''}`}
                onMouseDown={(e) => startVerticalDrag('right', e)}
                title="左右拖动调整右侧盘口与信号栏宽度"
              />
              <div
                ref={rightColRef}
                style={{
                  width: prefs.rightWidth,
                  flexShrink: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  overflow: 'hidden',
                }}
              >
                <div style={{ height: `${prefs.rightSplitPct}%`, minHeight: 170, display: 'flex', flexDirection: 'column' }}>
                  {renderDockWidget(prefs.slots.rightTop)}
                </div>
                <div
                  className={`st-splitter-h ${draggingHandle === 'right-h' ? 'dragging' : ''}`}
                  onMouseDown={(e) => startHorizontalDrag('right', rightColRef, e)}
                  title="上下拖动调整右侧盘口与信号流高度比例"
                />
                <div style={{ flex: 1, minHeight: 140, display: 'flex', flexDirection: 'column' }}>
                  {renderDockWidget(prefs.slots.rightBottom)}
                </div>
              </div>
            </>
          )}
        </div>

        <TradePlanCardModal
          open={showPlanCard}
          seed={{
            code: primaryDetail?.code || selectedSecid.split('.')[1] || '',
            name: activeName,
            entryPrice: activePrice != null ? Number(activePrice.toFixed(2)) : '',
            stopLossPrice: activePrice != null ? Number((activePrice * 0.95).toFixed(2)) : '',
          }}
          onClose={() => setShowPlanCard(false)}
          onToast={onToast}
        />
      </div>
    );
  }

  // =========================================================================
  // 视图 2：全景热力总览（9格温度 + 指数分时 + 6日轮动矩阵 + 6列快榜 + 24只迷你分时墙）
  // =========================================================================
  return (
    <div className="scroll-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="badge badge-crimson" style={{ fontSize: 12, padding: '4px 10px' }}>
            <Gauge size={13} /> {t('盘面温度', 'Temp')} {temp.sentimentScore != null ? temp.sentimentScore : '—'} · {node?.node || temp.stage || t('行情降级', 'Degraded')}
          </span>
          {node?.maxPositionPct != null && (
            <span className="badge badge-navy" style={{ fontSize: 11.5 }}>
              {t('仓位纪律上限', 'Pos Cap')}: {node.maxPositionPct}% · {node.channelLabel}
            </span>
          )}
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {t('交易日', 'Date')}: {data?.tradeDate || '—'} · {t('数据时点', 'As Of')}: {data?.asOf ? String(data.asOf).slice(0, 19) : t('暂缺', 'N/A')}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setViewMode('cockpit')}>
            <Zap size={13} /> {t('返回三栏联动盯盘驾驶舱', 'Back to 3-Col Cockpit')}
          </button>
          <button type="button" className="btn btn-sm" disabled={refreshing} onClick={() => loadAll(true)}>
            <RefreshCw size={13} className={refreshing ? 'spin' : ''} /> {t('刷新全景', 'Refresh')}
          </button>
        </div>
      </div>

      {/* Row 1: 9-Cell Temp + Index Intraday */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(290px, 1.05fr) minmax(300px, 1.35fr)', gap: 10 }}>
        <div className="panel" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 12.5 }}>{t('全市场微观盘面温度', 'Market Micro Temperature')}</strong>
            <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => onNavigateTab?.('st_ladder')}>
              {t('连板周期 →', 'Cycle →')}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
            {[
              { k: t('两市成交', 'Turnover'), v: formatYi(temp.twoMarketAmtYi), sub: temp.estFullDayAmtYi ? `${t('预估', 'Est')} ${formatYi(temp.estFullDayAmtYi)}` : '', c: 'var(--navy)' },
              {
                k: t('涨跌家数', 'Adv / Dec'),
                v: `${temp.up ?? '-'} : ${temp.down ?? '-'}`,
                sub: `${t('红盘率', 'Adv%')} ${temp.redRatePct ?? '-'}%`,
                c: temp.redRatePct == null ? 'var(--text-muted)' : pctColor(temp.redRatePct - 50),
              },
              { k: t('主力净流', 'Main Flow'), v: formatYi(temp.mainNetSumYi), sub: t('核心行业合计', 'Sector Sum'), c: pctColor(temp.mainNetSumYi) },
              { k: t('涨停 / 跌停', 'ZT / DT'), v: `${temp.ztCount ?? '-'} / ${temp.dtCount ?? '-'}`, sub: `20cm ${t('涨停', 'ZT')}: ${temp.zt20cmCount ?? '—'}`, c: upColor },
              {
                k: t('封板 / 炸板', 'Seal / Burst'),
                v: temp.sealRatePct != null ? `${temp.sealRatePct}%` : '—',
                sub: `${t('炸板', 'Burst')} ${temp.zbCount ?? '-'}`,
                c: temp.sealRatePct == null ? 'var(--text-muted)' : temp.sealRatePct >= 70 ? upColor : downColor,
              },
              { k: t('连板 / 高度', 'Streak / Max'), v: `${temp.lianbanCount ?? '—'} / ${temp.maxBoard ?? '—'}${t('板', 'B')}`, sub: t('最高连板高度', 'Max Board'), c: 'var(--amber)' },
              { k: t('昨涨停溢价', 'Yest ZT Ret'), v: formatPct(temp.yestZtPremiumPct), sub: t('短线接力情绪', 'Follow-through'), c: pctColor(temp.yestZtPremiumPct) },
              { k: t('昨连板溢价', 'Yest LB Ret'), v: formatPct(temp.yestLianbanPremiumPct), sub: t('高标赚钱效应', 'High-board'), c: pctColor(temp.yestLianbanPremiumPct) },
              {
                k: t('情绪评分', 'Temp Score'),
                v: temp.sentimentScore != null ? `${temp.sentimentScore} / 100` : '—',
                sub: node?.node || temp.stage || t('数据降级', 'Degraded'),
                c: temp.sentimentScore == null ? 'var(--text-muted)' : temp.sentimentScore >= 60 ? upColor : 'var(--amber)',
              },
            ].map((cell) => (
              <div key={cell.k} style={{ padding: '6px 7px', borderRadius: 7, background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{cell.k}</div>
                <div className="mono num" style={{ fontSize: 13, fontWeight: 800, color: cell.c, marginTop: 2 }}>{cell.v}</div>
                <div style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{cell.sub}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 4 }}>
              <button type="button" className={`btn btn-sm ${indexView === 'sse' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setIndexView('sse')}>
                上证指数分时
              </button>
              <button type="button" className={`btn btn-sm ${indexView === 'chinext' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setIndexView('chinext')}>
                创业板指分时
              </button>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenFullscreenStock(indexView === 'sse' ? '1.000001' : '0.399006')}>
              <Maximize2 size={11} /> 全屏 K 线
            </button>
          </div>
          <IntradayVolumeChart
            intraday={indexView === 'sse' ? data?.indexIntraday?.sse : data?.indexIntraday?.chinext}
            currencySymbol=""
            height={175}
            interactive
          />
        </div>
      </div>

      {/* Row 2: 6-Day Theme Rotation + Sector Capital Flow */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1.2fr)', gap: 10 }}>
        <div className="panel" style={{ padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 12.5 }}>近 6 日主线题材轮动矩阵（点击切回驾驶舱联动查看成分）</strong>
            <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => onNavigateTab?.('st_themes')}>
              题材小表格 &amp; 四象限 →
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, (data?.themeRotation6d || []).length)}, minmax(0, 1fr))`, gap: 6 }}>
            {(data?.themeRotation6d || []).map((day: any) => (
              <div key={day.date} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div className="mono" style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, padding: '3px 0', background: 'var(--bg-subtle)', borderRadius: 5 }}>
                  {String(day.date).slice(5)}
                </div>
                {(day.themes || []).slice(0, 5).map((th: any, idx: number) => (
                  <div
                    key={`${day.date}-${th.code}-${idx}`}
                    style={{
                      cursor: 'pointer',
                      padding: '5px 6px',
                      borderRadius: 6,
                      background: idx === 0 ? 'var(--crimson-soft)' : 'var(--bg-subtle)',
                      border: '1px solid var(--border)',
                      fontSize: 11,
                    }}
                    onClick={() => {
                      handleSelectSector(th);
                      setViewMode('cockpit');
                    }}
                  >
                    <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{th.name}</div>
                    <div className="mono num" style={{ fontSize: 10.5, color: pctColor(th.pct), fontWeight: 700 }}>
                      {formatPct(th.pct)} · {formatYi(th.mainNetYi)}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="panel" style={{ padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 5 }}>
              <button type="button" className={`btn btn-sm ${sectorKind === 'concept' ? 'btn-primary' : ''}`} onClick={() => setSectorKind('concept')}>
                热点概念主力净流入
              </button>
              <button type="button" className={`btn btn-sm ${sectorKind === 'industry' ? 'btn-primary' : ''}`} onClick={() => setSectorKind('industry')}>
                行业板块主力净流入
              </button>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => onNavigateTab?.('st_clouds')}>
              题材/情绪双云图 →
            </button>
          </div>
          <div style={{ maxHeight: 230, overflowY: 'auto' }}>
            <table className="data-table" style={{ fontSize: 11.5 }}>
              <thead>
                <tr>
                  <th>板块</th>
                  <th>涨幅</th>
                  <th>主力净额</th>
                  <th>领涨龙头</th>
                </tr>
              </thead>
              <tbody>
                {sectorList.slice(0, 12).map((s: any) => (
                  <tr
                    key={s.code}
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      handleSelectSector(s);
                      setViewMode('cockpit');
                    }}
                  >
                    <td style={{ fontWeight: 700 }}>{s.name}</td>
                    <td className="mono num" style={{ color: pctColor(s.pct), fontWeight: 700 }}>{formatPct(s.pct)}</td>
                    <td className="mono num" style={{ color: pctColor(s.mainNetYi), fontWeight: 700 }}>{formatYi(s.mainNetYi)}</td>
                    <td>
                      {s.leaderName} <span className="mono num" style={{ color: pctColor(s.leaderPct) }}>{formatPct(s.leaderPct)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Row 3: 6-Column Rapid Leaderboards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 8 }}>
        {[
          { title: '异动监管雷达', icon: <ShieldAlert size={12} color="var(--crimson)" />, rows: (lbs.anomalies || []).slice(0, 12), renderVal: (r: any) => <span className="mono" style={{ fontSize: 10.5, color: r.riskLevel === 'triggered' ? 'var(--crimson)' : 'var(--amber)', fontWeight: 700 }}>{r.dev10dPct >= 100 ? '已触发' : `余${r.gapTo100Pct}%`}</span> },
          { title: '连板情绪榜', icon: <Flame size={12} color="var(--crimson)" />, rows: (lbs.lianban || []).slice(0, 12), renderVal: (r: any) => <span className="badge badge-crimson" style={{ fontSize: 10, padding: '0 4px' }}>{r.lbc}板</span> },
          { title: '大肉涨幅前 20', icon: <TrendingUp size={12} color={upColor} />, rows: (lbs.gainers || []).slice(0, 12), renderVal: (r: any) => <span className="mono" style={{ color: pctColor(r.pct), fontWeight: 700 }}>{formatPct(r.pct)}</span> },
          { title: '大面跌幅前 20', icon: <TrendingDown size={12} color={downColor} />, rows: (lbs.losers || []).slice(0, 12), renderVal: (r: any) => <span className="mono" style={{ color: pctColor(r.pct), fontWeight: 700 }}>{formatPct(r.pct)}</span> },
          { title: '主力流入前 20', icon: <Zap size={12} color={upColor} />, rows: (lbs.mainInflows || []).slice(0, 12), renderVal: (r: any) => <span className="mono" style={{ color: pctColor(r.mainNetYi), fontWeight: 700 }}>{formatYi(r.mainNetYi)}</span> },
          { title: '主力流出前 20', icon: <Activity size={12} color={downColor} />, rows: (lbs.mainOutflows || []).slice(0, 12), renderVal: (r: any) => <span className="mono" style={{ color: pctColor(r.mainNetYi), fontWeight: 700 }}>{formatYi(r.mainNetYi)}</span> },
        ].map((col) => (
          <div key={col.title} className="panel" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontWeight: 700, fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 4, borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>
              {col.icon} {col.title}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 260, overflowY: 'auto' }}>
              {col.rows.map((r: any, idx: number) => (
                <div
                  key={`${r.secid || r.code}-${idx}`}
                  onClick={() => {
                    if (r.secid) {
                      selectStock(r.secid, r.name);
                      setViewMode('cockpit');
                    }
                  }}
                  onDoubleClick={() => r.secid && onOpenFullscreenStock(r.secid)}
                  style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 4px', borderRadius: 4, fontSize: 11 }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 80, fontWeight: 600 }}>{r.name}</span>
                  {col.renderVal(r)}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Row 4: 4-Column 24-Stock Intraday Sparkline Wall */}
      <div className="panel" style={{ padding: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <strong style={{ fontSize: 12.5 }}>盘中迷你分时瀑布流（单击联动驾驶舱 · 双击全屏K线）</strong>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>一屏扫 24 只核心强势/异动/承压股分时强弱结构</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
          {(data?.sparklineWall || []).map((group: any) => (
            <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, padding: '4px 8px', borderRadius: 6, background: 'var(--bg-subtle)' }}>
                {t(group.titleZh, group.titleEn)}
              </div>
              {(group.items || []).map((st: any) => (
                <div
                  key={st.secid}
                  onClick={() => {
                    selectStock(st.secid, st.name);
                    setViewMode('cockpit');
                  }}
                  onDoubleClick={() => onOpenFullscreenStock(st.secid)}
                  style={{
                    cursor: 'pointer',
                    display: 'grid',
                    gridTemplateColumns: '76px 1fr 56px',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 7px',
                    borderRadius: 7,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-card)',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.name}</div>
                    <div className="mono" style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{st.code}</div>
                  </div>
                  <MiniSparkline points={st.intraday?.points || []} preClose={st.intraday?.preClose} color={pctColor(st.pct)} />
                  <div style={{ textAlign: 'right' }}>
                    <div className="mono num" style={{ fontSize: 11.5, fontWeight: 800, color: pctColor(st.pct) }}>{formatPct(st.pct)}</div>
                    <div className="mono num" style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>{st.amountYi != null ? formatYi(st.amountYi) : ''}</div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
