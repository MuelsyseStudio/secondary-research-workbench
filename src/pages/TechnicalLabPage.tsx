import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Calculator,
  CheckCircle2,
  ClipboardCopy,
  Crosshair,
  Flame,
  Gauge,
  Loader2,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type {
  AiProvider,
  AiSafeConfig,
  EntityRef,
  KlineTimeframe,
  RegulatoryWatchItem,
  RuleCardDriftAudit,
  TechnicalAlertRule,
  TechnicalAnalysisResponse,
  TechnicalMetricOption,
  TechnicalRadarResponse,
  WorkspaceData,
} from '../types';
import { AiProviderPicker, isAiProviderReady } from '../components/AiProviderPicker';
import { InteractiveKlineChart } from '../components/InteractiveKlineChart';
import { TradePlanCardModal } from '../components/TradePlanCardModal';
import { useSlimeBot } from '../contexts/SlimeBotContext';

interface TechnicalLabPageProps {
  workspace: WorkspaceData;
  aiConfig: AiSafeConfig | null;
  isActive?: boolean;
  initialTargetQuery?: string | null;
  onConsumeInitial?: () => void;
  onRadarSummaryChange?: (summary: { totalAlerts: number; highSeverityCount: number }) => void;
  onOpenEntity: (ref: EntityRef) => void;
  onQuickAnalyzeStock: (queryLabel: string) => void;
  onOpenAiSettings: () => void;
  onToast: (msg: string) => void;
}

function currencyPrefix(currency: string) {
  if (currency === 'USD') return '$';
  if (currency === 'HKD') return 'HK$';
  return '¥';
}

function pctColor(v: number | null | undefined) {
  if (v == null) return 'var(--text-muted)';
  if (v > 0) return '#dc2626';
  if (v < 0) return '#16a34a';
  return 'var(--text-secondary)';
}

function severityBadge(sev: 'high' | 'medium' | 'info') {
  if (sev === 'high') return <span className="badge badge-crimson" style={{ fontSize: 10.5 }}>高危见顶/破位</span>;
  if (sev === 'medium') return <span className="badge badge-amber" style={{ fontSize: 10.5 }}>中度警戒</span>;
  return <span className="badge badge-teal" style={{ fontSize: 10.5 }}>观察提示</span>;
}

export const TechnicalLabPage: React.FC<TechnicalLabPageProps> = ({
  workspace,
  aiConfig,
  isActive = true,
  initialTargetQuery,
  onConsumeInitial,
  onRadarSummaryChange,
  onOpenEntity,
  onQuickAnalyzeStock,
  onOpenAiSettings,
  onToast,
}) => {
  const { t } = useI18n();
  const { watchState, addPriceAlertQuick, deleteWatchAlertQuick, setContextPill } = useSlimeBot();
  const [subView, setSubView] = useState<'overview' | 'rules'>('overview');

  // 雷达扫描状态
  const [radar, setRadar] = useState<TechnicalRadarResponse | null>(null);
  const [loadingRadar, setLoadingRadar] = useState(true);

  // 支撑压力位生成器状态（优先读当前空间自选股，不写死个人私有标的）
  const [targetInput, setTargetInput] = useState('');
  const [timeframe, setTimeframe] = useState<KlineTimeframe>('day');
  const [analysis, setAnalysis] = useState<TechnicalAnalysisResponse | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  // 规则库管理状态 + P0-3B 漂移审计 + P0-2 监管红线名单（卡片174）
  const [rules, setRules] = useState<TechnicalAlertRule[]>([]);
  const [metricCatalog, setMetricCatalog] = useState<TechnicalMetricOption[]>([]);
  const [driftAudit, setDriftAudit] = useState<RuleCardDriftAudit | null>(null);
  const [savingRules, setSavingRules] = useState(false);

  const [regItems, setRegItems] = useState<RegulatoryWatchItem[]>([]);
  const [newRegCode, setNewRegCode] = useState('');
  const [newRegName, setNewRegName] = useState('');
  const [newRegReason, setNewRegReason] = useState('10日4次异动 / 交易所重点监控红线（卡片174）');
  const [savingReg, setSavingReg] = useState(false);

  // P0-4：R 倍数仓位与同方向集中度计算器状态
  const [calcCapital, setCalcCapital] = useState('500000');
  const [calcRiskPct, setCalcRiskPct] = useState('1.5');
  const [calcMaxSinglePct, setCalcMaxSinglePct] = useState('25');
  const [calcStopOverride, setCalcStopOverride] = useState('');
  const [showPlanCard, setShowPlanCard] = useState(false);

  // 手动自定义规则表单
  const [newRule, setNewRule] = useState<{
    name: string;
    scope: 'market_sentiment' | 'stock_peak';
    metric: string;
    operator: '>=' | '<=' | '>' | '<' | '==';
    threshold: string;
    severity: 'high' | 'medium' | 'info';
    sourceCardId: string;
    actionAdvice: string;
  }>({
    name: '',
    scope: 'stock_peak',
    metric: 'ma5BiasPct',
    operator: '>=',
    threshold: '10',
    severity: 'high',
    sourceCardId: '',
    actionAdvice: '',
  });

  // 从方法论卡片库提取规则状态
  const [cardSearch, setCardSearch] = useState('');
  const [onlyTechCards, setOnlyTechCards] = useState(true);
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>(['054', '055', '061', '196']);
  const [extractingCards, setExtractingCards] = useState(false);
  const [extractedCandidates, setExtractedCandidates] = useState<TechnicalAlertRule[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<AiProvider>(aiConfig?.provider || 'codex_cli');

  useEffect(() => {
    if (aiConfig?.provider) setSelectedProvider(aiConfig.provider);
  }, [aiConfig?.provider]);

  const loadRules = useCallback(async () => {
    try {
      const [res, regRes] = await Promise.all([
        api.getTechnicalRules(),
        api.getRegulatoryWatchlist().catch(() => ({ ok: true, items: [] as RegulatoryWatchItem[], updatedAt: null })),
      ]);
      setRules(res.rules || []);
      setMetricCatalog(res.metricCatalog || []);
      setDriftAudit(res.driftAudit || null);
      setRegItems(regRes.items || []);
    } catch {
      // ignore
    }
  }, []);

  const handleSyncRuleHashes = async () => {
    setSavingRules(true);
    try {
      const res = await api.saveTechnicalRules({ syncHashes: true });
      setRules(res.rules || []);
      setDriftAudit(res.driftAudit || null);
      onToast('已同步全部预警规则对应的《方法论卡片库》最新内容指纹，漂移告警已清零！');
    } catch (err: any) {
      onToast(`同步失败：${err.message}`);
    } finally {
      setSavingRules(false);
    }
  };

  const handleAddRegulatoryItem = async () => {
    if (!newRegCode.trim() && !newRegName.trim()) {
      onToast('请输入交易所监管标的的代码或简称');
      return;
    }
    setSavingReg(true);
    try {
      const next: RegulatoryWatchItem[] = [
        {
          id: `reg-${Date.now()}`,
          code: newRegCode.trim().toUpperCase(),
          name: newRegName.trim() || newRegCode.trim().toUpperCase(),
          reason: newRegReason.trim() || '交易所重点监管/严重异动红线（卡片174）',
          level: 'ban',
          startDate: new Date().toISOString().slice(0, 10),
          endDate: '',
          active: true,
        },
        ...regItems,
      ];
      const res = await api.saveRegulatoryWatchlist(next);
      setRegItems(res.items || []);
      setNewRegCode('');
      setNewRegName('');
      onToast('已加入交易所重点监管红线名单（卡片174），标的研判与盘前预检将自动拦截提示！');
    } catch (err: any) {
      onToast(`保存监管名单失败：${err.message}`);
    } finally {
      setSavingReg(false);
    }
  };

  const handleRemoveRegulatoryItem = async (id: string) => {
    setSavingReg(true);
    try {
      const res = await api.saveRegulatoryWatchlist(regItems.filter((x) => x.id !== id));
      setRegItems(res.items || []);
      onToast('已移出重点监管名单');
    } finally {
      setSavingReg(false);
    }
  };

  const runRadarScan = useCallback(async () => {
    setLoadingRadar(true);
    try {
      const data = await api.getTechnicalRadar();
      setRadar(data);
      onRadarSummaryChange?.({
        totalAlerts: data.summary.totalAlerts,
        highSeverityCount: data.summary.highSeverityCount,
      });
    } catch (err: any) {
      onToast(`预警雷达扫描失败：${err.message}`);
    } finally {
      setLoadingRadar(false);
    }
  }, [onRadarSummaryChange, onToast]);

  const runAnalyzeTarget = useCallback(
    async (queryOrSecid: string, tfOverride?: KlineTimeframe) => {
      const q = queryOrSecid.trim();
      if (!q) {
        onToast('请输入标的代码或简称（如 300308 / 中际旭创 / NVDA / 英伟达 / 688809）');
        return;
      }
      const nextTf = tfOverride || timeframe;
      if (tfOverride) setTimeframe(tfOverride);
      setAnalyzing(true);
      try {
        const res = await api.analyzeTechnical(q, nextTf);
        setAnalysis(res);
        setTargetInput(`${res.target.name}（${res.target.secuCode}）`);
      } catch (err: any) {
        onToast(`生成支撑压力位失败：${err.message}`);
      } finally {
        setAnalyzing(false);
      }
    },
    [onToast, timeframe]
  );

  // 初始化并发拉取：规则库 + 全量预警雷达 + 当前空间首只自选标的支撑压力位（空时默认上证指数）
  useEffect(() => {
    loadRules();
    runRadarScan();
    api
      .getWatchlist()
      .then((wl) => {
        const first = wl.items?.[0]?.secid || '1.000001';
        runAnalyzeTarget(first, 'day');
      })
      .catch(() => {
        runAnalyzeTarget('1.000001', 'day');
      });
  }, [loadRules, runRadarScan]); // eslint-disable-line react-hooks/exhaustive-deps

  // 响应从「跨市场盯盘看板」跳转查询某只标的的支撑压力位
  useEffect(() => {
    if (initialTargetQuery) {
      setSubView('overview');
      setTargetInput(initialTargetQuery);
      runAnalyzeTarget(initialTargetQuery);
      onConsumeInitial?.();
    }
  }, [initialTargetQuery, onConsumeInitial, runAnalyzeTarget]);

  // 筛选方法论卡片供提取
  const filteredMethodCards = useMemo(() => {
    const kw = /高点|见顶|顶背|乖离|均线|支撑|压力|量能|放量|缩量|炸板|连板|高度|冰点|高潮|过热|拥挤|换手|分歧|止损|回踩|箱体|突破|情绪|MACD|RSI|2B|威科夫|缠论|波浪|订单流|筹码|抱团/i;
    const q = cardSearch.trim().toLowerCase();
    return workspace.methodology.cards
      .filter((c) => !c.isRevoked)
      .filter((c) => (!onlyTechCards ? true : kw.test(`${c.title} ${c.coreThesis} ${c.invalidationSignals}`)))
      .filter((c) => {
        if (!q) return true;
        return c.id.includes(q) || c.title.toLowerCase().includes(q) || c.coreThesis.toLowerCase().includes(q);
      });
  }, [workspace.methodology.cards, cardSearch, onlyTechCards]);

  const persistRulesAndRescan = async (nextRules: TechnicalAlertRule[], toastMsg: string) => {
    setSavingRules(true);
    try {
      const res = await api.saveTechnicalRules({ rules: nextRules });
      setRules(res.rules || []);
      onToast(toastMsg);
      await runRadarScan();
      if (analysis?.target?.secid) {
        await runAnalyzeTarget(analysis.target.secid);
      }
    } catch (err: any) {
      onToast(`保存规则失败：${err.message}`);
    } finally {
      setSavingRules(false);
    }
  };

  const handleToggleRule = (id: string) => {
    const next = rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r));
    persistRulesAndRescan(next, '已更新预警规则启用状态并重新扫描');
  };

  const handleThresholdChange = (id: string, valStr: string) => {
    const num = Number(valStr);
    if (!Number.isFinite(num)) return;
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, threshold: num } : r)));
  };

  const handleDeleteRule = (id: string) => {
    const next = rules.filter((r) => r.id !== id);
    persistRulesAndRescan(next, '已删除预警规则并刷新扫描');
  };

  const handleResetDefaultRules = async () => {
    setSavingRules(true);
    try {
      const res = await api.saveTechnicalRules({ reset: true });
      setRules(res.rules || []);
      onToast('已恢复内置方法论默认预警规则集');
      await runRadarScan();
    } catch (err: any) {
      onToast(`重置失败：${err.message}`);
    } finally {
      setSavingRules(false);
    }
  };

  const handleAddCustomRule = async () => {
    const th = Number(newRule.threshold);
    if (!Number.isFinite(th)) {
      onToast('请输入有效的数值阈值');
      return;
    }
    const metricObj = metricCatalog.find((m) => m.key === newRule.metric);
    const cardObj = newRule.sourceCardId
      ? workspace.methodology.cards.find((c) => c.id === newRule.sourceCardId.padStart(3, '0'))
      : null;

    const item: TechnicalAlertRule = {
      id: `custom-${Date.now()}`,
      name: newRule.name.trim() || `${metricObj?.label || newRule.metric} ${newRule.operator} ${th}`,
      scope: newRule.scope,
      metric: newRule.metric,
      operator: newRule.operator,
      threshold: th,
      severity: newRule.severity,
      enabled: true,
      sourceCardId: cardObj ? cardObj.id : newRule.sourceCardId.replace(/[^\d]/g, '').slice(0, 3),
      sourceCardTitle: cardObj ? cardObj.title : '自定义技术指标',
      actionAdvice: newRule.actionAdvice.trim() || '触发预设阈值，结合成交量与支撑压力位复核仓位纪律。',
    };

    await persistRulesAndRescan([item, ...rules], `已录入自定义预警指标「${item.name}」并完成全量扫描`);
    setNewRule((p) => ({ ...p, name: '', actionAdvice: '' }));
  };

  const handleExtractFromCards = async (useAi: boolean) => {
    if (selectedCardIds.length === 0) {
      onToast('请先在左侧勾选至少 1 张方法论卡片');
      return;
    }
    if (useAi && !isAiProviderReady(aiConfig, selectedProvider)) {
      onToast('所选 AI 引擎尚未就绪，请先配置或改用「规则引擎秒提」。');
      onOpenAiSettings();
      return;
    }
    setExtractingCards(true);
    try {
      const res = await api.extractTechnicalRulesFromCards(selectedCardIds, useAi, selectedProvider);
      setExtractedCandidates(res.extractedRules || []);
      onToast(
        `已从 ${res.sourceCards.length} 张方法论卡片${res.mode === 'ai' ? '经 AI 深度提炼' : '秒速提取'}出 ${res.extractedRules.length} 条可执行预警规则`
      );
    } catch (err: any) {
      onToast(`卡片提取规则失败：${err.message}`);
    } finally {
      setExtractingCards(false);
    }
  };

  const handleAcceptExtracted = async (candidates: TechnicalAlertRule[]) => {
    if (!candidates.length) return;
    const existingSig = new Set(rules.map((r) => `${r.scope}|${r.metric}|${r.operator}|${r.threshold}`));
    const fresh = candidates.filter((c) => !existingSig.has(`${c.scope}|${c.metric}|${c.operator}|${c.threshold}`));
    if (fresh.length === 0) {
      onToast('所选候选规则已存在于现行预警库中（相同指标与阈值）');
      return;
    }
    await persistRulesAndRescan([...fresh, ...rules], `已将 ${fresh.length} 条源自方法论卡片的预警规则加入实时雷达！`);
    setExtractedCandidates((prev) => prev.filter((c) => !fresh.some((f) => f.id === c.id)));
  };

  const handleCopyMarkdownLevels = async () => {
    if (!analysis) return;
    try {
      await navigator.clipboard.writeText(analysis.levels.markdownSummary);
      onToast(`已复制 ${analysis.target.name} 支撑压力位与止损 Markdown 摘要，可直接贴入复盘或标的研判！`);
    } catch {
      onToast('复制失败，请检查剪贴板权限');
    }
  };

  const metricLabel = (key: string) => metricCatalog.find((m) => m.key === key)?.label || key;
  const scopeMetrics = metricCatalog.filter((m) => m.scope === newRule.scope);

  const sentiment = radar?.sentiment;
  const currSym = analysis ? currencyPrefix(analysis.target.currency) : '¥';

  return (
    <div className="page-viewport">
      {/* 顶部模式切换栏 */}
      <div
        style={{
          padding: '10px 22px',
          background: 'var(--bg-elev)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div className="seg-tabs">
          <button
            type="button"
            className={`seg-tab ${subView === 'overview' ? 'active' : ''}`}
            onClick={() => setSubView('overview')}
          >
            <Radar size={14} /> {t('见顶预警雷达 & 一键支撑压力位', 'Alert Radar & Multi-School S/R')}
            {(radar?.summary.totalAlerts || 0) > 0 && (
              <span className="badge badge-crimson" style={{ padding: '0 5px', fontSize: 10.5 }}>
                {radar?.summary.totalAlerts}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`seg-tab ${subView === 'rules' ? 'active' : ''}`}
            onClick={() => setSubView('rules')}
          >
            <Settings2 size={14} /> {t('预警指标库（方法论卡片提取 + 自定义录入', 'Alert Rule Engine (Cards + Custom')} · {rules.filter((r) => r.enabled).length}/{rules.length}）
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={loadingRadar} onClick={runRadarScan}>
            <RefreshCw size={13} className={loadingRadar ? 'spin' : ''} />
            {loadingRadar ? t('雷达扫描中...', 'Scanning...') : t('全市场 & 自选重新扫描', 'Rescan Market & Watchlist')}
          </button>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* 视图一：实时预警雷达 + 一键支撑压力位实验室                             */}
      {/* ===================================================================== */}
      <div className="scroll-page" style={{ display: subView === 'overview' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}>
        {/* P0-3A：跨日 10 态市场情绪状态机行动红绿灯 & 近 20 日节点演化链 + P0-3B 规则漂移审计 */}
        {radar?.sentimentChain?.current && (
          <div
            className="panel panel-pad"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              borderLeft: `4px solid ${
                radar.sentimentChain.current.channel === 'forbidden_new' || radar.sentimentChain.current.channel === 'realize_only'
                  ? 'var(--crimson)'
                  : radar.sentimentChain.current.channel === 'attack_ok'
                  ? 'var(--emerald)'
                  : 'var(--navy)'
              }`,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 14.5 }}>跨日 10 态市场情绪节点状态机：</strong>
                <span
                  className={`badge ${
                    radar.sentimentChain.current.colorTone === 'crimson'
                      ? 'badge-crimson'
                      : radar.sentimentChain.current.colorTone === 'emerald'
                      ? 'badge-emerald'
                      : radar.sentimentChain.current.colorTone === 'amber'
                      ? 'badge-amber'
                      : 'badge-navy'
                  }`}
                  style={{ fontSize: 12.5, padding: '2px 9px' }}
                >
                  {radar.sentimentChain.current.prevNode ? `${radar.sentimentChain.current.prevNode} → ` : ''}
                  {radar.sentimentChain.current.node}
                </span>
                <span className="badge badge-muted">{radar.sentimentChain.current.channelLabel}</span>
                <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--navy)' }}>
                  建议总仓位上限 ≤ {radar.sentimentChain.current.maxPositionPct}%
                </span>
              </div>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                {radar.sentimentChain.current.boundCards.map((cid) => (
                  <button
                    key={cid}
                    type="button"
                    className="ref-chip ref-chip-method"
                    onClick={() => onOpenEntity({ kind: 'methodology', id: cid })}
                  >
                    卡片{cid}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{radar.sentimentChain.current.actionNote}</div>
            {radar.sentimentChain.history.length > 0 && (
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>历史演化链：</span>
                {radar.sentimentChain.history.slice(-14).map((h) => (
                  <span
                    key={h.date}
                    className="mono"
                    title={`${h.date} | 情绪分 ${h.sentimentScore} | 节点 ${h.node} | 红盘率 ${h.redRatePct ?? '-'}%`}
                    style={{
                      fontSize: 10.5,
                      padding: '2px 6px',
                      borderRadius: 5,
                      background:
                        h.colorTone === 'crimson'
                          ? 'var(--crimson-soft)'
                          : h.colorTone === 'emerald'
                          ? 'var(--emerald-soft)'
                          : 'var(--bg-soft)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {h.date.slice(5)} {h.node}({h.sentimentScore})
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {(driftAudit?.driftedCount || 0) > 0 && (
          <div
            style={{
              padding: '9px 13px',
              borderRadius: 9,
              background: 'var(--amber-soft)',
              border: '1px solid color-mix(in srgb, var(--amber) 40%, transparent)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              fontSize: 12.5,
            }}
          >
            <div>
              <AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--amber)' }} />
              <strong>卡片-规则漂移审计：</strong>
              《方法论卡片库》已有 {driftAudit!.driftedCount} 张关联卡片更新（
              {driftAudit!.driftedRules.map((d) => `卡${d.sourceCardId}`).join('、')}），请核对预警规则阈值是否需要同步。
            </div>
            <button type="button" className="btn btn-amber btn-sm" disabled={savingRules} onClick={handleSyncRuleHashes}>
              确认无误并同步卡片指纹
            </button>
          </div>
        )}

        {/* 上半区：全市场情绪高点雷达 + 自选股股价见顶预警 */}
        <div className="grid-2" style={{ gap: 14, alignItems: 'stretch' }}>
          {/* 1. 全市场阶段性情绪高点雷达 */}
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 14.5 }}>
                <Gauge size={16} color="var(--amber)" />
                A 股阶段性情绪温度计 & 高点预警
              </div>
              {sentiment && (
                <span
                  className={`badge ${
                    sentiment.sentimentScore >= 75
                      ? 'badge-crimson'
                      : sentiment.sentimentScore >= 58
                      ? 'badge-amber'
                      : sentiment.sentimentScore <= 28
                      ? 'badge-teal'
                      : 'badge-navy'
                  }`}
                >
                  {sentiment.sentimentScore} / 100 · {sentiment.stage}
                </span>
              )}
            </div>

            {sentiment && (
              <>
                {/* 温度进度条 */}
                <div>
                  <div
                    style={{
                      height: 8,
                      borderRadius: 99,
                      background: 'linear-gradient(90deg, #0f766e 0%, #2563eb 35%, #d97706 70%, #dc2626 100%)',
                      position: 'relative',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        left: `calc(${Math.max(2, Math.min(98, sentiment.sentimentScore))}% - 6px)`,
                        top: -3,
                        width: 14,
                        height: 14,
                        borderRadius: 99,
                        background: 'var(--bg-elev)',
                        border: '3px solid var(--text)',
                        boxShadow: 'var(--shadow-xs)',
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
                    <span>0 情绪冰点(181)</span>
                    <span>50 正常分化</span>
                    <span>80+ 一致高潮/过热(067/071)</span>
                  </div>
                </div>

                {/* 6 项硬情绪指标 */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7, fontSize: 12 }}>
                  <div style={{ padding: '7px 9px', borderRadius: 7, background: 'var(--bg-soft)' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>两市实时成交额</div>
                    <div className="mono num" style={{ fontWeight: 700, fontSize: 13.5 }}>
                      {sentiment.twoMarketAmtYi != null ? `${sentiment.twoMarketAmtYi.toFixed(0)}亿` : '--'}
                    </div>
                  </div>
                  <div style={{ padding: '7px 9px', borderRadius: 7, background: 'var(--bg-soft)' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>全市场红盘率</div>
                    <div className="mono num" style={{ fontWeight: 700, fontSize: 13.5, color: (sentiment.redRatePct || 0) >= 80 ? '#dc2626' : 'var(--text)' }}>
                      {sentiment.redRatePct != null ? `${sentiment.redRatePct}%` : '--'}
                      <span style={{ fontSize: 10.5, fontWeight: 400, color: 'var(--text-muted)' }}>
                        {' '}({sentiment.up ?? '-'}/{sentiment.down ?? '-'})
                      </span>
                    </div>
                  </div>
                  <div style={{ padding: '7px 9px', borderRadius: 7, background: 'var(--bg-soft)' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>涨停 / 跌停 / 炸板</div>
                    <div className="mono num" style={{ fontWeight: 700, fontSize: 13.5 }}>
                      <span style={{ color: '#dc2626' }}>{sentiment.ztCount ?? '-'}</span> /{' '}
                      <span style={{ color: '#16a34a' }}>{sentiment.dtCount ?? '-'}</span> /{' '}
                      <span style={{ color: 'var(--amber)' }}>{sentiment.zbCount ?? '-'}</span>
                    </div>
                  </div>
                  <div style={{ padding: '7px 9px', borderRadius: 7, background: 'var(--bg-soft)' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>封板率 / 炸板率</div>
                    <div className="mono num" style={{ fontWeight: 700, fontSize: 13 }}>
                      {sentiment.sealRatePct != null ? `${sentiment.sealRatePct}%` : '--'} /{' '}
                      <span style={{ color: (sentiment.burstRatePct || 0) >= 35 ? '#dc2626' : 'var(--text)' }}>
                        {sentiment.burstRatePct != null ? `${sentiment.burstRatePct}%` : '--'}
                      </span>
                    </div>
                  </div>
                  <div style={{ padding: '7px 9px', borderRadius: 7, background: 'var(--bg-soft)' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>最高连板 / 连板数</div>
                    <div className="mono num" style={{ fontWeight: 700, fontSize: 13 }}>
                      {sentiment.maxBoard}板 · {sentiment.lianbanCount}只
                    </div>
                  </div>
                  <div style={{ padding: '7px 9px', borderRadius: 7, background: 'var(--bg-soft)' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>当前高标龙头</div>
                    <div style={{ fontWeight: 600, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sentiment.topLeaders[0] ? `${sentiment.topLeaders[0].name}(${sentiment.topLeaders[0].board}板)` : '暂无连板'}
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* 触发的市场情绪高点预警 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              {(radar?.marketAlerts || []).length === 0 ? (
                <div style={{ padding: '8px 11px', borderRadius: 7, background: 'var(--emerald-soft)', color: 'var(--emerald)', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle2 size={14} /> 全市场情绪指标暂未触发极端高点/退潮红警
                </div>
              ) : (
                radar!.marketAlerts.map((a, idx) => (
                  <div
                    key={`${a.ruleId}-${idx}`}
                    style={{
                      padding: '8px 11px',
                      borderRadius: 8,
                      background: a.severity === 'high' ? 'var(--crimson-soft)' : 'var(--amber-soft)',
                      border: `1px solid ${a.severity === 'high' ? 'color-mix(in srgb, var(--crimson) 30%, transparent)' : 'color-mix(in srgb, var(--amber) 35%, transparent)'}`,
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {severityBadge(a.severity)}
                        <strong>{a.ruleName}</strong>
                      </div>
                      <span className="mono" style={{ fontWeight: 700 }}>
                        当前 {a.actualValue} ({a.operator} {a.threshold})
                      </span>
                    </div>
                    <div style={{ color: 'var(--text-secondary)', marginTop: 4, display: 'flex', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span>{a.actionAdvice}</span>
                      {a.sourceCardId && (
                        <button type="button" className="ref-chip ref-chip-method" onClick={() => onOpenEntity({ kind: 'methodology', id: a.sourceCardId })}>
                          卡片{a.sourceCardId}
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 2. 自选池（A股+美股）股价阶段性高点与破位实时预警 */}
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 14.5 }}>
                <ShieldAlert size={16} color="var(--crimson)" />
                自选池（A股 + 美股）股价高点与破位预警
              </div>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                已扫 {radar?.summary.scannedStockCount ?? 0} 只 · 预警{' '}
                <strong style={{ color: (radar?.stockAlerts.length || 0) > 0 ? 'var(--crimson)' : 'var(--emerald)' }}>
                  {radar?.stockAlerts.length ?? 0}
                </strong>{' '}
                条
              </span>
            </div>

            <div style={{ flex: 1, maxHeight: 265, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 7 }}>
              {loadingRadar && !radar ? (
                <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                  <Loader2 size={18} className="spin" /> 正在扫描 60 日 K 线、MACD 背驰、2B 法则与 MA5 乖离...
                </div>
              ) : (radar?.stockAlerts || []).length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', borderRadius: 8, background: 'var(--bg-soft)', color: 'var(--text-muted)', fontSize: 12.5 }}>
                  <CheckCircle2 size={18} color="var(--emerald)" style={{ marginBottom: 4 }} />
                  <div>当前全部自选股均处于健康技术区间，未触发高点见顶或生命线破位规则</div>
                </div>
              ) : (
                radar!.stockAlerts.map((a, idx) => (
                  <div
                    key={`${a.secid}-${a.ruleId}-${idx}`}
                    style={{
                      padding: '8px 11px',
                      borderRadius: 8,
                      background: 'var(--bg-soft)',
                      border: '1px solid var(--border)',
                      borderLeft: `3px solid ${a.severity === 'high' ? 'var(--crimson)' : 'var(--amber)'}`,
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span className={`badge ${a.marketKind === 'US' ? 'badge-navy' : 'badge-teal'}`} style={{ fontSize: 10, padding: '0 4px' }}>
                          {a.marketKind === 'US' ? '美股' : 'A股'}
                        </span>
                        <strong>{a.stockName}</strong>
                        <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 11 }}>{a.secuCode}</span>
                        {severityBadge(a.severity)}
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: '2px 7px', fontSize: 11 }}
                        onClick={() => a.secid && runAnalyzeTarget(a.secid)}
                      >
                        <Crosshair size={11} /> 看支撑压力
                      </button>
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text)' }}>
                        {a.ruleName}：
                        <span className="mono" style={{ color: a.severity === 'high' ? 'var(--crimson)' : 'var(--amber)' }}>
                          {a.operator === '==' ? '已触发' : `${a.actualValue} (${a.operator}${a.threshold})`}
                        </span>
                      </span>
                      {a.sourceCardId && (
                        <button type="button" className="ref-chip ref-chip-method" onClick={() => onOpenEntity({ kind: 'methodology', id: a.sourceCardId })}>
                          卡片{a.sourceCardId}
                        </button>
                      )}
                    </div>
                    {a.actionAdvice && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{a.actionAdvice}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* 下半区：多流派一键支撑压力位生成器 & K 线技术诊断台 */}
        <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 15.5, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 7 }}>
                <Crosshair size={17} color="var(--navy)" />
                多流派一键支撑压力位生成器（筹码峰POC · 波段颈线 · 均线 · 斐波那契 · 枢轴点 · 确认阳线 · 海龟2N止损）
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                自动将距离 ≤ 1.35% 的多流派点位聚类为「强共振支撑/压力带」，并附带对应《方法论卡片库》依据
              </div>
            </div>

            <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="input"
                style={{ width: 250 }}
                placeholder="输入代码/名称：300308 / NVDA / 强一股份"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') runAnalyzeTarget(targetInput);
                }}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={analyzing || !targetInput.trim()}
                onClick={() => runAnalyzeTarget(targetInput)}
              >
                {analyzing ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
                {analyzing ? '测算中...' : '一键生成支撑压力位'}
              </button>
            </div>
          </div>

          {/* 自选股快捷切换胶囊（带实时红点预警标识） */}
          {(radar?.stockScans || []).length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>自选快切：</span>
              {radar!.stockScans.map((s) => {
                const isSelected = analysis?.target.secid === s.secid;
                const hasHigh = s.alerts.some((x) => x.severity === 'high');
                const hasAlert = s.alerts.length > 0;
                return (
                  <button
                    key={s.secid}
                    type="button"
                    className={`btn btn-sm ${isSelected ? 'btn-primary' : ''}`}
                    style={{ padding: '3px 9px', fontSize: 11.5 }}
                    onClick={() => runAnalyzeTarget(s.secid)}
                  >
                    {hasAlert && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 99,
                          background: hasHigh ? '#dc2626' : '#d97706',
                          display: 'inline-block',
                        }}
                      />
                    )}
                    <span>{s.name}</span>
                    <span className="mono" style={{ opacity: 0.78, fontSize: 10.5 }}>
                      {s.pct != null ? `${s.pct > 0 ? '+' : ''}${s.pct}%` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {analyzing && !analysis ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
              <Loader2 size={20} className="spin" /> 正在获取 65 日 K 线并计算 6 大技术流派共振点位...
            </div>
          ) : analysis ? (
            <>
              {/* 单标技术状态汇总 + 快捷导出按钮 */}
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 9,
                  background: 'var(--bg-soft)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className={`badge ${analysis.target.marketKind === 'US' ? 'badge-navy' : 'badge-teal'}`}>
                    {analysis.target.marketKind === 'US' ? '美股' : analysis.target.marketKind === 'HK' ? '港股' : 'A股'}
                  </span>
                  <strong style={{ fontSize: 16 }}>{analysis.target.name}</strong>
                  <span className="mono" style={{ color: 'var(--text-muted)' }}>{analysis.target.secuCode}</span>
                  <span className="mono num" style={{ fontSize: 17, fontWeight: 800, color: pctColor(analysis.indicators.pct) }}>
                    {currSym}{analysis.indicators.price.toFixed(2)}{' '}
                    ({analysis.indicators.pct != null ? `${analysis.indicators.pct > 0 ? '+' : ''}${analysis.indicators.pct}%` : '--'})
                  </span>
                  <span className="badge badge-navy">{analysis.indicators.trendRegime}</span>
                  {analysis.levels.rewardRiskRatio != null && (
                    <span className="badge badge-emerald mono">
                      R1/S1 盈亏比 {analysis.levels.rewardRiskRatio}:1
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-teal btn-sm" onClick={() => setShowPlanCard(true)}>
                    <Calculator size={13} /> A股交易计划卡
                  </button>
                  <button type="button" className="btn btn-sm" onClick={handleCopyMarkdownLevels}>
                    <ClipboardCopy size={13} /> 复制点位摘要
                  </button>
                  <button
                    type="button"
                    className="btn btn-amber btn-sm"
                    onClick={() => onQuickAnalyzeStock(`${analysis.target.name}（${analysis.target.secuCode}）`)}
                  >
                    <Sparkles size={13} /> 发起 AI 联网研判
                  </button>
                </div>
              </div>

              {/* 当前标的触发的见顶/破位警报提示条 */}
              {analysis.triggeredAlerts.length > 0 && (
                <div
                  style={{
                    padding: '10px 13px',
                    borderRadius: 9,
                    background: 'var(--crimson-soft)',
                    border: '1px solid color-mix(in srgb, var(--crimson) 32%, transparent)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--crimson)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle size={14} />
                    当前标的已触发 {analysis.triggeredAlerts.length} 项技术高点 / 破位预警：
                  </div>
                  {analysis.triggeredAlerts.map((a, i) => (
                    <div key={i} style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span>
                        • <strong>{a.ruleName}</strong>（当前{' '}
                        <span className="mono">{a.operator === '==' ? '已触发' : a.actualValue}</span>）— {a.actionAdvice}
                      </span>
                      {a.sourceCardId && (
                        <button type="button" className="ref-chip ref-chip-method" onClick={() => onOpenEntity({ kind: 'methodology', id: a.sourceCardId })}>
                          卡片{a.sourceCardId}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 技术指标诊断八格（4x2 均衡栅格） */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, fontSize: 12 }}>
                <div className="field-block" style={{ marginBottom: 0, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>MA5 / 乖离率</div>
                  <div className="mono num" style={{ fontWeight: 700 }}>
                    {currSym}{analysis.indicators.ma5 ?? '--'}{' '}
                    <span style={{ color: Math.abs(analysis.indicators.ma5BiasPct || 0) >= 8 ? 'var(--crimson)' : 'var(--text-secondary)' }}>
                      ({analysis.indicators.ma5BiasPct != null ? `${analysis.indicators.ma5BiasPct > 0 ? '+' : ''}${analysis.indicators.ma5BiasPct}%` : '--'})
                    </span>
                  </div>
                </div>
                <div className="field-block" style={{ marginBottom: 0, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>MA20 / 乖离率</div>
                  <div className="mono num" style={{ fontWeight: 700 }}>
                    {currSym}{analysis.indicators.ma20 ?? '--'}{' '}
                    <span style={{ color: (analysis.indicators.ma20BiasPct || 0) < 0 ? '#16a34a' : 'var(--text-secondary)' }}>
                      ({analysis.indicators.ma20BiasPct != null ? `${analysis.indicators.ma20BiasPct > 0 ? '+' : ''}${analysis.indicators.ma20BiasPct}%` : '--'})
                    </span>
                  </div>
                </div>
                <div className="field-block" style={{ marginBottom: 0, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>RSI(6) / RSI(14)</div>
                  <div className="mono num" style={{ fontWeight: 700 }}>
                    <span style={{ color: (analysis.indicators.rsi6 || 0) >= 80 ? 'var(--crimson)' : 'var(--text)' }}>
                      {analysis.indicators.rsi6 ?? '--'}
                    </span>{' '}
                    / {analysis.indicators.rsi14 ?? '--'}
                  </div>
                </div>
                <div className="field-block" style={{ marginBottom: 0, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>MACD / 缠论顶背驰</div>
                  <div className="mono num" style={{ fontWeight: 700 }}>
                    柱 {analysis.indicators.macdHist ?? '--'}{' '}
                    {analysis.indicators.macdTopDivergence === 1 ? (
                      <span className="badge badge-crimson" style={{ fontSize: 10, padding: '0 4px' }}>顶背驰!</span>
                    ) : (
                      <span style={{ color: 'var(--emerald)', fontSize: 11 }}>正常</span>
                    )}
                  </div>
                </div>
                <div className="field-block" style={{ marginBottom: 0, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>60日筹码峰 POC</div>
                  <div className="mono num" style={{ fontWeight: 700, color: '#7c3aed' }}>
                    {currSym}{analysis.levels.volumeProfile.poc ?? '--'}
                  </div>
                </div>
                <div className="field-block" style={{ marginBottom: 0, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>海龟 2N 追踪止损</div>
                  <div className="mono num" style={{ fontWeight: 700, color: 'var(--amber)' }}>
                    {currSym}{analysis.levels.turtleStop2N ?? '--'}
                    <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}> (ATR {analysis.indicators.atrPct ?? '-'}%)</span>
                  </div>
                </div>
                <div className="field-block" style={{ marginBottom: 0, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>量能倍数 / 上影线</div>
                  <div className="mono num" style={{ fontWeight: 700 }}>
                    {analysis.indicators.volRatio5d ?? '--'}x / {analysis.indicators.upperShadowPct}%
                  </div>
                </div>
                <div className="field-block" style={{ marginBottom: 0, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>2B法则 / 威科夫量价</div>
                  <div style={{ fontWeight: 700, fontSize: 11.5 }}>
                    {analysis.indicators.is2BTopSignal === 1 ? (
                      <span style={{ color: 'var(--crimson)' }}>2B假突破! </span>
                    ) : (
                      <span style={{ color: 'var(--emerald)' }}>无2B · </span>
                    )}
                    {analysis.indicators.isHighVolStall === 1 ? (
                      <span style={{ color: 'var(--crimson)' }}>放量滞涨!</span>
                    ) : (
                      <span style={{ color: 'var(--emerald)' }}>量价配合</span>
                    )}
                  </div>
                </div>
              </div>

              {/* 多周期可缩放 K 线 + 筹码峰 + 支撑压力位 + 三大趋势线流派 + B/S点位 + 盲测回放 + 交互画线 */}
              <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)' }}>
                <InteractiveKlineChart
                  secid={analysis.target.secid}
                  title={`${analysis.target.name} (${analysis.target.secuCode})`}
                  klines={analysis.klines}
                  timeframe={analysis.timeframe || timeframe}
                  isActive={isActive}
                  loadingTimeframe={analyzing}
                  onChangeTimeframe={(tf) => runAnalyzeTarget(analysis.target.secid, tf)}
                  resistances={analysis.levels.resistances}
                  supports={analysis.levels.supports}
                  poc={analysis.levels.volumeProfile.poc}
                  volumeProfileBins={analysis.levels.volumeProfile.bins}
                  turtleStop2N={analysis.levels.turtleStop2N}
                  trendlines={analysis.trendlines || null}
                  tradeMarkers={analysis.tradeMarkers || null}
                  initialDrawings={analysis.drawings || []}
                  initialDrawingAlerts={analysis.drawingAlerts || []}
                  botPriceAlerts={(watchState?.alertsStore?.alerts || [])
                    .filter((a) => a.secid === analysis.target.secid && (a.condition === 'price_above' || a.condition === 'price_below') && a.enabled)
                    .map((a) => ({ id: a.id, price: a.threshold, condition: a.condition as 'price_above' | 'price_below', note: a.note }))}
                  onAddBotPriceAlert={(price, cond) => {
                    setContextPill({
                      label: `${analysis.target.name} ${analysis.target.code}`,
                      secid: analysis.target.secid,
                      code: analysis.target.code,
                      name: analysis.target.name,
                      price: analysis.indicators.price,
                    });
                    addPriceAlertQuick({ secid: analysis.target.secid, name: analysis.target.name, price, condition: cond });
                  }}
                  onDeleteBotPriceAlert={(id) => deleteWatchAlertQuick(id)}
                  onToast={onToast}
                  currencySymbol={currSym}
                  height={370}
                />
              </div>

              {/* P0-4：R 倍数仓位与单股红线计算器（直连当前现价 + S1/2N 止损位 + R1 目标位） */}
              {(() => {
                const entryP = analysis.indicators.price;
                const defaultStop = analysis.levels.supports[0]?.price || analysis.levels.turtleStop2N || Number((entryP * 0.93).toFixed(2));
                const stopP = Number(calcStopOverride) > 0 ? Number(calcStopOverride) : defaultStop;
                const targetP = analysis.levels.resistances[0]?.price || Number((entryP * 1.12).toFixed(2));
                const cap = Math.max(1000, Number(calcCapital) || 500000);
                const riskPct = Math.max(0.2, Math.min(10, Number(calcRiskPct) || 1.5));
                const maxSingle = Math.max(5, Math.min(100, Number(calcMaxSinglePct) || 25));
                const riskPerShare = Math.max(0.01, entryP - stopP);
                const stopDistPct = entryP > 0 ? ((entryP - stopP) / entryP) * 100 : 0;
                const riskBudget = (cap * riskPct) / 100;
                const rawSharesByRisk = entryP > stopP ? riskBudget / riskPerShare : 0;
                const maxSharesByCap = (cap * (maxSingle / 100)) / Math.max(0.01, entryP);
                const finalRaw = Math.min(rawSharesByRisk, maxSharesByCap);
                const lot = analysis.target.marketKind === 'CN' ? 100 : 1;
                const shares = Math.floor(finalRaw / lot) * lot;
                const positionAmt = shares * entryP;
                const positionPct = (positionAmt / cap) * 100;
                const clampedBySingle = rawSharesByRisk > maxSharesByCap;
                const rRatio = entryP > stopP && targetP > entryP ? (targetP - entryP) / (entryP - stopP) : null;

                return (
                  <div
                    style={{
                      padding: '11px 14px',
                      borderRadius: 10,
                      background: 'var(--bg-soft)',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 9,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <strong style={{ fontSize: 13 }}>
                        R 倍数风控仓位计算器（以损定仓 + 单股红线钳制 · 现价 {currSym}{entryP.toFixed(2)}）
                      </strong>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 11.5 }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '2px 7px', fontSize: 11 }}
                          onClick={() => analysis.levels.supports[0] && setCalcStopOverride(String(analysis.levels.supports[0].price))}
                        >
                          用 S1 ({currSym}{analysis.levels.supports[0]?.price ?? '-'})
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '2px 7px', fontSize: 11 }}
                          onClick={() => analysis.levels.turtleStop2N && setCalcStopOverride(String(analysis.levels.turtleStop2N))}
                        >
                          用海龟 2N ({currSym}{analysis.levels.turtleStop2N ?? '-'})
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
                      <div>
                        <label className="field-label" style={{ fontSize: 11 }}>账户总资金</label>
                        <input className="input mono" style={{ padding: '4px 8px', fontSize: 12 }} type="number" value={calcCapital} onChange={(e) => setCalcCapital(e.target.value)} />
                      </div>
                      <div>
                        <label className="field-label" style={{ fontSize: 11 }}>单笔最大风险 (%)</label>
                        <input className="input mono" style={{ padding: '4px 8px', fontSize: 12 }} type="number" step="0.1" value={calcRiskPct} onChange={(e) => setCalcRiskPct(e.target.value)} />
                      </div>
                      <div>
                        <label className="field-label" style={{ fontSize: 11 }}>单股仓位红线 (%)</label>
                        <input className="input mono" style={{ padding: '4px 8px', fontSize: 12 }} type="number" value={calcMaxSinglePct} onChange={(e) => setCalcMaxSinglePct(e.target.value)} />
                      </div>
                      <div>
                        <label className="field-label" style={{ fontSize: 11 }}>硬止损价（默认S1/2N）</label>
                        <input className="input mono" style={{ padding: '4px 8px', fontSize: 12 }} type="number" step="0.01" placeholder={String(defaultStop)} value={calcStopOverride} onChange={(e) => setCalcStopOverride(e.target.value)} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, padding: '7px 10px', borderRadius: 7, background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
                      <span>
                        建议可买：<strong className="mono" style={{ color: 'var(--navy)', fontSize: 14 }}>{shares.toLocaleString()} 股</strong>
                        {analysis.target.marketKind === 'CN' ? ' (整手)' : ''}
                      </span>
                      <span>
                        投入金额：<strong className="mono">{currSym}{Math.round(positionAmt).toLocaleString()}</strong> ({positionPct.toFixed(1)}%仓位
                        {clampedBySingle ? ' · 已触发单股红线钳制!' : ''})
                      </span>
                      <span>
                        止损空间：<strong className="mono" style={{ color: '#16a34a' }}>-{stopDistPct.toFixed(2)}%</strong>（1R 预算 {currSym}{Math.round(riskBudget).toLocaleString()}）
                      </span>
                      <span>
                        至 R1({currSym}{targetP.toFixed(2)}) 盈亏比：<strong className="mono" style={{ color: (rRatio || 0) >= 2 ? '#dc2626' : 'var(--amber)' }}>{rRatio != null ? `${rRatio.toFixed(2)} : 1` : '--'}</strong>
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* 三大权威趋势线流派诊断（维克多 1-2-3 · 德马克 TD 线 · 线性回归 ±2σ 通道） */}
              {analysis.trendlines && (
                <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-soft)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span>趋势线流派客观划线与形态诊断</span>
                      <span className="badge badge-navy">{analysis.trendlines.patternLabel}</span>
                    </div>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      三大零主观划线体系（当前周期：{analysis.timeframe} · 已接入实时突破/破位预警）
                    </span>
                  </div>

                  <div className="grid-3" style={{ gap: 10 }}>
                    {/* 流派 1：维克多·斯波朗迪 1-2-3 */}
                    <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderTop: '3px solid #e11d48', fontSize: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <strong style={{ color: '#e11d48' }}>① 维克多严格趋势线 (1-2-3)</strong>
                        <button type="button" className="ref-chip ref-chip-method" style={{ fontSize: 10.5 }} onClick={() => onOpenEntity({ kind: 'methodology', id: '061' })}>
                          卡片061
                        </button>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 7 }}>
                        理论依据：严格连接极值与反转前最近拐点，数学保证不穿透区间内任何一根 K 线。
                      </div>
                      {analysis.trendlines.victor.downLine && (
                        <div style={{ marginBottom: 5 }}>
                          <span className="badge badge-crimson" style={{ fontSize: 10, padding: '0 4px', marginRight: 5 }}>下降压制</span>
                          <strong className="mono">{currSym}{analysis.trendlines.victor.downLine.currentPrice}</strong>
                          <span className="mono" style={{ marginLeft: 5, color: 'var(--text-secondary)', fontSize: 11 }}>
                            ({analysis.trendlines.victor.downLine.status})
                          </span>
                          <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                            锚点 {analysis.trendlines.victor.downLine.date1.slice(0, 10)} → {analysis.trendlines.victor.downLine.date2.slice(0, 10)}
                          </div>
                        </div>
                      )}
                      {analysis.trendlines.victor.upLine && (
                        <div>
                          <span className="badge badge-emerald" style={{ fontSize: 10, padding: '0 4px', marginRight: 5 }}>上升支撑</span>
                          <strong className="mono">{currSym}{analysis.trendlines.victor.upLine.currentPrice}</strong>
                          <span className="mono" style={{ marginLeft: 5, color: analysis.trendlines.victor.upLine.broken ? 'var(--crimson)' : 'var(--text-secondary)', fontSize: 11 }}>
                            ({analysis.trendlines.victor.upLine.status})
                          </span>
                          <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                            锚点 {analysis.trendlines.victor.upLine.date1.slice(0, 10)} → {analysis.trendlines.victor.upLine.date2.slice(0, 10)}
                          </div>
                        </div>
                      )}
                      {!analysis.trendlines.victor.downLine && !analysis.trendlines.victor.upLine && (
                        <div style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>当前区间暂未形成有效维克多单边切线</div>
                      )}
                    </div>

                    {/* 流派 2：汤姆·德马克 TD 供给/需求线 */}
                    <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderTop: '3px solid #d97706', fontSize: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <strong style={{ color: '#b45309' }}>② 德马克 TD 供给/需求线</strong>
                        <button type="button" className="ref-chip ref-chip-method" style={{ fontSize: 10.5 }} onClick={() => onOpenEntity({ kind: 'methodology', id: '052' })}>
                          卡片052
                        </button>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 7 }}>
                        理论依据：由右向左锁定最近两个分形极值，彻底消除画线主观性并测算突破目标位。
                      </div>
                      {analysis.trendlines.demark.supplyLine && (
                        <div style={{ marginBottom: 5 }}>
                          <span className="badge badge-amber" style={{ fontSize: 10, padding: '0 4px', marginRight: 5 }}>TD 供给线</span>
                          <strong className="mono">{currSym}{analysis.trendlines.demark.supplyLine.currentPrice}</strong>
                          <span style={{ marginLeft: 5, fontSize: 11, color: 'var(--text-secondary)' }}>
                            ({analysis.trendlines.demark.supplyLine.status})
                          </span>
                          {analysis.trendlines.demark.supplyLine.targetPrice && (
                            <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                              突破测算目标 ≈ {currSym}{analysis.trendlines.demark.supplyLine.targetPrice}
                            </div>
                          )}
                        </div>
                      )}
                      {(analysis.trendlines.demark.demandLine || analysis.trendlines.demark.lowerChannel) && (() => {
                        const seg = (analysis.trendlines.demark.demandLine || analysis.trendlines.demark.lowerChannel)!;
                        return (
                          <div>
                            <span className="badge badge-teal" style={{ fontSize: 10, padding: '0 4px', marginRight: 5 }}>
                              {analysis.trendlines.demark.demandLine ? 'TD 需求线' : '下行下轨'}
                            </span>
                            <strong className="mono">{currSym}{seg.currentPrice}</strong>
                            <span style={{ marginLeft: 5, fontSize: 11, color: seg.broken ? 'var(--crimson)' : 'var(--text-secondary)' }}>
                              ({seg.status})
                            </span>
                            <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                              锚点 {seg.date1.slice(0, 10)} → {seg.date2.slice(0, 10)}
                            </div>
                          </div>
                        );
                      })()}
                      {!analysis.trendlines.demark.supplyLine && !analysis.trendlines.demark.demandLine && !analysis.trendlines.demark.lowerChannel && (
                        <div style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>当前区间暂无满足斜率条件的 TD 线</div>
                      )}
                    </div>

                    {/* 流派 3：线性回归标准差通道 (±2σ) */}
                    <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderTop: '3px solid #4f46e5', fontSize: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <strong style={{ color: '#4f46e5' }}>③ 线性回归标准差通道 (±2σ)</strong>
                        <button type="button" className="ref-chip ref-chip-method" style={{ fontSize: 10.5 }} onClick={() => onOpenEntity({ kind: 'methodology', id: '065' })}>
                          卡片065
                        </button>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 7 }}>
                        理论依据：最小二乘法客观拟合趋势中轴 + ±2σ 平行上下轨，量化通道超买/超卖极值。
                      </div>
                      {analysis.trendlines.regressionChannel && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
                            <span>上轨 <strong style={{ color: '#dc2626' }}>{currSym}{analysis.trendlines.regressionChannel.endUpper}</strong></span>
                            <span>中轴 <strong>{currSym}{analysis.trendlines.regressionChannel.endMid}</strong></span>
                            <span>下轨 <strong style={{ color: '#16a34a' }}>{currSym}{analysis.trendlines.regressionChannel.endLower}</strong></span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-secondary)' }}>
                            <span>趋势线性度 R² = <strong className="mono">{analysis.trendlines.regressionChannel.rSquared}</strong></span>
                            <span style={{ fontWeight: 700, color: analysis.trendlines.regressionChannel.posPct >= 90 ? 'var(--crimson)' : analysis.trendlines.regressionChannel.posPct <= 10 ? 'var(--teal)' : 'var(--navy)' }}>
                              位置 {analysis.trendlines.regressionChannel.posPct}% ({analysis.trendlines.regressionChannel.zoneLabel.split(' ')[0]})
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* 支撑压力位分级清单（左：上方压力 R1-R4，右：下方支撑 S1-S4） */}
              <div className="grid-2" style={{ gap: 12 }}>
                <div style={{ padding: '12px 14px', borderRadius: 9, background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#dc2626', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <TrendingUp size={14} /> 上方压力位梯队（由近及远）
                  </div>
                  {analysis.levels.resistances.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>当前已突破近 60 日全部历史套牢压制区（无近端压力）</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {analysis.levels.resistances.map((lv) => (
                        <div
                          key={lv.code}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 7,
                            background: 'var(--bg-elev)',
                            border: '1px solid var(--border)',
                            borderLeft: `3px solid ${lv.strength === '强共振' ? '#dc2626' : '#f87171'}`,
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                              <span className="badge badge-crimson mono">{lv.code}</span>
                              <strong className="mono num" style={{ fontSize: 14.5 }}>{currSym}{lv.price.toFixed(2)}</strong>
                              <span className="mono" style={{ fontSize: 12, color: '#dc2626' }}>+{lv.distPct}%</span>
                            </div>
                            <span className={`badge ${lv.strength === '强共振' ? 'badge-crimson' : lv.strength === '中级' ? 'badge-amber' : 'badge-muted'}`} style={{ fontSize: 10.5 }}>
                              {lv.strength}{lv.resonanceCount >= 2 ? ` (${lv.resonanceCount}派)` : ''}
                            </span>
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4, display: 'flex', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span>{lv.labels.join(' + ')}</span>
                            <span style={{ display: 'inline-flex', gap: 3 }}>
                              {lv.cardIds.map((cid) => (
                                <button key={cid} type="button" className="ref-chip ref-chip-method" style={{ fontSize: 10.5 }} onClick={() => onOpenEntity({ kind: 'methodology', id: cid })}>
                                  卡{cid}
                                </button>
                              ))}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ padding: '12px 14px', borderRadius: 9, background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#16a34a', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <TrendingDown size={14} /> 下方支撑与防守梯队（由近及远）
                  </div>
                  {analysis.levels.supports.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>当前处于近 60 日低位区，下方缺少历史筹码支撑</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {analysis.levels.supports.map((lv) => (
                        <div
                          key={lv.code}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 7,
                            background: 'var(--bg-elev)',
                            border: '1px solid var(--border)',
                            borderLeft: `3px solid ${lv.strength === '强共振' ? '#16a34a' : '#4ade80'}`,
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                              <span className="badge badge-emerald mono">{lv.code}</span>
                              <strong className="mono num" style={{ fontSize: 14.5 }}>{currSym}{lv.price.toFixed(2)}</strong>
                              <span className="mono" style={{ fontSize: 12, color: '#16a34a' }}>{lv.distPct}%</span>
                            </div>
                            <span className={`badge ${lv.strength === '强共振' ? 'badge-emerald' : lv.strength === '中级' ? 'badge-teal' : 'badge-muted'}`} style={{ fontSize: 10.5 }}>
                              {lv.strength}{lv.resonanceCount >= 2 ? ` (${lv.resonanceCount}派)` : ''}
                            </span>
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4, display: 'flex', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span>{lv.labels.join(' + ')}</span>
                            <span style={{ display: 'inline-flex', gap: 3 }}>
                              {lv.cardIds.map((cid) => (
                                <button key={cid} type="button" className="ref-chip ref-chip-method" style={{ fontSize: 10.5 }} onClick={() => onOpenEntity({ kind: 'methodology', id: cid })}>
                                  卡{cid}
                                </button>
                              ))}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* ===================================================================== */}
      {/* 视图二：预警规则管理（从方法论卡片提取 + 手动自定义录入 + 现行规则总表） */}
      {/* ===================================================================== */}
      <div className="scroll-page" style={{ display: subView === 'rules' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}>
        <div className="grid-2" style={{ gap: 14, alignItems: 'start' }}>
          {/* 左卡：从《方法论卡片库》一键提取预警规则 */}
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 7 }}>
                <BookOpen size={16} color="var(--navy)" />
                从《方法论卡片库》一键提取见顶预警指标
              </div>
              <AiProviderPicker
                value={selectedProvider}
                config={aiConfig}
                onChange={setSelectedProvider}
                onOpenSettings={onOpenAiSettings}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Search size={13} color="var(--text-muted)" style={{ position: 'absolute', left: 9, top: 10 }} />
                <input
                  className="input"
                  style={{ paddingLeft: 28, fontSize: 12.5 }}
                  placeholder="搜卡号或关键词（如 054 / 055 / 061 / 178 / 196 / 顶背离）"
                  value={cardSearch}
                  onChange={(e) => setCardSearch(e.target.value)}
                />
              </div>
              <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={onlyTechCards} onChange={(e) => setOnlyTechCards(e.target.checked)} />
                仅看技术/情绪/见顶相关卡 ({filteredMethodCards.length})
              </label>
            </div>

            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {filteredMethodCards.slice(0, 60).map((c) => {
                const checked = selectedCardIds.includes(c.id);
                return (
                  <label
                    key={c.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 7,
                      padding: '5px 7px',
                      borderRadius: 6,
                      background: checked ? 'var(--navy-soft)' : 'transparent',
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedCardIds((prev) =>
                          prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]
                        )
                      }
                      style={{ marginTop: 3 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span className="badge badge-navy mono" style={{ padding: '0 4px', fontSize: 10.5 }}>{c.id}</span>
                        <strong style={{ fontSize: 12 }}>{c.title}</strong>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.coreThesis}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={extractingCards || selectedCardIds.length === 0}
                onClick={() => handleExtractFromCards(false)}
              >
                {extractingCards ? <Loader2 size={13} className="spin" /> : <Flame size={13} />}
                规则引擎秒提（已选 {selectedCardIds.length} 张）
              </button>
              <button
                type="button"
                className="btn btn-amber btn-sm"
                disabled={extractingCards || selectedCardIds.length === 0}
                onClick={() => handleExtractFromCards(true)}
              >
                {extractingCards ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                AI 深度提炼规则
              </button>
              {selectedCardIds.length > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedCardIds([])}>
                  清空勾选
                </button>
              )}
            </div>

            {/* 提炼出的候选规则确认区 */}
            {extractedCandidates.length > 0 && (
              <div style={{ padding: 10, borderRadius: 8, background: 'var(--emerald-soft)', border: '1px solid color-mix(in srgb, var(--emerald) 30%, transparent)', display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: 12.5, color: 'var(--emerald)' }}>
                    已提取 {extractedCandidates.length} 条候选预警规则：
                  </strong>
                  <button type="button" className="btn btn-teal btn-sm" disabled={savingRules} onClick={() => handleAcceptExtracted(extractedCandidates)}>
                    <Plus size={12} /> 全部加入实时雷达
                  </button>
                </div>
                {extractedCandidates.map((cand) => (
                  <div
                    key={cand.id}
                    style={{
                      padding: '6px 9px',
                      borderRadius: 6,
                      background: 'var(--bg-elev)',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 12,
                    }}
                  >
                    <div>
                      <strong>{cand.name}</strong>{' '}
                      <span className="mono" style={{ color: 'var(--navy)' }}>
                        [{metricLabel(cand.metric)} {cand.operator} {cand.threshold}]
                      </span>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{cand.actionAdvice}</div>
                    </div>
                    <button type="button" className="btn btn-sm" disabled={savingRules} onClick={() => handleAcceptExtracted([cand])}>
                      <Plus size={11} /> 加入
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 右卡：手动自定义录入预警指标 */}
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 7 }}>
              <Plus size={16} color="var(--teal)" />
              手动录入自定义情绪/股价高点预警指标
            </div>

            <div className="grid-2" style={{ gap: 9 }}>
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">监控范围</label>
                <select
                  className="select"
                  value={newRule.scope}
                  onChange={(e) => {
                    const nextScope = e.target.value as 'market_sentiment' | 'stock_peak';
                    const firstM = metricCatalog.find((m) => m.scope === nextScope)?.key || '';
                    setNewRule((p) => ({ ...p, scope: nextScope, metric: firstM }));
                  }}
                >
                  <option value="stock_peak">个股阶段性股价高点 / 破位</option>
                  <option value="market_sentiment">全市场阶段性情绪高点 / 冰点</option>
                </select>
              </div>

              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">警报级别</label>
                <select
                  className="select"
                  value={newRule.severity}
                  onChange={(e) => setNewRule((p) => ({ ...p, severity: e.target.value as 'high' | 'medium' | 'info' }))}
                >
                  <option value="high">高危见顶 / 破位（红警）</option>
                  <option value="medium">中度警戒（橙警）</option>
                  <option value="info">观察提示（青色）</option>
                </select>
              </div>
            </div>

            <div className="field-group" style={{ marginBottom: 0 }}>
              <label className="field-label">预警指标名称（留空自动生成）</label>
              <input
                className="input"
                placeholder="例：算力大票短线 MA5 乖离 >= 10% 止盈警报"
                value={newRule.name}
                onChange={(e) => setNewRule((p) => ({ ...p, name: e.target.value }))}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 80px 100px', gap: 8 }}>
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">量化指标</label>
                <select
                  className="select"
                  value={newRule.metric}
                  onChange={(e) => setNewRule((p) => ({ ...p, metric: e.target.value }))}
                >
                  {scopeMetrics.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">条件</label>
                <select
                  className="select mono"
                  value={newRule.operator}
                  onChange={(e) => setNewRule((p) => ({ ...p, operator: e.target.value as any }))}
                >
                  <option value=">=">&gt;=</option>
                  <option value="<=">&lt;=</option>
                  <option value=">">&gt;</option>
                  <option value="<">&lt;</option>
                  <option value="==">==</option>
                </select>
              </div>
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">阈值</label>
                <input
                  className="input mono"
                  type="number"
                  step="any"
                  value={newRule.threshold}
                  onChange={(e) => setNewRule((p) => ({ ...p, threshold: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid-2" style={{ gap: 8 }}>
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">关联方法论卡号（可选，3位）</label>
                <input
                  className="input mono"
                  placeholder="如：054 / 067 / 178"
                  value={newRule.sourceCardId}
                  onChange={(e) => setNewRule((p) => ({ ...p, sourceCardId: e.target.value }))}
                />
              </div>
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">触发后操作纪律</label>
                <input
                  className="input"
                  placeholder="例：减仓50%，不追高，等回踩5日线"
                  value={newRule.actionAdvice}
                  onChange={(e) => setNewRule((p) => ({ ...p, actionAdvice: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              <button type="button" className="btn btn-teal" disabled={savingRules} onClick={handleAddCustomRule}>
                <Plus size={14} /> 保存并立即投入实时预警
              </button>
            </div>
          </div>
        </div>

        {/* P0-2：交易所重点监管 / 严重异动名单红线管理（落地待定建议② 卡片174） */}
        <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <strong style={{ fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <ShieldAlert size={16} color="var(--crimson)" />
              交易所重点监管 / 严重异动红线名单（卡片 174 监管高度天花板变量）
            </strong>
            <button type="button" className="ref-chip ref-chip-method" onClick={() => onOpenEntity({ kind: 'methodology', id: '174' })}>
              查看卡片174
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            录入沪深北交易所公告的严重异动/重点监控标的；命中名单后，标的 AI 联网研判的对账门禁与驾驶舱盘前预检将强制发出禁追高红警。
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '140px 160px 1fr auto', gap: 8 }}>
            <input className="input mono" placeholder="代码如 300XXX" value={newRegCode} onChange={(e) => setNewRegCode(e.target.value)} />
            <input className="input" placeholder="标的简称" value={newRegName} onChange={(e) => setNewRegName(e.target.value)} />
            <input className="input" placeholder="异动/重点监控原因" value={newRegReason} onChange={(e) => setNewRegReason(e.target.value)} />
            <button type="button" className="btn btn-primary btn-sm" disabled={savingReg} onClick={handleAddRegulatoryItem}>
              <Plus size={13} /> 加入监管红线
            </button>
          </div>
          {regItems.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {regItems.map((item) => (
                <div
                  key={item.id}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 7,
                    background: 'var(--crimson-soft)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 12,
                  }}
                >
                  <div>
                    <span className="badge badge-crimson" style={{ marginRight: 6, fontSize: 10 }}>禁追红线</span>
                    <strong className="mono">{item.code}</strong> <strong>{item.name}</strong> — {item.reason}{' '}
                    <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 11 }}>({item.startDate})</span>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleRemoveRegulatoryItem(item.id)}>
                    <Trash2 size={12} color="var(--crimson)" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 现行全部预警规则清单 */}
        <div className="panel panel-pad">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <strong style={{ fontSize: 14.5 }}>现行实时预警规则总表（共 {rules.length} 条 · 修改阈值后点保存即可生效）</strong>
            <div style={{ display: 'flex', gap: 7 }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={savingRules}
                onClick={() => persistRulesAndRescan(rules, '已保存全部阈值修改并重新扫描')}
              >
                保存阈值修改
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={savingRules} onClick={handleResetDefaultRules}>
                <RotateCcw size={13} /> 恢复默认规则
              </button>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: 'var(--bg-soft)', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'center', padding: '8px', width: 52 }}>启用</th>
                  <th style={{ textAlign: 'left', padding: '8px' }}>范围 / 级别</th>
                  <th style={{ textAlign: 'left', padding: '8px' }}>规则名称与操作纪律</th>
                  <th style={{ textAlign: 'left', padding: '8px' }}>指标条件与阈值</th>
                  <th style={{ textAlign: 'left', padding: '8px' }}>来源方法论卡</th>
                  <th style={{ textAlign: 'right', padding: '8px' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border)', opacity: r.enabled ? 1 : 0.52 }}>
                    <td style={{ textAlign: 'center', padding: '8px' }}>
                      <input type="checkbox" checked={r.enabled} onChange={() => handleToggleRule(r.id)} />
                    </td>
                    <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                        <span className={`badge ${r.scope === 'market_sentiment' ? 'badge-violet' : 'badge-navy'}`} style={{ fontSize: 10 }}>
                          {r.scope === 'market_sentiment' ? '市场情绪' : '个股高点'}
                        </span>
                        {severityBadge(r.severity)}
                      </div>
                    </td>
                    <td style={{ padding: '8px' }}>
                      <div style={{ fontWeight: 700 }}>{r.name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{r.actionAdvice}</div>
                    </td>
                    <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 12 }}>{metricLabel(r.metric)}</span>
                        <span className="mono" style={{ fontWeight: 700 }}>{r.operator}</span>
                        <input
                          className="input mono"
                          type="number"
                          step="any"
                          style={{ width: 72, padding: '3px 6px', fontSize: 12 }}
                          value={r.threshold}
                          onChange={(e) => handleThresholdChange(r.id, e.target.value)}
                        />
                      </div>
                    </td>
                    <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                      {r.sourceCardId ? (
                        <button type="button" className="ref-chip ref-chip-method" onClick={() => onOpenEntity({ kind: 'methodology', id: r.sourceCardId })}>
                          卡片{r.sourceCardId}
                        </button>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>自定义</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', padding: '8px' }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleDeleteRule(r.id)} title="删除该规则">
                        <Trash2 size={13} color="var(--text-muted)" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <TradePlanCardModal
        open={showPlanCard}
        seed={
          analysis
            ? {
                code: analysis.target.code || analysis.target.secuCode,
                name: analysis.target.name,
                entryPrice: analysis.indicators.price ? Number(analysis.indicators.price.toFixed(2)) : '',
                stopLossPrice:
                  calcStopOverride ||
                  (analysis.levels.turtleStop2N && analysis.levels.turtleStop2N < analysis.indicators.price
                    ? Number(analysis.levels.turtleStop2N.toFixed(2))
                    : analysis.levels.supports?.[0]?.price && analysis.levels.supports[0].price < analysis.indicators.price
                    ? Number(analysis.levels.supports[0].price.toFixed(2))
                    : Number((analysis.indicators.price * 0.95).toFixed(2))),
                targetPrice: analysis.levels.resistances?.[0]?.price
                  ? Number(analysis.levels.resistances[0].price.toFixed(2))
                  : '',
                accountCapital: Number(calcCapital) || 500000,
                maxSinglePct: Number(calcMaxSinglePct) || 25,
                note: `参考技术位：${analysis.indicators.trendRegime}，R1=${analysis.levels.resistances?.[0]?.price ?? '--'} / S1=${analysis.levels.supports?.[0]?.price ?? '--'}`,
              }
            : null
        }
        onClose={() => setShowPlanCard(false)}
        onToast={onToast}
      />
    </div>
  );
};
