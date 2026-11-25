import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Database,
  EyeOff,
  Globe,
  KeyRound,
  Keyboard,
  Languages,
  Layers,
  Loader2,
  Maximize2,
  Moon,
  Palette,
  Search,
  SlidersHorizontal,
  StickyNote,
  Sun,
} from 'lucide-react';
import { api, setClientWorkspaceRoot } from './api';
import { useI18n } from './i18n';
import { CRYPTO_ENABLED, IS_COMMERCIAL_EDITION, IS_OPEN_SOURCE_EDITION } from './config/edition';
import { setClientEntitlements } from './config/entitlements';
import type {
  ActiveTab,
  AiSafeConfig,
  AuditReport,
  BackgroundJobSummary,
  BrandStateResponse,
  DataSourceChannelId,
  DataSourceConfigResponse,
  EntityRef,
  EulaStatusInfo,
  LicenseStatusInfo,
  MutationPreview,
  QuickDraftNotePayload,
  SecuritySearchItem,
  UpgradeRequiredEventDetail,
  WorkbenchMode,
  WorkspaceData,
  WorkspaceProfileInfo,
} from './types';
import { Sidebar } from './components/Sidebar';
import { CommandPalette } from './components/CommandPalette';
import { EntityPreviewDrawer } from './components/EntityPreviewDrawer';
import { DiffConfirmModal } from './components/DiffConfirmModal';
import { AiConfigModal } from './components/AiConfigModal';
import { DataSourceModal } from './components/DataSourceModal';
import { EulaOnboardingModal } from './components/EulaOnboardingModal';
import { UpgradeGateModal } from './components/UpgradeGateModal';
import {
  RoleOnboardingModal,
  loadUserUiPrefs,
  saveUserUiPrefs,
  type UserUiPreferences,
} from './components/RoleOnboardingModal';
import { BrandCustomizeModal } from './components/BrandCustomizeModal';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import { ToastStack, inferToastLevel, type ToastItem, type ToastLevel } from './components/ToastStack';
import { ShortcutHelpModal } from './components/ShortcutHelpModal';
import { QuickNotesModal } from './components/QuickNotesModal';
import { SlimeBotWidget } from './components/SlimeBotWidget';
import { BotBottomDock } from './components/BotBottomDock';
import { MarketTickerStrip } from './components/MarketTickerStrip';
import { SlimeBotProvider } from './contexts/SlimeBotContext';
import { getAiProviderBadgeText, isAiProviderReady } from './components/AiProviderPicker';
import { DashboardPage } from './pages/DashboardPage';

// 路由级与重型弹窗代码分割（React.lazy）：将 klinecharts 及 15 个非首屏页面彻底移出首屏包
const WorkspaceLicenseModal = lazy(() =>
  import('./components/WorkspaceLicenseModal').then((m) => ({ default: m.WorkspaceLicenseModal }))
);
const StockFullscreenModal = lazy(() =>
  import('./components/StockFullscreenModal').then((m) => ({ default: m.StockFullscreenModal }))
);
const WatchlistPage = lazy(() => import('./pages/WatchlistPage').then((m) => ({ default: m.WatchlistPage })));
const TechnicalLabPage = lazy(() => import('./pages/TechnicalLabPage').then((m) => ({ default: m.TechnicalLabPage })));
const TradeLedgerPage = lazy(() => import('./pages/TradeLedgerPage').then((m) => ({ default: m.TradeLedgerPage })));
const BacktestLabPage = lazy(() => import('./pages/BacktestLabPage').then((m) => ({ default: m.BacktestLabPage })));
const IntelHubPage = lazy(() => import('./pages/IntelHubPage').then((m) => ({ default: m.IntelHubPage })));
const MethodologyPage = lazy(() => import('./pages/MethodologyPage').then((m) => ({ default: m.MethodologyPage })));
const CognitionPage = lazy(() => import('./pages/CognitionPage').then((m) => ({ default: m.CognitionPage })));
const LedgerPage = lazy(() => import('./pages/LedgerPage').then((m) => ({ default: m.LedgerPage })));
const MaintenancePage = lazy(() => import('./pages/MaintenancePage').then((m) => ({ default: m.MaintenancePage })));
const ShortTermWatchPage = lazy(() => import('./pages/ShortTermWatchPage').then((m) => ({ default: m.ShortTermWatchPage })));
const ShortTermLadderPage = lazy(() => import('./pages/ShortTermLadderPage').then((m) => ({ default: m.ShortTermLadderPage })));
const CloudTreemapPage = lazy(() => import('./pages/CloudTreemapPage').then((m) => ({ default: m.CloudTreemapPage })));
const AnomalyCenterPage = lazy(() => import('./pages/AnomalyCenterPage').then((m) => ({ default: m.AnomalyCenterPage })));
const ThemeRangePage = lazy(() => import('./pages/ThemeRangePage').then((m) => ({ default: m.ThemeRangePage })));
const DragonTigerPage = lazy(() => import('./pages/DragonTigerPage').then((m) => ({ default: m.DragonTigerPage })));

const TAB_TITLES: Record<ActiveTab, { title: string; titleEn: string; subtitle: string; subtitleEn: string }> = {
  dashboard: {
    title: '研究总览驾驶舱',
    titleEn: 'Research Cockpit',
    subtitle: '盘前预检收件箱 · 10态情绪红绿灯 · 三库实时状态 · 评分轨迹 · 高频卡可信度',
    subtitleEn: 'Preflight Inbox · 10-State Market Regime · 3-Library Truth · Credibility',
  },
  watchlist: {
    title: CRYPTO_ENABLED ? '全球多市场 · 期货 · 加密实时盯盘' : '全球多市场股市与期货实时盯盘',
    titleEn: CRYPTO_ENABLED ? 'Global Equities, World Futures & Crypto' : 'Global Equities & World Futures',
    subtitle: CRYPTO_ENABLED
      ? 'A股 / 美股 / 港股 / 台股 / 韩股 / 法股 / 英股 / 日德 / 世界期货 / BTC 24/7 + 顶部盘面温度'
      : 'A股 / 美股 / 港股 / 台股 / 韩股 / 法股 / 英股 / 日德 / 世界大宗期货 + 顶部盘面温度',
    subtitleEn: CRYPTO_ENABLED
      ? 'CN · US · HK · TW · KR · FR · UK · JP · DE · Global Futures · Crypto 24/7'
      : 'CN · US · HK · TW · KR · FR · UK · JP · DE · Global Futures',
  },
  technical: {
    title: '技术流派 · 预警与支撑压力位',
    titleEn: 'Technical Lab & S/R Levels',
    subtitle: '跨日10态情绪链 · 卡片漂移审计 · R倍数仓位风控 · 监管异动红线 · 6流派共振点位',
    subtitleEn: 'Multi-School S/R · Trendlines · R-Multiple Sizing · Rule Drift Audit',
  },
  trades: {
    title: '实盘 / 模拟交易账本与归因中心',
    titleEn: 'Trade Ledger & Attribution',
    subtitle: 'CSV/AI截图交割单导入 · B/S点位直绘K线 · 卖飞/逃顶审计 · 方法论卡片实战胜率与坏习惯成本',
    subtitleEn: 'Trade Import · K-Line B/S Markers · Card Win-Rate & Mistake Cost',
  },
  backtest: {
    title: '策略回测实验室 · Python + DuckDB',
    titleEn: 'Multi-Market Strategy Backtest Lab',
    subtitle: CRYPTO_ENABLED
      ? '100%原创多市场撮合内核 (A股T+1涨跌停 / 美股T+0 / 港股每手 / 加密24×7) · 本地DuckDB · K线B/S复盘 · 方法论卡片AI转译'
      : '100%原创多市场撮合内核 (A股T+1涨跌停 / 美股T+0 / 港股每手 / 全球期货) · 本地DuckDB · K线B/S复盘 · 方法论卡片AI转译',
    subtitleEn: 'Original Event-Driven Engine · DuckDB Store · Visual & Python Strategies · K-Line B/S Replay',
  },
  intel: {
    title: '情报信源与定时进化中心',
    titleEn: 'Intel Hub & Auto-Evolution',
    subtitle: '知识星球 + 微信公众号双向桥接 + 本地研报目录 + 公开电报/RSS · 三轨分流提纯至候选收件箱',
    subtitleEn: 'Multi-Channel Research Ingestion & Local Vault Batch Migration',
  },
  methodology: {
    title: '方法论卡片库',
    titleEn: 'Methodology Cards',
    subtitle: '回答“应当怎样研究和交易” · 冲突矩阵 · 复盘校准',
    subtitleEn: 'Trading & Research Rules · Conflict Matrix · Post-Review Calibration',
  },
  cognition: {
    title: '行业前沿认知库',
    titleEn: 'Industry Cognition Library',
    subtitle: '回答“产业正在发生什么” · 事实 / 产业含义 / A股映射严格分离',
    subtitleEn: 'Facts · Industry Implications · Stock Mappings · Evidence Grading',
  },
  ledger: {
    title: '研判与复盘台账（短线 + 投研统一复盘）',
    titleEn: 'Unified Review & Judgment Ledger',
    subtitle: '短线情绪/连板周期 + 题材趋势/产业逻辑一体化复盘 · T+N 追踪 · 否决池 · 周/月报 HTML',
    subtitleEn: 'Short-Term Tape + Theme Trend & Industry Logic · T+N Tracking · Veto Ledger',
  },
  maintenance: {
    title: '质检 · 推送调度 · 备份中心',
    titleEn: 'Audit, Scheduler & Backups',
    subtitle: '三库质检 · 盘中定时巡检 & 飞书/企微/钉钉/Bark Webhook 推送 · 原子快照与一键回滚',
    subtitleEn: 'Integrity Checks · Webhook Dispatch · Atomic Snapshots & Rollback',
  },
  st_watch: {
    title: '短线全景看盘驾驶舱',
    titleEn: 'Short-Term Tape Cockpit',
    subtitle: '板块→成分股→分时/K线/五档盘口全联动 · 拖拽调栏与自由模块定制 · 盘面温度 & 短线精灵',
    subtitleEn: 'Linked Sector/Chart/OrderBook · Resizable Customizable Panes · Live Sprite',
  },
  st_ladder: {
    title: '连板天梯 · 情绪周期 · 竞价雷达',
    titleEn: 'Board Ladder, Emotion Cycle & Auction',
    subtitle: '逐级晋级率与首封时间 · 4联短线龙头情绪周期曲线 · 涨停封单额与封流比 Top10',
    subtitleEn: 'Promotion Rates · 4-Chart Leader Emotion Cycle · Seal Order Intensity',
  },
  st_clouds: {
    title: '题材云图 & 情绪封单云图',
    titleEn: 'Theme & Emotion Seal Treemaps',
    subtitle: '全A成交额面积×涨跌热力云图 · 全市场涨停封单金额按题材分组下钻',
    subtitleEn: 'Turnover-Weighted Sector Heatmap · Limit-Up Seal Order Treemap',
  },
  st_anomaly: {
    title: 'A股异动中心 · 严重异动与重点监控',
    titleEn: 'A-Share Severe Anomaly & Monitor Center',
    subtitle: '10日(+100%) / 30日(+200%) 基准偏离值实时精确测算 · 停牌核查公告 · 联动监管异动红线规则',
    subtitleEn: '10D (+100%) & 30D (+200%) Deviation Radar · Regulatory Anomaly Redline Sync',
  },
  st_themes: {
    title: '题材小表格 · 四象限轮动 · 区间统计',
    titleEn: 'Theme Matrix, Quadrant & Range Stats',
    subtitle: '热点分层小表格 & 个人认知库产业链 · 60日×5日板块四象限 · 大盘K线拖拽区间涨幅榜（复盘统一归口至台账）',
    subtitleEn: 'Chain Matrix · 4-Quadrant Sector Rotation · Brushable Range Stats',
  },
  st_lhb: {
    title: 'A股龙虎榜与席位资金',
    titleEn: 'Dragon-Tiger List & Flows',
    subtitle: '近10日上榜数量与净额趋势 · 单日/三日榜净买明细 · 点击直达全屏个股研究',
    subtitleEn: '10-Day LHB Trend · Buy/Sell Breakdown · One-Click Fullscreen Research',
  },
};

export const App: React.FC = () => {
  const { lang, toggleLang, colorConvention, toggleColorConvention, t } = useI18n();
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchMode>(() => {
    return (localStorage.getItem('srw-mode') as WorkbenchMode) === 'short_term' ? 'short_term' : 'research';
  });
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    return localStorage.getItem('srw-mode') === 'short_term' ? 'st_watch' : 'dashboard';
  });
  const [fullscreenStockQuery, setFullscreenStockQuery] = useState<string | null>(null);
  const [lastStockQuery, setLastStockQuery] = useState<string>('');
  const [firstWatchlistSecid, setFirstWatchlistSecid] = useState<string>('');
  const [stLinkedSecid, setStLinkedSecid] = useState<string | null>(null);
  const [workspaceEpoch, setWorkspaceEpoch] = useState<number>(0);
  const workspaceGenRef = useRef<number>(0);
  const loadSeqRef = useRef<number>(0);
  const activeWorkspaceRootRef = useRef<string>('');
  const [visitedTabs, setVisitedTabs] = useState<Set<ActiveTab>>(() => {
    const init: ActiveTab = localStorage.getItem('srw-mode') === 'short_term' ? 'st_watch' : 'dashboard';
    return new Set<ActiveTab>([init]);
  });
  const standaloneStockInitial = useMemo(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get('standalone') === 'stock') {
        return (sp.get('secid') || sp.get('q') || '1.000001').trim();
      }
    } catch {
      // ignore
    }
    return '';
  }, []);
  const [standaloneSecid, setStandaloneSecid] = useState<string>(standaloneStockInitial);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('srw-sidebar-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const [slimeHidden, setSlimeHidden] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('srw-slime-hidden');
      if (saved === '1') return true;
      if (saved === '0') return false;
      // 商业版首次默认关闭悬浮萌系挂件，保持严肃简洁；个人版默认保留悬浮挂件
      return IS_COMMERCIAL_EDITION;
    } catch {
      return IS_COMMERCIAL_EDITION;
    }
  });
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [quickNotesOpen, setQuickNotesOpen] = useState(false);
  const prefsRef = useRef<HTMLDivElement | null>(null);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('srw-theme') as 'light' | 'dark') || 'light';
  });

  const handleChangeWorkbenchMode = useCallback((mode: WorkbenchMode) => {
    setWorkbenchMode(mode);
    localStorage.setItem('srw-mode', mode);
    setActiveTab((cur) => {
      const shortTermTabs: ActiveTab[] = ['st_watch', 'st_ladder', 'st_clouds', 'st_anomaly', 'st_themes', 'st_lhb'];
      if (mode === 'short_term' && !shortTermTabs.includes(cur)) return 'st_watch';
      if (mode === 'research' && shortTermTabs.includes(cur)) return 'dashboard';
      return cur;
    });
  }, []);

  const handleToggleLanguage = useCallback(() => {
    const next = lang === 'zh' ? 'en' : 'zh';
    toggleLang();
    api.saveBotConfig({ language: next }).catch(() => {});
  }, [lang, toggleLang]);

  // Global overlays
  const [cmdOpen, setCmdOpen] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiConfig, setAiConfig] = useState<AiSafeConfig | null>(null);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceModalTab, setWorkspaceModalTab] = useState<'workspace' | 'license'>('workspace');
  const [workspaceProfile, setWorkspaceProfile] = useState<WorkspaceProfileInfo | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatusInfo | null>(null);
  const [eulaStatus, setEulaStatus] = useState<EulaStatusInfo | null>(null);
  const [upgradeGateDetail, setUpgradeGateDetail] = useState<UpgradeRequiredEventDetail | null>(null);
  const [uiPrefs, setUiPrefs] = useState<UserUiPreferences>(() => loadUserUiPrefs());
  const [partnerForceFocus, setPartnerForceFocus] = useState(false);
  const [roleWizardOpen, setRoleWizardOpen] = useState(false);
  const [brandModalOpen, setBrandModalOpen] = useState(false);
  const [brandState, setBrandState] = useState<BrandStateResponse | null>(null);
  const [dataSourceModalOpen, setDataSourceModalOpen] = useState(false);
  const [dataSourceInitialChannel, setDataSourceInitialChannel] = useState<DataSourceChannelId>('cn_quotes');
  const [dataSourceConfig, setDataSourceConfig] = useState<DataSourceConfigResponse | null>(null);
  const [previewEntity, setPreviewEntity] = useState<EntityRef | null>(null);

  const openDataSourceModal = useCallback((channel: DataSourceChannelId = 'cn_quotes') => {
    setDataSourceInitialChannel(channel);
    setDataSourceModalOpen(true);
  }, []);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Pending navigation targets inside pages
  const [targetMethodCard, setTargetMethodCard] = useState<string | null>(null);
  const [targetConflict, setTargetConflict] = useState<string | null>(null);
  const [targetMethodModal, setTargetMethodModal] = useState<'createCard' | 'aiIngest' | null>(null);
  const [targetCogCard, setTargetCogCard] = useState<string | null>(null);
  const [targetCogModal, setTargetCogModal] = useState<'createCard' | 'aiIngest' | null>(null);
  const [targetDailyId, setTargetDailyId] = useState<string | null>(null);
  const [targetJudgeId, setTargetJudgeId] = useState<string | null>(null);
  const [targetLedgerMode, setTargetLedgerMode] = useState<'createDaily' | 'createJudgment' | null>(null);
  const [targetJudgeQuery, setTargetJudgeQuery] = useState<string | null>(null);
  const [targetTechnicalQuery, setTargetTechnicalQuery] = useState<string | null>(null);
  const [cmdHintMode, setCmdHintMode] = useState<'all' | 'stock'>('all');
  const [activeStockCtx, setActiveStockCtx] = useState<{ secid: string; code: string; name: string } | null>(null);
  const [pendingDraftNote, setPendingDraftNote] = useState<QuickDraftNotePayload | null>(null);
  const [techRadarSummary, setTechRadarSummary] = useState<{
    totalAlerts: number | null;
    highSeverityCount: number | null;
  }>({
    totalAlerts: null,
    highSeverityCount: null,
  });
  const [intelPendingCount, setIntelPendingCount] = useState<number | null>(null);

  // 全局后台 AI 任务队列（切页/刷新不中断）
  const [jobs, setJobs] = useState<BackgroundJobSummary[]>([]);

  // Confirmation Gate (Diff Modal) state
  const [pendingMutation, setPendingMutation] = useState<{
    action: string;
    payload: Record<string, unknown>;
    preview: MutationPreview;
    onSuccess?: () => void;
  } | null>(null);
  const [committing, setCommitting] = useState(false);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const showToast = useCallback((msg: string, level?: ToastLevel) => {
    const resolvedLevel = level || inferToastLevel(msg);
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-4), { id, message: msg, level: resolvedLevel }]);
    const duration = resolvedLevel === 'error' || resolvedLevel === 'warning' ? 6800 : 4800;
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, duration);
  }, []);

  const normalizeWorkspaceRoot = useCallback((projectRoot?: string | null) => {
    return String(projectRoot || '')
      .trim()
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  }, []);

  const getWorkspaceStockKey = useCallback(
    (projectRoot?: string | null) => {
      const norm = normalizeWorkspaceRoot(projectRoot);
      return norm ? `srw-last-stock-query::${norm}` : '';
    },
    [normalizeWorkspaceRoot]
  );

  const applyWorkspaceRootTransition = useCallback(
    (nextRootRaw: string, options?: { forceReset?: boolean; keepTabs?: boolean }) => {
      const nextRoot = String(nextRootRaw || '').trim();
      const prevNorm = normalizeWorkspaceRoot(activeWorkspaceRootRef.current);
      const nextNorm = normalizeWorkspaceRoot(nextRoot);
      const rootChanged = Boolean(prevNorm && nextNorm && prevNorm !== nextNorm);
      activeWorkspaceRootRef.current = nextRoot;
      setClientWorkspaceRoot(nextRoot);
      if (options?.forceReset || rootChanged) {
        workspaceGenRef.current += 1;
        setActiveStockCtx(null);
        setFullscreenStockQuery(null);
        setStLinkedSecid(null);
        setTargetTechnicalQuery(null);
        setFirstWatchlistSecid('');
        setLastStockQuery('');
        if (!options?.keepTabs) {
          setVisitedTabs((cur) => {
            // 仅保留当前激活标签，卸载旧空间已挂载页面以清空跨空间残留状态
            const kept = cur.size ? [activeTab] : [activeTab];
            return new Set<ActiveTab>(kept);
          });
        }
        setWorkspaceEpoch(workspaceGenRef.current);
        return true;
      }
      return false;
    },
    [activeTab, normalizeWorkspaceRoot]
  );

  const persistWorkspaceLastStock = useCallback(
    (secid: string) => {
      const wsKey = getWorkspaceStockKey(activeWorkspaceRootRef.current);
      if (!wsKey || !secid) return;
      try {
        localStorage.setItem(wsKey, secid);
      } catch {
        // ignore storage quota errors
      }
    },
    [getWorkspaceStockKey]
  );

  const handleActiveStockChange = useCallback(
    (info: { secid: string; code: string; name: string }, expectedGen?: number) => {
      if (expectedGen !== undefined && expectedGen !== workspaceGenRef.current) return;
      setActiveStockCtx(info);
      if (info.secid) {
        setLastStockQuery(info.secid);
        persistWorkspaceLastStock(info.secid);
      }
    },
    [persistWorkspaceLastStock]
  );

  const handleConsumeStLinked = useCallback(() => setStLinkedSecid(null), []);

  const handleOpenUnifiedReview = useCallback(() => {
    setTargetLedgerMode('createDaily');
    setActiveTab('ledger');
  }, []);

  const openFullscreenStock = useCallback(
    (explicitQuery?: string, explicitName?: string) => {
      const cleanedExplicit = String(explicitQuery || '').trim();
      const target = cleanedExplicit || activeStockCtx?.secid || lastStockQuery || firstWatchlistSecid;
      if (target) {
        setFullscreenStockQuery(target);
        setLastStockQuery(target);
        if (cleanedExplicit) {
          setActiveStockCtx((prev) => ({
            secid: target,
            code: target.replace(/^\d+\./, ''),
            name: explicitName || (prev?.secid === target ? prev.name : ''),
          }));
        } else if (explicitName) {
          setActiveStockCtx({ secid: target, code: target.replace(/^\d+\./, ''), name: explicitName });
        }
        persistWorkspaceLastStock(target);
        return;
      }
      setCmdHintMode('stock');
      setCmdOpen(true);
      showToast(
        t(
          '当前空间暂无自选标的，请直接输入股票代码或名称（如 600519 / NVDA）打开全屏 K 线或加入自选',
          'No watchlist symbol yet — type a stock ticker or name (e.g. 600519 / NVDA) to open chart or add to watchlist'
        ),
        'info'
      );
    },
    [activeStockCtx?.secid, firstWatchlistSecid, lastStockQuery, persistWorkspaceLastStock, showToast, t]
  );

  const handleAddSecurityToWatchlist = useCallback(
    async (item: SecuritySearchItem) => {
      const reqGen = workspaceGenRef.current;
      const reqRootRaw = activeWorkspaceRootRef.current;
      const reqRootNorm = normalizeWorkspaceRoot(reqRootRaw);
      try {
        const res = await api.addWatchlistItem(
          {
            secid: item.secid,
            code: item.code,
            secuCode: item.secuCode,
            name: item.name,
            marketKind: item.marketKind,
            currency: item.currency,
            group: item.marketKind === 'US' ? '美股自选' : item.marketKind === 'HK' ? '港股自选' : 'A股自选',
            note: '',
          },
          true,
          reqRootRaw || undefined
        );
        // 严格核对工作空间代次、当前活动空间及响应归属，防止切空间后延迟回包把旧空间标的写入当前空间历史
        if (reqGen !== workspaceGenRef.current) return;
        const curRootNorm = normalizeWorkspaceRoot(activeWorkspaceRootRef.current);
        if (reqRootNorm && curRootNorm && reqRootNorm !== curRootNorm) return;
        const resRootNorm = normalizeWorkspaceRoot(res?.workspaceRoot);
        if (resRootNorm && curRootNorm && resRootNorm !== curRootNorm) return;
        if (res.alreadyExists) {
          setFirstWatchlistSecid((prev) => prev || item.secid);
          showToast(t(`${item.name} (${item.code}) 已在自选列表中`, `${item.name} (${item.code}) is already in watchlist`), 'info');
          return;
        }
        setFirstWatchlistSecid(item.secid);
        handleActiveStockChange({ secid: item.secid, code: item.code, name: item.name }, reqGen);
        showToast(t(`已将 ${item.name} (${item.code}) 加入当前空间自选`, `Added ${item.name} (${item.code}) to watchlist`), 'success');
      } catch (err: any) {
        if (reqGen !== workspaceGenRef.current) return;
        showToast(`${t('加入自选失败：', 'Failed to add to watchlist: ')}${err.message}`, 'error');
      }
    },
    [handleActiveStockChange, normalizeWorkspaceRoot, showToast, t]
  );

  const handleDraftNoteAccepted = useCallback(
    async (noteId: string, target: 'cognition' | 'method' | 'judgment') => {
      try {
        await api.markQuickNoteConverted(noteId, target);
        showToast(
          t('已将盘中闪念内容与标的直接预填至草稿表单', 'Quick note text & symbol prefilled into draft form'),
          'success'
        );
      } catch (err: any) {
        showToast(
          `${t('正文已预填，但登记转换状态失败（原速记已保留）：', 'Draft prefilled, but failed to mark note converted: ')}${err.message}`,
          'warning'
        );
      }
    },
    [showToast, t]
  );

  const refreshJobs = useCallback(async () => {
    try {
      const res = await api.listJobs();
      setJobs(res.jobs || []);
    } catch {
      // non-fatal
    }
  }, []);

  const handleJobStarted = useCallback((job: BackgroundJobSummary) => {
    setJobs((prev) => [job, ...prev.filter((x) => x.id !== job.id)]);
  }, []);

  const loadAll = useCallback(async (isInitial = false) => {
    const reqGen = workspaceGenRef.current;
    const reqSeq = ++loadSeqRef.current;
    if (isInitial) setLoading(true);
    else setReloading(true);
    setError(null);
    try {
      const [ws, au, aiRes, jobsRes, appProfileRes, brandRes, dsRes, wlRes, sideSummaryRes] = await Promise.all([
        api.getWorkspace(),
        api.runAudit(),
        api.getAiConfig().catch(() => null),
        api.listJobs().catch(() => ({ ok: true, jobs: [] as BackgroundJobSummary[] })),
        api.getAppProfile().catch(() => null),
        api.getBrandState().catch(() => null),
        api.getDataSources().catch(() => null),
        api.getWatchlist().catch(() => null),
        api.getSidebarSummary().catch(() => null),
      ]);
      // 丢弃旧工作空间代次或过期并发请求，杜绝切换空间后被旧数据回写
      if (reqGen !== workspaceGenRef.current || reqSeq !== loadSeqRef.current) return;
      setWorkspace(ws);
      setAudit(au);
      if (aiRes?.config) setAiConfig(aiRes.config);
      setJobs(jobsRes.jobs || []);
      if (sideSummaryRes?.ok) {
        setIntelPendingCount(sideSummaryRes.intelPendingCount);
        setTechRadarSummary({
          totalAlerts: sideSummaryRes.techAlertCount,
          highSeverityCount: sideSummaryRes.techHighSeverityCount,
        });
      } else {
        setIntelPendingCount(null);
        setTechRadarSummary({ totalAlerts: null, highSeverityCount: null });
      }
      const nextRoot = appProfileRes?.ok ? appProfileRes.workspaceProfile?.activeProjectRoot || '' : activeWorkspaceRootRef.current;
      const nextRootNorm = normalizeWorkspaceRoot(nextRoot);
      if (appProfileRes?.ok) {
        setWorkspaceProfile(appProfileRes.workspaceProfile);
        // 统一处理根目录变更（含另一标签页后台切空间后本标签刷新）：自动清理旧 activeStockCtx / 全屏态并递增 workspaceEpoch
        applyWorkspaceRootTransition(nextRoot);
        const wsKey = getWorkspaceStockKey(nextRoot);
        let scopedLast = '';
        if (wsKey) {
          try {
            // 仅读取带工作空间归属的最近查看标的；无归属记录的旧全局键不再强行归属任何空间
            scopedLast = localStorage.getItem(wsKey) || '';
          } catch {
            scopedLast = '';
          }
        }
        setLastStockQuery(scopedLast);
        setLicenseStatus(appProfileRes.license);
        if (appProfileRes.eula) setEulaStatus(appProfileRes.eula);
        setClientEntitlements(appProfileRes.entitlements, appProfileRes.license?.machineCode || '');
        const lockedFocus = Boolean(
          appProfileRes.entitlements?.partnerManifest?.forceFocusProMode ||
            appProfileRes.features?.lockBrandDisclaimer
        );
        setPartnerForceFocus(lockedFocus);
      }
      // 仅接纳与当前空间资料同根的自选结果，避免并发切换瞬间旧空间自选覆盖新空间
      const wlRootNorm = normalizeWorkspaceRoot(wlRes?.workspaceRoot);
      const wlMatchesRoot = !wlRootNorm || !nextRootNorm || wlRootNorm === nextRootNorm;
      if (wlMatchesRoot && wlRes?.items?.length && !wlRes?.isDemo) {
        setFirstWatchlistSecid(wlRes.items[0].secid || wlRes.items[0].code || '');
      } else {
        setFirstWatchlistSecid('');
      }
      if (brandRes?.ok) {
        setBrandState(brandRes);
        if (brandRes.profile?.title) document.title = brandRes.profile.title;
      }
      if (dsRes) {
        setDataSourceConfig(dsRes);
      }
    } catch (err: any) {
      if (reqGen !== workspaceGenRef.current || reqSeq !== loadSeqRef.current) return;
      setError(err.message || '本地投研服务暂未响应，请点击下方重试按钮或重启桌面工作台程序');
    } finally {
      if (reqGen === workspaceGenRef.current && reqSeq === loadSeqRef.current) {
        setLoading(false);
        setReloading(false);
      }
    }
  }, [applyWorkspaceRootTransition, getWorkspaceStockKey, normalizeWorkspaceRoot]);

  useEffect(() => {
    loadAll(true);
  }, [loadAll]);

  // 有后台任务运行时，顶栏每 2 秒同步一次进度
  const hasRunningJobs = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!hasRunningJobs) return;
    const timer = setInterval(() => {
      refreshJobs();
    }, 2000);
    return () => clearInterval(timer);
  }, [hasRunningJobs, refreshJobs]);

  const jumpToJob = useCallback((job: BackgroundJobSummary) => {
    if (job.kind === 'daily_review') {
      setTargetLedgerMode('createDaily');
      setActiveTab('ledger');
    } else if (job.kind === 'judgment_draft') {
      setTargetLedgerMode('createJudgment');
      setActiveTab('ledger');
    } else if (job.kind === 'ingest_methodology') {
      setTargetMethodModal('aiIngest');
      setActiveTab('methodology');
    } else if (job.kind === 'ingest_cognition') {
      setTargetCogModal('aiIngest');
      setActiveTab('cognition');
    } else if (job.kind === 'intel_digest') {
      setActiveTab('intel');
    } else if (job.kind === 'quant_backtest' || job.kind === 'quant_sync' || job.kind === 'quant_setup') {
      setActiveTab('backtest');
    }
  }, []);

  // LRU Keep-Alive 池（上限 4 个活跃页签，防止长期挂机 16 页 DOM/Canvas 无限驻留导致内存飙升）
  const MAX_KEEP_ALIVE_TABS = 4;
  useEffect(() => {
    setVisitedTabs((prev) => {
      const ordered = [...prev].filter((t) => t !== activeTab);
      ordered.push(activeTab);
      const trimmed = ordered.slice(-MAX_KEEP_ALIVE_TABS);
      if (trimmed.length === prev.size && trimmed.every((t) => prev.has(t))) {
        return prev;
      }
      return new Set<ActiveTab>(trimmed);
    });
  }, [activeTab]);

  const effectiveFocusProMode = partnerForceFocus || uiPrefs.focusProMode;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('srw-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-focus-pro', effectiveFocusProMode ? 'true' : 'false');
  }, [effectiveFocusProMode]);

  // 商业版首次启动：EULA 签署完成后，自动弹出一次 3 分钟角色向导（personal 模式不主动打扰）
  useEffect(() => {
    if (eulaStatus?.required && eulaStatus?.accepted && !uiPrefs.onboarded) {
      setRoleWizardOpen(true);
    }
  }, [eulaStatus, uiPrefs.onboarded]);

  const handleApplyUiPrefs = useCallback(
    (next: UserUiPreferences) => {
      setUiPrefs(next);
      saveUserUiPrefs(next);
      setRoleWizardOpen(false);
      if (next.role === 'short_term_a') {
        handleChangeWorkbenchMode('short_term');
        setActiveTab('st_watch');
      } else if (next.role === 'wave_research') {
        handleChangeWorkbenchMode('research');
        setActiveTab('dashboard');
      }
      showToast(
        `已应用「${
          next.role === 'wave_research' ? '波段投研' : next.role === 'short_term_a' ? 'A股短线' : '全功能工作台'
        }」${next.focusProMode ? ' · 专注专业模式' : ''}`
      );
    },
    [handleChangeWorkbenchMode, showToast]
  );

  const handleToggleFocusProMode = useCallback(() => {
    if (partnerForceFocus) {
      showToast(t('当前机构白标策略已锁定专注专业模式', 'Institutional Focus Mode is locked by Partner policy'), 'warning');
      return;
    }
    setUiPrefs((prev) => {
      const next = { ...prev, focusProMode: !prev.focusProMode };
      saveUserUiPrefs(next);
      showToast(
        next.focusProMode
          ? t('已开启专注专业模式（机构克制视觉 + 隐藏萌系挂件与趣味文案）', 'Institutional Focus Mode enabled')
          : t('已退出专注专业模式', 'Institutional Focus Mode disabled'),
        'info'
      );
      return next;
    });
  }, [partnerForceFocus, showToast, t]);

  // 监听任意页面的自选股增删，按响应归属工作空间实时同步首只自选标的，拒绝旧空间事件污染当前空间
  useEffect(() => {
    const onWatchlistChanged = (e: Event) => {
      const detail = (
        e as CustomEvent<{ workspaceRoot?: string; items?: { secid?: string; code?: string }[]; isDemo?: boolean }>
      ).detail;
      const curRoot = activeWorkspaceRootRef.current.trim().toLowerCase();
      const evtRoot = String(detail?.workspaceRoot || '').trim().toLowerCase();
      if (curRoot && evtRoot && evtRoot !== curRoot) return;
      if (detail?.items?.length && !detail?.isDemo) {
        setFirstWatchlistSecid(detail.items[0].secid || detail.items[0].code || '');
      } else if (Array.isArray(detail?.items)) {
        setFirstWatchlistSecid('');
      }
    };
    const onAiCfgUpdated = (e: Event) => {
      const cfg = (e as CustomEvent<AiSafeConfig>).detail;
      if (cfg) setAiConfig(cfg);
    };
    window.addEventListener('srw-watchlist-changed', onWatchlistChanged);
    window.addEventListener('srw-ai-config-updated', onAiCfgUpdated);
    return () => {
      window.removeEventListener('srw-watchlist-changed', onWatchlistChanged);
      window.removeEventListener('srw-ai-config-updated', onAiCfgUpdated);
    };
  }, []);

  // Global 402 UPGRADE_REQUIRED listener -> open unified UpgradeGateModal
  useEffect(() => {
    const onUpgrade = (e: Event) => {
      const detail = (e as CustomEvent<UpgradeRequiredEventDetail>).detail;
      if (detail) setUpgradeGateDetail(detail);
    };
    window.addEventListener('srw-upgrade-required', onUpgrade);
    return () => window.removeEventListener('srw-upgrade-required', onUpgrade);
  }, []);

  // Close Preferences Popover on outside click
  useEffect(() => {
    if (!prefsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (prefsRef.current && !prefsRef.current.contains(e.target as Node)) {
        setPrefsOpen(false);
      }
    };
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [prefsOpen]);

  const handleToggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('srw-sidebar-collapsed', next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const handleToggleSlimeHidden = useCallback(
    (hide?: boolean) => {
      setSlimeHidden((prev) => {
        const next = typeof hide === 'boolean' ? hide : !prev;
        try {
          localStorage.setItem('srw-slime-hidden', next ? '1' : '0');
        } catch {
          // ignore
        }
        showToast(next ? t('已将悬浮挂件贴边隐藏至底部栏', 'Floating mascot hidden to bottom dock') : t('已恢复显示悬浮挂件', 'Floating mascot restored'), 'info');
        return next;
      });
    },
    [showToast, t]
  );

  // 全局高频快捷键：Ctrl+K / '/' 秒搜 · Ctrl+Shift+N 闪念速记 · '?' 快捷键总表 · Alt+1..9 极速切页
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdHintMode('all');
        setCmdOpen((v) => !v);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setQuickNotesOpen((v) => !v);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const idx = Number(e.key) - 1;
        const researchMap: ActiveTab[] = [
          'dashboard',
          'watchlist',
          'technical',
          'trades',
          'backtest',
          'intel',
          'methodology',
          'cognition',
          'ledger',
        ];
        const shortTermMap: ActiveTab[] = [
          'st_watch',
          'st_ladder',
          'st_clouds',
          'st_anomaly',
          'st_themes',
          'st_lhb',
          'methodology',
          'cognition',
          'ledger',
        ];
        const nextTab = (workbenchMode === 'short_term' ? shortTermMap : researchMap)[idx];
        if (nextTab) setActiveTab(nextTab);
        return;
      }
      if (!isTypingTarget(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === '?' || (e.shiftKey && e.key === '/')) {
          e.preventDefault();
          setShortcutsOpen((v) => !v);
          return;
        }
        if (e.key === '/') {
          // 在短线盯盘驾驶舱页内，'/' 键独占给盘内快速切票搜索框，绝不触发双重搜索弹窗
          if (activeTab === 'st_watch') return;
          e.preventDefault();
          setCmdHintMode('all');
          setCmdOpen(true);
          return;
        }
      }
      if (e.key === 'Escape') {
        setPrefsOpen(false);
        setShortcutsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workbenchMode, activeTab]);

  // 主屏直接跳转
  const jumpToEntity = useCallback((ref: EntityRef) => {
    if (ref.kind === 'methodology') {
      setTargetMethodCard(ref.id);
      setActiveTab('methodology');
    } else if (ref.kind === 'conflict') {
      setTargetConflict(ref.id);
      setActiveTab('methodology');
    } else if (ref.kind === 'cognition') {
      setTargetCogCard(ref.id);
      setActiveTab('cognition');
    } else if (ref.kind === 'daily') {
      setTargetDailyId(ref.id);
      setActiveTab('ledger');
    } else if (ref.kind === 'judgment') {
      setTargetJudgeId(ref.id);
      setActiveTab('ledger');
    }
  }, []);

  // 文本双链点击：卡片/认知/冲突弹出右侧抽屉就地预览，台账条目主屏直达
  const handleOpenEntity = useCallback(
    (ref: EntityRef) => {
      if (ref.kind === 'methodology' || ref.kind === 'cognition' || ref.kind === 'conflict') {
        setPreviewEntity(ref);
      } else {
        jumpToEntity(ref);
      }
    },
    [jumpToEntity]
  );

  // 触发写库确认门（先请求 preview Diff）
  const handleRequestMutation = useCallback(
    async (action: string, payload: Record<string, unknown>, onSuccess?: () => void) => {
      try {
        const preview = await api.previewMutation(action, payload);
        setPendingMutation({ action, payload, preview, onSuccess });
      } catch (err: any) {
        showToast(`生成变更预览失败：${err.message}`);
      }
    },
    [showToast]
  );

  const handleConfirmMutation = async () => {
    if (!pendingMutation) return;
    setCommitting(true);
    try {
      const res = await api.commitMutation(pendingMutation.action, pendingMutation.payload);
      const cb = pendingMutation.onSuccess;
      setPendingMutation(null);
      await loadAll(false);
      cb?.();
      if (!res.committed) {
        showToast(t('无文件变更需要落库', 'No file changes to commit'), 'info');
      } else if (res.auditRecorded === false) {
        showToast(
          t(
            `三库已安全落盘（快照 ${res.backupId}），但审计日志写入失败：${res.auditError || '磁盘写入受阻'}。请留存快照编号并在质检中心补记。`,
            `Saved to disk (snapshot ${res.backupId}), but audit trail write failed: ${res.auditError || 'disk error'}. Keep snapshot ID for reconciliation.`
          ),
          'warning'
        );
      } else {
        showToast(
          t(`已安全落库并自动保存快照备份（${res.backupId}）`, `Saved safely with snapshot backup (${res.backupId})`),
          'success'
        );
      }
    } catch (err: any) {
      showToast(`${t('落库失败：', 'Commit failed: ')}${err.message}`, 'error');
    } finally {
      setCommitting(false);
    }
  };

  const handleQuickCreate = (kind: 'method' | 'cognition' | 'daily' | 'judgment') => {
    if (kind === 'method') {
      setTargetMethodModal('createCard');
      setActiveTab('methodology');
    } else if (kind === 'cognition') {
      setTargetCogModal('createCard');
      setActiveTab('cognition');
    } else if (kind === 'daily') {
      setTargetLedgerMode('createDaily');
      setActiveTab('ledger');
    } else if (kind === 'judgment') {
      setTargetLedgerMode('createJudgment');
      setActiveTab('ledger');
    }
  };

  // 多屏独立弹出全屏研股窗口模式（?standalone=stock&secid=...）
  if (standaloneSecid) {
    return (
      <SlimeBotProvider
        aiConfig={aiConfig}
        onRequestMutation={handleRequestMutation}
        onLibraryChanged={() => loadAll(false)}
        onToast={showToast}
      >
        <PageErrorBoundary pageName="独立研股窗口" onToast={showToast}>
          <Suspense
            fallback={
              <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                正在加载独立全屏研股窗口...
              </div>
            }
          >
            <StockFullscreenModal
              standalone
              queryOrSecid={standaloneSecid}
              onClose={() => {
                window.location.href = '/';
              }}
              onChangeTarget={(nextQ) => {
                setStandaloneSecid(nextQ);
                try {
                  const u = new URL(window.location.href);
                  u.searchParams.set('secid', nextQ);
                  window.history.replaceState(null, '', u.toString());
                } catch {
                  // ignore
                }
              }}
              onToast={showToast}
            />
          </Suspense>
        </PageErrorBoundary>
        <ToastStack items={toasts} onDismiss={dismissToast} />
      </SlimeBotProvider>
    );
  }

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
        正在解析《方法论卡片库》《行业前沿认知库》《研判与复盘台账》...
      </div>
    );
  }

  if (error || !workspace) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div className="panel panel-pad" style={{ maxWidth: 480, textAlign: 'center' }}>
          <h3 style={{ marginTop: 0, color: 'var(--crimson)' }}>无法连接三库工作台后端</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>{error}</p>
          <button type="button" className="btn btn-primary" onClick={() => loadAll(true)}>
            重试连接
          </button>
        </div>
      </div>
    );
  }

  const headerInfo = TAB_TITLES[activeTab];
  const runningJobs = jobs.filter((j) => j.status === 'running');
  const recentDailyJob = jobs.find((j) => j.kind === 'daily_review') || null;
  const recentJudgmentJob = jobs.find((j) => j.kind === 'judgment_draft') || null;
  const recentMethodIngestJob = jobs.find((j) => j.kind === 'ingest_methodology') || null;
  const recentCogIngestJob = jobs.find((j) => j.kind === 'ingest_cognition') || null;
  const recentIntelJob = jobs.find((j) => j.kind === 'intel_digest') || null;
  const topbarJob =
    runningJobs[0] ||
    jobs.find((j) => {
      if (j.status === 'running') return false;
      const t = j.finishedAt ? new Date(j.finishedAt).getTime() : 0;
      return Date.now() - t < 30 * 60 * 1000;
    }) ||
    null;

  const activeWorkspaceLabel =
    workspaceProfile?.workspaces.find((w) => w.isActive)?.label || t('默认三库', 'Default');

  const licenseShortBadge = IS_OPEN_SOURCE_EDITION || licenseStatus?.tier === 'community_oss'
    ? 'OSS'
    : !licenseStatus
    ? t('本地版', 'Local')
    : licenseStatus.tier === 'max_lifetime'
    ? t('Max买断', 'Max Life')
    : licenseStatus.tier === 'max_annual'
    ? t('Max年费', 'Max Yr')
    : licenseStatus.tier === 'partner'
    ? 'Partner'
    : licenseStatus.tier === 'pro_lifetime'
    ? t('Pro买断', 'Pro Life')
    : licenseStatus.tier === 'pro_annual'
    ? t('Pro年费', 'Pro Yr')
    : licenseStatus.tier === 'friend_trial'
    ? t('好友体验', 'Trial')
    : licenseStatus.tier === 'developer'
    ? t('主理人', 'Dev')
    : workspaceProfile?.isPortableMode
    ? licenseStatus.enforcementMode === 'enforced'
      ? t('Free版', 'Free')
      : t('便携体验', 'Portable')
    : t('基础版', 'Basic');

  const isShortTermTab = ['st_watch', 'st_ladder', 'st_clouds', 'st_anomaly', 'st_themes', 'st_lhb'].includes(activeTab);

  return (
    <SlimeBotProvider
      aiConfig={aiConfig}
      workspaceEpoch={workspaceEpoch}
      onRequestMutation={handleRequestMutation}
      onLibraryChanged={() => loadAll(false)}
      onToast={showToast}
    >
    <div className="app-shell">
      <Sidebar
        workbenchMode={workbenchMode}
        onChangeWorkbenchMode={handleChangeWorkbenchMode}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        workspace={workspace}
        audit={audit}
        techAlertCount={techRadarSummary.highSeverityCount || techRadarSummary.totalAlerts}
        intelPendingCount={intelPendingCount}
        theme={theme}
        onToggleTheme={() => setTheme((tm) => (tm === 'light' ? 'dark' : 'light'))}
        onReload={() => {
          loadAll(false);
          showToast(t('已从磁盘重新解析最新现行三库', 'Reloaded latest 3-library markdown files'));
        }}
        reloading={reloading}
        activeWorkspaceLabel={activeWorkspaceLabel}
        onOpenWorkspaceModal={() => setWorkspaceModalOpen(true)}
        brandProfile={brandState?.profile || null}
        onOpenBrandModal={() => setBrandModalOpen(true)}
        onOpenFullscreenStock={(q) => openFullscreenStock(q)}
        rolePreset={uiPrefs.role}
        focusProMode={effectiveFocusProMode}
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleSidebarCollapsed}
        onOpenRoleWizard={() => setRoleWizardOpen(true)}
        onToggleFocusProMode={handleToggleFocusProMode}
      />

      <div className="main-column">
        <header className="topbar" style={{ gap: 10 }}>
          <div className="topbar-left" style={{ minWidth: 0, flex: '1 1 180px', overflow: 'hidden' }}>
            <h1 className="topbar-title" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {lang === 'en' ? headerInfo.titleEn : headerInfo.title}
            </h1>
            <span className="topbar-meta" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {lang === 'en' ? headerInfo.subtitleEn : headerInfo.subtitle}
            </span>
          </div>

          <div className="topbar-right" style={{ flexShrink: 0, gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => openFullscreenStock()}
              title={t('打开最近查看或首只自选标的的全屏研究工作台', 'Open Fullscreen Security Terminal')}
            >
              <Maximize2 size={13} />
              <span>{t('全屏研股', 'Full')}</span>
            </button>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: '4px 7px' }}
              onClick={() => setQuickNotesOpen(true)}
              title={t('盘中闪念速记框 (Ctrl+Shift+N)', 'Intraday Quick Notes (Ctrl+Shift+N)')}
            >
              <StickyNote size={13} color="var(--amber)" />
              <span>{t('速记', 'Note')}</span>
            </button>

            {topbarJob && (
              <button
                type="button"
                className={`job-pill ${
                  topbarJob.status === 'running'
                    ? 'job-pill-running'
                    : topbarJob.status === 'completed'
                    ? 'job-pill-done'
                    : 'job-pill-failed'
                }`}
                onClick={() => jumpToJob(topbarJob)}
                title={`${topbarJob.title}${topbarJob.error ? ` — ${topbarJob.error}` : '（点击直接跳转查看）'}`}
              >
                {topbarJob.status === 'running' ? (
                  <Loader2 size={13} className="spin" />
                ) : topbarJob.status === 'completed' ? (
                  <CheckCircle2 size={13} />
                ) : (
                  <AlertTriangle size={13} />
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {topbarJob.status === 'running'
                    ? `后台运行中 · ${topbarJob.title}${runningJobs.length > 1 ? ` (+${runningJobs.length - 1})` : ''}`
                    : topbarJob.status === 'completed'
                    ? `后台已完成 · 点击查看`
                    : `后台任务失败 · 查看`}
                </span>
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              style={{ padding: '4px 8px' }}
              onClick={() => {
                setWorkspaceModalTab(!IS_OPEN_SOURCE_EDITION && IS_COMMERCIAL_EDITION && !licenseStatus?.activated ? 'license' : 'workspace');
                setWorkspaceModalOpen(true);
              }}
              title={
                IS_OPEN_SOURCE_EDITION
                  ? t('切换或创建本地三库工作空间（开源社区版）', 'Switch or create local Markdown workspaces (Open-Source)')
                  : t('切换本地三库工作空间或激活离线授权', 'Switch workspace or activate offline license')
              }
            >
              {IS_OPEN_SOURCE_EDITION ? (
                <Layers size={13} color="var(--emerald)" />
              ) : (
                <KeyRound size={13} color={licenseStatus?.activated ? 'var(--navy)' : 'var(--amber)'} />
              )}
              <span>{IS_OPEN_SOURCE_EDITION ? t('工作空间', 'Workspaces') : t('空间 · 授权', 'Workspace')}</span>
              <span
                className={`badge ${
                  IS_OPEN_SOURCE_EDITION || licenseStatus?.activated || licenseStatus?.tier === 'developer' ? 'badge-emerald' : 'badge-amber'
                }`}
                style={{ padding: '0px 4px', fontSize: 10 }}
              >
                {licenseShortBadge}
              </span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              style={{ padding: '4px 7px' }}
              onClick={() => openDataSourceModal('cn_quotes')}
              title={t('管理可插拔数据源（免费 / 付费行情 / L2 / Webhook）', 'Manage pluggable market data feeds')}
            >
              <Database size={13} color="var(--navy)" />
              <span>{t('数据源', 'Feeds')}</span>
              <span
                className={`badge mono ${
                  (dataSourceConfig?.capabilities?.customChannelCount || 0) > 0 ? 'badge-gold' : 'badge-emerald'
                }`}
                style={{ padding: '0px 4px', fontSize: 10 }}
              >
                {(dataSourceConfig?.capabilities?.customChannelCount || 0) > 0
                  ? t(`${dataSourceConfig?.capabilities?.customChannelCount}源`, `${dataSourceConfig?.capabilities?.customChannelCount} Custom`)
                  : t('免费', 'Free')}
              </span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              style={{ padding: '4px 7px' }}
              onClick={() => setAiModalOpen(true)}
              title={t('配置 DeepSeek / 通义 / Kimi / 本机 CLI 等 AI 引擎', 'Configure AI providers')}
            >
              <Bot size={13} color="var(--navy)" />
              <span>AI</span>
              <span
                className={`badge mono ${
                  aiConfig && isAiProviderReady(aiConfig, aiConfig.provider) ? 'badge-emerald' : 'badge-muted'
                }`}
                style={{ padding: '0px 4px', fontSize: 10 }}
              >
                {getAiProviderBadgeText(aiConfig, undefined, lang)}
              </span>
            </button>
            <button type="button" className="search-trigger" style={{ minWidth: 138, padding: '5px 8px' }} onClick={() => setCmdOpen(true)}>
              <Search size={13} />
              <span>{t('秒搜三库 / 标的', 'Search')}</span>
              <span className="kbd">Ctrl K</span>
            </button>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: '4px 6px' }}
              onClick={() => setShortcutsOpen(true)}
              title={t('键盘快捷键速查表 (?)', 'Keyboard Shortcuts (?)')}
            >
              <Keyboard size={14} />
            </button>

            {/* 收敛右上角偏好设置 Popover（语言 / 涨跌色 / 主题 / 专注专业模式 / 角色向导 / 悬浮挂件） */}
            <div ref={prefsRef} style={{ position: 'relative' }}>
              <button
                type="button"
                className={`btn btn-sm ${prefsOpen ? 'btn-primary' : 'btn-ghost'}`}
                style={{ padding: '4px 7px' }}
                onClick={() => setPrefsOpen((v) => !v)}
                title={t('偏好设置（语言 / 涨跌色 / 主题 / 专注模式 / 品牌）', 'Preferences (Language / Theme / Focus Mode)')}
              >
                <SlidersHorizontal size={14} />
              </button>
              {prefsOpen && (
                <div className="prefs-popover">
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)', padding: '2px 6px' }}>
                    {t('工作台显示与偏好设置', 'Display & Preferences')}
                  </div>
                  <div className="prefs-row">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Languages size={14} color="var(--navy)" /> {t('界面与 Bot 语言', 'UI & Bot Language')}
                    </span>
                    <button type="button" className="btn btn-sm" style={{ padding: '2px 8px', fontSize: 11.5 }} onClick={handleToggleLanguage}>
                      {lang === 'en' ? 'English → 中文' : '中文 → EN'}
                    </button>
                  </div>
                  <div className="prefs-row">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Globe size={14} color="var(--navy)" /> {t('涨跌配色习惯', 'Color Convention')}
                    </span>
                    <button type="button" className="btn btn-sm" style={{ padding: '2px 8px', fontSize: 11.5 }} onClick={toggleColorConvention}>
                      {colorConvention === 'global_green_up' ? 'G↑ 绿涨红跌' : '红↑ 红涨绿跌'}
                    </button>
                  </div>
                  <div className="prefs-row">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {theme === 'light' ? <Sun size={14} color="var(--amber)" /> : <Moon size={14} color="var(--navy)" />}
                      {t('主题外观', 'Theme')}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: '2px 8px', fontSize: 11.5 }}
                      onClick={() => setTheme((tm) => (tm === 'light' ? 'dark' : 'light'))}
                    >
                      {theme === 'light' ? t('羊皮纸浅色', 'Light') : t('终端深色', 'Dark')}
                    </button>
                  </div>
                  <div className="prefs-row">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <EyeOff size={14} color="var(--navy)" /> {t('专注专业模式', 'Institutional Focus')}
                    </span>
                    <button
                      type="button"
                      className={`btn btn-sm ${effectiveFocusProMode ? 'btn-primary' : ''}`}
                      style={{ padding: '2px 8px', fontSize: 11.5 }}
                      onClick={handleToggleFocusProMode}
                      disabled={partnerForceFocus}
                    >
                      {partnerForceFocus ? t('机构锁定', 'Locked') : effectiveFocusProMode ? t('已开启', 'ON') : t('关闭', 'OFF')}
                    </button>
                  </div>
                  {!effectiveFocusProMode && (
                    <div className="prefs-row">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Bot size={14} color="var(--teal)" /> {t('右下角悬浮挂件', 'Floating Mascot')}
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: '2px 8px', fontSize: 11.5 }}
                        onClick={() => handleToggleSlimeHidden()}
                      >
                        {slimeHidden ? t('已隐藏', 'Hidden') : t('显示中', 'Visible')}
                      </button>
                    </div>
                  )}
                  <div style={{ borderTop: '1px solid var(--border)', marginTop: 2, paddingTop: 6, display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ flex: 1, justifyContent: 'center', fontSize: 11.5 }}
                      onClick={() => {
                        setPrefsOpen(false);
                        setRoleWizardOpen(true);
                      }}
                    >
                      <SlidersHorizontal size={12} /> {t('角色向导', 'Role Wizard')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ flex: 1, justifyContent: 'center', fontSize: 11.5 }}
                      onClick={() => {
                        setPrefsOpen(false);
                        setBrandModalOpen(true);
                      }}
                    >
                      <Palette size={12} /> {t('品牌定制', 'Branding')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* 模块二：常驻顶部大盘摘要条（短线全6页与实时盯盘页顶部常驻，不混入投研三库编辑页） */}
        {(isShortTermTab || activeTab === 'watchlist') && (
          <MarketTickerStrip
            onSelectStock={(secid) => {
              if (activeTab === 'st_watch') {
                setStLinkedSecid(secid);
              } else {
                openFullscreenStock(secid);
              }
            }}
            onOpenFullscreenStock={(secid) => openFullscreenStock(secid)}
            onOpenDataSources={openDataSourceModal}
            customSourceCount={dataSourceConfig?.capabilities?.customChannelCount || 0}
          />
        )}

        {/* 首次访问懒加载 + LRU 保活（最多保活 4 页）：大幅压缩首屏 JS 体积与长期挂机内存；每页独立 ErrorBoundary 防白屏 */}
        <main className="page-viewport" key={`ws-main-${workspaceEpoch}`}>
          <Suspense
            fallback={
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                <Loader2 size={16} className="spin" /> 正在加载页面模块...
              </div>
            }
          >
          {visitedTabs.has('dashboard') && (
            <div
              className="page-viewport page-viewport-pane"
              data-active={activeTab === 'dashboard' ? 'true' : 'false'}
              style={{ display: activeTab === 'dashboard' ? 'flex' : 'none' }}
            >
              <PageErrorBoundary pageName="研究总览驾驶舱" onToast={showToast}>
                <DashboardPage
                  workspace={workspace}
                  audit={audit}
                  onNavigateTab={setActiveTab}
                  onOpenEntity={jumpToEntity}
                  onQuickCreate={handleQuickCreate}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('watchlist') && (
            <div
              className="page-viewport page-viewport-pane"
              data-active={activeTab === 'watchlist' ? 'true' : 'false'}
              style={{ display: activeTab === 'watchlist' ? 'flex' : 'none' }}
            >
              <PageErrorBoundary pageName="全球市场实时盯盘" onToast={showToast}>
                <WatchlistPage
                  workspace={workspace}
                  isActive={activeTab === 'watchlist'}
                  onOpenEntity={handleOpenEntity}
                  onPreviewEntity={setPreviewEntity}
                  onQuickAnalyzeStock={(queryLabel) => {
                    setTargetJudgeQuery(queryLabel);
                    setTargetLedgerMode('createJudgment');
                    setActiveTab('ledger');
                  }}
                  onOpenTechnical={(secidOrQuery) => {
                    setTargetTechnicalQuery(secidOrQuery);
                    setActiveTab('technical');
                  }}
                  onOpenFullscreenStock={(secidOrQuery) => openFullscreenStock(secidOrQuery)}
                  onNavigateShortTerm={() => handleChangeWorkbenchMode('short_term')}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {/* 短线模式 6 大专属实战工作区（首次访问懒挂载 + 保活 + 错误隔离；隐藏时暂停轮询与全局快捷键） */}
          {visitedTabs.has('st_watch') && (
            <div
              className="page-viewport page-viewport-pane"
              data-active={activeTab === 'st_watch' ? 'true' : 'false'}
              style={{ display: activeTab === 'st_watch' ? 'flex' : 'none' }}
            >
              <PageErrorBoundary pageName="短线全景看盘驾驶舱" onToast={showToast}>
                <ShortTermWatchPage
                  isActive={activeTab === 'st_watch'}
                  externalSelectedSecid={stLinkedSecid}
                  onConsumeExternalSelect={handleConsumeStLinked}
                  onActiveStockChange={(info) => handleActiveStockChange(info, workspaceEpoch)}
                  onOpenFullscreenStock={openFullscreenStock}
                  onOpenDataSources={openDataSourceModal}
                  onNavigateTab={setActiveTab}
                  onOpenUnifiedReview={handleOpenUnifiedReview}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('st_ladder') && (
            <div
              className="scroll-page page-viewport-pane"
              data-active={activeTab === 'st_ladder' ? 'true' : 'false'}
              style={{ display: activeTab === 'st_ladder' ? 'block' : 'none' }}
            >
              <PageErrorBoundary pageName="连板天梯与竞价" onToast={showToast}>
                <ShortTermLadderPage
                  isActive={activeTab === 'st_ladder'}
                  onOpenFullscreenStock={(q) => openFullscreenStock(q)}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('st_clouds') && (
            <div
              className="scroll-page page-viewport-pane"
              data-active={activeTab === 'st_clouds' ? 'true' : 'false'}
              style={{ display: activeTab === 'st_clouds' ? 'block' : 'none' }}
            >
              <PageErrorBoundary pageName="题材与情绪云图" onToast={showToast}>
                <CloudTreemapPage
                  isActive={activeTab === 'st_clouds'}
                  onOpenFullscreenStock={(q) => openFullscreenStock(q)}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('st_anomaly') && (
            <div
              className="scroll-page page-viewport-pane"
              data-active={activeTab === 'st_anomaly' ? 'true' : 'false'}
              style={{ display: activeTab === 'st_anomaly' ? 'block' : 'none' }}
            >
              <PageErrorBoundary pageName="异动与监管中心" onToast={showToast}>
                <AnomalyCenterPage
                  isActive={activeTab === 'st_anomaly'}
                  onOpenFullscreenStock={(q) => openFullscreenStock(q)}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('st_themes') && (
            <div
              className="scroll-page page-viewport-pane"
              data-active={activeTab === 'st_themes' ? 'true' : 'false'}
              style={{ display: activeTab === 'st_themes' ? 'block' : 'none' }}
            >
              <PageErrorBoundary pageName="题材·四象限·区间统计" onToast={showToast}>
                <ThemeRangePage
                  isActive={activeTab === 'st_themes'}
                  onOpenFullscreenStock={(q) => openFullscreenStock(q)}
                  onOpenUnifiedReview={() => {
                    setTargetLedgerMode('createDaily');
                    setActiveTab('ledger');
                  }}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('st_lhb') && (
            <div
              className="scroll-page page-viewport-pane"
              data-active={activeTab === 'st_lhb' ? 'true' : 'false'}
              style={{ display: activeTab === 'st_lhb' ? 'block' : 'none' }}
            >
              <PageErrorBoundary pageName="龙虎榜与资金" onToast={showToast}>
                <DragonTigerPage
                  isActive={activeTab === 'st_lhb'}
                  onOpenFullscreenStock={(q) => openFullscreenStock(q)}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('technical') && (
            <div
              className="page-viewport page-viewport-pane"
              data-active={activeTab === 'technical' ? 'true' : 'false'}
              style={{ display: activeTab === 'technical' ? 'flex' : 'none' }}
            >
              <PageErrorBoundary pageName="技术流派与预警实验室" onToast={showToast}>
                <TechnicalLabPage
                  workspace={workspace}
                  aiConfig={aiConfig}
                  isActive={activeTab === 'technical'}
                  initialTargetQuery={targetTechnicalQuery}
                  onConsumeInitial={() => setTargetTechnicalQuery(null)}
                  onRadarSummaryChange={setTechRadarSummary}
                  onOpenEntity={handleOpenEntity}
                  onQuickAnalyzeStock={(queryLabel) => {
                    setTargetJudgeQuery(queryLabel);
                    setTargetLedgerMode('createJudgment');
                    setActiveTab('ledger');
                  }}
                  onOpenAiSettings={() => setAiModalOpen(true)}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('trades') && (
            <div
              className="page-viewport page-viewport-pane"
              data-active={activeTab === 'trades' ? 'true' : 'false'}
              style={{ display: activeTab === 'trades' ? 'flex' : 'none' }}
            >
              <PageErrorBoundary pageName="交易账本与归因中心" onToast={showToast}>
                <TradeLedgerPage
                  workspace={workspace}
                  aiConfig={aiConfig}
                  onOpenEntity={handleOpenEntity}
                  onOpenTechnical={(secidOrQuery) => {
                    setTargetTechnicalQuery(secidOrQuery);
                    setActiveTab('technical');
                  }}
                  onOpenAiSettings={() => setAiModalOpen(true)}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('backtest') && (
            <div
              className="page-viewport page-viewport-pane"
              data-active={activeTab === 'backtest' ? 'true' : 'false'}
              style={{ display: activeTab === 'backtest' ? 'flex' : 'none' }}
            >
              <PageErrorBoundary pageName="策略回测实验室" onToast={showToast}>
                <BacktestLabPage
                  workspace={workspace}
                  aiConfig={aiConfig}
                  onJobStarted={handleJobStarted}
                  onOpenEntity={handleOpenEntity}
                  onOpenFullscreenStock={(q) => openFullscreenStock(q)}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('intel') && (
            <div
              className="page-viewport page-viewport-pane"
              data-active={activeTab === 'intel' ? 'true' : 'false'}
              style={{ display: activeTab === 'intel' ? 'flex' : 'none' }}
            >
              <PageErrorBoundary pageName="情报信源与进化中心" onToast={showToast}>
                <IntelHubPage
                  aiConfig={aiConfig}
                  recentIntelJob={recentIntelJob}
                  onJobStarted={handleJobStarted}
                  onJobFinished={refreshJobs}
                  onOpenAiSettings={() => setAiModalOpen(true)}
                  onRequestMutation={handleRequestMutation}
                  onPendingCountChange={setIntelPendingCount}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('methodology') && (
            <div
              className="page-viewport page-viewport-pane"
              data-active={activeTab === 'methodology' ? 'true' : 'false'}
              style={{ display: activeTab === 'methodology' ? 'flex' : 'none' }}
            >
              <PageErrorBoundary pageName="方法论卡片库" onToast={showToast}>
                <MethodologyPage
                  workspace={workspace}
                  aiConfig={aiConfig}
                  recentIngestJob={recentMethodIngestJob}
                  onJobStarted={handleJobStarted}
                  onJobFinished={refreshJobs}
                  initialCardId={targetMethodCard}
                  initialConflictId={targetConflict}
                  initialModal={targetMethodModal}
                  initialDraftNote={pendingDraftNote?.target === 'method' ? pendingDraftNote : null}
                  onDraftNoteAccepted={handleDraftNoteAccepted}
                  onConsumeInitial={() => {
                    setTargetMethodCard(null);
                    setTargetConflict(null);
                    setTargetMethodModal(null);
                    setPendingDraftNote((prev) => (prev?.target === 'method' ? null : prev));
                  }}
                  onOpenEntity={handleOpenEntity}
                  onOpenAiSettings={() => setAiModalOpen(true)}
                  onRequestMutation={handleRequestMutation}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('cognition') && (
            <div
              className="page-viewport page-viewport-pane"
              data-active={activeTab === 'cognition' ? 'true' : 'false'}
              style={{ display: activeTab === 'cognition' ? 'flex' : 'none' }}
            >
              <PageErrorBoundary pageName="行业前沿认知库" onToast={showToast}>
                <CognitionPage
                  workspace={workspace}
                  aiConfig={aiConfig}
                  recentIngestJob={recentCogIngestJob}
                  onJobStarted={handleJobStarted}
                  onJobFinished={refreshJobs}
                  initialCardId={targetCogCard}
                  initialModal={targetCogModal}
                  initialDraftNote={pendingDraftNote?.target === 'cognition' ? pendingDraftNote : null}
                  onDraftNoteAccepted={handleDraftNoteAccepted}
                  onConsumeInitial={() => {
                    setTargetCogCard(null);
                    setTargetCogModal(null);
                    setPendingDraftNote((prev) => (prev?.target === 'cognition' ? null : prev));
                  }}
                  onOpenEntity={handleOpenEntity}
                  onOpenAiSettings={() => setAiModalOpen(true)}
                  onRequestMutation={handleRequestMutation}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('ledger') && (
            <div
              className="page-viewport page-viewport-pane"
              data-active={activeTab === 'ledger' ? 'true' : 'false'}
              style={{ display: activeTab === 'ledger' ? 'flex' : 'none' }}
            >
              <PageErrorBoundary pageName="研判与复盘台账" onToast={showToast}>
                <LedgerPage
                  workspace={workspace}
                  aiConfig={aiConfig}
                  theme={theme}
                  recentDailyJob={recentDailyJob}
                  recentJudgmentJob={recentJudgmentJob}
                  onJobStarted={handleJobStarted}
                  onJobFinished={refreshJobs}
                  initialDailyId={targetDailyId}
                  initialJudgmentId={targetJudgeId}
                  initialMode={targetLedgerMode}
                  initialJudgeQuery={targetJudgeQuery}
                  initialDraftNote={pendingDraftNote?.target === 'judgment' ? pendingDraftNote : null}
                  onDraftNoteAccepted={handleDraftNoteAccepted}
                  onConsumeInitial={() => {
                    setTargetDailyId(null);
                    setTargetJudgeId(null);
                    setTargetLedgerMode(null);
                    setTargetJudgeQuery(null);
                    setPendingDraftNote((prev) => (prev?.target === 'judgment' ? null : prev));
                  }}
                  onOpenEntity={handleOpenEntity}
                  onPreviewEntity={setPreviewEntity}
                  onOpenTechnical={(secidOrQuery) => {
                    setTargetTechnicalQuery(secidOrQuery);
                    setActiveTab('technical');
                  }}
                  onOpenAiSettings={() => setAiModalOpen(true)}
                  onRequestMutation={handleRequestMutation}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}

          {visitedTabs.has('maintenance') && (
            <div
              className="page-viewport page-viewport-pane"
              data-active={activeTab === 'maintenance' ? 'true' : 'false'}
              style={{ display: activeTab === 'maintenance' ? 'flex' : 'none' }}
            >
              <PageErrorBoundary pageName="质检·推送·备份中心" onToast={showToast}>
                <MaintenancePage
                  workspace={workspace}
                  audit={audit}
                  onRerunAudit={async () => {
                    const au = await api.runAudit();
                    setAudit(au);
                    showToast(t('三库全量质检完成', 'Full 3-library audit completed'), 'success');
                  }}
                  onRequestMutation={handleRequestMutation}
                  onRestored={async (msg) => {
                    await loadAll(false);
                    showToast(msg, 'success');
                  }}
                  onToast={showToast}
                />
              </PageErrorBoundary>
            </div>
          )}
          {/* 打印导出机构 PDF 固定合规免责页脚 */}
          <div className="print-compliance-footer">
            <strong>{t('合规免责声明：', 'Compliance Disclaimer: ')}</strong>
            {t(
              '本文件由本地优先三库投研工作台生成，仅供个人/机构内部研究笔记整理与复盘归档使用，不构成任何证券投资咨询、荐股、目标价预测或买卖建议。投资决策及全部风险由使用者自行承担。',
              'Generated by Local-First Secondary Research Workbench for internal research documentation and review archiving only. Does not constitute investment advice, security recommendations, or price targets.'
            )}{' '}
            · {new Date().toISOString().slice(0, 16).replace('T', ' ')}
          </div>
          </Suspense>
        </main>

        {/* 模块四：工作台页面底部常驻 Bot 对话栏（与悬浮宠物共享同一对话线程与 L0-L3 权限） */}
        <div className="no-print" data-assistant-layer="true">
          <BotBottomDock
            focusProMode={effectiveFocusProMode}
            slimeHidden={slimeHidden}
            onShowSlime={() => handleToggleSlimeHidden(false)}
            onOpenFullscreenStock={(q) => openFullscreenStock(q)}
          />
        </div>
      </div>

      {/* 全局跨三库与全市场证券秒搜 */}
      <CommandPalette
        open={cmdOpen}
        workspace={workspace}
        initialFocusHint={cmdHintMode}
        onClose={() => {
          setCmdOpen(false);
          setCmdHintMode('all');
        }}
        onSelectEntity={jumpToEntity}
        onOpenFullscreenStock={(secid, name) => openFullscreenStock(secid, name)}
        onAddToWatchlist={handleAddSecurityToWatchlist}
      />

      {/* 跨库双链右侧预览抽屉 */}
      <EntityPreviewDrawer
        entity={previewEntity}
        workspace={workspace}
        onClose={() => setPreviewEntity(null)}
        onJumpToMain={jumpToEntity}
        onPreviewEntity={setPreviewEntity}
      />

      {/* AI 自动复盘引擎配置模态框 */}
      <AiConfigModal
        open={aiModalOpen}
        config={aiConfig}
        onClose={() => setAiModalOpen(false)}
        onSaved={(cfg) => setAiConfig(cfg)}
        onToast={showToast}
      />

      {/* 模块一：可插拔数据源与接口管理模态框 */}
      <DataSourceModal
        open={dataSourceModalOpen}
        initialChannel={dataSourceInitialChannel}
        onClose={() => setDataSourceModalOpen(false)}
        onUpdated={(cfg) => setDataSourceConfig(cfg)}
        onToast={showToast}
      />

      {/* 方案 A：工作空间切换 & 离线授权管理模态框（按需懒加载） */}
      {workspaceModalOpen && (
        <Suspense fallback={null}>
          <WorkspaceLicenseModal
            open={workspaceModalOpen}
            initialTab={workspaceModalTab}
            workspaceProfile={workspaceProfile}
            license={licenseStatus}
            onClose={() => {
              setWorkspaceModalOpen(false);
              setWorkspaceModalTab('workspace');
            }}
            onProfileUpdated={(p) => setWorkspaceProfile(p)}
            onLicenseUpdated={(lic, ents) => {
              setLicenseStatus(lic);
              if (ents) setClientEntitlements(ents, lic.machineCode || '');
            }}
            onWorkspaceSwitched={(nextProfile) => {
              applyWorkspaceRootTransition(nextProfile?.activeProjectRoot || '', { forceReset: true });
              return loadAll(false);
            }}
            onToast={showToast}
          />
        </Suspense>
      )}

      {/* 商业化受控权益统一升级引导弹窗（拦截 HTTP 402 与前端盲测/多图入口） */}
      <UpgradeGateModal
        detail={upgradeGateDetail}
        machineCode={licenseStatus?.machineCode}
        onClose={() => setUpgradeGateDetail(null)}
        onOpenLicenseModal={() => {
          setWorkspaceModalTab('license');
          setWorkspaceModalOpen(true);
        }}
        onToast={showToast}
      />

      {/* 左上角工作台品牌个性化定制模态框 */}
      <BrandCustomizeModal
        open={brandModalOpen}
        brandState={brandState}
        aiConfig={aiConfig}
        onClose={() => setBrandModalOpen(false)}
        onSaved={(st) => {
          setBrandState(st);
          if (st.profile?.title) document.title = st.profile.title;
        }}
        onOpenAiSettings={() => setAiModalOpen(true)}
        onToast={showToast}
      />

      {/* 写盘确认门（Diff Preview + 原子备份落库） */}
      <DiffConfirmModal
        preview={pendingMutation?.preview || null}
        committing={committing}
        onCancel={() => setPendingMutation(null)}
        onConfirm={handleConfirmMutation}
      />

      {/* 弈盘风格：全局任意标的/期货个股全屏研究工作台（按需懒加载） */}
      {fullscreenStockQuery && (
        <Suspense fallback={null}>
          <StockFullscreenModal
            key={`fs-${workspaceEpoch}`}
            queryOrSecid={fullscreenStockQuery}
            onClose={() => setFullscreenStockQuery(null)}
            onChangeTarget={(nextQ, nextName) => openFullscreenStock(nextQ, nextName)}
            onTargetResolved={(info) => handleActiveStockChange(info, workspaceEpoch)}
            onOpenEntity={jumpToEntity}
            onQuickAnalyzeStock={(queryLabel) => {
              setTargetJudgeQuery(queryLabel);
              setTargetLedgerMode('createJudgment');
              setActiveTab('ledger');
            }}
            onToast={showToast}
          />
        </Suspense>
      )}

      {/* 蓝色史莱姆团子 · 权限可调全局悬浮 Bot（专注专业模式或用户手动贴边隐藏时自动关闭；打印态严格隐藏） */}
      {!effectiveFocusProMode && !slimeHidden && (
        <div className="no-print" data-assistant-layer="true">
          <SlimeBotWidget
            aiConfig={aiConfig}
            compactEdge={activeTab === 'st_watch'}
            onHideToDock={() => handleToggleSlimeHidden(true)}
            onOpenAiSettings={() => setAiModalOpen(true)}
            onOpenFullscreenStock={(q) => openFullscreenStock(q)}
            onToast={showToast}
          />
        </div>
      )}

      {/* 全局键盘快捷键速查表 (?) */}
      <ShortcutHelpModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* 盘中闪念速记框 (Ctrl+Shift+N) */}
      <QuickNotesModal
        open={quickNotesOpen}
        defaultSymbol={activeStockCtx?.secid || lastStockQuery || firstWatchlistSecid}
        defaultSymbolName={activeStockCtx?.name || ''}
        onClose={() => setQuickNotesOpen(false)}
        onConvertToDraft={(target, note) => {
          setPendingDraftNote({
            noteId: note.id,
            target,
            symbol: note.symbol || '',
            symbolName: note.symbolName || '',
            tag: note.tag || '盘中灵感',
            text: note.text,
            createdAt: note.createdAt,
            nonce: Date.now(),
          });
          if (target === 'cognition') {
            setActiveTab('cognition');
          } else if (target === 'method') {
            setActiveTab('methodology');
          } else {
            setActiveTab('ledger');
          }
        }}
        onToast={showToast}
      />

      {/* 商业版首次 3 分钟角色向导与专注专业模式配置 */}
      <RoleOnboardingModal
        open={roleWizardOpen}
        initialPrefs={uiPrefs}
        machineCode={licenseStatus?.machineCode || ''}
        canDismiss={uiPrefs.onboarded || !eulaStatus?.required}
        onApply={handleApplyUiPrefs}
        onQuickSetupDone={({ addedStocks, aiConfigured, licenseActivated }) => {
          const parts: string[] = [];
          if (addedStocks > 0) parts.push(`已导入 ${addedStocks} 只初始观察股`);
          if (aiConfigured) parts.push('AI 密钥已保存');
          if (licenseActivated) parts.push('离线授权已激活');
          if (parts.length > 0) {
            showToast(parts.join(' · '), 'success');
            loadAll(false);
          }
          // 兑现向导第 2 步承诺：若勾选了初始自选股且为波段投研模式，直接落地至实时自选盯盘页立即可看行情与 K 线
          if (addedStocks > 0) {
            setActiveTab('watchlist');
          }
        }}
        onToast={showToast}
        onClose={() => setRoleWizardOpen(false)}
      />

      {/* 商业版首次启动 EULA（软件许可与工具中立免责协议）签署确认门 */}
      <EulaOnboardingModal
        eula={eulaStatus}
        onAccepted={(next) => setEulaStatus(next)}
        onToast={showToast}
      />

      {/* 全局语义分级多条堆叠 Toast 队列 */}
      <ToastStack items={toasts} onDismiss={dismissToast} />
    </div>
    </SlimeBotProvider>
  );
};

export default App;
