import React, { useCallback, useEffect, useState } from 'react';
import {
  Bot,
  Calendar,
  Download,
  ExternalLink,
  FolderDown,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { api } from '../api';
import type { AiProvider, AiSafeConfig, EntityRef, PeriodicAiReport, PeriodicSummary } from '../types';
import { AiProviderPicker, isAiProviderReady } from './AiProviderPicker';

interface PeriodicReviewPanelProps {
  aiConfig: AiSafeConfig | null;
  theme: 'light' | 'dark';
  onOpenEntity: (ref: EntityRef) => void;
  onOpenAiSettings: () => void;
  onToast: (msg: string) => void;
}

export const PeriodicReviewPanel: React.FC<PeriodicReviewPanelProps> = ({
  aiConfig,
  theme,
  onOpenEntity,
  onOpenAiSettings,
  onToast,
}) => {
  const [periodType, setPeriodType] = useState<'week' | 'month'>('week');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [summary, setSummary] = useState<PeriodicSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const [selectedProvider, setSelectedProvider] = useState<AiProvider>(aiConfig?.provider || 'codex_cli');
  const [aiReport, setAiReport] = useState<PeriodicAiReport | null>(null);
  const [runningAi, setRunningAi] = useState(false);
  const [exportingHtml, setExportingHtml] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<{ html: string; fileName: string } | null>(null);

  useEffect(() => {
    if (aiConfig?.provider) setSelectedProvider(aiConfig.provider);
  }, [aiConfig?.provider]);

  const loadSummary = useCallback(
    async (pType: 'week' | 'month', sDate?: string, eDate?: string) => {
      setLoading(true);
      try {
        const res = await api.getPeriodicSummary({
          periodType: pType,
          startDate: sDate || undefined,
          endDate: eDate || undefined,
        });
        setSummary(res);
        setStartDate(res.startDate);
        setEndDate(res.endDate);
        setAiReport(null);
      } catch (err: any) {
        onToast(`聚合周期复盘失败：${err.message}`);
      } finally {
        setLoading(false);
      }
    },
    [onToast]
  );

  useEffect(() => {
    loadSummary('week');
  }, [loadSummary]);

  const handleRunAi = async () => {
    if (!summary) return;
    if (!isAiProviderReady(aiConfig, selectedProvider)) {
      onToast('所选 AI 引擎尚未就绪，请先配置。');
      onOpenAiSettings();
      return;
    }
    setRunningAi(true);
    try {
      const res = await api.runPeriodicAi({ summary, provider: selectedProvider });
      setAiReport(res.report);
      onToast(`已生成 ${summary.periodLabel} AI 深度反思与方法论迭代提案！`);
    } catch (err: any) {
      onToast(`生成周期 AI 复盘失败：${err.message}`);
    } finally {
      setRunningAi(false);
    }
  };

  const handleExportHtml = async (saveToDisk: boolean) => {
    if (!summary) return;
    setExportingHtml(true);
    try {
      const res = await api.renderPeriodicHtml({ summary, aiReport, theme, saveToDisk });
      if (saveToDisk && res.saved) {
        onToast(`已保存独立分享 HTML：周期复盘HTML/${res.saved.fileName}`);
      } else {
        setPreviewHtml({ html: res.html, fileName: res.fileName });
      }
    } catch (err: any) {
      onToast(`导出周期 HTML 失败：${err.message}`);
    } finally {
      setExportingHtml(false);
    }
  };

  const downloadHtml = (html: string, fileName: string) => {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 控制顶栏 */}
      <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 15.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Calendar size={17} color="var(--navy)" /> 周度 / 月度聚合复盘中心
            </strong>
            <div className="seg-tabs">
              <button
                type="button"
                className={`seg-tab ${periodType === 'week' ? 'active' : ''}`}
                onClick={() => {
                  setPeriodType('week');
                  loadSummary('week');
                }}
              >
                近 7 日（周报）
              </button>
              <button
                type="button"
                className={`seg-tab ${periodType === 'month' ? 'active' : ''}`}
                onClick={() => {
                  setPeriodType('month');
                  loadSummary('month');
                }}
              >
                近 30 日（月报）
              </button>
            </div>
            <input
              type="date"
              className="input mono"
              style={{ width: 138, padding: '4px 8px', fontSize: 12 }}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <span style={{ color: 'var(--text-muted)' }}>至</span>
            <input
              type="date"
              className="input mono"
              style={{ width: 138, padding: '4px 8px', fontSize: 12 }}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={loading}
              onClick={() => loadSummary(periodType, startDate, endDate)}
            >
              <RefreshCw size={13} className={loading ? 'spin' : ''} /> 聚合区间
            </button>
          </div>

          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
            <AiProviderPicker
              value={selectedProvider}
              config={aiConfig}
              onChange={setSelectedProvider}
              onOpenSettings={onOpenAiSettings}
            />
            <button type="button" className="btn btn-amber btn-sm" disabled={runningAi || !summary} onClick={handleRunAi}>
              {runningAi ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
              {runningAi ? 'AI 提炼周期复盘...' : 'AI 一键生成周期深度反思'}
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={exportingHtml || !summary} onClick={() => handleExportHtml(false)}>
              <ExternalLink size={13} /> 预览分享 HTML
            </button>
            <button type="button" className="btn btn-sm" disabled={exportingHtml || !summary} onClick={() => handleExportHtml(true)}>
              <FolderDown size={13} /> 保存 HTML 到磁盘
            </button>
          </div>
        </div>

        {/* 区间核心 KPI 四格 */}
        {summary && (
          <div className="kpi-grid" style={{ marginBottom: 0 }}>
            <div className="panel panel-pad" style={{ padding: '10px 13px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>区间日度复盘 / 均分</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 800 }}>
                {summary.stats.dailyReviewCount} 篇 · {summary.stats.avgDailyScore ?? '-'} 分
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                波动 {summary.stats.minDailyScore ?? '-'} ~ {summary.stats.maxDailyScore ?? '-'} 分
              </div>
            </div>
            <div className="panel panel-pad" style={{ padding: '10px 13px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>跟踪锚成立命中率</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 800, color: 'var(--navy)' }}>
                {summary.stats.anchorHitRatePct != null ? `${summary.stats.anchorHitRatePct}%` : '--'}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                成立 {summary.stats.anchorHit} / 证伪 {summary.stats.anchorFail} / 共 {summary.stats.anchorTotal}
              </div>
            </div>
            <div className="panel panel-pad" style={{ padding: '10px 13px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>区间实盘已实现盈亏</div>
              <div
                className="num"
                style={{ fontSize: 20, fontWeight: 800, color: summary.stats.periodRealizedPnl >= 0 ? '#dc2626' : '#16a34a' }}
              >
                {summary.stats.periodRealizedPnl >= 0 ? '+' : ''}¥{summary.stats.periodRealizedPnl.toLocaleString()}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                平仓 {summary.stats.closedTradeCount} 笔 · 胜率 {summary.stats.periodWinRate != null ? `${summary.stats.periodWinRate}%` : '--'}
              </div>
            </div>
            <div className="panel panel-pad" style={{ padding: '10px 13px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>标的研判 / 否决池 / 缺口</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 800 }}>
                {summary.stats.judgmentCount} / {summary.stats.vetoCount} / {summary.stats.openGapCount}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                情绪链快照 {summary.sentimentHistory.length} 天
              </div>
            </div>
          </div>
        )}
      </div>

      {/* AI 生成的周期深度反思报告 */}
      {aiReport && (
        <div className="panel panel-pad" style={{ borderTop: '3px solid var(--amber)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bot size={17} color="var(--amber)" />
            <h3 style={{ margin: 0, fontSize: 16 }}>{aiReport.headline}</h3>
          </div>
          <div className="grid-2" style={{ gap: 12 }}>
            <div className="field-block" style={{ marginBottom: 0 }}>
              <div style={{ fontWeight: 700, marginBottom: 5 }}>一、周期市场节奏与情绪演化</div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{aiReport.marketRegimeReview}</div>
            </div>
            <div className="field-block" style={{ marginBottom: 0 }}>
              <div style={{ fontWeight: 700, marginBottom: 5 }}>二、研究、否决与交易执行归因</div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>{aiReport.researchAndExecutionReview}</div>
            </div>
          </div>
          <div className="grid-2" style={{ gap: 12 }}>
            <div className="field-block" style={{ marginBottom: 0 }}>
              <div style={{ fontWeight: 700, marginBottom: 5 }}>三、本周期核心教训与正反馈</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
                {aiReport.topLessons.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
            <div className="field-block" style={{ marginBottom: 0 }}>
              <div style={{ fontWeight: 700, marginBottom: 5 }}>四、下周期作战抓手 & 卡片演化提案</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
                {aiReport.nextPeriodFocus.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
              {aiReport.cardEvolutionProposals.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {aiReport.cardEvolutionProposals.map((p, idx) => (
                    <div key={idx} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="ref-chip ref-chip-method"
                        onClick={() => onOpenEntity({ kind: 'methodology', id: String(p.cardId).padStart(3, '0') })}
                      >
                        卡片{p.cardId}
                      </button>
                      <span className="badge badge-amber" style={{ fontSize: 10.5 }}>{p.action}</span>
                      <span>{p.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 区间明细：高频调用卡 + 日度复盘表 */}
      {summary && (
        <div className="grid-2" style={{ gap: 14 }}>
          <div className="panel panel-pad">
            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>区间高频调用方法论卡片</div>
            {summary.topCards.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>区间内暂无卡片调用记录</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {summary.topCards.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="ref-chip ref-chip-method"
                    style={{ fontSize: 12, padding: '3px 9px' }}
                    onClick={() => onOpenEntity({ kind: 'methodology', id: c.id })}
                  >
                    卡{c.id} {c.title} ×{c.count}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="panel panel-pad">
            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>
              区间日度复盘清单（{summary.dailySeries.length} 篇）
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
              {summary.dailySeries.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>所选区间内暂无日度复盘，可调宽起始日期</div>
              ) : (
                summary.dailySeries.map((d) => (
                  <div
                    key={d.id}
                    style={{
                      padding: '6px 9px',
                      borderRadius: 7,
                      background: 'var(--bg-soft)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 12.5,
                      cursor: 'pointer',
                    }}
                    onClick={() => onOpenEntity({ kind: 'daily', id: d.id })}
                  >
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span className="mono" style={{ color: 'var(--text-muted)', marginRight: 6 }}>{d.date}</span>
                      <strong>{d.title}</strong>
                    </div>
                    <span className="badge badge-amber mono">{d.score ?? '-'}分</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* HTML 预览弹窗 */}
      {previewHtml && (
        <div className="modal-backdrop" onClick={() => setPreviewHtml(null)}>
          <div className="modal-box" style={{ maxWidth: 980, width: '92vw', height: '88vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong>{previewHtml.fileName}</strong>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => downloadHtml(previewHtml.html, previewHtml.fileName)}>
                  <Download size={13} /> 下载独立 HTML
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreviewHtml(null)}>
                  关闭
                </button>
              </div>
            </div>
            <div className="modal-body" style={{ padding: 0, flex: 1 }}>
              <iframe title="periodic-html" srcDoc={previewHtml.html} style={{ width: '100%', height: '100%', border: 'none' }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
