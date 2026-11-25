import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  FolderInput,
  FolderPlus,
  Globe,
  Inbox,
  Layers,
  Lightbulb,
  Link2,
  Loader2,
  MessageSquareText,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Rss,
  Save,
  Search,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';
import type {
  AiProvider,
  AiSafeConfig,
  BackgroundJobSummary,
  IntelBatchRecord,
  IntelCandidateItem,
  IntelHubConfig,
  IntelHubOverviewResponse,
  IntelRawItem,
  IntelRoute,
  IntelZsxqGroupConfig,
  VaultScanResponse,
} from '../types';
import { AiProviderPicker } from '../components/AiProviderPicker';

interface IntelHubPageProps {
  aiConfig: AiSafeConfig | null;
  recentIntelJob: BackgroundJobSummary | null;
  onJobStarted: (job: BackgroundJobSummary) => void;
  onJobFinished: () => void;
  onOpenAiSettings: () => void;
  onRequestMutation: (action: string, payload: Record<string, unknown>, onSuccess?: () => void) => void;
  onPendingCountChange?: (count: number) => void;
  onToast: (msg: string, level?: 'success' | 'error' | 'warning' | 'info') => void;
}

const ROUTE_LABELS: Record<IntelRoute, string> = {
  cognition: '行业认知库',
  methodology: '方法论库',
  both: '双轨（认知+方法论）',
  sentiment: '日度情绪参考',
};

const CHANNEL_LABELS: Record<string, string> = {
  zsxq: '知识星球',
  wechat: '微信公众号',
  local_folder: '本地日报/研报',
  public_feed: '7×24公开电报',
  rss: '自定义RSS',
  manual_url: '单篇快采',
};

export const IntelHubPage: React.FC<IntelHubPageProps> = ({
  aiConfig,
  recentIntelJob,
  onJobStarted,
  onJobFinished,
  onOpenAiSettings,
  onRequestMutation,
  onPendingCountChange,
  onToast,
}) => {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<'inbox' | 'sources' | 'vault' | 'schedule'>('inbox');
  const [overview, setOverview] = useState<IntelHubOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Inbox controls + Multi-select Batch Diff Commit
  const [selectedBatchId, setSelectedBatchId] = useState<string>('');
  const [selectedCids, setSelectedCids] = useState<string[]>([]);
  const [candFilter, setCandFilter] = useState<'all' | 'pending' | 'cognition' | 'methodology'>('all');
  const [rawChannelFilter, setRawChannelFilter] = useState<string>('all');
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [showRawItems, setShowRawItems] = useState(false);

  // Local Vault Batch Importer state
  const [vaultDirPath, setVaultDirPath] = useState('');
  const [vaultMode, setVaultMode] = useState<'auto' | 'cognition' | 'methodology' | 'both'>('auto');
  const [scanningVault, setScanningVault] = useState(false);
  const [vaultScan, setVaultScan] = useState<VaultScanResponse | null>(null);
  const [selectedVaultFiles, setSelectedVaultFiles] = useState<string[]>([]);

  // Run pipeline controls
  const [provider, setProvider] = useState<AiProvider>(aiConfig?.provider || 'codex_cli');
  const [lookbackDays, setLookbackDays] = useState<number>(1);
  const [syncWechatFirst, setSyncWechatFirst] = useState(false);
  const [ignoreWatermarks, setIgnoreWatermarks] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStage, setJobStage] = useState<string>('');

  // Source discovery / interactive state
  const [probingZsxq, setProbingZsxq] = useState(false);
  const [zsxqProbeMsg, setZsxqProbeMsg] = useState<string>('');
  const [allProbedZsxq, setAllProbedZsxq] = useState<IntelZsxqGroupConfig[] | null>(null);

  const [wechatDirInput, setWechatDirInput] = useState('');
  const [syncingWechat, setSyncingWechat] = useState(false);
  const [launchingWechatUi, setLaunchingWechatUi] = useState(false);

  // Add Local Folder form
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderPath, setNewFolderPath] = useState('');
  const [newFolderKeyword, setNewFolderKeyword] = useState('');
  const [newFolderRoute, setNewFolderRoute] = useState<IntelRoute>('cognition');

  // Add Custom RSS form
  const [newRssName, setNewRssName] = useState('');
  const [newRssUrl, setNewRssUrl] = useState('');
  const [newRssRoute, setNewRssRoute] = useState<IntelRoute>('cognition');

  // Single URL Quick Fetch
  const [quickUrl, setQuickUrl] = useState('');
  const [quickUrlRoute, setQuickUrlRoute] = useState<IntelRoute>('cognition');
  const [fetchingUrl, setFetchingUrl] = useState(false);

  useEffect(() => {
    if (aiConfig?.provider) setProvider(aiConfig.provider);
  }, [aiConfig?.provider]);

  const loadOverview = useCallback(async () => {
    try {
      const data = await api.getIntelOverview();
      setOverview(data);
      setWechatDirInput(data.config.wechat.toolDir || '');
      onPendingCountChange?.(data.pendingCandidatesCount || 0);
      if (data.batches.length > 0) {
        setSelectedBatchId((prev) => (prev && data.batches.some((b) => b.id === prev) ? prev : data.batches[0].id));
      }
    } catch (err: any) {
      onToast(`加载情报中心失败：${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [onPendingCountChange, onToast]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  // 监听后台情报任务进度（切页不中断）
  const runningJob =
    recentIntelJob && recentIntelJob.status === 'running'
      ? recentIntelJob
      : activeJobId && recentIntelJob?.id === activeJobId && recentIntelJob.status === 'running'
      ? recentIntelJob
      : null;

  useEffect(() => {
    const jid = activeJobId || (recentIntelJob?.status === 'running' ? recentIntelJob.id : null);
    if (!jid) return;
    const timer = setInterval(async () => {
      try {
        const res = await api.getJob(jid);
        const j = res.job;
        setJobStage(j.stage || '');
        if (j.status === 'completed') {
          clearInterval(timer);
          setActiveJobId(null);
          setJobStage('');
          onJobFinished();
          await loadOverview();
          const b: IntelBatchRecord | undefined = j.result?.batch;
          if (b) {
            setSelectedBatchId(b.id);
            onToast(
              `情报采集完成：共拉取 ${b.stats.totalFetched} 条，产出 ${b.stats.candidateCount} 条待审阅候选！`
            );
          }
        } else if (j.status === 'failed' || j.status === 'cancelled') {
          clearInterval(timer);
          setActiveJobId(null);
          setJobStage('');
          onJobFinished();
          onToast(
            j.status === 'cancelled'
              ? '情报采集任务已取消'
              : `情报采集任务失败：${j.error || '未知错误'}`
          );
        }
      } catch {
        // retry next tick
      }
    }, 1800);
    return () => clearInterval(timer);
  }, [activeJobId, recentIntelJob, loadOverview, onJobFinished, onToast]);

  const persistConfig = async (patch: Partial<IntelHubConfig>, toastMsg?: string) => {
    setSaving(true);
    try {
      const res = await api.saveIntelConfig(patch);
      setOverview((prev) => (prev ? { ...prev, config: res.config, wechatBridge: res.wechatBridge } : prev));
      if (toastMsg) onToast(toastMsg);
    } catch (err: any) {
      onToast(`保存配置失败：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleStartPipeline = async (runAi: boolean, extraItems?: IntelRawItem[]) => {
    try {
      const res = await api.startIntelRunJob({
        runAi,
        lookbackDays,
        syncWechatFirst: extraItems ? false : syncWechatFirst,
        ignoreWatermarks: extraItems ? true : ignoreWatermarks,
        channels: extraItems ? [] : undefined,
        extraItems,
        provider,
        pushSummary: false,
      });
      setActiveJobId(res.job.id);
      setJobStage(res.job.stage || '已启动后台采集与提纯任务...');
      onJobStarted(res.job);
      setSubTab('inbox');
      onToast(runAi ? '已启动后台多信源采集 + AI 双轨提纯，切换页面不中断' : '已启动后台多信源原文拉取...');
    } catch (err: any) {
      onToast(`启动采集任务失败：${err.message}`);
    }
  };

  const handleProbeZsxq = async () => {
    setProbingZsxq(true);
    setZsxqProbeMsg('');
    try {
      const res = await api.probeZsxqGroups(true);
      setAllProbedZsxq(res.groups || []);
      setOverview((prev) => (prev ? { ...prev, config: res.config } : prev));
      if (!res.installed || !res.authenticated) {
        setZsxqProbeMsg(res.message || '未检测到已登录的 zsxq-cli');
      } else {
        setZsxqProbeMsg(
          `探测完成：当前账号共加入 ${res.totalCount} 个星球，其中 ${res.readableCount} 个已开通 Skill 读取权限（已自动勾选活跃星球，可自由调整路由）。`
        );
        onToast(`已发现 ${res.readableCount} 个可直连知识星球`);
      }
    } catch (err: any) {
      setZsxqProbeMsg(`探测失败：${err.message}`);
    } finally {
      setProbingZsxq(false);
    }
  };

  const handleToggleZsxqGroup = (group: IntelZsxqGroupConfig, patch: Partial<IntelZsxqGroupConfig>) => {
    if (!overview) return;
    const curGroups = [...overview.config.zsxq.groups];
    const idx = curGroups.findIndex((g) => g.groupId === group.groupId);
    const updated = { ...group, ...patch };
    if (idx >= 0) curGroups[idx] = updated;
    else curGroups.push(updated);

    if (allProbedZsxq) {
      setAllProbedZsxq(allProbedZsxq.map((g) => (g.groupId === group.groupId ? updated : g)));
    }
    persistConfig({ zsxq: { ...overview.config.zsxq, groups: curGroups } });
  };

  const handleWechatAccountUpdate = (bookId: string, patch: { enabled?: boolean; route?: IntelRoute }) => {
    if (!overview) return;
    const acc = overview.wechatBridge.accounts.find((a) => a.id === bookId);
    const cur = overview.config.wechat.accountRoutes[bookId] || {
      enabled: acc?.enabled ?? true,
      route: acc?.route ?? 'sentiment',
    };
    const nextRoutes = {
      ...overview.config.wechat.accountRoutes,
      [bookId]: { ...cur, ...patch },
    };
    persistConfig({ wechat: { ...overview.config.wechat, accountRoutes: nextRoutes } });
  };

  const handleWechatSyncNow = async (bookId = '') => {
    setSyncingWechat(true);
    try {
      const res = await api.syncWechatSubscriptions(bookId);
      setOverview((prev) => (prev ? { ...prev, wechatBridge: res.bridgeStatus } : prev));
      const sum = res.summary;
      if (sum?.stoppedEarly) {
        onToast(`公众号增量同步已按合规策略暂停：${sum.stopReason || '触发频控冷却'}`);
      } else {
        onToast(
          `公众号增量追更完成（检查 ${sum?.accountsChecked ?? '-'} 号，新增 ${sum?.totalNewArticles ?? 0} 篇）`
        );
      }
    } catch (err: any) {
      onToast(`同步失败：${err.message}`);
    } finally {
      setSyncingWechat(false);
    }
  };

  const handleLaunchWechatUi = async () => {
    setLaunchingWechatUi(true);
    try {
      const res = await api.launchWechatWebUi();
      setOverview((prev) =>
        prev ? { ...prev, wechatBridge: { ...prev.wechatBridge, webUiRunning: true, webUiUrl: res.webUiUrl } } : prev
      );
      window.open(res.webUiUrl, '_blank', 'noopener,noreferrer');
      onToast(`已打开公众号扫码与搜号工作台 (${res.webUiUrl})`, 'success');
    } catch (err: any) {
      onToast(err.message || '打开公众号工作台失败', 'error');
    } finally {
      setLaunchingWechatUi(false);
    }
  };

  const handleAddLocalFolder = () => {
    if (!overview) return;
    if (!newFolderPath.trim()) {
      onToast('请填写本地研报或日报文件夹路径');
      return;
    }
    const entry = {
      id: `local-${Date.now().toString(36)}`,
      name: newFolderName.trim() || newFolderPath.trim().split(/[\\/]/).pop() || '本地目录',
      dirPath: newFolderPath.trim(),
      route: newFolderRoute,
      extensions: ['.md', '.txt', '.html', '.pdf', '.docx'],
      nameIncludes: newFolderKeyword.trim(),
      maxAgeDays: 3,
      enabled: true,
    };
    persistConfig({ localFolders: [...overview.config.localFolders, entry] }, `已挂载本地监听目录「${entry.name}」`);
    setNewFolderName('');
    setNewFolderPath('');
    setNewFolderKeyword('');
  };

  const handleAddRss = (preset?: { id: string; name: string; url: string; route: IntelRoute }) => {
    if (!overview) return;
    const url = (preset?.url || newRssUrl).trim();
    const name = (preset?.name || newRssName || url).trim();
    const route = preset?.route || newRssRoute;
    if (!/^https?:\/\//i.test(url)) {
      onToast('请输入以 http:// 或 https:// 开头的有效 RSS/Atom 地址');
      return;
    }
    if (overview.config.rssFeeds.some((r) => r.url === url)) {
      onToast('该 RSS 订阅源已在列表中');
      return;
    }
    const next = [
      ...overview.config.rssFeeds,
      { id: preset?.id || `rss-${Date.now().toString(36)}`, name, url, route, enabled: true },
    ];
    persistConfig({ rssFeeds: next }, `已订阅 RSS「${name}」`);
    if (!preset) {
      setNewRssName('');
      setNewRssUrl('');
    }
  };

  const handleQuickUrlIngest = async () => {
    if (!quickUrl.trim()) {
      onToast('请粘贴文章链接');
      return;
    }
    setFetchingUrl(true);
    try {
      const res = await api.fetchSingleIntelUrl(quickUrl.trim(), quickUrlRoute);
      setQuickUrl('');
      await handleStartPipeline(true, [res.item]);
    } catch (err: any) {
      onToast(err.message || '解析链接失败', 'error');
    } finally {
      setFetchingUrl(false);
    }
  };

  const handleCommitCandidate = (batch: IntelBatchRecord, cand: IntelCandidateItem) => {
    onRequestMutation(cand.action, cand.payload, async () => {
      try {
        await api.updateIntelCandidateStatus(batch.id, cand.cid, 'committed');
        setSelectedCids((prev) => prev.filter((id) => id !== cand.cid));
        await loadOverview();
      } catch {
        // non-fatal
      }
    });
  };

  const handleBatchCommitSelected = (batch: IntelBatchRecord) => {
    const picked = (batch.candidates || []).filter(
      (c) => c.status === 'pending' && selectedCids.includes(c.cid)
    );
    if (picked.length === 0) {
      onToast('请先勾选至少 1 条待审阅的候选卡片');
      return;
    }
    const operations = picked.map((c) => ({ action: c.action, payload: c.payload }));
    onRequestMutation('batch.commitOperations', { operations }, async () => {
      for (const c of picked) {
        await api.updateIntelCandidateStatus(batch.id, c.cid, 'committed').catch(() => {});
      }
      setSelectedCids([]);
      await loadOverview();
    });
  };

  const handleScanVault = async () => {
    if (!vaultDirPath.trim()) {
      onToast('请填写要导入的本地知识库文件夹路径（如 Obsidian 库或研报目录）');
      return;
    }
    setScanningVault(true);
    try {
      const res = await api.scanLocalVault(vaultDirPath.trim(), 300);
      setVaultScan(res);
      setSelectedVaultFiles(res.files.slice(0, 30).map((f) => f.relPath));
      onToast(`扫描完成：共发现 ${res.totalFiles} 份支持文档（默认已勾选最新 ${Math.min(30, res.totalFiles)} 份）`);
    } catch (err: any) {
      onToast(`扫描失败：${err.message}`);
    } finally {
      setScanningVault(false);
    }
  };

  const handleStartVaultImport = async () => {
    if (!vaultScan || selectedVaultFiles.length === 0) {
      onToast('请先扫描并勾选至少 1 份文档');
      return;
    }
    try {
      const res = await api.startVaultImportJob({
        dirPath: vaultScan.rootDir,
        selectedRelPaths: selectedVaultFiles,
        mode: vaultMode,
        provider,
      });
      setActiveJobId(res.job.id);
      setJobStage('已启动存量本地知识库分批 AI 提纯任务...');
      onJobStarted(res.job);
      setSubTab('inbox');
      onToast(`已启动存量库批量导入（${selectedVaultFiles.length} 份文档），提纯后统一汇入候选收件箱支持一键合并 Diff 落库！`);
    } catch (err: any) {
      onToast(`启动批量导入失败：${err.message}`);
    }
  };

  const handleDismissCandidate = async (batch: IntelBatchRecord, cand: IntelCandidateItem) => {
    try {
      await api.updateIntelCandidateStatus(batch.id, cand.cid, cand.status === 'dismissed' ? 'pending' : 'dismissed');
      await loadOverview();
    } catch (err: any) {
      onToast(err.message || '更新候选状态失败', 'error');
    }
  };

  if (loading || !overview) {
    return (
      <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-muted)' }}>
        {t('正在加载情报信源与定时进化中心...', 'Loading Intel Hub & Auto-Evolution...')}
      </div>
    );
  }

  const cfg = overview.config;
  const activeBatch = overview.batches.find((b) => b.id === selectedBatchId) || overview.batches[0] || null;
  const displayedZsxqGroups = allProbedZsxq || cfg.zsxq.groups;

  const filteredCandidates = (activeBatch?.candidates || []).filter((c) => {
    if (candFilter === 'pending') return c.status === 'pending';
    if (candFilter === 'cognition') return c.targetLibrary === 'cognition';
    if (candFilter === 'methodology') return c.targetLibrary === 'methodology';
    return true;
  });

  const filteredRawItems = (activeBatch?.rawItems || []).filter(
    (it) => rawChannelFilter === 'all' || it.channel === rawChannelFilter
  );

  const enabledSourceCount =
    (cfg.zsxq.enabled ? cfg.zsxq.groups.filter((g) => g.enabled).length : 0) +
    (cfg.wechat.enabled && overview.wechatBridge.connected
      ? overview.wechatBridge.accounts.filter((a) => a.enabled).length
      : 0) +
    cfg.localFolders.filter((f) => f.enabled).length +
    cfg.publicFeeds.filter((f) => f.enabled).length +
    cfg.rssFeeds.filter((r) => r.enabled).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%' }}>
      {/* Sub-navigation + Quick Status Bar */}
      <div
        className="panel panel-pad"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn btn-sm ${subTab === 'inbox' ? 'btn-primary' : ''}`}
            onClick={() => setSubTab('inbox')}
          >
            <Inbox size={14} />
            <span>{t('候选收件箱与每日情报', 'Candidate Inbox & Daily Feeds')}</span>
            {overview.pendingCandidatesCount > 0 && (
              <span className="badge badge-crimson" style={{ padding: '0 6px', fontSize: 10.5 }}>
                {overview.pendingCandidatesCount} {t('待审', 'Pending')}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${subTab === 'sources' ? 'btn-primary' : ''}`}
            onClick={() => setSubTab('sources')}
          >
            <Radio size={14} />
            <span>{t('信源接入与三轨路由', 'Sources & 3-Track Routing')}</span>
            <span className="badge badge-navy" style={{ padding: '0 6px', fontSize: 10.5 }}>
              {t(`已启 ${enabledSourceCount} 源`, `${enabledSourceCount} Active`)}
            </span>
          </button>
          <button
            type="button"
            className={`btn btn-sm ${subTab === 'vault' ? 'btn-primary' : ''}`}
            onClick={() => setSubTab('vault')}
          >
            <FolderInput size={14} />
            <span>{t('存量知识库一键导入', 'Local Vault Batch Import')}</span>
            <span className="badge badge-emerald" style={{ padding: '0 6px', fontSize: 10.5 }}>
              {t('批量迁移', 'Migrate')}
            </span>
          </button>
          <button
            type="button"
            className={`btn btn-sm ${subTab === 'schedule' ? 'btn-primary' : ''}`}
            onClick={() => setSubTab('schedule')}
          >
            <Clock size={14} />
            <span>{t('每日定时进化 & 单篇快采', 'Scheduled Digest & URL Fetch')}</span>
            <span
              className={`badge ${cfg.schedule.enabled ? 'badge-emerald' : 'badge-muted'}`}
              style={{ padding: '0 6px', fontSize: 10.5 }}
            >
              {cfg.schedule.enabled
                ? `每日 ${String(cfg.schedule.dailyHour).padStart(2, '0')}:${String(cfg.schedule.dailyMinute).padStart(2, '0')}`
                : '未开启定时'}
            </span>
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
          <span>已去重水印 {overview.watermarkCount} 条</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={loadOverview} title="刷新情报中心状态">
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* Running Job Live Progress Banner */}
      {(runningJob || activeJobId) && (
        <div
          className="panel panel-pad"
          style={{
            background: 'var(--navy-soft)',
            borderColor: 'var(--navy)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Loader2 size={16} className="spin" color="var(--navy)" />
          <div style={{ fontSize: 13 }}>
            <strong>后台情报引擎运行中：</strong>
            <span>{jobStage || runningJob?.stage || '正在并发采集并提纯情报...'}</span>
            <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>（可自由切换其他页面，完成后自动通知）</span>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* SUB-TAB 1: 候选收件箱与每日情报                                       */}
      {/* =================================================================== */}
      {subTab === 'inbox' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Pipeline Trigger Bar */}
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>回看窗口</span>
                  <select
                    className="input"
                    style={{ width: 110, height: 32, padding: '2px 8px', fontSize: 12 }}
                    value={lookbackDays}
                    onChange={(e) => setLookbackDays(Number(e.target.value))}
                  >
                    <option value={1}>今日（1天）</option>
                    <option value={2}>近 2 天</option>
                    <option value={3}>近 3 天</option>
                    <option value={7}>近 7 天</option>
                  </select>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={ignoreWatermarks}
                    onChange={(e) => setIgnoreWatermarks(e.target.checked)}
                  />
                  <span>重扫已读水印</span>
                </label>

                {overview.wechatBridge.connected && (
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}
                    title="勾选后先调用微信文章清洗工具增量追更再入池；如近期刚批量拉取触发冷却请先不勾选"
                  >
                    <input
                      type="checkbox"
                      checked={syncWechatFirst}
                      onChange={(e) => setSyncWechatFirst(e.target.checked)}
                    />
                    <span>顺带触发公众号增量追更</span>
                  </label>
                )}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <AiProviderPicker
                  value={provider}
                  config={aiConfig}
                  onChange={setProvider}
                  onOpenSettings={onOpenAiSettings}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={Boolean(runningJob || activeJobId)}
                  onClick={() => handleStartPipeline(false)}
                  title="仅拉取各信源最新原文与情绪词频，不消耗 AI Token"
                >
                  <RefreshCw size={13} />
                  <span>仅拉取原文</span>
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={Boolean(runningJob || activeJobId)}
                  onClick={() => handleStartPipeline(true)}
                >
                  <Sparkles size={14} />
                  <span>一键采集 + AI 双轨提纯</span>
                </button>
              </div>
            </div>

            {/* Batch Selector */}
            {overview.batches.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>历史采集批次：</span>
                {overview.batches.slice(0, 8).map((b) => {
                  const pCount = (b.candidates || []).filter((c) => c.status === 'pending').length;
                  const active = activeBatch?.id === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                      style={{ fontSize: 11.5, padding: '3px 9px', height: 'auto' }}
                      onClick={() => setSelectedBatchId(b.id)}
                    >
                      <span>{b.createdAt.slice(5, 16).replace('T', ' ')}</span>
                      <span style={{ opacity: 0.85 }}>
                        ({b.stats.totalFetched}条{b.runAi ? ` / ${pCount}待审` : '·原文'})
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {!activeBatch ? (
            <div className="panel panel-pad" style={{ textAlign: 'center', padding: '44px 24px' }}>
              <Radio size={32} color="var(--navy)" style={{ marginBottom: 10, opacity: 0.85 }} />
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
                欢迎使用「情报信源与定时进化中心」
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 640, margin: '0 auto 16px' }}>
                已默认开启免配置免费公开源（华尔街见闻 7×24、东方财富要闻/公告、Semiconductor Engineering RSS）。
                点击上方「一键采集 + AI 双轨提纯」立即体验，或前往「信源接入与三轨路由」一键探测你自己的知识星球、挂载微信公众号清洗工具或本地研报文件夹！
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
                <button type="button" className="btn btn-primary" onClick={() => handleStartPipeline(true)}>
                  <Sparkles size={14} /> 立即采集并 AI 提纯
                </button>
                <button type="button" className="btn" onClick={() => setSubTab('sources')}>
                  <Radio size={14} /> 配置我的专属信源
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Batch KPI Strip */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 10 }}>
                <div className="panel panel-pad">
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>本批采集 / 新增</div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                    {activeBatch.stats.totalFetched}
                    <span style={{ fontSize: 12, color: 'var(--emerald)', marginLeft: 5 }}>
                      +{activeBatch.stats.freshCount}
                    </span>
                  </div>
                </div>
                <div className="panel panel-pad">
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>知识星球 / 本地日报</div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                    {activeBatch.stats.byChannel?.zsxq || 0} / {activeBatch.stats.byChannel?.local_folder || 0}
                  </div>
                </div>
                <div className="panel panel-pad">
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>微信公众号文章</div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                    {activeBatch.stats.byChannel?.wechat || 0}
                  </div>
                </div>
                <div className="panel panel-pad">
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>公开电报 / RSS</div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                    {(activeBatch.stats.byChannel?.public_feed || 0) + (activeBatch.stats.byChannel?.rss || 0)}
                  </div>
                </div>
                <div className="panel panel-pad">
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>行业认知候选</div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: 'var(--navy)' }}>
                    {activeBatch.stats.cognitionCandidateCount}
                  </div>
                </div>
                <div className="panel panel-pad">
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>方法论候选 / 弃废</div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                    <span style={{ color: 'var(--emerald)' }}>{activeBatch.stats.methodologyCandidateCount}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 6 }}>
                      / 滤 {activeBatch.stats.discardedCount}
                    </span>
                  </div>
                </div>
              </div>

              {/* Warnings / Channel Errors */}
              {activeBatch.errors.length > 0 && (
                <div
                  className="panel panel-pad"
                  style={{ background: 'var(--amber-soft)', borderColor: 'var(--amber)', fontSize: 12.5 }}
                >
                  <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <AlertTriangle size={14} color="var(--amber)" />
                    <span>本次采集通道提示（{activeBatch.errors.length} 条）</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {activeBatch.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Sentiment & Theme Wind Vane (Track 3 — for Daily Review, never pollutes Methodology) */}
              {activeBatch.sentimentDigest && (
                <div className="panel panel-pad">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 13.5 }}>
                      <MessageSquareText size={16} color="var(--navy)" />
                      <span>三轨分流 · 今日情绪与主线风向参考（不污染方法论库，可直接带入每日复盘）</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        const sd = activeBatch.sentimentDigest!;
                        const txt = [
                          `【信源情绪与主线风向 ${activeBatch.date}】`,
                          `高频共识主题：${sd.hotThemes.map((t) => `${t.kw}(${t.hits})`).join('、') || '暂无'}`,
                          ...sd.sourceHighlights.map((h) => `- ${h.sourceName}（${h.latestDate}）：《${h.latestTitle}》 ${h.excerpt}`),
                        ].join('\n');
                        navigator.clipboard?.writeText(txt).then(() => onToast('已复制信源情绪摘要，可直接粘贴到日度复盘'));
                      }}
                    >
                      <Copy size={12} /> 复制给每日复盘
                    </button>
                  </div>
                  {activeBatch.sentimentDigest.hotThemes.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      {activeBatch.sentimentDigest.hotThemes.map((t) => (
                        <span key={t.kw} className="badge badge-navy">
                          {t.kw} ×{t.hits}
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
                    {activeBatch.sentimentDigest.sourceHighlights.map((h) => (
                      <div
                        key={h.sourceName}
                        style={{
                          padding: '9px 11px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--bg-subtle)',
                          fontSize: 12,
                          overflow: 'hidden',
                          overflowWrap: 'anywhere',
                          wordBreak: 'break-word',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                          <strong style={{ minWidth: 0, lineHeight: 1.35 }}>{h.sourceName}</strong>
                          <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap' }}>
                            {h.count} 篇/条
                          </span>
                        </div>
                        <div style={{ fontWeight: 600, marginBottom: 4, lineHeight: 1.4 }}>{h.latestTitle}</div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 11.5, lineHeight: 1.45 }}>
                          {h.excerpt}{h.excerpt ? '...' : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* AI Summaries + Candidate Cards Inbox */}
              <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Sparkles size={16} color="var(--navy)" />
                    <span style={{ fontWeight: 700, fontSize: 14 }}>
                      AI 提纯候选收件箱（确认后走 Diff 确认门 + 原子快照备份写入现行三库）
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {activeBatch.candidates.some((c) => c.status === 'pending') && (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            const pendingIds = filteredCandidates
                              .filter((c) => c.status === 'pending')
                              .map((c) => c.cid);
                            const allSelected = pendingIds.length > 0 && pendingIds.every((id) => selectedCids.includes(id));
                            setSelectedCids(allSelected ? [] : pendingIds);
                          }}
                        >
                          {selectedCids.length > 0 ? `取消已选 (${selectedCids.length})` : '全选待审'}
                        </button>
                        {selectedCids.length > 0 && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => handleBatchCommitSelected(activeBatch)}
                          >
                            <Layers size={13} />
                            <span>一键合并 Diff 入库 ({selectedCids.length} 项)</span>
                          </button>
                        )}
                      </>
                    )}
                    {(
                      [
                        ['all', `全部 (${activeBatch.candidates.length})`],
                        ['pending', `仅待审 (${activeBatch.candidates.filter((c) => c.status === 'pending').length})`],
                        ['cognition', `行业认知 (${activeBatch.stats.cognitionCandidateCount})`],
                        ['methodology', `方法论 (${activeBatch.stats.methodologyCandidateCount})`],
                      ] as const
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        className={`btn btn-sm ${candFilter === k ? 'btn-primary' : ''}`}
                        onClick={() => setCandFilter(k)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {(activeBatch.aiSummaries.cognition || activeBatch.aiSummaries.methodology) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12.5 }}>
                    {activeBatch.aiSummaries.cognition && (
                      <div style={{ padding: '9px 12px', borderRadius: 8, background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                        <div style={{ fontWeight: 700, color: 'var(--navy)', marginBottom: 3 }}>
                          <Lightbulb size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                          行业前沿认知库 · AI 提纯总结
                        </div>
                        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>{activeBatch.aiSummaries.cognition}</div>
                      </div>
                    )}
                    {activeBatch.aiSummaries.methodology && (
                      <div style={{ padding: '9px 12px', borderRadius: 8, background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                        <div style={{ fontWeight: 700, color: 'var(--emerald)', marginBottom: 3 }}>
                          <BookOpen size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                          方法论卡片库 · AI 提纯总结
                        </div>
                        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>{activeBatch.aiSummaries.methodology}</div>
                      </div>
                    )}
                  </div>
                )}

                {filteredCandidates.length === 0 ? (
                  <div style={{ padding: '20px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    {activeBatch.runAi
                      ? '本筛选条件下暂无候选卡片（说明本批情报均已被去重过滤，或已处理完毕）。'
                      : '当前批次为「仅拉取原文」模式，未消耗 AI Token。可点击上方「一键采集 + AI 双轨提纯」生成结构化候选卡片！'}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {filteredCandidates.map((cand) => {
                      const isCog = cand.targetLibrary === 'cognition';
                      const isCommitted = cand.status === 'committed';
                      const isDismissed = cand.status === 'dismissed';
                      return (
                        <div
                          key={cand.cid}
                          style={{
                            padding: '12px 14px',
                            borderRadius: 10,
                            border: isCommitted
                              ? '1.5px solid var(--emerald)'
                              : '1px solid var(--border)',
                            background: isDismissed ? 'var(--bg-subtle)' : 'var(--bg-card)',
                            opacity: isDismissed ? 0.6 : 1,
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                              {!isCommitted && !isDismissed && (
                                <input
                                  type="checkbox"
                                  style={{ marginTop: 4 }}
                                  checked={selectedCids.includes(cand.cid)}
                                  onChange={(e) => {
                                    setSelectedCids((prev) =>
                                      e.target.checked
                                        ? [...new Set([...prev, cand.cid])]
                                        : prev.filter((id) => id !== cand.cid)
                                    );
                                  }}
                                />
                              )}
                              <div>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
                                <span className={`badge ${isCog ? 'badge-navy' : 'badge-emerald'}`}>
                                  {isCog ? '行业前沿认知库' : '方法论卡片库'}
                                </span>
                                <span className="badge badge-muted">
                                  {cand.kind === 'new_card'
                                    ? '新建卡片'
                                    : cand.kind === 'amendment'
                                    ? '既有卡增订'
                                    : '冲突矩阵候选'}
                                </span>
                                {isCommitted && <span className="badge badge-emerald">已通过 Diff 入库</span>}
                                {isDismissed && <span className="badge badge-muted">已忽略</span>}
                                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{cand.subtitle}</span>
                              </div>
                              <div style={{ fontWeight: 700, fontSize: 14 }}>{cand.title}</div>
                              </div>
                            </div>

                            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                              {!isCommitted && (
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  onClick={() => handleCommitCandidate(activeBatch, cand)}
                                >
                                  <CheckCircle2 size={13} />
                                  <span>预览 Diff 并入库</span>
                                </button>
                              )}
                              {!isCommitted && (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => handleDismissCandidate(activeBatch, cand)}
                                >
                                  <XCircle size={13} />
                                  <span>{isDismissed ? '恢复' : '忽略'}</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Structured Payload Preview */}
                          <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {cand.kind === 'new_card' && isCog && (
                              <>
                                <div><strong>客观事实：</strong>{cand.payload.facts}</div>
                                <div><strong>产业含义：</strong>{cand.payload.industryImplications}</div>
                                <div><strong>A 股映射：</strong>{cand.payload.aShareMapping}</div>
                                <div style={{ color: 'var(--crimson)' }}><strong>失效/更新条件：</strong>{cand.payload.invalidationConditions}</div>
                                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>来源：{cand.payload.source}</div>
                              </>
                            )}
                            {cand.kind === 'new_card' && !isCog && (
                              <>
                                <div><strong>核心论断：</strong>{cand.payload.coreThesis}</div>
                                {cand.payload.logicChain && <div><strong>逻辑链条：</strong>{cand.payload.logicChain}</div>}
                                <div><strong>适用条件：</strong>{cand.payload.applicableConditions}</div>
                                <div style={{ color: 'var(--crimson)' }}><strong>失效信号：</strong>{cand.payload.invalidationSignals}</div>
                                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>来源：{cand.payload.source}</div>
                              </>
                            )}
                            {cand.kind === 'amendment' && (
                              <div><strong>增量内容（追加至卡 {cand.payload.cardId}，不覆盖原文）：</strong>{cand.payload.content}</div>
                            )}
                            {cand.kind === 'conflict' && (
                              <>
                                <div><strong>冲突点：</strong>{cand.payload.conflictPoint}</div>
                                <div><strong>折中与硬判别变量：</strong>{cand.payload.resolution}</div>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Collapsible Discarded Noise List */}
                {activeBatch.discarded.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setShowDiscarded((v) => !v)}
                    >
                      <span>{showDiscarded ? '收起' : '展开'} AI 自动拦截的重复/噪音条目（{activeBatch.discarded.length} 条）</span>
                    </button>
                    {showDiscarded && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                        {activeBatch.discarded.map((d, i) => (
                          <div key={i}>
                            [{d.targetLibrary === 'cognition' ? '认知' : '方法论'}] <strong>{d.item}</strong> — {d.reason}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Raw Fetched Items Stream */}
              <div className="panel panel-pad">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setShowRawItems((v) => !v)}
                    style={{ fontWeight: 700 }}
                  >
                    <span>{showRawItems ? '收起' : '查看'}本批次采集到的原始情报流（{activeBatch.rawItems.length} 条）</span>
                  </button>
                  {showRawItems && (
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {['all', 'zsxq', 'wechat', 'local_folder', 'public_feed', 'rss', 'manual_url'].map((ch) => (
                        <button
                          key={ch}
                          type="button"
                          className={`btn btn-sm ${rawChannelFilter === ch ? 'btn-primary' : ''}`}
                          style={{ fontSize: 11 }}
                          onClick={() => setRawChannelFilter(ch)}
                        >
                          {ch === 'all' ? '全部通道' : CHANNEL_LABELS[ch] || ch}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {showRawItems && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 460, overflowY: 'auto' }}>
                    {filteredRawItems.map((it) => (
                      <div
                        key={it.itemKey}
                        style={{
                          padding: '9px 11px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--bg-subtle)',
                          fontSize: 12,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span className="badge badge-navy">{it.sourceName}</span>
                            <span className="badge badge-muted">路由 → {ROUTE_LABELS[it.route]}</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{it.publishedAt || it.date}</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{it.wordCount} 字</span>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {it.url && (
                              <a
                                href={it.url}
                                target="_blank"
                                rel="noreferrer"
                                className="btn btn-ghost btn-sm"
                                style={{ fontSize: 11, padding: '2px 6px' }}
                              >
                                <ExternalLink size={11} /> 原文
                              </a>
                            )}
                            <button
                              type="button"
                              className="btn btn-sm"
                              style={{ fontSize: 11, padding: '2px 7px' }}
                              disabled={Boolean(runningJob || activeJobId)}
                              onClick={() => handleStartPipeline(true, [it])}
                            >
                              <Sparkles size={11} /> 单条提纯
                            </button>
                          </div>
                        </div>
                        <div style={{ fontWeight: 700, marginTop: 4 }}>{it.title}</div>
                        <div style={{ color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.45 }}>
                          {it.excerpt || it.content.slice(0, 220)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* SUB-TAB 2: 信源接入与三轨路由（支持你自己 + 任何朋友自助接入）        */}
      {/* =================================================================== */}
      {subTab === 'sources' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {/* 1. 知识星球（动态探测当前账号星球） */}
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 14 }}>
                <Globe size={16} color="var(--navy)" />
                <span>通道 1 · 知识星球（本机 zsxq-cli 动态对接）</span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cfg.zsxq.enabled}
                  onChange={(e) => persistConfig({ zsxq: { ...cfg.zsxq, enabled: e.target.checked } })}
                />
                <span>启用</span>
              </label>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              自动探测本机已登录的 <code>zsxq-cli</code> 账号下全部星球并测试 Skill 权限（每位用户只连接自己的星球，绝不打包外泄）。
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={probingZsxq}
                onClick={handleProbeZsxq}
              >
                {probingZsxq ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
                <span>{probingZsxq ? '正在逐个探测星球 Skill 权限...' : '自动探测我的知识星球与权限'}</span>
              </button>
            </div>
            {zsxqProbeMsg && (
              <div style={{ fontSize: 12, padding: '7px 10px', borderRadius: 6, background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
                {zsxqProbeMsg}
              </div>
            )}
            {displayedZsxqGroups.length === 0 ? (
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-subtle)', fontSize: 12, color: 'var(--text-muted)' }}>
                尚未探测或配置星球。请先点击上方「自动探测」按钮；如电脑尚未安装 CLI，可运行：
                <div className="mono" style={{ marginTop: 4, fontSize: 11.5 }}>
                  npm i -g zsxq-cli &amp;&amp; zsxq-cli auth login
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                {displayedZsxqGroups.map((g) => {
                  const locked = g.readable === false;
                  return (
                    <div
                      key={g.groupId}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        padding: '7px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        opacity: locked ? 0.58 : 1,
                      }}
                    >
                      <label style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, cursor: locked ? 'not-allowed' : 'pointer' }}>
                        <input
                          type="checkbox"
                          disabled={locked}
                          checked={Boolean(g.enabled) && !locked}
                          onChange={(e) => handleToggleZsxqGroup(g, { enabled: e.target.checked })}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 12.5, display: 'flex', gap: 5, alignItems: 'center' }}>
                            <span>{g.name}</span>
                            {g.readable === true && <span className="badge badge-emerald" style={{ fontSize: 10 }}>已通接口</span>}
                            {locked && <span className="badge badge-muted" style={{ fontSize: 10 }}>未开Skill权限</span>}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            ID: {g.groupId}
                            {g.memberCount ? ` · ${g.memberCount}人` : ''}
                            {g.latestDate ? ` · 最新 ${g.latestDate}` : ''}
                          </div>
                        </div>
                      </label>
                      {!locked && (
                        <select
                          className="input"
                          style={{ width: 132, height: 28, padding: '2px 6px', fontSize: 11.5 }}
                          value={g.route}
                          onChange={(e) => handleToggleZsxqGroup(g, { route: e.target.value as IntelRoute })}
                        >
                          <option value="cognition">→ 行业认知库</option>
                          <option value="methodology">→ 方法论库</option>
                          <option value="both">→ 双轨提纯</option>
                          <option value="sentiment">→ 日度情绪参考</option>
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 2. 微信公众号订阅中心（双向桥接「微信文章清洗工具」） */}
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 14 }}>
                <MessageSquareText size={16} color="var(--emerald)" />
                <span>通道 2 · 微信公众号（双向桥接清洗工具）</span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cfg.wechat.enabled}
                  onChange={(e) => persistConfig({ wechat: { ...cfg.wechat, enabled: e.target.checked } })}
                />
                <span>启用</span>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input mono"
                style={{ flex: 1, fontSize: 11.5 }}
                placeholder="填写本机「微信文章清洗工具」文件夹路径"
                value={wechatDirInput}
                onChange={(e) => setWechatDirInput(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={saving}
                onClick={() =>
                  persistConfig({ wechat: { ...cfg.wechat, toolDir: wechatDirInput.trim(), enabled: Boolean(wechatDirInput.trim()) } }, '已更新微信公众号工具目录并重新探测')
                }
              >
                <Save size={12} /> 绑定
              </button>
            </div>

            {overview.wechatBridge.connected ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 12 }}>
                  <span style={{ color: 'var(--emerald)', fontWeight: 600 }}>
                    已桥接（累计归档 {overview.wechatBridge.totalArchived} 篇，最新 {overview.wechatBridge.latestArchivedDate || '-'}）
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={syncingWechat}
                      onClick={() => handleWechatSyncNow('')}
                    >
                      {syncingWechat ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                      <span>安全增量追更</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={launchingWechatUi}
                      onClick={handleLaunchWechatUi}
                    >
                      <ExternalLink size={12} />
                      <span>{overview.wechatBridge.webUiRunning ? '打开 4546 搜号/扫码' : '启动 4546 搜号/扫码'}</span>
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
                  {overview.wechatBridge.accounts.map((acc) => (
                    <div
                      key={acc.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        padding: '7px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                      }}
                    >
                      <label style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={acc.enabled}
                          onChange={(e) => handleWechatAccountUpdate(acc.id, { enabled: e.target.checked })}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 12.5, display: 'flex', gap: 5, alignItems: 'center' }}>
                            <span>{acc.name}</span>
                            <span className="badge badge-muted" style={{ fontSize: 10 }}>{acc.totalSynced} 篇</span>
                            {acc.lastStatus === 'rate_limited' && (
                              <span className="badge badge-amber" style={{ fontSize: 10 }} title={acc.lastError}>
                                频控冷却
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 220,
                            }}
                            title={acc.lastArticleTitle}
                          >
                            {acc.lastArticleDate || '待同步'} · {acc.lastArticleTitle || '尚未拉取'}
                          </div>
                        </div>
                      </label>
                      <select
                        className="input"
                        style={{ width: 132, height: 28, padding: '2px 6px', fontSize: 11.5 }}
                        value={acc.route}
                        onChange={(e) => handleWechatAccountUpdate(acc.id, { route: e.target.value as IntelRoute })}
                      >
                        <option value="sentiment">→ 日度情绪参考</option>
                        <option value="cognition">→ 行业认知库</option>
                        <option value="methodology">→ 方法论库</option>
                        <option value="both">→ 双轨提纯</option>
                      </select>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg-subtle)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                {overview.wechatBridge.message}
                <div style={{ marginTop: 6 }}>
                  开源地址：<code>github.com/MuelsyseStudio/wechat-article-workbench</code>（下载解压后将目录路径贴入上方即可无缝联动，也可在「单篇快采」中直接粘贴公开公众号链接）。
                </div>
              </div>
            )}
          </div>

          {/* 3. 本地研报 / 日报文件夹监听 */}
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 14 }}>
              <FolderPlus size={16} color="var(--navy)" />
              <span>通道 3 · 本地研报 / 日报目录监听（Obsidian / PDF / MD）</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              挂载任意本地文件夹（例如你的 <code>信息搜集/reports</code> 每日总结报告，或朋友的券商 PDF 研报库），自动增量解析入池。
            </div>

            {cfg.localFolders.map((f, idx) => (
              <div
                key={f.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                }}
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={f.enabled}
                    onChange={(e) => {
                      const next = [...cfg.localFolders];
                      next[idx] = { ...f, enabled: e.target.checked };
                      persistConfig({ localFolders: next });
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 12.5 }}>{f.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                      {f.dirPath}
                      {f.nameIncludes ? ` (含"${f.nameIncludes}")` : ''}
                    </div>
                  </div>
                </label>
                <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  <select
                    className="input"
                    style={{ width: 120, height: 28, padding: '2px 6px', fontSize: 11.5 }}
                    value={f.route}
                    onChange={(e) => {
                      const next = [...cfg.localFolders];
                      next[idx] = { ...f, route: e.target.value as IntelRoute };
                      persistConfig({ localFolders: next });
                    }}
                  >
                    <option value="cognition">→ 行业认知库</option>
                    <option value="methodology">→ 方法论库</option>
                    <option value="both">→ 双轨提纯</option>
                    <option value="sentiment">→ 日度情绪</option>
                  </select>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => persistConfig({ localFolders: cfg.localFolders.filter((x) => x.id !== f.id) }, '已移除目录监听')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <input
                className="input"
                style={{ fontSize: 12 }}
                placeholder="显示名称（如：券商深度PDF库）"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
              />
              <input
                className="input"
                style={{ fontSize: 12 }}
                placeholder="文件名过滤词（可选，留空扫全部）"
                value={newFolderKeyword}
                onChange={(e) => setNewFolderKeyword(e.target.value)}
              />
              <input
                className="input mono"
                style={{ fontSize: 11.5 }}
                placeholder="本地绝对路径（如 D:\研报归档）"
                value={newFolderPath}
                onChange={(e) => setNewFolderPath(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  className="input"
                  style={{ flex: 1, fontSize: 12 }}
                  value={newFolderRoute}
                  onChange={(e) => setNewFolderRoute(e.target.value as IntelRoute)}
                >
                  <option value="cognition">→ 行业认知库</option>
                  <option value="both">→ 双轨提纯</option>
                  <option value="methodology">→ 方法论库</option>
                </select>
                <button type="button" className="btn btn-sm btn-primary" onClick={handleAddLocalFolder}>
                  <Plus size={12} /> 添加
                </button>
              </div>
            </div>
          </div>

          {/* 4. 免费公开实时电报 & 自定义 RSS / Atom */}
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 14 }}>
              <Rss size={16} color="var(--amber)" />
              <span>通道 4 · 免配置公开电报 & 自定义 RSS / Atom</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              零登录、零风控，发给任何朋友解压即可直接使用；同时支持自由粘贴任意投研 RSS / RSSHub 地址。
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {cfg.publicFeeds.map((f, idx) => {
                const cat = overview.publicFeedCatalog.find((c) => c.id === f.id);
                return (
                  <div
                    key={f.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 9px',
                      borderRadius: 7,
                      border: '1px solid var(--border)',
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={f.enabled}
                        onChange={(e) => {
                          const next = [...cfg.publicFeeds];
                          next[idx] = { ...f, enabled: e.target.checked };
                          persistConfig({ publicFeeds: next });
                        }}
                      />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{f.name}</div>
                        {cat && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{cat.desc}</div>}
                      </div>
                    </label>
                    <select
                      className="input"
                      style={{ width: 116, height: 26, padding: '1px 5px', fontSize: 11 }}
                      value={f.route}
                      onChange={(e) => {
                        const next = [...cfg.publicFeeds];
                        next[idx] = { ...f, route: e.target.value as IntelRoute };
                        persistConfig({ publicFeeds: next });
                      }}
                    >
                      <option value="cognition">→ 行业认知</option>
                      <option value="sentiment">→ 情绪参考</option>
                      <option value="both">→ 双轨</option>
                    </select>
                  </div>
                );
              })}
            </div>

            {/* Custom RSS list */}
            <div style={{ paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>已订阅 RSS / Atom 源</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
                {cfg.rssFeeds.map((r, idx) => (
                  <div
                    key={r.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 6,
                      padding: '5px 8px',
                      borderRadius: 6,
                      background: 'var(--bg-subtle)',
                      fontSize: 12,
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={(e) => {
                          const next = [...cfg.rssFeeds];
                          next[idx] = { ...r, enabled: e.target.checked };
                          persistConfig({ rssFeeds: next });
                        }}
                      />
                      <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.url}>
                        {r.name}
                      </span>
                    </label>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <select
                        className="input"
                        style={{ width: 105, height: 24, padding: '1px 4px', fontSize: 11 }}
                        value={r.route}
                        onChange={(e) => {
                          const next = [...cfg.rssFeeds];
                          next[idx] = { ...r, route: e.target.value as IntelRoute };
                          persistConfig({ rssFeeds: next });
                        }}
                      >
                        <option value="cognition">→ 认知库</option>
                        <option value="methodology">→ 方法论</option>
                        <option value="both">→ 双轨</option>
                      </select>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ padding: '2px 5px' }}
                        onClick={() => persistConfig({ rssFeeds: cfg.rssFeeds.filter((x) => x.id !== r.id) })}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* 1-click presets */}
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>精选预设一键加：</span>
                {overview.rssPresetCatalog.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="btn btn-sm"
                    style={{ fontSize: 11, padding: '2px 7px', height: 'auto' }}
                    onClick={() => handleAddRss(p)}
                  >
                    + {p.category} · {p.name.split('（')[0]}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="input"
                  style={{ width: 130, fontSize: 11.5 }}
                  placeholder="源名称"
                  value={newRssName}
                  onChange={(e) => setNewRssName(e.target.value)}
                />
                <input
                  className="input mono"
                  style={{ flex: 1, fontSize: 11.5 }}
                  placeholder="粘贴 RSS / Atom / RSSHub URL"
                  value={newRssUrl}
                  onChange={(e) => setNewRssUrl(e.target.value)}
                />
                <button type="button" className="btn btn-sm btn-primary" onClick={() => handleAddRss()}>
                  <Plus size={12} /> 订阅
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* SUB-TAB 3: 存量本地知识库一键批量扫描与分诊导入（Obsidian/Notion/PDF） */}
      {/* =================================================================== */}
      {subTab === 'vault' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14 }}>
              <FolderInput size={17} color="var(--navy)" />
              <span>本地存量知识库一键分析导入（适配 Obsidian / Notion 导出目录 / 券商研报文件夹）</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              递归扫描整个本地文件夹（自动跳过 <code>.git / .obsidian / assets / node_modules</code>，支持 <code>.md / .pdf / .docx / .html / .txt</code>），由 AI 按 2 万字分块自动分诊入「行业前沿认知库」和「方法论卡片库」并做滚雪球语义去重（已升级为本地 Top-28 正文语义召回去重）；全部结果汇入收件箱后，支持<strong>多选一键合并 Diff 原子入库</strong>！
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                className="input mono"
                style={{ flex: 1, minWidth: 280, fontSize: 12 }}
                placeholder="粘贴你的本地知识库文件夹路径，例如：D:\Notes\我的投研Obsidian库 或 D:\券商深度研报"
                value={vaultDirPath}
                onChange={(e) => setVaultDirPath(e.target.value)}
              />
              <select
                className="input"
                style={{ width: 195, fontSize: 12 }}
                value={vaultMode}
                onChange={(e) => setVaultMode(e.target.value as 'auto' | 'cognition' | 'methodology' | 'both')}
              >
                <option value="auto">AI 智能自动分诊（推荐）</option>
                <option value="both">全部双轨（认知 + 方法论）</option>
                <option value="cognition">全部导入行业前沿认知库</option>
                <option value="methodology">全部导入方法论卡片库</option>
              </select>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={scanningVault || !vaultDirPath.trim()}
                onClick={handleScanVault}
              >
                {scanningVault ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
                <span>{scanningVault ? '递归扫描中...' : '1. 递归扫描目录'}</span>
              </button>
            </div>
          </div>

          {vaultScan && (
            <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontSize: 13 }}>
                  <strong>扫描结果：</strong>共发现 <strong>{vaultScan.totalFiles}</strong> 份文档（总计 {vaultScan.totalSizeKb} KB，跳过 {vaultScan.skippedDirs} 个隐藏/附件目录）
                  <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 12 }}>
                    {Object.entries(vaultScan.byExt).map(([ext, cnt]) => `${ext}×${cnt}`).join(' · ')}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      setSelectedVaultFiles(
                        selectedVaultFiles.length === vaultScan.files.length ? [] : vaultScan.files.map((f) => f.relPath)
                      )
                    }
                  >
                    {selectedVaultFiles.length === vaultScan.files.length ? '取消全选' : `全选 (${vaultScan.files.length})`}
                  </button>
                  <AiProviderPicker value={provider} config={aiConfig} onChange={setProvider} onOpenSettings={onOpenAiSettings} />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={selectedVaultFiles.length === 0 || Boolean(runningJob || activeJobId)}
                    onClick={handleStartVaultImport}
                  >
                    <Sparkles size={14} />
                    <span>2. 一键分批提纯已选 ({selectedVaultFiles.length} 份)</span>
                  </button>
                </div>
              </div>

              <div style={{ maxHeight: 390, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                {vaultScan.files.map((f) => {
                  const checked = selectedVaultFiles.includes(f.relPath);
                  return (
                    <label
                      key={f.relPath}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 10,
                        padding: '7px 11px',
                        borderBottom: '1px solid var(--border)',
                        fontSize: 12,
                        cursor: 'pointer',
                        background: checked ? 'var(--bg-subtle)' : 'transparent',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            setSelectedVaultFiles((prev) =>
                              e.target.checked
                                ? [...new Set([...prev, f.relPath])]
                                : prev.filter((x) => x !== f.relPath)
                            );
                          }}
                        />
                        <span className="badge badge-muted mono" style={{ fontSize: 10 }}>{f.ext}</span>
                        <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.relPath}>
                          {f.relPath}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                        <span className="badge badge-navy" style={{ fontSize: 10 }}>
                          建议 → {ROUTE_LABELS[f.suggestedTrack]}
                        </span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{Math.max(1, Math.round(f.sizeBytes / 1024))} KB</span>
                        <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 11 }}>{f.modifiedAt}</span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* =================================================================== */}
      {/* SUB-TAB 4: 每日定时进化 & 单篇链接快采                                */}
      {/* =================================================================== */}
      {subTab === 'schedule' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 14 }}>
              <Clock size={16} color="var(--navy)" />
              <span>每日定时自动采集与三库进化引擎</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              开启后，只要工作台在后台托盘运行，每天到达设定时间会自动拉取全部已启用信源、运行 AI 双轨提纯进「候选收件箱」，并通过你在「质检·推送调度」配置好的飞书/企微/钉钉/Bark Webhook 发出晚报提醒（若电脑休眠错过时间，唤醒后自动补跑）。
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={cfg.schedule.enabled}
                onChange={(e) =>
                  persistConfig({ schedule: { ...cfg.schedule, enabled: e.target.checked } }, e.target.checked ? '已开启每日定时情报进化' : '已暂停每日定时情报进化')
                }
              />
              <span>启用每日定时情报进化任务</span>
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <div className="field-group" style={{ margin: 0 }}>
                <label className="field-label">执行小时 (0–23)</label>
                <input
                  type="number"
                  min={0}
                  max={23}
                  className="input mono"
                  value={cfg.schedule.dailyHour}
                  onChange={(e) =>
                    persistConfig({ schedule: { ...cfg.schedule, dailyHour: Number(e.target.value) } })
                  }
                />
              </div>
              <div className="field-group" style={{ margin: 0 }}>
                <label className="field-label">执行分钟 (0–59)</label>
                <input
                  type="number"
                  min={0}
                  max={59}
                  className="input mono"
                  value={cfg.schedule.dailyMinute}
                  onChange={(e) =>
                    persistConfig({ schedule: { ...cfg.schedule, dailyMinute: Number(e.target.value) } })
                  }
                />
              </div>
              <div className="field-group" style={{ margin: 0 }}>
                <label className="field-label">默认回看天数</label>
                <input
                  type="number"
                  min={1}
                  max={7}
                  className="input mono"
                  value={cfg.schedule.lookbackDays}
                  onChange={(e) =>
                    persistConfig({ schedule: { ...cfg.schedule, lookbackDays: Number(e.target.value) } })
                  }
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.5 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cfg.schedule.autoAiDistill}
                  onChange={(e) => persistConfig({ schedule: { ...cfg.schedule, autoAiDistill: e.target.checked } })}
                />
                <span>采集完成后自动运行 AI 双轨提纯（生成认知/方法论候选卡片）</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cfg.schedule.pushWebhookSummary}
                  onChange={(e) => persistConfig({ schedule: { ...cfg.schedule, pushWebhookSummary: e.target.checked } })}
                />
                <span>完成后自动通过飞书 / 企微 / 钉钉 / Bark Webhook 推送今日进化摘要</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cfg.schedule.autoWechatSync}
                  onChange={(e) => persistConfig({ schedule: { ...cfg.schedule, autoWechatSync: e.target.checked } })}
                />
                <span>定时执行前顺带调用微信公众号增量追更（默认关闭，避开微信读书日频控）</span>
              </label>
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-muted)', paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              最近执行记录：{cfg.schedule.lastRunAt || '尚未执行'}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Single URL Quick Fetch */}
            <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 14 }}>
                <Link2 size={16} color="var(--navy)" />
                <span>单篇公开文章链接快采（即贴即提纯）</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                看到一篇极佳的公众号文章、海外博客或产业新闻？直接粘贴 URL，工作台立即抓取正文并走 AI 双轨提纯进入候选收件箱！
              </div>
              <input
                className="input mono"
                style={{ fontSize: 12 }}
                placeholder="粘贴 https://mp.weixin.qq.com/s/... 或任意网页链接"
                value={quickUrl}
                onChange={(e) => setQuickUrl(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  className="input"
                  style={{ width: 170, fontSize: 12 }}
                  value={quickUrlRoute}
                  onChange={(e) => setQuickUrlRoute(e.target.value as IntelRoute)}
                >
                  <option value="cognition">提纯目标 → 行业认知库</option>
                  <option value="methodology">提纯目标 → 方法论卡片库</option>
                  <option value="both">提纯目标 → 双轨同时提纯</option>
                </select>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={fetchingUrl || !quickUrl.trim() || Boolean(runningJob || activeJobId)}
                  onClick={handleQuickUrlIngest}
                >
                  {fetchingUrl ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                  <span>抓取并送入 AI 提纯</span>
                </button>
              </div>
            </div>

            {/* Watermark Maintenance */}
            <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>去重水印维护</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                当前已记录 <strong>{overview.watermarkCount}</strong> 条已处理文章/帖子指纹，避免重复消耗 AI Token。如需重新对近几日全量内容再提纯一次，可清空水印。
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    await api.resetIntelWatermarks();
                    await loadOverview();
                    onToast('已清空情报去重水印');
                  }}
                >
                  <Trash2 size={12} /> 清空去重水印
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
