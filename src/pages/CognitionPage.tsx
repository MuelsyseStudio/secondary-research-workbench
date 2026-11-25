import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Edit3,
  Eye,
  FileText,
  GitBranch,
  History,
  Layers,
  Lightbulb,
  Link2,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type {
  AiSafeConfig,
  BackgroundJobSummary,
  CognitionCard,
  EntityRef,
  KbTopicMemberItem,
  KbTopicView,
  QuickDraftNotePayload,
  WorkspaceData,
} from '../types';
import { CardLinkText } from '../components/CardLinkText';
import { MarkdownBlock } from '../components/MarkdownBlock';
import { AiIngestionModal } from '../components/AiIngestionModal';

function normalizeKbCardId(raw: string): string {
  const s = String(raw || '').trim();
  const m = s.match(/^[A-Z]+[:\-]?(\d+)$/i);
  return m ? m[1].padStart(3, '0') : s;
}

function parseKbIdToEntityRef(raw: string, fallbackKind: 'cognition' | 'methodology' | 'conflict' = 'cognition'): EntityRef {
  const s = String(raw || '').trim();
  const mM = s.match(/^M[:\-]?(\d+)$/i);
  if (mM) return { kind: 'methodology', id: mM[1].padStart(3, '0') };
  const mC = s.match(/^C[:\-]?(\d+)$/i);
  if (mC) return { kind: 'cognition', id: mC[1].padStart(3, '0') };
  const mCf = s.match(/^CF[:\-]?(\d+)$/i);
  if (mCf) return { kind: 'conflict', id: String(Number(mCf[1])) };
  if (fallbackKind === 'conflict') return { kind: 'conflict', id: String(Number(s) || s) };
  return { kind: fallbackKind, id: s.padStart(3, '0') };
}

function normalizeTopicKey(raw: string): string {
  return String(raw || '').trim().replace(/^T[:\-]/i, 'T:').toLowerCase();
}

interface CognitionPageProps {
  workspace: WorkspaceData;
  aiConfig: AiSafeConfig | null;
  recentIngestJob?: BackgroundJobSummary | null;
  onJobStarted?: (job: BackgroundJobSummary) => void;
  onJobFinished?: () => void;
  initialCardId?: string | null;
  initialModal?: 'createCard' | 'aiIngest' | null;
  initialDraftNote?: QuickDraftNotePayload | null;
  onDraftNoteAccepted?: (noteId: string, target: 'cognition' | 'method' | 'judgment') => void;
  onConsumeInitial?: () => void;
  onOpenEntity: (ref: EntityRef) => void;
  onOpenAiSettings: () => void;
  onRequestMutation: (action: string, payload: Record<string, unknown>, onSuccess?: () => void) => void;
  onToast: (msg: string) => void;
}

export const CognitionPage: React.FC<CognitionPageProps> = ({
  workspace,
  aiConfig,
  recentIngestJob,
  onJobStarted,
  onJobFinished,
  initialCardId,
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
  const { cognition, backlinks } = workspace;
  const isKbV2 = workspace.kbMode === 'v2';

  const [subView, setSubView] = useState<'cards' | 'topics' | 'archives' | 'logs'>('cards');
  const [search, setSearch] = useState('');
  const [gradeFilter, setGradeFilter] = useState<'ALL' | 'A' | 'B' | 'C' | 'AMENDED' | 'FLAGGED'>('ALL');
  const [batchFilter, setBatchFilter] = useState('ALL');
  const [selectedCardId, setSelectedCardId] = useState<string>(
    cognition.cards[cognition.cards.length - 1]?.id || '001'
  );

  // KB v2 产业链活视图 (Topics) 状态
  const [topicsList, setTopicsList] = useState<KbTopicView[]>(workspace.topics || []);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [topicStatusFilter, setTopicStatusFilter] = useState<'all' | 'dirty' | 'synced'>('all');
  const [topicSearch, setTopicSearch] = useState('');
  const [expandedTopics, setExpandedTopics] = useState<Record<string, boolean>>({});
  const [synthesizingTopicId, setSynthesizingTopicId] = useState<string | null>(null);
  const [savingTopicId, setSavingTopicId] = useState<string | null>(null);
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [topicDrafts, setTopicDrafts] = useState<Record<string, string>>({});
  const [topicPreviewMode, setTopicPreviewMode] = useState<Record<string, 'split' | 'edit' | 'preview'>>({});

  useEffect(() => {
    setTopicsList(workspace.topics || []);
  }, [workspace.topics, workspace.loadedAt]);

  const showTopicsTab = isKbV2 || topicsList.length > 0;
  const dirtyTopicsCount = useMemo(
    () => topicsList.filter((tp) => tp.status === 'dirty').length,
    [topicsList]
  );

  const refreshTopics = async () => {
    setLoadingTopics(true);
    try {
      const res = await api.kbTopics();
      setTopicsList(res.topics || []);
      onToast(t(`已刷新 ${res.topics?.length || 0} 个产业链活视图`, `Refreshed ${res.topics?.length || 0} living topic views`));
    } catch (err: any) {
      onToast(t(`刷新活视图失败：${err.message}`, `Failed to refresh topics: ${err.message}`));
    } finally {
      setLoadingTopics(false);
    }
  };

  const handleSynthesizeTopic = async (topic: KbTopicView) => {
    setSynthesizingTopicId(topic.id);
    try {
      const res = await api.kbSynthesizeTopic(topic.id);
      setTopicDrafts((prev) => ({ ...prev, [topic.id]: res.draftSummary || '' }));
      setEditingTopicId(topic.id);
      setTopicPreviewMode((prev) => ({ ...prev, [topic.id]: prev[topic.id] || 'split' }));
      onToast(
        t(
          `AI 已为「${topic.title}」起草共识摘要初稿，可审阅修改后点击「保存共识摘要」落盘！`,
          `AI drafted consensus summary for "${topic.title}". Review and click Save to persist.`
        )
      );
    } catch (err: any) {
      onToast(t(`AI 起草共识摘要失败：${err.message}`, `AI topic synthesis failed: ${err.message}`));
    } finally {
      setSynthesizingTopicId(null);
    }
  };

  const handleSaveTopicSummary = async (topic: KbTopicView) => {
    const draft = (topicDrafts[topic.id] ?? '').trim();
    if (!draft) {
      onToast(t('共识摘要内容不能为空', 'Consensus summary cannot be empty'));
      return;
    }
    setSavingTopicId(topic.id);
    try {
      const res = await api.kbSaveTopicSummary(topic.id, draft);
      setTopicsList((prev) =>
        prev.map((item) =>
          item.id === topic.id
            ? {
                ...item,
                ...(res.topic || {}),
                consensusSummary: draft,
                consensus_summary: draft,
                status: 'synced',
                lastSynthesizedAt: res.topic?.lastSynthesizedAt || new Date().toISOString().slice(0, 10),
              }
            : item
        )
      );
      setEditingTopicId(null);
      onToast(t(`已保存「${topic.title}」共识摘要并同步 SQLite 索引！`, `Saved consensus summary for "${topic.title}" and synced SQLite!`));
    } catch (err: any) {
      onToast(t(`保存共识摘要失败：${err.message}`, `Failed to save consensus summary: ${err.message}`));
    } finally {
      setSavingTopicId(null);
    }
  };

  const resolveTopicMembers = (topic: KbTopicView): { active: KbTopicMemberItem[]; inactive: KbTopicMemberItem[] } => {
    if (Array.isArray(topic.activeMembers) || Array.isArray(topic.inactiveMembers)) {
      return {
        active: topic.activeMembers || [],
        inactive: topic.inactiveMembers || [],
      };
    }
    if (Array.isArray(topic.members) && topic.members.length > 0) {
      return {
        active: topic.members.filter((m) => m.status === 'active'),
        inactive: topic.members.filter((m) => m.status !== 'active'),
      };
    }
    const targetKey = normalizeTopicKey(topic.id);
    const matched = cognition.cards.filter((c) =>
      (c.v2Meta?.topics || []).some((tid) => normalizeTopicKey(tid) === targetKey)
    );
    const mapped: KbTopicMemberItem[] = matched.map((c) => ({
      id: c.v2Meta?.kbId || `C:${c.id}`,
      cardId: c.id,
      num: c.num,
      title: c.title,
      status:
        c.v2Meta?.status ||
        (c.isArchived
          ? 'archived'
          : c.isPartiallyFalsified
          ? 'partially_falsified'
          : c.updatedToId
          ? 'superseded'
          : 'active'),
      primaryGrade: c.primaryGrade,
      subKind: c.v2Meta?.claimType || '',
      ingestedAt: c.ingestedDate,
      updatedAt: c.v2Meta?.updatedAt || c.ingestedDate,
      validUntil: c.v2Meta?.validUntil || null,
    }));
    return {
      active: mapped.filter((m) => m.status === 'active'),
      inactive: mapped.filter((m) => m.status !== 'active'),
    };
  };

  const filteredTopics = useMemo(() => {
    const q = topicSearch.trim().toLowerCase();
    return topicsList.filter((tp) => {
      if (topicStatusFilter !== 'all' && tp.status !== topicStatusFilter) return false;
      if (!q) return true;
      const summary = tp.consensusSummary || tp.consensus_summary || '';
      const prefix = tp.chainPrefix || tp.chain_prefix || '';
      return (
        tp.id.toLowerCase().includes(q) ||
        tp.title.toLowerCase().includes(q) ||
        prefix.toLowerCase().includes(q) ||
        summary.toLowerCase().includes(q)
      );
    });
  }, [topicsList, topicStatusFilter, topicSearch]);

  const jumpToCardById = (rawId: string) => {
    const norm = normalizeKbCardId(rawId);
    setSelectedCardId(norm);
    setSubView('cards');
  };

  // Archive reader state
  const [selectedArchivePath, setSelectedArchivePath] = useState<string>(
    cognition.researchArchives[0]?.relativePath || ''
  );
  const [archiveContent, setArchiveContent] = useState<string>('');
  const [archiveLoading, setArchiveLoading] = useState(false);

  // Modals
  const [showCreate, setShowCreate] = useState(false);
  const [showAiIngest, setShowAiIngest] = useState(false);
  const [ingestInitialMode, setIngestInitialMode] = useState<'document' | 'voice'>('document');
  const [showAmend, setShowAmend] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [showRawEdit, setShowRawEdit] = useState(false);

  // Forms
  const [createForm, setCreateForm] = useState({
    title: '',
    categoryTag: '第六编增补',
    batchName: '日常产业研报批次',
    newBatchTitle: '',
    facts: '',
    source: '',
    evidenceLevel: 'B（权威研报/媒体）',
    industryImplications: '',
    aShareMapping: '',
    confidence: '中',
    invalidationConditions: '',
    relatedMethodIds: '',
    relatedCognitionIds: '',
  });
  const [amendForm, setAmendForm] = useState({ batchNote: '跨源互证增订', content: '' });
  const [statusForm, setStatusForm] = useState({
    statusType: 'updated',
    targetCardId: '',
    statusDetail: '',
  });
  const [rawForm, setRawForm] = useState({ summary: '', rawMarkdown: '' });

  useEffect(() => {
    if (initialDraftNote && initialDraftNote.target === 'cognition') {
      const symLabel = initialDraftNote.symbol || initialDraftNote.symbolName || '';
      setSubView('cards');
      setCreateForm((prev) => ({
        ...prev,
        title: `${initialDraftNote.tag}${symLabel ? `：${symLabel}` : ''}`,
        facts: initialDraftNote.text,
        aShareMapping: symLabel || prev.aShareMapping,
        source: `盘中闪念速记 (${initialDraftNote.createdAt.slice(0, 16).replace('T', ' ')})`,
      }));
      setShowCreate(true);
      onDraftNoteAccepted?.(initialDraftNote.noteId, 'cognition');
      onConsumeInitial?.();
      return;
    }
    if (initialCardId) {
      setSubView('cards');
      setSelectedCardId(initialCardId);
      onConsumeInitial?.();
    } else if (initialModal === 'createCard') {
      setSubView('cards');
      setShowCreate(true);
      onConsumeInitial?.();
    } else if (initialModal === 'aiIngest') {
      setSubView('cards');
      setShowAiIngest(true);
      onConsumeInitial?.();
    }
  }, [initialCardId, initialModal, initialDraftNote, onDraftNoteAccepted, onConsumeInitial]);

  useEffect(() => {
    if (subView === 'archives' && selectedArchivePath) {
      setArchiveLoading(true);
      api
        .getArchiveDoc(selectedArchivePath)
        .then((res) => setArchiveContent(res.content))
        .catch((err) => setArchiveContent(`> 无法加载归档文件：${err.message}`))
        .finally(() => setArchiveLoading(false));
    }
  }, [subView, selectedArchivePath]);

  const filteredCards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...cognition.cards].reverse().filter((c) => {
      if (batchFilter !== 'ALL' && c.batchTitle !== batchFilter) return false;
      if (gradeFilter === 'A' && !c.evidenceGrades.includes('A')) return false;
      if (gradeFilter === 'B' && !c.evidenceGrades.includes('B')) return false;
      if (gradeFilter === 'C' && !c.evidenceGrades.includes('C')) return false;
      if (gradeFilter === 'AMENDED' && c.amendments.length === 0) return false;
      if (gradeFilter === 'FLAGGED' && !c.isArchived && !c.isPartiallyFalsified && !c.updatedToId) return false;
      if (!q) return true;
      return (
        c.id.includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.facts.toLowerCase().includes(q) ||
        c.aShareMapping.toLowerCase().includes(q) ||
        c.source.toLowerCase().includes(q) ||
        c.rawMarkdown.toLowerCase().includes(q)
      );
    });
  }, [cognition.cards, search, gradeFilter, batchFilter]);

  const selectedCard: CognitionCard | undefined =
    cognition.cards.find((c) => c.id === selectedCardId) || filteredCards[0];

  const cardBacklinks = selectedCard ? backlinks.cognitionBacklinks[selectedCard.id] || [] : [];

  const gradeBadgeClass = (g: string) => {
    if (g === 'A') return 'badge-emerald';
    if (g === 'B') return 'badge-navy';
    if (g === 'C') return 'badge-amber';
    return 'badge-muted';
  };

  return (
    <div className="page-viewport">
      {/* 二级工具栏 */}
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
            <Lightbulb size={14} /> {t('卡片列表', 'Card List')} ({cognition.stats.totalCount})
          </button>
          {showTopicsTab && (
            <button
              type="button"
              className={`seg-tab ${subView === 'topics' ? 'active' : ''}`}
              onClick={() => setSubView('topics')}
            >
              <Layers size={14} /> {t('产业链活视图 (Topics)', 'Living Topics')}
              {topicsList.length > 0 ? ` (${topicsList.length})` : ''}
              {dirtyTopicsCount > 0 && (
                <span className="badge badge-amber" style={{ fontSize: 10, padding: '0 4px', marginLeft: 3 }}>
                  {dirtyTopicsCount} dirty
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            className={`seg-tab ${subView === 'archives' ? 'active' : ''}`}
            onClick={() => setSubView('archives')}
          >
            <FileText size={14} /> {t('研究观点归档', 'Research Archives')} ({cognition.researchArchives.length})
          </button>
          <button
            type="button"
            className={`seg-tab ${subView === 'logs' ? 'active' : ''}`}
            onClick={() => setSubView('logs')}
          >
            <History size={14} /> {t('批次更新日志', 'Batch Logs')} ({cognition.updateLogs.length})
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
            title={t('实时语音口述或上传路演/调研录音，一键清洗并 AI 转化为产业认知卡', 'Voice or audio-to-card AI ingestion')}
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
            <Sparkles size={14} color="var(--teal)" /> {t('AI 研报/文档转化', 'AI Report Ingest')}
          </button>
          <button type="button" className="btn btn-teal btn-sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> {t('新建产业认知卡', 'New Intel Card')} ({cognition.stats.nextCardId})
          </button>
        </div>
      </div>

      {/* 子视图 1：认知卡 Master-Detail */}
      {subView === 'cards' && (
        <div className="split-workbench">
          <div className="list-pane">
            <div className="list-pane-header">
              <div style={{ position: 'relative' }}>
                <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: 10, top: 10 }} />
                <input
                  className="input"
                  style={{ paddingLeft: 30 }}
                  placeholder="搜卡号、产业链、A股标的、机构..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              <select
                className="select"
                value={batchFilter}
                onChange={(e) => setBatchFilter(e.target.value)}
                style={{ fontSize: 12.5, padding: '6px 9px' }}
              >
                <option value="ALL">全部编 / 入库批次（{cognition.batches.length}）</option>
                {[...cognition.batches].reverse().map((b) => (
                  <option key={b.title} value={b.title}>
                    {b.title}
                  </option>
                ))}
              </select>

              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {(
                  [
                    ['ALL', '全部'],
                    ['A', `A级 (${cognition.stats.gradeACount})`],
                    ['B', `B级 (${cognition.stats.gradeBCount})`],
                    ['C', `C级 (${cognition.stats.gradeCCount})`],
                    ['AMENDED', `有增订 (${cognition.stats.withAmendmentsCount})`],
                    ['FLAGGED', '证伪/归档'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`btn btn-sm ${gradeFilter === k ? 'btn-teal' : ''}`}
                    style={{ padding: '2px 8px', fontSize: 11.5 }}
                    onClick={() => setGradeFilter(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                按最新倒序 · 显示 <strong className="num">{filteredCards.length}</strong> / {cognition.stats.totalCount} 张
              </div>
            </div>

            <div className="list-pane-scroll">
              {filteredCards.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`list-card ${selectedCard?.id === c.id ? 'selected-teal' : ''}`}
                  onClick={() => setSelectedCardId(c.id)}
                >
                  <div className="list-card-top">
                    <span className="badge badge-teal mono">认知 {c.id}</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {c.evidenceGrades.map((g) => (
                        <span key={g} className={`badge ${gradeBadgeClass(g)}`} style={{ padding: '1px 5px', fontSize: 10.5 }}>
                          {g}
                        </span>
                      ))}
                      {c.isPartiallyFalsified && <span className="badge badge-crimson" style={{ fontSize: 10.5 }}>部分证伪</span>}
                      {c.v2Meta?.refuters && c.v2Meta.refuters.length > 0 && !c.isPartiallyFalsified && (
                        <span className="badge badge-crimson" style={{ fontSize: 10.5 }}>{t('有反证', 'Refuted')}</span>
                      )}
                      {c.v2Meta?.isExpired && (
                        <span className="badge badge-crimson" style={{ fontSize: 10.5 }}>{t('已过期', 'Expired')}</span>
                      )}
                      {!c.v2Meta?.isExpired && c.v2Meta?.isCheckDue && (
                        <span className="badge badge-amber" style={{ fontSize: 10.5 }}>{t('待巡检', 'Due')}</span>
                      )}
                      {c.isArchived && <span className="badge badge-muted" style={{ fontSize: 10.5 }}>归档</span>}
                    </div>
                  </div>
                  <div className="list-card-title">{c.title}</div>
                  <div className="list-card-sub">
                    <span>{c.ingestedDate || '早期批次'}</span>
                    {c.amendments.length > 0 && (
                      <span className="badge badge-muted" style={{ fontSize: 10.5 }}>
                        增订 {c.amendments.length}
                      </span>
                    )}
                    {c.updatedToId && (
                      <span className="badge badge-amber" style={{ fontSize: 10.5 }}>
                        已更新→{c.updatedToId}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 右侧认知卡精读（事实 / 产业含义 / A股映射严格分栏） */}
          <div className="detail-pane">
            {!selectedCard ? (
              <div className="empty-state">请从左侧选择一张产业认知卡</div>
            ) : (
              <div style={{ maxWidth: 920 }}>
                {/* KB v2 1-Hop 反证警报横幅 */}
                {selectedCard.v2Meta?.refuters && selectedCard.v2Meta.refuters.length > 0 && (
                  <div
                    className="panel panel-pad"
                    style={{
                      marginBottom: 12,
                      background: 'var(--crimson-soft)',
                      borderColor: 'var(--crimson)',
                      borderWidth: 1.5,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 1, minWidth: 240 }}>
                      <ShieldAlert size={18} color="var(--crimson)" style={{ flexShrink: 0 }} />
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 13.5, color: 'var(--crimson)' }}>
                          {t(
                            `已被 ${selectedCard.v2Meta.refuters
                              .map((r) => (typeof r === 'string' ? r : r.id))
                              .join(' / ')} 部分证伪或存在直接反证`,
                            `Partially refuted by ${selectedCard.v2Meta.refuters
                              .map((r) => (typeof r === 'string' ? r : r.id))
                              .join(' / ')}`
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                          {t(
                            'KB v2 1-Hop 图谱防幻觉提示：引用本卡历史结论前，请务必对照最新反证卡核实当前产业链事实。',
                            'KB v2 1-hop graph guard: cross-check the refuting card(s) before relying on this thesis.'
                          )}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {selectedCard.v2Meta.refuters.map((r) => {
                        const rid = typeof r === 'string' ? r : r.id;
                        const rTitle = typeof r === 'string' ? '' : r.title || '';
                        const targetRef = parseKbIdToEntityRef(rid, 'cognition');
                        return (
                          <button
                            key={rid}
                            type="button"
                            className="btn btn-danger btn-sm"
                            title={rTitle || rid}
                            onClick={() => {
                              if (targetRef.kind === 'cognition') {
                                setSelectedCardId(targetRef.id);
                              } else {
                                onOpenEntity(targetRef);
                              }
                            }}
                          >
                            {t(`跳转查看 ${rid} →`, `Jump to ${rid} →`)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="panel panel-pad" style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                        <span className="badge badge-teal mono">认知卡 {selectedCard.id}</span>
                        {selectedCard.evidenceGrades.map((g) => (
                          <span key={g} className={`badge ${gradeBadgeClass(g)}`}>
                            证据 {g} 级
                          </span>
                        ))}
                        {selectedCard.ingestedDate && <span className="badge badge-muted">{selectedCard.ingestedDate} 入库</span>}
                        {selectedCard.categoryTag && <span className="badge badge-navy">{selectedCard.categoryTag}</span>}
                        {selectedCard.v2Meta?.claimType && (
                          <span className="badge badge-violet mono" style={{ fontSize: 11 }}>
                            {selectedCard.v2Meta.claimType}
                          </span>
                        )}
                        {selectedCard.v2Meta?.validUntil && (
                          <span
                            className={`badge mono ${selectedCard.v2Meta.isExpired ? 'badge-crimson' : 'badge-emerald'}`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
                          >
                            <CalendarClock size={11} />
                            {selectedCard.v2Meta.isExpired
                              ? t(`已过期 (${selectedCard.v2Meta.validUntil})`, `Expired (${selectedCard.v2Meta.validUntil})`)
                              : t(`有效至 ${selectedCard.v2Meta.validUntil}`, `Valid until ${selectedCard.v2Meta.validUntil}`)}
                          </span>
                        )}
                        {selectedCard.v2Meta?.nextCheckDate && (
                          <span className={`badge mono ${selectedCard.v2Meta.isCheckDue ? 'badge-amber' : 'badge-muted'}`}>
                            {selectedCard.v2Meta.isCheckDue
                              ? t(`到期复核 ${selectedCard.v2Meta.nextCheckDate}`, `Check due ${selectedCard.v2Meta.nextCheckDate}`)
                              : t(`复核日 ${selectedCard.v2Meta.nextCheckDate}`, `Next check ${selectedCard.v2Meta.nextCheckDate}`)}
                          </span>
                        )}
                        {selectedCard.isPartiallyFalsified && <span className="badge badge-crimson">⚠️ 部分证伪</span>}
                        {selectedCard.isArchived && <span className="badge badge-muted">已归档</span>}
                        {selectedCard.updatedToId && (
                          <button
                            type="button"
                            className="ref-chip ref-chip-cognition"
                            onClick={() => onOpenEntity({ kind: 'cognition', id: selectedCard.updatedToId! })}
                          >
                            已更新 → 认知卡 {selectedCard.updatedToId}
                          </button>
                        )}
                      </div>
                      <h2 style={{ margin: '0 0 6px', fontSize: 19, lineHeight: 1.35, color: 'var(--text)' }}>
                        {selectedCard.title}
                      </h2>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        批次：{selectedCard.batchTitle} · 行 L{selectedCard.startLine}–L{selectedCard.endLine}
                      </div>

                      {/* KB v2 产业链节点 / 标的实体 / 所属活视图标签条 */}
                      {selectedCard.v2Meta &&
                        ((selectedCard.v2Meta.chainNodes?.length || 0) > 0 ||
                          (selectedCard.v2Meta.tickers?.length || 0) > 0 ||
                          (selectedCard.v2Meta.topics?.length || 0) > 0) && (
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--border)' }}>
                            {(selectedCard.v2Meta.chainNodes || []).map((cn) => (
                              <span key={`cn-${cn}`} className="badge badge-teal mono" style={{ fontSize: 10.5 }}>
                                #{cn}
                              </span>
                            ))}
                            {(selectedCard.v2Meta.tickers || []).map((tk, idx) => {
                              const code = typeof tk === 'string' ? tk : tk.code;
                              const name = typeof tk === 'string' ? '' : tk.name;
                              return (
                                <span key={`tk-${code}-${idx}`} className="badge badge-navy mono" style={{ fontSize: 10.5 }}>
                                  {name && name !== code ? `${name} (${code})` : code}
                                </span>
                              );
                            })}
                            {(selectedCard.v2Meta.topics || []).map((tid) => (
                              <button
                                key={`tp-${tid}`}
                                type="button"
                                className="badge badge-violet mono"
                                style={{ border: 'none', cursor: 'pointer', fontSize: 10.5 }}
                                onClick={() => {
                                  setExpandedTopics((prev) => ({ ...prev, [tid]: true }));
                                  setSubView('topics');
                                }}
                                title={t('跳转到所属产业链活视图', 'Jump to living topic view')}
                              >
                                {tid}
                              </button>
                            ))}
                          </div>
                        )}
                    </div>

                    <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-teal btn-sm"
                        onClick={() => {
                          setAmendForm({ batchNote: '跨源互证增订', content: '' });
                          setShowAmend(true);
                        }}
                      >
                        <GitBranch size={13} /> 追加增订
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setStatusForm({ statusType: 'updated', targetCardId: '', statusDetail: '' });
                          setShowStatus(true);
                        }}
                      >
                        <Tag size={13} /> 标记覆盖/状态
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setRawForm({
                            summary: `定向修订认知卡 ${selectedCard.id}`,
                            rawMarkdown: selectedCard.rawMarkdown,
                          });
                          setShowRawEdit(true);
                        }}
                      >
                        <Edit3 size={13} /> 原文编辑
                      </button>
                    </div>
                  </div>
                </div>

                {/* 铁律③：事实 / 产业含义 / A股映射严格分离 */}
                <div className="field-block field-block-fact">
                  <div className="field-block-label" style={{ color: 'var(--emerald)' }}>
                    客观事实 / 要点（Fact Layer）
                  </div>
                  <div style={{ lineHeight: 1.75, color: 'var(--text)' }}>
                    <CardLinkText text={selectedCard.facts} onOpenEntity={onOpenEntity} />
                  </div>
                </div>

                <div className="field-block field-block-analysis">
                  <div className="field-block-label" style={{ color: 'var(--navy)' }}>
                    产业含义（Analysis · 非事实）
                  </div>
                  <div style={{ lineHeight: 1.75, color: 'var(--text)' }}>
                    <CardLinkText text={selectedCard.industryImplications} onOpenEntity={onOpenEntity} />
                  </div>
                </div>

                <div className="field-block field-block-mapping">
                  <div className="field-block-label" style={{ color: 'var(--teal)' }}>
                    A 股映射（Mapping · 分析判断）
                  </div>
                  <div style={{ lineHeight: 1.75, color: 'var(--text)' }}>
                    <CardLinkText text={selectedCard.aShareMapping} onOpenEntity={onOpenEntity} />
                  </div>
                </div>

                <div className="grid-2">
                  <div className="field-block" style={{ marginBottom: 12 }}>
                    <div className="field-block-label">证据等级与置信度</div>
                    <div style={{ fontSize: 13, marginBottom: 6 }}>
                      <strong>证据等级：</strong>
                      <CardLinkText text={selectedCard.evidenceLevelRaw} onOpenEntity={onOpenEntity} />
                    </div>
                    <div style={{ fontSize: 13 }}>
                      <strong>置信度：</strong>
                      <CardLinkText text={selectedCard.confidence} onOpenEntity={onOpenEntity} />
                    </div>
                  </div>

                  <div className="field-block field-block-danger" style={{ marginBottom: 12 }}>
                    <div className="field-block-label" style={{ color: 'var(--crimson)' }}>
                      <AlertTriangle size={13} /> 失效 / 更新条件（铁律②必填）
                    </div>
                    <div style={{ lineHeight: 1.65 }}>
                      <CardLinkText text={selectedCard.invalidationConditions} onOpenEntity={onOpenEntity} />
                    </div>
                  </div>
                </div>

                <div className="field-block">
                  <div className="field-block-label">原始来源与更新日志</div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: selectedCard.updateLog ? 6 : 0 }}>
                    <strong>来源：</strong>
                    <CardLinkText text={selectedCard.source} onOpenEntity={onOpenEntity} />
                  </div>
                  {selectedCard.updateLog && (
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      <strong>更新日志：</strong>
                      {selectedCard.updateLog}
                    </div>
                  )}
                </div>

                {/* 增订历史 */}
                {selectedCard.amendments.length > 0 && (
                  <div className="panel panel-pad" style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 7 }}>
                      <Sparkles size={15} color="var(--teal)" />
                      跨源互证与后续增订（{selectedCard.amendments.length} 条 · 原数据未覆盖）
                    </div>
                    <div className="timeline-list">
                      {selectedCard.amendments.map((am, i) => (
                        <div key={i} className="timeline-item">
                          <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--teal)', marginBottom: 3 }}>
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

                {/* 双向关联网络 */}
                <div className="panel panel-pad">
                  <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 7 }}>
                    <Link2 size={15} color="var(--navy)" />
                    关联方法论 / 关联认知 / 反向引用（{cardBacklinks.length}）
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                    {selectedCard.references.methodIds.map((id) => (
                      <button key={`m-${id}`} type="button" className="ref-chip ref-chip-method" onClick={() => onOpenEntity({ kind: 'methodology', id })}>
                        方法论 {id}
                      </button>
                    ))}
                    {selectedCard.references.cognitionIds.map((id) => (
                      <button key={`c-${id}`} type="button" className="ref-chip ref-chip-cognition" onClick={() => onOpenEntity({ kind: 'cognition', id })}>
                        认知卡 {id}
                      </button>
                    ))}
                    {selectedCard.references.conflictIds.map((id) => (
                      <button key={`cf-${id}`} type="button" className="ref-chip ref-chip-conflict" onClick={() => onOpenEntity({ kind: 'conflict', id })}>
                        冲突 {id}
                      </button>
                    ))}
                  </div>
                  {cardBacklinks.length > 0 && (
                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 9 }}>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>被以下条目引用：</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {cardBacklinks.slice(0, 20).map((bl, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className="btn btn-sm"
                            style={{ fontSize: 11.5, padding: '3px 8px' }}
                            onClick={() => onOpenEntity({ kind: bl.type, id: bl.id })}
                          >
                            {bl.label.slice(0, 36)}
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

      {/* 子视图 1B：KB v2 产业链活视图 (Topics) */}
      {subView === 'topics' && (
        <div className="scroll-page">
          <div style={{ maxWidth: 1180, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div
              className="panel panel-pad"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div style={{ fontWeight: 800, fontSize: 15, display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text)' }}>
                  <Layers size={16} color="var(--teal)" />
                  {t(`产业链活视图矩阵（共 ${topicsList.length} 个专题）`, `Living Industry Topic Views (${topicsList.length})`)}
                  {dirtyTopicsCount > 0 && (
                    <span className="badge badge-amber">
                      {t(`${dirtyTopicsCount} 个待更新摘要 (dirty)`, `${dirtyTopicsCount} dirty`)}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {t(
                    '每个专题由 SQLite 自动聚合活跃/证伪认知卡，支持 AI 一键起草共识摘要并经人工审阅编辑后回写 topics/T-*.md。',
                    'Each topic auto-aggregates active & superseded cards from SQLite. Draft consensus summaries with AI, edit in Markdown, and save back to topics/T-*.md.'
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ position: 'relative' }}>
                  <Search size={13} color="var(--text-muted)" style={{ position: 'absolute', left: 9, top: 8 }} />
                  <input
                    className="input"
                    style={{ paddingLeft: 26, width: 200, fontSize: 12.5, paddingTop: 4, paddingBottom: 4 }}
                    placeholder={t('搜专题 ID / 产业链...', 'Search topic / chain...')}
                    value={topicSearch}
                    onChange={(e) => setTopicSearch(e.target.value)}
                  />
                </div>
                {(
                  [
                    ['all', t('全部', 'All')],
                    ['dirty', t('待更新 dirty', 'Dirty')],
                    ['synced', t('已同步 synced', 'Synced')],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`btn btn-sm ${topicStatusFilter === k ? 'btn-teal' : ''}`}
                    style={{ padding: '3px 9px', fontSize: 11.5 }}
                    onClick={() => setTopicStatusFilter(k)}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={loadingTopics}
                  onClick={refreshTopics}
                >
                  <RefreshCw size={12} className={loadingTopics ? 'spin' : ''} /> {t('刷新', 'Refresh')}
                </button>
              </div>
            </div>

            {filteredTopics.length === 0 ? (
              <div className="panel panel-pad empty-state" style={{ padding: '38px 18px' }}>
                {topicsList.length === 0
                  ? t('当前工作空间暂无产业链活视图（请先在质检中心升级至 KB v2 并同步索引）。', 'No living topic views yet (upgrade to KB v2 in Maintenance).')
                  : t('当前筛选条件下无匹配的产业链活视图。', 'No topic views match the current filter.')}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(490px, 1fr))', gap: 14 }}>
                {filteredTopics.map((topic) => {
                  const isDirty = topic.status === 'dirty';
                  const isExpanded = Boolean(expandedTopics[topic.id]);
                  const isEditing = editingTopicId === topic.id;
                  const isSynth = synthesizingTopicId === topic.id;
                  const isSaving = savingTopicId === topic.id;
                  const summaryText = topic.consensusSummary ?? topic.consensus_summary ?? '';
                  const chainPrefix = topic.chainPrefix ?? topic.chain_prefix ?? '';
                  const lastSynth = topic.lastSynthesizedAt ?? topic.last_synthesized_at;
                  const { active, inactive } = resolveTopicMembers(topic);
                  const totalMembers = topic.memberCount || active.length + inactive.length;
                  const viewMode = topicPreviewMode[topic.id] || 'split';

                  return (
                    <div
                      key={topic.id}
                      className="panel"
                      style={{
                        borderTop: `3px solid ${isDirty ? 'var(--amber)' : 'var(--emerald)'}`,
                        display: 'flex',
                        flexDirection: 'column',
                      }}
                    >
                      <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 5 }}>
                              <span className="badge badge-teal mono">{topic.id}</span>
                              <span className={`badge ${isDirty ? 'badge-amber' : 'badge-emerald'}`}>
                                {isDirty ? t('待更新 dirty', 'dirty') : t('已同步 synced', 'synced')}
                              </span>
                              <span className="badge badge-navy num">
                                {t(`成员 ${totalMembers}（活 ${active.length} / 非活 ${inactive.length}）`, `${totalMembers} cards (${active.length} active)`)}
                              </span>
                              {chainPrefix && (
                                <span className="badge badge-muted mono" style={{ fontSize: 10.5 }}>
                                  {chainPrefix}
                                </span>
                              )}
                            </div>
                            <h3 style={{ margin: 0, fontSize: 15.5, lineHeight: 1.35, color: 'var(--text)' }}>
                              {topic.title}
                            </h3>
                            {lastSynth && (
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                                {t(`上次共识综合：${lastSynth}`, `Last synthesized: ${lastSynth}`)}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* 共识摘要展示或编辑预览区 */}
                        {!isEditing ? (
                          <div
                            style={{
                              padding: '10px 12px',
                              borderRadius: 8,
                              background: 'var(--bg-soft)',
                              border: '1px solid var(--border)',
                              fontSize: 13,
                            }}
                          >
                            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4 }}>
                              {t('当前产业链共识摘要', 'Current Consensus Summary')}
                            </div>
                            {summaryText.trim() ? (
                              <MarkdownBlock content={summaryText} onOpenEntity={onOpenEntity} />
                            ) : (
                              <div style={{ color: 'var(--text-muted)', fontSize: 12.5, fontStyle: 'italic' }}>
                                {t(
                                  '尚无共识摘要。点击下方「AI 起草共识摘要」自动综合本专题活跃卡与反证卡。',
                                  'No consensus summary yet. Click "AI Draft Consensus" to synthesize active & refuting cards.'
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div
                            style={{
                              padding: 11,
                              borderRadius: 8,
                              background: 'var(--bg-soft)',
                              border: '1px solid var(--teal)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 8,
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--teal)' }}>
                                {t('编辑共识摘要（Markdown）', 'Edit Consensus Summary (Markdown)')}
                              </span>
                              <div style={{ display: 'flex', gap: 4 }}>
                                {(
                                  [
                                    ['edit', t('源码', 'Edit')],
                                    ['split', t('双栏', 'Split')],
                                    ['preview', t('预览', 'Preview')],
                                  ] as const
                                ).map(([m, lbl]) => (
                                  <button
                                    key={m}
                                    type="button"
                                    className={`btn btn-sm ${viewMode === m ? 'btn-teal' : ''}`}
                                    style={{ padding: '1px 7px', fontSize: 11 }}
                                    onClick={() => setTopicPreviewMode((prev) => ({ ...prev, [topic.id]: m }))}
                                  >
                                    {m === 'preview' && <Eye size={10} />} {lbl}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div
                              style={{
                                display: 'grid',
                                gridTemplateColumns: viewMode === 'split' ? '1fr 1fr' : '1fr',
                                gap: 8,
                              }}
                            >
                              {viewMode !== 'preview' && (
                                <textarea
                                  className="textarea textarea-mono"
                                  style={{ minHeight: 180, fontSize: 12 }}
                                  value={topicDrafts[topic.id] ?? ''}
                                  onChange={(e) =>
                                    setTopicDrafts((prev) => ({ ...prev, [topic.id]: e.target.value }))
                                  }
                                  placeholder={t('输入或修改 Markdown 共识摘要...', 'Enter Markdown consensus summary...')}
                                />
                              )}
                              {viewMode !== 'edit' && (
                                <div
                                  style={{
                                    padding: '8px 10px',
                                    borderRadius: 7,
                                    background: 'var(--bg-elev)',
                                    border: '1px solid var(--border)',
                                    maxHeight: 220,
                                    overflowY: 'auto',
                                    fontSize: 12.5,
                                  }}
                                >
                                  <MarkdownBlock content={topicDrafts[topic.id] ?? ''} onOpenEntity={onOpenEntity} />
                                </div>
                              )}
                            </div>
                            <div style={{ display: 'flex', gap: 7, justifyContent: 'flex-end' }}>
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={isSaving}
                                onClick={() => setEditingTopicId(null)}
                              >
                                {t('取消', 'Cancel')}
                              </button>
                              <button
                                type="button"
                                className="btn btn-teal btn-sm"
                                disabled={isSaving}
                                onClick={() => handleSaveTopicSummary(topic)}
                              >
                                {isSaving ? <Loader2 size={12} className="spin" /> : <Save size={12} />}{' '}
                                {isSaving ? t('保存中...', 'Saving...') : t('保存共识摘要', 'Save Consensus Summary')}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* 活视图操作按钮条 */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() =>
                              setExpandedTopics((prev) => ({ ...prev, [topic.id]: !prev[topic.id] }))
                            }
                          >
                            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            {isExpanded
                              ? t('收起成员卡表', 'Hide Member Cards')
                              : t(`展开成员卡表 (${active.length} 活 / ${inactive.length} 非活)`, `Expand Members (${active.length} / ${inactive.length})`)}
                          </button>

                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                setTopicDrafts((prev) => ({
                                  ...prev,
                                  [topic.id]: prev[topic.id] !== undefined ? prev[topic.id] : summaryText,
                                }));
                                setEditingTopicId(topic.id);
                              }}
                            >
                              <Edit3 size={12} /> {t('编辑摘要', 'Edit')}
                            </button>
                            <button
                              type="button"
                              className="btn btn-teal btn-sm"
                              disabled={isSynth}
                              onClick={() => handleSynthesizeTopic(topic)}
                            >
                              {isSynth ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}{' '}
                              {isSynth ? t('AI 起草中...', 'Drafting...') : t('AI 起草共识摘要', 'AI Draft Consensus')}
                            </button>
                          </div>
                        </div>

                        {/* 可展开的活跃/非活跃成员表 + 关联方法论/冲突 */}
                        {isExpanded && (
                          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--emerald)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
                                <CheckCircle2 size={13} />
                                {t(`活跃认知卡（${active.length} 张 · 点击跳转）`, `Active Cognition Cards (${active.length})`)}
                              </div>
                              {active.length === 0 ? (
                                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('暂无活跃成员卡', 'No active cards')}</div>
                              ) : (
                                <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 7 }}>
                                  <table className="data-table">
                                    <thead>
                                      <tr>
                                        <th style={{ width: 70 }}>{t('卡号', 'ID')}</th>
                                        <th style={{ width: 48 }}>{t('证据', 'Grd')}</th>
                                        <th style={{ width: 92 }}>{t('更新日', 'Updated')}</th>
                                        <th>{t('标题', 'Title')}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {active.map((m) => {
                                        const grade = m.primaryGrade || m.primary_grade || '-';
                                        const upd = m.updatedAt || m.updated_at || m.ingestedAt || m.ingested_at || '-';
                                        return (
                                          <tr
                                            key={m.id}
                                            style={{ cursor: 'pointer' }}
                                            onClick={() => jumpToCardById(m.cardId || m.id)}
                                          >
                                            <td className="mono" style={{ fontWeight: 700, color: 'var(--teal)' }}>
                                              {m.id}
                                            </td>
                                            <td>
                                              <span className={`badge ${gradeBadgeClass(grade)}`} style={{ fontSize: 10, padding: '0 4px' }}>
                                                {grade}
                                              </span>
                                            </td>
                                            <td className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                              {upd}
                                            </td>
                                            <td style={{ fontSize: 12 }}>{m.title}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>

                            {inactive.length > 0 && (
                              <div>
                                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--crimson)', marginBottom: 5 }}>
                                  {t(`已替代 / 部分证伪 / 归档卡（${inactive.length} 张）`, `Inactive / Superseded / Falsified (${inactive.length})`)}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  {inactive.map((m) => (
                                    <button
                                      key={m.id}
                                      type="button"
                                      onClick={() => jumpToCardById(m.cardId || m.id)}
                                      style={{
                                        textAlign: 'left',
                                        padding: '5px 8px',
                                        borderRadius: 6,
                                        background: 'var(--bg-soft)',
                                        border: '1px solid var(--border)',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        fontSize: 12,
                                      }}
                                    >
                                      <span className="badge badge-muted mono" style={{ fontSize: 10.5 }}>{m.id}</span>
                                      <span
                                        className={`badge ${
                                          m.status === 'partially_falsified'
                                            ? 'badge-crimson'
                                            : m.status === 'superseded'
                                            ? 'badge-amber'
                                            : 'badge-muted'
                                        }`}
                                        style={{ fontSize: 10 }}
                                      >
                                        {m.status}
                                      </span>
                                      <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {m.title}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {((topic.linkedMethods?.length || 0) > 0 || (topic.linkedConflicts?.length || 0) > 0) && (
                              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', paddingTop: 4 }}>
                                {(topic.linkedMethods || []).slice(0, 12).map((lm, i) => {
                                  const rawId = lm.id || lm.target_id || '';
                                  if (!rawId) return null;
                                  return (
                                    <button
                                      key={`lm-${rawId}-${i}`}
                                      type="button"
                                      className="ref-chip ref-chip-method"
                                      onClick={() => onOpenEntity(parseKbIdToEntityRef(rawId, 'methodology'))}
                                    >
                                      {rawId}{lm.title ? ` · ${lm.title.slice(0, 14)}` : ''}
                                    </button>
                                  );
                                })}
                                {(topic.linkedConflicts || []).map((cf, i) => {
                                  const rawId = cf.id || cf.target_id || '';
                                  if (!rawId) return null;
                                  return (
                                    <button
                                      key={`lcf-${rawId}-${i}`}
                                      type="button"
                                      className="ref-chip ref-chip-conflict"
                                      onClick={() => onOpenEntity(parseKbIdToEntityRef(rawId, 'conflict'))}
                                    >
                                      {rawId}{cf.title ? ` · ${cf.title.slice(0, 16)}` : ''}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 子视图 2：研究观点归档本地阅读器 */}
      {subView === 'archives' && (
        <div className="split-workbench">
          <div className="list-pane">
            <div className="list-pane-header">
              <div style={{ fontWeight: 700, fontSize: 13 }}>研究观点归档专题（{cognition.researchArchives.length} 篇）</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                收到的材料先辨析来源、口径与关键判断后归档，支持在工作台内直接全文研读
              </div>
            </div>
            <div className="list-pane-scroll">
              {cognition.researchArchives.map((arch) => (
                <button
                  key={arch.relativePath}
                  type="button"
                  className={`list-card ${selectedArchivePath === arch.relativePath ? 'selected-teal' : ''}`}
                  onClick={() => setSelectedArchivePath(arch.relativePath)}
                >
                  <div className="list-card-top">
                    <span className="badge badge-teal mono">{arch.date}</span>
                    {!arch.exists && <span className="badge badge-crimson">文件缺失</span>}
                  </div>
                  <div className="list-card-title">{arch.title}</div>
                  <div className="list-card-sub">{arch.summary}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="detail-pane">
            <div className="panel panel-pad" style={{ maxWidth: 920 }}>
              {archiveLoading ? (
                <div className="empty-state">正在读取归档专题 Markdown...</div>
              ) : (
                <MarkdownBlock content={archiveContent} onOpenEntity={onOpenEntity} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* 子视图 3：批次更新日志 */}
      {subView === 'logs' && (
        <div className="scroll-page">
          <div style={{ maxWidth: 920, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[...cognition.updateLogs].reverse().map((log, idx) => (
              <div key={idx} className="panel panel-pad">
                <h3 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--teal)' }}>{log.title}</h3>
                <MarkdownBlock content={log.content} onOpenEntity={onOpenEntity} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 弹窗 1：新建产业认知卡 */}
      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                新建产业认知卡 · 自动分配 <span className="badge badge-teal mono">认知卡 {cognition.stats.nextCardId}</span>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowCreate(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="field-group">
                <label className="field-label">主题标题（核心量化结论一目了然）<span className="field-req">*</span></label>
                <input className="input" placeholder="例：某细分产业链产能与订单实证：2027年缺口XX%" value={createForm.title} onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })} />
              </div>
              <div className="grid-3">
                <div className="field-group">
                  <label className="field-label">编目归属标注</label>
                  <input className="input" value={createForm.categoryTag} onChange={(e) => setCreateForm({ ...createForm, categoryTag: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">证据等级（铁律①必填 A/B/C）<span className="field-req">*</span></label>
                  <input className="input" value={createForm.evidenceLevel} onChange={(e) => setCreateForm({ ...createForm, evidenceLevel: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">置信度</label>
                  <input className="input" value={createForm.confidence} onChange={(e) => setCreateForm({ ...createForm, confidence: e.target.value })} />
                </div>
              </div>
              <div className="grid-2">
                <div className="field-group">
                  <label className="field-label">批次名称</label>
                  <input className="input" value={createForm.batchName} onChange={(e) => setCreateForm({ ...createForm, batchName: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">可选：新开批次 H1 标题（留空接在末尾）</label>
                  <input className="input" placeholder="例：第十八批入库（2026-11-24，XXX专题）" value={createForm.newBatchTitle} onChange={(e) => setCreateForm({ ...createForm, newBatchTitle: e.target.value })} />
                </div>
              </div>
              <div className="field-group">
                <label className="field-label" style={{ color: 'var(--emerald)' }}>客观事实 / 要点（严格不含主观映射）<span className="field-req">*</span></label>
                <textarea className="textarea" style={{ minHeight: 96 }} value={createForm.facts} onChange={(e) => setCreateForm({ ...createForm, facts: e.target.value })} />
              </div>
              <div className="grid-2">
                <div className="field-group">
                  <label className="field-label" style={{ color: 'var(--navy)' }}>产业含义（分析）</label>
                  <textarea className="textarea" value={createForm.industryImplications} onChange={(e) => setCreateForm({ ...createForm, industryImplications: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label" style={{ color: 'var(--teal)' }}>A 股映射（分析，具体标的与逻辑）</label>
                  <textarea className="textarea" value={createForm.aShareMapping} onChange={(e) => setCreateForm({ ...createForm, aShareMapping: e.target.value })} />
                </div>
              </div>
              <div className="field-group">
                <label className="field-label" style={{ color: 'var(--crimson)' }}>失效 / 更新条件（铁律②必填）<span className="field-req">*</span></label>
                <textarea className="textarea" style={{ minHeight: 68 }} value={createForm.invalidationConditions} onChange={(e) => setCreateForm({ ...createForm, invalidationConditions: e.target.value })} />
              </div>
              <div className="field-group">
                <label className="field-label">原始来源（报告名+机构+日期+页码）<span className="field-req">*</span></label>
                <input className="input" value={createForm.source} onChange={(e) => setCreateForm({ ...createForm, source: e.target.value })} />
              </div>
              <div className="grid-2">
                <div className="field-group">
                  <label className="field-label">关联方法论卡号（逗号或顿号分隔）</label>
                  <input className="input" placeholder="例：177、212、213" value={createForm.relatedMethodIds} onChange={(e) => setCreateForm({ ...createForm, relatedMethodIds: e.target.value })} />
                </div>
                <div className="field-group">
                  <label className="field-label">关联认知卡号（三位数字，逗号分隔）</label>
                  <input className="input" placeholder="例：044, 135, 138" value={createForm.relatedCognitionIds} onChange={(e) => setCreateForm({ ...createForm, relatedCognitionIds: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setShowCreate(false)}>取消</button>
              <button
                type="button"
                className="btn btn-teal"
                onClick={() =>
                  onRequestMutation('cognition.createCard', createForm, () => {
                    setShowCreate(false);
                    setSelectedCardId(cognition.stats.nextCardId);
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
      {showAmend && selectedCard && (
        <div className="modal-backdrop" onClick={() => setShowAmend(false)}>
          <div className="modal-box" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ fontWeight: 700, fontSize: 15 }}>追加增订 → 认知卡 {selectedCard.id}（不覆盖原数据）</div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAmend(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="field-group">
                <label className="field-label">增订批次/来源标注</label>
                <input className="input" value={amendForm.batchNote} onChange={(e) => setAmendForm({ ...amendForm, batchNote: e.target.value })} />
              </div>
              <div className="field-group">
                <label className="field-label">新增事实或跨源互证内容 <span className="field-req">*</span></label>
                <textarea className="textarea" style={{ minHeight: 130 }} value={amendForm.content} onChange={(e) => setAmendForm({ ...amendForm, content: e.target.value })} />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setShowAmend(false)}>取消</button>
              <button
                type="button"
                className="btn btn-teal"
                onClick={() =>
                  onRequestMutation('cognition.appendAmendment', { cardId: selectedCard.id, ...amendForm }, () => setShowAmend(false))
                }
              >
                预览变更 Diff
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 3：标记覆盖/部分证伪/归档（不删除历史） */}
      {showStatus && selectedCard && (
        <div className="modal-backdrop" onClick={() => setShowStatus(false)}>
          <div className="modal-box" style={{ maxWidth: 580 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 7 }}>
                <Archive size={16} /> 更新认知卡 {selectedCard.id} 生命周期状态（契约：不删除历史）
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowStatus(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="field-group">
                <label className="field-label">状态类型</label>
                <select className="select" value={statusForm.statusType} onChange={(e) => setStatusForm({ ...statusForm, statusType: e.target.value })}>
                  <option value="updated">被新事实覆盖 → 标记【已更新→卡号X】</option>
                  <option value="falsified">新证据证伪 → 标记【⚠️部分证伪】</option>
                  <option value="archived">事件过期 → 标记【整卡归档】</option>
                </select>
              </div>
              {statusForm.statusType === 'updated' && (
                <div className="field-group">
                  <label className="field-label">替代的新认知卡编号（3位数字）</label>
                  <input className="input" placeholder="例：138" value={statusForm.targetCardId} onChange={(e) => setStatusForm({ ...statusForm, targetCardId: e.target.value })} />
                </div>
              )}
              <div className="field-group">
                <label className="field-label">状态变更依据与说明</label>
                <textarea className="textarea" placeholder="注明新事实来源、时间边界与替代说明..." value={statusForm.statusDetail} onChange={(e) => setStatusForm({ ...statusForm, statusDetail: e.target.value })} />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setShowStatus(false)}>取消</button>
              <button
                type="button"
                className="btn btn-teal"
                onClick={() =>
                  onRequestMutation('cognition.markStatus', { cardId: selectedCard.id, ...statusForm }, () => setShowStatus(false))
                }
              >
                预览变更 Diff
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 4：原文编辑 */}
      {showRawEdit && selectedCard && (
        <div className="modal-backdrop" onClick={() => setShowRawEdit(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 7 }}>
                <Code2 size={16} /> 原文编辑 · 认知卡 {selectedCard.id}
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowRawEdit(false)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="field-group">
                <label className="field-label">修订说明</label>
                <input className="input" value={rawForm.summary} onChange={(e) => setRawForm({ ...rawForm, summary: e.target.value })} />
              </div>
              <div className="field-group">
                <label className="field-label">Markdown 正文（保留首行 ## 认知卡 {selectedCard.id}）</label>
                <textarea className="textarea textarea-mono" style={{ minHeight: 320 }} value={rawForm.rawMarkdown} onChange={(e) => setRawForm({ ...rawForm, rawMarkdown: e.target.value })} />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setShowRawEdit(false)}>取消</button>
              <button
                type="button"
                className="btn btn-teal"
                onClick={() =>
                  onRequestMutation('cognition.editCardRaw', { cardId: selectedCard.id, ...rawForm }, () => setShowRawEdit(false))
                }
              >
                预览变更 Diff
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 弹窗 5：AI 研报/文档/语音转化入库 */}
      <AiIngestionModal
        open={showAiIngest}
        targetLibrary="cognition"
        initialMode={ingestInitialMode}
        aiConfig={aiConfig}
        recentIngestJob={recentIngestJob}
        onJobStarted={onJobStarted}
        onJobFinished={onJobFinished}
        onClose={() => setShowAiIngest(false)}
        onOpenAiSettings={onOpenAiSettings}
        onFillNewCardForm={(card) => {
          setCreateForm({
            title: card.title || '',
            categoryTag: card.categoryTag || '第六编增补',
            batchName: card.batchName || '产业研报AI转化批次',
            newBatchTitle: card.newBatchTitle || '',
            facts: card.facts || '',
            source: card.source || '',
            evidenceLevel: card.evidenceLevel || 'B（权威研报/媒体）',
            industryImplications: card.industryImplications || '',
            aShareMapping: card.aShareMapping || '',
            confidence: card.confidence || '中',
            invalidationConditions: card.invalidationConditions || '',
            relatedMethodIds: card.relatedMethodIds || '',
            relatedCognitionIds: card.relatedCognitionIds || '',
          });
          setShowCreate(true);
          onToast('已将 AI 解析的认知候选卡填入「新建产业认知卡」表单，可微调后提交确认门！');
        }}
        onRequestMutation={onRequestMutation}
        onToast={onToast}
      />
    </div>
  );
};
