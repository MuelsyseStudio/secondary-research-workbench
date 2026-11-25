import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Award,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code2,
  Edit3,
  Flame,
  GitBranch,
  History,
  Link2,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  Scale,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { api } from '../api';
import type {
  AiSafeConfig,
  BackgroundJobSummary,
  EntityRef,
  KbCardTimelineResponse,
  MethodologyCard,
  QuickDraftNotePayload,
  WorkspaceData,
} from '../types';
import { useI18n } from '../i18n';
import { CardLinkText } from '../components/CardLinkText';
import { MarkdownBlock } from '../components/MarkdownBlock';
import { AiIngestionModal } from '../components/AiIngestionModal';

const DOMAIN_LABELS: Record<string, [string, string]> = {
  macro: ['宏观利率', 'Macro'],
  asset_allocation: ['资产配置', 'Allocation'],
  industry_research: ['产业研究', 'Industry'],
  valuation: ['估值定价', 'Valuation'],
  financial_forensics: ['财报排雷', 'Forensics'],
  technical: ['技术分析', 'Technical'],
  trend_trading: ['趋势波段', 'Trend'],
  short_term_sentiment: ['短线情绪', 'Sentiment'],
  quant: ['量化回测', 'Quant'],
  derivatives: ['衍生品', 'Derivatives'],
  behavioral: ['行为金融', 'Behavioral'],
  risk_position: ['风控仓位', 'Risk/Pos'],
  policy_event: ['政策事件', 'Policy'],
};

const REGIME_LABELS: Record<string, [string, string]> = {
  all: ['全市场态', 'All Regimes'],
  bull_main_wave: ['主升浪', 'Bull Main'],
  structural_rotation: ['结构轮动', 'Rotation'],
  weak_choppy: ['弱市震荡', 'Weak Chop'],
  bear_liquidity_crunch: ['流动性挤兑', 'Liquidity Crunch'],
  sentiment_ice_point: ['情绪冰点', 'Ice Point'],
  sentiment_climax: ['情绪高潮', 'Climax'],
  supply_inflation_shock: ['供给通胀冲击', 'Inflation Shock'],
  growth_slowdown: ['增长放缓', 'Slowdown'],
};

const HORIZON_LABELS: Record<string, [string, string]> = {
  intraday: ['日内', 'Intraday'],
  swing_days: ['短线数日', 'Swing Days'],
  tactical_weeks: ['波段数周', 'Tactical Wks'],
  cyclical_quarters: ['周期季度', 'Cyclical Qtrs'],
  secular_years: ['长期多年', 'Secular Yrs'],
};

function parseKbIdToEntityRef(raw: string): EntityRef | null {
  const s = String(raw || '').trim();
  const mM = s.match(/^M[:\-]?(\d+)$/i);
  if (mM) return { kind: 'methodology', id: mM[1].padStart(3, '0') };
  const mC = s.match(/^C[:\-]?(\d+)$/i);
  if (mC) return { kind: 'cognition', id: mC[1].padStart(3, '0') };
  const mCf = s.match(/^CF[:\-]?(\d+)$/i);
  if (mCf) return { kind: 'conflict', id: String(Number(mCf[1])) };
  return null;
}

interface MethodologyPageProps {
  workspace: WorkspaceData;
  aiConfig: AiSafeConfig | null;
  recentIngestJob?: BackgroundJobSummary | null;
  onJobStarted?: (job: BackgroundJobSummary) => void;
  onJobFinished?: () => void;
  initialCardId?: string | null;
  initialConflictId?: string | null;
  initialModal?: 'createCard' | 'aiIngest' | null;
  initialDraftNote?: QuickDraftNotePayload | null;
  onDraftNoteAccepted?: (noteId: string, target: 'cognition' | 'method' | 'judgment') => void;
  onConsumeInitial?: () => void;
  onOpenEntity: (ref: EntityRef) => void;
  onOpenAiSettings: () => void;
  onRequestMutation: (action: string, payload: Record<string, unknown>, onSuccess?: () => void) => void;
  onToast: (msg: string) => void;
}

export const MethodologyPage: React.FC<MethodologyPageProps> = ({
  workspace,
  aiConfig,
  recentIngestJob,
  onJobStarted,
  onJobFinished,
  initialCardId,
  initialConflictId,
  initialModal,
  initialDraftNote,
  onDraftNoteAccepted,
  onConsumeInitial,
  onOpenEntity,
  onOpenAiSettings,
  onRequestMutation,
  onToast,
}) => {
  const { t } = useI18n();
  const { methodology, backlinks } = workspace;

  const [subView, setSubView] = useState<'cards' | 'conflicts' | 'logs'>('cards');
  const [search, setSearch] = useState('');
  const [sectionFilter, setSectionFilter] = useState('ALL');
  const [credFilter, setCredFilter] = useState<'ALL' | 'HIGH' | 'MID' | 'LOW' | 'REVIEWS' | 'AMENDED' | 'VERIFY'>('ALL');
  const [domainFilter, setDomainFilter] = useState('ALL');
  const [regimeFilter, setRegimeFilter] = useState('ALL');
  const [horizonFilter, setHorizonFilter] = useState('ALL');
  const [showOrthoFilters, setShowOrthoFilters] = useState(true);
  const [selectedCardId, setSelectedCardId] = useState<string>(methodology.cards[0]?.id || '001');
  const [selectedConflictId, setSelectedConflictId] = useState<number>(
    methodology.conflicts[methodology.conflicts.length - 1]?.id || 1
  );

  // KB v2 逐日复盘实证时间轴 (review-log.jsonl) 懒加载状态
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [timelineCache, setTimelineCache] = useState<Record<string, KbCardTimelineResponse>>({});
  const [timelineLoadingId, setTimelineLoadingId] = useState<string | null>(null);
  const [timelineErrors, setTimelineErrors] = useState<Record<string, string>>({});

  const hasV2Meta = useMemo(
    () => workspace.kbMode === 'v2' || methodology.cards.some((c) => Boolean(c.v2Meta)),
    [workspace.kbMode, methodology.cards]
  );

  const orthogonalOptions = useMemo(() => {
    const domains = new Set<string>();
    const regimes = new Set<string>();
    const horizons = new Set<string>();
    for (const c of methodology.cards) {
      for (const d of c.v2Meta?.domains || []) domains.add(d);
      for (const r of c.v2Meta?.regimes || []) regimes.add(r);
      for (const h of c.v2Meta?.horizons || []) horizons.add(h);
    }
    return {
      domains: [...domains].sort(),
      regimes: [...regimes].sort(),
      horizons: [...horizons].sort(),
    };
  }, [methodology.cards]);

  const formatDomain = (d: string) => (DOMAIN_LABELS[d] ? t(DOMAIN_LABELS[d][0], DOMAIN_LABELS[d][1]) : d);
  const formatRegime = (r: string) => (REGIME_LABELS[r] ? t(REGIME_LABELS[r][0], REGIME_LABELS[r][1]) : r);
  const formatHorizon = (h: string) => (HORIZON_LABELS[h] ? t(HORIZON_LABELS[h][0], HORIZON_LABELS[h][1]) : h);

  useEffect(() => {
    setTimelineExpanded(false);
  }, [selectedCardId]);

  useEffect(() => {
    setTimelineCache({});
    setTimelineErrors({});
  }, [workspace.loadedAt]);

  const fetchCardTimeline = async (kbId: string, force = false) => {
    if (!force && timelineCache[kbId]) return;
    setTimelineLoadingId(kbId);
    setTimelineErrors((prev) => {
      const next = { ...prev };
      delete next[kbId];
      return next;
    });
    try {
      const res = await api.kbCardTimeline(kbId);
      setTimelineCache((prev) => ({ ...prev, [kbId]: res }));
    } catch (err: any) {
      setTimelineErrors((prev) => ({
        ...prev,
        [kbId]: err?.message || t('加载实证时间轴失败', 'Failed to load empirical timeline'),
      }));
    } finally {
      setTimelineLoadingId((cur) => (cur === kbId ? null : cur));
    }
  };

  // Modals
  const [showCreateCard, setShowCreateCard] = useState(false);
  const [showAiIngest, setShowAiIngest] = useState(false);
  const [ingestInitialMode, setIngestInitialMode] = useState<'document' | 'voice'>('document');
  const [showAmendModal, setShowAmendModal] = useState(false);
  const [showCredModal, setShowCredModal] = useState(false);
  const [showRawEditModal, setShowRawEditModal] = useState(false);
  const [showCreateConflict, setShowCreateConflict] = useState(false);

  // Form states
  const [newCardForm, setNewCardForm] = useState({
    system: '',
    topic: '',
    batchNote: '日常研学入库',
    newSectionTitle: '',
    coreThesis: '',
    logicChain: '',
    applicableConditions: '',
    invalidationSignals: '',
    historicalCases: '',
    credibility: '0.5',
    source: '',
  });
  const [amendForm, setAmendForm] = useState({ batchNote: '日常增订', content: '' });
  const [credForm, setCredForm] = useState({ delta: 0, shortNote: '', reason: '' });
  const [rawEditForm, setRawEditForm] = useState({ summary: '', rawMarkdown: '' });
  const [conflictForm, setConflictForm] = useState({ title: '', sides: '', conflictPoint: '', resolution: '' });

  useEffect(() => {
    if (initialDraftNote && initialDraftNote.target === 'method') {
      const symTag = initialDraftNote.symbol ? ` · ${initialDraftNote.symbol}` : '';
      setSubView('cards');
      setNewCardForm((prev) => ({
        ...prev,
        topic: `${initialDraftNote.tag}${symTag}`,
        coreThesis: initialDraftNote.text,
        source: `盘中闪念速记 (${initialDraftNote.createdAt.slice(0, 16).replace('T', ' ')})`,
      }));
      setShowCreateCard(true);
      onDraftNoteAccepted?.(initialDraftNote.noteId, 'method');
      onConsumeInitial?.();
      return;
    }
    if (initialCardId) {
      setSubView('cards');
      setSelectedCardId(initialCardId);
      onConsumeInitial?.();
    } else if (initialConflictId) {
      setSubView('conflicts');
      setSelectedConflictId(Number(initialConflictId));
      onConsumeInitial?.();
    } else if (initialModal === 'createCard') {
      setSubView('cards');
      setShowCreateCard(true);
      onConsumeInitial?.();
    } else if (initialModal === 'aiIngest') {
      setSubView('cards');
      setShowAiIngest(true);
      onConsumeInitial?.();
    }
  }, [initialCardId, initialConflictId, initialModal, initialDraftNote, onDraftNoteAccepted, onConsumeInitial]);

  const filteredCards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return methodology.cards.filter((c) => {
      if (sectionFilter !== 'ALL' && c.sectionTitle !== sectionFilter) return false;
      if (credFilter === 'HIGH' && (c.credibilityScore ?? 0) < 0.7) return false;
      if (credFilter === 'MID' && ((c.credibilityScore ?? 0) < 0.5 || (c.credibilityScore ?? 0) >= 0.7)) return false;
      if (credFilter === 'LOW' && (c.credibilityScore ?? 1) >= 0.5) return false;
      if (credFilter === 'REVIEWS' && c.reviewLogs.length === 0) return false;
      if (credFilter === 'AMENDED' && c.amendments.length === 0) return false;
      if (credFilter === 'VERIFY' && !c.isPendingVerify) return false;
      if (domainFilter !== 'ALL' && !(c.v2Meta?.domains || []).includes(domainFilter)) return false;
      if (regimeFilter !== 'ALL' && !(c.v2Meta?.regimes || []).includes(regimeFilter)) return false;
      if (horizonFilter !== 'ALL' && !(c.v2Meta?.horizons || []).includes(horizonFilter)) return false;
      if (!q) return true;
      return (
        c.id.includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.system.toLowerCase().includes(q) ||
        c.coreThesis.toLowerCase().includes(q) ||
        c.source.toLowerCase().includes(q) ||
        c.rawMarkdown.toLowerCase().includes(q)
      );
    });
  }, [methodology.cards, search, sectionFilter, credFilter, domainFilter, regimeFilter, horizonFilter]);

  const selectedCard: MethodologyCard | undefined =
    methodology.cards.find((c) => c.id === selectedCardId) || filteredCards[0];

  const selectedConflict =
    methodology.conflicts.find((c) => c.id === selectedConflictId) || methodology.conflicts[0];

  const cardBacklinks = selectedCard ? backlinks.methodBacklinks[selectedCard.id] || [] : [];

  const openRawEditor = () => {
    if (!selectedCard) return;
    setRawEditForm({
      summary: `定向修订卡片 ${selectedCard.id}`,
      rawMarkdown: selectedCard.rawMarkdown,
    });
    setShowRawEditModal(true);
  };

  const openCredModal = () => {
    setCredForm({ delta: 0, shortNote: '', reason: '' });
    setShowCredModal(true);
  };

  const credBadgeClass = (score: number | null) => {
    if (score === null) return 'badge-muted';
    if (score >= 0.8) return 'badge-emerald';
    if (score >= 0.65) return 'badge-navy';
    if (score >= 0.45) return 'badge-amber';
    return 'badge-crimson';
  };

  return (
    <div className="page-viewport">
      {/* 二级子工具条 */}
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
            className={`seg-tab ${subView === 'cards' ? 'active' : ''}`}
            onClick={() => setSubView('cards')}
          >
            <BookOpen size={14} /> {t('方法论卡片', 'Methodology Cards')} ({methodology.stats.totalTitles})
          </button>
          <button
            type="button"
            className={`seg-tab ${subView === 'conflicts' ? 'active' : ''}`}
            onClick={() => setSubView('conflicts')}
          >
            <Flame size={14} /> {t('冲突矩阵', 'Conflict Matrix')} ({methodology.stats.conflictCount})
          </button>
          <button
            type="button"
            className={`seg-tab ${subView === 'logs' ? 'active' : ''}`}
            onClick={() => setSubView('logs')}
          >
            <History size={14} /> {t('历史入库清单', 'Ingestion Logs')} ({methodology.ingestionLogs.length})
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setIngestInitialMode('voice');
              setShowAiIngest(true);
            }}
            title={t('实时语音口述或上传录音，一键清洗并 AI 转化为方法论卡片', 'Voice dictation or audio-to-card AI ingestion')}
          >
            <Mic size={14} color="var(--amber)" /> {t('语音输入转化', 'Voice Ingest')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setIngestInitialMode('document');
              setShowAiIngest(true);
            }}
          >
            <Sparkles size={14} color="var(--navy)" /> {t('AI 文献/文档转化', 'AI Doc Ingest')}
          </button>
          {subView === 'conflicts' ? (
            <button type="button" className="btn btn-danger btn-sm" onClick={() => setShowCreateConflict(true)}>
              <Plus size={14} /> {t('新增冲突', 'New Conflict')} #{methodology.stats.nextConflictId}
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowCreateCard(true)}>
              <Plus size={14} /> {t('新建方法论卡片', 'New Card')} ({methodology.stats.nextCardId})
            </button>
          )}
        </div>
      </div>

      {/* 子视图 1：方法论卡片 Master-Detail */}
      {subView === 'cards' && (
        <div className="split-workbench">
          <div className="list-pane">
            <div className="list-pane-header">
              <div style={{ position: 'relative' }}>
                <Search
                  size={14}
                  color="var(--text-muted)"
                  style={{ position: 'absolute', left: 10, top: 10 }}
                />
                <input
                  className="input"
                  style={{ paddingLeft: 30 }}
                  placeholder={t('搜卡号、主题、核心论断、来源...', 'Search ID, topic, thesis, source...')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              <select
                className="select"
                value={sectionFilter}
                onChange={(e) => setSectionFilter(e.target.value)}
                style={{ fontSize: 12.5, padding: '6px 9px' }}
              >
                <option value="ALL">{t(`全部章节（${methodology.sections.length} 编）`, `All Sections (${methodology.sections.length})`)}</option>
                {methodology.sections.map((s) => (
                  <option key={s.title} value={s.title}>
                    {s.title}
                  </option>
                ))}
              </select>

              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {(
                  [
                    ['ALL', t('全部', 'All')],
                    ['HIGH', t('高确信 ≥0.7', 'High ≥0.7')],
                    ['REVIEWS', `${t('含复盘', 'Reviewed')} (${methodology.stats.withReviewsCount})`],
                    ['AMENDED', t('含增订', 'Amended')],
                    ['VERIFY', `${t('待核', 'Verify')} (${methodology.stats.pendingVerifyCount})`],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`btn btn-sm ${credFilter === k ? 'btn-primary' : ''}`}
                    style={{ padding: '2px 8px', fontSize: 11.5 }}
                    onClick={() => setCredFilter(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* KB v2 正交维度筛选条（domain / regime / horizon） */}
              {hasV2Meta &&
                (orthogonalOptions.domains.length > 0 ||
                  orthogonalOptions.regimes.length > 0 ||
                  orthogonalOptions.horizons.length > 0) && (
                  <div
                    style={{
                      padding: '6px 8px',
                      borderRadius: 7,
                      background: 'var(--bg-soft)',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 5,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => setShowOrthoFilters((v) => !v)}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          padding: 0,
                          fontSize: 11,
                          fontWeight: 700,
                          color: 'var(--teal)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        {showOrthoFilters ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        {t('KB v2 正交维度筛选', 'KB v2 Orthogonal Filters')}
                      </button>
                      {(domainFilter !== 'ALL' || regimeFilter !== 'ALL' || horizonFilter !== 'ALL') && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '0px 6px', fontSize: 10.5 }}
                          onClick={() => {
                            setDomainFilter('ALL');
                            setRegimeFilter('ALL');
                            setHorizonFilter('ALL');
                          }}
                        >
                          {t('清空', 'Reset')}
                        </button>
                      )}
                    </div>

                    {showOrthoFilters && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {orthogonalOptions.domains.length > 0 && (
                          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginRight: 2 }}>{t('领域', 'Dom')}:</span>
                            {orthogonalOptions.domains.map((d) => (
                              <button
                                key={d}
                                type="button"
                                className={`btn btn-sm ${domainFilter === d ? 'btn-teal' : ''}`}
                                style={{ padding: '1px 6px', fontSize: 10.5 }}
                                onClick={() => setDomainFilter((cur) => (cur === d ? 'ALL' : d))}
                              >
                                {formatDomain(d)}
                              </button>
                            ))}
                          </div>
                        )}
                        {orthogonalOptions.regimes.length > 0 && (
                          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginRight: 2 }}>{t('市场态', 'Reg')}:</span>
                            {orthogonalOptions.regimes.map((r) => (
                              <button
                                key={r}
                                type="button"
                                className={`btn btn-sm ${regimeFilter === r ? 'btn-amber' : ''}`}
                                style={{ padding: '1px 6px', fontSize: 10.5 }}
                                onClick={() => setRegimeFilter((cur) => (cur === r ? 'ALL' : r))}
                              >
                                {formatRegime(r)}
                              </button>
                            ))}
                          </div>
                        )}
                        {orthogonalOptions.horizons.length > 0 && (
                          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginRight: 2 }}>{t('周期', 'Hor')}:</span>
                            {orthogonalOptions.horizons.map((h) => (
                              <button
                                key={h}
                                type="button"
                                className={`btn btn-sm ${horizonFilter === h ? 'btn-primary' : ''}`}
                                style={{ padding: '1px 6px', fontSize: 10.5 }}
                                onClick={() => setHorizonFilter((cur) => (cur === h ? 'ALL' : h))}
                              >
                                {formatHorizon(h)}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {t('显示', 'Showing')} <strong className="num">{filteredCards.length}</strong> / {methodology.stats.totalTitles}
                {methodology.stats.declaredMissing.length > 0 || methodology.stats.revokedCount > 0
                  ? `（${
                      methodology.stats.declaredMissing.length > 0
                        ? `${t('缺号', 'Gap')} ${methodology.stats.declaredMissing.join('/')}`
                        : ''
                    }${
                      methodology.stats.declaredMissing.length > 0 && methodology.stats.revokedCount > 0 ? '，' : ''
                    }${methodology.stats.revokedCount > 0 ? `${t('已撤销', 'Revoked')} ${methodology.stats.revokedCount}` : ''}）`
                  : ''}
              </div>
            </div>

            <div className="list-pane-scroll">
              {filteredCards.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`list-card ${selectedCard?.id === c.id ? 'selected' : ''}`}
                  onClick={() => setSelectedCardId(c.id)}
                >
                  <div className="list-card-top">
                    <span className="badge badge-navy mono">卡片 {c.id}</span>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {c.isRevoked && <span className="badge badge-crimson">撤销</span>}
                      {c.isArchived && <span className="badge badge-violet">封存</span>}
                      {c.isHighPaused && <span className="badge badge-amber">高位暂停</span>}
                      {!c.isRevoked && (
                        <span className={`badge num ${credBadgeClass(c.credibilityScore)}`}>
                          {c.credibilityScore ?? '-'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="list-card-title">{c.title}</div>
                  <div className="list-card-sub">
                    <span>{c.system}</span>
                    {c.reviewLogs.length > 0 && (
                      <span className="badge badge-muted" style={{ fontSize: 10.5 }}>
                        复盘 {c.reviewLogs.length}
                      </span>
                    )}
                    {c.v2Meta && (c.v2Meta.independentChains || 0) > 0 && (
                      <span className="badge badge-teal num" style={{ fontSize: 10 }}>
                        {t(`独立链 ${c.v2Meta.independentChains}`, `${c.v2Meta.independentChains} chains`)}
                      </span>
                    )}
                    {c.amendments.length > 0 && (
                      <span className="badge badge-muted" style={{ fontSize: 10.5 }}>
                        增订 {c.amendments.length}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 右侧详情与维护区 */}
          <div className="detail-pane">
            {!selectedCard ? (
              <div className="empty-state">请从左侧选择一张方法论卡片</div>
            ) : (
              <div style={{ maxWidth: 920 }}>
                {/* 卡片头部 */}
                <div className="panel panel-pad" style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                        <span className="badge badge-navy mono">卡片 {selectedCard.id}</span>
                        <span className="badge badge-muted">{selectedCard.system}</span>
                        <span className={`badge num ${credBadgeClass(selectedCard.credibilityScore)}`}>
                          可信度 {selectedCard.credibilityScore ?? '-'}
                        </span>
                        {selectedCard.v2Meta?.cardKind && (
                          <span className="badge badge-muted mono" style={{ fontSize: 10.5 }}>
                            {selectedCard.v2Meta.cardKind}
                          </span>
                        )}
                        {selectedCard.v2Meta?.verificationTier && (
                          <span
                            className={`badge mono ${
                              /gold|high|verified|core|tier_1|tier1/i.test(selectedCard.v2Meta.verificationTier)
                                ? 'badge-emerald'
                                : /mid|tier_2|tier2|active/i.test(selectedCard.v2Meta.verificationTier)
                                ? 'badge-teal'
                                : 'badge-amber'
                            }`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
                          >
                            <Award size={11} /> {selectedCard.v2Meta.verificationTier}
                          </span>
                        )}
                        {selectedCard.v2Meta && typeof selectedCard.v2Meta.independentChains === 'number' && (
                          <span className="badge badge-teal num">
                            {t(`独立证据链 ${selectedCard.v2Meta.independentChains}`, `${selectedCard.v2Meta.independentChains} Indep. Chains`)}
                          </span>
                        )}
                        {selectedCard.v2Meta && typeof selectedCard.v2Meta.reviewEventCount === 'number' && (
                          <span className="badge badge-amber num">
                            {t(`复盘事件 ${selectedCard.v2Meta.reviewEventCount}`, `${selectedCard.v2Meta.reviewEventCount} Events`)}
                          </span>
                        )}
                        {selectedCard.isArchived && <span className="badge badge-violet">封存维持</span>}
                        {selectedCard.isHighPaused && <span className="badge badge-amber">高位暂停上调</span>}
                        {selectedCard.isPendingVerify && <span className="badge badge-amber">待核</span>}
                        {selectedCard.isPendingRetire && <span className="badge badge-crimson">【待淘汰】</span>}
                        {selectedCard.isRevoked && <span className="badge badge-crimson">已撤销保留编号</span>}
                      </div>
                      <h2 style={{ margin: '0 0 6px', fontSize: 19, lineHeight: 1.35, color: 'var(--text)' }}>
                        {selectedCard.title}
                      </h2>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        归属：{selectedCard.sectionTitle} · 正文行 L{selectedCard.startLine}–L{selectedCard.endLine}
                        {selectedCard.batchTag ? ` · ${selectedCard.batchTag}` : ''}
                      </div>

                      {selectedCard.v2Meta &&
                        ((selectedCard.v2Meta.domains?.length || 0) > 0 ||
                          (selectedCard.v2Meta.regimes?.length || 0) > 0 ||
                          (selectedCard.v2Meta.horizons?.length || 0) > 0) && (
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
                            {(selectedCard.v2Meta.domains || []).map((d) => (
                              <button
                                key={`cd-${d}`}
                                type="button"
                                className="badge badge-teal"
                                style={{ border: 'none', cursor: 'pointer', fontSize: 10.5 }}
                                onClick={() => setDomainFilter((cur) => (cur === d ? 'ALL' : d))}
                              >
                                {formatDomain(d)}
                              </button>
                            ))}
                            {(selectedCard.v2Meta.regimes || []).map((r) => (
                              <button
                                key={`cr-${r}`}
                                type="button"
                                className="badge badge-amber"
                                style={{ border: 'none', cursor: 'pointer', fontSize: 10.5 }}
                                onClick={() => setRegimeFilter((cur) => (cur === r ? 'ALL' : r))}
                              >
                                {formatRegime(r)}
                              </button>
                            ))}
                            {(selectedCard.v2Meta.horizons || []).map((h) => (
                              <button
                                key={`ch-${h}`}
                                type="button"
                                className="badge badge-navy"
                                style={{ border: 'none', cursor: 'pointer', fontSize: 10.5 }}
                                onClick={() => setHorizonFilter((cur) => (cur === h ? 'ALL' : h))}
                              >
                                {formatHorizon(h)}
                              </button>
                            ))}
                          </div>
                        )}
                    </div>

                    {!selectedCard.isRevoked && (
                      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                        <button type="button" className="btn btn-primary btn-sm" onClick={openCredModal}>
                          <Scale size={13} /> 复盘调可信度
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => { setAmendForm({ batchNote: '日常增订', content: '' }); setShowAmendModal(true); }}>
                          <GitBranch size={13} /> 追加增订
                        </button>
                        <button type="button" className="btn btn-sm" onClick={openRawEditor}>
                          <Edit3 size={13} /> 原文编辑
                        </button>
                      </div>
                    )}
                  </div>

                  {/* 可信度详情进度条 */}
                  {!selectedCard.isRevoked && (
                    <div style={{ marginTop: 12, paddingTop: 11, borderTop: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                        <span style={{ color: 'var(--text-muted)' }}>可信度原文：{selectedCard.credibilityRaw}</span>
                        <span className="mono" style={{ fontWeight: 700 }}>
                          {Math.round((selectedCard.credibilityScore ?? 0) * 100)}%
                        </span>
                      </div>
                      <div className="cred-bar-track">
                        <div
                          className="cred-bar-fill"
                          style={{
                            width: `${Math.round((selectedCard.credibilityScore ?? 0) * 100)}%`,
                            background:
                              (selectedCard.credibilityScore ?? 0) >= 0.8
                                ? 'var(--emerald)'
                                : (selectedCard.credibilityScore ?? 0) >= 0.6
                                ? 'var(--navy)'
                                : (selectedCard.credibilityScore ?? 0) >= 0.3
                                ? 'var(--amber)'
                                : 'var(--crimson)',
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* 核心字段区 */}
                <div className="field-block field-block-thesis">
                  <div className="field-block-label" style={{ color: 'var(--navy)' }}>核心论断</div>
                  <div style={{ fontSize: 14.5, lineHeight: 1.75, color: 'var(--text)' }}>
                    <CardLinkText text={selectedCard.coreThesis} onOpenEntity={onOpenEntity} />
                  </div>
                </div>

                {selectedCard.logicChain && (
                  <div className="field-block">
                    <div className="field-block-label">逻辑链条</div>
                    <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                      <CardLinkText text={selectedCard.logicChain} onOpenEntity={onOpenEntity} />
                    </div>
                  </div>
                )}

                <div className="grid-2">
                  <div className="field-block" style={{ marginBottom: 12 }}>
                    <div className="field-block-label">适用条件</div>
                    <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                      <CardLinkText text={selectedCard.applicableConditions} onOpenEntity={onOpenEntity} />
                    </div>
                  </div>

                  <div className="field-block field-block-danger" style={{ marginBottom: 12 }}>
                    <div className="field-block-label" style={{ color: 'var(--crimson)' }}>
                      <AlertTriangle size={13} /> 失效信号（可证伪判据）
                    </div>
                    <div style={{ color: 'var(--text)', lineHeight: 1.7 }}>
                      <CardLinkText text={selectedCard.invalidationSignals} onOpenEntity={onOpenEntity} />
                    </div>
                  </div>
                </div>

                <div className="field-block">
                  <div className="field-block-label">历史案例</div>
                  <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                    <CardLinkText text={selectedCard.historicalCases} onOpenEntity={onOpenEntity} />
                  </div>
                </div>

                <div className="field-block">
                  <div className="field-block-label">来源与溯源</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                    <CardLinkText text={selectedCard.source} onOpenEntity={onOpenEntity} />
                  </div>
                </div>

                {/* 版本增订记录 */}
                {selectedCard.amendments.length > 0 && (
                  <div className="panel panel-pad" style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 7 }}>
                      <Sparkles size={15} color="var(--violet)" />
                      历史版本增订（{selectedCard.amendments.length} 条 · 不覆盖原字段）
                    </div>
                    <div className="timeline-list">
                      {selectedCard.amendments.map((am, i) => (
                        <div key={i} className="timeline-item">
                          <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--violet)', marginBottom: 3 }}>
                            {am.label}
                          </div>
                          <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65 }}>
                            <CardLinkText text={am.content} onOpenEntity={onOpenEntity} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 实盘复盘验证记录轨迹 */}
                {selectedCard.reviewLogs.length > 0 && (
                  <div className="panel panel-pad" style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 7 }}>
                      <History size={15} color="var(--amber)" />
                      实盘复盘验证轨迹（共 {selectedCard.reviewLogs.length} 条，按最新倒序）
                    </div>
                    <div className="timeline-list">
                      {[...selectedCard.reviewLogs].reverse().map((rl, i) => (
                        <div key={i} className="timeline-item">
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                            <span className="badge badge-amber mono">{rl.label}</span>
                            {rl.date && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                style={{ padding: '1px 6px', fontSize: 11 }}
                                onClick={() => onOpenEntity({ kind: 'daily', id: `daily-${rl.date}` })}
                              >
                                查看当日台账 →
                              </button>
                            )}
                          </div>
                          <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65 }}>
                            <CardLinkText text={rl.content} onOpenEntity={onOpenEntity} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* KB v2 可折叠逐日复盘实证时间轴（按需懒加载 events/review-log.jsonl + 有向关系边） */}
                {(selectedCard.v2Meta?.kbId || workspace.kbMode === 'v2') && (() => {
                  const kbId = selectedCard.v2Meta?.kbId || `M:${selectedCard.id}`;
                  const tlData = timelineCache[kbId];
                  const tlEvents = tlData?.events || tlData?.reviewEvents || [];
                  const tlOutEdges = tlData?.edges?.out || tlData?.outEdges || [];
                  const tlInEdges = tlData?.edges?.in || tlData?.inEdges || [];
                  const tlLoading = timelineLoadingId === kbId;
                  const tlError = timelineErrors[kbId];
                  const eventCountBadge =
                    tlData ? tlEvents.length : selectedCard.v2Meta?.reviewEventCount ?? selectedCard.reviewLogs.length;

                  const verdictBadge = (v: string) => {
                    if (v === 'confirmed') return { cls: 'badge-emerald', label: t('验证为真', 'Confirmed') };
                    if (v === 'falsified') return { cls: 'badge-crimson', label: t('证伪', 'Falsified') };
                    if (v === 'regime_na') return { cls: 'badge-muted', label: t('市场态不适用', 'Regime N/A') };
                    if (v === 'data_gap') return { cls: 'badge-amber', label: t('数据缺口', 'Data Gap') };
                    return { cls: 'badge-navy', label: t('维持边界', 'Hold') };
                  };

                  return (
                    <div className="panel" style={{ marginBottom: 14 }}>
                      <div
                        className="panel-header"
                        style={{ cursor: 'pointer', userSelect: 'none' }}
                        onClick={() => {
                          const next = !timelineExpanded;
                          setTimelineExpanded(next);
                          if (next) fetchCardTimeline(kbId, false);
                        }}
                      >
                        <div className="panel-title" style={{ fontSize: 13.5 }}>
                          {timelineExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          <History size={15} color="var(--teal)" />
                          {t('逐日复盘实证时间轴 (review-log.jsonl)', 'Empirical Review Timeline (review-log.jsonl)')}
                          <span className="badge badge-teal num" style={{ fontSize: 11 }}>
                            {eventCountBadge} {t('条', 'events')}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                          {timelineExpanded && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={tlLoading}
                              onClick={() => fetchCardTimeline(kbId, true)}
                            >
                              <RefreshCw size={12} className={tlLoading ? 'spin' : ''} /> {t('刷新', 'Refresh')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => {
                              const next = !timelineExpanded;
                              setTimelineExpanded(next);
                              if (next) fetchCardTimeline(kbId, false);
                            }}
                          >
                            {timelineExpanded ? t('收起', 'Collapse') : t('展开加载', 'Expand & Load')}
                          </button>
                        </div>
                      </div>

                      {timelineExpanded && (
                        <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                          {tlLoading && !tlData ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text-muted)', padding: '10px 4px' }}>
                              <Loader2 size={14} className="spin" /> {t(`正在加载 ${kbId} 实证流水...`, `Loading timeline for ${kbId}...`)}
                            </div>
                          ) : tlError ? (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, color: 'var(--crimson)', fontSize: 12.5 }}>
                              <span>{tlError}</span>
                              <button type="button" className="btn btn-sm" onClick={() => fetchCardTimeline(kbId, true)}>
                                {t('重试', 'Retry')}
                              </button>
                            </div>
                          ) : tlEvents.length === 0 ? (
                            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '6px 2px' }}>
                              {t('该卡片在 events/review-log.jsonl 中暂无结构化复盘实证事件。', 'No structured review events recorded in review-log.jsonl for this card yet.')}
                            </div>
                          ) : (
                            <div className="timeline-list">
                              {[...tlEvents]
                                .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
                                .map((ev, idx) => {
                                  const vb = verdictBadge(ev.verdict);
                                  const chainId = ev.evidence_chain_id || ev.evidenceChainId;
                                  const delta = ev.legacy_delta ?? ev.legacyDelta ?? 0;
                                  const scoreAfter = ev.legacy_score_after ?? ev.legacyScoreAfter;
                                  return (
                                    <div key={ev.event_id || ev.eventId || `${ev.date}-${idx}`} className="timeline-item">
                                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                                          <span className="badge badge-muted mono">{ev.date || '-'}</span>
                                          <span className={`badge ${vb.cls}`}>{vb.label}</span>
                                          {chainId && (
                                            <span className="badge badge-teal mono" style={{ fontSize: 10.5 }}>
                                              {chainId}
                                            </span>
                                          )}
                                          {ev.regime && (
                                            <span className="badge badge-amber" style={{ fontSize: 10.5 }}>
                                              {formatRegime(ev.regime)}
                                            </span>
                                          )}
                                          {delta !== 0 && (
                                            <span className={`badge mono ${delta > 0 ? 'badge-emerald' : 'badge-crimson'}`}>
                                              {delta > 0 ? `+${delta}` : delta}
                                              {scoreAfter !== null && scoreAfter !== undefined ? ` → ${scoreAfter}` : ''}
                                            </span>
                                          )}
                                        </div>
                                        {ev.date && (
                                          <button
                                            type="button"
                                            className="btn btn-ghost btn-sm"
                                            style={{ padding: '1px 6px', fontSize: 11 }}
                                            onClick={() => onOpenEntity({ kind: 'daily', id: `daily-${ev.date}` })}
                                          >
                                            {t('查看当日台账 →', 'Open Daily Ledger →')}
                                          </button>
                                        )}
                                      </div>
                                      <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: 13 }}>
                                        <CardLinkText text={ev.note || ''} onOpenEntity={onOpenEntity} />
                                      </div>
                                    </div>
                                  );
                                })}
                            </div>
                          )}

                          {(tlOutEdges.length > 0 || tlInEdges.length > 0) && (
                            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 9 }}>
                              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>
                                {t(`SQLite 1-Hop 有向图谱边（出边 ${tlOutEdges.length} · 入边 ${tlInEdges.length}）`, `1-Hop Directed Graph Edges (${tlOutEdges.length} out · ${tlInEdges.length} in)`)}
                              </div>
                              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                {tlOutEdges.map((e, i) => {
                                  const targetId = e.target || e.target_id || '';
                                  const edgeType = e.type || e.edge_type || 'rel';
                                  const ref = parseKbIdToEntityRef(targetId);
                                  return (
                                    <button
                                      key={`out-${targetId}-${edgeType}-${i}`}
                                      type="button"
                                      className={`ref-chip ${
                                        ref?.kind === 'conflict'
                                          ? 'ref-chip-conflict'
                                          : ref?.kind === 'cognition'
                                          ? 'ref-chip-cognition'
                                          : 'ref-chip-method'
                                      }`}
                                      disabled={!ref}
                                      onClick={() => ref && onOpenEntity(ref)}
                                      title={e.note || targetId}
                                    >
                                      {edgeType} → {targetId}
                                    </button>
                                  );
                                })}
                                {tlInEdges.map((e, i) => {
                                  const sourceId = e.source || e.source_id || '';
                                  const edgeType = e.type || e.edge_type || 'rel';
                                  const ref = parseKbIdToEntityRef(sourceId);
                                  return (
                                    <button
                                      key={`in-${sourceId}-${edgeType}-${i}`}
                                      type="button"
                                      className="btn btn-sm"
                                      style={{ fontSize: 11, padding: '2px 7px' }}
                                      disabled={!ref}
                                      onClick={() => ref && onOpenEntity(ref)}
                                      title={e.note || sourceId}
                                    >
                                      {sourceId} ({edgeType}) →
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* 跨库双链 & 反向引用 */}
                <div className="panel panel-pad">
                  <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 7 }}>
                    <Link2 size={15} color="var(--teal)" />
                    跨三库关联网络（显式引用 & 反向引用 {cardBacklinks.length}）
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                    {selectedCard.references.methodIds.map((id) => (
                      <button key={`m-${id}`} type="button" className="ref-chip ref-chip-method" onClick={() => onOpenEntity({ kind: 'methodology', id })}>
                        引用卡片 {id}
                      </button>
                    ))}
                    {selectedCard.references.cognitionIds.map((id) => (
                      <button key={`c-${id}`} type="button" className="ref-chip ref-chip-cognition" onClick={() => onOpenEntity({ kind: 'cognition', id })}>
                        引用认知 {id}
                      </button>
                    ))}
                    {selectedCard.references.conflictIds.map((id) => (
                      <button key={`cf-${id}`} type="button" className="ref-chip ref-chip-conflict" onClick={() => onOpenEntity({ kind: 'conflict', id })}>
                        关联冲突 {id}
                      </button>
                    ))}
                    {selectedCard.references.methodIds.length + selectedCard.references.cognitionIds.length + selectedCard.references.conflictIds.length === 0 && (
                      <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>本卡暂无显式外链引用</span>
                    )}
                  </div>

                  {cardBacklinks.length > 0 && (
                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 9 }}>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>被以下条目引用：</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {cardBacklinks.slice(0, 24).map((bl, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className="btn btn-sm"
                            style={{ fontSize: 11.5, padding: '3px 8px' }}
                            onClick={() => onOpenEntity({ kind: bl.type, id: bl.id })}
                          >
                            {bl.label.slice(0, 34)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 子视图 2：冲突矩阵 */}
      {subView === 'conflicts' && (
        <div className="split-workbench">
          <div className="list-pane">
            <div className="list-pane-header">
              <div style={{ fontWeight: 700, fontSize: 13 }}>第十一编 · 方法论冲突矩阵（{methodology.conflicts.length} 项）</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                两篇文献正面矛盾时不强行二选一，必须给出「何时用 A、何时用 B」的判别变量
              </div>
            </div>
            <div className="list-pane-scroll">
              {[...methodology.conflicts].reverse().map((cf) => (
                <button
                  key={cf.id}
                  type="button"
                  className={`list-card ${selectedConflict?.id === cf.id ? 'selected' : ''}`}
                  onClick={() => setSelectedConflictId(cf.id)}
                >
                  <div className="list-card-top">
                    <span className="badge badge-crimson mono">冲突 {cf.id}</span>
                    {cf.versionTag && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{cf.versionTag}</span>}
                  </div>
                  <div className="list-card-title">{cf.title}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="detail-pane">
            {selectedConflict && (
              <div style={{ maxWidth: 880 }}>
                <div className="panel panel-pad" style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <span className="badge badge-crimson mono">冲突 {selectedConflict.id}</span>
                    {selectedConflict.versionTag && <span className="badge badge-muted">{selectedConflict.versionTag}</span>}
                  </div>
                  <h2 style={{ margin: 0, fontSize: 19 }}>{selectedConflict.title}</h2>
                </div>

                <div className="field-block">
                  <div className="field-block-label">对抗双方（观点 A vs 观点 B）</div>
                  <div style={{ lineHeight: 1.75 }}>
                    <CardLinkText text={selectedConflict.sides} onOpenEntity={onOpenEntity} />
                  </div>
                </div>

                <div className="field-block field-block-danger">
                  <div className="field-block-label" style={{ color: 'var(--crimson)' }}>核心冲突点</div>
                  <div style={{ lineHeight: 1.75 }}>
                    <CardLinkText text={selectedConflict.conflictPoint} onOpenEntity={onOpenEntity} />
                  </div>
                </div>

                <div className="field-block field-block-mapping">
                  <div className="field-block-label" style={{ color: 'var(--teal)' }}>折中思路与硬判别变量</div>
                  <div style={{ lineHeight: 1.75, color: 'var(--text)' }}>
                    <CardLinkText text={selectedConflict.resolution} onOpenEntity={onOpenEntity} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 子视图 3：入库清单日志 */}
      {subView === 'logs' && (
        <div className="scroll-page">
          <div style={{ maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[...methodology.ingestionLogs].reverse().map((log, idx) => (
              <div key={idx} className="panel panel-pad">
                <h3 style={{ margin: '0 0 10px', fontSize: 15.5, color: 'var(--navy)' }}>{log.title}</h3>
                <MarkdownBlock content={log.content} onOpenEntity={onOpenEntity} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 弹窗 1：新建方法论卡片 */}
      {showCreateCard && (
        <div className="modal-backdrop" onClick={() => setShowCreateCard(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                新建方法论卡片 · 自动分配编号 <span className="badge badge-navy mono">卡片 {methodology.stats.nextCardId}</span>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowCreateCard(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="grid-2">
                <div className="field-group">
                  <label className="field-label">体系名 <span className="field-req">*</span></label>
                  <input className="input" placeholder="例：产业研究 / 短线体系 / 估值体系" value={newCardForm.system} onChange={(e) => setNewCardForm({ ...newCardForm, system: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">主题名 <span className="field-req">*</span></label>
                  <input className="input" placeholder="例：半导体设备与材料周期解耦模型" value={newCardForm.topic} onChange={(e) => setNewCardForm({ ...newCardForm, topic: e.target.value })} />
                </div>
              </div>
              <div className="grid-2">
                <div className="field-group">
                  <label className="field-label">入库批次标注</label>
                  <input className="input" value={newCardForm.batchNote} onChange={(e) => setNewCardForm({ ...newCardForm, batchNote: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">可选：新建章节标题（留空则接在当前末尾编）</label>
                  <input className="input" placeholder="例：第十八编 XXX 专题" value={newCardForm.newSectionTitle} onChange={(e) => setNewCardForm({ ...newCardForm, newSectionTitle: e.target.value })} />
                </div>
              </div>
              <div className="field-group">
                <label className="field-label">核心论断（一句话可操作、可证伪）<span className="field-req">*</span></label>
                <textarea className="textarea" value={newCardForm.coreThesis} onChange={(e) => setNewCardForm({ ...newCardForm, coreThesis: e.target.value })} />
              </div>
              <div className="field-group">
                <label className="field-label">逻辑链条（A → B → C 因果传导）</label>
                <textarea className="textarea" style={{ minHeight: 62 }} value={newCardForm.logicChain} onChange={(e) => setNewCardForm({ ...newCardForm, logicChain: e.target.value })} />
              </div>
              <div className="grid-2">
                <div className="field-group">
                  <label className="field-label">适用条件</label>
                  <textarea className="textarea" value={newCardForm.applicableConditions} onChange={(e) => setNewCardForm({ ...newCardForm, applicableConditions: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label" style={{ color: 'var(--crimson)' }}>失效信号（契约铁律必填）<span className="field-req">*</span></label>
                  <textarea className="textarea" placeholder="出现什么事实即证伪本论断？写不出不得入库" value={newCardForm.invalidationSignals} onChange={(e) => setNewCardForm({ ...newCardForm, invalidationSignals: e.target.value })} />
                </div>
              </div>
              <div className="field-group">
                <label className="field-label">历史案例（日期 + 个股 + 数据）</label>
                <textarea className="textarea" style={{ minHeight: 62 }} value={newCardForm.historicalCases} onChange={(e) => setNewCardForm({ ...newCardForm, historicalCases: e.target.value })} />
              </div>
              <div className="grid-2">
                <div className="field-group">
                  <label className="field-label">初始可信度 [0, 1]（默认 0.5）</label>
                  <input className="input" type="number" step="0.05" min="0" max="1" value={newCardForm.credibility} onChange={(e) => setNewCardForm({ ...newCardForm, credibility: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">来源（文献名+页码 / 复盘日期）<span className="field-req">*</span></label>
                  <input className="input" value={newCardForm.source} onChange={(e) => setNewCardForm({ ...newCardForm, source: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setShowCreateCard(false)}>取消</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  onRequestMutation('methodology.createCard', newCardForm, () => {
                    setShowCreateCard(false);
                    setSelectedCardId(methodology.stats.nextCardId);
                  })
                }
              >
                预览变更 Diff（进入确认门）
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 2：追加增订 */}
      {showAmendModal && selectedCard && (
        <div className="modal-backdrop" onClick={() => setShowAmendModal(false)}>
          <div className="modal-box" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ fontWeight: 700, fontSize: 15 }}>追加增订 → 卡片 {selectedCard.id}（不覆盖原字段）</div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAmendModal(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="field-group">
                <label className="field-label">批次/来源标注</label>
                <input className="input" value={amendForm.batchNote} onChange={(e) => setAmendForm({ ...amendForm, batchNote: e.target.value })} />
              </div>
              <div className="field-group">
                <label className="field-label">增订正文 <span className="field-req">*</span></label>
                <textarea className="textarea" style={{ minHeight: 130 }} placeholder="补充新的适用边界、反例、跨源互证或观察变量..." value={amendForm.content} onChange={(e) => setAmendForm({ ...amendForm, content: e.target.value })} />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setShowAmendModal(false)}>取消</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  onRequestMutation('methodology.appendAmendment', { cardId: selectedCard.id, ...amendForm }, () => setShowAmendModal(false))
                }
              >
                预览变更 Diff
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 3：可信度复盘调整 */}
      {showCredModal && selectedCard && (
        <div className="modal-backdrop" onClick={() => setShowCredModal(false)}>
          <div className="modal-box" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                复盘可信度调整 → 卡片 {selectedCard.id}（当前 {selectedCard.credibilityScore ?? '-'}）
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowCredModal(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {(selectedCard.isArchived || selectedCard.isHighPaused) && (
                <div className="field-block" style={{ background: 'var(--amber-soft)', borderColor: 'var(--amber)', fontSize: 12.5 }}>
                  <strong>防通胀纪律提示：</strong>该卡片当前处于「{selectedCard.isArchived ? '封存' : '高位暂停'}」状态，按项目铁律除非出现全新独立形态，建议选择「维持现值（+0）仅追加复盘记录」。
                </div>
              )}

              <div className="field-group">
                <label className="field-label">本次复盘验证裁定</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className={`btn ${credForm.delta === 0.1 ? 'btn-teal' : ''}`} onClick={() => setCredForm({ ...credForm, delta: 0.1 })}>
                    验证为真 (+0.1)
                  </button>
                  <button type="button" className={`btn ${credForm.delta === 0 ? 'btn-primary' : ''}`} onClick={() => setCredForm({ ...credForm, delta: 0 })}>
                    维持现值 (+0，仅记复盘)
                  </button>
                  <button type="button" className={`btn ${credForm.delta === -0.15 ? 'btn-danger' : ''}`} onClick={() => setCredForm({ ...credForm, delta: -0.15 })}>
                    证伪 (-0.15)
                  </button>
                </div>
                <div className="field-hint">
                  调整后可信度预览：<strong>{Math.max(0, Math.min(1, Number(((selectedCard.credibilityScore ?? 0.5) + credForm.delta).toFixed(2))))}</strong>
                  {(selectedCard.credibilityScore ?? 0.5) + credForm.delta < 0.3 && '（将自动附加【待淘汰】标记）'}
                </div>
              </div>

              {credForm.delta !== 0 && (
                <div className="field-group">
                  <label className="field-label">可信度行简短括号注记</label>
                  <input className="input" placeholder="例：11-23复盘+0.1：独立出样验证成立" value={credForm.shortNote} onChange={(e) => setCredForm({ ...credForm, shortNote: e.target.value })} />
                </div>
              )}

              <div className="field-group">
                <label className="field-label">复盘记录详细证据与依据 <span className="field-req">*</span></label>
                <textarea className="textarea" style={{ minHeight: 110 }} placeholder="写明日期、盘面/标的事实验证细节、以及是否属于独立证据链..." value={credForm.reason} onChange={(e) => setCredForm({ ...credForm, reason: e.target.value })} />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setShowCredModal(false)}>取消</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  onRequestMutation('methodology.adjustCredibility', { cardId: selectedCard.id, ...credForm }, () => setShowCredModal(false))
                }
              >
                预览变更 Diff
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 4：高级原文编辑 */}
      {showRawEditModal && selectedCard && (
        <div className="modal-backdrop" onClick={() => setShowRawEditModal(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 7 }}>
                <Code2 size={16} /> 定向原文编辑 · 卡片 {selectedCard.id}
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowRawEditModal(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="field-group">
                <label className="field-label">修订摘要说明</label>
                <input className="input" value={rawEditForm.summary} onChange={(e) => setRawEditForm({ ...rawEditForm, summary: e.target.value })} />
              </div>
              <div className="field-group">
                <label className="field-label">Markdown 正文（请保留首行 ## 卡片 {selectedCard.id} 编号）</label>
                <textarea className="textarea textarea-mono" style={{ minHeight: 320 }} value={rawEditForm.rawMarkdown} onChange={(e) => setRawEditForm({ ...rawEditForm, rawMarkdown: e.target.value })} />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setShowRawEditModal(false)}>取消</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  onRequestMutation('methodology.editCardRaw', { cardId: selectedCard.id, ...rawEditForm }, () => setShowRawEditModal(false))
                }
              >
                预览变更 Diff
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 5：新增冲突矩阵条目 */}
      {showCreateConflict && (
        <div className="modal-backdrop" onClick={() => setShowCreateConflict(false)}>
          <div className="modal-box" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                新增冲突矩阵条目 · <span className="badge badge-crimson mono">冲突 {methodology.stats.nextConflictId}</span>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowCreateConflict(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="field-group">
                <label className="field-label">冲突标题（观点 A vs 观点 B）<span className="field-req">*</span></label>
                <input className="input" value={conflictForm.title} onChange={(e) => setConflictForm({ ...conflictForm, title: e.target.value })} />
              </div>
              <div className="field-group">
                <label className="field-label">双方立场与来源 <span className="field-req">*</span></label>
                <textarea className="textarea" value={conflictForm.sides} onChange={(e) => setConflictForm({ ...conflictForm, sides: e.target.value })} />
              </div>
              <div className="field-group">
                <label className="field-label">核心冲突点 <span className="field-req">*</span></label>
                <textarea className="textarea" style={{ minHeight: 68 }} value={conflictForm.conflictPoint} onChange={(e) => setConflictForm({ ...conflictForm, conflictPoint: e.target.value })} />
              </div>
              <div className="field-group">
                <label className="field-label">折中思路与硬判别变量（何时用 A、何时用 B）<span className="field-req">*</span></label>
                <textarea className="textarea" style={{ minHeight: 100 }} value={conflictForm.resolution} onChange={(e) => setConflictForm({ ...conflictForm, resolution: e.target.value })} />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setShowCreateConflict(false)}>取消</button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() =>
                  onRequestMutation('methodology.createConflict', conflictForm, () => {
                    setShowCreateConflict(false);
                    setSelectedConflictId(methodology.stats.nextConflictId);
                  })
                }
              >
                预览变更 Diff
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 弹窗 6：AI 文献/文档/语音转化入库 */}
      <AiIngestionModal
        open={showAiIngest}
        targetLibrary="methodology"
        initialMode={ingestInitialMode}
        aiConfig={aiConfig}
        recentIngestJob={recentIngestJob}
        onJobStarted={onJobStarted}
        onJobFinished={onJobFinished}
        onClose={() => setShowAiIngest(false)}
        onOpenAiSettings={onOpenAiSettings}
        onFillNewCardForm={(card) => {
          setNewCardForm({
            system: card.system || '',
            topic: card.topic || '',
            batchNote: card.batchNote || '文献AI转化入库',
            newSectionTitle: card.newSectionTitle || '',
            coreThesis: card.coreThesis || '',
            logicChain: card.logicChain || '',
            applicableConditions: card.applicableConditions || '',
            invalidationSignals: card.invalidationSignals || '',
            historicalCases: card.historicalCases || '',
            credibility: String(card.credibility || '0.5'),
            source: card.source || '',
          });
          setShowCreateCard(true);
          onToast('已将 AI 解析的候选卡填入「新建方法论卡片」表单，可微调后提交确认门！');
        }}
        onRequestMutation={onRequestMutation}
        onToast={onToast}
      />
    </div>
  );
};
