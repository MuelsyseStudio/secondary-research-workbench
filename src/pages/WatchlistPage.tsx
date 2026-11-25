import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  Clock,
  Crosshair,
  Gauge,
  Globe,
  History,
  LayoutGrid,
  Loader2,
  Maximize2,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Table2,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import { useI18n, currencyPrefixStatic } from '../i18n';
import { CRYPTO_ENABLED } from '../config/edition';
import type {
  EntityRef,
  GlobalMarketsOverviewResponse,
  JudgmentEntry,
  KlineTimeframe,
  MarketKind,
  SecurityDetailData,
  SecuritySearchItem,
  WatchlistItem,
  WatchlistLiveResponse,
  WatchlistQuoteItem,
  WorkspaceData,
} from '../types';
import { IntradayVolumeChart } from '../components/IntradayVolumeChart';
import { InteractiveKlineChart } from '../components/InteractiveKlineChart';

interface WatchlistPageProps {
  workspace: WorkspaceData;
  isActive: boolean;
  onOpenEntity: (ref: EntityRef) => void;
  onPreviewEntity: (ref: EntityRef) => void;
  onQuickAnalyzeStock: (queryLabel: string) => void;
  onOpenTechnical?: (secidOrQuery: string) => void;
  onOpenFullscreenStock?: (secidOrQuery: string) => void;
  onNavigateShortTerm?: () => void;
  onToast: (msg: string) => void;
}

type MarketFilter = 'ALL' | 'CN' | 'US' | 'HK' | 'GLOBAL' | 'FUT' | 'CRYPTO';
type SortMode = 'custom' | 'pctDesc' | 'pctAsc' | 'amountDesc' | 'volRatioDesc';

function currencyPrefix(currency: string) {
  return currencyPrefixStatic(currency);
}

function pctColor(v: number | null | undefined) {
  if (v == null) return 'var(--text-muted)';
  if (v > 0) return '#dc2626';
  if (v < 0) return '#16a34a';
  return 'var(--text-secondary)';
}

function formatPct(v: number | null | undefined) {
  if (v == null) return '--';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function formatPrice(v: number | null | undefined, currency: string) {
  if (v == null) return '--';
  return `${currencyPrefix(currency)}${v.toFixed(2)}`;
}

function formatAmount(item: WatchlistQuoteItem) {
  if (item.marketKind === 'US') {
    if (item.amountUsdB != null && item.amountUsdB >= 1) return `$${item.amountUsdB.toFixed(2)}B`;
    if (item.amountUsdM != null) return `$${item.amountUsdM.toFixed(1)}M`;
    return '--';
  }
  if (item.amountYi != null) return `${item.amountYi.toFixed(2)}亿`;
  return '--';
}

function formatVolume(item: WatchlistQuoteItem) {
  if (item.volume == null) return '--';
  if (item.marketKind === 'US') {
    if (item.volume >= 1e6) return `${(item.volume / 1e6).toFixed(2)}M股`;
    if (item.volume >= 1e3) return `${(item.volume / 1e3).toFixed(1)}K股`;
    return `${item.volume}股`;
  }
  // 东财 A股 f5 单位为手
  if (item.volume >= 1e4) return `${(item.volume / 1e4).toFixed(1)}万手`;
  return `${item.volume.toLocaleString()}手`;
}

function formatMarketCap(item: WatchlistQuoteItem) {
  if (item.marketKind === 'US') {
    if (item.totalCapUsdB == null) return '--';
    if (item.totalCapUsdB >= 1000) return `$${(item.totalCapUsdB / 1000).toFixed(2)}T`;
    return `$${item.totalCapUsdB.toFixed(1)}B`;
  }
  if (item.totalCapYi == null) return '--';
  return `${item.totalCapYi.toFixed(0)}亿`;
}

export const WatchlistPage: React.FC<WatchlistPageProps> = ({
  workspace,
  isActive,
  onOpenEntity,
  onPreviewEntity,
  onQuickAnalyzeStock,
  onOpenTechnical,
  onOpenFullscreenStock,
  onNavigateShortTerm,
  onToast,
}) => {
  const { t, pctColor: i18nPctColor, formatPrice: i18nFormatPrice, marketBadgeLabel } = useI18n();
  const [board, setBoard] = useState<WatchlistLiveResponse | null>(null);
  const [globalOverview, setGlobalOverview] = useState<GlobalMarketsOverviewResponse | null>(null);
  const [marketTemp, setMarketTemp] = useState<any | null>(null);
  const [explorerTab, setExplorerTab] = useState<'watchlist' | 'global_stocks' | 'futures' | 'crypto'>('watchlist');
  const [showMacroAnchors, setShowMacroAnchors] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [refreshSec, setRefreshSec] = useState<number>(15); // 5 | 15 | 30 | 0(manual)
  const [marketFilter, setMarketFilter] = useState<MarketFilter>('ALL');
  const [sortMode, setSortMode] = useState<SortMode>('custom');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');

  // 统一跨市场证券搜索与添加
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState<SecuritySearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [savingList, setSavingList] = useState(false);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  // 单标高清详情弹窗（分时成交量 + 多周期可缩放 K 线）
  const [detailSecid, setDetailSecid] = useState<string | null>(null);
  const [detailTimeframe, setDetailTimeframe] = useState<KlineTimeframe>('day');
  const [detailData, setDetailData] = useState<SecurityDetailData | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // 全市场量化策略 B/S 信号批量叠加
  const [liveStrategies, setLiveStrategies] = useState<any[]>([]);
  const [activeOverlayStrategyId, setActiveOverlayStrategyId] = useState<string>(() => {
    try {
      return localStorage.getItem('srw_active_live_strategy_id_v1') || '';
    } catch {
      return '';
    }
  });
  const [strategySignalMap, setStrategySignalMap] = useState<Record<string, any>>({});
  const [scanningSignals, setScanningSignals] = useState(false);

  useEffect(() => {
    const loadStrats = () => {
      api
        .listPublishedStrategies()
        .then((r) => setLiveStrategies(r.allStrategies || []))
        .catch(() => {});
      try {
        setActiveOverlayStrategyId(localStorage.getItem('srw_active_live_strategy_id_v1') || '');
      } catch {
        // ignore
      }
    };
    loadStrats();
    window.addEventListener('srw-published-strategies-changed', loadStrats);
    return () => window.removeEventListener('srw-published-strategies-changed', loadStrats);
  }, []);

  const boardSecidsSig = (board?.items || []).map((x) => x.secid).join(',');
  useEffect(() => {
    if (!activeOverlayStrategyId || !board?.items?.length) {
      setStrategySignalMap({});
      return;
    }
    let cancelled = false;
    setScanningSignals(true);
    api
      .evaluateStrategyBatch({
        strategyId: activeOverlayStrategyId,
        secids: board.items.map((x) => x.secid),
        timeframe: 'day',
      })
      .then((res) => {
        if (!cancelled && res.ok) setStrategySignalMap(res.results || {});
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setScanningSignals(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeOverlayStrategyId, boardSecidsSig]);

  const fetchBoard = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const data = await api.getWatchlistLive(true);
      setBoard((prev) => {
        if (!prev) return data;
        const prevIntraBySecid = new Map(prev.items.map((x) => [x.secid, x.intraday]));
        return {
          ...data,
          items: data.items.map((item) => ({
            ...item,
            intraday: item.intraday?.available ? item.intraday : prevIntraBySecid.get(item.secid) || item.intraday,
          })),
        };
      });
    } catch (err: any) {
      setError(err.message || '实时行情拉取失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // 首次加载（同时拉取全球股市/期货/加密货币总览 + A股盘面温度条）
  useEffect(() => {
    fetchBoard(true);
    api.getGlobalMarketsOverview().then(setGlobalOverview).catch(() => {});
    api.getTechnicalRadar().then((r) => setMarketTemp(r.sentiment)).catch(() => {});
  }, [fetchBoard]);

  // 仅当看板处于当前激活页签、页面可见且开启自动刷新时定时轮询（切页/最小化自动静默暂停）
  useEffect(() => {
    if (!isActive || refreshSec <= 0) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchBoard(false);
    }, refreshSec * 1000);
    return () => clearInterval(timer);
  }, [isActive, refreshSec, fetchBoard]);

  // 搜索防抖
  useEffect(() => {
    const q = searchInput.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.searchSecurities(q);
        setSearchResults(res.items || []);
        setDropdownOpen(true);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 260);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 点击外部关闭搜索下拉
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // 打开单标高清分时+多周期K线弹窗
  const openDetailModal = async (secid: string, tf: KlineTimeframe = 'day') => {
    setDetailSecid(secid);
    setDetailTimeframe(tf);
    if (!detailData || detailData.secid !== secid) setDetailData(null);
    setLoadingDetail(true);
    try {
      const res = await api.getSecurityDetail(secid, tf);
      setDetailData(res);
    } catch (err: any) {
      onToast(`加载详情图表失败：${err.message}`);
    } finally {
      setLoadingDetail(false);
    }
  };

  // 将现有台账研判按 code / name 建索引，方便卡片直接显示历史研判徽章
  const judgmentByStock = useMemo(() => {
    const map = new Map<string, JudgmentEntry[]>();
    for (const j of workspace.ledger.judgments) {
      if (j.stockCode) {
        const k = j.stockCode.toUpperCase();
        map.set(k, [...(map.get(k) || []), j]);
      }
      if (j.stockName) {
        map.set(j.stockName, [...(map.get(j.stockName) || []), j]);
      }
    }
    return map;
  }, [workspace.ledger.judgments]);

  const findLinkedJudgments = (item: WatchlistQuoteItem): JudgmentEntry[] => {
    const byCode = judgmentByStock.get(item.code.toUpperCase()) || [];
    if (byCode.length > 0) return byCode;
    return judgmentByStock.get(item.name) || [];
  };

  const existingSecids = useMemo(
    () => new Set((board?.items || []).map((x) => x.secid)),
    [board?.items]
  );

  const handleAddSecurity = async (cand: SecuritySearchItem) => {
    if (existingSecids.has(cand.secid)) {
      onToast(`${cand.name} (${cand.secuCode}) 已在自选看板中`);
      setDropdownOpen(false);
      return;
    }
    setSavingList(true);
    try {
      const currentItems: WatchlistItem[] = (board?.items || []).map((x) => ({
        secid: x.secid,
        code: x.code,
        secuCode: x.secuCode,
        name: x.name,
        marketKind: x.marketKind,
        currency: x.currency,
        group: x.group,
        note: x.note,
      }));
      const newItem: WatchlistItem = {
        secid: cand.secid,
        code: cand.code,
        secuCode: cand.secuCode,
        name: cand.name,
        marketKind: cand.marketKind,
        currency: cand.currency,
        group: cand.marketKind === 'US' ? '美股自选' : cand.marketKind === 'HK' ? '港股自选' : 'A股自选',
        note: cand.boardType,
      };
      await api.saveWatchlist({ items: [newItem, ...currentItems], workspaceRoot: board?.workspaceRoot });
      setSearchInput('');
      setSearchResults([]);
      setDropdownOpen(false);
      onToast(`已添加自选：${cand.name} (${cand.secuCode})`);
      await fetchBoard(false);
    } catch (err: any) {
      onToast(`添加失败：${err.message}`);
    } finally {
      setSavingList(false);
    }
  };

  const handleRemoveSecurity = async (target: WatchlistQuoteItem) => {
    setSavingList(true);
    try {
      const remaining: WatchlistItem[] = (board?.items || [])
        .filter((x) => x.secid !== target.secid)
        .map((x) => ({
          secid: x.secid,
          code: x.code,
          secuCode: x.secuCode,
          name: x.name,
          marketKind: x.marketKind,
          currency: x.currency,
          group: x.group,
          note: x.note,
        }));
      await api.saveWatchlist({ items: remaining, workspaceRoot: board?.workspaceRoot });
      onToast(`已从自选看板移除：${target.name}`);
      await fetchBoard(false);
    } catch (err: any) {
      onToast(`移除失败：${err.message}`);
    } finally {
      setSavingList(false);
    }
  };

  const handleResetDefaults = async () => {
    setConfirmReset(false);
    setSavingList(true);
    try {
      await api.saveWatchlist({ reset: true, workspaceRoot: board?.workspaceRoot });
      onToast('已恢复默认示例自选组合');
      await fetchBoard(false);
    } catch (err: any) {
      onToast(`恢复失败：${err.message}`);
    } finally {
      setSavingList(false);
    }
  };

  const filteredItems = useMemo(() => {
    const raw = (board?.items || []).filter((it) => {
      if (marketFilter === 'ALL') return true;
      if (marketFilter === 'GLOBAL') return ['TW', 'KR', 'FR', 'UK', 'JP', 'DE'].includes(it.marketKind);
      return it.marketKind === marketFilter;
    });
    if (sortMode === 'custom') return raw;
    const copy = [...raw];
    if (sortMode === 'pctDesc') copy.sort((a, b) => (b.pct ?? -999) - (a.pct ?? -999));
    else if (sortMode === 'pctAsc') copy.sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999));
    else if (sortMode === 'amountDesc') copy.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
    else if (sortMode === 'volRatioDesc') copy.sort((a, b) => (b.volumeRatio ?? -1) - (a.volumeRatio ?? -1));
    return copy;
  }, [board?.items, marketFilter, sortMode]);

  const cnBenchmarks = (board?.benchmarks || []).filter((b) => b.marketKind === 'CN');
  const globalBenchmarks = (board?.benchmarks || []).filter((b) => b.marketKind !== 'CN');

  const marketBadge = (kind: MarketKind) => {
    const cls =
      kind === 'US'
        ? 'badge-navy'
        : kind === 'HK'
        ? 'badge-violet'
        : kind === 'FUT'
        ? 'badge-amber'
        : CRYPTO_ENABLED && kind === 'CRYPTO'
        ? 'badge-crimson'
        : ['TW', 'KR', 'FR', 'UK', 'JP', 'DE'].includes(kind)
        ? 'badge-emerald'
        : 'badge-teal';
    return (
      <span className={`badge ${cls}`} style={{ padding: '1px 5px', fontSize: 10.5 }}>
        {marketBadgeLabel(kind)}
      </span>
    );
  };

  const pairToneClass = (tone: string) => {
    if (tone === 'crimson') return 'badge-crimson';
    if (tone === 'amber') return 'badge-amber';
    if (tone === 'teal') return 'badge-teal';
    if (tone === 'emerald') return 'badge-emerald';
    if (tone === 'navy') return 'badge-navy';
    return 'badge-muted';
  };

  return (
    <div className="scroll-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 全球多市场顶层视图切换（复用顶部 MarketTickerStrip 盘面温度，不再重复堆叠温度条） */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { id: 'watchlist', label: t('我的自选', 'My Watchlist') },
            { id: 'global_stocks', label: t('全球股市', 'Global Equities') },
            { id: 'futures', label: t('大宗期货', 'World Futures') },
            ...(CRYPTO_ENABLED ? [{ id: 'crypto', label: t('加密货币 24/7', 'Crypto 24/7') }] : []),
          ].map((tb) => (
            <button
              key={tb.id}
              type="button"
              className={`btn btn-sm ${explorerTab === tb.id ? 'btn-primary' : ''}`}
              onClick={() => setExplorerTab(tb.id as any)}
            >
              {tb.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {explorerTab === 'watchlist' && board && (board.benchmarks.length > 0 || board.crossPairs.length > 0) && (
            <button
              type="button"
              className={`btn btn-sm ${showMacroAnchors ? 'btn-primary' : ''}`}
              onClick={() => setShowMacroAnchors((v) => !v)}
            >
              <Globe size={12} /> {showMacroAnchors ? '收起跨市场指数与联动' : '展开跨市场指数与中美联动'}
            </button>
          )}
          {onNavigateShortTerm && (
            <button type="button" className="btn btn-sm" onClick={onNavigateShortTerm}>
              <Zap size={12} color="var(--crimson)" /> {t('短线看盘', 'Short-Term')}
            </button>
          )}
        </div>
      </div>

      {/* 全球股市 / 世界期货一键实盘浏览与添加面板 */}
      {explorerTab !== 'watchlist' && globalOverview && (
        <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <strong style={{ fontSize: 14 }}>
              {explorerTab === 'global_stocks'
                ? t('全球核心交易所实盘（台湾 TWSE · 韩国 KRX · 法国 XPAR · 英国 LSE · 日本 JPX · 德国 XETR）', 'Global Stock Exchanges (TWSE · KRX · Euronext Paris · LSE · JPX · XETRA)')
                : explorerTab === 'futures' || !CRYPTO_ENABLED
                ? t('世界各地期货交易所实时行情（COMEX · NYMEX · CBOT/CME · LME · ICE · SGX · 上期/大商/郑商/广期/INE）', 'World Futures Exchanges Live Board')
                : t('加密货币 24/7 现货实盘（点击一键全屏看多周期 K 线或设 Bot 预警）', 'Crypto 24/7 Live Spot Board')}
            </strong>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => api.getGlobalMarketsOverview().then(setGlobalOverview).catch(() => {})}
            >
              <RefreshCw size={12} /> {t('刷新全球实盘', 'Refresh')}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {(explorerTab === 'global_stocks'
              ? globalOverview.globalStocks
              : explorerTab === 'futures' || !CRYPTO_ENABLED
              ? globalOverview.futures
              : globalOverview.cryptos
            ).map((it) => {
              const already = existingSecids.has(it.secid);
              return (
                <div
                  key={it.secid}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 9,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                    <span className="badge badge-navy" style={{ fontSize: 10 }}>{it.exchange} · {it.currency}</span>
                    {it.categoryZh && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t(it.categoryZh, it.categoryEn || it.categoryZh)}</span>}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 13 }}>{t(it.name, it.nameEn || it.name)}</div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{it.secuCode}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="mono" style={{ fontWeight: 800, fontSize: 14 }}>{i18nFormatPrice(it.price, it.currency)}</div>
                      <div className="mono" style={{ fontWeight: 700, fontSize: 12, color: i18nPctColor(it.pct) }}>{formatPct(it.pct)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 5, marginTop: 2 }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      style={{ flex: 1, justifyContent: 'center', fontSize: 11, padding: '3px 6px' }}
                      onClick={() => onOpenFullscreenStock?.(it.secid)}
                    >
                      <Maximize2 size={11} /> {t('全屏研究', 'Fullscreen')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={already || savingList}
                      style={{ fontSize: 11, padding: '3px 8px' }}
                      onClick={() =>
                        handleAddSecurity({
                          resolved: true,
                          marketKind: it.marketKind,
                          currency: it.currency,
                          mktNum: it.secid.split('.')[0],
                          secid: it.secid,
                          code: it.code,
                          market: it.exchange,
                          secuCode: it.secuCode,
                          name: it.name,
                          boardType: it.exchange,
                          classify: it.marketKind,
                        })
                      }
                    >
                      {already ? t('已自选', 'Added') : t('+ 自选', '+ Watch')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 顶部控制栏：搜索添加跨市场自选 + 自动刷新控制 + 视图筛选 */}
      <div className="panel panel-pad" style={{ padding: '14px 18px', display: explorerTab === 'watchlist' ? 'flex' : 'none', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          {/* 跨市场自选添加搜索框 */}
          <div ref={searchWrapRef} style={{ position: 'relative', flex: '1 1 340px', maxWidth: 540 }}>
            <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: 11, top: 11, pointerEvents: 'none' }} />
            <input
              className="input"
              style={{ paddingLeft: 33, paddingRight: 32 }}
              placeholder={
                CRYPTO_ENABLED
                  ? t(
                      '搜全球股票 / 期货 / BTC（如 2330.TW 台积电 / 三星 / LVMH / 壳牌 / COMEX黄金 / BTC）',
                      'Search Global Stocks / Futures / BTC (e.g. NVDA, 2330.TW, LVMH, SHEL, Gold, BTC)'
                    )
                  : t(
                      '搜全球股票 / 期货（如 2330.TW 台积电 / 三星 / LVMH / 壳牌 / COMEX黄金）',
                      'Search Global Stocks / Futures (e.g. NVDA, 2330.TW, LVMH, SHEL, Gold)'
                    )
              }
              value={searchInput}
              onFocus={() => searchResults.length > 0 && setDropdownOpen(true)}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            {searching && (
              <Loader2 size={14} className="spin" color="var(--navy)" style={{ position: 'absolute', right: 10, top: 11 }} />
            )}
            {!searching && searchInput && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setSearchInput('');
                  setSearchResults([]);
                  setDropdownOpen(false);
                }}
                style={{ position: 'absolute', right: 8, top: 7, border: 'none', padding: 3, cursor: 'pointer' }}
              >
                <X size={14} />
              </button>
            )}

            {dropdownOpen && searchResults.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 5px)',
                  left: 0,
                  right: 0,
                  zIndex: 60,
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 10,
                  boxShadow: 'var(--shadow-md)',
                  maxHeight: 320,
                  overflowY: 'auto',
                  padding: 5,
                }}
              >
                {searchResults.map((cand) => {
                  const already = existingSecids.has(cand.secid);
                  return (
                    <button
                      key={cand.secid}
                      type="button"
                      disabled={savingList}
                      onClick={() => handleAddSecurity(cand)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '7px 10px',
                        borderRadius: 7,
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left',
                        color: 'var(--text)',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                        {marketBadge(cand.marketKind)}
                        <strong style={{ fontSize: 13 }}>{cand.name}</strong>
                        <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 12 }}>{cand.secuCode}</span>
                        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{cand.boardType}</span>
                      </div>
                      <span className={`badge ${already ? 'badge-muted' : 'badge-emerald'}`} style={{ fontSize: 11 }}>
                        {already ? '已在自选' : <><Plus size={11} /> 加入看板</>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 实时刷新与量化策略 B/S 叠加 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            {liveStrategies.length > 0 && (
              <select
                className="input"
                value={activeOverlayStrategyId}
                onChange={(e) => {
                  const next = e.target.value;
                  setActiveOverlayStrategyId(next);
                  try {
                    if (next) localStorage.setItem('srw_active_live_strategy_id_v1', next);
                    else localStorage.removeItem('srw_active_live_strategy_id_v1');
                  } catch {
                    // ignore
                  }
                  window.dispatchEvent(new Event('srw-published-strategies-changed'));
                }}
                style={{
                  height: 28,
                  fontSize: 11.5,
                  padding: '0 8px',
                  maxWidth: 190,
                  borderColor: activeOverlayStrategyId ? '#7c3aed' : 'var(--border)',
                  color: activeOverlayStrategyId ? '#7c3aed' : 'var(--text)',
                  fontWeight: activeOverlayStrategyId ? 700 : 500,
                }}
                title="叠加已提取的量化策略指标，自动扫描自选股并标注「策B / 策S」实时信号"
              >
                <option value="">策略B/S叠加：关闭</option>
                {liveStrategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.builtinPreset ? '★ ' : '⚡ '}
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            {scanningSignals && <Loader2 size={13} className="spin" color="#7c3aed" />}
            <div className="seg-tabs" title="盘中自动刷新频率（切走页签会自动暂停节流）">
              {[
                { sec: 5, label: '5秒' },
                { sec: 15, label: '15秒' },
                { sec: 30, label: '30秒' },
                { sec: 0, label: '手动' },
              ].map((opt) => (
                <button
                  key={opt.sec}
                  type="button"
                  className={`seg-tab ${refreshSec === opt.sec ? 'active' : ''}`}
                  style={{ padding: '4px 9px', fontSize: 12 }}
                  onClick={() => setRefreshSec(opt.sec)}
                >
                  {opt.sec > 0 && refreshSec === opt.sec && (
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 99,
                        background: 'var(--emerald)',
                        display: 'inline-block',
                      }}
                    />
                  )}
                  {opt.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={refreshing}
              onClick={() => fetchBoard(false)}
            >
              <RefreshCw size={13} className={refreshing ? 'spin' : ''} />
              {refreshing ? '刷新中' : '立即刷新'}
            </button>

            {confirmReset ? (
              <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ background: 'var(--crimson)', color: '#fff', borderColor: 'var(--crimson)' }}
                  disabled={savingList}
                  onClick={handleResetDefaults}
                >
                  确认重置
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmReset(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={savingList}
                onClick={() => setConfirmReset(true)}
                title="重置当前空间自选为默认示例组合（需二次确认）"
              >
                <RotateCcw size={13} /> 恢复默认
              </button>
            )}

            {board?.fetchedAt && (
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Clock size={12} /> {board.fetchedAt.slice(11, 19)}
              </span>
            )}
          </div>
        </div>

        {/* 第二行：市场筛选 + 排序 + 卡片/表格切换 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div className="seg-tabs">
              <button type="button" className={`seg-tab ${marketFilter === 'ALL' ? 'active' : ''}`} onClick={() => setMarketFilter('ALL')}>
                全部 ({board?.summary.total ?? 0})
              </button>
              <button type="button" className={`seg-tab ${marketFilter === 'CN' ? 'active' : ''}`} onClick={() => setMarketFilter('CN')}>
                A股 ({board?.summary.cnCount ?? 0})
              </button>
              <button type="button" className={`seg-tab ${marketFilter === 'US' ? 'active' : ''}`} onClick={() => setMarketFilter('US')}>
                {t('美股', 'US')} ({board?.summary.usCount ?? 0})
              </button>
              {(board?.summary.hkCount || 0) > 0 && (
                <button type="button" className={`seg-tab ${marketFilter === 'HK' ? 'active' : ''}`} onClick={() => setMarketFilter('HK')}>
                  {t('港股', 'HK')} ({board?.summary.hkCount ?? 0})
                </button>
              )}
              {(board?.summary.globalCount || 0) > 0 && (
                <button type="button" className={`seg-tab ${marketFilter === 'GLOBAL' ? 'active' : ''}`} onClick={() => setMarketFilter('GLOBAL')}>
                  {t('台韩欧日', 'Global')} ({board?.summary.globalCount ?? 0})
                </button>
              )}
              {(board?.summary.futCount || 0) > 0 && (
                <button type="button" className={`seg-tab ${marketFilter === 'FUT' ? 'active' : ''}`} onClick={() => setMarketFilter('FUT')}>
                  {t('期货', 'Futures')} ({board?.summary.futCount ?? 0})
                </button>
              )}
              {CRYPTO_ENABLED && (board?.summary.cryptoCount || 0) > 0 && (
                <button type="button" className={`seg-tab ${marketFilter === 'CRYPTO' ? 'active' : ''}`} onClick={() => setMarketFilter('CRYPTO')}>
                  {t('加密', 'Crypto')} ({board?.summary.cryptoCount ?? 0})
                </button>
              )}
            </div>

            {board && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                涨 <strong style={{ color: '#dc2626' }} className="num">{board.summary.upCount}</strong> · 跌{' '}
                <strong style={{ color: '#16a34a' }} className="num">{board.summary.downCount}</strong>
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <select
              className="select"
              style={{ width: 'auto', padding: '4px 10px', fontSize: 12.5 }}
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
            >
              <option value="custom">排序：自选默认顺序</option>
              <option value="pctDesc">排序：涨幅由高到低</option>
              <option value="pctAsc">排序：跌幅由深到浅</option>
              <option value="amountDesc">排序：成交额最大</option>
              <option value="volRatioDesc">排序：量比最高</option>
            </select>

            <div className="seg-tabs">
              <button type="button" className={`seg-tab ${viewMode === 'cards' ? 'active' : ''}`} onClick={() => setViewMode('cards')}>
                <LayoutGrid size={13} /> 分时卡片
              </button>
              <button type="button" className={`seg-tab ${viewMode === 'table' ? 'active' : ''}`} onClick={() => setViewMode('table')}>
                <Table2 size={13} /> 行情列表
              </button>
            </div>
          </div>
        </div>
      </div>

      {explorerTab === 'watchlist' && (
        <>
      {error && (
        <div className="panel panel-pad" style={{ borderColor: 'var(--crimson)', background: 'var(--crimson-soft)', color: 'var(--crimson)', fontSize: 13 }}>
          行情拉取异常：{error}
        </div>
      )}

      {/* 模块一：中美港核心基准指数条（默认折叠，优先把首屏黄金区域留给用户自选股） */}
      {showMacroAnchors && board && board.benchmarks.length > 0 && (
        <div className="panel" style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Globe size={14} color="var(--navy)" />
              跨市场核心指数实时锚（A股 vs 美股 / 费城半导体 SOX / 恒生）
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>红涨绿跌 · 实时公开行情</span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 8,
            }}
          >
            {[...cnBenchmarks, ...globalBenchmarks].map((b) => {
              const up = (b.pct ?? 0) >= 0;
              return (
                <div
                  key={b.secid}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: 'var(--bg-soft)',
                    border: '1px solid var(--border)',
                    borderLeft: `3px solid ${b.marketKind === 'CN' ? 'var(--teal)' : b.marketKind === 'US' ? 'var(--navy)' : 'var(--violet)'}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{b.name}</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {b.marketKind === 'US' ? 'US' : b.marketKind === 'HK' ? 'HK' : 'CN'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 4 }}>
                    <span className="mono num" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                      {b.price != null ? b.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--'}
                    </span>
                    <span className="mono num" style={{ fontSize: 12.5, fontWeight: 700, color: up ? '#dc2626' : '#16a34a' }}>
                      {formatPct(b.pct)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 模块二：中美跨市场产业链联动剪刀差观察（默认随跨市场抽屉展开） */}
      {showMacroAnchors && board && board.crossPairs.length > 0 && (
        <div className="panel" style={{ padding: '13px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <ArrowLeftRight size={14} color="var(--amber)" />
              中美跨市场联动观察（美股龙头 vs A股产业链映射实时剪刀差）
            </div>
            {(workspace.methodology.cards.some((c) => c.id === '159') ||
              workspace.methodology.cards.some((c) => c.id === '192')) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
                对照方法论：
                {workspace.methodology.cards.some((c) => c.id === '159') && (
                  <button type="button" className="ref-chip ref-chip-method" onClick={() => onOpenEntity({ kind: 'methodology', id: '159' })}>
                    卡片159 美股高开兑现
                  </button>
                )}
                {workspace.methodology.cards.some((c) => c.id === '192') && (
                  <button type="button" className="ref-chip ref-chip-method" onClick={() => onOpenEntity({ kind: 'methodology', id: '192' })}>
                    卡片192 中美映射背离
                  </button>
                )}
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 10 }}>
            {board.crossPairs.map((pair) => (
              <div
                key={pair.id}
                style={{
                  padding: '11px 13px',
                  borderRadius: 9,
                  background: 'var(--bg-soft)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13 }}>{pair.title}</strong>
                  <span className={`badge ${pairToneClass(pair.signalTone)}`} style={{ fontSize: 11 }}>
                    {pair.signal}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 8 }}>
                  <div style={{ background: 'var(--bg-elev)', borderRadius: 7, padding: '6px 9px', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>美股锚均涨跌</div>
                    <div className="mono num" style={{ fontSize: 15, fontWeight: 800, color: pctColor(pair.usAvgPct) }}>
                      {formatPct(pair.usAvgPct)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                      {pair.usLegs.map((l) => `${l.code} ${formatPct(l.pct)}`).join(' · ') || '未加入自选'}
                    </div>
                  </div>

                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>剪刀差(A-美)</div>
                    <div
                      className="mono num"
                      style={{
                        fontSize: 12.5,
                        fontWeight: 700,
                        color: pair.spreadPct == null ? 'var(--text-muted)' : pair.spreadPct >= 0 ? 'var(--teal)' : 'var(--amber)',
                      }}
                    >
                      {pair.spreadPct != null ? `${pair.spreadPct > 0 ? '+' : ''}${pair.spreadPct.toFixed(2)}pp` : '--'}
                    </div>
                  </div>

                  <div style={{ background: 'var(--bg-elev)', borderRadius: 7, padding: '6px 9px', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>A股映射均涨跌</div>
                    <div className="mono num" style={{ fontSize: 15, fontWeight: 800, color: pctColor(pair.cnAvgPct) }}>
                      {formatPct(pair.cnAvgPct)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                      {pair.cnLegs.map((l) => `${l.name} ${formatPct(l.pct)}`).join(' · ') || '未加入自选'}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 模块三：自选股实时盘中盯盘（卡片分时图视图 / 高密行情表视图） */}
      {loading ? (
        <div className="panel panel-pad" style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
          <Loader2 size={20} className="spin" style={{ marginBottom: 8 }} />
          <div>正在拉取 A股 & 美股实时盘中报价、分时走势与分钟成交量...</div>
        </div>
      ) : filteredItems.length === 0 ? (
        <div
          className="panel panel-pad"
          style={{
            textAlign: 'center',
            padding: '36px 24px',
            color: 'var(--text-muted)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>
            {board && board.items.length > 0
              ? '当前筛选条件下暂无匹配的自选标的'
              : '你的全球自选监控台还是空的，10 秒导入示例股即可开启实时盯盘'}
          </div>
          <div style={{ fontSize: 12.5, maxWidth: 480 }}>
            支持 A 股、港美股与全球期货实时分时、K 线支撑压力与量化策略 B/S 信号叠加。
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            {(!board || board.items.length === 0) && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  const starters = [
                    { secid: '1.600519', code: '600519', secuCode: '600519.SH', name: '贵州茅台', marketKind: 'CN' as const, currency: 'CNY' as const, group: 'A股核心', note: '消费龙头示例' },
                    { secid: '0.300750', code: '300750', secuCode: '300750.SZ', name: '宁德时代', marketKind: 'CN' as const, currency: 'CNY' as const, group: 'A股核心', note: '新能源龙头示例' },
                    { secid: '1.601318', code: '601318', secuCode: '601318.SH', name: '中国平安', marketKind: 'CN' as const, currency: 'CNY' as const, group: 'A股核心', note: '大金融核心示例' },
                    { secid: '0.300308', code: '300308', secuCode: '300308.SZ', name: '中际旭创', marketKind: 'CN' as const, currency: 'CNY' as const, group: 'AI算力', note: '科技成长示例' },
                    { secid: '1.600036', code: '600036', secuCode: '600036.SH', name: '招商银行', marketKind: 'CN' as const, currency: 'CNY' as const, group: 'A股核心', note: '高股息银行示例' },
                  ];
                  try {
                    for (const item of starters) {
                      await api.addWatchlistItem(item);
                    }
                    onToast('已一键导入 5 只 A 股核心示例标的，正在拉取实时盘口');
                    fetchBoard(true);
                  } catch (err: any) {
                    onToast(`导入示例股失败：${err.message}`);
                  }
                }}
              >
                <Sparkles size={13} /> 一键导入 5 只 A 股核心示例股
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setMarketFilter('ALL');
                const input = searchWrapRef.current?.querySelector('input');
                input?.focus();
              }}
            >
              <Search size={13} /> 搜索添加自定义标的
            </button>
          </div>
        </div>
      ) : viewMode === 'cards' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(335px, 1fr))',
            gap: 13,
          }}
        >
          {filteredItems.map((item) => {
            const linkedJudgments = findLinkedJudgments(item);
            const latestJudge = linkedJudgments[linkedJudgments.length - 1];
            const isUp = (item.pct ?? 0) >= 0;

            return (
              <div
                key={item.secid}
                className="panel"
                style={{
                  padding: '13px 15px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 9,
                  borderTop: `3px solid ${item.pct == null ? 'var(--border)' : isUp ? '#dc2626' : '#16a34a'}`,
                }}
              >
                {/* 卡片头部：市场 + 名称 + 代码 + 历史研判直达 */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {marketBadge(item.marketKind)}
                      <strong style={{ fontSize: 15, color: 'var(--text)' }}>{item.name}</strong>
                      <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{item.secuCode}</span>
                      {strategySignalMap[item.secid]?.latestSignal && (() => {
                        const sig = strategySignalMap[item.secid].latestSignal;
                        const isB = sig.side === 'BUY';
                        return (
                          <span
                            className="badge mono"
                            style={{
                              fontSize: 10,
                              padding: '1px 6px',
                              background: isB ? 'rgba(124, 58, 237, 0.14)' : 'rgba(2, 132, 199, 0.14)',
                              color: isB ? '#7c3aed' : '#0284c7',
                              fontWeight: 800,
                            }}
                            title={`${sig.strategyName} · ${sig.date} @${sig.price} · ${sig.reason}`}
                          >
                            {isB ? '策B' : '策S'} {sig.barsAgo === 0 ? '今日' : `${sig.barsAgo}日前`}
                          </span>
                        );
                      })()}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span>{item.group}</span>
                      {latestJudge && (
                        <button
                          type="button"
                          className="badge badge-amber"
                          style={{ border: 'none', cursor: 'pointer', padding: '0px 6px', fontSize: 10.5 }}
                          onClick={() => onPreviewEntity({ kind: 'judgment', id: latestJudge.id })}
                          title={`查看台账中该标的的历史研判（共 ${linkedJudgments.length} 次）`}
                        >
                          <History size={10} /> 台账 {latestJudge.recordKey}
                          {latestJudge.score != null ? ` · ${latestJudge.score}分` : ''}
                        </button>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ padding: 4 }}
                    onClick={() => handleRemoveSecurity(item)}
                    title="从自选看板移除"
                  >
                    <Trash2 size={13} color="var(--text-muted)" />
                  </button>
                </div>

                {/* 价格 & 涨跌幅 & 日内强弱位置 */}
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span className="mono num" style={{ fontSize: 22, fontWeight: 800, color: pctColor(item.pct), letterSpacing: '-0.02em' }}>
                      {formatPrice(item.price, item.currency)}
                    </span>
                    <span className="mono num" style={{ fontSize: 12, color: pctColor(item.pct) }}>
                      {item.chg != null ? `${item.chg > 0 ? '+' : ''}${item.chg.toFixed(2)}` : ''}
                    </span>
                  </div>

                  <span
                    className="mono num"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                      padding: '3px 8px',
                      borderRadius: 6,
                      fontSize: 13.5,
                      fontWeight: 800,
                      background: item.pct == null ? 'var(--bg-soft)' : isUp ? 'rgba(220,38,38,0.11)' : 'rgba(22,163,74,0.12)',
                      color: pctColor(item.pct),
                    }}
                  >
                    {item.pct != null && (isUp ? <TrendingUp size={13} /> : <TrendingDown size={13} />)}
                    {formatPct(item.pct)}
                  </span>
                </div>

                {/* 双栏分时走势 + VWAP均价 + 底部成交量柱 SVG */}
                <div
                  style={{ cursor: 'pointer' }}
                  onClick={() => openDetailModal(item.secid)}
                  title="点击展开高清交互分时图 + 22日 K 线"
                >
                  <IntradayVolumeChart
                    intraday={item.intraday}
                    preClose={item.preClose}
                    pct={item.pct}
                    height={94}
                    currencySymbol={currencyPrefix(item.currency)}
                  />
                </div>

                {/* 核心盘中量价指标四格 */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: 6,
                    padding: '7px 8px',
                    borderRadius: 7,
                    background: 'var(--bg-soft)',
                    fontSize: 11.5,
                  }}
                >
                  <div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>成交额</div>
                    <div className="mono num" style={{ fontWeight: 700 }}>{formatAmount(item)}</div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>成交量</div>
                    <div className="mono num" style={{ fontWeight: 700 }}>{formatVolume(item)}</div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>换手 / 量比</div>
                    <div className="mono num" style={{ fontWeight: 700 }}>
                      {item.turnoverPct != null ? `${item.turnoverPct}%` : '--'}
                      {item.volumeRatio != null ? ` / ${item.volumeRatio}` : ''}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>市值 / PE</div>
                    <div className="mono num" style={{ fontWeight: 700 }}>
                      {formatMarketCap(item)}
                      {item.peTtm != null && item.peTtm > 0 ? ` · ${item.peTtm.toFixed(0)}x` : ''}
                    </div>
                  </div>
                </div>

                {/* 日内高低点与位置条 + 快捷操作 */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 2 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }} className="mono">
                    高 {item.high != null ? item.high.toFixed(2) : '--'} / 低 {item.low != null ? item.low.toFixed(2) : '--'}
                    {item.amplitudePct != null ? ` · 振${item.amplitudePct}%` : ''}
                  </div>

                  <div style={{ display: 'flex', gap: 5 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: '3px 7px', fontSize: 11.5 }}
                      onClick={() => openDetailModal(item.secid)}
                    >
                      <BarChart3 size={12} /> K线
                    </button>
                    {onOpenTechnical && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: '3px 7px', fontSize: 11.5 }}
                        onClick={() => onOpenTechnical(item.secid)}
                        title="一键生成该标的 6 流派支撑压力位、筹码峰 POC 与见顶预警诊断"
                      >
                        <Crosshair size={12} color="var(--navy)" /> 支撑压力
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-amber btn-sm"
                      style={{ padding: '3px 7px', fontSize: 11.5 }}
                      onClick={() => onQuickAnalyzeStock(`${item.name}（${item.secuCode}）`)}
                      title="跳转到「发起标的研判」并自动带入该标的进行联网深度分析"
                    >
                      <Sparkles size={12} /> AI 研判
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* 高密度行情表视图 */
        <div className="panel" style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'var(--bg-soft)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '9px 12px' }}>标的</th>
                <th style={{ textAlign: 'right', padding: '9px 8px' }}>现价</th>
                <th style={{ textAlign: 'right', padding: '9px 8px' }}>涨跌幅</th>
                <th style={{ textAlign: 'center', padding: '9px 8px', width: 130 }}>盘中分时+量</th>
                <th style={{ textAlign: 'right', padding: '9px 8px' }}>成交额</th>
                <th style={{ textAlign: 'right', padding: '9px 8px' }}>成交量</th>
                <th style={{ textAlign: 'right', padding: '9px 8px' }}>换手率</th>
                <th style={{ textAlign: 'right', padding: '9px 8px' }}>量比</th>
                <th style={{ textAlign: 'right', padding: '9px 8px' }}>振幅</th>
                <th style={{ textAlign: 'right', padding: '9px 8px' }}>总市值 / PE</th>
                <th style={{ textAlign: 'right', padding: '9px 12px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => (
                <tr key={item.secid} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {marketBadge(item.marketKind)}
                      <strong>{item.name}</strong>
                      <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>{item.secuCode}</span>
                    </div>
                  </td>
                  <td className="mono num" style={{ textAlign: 'right', padding: '8px', fontWeight: 700, color: pctColor(item.pct) }}>
                    {formatPrice(item.price, item.currency)}
                  </td>
                  <td className="mono num" style={{ textAlign: 'right', padding: '8px', fontWeight: 800, color: pctColor(item.pct) }}>
                    {formatPct(item.pct)}
                  </td>
                  <td style={{ padding: '4px 8px', cursor: 'pointer' }} onClick={() => openDetailModal(item.secid)}>
                    <IntradayVolumeChart
                      intraday={item.intraday}
                      preClose={item.preClose}
                      pct={item.pct}
                      height={42}
                      currencySymbol={currencyPrefix(item.currency)}
                    />
                  </td>
                  <td className="mono num" style={{ textAlign: 'right', padding: '8px' }}>{formatAmount(item)}</td>
                  <td className="mono num" style={{ textAlign: 'right', padding: '8px' }}>{formatVolume(item)}</td>
                  <td className="mono num" style={{ textAlign: 'right', padding: '8px' }}>
                    {item.turnoverPct != null ? `${item.turnoverPct}%` : '--'}
                  </td>
                  <td className="mono num" style={{ textAlign: 'right', padding: '8px' }}>
                    {item.volumeRatio != null ? item.volumeRatio.toFixed(2) : '--'}
                  </td>
                  <td className="mono num" style={{ textAlign: 'right', padding: '8px' }}>
                    {item.amplitudePct != null ? `${item.amplitudePct}%` : '--'}
                  </td>
                  <td className="mono num" style={{ textAlign: 'right', padding: '8px' }}>
                    {formatMarketCap(item)}{item.peTtm != null && item.peTtm > 0 ? ` / ${item.peTtm.toFixed(0)}x` : ''}
                  </td>
                  <td style={{ textAlign: 'right', padding: '8px 12px', whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'inline-flex', gap: 5 }}>
                      <button type="button" className="btn btn-sm" style={{ padding: '2px 7px', fontSize: 11.5 }} onClick={() => openDetailModal(item.secid)}>
                        K线
                      </button>
                      <button
                        type="button"
                        className="btn btn-amber btn-sm"
                        style={{ padding: '2px 7px', fontSize: 11.5 }}
                        onClick={() => onQuickAnalyzeStock(`${item.name}（${item.secuCode}）`)}
                      >
                        AI研判
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '2px 5px' }} onClick={() => handleRemoveSecurity(item)}>
                        <Trash2 size={12} color="var(--text-muted)" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
        </>
      )}

      {/* 单标高清交互详情弹窗（完整分时+成交量 & 22日K线+MA5乖离） */}
      {detailSecid && (
        <div className="modal-backdrop" onClick={() => setDetailSecid(null)}>
          <div
            className="modal-box"
            style={{ maxWidth: '94vw', width: 1060, maxHeight: '92vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Activity size={16} color="var(--navy)" />
                {detailData ? (
                  <>
                    {marketBadge(detailData.marketKind)}
                    <strong style={{ fontSize: 16 }}>{detailData.name}</strong>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>{detailData.secuCode}</span>
                    <span className="mono num" style={{ fontSize: 16, fontWeight: 800, color: pctColor(detailData.quote.pct) }}>
                      {formatPrice(detailData.quote.price, detailData.currency)} ({formatPct(detailData.quote.pct)})
                    </span>
                  </>
                ) : (
                  <strong>加载盘中分时与日K图表...</strong>
                )}
              </div>

              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {detailData && (
                  <button
                    type="button"
                    className="btn btn-amber btn-sm"
                    onClick={() => {
                      const label = `${detailData.name}（${detailData.secuCode}）`;
                      setDetailSecid(null);
                      onQuickAnalyzeStock(label);
                    }}
                  >
                    <Sparkles size={13} /> 发起 AI 联网深度研判
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDetailSecid(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {!detailData ? (
                <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
                  <Loader2 size={20} className="spin" />
                  <div style={{ marginTop: 8 }}>正在拉取高清 1 分钟分时 + 22日 K 线数据...</div>
                </div>
              ) : (
                <>
                  {/* 技术面与量价汇总栏（含框架增订④ MA5乖离告警） */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))',
                      gap: 8,
                    }}
                  >
                    <div className="field-block" style={{ marginBottom: 0, padding: '8px 11px' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>MA5 / 乖离率</div>
                      <div className="mono num" style={{ fontWeight: 700, fontSize: 13 }}>
                        {detailData.quote.ma5 ?? '--'}{' '}
                        <span
                          style={{
                            color:
                              Math.abs(detailData.quote.ma5BiasPct || 0) > 8
                                ? 'var(--crimson)'
                                : 'var(--text-secondary)',
                          }}
                        >
                          ({detailData.quote.ma5BiasPct != null ? `${detailData.quote.ma5BiasPct > 0 ? '+' : ''}${detailData.quote.ma5BiasPct}%` : '--'})
                        </span>
                      </div>
                    </div>
                    <div className="field-block" style={{ marginBottom: 0, padding: '8px 11px' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>MA10 / MA20</div>
                      <div className="mono num" style={{ fontWeight: 700, fontSize: 13 }}>
                        {detailData.quote.ma10 ?? '--'} / {detailData.quote.ma20 ?? '--'}
                      </div>
                    </div>
                    <div className="field-block" style={{ marginBottom: 0, padding: '8px 11px' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>5日 / 20日涨跌</div>
                      <div className="mono num" style={{ fontWeight: 700, fontSize: 13 }}>
                        <span style={{ color: pctColor(detailData.quote.ret5dPct) }}>{formatPct(detailData.quote.ret5dPct)}</span>
                        {' / '}
                        <span style={{ color: pctColor(detailData.quote.ret20dPct) }}>{formatPct(detailData.quote.ret20dPct)}</span>
                      </div>
                    </div>
                    <div className="field-block" style={{ marginBottom: 0, padding: '8px 11px' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>换手 / 量比 / 振幅</div>
                      <div className="mono num" style={{ fontWeight: 700, fontSize: 13 }}>
                        {detailData.quote.turnoverPct != null ? `${detailData.quote.turnoverPct}%` : '--'} /{' '}
                        {detailData.quote.volumeRatio ?? '--'} /{' '}
                        {detailData.quote.amplitudePct != null ? `${detailData.quote.amplitudePct}%` : '--'}
                      </div>
                    </div>
                    <div className="field-block" style={{ marginBottom: 0, padding: '8px 11px' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>总市值 / PE(TTM)</div>
                      <div className="mono num" style={{ fontWeight: 700, fontSize: 13 }}>
                        {detailData.marketKind === 'US'
                          ? detailData.quote.totalCapUsdB != null
                            ? `$${detailData.quote.totalCapUsdB}B`
                            : '--'
                          : detailData.quote.totalCapYi != null
                          ? `${detailData.quote.totalCapYi}亿`
                          : '--'}{' '}
                        · {detailData.quote.peTtm ?? '--'}x
                      </div>
                    </div>
                  </div>

                  {/* 多周期交互缩放 K 线（周K / 500日K / 60m / 15m / 1m）+ 趋势线叠加 */}
                  <div className="panel panel-pad" style={{ padding: '12px 14px' }}>
                    <InteractiveKlineChart
                      secid={detailData.secid}
                      title={`${detailData.name} 多周期交互 K 线`}
                      klines={detailData.klines}
                      timeframe={detailTimeframe}
                      loadingTimeframe={loadingDetail}
                      onChangeTimeframe={(tf) => detailSecid && openDetailModal(detailSecid, tf)}
                      trendlines={detailData.trendlines || null}
                      tradeMarkers={detailData.tradeMarkers || null}
                      initialDrawings={detailData.drawings || []}
                      initialDrawingAlerts={detailData.drawingAlerts || []}
                      onToast={onToast}
                      defaultShowSR={false}
                      defaultShowVictor
                      defaultShowDemark={false}
                      defaultShowRegression
                      currencySymbol={currencyPrefix(detailData.currency)}
                      height={310}
                    />
                  </div>

                  {/* 高清盘中分时 + VWAP + 成交量 */}
                  <div className="panel panel-pad" style={{ padding: '12px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <strong style={{ fontSize: 13 }}>
                        今日盘中分时走势 · VWAP 均价线（黄虚线）· 分钟成交量柱
                      </strong>
                      <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                        {detailData.intraday.tradeDate} · 共 {detailData.intraday.barCount} 根分时柱
                        {detailData.intraday.aboveAvgRatioPct != null ? ` · 均价上方占比 ${detailData.intraday.aboveAvgRatioPct}%` : ''}
                      </span>
                    </div>
                    <IntradayVolumeChart
                      intraday={detailData.intraday}
                      preClose={detailData.quote.preClose}
                      pct={detailData.quote.pct}
                      height={185}
                      interactive
                      currencySymbol={currencyPrefix(detailData.currency)}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
