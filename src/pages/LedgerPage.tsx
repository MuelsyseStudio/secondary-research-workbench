import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Calendar,
  CalendarRange,
  CheckCircle2,
  ClipboardCheck,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  FilePlus2,
  FileSpreadsheet,
  Flame,
  FolderDown,
  History,
  LayoutGrid,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type {
  AiSafeConfig,
  BackgroundJobSummary,
  DailyReviewEntry,
  EntityRef,
  EvidenceCheckResult,
  EvidenceFact,
  EvidenceRecord,
  JudgmentEntry,
  MarketPacket,
  QuickDraftNotePayload,
  WorkspaceData,
} from '../types';
import { CardLinkText } from '../components/CardLinkText';
import { MarkdownBlock } from '../components/MarkdownBlock';
import { AutoDailyReviewPanel } from '../components/AutoDailyReviewPanel';
import { AiJudgmentPanel } from '../components/AiJudgmentPanel';
import { JudgmentTrackerPanel } from '../components/JudgmentTrackerPanel';
import { PeriodicReviewPanel } from '../components/PeriodicReviewPanel';

interface LedgerPageProps {
  workspace: WorkspaceData;
  aiConfig: AiSafeConfig | null;
  theme: 'light' | 'dark';
  recentDailyJob?: BackgroundJobSummary | null;
  recentJudgmentJob?: BackgroundJobSummary | null;
  onJobStarted?: (job: BackgroundJobSummary) => void;
  onJobFinished?: () => void;
  initialDailyId?: string | null;
  initialJudgmentId?: string | null;
  initialMode?: 'createDaily' | 'createJudgment' | null;
  initialJudgeQuery?: string | null;
  initialDraftNote?: QuickDraftNotePayload | null;
  onDraftNoteAccepted?: (noteId: string, target: 'cognition' | 'method' | 'judgment') => void;
  onConsumeInitial?: () => void;
  onOpenEntity: (ref: EntityRef) => void;
  onPreviewEntity?: (ref: EntityRef) => void;
  onOpenTechnical?: (secidOrQuery: string) => void;
  onOpenAiSettings: () => void;
  onRequestMutation: (action: string, payload: Record<string, unknown>, onSuccess?: () => void) => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const LedgerPage: React.FC<LedgerPageProps> = ({
  workspace,
  aiConfig,
  theme,
  recentDailyJob,
  recentJudgmentJob,
  onJobStarted,
  onJobFinished,
  initialDailyId,
  initialJudgmentId,
  initialMode,
  initialJudgeQuery,
  initialDraftNote,
  onDraftNoteAccepted,
  onConsumeInitial,
  onOpenEntity,
  onPreviewEntity,
  onOpenTechnical,
  onOpenAiSettings,
  onRequestMutation,
  onToast,
}) => {
  const { t } = useI18n();
  const { ledger, highFreqCards, evidenceFiles } = workspace;

  const [subView, setSubView] = useState<'daily' | 'judgments' | 'tracker' | 'periodic' | 'createDaily' | 'createJudgment'>('daily');
  const [dailyViewMode, setDailyViewMode] = useState<'visual' | 'structured'>('visual');
  const [savingHtml, setSavingHtml] = useState(false);
  const [draftHtmlPreview, setDraftHtmlPreview] = useState<{ html: string; fileName: string } | null>(null);
  const [renderingDraftHtml, setRenderingDraftHtml] = useState(false);
  const [search, setSearch] = useState('');
  const [targetFilterKey, setTargetFilterKey] = useState<string>('ALL');
  const [selectedDailyId, setSelectedDailyId] = useState<string>(ledger.dailyReviews[0]?.id || '');
  const [selectedJudgeId, setSelectedJudgeId] = useState<string>(
    ledger.judgments[ledger.judgments.length - 1]?.id || ledger.judgments[0]?.id || ''
  );
  const judgeDetailRef = useRef<HTMLDivElement>(null);
  const [activeSubSecIdx, setActiveSubSecIdx] = useState<number>(-1); // -1 = 全部展开
  const [liveMarketPacket, setLiveMarketPacket] = useState<MarketPacket | null>(null);

  // 统一复盘：短线盘面情绪 + 主线题材趋势一键同步快照
  const [loadingStSnap, setLoadingStSnap] = useState(false);
  const [stSnapshot, setStSnapshot] = useState<{
    fetchedAt: string;
    sentimentScore: number | null;
    stage: string;
    yestZtPremiumPct: number | null;
    yestLianbanPremiumPct: number | null;
    sealRatePct: number | null;
    ztCount: number | null;
    dtCount: number | null;
    zbCount: number | null;
    lianbanCount: number | null;
    maxBoard: number | null;
    topThemes: { name: string; pct: number | null; mainNetYi: number | null; leaderName?: string }[];
    topLadder: { board: number; count: number; promotionRatePct?: number | null; names: string[] }[];
  } | null>(null);
  const [aiNotesAppend, setAiNotesAppend] = useState<{ text: string; nonce: number } | null>(null);

  const buildStSnapshotText = (snap: NonNullable<typeof stSnapshot>) => {
    const fmtP = (v: number | null | undefined) => (v == null ? '--' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
    const themesLine = snap.topThemes
      .map((th) => `${th.name}(${fmtP(th.pct)}${th.mainNetYi != null ? `/主力${th.mainNetYi > 0 ? '+' : ''}${Number(th.mainNetYi).toFixed(1)}亿` : ''}${th.leaderName ? `/领涨:${th.leaderName}` : ''})`)
      .join('；');
    const ladderLine = snap.topLadder
      .map((lv) => `${lv.board}板(${lv.count}家${lv.promotionRatePct != null ? `/晋级${lv.promotionRatePct}%` : ''}): ${lv.names.join('、')}`)
      .join(' | ');
    return [
      `情绪温度：${snap.sentimentScore ?? '--'}分（${snap.stage}）｜涨停 ${snap.ztCount ?? '--'} / 跌停 ${snap.dtCount ?? '--'} / 炸板 ${snap.zbCount ?? '--'}｜封板率 ${snap.sealRatePct ?? '--'}%｜连板 ${snap.lianbanCount ?? '--'} 家（最高 ${snap.maxBoard ?? '--'} 板）`,
      `接力溢价：昨涨停溢价 ${fmtP(snap.yestZtPremiumPct)}｜昨连板溢价 ${fmtP(snap.yestLianbanPremiumPct)}`,
      `领涨主线题材 TOP5：${themesLine || '暂无'}`,
      `连板梯队核心：${ladderLine || '暂无'}`,
    ].join('\n');
  };

  const handleSyncShortTermSnapshot = async () => {
    setLoadingStSnap(true);
    try {
      const [dash, lad] = await Promise.all([
        api.getShortTermDashboard(),
        api.getShortTermLadder().catch(() => null),
      ]);
      const temp = dash?.temperature || {};
      const sum = lad?.summary || {};
      const topThemes = ((dash?.concepts || []).length ? dash.concepts : dash?.industries || [])
        .slice(0, 5)
        .map((c: any) => ({
          name: c.name,
          pct: c.pct ?? null,
          mainNetYi: c.mainNetYi ?? null,
          leaderName: c.leaderName || '',
        }));
      const topLadder = (lad?.levels || [])
        .filter((lv: any) => lv.board >= 2)
        .slice(0, 4)
        .map((lv: any) => ({
          board: lv.board,
          count: lv.count,
          promotionRatePct: lv.promotionRatePct ?? null,
          names: (lv.stocks || []).slice(0, 4).map((s: any) => `${s.name}${s.industry ? `(${s.industry})` : ''}`),
        }));
      const snap = {
        fetchedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        sentimentScore: temp.sentimentScore ?? null,
        stage: temp.node?.node || temp.stage || '常态震荡',
        yestZtPremiumPct: temp.yestZtPremiumPct ?? null,
        yestLianbanPremiumPct: temp.yestLianbanPremiumPct ?? null,
        sealRatePct: sum.sealRatePct ?? temp.sealRatePct ?? null,
        ztCount: sum.ztCount ?? temp.ztCount ?? null,
        dtCount: sum.dtCount ?? temp.dtCount ?? null,
        zbCount: sum.zbCount ?? temp.zbCount ?? null,
        lianbanCount: sum.lianbanCount ?? temp.lianbanCount ?? null,
        maxBoard: sum.maxBoard ?? temp.maxBoard ?? null,
        topThemes,
        topLadder,
      };
      setStSnapshot(snap);
      onToast(`已同步今日短线盘面温度(${snap.sentimentScore ?? '--'}分)与 ${topThemes.length} 条领涨主线题材`);
    } catch (err: any) {
      onToast(`同步短线盘面快照失败：${err.message}`);
    } finally {
      setLoadingStSnap(false);
    }
  };

  const handleFillShortTermIntoForm = () => {
    if (!stSnapshot) return;
    const summaryText = buildStSnapshotText(stSnapshot);
    const themeTemplate = stSnapshot.topThemes
      .slice(0, 4)
      .map((th, i) => `${i + 1}. 【${th.name}】盘面强度：${th.pct != null ? `${th.pct > 0 ? '+' : ''}${th.pct.toFixed(2)}%` : '--'}｜领涨/核心：${th.leaderName || '待填'}｜产业趋势与认知库逻辑映射：（待补充景气度/催化持续性）`)
      .join('\n');
    const ladderBrief = stSnapshot.topLadder
      .map((lv) => `${lv.board}板(${lv.count}家)：${lv.names.join('、')}`)
      .join('；');

    setDailyForm((prev) => ({
      ...prev,
      marketFacts: prev.marketFacts.includes('情绪温度：')
        ? prev.marketFacts
        : [prev.marketFacts.trim(), `【短线情绪与涨跌停快照 ${stSnapshot.fetchedAt}】\n${summaryText}`].filter(Boolean).join('\n\n'),
      dualLineSplit: prev.dualLineSplit.includes('【主线题材趋势与产业逻辑】')
        ? prev.dualLineSplit
        : [
            prev.dualLineSplit.trim(),
            `【投机连板梯队】最高 ${stSnapshot.maxBoard ?? '--'} 板（连板 ${stSnapshot.lianbanCount ?? '--'} 家）；${ladderBrief || '暂无高标连板'}`,
            `【主线题材趋势与产业逻辑】\n${themeTemplate}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
      marketState:
        prev.marketState === '投机=；趋势成长=；防御='
          ? `投机=${stSnapshot.stage}(温度${stSnapshot.sentimentScore ?? '--'})；趋势成长=主线聚焦${stSnapshot.topThemes.slice(0, 2).map((x) => x.name).join('/')}；防御=待定`
          : prev.marketState,
    }));
    onToast('已将短线情绪、连板梯队与主线题材产业逻辑模板填入下方复盘表单（未覆盖已有内容）');
  };

  const handleInjectShortTermIntoAi = () => {
    if (!stSnapshot) return;
    setAiNotesAppend({ text: buildStSnapshotText(stSnapshot), nonce: Date.now() });
    onToast('已注入 AI 复盘附加材料，执行 AI 复盘时将自动融合短线盘面与题材产业逻辑');
  };

  // -------------------------------------------------------------------------
  // 新建每日复盘表单 + 证据核验状态
  // -------------------------------------------------------------------------
  const latestDaily = ledger.dailyReviews[0];
  const [dailyForm, setDailyForm] = useState(() => ({
    date: todayISO(),
    headline: '',
    dataSource: '日K与分钟行情 / 涨跌停统计与用户补充材料',
    evidenceCutoff: `${todayISO()}T18:00:00+08:00`,
    macroNotes: '',
    marketFacts: '',
    intradayStructure: '',
    dualLineSplit: '',
    methodFailure: '无',
    applicationError: '无新增',
    behavioralReview: '',
    score: '5.5',
    scoreReason: '',
    marketState: '投机=；趋势成长=；防御=',
    nextAnchors: '① \n② \n③ ',
    gaps: '无新增数据缺口',
    syncMethodology: true,
    anchorChecks: (latestDaily?.nextAnchors || []).map((a) => ({
      anchor: a.slice(0, 36),
      preset: a,
      evidence: '',
      verdict: '成立',
    })),
    credibilityAdjustments: [] as { cardId: string; delta: number; reason: string }[],
  }));

  // 证据核验器状态（直接对接 日度复盘工作台_2026-11-23）
  const [evidenceRecord, setEvidenceRecord] = useState<EvidenceRecord>({
    review_date: todayISO(),
    mode: 'daily',
    cutoff: `${todayISO()}T18:00:00+08:00`,
    facts: [
      {
        id: 'E01',
        metric: '两市成交额',
        date: todayISO(),
        kind: 'same_day',
        state: 'observed',
        value: 16500,
        unit: '亿元',
        scope: '沪深两市全市场',
        source: 'Wind / 东方财富收盘统计',
        chain: `MKT-${todayISO().replaceAll('-', '')}`,
        available_at: `${todayISO()}T15:05:00+08:00`,
      },
    ],
  });
  const [evidenceCheck, setEvidenceCheck] = useState<EvidenceCheckResult | null>(null);
  const [checkingEvidence, setCheckingEvidence] = useState(false);

  // -------------------------------------------------------------------------
  // 新建标的研判向导（工作模式二）
  // -------------------------------------------------------------------------
  const [judgeForm, setJudgeForm] = useState({
    recordKey: ledger.stats.nextJudgmentKey,
    target: '',
    date: todayISO(),
    dataCutoff: todayISO(),
    score: '6.0',
    marketState: '趋势成长池（独立止损，不与短线池混管）',
    conclusion: '',
    industryPosition: '',
    bullArgs: '',
    bearArgs: '',
    tradingStructure: '',
    behavioralCheck: '',
    methodIds: '',
    cognitionIds: '',
    hypotheses: [
      { claim: '', verifyMethod: '', verifyDate: '', falsifyCond: '' },
      { claim: '', verifyMethod: '', verifyDate: '', falsifyCond: '' },
      { claim: '', verifyMethod: '', verifyDate: '', falsifyCond: '' },
    ],
  });

  useEffect(() => {
    setJudgeForm((prev) => ({ ...prev, recordKey: ledger.stats.nextJudgmentKey }));
  }, [ledger.stats.nextJudgmentKey]);

  // 监听可视化 HTML 研报 iframe 内的卡片徽章点击事件，唤起工作台右侧双链预览抽屉
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data && e.data.type === 'srw-open-entity' && e.data.kind && e.data.id) {
        onOpenEntity({ kind: e.data.kind, id: String(e.data.id) });
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [onOpenEntity]);

  const handleSaveArchivedHtml = async (dailyId: string) => {
    setSavingHtml(true);
    try {
      const res = await api.saveDailyReviewHtml({ id: dailyId, theme });
      onToast(`已保存独立分享 HTML：复盘简报HTML/${res.fileName} (${Math.round(res.sizeBytes / 1024)} KB)`);
    } catch (err: any) {
      onToast(`保存 HTML 失败：${err.message}`);
    } finally {
      setSavingHtml(false);
    }
  };

  const handlePreviewDraftHtml = async () => {
    setRenderingDraftHtml(true);
    try {
      const res = await api.renderDraftDailyHtml(dailyForm, liveMarketPacket, theme);
      setDraftHtmlPreview({ html: res.html, fileName: res.fileName });
    } catch (err: any) {
      onToast(`生成草稿 HTML 失败：${err.message}`);
    } finally {
      setRenderingDraftHtml(false);
    }
  };

  const handleDownloadHtmlText = (html: string, fileName: string) => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const handleSaveDraftHtmlToDisk = async () => {
    setSavingHtml(true);
    try {
      const res = await api.saveDailyReviewHtml({ form: dailyForm, packet: liveMarketPacket, theme });
      onToast(`已保存草稿分享 HTML 至本地：复盘简报HTML/${res.fileName}`);
    } catch (err: any) {
      onToast(`保存失败：${err.message}`);
    } finally {
      setSavingHtml(false);
    }
  };

  const [quickJudgeTrigger, setQuickJudgeTrigger] = useState<{ query: string; nonce: number } | null>(null);

  useEffect(() => {
    if (initialDraftNote && initialDraftNote.target === 'judgment') {
      const symLabel = initialDraftNote.symbol || initialDraftNote.symbolName || '';
      const stampedNote = `【盘中闪念 · ${initialDraftNote.tag} · ${initialDraftNote.createdAt.slice(0, 16).replace('T', ' ')}】\n${initialDraftNote.text}`;
      setSubView('createJudgment');
      setJudgeForm((prev) => ({
        ...prev,
        target: symLabel || prev.target,
        conclusion: prev.conclusion ? `${prev.conclusion}\n\n${stampedNote}` : stampedNote,
        tradingStructure: prev.tradingStructure || stampedNote,
      }));
      if (symLabel) {
        setQuickJudgeTrigger({ query: symLabel, nonce: Date.now() });
      }
      onDraftNoteAccepted?.(initialDraftNote.noteId, 'judgment');
      onConsumeInitial?.();
      return;
    }
    if (initialDailyId) {
      setSubView('daily');
      setSelectedDailyId(initialDailyId);
      setActiveSubSecIdx(-1);
      onConsumeInitial?.();
    } else if (initialJudgmentId) {
      setSubView('judgments');
      setSelectedJudgeId(initialJudgmentId);
      onConsumeInitial?.();
    } else if (initialMode === 'createDaily') {
      setSubView('createDaily');
      onConsumeInitial?.();
    } else if (initialMode === 'createJudgment') {
      setSubView('createJudgment');
      if (initialJudgeQuery) {
        setJudgeForm((prev) => ({ ...prev, target: initialJudgeQuery }));
        setQuickJudgeTrigger({ query: initialJudgeQuery, nonce: Date.now() });
      }
      onConsumeInitial?.();
    }
  }, [initialDailyId, initialJudgmentId, initialMode, initialJudgeQuery, initialDraftNote, onDraftNoteAccepted, onConsumeInitial]);

  const filteredDaily = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ledger.dailyReviews.filter((d) => {
      if (!q) return true;
      return (
        d.date.includes(q) ||
        d.title.toLowerCase().includes(q) ||
        d.rawMarkdown.toLowerCase().includes(q)
      );
    });
  }, [ledger.dailyReviews, search]);

  const multiTargetGroups = useMemo(
    () => (ledger.targetGroups || []).filter((g) => g.count > 1),
    [ledger.targetGroups]
  );

  const filteredJudgments = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...ledger.judgments].reverse().filter((j) => {
      if (targetFilterKey !== 'ALL' && j.targetKey !== targetFilterKey) return false;
      if (!q) return true;
      return (
        j.recordKey.toLowerCase().includes(q) ||
        j.target.toLowerCase().includes(q) ||
        (j.stockCode || '').includes(q) ||
        (j.stockName || '').toLowerCase().includes(q) ||
        j.rawMarkdown.toLowerCase().includes(q)
      );
    });
  }, [ledger.judgments, search, targetFilterKey]);

  const selectedDaily: DailyReviewEntry | undefined =
    ledger.dailyReviews.find((d) => d.id === selectedDailyId) || filteredDaily[0];

  const selectedJudge: JudgmentEntry | undefined =
    ledger.judgments.find((j) => j.id === selectedJudgeId) || filteredJudgments[0];

  const selectedTargetGroup = useMemo(() => {
    if (!selectedJudge) return null;
    return (
      (ledger.targetGroups || []).find((g) => g.judgmentIds.includes(selectedJudge.id)) || null
    );
  }, [selectedJudge, ledger.targetGroups]);

  const sameTargetJudgments = useMemo(() => {
    if (!selectedTargetGroup) return [];
    return selectedTargetGroup.judgmentIds
      .map((id) => ledger.judgments.find((j) => j.id === id))
      .filter((x): x is JudgmentEntry => Boolean(x));
  }, [selectedTargetGroup, ledger.judgments]);

  // 为选中的标的研判配对同一编号前缀及同标的历史复盘回填记录
  const pairedBackfills = useMemo(() => {
    if (!selectedJudge) return [];
    const baseKey = selectedJudge.recordKey.replace(/[a-z]+$/i, '');
    const groupBfIds = new Set(selectedTargetGroup?.backfillIds || []);
    return ledger.backfills.filter(
      (b) =>
        b.recordKey === selectedJudge.recordKey ||
        b.recordKey.startsWith(baseKey) ||
        groupBfIds.has(b.id)
    );
  }, [selectedJudge, selectedTargetGroup, ledger.backfills]);

  const jumpToJudgment = (id: string) => {
    setSubView('judgments');
    setSelectedJudgeId(id);
    if (judgeDetailRef.current) {
      judgeDetailRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const scoreColor = (score: number | null) => {
    if (score === null) return 'badge-muted';
    if (score >= 6.5) return 'badge-emerald';
    if (score >= 5.0) return 'badge-amber';
    return 'badge-crimson';
  };

  // 证据核验器动作
  const handleLoadEvidenceSample = async (fileName: string) => {
    try {
      const res = await api.getEvidenceFile(fileName);
      setEvidenceRecord(res.data);
      setEvidenceCheck(res.check);
      onToast(`已加载证据表：${fileName}`, 'success');
    } catch (err: any) {
      onToast(`加载失败：${err.message}`, 'error');
    }
  };

  const handleRunEvidenceCheck = async () => {
    setCheckingEvidence(true);
    try {
      const res = await api.checkEvidence(evidenceRecord);
      setEvidenceCheck(res);
    } catch (err: any) {
      onToast(`核验异常：${err.message}`, 'error');
    } finally {
      setCheckingEvidence(false);
    }
  };

  const handleSaveEvidenceFile = async () => {
    try {
      const fileName = `${evidenceRecord.review_date || todayISO()}_复盘证据.json`;
      const res = await api.saveEvidence(fileName, evidenceRecord);
      setEvidenceCheck(res.check);
      onToast(`核验通过并已保存至日度复盘工作台：${res.fileName}`, 'success');
    } catch (err: any) {
      onToast(`保存证据表失败：${err.message || String(err)}`, 'error');
    }
  };

  const updateFact = (idx: number, patch: Partial<EvidenceFact>) => {
    setEvidenceRecord((prev) => ({
      ...prev,
      facts: prev.facts.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    }));
  };

  const addFactRow = () => {
    const nextNum = evidenceRecord.facts.length + 1;
    setEvidenceRecord((prev) => ({
      ...prev,
      facts: [
        ...prev.facts,
        {
          id: `E${String(nextNum).padStart(2, '0')}`,
          metric: '',
          date: prev.review_date || todayISO(),
          kind: 'same_day',
          state: 'observed',
          value: 0,
          unit: '%',
          scope: '',
          source: '',
          chain: `MKT-${(prev.review_date || todayISO()).replaceAll('-', '')}`,
          available_at: prev.cutoff || `${todayISO()}T15:05:00+08:00`,
        },
      ],
    }));
  };

  const toggleHighFreqAdjustment = (cardId: string) => {
    setDailyForm((prev) => {
      const exists = prev.credibilityAdjustments.some((x) => x.cardId === cardId);
      if (exists) {
        return {
          ...prev,
          credibilityAdjustments: prev.credibilityAdjustments.filter((x) => x.cardId !== cardId),
        };
      }
      return {
        ...prev,
        credibilityAdjustments: [...prev.credibilityAdjustments, { cardId, delta: 0, reason: '' }],
      };
    });
  };

  return (
    <div className="page-viewport">
      {/* 顶部子模式切换栏 */}
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
            className={`seg-tab ${subView === 'daily' ? 'active' : ''}`}
            onClick={() => setSubView('daily')}
          >
            <Calendar size={14} /> {t('每日复盘', 'Daily Reviews')} ({ledger.stats.dailyReviewCount})
          </button>
          <button
            type="button"
            className={`seg-tab ${subView === 'judgments' ? 'active' : ''}`}
            onClick={() => setSubView('judgments')}
          >
            <Target size={14} /> {t('标的研判', 'Stock Theses')} ({ledger.stats.judgmentCount})
          </button>
          <button
            type="button"
            className={`seg-tab ${subView === 'tracker' ? 'active' : ''}`}
            onClick={() => setSubView('tracker')}
          >
            <BarChart3 size={14} /> {t('T+N 追踪 & 否决池', 'T+N Tracker & Vetos')}
          </button>
          <button
            type="button"
            className={`seg-tab ${subView === 'periodic' ? 'active' : ''}`}
            onClick={() => setSubView('periodic')}
          >
            <CalendarRange size={14} /> {t('周报 / 月报聚合', 'Weekly / Monthly')}
          </button>
          <button
            type="button"
            className={`seg-tab ${subView === 'createDaily' ? 'active' : ''}`}
            onClick={() => setSubView('createDaily')}
          >
            <ClipboardCheck size={14} /> {t('录入日度复盘', 'Log Daily Review')}
          </button>
          <button
            type="button"
            className={`seg-tab ${subView === 'createJudgment' ? 'active' : ''}`}
            onClick={() => setSubView('createJudgment')}
          >
            <FilePlus2 size={14} /> {t('发起标的研判', 'New Thesis')} ({ledger.stats.nextJudgmentKey})
          </button>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.print()} title={t('打印当前研报/复盘导出 PDF', 'Print / Export PDF')}>
          <Printer size={13} /> {t('打印 PDF', 'Print PDF')}
        </button>

        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          框架增订：①宏观必查 · ②日内分时 · ③涨停穷举 · ④双线分治 · ⑤龙虎榜10日池 · ⑥评分校准
        </div>
      </div>

      {/* 子视图 1：每日 A 股复盘精读 */}
      {subView === 'daily' && (
        <div className="split-workbench">
          <div className="list-pane">
            <div className="list-pane-header">
              <div style={{ position: 'relative' }}>
                <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: 10, top: 10 }} />
                <input
                  className="input"
                  style={{ paddingLeft: 30 }}
                  placeholder="搜日期、板块、标的、关键词..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                按交易日倒序 · 共 <strong className="num">{filteredDaily.length}</strong> 个复盘日
              </div>
            </div>
            <div className="list-pane-scroll">
              {filteredDaily.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`list-card ${selectedDaily?.id === d.id ? 'selected-amber' : ''}`}
                  onClick={() => {
                    setSelectedDailyId(d.id);
                    setActiveSubSecIdx(-1);
                  }}
                >
                  <div className="list-card-top">
                    <span className="badge badge-amber mono">{d.date}</span>
                    {d.score !== null && (
                      <span className={`badge num ${scoreColor(d.score)}`}>{d.score} / 10</span>
                    )}
                  </div>
                  <div className="list-card-title">{d.title}</div>
                  <div className="list-card-sub">
                    <span>{d.subsections.length} 模块</span>
                    {d.anchorChecks.length > 0 && <span>核对 {d.anchorChecks.length} 锚</span>}
                    {d.credibilityEntries.length > 0 && <span>高频卡 {d.credibilityEntries.length}</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div
            className="detail-pane"
            style={
              dailyViewMode === 'visual' && selectedDaily
                ? { padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }
                : undefined
            }
          >
            {!selectedDaily ? (
              <div className="empty-state">请选择左侧交易日复盘记录</div>
            ) : dailyViewMode === 'visual' ? (
              <>
                <div
                  style={{
                    padding: '9px 18px',
                    background: 'var(--bg-elev)',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                    flexShrink: 0,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div className="seg-tabs">
                      <button
                        type="button"
                        className="seg-tab active"
                        onClick={() => setDailyViewMode('visual')}
                      >
                        <LayoutGrid size={13} /> 可视化研报视图
                      </button>
                      <button
                        type="button"
                        className="seg-tab"
                        onClick={() => setDailyViewMode('structured')}
                      >
                        <FileCode2 size={13} /> 原文分节视图
                      </button>
                    </div>
                    <span className="badge badge-amber mono">{selectedDaily.date}</span>
                    {selectedDaily.score !== null && (
                      <span className={`badge num ${scoreColor(selectedDaily.score)}`}>
                        评分 {selectedDaily.score} / 10
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <a
                      className="btn btn-sm"
                      style={{ textDecoration: 'none' }}
                      href={`/api/daily-review/html?id=${encodeURIComponent(selectedDaily.id)}&theme=${theme}`}
                      target="_blank"
                      rel="noreferrer"
                      title="在浏览器新标签页打开完整研报，支持一键打印/存 PDF"
                    >
                      <ExternalLink size={13} /> 新标签页打开 HTML
                    </a>
                    <a
                      className="btn btn-primary btn-sm"
                      style={{ textDecoration: 'none' }}
                      href={`/api/daily-review/html?id=${encodeURIComponent(selectedDaily.id)}&download=1&theme=${theme}`}
                      download={`${selectedDaily.date}_A股复盘研报.html`}
                      title="下载零外链单文件 .html，可直接发微信/飞书/邮件"
                    >
                      <Download size={13} /> 下载独立 HTML 分享
                    </a>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={savingHtml}
                      onClick={() => handleSaveArchivedHtml(selectedDaily.id)}
                      title="保存到本地项目目录 复盘简报HTML/"
                    >
                      <FolderDown size={13} /> {savingHtml ? '保存中...' : '存至本地文件夹'}
                    </button>
                  </div>
                </div>

                <iframe
                  key={`${selectedDaily.id}-${theme}-${workspace.loadedAt}`}
                  title={`${selectedDaily.date} 每日复盘可视化研报`}
                  src={`/api/daily-review/html?id=${encodeURIComponent(selectedDaily.id)}&embedded=1&theme=${theme}&v=${encodeURIComponent(workspace.loadedAt)}`}
                  style={{ flex: 1, width: '100%', border: 'none', background: 'var(--bg)' }}
                />
              </>
            ) : (
              <div style={{ maxWidth: 960 }}>
                <div className="panel panel-pad" style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
                        <span className="badge badge-amber mono">{selectedDaily.date}</span>
                        {selectedDaily.score !== null && (
                          <span className={`badge num ${scoreColor(selectedDaily.score)}`}>
                            大盘评分 {selectedDaily.score} / 10
                          </span>
                        )}
                        <span className="badge badge-muted">行 L{selectedDaily.startLine}–L{selectedDaily.endLine}</span>
                      </div>
                      <h2 style={{ margin: '0 0 6px', fontSize: 18, lineHeight: 1.4 }}>{selectedDaily.title}</h2>
                      {selectedDaily.marketState && (
                        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6 }}>
                          <strong>市场状态：</strong>
                          <CardLinkText text={selectedDaily.marketState} onOpenEntity={onOpenEntity} />
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setDailyViewMode('visual')}>
                        <LayoutGrid size={13} /> 切回可视化研报
                      </button>
                      <a
                        className="btn btn-sm"
                        style={{ textDecoration: 'none' }}
                        href={`/api/daily-review/html?id=${encodeURIComponent(selectedDaily.id)}&download=1&theme=${theme}`}
                        download={`${selectedDaily.date}_A股复盘研报.html`}
                      >
                        <Download size={13} /> 下载 HTML
                      </a>
                    </div>
                  </div>

                  {/* 十节快速切换胶囊 */}
                  {selectedDaily.subsections.length > 0 && (
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                      <button
                        type="button"
                        className={`btn btn-sm ${activeSubSecIdx === -1 ? 'btn-amber' : ''}`}
                        style={{ padding: '2px 8px', fontSize: 11.5 }}
                        onClick={() => setActiveSubSecIdx(-1)}
                      >
                        展开全部 ({selectedDaily.subsections.length})
                      </button>
                      {selectedDaily.subsections.map((s, idx) => (
                        <button
                          key={idx}
                          type="button"
                          className={`btn btn-sm ${activeSubSecIdx === idx ? 'btn-amber' : ''}`}
                          style={{ padding: '2px 8px', fontSize: 11.5 }}
                          onClick={() => setActiveSubSecIdx(idx)}
                        >
                          {s.title.slice(0, 14)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* 分节渲染 */}
                {selectedDaily.subsections.length === 0 ? (
                  <div className="panel panel-pad">
                    <MarkdownBlock content={selectedDaily.rawMarkdown} onOpenEntity={onOpenEntity} />
                  </div>
                ) : (
                  selectedDaily.subsections.map((sub, idx) => {
                    if (activeSubSecIdx !== -1 && activeSubSecIdx !== idx) return null;
                    return (
                      <div key={idx} className="panel panel-pad" style={{ marginBottom: 12 }}>
                        <h3 style={{ margin: '0 0 10px', fontSize: 15, color: 'var(--navy)', borderBottom: '1px solid var(--border)', paddingBottom: 6 }}>
                          {sub.title}
                        </h3>
                        <MarkdownBlock content={sub.content} onOpenEntity={onOpenEntity} />
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 子视图 2：标的研判与复盘回填 */}
      {subView === 'judgments' && (
        <div className="split-workbench">
          <div className="list-pane">
            <div className="list-pane-header">
              <div style={{ position: 'relative' }}>
                <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: 10, top: 10 }} />
                <input
                  className="input"
                  style={{ paddingLeft: 30 }}
                  placeholder="搜编号(#001)、标的(东山/立讯)..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                按最新倒序 · 研判 {filteredJudgments.length} 条 · 配套回填 {ledger.stats.backfillCount} 条
              </div>
              {multiTargetGroups.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${targetFilterKey === 'ALL' ? 'btn-amber' : ''}`}
                    style={{ padding: '2px 7px', fontSize: 11 }}
                    onClick={() => setTargetFilterKey('ALL')}
                  >
                    全部
                  </button>
                  {multiTargetGroups.map((g) => (
                    <button
                      key={g.targetKey}
                      type="button"
                      className={`btn btn-sm ${targetFilterKey === g.targetKey ? 'btn-amber' : ''}`}
                      style={{ padding: '2px 7px', fontSize: 11 }}
                      onClick={() => {
                        setTargetFilterKey(g.targetKey);
                        const latestId = g.judgmentIds[g.judgmentIds.length - 1];
                        if (latestId) setSelectedJudgeId(latestId);
                      }}
                    >
                      {g.stockName || g.displayName} ({g.count})
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="list-pane-scroll">
              {filteredJudgments.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  className={`list-card ${selectedJudge?.id === j.id ? 'selected-amber' : ''}`}
                  onClick={() => {
                    setSelectedJudgeId(j.id);
                    judgeDetailRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  <div className="list-card-top">
                    <span className="badge badge-amber mono">{j.recordKey}</span>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {(j.sameTargetCount || 0) > 1 && (
                        <span className="badge badge-navy" style={{ fontSize: 10 }}>
                          历次 {j.sameTargetCount}
                        </span>
                      )}
                      {j.isLegacyRef && <span className="badge badge-muted" style={{ fontSize: 10 }}>含旧库引</span>}
                      {j.score !== null && <span className={`badge num ${scoreColor(j.score)}`}>{j.score}/10</span>}
                    </div>
                  </div>
                  <div className="list-card-title">{j.target}</div>
                  <div className="list-card-sub">
                    <span>{j.date || '历史记录'}</span>
                    {j.hypotheses.length > 0 && <span>假设 {j.hypotheses.length} 条</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="detail-pane" ref={judgeDetailRef}>
            {selectedJudge && (
              <div style={{ maxWidth: 940 }}>
                <div className="panel panel-pad" style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 8 }}>
                    <span className="badge badge-amber mono">{selectedJudge.recordKey}</span>
                    {selectedJudge.date && <span className="badge badge-muted">{selectedJudge.date}</span>}
                    {selectedJudge.score !== null && (
                      <span className={`badge num ${scoreColor(selectedJudge.score)}`}>
                        评分 {selectedJudge.score} / 10
                      </span>
                    )}
                    {selectedTargetGroup && selectedTargetGroup.count > 1 && (
                      <span className="badge badge-navy">
                        同标的历次研判共 {selectedTargetGroup.count} 次
                      </span>
                    )}
                    {selectedJudge.isLegacyRef && (
                      <span className="badge badge-violet">声明含穿透三部曲旧库编号（非现行同号）</span>
                    )}
                  </div>
                  <h2 style={{ margin: '0 0 8px', fontSize: 19 }}>{selectedJudge.target}</h2>
                  {selectedJudge.conclusion && (
                    <div className="field-block field-block-thesis" style={{ marginBottom: 0 }}>
                      <div className="field-block-label">一句话结论</div>
                      <CardLinkText text={selectedJudge.conclusion} onOpenEntity={onOpenEntity} />
                    </div>
                  )}
                </div>

                {/* 同标的历次研判成果与评分演变（一键点击跳转历史研判或右侧抽屉并排对照） */}
                {selectedTargetGroup && (sameTargetJudgments.length > 1 || selectedTargetGroup.dailyMentions.length > 0) && (
                  <div
                    className="panel panel-pad"
                    style={{
                      marginBottom: 14,
                      borderColor: 'color-mix(in srgb, var(--navy) 32%, var(--border))',
                      background: 'linear-gradient(180deg, var(--bg-elev) 0%, color-mix(in srgb, var(--navy-soft) 28%, var(--bg-elev)) 100%)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 8,
                        marginBottom: 10,
                      }}
                    >
                      <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 7, color: 'var(--navy)' }}>
                        <History size={15} />
                        同标的历次研判成果 · {selectedTargetGroup.displayName}（共 {sameTargetJudgments.length} 次）
                      </div>
                      {selectedTargetGroup.scoreSeries.length > 1 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, flexWrap: 'wrap' }}>
                          <span style={{ color: 'var(--text-muted)' }}>评分演变：</span>
                          {selectedTargetGroup.scoreSeries.map((pt, idx) => (
                            <React.Fragment key={pt.id}>
                              <button
                                type="button"
                                className={`badge num ${pt.id === selectedJudge.id ? 'badge-amber' : scoreColor(pt.score)}`}
                                style={{ border: 'none', cursor: 'pointer' }}
                                onClick={() => jumpToJudgment(pt.id)}
                                title={`点击跳转查看 ${pt.recordKey} (${pt.date})`}
                              >
                                {pt.recordKey} {pt.score}
                              </button>
                              {idx < selectedTargetGroup.scoreSeries.length - 1 && (
                                <ArrowRight size={11} color="var(--text-muted)" />
                              )}
                            </React.Fragment>
                          ))}
                        </div>
                      )}
                    </div>

                    {sameTargetJudgments.length > 1 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                        {sameTargetJudgments.map((item) => {
                          const isCurrent = item.id === selectedJudge.id;
                          return (
                            <div
                              key={item.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 10,
                                flexWrap: 'wrap',
                                padding: '9px 12px',
                                borderRadius: 8,
                                background: isCurrent ? 'var(--amber-soft)' : 'var(--bg-elev)',
                                border: `1px solid ${isCurrent ? 'var(--amber)' : 'var(--border)'}`,
                              }}
                            >
                              <div
                                style={{ flex: 1, minWidth: 240, cursor: isCurrent ? 'default' : 'pointer' }}
                                onClick={() => {
                                  if (!isCurrent) jumpToJudgment(item.id);
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
                                  <span className="badge badge-amber mono">{item.recordKey}</span>
                                  <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                    {item.date || '历史'}
                                  </span>
                                  {item.score !== null && (
                                    <span className={`badge num ${scoreColor(item.score)}`}>{item.score} / 10</span>
                                  )}
                                  {item.hypotheses.length > 0 && (
                                    <span className="badge badge-muted">假设 {item.hypotheses.length} 条</span>
                                  )}
                                  {isCurrent && <span className="badge badge-navy">当前查看</span>}
                                </div>
                                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                  {item.conclusion || item.title}
                                </div>
                              </div>

                              {!isCurrent && (
                                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                                  {onPreviewEntity && (
                                    <button
                                      type="button"
                                      className="btn btn-sm"
                                      onClick={() => onPreviewEntity({ kind: 'judgment', id: item.id })}
                                      title="在右侧抽屉打开，与当前研判并排对照"
                                    >
                                      <Eye size={12} /> 抽屉对照
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="btn btn-primary btn-sm"
                                    onClick={() => jumpToJudgment(item.id)}
                                  >
                                    跳转查看 <ArrowRight size={12} />
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {selectedTargetGroup.dailyMentions.length > 0 && (
                      <div style={{ marginTop: sameTargetJudgments.length > 1 ? 10 : 0, paddingTop: sameTargetJudgments.length > 1 ? 9 : 0, borderTop: sameTargetJudgments.length > 1 ? '1px dashed var(--border)' : 'none' }}>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>
                          近期每日复盘中提及该标的的交易日（点击直达当日复盘）：
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {selectedTargetGroup.dailyMentions.map((dm) => (
                            <button
                              key={dm.id}
                              type="button"
                              className="btn btn-sm"
                              style={{ padding: '2px 8px', fontSize: 11.5 }}
                              onClick={() => {
                                setSelectedDailyId(dm.id);
                                setSubView('daily');
                              }}
                              title={dm.title}
                            >
                              <Calendar size={11} /> {dm.date}
                              {dm.score !== null ? ` (${dm.score}分)` : ''}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 关键假设卡片化展示 */}
                {selectedJudge.hypotheses.length > 0 && (
                  <div className="panel panel-pad" style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 7 }}>
                      <Target size={15} color="var(--amber)" /> 事前关键假设清单（{selectedJudge.hypotheses.length} 条）
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {selectedJudge.hypotheses.map((h) => (
                        <div key={h.id} style={{ padding: '8px 12px', background: 'var(--bg-soft)', borderRadius: 7, fontSize: 13 }}>
                          <span className="badge badge-amber mono" style={{ marginRight: 8 }}>{h.id}</span>
                          <CardLinkText text={h.content} onOpenEntity={onOpenEntity} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="panel panel-pad" style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>研判正文完整档案</div>
                  <MarkdownBlock content={selectedJudge.rawMarkdown} onOpenEntity={onOpenEntity} />
                </div>

                {/* 自动配对的复盘回填记录 */}
                {pairedBackfills.length > 0 && (
                  <div className="panel panel-pad">
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: 'var(--teal)' }}>
                      关联复盘回填记录（{pairedBackfills.length} 条）
                    </div>
                    {pairedBackfills.map((bf) => (
                      <div key={bf.id} className="field-block" style={{ marginBottom: 12 }}>
                        <div style={{ display: 'flex', gap: 7, marginBottom: 6 }}>
                          <span className="badge badge-teal mono">{bf.recordKey}</span>
                          {bf.date && <span className="badge badge-muted">{bf.date}</span>}
                          {bf.isPostHoc && <span className="badge badge-amber">事后复盘（无事前基准，不调可信度）</span>}
                        </div>
                        <MarkdownBlock content={bf.rawMarkdown} onOpenEntity={onOpenEntity} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 子视图 3：新建每日复盘 + 真实 1 分钟数据采集 + GPT/Gemini 自动执行 + 证据核验（Keep-Alive 不卸载） */}
      <div className="scroll-page" style={{ display: subView === 'createDaily' ? 'block' : 'none' }}>
        <div style={{ maxWidth: 1120, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* 统一复盘融合栏：短线盘面情绪 + 题材趋势与产业逻辑一体化注入 */}
          <div className="panel">
            <div className="panel-header" style={{ flexWrap: 'wrap', gap: 8 }}>
              <h3 className="panel-title">
                <Flame size={16} color="var(--crimson)" />
                统一复盘底座 · 短线情绪周期 × 主线题材趋势 × 产业逻辑（单入口沉淀，不再拆分复盘营）
              </h3>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={loadingStSnap}
                  onClick={handleSyncShortTermSnapshot}
                >
                  <RefreshCw size={12} className={loadingStSnap ? 'spin' : ''} />
                  {loadingStSnap ? '正在同步盘面与主线...' : stSnapshot ? '刷新短线与题材快照' : '一键同步今日短线情绪与主线题材'}
                </button>
                {stSnapshot && (
                  <>
                    <button type="button" className="btn btn-sm" onClick={handleFillShortTermIntoForm}>
                      <ClipboardCheck size={12} /> 填入盘面事实 & 题材逻辑字段
                    </button>
                    <button type="button" className="btn btn-sm" onClick={handleInjectShortTermIntoAi}>
                      <Sparkles size={12} /> 注入 AI 复盘附加材料
                    </button>
                  </>
                )}
              </div>
            </div>
            {stSnapshot ? (
              <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
                  <span className="badge badge-crimson mono">情绪温度 {stSnapshot.sentimentScore ?? '--'} · {stSnapshot.stage}</span>
                  <span className="badge badge-amber mono">
                    涨停 {stSnapshot.ztCount ?? '--'} / 跌停 {stSnapshot.dtCount ?? '--'} / 炸板 {stSnapshot.zbCount ?? '--'}
                  </span>
                  <span className="badge badge-teal mono">封板率 {stSnapshot.sealRatePct ?? '--'}%</span>
                  <span className="badge badge-navy mono">
                    连板 {stSnapshot.lianbanCount ?? '--'} 家 · 最高 {stSnapshot.maxBoard ?? '--'} 板
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    快照时点 {stSnapshot.fetchedAt}
                  </span>
                </div>
                <div className="grid-2" style={{ gap: 10 }}>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'var(--bg-soft)' }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                      今日领涨主线题材 TOP 5（对接产业逻辑与认知库映射）
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {stSnapshot.topThemes.map((th) => (
                        <div key={th.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 8 }}>
                          <span style={{ fontWeight: 700 }}>
                            {th.name}{' '}
                            {th.leaderName && <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>· {th.leaderName}</span>}
                          </span>
                          <span className="mono" style={{ fontWeight: 700, color: (th.pct ?? 0) >= 0 ? 'var(--crimson)' : 'var(--emerald)' }}>
                            {th.pct != null ? `${th.pct > 0 ? '+' : ''}${th.pct.toFixed(2)}%` : '--'}
                            {th.mainNetYi != null && (
                              <span style={{ color: 'var(--text-muted)', fontWeight: 500, marginLeft: 6 }}>
                                {th.mainNetYi > 0 ? '+' : ''}{th.mainNetYi.toFixed(1)}亿
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'var(--bg-soft)' }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                      核心连板梯队（短线投机情绪标尺）
                    </div>
                    {stSnapshot.topLadder.length === 0 ? (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>当前无 2 板以上连板或盘前暂无数据</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {stSnapshot.topLadder.map((lv) => (
                          <div key={lv.board} style={{ fontSize: 11.5, display: 'flex', gap: 6, alignItems: 'baseline' }}>
                            <span className="badge badge-crimson mono" style={{ flexShrink: 0 }}>
                              {lv.board}板({lv.count})
                            </span>
                            <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {lv.names.join('、')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="panel-pad" style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
                点击右上角按钮可实时拉取短线情绪温度、连板梯队与领涨主线题材，一键写入下方复盘表的「盘面事实」与「投机/题材产业双线分析」或作为 AI 附加硬材料，在同一份复盘档案里兼顾短线节奏与中长期产业逻辑。
              </div>
            )}
          </div>

          <AutoDailyReviewPanel
            aiConfig={aiConfig}
            packet={liveMarketPacket}
            currentForm={dailyForm}
            recentDailyJob={recentDailyJob}
            externalNotesAppend={aiNotesAppend}
            onPacketFetched={(pkt) => {
              setLiveMarketPacket(pkt);
              setEvidenceRecord(pkt.evidenceRecord);
              setEvidenceCheck(pkt.evidenceCheck);
              setDailyForm((prev) => ({
                ...prev,
                date: pkt.actualTradeDate,
                evidenceCutoff: pkt.fetchedAt,
                dataSource: `腾讯日K(权威开高低收) + 东财1m正式交易241条分时 + 东财全量三池（抓取于 ${pkt.fetchedAt}）`,
              }));
            }}
            onDraftGenerated={(formPatch) => {
              setDailyForm((prev) => ({
                ...prev,
                ...formPatch,
              }));
            }}
            onJobStarted={onJobStarted}
            onJobFinished={onJobFinished}
            onOpenAiSettings={onOpenAiSettings}
            onToast={onToast}
          />

            {/* Part A：结构化证据登记与离线核验（融合 日度复盘工作台_2026-11-23） */}
            <div className="panel">
              <div className="panel-header">
                <h3 className="panel-title">
                  <FileSpreadsheet size={16} color="var(--teal)" />
                  Step 1 · 结构化证据登记与防未来函数核验（对齐 核验复盘.cjs）
                </h3>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {evidenceFiles.map((ef) => (
                    <button
                      key={ef.name}
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleLoadEvidenceSample(ef.name)}
                    >
                      载入 {ef.name}
                    </button>
                  ))}
                  <button type="button" className="btn btn-teal btn-sm" onClick={handleRunEvidenceCheck} disabled={checkingEvidence}>
                    <CheckCircle2 size={13} /> {checkingEvidence ? '核验中...' : '运行离线核验'}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={handleSaveEvidenceFile}>
                    <Save size={13} /> 保存证据 JSON
                  </button>
                </div>
              </div>
              <div className="panel-pad">
                <div className="grid-3" style={{ marginBottom: 12 }}>
                  <div className="field-group" style={{ marginBottom: 0 }}>
                    <label className="field-label">复盘交易日 (YYYY-MM-DD)</label>
                    <input
                      className="input"
                      value={evidenceRecord.review_date}
                      onChange={(e) => {
                        const v = e.target.value;
                        setEvidenceRecord({ ...evidenceRecord, review_date: v });
                        setDailyForm((p) => ({ ...p, date: v }));
                      }}
                    />
                  </div>
                  <div className="field-group" style={{ marginBottom: 0 }}>
                    <label className="field-label">记录模式</label>
                    <select
                      className="select"
                      value={evidenceRecord.mode}
                      onChange={(e) => setEvidenceRecord({ ...evidenceRecord, mode: e.target.value as 'daily' | 'archive_replay' })}
                    >
                      <option value="daily">daily（当日登记）</option>
                      <option value="archive_replay">archive_replay（档案回放）</option>
                    </select>
                  </div>
                  <div className="field-group" style={{ marginBottom: 0 }}>
                    <label className="field-label">证据冻结时点（含时区）</label>
                    <input
                      className="input mono"
                      placeholder="2026-11-23T18:00:00+08:00"
                      value={evidenceRecord.cutoff ?? ''}
                      onChange={(e) => {
                        const v = e.target.value || null;
                        setEvidenceRecord({ ...evidenceRecord, cutoff: v });
                        setDailyForm((p) => ({ ...p, evidenceCutoff: v || '' }));
                      }}
                    />
                  </div>
                </div>

                <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 10 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: 64 }}>ID</th>
                        <th style={{ width: 150 }}>指标名</th>
                        <th style={{ width: 112 }}>状态</th>
                        <th style={{ width: 92 }}>数值</th>
                        <th style={{ width: 72 }}>单位</th>
                        <th>口径 / 出处 / 缺失原因</th>
                        <th style={{ width: 165 }}>首次可得时间</th>
                        <th style={{ width: 42 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {evidenceRecord.facts.map((f, idx) => (
                        <tr key={idx}>
                          <td>
                            <input className="input mono" style={{ padding: '4px 6px', fontSize: 12 }} value={f.id} onChange={(e) => updateFact(idx, { id: e.target.value })} />
                          </td>
                          <td>
                            <input className="input" style={{ padding: '4px 6px', fontSize: 12 }} value={f.metric} onChange={(e) => updateFact(idx, { metric: e.target.value })} />
                          </td>
                          <td>
                            <select
                              className="select"
                              style={{ padding: '4px 6px', fontSize: 12 }}
                              value={f.state}
                              onChange={(e) => {
                                const st = e.target.value as EvidenceFact['state'];
                                updateFact(idx, {
                                  state: st,
                                  value: ['missing', 'conflict', 'not_applicable'].includes(st) ? null : f.value ?? 0,
                                });
                              }}
                            >
                              <option value="observed">observed</option>
                              <option value="archived">archived</option>
                              <option value="missing">missing</option>
                              <option value="conflict">conflict</option>
                              <option value="not_applicable">not_applicable</option>
                            </select>
                          </td>
                          <td>
                            <input
                              className="input mono"
                              style={{ padding: '4px 6px', fontSize: 12 }}
                              disabled={['missing', 'conflict', 'not_applicable'].includes(f.state)}
                              placeholder="null"
                              value={f.value === null ? '' : String(f.value)}
                              onChange={(e) => updateFact(idx, { value: e.target.value === '' ? null : Number(e.target.value) })}
                            />
                          </td>
                          <td>
                            <input className="input" style={{ padding: '4px 6px', fontSize: 12 }} value={f.unit || ''} onChange={(e) => updateFact(idx, { unit: e.target.value })} />
                          </td>
                          <td>
                            {['missing', 'conflict', 'not_applicable'].includes(f.state) ? (
                              <input className="input" style={{ padding: '4px 6px', fontSize: 12 }} placeholder="必填缺失/冲突原因（禁填0）" value={f.reason || ''} onChange={(e) => updateFact(idx, { reason: e.target.value })} />
                            ) : (
                              <div style={{ display: 'flex', gap: 4 }}>
                                <input className="input" style={{ padding: '4px 6px', fontSize: 12 }} placeholder="证券池范围" value={f.scope || ''} onChange={(e) => updateFact(idx, { scope: e.target.value })} />
                                <input className="input" style={{ padding: '4px 6px', fontSize: 12 }} placeholder="出处" value={f.source || ''} onChange={(e) => updateFact(idx, { source: e.target.value })} />
                              </div>
                            )}
                          </td>
                          <td>
                            <input
                              className="input mono"
                              style={{ padding: '4px 6px', fontSize: 11 }}
                              placeholder="YYYY-MM-DDTHH:MM+08:00"
                              value={f.available_at || ''}
                              onChange={(e) => updateFact(idx, { available_at: e.target.value || null })}
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setEvidenceRecord((p) => ({ ...p, facts: p.facts.filter((_, i) => i !== idx) }))}
                            >
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <button type="button" className="btn btn-sm" onClick={addFactRow}>
                    <Plus size={13} /> 新增证据行
                  </button>
                  {evidenceCheck && (
                    <div style={{ fontSize: 12.5 }}>
                      {evidenceCheck.ok ? (
                        <span className="badge badge-emerald">
                          <CheckCircle2 size={13} /> {evidenceCheck.status} · 独立证据链 {evidenceCheck.chains.length} 条
                          {evidenceCheck.calculations.length > 0 ? ` · 点差复算通过 ${evidenceCheck.calculations.length} 项` : ''}
                        </span>
                      ) : (
                        <span className="badge badge-crimson">
                          <AlertTriangle size={13} /> {evidenceCheck.errors[0]}（共 {evidenceCheck.errors.length} 项错误）
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Part B：结构化每日复盘主体 + 高频方法论卡双库联动 */}
            <div className="panel">
              <div className="panel-header" style={{ flexWrap: 'wrap' }}>
                <h3 className="panel-title">
                  <Sparkles size={16} color="var(--amber)" />
                  Step 2 · 编写每日 A 股复盘（支持原子联动更新方法论卡片库）
                </h3>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={renderingDraftHtml}
                    onClick={handlePreviewDraftHtml}
                    title="将当前草稿与1分钟分时图渲染为独立可视化 HTML 研报"
                  >
                    <Eye size={13} /> {renderingDraftHtml ? '生成中...' : '预览/分享 HTML 研报'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-amber btn-sm"
                    onClick={() =>
                      onRequestMutation('ledger.createDailyReview', dailyForm, () => {
                        setSubView('daily');
                        setDailyViewMode('visual');
                        setSelectedDailyId(`daily-${dailyForm.date}`);
                      })
                    }
                  >
                    预览变更 Diff 并落库
                  </button>
                </div>
              </div>
              <div className="panel-pad">
                <div className="grid-3">
                  <div className="field-group">
                    <label className="field-label">复盘日期 <span className="field-req">*</span></label>
                    <input className="input" value={dailyForm.date} onChange={(e) => setDailyForm({ ...dailyForm, date: e.target.value })} />
                  </div>
                  <div className="field-group">
                    <label className="field-label">大盘综合评分 (/10)</label>
                    <input className="input" type="number" step="0.1" min="0" max="10" value={dailyForm.score} onChange={(e) => setDailyForm({ ...dailyForm, score: e.target.value })} />
                  </div>
                  <div className="field-group">
                    <label className="field-label">数据来源与口径</label>
                    <input className="input" value={dailyForm.dataSource} onChange={(e) => setDailyForm({ ...dailyForm, dataSource: e.target.value })} />
                  </div>
                </div>

                <div className="field-group">
                  <label className="field-label">当日一句话盘面定性标题 <span className="field-req">*</span></label>
                  <input className="input" placeholder="例：周一 · 缩量震荡分化日/「算力承接+投机高低切」" value={dailyForm.headline} onChange={(e) => setDailyForm({ ...dailyForm, headline: e.target.value })} />
                </div>

                <div className="grid-2">
                  <div className="field-group">
                    <label className="field-label">二、隔夜美股与宏观事件（增订①，无则明示）</label>
                    <textarea className="textarea" placeholder="无重大宏观变量，或列举中国/美国宏观与央行变量..." value={dailyForm.macroNotes} onChange={(e) => setDailyForm({ ...dailyForm, macroNotes: e.target.value })} />
                  </div>
                  <div className="field-group">
                    <label className="field-label">三、指数与盘面事实（量能/广度/涨跌停/聚类）<span className="field-req">*</span></label>
                    <textarea className="textarea" placeholder="沪指/创指/科创50、两市量能、红盘数、三源涨跌停、≥3只集群穷举..." value={dailyForm.marketFacts} onChange={(e) => setDailyForm({ ...dailyForm, marketFacts: e.target.value })} />
                  </div>
                </div>

                <div className="grid-2">
                  <div className="field-group">
                    <label className="field-label">四、日内结构（增订②：竞价→早盘→午盘→尾盘 + 个股分时）</label>
                    <textarea className="textarea" value={dailyForm.intradayStructure} onChange={(e) => setDailyForm({ ...dailyForm, intradayStructure: e.target.value })} />
                  </div>
                  <div className="field-group">
                    <label className="field-label">五、投机高标 vs 价值成长拆分 & 双线仓位框架</label>
                    <textarea className="textarea" value={dailyForm.dualLineSplit} onChange={(e) => setDailyForm({ ...dailyForm, dualLineSplit: e.target.value })} />
                  </div>
                </div>

                {/* 自动带出的上期跟踪锚核对表 */}
                {dailyForm.anchorChecks.length > 0 && (
                  <div className="field-group">
                    <label className="field-label">六、上期跟踪锚逐条回填（已自动载入 {latestDaily?.date} 的 {dailyForm.anchorChecks.length} 条跟踪锚）</label>
                    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th style={{ width: '32%' }}>预设锚</th>
                            <th>当日事实证据</th>
                            <th style={{ width: 120 }}>判定</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dailyForm.anchorChecks.map((ac, idx) => (
                            <tr key={idx}>
                              <td style={{ fontSize: 12 }}>{ac.preset}</td>
                              <td>
                                <input
                                  className="input"
                                  style={{ padding: '4px 8px', fontSize: 12 }}
                                  placeholder="填写对应盘面事实..."
                                  value={ac.evidence}
                                  onChange={(e) =>
                                    setDailyForm((p) => ({
                                      ...p,
                                      anchorChecks: p.anchorChecks.map((x, i) => (i === idx ? { ...x, evidence: e.target.value } : x)),
                                    }))
                                  }
                                />
                              </td>
                              <td>
                                <select
                                  className="select"
                                  style={{ padding: '4px 6px', fontSize: 12 }}
                                  value={ac.verdict}
                                  onChange={(e) =>
                                    setDailyForm((p) => ({
                                      ...p,
                                      anchorChecks: p.anchorChecks.map((x, i) => (i === idx ? { ...x, verdict: e.target.value } : x)),
                                    }))
                                  }
                                >
                                  <option value="成立">成立</option>
                                  <option value="部分成立">部分成立</option>
                                  <option value="证伪">证伪</option>
                                  <option value="未获得，不判定">未获得，不判定</option>
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* 高频方法论卡双库联动勾选 */}
                <div className="field-group">
                  <label className="field-label" style={{ justifyContent: 'space-between' }}>
                    <span>七、高频核心方法论卡联动回填（勾选后将同步写入《方法论卡片库.md》与《台账》，三处一致）</span>
                    <label style={{ fontWeight: 500, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <input
                        type="checkbox"
                        checked={dailyForm.syncMethodology}
                        onChange={(e) => setDailyForm({ ...dailyForm, syncMethodology: e.target.checked })}
                      />
                      同步回写方法论卡片库
                    </label>
                  </label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    {highFreqCards.slice(0, 14).map((hc) => {
                      const active = dailyForm.credibilityAdjustments.some((x) => x.cardId === hc.id);
                      return (
                        <button
                          key={hc.id}
                          type="button"
                          className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                          onClick={() => toggleHighFreqAdjustment(hc.id)}
                        >
                          {hc.id} ({hc.credibilityScore})
                        </button>
                      );
                    })}
                  </div>
                  {dailyForm.credibilityAdjustments.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {dailyForm.credibilityAdjustments.map((adj, idx) => (
                        <div key={adj.cardId} style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'var(--bg-soft)', padding: 8, borderRadius: 7 }}>
                          <span className="badge badge-navy mono">卡片 {adj.cardId}</span>
                          <select
                            className="select"
                            style={{ width: 155, padding: '5px 8px', fontSize: 12 }}
                            value={adj.delta}
                            onChange={(e) =>
                              setDailyForm((p) => ({
                                ...p,
                                credibilityAdjustments: p.credibilityAdjustments.map((x, i) =>
                                  i === idx ? { ...x, delta: Number(e.target.value) } : x
                                ),
                              }))
                            }
                          >
                            <option value={0}>维持现值 (+0)</option>
                            <option value={0.1}>验证为真 (+0.1)</option>
                            <option value={-0.15}>证伪 (-0.15)</option>
                          </select>
                          <input
                            className="input"
                            style={{ padding: '5px 8px', fontSize: 12.5 }}
                            placeholder="填写当日复盘依据（如封存维持/边际递减/独立验证理由）..."
                            value={adj.reason}
                            onChange={(e) =>
                              setDailyForm((p) => ({
                                ...p,
                                credibilityAdjustments: p.credibilityAdjustments.map((x, i) =>
                                  i === idx ? { ...x, reason: e.target.value } : x
                                ),
                              }))
                            }
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid-2">
                  <div className="field-group">
                    <label className="field-label">八、方法论失效 vs 应用错误</label>
                    <input className="input" style={{ marginBottom: 6 }} placeholder="方法论失效（无/具体说明）" value={dailyForm.methodFailure} onChange={(e) => setDailyForm({ ...dailyForm, methodFailure: e.target.value })} />
                    <input className="input" placeholder="应用错误（无新增/具体教训）" value={dailyForm.applicationError} onChange={(e) => setDailyForm({ ...dailyForm, applicationError: e.target.value })} />
                  </div>
                  <div className="field-group">
                    <label className="field-label">九、行为金融检视（锚定/近因/处置/叙事拥挤）</label>
                    <textarea className="textarea" style={{ minHeight: 74 }} value={dailyForm.behavioralReview} onChange={(e) => setDailyForm({ ...dailyForm, behavioralReview: e.target.value })} />
                  </div>
                </div>

                <div className="grid-2">
                  <div className="field-group">
                    <label className="field-label">十、评分加扣分依据 & 市场状态</label>
                    <input className="input" style={{ marginBottom: 6 }} placeholder="加分项 / 扣分项（外部二元事件扣分封顶 -1.5）" value={dailyForm.scoreReason} onChange={(e) => setDailyForm({ ...dailyForm, scoreReason: e.target.value })} />
                    <input className="input" placeholder="市场状态（投机 / 趋势成长 / 防御）" value={dailyForm.marketState} onChange={(e) => setDailyForm({ ...dailyForm, marketState: e.target.value })} />
                  </div>
                  <div className="field-group">
                    <label className="field-label">次日跟踪锚（①②③...）与数据缺口登记</label>
                    <textarea className="textarea" style={{ minHeight: 74 }} value={dailyForm.nextAnchors} onChange={(e) => setDailyForm({ ...dailyForm, nextAnchors: e.target.value })} />
                  </div>
                </div>

                <div className="field-group">
                  <label className="field-label">缺口登记</label>
                  <input className="input" value={dailyForm.gaps} onChange={(e) => setDailyForm({ ...dailyForm, gaps: e.target.value })} />
                </div>
              </div>
            </div>
          </div>
      </div>

      {/* 子视图 4：发起标的研判向导（工作模式二，Keep-Alive 不卸载） */}
      <div className="scroll-page" style={{ display: subView === 'createJudgment' ? 'block' : 'none' }}>
        <div style={{ maxWidth: 1020 }}>
          <AiJudgmentPanel
            aiConfig={aiConfig}
            currentForm={judgeForm}
            recentJudgmentJob={recentJudgmentJob}
            externalTargetQuery={judgeForm.target}
            externalQuickTrigger={quickJudgeTrigger}
            existingJudgments={ledger.judgments}
            onJumpToJudgment={jumpToJudgment}
            onPreviewJudgment={(id) => onPreviewEntity?.({ kind: 'judgment', id })}
            onJobStarted={onJobStarted}
            onJobFinished={onJobFinished}
            onDraftGenerated={(formPatch) => {
              setJudgeForm((prev) => ({
                ...prev,
                ...formPatch,
                recordKey: prev.recordKey || formPatch.recordKey || ledger.stats.nextJudgmentKey,
              }));
            }}
            onOpenAiSettings={onOpenAiSettings}
            onToast={onToast}
          />
          <div className="panel">
            <div className="panel-header">
              <h3 className="panel-title">
                <Target size={16} color="var(--amber)" />
                工作模式二 · 标的研判向导（自动分配 {judgeForm.recordKey}）
              </h3>
              <button
                type="button"
                className="btn btn-amber btn-sm"
                onClick={() =>
                  onRequestMutation('ledger.createJudgment', judgeForm, () => {
                    setSubView('judgments');
                  })
                }
              >
                预览变更 Diff 并写入台账
              </button>
            </div>
            <div className="panel-pad">
              <div className="grid-3">
                <div className="field-group">
                  <label className="field-label">研判编号</label>
                  <input className="input mono" value={judgeForm.recordKey} onChange={(e) => setJudgeForm({ ...judgeForm, recordKey: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">标的名称与代码 <span className="field-req">*</span></label>
                  <input className="input" placeholder="例：强一股份（688809.SH）或 英伟达（NVDA.US）" value={judgeForm.target} onChange={(e) => setJudgeForm({ ...judgeForm, target: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">综合评分 (1-10) / 数据截止日</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="input" style={{ width: 90 }} value={judgeForm.score} onChange={(e) => setJudgeForm({ ...judgeForm, score: e.target.value })} />
                    <input className="input" value={judgeForm.dataCutoff} onChange={(e) => setJudgeForm({ ...judgeForm, dataCutoff: e.target.value })} />
                  </div>
                </div>
              </div>

              <div className="field-group">
                <label className="field-label">一句话综合结论 <span className="field-req">*</span></label>
                <textarea className="textarea" style={{ minHeight: 68 }} value={judgeForm.conclusion} onChange={(e) => setJudgeForm({ ...judgeForm, conclusion: e.target.value })} />
              </div>

              <div className="field-group">
                <label className="field-label">一、产业定位（产业链位置、供需格局、核心驱动变量）</label>
                <textarea className="textarea" style={{ minHeight: 68 }} value={judgeForm.industryPosition} onChange={(e) => setJudgeForm({ ...judgeForm, industryPosition: e.target.value })} />
              </div>

              <div className="grid-2">
                <div className="field-group">
                  <label className="field-label">二、多头核心论断（3-5条，注明卡号与适用条件状态）</label>
                  <textarea className="textarea" value={judgeForm.bullArgs} onChange={(e) => setJudgeForm({ ...judgeForm, bullArgs: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">二、空头核心论断（3-5条，注明卡号与风险点）</label>
                  <textarea className="textarea" value={judgeForm.bearArgs} onChange={(e) => setJudgeForm({ ...judgeForm, bearArgs: e.target.value })} />
                </div>
              </div>

              <div className="grid-2">
                <div className="field-group">
                  <label className="field-label">三、交易结构（介入触发器、失效离场条件、双线仓位边界）</label>
                  <textarea className="textarea" value={judgeForm.tradingStructure} onChange={(e) => setJudgeForm({ ...judgeForm, tradingStructure: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">四、行为金融检视（市场认知偏差 + 自身最易犯错误）</label>
                  <textarea className="textarea" value={judgeForm.behavioralCheck} onChange={(e) => setJudgeForm({ ...judgeForm, behavioralCheck: e.target.value })} />
                </div>
              </div>

              <div className="field-group">
                <label className="field-label">五、关键假设清单（每条须含验证方式 + 验证时点 + 证伪条件）<span className="field-req">*</span></label>
                {judgeForm.hypotheses.map((h, idx) => (
                  <div key={idx} className="grid-2" style={{ background: 'var(--bg-soft)', padding: 10, borderRadius: 8, marginBottom: 8 }}>
                    <input
                      className="input"
                      placeholder={`假设 H${idx + 1} 主张内容`}
                      value={h.claim}
                      onChange={(e) =>
                        setJudgeForm((p) => ({
                          ...p,
                          hypotheses: p.hypotheses.map((x, i) => (i === idx ? { ...x, claim: e.target.value } : x)),
                        }))
                      }
                    />
                    <input
                      className="input"
                      placeholder="验证方式（如季报毛利率/公告）"
                      value={h.verifyMethod}
                      onChange={(e) =>
                        setJudgeForm((p) => ({
                          ...p,
                          hypotheses: p.hypotheses.map((x, i) => (i === idx ? { ...x, verifyMethod: e.target.value } : x)),
                        }))
                      }
                    />
                    <input
                      className="input"
                      placeholder="验证时点（如 2027-04 年报季）"
                      value={h.verifyDate}
                      onChange={(e) =>
                        setJudgeForm((p) => ({
                          ...p,
                          hypotheses: p.hypotheses.map((x, i) => (i === idx ? { ...x, verifyDate: e.target.value } : x)),
                        }))
                      }
                    />
                    <input
                      className="input"
                      placeholder="证伪条件（出现什么即判定假设失效）"
                      value={h.falsifyCond}
                      onChange={(e) =>
                        setJudgeForm((p) => ({
                          ...p,
                          hypotheses: p.hypotheses.map((x, i) => (i === idx ? { ...x, falsifyCond: e.target.value } : x)),
                        }))
                      }
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    setJudgeForm((p) => ({
                      ...p,
                      hypotheses: [...p.hypotheses, { claim: '', verifyMethod: '', verifyDate: '', falsifyCond: '' }],
                    }))
                  }
                >
                  <Plus size={13} /> 添加一条关键假设
                </button>
              </div>

              <div className="grid-2">
                <div className="field-group">
                  <label className="field-label">引用方法论卡片编号</label>
                  <input className="input" placeholder="例：209/212/213/163" value={judgeForm.methodIds} onChange={(e) => setJudgeForm({ ...judgeForm, methodIds: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">引用产业认知卡编号</label>
                  <input className="input" placeholder="例：135/136/138" value={judgeForm.cognitionIds} onChange={(e) => setJudgeForm({ ...judgeForm, cognitionIds: e.target.value })} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* P0-1 子视图：研判 T+N 自动回填追踪 & 否决观察池 */}
      {subView === 'tracker' && (
        <div className="scroll-page">
          <JudgmentTrackerPanel
            onOpenEntity={(ref) => {
              if (ref.kind === 'judgment') {
                setSelectedJudgeId(ref.id);
                setSubView('judgments');
              } else {
                onOpenEntity(ref);
              }
            }}
            onOpenTechnical={onOpenTechnical}
            onToast={onToast}
          />
        </div>
      )}

      {/* P2-2 子视图：周度 / 月度聚合复盘与 HTML 导出 */}
      {subView === 'periodic' && (
        <div className="scroll-page">
          <PeriodicReviewPanel
            aiConfig={aiConfig}
            theme={theme}
            onOpenEntity={(ref) => {
              if (ref.kind === 'daily') {
                setSelectedDailyId(ref.id);
                setSubView('daily');
              } else {
                onOpenEntity(ref);
              }
            }}
            onOpenAiSettings={onOpenAiSettings}
            onToast={onToast}
          />
        </div>
      )}

      {/* 草稿 HTML 可视化预览与导出模态框 */}
      {draftHtmlPreview && (
        <div className="modal-backdrop" onClick={() => setDraftHtmlPreview(null)}>
          <div
            className="modal-box"
            style={{ maxWidth: '94vw', width: 1160, height: '90vh', maxHeight: '90vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
                <LayoutGrid size={16} color="var(--navy)" />
                每日复盘可视化 HTML 研报预览 · <span className="mono">{draftHtmlPreview.fileName}</span>
              </div>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => handleDownloadHtmlText(draftHtmlPreview.html, draftHtmlPreview.fileName)}
                >
                  <Download size={13} /> 下载独立 HTML 分享
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={savingHtml}
                  onClick={handleSaveDraftHtmlToDisk}
                >
                  <FolderDown size={13} /> {savingHtml ? '保存中...' : '存至本地 复盘简报HTML/'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraftHtmlPreview(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>
            <iframe
              title="草稿可视化 HTML 预览"
              srcDoc={draftHtmlPreview.html}
              style={{ flex: 1, width: '100%', border: 'none', background: 'var(--bg)' }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
