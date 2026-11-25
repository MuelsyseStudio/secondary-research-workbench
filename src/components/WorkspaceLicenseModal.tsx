import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  KeyRound,
  Layers,
  Loader2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { APP_EDITION, EDITION_DISPLAY_LABEL, IS_OPEN_SOURCE_EDITION } from '../config/edition';
import type { EntitlementsSnapshot, LicenseStatusInfo, WorkspaceProfileInfo } from '../types';
import { ComplianceDisclaimerBanner } from './ComplianceDisclaimerBanner';

const TIER_LABEL_EN_MAP: Record<string, string> = {
  free: 'Community Free Edition',
  community_oss: 'Open-Source Community Edition',
  pro_annual: 'Pro Annual Edition',
  pro_lifetime: 'Pro Lifetime Edition',
  max_annual: 'Max Quant Annual Edition',
  max_lifetime: 'Max Quant Lifetime Edition',
  friend_trial: 'Trial / Partner Access',
  partner: 'Institutional Partner Edition',
  developer: 'Personal Dev Full Access',
};

const EDITION_LABEL_EN_MAP: Record<string, string> = {
  personal: 'Personal Dev Edition',
  open_source: 'Open-Source Edition (Apache-2.0)',
  cn_commercial: 'CN Commercial Edition',
  global_commercial: 'Global Commercial Edition',
  partner: 'Partner Edition',
};

function localizeSystemHolder(holder: string | undefined, t: (zh: string, en: string) => string): string {
  const raw = String(holder || '').trim();
  if (!raw) return '—';
  if (/未激活|社区免费/.test(raw)) return t(raw, 'Unlicensed (Community Free)');
  if (/开发者|个人自用/.test(raw)) return t(raw, 'Local Developer');
  if (/本机用户|体验用户/.test(raw)) return t(raw, 'Local User');
  return raw;
}

interface WorkspaceLicenseModalProps {
  open: boolean;
  initialTab?: 'workspace' | 'license';
  workspaceProfile: WorkspaceProfileInfo | null;
  license: LicenseStatusInfo | null;
  onClose: () => void;
  onProfileUpdated: (profile: WorkspaceProfileInfo) => void;
  onLicenseUpdated: (license: LicenseStatusInfo, entitlements?: EntitlementsSnapshot) => void;
  onWorkspaceSwitched: (nextProfile?: WorkspaceProfileInfo) => Promise<void>;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

const PRO_FEATURE_LABELS: Record<string, { titleZh: string; titleEn: string; descZh: string; descEn: string; tier?: 'pro' | 'max' }> = {
  multi_workspace: {
    titleZh: '多工作空间 & Obsidian / Git 自由挂载',
    titleEn: 'Multi-Workspace & Obsidian / Git Mount',
    descZh: '隔离个人实盘、模拟训练与专题研究三库，纯文本永不锁死',
    descEn: 'Isolate live trading, paper practice & thematic workspaces in plain Markdown',
    tier: 'pro',
  },
  ai_daily_review: {
    titleZh: 'AI 全自动日度复盘与数值防幻觉对账',
    titleEn: 'AI Daily Review & Numerical Reconciliation',
    descZh: '基于真实 1 分钟数据自动生成十节复盘草稿、校验数值并归档 HTML',
    descEn: 'Generate structured daily reviews from 1m data with strict numerical checks & HTML export',
    tier: 'pro',
  },
  ic_adversarial_debate: {
    titleZh: 'AI 标的研判与红队反驳辩论',
    titleEn: 'AI Thesis Synthesis & Red-Team Debate',
    descZh: '自动整理公开财务/公告与可证伪假设，多空对称红队校验',
    descEn: 'Compile public filings & falsifiable hypotheses with symmetric bull/bear stress tests',
    tier: 'pro',
  },
  ai_batch_ingest: {
    titleZh: '文献 / 语音 / 情报中心 / 存量库批量提纯',
    titleEn: 'Document / Voice / Intel Hub Batch Ingestion',
    descZh: 'PDF/Word/音频与存量资料批量提纯入候选收件箱',
    descEn: 'Batch distill PDFs, docs, audio & local vaults into structured candidate cards',
    tier: 'pro',
  },
  trade_ledger_ai_import: {
    titleZh: '交割单 CSV/AI 解析与坏习惯成本归因',
    titleEn: 'Broker CSV/AI Trade Import & Attribution',
    descZh: '券商交割单批量入账、做T拆解、卖飞/逃顶质量审计',
    descEn: 'Batch broker statements, intraday swing breakdown & behavioral cost analytics',
    tier: 'pro',
  },
  custom_chart_drawings: {
    titleZh: 'K 线手工画线持久化与穿线预警',
    titleEn: 'Persistent Chart Drawings & Breakout Alerts',
    descZh: '支撑/压力水平线与趋势射线本地存档并纳入盘中雷达监控',
    descEn: 'Persist S/R lines & trend rays locally with live breakout radar alerts',
    tier: 'pro',
  },
  scheduler_webhooks: {
    titleZh: '自动化定时巡检与多通道推送',
    titleEn: 'Scheduled Scans & Push Notifications',
    descZh: '盘中/盘后定时巡检任务及飞书/企微/钉钉通知推送（合规数据源与本地 Webhook 免费开放）',
    descEn: 'Scheduled intraday/close scans & push alerts (custom compliant feeds remain free)',
    tier: 'pro',
  },
  periodic_meta_review: {
    titleZh: '周报 / 月报聚合复盘与独立 HTML 导出',
    titleEn: 'Weekly / Monthly Meta-Review & HTML Reports',
    descZh: '跨日评分曲线、预测锚命中率统计、AI 元复盘与卡片进化建议',
    descEn: 'Cross-session score curves, anchor hit-rate stats & rule evolution proposals',
    tier: 'pro',
  },
  slime_bot_autonomous: {
    titleZh: 'AI 助手提案确认/自动写库与桌面悬浮挂件',
    titleEn: 'Autonomous Assistant & Desktop Companion',
    descZh: '授权助手按确认模式或自动模式写库，及桌面独立挂件联动',
    descEn: 'Diff-gated library proposals & desktop companion sync',
    tier: 'pro',
  },
  brand_custom: {
    titleZh: '工作台个性化品牌图标与 AI 重绘',
    titleEn: 'Custom Workspace Branding & Icon Styling',
    descZh: '自定义左上角图标、标题与专属工作台视觉标识',
    descEn: 'Customize brand emblem, title & visual identity',
    tier: 'pro',
  },
  bar_replay_trainer: {
    titleZh: 'K 线历史盲测回放训练器',
    titleEn: 'Historical Bar Replay Trainer',
    descZh: '隐去右侧未来行情逐根推演，模拟下单并实时算盈亏与回撤',
    descEn: 'Step bar-by-bar through hidden future candles with simulated orders & P&L',
    tier: 'pro',
  },
  multi_chart: {
    titleZh: '短线多图同屏盯盘（2 屏 / 4 屏）',
    titleEn: 'Multi-Chart Tape Layout (2x / 4x)',
    descZh: '多标的同屏分时/K 线对照与联动切换',
    descEn: 'Side-by-side intraday & K-line monitoring with linked switching',
    tier: 'pro',
  },
  quant_backtest: {
    titleZh: 'Python + DuckDB 策略回测实验室（Max）',
    titleEn: 'Python + DuckDB Backtest Lab (Max)',
    descZh: '本地 DuckDB 行情仓、多市场撮合回测内核与 K 线 B/S 复盘',
    descEn: 'Local DuckDB market store, multi-market simulator & K-line B/S replay',
    tier: 'max',
  },
};

export const WorkspaceLicenseModal: React.FC<WorkspaceLicenseModalProps> = ({
  open,
  initialTab = 'workspace',
  workspaceProfile,
  license,
  onClose,
  onProfileUpdated,
  onLicenseUpdated,
  onWorkspaceSwitched,
  onToast,
}) => {
  const { t } = useI18n();
  const [tab, setTab] = useState<'workspace' | 'license'>(initialTab);

  // Create sub-workspace form
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState<'starter' | 'blank'>('starter');
  const [creating, setCreating] = useState(false);

  // Mount existing directory form
  const [customPath, setCustomPath] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [initIfMissing, setInitIfMissing] = useState(false);
  const [switchingPath, setSwitchingPath] = useState<string | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);

  // License activation form
  const [licenseInput, setLicenseInput] = useState('');
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setActionError(null);
    setActionSuccess(null);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    setActionError(null);
    setActionSuccess(null);
  }, [tab]);

  if (!open) return null;

  const copyPath = (text: string) => {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => onToast(t('已复制内容到剪贴板', 'Copied to clipboard'), 'success'),
      () => onToast(t('复制失败，请手动选中复制', 'Copy failed — please copy manually'), 'error')
    );
  };

  const handlePickFolder = async () => {
    if (pickingFolder) return;
    setPickingFolder(true);
    setActionError(null);
    try {
      const r = await api.pickFolder(
        t('选择本地三库或 Obsidian / Git 文件夹', 'Select Local 3-Library or Obsidian / Git Folder')
      );
      if (r.path) {
        setCustomPath(r.path);
        onToast(`${t('已选中文件夹：', 'Selected folder: ')}${r.path}`, 'success');
      } else if (r.cancelled) {
        // User cleanly cancelled native dialog — no error noise
      } else if (r.error || r.message) {
        const msg = r.error || r.message || t('无法打开目录选择器', 'Folder picker failed');
        setActionError(msg);
        onToast(msg, 'error');
      }
    } catch (err: any) {
      const msg = `${t('打开目录选择器失败：', 'Folder picker error: ')}${err.message}`;
      setActionError(msg);
      onToast(msg, 'error');
    } finally {
      setPickingFolder(false);
    }
  };

  const handleSwitch = async (
    targetDir: string,
    opts?: { label?: string; initIfMissing?: boolean; template?: 'starter' | 'blank' }
  ) => {
    setActionError(null);
    setActionSuccess(null);
    setSwitchingPath(targetDir);
    try {
      const res = await api.switchWorkspace({
        targetDir,
        label: opts?.label,
        initIfMissing: opts?.initIfMissing,
        template: opts?.template || 'starter',
      });
      onProfileUpdated(res.workspaceProfile);
      await onWorkspaceSwitched(res.workspaceProfile);
      setActionSuccess(`${t('已切换至工作空间：', 'Switched workspace to: ')}${res.workspaceProfile.activeProjectRoot}`);
      if (res.auditRecorded === false) {
        onToast(
          t(
            `工作空间已切换，但审计日志写入失败：${res.auditError || '磁盘受阻'}`,
            `Workspace switched, but audit log write failed: ${res.auditError || 'disk error'}`
          ),
          'warning'
        );
      } else {
        onToast(t('工作空间切换成功，已重新解析现行三库', 'Workspace switched and libraries reloaded'), 'success');
      }
    } catch (err: any) {
      setActionError(err.message || t('切换工作空间失败', 'Failed to switch workspace'));
    } finally {
      setSwitchingPath(null);
    }
  };

  const handleCreateWorkspace = async () => {
    if (!newName.trim()) {
      setActionError(t('请先填写新工作空间名称（如：2026实盘三库）', 'Please enter a workspace name first'));
      return;
    }
    setActionError(null);
    setActionSuccess(null);
    setCreating(true);
    try {
      const res = await api.createWorkspace({ name: newName.trim(), template: newTemplate });
      onProfileUpdated(res.workspaceProfile);
      await onWorkspaceSwitched(res.workspaceProfile);
      const createdName = newName.trim();
      setNewName('');
      setActionSuccess(`${t('已创建并切换至新空间：', 'Created and switched to: ')}${res.workspaceProfile.activeProjectRoot}`);
      if (res.auditRecorded === false) {
        onToast(
          t(
            `新空间「${createdName}」已创建，但审计日志写入失败：${res.auditError || '磁盘受阻'}`,
            `Workspace "${createdName}" created, but audit log write failed: ${res.auditError || 'disk error'}`
          ),
          'warning'
        );
      } else {
        onToast(t(`新工作空间「${createdName}」已就绪`, `Workspace "${createdName}" is ready`), 'success');
      }
    } catch (err: any) {
      setActionError(err.message || t('创建工作空间失败', 'Failed to create workspace'));
    } finally {
      setCreating(false);
    }
  };

  const handleActivateLicense = async () => {
    if (!licenseInput.trim()) {
      setActionError(t('请粘贴以 SRW2. 或 SRW1. 开头的离线授权码', 'Please paste an offline license key starting with SRW2. or SRW1.'));
      return;
    }
    setActionError(null);
    setActionSuccess(null);
    setActivating(true);
    try {
      const res = await api.activateLicense(licenseInput.trim());
      onLicenseUpdated(res.license, res.entitlements);
      setLicenseInput('');
      const tierDisplay = t(res.license.tierLabel, TIER_LABEL_EN_MAP[res.license.tier] || res.license.tierLabel);
      setActionSuccess(
        t(
          `离线验签通过！已激活：${tierDisplay}（持有人：${localizeSystemHolder(res.license.holder, t)}）`,
          `Verified offline! Activated: ${tierDisplay} (Holder: ${localizeSystemHolder(res.license.holder, t)})`
        )
      );
      if (res.auditRecorded === false) {
        onToast(
          t(
            `授权已激活（${tierDisplay}），但审计日志写入失败：${res.auditError || '磁盘受阻'}`,
            `License activated (${tierDisplay}), but audit log write failed: ${res.auditError || 'disk error'}`
          ),
          'warning'
        );
      } else {
        onToast(`${t('授权激活成功：', 'License activated: ')}${tierDisplay}`, 'success');
      }
    } catch (err: any) {
      setActionError(err.message || t('授权码校验失败', 'License verification failed'));
    } finally {
      setActivating(false);
    }
  };

  const handleDeactivateLicense = async () => {
    setActionError(null);
    setActionSuccess(null);
    setDeactivating(true);
    try {
      const res = await api.deactivateLicense();
      onLicenseUpdated(res.license, res.entitlements);
      setActionSuccess(t('已移除本机保存的授权码', 'Local license key removed'));
      if (res.auditRecorded === false) {
        onToast(
          t(
            `已移除授权码，但审计日志写入失败：${res.auditError || '磁盘受阻'}`,
            `License removed, but audit log write failed: ${res.auditError || 'disk error'}`
          ),
          'warning'
        );
      } else {
        onToast(t('已清除当前授权记录', 'License deactivated'), 'info');
      }
    } catch (err: any) {
      setActionError(err.message || t('清除授权失败', 'Failed to deactivate license'));
    } finally {
      setDeactivating(false);
    }
  };

  const tierTone =
    license?.tier === 'pro_lifetime' || license?.tier === 'max_lifetime' || license?.tier === 'developer'
      ? 'badge-emerald'
      : license?.tier === 'pro_annual' || license?.tier === 'max_annual' || license?.tier === 'friend_trial' || license?.tier === 'partner'
      ? 'badge-navy'
      : 'badge-amber';

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('工作空间与离线授权中心', 'Workspaces & Offline Licensing')}
      onClick={onClose}
    >
      <div className="modal-box" style={{ maxWidth: 820 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Layers size={19} color="var(--navy)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                {IS_OPEN_SOURCE_EDITION
                  ? t(
                      `本地工作空间管理（开源社区版 v${workspaceProfile?.appVersion || '2.0.0'}）`,
                      `Local Workspaces (Open-Source v${workspaceProfile?.appVersion || '2.0.0'})`
                    )
                  : t(
                      `工作空间与离线授权中心（纯本地桌面版 v${workspaceProfile?.appVersion || '2.0.0'}）`,
                      `Workspaces & Offline Licensing (Local Desktop v${workspaceProfile?.appVersion || '2.0.0'})`
                    )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {IS_OPEN_SOURCE_EDITION
                  ? t(
                      '所有三库均为纯文本 Markdown 存于本机目录 · Apache-2.0 开源版本，全部本地研究与回测功能免费开放',
                      'All 3 libraries live as plain Markdown locally · Apache-2.0 Open-Source edition with all local features unlocked'
                    )
                  : t(
                      '所有三库均为纯文本 Markdown 存于本机目录 · 支持自由切换空间与离线数字签名授权验证',
                      'All 3 libraries live as plain Markdown files locally · Switch workspaces & manage offline signed licenses'
                    )}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={t('关闭弹窗', 'Close dialog')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Tab Switcher */}
          <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
            <button
              type="button"
              className={`btn btn-sm ${tab === 'workspace' ? 'btn-primary' : ''}`}
              onClick={() => setTab('workspace')}
            >
              <FolderOpen size={14} />
              <span>
                {t('本地工作空间', 'Local Workspaces')} ({workspaceProfile?.workspaces.length || 1})
              </span>
            </button>
            {!IS_OPEN_SOURCE_EDITION && (
              <button
                type="button"
                className={`btn btn-sm ${tab === 'license' ? 'btn-primary' : ''}`}
                onClick={() => setTab('license')}
              >
                <KeyRound size={14} />
                <span>{t('离线授权与版本', 'Offline License & Edition')}</span>
                {license && (
                  <span className={`badge ${tierTone}`} style={{ fontSize: 10, padding: '0 5px' }}>
                    {license.activated ? t('已激活', 'Active') : license.tier === 'developer' ? t('主理人', 'Dev') : t('体验态', 'Trial')}
                  </span>
                )}
              </button>
            )}
          </div>

          {actionError && (
            <div
              style={{
                padding: '9px 12px',
                borderRadius: 8,
                background: 'var(--crimson-soft)',
                color: 'var(--crimson)',
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              {actionError}
            </div>
          )}

          {actionSuccess && (
            <div
              style={{
                padding: '9px 12px',
                borderRadius: 8,
                background: 'var(--emerald-soft)',
                color: 'var(--emerald)',
                fontSize: 12.5,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <CheckCircle2 size={15} />
              <span>{actionSuccess}</span>
            </div>
          )}

          {tab === 'workspace' && workspaceProfile && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Current Active Directory Card */}
              <div className="panel panel-pad" style={{ background: 'var(--bg-subtle)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <FolderGit2 size={16} color="var(--navy)" />
                    <span style={{ fontWeight: 700, fontSize: 13 }}>
                      {t('当前激活的现行三库目录', 'Active 3-Library Directory')}
                    </span>
                    <span className={`badge ${workspaceProfile.isPortableMode ? 'badge-emerald' : 'badge-navy'}`}>
                      {workspaceProfile.isPortableMode
                        ? t('便携独立桌面模式', 'Portable Desktop Mode')
                        : t('开发者原位模式', 'In-Place Dev Mode')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => copyPath(workspaceProfile.activeCurrentDir)}
                  >
                    <Copy size={12} /> {t('复制路径', 'Copy Path')}
                  </button>
                </div>
                <div
                  className="mono"
                  style={{
                    marginTop: 8,
                    padding: '7px 10px',
                    borderRadius: 6,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    fontSize: 12,
                    wordBreak: 'break-all',
                    color: 'var(--text-primary)',
                  }}
                >
                  {workspaceProfile.activeCurrentDir}
                </div>
                <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {t('状态与快照目录：', 'State & Snapshot Dir: ')}
                  <span className="mono">{workspaceProfile.stateDir}</span>{' '}
                  {t('（可用 Obsidian / VSCode / Git 直接打开同步）', '(Compatible with Obsidian / VSCode / Git)')}
                </div>
              </div>

              {/* Saved Workspaces List */}
              <div>
                <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 8, color: 'var(--text-secondary)' }}>
                  {t('已登记工作空间（点击一键热切换，不重启服务）', 'Registered Workspaces (Hot-switch without restarting)')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {workspaceProfile.workspaces.map((ws) => (
                    <div
                      key={ws.path}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 10,
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: ws.isActive ? '1.5px solid var(--navy)' : '1px solid var(--border)',
                        background: ws.isActive ? 'var(--navy-soft)' : 'var(--bg-card)',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 700, fontSize: 13 }}>{ws.label}</span>
                          {ws.isActive && <span className="badge badge-emerald">{t('当前使用中', 'Active')}</span>}
                          {ws.isDefault && <span className="badge badge-muted">{t('默认空间', 'Default')}</span>}
                          {!ws.exists && <span className="badge badge-crimson">{t('缺少三库文件', 'Missing Files')}</span>}
                        </div>
                        <div
                          className="mono"
                          style={{
                            fontSize: 11.5,
                            color: 'var(--text-muted)',
                            marginTop: 2,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={ws.path}
                        >
                          {ws.path}
                        </div>
                      </div>
                      {!ws.isActive && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={Boolean(switchingPath)}
                          onClick={() => handleSwitch(ws.path, { label: ws.label })}
                        >
                          {switchingPath === ws.path ? t('切换中...', 'Switching...') : t('切换到此空间', 'Switch')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Create New Workspace + Mount Local Folder (2 columns) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="panel panel-pad">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                    <FolderPlus size={15} color="var(--navy)" />
                    <span>{t('新建独立三库工作空间', 'Create New Workspace')}</span>
                  </div>
                  <div className="field-group" style={{ marginBottom: 8 }}>
                    <label className="field-label">{t('空间名称', 'Workspace Name')}</label>
                    <input
                      className="input"
                      placeholder={t('例如：2026实盘主空间 / 美股科技研究', 'e.g. 2026 Live Desk / US Tech Research')}
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  </div>
                  <div className="field-group" style={{ marginBottom: 10 }}>
                    <label className="field-label">{t('初始化模板', 'Starter Template')}</label>
                    <select
                      className="input"
                      value={newTemplate}
                      onChange={(e) => setNewTemplate(e.target.value as 'starter' | 'blank')}
                    >
                      <option value="starter">
                        {t('脱敏示例三库（12 张方法论卡 + 示例研判/复盘）', 'Sanitized Demo Library (12 Rules + Sample Notes)')}
                      </option>
                      <option value="blank">
                        {t('极简空白三库（仅含 1 张风控底线初始卡）', 'Minimal Blank Library (1 Risk Baseline Card)')}
                      </option>
                    </select>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    style={{ width: '100%', justifyContent: 'center' }}
                    disabled={creating}
                    onClick={handleCreateWorkspace}
                  >
                    <Sparkles size={13} />
                    <span>{creating ? t('正在初始化并切换...', 'Creating & switching...') : t('一键创建并切换', 'Create & Switch')}</span>
                  </button>
                </div>

                <div className="panel panel-pad">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                    <FolderOpen size={15} color="var(--navy)" />
                    <span>{t('挂载本机任意目录（Obsidian / Git）', 'Mount Local Folder (Obsidian / Git)')}</span>
                  </div>
                  <div className="field-group" style={{ marginBottom: 8 }}>
                    <label className="field-label">{t('本地文件夹绝对路径', 'Absolute Local Folder Path')}</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="input mono"
                        style={{ fontSize: 12, flex: 1 }}
                        placeholder={t('例如：D:\\Notes\\我的投研库', 'e.g. D:\\Notes\\ResearchVault')}
                        value={customPath}
                        onChange={(e) => setCustomPath(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ flexShrink: 0 }}
                        disabled={pickingFolder}
                        onClick={handlePickFolder}
                        title={t('调用操作系统原生文件夹浏览对话框（异步不阻塞服务）', 'Open native OS folder picker (non-blocking)')}
                      >
                        {pickingFolder ? <Loader2 size={13} className="spin" /> : <FolderOpen size={13} />}
                        <span>{pickingFolder ? t('选择中...', 'Picking...') : t('浏览', 'Browse')}</span>
                      </button>
                    </div>
                  </div>
                  <div className="field-group" style={{ marginBottom: 8 }}>
                    <label className="field-label">{t('显示别名（可选）', 'Display Alias (optional)')}</label>
                    <input
                      className="input"
                      placeholder={t('例如：Obsidian 同步库', 'e.g. Obsidian Sync Vault')}
                      value={customLabel}
                      onChange={(e) => setCustomLabel(e.target.value)}
                    />
                  </div>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11.5,
                      color: 'var(--text-secondary)',
                      marginBottom: 10,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={initIfMissing}
                      onChange={(e) => setInitIfMissing(e.target.checked)}
                    />
                    <span>{t('若目录内尚无「现行三库/」，自动初始化三库模板', 'Initialize 3-library template automatically if missing')}</span>
                  </label>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ width: '100%', justifyContent: 'center' }}
                    disabled={Boolean(switchingPath) || !customPath.trim()}
                    onClick={() =>
                      handleSwitch(customPath.trim(), {
                        label: customLabel.trim() || undefined,
                        initIfMissing,
                        template: 'starter',
                      })
                    }
                  >
                    <span>{switchingPath === customPath.trim() ? t('正在挂载...', 'Mounting...') : t('挂载并切换', 'Mount & Switch')}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === 'license' && license && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Current License Status Card */}
              <div className="panel panel-pad" style={{ background: 'var(--bg-subtle)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <ShieldCheck size={18} color="var(--emerald)" />
                      <span style={{ fontWeight: 700, fontSize: 15 }}>
                        {t(license.tierLabel, TIER_LABEL_EN_MAP[license.tier] || license.tierLabel)}
                      </span>
                      <span className="badge badge-navy">
                        {t(EDITION_DISPLAY_LABEL, EDITION_LABEL_EN_MAP[APP_EDITION] || EDITION_DISPLAY_LABEL)}
                      </span>
                      <span className="badge badge-muted">
                        {license.enforcementMode === 'enforced'
                          ? t('正式授权校验模式', 'Standard License Check')
                          : t('体验友好模式', 'Permissive Mode')}
                      </span>
                    </div>
                    <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, fontSize: 12 }}>
                      <div>
                        <span style={{ color: 'var(--text-muted)' }}>{t('授权持有人：', 'License Holder: ')}</span>
                        <strong>{localizeSystemHolder(license.holder, t)}</strong>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-muted)' }}>{t('授权编号：', 'License ID: ')}</span>
                        <span className="mono">{license.licenseId || '—'}</span>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-muted)' }}>{t('更新 / 永久回退截止日：', 'Updates / Fallback Until: ')}</span>
                        <strong>
                          {license.activated
                            ? license.updatesUntil || license.expiresAt
                              ? `${license.updatesUntil || license.expiresAt}${
                                  license.perpetualFallback
                                    ? license.perpetualFallbackActive
                                      ? t(' (永久回退有效)', ' (Perpetual fallback active)')
                                      : t(' (含永久回退权)', ' (Perpetual fallback included)')
                                    : license.daysRemaining !== null
                                    ? t(` (剩 ${license.daysRemaining} 天)`, ` (${license.daysRemaining}d left)`)
                                    : ''
                                }`
                              : t(`永久有效 (v${license.fallbackMajor || 2}.x 买断)`, `Perpetual (v${license.fallbackMajor || 2}.x Lifetime)`)
                            : t('未绑定授权码', 'Unlicensed')}
                        </strong>
                      </div>
                    </div>
                    {license.machineCode && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: 'var(--bg-elev)',
                          border: '1px solid var(--border)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          fontSize: 11.5,
                        }}
                      >
                        <div>
                          <span style={{ color: 'var(--text-muted)' }}>
                            {t('本机设备识别码（最多支持绑定 2 台电脑）：', 'Device Code (max 2 devices): ')}
                          </span>
                          <strong className="mono" style={{ color: 'var(--navy)', letterSpacing: '0.06em' }}>
                            {license.machineCode}
                          </strong>
                          {license.buildDate && (
                            <span className="mono" style={{ color: 'var(--text-muted)', marginLeft: 10 }}>
                              {t('构建日', 'Build')} {license.buildDate}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ height: 22, padding: '0 7px', fontSize: 11 }}
                          onClick={() => copyPath(license.machineCode || '')}
                        >
                          <Copy size={11} /> {t('复制设备码', 'Copy Code')}
                        </button>
                      </div>
                    )}
                    {license.keyPreview && (
                      <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
                        {t(`已验签密钥 (SRW${license.schemaVersion || 2})：`, `Verified Key (SRW${license.schemaVersion || 2}): `)}
                        <span className="mono">{license.keyPreview}</span>
                        {license.boundDevicesCount
                          ? t(` · 已绑设备 ${license.boundDevicesCount}/${license.maxDevices || 2}`, ` · Bound ${license.boundDevicesCount}/${license.maxDevices || 2}`)
                          : ''}
                        {license.note ? ` · ${license.note}` : ''}
                      </div>
                    )}
                  </div>
                  {license.activated && (
                    confirmDeactivate ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ background: 'var(--crimson)', color: '#fff', borderColor: 'var(--crimson)' }}
                          disabled={deactivating}
                          onClick={() => {
                            setConfirmDeactivate(false);
                            handleDeactivateLicense();
                          }}
                        >
                          {deactivating ? t('清除中...', 'Removing...') : t('确认移除', 'Confirm')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setConfirmDeactivate(false)}
                        >
                          {t('取消', 'Cancel')}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={deactivating}
                        onClick={() => setConfirmDeactivate(true)}
                        title={t('清除本机保存的授权文件（需二次确认）', 'Remove locally stored license')}
                      >
                        <Trash2 size={13} />
                        <span>{t('移除授权', 'Remove')}</span>
                      </button>
                    )
                  )}
                </div>
              </div>

              {/* Offline Ed25519 License Activation Input */}
              <div className="panel panel-pad">
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
                  {t(
                    '输入离线授权码（本地离线数字签名验证，零联网上报）',
                    'Activate Offline License Key (Local Digital Signature Verification, Zero Telemetry)'
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  {t(
                    '激活 3 步指引：① 复制上方 12 位本机设备码 → ② 在购买渠道提交设备码获取专属授权码 → ③ 粘贴下方授权码立即离线激活（支持 Pro 年度/买断、Max 量化版与体验授权）。',
                    '3-step activation: 1) Copy your 12-char Device Code above -> 2) Submit it at purchase to receive your key -> 3) Paste below to activate offline.'
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input mono"
                    style={{ flex: 1, fontSize: 12 }}
                    placeholder={t('请粘贴您的完整授权码（授权码示例：SRW2.xxxx...）', 'Paste your full license key (e.g. SRW2.xxxx...)')}
                    value={licenseInput}
                    onChange={(e) => setLicenseInput(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={activating || !licenseInput.trim()}
                    onClick={handleActivateLicense}
                  >
                    <KeyRound size={14} />
                    <span>{activating ? t('验签中...', 'Verifying...') : t('离线验签并激活', 'Verify & Activate')}</span>
                  </button>
                </div>
              </div>

              {/* Pro & Max Feature Matrix */}
              <div>
                <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 8, color: 'var(--text-secondary)' }}>
                  {t(
                    `专业版 / 量化版高阶权益矩阵（Pro：${license.proUnlocked ? '已解锁' : '未解锁'} ｜ Max：${license.maxUnlocked ? '已解锁' : '未解锁'}）`,
                    `Pro & Max Feature Entitlements (Pro: ${license.proUnlocked ? 'Unlocked' : 'Locked'} | Max: ${license.maxUnlocked ? 'Unlocked' : 'Locked'})`
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[...license.proFeatures, ...(license.maxFeatures || ['quant_backtest'])].map((key) => {
                    const info = PRO_FEATURE_LABELS[key] || { titleZh: key, titleEn: key, descZh: '', descEn: '', tier: 'pro' };
                    const unlocked = info.tier === 'max' ? Boolean(license.maxUnlocked) : Boolean(license.proUnlocked);
                    return (
                      <div
                        key={key}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--bg-card)',
                          display: 'flex',
                          gap: 8,
                          alignItems: 'flex-start',
                        }}
                      >
                        <CheckCircle2
                          size={15}
                          style={{ marginTop: 2, flexShrink: 0 }}
                          color={unlocked ? 'var(--emerald)' : 'var(--text-muted)'}
                        />
                        <div>
                          <div style={{ fontSize: 12.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span>{t(info.titleZh, info.titleEn)}</span>
                            <span className={`badge ${info.tier === 'max' ? 'badge-amber' : 'badge-navy'}`} style={{ fontSize: 9.5, padding: '0 4px' }}>
                              {info.tier === 'max' ? 'MAX' : 'PRO'}
                            </span>
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 1 }}>{t(info.descZh, info.descEn)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 产品定位、数据来源与 A 股交易执行合规免责声明 */}
              <ComplianceDisclaimerBanner variant="card" showExecutionBoundary />
            </div>
          )}
        </div>

        <div className="modal-footer">
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {t(
              '提示：三库笔记、API Key 与交割单默认仅保存在本机；仅当你主动点击 AI 分析/交割单识别时，所选文本或图片才会直接发往你自配的 AI 服务商（本地 CSV 解析全程离线零外发）。',
              'Note: Libraries, API keys & trade records are stored locally only. Selected text or images are transmitted externally only when you explicitly invoke a remote AI provider; local CSV parsing runs 100% offline.'
            )}
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            {t('关闭', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
};
