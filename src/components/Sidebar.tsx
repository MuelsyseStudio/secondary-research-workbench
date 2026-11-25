import React from 'react';
import {
  Activity,
  Award,
  BookOpen,
  CalendarClock,
  Compass,
  Crosshair,
  EyeOff,
  Flame,
  FlaskConical,
  FolderGit2,
  Globe,
  Grid,
  Layers,
  LayoutDashboard,
  Lightbulb,
  Maximize2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Wallet,
  Zap,
} from 'lucide-react';
import type { ActiveTab, AuditReport, BrandProfile, WorkbenchMode, WorkspaceData } from '../types';
import { useI18n } from '../i18n';
import { CRYPTO_ENABLED } from '../config/edition';
import { BrandMark } from './BrandMark';
import type { UserRolePreset } from './RoleOnboardingModal';

interface SidebarProps {
  workbenchMode: WorkbenchMode;
  onChangeWorkbenchMode: (mode: WorkbenchMode) => void;
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  workspace: WorkspaceData;
  audit: AuditReport | null;
  techAlertCount?: number | null;
  intelPendingCount?: number | null;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onReload: () => void;
  reloading: boolean;
  activeWorkspaceLabel?: string;
  onOpenWorkspaceModal?: () => void;
  brandProfile?: BrandProfile | null;
  onOpenBrandModal?: () => void;
  onOpenFullscreenStock?: (secidOrQuery?: string) => void;
  rolePreset?: UserRolePreset;
  focusProMode?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onOpenRoleWizard?: () => void;
  onToggleFocusProMode?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  workbenchMode,
  onChangeWorkbenchMode,
  activeTab,
  onSelectTab,
  workspace,
  audit,
  techAlertCount = null,
  intelPendingCount = null,
  theme,
  onToggleTheme,
  onReload,
  reloading,
  activeWorkspaceLabel,
  onOpenWorkspaceModal,
  brandProfile,
  onOpenBrandModal,
  onOpenFullscreenStock,
  rolePreset = 'all_features',
  focusProMode = false,
  collapsed = false,
  onToggleCollapse,
  onOpenRoleWizard,
  onToggleFocusProMode,
}) => {
  const { t } = useI18n();
  const issueAlertCount = (audit?.summary.errorCount || 0) + (audit?.summary.warningCount || 0);
  const isWaveFocused = rolePreset === 'wave_research';
  const isShortTermFocused = rolePreset === 'short_term_a';

  return (
    <aside className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}>
      <div style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'space-between', gap: 4 }}>
          <div
            className="brand-block"
            onClick={onOpenBrandModal}
            role={onOpenBrandModal ? 'button' : undefined}
            tabIndex={onOpenBrandModal ? 0 : undefined}
            title={t('点击自定义工作台左上角图标、标题与风格', 'Click to customize brand icon, title & style')}
            style={{ cursor: onOpenBrandModal ? 'pointer' : 'default', position: 'relative', flex: collapsed ? '0 0 auto' : 1, minWidth: 0 }}
          >
            <div className="brand-row" style={{ alignItems: 'center' }}>
              <BrandMark profile={brandProfile} size={collapsed ? 30 : 38} institutional={focusProMode} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div
                    className="brand-title"
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {brandProfile?.title || t('二级投研工作台', 'Alpha Research Desk')}
                  </div>
                  {onOpenBrandModal && (
                    <Pencil size={11} style={{ color: 'var(--text-muted)', opacity: 0.72, flexShrink: 0 }} />
                  )}
                </div>
                <div
                  className="brand-sub"
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {brandProfile?.subtitle || t('三库闭环 · 日常维护与复盘', '3-Library Research & Trading OS')}
                </div>
              </div>
            </div>
          </div>
          {!collapsed && onToggleCollapse && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: 4, flexShrink: 0, alignSelf: 'flex-start' }}
              onClick={onToggleCollapse}
              title={t('折叠为 56px 极窄图标栏（释放横向视口空间）', 'Collapse sidebar to 56px rail')}
            >
              <PanelLeftClose size={15} />
            </button>
          )}
        </div>

        {collapsed && onToggleCollapse && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ width: 42, justifyContent: 'center', padding: '5px 0', margin: '4px auto 6px', display: 'flex' }}
            onClick={onToggleCollapse}
            title={t('展开完整侧边导航栏', 'Expand sidebar')}
          >
            <PanelLeftOpen size={15} />
          </button>
        )}

        {/* Mode Switcher Pill inside Sidebar */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: collapsed ? '1fr' : '1fr 1fr',
            gap: 4,
            padding: 3,
            margin: '8px 0 10px',
            borderRadius: 9,
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border)',
          }}
        >
          <button
            type="button"
            className={`btn btn-sm ${workbenchMode === 'research' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ justifyContent: 'center', fontSize: 11.5, padding: collapsed ? '6px 0' : '4px 6px' }}
            onClick={() => onChangeWorkbenchMode('research')}
            title={t('切换至投研模式', 'Research Mode')}
          >
            <BookOpen size={13} /> <span className="sidebar-mode-switcher-label">{t('投研模式', 'Research')}</span>
          </button>
          <button
            type="button"
            className={`btn btn-sm ${workbenchMode === 'short_term' ? 'btn-primary' : 'btn-ghost'}`}
            style={{
              justifyContent: 'center',
              fontSize: 11.5,
              padding: collapsed ? '6px 0' : '4px 6px',
              ...(workbenchMode === 'short_term' ? { background: '#b91c1c', borderColor: '#b91c1c', color: '#fff' } : {}),
            }}
            onClick={() => onChangeWorkbenchMode('short_term')}
            title={t('切换至短线模式', 'Short-Term Mode')}
          >
            <Zap size={13} /> <span className="sidebar-mode-switcher-label">{t('短线模式', 'Short-Term')}</span>
          </button>
        </div>

        {workbenchMode === 'short_term' ? (
          <>
            <div className="nav-section-label">{t('短线作战中枢', 'Short-Term Desk')}</div>
            <div className="nav-list">
              <button
                type="button"
                className={`nav-item ${activeTab === 'st_watch' ? 'active' : ''}`}
                onClick={() => onSelectTab('st_watch')}
              >
                <span className="nav-item-left">
                  <Flame size={16} />
                  <span>{t('全景看盘与精灵', 'Panoramic Watch')}</span>
                </span>
                <span className="nav-badge" style={{ background: 'var(--crimson-soft)', color: 'var(--crimson)' }}>
                  {t('温度', 'Live')}
                </span>
              </button>

              <button
                type="button"
                className={`nav-item ${activeTab === 'st_ladder' ? 'active' : ''}`}
                onClick={() => onSelectTab('st_ladder')}
              >
                <span className="nav-item-left">
                  <Layers size={16} />
                  <span>{t('连板天梯与竞价', 'Ladder & Cycle')}</span>
                </span>
                <span className="nav-badge">{t('周期', '4x')}</span>
              </button>

              <button
                type="button"
                className={`nav-item ${activeTab === 'st_clouds' ? 'active' : ''}`}
                onClick={() => onSelectTab('st_clouds')}
              >
                <span className="nav-item-left">
                  <Grid size={16} />
                  <span>{t('题材与情绪云图', 'Treemap Clouds')}</span>
                </span>
                <span className="nav-badge">{t('热力', 'Map')}</span>
              </button>

              <button
                type="button"
                className={`nav-item ${activeTab === 'st_anomaly' ? 'active' : ''}`}
                onClick={() => onSelectTab('st_anomaly')}
              >
                <span className="nav-item-left">
                  <ShieldAlert size={16} />
                  <span>{t('异动与监管中心', 'Anomaly Center')}</span>
                </span>
                <span className="nav-badge" style={{ background: 'var(--amber-soft)', color: 'var(--amber)' }}>
                  {t('监管', 'Reg')}
                </span>
              </button>

              <button
                type="button"
                className={`nav-item ${activeTab === 'st_themes' ? 'active' : ''}`}
                onClick={() => onSelectTab('st_themes')}
              >
                <span className="nav-item-left">
                  <Compass size={16} />
                  <span>{t('题材·四象限·区间', 'Themes & Range')}</span>
                </span>
                <span className="nav-badge">{t('轮动', 'Map')}</span>
              </button>

              <button
                type="button"
                className={`nav-item ${activeTab === 'st_lhb' ? 'active' : ''}`}
                onClick={() => onSelectTab('st_lhb')}
              >
                <span className="nav-item-left">
                  <Award size={16} />
                  <span>{t('龙虎榜与资金', 'Dragon-Tiger')}</span>
                </span>
              </button>

              {onOpenFullscreenStock && (
                <button
                  type="button"
                  className="nav-item"
                  style={{ border: '1px dashed var(--border-strong)', marginTop: 2 }}
                  onClick={() => onOpenFullscreenStock()}
                >
                  <span className="nav-item-left">
                    <Maximize2 size={15} color="var(--navy)" />
                    <span>{t('个股全屏 K 线台', 'Fullscreen K-Line')}</span>
                  </span>
                  <span className="nav-badge">FULL</span>
                </button>
              )}
            </div>

            <div className="nav-section-label" style={{ marginTop: 12 }}>
              {t('统一复盘与纪律风控', 'Unified Review & Risk')}
            </div>
            <div className="nav-list">
              <button
                type="button"
                className={`nav-item ${activeTab === 'ledger' ? 'active' : ''}`}
                onClick={() => onSelectTab('ledger')}
                title={t('短线情绪、题材趋势与产业逻辑统一沉淀至此', 'Unified review hub for short-term tape, theme trends & industry logic')}
              >
                <span className="nav-item-left">
                  <CalendarClock size={16} />
                  <span>{t('深度复盘与台账', 'Unified Review')}</span>
                </span>
                <span className="nav-badge" style={{ background: 'var(--navy-soft)', color: 'var(--navy)' }}>
                  {t('统一', 'Hub')}
                </span>
              </button>

              <button
                type="button"
                className={`nav-item ${activeTab === 'trades' ? 'active' : ''}`}
                onClick={() => onSelectTab('trades')}
              >
                <span className="nav-item-left">
                  <Wallet size={16} />
                  <span>{t('交易账本与归因', 'Trade Ledger')}</span>
                </span>
              </button>

              {!isShortTermFocused && (
                <button
                  type="button"
                  className={`nav-item ${activeTab === 'backtest' ? 'active' : ''}`}
                  onClick={() => onSelectTab('backtest')}
                >
                  <span className="nav-item-left">
                    <FlaskConical size={16} />
                    <span>{t('策略回测实验室', 'Backtest Lab')}</span>
                  </span>
                  <span className="nav-badge" style={{ background: 'var(--navy-soft)', color: 'var(--navy)' }}>
                    PY
                  </span>
                </button>
              )}

              <button
                type="button"
                className={`nav-item ${activeTab === 'technical' ? 'active' : ''}`}
                onClick={() => onSelectTab('technical')}
              >
                <span className="nav-item-left">
                  <Crosshair size={16} />
                  <span>{t('技术预警与点位', 'Technical Alerts')}</span>
                </span>
                {techAlertCount === null ? (
                  <span className="nav-badge" title={t('预警摘要暂未同步', 'Alert summary pending')}>
                    ?
                  </span>
                ) : techAlertCount > 0 ? (
                  <span
                    className="nav-badge"
                    style={{ background: 'var(--crimson-soft)', color: 'var(--crimson)' }}
                    title={t('未读盯盘提醒 / 技术雷达预警数（进入技术页后同步实盘雷达扫描结果）', 'Unread watch alerts / live radar triggers (syncs on visiting Technical Lab)')}
                  >
                    {techAlertCount}
                  </span>
                ) : null}
              </button>

              {!isShortTermFocused && (
                <button
                  type="button"
                  className={`nav-item ${activeTab === 'watchlist' ? 'active' : ''}`}
                  onClick={() => onSelectTab('watchlist')}
                >
                  <span className="nav-item-left">
                    <Globe size={16} />
                    <span>{CRYPTO_ENABLED ? t('全球股市·期货·加密', 'Global · Fut · BTC') : t('全球股市与期货', 'Global · Futures')}</span>
                  </span>
                  <span className="nav-badge">10+</span>
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="nav-section-label">{t('核心投研工作台', 'Research Workbench')}</div>
            <div className="nav-list">
              <button
                type="button"
                className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
                onClick={() => onSelectTab('dashboard')}
              >
                <span className="nav-item-left">
                  <LayoutDashboard size={16} />
                  <span>{t('研究总览驾驶舱', 'Research Cockpit')}</span>
                </span>
              </button>

              <button
                type="button"
                className={`nav-item ${activeTab === 'watchlist' ? 'active' : ''}`}
                onClick={() => onSelectTab('watchlist')}
              >
                <span className="nav-item-left">
                  <Activity size={16} />
                  <span>{t('全球市场与期货盯盘', 'Global Markets')}</span>
                </span>
                <span className="nav-badge">{t('全球', 'All')}</span>
              </button>

              <button
                type="button"
                className={`nav-item ${activeTab === 'technical' ? 'active' : ''}`}
                onClick={() => onSelectTab('technical')}
              >
                <span className="nav-item-left">
                  <Crosshair size={16} />
                  <span>{t('技术预警与点位', 'Technical Lab')}</span>
                </span>
                {techAlertCount === null ? (
                  <span className="nav-badge" title={t('预警摘要暂未同步', 'Alert summary pending')}>
                    ?
                  </span>
                ) : techAlertCount > 0 ? (
                  <span
                    className="nav-badge"
                    style={{ background: 'var(--crimson-soft)', color: 'var(--crimson)' }}
                    title={t('未读盯盘提醒 / 技术雷达预警数（进入技术页后同步实盘雷达扫描结果）', 'Unread watch alerts / live radar triggers (syncs on visiting Technical Lab)')}
                  >
                    {techAlertCount}
                  </span>
                ) : (
                  <span className="nav-badge">{t('点位', 'S/R')}</span>
                )}
              </button>

              <button
                type="button"
                className={`nav-item ${activeTab === 'trades' ? 'active' : ''}`}
                onClick={() => onSelectTab('trades')}
              >
                <span className="nav-item-left">
                  <Wallet size={16} />
                  <span>{t('交易账本与归因', 'Trade Ledger')}</span>
                </span>
                <span className="nav-badge" style={{ background: 'var(--emerald-soft)', color: 'var(--emerald)' }}>
                  {t('实盘', 'P&L')}
                </span>
              </button>

              {!isWaveFocused && (
                <>
                  <button
                    type="button"
                    className={`nav-item ${activeTab === 'backtest' ? 'active' : ''}`}
                    onClick={() => onSelectTab('backtest')}
                  >
                    <span className="nav-item-left">
                      <FlaskConical size={16} />
                      <span>{t('策略回测实验室', 'Backtest Lab')}</span>
                    </span>
                    <span className="nav-badge" style={{ background: 'var(--navy-soft)', color: 'var(--navy)' }}>
                      {t('量化', 'Quant')}
                    </span>
                  </button>

                  <button
                    type="button"
                    className={`nav-item ${activeTab === 'intel' ? 'active' : ''}`}
                    onClick={() => onSelectTab('intel')}
                  >
                    <span className="nav-item-left">
                      <Radio size={16} />
                      <span>{t('情报信源与进化', 'Intel Hub')}</span>
                    </span>
                    {intelPendingCount === null ? (
                      <span className="nav-badge" title={t('情报待办摘要暂未同步', 'Intel inbox summary pending')}>
                        ?
                      </span>
                    ) : intelPendingCount > 0 ? (
                      <span className="nav-badge" style={{ background: 'var(--crimson-soft)', color: 'var(--crimson)' }}>
                        {intelPendingCount}
                      </span>
                    ) : (
                      <span className="nav-badge">{t('多源', 'Hub')}</span>
                    )}
                  </button>
                </>
              )}

              <button
                type="button"
                className={`nav-item ${activeTab === 'methodology' ? 'active' : ''}`}
                onClick={() => onSelectTab('methodology')}
              >
                <span className="nav-item-left">
                  <BookOpen size={16} />
                  <span>{t('方法论卡片库', 'Methodology')}</span>
                </span>
                <span className="nav-badge">{workspace.methodology.stats.activeCount}</span>
              </button>

              <button
                type="button"
                className={`nav-item ${activeTab === 'cognition' ? 'active' : ''}`}
                onClick={() => onSelectTab('cognition')}
              >
                <span className="nav-item-left">
                  <Lightbulb size={16} />
                  <span>{t('行业前沿认知库', 'Industry Intel')}</span>
                </span>
                <span className="nav-badge">{workspace.cognition.stats.totalCount}</span>
              </button>

              <button
                type="button"
                className={`nav-item ${activeTab === 'ledger' ? 'active' : ''}`}
                onClick={() => onSelectTab('ledger')}
              >
                <span className="nav-item-left">
                  <CalendarClock size={16} />
                  <span>{t('研判与复盘台账', 'Review Ledger')}</span>
                </span>
                <span className="nav-badge">{workspace.ledger.stats.dailyReviewCount}</span>
              </button>
            </div>

            <div className="nav-section-label" style={{ marginTop: 12 }}>
              {t('治理与维护', 'Governance')}
            </div>
            <div className="nav-list">
              <button
                type="button"
                className={`nav-item ${activeTab === 'maintenance' ? 'active' : ''}`}
                onClick={() => onSelectTab('maintenance')}
              >
                <span className="nav-item-left">
                  <ShieldCheck size={16} />
                  <span>{t('质检 · 同步 · 备份', 'Audit & Backup')}</span>
                </span>
                {issueAlertCount > 0 && (
                  <span
                    className="nav-badge"
                    style={{
                      background: audit?.summary.errorCount ? 'var(--crimson-soft)' : 'var(--amber-soft)',
                      color: audit?.summary.errorCount ? 'var(--crimson)' : 'var(--amber)',
                    }}
                  >
                    {issueAlertCount}
                  </span>
                )}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="version-stack">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
              {t('本地三库数据', 'Local 3-Library')}
            </span>
            {onOpenWorkspaceModal && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ padding: '1px 5px', fontSize: 10.5, height: 'auto', gap: 3 }}
                onClick={onOpenWorkspaceModal}
                title={t('切换本地工作空间或管理离线授权', 'Switch workspace or license')}
              >
                <FolderGit2 size={11} />
                <span style={{ maxWidth: 82, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeWorkspaceLabel || t('切换空间', 'Switch')}
                </span>
              </button>
            )}
          </div>
          <div className="version-row">
            <span>{t('方法论卡片库', 'Methodology')}</span>
            <span className="version-pill">{workspace.methodology.meta.version || '-'}</span>
          </div>
          <div className="version-row">
            <span>{t('行业前沿认知库', 'Cognition')}</span>
            <span className="version-pill">{workspace.cognition.meta.version || '-'}</span>
          </div>
          <div className="version-row">
            <span>{t('研判与复盘台账', 'Ledger')}</span>
            <span className="version-pill">{workspace.ledger.meta.version || '-'}</span>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-sm"
          style={{ width: '100%', justifyContent: 'center', padding: collapsed ? '6px 0' : undefined }}
          onClick={onReload}
          disabled={reloading}
          title={t('刷新本地三库数据', 'Refresh local data')}
        >
          <RefreshCw size={13} className={reloading ? 'spin' : ''} />
          <span className="sidebar-footer-label">{reloading ? t('刷新中', 'Loading') : t('刷新本地数据', 'Refresh')}</span>
        </button>
      </div>
    </aside>
  );
};
