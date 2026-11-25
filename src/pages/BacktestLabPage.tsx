import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Code2,
  Database,
  Download,
  Filter,
  FlaskConical,
  GitCompare,
  HelpCircle,
  Loader2,
  Maximize2,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Wrench,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { CRYPTO_ENABLED } from '../config/edition';
import type {
  AiProvider,
  AiSafeConfig,
  BackgroundJobDetail,
  BackgroundJobSummary,
  BacktestResultFull,
  BacktestRunSummary,
  EntityRef,
  QuantDataSummary,
  QuantEnvStatus,
  QuantMarket,
  QuantStrategyItem,
  VisualRuleConfig,
  WorkspaceData,
} from '../types';
import { QuantDataManagerPanel } from '../components/QuantDataManagerPanel';
import { CardToStrategyModal, StrategyRuleBuilder } from '../components/StrategyRuleBuilder';
import { BacktestReportView } from '../components/BacktestReportView';

interface BacktestLabPageProps {
  workspace: WorkspaceData;
  aiConfig: AiSafeConfig | null;
  onJobStarted?: (job: BackgroundJobSummary) => void;
  onOpenEntity?: (ref: EntityRef) => void;
  onOpenFullscreenStock?: (secidOrQuery: string) => void;
  onToast: (msg: string) => void;
}

type SubTab = 'workspace' | 'screener' | 'report' | 'compare' | 'data';

const CN_CORE_UNIVERSE_PRESETS: { id: string; label: string; symbols: string[] }[] = [
  {
    id: 'tech_leaders',
    label: 'A股科技成长核心(10只)',
    symbols: ['300308.SZ', '300502.SZ', '002384.SZ', '688256.SH', '601138.SH', '002371.SZ', '688981.SH', '300750.SZ', '002594.SZ', '688041.SH'],
  },
  {
    id: 'hs300_core',
    label: '沪深300权重精选(10只)',
    symbols: ['600519.SH', '601318.SH', '600036.SH', '601398.SH', '000333.SZ', '601899.SH', '600900.SH', '601088.SH', '000858.SZ', '600030.SH'],
  },
];

const MARKET_PRESETS: Partial<
  Record<
    QuantMarket,
    { label: string; badge: string; defaultCash: number; benchmark: string; defaultSymbols: string[]; rulesHint: string }
  >
> = {
  CN: {
    label: 'A股 (CN)',
    badge: 'T+1 · 涨跌停 · 100股 · 印花税',
    defaultCash: 1_000_000,
    benchmark: '000300.SH',
    defaultSymbols: ['300308.SZ', '002384.SZ'],
    rulesHint: 'T+1 锁仓、主板±10%/双创±20%/北交±30%/ST±5%、100股整手、卖出0.05%印花税+¥5最低佣金',
  },
  US: {
    label: '美股 (US)',
    badge: 'T+0 · 无涨跌停 · 1股 · USD',
    defaultCash: 100_000,
    benchmark: 'SPY.US',
    defaultSymbols: ['NVDA.US'],
    rulesHint: 'T+0 当日可买可卖、无涨跌幅限制、1股起买、支持做空、无印花税',
  },
  HK: {
    label: '港股 (HK)',
    badge: 'T+0 · 每手lot · 双边0.1%印花税',
    defaultCash: 500_000,
    benchmark: '02800.HK',
    defaultSymbols: ['00700.HK'],
    rulesHint: 'T+0 回转、按标的每手股数 (lot_size) 撮合、双边 0.1% 印花税',
  },
  ...(CRYPTO_ENABLED
    ? {
        CRYPTO: {
          label: '加密 (CRYPTO)',
          badge: '24×7 · 小数仓位 · USDT',
          defaultCash: 50_000,
          benchmark: 'BTC_USDT.CRYPTO',
          defaultSymbols: ['BTC_USDT.CRYPTO'],
          rulesHint: '7×24 含周末全年连续 K 线、支持 0.0001 小数仓位与双向交易、0.1% 手续费',
        },
      }
    : {}),
  FUT: {
    label: '期货 (FUT)',
    badge: 'T+0 · 多空双向 · 合约手数',
    defaultCash: 500_000,
    benchmark: '',
    defaultSymbols: [],
    rulesHint: 'T+0 双向合约撮合、按合约乘数与 0.01% 手续费结算',
  },
};

const DEFAULT_VISUAL_RULE: VisualRuleConfig = {
  name: '可视化双均线 + 不追高乖离策略',
  positionWeight: 0.45,
  entryLogic: 'AND',
  exitLogic: 'OR',
  entryConditions: [
    { indicator: 'MA', period: 5, op: 'cross_above', rhsType: 'indicator', rhsIndicator: 'MA', rhsPeriod: 20 },
    { indicator: 'BIAS', period: 5, op: '<=', rhsType: 'value', value: 8 },
  ],
  exitConditions: [
    { indicator: 'MA', period: 5, op: 'cross_below', rhsType: 'indicator', rhsIndicator: 'MA', rhsPeriod: 20 },
  ],
};

const COMPARE_COLORS = ['#ef4444', '#2563eb', '#10b981', '#f59e0b'];

export const BacktestLabPage: React.FC<BacktestLabPageProps> = ({
  workspace,
  aiConfig,
  onJobStarted,
  onOpenEntity,
  onOpenFullscreenStock,
  onToast,
}) => {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<SubTab>('workspace');
  const [env, setEnv] = useState<QuantEnvStatus | null>(null);
  const [summary, setSummary] = useState<QuantDataSummary | null>(null);
  const [strategies, setStrategies] = useState<QuantStrategyItem[]>([]);
  const [runs, setRuns] = useState<BacktestRunSummary[]>([]);
  const [activeRun, setActiveRun] = useState<BacktestResultFull | null>(null);
  const [loadingInit, setLoadingInit] = useState<boolean>(true);
  const [showGuide, setShowGuide] = useState<boolean>(false);

  // 环境自定义配置 & 安装任务
  const [customPythonDraft, setCustomPythonDraft] = useState<string>('');
  const [setupJobId, setSetupJobId] = useState<string | null>(null);
  const [setupJob, setSetupJob] = useState<BackgroundJobDetail | null>(null);

  // 同步 & 回测活跃任务
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncJob, setSyncJob] = useState<BackgroundJobDetail | null>(null);
  const [btJobId, setBtJobId] = useState<string | null>(null);
  const [btJob, setBtJob] = useState<BackgroundJobDetail | null>(null);

  // 自选股跨市场符号池
  const [watchlistSymbols, setWatchlistSymbols] = useState<{ cn: string[]; us: string[]; hk: string[]; crypto: string[] }>({
    cn: [],
    us: [],
    hk: [],
    crypto: [],
  });

  // 策略工作区状态
  const [selectedStrategyId, setSelectedStrategyId] = useState<string>('builtin_dual_ma');
  const [strategyName, setStrategyName] = useState<string>('');
  const [strategyDesc, setStrategyDesc] = useState<string>('');
  const [strategyMode, setStrategyMode] = useState<'python' | 'visual'>('python');
  const [strategyCode, setStrategyCode] = useState<string>('');
  const [cardRefs, setCardRefs] = useState<string[]>([]);
  const [visualRule, setVisualRule] = useState<VisualRuleConfig>(DEFAULT_VISUAL_RULE);
  const [cardModalOpen, setCardModalOpen] = useState<boolean>(false);

  // 回测参数 + 动态选股模式
  const [market, setMarket] = useState<QuantMarket>('CN');
  const [universeMode, setUniverseMode] = useState<'explicit' | 'duckdb_all' | 'screener'>('explicit');
  const [symbolsText, setSymbolsText] = useState<string>('300308.SZ, 002384.SZ');
  const [screenerTopK, setScreenerTopK] = useState<number>(5);
  const [screenerRebalDays, setScreenerRebalDays] = useState<number>(5);
  const [screenerRankBy, setScreenerRankBy] = useState<string>('momentum_20d');
  const [screenerRequireMaBull, setScreenerRequireMaBull] = useState<boolean>(true);
  const [screenerPureRotation, setScreenerPureRotation] = useState<boolean>(true);
  const [screenerMinAmtWan, setScreenerMinAmtWan] = useState<number>(5000);
  const [publishingLive, setPublishingLive] = useState<boolean>(false);
  const [publishedStrategies, setPublishedStrategies] = useState<any[]>([]);

  // 全市场实时选股器状态
  const [liveMinAmtYi, setLiveMinAmtYi] = useState<number>(5);
  const [liveMinPrice, setLiveMinPrice] = useState<string>('5');
  const [liveMaxPrice, setLiveMaxPrice] = useState<string>('300');
  const [liveMinPct, setLiveMinPct] = useState<string>('-3');
  const [liveMaxPct, setLiveMaxPct] = useState<string>('11');
  const [liveMinVolRatio, setLiveMinVolRatio] = useState<string>('1.0');
  const [liveSortBy, setLiveSortBy] = useState<string>('f6');
  const [liveStrategyId, setLiveStrategyId] = useState<string>('');
  const [liveSignalFilter, setLiveSignalFilter] = useState<'any' | 'buy_recent' | 'in_position'>('any');
  const [liveScreening, setLiveScreening] = useState<boolean>(false);
  const [liveScreenedItems, setLiveScreenedItems] = useState<any[]>([]);
  const [liveScanMeta, setLiveScanMeta] = useState<{ totalPoolScanned: number; matchedCount: number; scannedAt: string } | null>(null);
  const [startDate, setStartDate] = useState<string>('2025-01-01');
  const [endDate, setEndDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [freq, setFreq] = useState<string>('1d');
  const [adjust, setAdjust] = useState<string>('qfq');
  const [matchMode, setMatchMode] = useState<'next_open' | 'close'>('next_open');
  const [initialCash, setInitialCash] = useState<number>(1_000_000);
  const [benchmark, setBenchmark] = useState<string>('000300.SH');

  // 风控配置
  const [maxPositionPct, setMaxPositionPct] = useState<number>(45);
  const [maxTotalExposurePct, setMaxTotalExposurePct] = useState<number>(95);
  const [stopLossPct, setStopLossPct] = useState<string>('');
  const [takeProfitPct, setTakeProfitPct] = useState<string>('');
  const [trailingAtrMult, setTrailingAtrMult] = useState<string>('');
  const [enableCard174Guard, setEnableCard174Guard] = useState<boolean>(true);
  const [enableSentimentCap, setEnableSentimentCap] = useState<boolean>(false);
  const [savingStrategy, setSavingStrategy] = useState<boolean>(false);
  const [launchingBt, setLaunchingBt] = useState<boolean>(false);

  // 多轮历史对比状态
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareDetails, setCompareDetails] = useState<Record<string, BacktestResultFull>>({});
  const [loadingCompare, setLoadingCompare] = useState<boolean>(false);

  const loadAllQuantState = useCallback(async (selectFirstStrategy = false) => {
    try {
      const [envRes, sumRes, stratRes, runsRes, pubRes] = await Promise.all([
        api.getQuantEnv(),
        api.getQuantDataSummary(),
        api.listQuantStrategies(),
        api.listQuantRuns(),
        api.listPublishedStrategies().catch(() => ({ ok: true, allStrategies: [] })),
      ]);
      setEnv(envRes);
      setCustomPythonDraft(envRes.config?.pythonPath || '');
      setSummary(sumRes);
      setStrategies(stratRes.strategies || []);
      setRuns(runsRes.runs || []);
      setPublishedStrategies(pubRes.allStrategies || []);

      if (!sumRes.totalSeries) {
        setShowGuide(true);
      }

      if (selectFirstStrategy && stratRes.strategies?.length) {
        const first = stratRes.strategies[0];
        setSelectedStrategyId(first.id);
        setStrategyName(first.name);
        setStrategyDesc(first.description || '');
        setStrategyMode(first.mode || 'python');
        setStrategyCode(first.code || '');
        setCardRefs(first.cardRefs || []);
        if (first.ruleConfig) setVisualRule(first.ruleConfig);
      }

      // 默认预选最新 2 条跑过的回测供对比，并加载最新一条报告
      if (runsRes.runs?.length && selectFirstStrategy) {
        setCompareIds(runsRes.runs.slice(0, 3).map((r) => r.runId));
        api
          .getQuantRun(runsRes.runs[0].runId)
          .then((full) => setActiveRun(full))
          .catch(() => {});
      }
    } catch (err: any) {
      onToast(`加载回测实验室状态失败：${err.message || err}`);
    } finally {
      setLoadingInit(false);
    }
  }, [onToast]);

  useEffect(() => {
    loadAllQuantState(true);
    // 同步读取自选股配置以支持一键导入同市场标的
    api
      .getWatchlist()
      .then((res) => {
        const cn: string[] = [];
        const us: string[] = [];
        const hk: string[] = [];
        const crypto: string[] = [];
        for (const it of res.items || []) {
          const m = String(it.marketKind || 'CN').toUpperCase();
          const code = String(it.code || '').trim();
          const secid = String(it.secid || '').trim();
          if (!code) continue;
          if (m === 'CN') {
            if (secid.startsWith('1.') || code.startsWith('6')) cn.push(`${code}.SH`);
            else if (code.startsWith('8') || code.startsWith('4')) cn.push(`${code}.BJ`);
            else cn.push(`${code}.SZ`);
          } else if (m === 'US') {
            us.push(`${code.toUpperCase()}.US`);
          } else if (m === 'HK') {
            hk.push(`${code.padStart(5, '0')}.HK`);
          } else if (CRYPTO_ENABLED && m === 'CRYPTO') {
            crypto.push(code.includes('_') ? `${code.toUpperCase()}.CRYPTO` : `${code.toUpperCase()}_USDT.CRYPTO`);
          }
        }
        setWatchlistSymbols({ cn, us, hk, crypto });
      })
      .catch(() => {});
  }, [loadAllQuantState]);

  // 轮询活跃任务（setup / sync / backtest）
  useEffect(() => {
    const ids = [setupJobId, syncJobId, btJobId].filter(Boolean) as string[];
    if (!ids.length) return;
    let alive = true;
    const poll = async () => {
      for (const jid of ids) {
        try {
          const res = await api.getJob(jid);
          if (!alive || !res.job) continue;
          const j = res.job;
          if (jid === setupJobId) {
            setSetupJob(j);
            if (j.status !== 'running') {
              setSetupJobId(null);
              if (j.status === 'completed') {
                onToast('Python 量化隔离环境 (.venv + DuckDB) 初始化成功！');
                loadAllQuantState(false);
              } else if (j.status === 'failed') {
                onToast(`环境初始化失败：${j.error}`);
              }
            }
          }
          if (jid === syncJobId) {
            setSyncJob(j);
            if (j.status !== 'running') {
              setSyncJobId(null);
              if (j.status === 'completed') {
                onToast('DuckDB 历史数据同步完成！');
                loadAllQuantState(false);
              } else if (j.status === 'failed') {
                onToast(`数据同步失败：${j.error}`);
              }
            }
          }
          if (jid === btJobId) {
            setBtJob(j);
            if (j.status !== 'running') {
              if (j.status === 'completed' && j.result?.runId) {
                const finishedRunId = j.result.runId as string;
                const finishedName = j.result.meta?.strategyName || '';
                const finishedRet = j.result.summary?.totalReturnPct ?? 0;
                onToast(`回测完成：${finishedName} (${finishedRet}%)`);
                try {
                  const [full, runsRes] = await Promise.all([api.getQuantRun(finishedRunId), api.listQuantRuns()]);
                  setActiveRun(full);
                  setRuns(runsRes.runs || []);
                  setSubTab('report');
                } catch {
                  // fallback
                }
              } else if (j.status === 'failed') {
                onToast(`回测失败：${j.error}`);
              }
              setBtJobId(null);
            }
          }
        } catch {
          // ignore transient poll error
        }
      }
    };
    poll();
    const timer = window.setInterval(poll, 750);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [setupJobId, syncJobId, btJobId, loadAllQuantState, onToast]);

  // 加载多轮对比的完整净值曲线
  useEffect(() => {
    if (subTab !== 'compare' || !compareIds.length) return;
    const missing = compareIds.filter((id) => !compareDetails[id]);
    if (!missing.length) return;
    let alive = true;
    setLoadingCompare(true);
    Promise.all(missing.map((id) => api.getQuantRun(id).catch(() => null)))
      .then((list) => {
        if (!alive) return;
        setCompareDetails((prev) => {
          const next = { ...prev };
          for (const item of list) {
            if (item && item.runId) next[item.runId] = item;
          }
          return next;
        });
      })
      .finally(() => {
        if (alive) setLoadingCompare(false);
      });
    return () => {
      alive = false;
    };
  }, [subTab, compareIds, compareDetails]);

  const storedSymbolsForMarket = useMemo(() => {
    return (summary?.items || []).filter((it) => it.market === market && it.freq === freq);
  }, [summary, market, freq]);

  const handleSelectStrategy = (s: QuantStrategyItem) => {
    setSelectedStrategyId(s.id);
    setStrategyName(s.name);
    setStrategyDesc(s.description || '');
    setStrategyMode(s.mode || 'python');
    setStrategyCode(s.code || '');
    setCardRefs(s.cardRefs || []);
    if (s.ruleConfig) setVisualRule(s.ruleConfig);
  };

  const handleMarketSwitch = (mk: QuantMarket) => {
    const preset = MARKET_PRESETS[mk];
    if (!preset) return;
    setMarket(mk);
    setInitialCash(preset.defaultCash);
    setBenchmark(preset.benchmark);
    const stored = (summary?.items || [])
      .filter((it) => it.market === mk && it.freq === '1d' && it.symbol !== preset.benchmark)
      .map((it) => it.symbol);
    if (stored.length) {
      setSymbolsText(stored.slice(0, 3).join(', '));
    } else if (preset.defaultSymbols.length) {
      setSymbolsText(preset.defaultSymbols.join(', '));
    } else {
      setSymbolsText('');
    }
  };

  const handleImportWatchlistForMarket = () => {
    const key = market.toLowerCase() as 'cn' | 'us' | 'hk' | 'crypto';
    const list = watchlistSymbols[key] || [];
    if (!list.length) {
      onToast(`当前自选股池中暂无 ${market} 市场标的`);
      return;
    }
    setSymbolsText(list.slice(0, 8).join(', '));
    onToast(`已导入 ${Math.min(8, list.length)} 只 ${market} 自选股到回测标的池`);
  };

  const handleSaveStrategy = async () => {
    const name = (strategyMode === 'visual' ? visualRule.name : strategyName).trim() || '自定义量化策略';
    setSavingStrategy(true);
    try {
      const res = await api.saveQuantStrategy({
        id: selectedStrategyId.startsWith('builtin_') ? undefined : selectedStrategyId,
        name,
        description: strategyDesc,
        mode: strategyMode,
        market,
        code: strategyCode,
        ruleConfig: strategyMode === 'visual' ? visualRule : null,
        cardRefs,
      });
      setSelectedStrategyId(res.strategy.id);
      const listRes = await api.listQuantStrategies();
      setStrategies(listRes.strategies || []);
      onToast(`策略「${res.strategy.name}」已保存至本地 quant_data/strategies/`);
    } catch (err: any) {
      onToast(`保存策略失败：${err.message || err}`);
    } finally {
      setSavingStrategy(false);
    }
  };

  const handleDeleteStrategy = async (id: string) => {
    try {
      await api.deleteQuantStrategy(id);
      const listRes = await api.listQuantStrategies();
      setStrategies(listRes.strategies || []);
      if (selectedStrategyId === id && listRes.strategies?.length) {
        handleSelectStrategy(listRes.strategies[0]);
      }
      onToast('策略已删除');
    } catch (err: any) {
      onToast(`删除策略失败：${err.message || err}`);
    }
  };

  const handlePublishCurrentStrategyToLive = async () => {
    const name = (strategyMode === 'visual' ? visualRule.name : strategyName).trim() || '自定义策略指标';
    setPublishingLive(true);
    try {
      const res = await api.publishLiveStrategy({
        strategyId: selectedStrategyId,
        strategyName: name,
        description: strategyDesc,
        strategyMode,
        code: strategyCode,
        ruleConfig: strategyMode === 'visual' ? visualRule : null,
        setDefault: true,
      });
      if (res.strategy?.id) {
        try {
          localStorage.setItem('srw_active_live_strategy_id_v1', res.strategy.id);
        } catch {
          // ignore
        }
        window.dispatchEvent(new Event('srw-published-strategies-changed'));
      }
      const pub = await api.listPublishedStrategies().catch(() => null);
      if (pub?.allStrategies) setPublishedStrategies(pub.allStrategies);
      onToast(`已将「${name}」提取为全市场盯盘 B/S 指标！打开任意股票 K 线或自选看板即可直接查看「策B / 策S」点位。`);
    } catch (err: any) {
      onToast(`提取实时策略指标失败：${err.message || err}`);
    } finally {
      setPublishingLive(false);
    }
  };

  const handleRunLiveScreener = async () => {
    setLiveScreening(true);
    try {
      const res = await api.screenLiveMarketStocks({
        minAmountYi: liveMinAmtYi,
        minPrice: liveMinPrice.trim() ? Number(liveMinPrice) : 0,
        maxPrice: liveMaxPrice.trim() ? Number(liveMaxPrice) : 0,
        minPct: liveMinPct.trim() ? Number(liveMinPct) : -10,
        maxPct: liveMaxPct.trim() ? Number(liveMaxPct) : 21,
        minVolRatio: liveMinVolRatio.trim() ? Number(liveMinVolRatio) : 0,
        sortBy: liveSortBy,
        strategyId: liveStrategyId,
        signalFilter: liveSignalFilter,
        limit: 30,
      });
      setLiveScreenedItems(res.items || []);
      setLiveScanMeta({
        totalPoolScanned: res.totalPoolScanned,
        matchedCount: res.matchedCount,
        scannedAt: res.scannedAt,
      });
      onToast(`全市场扫描完成：初筛 ${res.totalPoolScanned} 只，命中 ${res.matchedCount} 只标的`);
    } catch (err: any) {
      onToast(`全市场选股扫描失败：${err.message || err}`);
    } finally {
      setLiveScreening(false);
    }
  };

  const handleSyncSymbolsBatch = async (syms: string[], label: string) => {
    if (!env?.available) {
      onToast('请先初始化 Python 量化隔离环境 (.venv + DuckDB)');
      return;
    }
    try {
      const res = await api.startQuantDataSync({
        symbols: syms,
        market: 'CN',
        start: startDate,
        end: endDate,
        freq: '1d',
      });
      setSyncJobId(res.job.id);
      onJobStarted?.(res.job);
      setSymbolsText(syms.join(', '));
      onToast(`已启动「${label}」(${syms.length}只) 批量同步至本地 DuckDB，同步完成后可直接选股回测！`);
    } catch (err: any) {
      onToast(`启动批量同步失败：${err.message || err}`);
    }
  };

  const handleRunBacktest = async () => {
    if (!env?.available) {
      onToast('请先初始化 Python 量化隔离环境 (.venv + DuckDB)');
      return;
    }
    const syms = symbolsText
      .split(/[\s,，;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!syms.length && universeMode === 'explicit') {
      onToast('请至少输入或点选 1 个回测标的，或切换为「DuckDB 全库自动选股」模式');
      return;
    }
    setLaunchingBt(true);
    try {
      const res = await api.startQuantBacktest({
        market,
        universeMode,
        symbols: universeMode === 'explicit' ? syms : syms,
        screener:
          universeMode === 'screener'
            ? {
                enabled: true,
                topK: screenerTopK,
                rebalanceDays: screenerRebalDays,
                rankBy: screenerRankBy,
                requireMaBull: screenerRequireMaBull,
                pureRotation: screenerPureRotation,
                minAmountWan: screenerMinAmtWan,
                excludeSt: true,
              }
            : null,
        startDate,
        endDate,
        freq,
        adjust,
        matchMode,
        initialCash,
        benchmark,
        strategyId: selectedStrategyId,
        strategyName: strategyMode === 'visual' ? visualRule.name : strategyName || '自定义策略',
        strategyMode,
        code: strategyCode,
        ruleConfig: strategyMode === 'visual' ? visualRule : null,
        cardRefs,
        risk: {
          maxPositionPct: Math.max(0.05, Math.min(1, maxPositionPct / 100)),
          maxTotalExposurePct: Math.max(0.1, Math.min(1, maxTotalExposurePct / 100)),
          stopLossPct: stopLossPct.trim() ? Number(stopLossPct) : null,
          takeProfitPct: takeProfitPct.trim() ? Number(takeProfitPct) : null,
          trailingAtrMult: trailingAtrMult.trim() ? Number(trailingAtrMult) : null,
          enableCard174Guard,
          enableSentimentCap,
        },
      });
      setBtJobId(res.job.id);
      onJobStarted?.(res.job);
      onToast(`已启动多市场回测任务：${res.job.title}`);
    } catch (err: any) {
      onToast(`启动回测失败：${err.message || err}`);
    } finally {
      setLaunchingBt(false);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      await api.cancelJob(jobId);
      onToast('已发送取消指令，正在安全终止子进程...');
    } catch (err: any) {
      onToast(`取消任务失败：${err.message || err}`);
    }
  };

  const handleStartSetup = async () => {
    try {
      const res = await api.startQuantEnvSetup();
      setSetupJobId(res.job.id);
      onJobStarted?.(res.job);
      onToast('已开始后台创建独立 .venv 并安装商业友好依赖 (MIT/Apache/BSD)...');
    } catch (err: any) {
      onToast(`初始化启动失败：${err.message || err}`);
    }
  };

  const handleSaveCustomPython = async () => {
    try {
      const next = await api.saveQuantConfig({ pythonPath: customPythonDraft.trim() });
      setEnv(next);
      onToast(next.available ? `Python 环境已切换并自检通过 (${next.pythonVersion})` : next.reason || '已保存路径，但自检未通过');
      if (next.available) loadAllQuantState(false);
    } catch (err: any) {
      onToast(`保存 Python 路径失败：${err.message || err}`);
    }
  };

  const toggleCompareId = (runId: string) => {
    setCompareIds((prev) => {
      if (prev.includes(runId)) return prev.filter((x) => x !== runId);
      if (prev.length >= 4) return [...prev.slice(1), runId];
      return [...prev, runId];
    });
  };

  const comparedRuns = compareIds.map((id) => compareDetails[id]).filter(Boolean) as BacktestResultFull[];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 14px 72px 14px', width: '100%', overflowY: 'auto' }}>
      {/* 顶部子导航 + 状态条 */}
      <div className="panel" style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            className={`btn btn-sm ${subTab === 'workspace' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSubTab('workspace')}
          >
            <Code2 size={14} /> {t('策略工作区 & 选股回测', 'Strategy & Screener Backtest')}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${subTab === 'screener' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSubTab('screener')}
          >
            <Filter size={14} /> {t('全市场实时选股器', 'Live Market Screener')}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${subTab === 'report' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSubTab('report')}
          >
            <BarChart3 size={14} /> {t('回测绩效报告', 'Performance Report')}
            {activeRun ? <span className="badge" style={{ fontSize: 10, padding: '0 4px' }}>{activeRun.meta.market}</span> : null}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${subTab === 'compare' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSubTab('compare')}
          >
            <GitCompare size={14} /> {t('历史回测对比', 'Compare Runs')} ({runs.length})
          </button>
          <button
            type="button"
            className={`btn btn-sm ${subTab === 'data' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSubTab('data')}
          >
            <Database size={14} /> {t('本地数据仓管理', 'DuckDB Data Store')} ({summary?.totalSeries ?? 0})
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {loadingInit ? (
            <span className="badge badge-navy"><Loader2 size={11} className="spin" /> {t('探测量化内核...', 'Probing Engine...')}</span>
          ) : env?.available ? (
            <span className="badge badge-emerald mono" title={env.pythonExecutable}>
              <CheckCircle2 size={11} /> Python {env.pythonVersion} · DuckDB {env.dependencies?.duckdb?.version || 'OK'}
            </span>
          ) : (
            <span className="badge badge-amber">
              <AlertTriangle size={11} /> {t('Python 环境待初始化', 'Python Setup Needed')}
            </span>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowGuide((v) => !v)}>
            <HelpCircle size={13} /> {showGuide ? t('收起新手引导', 'Hide Guide') : t('4步上手向导', '4-Step Guide')}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => loadAllQuantState(false)}>
            <RefreshCw size={12} /> {t('刷新', 'Refresh')}
          </button>
        </div>
      </div>

      {/* 零 Python 友好诊断与一键初始化横幅（未装 Python 或缺依赖时展示，不崩溃、不影响其他页面） */}
      {!loadingInit && env && !env.available && (
        <div
          className="panel"
          style={{
            padding: 14,
            border: '1px solid var(--amber)',
            background: 'var(--amber-soft)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Wrench size={16} /> 量化回测引擎环境诊断（不影响工作台其他投研/短线页面正常使用）
              </div>
              <div style={{ fontSize: 12.5, marginTop: 4 }}>{env.reason}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>
                本内核 100% 原创自研，仅使用商业友好开源库（DuckDB MIT / Pandas BSD / NumPy BSD / BaoStock MIT / yfinance Apache-2.0），隔离安装至 `quant_engine/.venv`，不污染系统全局 Python。
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {env.canAutoSetup && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={setupJob?.status === 'running'}
                  onClick={handleStartSetup}
                >
                  {setupJob?.status === 'running' ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                  一键初始化隔离环境 (.venv)
                </button>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>自定义 Python 路径（选填）：</span>
            <input
              className="input mono"
              style={{ flex: '1 1 280px', fontSize: 12 }}
              value={customPythonDraft}
              onChange={(e) => setCustomPythonDraft(e.target.value)}
              placeholder="留空自动探测 .venv 或系统 Python 3.10+"
            />
            <button type="button" className="btn btn-sm" onClick={handleSaveCustomPython}>
              保存并重新探测
            </button>
          </div>

          {setupJob && (
            <div style={{ marginTop: 10, padding: 8, borderRadius: 6, background: 'var(--bg-card)', fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{setupJob.stage || setupJob.title}</span>
                <span className="mono">{Math.round(setupJob.pct || 0)}%</span>
              </div>
              {setupJob.logs && setupJob.logs.length > 0 && (
                <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, maxHeight: 72, overflowY: 'auto' }}>
                  {setupJob.logs.slice(-5).map((l, i) => (
                    <div key={i}>{l.msg}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 4 步零门槛新手引导卡片 */}
      {showGuide && (
        <div className="panel" style={{ padding: 14, border: '1px solid var(--navy)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <FlaskConical size={16} color="var(--navy)" /> 4 步零门槛开启本地多市场量化回测
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowGuide(false)}>
              知道了
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
            <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg-subtle)' }}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>Step 1 · Python + DuckDB 环境</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                {env?.available ? `已就绪 (Python ${env.pythonVersion}, 隔离 .venv)` : '点击上方一键初始化 .venv'}
              </div>
            </div>
            <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg-subtle)' }}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>Step 2 · 本地 DuckDB 存储路径</div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, wordBreak: 'break-all' }}>
                {env?.dataDir || 'quant_data/'}（可在「数据仓管理」修改）
              </div>
            </div>
            <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg-subtle)' }}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>Step 3 · 下载历史 K 线数据包</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                当前已入库 {summary?.totalSeries ?? 0} 条序列。
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginTop: 6 }}
                  onClick={() => setSubTab('data')}
                >
                  <Download size={11} /> 去数据仓一键免费同步
                </button>
              </div>
            </div>
            <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg-subtle)' }}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>Step 4 · 一键运行内置模板策略</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                零未来函数次日开盘撮合，跑完直出净值曲线 + K 线 B/S 买卖点复盘！
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  style={{ marginTop: 6 }}
                  disabled={!env?.available || launchingBt}
                  onClick={handleRunBacktest}
                >
                  <Play size={11} /> 立即试跑双均线
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== SUB-TAB 1: 策略工作区 ==================== */}
      {subTab === 'workspace' && (
        <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
          {/* 左侧策略清单 */}
          <div className="panel" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>策略模板与自建库</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title="新建空白可视化/Python策略"
                onClick={() => {
                  setSelectedStrategyId('');
                  setStrategyName('我的新策略');
                  setStrategyDesc('');
                  setCardRefs([]);
                }}
              >
                <Plus size={13} />
              </button>
            </div>

            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ justifyContent: 'center' }}
              onClick={() => setCardModalOpen(true)}
            >
              <Sparkles size={13} /> 从方法论卡片 AI 生成策略
            </button>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 480, overflowY: 'auto' }}>
              {strategies.map((s) => {
                const active = s.id === selectedStrategyId;
                return (
                  <div
                    key={s.id}
                    onClick={() => handleSelectStrategy(s)}
                    style={{
                      padding: '8px 9px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      border: active ? '1px solid var(--navy)' : '1px solid var(--border)',
                      background: active ? 'var(--navy-soft)' : 'var(--bg-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: 12, lineHeight: 1.3 }}>{s.name}</span>
                      {!s.builtin && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: 2 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteStrategy(s.id);
                          }}
                          title="删除策略"
                        >
                          <Trash2 size={11} color="var(--crimson)" />
                        </button>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                      <span className="badge" style={{ fontSize: 10 }}>
                        {s.builtin ? '内置模板' : s.mode === 'visual' ? '可视化规则' : 'Python'}
                      </span>
                      {(s.cardRefs || []).map((cid) => (
                        <span key={cid} className="badge badge-gold mono" style={{ fontSize: 10 }}>
                          卡{cid}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 右侧主配置与编辑器 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* 市场模式切换 + 标的池 + 时间/撮合参数 */}
            <div className="panel" style={{ padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {(Object.keys(MARKET_PRESETS) as QuantMarket[]).map((mk) => (
                    <button
                      key={mk}
                      type="button"
                      className={`btn btn-sm ${market === mk ? 'btn-primary' : ''}`}
                      onClick={() => handleMarketSwitch(mk)}
                    >
                      {MARKET_PRESETS[mk]?.label}
                    </button>
                  ))}
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{MARKET_PRESETS[market]?.badge}</span>
              </div>

              <div
                style={{
                  padding: '6px 10px',
                  borderRadius: 6,
                  background: 'var(--bg-subtle)',
                  fontSize: 11.5,
                  color: 'var(--text-secondary)',
                  marginBottom: 10,
                }}
              >
                <ShieldCheck size={12} style={{ verticalAlign: 'middle', marginRight: 5 }} />
                当前市场撮合规则：{MARKET_PRESETS[market]?.rulesHint}
              </div>

              {/* 标的池与选股模式选择 */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {[
                    { id: 'explicit', label: '指定标的池' },
                    { id: 'duckdb_all', label: `DuckDB 全库多标的 (${storedSymbolsForMarket.length}只)` },
                    { id: 'screener', label: '动态横截面选股轮动 (Top-K)' },
                  ].map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`btn btn-sm ${universeMode === m.id ? 'btn-primary' : ''}`}
                      style={{ fontSize: 11.5 }}
                      onClick={() => setUniverseMode(m.id as any)}
                    >
                      {m.label}
                    </button>
                  ))}
                  {market === 'CN' &&
                    CN_CORE_UNIVERSE_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11 }}
                        onClick={() => handleSyncSymbolsBatch(p.symbols, p.label)}
                        title="批量下载这组核心龙头股的日K历史至本地 DuckDB，方便直接运行动态选股轮动回测"
                      >
                        <Download size={11} /> 同步{p.label}
                      </button>
                    ))}
                </div>

                {universeMode === 'screener' && (
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--navy)',
                      background: 'var(--navy-soft)',
                      marginBottom: 8,
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))',
                      gap: 8,
                      fontSize: 11.5,
                    }}
                  >
                    <div>
                      <label className="field-label">每期入选 Top K (只)</label>
                      <input type="number" className="input mono" min={1} max={30} value={screenerTopK} onChange={(e) => setScreenerTopK(Math.max(1, Number(e.target.value) || 5))} />
                    </div>
                    <div>
                      <label className="field-label">轮动调仓周期 (交易日)</label>
                      <input type="number" className="input mono" min={1} max={60} value={screenerRebalDays} onChange={(e) => setScreenerRebalDays(Math.max(1, Number(e.target.value) || 5))} />
                    </div>
                    <div>
                      <label className="field-label">横截面选股排序因子</label>
                      <select className="input" value={screenerRankBy} onChange={(e) => setScreenerRankBy(e.target.value)}>
                        <option value="momentum_20d">20日动量最强</option>
                        <option value="momentum_5d">5日短线强势</option>
                        <option value="breakout_20d">20日新高突破强度</option>
                        <option value="volume_ratio">放量倍数最高</option>
                        <option value="rsi_low">低 RSI 超跌反弹</option>
                        <option value="amount">成交额容量最大</option>
                      </select>
                    </div>
                    <div>
                      <label className="field-label">日均成交额下限 (万元)</label>
                      <input type="number" className="input mono" value={screenerMinAmtWan} onChange={(e) => setScreenerMinAmtWan(Number(e.target.value) || 0)} />
                    </div>
                    <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                        <input type="checkbox" checked={screenerRequireMaBull} onChange={(e) => setScreenerRequireMaBull(e.target.checked)} />
                        仅选多头趋势（收盘&gt;MA20 且 MA5≥MA20）
                      </label>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                        <input type="checkbox" checked={screenerPureRotation} onChange={(e) => setScreenerPureRotation(e.target.checked)} />
                        纯因子轮动（入选即等权持有、跌出 Top-K 即卖出；取消则仅把入选股喂给下方择时策略）
                      </label>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <label className="field-label" style={{ marginBottom: 0 }}>
                    {universeMode === 'explicit'
                      ? '回测标的池（逗号分隔，仅读取本地 DuckDB）'
                      : '候选股票池（留空 = 自动使用本地 DuckDB 该市场全部已同步标的）'}
                  </label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={handleImportWatchlistForMarket}>
                      一键导入 {market} 自选股
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => setSubTab('screener')}>
                      去全市场选股器挑选 →
                    </button>
                  </div>
                </div>
                <input
                  className="input mono"
                  value={symbolsText}
                  onChange={(e) => setSymbolsText(e.target.value)}
                  placeholder={
                    universeMode === 'explicit'
                      ? CRYPTO_ENABLED
                        ? '例如：300308.SZ, 002384.SZ 或 NVDA.US 或 BTC_USDT.CRYPTO'
                        : '例如：300308.SZ, 002384.SZ 或 NVDA.US 或 00700.HK'
                      : '留空将自动扫描本地 DuckDB 该市场所有已同步标的（也可填子集代码缩小候选池）'
                  }
                />
                {storedSymbolsForMarket.length > 0 && (
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>本地已入库点击快选：</span>
                    {storedSymbolsForMarket.slice(0, 12).map((it) => {
                      const inPool = symbolsText.toUpperCase().includes(it.symbol.toUpperCase());
                      return (
                        <button
                          key={it.symbol}
                          type="button"
                          className={`badge mono ${inPool ? 'badge-navy' : ''}`}
                          style={{ cursor: 'pointer', border: '1px solid var(--border)' }}
                          onClick={() => {
                            const list = symbolsText
                              .split(/[\s,，;；]+/)
                              .map((s) => s.trim())
                              .filter(Boolean);
                            const next = inPool
                              ? list.filter((s) => s.toUpperCase() !== it.symbol.toUpperCase())
                              : [...list, it.symbol];
                            setSymbolsText(next.join(', '));
                          }}
                        >
                          {it.symbol} {it.name && it.name !== it.symbol ? `· ${it.name}` : ''}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 8 }}>
                <div>
                  <label className="field-label">开始日期</label>
                  <input type="date" className="input mono" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </div>
                <div>
                  <label className="field-label">结束日期</label>
                  <input type="date" className="input mono" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </div>
                <div>
                  <label className="field-label">初始资金</label>
                  <input
                    type="number"
                    className="input mono"
                    step={10000}
                    value={initialCash}
                    onChange={(e) => setInitialCash(Math.max(1000, Number(e.target.value) || 100000))}
                  />
                </div>
                <div>
                  <label className="field-label">对比基准</label>
                  <input className="input mono" value={benchmark} onChange={(e) => setBenchmark(e.target.value)} placeholder="如 000300.SH / SPY.US" />
                </div>
                <div>
                  <label className="field-label">撮合模式</label>
                  <select className="input" value={matchMode} onChange={(e) => setMatchMode(e.target.value as 'next_open' | 'close')}>
                    <option value="next_open">次日开盘 (零未来函数·推荐)</option>
                    <option value="close">当日收盘 (极速近似)</option>
                  </select>
                </div>
                <div>
                  <label className="field-label">周期 / 复权</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <select className="input" value={freq} onChange={(e) => setFreq(e.target.value)}>
                      <option value="1d">1d</option>
                      <option value="60m">60m</option>
                      <option value="15m">15m</option>
                      <option value="5m">5m</option>
                    </select>
                    <select className="input" value={adjust} onChange={(e) => setAdjust(e.target.value)}>
                      <option value="qfq">前复权</option>
                      <option value="none">不复权</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            {/* 策略编辑区：零代码可视化 vs Python 代码模式 */}
            <div className="panel" style={{ padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${strategyMode === 'python' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setStrategyMode('python')}
                  >
                    <Code2 size={13} /> Python 策略脚本模式
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${strategyMode === 'visual' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setStrategyMode('visual')}
                  >
                    <SlidersHorizontal size={13} /> 零代码可视化规则构建器
                  </button>
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-teal"
                    onClick={handlePublishCurrentStrategyToLive}
                    disabled={publishingLive}
                    title="提取当前策略指标并实时叠加到全市场盯盘页面（自选看板 / 短线盯盘 / 全屏 K 线）显示「策B / 策S」点位"
                  >
                    {publishingLive ? <Loader2 size={12} className="spin" /> : <Radio size={12} />} 提取到盯盘显示 B/S 点
                  </button>
                  <button type="button" className="btn btn-sm" onClick={handleSaveStrategy} disabled={savingStrategy}>
                    {savingStrategy ? <Loader2 size={12} className="spin" /> : <Save size={12} />} 保存为我的策略
                  </button>
                </div>
              </div>

              {strategyMode === 'visual' ? (
                <StrategyRuleBuilder ruleConfig={visualRule} onChange={setVisualRule} />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      className="input"
                      style={{ flex: '1 1 240px', fontWeight: 600 }}
                      value={strategyName}
                      onChange={(e) => setStrategyName(e.target.value)}
                      placeholder="策略名称"
                    />
                    <input
                      className="input"
                      style={{ flex: '2 1 300px', fontSize: 12 }}
                      value={strategyDesc}
                      onChange={(e) => setStrategyDesc(e.target.value)}
                      placeholder="策略逻辑说明与适用市场"
                    />
                  </div>
                  <textarea
                    className="input mono"
                    rows={14}
                    style={{
                      width: '100%',
                      fontSize: 12,
                      lineHeight: 1.55,
                      resize: 'vertical',
                      background: 'var(--bg-subtle)',
                    }}
                    value={strategyCode}
                    onChange={(e) => setStrategyCode(e.target.value)}
                    spellCheck={false}
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    内置安全 AST 校验（禁止 os/subprocess/网络读写），直接可用 `ctx.history(sym, n)` / `ctx.ind.sma/ema/rsi/macd/boll/atr/bias/crossover` / `ctx.order_target_percent` / `ctx.close_position`。
                  </div>
                </div>
              )}
            </div>

            {/* 风控与三库方法论纪律联动 + 运行按钮 */}
            <div className="panel" style={{ padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>组合风控与三库纪律叠加</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 8, marginBottom: 10 }}>
                <div>
                  <label className="field-label">单票仓位上限 (%)</label>
                  <input type="number" className="input mono" min={5} max={100} value={maxPositionPct} onChange={(e) => setMaxPositionPct(Number(e.target.value) || 35)} />
                </div>
                <div>
                  <label className="field-label">组合总仓上限 (%)</label>
                  <input type="number" className="input mono" min={10} max={100} value={maxTotalExposurePct} onChange={(e) => setMaxTotalExposurePct(Number(e.target.value) || 95)} />
                </div>
                <div>
                  <label className="field-label">单笔硬止损 % (选填)</label>
                  <input type="number" className="input mono" placeholder="如 8" value={stopLossPct} onChange={(e) => setStopLossPct(e.target.value)} />
                </div>
                <div>
                  <label className="field-label">单笔止盈 % (选填)</label>
                  <input type="number" className="input mono" placeholder="如 25" value={takeProfitPct} onChange={(e) => setTakeProfitPct(e.target.value)} />
                </div>
                <div>
                  <label className="field-label">移动 ATR 止损倍数</label>
                  <input type="number" step="0.5" className="input mono" placeholder="如 2.0" value={trailingAtrMult} onChange={(e) => setTrailingAtrMult(e.target.value)} />
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5 }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={enableCard174Guard} onChange={(e) => setEnableCard174Guard(e.target.checked)} />
                    叠加《卡片 174》重点监管黑名单拦截
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={enableSentimentCap} onChange={(e) => setEnableSentimentCap(e.target.checked)} />
                    叠加本地历史情绪周期仓位上限
                  </label>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  {btJob?.status === 'running' && (
                    <button type="button" className="btn btn-sm" style={{ color: 'var(--crimson)' }} onClick={() => handleCancelJob(btJob.id)}>
                      <Square size={12} /> 取消回测
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={launchingBt || btJob?.status === 'running' || !env?.available}
                    onClick={handleRunBacktest}
                  >
                    {launchingBt || btJob?.status === 'running' ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                    {btJob?.status === 'running' ? `回测计算中 (${Math.round(btJob.pct || 0)}%)` : '启动本地 DuckDB 回测'}
                  </button>
                </div>
              </div>

              {btJob && (
                <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                    <span>{btJob.stage || btJob.title}</span>
                    <span className="mono">{Math.round(btJob.pct || 0)}% · {btJob.status}</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${Math.min(100, Math.max(4, btJob.pct || 0))}%`,
                        height: '100%',
                        background: btJob.status === 'failed' ? 'var(--crimson)' : 'var(--navy)',
                        transition: 'width 0.2s ease',
                      }}
                    />
                  </div>
                  {btJob.error && <div style={{ fontSize: 12, color: 'var(--crimson)', marginTop: 6 }}>{btJob.error}</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================== SUB-TAB 1.5: 全市场实时选股器 + 策略 B/S 信号扫描 ==================== */}
      {subTab === 'screener' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="panel" style={{ padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Filter size={15} color="var(--navy)" /> 全市场 A 股实时选股器（基础量价条件 + 量化策略 B/S 信号复筛）
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  按成交额/价格/涨幅/量比初筛实时 A 股池，并可直接叠加你在回测实验室提取的量化策略，找出近期刚刚发出「策B」信号的标的！
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="btn btn-primary btn-sm" disabled={liveScreening} onClick={handleRunLiveScreener}>
                  {liveScreening ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
                  {liveScreening ? '正在全市场扫描...' : '立即扫描全市场'}
                </button>
                {liveScreenedItems.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-teal btn-sm"
                    onClick={() => {
                      const syms = liveScreenedItems.slice(0, 12).map((x) => x.symbol);
                      handleSyncSymbolsBatch(syms, '选股器命中股池');
                      setUniverseMode('screener');
                      setSubTab('workspace');
                    }}
                  >
                    <Download size={12} /> 一键同步前 {Math.min(12, liveScreenedItems.length)} 只并去回测
                  </button>
                )}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 8 }}>
              <div>
                <label className="field-label">最小成交额 (亿元)</label>
                <input type="number" className="input mono" value={liveMinAmtYi} onChange={(e) => setLiveMinAmtYi(Number(e.target.value) || 0)} />
              </div>
              <div>
                <label className="field-label">股价区间 (元)</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input type="number" className="input mono" placeholder="最低" value={liveMinPrice} onChange={(e) => setLiveMinPrice(e.target.value)} />
                  <input type="number" className="input mono" placeholder="最高" value={liveMaxPrice} onChange={(e) => setLiveMaxPrice(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="field-label">今日涨跌幅 (%)</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input type="number" className="input mono" placeholder="下限" value={liveMinPct} onChange={(e) => setLiveMinPct(e.target.value)} />
                  <input type="number" className="input mono" placeholder="上限" value={liveMaxPct} onChange={(e) => setLiveMaxPct(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="field-label">最小量比</label>
                <input type="number" step="0.1" className="input mono" value={liveMinVolRatio} onChange={(e) => setLiveMinVolRatio(e.target.value)} />
              </div>
              <div>
                <label className="field-label">排序维度</label>
                <select className="input" value={liveSortBy} onChange={(e) => setLiveSortBy(e.target.value)}>
                  <option value="f6">成交额从高到低</option>
                  <option value="f3">今日涨幅从高到低</option>
                  <option value="f62">主力资金净流入</option>
                  <option value="f10">盘中量比放大</option>
                  <option value="f8">换手率活跃度</option>
                </select>
              </div>
              <div>
                <label className="field-label">叠加量化策略 B/S 复筛</label>
                <select className="input" value={liveStrategyId} onChange={(e) => setLiveStrategyId(e.target.value)}>
                  <option value="">不叠加策略（仅基础因子）</option>
                  {publishedStrategies.map((ps) => (
                    <option key={ps.id} value={ps.id}>
                      {ps.builtinPreset ? '★ ' : '⚡ '}
                      {ps.name}
                    </option>
                  ))}
                </select>
              </div>
              {liveStrategyId && (
                <div>
                  <label className="field-label">策略信号条件</label>
                  <select className="input" value={liveSignalFilter} onChange={(e) => setLiveSignalFilter(e.target.value as any)}>
                    <option value="any">全部展示并标注最新信号</option>
                    <option value="buy_recent">仅看近 5 日触发「策B」买入</option>
                    <option value="in_position">仅看当前处于策略多头持仓态</option>
                  </select>
                </div>
              )}
            </div>
          </div>

          <div className="panel" style={{ padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 13.5 }}>
                选股扫描结果 ({liveScreenedItems.length})
              </strong>
              {liveScanMeta && (
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  已扫描全A前 {liveScanMeta.totalPoolScanned} 只活跃股 · 命中 {liveScanMeta.matchedCount} 只
                </span>
              )}
            </div>
            {liveScreenedItems.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                点击上方「立即扫描全市场」即可实时筛选满足条件的 A 股，并可直接查看每个标的的策略「策B / 策S」触发状态。
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>标的</th>
                      <th>现价</th>
                      <th>涨跌幅</th>
                      <th>成交额</th>
                      <th>量比 / 换手</th>
                      <th>主力净流</th>
                      <th>策略 B/S 信号</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveScreenedItems.map((it) => (
                      <tr key={it.secid}>
                        <td>
                          <strong>{it.name}</strong>{' '}
                          <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{it.symbol}</span>
                        </td>
                        <td className="mono" style={{ fontWeight: 700 }}>¥{it.price}</td>
                        <td className="mono" style={{ fontWeight: 800, color: (it.pct ?? 0) >= 0 ? 'var(--crimson)' : 'var(--emerald)' }}>
                          {it.pct != null ? `${it.pct > 0 ? '+' : ''}${it.pct}%` : '-'}
                        </td>
                        <td className="mono">{it.amountYi}亿</td>
                        <td className="mono">{it.volumeRatio}x / {it.turnoverPct}%</td>
                        <td className="mono" style={{ color: (it.mainNetYi ?? 0) >= 0 ? 'var(--crimson)' : 'var(--emerald)' }}>
                          {it.mainNetYi != null ? `${it.mainNetYi > 0 ? '+' : ''}${it.mainNetYi}亿` : '-'}
                        </td>
                        <td>
                          {it.latestSignal ? (
                            <span
                              className="badge mono"
                              style={{
                                fontSize: 10.5,
                                background: it.latestSignal.side === 'BUY' ? 'rgba(124,58,237,0.14)' : 'rgba(2,132,199,0.14)',
                                color: it.latestSignal.side === 'BUY' ? '#7c3aed' : '#0284c7',
                              }}
                              title={`${it.latestSignal.date} @${it.latestSignal.price} ${it.latestSignal.reason}`}
                            >
                              {it.latestSignal.side === 'BUY' ? '策B' : '策S'} ·{' '}
                              {it.latestSignal.barsAgo === 0 ? '今日' : `${it.latestSignal.barsAgo}日前`}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{liveStrategyId ? '无信号' : '未选策略'}</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 5 }}>
                            {onOpenFullscreenStock && (
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                style={{ padding: '2px 7px', fontSize: 11 }}
                                onClick={() => {
                                  if (liveStrategyId) {
                                    try {
                                      localStorage.setItem('srw_active_live_strategy_id_v1', liveStrategyId);
                                    } catch {
                                      // ignore
                                    }
                                    window.dispatchEvent(new Event('srw-published-strategies-changed'));
                                  }
                                  onOpenFullscreenStock(it.secid);
                                }}
                              >
                                <Maximize2 size={11} /> 看图
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-sm"
                              style={{ padding: '2px 7px', fontSize: 11 }}
                              onClick={async () => {
                                try {
                                  await api.addWatchlistItem(
                                    {
                                      secid: it.secid,
                                      code: it.code,
                                      secuCode: it.symbol,
                                      name: it.name,
                                      marketKind: 'CN',
                                      currency: 'CNY',
                                      group: '量化选股',
                                    },
                                    true
                                  );
                                  onToast(`已将 ${it.name} (${it.code}) 加入自选看板`);
                                } catch (e: any) {
                                  onToast(e.message || '加入自选失败');
                                }
                              }}
                            >
                              <Plus size={11} /> 自选
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== SUB-TAB 2: 回测绩效报告 ==================== */}
      {subTab === 'report' && (
        <BacktestReportView run={activeRun} onOpenEntity={onOpenEntity} onToast={onToast} />
      )}

      {/* ==================== SUB-TAB 3: 历史回测对比 ==================== */}
      {subTab === 'compare' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* 多曲线叠加对比图 */}
          {comparedRuns.length >= 2 && (() => {
            const W = 920;
            const H = 220;
            const PAD_L = 54;
            const PAD_R = 16;
            const PAD_T = 16;
            const PAD_B = 24;
            const allNavs = comparedRuns.flatMap((r) => (r.equityCurve || []).map((p) => p.nav));
            const minV = Math.min(...allNavs, 0.95) * 0.97;
            const maxV = Math.max(...allNavs, 1.05) * 1.03;
            const span = Math.max(0.01, maxV - minV);
            const maxLen = Math.max(...comparedRuns.map((r) => r.equityCurve?.length || 1), 2);
            const xOf = (i: number, len: number) => PAD_L + (len <= 1 ? 0 : (i / (len - 1)) * (W - PAD_L - PAD_R));
            const yOf = (v: number) => PAD_T + ((maxV - v) / span) * (H - PAD_T - PAD_B);
            return (
              <div className="panel" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>多策略归一化净值叠加对比 ({comparedRuns.length} 组)</div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5 }}>
                    {comparedRuns.map((r, idx) => (
                      <span key={r.runId} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ width: 10, height: 3, background: COMPARE_COLORS[idx % COMPARE_COLORS.length], display: 'inline-block' }} />
                        <b>[{r.meta.market}] {r.meta.strategyName}</b> ({r.metrics.totalReturnPct >= 0 ? '+' : ''}{r.metrics.totalReturnPct.toFixed(1)}%)
                      </span>
                    ))}
                  </div>
                </div>
                <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 215, display: 'block' }}>
                  {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                    const val = minV + (1 - t) * span;
                    const y = PAD_T + t * (H - PAD_T - PAD_B);
                    return (
                      <g key={t}>
                        <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="var(--border)" strokeDasharray="3 3" />
                        <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)" className="mono">{val.toFixed(2)}</text>
                      </g>
                    );
                  })}
                  {comparedRuns.map((r, idx) => {
                    const pts = r.equityCurve || [];
                    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i, pts.length).toFixed(1)},${yOf(p.nav).toFixed(1)}`).join(' ');
                    return <path key={r.runId} d={d} fill="none" stroke={COMPARE_COLORS[idx % COMPARE_COLORS.length]} strokeWidth="2.1" />;
                  })}
                  <text x={W - PAD_R} y={H - 5} textAnchor="end" fontSize="10" fill="var(--text-muted)" className="mono">
                    按各自交易进度归一化对齐 (最长 {maxLen} 根K线)
                  </text>
                </svg>

                {/* 横向 KPI & 参数对比表 */}
                <div style={{ overflowX: 'auto', marginTop: 10 }}>
                  <table className="data-table" style={{ width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th>策略 / 市场</th>
                        <th>标的池</th>
                        <th style={{ textAlign: 'right' }}>累计收益</th>
                        <th style={{ textAlign: 'right' }}>年化收益</th>
                        <th style={{ textAlign: 'right' }}>超额 Alpha</th>
                        <th style={{ textAlign: 'right' }}>最大回撤</th>
                        <th style={{ textAlign: 'right' }}>夏普</th>
                        <th style={{ textAlign: 'right' }}>胜率 / 盈亏比</th>
                        <th style={{ textAlign: 'right' }}>成交笔数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparedRuns.map((r, idx) => (
                        <tr key={r.runId}>
                          <td>
                            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: COMPARE_COLORS[idx % COMPARE_COLORS.length], marginRight: 6 }} />
                            <b>[{r.meta.market}] {r.meta.strategyName}</b>
                          </td>
                          <td className="mono" style={{ fontSize: 11 }}>{r.meta.symbols.join(', ')}</td>
                          <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: r.metrics.totalReturnPct >= 0 ? 'var(--crimson)' : 'var(--emerald)' }}>
                            {r.metrics.totalReturnPct >= 0 ? '+' : ''}{r.metrics.totalReturnPct.toFixed(2)}%
                          </td>
                          <td className="mono" style={{ textAlign: 'right' }}>{r.metrics.annualizedReturnPct.toFixed(2)}%</td>
                          <td className="mono" style={{ textAlign: 'right' }}>{r.metrics.excessReturnPct >= 0 ? '+' : ''}{r.metrics.excessReturnPct.toFixed(2)}%</td>
                          <td className="mono" style={{ textAlign: 'right', color: 'var(--emerald)' }}>-{Math.abs(r.metrics.maxDrawdownPct).toFixed(2)}%</td>
                          <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{r.metrics.sharpeRatio.toFixed(2)}</td>
                          <td className="mono" style={{ textAlign: 'right' }}>{r.metrics.winRatePct.toFixed(1)}% / {r.metrics.profitLossRatio.toFixed(2)}</td>
                          <td className="mono" style={{ textAlign: 'right' }}>{r.metrics.tradeCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* 历史回测归档清单 */}
          <div className="panel" style={{ padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>历史回测归档记录 ({runs.length})</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>勾选 2~4 条记录即可在上方叠加多曲线净值与 KPI 对比；点击「查看报告」可下钻 K 线 B/S 复盘</div>
              </div>
              {loadingCompare && <Loader2 size={14} className="spin" />}
            </div>

            {runs.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                暂无历史回测归档，请在「策略工作区」运行第一次回测。
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table" style={{ width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 34 }}>对比</th>
                      <th>时间 / RunID</th>
                      <th>市场</th>
                      <th>策略名称</th>
                      <th>标的</th>
                      <th style={{ textAlign: 'right' }}>累计收益</th>
                      <th style={{ textAlign: 'right' }}>最大回撤</th>
                      <th style={{ textAlign: 'right' }}>夏普</th>
                      <th style={{ textAlign: 'right' }}>成交</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => {
                      const checked = compareIds.includes(r.runId);
                      return (
                        <tr key={r.runId}>
                          <td style={{ textAlign: 'center' }}>
                            <input type="checkbox" checked={checked} onChange={() => toggleCompareId(r.runId)} />
                          </td>
                          <td className="mono" style={{ fontSize: 11 }}>{(r.createdAt || r.runId).slice(0, 19).replace('T', ' ')}</td>
                          <td><span className="badge badge-navy mono">{r.meta?.market || 'CN'}</span></td>
                          <td style={{ fontWeight: 600 }}>{r.meta?.strategyName || '-'}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{(r.meta?.symbols || []).slice(0, 3).join(', ')}</td>
                          <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: (r.metrics?.totalReturnPct ?? 0) >= 0 ? 'var(--crimson)' : 'var(--emerald)' }}>
                            {(r.metrics?.totalReturnPct ?? 0) >= 0 ? '+' : ''}{(r.metrics?.totalReturnPct ?? 0).toFixed(2)}%
                          </td>
                          <td className="mono" style={{ textAlign: 'right' }}>-{Math.abs(r.metrics?.maxDrawdownPct ?? 0).toFixed(2)}%</td>
                          <td className="mono" style={{ textAlign: 'right' }}>{(r.metrics?.sharpeRatio ?? 0).toFixed(2)}</td>
                          <td className="mono" style={{ textAlign: 'right' }}>{r.tradeCount}</td>
                          <td>
                            <div style={{ display: 'flex', gap: 5 }}>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={async () => {
                                  try {
                                    const full = await api.getQuantRun(r.runId);
                                    setActiveRun(full);
                                    setSubTab('report');
                                  } catch (err: any) {
                                    onToast(`加载报告失败：${err.message || err}`);
                                  }
                                }}
                              >
                                查看报告
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={async () => {
                                  await api.deleteQuantRun(r.runId);
                                  setRuns((prev) => prev.filter((x) => x.runId !== r.runId));
                                  setCompareIds((prev) => prev.filter((x) => x !== r.runId));
                                  onToast('已删除该回测归档');
                                }}
                                title="删除归档"
                              >
                                <Trash2 size={12} color="var(--crimson)" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== SUB-TAB 4: 本地数据仓管理 ==================== */}
      {subTab === 'data' && (
        <QuantDataManagerPanel
          env={env}
          summary={summary}
          activeSyncJob={syncJob}
          watchlistSymbols={watchlistSymbols}
          onSyncJobStarted={(jid) => setSyncJobId(jid)}
          onCancelJob={handleCancelJob}
          onDataDirSaved={(next) => setEnv(next)}
          onRefresh={() => loadAllQuantState(false)}
          onToast={onToast}
        />
      )}

      {/* 从方法论卡片库 AI 生成策略弹窗 */}
      <CardToStrategyModal
        open={cardModalOpen}
        cards={workspace.methodology.cards}
        market={market}
        provider={(aiConfig?.provider as AiProvider | undefined) || undefined}
        onClose={() => setCardModalOpen(false)}
        onGenerated={(draft) => {
          setSelectedStrategyId('');
          setStrategyMode('python');
          setStrategyName(draft.name);
          setStrategyDesc(draft.description);
          setCardRefs(draft.cardRefs);
          setStrategyCode(draft.code);
        }}
        onToast={onToast}
      />
    </div>
  );
};
