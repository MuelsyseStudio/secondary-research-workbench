import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock,
  Database,
  Download,
  FileSpreadsheet,
  FolderArchive,
  History,
  Info,
  Layers,
  Play,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type {
  AuditReport,
  BackupManifest,
  EntityRef,
  KbStaleItem,
  KbStaleReport,
  SchedulerConfig,
  SchedulerStatusResponse,
  WorkspaceData,
} from '../types';

interface MaintenancePageProps {
  workspace: WorkspaceData;
  audit: AuditReport | null;
  onRerunAudit: () => Promise<void>;
  onRequestMutation: (action: string, payload: Record<string, unknown>, onSuccess?: () => void) => void;
  onRestored: (message: string) => void;
  onReload?: () => Promise<void> | void;
  onOpenEntity?: (ref: EntityRef) => void;
  onToast?: (message: string) => void;
}

export const MaintenancePage: React.FC<MaintenancePageProps> = ({
  workspace,
  audit,
  onRerunAudit,
  onRequestMutation,
  onRestored,
  onReload,
  onOpenEntity,
  onToast,
}) => {
  const { t } = useI18n();
  const [backups, setBackups] = useState<BackupManifest[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditLogs, setAuditLogs] = useState<
    { id: string; timestamp: string; category: string; action: string; summary: string; targetIds: string[]; backupId: string | null; actor: string }[]
  >([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditCategory, setAuditCategory] = useState('all');
  const [auditSearch, setAuditSearch] = useState('');
  const [loadingAuditLogs, setLoadingAuditLogs] = useState(false);
  const [exportingCsvScope, setExportingCsvScope] = useState<string | null>(null);

  // P1-3：盘中定时巡检 + 离屏 Webhook 推送调度器状态
  const [schedStatus, setSchedStatus] = useState<SchedulerStatusResponse | null>(null);
  const [schedCfg, setSchedCfg] = useState<SchedulerConfig | null>(null);
  const [savingSched, setSavingSched] = useState(false);
  const [runningSchedTask, setRunningSchedTask] = useState<string | null>(null);

  // KB v2 双模引擎管理（无损升级 / 单文件快照导出 / 时效巡检清单）
  const [confirmMigrateV2, setConfirmMigrateV2] = useState(false);
  const [migratingV2, setMigratingV2] = useState(false);
  const [exportingMonolith, setExportingMonolith] = useState(false);
  const [monolithResult, setMonolithResult] = useState<{
    methodologySnapshot?: { path: string; bytes: number; cardCount: number; conflictCount: number };
    cognitionSnapshot?: { path: string; bytes: number; cardCount: number };
    files?: string[];
    message?: string;
  } | null>(null);
  const [liveStaleReport, setLiveStaleReport] = useState<KbStaleReport | null>(workspace.staleReport || null);
  const [loadingStale, setLoadingStale] = useState(false);
  const [staleFilter, setStaleFilter] = useState<'all' | 'expired' | 'checkDue'>('all');

  useEffect(() => {
    setLiveStaleReport(workspace.staleReport || null);
  }, [workspace.staleReport, workspace.loadedAt]);

  const isKbV2 = workspace.kbMode === 'v2';

  const normalizeCognitionId = (rawId: string) => {
    const m = String(rawId || '').trim().match(/^C[:\-]?(\d+)$/i);
    return m ? m[1].padStart(3, '0') : String(rawId || '').trim();
  };

  const handleConfirmMigrateV2 = async () => {
    setMigratingV2(true);
    try {
      const res = await api.kbMigrateFromV1(false);
      setConfirmMigrateV2(false);
      const msg =
        res.message ||
        t(
          '已无损升级至三库 v2（原现行三库 Markdown 保持严格只读未改动），SQLite FTS5 索引已就绪！',
          'Losslessly upgraded to KB v2 (original v1 Markdown files untouched); SQLite FTS5 index is ready!'
        );
      if (onReload) {
        await onReload();
        onToast?.(msg);
      } else {
        onRestored(msg);
      }
    } catch (err: any) {
      onToast?.(t(`升级三库 v2 失败：${err.message}`, `KB v2 migration failed: ${err.message}`));
    } finally {
      setMigratingV2(false);
    }
  };

  const handleExportMonolith = async () => {
    setExportingMonolith(true);
    try {
      const res = await api.kbExportMonolith();
      setMonolithResult(res);
      onToast?.(
        res.message ||
          t(
            '已逆向编译导出经典单文件兼容快照至 kb/exports/*.compiled.md',
            'Exported classic single-file compatibility snapshots to kb/exports/*.compiled.md'
          )
      );
    } catch (err: any) {
      onToast?.(t(`导出单文件快照失败：${err.message}`, `Snapshot export failed: ${err.message}`));
    } finally {
      setExportingMonolith(false);
    }
  };

  const handleRefreshStale = async () => {
    setLoadingStale(true);
    try {
      const res = await api.kbStale();
      setLiveStaleReport(res);
      onToast?.(
        t(
          `时效巡检已更新：已过期 ${res.expiredCount} 张，到期巡检 ${res.checkDueCount} 张`,
          `Freshness patrol refreshed: ${res.expiredCount} expired, ${res.checkDueCount} check-due`
        )
      );
    } catch (err: any) {
      onToast?.(t(`刷新时效巡检失败：${err.message}`, `Failed to refresh stale report: ${err.message}`));
    } finally {
      setLoadingStale(false);
    }
  };

  const staleRows: { kind: 'expired' | 'checkDue'; item: KbStaleItem }[] = liveStaleReport
    ? [
        ...(staleFilter !== 'checkDue'
          ? (liveStaleReport.expired || []).map((item) => ({ kind: 'expired' as const, item }))
          : []),
        ...(staleFilter !== 'expired'
          ? (liveStaleReport.checkDue || []).map((item) => ({ kind: 'checkDue' as const, item }))
          : []),
      ]
    : [];

  const loadScheduler = async () => {
    try {
      const res = await api.getSchedulerStatus();
      setSchedStatus(res);
      setSchedCfg(res.config);
    } catch {
      // ignore
    }
  };

  const loadBackups = async () => {
    setLoadingBackups(true);
    try {
      const res = await api.listBackups();
      setBackups(res.backups);
    } finally {
      setLoadingBackups(false);
    }
  };

  const loadAuditTrail = async (cat = auditCategory, q = auditSearch) => {
    setLoadingAuditLogs(true);
    try {
      const res = await api.getAuditTrail({ category: cat, q, limit: 200 });
      setAuditLogs(res.items || []);
      setAuditTotal(res.total || 0);
    } catch {
      // non-fatal
    } finally {
      setLoadingAuditLogs(false);
    }
  };

  const handleDownloadCsv = async (url: string, fallbackName: string, scopeKey: string) => {
    setExportingCsvScope(scopeKey);
    try {
      const resp = await fetch(url, { headers: { 'X-SRW-Client': 'workbench' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const disp = resp.headers.get('content-disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const fileName = match?.[1] || fallbackName;
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2500);
      onToast?.(t(`已导出 ${fileName}（UTF-8 BOM 兼容 Excel，页脚已附合规免责声明）`, `Exported ${fileName} (Excel CSV with compliance footer)`));
    } catch (err: any) {
      onToast?.(t(`导出 CSV 失败：${err.message}`, `CSV export failed: ${err.message}`));
    } finally {
      setExportingCsvScope(null);
    }
  };

  useEffect(() => {
    loadBackups();
    loadScheduler();
    loadAuditTrail();
  }, [workspace.loadedAt]);

  const handleSaveScheduler = async () => {
    if (!schedCfg) return;
    setSavingSched(true);
    try {
      const res = await api.saveSchedulerConfig(schedCfg);
      setSchedCfg(res.config);
      onToast?.('已保存定时巡检与 Webhook 多通道推送配置！');
      await loadScheduler();
    } catch (err: any) {
      onToast?.(`保存失败：${err.message}`);
    } finally {
      setSavingSched(false);
    }
  };

  const handleTestWebhook = async (channel: string) => {
    setRunningSchedTask(`test-${channel}`);
    try {
      if (schedCfg) await api.saveSchedulerConfig(schedCfg);
      const res = await api.testWebhook(channel);
      const r = res.results[0];
      if (r?.ok) onToast?.(`通道 [${channel}] 推送测试成功！请检查手机/群聊消息。`);
      else onToast?.(`通道 [${channel}] 推送失败：${r?.error || '请检查 Webhook 地址'}`);
    } catch (err: any) {
      onToast?.(`测试失败：${err.message}`);
    } finally {
      setRunningSchedTask(null);
    }
  };

  const handleRunScanNow = async () => {
    setRunningSchedTask('scan');
    try {
      const res = await api.runSchedulerScanNow();
      onToast?.(`手动巡检完成：命中 ${res.totalAlerts} 条预警（含画线 ${res.drawingAlertCount} 条），新增推送 ${res.freshCount} 条`);
      await loadScheduler();
    } catch (err: any) {
      onToast?.(`巡检失败：${err.message}`);
    } finally {
      setRunningSchedTask(null);
    }
  };

  const handleRunPostMarketNow = async () => {
    setRunningSchedTask('post');
    try {
      const res = await api.runPostMarketCaptureNow();
      onToast?.(`${res.date} 盘后情绪快照与 1m 实盘包 (${res.packetBars}条) 已落盘！`);
      await loadScheduler();
    } catch (err: any) {
      onToast?.(`盘后抓取失败：${err.message}`);
    } finally {
      setRunningSchedTask(null);
    }
  };

  const handleEnableBrowserNotif = async () => {
    if (typeof Notification === 'undefined') {
      onToast?.('当前浏览器不支持桌面系统通知');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      new Notification('二级投研 · 三库工作台', { body: '浏览器桌面预警通知已开启！' });
      onToast?.('浏览器桌面通知已授权开启');
    } else {
      onToast?.('通知权限未授予，可在浏览器地址栏左侧开启');
    }
  };

  const [pendingRestoreId, setPendingRestoreId] = useState<string | null>(null);
  const [exportingDiag, setExportingDiag] = useState(false);
  const [exportingBackupZip, setExportingBackupZip] = useState(false);
  const [importingBackupZip, setImportingBackupZip] = useState(false);
  const [pendingZipRestore, setPendingZipRestore] = useState<{ fileName: string; base64: string } | null>(null);
  const backupZipInputRef = React.useRef<HTMLInputElement | null>(null);

  const handleExportFullBackupZip = async () => {
    setExportingBackupZip(true);
    try {
      const resp = await fetch('/api/backups/export-zip', {
        headers: { 'X-SRW-Client': 'workbench' },
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || `备份导出失败 (${resp.status})`);
      }
      const blob = await resp.blob();
      const disp = resp.headers.get('content-disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const fileName = match?.[1] || `research-workbench-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2500);
      onToast?.(`已导出全量数据备份：${fileName}（含三库 Markdown 与本地研究状态，不含 API Key）`);
    } catch (err: any) {
      onToast?.(`导出全量备份失败：${err.message}`);
    } finally {
      setExportingBackupZip(false);
    }
  };

  const handleSelectBackupZipFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 24 * 1024 * 1024) {
      onToast?.('备份 ZIP 文件超过 24MB 限制');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      setPendingZipRestore({ fileName: file.name, base64 });
    };
    reader.readAsDataURL(file);
  };

  const executeZipRestore = async () => {
    if (!pendingZipRestore) return;
    const { fileName, base64 } = pendingZipRestore;
    setPendingZipRestore(null);
    setImportingBackupZip(true);
    try {
      const res = await api.importBackupZip(base64);
      await loadBackups();
      if (res.auditRecorded === false) {
        onRestored(
          t(
            `已从 ${fileName} 安全还原（原数据已备份为 ${res.preRestoreBackupId}），但审计日志写入失败：${res.auditError || '磁盘受阻'}`,
            `Restored from ${fileName} (backup ${res.preRestoreBackupId}), but audit log write failed: ${res.auditError || 'disk error'}`
          )
        );
      } else {
        onRestored(
          `已从 ${fileName} 安全还原 ${res.restoredMarkdown.length} 份三库与 ${res.restoredState.length} 份状态文件（原数据已备份为 ${res.preRestoreBackupId}）`
        );
      }
    } catch (err: any) {
      onToast?.(`从备份 ZIP 还原失败：${err.message}`);
    } finally {
      setImportingBackupZip(false);
    }
  };

  const handleAudit = async () => {
    setAuditing(true);
    try {
      await onRerunAudit();
    } finally {
      setAuditing(false);
    }
  };

  const handleRestore = (backupId: string) => {
    setPendingRestoreId(backupId);
  };

  const executeRestore = async () => {
    if (!pendingRestoreId) return;
    const backupId = pendingRestoreId;
    setPendingRestoreId(null);
    setRestoringId(backupId);
    try {
      const res = await api.restoreBackup(backupId);
      await loadBackups();
      if (res.auditRecorded === false) {
        onRestored(
          t(
            `已从快照 ${backupId} 安全回滚三库文件，但审计日志写入失败：${res.auditError || '磁盘受阻'}`,
            `Rolled back to snapshot ${backupId}, but audit log write failed: ${res.auditError || 'disk error'}`
          )
        );
      } else {
        onRestored(`已从快照 ${backupId} 安全回滚三库文件`);
      }
    } catch (err: any) {
      onToast?.(`回滚失败：${err.message}`);
    } finally {
      setRestoringId(null);
    }
  };

  const handleDownloadDiagnosticZip = async () => {
    setExportingDiag(true);
    try {
      const resp = await fetch('/api/maintenance/diagnostic-zip', {
        headers: { 'X-SRW-Client': 'workbench' },
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || `导出失败 (${resp.status})`);
      }
      const blob = await resp.blob();
      const disp = resp.headers.get('content-disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const fileName = match?.[1] || `research-workbench-diagnostic-${new Date().toISOString().slice(0, 10)}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2500);
      onToast?.(`已导出脱敏诊断包：${fileName}（已自动排除密钥、三库正文与交割单）`);
    } catch (err: any) {
      onToast?.(`导出诊断包失败：${err.message}`);
    } finally {
      setExportingDiag(false);
    }
  };

  const formatBytes = (n: number) => `${(n / 1024).toFixed(1)} KB`;

  return (
    <div className="scroll-page">
      <div style={{ maxWidth: 1120, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* 头部操作栏 */}
        <div className="panel panel-pad" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ margin: '0 0 3px', fontSize: 17, display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShieldCheck size={19} color="var(--navy)" />
              {t('工作模式五 · 三库全量质检、审计与维护中心', 'Governance · Integrity Audit, Trail & Maintenance Center')}
            </h2>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              {t(
                '遵循质检铁律：默认只读扫描并定位问题，任何修复动作均须经过确认门 Diff 预览并由用户拍板后执行',
                'Read-only integrity scans by default; all writes pass through Diff Confirmation Gate with atomic backups.'
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => window.print()}
              title={t('使用机构级打印样式表导出 PDF 报告', 'Print / Export clean institutional PDF')}
            >
              <Printer size={13} /> {t('打印 / 导出 PDF', 'Print PDF')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={exportingDiag}
              onClick={handleDownloadDiagnosticZip}
              title={t('一键导出脱敏售后诊断包（自动排除 API Key、私钥、三库正文与交割单）', 'Export sanitized diagnostic ZIP')}
            >
              <ShieldCheck size={13} /> {exportingDiag ? t('打包诊断中...', 'Exporting...') : t('导出脱敏诊断包 (.zip)', 'Diagnostic ZIP')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onRequestMutation('maintenance.syncCompanionVersions', {})}
            >
              <Wrench size={13} /> {t('预览同步三库版本互挂', 'Sync Cross-Versions')}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleAudit} disabled={auditing}>
              <RefreshCw size={13} /> {auditing ? t('正在扫描...', 'Scanning...') : t('重新全库质检', 'Run Audit')}
            </button>
          </div>
        </div>

        {/* 三库底层架构（KB v2 双模管理） */}
        <div className="panel">
          <div className="panel-header" style={{ flexWrap: 'wrap', gap: 10 }}>
            <h3 className="panel-title">
              <Database size={16} color={isKbV2 ? 'var(--teal)' : 'var(--navy)'} />
              {t('三库底层架构（KB v2 双模管理）', 'Three Libraries Engine (KB v2 Dual-Mode)')}
              <span
                className={`badge mono ${
                  isKbV2
                    ? workspace.kbSummary?.sqliteAvailable === false
                      ? 'badge-amber'
                      : 'badge-teal'
                    : 'badge-muted'
                }`}
                style={{ fontSize: 11 }}
              >
                {isKbV2
                  ? workspace.kbSummary?.sqliteAvailable === false
                    ? t('v2 · JSON 降级索引', 'v2 · JSON Index')
                    : 'v2 · SQLite FTS5'
                  : t('v1 · 经典单文件', 'v1 · Single-File')}
              </span>
            </h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {isKbV2 ? (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={loadingStale}
                    onClick={handleRefreshStale}
                  >
                    <RefreshCw size={12} className={loadingStale ? 'spin' : ''} />{' '}
                    {loadingStale ? t('巡检中...', 'Checking...') : t('刷新时效巡检', 'Refresh Stale Check')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-teal btn-sm"
                    disabled={exportingMonolith}
                    onClick={handleExportMonolith}
                  >
                    <Download size={13} />{' '}
                    {exportingMonolith
                      ? t('编译导出中...', 'Exporting...')
                      : t('一键导出经典单文件兼容快照', 'Export Classic Monolith Snapshot')}
                  </button>
                </>
              ) : (
                !confirmMigrateV2 && (
                  <button
                    type="button"
                    className="btn btn-teal btn-sm"
                    onClick={() => setConfirmMigrateV2(true)}
                  >
                    <Sparkles size={13} /> {t('无损升级至三库 v2（严格只读原件）', 'Upgrade Losslessly to KB v2 (Read-Only Source)')}
                  </button>
                )
              )}
            </div>
          </div>

          <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {!isKbV2 ? (
              <>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.65 }}>
                  {t(
                    '当前工作空间运行在经典 v1 单文件模式（直接读写现行三库/*.md）。升级至 KB v2 后，将获得单卡单文件 MD + YAML Frontmatter、SQLite FTS5 毫秒级混合图谱检索、1-Hop 冲突/反证自动防幻觉、产业链活视图 (Topics) 以及独立复盘事件日志（review-log.jsonl）。',
                    'Workspace is currently in classic v1 single-file mode. Upgrading to KB v2 unlocks one-file-per-card Markdown + YAML, SQLite FTS5 hybrid graph search, 1-hop conflict/refuter grounding, living topic views, and append-only review-log.jsonl.'
                  )}
                </div>

                {confirmMigrateV2 && (
                  <div
                    className="field-block"
                    style={{
                      marginBottom: 0,
                      background: 'var(--teal-soft)',
                      borderColor: 'var(--teal)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--teal)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Layers size={15} />
                      {t('二次确认：执行无损升级至三库 v2（严格只读原件）', 'Confirm Lossless Upgrade to KB v2 (Strict Read-Only Source)')}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                      {t(
                        '系统将严格只读当前现行三库/*.md（原件零修改、SHA-256 保持不变），在工作空间旁新建 kb/ 分卡目录并自动完成 SQLite FTS5 索引对账与完整性核验。升级后可随时一键逆向导出经典单文件兼容快照。确认继续吗？',
                        'Original v1 Markdown files are strictly read-only (zero modifications). A new kb/ directory and SQLite FTS5 index will be generated alongside them with full verification. Proceed?'
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={migratingV2}
                        onClick={() => setConfirmMigrateV2(false)}
                      >
                        {t('取消', 'Cancel')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-teal btn-sm"
                        disabled={migratingV2}
                        onClick={handleConfirmMigrateV2}
                      >
                        <Sparkles size={13} />{' '}
                        {migratingV2
                          ? t('正在无损迁移并构建 SQLite 索引...', 'Migrating & Indexing...')
                          : t('确认立即无损升级', 'Confirm Upgrade Now')}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                {workspace.kbSummary && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 8 }}>
                    {[
                      { label: t('图谱节点 (Cards)', 'Nodes'), value: workspace.kbSummary.nodeCount, color: 'var(--navy)' },
                      { label: t('有向图谱边 (Edges)', 'Edges'), value: workspace.kbSummary.edgeCount, color: 'var(--teal)' },
                      { label: t('正交标签 (Tags)', 'Tags'), value: workspace.kbSummary.tagCount, color: 'var(--violet)' },
                      { label: t('标的实体锚 (Entities)', 'Entities'), value: workspace.kbSummary.entityCount, color: 'var(--emerald)' },
                      { label: t('复盘实证流水 (Events)', 'Review Events'), value: workspace.kbSummary.reviewEventCount, color: 'var(--amber)' },
                      { label: t('产业链活视图 (Topics)', 'Topics'), value: workspace.kbSummary.topicCount, color: 'var(--navy)' },
                    ].map((stat) => (
                      <div
                        key={stat.label}
                        style={{
                          padding: '9px 11px',
                          borderRadius: 8,
                          background: 'var(--bg-soft)',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{stat.label}</div>
                        <div className="num" style={{ fontSize: 18, fontWeight: 800, color: stat.color }}>
                          {stat.value}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {monolithResult && (
                  <div
                    className="field-block"
                    style={{
                      marginBottom: 0,
                      background: 'var(--emerald-soft)',
                      borderColor: 'var(--emerald)',
                      fontSize: 12.5,
                      color: 'var(--text)',
                    }}
                  >
                    <div style={{ fontWeight: 700, color: 'var(--emerald)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <CheckCircle2 size={14} /> {t('单文件兼容快照已导出成功', 'Monolith Compatibility Snapshots Exported')}
                    </div>
                    {monolithResult.methodologySnapshot && (
                      <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                        • {monolithResult.methodologySnapshot.path} ({monolithResult.methodologySnapshot.cardCount}{' '}
                        {t('方法论卡', 'rules')} / {monolithResult.methodologySnapshot.conflictCount}{' '}
                        {t('冲突', 'conflicts')} · {formatBytes(monolithResult.methodologySnapshot.bytes)})
                      </div>
                    )}
                    {monolithResult.cognitionSnapshot && (
                      <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                        • {monolithResult.cognitionSnapshot.path} ({monolithResult.cognitionSnapshot.cardCount}{' '}
                        {t('认知卡', 'intel cards')} · {formatBytes(monolithResult.cognitionSnapshot.bytes)})
                      </div>
                    )}
                  </div>
                )}

                {/* 完整时效巡检报告（过期 + 到期复核认知卡） */}
                {liveStaleReport && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                        <CalendarClock size={15} color="var(--amber)" />
                        <strong style={{ fontSize: 13.5 }}>
                          {t('认知卡时效巡检全量清单', 'Full Cognition Freshness & Stale Report')}
                        </strong>
                        <span className="badge badge-muted mono" style={{ fontSize: 10.5 }}>
                          {t(`基准日 ${liveStaleReport.asOfDate} · 活跃 ${liveStaleReport.activeTotal} 张`, `As of ${liveStaleReport.asOfDate} · ${liveStaleReport.activeTotal} active`)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        {(
                          [
                            ['all', `${t('全部', 'All')} (${liveStaleReport.expiredCount + liveStaleReport.checkDueCount})`],
                            ['expired', `${t('已过期', 'Expired')} (${liveStaleReport.expiredCount})`],
                            ['checkDue', `${t('到期巡检', 'Check Due')} (${liveStaleReport.checkDueCount})`],
                          ] as const
                        ).map(([k, label]) => (
                          <button
                            key={k}
                            type="button"
                            className={`btn btn-sm ${
                              staleFilter === k ? (k === 'expired' ? 'btn-danger' : k === 'checkDue' ? 'btn-amber' : 'btn-primary') : ''
                            }`}
                            style={{ padding: '2px 8px', fontSize: 11.5 }}
                            onClick={() => setStaleFilter(k)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {staleRows.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: 'var(--emerald)', display: 'flex', alignItems: 'center', gap: 6, padding: '8px 2px' }}>
                        <CheckCircle2 size={14} />{' '}
                        {t('当前筛选下无已过期或到期巡检认知卡。', 'No expired or check-due cognition cards in this view.')}
                      </div>
                    ) : (
                      <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th style={{ width: 82 }}>{t('状态', 'Status')}</th>
                              <th style={{ width: 78 }}>{t('卡号', 'ID')}</th>
                              <th style={{ width: 54 }}>{t('证据', 'Grade')}</th>
                              <th style={{ width: 120 }}>{t('类型', 'Type')}</th>
                              <th style={{ width: 102 }}>{t('有效至', 'Valid Until')}</th>
                              <th style={{ width: 102 }}>{t('下次复核', 'Next Check')}</th>
                              <th>{t('标题摘要', 'Title')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {staleRows.map(({ kind, item }) => {
                              const cid = normalizeCognitionId(item.id);
                              const grade = item.primaryGrade || item.primary_grade || '-';
                              const subKind = item.subKind || item.sub_kind || '-';
                              const validUntil = item.validUntil || item.valid_until || '-';
                              const nextCheck = item.nextCheckDate || item.next_check_date || '-';
                              return (
                                <tr
                                  key={`${kind}-${item.id}`}
                                  style={{ cursor: onOpenEntity ? 'pointer' : 'default' }}
                                  onClick={() => onOpenEntity?.({ kind: 'cognition', id: cid })}
                                >
                                  <td>
                                    <span className={`badge ${kind === 'expired' ? 'badge-crimson' : 'badge-amber'}`} style={{ fontSize: 10.5 }}>
                                      {kind === 'expired' ? t('已过期', 'Expired') : t('到期巡检', 'Check Due')}
                                    </span>
                                  </td>
                                  <td className="mono" style={{ fontWeight: 700, color: 'var(--teal)' }}>
                                    {item.id}
                                  </td>
                                  <td>
                                    <span className="badge badge-muted">{grade}</span>
                                  </td>
                                  <td className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                    {subKind}
                                  </td>
                                  <td
                                    className="mono"
                                    style={{
                                      fontSize: 11.5,
                                      color: kind === 'expired' ? 'var(--crimson)' : 'var(--text-muted)',
                                      fontWeight: kind === 'expired' ? 700 : 400,
                                    }}
                                  >
                                    {validUntil}
                                  </td>
                                  <td
                                    className="mono"
                                    style={{
                                      fontSize: 11.5,
                                      color: kind === 'checkDue' ? 'var(--amber)' : 'var(--text-muted)',
                                      fontWeight: kind === 'checkDue' ? 700 : 400,
                                    }}
                                  >
                                    {nextCheck}
                                  </td>
                                  <td style={{ fontSize: 12.5, color: 'var(--text)' }}>{item.title}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* 机构级三库与交割单 Excel/CSV 一键汇总导出 */}
        <div className="panel panel-pad" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 7 }}>
              <FileSpreadsheet size={16} color="var(--emerald)" />
              {t('机构级标准数据汇总导出（Excel/CSV · 自动附合规免责页脚）', 'Institutional Summary Exports (Excel/CSV with Disclaimer Footer)')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('支持按三库全量、方法论卡片、行业认知卡、复盘研判台账或交易交割单分别导出 UTF-8 BOM CSV', 'Export unified or per-module UTF-8 BOM CSV reports compatible with Microsoft Excel')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(
              [
                ['all', t('全量汇总 CSV', 'All Summary CSV')],
                ['methodology', t('方法论库', 'Methodology')],
                ['cognition', t('认知库', 'Cognition')],
                ['ledger', t('复盘台账', 'Ledger')],
                ['trades', t('交易交割单', 'Trades')],
              ] as const
            ).map(([scope, label]) => (
              <button
                key={scope}
                type="button"
                className={`btn btn-sm ${scope === 'all' ? 'btn-teal' : ''}`}
                disabled={exportingCsvScope === scope}
                onClick={() =>
                  handleDownloadCsv(
                    `/api/maintenance/export-summary-csv?scope=${scope}`,
                    `srw-${scope}.csv`,
                    scope
                  )
                }
              >
                <Download size={12} /> {exportingCsvScope === scope ? t('导出中...', 'Exporting...') : label}
              </button>
            ))}
          </div>
        </div>

        {/* 质检结果摘要与明细 */}
        {audit && (
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                实时质检报告（{new Date(audit.summary.checkedAt).toLocaleString()}）
              </div>
              <div style={{ display: 'flex', gap: 7 }}>
                <span className={`badge ${audit.summary.errorCount ? 'badge-crimson' : 'badge-emerald'}`}>
                  错误 {audit.summary.errorCount}
                </span>
                <span className={`badge ${audit.summary.warningCount ? 'badge-amber' : 'badge-muted'}`}>
                  告警 {audit.summary.warningCount}
                </span>
                <span className="badge badge-navy">提示 {audit.summary.infoCount}</span>
              </div>
            </div>

            <div className="panel-pad">
              {/* 通过的检查项 */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                {audit.summary.passedChecks.map((pc, i) => (
                  <span key={i} className="badge badge-emerald" style={{ padding: '4px 9px', fontSize: 12 }}>
                    <CheckCircle2 size={13} /> {pc}
                  </span>
                ))}
              </div>

              {audit.issues.length === 0 ? (
                <div style={{ padding: 18, textAlign: 'center', color: 'var(--emerald)', fontWeight: 600 }}>
                  所有编号、契约字段、跨库引用、目录与三处可信度检查全部通过！
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {audit.issues.map((issue) => (
                    <div
                      key={issue.id}
                      className="field-block"
                      style={{
                        marginBottom: 0,
                        borderLeft: `4px solid ${
                          issue.severity === 'error'
                            ? 'var(--crimson)'
                            : issue.severity === 'warning'
                            ? 'var(--amber)'
                            : 'var(--navy)'
                        }`,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                          {issue.severity === 'error' ? (
                            <AlertCircle size={15} color="var(--crimson)" />
                          ) : issue.severity === 'warning' ? (
                            <AlertTriangle size={15} color="var(--amber)" />
                          ) : (
                            <Info size={15} color="var(--navy)" />
                          )}
                          <span className="badge badge-muted mono">{issue.id}</span>
                          <span className="badge badge-muted">{issue.category}</span>
                          <span style={{ fontWeight: 700, fontSize: 13.5 }}>{issue.title}</span>
                        </div>
                        {issue.fixAction === 'sync_companion_versions' && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => onRequestMutation('maintenance.syncCompanionVersions', {})}
                          >
                            预览修复 Diff
                          </button>
                        )}
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                        <strong>定位（{issue.target}）：</strong>
                        {issue.detail}
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                        <strong>建议处理：</strong>
                        {issue.suggestion}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 三库文件技术元数据指纹 */}
        <div className="panel">
          <div className="panel-header">
            <h3 className="panel-title">现行三库单一真实源指纹（Markdown 源文件）</h3>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>核心库</th>
                  <th>当前版本</th>
                  <th>同步日期</th>
                  <th>体积 / 行数</th>
                  <th>SHA-256 指纹</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: '方法论卡片库.md', data: workspace.methodology },
                  { name: '行业前沿认知库.md', data: workspace.cognition },
                  { name: '研判与复盘台账.md', data: workspace.ledger },
                ].map((item) => (
                  <tr key={item.name}>
                    <td style={{ fontWeight: 700 }}>{item.name}</td>
                    <td><span className="badge badge-navy mono">{item.data.meta.version}</span></td>
                    <td className="mono">{item.data.meta.syncDate || '-'}</td>
                    <td className="num">{formatBytes(item.data.fileSize)} · {item.data.lineCount} 行</td>
                    <td className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      {item.data.sha256.slice(0, 24)}...
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* P1-3：盘中定时巡检 + 离屏多通道告警推送（飞书/企微/钉钉/Bark）+ 盘后自动快照 */}
        {schedCfg && (
          <div className="panel">
            <div className="panel-header" style={{ flexWrap: 'wrap' }}>
              <h3 className="panel-title">
                <Bell size={16} color="var(--amber)" />
                盘中定时预警巡检 · 多通道 Webhook 推送 · 盘后自动快照调度器
              </h3>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-sm" onClick={handleEnableBrowserNotif}>
                  开启桌面弹窗通知
                </button>
                <button type="button" className="btn btn-sm" disabled={runningSchedTask === 'scan'} onClick={handleRunScanNow}>
                  <Play size={12} /> {runningSchedTask === 'scan' ? '扫描中...' : '立即跑一次预警巡检'}
                </button>
                <button type="button" className="btn btn-amber btn-sm" disabled={runningSchedTask === 'post'} onClick={handleRunPostMarketNow}>
                  <Clock size={12} /> {runningSchedTask === 'post' ? '抓数中...' : '立即跑盘后快照落盘'}
                </button>
                <button type="button" className="btn btn-primary btn-sm" disabled={savingSched} onClick={handleSaveScheduler}>
                  {savingSched ? '保存中...' : '保存调度与推送配置'}
                </button>
              </div>
            </div>

            <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={schedCfg.enabled}
                    onChange={(e) => setSchedCfg({ ...schedCfg, enabled: e.target.checked })}
                  />
                  启用后台无人值守调度器
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={schedCfg.intradayScanEnabled}
                    onChange={(e) => setSchedCfg({ ...schedCfg, intradayScanEnabled: e.target.checked })}
                  />
                  交易时段自动扫描预警（每
                  <input
                    type="number"
                    min={5}
                    max={60}
                    className="input mono"
                    style={{ width: 58, padding: '2px 6px' }}
                    value={schedCfg.intradayIntervalMin}
                    onChange={(e) => setSchedCfg({ ...schedCfg, intradayIntervalMin: Number(e.target.value) || 15 })}
                  />
                  分钟）
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={schedCfg.postMarketSnapshotEnabled}
                    onChange={(e) => setSchedCfg({ ...schedCfg, postMarketSnapshotEnabled: e.target.checked })}
                  />
                  盘后自动落盘情绪链+1m实盘包（含休眠补跑，15:12）
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={schedCfg.onlyHighSeverityPush}
                    onChange={(e) => setSchedCfg({ ...schedCfg, onlyHighSeverityPush: e.target.checked })}
                  />
                  仅推送高危(High)信号
                </label>
              </div>

              {/* 多通道 Webhook 配置表 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 8 }}>
                {(
                  [
                    { key: 'feishu', label: '飞书机器人 Webhook', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...' },
                    { key: 'wecom', label: '企业微信机器人 Webhook', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' },
                    { key: 'dingtalk', label: '钉钉机器人 Webhook', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
                    { key: 'bark', label: 'Bark (iOS 手机推送地址)', placeholder: 'https://api.day.app/你的Key' },
                    { key: 'custom', label: '自定义 JSON Webhook', placeholder: 'https://your-endpoint.example.com/hook' },
                  ] as const
                ).map((ch) => {
                  const item = schedCfg.webhooks[ch.key];
                  return (
                    <div
                      key={ch.key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                        padding: '7px 10px',
                        borderRadius: 8,
                        background: 'var(--bg-soft)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={item.enabled}
                        onChange={(e) =>
                          setSchedCfg({
                            ...schedCfg,
                            webhooks: { ...schedCfg.webhooks, [ch.key]: { ...item, enabled: e.target.checked } },
                          })
                        }
                      />
                      <span style={{ width: 132, fontSize: 12, fontWeight: 600, flexShrink: 0 }}>{ch.label}</span>
                      <input
                        className="input mono"
                        style={{ flex: 1, fontSize: 11.5, padding: '4px 8px' }}
                        placeholder={ch.placeholder}
                        value={item.url}
                        onChange={(e) =>
                          setSchedCfg({
                            ...schedCfg,
                            webhooks: { ...schedCfg.webhooks, [ch.key]: { ...item, url: e.target.value } },
                          })
                        }
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: '3px 8px', fontSize: 11 }}
                        disabled={!item.url.trim() || runningSchedTask === `test-${ch.key}`}
                        onClick={() => handleTestWebhook(ch.key)}
                      >
                        <Send size={11} /> 测试
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* 最近巡检与推送日志 */}
              {schedStatus && schedStatus.logs.length > 0 && (
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>
                    最近调度执行与推送日志（最多保留 50 条）
                  </div>
                  <div style={{ maxHeight: 150, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {schedStatus.logs.slice(0, 12).map((l) => (
                      <div key={l.id} className="mono" style={{ fontSize: 11.5, display: 'flex', gap: 8, color: 'var(--text-secondary)' }}>
                        <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{l.time.slice(0, 19).replace('T', ' ')}</span>
                        <span className={`badge ${l.status === 'ok' ? 'badge-emerald' : 'badge-crimson'}`} style={{ fontSize: 10, padding: '0 4px' }}>
                          {l.type}
                        </span>
                        <span>{l.summary}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 机构级结构化操作审计日志时间线（audit-trail.local.jsonl） */}
        <div className="panel">
          <div className="panel-header" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h3 className="panel-title">
              <History size={16} color="var(--navy)" />
              {t(`操作审计日志时间线（audit-trail.local.jsonl · 共 ${auditTotal} 条）`, `Audit Trail Log (${auditTotal} entries)`)}
            </h3>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                className="select"
                style={{ fontSize: 12, padding: '4px 8px' }}
                value={auditCategory}
                onChange={(e) => {
                  setAuditCategory(e.target.value);
                  loadAuditTrail(e.target.value, auditSearch);
                }}
              >
                <option value="all">{t('全部分类', 'All Categories')}</option>
                <option value="library_mutation">{t('三库写盘', 'Library Writes')}</option>
                <option value="rule_change">{t('规则/红线变更', 'Rule Changes')}</option>
                <option value="trade_import">{t('交易/交割变更', 'Trade Ledger')}</option>
                <option value="backup_restore">{t('备份/还原', 'Backup/Restore')}</option>
                <option value="workspace_switch">{t('工作空间切换', 'Workspace')}</option>
                <option value="license_change">{t('授权变更', 'Licensing')}</option>
              </select>
              <div style={{ position: 'relative' }}>
                <Search size={12} color="var(--text-muted)" style={{ position: 'absolute', left: 8, top: 8 }} />
                <input
                  className="input"
                  style={{ paddingLeft: 24, fontSize: 12, width: 170, height: 28 }}
                  placeholder={t('筛选动作/摘要/ID...', 'Filter action or ID...')}
                  value={auditSearch}
                  onChange={(e) => setAuditSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') loadAuditTrail(auditCategory, auditSearch);
                  }}
                />
              </div>
              <button type="button" className="btn btn-sm" onClick={() => loadAuditTrail(auditCategory, auditSearch)} disabled={loadingAuditLogs}>
                <RefreshCw size={12} className={loadingAuditLogs ? 'spin' : ''} /> {t('查询', 'Filter')}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={exportingCsvScope === 'audit_csv'}
                onClick={() =>
                  handleDownloadCsv(
                    `/api/maintenance/audit-trail/csv?category=${encodeURIComponent(auditCategory)}&q=${encodeURIComponent(auditSearch)}`,
                    'audit-trail.csv',
                    'audit_csv'
                  )
                }
              >
                <Download size={12} /> {t('导出审计 CSV', 'Export Audit CSV')}
              </button>
            </div>
          </div>
          <div className="panel-pad">
            {auditLogs.length === 0 ? (
              <div style={{ padding: '16px 10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                {t('暂无匹配的操作审计记录。后续每次写库、规则变更、交割导入与备份回滚均会自动追加记录至此。', 'No audit entries yet. Library mutations, rule changes, trade imports and restores are automatically logged here.')}
              </div>
            ) : (
              <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 150 }}>{t('时间', 'Time')}</th>
                      <th style={{ width: 110 }}>{t('分类', 'Category')}</th>
                      <th style={{ width: 165 }}>{t('动作', 'Action')}</th>
                      <th>{t('变更摘要与涉及对象', 'Summary & Targets')}</th>
                      <th style={{ width: 120 }}>{t('关联快照', 'Snapshot')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.slice(0, 80).map((row) => (
                      <tr key={row.id}>
                        <td className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          {row.timestamp.slice(0, 19).replace('T', ' ')}
                        </td>
                        <td>
                          <span className="badge badge-navy" style={{ fontSize: 10.5 }}>
                            {row.category}
                          </span>
                        </td>
                        <td className="mono" style={{ fontSize: 11.5 }}>
                          {row.action}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          <div>{row.summary}</div>
                          {row.targetIds && row.targetIds.length > 0 && (
                            <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                              {row.targetIds.join(', ')}
                            </div>
                          )}
                        </td>
                        <td className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {row.backupId || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* 安全备份快照与一键回滚 */}
        <div className="panel">
          <div className="panel-header" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h3 className="panel-title">
              <FolderArchive size={16} color="var(--teal)" />
              全量备份迁移 & 原子写盘自动备份快照
            </h3>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                ref={backupZipInputRef}
                type="file"
                accept=".zip,application/zip"
                style={{ display: 'none' }}
                onChange={handleSelectBackupZipFile}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={exportingBackupZip}
                onClick={handleExportFullBackupZip}
                title="一键导出当前空间全部三库 Markdown 与研究状态数据 ZIP（自动排除 API Key）"
              >
                <FolderArchive size={13} /> {exportingBackupZip ? '打包备份中...' : '一键导出全量备份 ZIP'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={importingBackupZip}
                onClick={() => backupZipInputRef.current?.click()}
                title="从全量备份 ZIP 安全还原（还原前自动对当前三库存留快照）"
              >
                <RotateCcw size={13} /> {importingBackupZip ? '还原中...' : '从备份 ZIP 安全还原'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={loadBackups} disabled={loadingBackups}>
                <RefreshCw size={13} /> 刷新列表
              </button>
            </div>
          </div>
          <div className="panel-pad">
            {backups.length === 0 ? (
              <div style={{ padding: '22px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                尚无写盘历史快照。当你通过工作台确认门执行首次写库时，系统将自动在此保存修改前的完整三库原件快照。
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {backups.map((b) => (
                  <div
                    key={b.backupId}
                    className="field-block"
                    style={{ marginBottom: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}
                  >
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                        <span className="badge badge-teal mono">{b.backupId}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {new Date(b.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text)' }}>
                        {b.summary.join('；')}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                        涉及文件：{b.files.map((f) => `${f.label} (${f.versionBefore}→${f.versionAfter})`).join('、')}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={restoringId === b.backupId}
                      onClick={() => handleRestore(b.backupId)}
                    >
                      <RotateCcw size={13} />
                      {restoringId === b.backupId ? '回滚中...' : '恢复此快照'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {pendingZipRestore && (
        <div className="modal-backdrop" onClick={() => setPendingZipRestore(null)}>
          <div className="modal-box" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong style={{ fontSize: 14.5 }}>确认从备份 ZIP 安全还原</strong>
            </div>
            <div className="modal-body" style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--text-secondary)' }}>
              即将从 <strong className="mono">{pendingZipRestore.fileName}</strong> 还原当前空间的三库 Markdown 与研究状态文件。
              系统会在覆盖前自动保存一份当前三库的只读快照，随时可一键回滚。确认继续吗？
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-sm" onClick={() => setPendingZipRestore(null)}>
                取消
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={executeZipRestore}>
                <RotateCcw size={13} /> 确认安全还原
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingRestoreId && (
        <div className="modal-backdrop" onClick={() => setPendingRestoreId(null)}>
          <div className="modal-box" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong style={{ fontSize: 14.5 }}>确认恢复历史快照</strong>
            </div>
            <div className="modal-body" style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
              确认从快照 <strong className="mono">{pendingRestoreId}</strong> 恢复对应三库文件吗？回滚前系统仍会自动备份当前版本，确保可逆。
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-sm" onClick={() => setPendingRestoreId(null)}>
                取消
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={executeRestore}>
                <RotateCcw size={13} /> 确认回滚
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
