import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Bell,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Database,
  Flame,
  Lightbulb,
  Plus,
  Printer,
  RefreshCw,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { ActiveTab, AuditReport, EntityRef, KbStaleItem, PreflightReport, WorkspaceData } from '../types';
import { CardLinkText } from '../components/CardLinkText';
import { ComplianceDisclaimerBanner } from '../components/ComplianceDisclaimerBanner';
import { IS_COMMERCIAL_EDITION } from '../config/edition';

interface DashboardPageProps {
  workspace: WorkspaceData;
  audit: AuditReport | null;
  onNavigateTab: (tab: ActiveTab) => void;
  onOpenEntity: (ref: EntityRef) => void;
  onQuickCreate: (kind: 'method' | 'cognition' | 'daily' | 'judgment') => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  workspace,
  audit,
  onNavigateTab,
  onOpenEntity,
  onQuickCreate,
}) => {
  const { t } = useI18n();
  const { methodology, cognition, ledger, highFreqCards } = workspace;
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [loadingPreflight, setLoadingPreflight] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [preflightUpdatedAt, setPreflightUpdatedAt] = useState<string>('');
  const [disclaimerDismissed, setDisclaimerDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('srw-disclaimer-ack-v1') === '1';
    } catch {
      return false;
    }
  });
  const [quickStartDismissed, setQuickStartDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('srw-quickstart-dismissed-v1') === '1';
    } catch {
      return false;
    }
  });

  const loadPreflight = async () => {
    setLoadingPreflight(true);
    setPreflightError(null);
    try {
      const res = await api.getPreflight();
      setPreflight(res);
      setPreflightUpdatedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    } catch (err: any) {
      setPreflightError(err?.message || t('预检接口响应超时或网络中断', 'Preflight request timed out or network error'));
    } finally {
      setLoadingPreflight(false);
    }
  };

  useEffect(() => {
    loadPreflight();
  }, [workspace.loadedAt]);

  const timeline = ledger.scoreTimeline;
  const chartW = 580;
  const chartH = 168;
  const padL = 32;
  const padR = 16;
  const padT = 18;
  const padB = 28;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;

  const points = timeline.map((pt, i) => {
    const x = timeline.length <= 1 ? padL + innerW / 2 : padL + (i / (timeline.length - 1)) * innerW;
    const y = padT + innerH - (Math.max(0, Math.min(10, pt.score)) / 10) * innerH;
    return { ...pt, x, y };
  });

  const polylineStr = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaStr =
    points.length > 0
      ? `${points[0].x.toFixed(1)},${(padT + innerH).toFixed(1)} ${polylineStr} ${points[points.length - 1].x.toFixed(1)},${(padT + innerH).toFixed(1)}`
      : '';

  const hoveredPoint = hoverIdx !== null ? points[hoverIdx] : points[points.length - 1] || null;

  const credColor = (score: number | null) => {
    if (score === null) return 'var(--text-muted)';
    if (score >= 0.8) return 'var(--emerald)';
    if (score >= 0.65) return 'var(--navy)';
    if (score >= 0.45) return 'var(--amber)';
    return 'var(--crimson)';
  };

  const normalizeCognitionId = (rawId: string) => {
    const m = String(rawId || '').trim().match(/^C[:\-]?(\d+)$/i);
    return m ? m[1].padStart(3, '0') : String(rawId || '').trim();
  };

  const isKbV2 = workspace.kbMode === 'v2';
  const staleReport = workspace.staleReport;
  const hasStaleAlerts = Boolean(
    staleReport && (staleReport.expiredCount > 0 || staleReport.checkDueCount > 0)
  );
  const staleSampleItems: { item: KbStaleItem; kind: 'expired' | 'checkDue' }[] = hasStaleAlerts && staleReport
    ? [
        ...(staleReport.expired || []).slice(0, 4).map((item) => ({ item, kind: 'expired' as const })),
        ...(staleReport.checkDue || [])
          .slice(0, Math.max(2, 6 - Math.min(4, (staleReport.expired || []).length)))
          .map((item) => ({ item, kind: 'checkDue' as const })),
      ].slice(0, 6)
    : [];

  return (
    <div className="scroll-page">
      {/* 个人版首次启动可折叠提示；商业版改置页尾紧凑合规栏，避免首屏大横幅遮挡核心数据 */}
      {!IS_COMMERCIAL_EDITION && !disclaimerDismissed && (
        <div style={{ marginBottom: 12 }}>
          <ComplianceDisclaimerBanner
            variant="banner"
            showExecutionBoundary={false}
            dismissible
            onDismiss={() => {
              setDisclaimerDismissed(true);
              try {
                localStorage.setItem('srw-disclaimer-ack-v1', '1');
              } catch {
                // ignore
              }
            }}
          />
        </div>
      )}

      {/* 快捷动作头栏 */}
      <div
        className="panel panel-pad"
        style={{
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          background: 'linear-gradient(120deg, var(--bg-elev) 0%, var(--navy-soft) 100%)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>
              {t('二级投研 · 三库闭环指挥台', 'Secondary Research · 3-Library Command Cockpit')}
            </span>
            <button
              type="button"
              className={`badge mono ${
                isKbV2
                  ? workspace.kbSummary?.sqliteAvailable === false
                    ? 'badge-amber'
                    : 'badge-teal'
                  : 'badge-muted'
              }`}
              style={{
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 7px',
              }}
              onClick={() => onNavigateTab('maintenance')}
              title={
                isKbV2
                  ? t(
                      `KB v2 分卡引擎（节点 ${workspace.kbSummary?.nodeCount ?? '-'} · 边 ${workspace.kbSummary?.edgeCount ?? '-'} · 活视图 ${workspace.kbSummary?.topicCount ?? '-'}）· 点击管理`,
                      `KB v2 Card Engine (${workspace.kbSummary?.nodeCount ?? '-'} nodes · ${workspace.kbSummary?.edgeCount ?? '-'} edges · ${workspace.kbSummary?.topicCount ?? '-'} topics) — Click to manage`
                    )
                  : t(
                      '当前为经典单文件模式，点击前往质检中心可一键无损升级至 KB v2',
                      'Classic single-file mode — click to upgrade losslessly to KB v2 in Maintenance'
                    )
              }
            >
              <Database size={11} />
              {isKbV2
                ? workspace.kbSummary?.sqliteAvailable === false
                  ? t('KB v2 · JSON 索引', 'KB v2 · JSON Index')
                  : 'KB v2 · SQLite FTS5'
                : t('KB v1 · 单文件', 'KB v1 · Single-File')}
            </button>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            {t(
              '认知卡沉淀事实 → 方法论提供条件约束 → 台账记录假设与复盘 → 反向校准方法论可信度（全部修改经确认门 + 自动快照备份）',
              'Industry Facts → Methodology Rules → Ledger Hypotheses & Reviews → Credibility Calibration (Diff-Gated + Atomic Snapshots)'
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onQuickCreate('method')}>
            <Plus size={14} /> {t(`新建方法论卡 (${methodology.stats.nextCardId})`, `New Rule (${methodology.stats.nextCardId})`)}
          </button>
          <button type="button" className="btn btn-teal btn-sm" onClick={() => onQuickCreate('cognition')}>
            <Plus size={14} /> {t(`新建认知卡 (${cognition.stats.nextCardId})`, `New Intel (${cognition.stats.nextCardId})`)}
          </button>
          <button type="button" className="btn btn-amber btn-sm" onClick={() => onQuickCreate('daily')}>
            <Plus size={14} /> {t('录入日度复盘', 'Daily Review')}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onQuickCreate('judgment')}>
            <Plus size={14} /> {t(`发起标的研判 (${ledger.stats.nextJudgmentKey})`, `New Thesis (${ledger.stats.nextJudgmentKey})`)}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.print()} title={t('打印当前总览 / 导出机构级 PDF', 'Print / Export PDF')}>
            <Printer size={14} /> {t('打印 PDF', 'Print PDF')}
          </button>
        </div>
      </div>

      {/* 新手 3 步快速上手引导卡（商业版首启与空白态均可见，支持一键收起，避免被预置示例数据隐藏） */}
      {!quickStartDismissed && (IS_COMMERCIAL_EDITION || (ledger.dailyReviews.length === 0 && ledger.judgments.length === 0)) && (
        <div
          className="panel panel-pad"
          style={{
            marginBottom: 16,
            borderLeft: '4px solid var(--navy)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: 'var(--text)' }}>
              3 步开启你的本地投研工作流（当前示例三库仅作体验，可随时在右上角新建空白正式空间）
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 11.5, padding: '2px 8px' }}
              onClick={() => {
                setQuickStartDismissed(true);
                try {
                  localStorage.setItem('srw-quickstart-dismissed-v1', '1');
                } catch {
                  // ignore
                }
              }}
            >
              我已熟悉 · 收起
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            <button
              type="button"
              className="list-card"
              style={{ textAlign: 'left', padding: '10px 12px' }}
              onClick={() => onNavigateTab('watchlist')}
            >
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--navy)' }}>① 查看我的自选行情与 K 线 →</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                查看刚勾选的观察股分时、多周期 K 线与支撑压力位
              </div>
            </button>
            <button
              type="button"
              className="list-card"
              style={{ textAlign: 'left', padding: '10px 12px' }}
              onClick={() => onQuickCreate('daily')}
            >
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--amber)' }}>② 生成第 1 篇日度复盘 →</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                记录今日盘面节奏与心得，自动写入本地复盘台账
              </div>
            </button>
            <button
              type="button"
              className="list-card"
              style={{ textAlign: 'left', padding: '10px 12px' }}
              onClick={() => onQuickCreate('method')}
            >
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--teal)' }}>③ 沉淀第 1 条交易纪律卡 →</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                把你的买点/止损纪律固化为可追溯的方法论卡片
              </div>
            </button>
          </div>
        </div>
      )}

      {/* P0-1 & P0-3：零 Token 今日盘前预检收件箱（Preflight Inbox）+ 10态市场情绪行动红绿灯 */}
      {preflightError && !preflight && (
        <div
          className="panel panel-pad"
          style={{
            marginBottom: 16,
            borderColor: 'var(--crimson)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--crimson)', fontSize: 13 }}>
            <AlertTriangle size={15} />
            <span>
              {t('今日盘前预检拉取失败：', 'Pre-Market Preflight failed: ')}
              {preflightError}
            </span>
          </div>
          <button type="button" className="btn btn-sm btn-primary" onClick={loadPreflight} disabled={loadingPreflight}>
            <RefreshCw size={12} className={loadingPreflight ? 'spin' : ''} /> {t('超时重试', 'Retry')}
          </button>
        </div>
      )}
      {preflight && (
        <div className="panel panel-pad" style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Bell size={16} color="var(--amber)" />
              <strong style={{ fontSize: 14.5 }}>
                {t(`今日盘前预检与 Attention 收件箱（${preflight.today}）`, `Pre-Market Preflight & Attention Inbox (${preflight.today})`)}
              </strong>
              {preflight.summary.highCount > 0 ? (
                <span className="badge badge-crimson">
                  {t(`高优待办 ${preflight.summary.highCount} 项`, `${preflight.summary.highCount} High Priority`)}
                </span>
              ) : preflight.stopLossCoverage?.status === 'unverified' || preflight.stopLossCoverage?.error ? (
                <span className="badge badge-amber">
                  {t('持仓止损待核验', 'Stop-Loss Unverified')}
                </span>
              ) : preflight.summary.mediumCount > 0 ? (
                <span className="badge badge-amber">
                  {t(`待关注 ${preflight.summary.mediumCount} 项`, `${preflight.summary.mediumCount} Warnings`)}
                </span>
              ) : (
                <span className="badge badge-emerald">{t('无高危阻断项', 'All Clear')}</span>
              )}
              {preflight.stopLossCoverage && (
                <span
                  className={`badge mono ${
                    preflight.stopLossCoverage.status === 'triggered'
                      ? 'badge-crimson'
                      : preflight.stopLossCoverage.status === 'unverified' || preflight.stopLossCoverage.error
                      ? 'badge-amber'
                      : preflight.stopLossCoverage.status === 'verified_ok'
                      ? 'badge-emerald'
                      : 'badge-muted'
                  }`}
                  style={{ fontSize: 10.5 }}
                  title={preflight.stopLossCoverage.error || undefined}
                >
                  {preflight.stopLossCoverage.trackedStopCount === 0 && !preflight.stopLossCoverage.error
                    ? t('止损核验：无在途设止损持仓', 'Stop-Loss: No tracked holdings')
                    : preflight.stopLossCoverage.status === 'unverified' || preflight.stopLossCoverage.error
                    ? t(
                        `止损核验 ${preflight.stopLossCoverage.verifiedCount}/${preflight.stopLossCoverage.trackedStopCount}（${preflight.stopLossCoverage.unverifiedCount} 待核验）`,
                        `Stop-Loss ${preflight.stopLossCoverage.verifiedCount}/${preflight.stopLossCoverage.trackedStopCount} (${preflight.stopLossCoverage.unverifiedCount} unverified)`
                      )
                    : t(
                        `止损已核验 ${preflight.stopLossCoverage.verifiedCount}/${preflight.stopLossCoverage.trackedStopCount}${
                          preflight.stopLossCoverage.quoteAsOf ? ` · 行情 ${preflight.stopLossCoverage.quoteAsOf}` : ''
                        }`,
                        `Stop-Loss Verified ${preflight.stopLossCoverage.verifiedCount}/${preflight.stopLossCoverage.trackedStopCount}${
                          preflight.stopLossCoverage.quoteAsOf ? ` · ${preflight.stopLossCoverage.quoteAsOf}` : ''
                        }`
                      )}
                </span>
              )}
              {preflightUpdatedAt && (
                <span className="badge badge-muted mono" style={{ fontSize: 10.5 }}>
                  {t('更新', 'Updated')} {preflightUpdatedAt}
                </span>
              )}
              {preflightError && (
                <span className="badge badge-crimson" style={{ fontSize: 10.5 }}>
                  {t('最近刷新失败', 'Last refresh failed')}
                </span>
              )}
              {preflight.latestSentimentNode && (
                <span
                  className={`badge ${
                    preflight.latestSentimentNode.channel === 'forbidden_new' || preflight.latestSentimentNode.channel === 'realize_only'
                      ? 'badge-crimson'
                      : preflight.latestSentimentNode.channel === 'attack_ok'
                      ? 'badge-emerald'
                      : 'badge-navy'
                  }`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => onNavigateTab('technical')}
                  title={preflight.latestSentimentNode.actionNote}
                >
                  {t('市场节点：', 'Market Regime: ')}
                  {preflight.latestSentimentNode.node} ({preflight.latestSentimentNode.sentimentScore}
                  {t('分', 'pt')}) · {preflight.latestSentimentNode.channelLabel}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {t(
                  `到期假设 ${preflight.summary.dueHypCount} · 规则漂移 ${preflight.summary.driftedRuleCount} · 否决池 ${preflight.summary.vetoCount}`,
                  `Due Hyp ${preflight.summary.dueHypCount} · Drift ${preflight.summary.driftedRuleCount} · Veto ${preflight.summary.vetoCount}`
                )}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={loadPreflight} disabled={loadingPreflight}>
                <RefreshCw size={12} className={loadingPreflight ? 'spin' : ''} /> {t('刷新预检', 'Refresh')}
              </button>
            </div>
          </div>

          {preflight.items.length === 0 ? (
            preflight.stopLossCoverage?.status === 'unverified' || preflight.stopLossCoverage?.error ? (
              <div style={{ fontSize: 12.5, color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={14} />{' '}
                {t(
                  '部分持仓止损缺少有效现价报价，暂不可视为核验通过，请进入「交易账本」刷新实盘现价后确认。',
                  'Some open holdings lack valid live quotes — stop-loss checks are unverified. Refresh live quotes in Trade Ledger.'
                )}
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--emerald)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={14} />{' '}
                {preflight.stopLossCoverage?.trackedStopCount
                  ? t(
                      `所有研判假设、策略规则、监管红线及 ${preflight.stopLossCoverage.verifiedCount} 只在途持仓止损（行情时点 ${preflight.stopLossCoverage.quoteAsOf || '最新'}）均已核验通过！`,
                      `All thesis hypotheses, rules, regulatory checks, and ${preflight.stopLossCoverage.verifiedCount} open stop-loss guards (${preflight.stopLossCoverage.quoteAsOf || 'latest'}) are verified clear.`
                    )
                  : t(
                      '所有研判假设、策略规则与监管红线均处于健康清零状态（当前无在途设止损持仓）。',
                      'All thesis hypotheses, rules, and regulatory checks are clear (no open stop-loss holdings).'
                    )}
              </div>
            )
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: 8 }}>
              {preflight.items.slice(0, 6).map((item) => (
                <div
                  key={item.id}
                  onClick={() => (item.actionEntity ? onOpenEntity(item.actionEntity) : onNavigateTab(item.actionTab))}
                  title={`${item.title} — ${item.detail}`}
                  style={{
                    padding: '8px 11px',
                    borderRadius: 8,
                    background: 'var(--bg-soft)',
                    border: '1px solid var(--border)',
                    borderLeft: `3.5px solid ${
                      item.severity === 'high' ? 'var(--crimson)' : item.severity === 'medium' ? 'var(--amber)' : 'var(--navy)'
                    }`,
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    {item.severity === 'high' && <AlertTriangle size={13} color="var(--crimson)" style={{ flexShrink: 0 }} />}
                    <span
                      className={`badge ${
                        item.severity === 'high' ? 'badge-crimson' : item.severity === 'medium' ? 'badge-amber' : 'badge-navy'
                      }`}
                      style={{ fontSize: 10, padding: '0 5px', flexShrink: 0 }}
                    >
                      {item.category}
                    </span>
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</strong>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.detail}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* KB v2 时效巡检提醒卡（有过期或到期巡检认知卡时自动浮出） */}
      {hasStaleAlerts && staleReport && (
        <div
          className="panel panel-pad"
          style={{
            marginBottom: 16,
            borderLeft: `4px solid ${staleReport.expiredCount > 0 ? 'var(--crimson)' : 'var(--amber)'}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <CalendarClock size={16} color={staleReport.expiredCount > 0 ? 'var(--crimson)' : 'var(--amber)'} />
              <strong style={{ fontSize: 14 }}>
                {t('时效巡检提醒（认知卡保鲜期）', 'Knowledge Freshness Patrol (KB v2)')}
              </strong>
              {staleReport.expiredCount > 0 && (
                <span className="badge badge-crimson num">
                  {t(`已过期 ${staleReport.expiredCount} 张`, `${staleReport.expiredCount} Expired`)}
                </span>
              )}
              {staleReport.checkDueCount > 0 && (
                <span className="badge badge-amber num">
                  {t(`到期巡检 ${staleReport.checkDueCount} 张`, `${staleReport.checkDueCount} Check Due`)}
                </span>
              )}
              <span className="badge badge-muted mono" style={{ fontSize: 10.5 }}>
                {t(`基准日 ${staleReport.asOfDate}`, `As of ${staleReport.asOfDate}`)}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onNavigateTab('maintenance')}
            >
              {t('前往质检中心查看全部', 'View Full Patrol in Maintenance')} <ArrowRight size={13} />
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 8 }}>
            {staleSampleItems.map(({ item, kind }) => {
              const cid = normalizeCognitionId(item.id);
              const dueDate =
                kind === 'expired'
                  ? item.validUntil || item.valid_until || '-'
                  : item.nextCheckDate || item.next_check_date || item.validUntil || item.valid_until || '-';
              const grade = item.primaryGrade || item.primary_grade;
              return (
                <button
                  key={`${kind}-${item.id}`}
                  type="button"
                  onClick={() => onOpenEntity({ kind: 'cognition', id: cid })}
                  title={item.title}
                  style={{
                    textAlign: 'left',
                    padding: '8px 11px',
                    borderRadius: 8,
                    background: 'var(--bg-soft)',
                    border: '1px solid var(--border)',
                    borderLeft: `3.5px solid ${kind === 'expired' ? 'var(--crimson)' : 'var(--amber)'}`,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className="badge badge-teal mono" style={{ fontSize: 10.5, padding: '0 5px' }}>
                      {item.id}
                    </span>
                    <span
                      className={`badge ${kind === 'expired' ? 'badge-crimson' : 'badge-amber'}`}
                      style={{ fontSize: 10, padding: '0 5px' }}
                    >
                      {kind === 'expired' ? t('已过期', 'Expired') : t('到期复核', 'Check Due')}
                    </span>
                    {grade && (
                      <span className="badge badge-muted" style={{ fontSize: 10, padding: '0 5px' }}>
                        {grade}
                      </span>
                    )}
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                      {dueDate}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: 'var(--text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      width: '100%',
                    }}
                  >
                    {item.title}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 四大 KPI 卡片 */}
      <div className="kpi-grid">
        <div className="kpi-card" onClick={() => onNavigateTab('methodology')}>
          <div className="kpi-label">
            <span>{t('方法论卡片库', 'Methodology Rules')}</span>
            <span className="badge badge-navy mono">{methodology.meta.version}</span>
          </div>
          <div className="kpi-value">{methodology.stats.activeCount}</div>
          <div className="kpi-sub">
            {t(`共 ${methodology.stats.totalTitles} 标题 · 冲突 ${methodology.stats.conflictCount} 项`, `${methodology.stats.totalTitles} Titles · ${methodology.stats.conflictCount} Conflicts`)}
            {methodology.stats.declaredMissing.length > 0
              ? ` · ${t('缺号', 'Gap')} ${methodology.stats.declaredMissing.join('/')}`
              : ''}
            {methodology.stats.revokedCount > 0 ? ` · ${t('撤销', 'Revoked')} ${methodology.stats.revokedCount}` : ''}
          </div>
        </div>

        <div className="kpi-card" onClick={() => onNavigateTab('cognition')}>
          <div className="kpi-label">
            <span>{t('行业前沿认知库', 'Industry Cognition')}</span>
            <span className="badge badge-teal mono">{cognition.meta.version}</span>
          </div>
          <div className="kpi-value">{cognition.stats.totalCount}</div>
          <div className="kpi-sub">
            {t(
              `A 级 ${cognition.stats.gradeACount} · B 级 ${cognition.stats.gradeBCount} · C 级 ${cognition.stats.gradeCCount} · 归档 ${cognition.researchArchives.length}`,
              `Grade A ${cognition.stats.gradeACount} · B ${cognition.stats.gradeBCount} · C ${cognition.stats.gradeCCount} · Archives ${cognition.researchArchives.length}`
            )}
          </div>
        </div>

        <div className="kpi-card" onClick={() => onNavigateTab('ledger')}>
          <div className="kpi-label">
            <span>{t('研判与复盘台账', 'Review & Thesis Ledger')}</span>
            <span className="badge badge-amber mono">{ledger.meta.version}</span>
          </div>
          <div className="kpi-value">
            {ledger.stats.latestDailyScore !== null ? `${ledger.stats.latestDailyScore}` : '-'}
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)' }}> / 10</span>
          </div>
          <div className="kpi-sub">
            {t(
              `最新日度 ${ledger.stats.latestDailyDate} · 共 ${ledger.stats.dailyReviewCount} 日 / ${ledger.stats.judgmentCount} 研判`,
              `Latest ${ledger.stats.latestDailyDate} · ${ledger.stats.dailyReviewCount} Reviews / ${ledger.stats.judgmentCount} Theses`
            )}
          </div>
        </div>

        <div className="kpi-card" onClick={() => onNavigateTab('maintenance')}>
          <div className="kpi-label">
            <span>{t('三库质检状态', 'Integrity Audit')}</span>
            <span
              className={`badge ${
                (audit?.summary.errorCount || 0) > 0
                  ? 'badge-crimson'
                  : (audit?.summary.warningCount || 0) > 0
                  ? 'badge-amber'
                  : 'badge-emerald'
              }`}
            >
              {(audit?.summary.errorCount || 0) > 0
                ? t(`${audit?.summary.errorCount} 错误`, `${audit?.summary.errorCount} Errors`)
                : t(`${audit?.summary.warningCount || 0} 告警`, `${audit?.summary.warningCount || 0} Warns`)}
            </span>
          </div>
          <div className="kpi-value" style={{ color: (audit?.summary.errorCount || 0) === 0 ? 'var(--emerald)' : 'var(--crimson)' }}>
            {(audit?.summary.errorCount || 0) === 0 ? t('结构健康', 'Healthy') : t('需检修', 'Needs Fix')}
          </div>
          <div className="kpi-sub">
            {t(
              `同步日 ${methodology.meta.syncDate} · 缺口 ${ledger.stats.openGapCount} · 待拍板 ${ledger.stats.pendingSuggestionCount}`,
              `Sync ${methodology.meta.syncDate} · ${ledger.stats.openGapCount} Gaps · ${ledger.stats.pendingSuggestionCount} Pending`
            )}
          </div>
        </div>
      </div>

      {/* 主视觉行：评分走势图 + 高频卡片矩阵 */}
      <div className="grid-2" style={{ marginBottom: 16 }}>
        {/* 大盘评分走势与最新次日跟踪锚 */}
        <div className="panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <TrendingUp size={16} color="var(--amber)" />
              {t(`大盘日度评分轨迹（${timeline.length} 个已评分交易日）`, `Daily Market Score Trajectory (${timeline.length} Scored Sessions)`)}
            </h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigateTab('ledger')}>
              {t('进入台账', 'Open Ledger')} <ArrowRight size={13} />
            </button>
          </div>
          <div className="panel-pad">
            {timeline.length === 0 ? (
              <div className="empty-state" style={{ padding: '26px 12px' }}>
                <div style={{ marginBottom: 8 }}>
                  {t('尚无已评分的日度复盘记录', 'No scored daily review sessions yet')}
                </div>
                <button type="button" className="btn btn-amber btn-sm" onClick={() => onQuickCreate('daily')}>
                  <Plus size={13} /> {t('录入首篇日度复盘', 'Create First Daily Review')}
                </button>
              </div>
            ) : (
              <>
                {hoveredPoint && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '7px 11px',
                      borderRadius: 7,
                      background: 'var(--bg-soft)',
                      marginBottom: 10,
                      fontSize: 12.5,
                      gap: 10,
                    }}
                  >
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span className="badge badge-amber mono" style={{ marginRight: 8 }}>
                        {hoveredPoint.date}
                      </span>
                      <span style={{ color: 'var(--text)' }}>{hoveredPoint.title}</span>
                    </div>
                    <strong className="num" style={{ color: 'var(--amber)', flexShrink: 0 }}>
                      {hoveredPoint.score} / 10
                    </strong>
                  </div>
                )}

                <svg viewBox={`0 0 ${chartW} ${chartH}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
                  <defs>
                    <linearGradient id="scoreAreaGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--amber)" stopOpacity="0.25" />
                      <stop offset="100%" stopColor="var(--amber)" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>
                  {[2, 4, 6, 8, 10].map((v) => {
                    const y = padT + innerH - (v / 10) * innerH;
                    return (
                      <g key={v}>
                        <line
                          x1={padL}
                          x2={chartW - padR}
                          y1={y}
                          y2={y}
                          stroke="var(--border)"
                          strokeDasharray={v === 6 ? '4 3' : undefined}
                        />
                        <text x={padL - 8} y={y + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                          {v}
                        </text>
                      </g>
                    );
                  })}
                  {areaStr && <polygon points={areaStr} fill="url(#scoreAreaGrad)" />}
                  {polylineStr && (
                    <polyline
                      points={polylineStr}
                      fill="none"
                      stroke="var(--amber)"
                      strokeWidth="2.4"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  )}
                  {points.map((pt, i) => (
                    <g
                      key={pt.date}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHoverIdx(i)}
                      onClick={() => onOpenEntity({ kind: 'daily', id: `daily-${pt.date}` })}
                    >
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={hoverIdx === i || (hoverIdx === null && i === points.length - 1) ? 5.5 : 3.4}
                        fill="var(--bg-elev)"
                        stroke="var(--amber)"
                        strokeWidth="2.2"
                      />
                      {(i === 0 || i === points.length - 1 || i % Math.max(1, Math.floor(points.length / 5)) === 0) && (
                        <text x={pt.x} y={chartH - 7} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                          {pt.date.slice(5)}
                        </text>
                      )}
                    </g>
                  ))}
                </svg>
              </>
            )}

            {ledger.latestDailySummary && (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>
                  {t(
                    `最新复盘（${ledger.latestDailySummary.date}）下一交易日跟踪锚`,
                    `Latest Review (${ledger.latestDailySummary.date}) Next-Session Tracking Anchors`
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {ledger.latestDailySummary.nextAnchors.slice(0, 5).map((anc, idx) => (
                    <div
                      key={idx}
                      style={{
                        fontSize: 12.5,
                        color: 'var(--text-secondary)',
                        padding: '5px 9px',
                        background: 'var(--bg-soft)',
                        borderRadius: 6,
                        lineHeight: 1.5,
                      }}
                    >
                      <CardLinkText text={anc} onOpenEntity={onOpenEntity} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 高频核心方法论卡可信度矩阵 */}
        <div className="panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <BookOpen size={16} color="var(--navy)" />
              {t('高频复盘核心卡可信度矩阵（Top 14）', 'High-Frequency Rule Credibility Matrix (Top 14)')}
            </h3>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigateTab('methodology')}>
              {t('全部卡片', 'All Cards')} <ArrowRight size={13} />
            </button>
          </div>
          <div style={{ maxHeight: 410, overflowY: 'auto' }}>
            {highFreqCards.length === 0 ? (
              <div className="empty-state" style={{ padding: '40px 18px' }}>
                <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                  {t('当前暂无高频复盘核心方法论卡', 'No high-frequency reviewed methodology cards yet')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  {t(
                    '新建方法论卡并在日度复盘中持续引用校准后，此处会自动汇总高频规则可信度排行。',
                    'Create methodology rules and calibrate them in daily reviews to populate this credibility matrix.'
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onQuickCreate('method')}>
                    <Plus size={13} /> {t('新建方法论卡', 'New Rule Card')}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => onNavigateTab('methodology')}>
                    {t('前往方法论库', 'Open Methodology')}
                  </button>
                </div>
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 62 }}>{t('卡号', 'ID')}</th>
                    <th>{t('主题与体系', 'Topic & System')}</th>
                    <th style={{ width: 125 }}>{t('可信度', 'Credibility')}</th>
                    <th style={{ width: 88 }}>{t('状态', 'Status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {highFreqCards.slice(0, 14).map((c) => (
                    <tr
                      key={c.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => onOpenEntity({ kind: 'methodology', id: c.id })}
                    >
                      <td className="mono" style={{ fontWeight: 700, color: 'var(--navy)' }}>
                        {c.id}
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text)' }}>{c.title}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          {t(
                            `${c.reviewCount} 次复盘 · 最近 ${c.latestReviewDate || '-'}`,
                            `${c.reviewCount} reviews · Latest ${c.latestReviewDate || '-'}`
                          )}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <div className="cred-bar-track" style={{ flex: 1 }}>
                            <div
                              className="cred-bar-fill"
                              style={{
                                width: `${Math.round((c.credibilityScore ?? 0) * 100)}%`,
                                background: credColor(c.credibilityScore),
                              }}
                            />
                          </div>
                          <span className="num" style={{ fontWeight: 700, fontSize: 12.5, width: 32, textAlign: 'right' }}>
                            {c.credibilityScore ?? '-'}
                          </span>
                        </div>
                      </td>
                      <td>
                        {c.isArchived ? (
                          <span className="badge badge-violet">{t('封存', 'Archived')}</span>
                        ) : c.isHighPaused ? (
                          <span className="badge badge-amber">{t('高位暂停', 'Paused')}</span>
                        ) : c.isPendingRetire ? (
                          <span className="badge badge-crimson">{t('待淘汰', 'Retire?')}</span>
                        ) : (
                          <span className="badge badge-emerald">{t('活跃检验', 'Active')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* 下部双栏：数据缺口 + 待拍板规则建议 */}
      <div className="grid-2">
        <div className="panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <AlertCircle size={16} color="var(--crimson)" />
              {t(`当前待补数据缺口（截至 ${ledger.latestDailySummary?.date || '-'}）`, `Open Data Gaps (as of ${ledger.latestDailySummary?.date || '-'})`)}
            </h3>
            <span className="badge badge-muted num">
              {ledger.latestDailySummary?.gaps.length || 0} {t('项', 'items')}
            </span>
          </div>
          <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {(ledger.latestDailySummary?.gaps || []).length === 0 ? (
              <div style={{ color: 'var(--emerald)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={15} /> {t('当前无登记数据缺口', 'No open data gaps recorded')}
              </div>
            ) : (
              ledger.latestDailySummary!.gaps.map((g, idx) => (
                <div
                  key={idx}
                  style={{
                    fontSize: 12.5,
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: /已补|销项/.test(g) ? 'var(--emerald-soft)' : 'var(--bg-soft)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {g}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <ShieldAlert size={16} color="var(--violet)" />
              {t('待拍板优化建议（未采纳不自动执行）', 'Pending Rule Proposals (Manual Approval Required)')}
            </h3>
            <span className="badge badge-violet">{t('人工裁决区', 'Manual Review')}</span>
          </div>
          <div style={{ maxHeight: 340, overflowY: 'auto' }}>
            {ledger.pendingSuggestions.length === 0 ? (
              <div className="empty-state" style={{ padding: '28px 12px' }}>
                {t('暂无待拍板规则建议', 'No pending proposals')}
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>{t('号', '#')}</th>
                    <th>{t('建议内容', 'Proposal')}</th>
                    <th style={{ width: 80 }}>{t('目标', 'Target')}</th>
                    <th style={{ width: 72 }}>{t('佐证记录', 'Evidence')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.pendingSuggestions.map((s) => (
                    <tr key={s.num}>
                      <td style={{ fontWeight: 700, color: 'var(--violet)' }}>{s.num}</td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{s.name}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{s.summary}</div>
                      </td>
                      <td>
                        <span className="badge badge-muted mono">{s.targetCard}</span>
                      </td>
                      <td className="num" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {s.evidenceMentions} {t('次', 'x')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* 最新三库动态预览 */}
      <div className="grid-3" style={{ marginTop: 16 }}>
        <div className="panel panel-pad">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>
            <Lightbulb size={15} color="var(--teal)" /> {t('最新入库产业认知卡', 'Latest Industry Intel Cards')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {cognition.cards.slice(-4).reverse().map((c) => (
              <button
                key={c.id}
                type="button"
                className="list-card"
                onClick={() => onOpenEntity({ kind: 'cognition', id: c.id })}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span className="badge badge-teal mono">{t('认知', 'Intel')} {c.id}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.ingestedDate}</span>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{c.title}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="panel panel-pad">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>
            <BookOpen size={15} color="var(--navy)" /> {t('最新入库方法论卡片', 'Latest Methodology Cards')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {methodology.cards.slice(-4).reverse().map((c) => (
              <button
                key={c.id}
                type="button"
                className="list-card"
                onClick={() => onOpenEntity({ kind: 'methodology', id: c.id })}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span className="badge badge-navy mono">{t('卡片', 'Card')} {c.id}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.system}</span>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{c.title}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="panel panel-pad">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>
            <Flame size={15} color="var(--crimson)" /> {t('最新冲突矩阵条目', 'Latest Conflict Matrix Entries')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {methodology.conflicts.slice(-4).reverse().map((cf) => (
              <button
                key={cf.id}
                type="button"
                className="list-card"
                onClick={() => onOpenEntity({ kind: 'conflict', id: String(cf.id) })}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span className="badge badge-crimson mono">{t('冲突', 'Conflict')} {cf.id}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{cf.versionTag}</span>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{cf.title}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 页尾紧凑合规与本地工具免责声明（首屏无遮挡，合规声明常驻不可关闭） */}
      <ComplianceDisclaimerBanner
        variant="footer"
        showExecutionBoundary={IS_COMMERCIAL_EDITION}
        dismissible={!IS_COMMERCIAL_EDITION}
      />
    </div>
  );
};
