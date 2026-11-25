import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ClipboardCopy,
  DownloadCloud,
  FileJson,
  Loader2,
  RefreshCw,
  Settings2,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { AiProvider, AiSafeConfig, AutoReviewResult, BackgroundJobSummary, MarketPacket, ReconcileItem, ReconcileReport } from '../types';
import { IntradaySparkline } from './IntradaySparkline';
import { AiProviderPicker, getAiProviderModelLabel, isAiProviderReady } from './AiProviderPicker';
import { ReconcileAuditBanner } from './ReconcileAuditBanner';
import { ComplianceDisclaimerBanner } from './ComplianceDisclaimerBanner';

interface AutoDailyReviewPanelProps {
  aiConfig: AiSafeConfig | null;
  packet: MarketPacket | null;
  currentForm?: Record<string, any>;
  recentDailyJob?: BackgroundJobSummary | null;
  externalNotesAppend?: { text: string; nonce: number } | null;
  onPacketFetched: (packet: MarketPacket) => void;
  onDraftGenerated: (form: Record<string, any>, audit: AutoReviewResult['auditTrail'] | null, warnings?: string[]) => void;
  onJobStarted?: (job: BackgroundJobSummary) => void;
  onJobFinished?: () => void;
  onOpenAiSettings: () => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

export function resolveDailyWatchStocksPayload(params: {
  userWatchDraft: string | null;
  watchStocksConfigured?: boolean;
  configuredWatchStocks?: string[] | null;
}): string[] | undefined {
  if (params.userWatchDraft !== null) {
    return params.userWatchDraft
      .split(/[,，、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (params.watchStocksConfigured) {
    return (params.configuredWatchStocks || []).map((s) => String(s).trim()).filter(Boolean);
  }
  return undefined;
}

export const AutoDailyReviewPanel: React.FC<AutoDailyReviewPanelProps> = ({
  aiConfig,
  packet,
  currentForm,
  recentDailyJob,
  externalNotesAppend,
  onPacketFetched,
  onDraftGenerated,
  onJobStarted,
  onJobFinished,
  onOpenAiSettings,
  onToast,
}) => {
  // 分离保存默认预览值与用户手动编辑草稿，防止异步自选预填晚返回时覆盖用户输入
  const [defaultWatchPreview, setDefaultWatchPreview] = useState(
    aiConfig?.watchStocksConfigured ? (aiConfig.watchStocks || []).filter(Boolean).join(', ') : ''
  );
  const [userWatchDraft, setUserWatchDraft] = useState<string | null>(null);
  const displayedWatchInput = userWatchDraft !== null ? userWatchDraft : defaultWatchPreview;
  const [fetchingMarket, setFetchingMarket] = useState(false);
  const [extraNotes, setExtraNotes] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<AiProvider>(aiConfig?.provider || 'codex_cli');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJobStartedAt, setActiveJobStartedAt] = useState<number>(Date.now());
  const [elapsedSec, setElapsedSec] = useState(0);
  const [lastAudit, setLastAudit] = useState<AutoReviewResult['auditTrail'] | null>(null);
  const [lastReconcile, setLastReconcile] = useState<ReconcileReport | null>(null);
  const [applyingReconcile, setApplyingReconcile] = useState(false);
  const [manualWarnings, setManualWarnings] = useState<string[]>([]);
  const [showBoardDetail, setShowBoardDetail] = useState(true);
  const [showImportModal, setShowImportModal] = useState(false);
  const [manualJsonText, setManualJsonText] = useState('');
  const [importingJson, setImportingJson] = useState(false);
  const appliedJobIds = useRef<Set<string>>(new Set());

  const onDraftGeneratedRef = useRef(onDraftGenerated);
  const onJobFinishedRef = useRef(onJobFinished);
  const onToastRef = useRef(onToast);
  onDraftGeneratedRef.current = onDraftGenerated;
  onJobFinishedRef.current = onJobFinished;
  onToastRef.current = onToast;

  const runningAi = Boolean(activeJobId);

  useEffect(() => {
    if (aiConfig?.provider) {
      setSelectedProvider(aiConfig.provider);
    }
  }, [aiConfig?.provider]);

  // 与 AI 设置框和后端保持同一默认观察池口径：
  // 1) 若用户已在 AI 设置保存 watchStocksConfigured（含显式清空 []），默认预览严格展示保存值；
  // 2) 未单独配置时，异步预填仅更新 defaultWatchPreview，绝不覆盖用户已经手动输入的 userWatchDraft。
  const aiWatchStocksKey = (aiConfig?.watchStocks || []).filter(Boolean).join(',');
  const prevAiConfigSigRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    const nextSig = `${aiConfig?.watchStocksConfigured ? '1' : '0'}:${aiWatchStocksKey}`;
    if (prevAiConfigSigRef.current !== null && prevAiConfigSigRef.current !== nextSig) {
      // 仅当 AI 设置中的观察股配置确实发生变更时，重置局部草稿以同步最新设置
      setUserWatchDraft(null);
    }
    prevAiConfigSigRef.current = nextSig;

    if (aiConfig?.watchStocksConfigured) {
      setDefaultWatchPreview((aiConfig.watchStocks || []).filter(Boolean).join(', '));
      return () => {
        alive = false;
      };
    }
    setDefaultWatchPreview('');
    api
      .getWatchlist()
      .then((res) => {
        if (!alive || !res?.configured || res?.isDemo) return;
        const codes = (res.items || [])
          .filter((it) => it && it.marketKind === 'CN')
          .map((it) => String(it.code || it.secid || '').replace(/^\d+\./, '').trim())
          .filter((code) => /^\d{6}$/.test(code))
          .slice(0, 10);
        if (codes.length > 0) setDefaultWatchPreview(codes.join(', '));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [aiConfig?.watchStocksConfigured, aiWatchStocksKey]);

  useEffect(() => {
    if (!externalNotesAppend?.text) return;
    setExtraNotes((prev) => {
      const markerStart = '【短线盘面与主线题材实时快照】';
      const markerEnd = '【/短线快照】';
      const block = `${markerStart}\n${externalNotesAppend.text}\n${markerEnd}`;
      if (prev.includes(markerStart) && prev.includes(markerEnd)) {
        const idxA = prev.indexOf(markerStart);
        const idxB = prev.indexOf(markerEnd) + markerEnd.length;
        return `${prev.slice(0, idxA)}${block}${prev.slice(idxB)}`;
      }
      return prev.trim() ? `${prev.trim()}\n\n${block}` : block;
    });
  }, [externalNotesAppend]);

  // 如果用户刷新浏览器后重新进来，且后端已有正在跑的每日复盘任务，自动接管跟踪（排除已处理完的 jobId，防竞态重挂）
  useEffect(() => {
    if (
      !activeJobId &&
      recentDailyJob &&
      recentDailyJob.status === 'running' &&
      !appliedJobIds.current.has(recentDailyJob.id)
    ) {
      setActiveJobId(recentDailyJob.id);
      const ts = recentDailyJob.startedAt ? new Date(recentDailyJob.startedAt).getTime() : Date.now();
      setActiveJobStartedAt(Number.isFinite(ts) ? ts : Date.now());
    }
  }, [activeJobId, recentDailyJob]);

  // 轮询当前后台复盘任务（由于页面 Keep-Alive + 服务端异步执行，切到别的页面也能无缝跑完自动回填！）
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
          if (job.result && !appliedJobIds.current.has(job.id)) {
            appliedJobIds.current.add(job.id);
            setLastAudit(job.result.auditTrail || null);
            setLastReconcile(job.result.reconcile || null);
            onDraftGeneratedRef.current(job.result.form, job.result.auditTrail || null, job.result.auditTrail?.warnings);
            onToastRef.current(
              `后台复盘完成！${job.result.auditTrail?.provider || ''} 已基于 ${job.result.auditTrail?.intradayBarsGrounded || ''} 条真实 1m K线自动回填十节表单`
            );
          }
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          appliedJobIds.current.add(job.id);
          setActiveJobId(null);
          onJobFinishedRef.current?.();
          onToastRef.current(
            job.status === 'cancelled'
              ? '后台复盘任务已取消'
              : `后台复盘失败：${job.error || '未知错误'}`
          );
        }
      } catch {
        // transient network hiccup, retry next tick
      }
    }, 1500);

    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [activeJobId, activeJobStartedAt]);

  const handleLoadCompletedJob = async (jobId: string) => {
    try {
      const res = await api.getJob(jobId);
      if (res.job.result?.form) {
        setLastAudit(res.job.result.auditTrail || null);
        onDraftGenerated(res.job.result.form, res.job.result.auditTrail || null, res.job.result.auditTrail?.warnings);
        onToast('已从本地后台任务缓存恢复上次生成的十节复盘草稿！');
      }
    } catch (err: any) {
      onToast(`恢复失败：${err.message}`);
    }
  };

  const handleFetchMarket = async () => {
    setFetchingMarket(true);
    try {
      const codes = resolveDailyWatchStocksPayload({
        userWatchDraft,
        watchStocksConfigured: aiConfig?.watchStocksConfigured,
        configuredWatchStocks: aiConfig?.watchStocks,
      });
      const res = await api.fetchDailyMarket(undefined, codes);
      onPacketFetched(res.packet);
      onToast(
        `已抓回 ${res.packet.actualTradeDate} 共 ${res.packet.totalIntradayBars} 条真实 1 分钟 K 线，并自动通过证据核验！`,
        'success'
      );
    } catch (err: any) {
      onToast(`抓取分钟数据失败：${err.message}`, 'error');
    } finally {
      setFetchingMarket(false);
    }
  };

  const handleLoadDemoPacket = async () => {
    setFetchingMarket(true);
    try {
      const res = await api.getDemoMarketPacket();
      onPacketFetched(res.packet);
      onToast('已载入内置脱敏离线演示数据包（零外网/零 Key 即可完整体验分时图谱、证据核验与 HTML 研报导出）');
    } catch (err: any) {
      onToast(`载入离线演示包失败：${err.message}`);
    } finally {
      setFetchingMarket(false);
    }
  };

  const isProviderReady = (p: AiProvider) => isAiProviderReady(aiConfig, p);

  const providerLabel = (p: AiProvider) => getAiProviderModelLabel(aiConfig, p);

  const handleRunAi = async () => {
    if (!packet) {
      onToast('按防幻觉铁律，请先点击「拉取真实 1 分钟数据」后再执行 AI 自动复盘！');
      return;
    }
    const provider = selectedProvider;
    if (!isProviderReady(provider)) {
      onToast(`所选引擎 ${providerLabel(provider)} 尚未就绪（未登录 CLI 或未配 Key），请先检查设置。`);
      onOpenAiSettings();
      return;
    }
    setManualWarnings([]);
    try {
      const res = await api.startAutoDailyReviewJob(packet, extraNotes, provider);
      setActiveJobStartedAt(Date.now());
      setActiveJobId(res.job.id);
      onJobStarted?.(res.job);
      onToast('复盘任务已转入本地后台运行！你现在可以自由切换页面查看卡片，完成后会自动回填并提醒。');
    } catch (err: any) {
      onToast(`启动后台复盘失败：${err.message}`);
    }
  };

  const handleCopyPrompt = async () => {
    if (!packet) {
      onToast('请先拉取真实 1 分钟数据包再生成 Prompt。');
      return;
    }
    try {
      const res = await api.buildReviewPrompt(packet, extraNotes);
      await navigator.clipboard.writeText(res.combinedPrompt);
      onToast('已复制「防幻觉完整 Prompt + 真实分钟数据包」，可直接贴入 ChatGPT / Gemini 网页版运行！');
    } catch (err: any) {
      onToast(`生成或复制 Prompt 失败：${err.message}`);
    }
  };

  const handleImportManualJson = async () => {
    if (!packet) return;
    setImportingJson(true);
    try {
      const res = await api.parseManualReviewJson(packet, manualJsonText);
      setManualWarnings(res.warnings || []);
      setLastAudit(null);
      setLastReconcile(res.reconcile || null);
      onDraftGenerated(res.form, null, res.warnings);
      setShowImportModal(false);
      setManualJsonText('');
      onToast('已通过防幻觉与卡片编号校验，并自动填充十节复盘表单！');
    } catch (err: any) {
      onToast(`JSON 解析失败：${err.message}`);
    } finally {
      setImportingJson(false);
    }
  };

  const pctColor = (v: number | null | undefined) => {
    if (v == null) return 'var(--text-muted)';
    if (v > 0) return '#dc2626';
    if (v < 0) return '#16a34a';
    return 'var(--text-secondary)';
  };

  const fmtPct = (v: number | null | undefined) => {
    if (v == null) return '-';
    return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
  };

  const handleApplyReconcileFix = async (items: ReconcileItem[]) => {
    if (!currentForm || !packet) return;
    setApplyingReconcile(true);
    try {
      const res = await api.applyReconcileFixes({ kind: 'daily', form: currentForm, items, packet });
      onDraftGenerated(res.form, lastAudit, []);
      setLastReconcile(res.reconcile);
      onToast(`数值对账门禁已自动修正 ${res.applied} 处数字为实盘权威口径！`);
    } catch (err: any) {
      onToast(`自动修正失败：${err.message}`);
    } finally {
      setApplyingReconcile(false);
    }
  };

  const activeModelName = providerLabel(selectedProvider);
  const activeHasKey = isProviderReady(selectedProvider);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* =================================================================== */}
      {/* Part 1: 真实 1 分钟级行情与情绪抓数底座 */}
      {/* =================================================================== */}
      <div className="panel">
        <div className="panel-header" style={{ flexWrap: 'wrap' }}>
          <h3 className="panel-title">
            <Activity size={16} color="var(--navy)" />
            Step 0 · 真实日K + 1 分钟级行情与全市场三池采集（防幻觉唯一数据源）
          </h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="input mono"
              style={{ width: 265, padding: '5px 9px', fontSize: 12 }}
              placeholder="观察股代码（留空默认取当前空间 A 股自选，自动附加当日高标龙头）"
              value={displayedWatchInput}
              onChange={(e) => {
                setUserWatchDraft(e.target.value);
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleLoadDemoPacket}
              disabled={fetchingMarket}
              title="无需外网或数据源 Key，一键载入内置脱敏演示数据包体验完整复盘流程"
            >
              <FileJson size={13} /> 载入离线演示包
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleFetchMarket}
              disabled={fetchingMarket}
            >
              {fetchingMarket ? <RefreshCw size={13} className="spin" /> : <DownloadCloud size={14} />}
              {fetchingMarket ? '正在并发采集 1 分钟K线...' : '拉取今日真实 1 分钟数据'}
            </button>
          </div>
        </div>

        <div className="panel-pad">
          {aiConfig?.watchStocksLegacyPendingConfirm && (
            <div
              className="field-block"
              style={{
                marginBottom: 12,
                background: 'var(--amber-soft)',
                borderColor: 'var(--amber)',
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <span>
                检测到旧版自动保存的固定观察股（{(aiConfig.legacyWatchStocks || []).slice(0, 3).join(', ')} 等），确认前已自动回退为当前空间自选。
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={async () => {
                    try {
                      const res = await api.saveAiConfig({ confirmLegacyWatchStocks: 'use_watchlist' });
                      window.dispatchEvent(new CustomEvent('srw-ai-config-updated', { detail: res.config }));
                      onToast('已确认：日度复盘默认沿用当前工作空间自选', 'success');
                    } catch (err: any) {
                      onToast(`保存确认失败：${err.message}`, 'error');
                    }
                  }}
                >
                  沿用当前空间自选（推荐）
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    try {
                      const res = await api.saveAiConfig({ confirmLegacyWatchStocks: 'keep' });
                      window.dispatchEvent(new CustomEvent('srw-ai-config-updated', { detail: res.config }));
                      onToast('已确认保留旧版 6 只观察股作为自定义观察池', 'success');
                    } catch (err: any) {
                      onToast(`保存确认失败：${err.message}`, 'error');
                    }
                  }}
                >
                  保留旧版 6 只观察股
                </button>
              </div>
            </div>
          )}
          {!packet ? (
            <div
              style={{
                padding: '20px 16px',
                background: 'var(--bg-soft)',
                borderRadius: 9,
                border: '1px dashed var(--border-strong)',
                textAlign: 'center',
                color: 'var(--text-secondary)',
                fontSize: 13,
              }}
            >
              点击右上角 <strong>「拉取今日真实 1 分钟数据」</strong>，后端将实时并发抓取：
              <br />
              7 大指数权威日K + 正式交易 241 条 1 分钟分时（含均价线与精确分钟转折点）· 沪深放缩量与广度 · 全量涨停/跌停/炸板三池与 ≥3 只行业聚类 · 观察股+连板龙头 1 分钟分时 · 隔夜美股。
              <br />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                所有抓取不到的字段（DR001 / 央行逆回购 / 两融 / 龙虎榜席位）将自动标为 missing(null) 并登记缺口，严禁大模型凭空乱造。
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* 权威数据采集状态横幅 */}
              <div
                style={{
                  padding: '9px 13px',
                  borderRadius: 8,
                  background: 'var(--emerald-soft)',
                  border: '1px solid color-mix(in srgb, var(--emerald) 30%, transparent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                  fontSize: 12.5,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <CheckCircle2 size={15} color="var(--emerald)" />
                  <strong>交易日 {packet.actualTradeDate}</strong>
                  <span className="badge badge-navy mono">真实 1m K线 {packet.totalIntradayBars} 条</span>
                  <span className="badge badge-emerald">证据核验：{packet.evidenceCheck.status}</span>
                </div>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  冻结时点 {packet.fetchedAt} · 已自动存档至 market_packets/
                </span>
              </div>

              {packet.dateMismatchWarning && (
                <div className="field-block" style={{ marginBottom: 0, background: 'var(--amber-soft)', borderColor: 'var(--amber)', fontSize: 12.5 }}>
                  <AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                  {packet.dateMismatchWarning}
                </div>
              )}

              {/* 全市场量能 / 广度 / 情绪四格摘要 */}
              <div className="kpi-grid" style={{ marginBottom: 0 }}>
                <div className="panel panel-pad" style={{ padding: '11px 14px' }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>沪深两市总成交</div>
                  <div className="num" style={{ fontSize: 20, fontWeight: 800, marginTop: 2 }}>
                    {packet.marketSummary.twoMarketAmtYi ? `${(packet.marketSummary.twoMarketAmtYi / 10000).toFixed(3)} 万亿` : '-'}
                  </div>
                  <div className="num" style={{ fontSize: 12, color: pctColor(packet.marketSummary.volDeltaYi) }}>
                    {packet.marketSummary.volDeltaYi != null
                      ? `较前日 ${packet.marketSummary.volDeltaYi > 0 ? '放量 +' : '缩量 '}${packet.marketSummary.volDeltaYi} 亿 (${fmtPct(packet.marketSummary.volDeltaPct)})`
                      : '昨日成交待核'}
                  </div>
                </div>

                <div className="panel panel-pad" style={{ padding: '11px 14px' }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>全市场广度与红盘率</div>
                  <div className="num" style={{ fontSize: 20, fontWeight: 800, marginTop: 2, color: pctColor((packet.marketSummary.breadth.redRatePct || 50) - 50) }}>
                    {packet.marketSummary.breadth.redRatePct != null ? `${packet.marketSummary.breadth.redRatePct}%` : '-'}
                  </div>
                  <div className="num" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    涨 {packet.marketSummary.breadth.up ?? '-'} / 跌 {packet.marketSummary.breadth.down ?? '-'} / 平 {packet.marketSummary.breadth.flat ?? '-'}
                  </div>
                </div>

                <div className="panel panel-pad" style={{ padding: '11px 14px' }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>非ST涨停 / 跌停 / 炸板</div>
                  <div className="num" style={{ fontSize: 20, fontWeight: 800, marginTop: 2 }}>
                    <span style={{ color: '#dc2626' }}>{packet.limitPools.ztCount ?? '-'}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 14 }}> / </span>
                    <span style={{ color: '#16a34a' }}>{packet.limitPools.dtCount ?? '-'}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 14 }}> / </span>
                    <span>{packet.limitPools.zbCount ?? '-'}</span>
                  </div>
                  <div className="num" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    封板率 {packet.limitPools.sealRatePct ?? '-'}% · 炸板率 {packet.limitPools.burstRatePct ?? '-'}%
                  </div>
                </div>

                <div className="panel panel-pad" style={{ padding: '11px 14px' }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>连板高度与隔夜美股</div>
                  <div className="num" style={{ fontSize: 20, fontWeight: 800, marginTop: 2 }}>
                    {packet.limitPools.maxBoard} 板{' '}
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)' }}>
                      (连板 {packet.limitPools.lianbanCount} 只)
                    </span>
                  </div>
                  <div className="num" style={{ fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {packet.usOvernight.items
                      .filter((u) => ['IXIC', 'NVDA', 'TSM'].includes(u.code))
                      .map((u) => `${u.name} ${fmtPct(u.pct)}`)
                      .join(' · ') || '美股数据待核'}
                  </div>
                </div>
              </div>

              {/* 7 大核心指数真实 1 分钟分时卡片网格 */}
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  7 大核心指数权威日K + 1 分钟正式交易分时（241条 · 昨收基准虚线 + 黄色均价线）
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(235px, 1fr))', gap: 10 }}>
                  {packet.indices.map((idx) => (
                    <div key={idx.code} className="panel" style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                        <strong style={{ fontSize: 13 }}>{idx.name}</strong>
                        <span className="num" style={{ fontWeight: 800, fontSize: 13.5, color: pctColor(idx.dailyAuth.pct) }}>
                          {idx.dailyAuth.close} ({fmtPct(idx.dailyAuth.pct)})
                        </span>
                      </div>
                      <IntradaySparkline
                        points={idx.intraday.sparkline}
                        height={54}
                        highTime={idx.intraday.dayHigh?.time}
                        lowTime={idx.intraday.dayLow?.time}
                      />
                      {idx.intraday.available && (
                        <div className="num" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>高 {idx.intraday.dayHigh?.price} @{idx.intraday.dayHigh?.time}</span>
                            <span>低 {idx.intraday.dayLow?.price} @{idx.intraday.dayLow?.time}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>开 {fmtPct(idx.intraday.openPct)} · 收盘位 {idx.intraday.closePosPct}%</span>
                            <span>{idx.intraday.barCount}条1m</span>
                          </div>
                          {idx.intraday.maxUp10m && (
                            <div style={{ color: 'var(--text-secondary)' }}>
                              <TrendingUp size={10} style={{ marginRight: 3, color: '#dc2626' }} />
                              10m最强 {idx.intraday.maxUp10m.fromTime}→{idx.intraday.maxUp10m.toTime} ({fmtPct(idx.intraday.maxUp10m.deltaPct)})
                            </div>
                          )}
                          {idx.intraday.maxDown10m && idx.intraday.maxDown10m.deltaPct < -0.15 && (
                            <div style={{ color: 'var(--text-secondary)' }}>
                              <TrendingDown size={10} style={{ marginRight: 3, color: '#16a34a' }} />
                              10m最急杀 {idx.intraday.maxDown10m.fromTime}→{idx.intraday.maxDown10m.toTime} ({fmtPct(idx.intraday.maxDown10m.deltaPct)})
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* 折叠开关：板块聚类穷举 + 观察股分时 + 隔夜美股 */}
              <div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setShowBoardDetail((v) => !v)}
                  style={{ marginBottom: showBoardDetail ? 10 : 0 }}
                >
                  {showBoardDetail ? '收起' : '展开'} 涨停集群穷举 ({packet.limitPools.clustersGe3.length} 集群) · 连板梯队 · 观察池与龙头个股分时 ({packet.watchStocks.length} 只) · 隔夜美股
                </button>

                {showBoardDetail && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div className="grid-2">
                      {/* 框架增订③：>=3只集群穷举 */}
                      <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ padding: '7px 11px', background: 'var(--bg-soft)', fontSize: 12, fontWeight: 700 }}>
                          框架增订③ · 涨停 ≥3 只板块集群穷举（共 {packet.limitPools.clustersGe3.length} 个）
                        </div>
                        <div style={{ maxHeight: 210, overflowY: 'auto' }}>
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>行业集群</th>
                                <th style={{ width: 52 }}>家数</th>
                                <th style={{ width: 56 }}>最高</th>
                                <th>连板 / 代表股</th>
                              </tr>
                            </thead>
                            <tbody>
                              {packet.limitPools.clustersGe3.map((cl) => (
                                <tr key={cl.industry}>
                                  <td style={{ fontWeight: 600, fontSize: 12 }}>{cl.industry}</td>
                                  <td className="num" style={{ fontWeight: 700 }}>{cl.count}</td>
                                  <td className="num">{cl.maxBoard}板</td>
                                  <td style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                                    {(cl.lianbanStocks.length > 0 ? cl.lianbanStocks : cl.sampleStocks).slice(0, 4).join('、')}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* 连板梯队 + 隔夜美股 */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                          <div style={{ padding: '7px 11px', background: 'var(--bg-soft)', fontSize: 12, fontWeight: 700 }}>
                            连板梯队（2 板及以上共 {packet.limitPools.lianbanCount} 只）
                          </div>
                          <div style={{ padding: '8px 11px', maxHeight: 130, overflowY: 'auto', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            {packet.limitPools.boardLadder.map((lv) => (
                              <div key={lv.board}>
                                <span className="badge badge-crimson mono" style={{ marginRight: 6 }}>{lv.board}板 ({lv.count})</span>
                                <span style={{ color: 'var(--text-secondary)' }}>
                                  {lv.stocks.slice(0, 6).map((s) => `${s.name}(${s.industry}/${s.boardStyle})`).join('、')}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px', background: 'var(--bg-elev)' }}>
                          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>隔夜美股最新收盘（{packet.usOvernight.items[0]?.tradeTimeET || '-'}）</div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {packet.usOvernight.items.map((u) => (
                              <span key={u.code} className="badge badge-muted num" style={{ fontSize: 11.5 }}>
                                {u.name}{' '}
                                <strong style={{ color: pctColor(u.pct), marginLeft: 3 }}>{fmtPct(u.pct)}</strong>
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 核心观察股 + 当日连板龙头 1m 分时表 */}
                    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                      <div style={{ padding: '7px 11px', background: 'var(--bg-soft)', fontSize: 12, fontWeight: 700 }}>
                        个股权威日K + 1 分钟分时结构（观察池 + 自动并入最高连板前 3 龙头）
                      </div>
                      <div style={{ overflowX: 'auto' }}>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th style={{ width: 140 }}>标的 / 角色</th>
                              <th style={{ width: 120 }}>权威收盘 / 涨幅</th>
                              <th style={{ width: 130 }}>1m 分时图</th>
                              <th>开/高/低时间与均价线行为</th>
                              <th style={{ width: 105 }}>尾盘方向</th>
                            </tr>
                          </thead>
                          <tbody>
                            {packet.watchStocks.map((st) => (
                              <tr key={st.code}>
                                <td>
                                  <div style={{ fontWeight: 700, fontSize: 12.5 }}>
                                    {st.name} <span className="mono" style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{st.code}</span>
                                  </div>
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{st.role}</div>
                                </td>
                                <td className="num">
                                  <div style={{ fontWeight: 700, color: pctColor(st.dailyAuth.pct) }}>
                                    {st.dailyAuth.close} ({fmtPct(st.dailyAuth.pct)})
                                  </div>
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                    额 {st.dailyAuth.amountYi ?? '-'}亿 · 换 {st.dailyAuth.turnoverPct ?? '-'}%
                                  </div>
                                </td>
                                <td>
                                  <IntradaySparkline
                                    points={st.intraday.sparkline}
                                    height={36}
                                    highTime={st.intraday.dayHigh?.time}
                                    lowTime={st.intraday.dayLow?.time}
                                  />
                                </td>
                                <td className="num" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                                  开 {fmtPct(st.intraday.openPct)} · 高 {st.intraday.dayHigh?.price}@{st.intraday.dayHigh?.time} · 低 {st.intraday.dayLow?.price}@{st.intraday.dayLow?.time}
                                  <br />
                                  均价线上方运行 {st.intraday.aboveAvgRatioPct ?? '-'}% · 收盘位 {st.intraday.closePosPct ?? '-'}%
                                </td>
                                <td>
                                  <span className="badge badge-muted" style={{ fontSize: 11 }}>{st.intraday.tailDirection || '-'}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* =================================================================== */}
      {/* Part 2: GPT / Gemini 自动执行复盘引擎 */}
      {/* =================================================================== */}
      <div className="panel" style={{ borderColor: 'color-mix(in srgb, var(--navy) 35%, var(--border))' }}>
        <div
          className="panel-header"
          style={{ background: 'linear-gradient(120deg, var(--bg-elev) 0%, var(--navy-soft) 100%)', flexWrap: 'wrap' }}
        >
          <h3 className="panel-title">
            <Bot size={17} color="var(--navy)" />
            AI 自动执行每日复盘（Codex/Gemini 套餐 · DeepSeek · 通义 · Kimi · GLM · GPT）
          </h3>
          <AiProviderPicker
            value={selectedProvider}
            config={aiConfig}
            onChange={setSelectedProvider}
            onOpenSettings={onOpenAiSettings}
          />
        </div>

        <div className="panel-pad">
          <div className="field-group" style={{ marginBottom: 12 }}>
            <label className="field-label">
              可选补充硬材料（粘贴今日 DR001 / 央行逆回购 / 两融余额 / 龙虎榜 / 突发宏观公告，留空则缺失项自动记入缺口、绝不编造）
            </label>
            <textarea
              className="textarea"
              style={{ minHeight: 68 }}
              placeholder="例：DR001 1.31%；央行今日逆回购 2100 亿净投放 300 亿；两融余额 23100 亿环比 +150 亿；美东昨日公布..."
              value={extraNotes}
              onChange={(e) => setExtraNotes(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!packet || runningAi}
              onClick={handleRunAi}
            >
              {runningAi ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              {runningAi
                ? `后台正在撰写复盘 (${elapsedSec}s，切页不会中断)...`
                : packet
                ? `一键自动执行复盘（基于 ${packet.totalIntradayBars} 条真实 1m K线）`
                : '请先在 Step 0 拉取真实 1 分钟数据'}
            </button>

            <button type="button" className="btn btn-sm" disabled={!packet} onClick={handleCopyPrompt}>
              <ClipboardCopy size={13} /> 复制防幻觉完整 Prompt（无 Key 可贴网页版）
            </button>

            <button type="button" className="btn btn-sm" disabled={!packet} onClick={() => setShowImportModal(true)}>
              <FileJson size={13} /> 导入网页版返回的 JSON
            </button>

            {!runningAi && recentDailyJob && recentDailyJob.status === 'completed' && recentDailyJob.hasResult && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => handleLoadCompletedJob(recentDailyJob.id)}
                title={`恢复后台缓存任务：${recentDailyJob.title}`}
              >
                <CheckCircle2 size={13} color="var(--emerald)" /> 载入上次后台草稿 ({recentDailyJob.meta?.tradeDate || ''})
              </button>
            )}
          </div>

          {/* 审计报告横幅 */}
          {lastAudit && (
            <div
              className="field-block"
              style={{
                marginTop: 12,
                marginBottom: 0,
                background: 'var(--navy-soft)',
                borderColor: 'color-mix(in srgb, var(--navy) 30%, transparent)',
                fontSize: 12.5,
              }}
            >
              <div style={{ fontWeight: 700, color: 'var(--navy)', marginBottom: 4 }}>
                AI 自动复盘已完成并回填下方十节表单（尚未写盘，请逐项人工审核后点击「预览变更 Diff 并落库」）
              </div>
              <div style={{ color: 'var(--text-secondary)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span>引擎：{lastAudit.provider.toUpperCase()} ({lastAudit.model})</span>
                <span>耗时：{(lastAudit.latencyMs / 1000).toFixed(1)}s</span>
                <span>数据底座：{lastAudit.tradeDate} · {lastAudit.intradayBarsGrounded} 条真实 1m K线</span>
              </div>
              {lastAudit.warnings.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--amber)' }}>
                  {lastAudit.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {manualWarnings.length > 0 && (
            <div className="field-block" style={{ marginTop: 10, marginBottom: 0, background: 'var(--amber-soft)', fontSize: 12.5 }}>
              <strong>导入校验提醒：</strong> {manualWarnings.join('；')}
            </div>
          )}

          {/* P0-2：事后数值防幻觉对账门禁审核条 */}
          <ReconcileAuditBanner
            reconcile={lastReconcile}
            applying={applyingReconcile}
            onApplyAutoFix={currentForm ? handleApplyReconcileFix : undefined}
          />
        </div>
      </div>

      {/* 手动粘贴网页版 GPT/Gemini 返回的 JSON 模态框 */}
      {showImportModal && (
        <div className="modal-backdrop" onClick={() => setShowImportModal(false)}>
          <div className="modal-box" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ fontWeight: 700, fontSize: 15 }}>粘贴网页版 GPT / Gemini 返回的 JSON 复盘结果</div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowImportModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="field-label">完整 JSON 文本（支持直接粘贴带 ```json 代码块的回复）</label>
                <textarea
                  className="textarea textarea-mono"
                  style={{ minHeight: 280 }}
                  placeholder='{"date": "2026-11-23", "headline": "...", ...}'
                  value={manualJsonText}
                  onChange={(e) => setManualJsonText(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setShowImportModal(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!manualJsonText.trim() || importingJson}
                onClick={handleImportManualJson}
              >
                {importingJson ? '校验导入中...' : '校验并自动填入十节表单'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ComplianceDisclaimerBanner variant="footer" showExecutionBoundary />
    </div>
  );
};
