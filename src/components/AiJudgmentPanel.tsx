import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ExternalLink,
  Eye,
  FileJson,
  Globe,
  History,
  Loader2,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../api';
import type {
  AiProvider,
  AiSafeConfig,
  BackgroundJobSummary,
  DebateTranscript,
  ExtractedDoc,
  JudgmentEntry,
  ReconcileItem,
  ReconcileReport,
  StockResearchPacket,
} from '../types';
import { AiProviderPicker, isAiProviderReady } from './AiProviderPicker';
import { ReconcileAuditBanner } from './ReconcileAuditBanner';
import { ComplianceDisclaimerBanner } from './ComplianceDisclaimerBanner';

interface AiJudgmentPanelProps {
  aiConfig: AiSafeConfig | null;
  currentForm?: Record<string, any>;
  recentJudgmentJob?: BackgroundJobSummary | null;
  externalTargetQuery?: string;
  externalQuickTrigger?: { query: string; nonce: number } | null;
  existingJudgments?: JudgmentEntry[];
  onJumpToJudgment?: (id: string) => void;
  onPreviewJudgment?: (id: string) => void;
  onJobStarted?: (job: BackgroundJobSummary) => void;
  onJobFinished?: () => void;
  onDraftGenerated: (formPatch: Record<string, any>) => void;
  onOpenAiSettings: () => void;
  onToast: (msg: string) => void;
}

export const AiJudgmentPanel: React.FC<AiJudgmentPanelProps> = ({
  aiConfig,
  currentForm,
  recentJudgmentJob,
  externalTargetQuery,
  externalQuickTrigger,
  existingJudgments = [],
  onJumpToJudgment,
  onPreviewJudgment,
  onJobStarted,
  onJobFinished,
  onDraftGenerated,
  onOpenAiSettings,
  onToast,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stockQuery, setStockQuery] = useState('');
  const [hint, setHint] = useState('');
  const [enableWebResearch, setEnableWebResearch] = useState(true);
  const [debateMode, setDebateMode] = useState(false);
  const [sourceName, setSourceName] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [extractedMeta, setExtractedMeta] = useState<ExtractedDoc | null>(null);
  const [extracting, setExtracting] = useState(false);

  const [researchPacket, setResearchPacket] = useState<StockResearchPacket | null>(null);
  const [collectingWeb, setCollectingWeb] = useState(false);
  const [showDossierDetail, setShowDossierDetail] = useState(false);

  const [selectedProvider, setSelectedProvider] = useState<AiProvider>(aiConfig?.provider || 'codex_cli');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJobStartedAt, setActiveJobStartedAt] = useState<number>(Date.now());
  const [elapsedSec, setElapsedSec] = useState(0);
  const [lastResultInfo, setLastResultInfo] = useState<{
    summary: string;
    warnings: string[];
    auditTrail: Record<string, any> | null;
    reconcile?: ReconcileReport | null;
    debateTranscript?: DebateTranscript | null;
  } | null>(null);
  const [applyingReconcile, setApplyingReconcile] = useState(false);
  const [showDebateBox, setShowDebateBox] = useState(true);

  const [showJsonImport, setShowJsonImport] = useState(false);
  const [manualJson, setManualJson] = useState('');

  const appliedJobIds = useRef<Set<string>>(new Set());
  const onDraftGeneratedRef = useRef(onDraftGenerated);
  const onJobFinishedRef = useRef(onJobFinished);
  const onToastRef = useRef(onToast);
  onDraftGeneratedRef.current = onDraftGenerated;
  onJobFinishedRef.current = onJobFinished;
  onToastRef.current = onToast;

  const running = Boolean(activeJobId);

  useEffect(() => {
    if (aiConfig?.provider) {
      setSelectedProvider(aiConfig.provider);
    }
  }, [aiConfig?.provider]);

  useEffect(() => {
    if (externalTargetQuery && externalTargetQuery.trim() && !stockQuery.trim()) {
      setStockQuery(externalTargetQuery.trim());
    }
  }, [externalTargetQuery, stockQuery]);

  // 从「跨市场盯盘看板」点击 AI 研判跳转过来时，强制替换为目标标的并清空旧资料包
  useEffect(() => {
    if (externalQuickTrigger?.query) {
      setStockQuery(externalQuickTrigger.query.trim());
      setResearchPacket(null);
      setLastResultInfo(null);
    }
  }, [externalQuickTrigger]);

  // 刷新后如后端仍有运行中的标的研判任务，自动接管（防竞态重挂）
  useEffect(() => {
    if (
      !activeJobId &&
      recentJudgmentJob &&
      recentJudgmentJob.status === 'running' &&
      !appliedJobIds.current.has(recentJudgmentJob.id)
    ) {
      setActiveJobId(recentJudgmentJob.id);
      const ts = recentJudgmentJob.startedAt ? new Date(recentJudgmentJob.startedAt).getTime() : Date.now();
      setActiveJobStartedAt(Number.isFinite(ts) ? ts : Date.now());
    }
  }, [activeJobId, recentJudgmentJob]);

  // 后台轮询（切页/切子标签均不中断）
  useEffect(() => {
    if (!activeJobId) {
      setElapsedSec(0);
      return;
    }
    const updateElapsed = () => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - activeJobStartedAt) / 1000)));
    };
    updateElapsed();
    const tick = setInterval(updateElapsed, 1000);

    const poll = setInterval(async () => {
      try {
        const res = await api.getJob(activeJobId);
        const job = res.job;
        if (job.status === 'completed') {
          setActiveJobId(null);
          onJobFinishedRef.current?.();
          if (job.result?.form && !appliedJobIds.current.has(job.id)) {
            appliedJobIds.current.add(job.id);
            if (job.result.researchPacket) setResearchPacket(job.result.researchPacket);
            setLastResultInfo({
              summary: job.result.summary || '',
              warnings: job.result.warnings || [],
              auditTrail: job.result.auditTrail || null,
              reconcile: job.result.reconcile || null,
              debateTranscript: job.result.debateTranscript || null,
            });
            onDraftGeneratedRef.current(job.result.form);
            onToastRef.current(
              `标的研判 AI 分析完成！已自动填充「${job.result.form.target || '目标标的'}」全部字段与 ${
                (job.result.form.hypotheses || []).length
              } 条可证伪假设`
            );
          }
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          appliedJobIds.current.add(job.id);
          setActiveJobId(null);
          onJobFinishedRef.current?.();
          onToastRef.current(
            job.status === 'cancelled'
              ? '标的研判 AI 任务已取消'
              : `标的研判 AI 分析失败：${job.error || '未知错误'}`
          );
        }
      } catch {
        // retry next tick
      }
    }, 1500);

    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [activeJobId, activeJobStartedAt]);

  const effectiveQuery = stockQuery.trim() || (externalTargetQuery || '').trim();

  // 实时匹配台账中同一标的的过往研判成果（支持 A股 6 位代码、美股 Ticker 如 NVDA/TSM 及简称）
  const matchedPastJudgments = useMemo(() => {
    const q = effectiveQuery;
    if (!q || q.length < 2) return [];
    const codeM =
      q.match(/\b(\d{6})\b/) ||
      q.match(/\b([A-Za-z]{1,6})\.(?:US|O|N|NASDAQ|NYSE)\b/i) ||
      q.match(/^([A-Za-z]{1,6})$/);
    const code = (researchPacket?.target?.code || (codeM ? codeM[1] : '')).toUpperCase();
    const nameClean = (researchPacket?.target?.name || q)
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/\b\d{6}(?:\.[A-Z]{2})?\b/gi, '')
      .replace(/\b[A-Za-z]{1,6}\.(?:US|O|N|NASDAQ|NYSE)\b/gi, '')
      .trim();

    return existingJudgments.filter((j) => {
      if (code && j.stockCode && j.stockCode.toUpperCase() === code) return true;
      if (nameClean.length >= 2 && (j.stockName === nameClean || j.target.includes(nameClean))) return true;
      return false;
    });
  }, [effectiveQuery, researchPacket, existingJudgments]);

  const handleFileSelected = async (file: File | undefined) => {
    if (!file) return;
    setExtracting(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取本地文件失败'));
        reader.readAsDataURL(file);
      });
      const res = await api.extractDocument(file.name, base64);
      setExtractedMeta(res.extracted);
      setSourceName(file.name);
      setSourceText(res.extracted.text);
      onToast(
        `已解析 ${file.name}（${res.extracted.pageCount ? `${res.extracted.pageCount} 页，` : ''}${res.extracted.extractedChars} 字）`
      );
    } catch (err: any) {
      onToast(`文档提取失败：${err.message}`);
    } finally {
      setExtracting(false);
    }
  };

  const handleCollectWebResearch = async () => {
    if (!effectiveQuery) {
      onToast('请先输入标的名称或代码（支持 A股如 688809/中际旭创、美股如 NVDA/英伟达/TSM、港股如 00700）。');
      return;
    }
    setCollectingWeb(true);
    try {
      const res = await api.collectStockResearch(effectiveQuery);
      setResearchPacket(res.packet);
      setShowDossierDetail(true);
      if (res.packet.target.resolved) {
        setStockQuery(`${res.packet.target.name}（${res.packet.target.secuCode}）`);
        const isUS = res.packet.target.marketKind === 'US';
        onToast(
          isUS
            ? `已联网搜集美股 ${res.packet.target.name}（${res.packet.target.secuCode}）：GAAP 季报 ${res.packet.counts.financialPeriods}期 · 实时新闻 ${res.packet.counts.news}条 · 跨市场基准指数已锚定`
            : `已联网搜集 ${res.packet.target.name}（${res.packet.target.secuCode}）：A级财报 ${res.packet.counts.financialPeriods}期 · 官方公告 ${res.packet.counts.announcements}条 · 券商研报 ${res.packet.counts.brokerReports}篇 · 实时新闻 ${res.packet.counts.news}条`
        );
      } else {
        onToast(`未匹配到证券代码，已检索到相关实时财经新闻 ${res.packet.counts.news} 条。`);
      }
    } catch (err: any) {
      onToast(`联网采集失败：${err.message}`);
    } finally {
      setCollectingWeb(false);
    }
  };

  const handleRunAi = async () => {
    if (!effectiveQuery && sourceText.trim().length < 15) {
      onToast('请输入标的名称/6位代码（自动联网搜集资料），或上传/粘贴至少 15 字研判材料。');
      return;
    }
    if (!isAiProviderReady(aiConfig, selectedProvider)) {
      onToast('当前所选 AI 引擎尚未就绪，请先在设置中配置 API Key 或检查本机 CLI 登录状态。');
      onOpenAiSettings();
      return;
    }

    // 若联网已开启且输入了新标的（尚未采集或标的已变），先实时抓取并展示给用户透明核验，再立刻启动后台 AI 分析
    let packetToUse = researchPacket;
    const queryChanged =
      packetToUse &&
      effectiveQuery &&
      !effectiveQuery.includes(packetToUse.target.code || '__NONE__') &&
      !effectiveQuery.includes(packetToUse.target.name || '__NONE__');

    if (enableWebResearch && effectiveQuery && (!packetToUse || queryChanged)) {
      setCollectingWeb(true);
      try {
        const res = await api.collectStockResearch(effectiveQuery);
        packetToUse = res.packet;
        setResearchPacket(res.packet);
        if (res.packet.target.resolved) {
          setStockQuery(`${res.packet.target.name}（${res.packet.target.secuCode}）`);
        }
      } catch {
        packetToUse = null;
      } finally {
        setCollectingWeb(false);
      }
    }

    try {
      const codeMatch = effectiveQuery.match(/\b(\d{6})\b/);
      const res = await api.startAiJudgmentJob(
        sourceText,
        {
          targetHint: packetToUse?.target?.resolved
            ? `${packetToUse.target.name}（${packetToUse.target.secuCode}）`
            : effectiveQuery,
          stockCode: packetToUse?.target?.code || (codeMatch ? codeMatch[1] : ''),
          sourceName: sourceName || (enableWebResearch ? '实时联网资料包 + 用户输入' : '用户粘贴研判材料'),
          hint: hint.trim(),
        },
        selectedProvider,
        {
          researchPacket: enableWebResearch ? packetToUse : null,
          enableWebResearch,
          debateMode,
        }
      );
      setActiveJobStartedAt(Date.now());
      setActiveJobId(res.job.id);
      onJobStarted?.(res.job);
      onToast(
        debateMode
          ? '已启动【投委会多空对抗模式】：并发运行多头研究员 vs 空头质疑员，再由风控终审官定稿！切页不中断。'
          : enableWebResearch
          ? '已携带实时联网资料包启动后台 AI 标的深度研判！切页不中断，完成后自动填入下方全部字段。'
          : '标的研判 AI 解析已转入后台运行！切页不中断，完成后自动填表。'
      );
    } catch (err: any) {
      onToast(`启动标的研判分析失败：${err.message}`);
    }
  };

  const handleApplyJudgmentReconcile = async (items: ReconcileItem[]) => {
    if (!currentForm || !researchPacket) return;
    setApplyingReconcile(true);
    try {
      const res = await api.applyReconcileFixes({ kind: 'judgment', form: currentForm, items, researchPacket });
      onDraftGenerated(res.form);
      setLastResultInfo((prev) => (prev ? { ...prev, reconcile: res.reconcile } : prev));
      onToast(`已一键修正 ${res.applied} 处标的研判数字为实盘权威口径！`);
    } catch (err: any) {
      onToast(`修正失败：${err.message}`);
    } finally {
      setApplyingReconcile(false);
    }
  };

  const handleCopyPrompt = async () => {
    if (!effectiveQuery && sourceText.trim().length < 15) {
      onToast('请先输入标的名称/代码或研判材料。');
      return;
    }
    try {
      const codeMatch = effectiveQuery.match(/\b(\d{6})\b/);
      const res = await api.buildJudgmentPrompt(
        sourceText,
        {
          targetHint: effectiveQuery,
          stockCode: researchPacket?.target?.code || (codeMatch ? codeMatch[1] : ''),
          sourceName: sourceName || '联网资料+用户输入',
          hint,
        },
        enableWebResearch ? researchPacket : null,
        enableWebResearch
      );
      if (res.researchPacket) setResearchPacket(res.researchPacket);
      await navigator.clipboard.writeText(res.combinedPrompt);
      onToast('已复制含「实时联网 A/B 级资料 + 三库全量卡号索引」的完整 Prompt，可直接贴入网页版大模型！');
    } catch (err: any) {
      onToast(`复制 Prompt 失败：${err.message}`);
    }
  };

  const handleParseManualJson = async () => {
    try {
      const res = await api.parseManualJudgmentJson(
        manualJson,
        { targetHint: effectiveQuery, stockCode: researchPacket?.target?.code || '', sourceName: sourceName || '网页版导入' },
        researchPacket
      );
      setLastResultInfo({ summary: res.summary, warnings: res.warnings, auditTrail: null });
      onDraftGenerated(res.form);
      setShowJsonImport(false);
      setManualJson('');
      onToast(`已通过卡片编号校验并填入「${res.form.target}」标的研判表单！`);
    } catch (err: any) {
      onToast(`JSON 解析失败：${err.message}`);
    }
  };

  const handleLoadCompletedJob = async (jobId: string) => {
    try {
      const res = await api.getJob(jobId);
      if (res.job.result?.form) {
        if (res.job.result.researchPacket) setResearchPacket(res.job.result.researchPacket);
        setLastResultInfo({
          summary: res.job.result.summary || '',
          warnings: res.job.result.warnings || [],
          auditTrail: res.job.result.auditTrail || null,
        });
        onDraftGenerated(res.job.result.form);
        onToast('已从本地后台缓存载入上次 AI 标的研判草稿！');
      }
    } catch (err: any) {
      onToast(`载入失败：${err.message}`);
    }
  };

  const pctColor = (v: number | null | undefined) => {
    if (v == null) return 'var(--text-muted)';
    if (v > 0) return '#dc2626';
    if (v < 0) return '#16a34a';
    return 'var(--text-secondary)';
  };

  const snap = researchPacket?.snapshot;
  const latestFin = researchPacket?.financials?.[0];
  const latestHolder = researchPacket?.shareholders?.gdrs?.[0];
  const isUSTarget = researchPacket?.target?.marketKind === 'US';
  const currSign = isUSTarget ? '$' : researchPacket?.target?.marketKind === 'HK' ? 'HK$' : '¥';

  return (
    <div className="panel" style={{ borderColor: 'color-mix(in srgb, var(--amber) 42%, var(--border))', marginBottom: 16 }}>
      <div
        className="panel-header"
        style={{ background: 'linear-gradient(120deg, var(--bg-elev) 0%, var(--amber-soft) 100%)', flexWrap: 'wrap' }}
      >
        <h3 className="panel-title">
          <Bot size={16} color="var(--amber)" />
          AI 跨市场联网一键深度研判（支持 A股 / 美股 / 港股 · 自动搜集财报·公告·新闻·日K与中美联动基准）
        </h3>
        <AiProviderPicker
          value={selectedProvider}
          config={aiConfig}
          onChange={setSelectedProvider}
          onOpenSettings={onOpenAiSettings}
        />
      </div>

      <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {/* 核心一行：标的输入 + 联网搜集 + AI 一键分析 */}
        <div className="grid-2" style={{ gap: 10 }}>
          <div className="field-group" style={{ marginBottom: 0 }}>
            <label className="field-label">
              目标标的名称或代码（A股 / 美股 / 港股） <span className="field-req">*</span>
              <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11.5 }}>
                （支持中美跨市场联动观察，无需上传文件也可直接联网搜集）
              </span>
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                placeholder="如：NVDA / 英伟达 / TSM / 博通 / 强一股份 / 688809 / 300308 / 00700"
                value={stockQuery}
                onChange={(e) => setStockQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && effectiveQuery && !collectingWeb) {
                    e.preventDefault();
                    handleCollectWebResearch();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={collectingWeb || !effectiveQuery}
                onClick={handleCollectWebResearch}
                title="先联网抓回该 A股/美股/港股标的的真实前复权日K、A级财报/公告、实时新闻与中美跨市场基准"
              >
                {collectingWeb ? <Loader2 size={13} className="spin" /> : <Globe size={13} color="var(--teal)" />}
                {collectingWeb ? '搜集中...' : '联网搜集资料'}
              </button>
            </div>
          </div>

          <div className="field-group" style={{ marginBottom: 0 }}>
            <label className="field-label">可选重点分析指令（如中美产业链映射、MA5乖离、证伪催化）</label>
            <input
              className="input"
              placeholder="例：重点分析美股算力CapEx对A股光模块映射传导（卡片159/192）及MA5乖离"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
            />
          </div>
        </div>

        {/* 同标的历史研判成果实时匹配提示栏 */}
        {matchedPastJudgments.length > 0 && (
          <div
            style={{
              padding: '9px 12px',
              borderRadius: 8,
              background: 'var(--navy-soft)',
              border: '1px solid color-mix(in srgb, var(--navy) 28%, transparent)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--navy)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <History size={14} />
              发现该标的过往研判成果（{matchedPastJudgments.length} 次 · AI 分析时会自动纳入对照，你也可以直接点击查阅）
            </div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {matchedPastJudgments.map((mj) => (
                <div
                  key={mj.id}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px',
                    borderRadius: 7,
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    fontSize: 12,
                  }}
                >
                  <span className="badge badge-amber mono" style={{ padding: '0 5px' }}>{mj.recordKey}</span>
                  <span className="mono" style={{ color: 'var(--text-muted)' }}>{mj.date}</span>
                  {mj.score !== null && <span className="badge badge-navy num" style={{ padding: '0 5px' }}>{mj.score}分</span>}
                  {onPreviewJudgment && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: '1px 6px', fontSize: 11.5 }}
                      onClick={() => onPreviewJudgment(mj.id)}
                      title="右侧抽屉对照阅读（不打断当前起草）"
                    >
                      <Eye size={11} /> 抽屉对照
                    </button>
                  )}
                  {onJumpToJudgment && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: '1px 6px', fontSize: 11.5 }}
                      onClick={() => onJumpToJudgment(mj.id)}
                      title="跳转到「标的研判与回填」查看完整历史记录与回填"
                    >
                      跳转查看 <ArrowRight size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 联网采集资料包摘要与展开核验区 */}
        {researchPacket && (
          <div
            style={{
              borderRadius: 9,
              background: 'var(--bg-soft)',
              border: '1px solid var(--border-strong)',
              padding: '10px 13px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 12 }}>
                <span className="badge badge-teal">
                  <Globe size={11} /> 已联网采集
                </span>
                {researchPacket.target.resolved && (
                  <span className="badge badge-navy mono">
                    {researchPacket.target.name} ({researchPacket.target.secuCode}) {researchPacket.target.boardType}
                  </span>
                )}
                {snap?.ok && (
                  <span className="mono" style={{ fontWeight: 700, color: pctColor(snap.pct) }}>
                    现价 {currSign}{snap.close} ({snap.pct != null ? `${snap.pct > 0 ? '+' : ''}${snap.pct}%` : '-'})
                  </span>
                )}
                {snap?.ok && (
                  <span className="mono" style={{ color: 'var(--text-secondary)' }}>
                    MA5 {currSign}{snap.ma5 ?? '-'} (乖离{' '}
                    <strong style={{ color: Math.abs(snap.ma5BiasPct || 0) > 8 ? 'var(--crimson)' : 'var(--text)' }}>
                      {snap.ma5BiasPct != null ? `${snap.ma5BiasPct > 0 ? '+' : ''}${snap.ma5BiasPct}%` : '-'}
                    </strong>
                    ) · 市值{' '}
                    {isUSTarget
                      ? snap.totalCapUsdB != null
                        ? `$${snap.totalCapUsdB}B`
                        : '-'
                      : `${snap.totalCapYi ?? '-'}亿`}{' '}
                    · PE {snap.peTtm ?? '-'}
                  </span>
                )}
              </div>

              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowDossierDetail((v) => !v)}
              >
                {showDossierDetail ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                {showDossierDetail ? '收起联网资料明细' : '展开核验联网资料明细'}
              </button>
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 11.5 }}>
              <span className="badge badge-emerald">
                {isUSTarget ? `A级GAAP季报 ${researchPacket.counts.financialPeriods} 期` : `A级财报 ${researchPacket.counts.financialPeriods} 期`}
              </span>
              {!isUSTarget && (
                <>
                  <span className="badge badge-emerald">A级官方公告 {researchPacket.counts.announcements} 条</span>
                  <span className="badge badge-navy">B级券商研报 {researchPacket.counts.brokerReports} 篇</span>
                </>
              )}
              <span className="badge badge-amber">实时财经新闻 {researchPacket.counts.news} 条</span>
              {(researchPacket.crossMarketBenchmarks?.length || 0) > 0 && (
                <span className="badge badge-teal">
                  跨市场基准 {researchPacket.crossMarketBenchmarks?.length} 指数已锚定
                </span>
              )}
              {latestFin && (
                <span className="mono" style={{ color: 'var(--text-secondary)' }}>
                  最新 {latestFin.period}：营收{' '}
                  {isUSTarget ? `$${latestFin.revenueUsdB ?? '-'}B` : `${latestFin.revenueYi ?? '-'}亿`} (
                  {latestFin.revenueYoyPct != null ? `${latestFin.revenueYoyPct > 0 ? '+' : ''}${latestFin.revenueYoyPct}%` : '-'}) · 净利{' '}
                  {isUSTarget ? `$${latestFin.parentNetProfitUsdB ?? '-'}B` : `${latestFin.parentNetProfitYi ?? '-'}亿`} (
                  {latestFin.parentNetProfitYoyPct != null ? `${latestFin.parentNetProfitYoyPct > 0 ? '+' : ''}${latestFin.parentNetProfitYoyPct}%` : '-'}) · 毛利率{' '}
                  {latestFin.grossMarginPct ?? '-'}%
                </span>
              )}
              {latestHolder && (
                <span className="mono" style={{ color: 'var(--text-muted)' }}>
                  · 股东 {latestHolder.holderCount?.toLocaleString()}户 ({latestHolder.holderChangePct != null ? `${latestHolder.holderChangePct > 0 ? '+' : ''}${latestHolder.holderChangePct}%` : '-'}, {latestHolder.concentration})
                </span>
              )}
            </div>

            {showDossierDetail && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 6, borderTop: '1px solid var(--border)', fontSize: 12 }}>
                {(researchPacket.crossMarketBenchmarks?.length || 0) > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, color: 'var(--teal)' }}>跨市场实时基准：</span>
                    {researchPacket.crossMarketBenchmarks!.map((bm) => (
                      <span
                        key={bm.secid}
                        className="mono"
                        style={{
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: 'var(--bg-elev)',
                          border: '1px solid var(--border)',
                          fontSize: 11,
                        }}
                      >
                        {bm.name}{' '}
                        <strong style={{ color: pctColor(bm.pct) }}>
                          {bm.pct != null ? `${bm.pct > 0 ? '+' : ''}${bm.pct}%` : '-'}
                        </strong>
                      </span>
                    ))}
                  </div>
                )}

                <div className="grid-2" style={{ gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, color: 'var(--emerald)', marginBottom: 4 }}>
                      {isUSTarget ? 'A级 · 美股 GAAP 历期财报趋势' : 'A级 · 最新交易所公告（前 5 条，可点击溯源）'}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {isUSTarget ? (
                        researchPacket.financials.slice(0, 5).map((f, i) => (
                          <div key={i} className="mono" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11.5 }}>
                            <strong>{f.period}</strong>
                            <span>营收 ${f.revenueUsdB ?? '-'}B ({f.revenueYoyPct != null ? `${f.revenueYoyPct > 0 ? '+' : ''}${f.revenueYoyPct}%` : '-'})</span>
                            <span>净利 ${f.parentNetProfitUsdB ?? '-'}B ({f.parentNetProfitYoyPct != null ? `${f.parentNetProfitYoyPct > 0 ? '+' : ''}${f.parentNetProfitYoyPct}%` : '-'})</span>
                            <span>毛利 {f.grossMarginPct ?? '-'}%</span>
                          </div>
                        ))
                      ) : (
                        researchPacket.announcements.slice(0, 5).map((a, i) => (
                          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                            <span className="mono" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{a.date}</span>
                            {a.url ? (
                              <a href={a.url} target="_blank" rel="noreferrer" style={{ color: 'var(--text)', textDecoration: 'none' }}>
                                [{a.category}] {a.title} <ExternalLink size={10} style={{ verticalAlign: -1 }} />
                              </a>
                            ) : (
                              <span>[{a.category}] {a.title}</span>
                            )}
                          </div>
                        ))
                      )}
                      {!isUSTarget && researchPacket.announcements.length === 0 && (
                        <span style={{ color: 'var(--text-muted)' }}>暂无公告</span>
                      )}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontWeight: 700, color: 'var(--navy)', marginBottom: 4 }}>
                      {isUSTarget ? 'B/C级 · 最新中文财经新闻与产业链动态' : 'B级 · 券商研报盈利预测 & 实时财经新闻'}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {researchPacket.brokerReports.slice(0, 3).map((r, i) => (
                        <div key={`r-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                          <span className="badge badge-navy" style={{ fontSize: 10, padding: '0 4px' }}>{r.org}</span>
                          <a href={r.url} target="_blank" rel="noreferrer" style={{ color: 'var(--text)', textDecoration: 'none' }}>
                            {r.title}
                            {r.epsThisYear != null ? ` (当年EPS ${r.epsThisYear}/次年 ${r.epsNextYear ?? '-'})` : ''}
                          </a>
                        </div>
                      ))}
                      {researchPacket.news.slice(0, isUSTarget ? 6 : 3).map((n, i) => (
                        <div key={`n-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'baseline', color: 'var(--text-secondary)' }}>
                          <span className="mono" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{n.date.slice(5, 10)}</span>
                          <a href={n.url} target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>
                            [{n.media}] {n.title}
                          </a>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 可选补充材料（支持叠加 PDF/DOCX 研报或调研纪要，也可以留空纯走联网分析） */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5, flexWrap: 'wrap', gap: 6 }}>
            <label className="field-label" style={{ margin: 0 }}>
              可选补充材料（留空则纯用联网实时资料；也可叠加上传 PDF/DOCX 深度研报或粘贴草根调研纪要）
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm,.csv,.json"
                style={{ display: 'none' }}
                onChange={(e) => handleFileSelected(e.target.files?.[0])}
              />
              <button type="button" className="btn btn-sm" disabled={extracting} onClick={() => fileInputRef.current?.click()}>
                <Upload size={13} /> {extracting ? '提取中...' : '叠加上传 PDF / DOCX / MD'}
              </button>
              {sourceText && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setSourceText('');
                    setExtractedMeta(null);
                    setSourceName('');
                  }}
                >
                  <Trash2 size={13} /> 清空
                </button>
              )}
            </div>
          </div>

          {extractedMeta && (
            <div style={{ padding: '6px 10px', borderRadius: 6, background: 'var(--emerald-soft)', fontSize: 12, marginBottom: 6 }}>
              <CheckCircle2 size={13} style={{ verticalAlign: -2, marginRight: 5, color: 'var(--emerald)' }} />
              已附加 <strong>{extractedMeta.fileName}</strong>
              {extractedMeta.pageCount ? `（${extractedMeta.pageCount} 页）` : ''} ·{' '}
              <strong className="num">{extractedMeta.extractedChars.toLocaleString()}</strong> 字
            </div>
          )}

          <textarea
            className="textarea"
            style={{ minHeight: 74 }}
            placeholder="（可选）粘贴额外调研纪要、券商观点或个人关注逻辑；留空时系统将直接基于上方标的的实时联网财报/公告/研报/新闻/K线 + 现行三库完成深度研判..."
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
          />
        </div>

        {/* 主动作条 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-amber"
              disabled={running || collectingWeb || (!effectiveQuery && sourceText.trim().length < 15)}
              onClick={handleRunAi}
            >
              {running || collectingWeb ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              {collectingWeb
                ? '正在联网搜集财报/公告/研报...'
                : running
                ? `后台深度研判中 (${elapsedSec}s，切页不中断)...`
                : enableWebResearch
                ? 'AI 联网一键深度分析并自动填表'
                : 'AI 解析本地材料并自动填表'}
            </button>

            <button type="button" className="btn btn-sm" onClick={handleCopyPrompt} disabled={!effectiveQuery && sourceText.trim().length < 15}>
              <ClipboardCopy size={13} /> 复制联网完整 Prompt
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setShowJsonImport((v) => !v)}>
              <FileJson size={13} /> 导入 JSON
            </button>
            {!running && recentJudgmentJob && recentJudgmentJob.status === 'completed' && recentJudgmentJob.hasResult && (
              <button type="button" className="btn btn-sm" onClick={() => handleLoadCompletedJob(recentJudgmentJob.id)}>
                <CheckCircle2 size={13} color="var(--emerald)" /> 载入上次后台草稿 ({recentJudgmentJob.meta?.targetHint || ''})
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={enableWebResearch}
                onChange={(e) => setEnableWebResearch(e.target.checked)}
              />
              联网搜集财报/公告/研报/新闻
            </label>
            <label
              style={{
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                color: debateMode ? 'var(--crimson)' : 'var(--text-secondary)',
                fontWeight: debateMode ? 700 : 500,
                cursor: 'pointer',
              }}
              title="多头研究员 vs 空头质疑员独立交锋，再由风控终审官无谄媚定稿（参考 TradingAgents）"
            >
              <input
                type="checkbox"
                checked={debateMode}
                onChange={(e) => setDebateMode(e.target.checked)}
              />
              投委会多空对抗辩论（Bull vs Bear 终审）
            </label>
          </div>
        </div>

        {showJsonImport && (
          <div className="panel panel-pad" style={{ background: 'var(--bg-soft)' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>粘贴网页版大模型返回的标的研判 JSON：</div>
            <textarea
              className="textarea textarea-mono"
              style={{ minHeight: 120, marginBottom: 8 }}
              value={manualJson}
              onChange={(e) => setManualJson(e.target.value)}
              placeholder='{"target": "...", "score": "6.5", "conclusion": "...", "hypotheses": [...]}'
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn btn-sm" onClick={() => setShowJsonImport(false)}>收起</button>
              <button type="button" className="btn btn-amber btn-sm" onClick={handleParseManualJson} disabled={!manualJson.trim()}>
                校验并填入下方研判表单
              </button>
            </div>
          </div>
        )}

        {lastResultInfo && (
          <div
            className="field-block"
            style={{
              marginBottom: 0,
              background: 'var(--navy-soft)',
              borderColor: 'color-mix(in srgb, var(--navy) 28%, transparent)',
              fontSize: 12.5,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
              <strong style={{ color: 'var(--navy)' }}>
                AI 联网研判完成并已填入下方表单（尚未写盘，请人工核验后点「预览变更 Diff 并写入台账」）
              </strong>
              {lastResultInfo.auditTrail && (
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {String(lastResultInfo.auditTrail.provider || '').toUpperCase()} ({lastResultInfo.auditTrail.model || ''}) ·{' '}
                  {((lastResultInfo.auditTrail.latencyMs || 0) / 1000).toFixed(1)}s
                  {lastResultInfo.auditTrail.webGrounded ? ' · 已联网锚定A/B级资料' : ''}
                </span>
              )}
            </div>
            {lastResultInfo.summary && <div style={{ color: 'var(--text-secondary)' }}>{lastResultInfo.summary}</div>}
            {lastResultInfo.warnings.length > 0 && (
              <div style={{ marginTop: 6, color: 'var(--amber)' }}>
                <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                {lastResultInfo.warnings.join('；')}
              </div>
            )}

            {/* P0-2：标的研判数值与监管红线对账门禁 */}
            <ReconcileAuditBanner
              reconcile={lastResultInfo.reconcile}
              applying={applyingReconcile}
              onApplyAutoFix={currentForm ? handleApplyJudgmentReconcile : undefined}
            />

            {/* P2-1：投委会多空对抗辩论实录 */}
            {lastResultInfo.debateTranscript?.enabled && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
                  <strong style={{ color: 'var(--crimson)' }}>
                    投委会多空对抗辩论实录（耗时 {((lastResultInfo.debateTranscript.totalLatencyMs || 0) / 1000).toFixed(1)}s）
                  </strong>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowDebateBox((v) => !v)}>
                    {showDebateBox ? '收起辩论实录' : '展开多空交锋'}
                  </button>
                </div>
                {showDebateBox && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {lastResultInfo.debateTranscript.chiefArbitration && (
                      <div style={{ padding: '7px 10px', borderRadius: 7, background: 'var(--bg-elev)', borderLeft: '3.5px solid var(--navy)' }}>
                        <strong>风控终审官裁决：</strong>
                        {lastResultInfo.debateTranscript.chiefArbitration}
                      </div>
                    )}
                    <div className="grid-2" style={{ gap: 8 }}>
                      <div style={{ padding: '8px 10px', borderRadius: 7, background: 'var(--bg-elev)', borderTop: '3px solid #dc2626' }}>
                        <strong style={{ color: '#dc2626' }}>多头研究员陈述</strong>
                        <div style={{ marginTop: 4 }}>{lastResultInfo.debateTranscript.bullBrief?.thesis || '-'}</div>
                        {(lastResultInfo.debateTranscript.bullBrief?.catalysts || []).length > 0 && (
                          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                            {lastResultInfo.debateTranscript.bullBrief.catalysts!.map((c, idx) => (
                              <li key={idx}>{c}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div style={{ padding: '8px 10px', borderRadius: 7, background: 'var(--bg-elev)', borderTop: '3px solid #16a34a' }}>
                        <strong style={{ color: '#16a34a' }}>空头质疑员反驳（魔鬼代言人）</strong>
                        <div style={{ marginTop: 4 }}>{lastResultInfo.debateTranscript.bearBrief?.thesis || '-'}</div>
                        {(lastResultInfo.debateTranscript.bearBrief?.killSwitches || []).length > 0 && (
                          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                            {lastResultInfo.debateTranscript.bearBrief.killSwitches!.map((c, idx) => (
                              <li key={idx}>{c}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <ComplianceDisclaimerBanner variant="footer" showExecutionBoundary />
    </div>
  );
};
