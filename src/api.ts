import type {
  AiIngestionResult,
  AiProvider,
  AiSafeConfig,
  AppProfileResponse,
  AuditReport,
  AutoReviewResult,
  BackgroundJobDetail,
  BackgroundJobSummary,
  BacktestResultFull,
  BacktestRunSummary,
  BackupManifest,
  BotNotificationItem,
  BotWatchFullState,
  BrandProfile,
  BrandStateResponse,
  ChartDrawing,
  CrossMarketPairConfig,
  DailyKlinePoint,
  DataSourceChannelId,
  DataSourceConfigResponse,
  EvidenceCheckResult,
  EvidenceRecord,
  ExecutionSlotStateResponse,
  ExtractedDoc,
  GlobalMarketsOverviewResponse,
  IntelHubConfig,
  IntelHubOverviewResponse,
  IntelRawItem,
  IntelRoute,
  IntelZsxqGroupConfig,
  JudgmentTrackerResponse,
  KbCardTimelineResponse,
  KbSearchResponse,
  KbStaleReport,
  KbTopicView,
  KlineTimeframe,
  LicenseStatusInfo,
  MarketPacket,
  MiniQmtProbeResult,
  MutationPreview,
  PeriodicAiReport,
  PeriodicSummary,
  PreflightReport,
  QuantDataSummary,
  QuantEnvStatus,
  QuantStrategyItem,
  ReconcileItem,
  ReconcileReport,
  RegulatoryWatchItem,
  RuleCardDriftAudit,
  SchedulerConfig,
  SchedulerStatusResponse,
  SecurityDetailData,
  SecuritySearchItem,
  SentimentNodeEntry,
  SlimeBotConfig,
  SlimeBotMessage,
  SlimeBotStateResponse,
  SlimeMiniTickerData,
  StockOrderBookResponse,
  StockResearchPacket,
  StockSnapshot,
  SymbolTradeMarkers,
  TechnicalAlertRule,
  TechnicalAnalysisResponse,
  TechnicalMetricOption,
  TechnicalRadarResponse,
  TradeLedgerAnalytics,
  TradeRecord,
  VaultScanResponse,
  VetoLedgerItem,
  WatchlistItem,
  WatchlistLiveResponse,
  WechatBridgeStatus,
  WorkspaceData,
  WorkspaceProfileInfo,
} from './types';

const LONG_TIMEOUT_URL_RE =
  /\/api\/(ai\/|quant\/|backups\/|ingest\/|audio\/|intel\/|bot\/chat|trades\/parse-ai|periodic-review\/ai|brand\/ai-stylize|technical\/extract-from-cards|reports\/|vault\/|kb\/(topics\/synthesize|migrate-from-v1|export-monolith))/;

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const mergedHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-SRW-Client': 'workbench',
    ...((options?.headers as Record<string, string>) || {}),
  };
  const timeoutMs = LONG_TIMEOUT_URL_RE.test(url) ? 180000 : 25000;
  const controller = !options?.signal ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const resp = await fetch(url, {
      ...options,
      headers: mergedHeaders,
      signal: options?.signal || controller?.signal,
    });
    const rawText = await resp.text();
    let data: any = {};
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        if (!resp.ok) {
          throw new Error(`服务端响应异常 (${resp.status})：${rawText.slice(0, 140)}`);
        }
        throw new Error('服务端返回了非 JSON 数据，请检查本地服务状态');
      }
    }
    if (!resp.ok) {
      if (resp.status === 402 && data?.code === 'UPGRADE_REQUIRED' && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('srw-upgrade-required', { detail: data }));
      }
      throw new Error(data.message || data.error || `请求失败 (${resp.status})`);
    }
    return data as T;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      if (options?.signal?.aborted) {
        throw err;
      }
      throw new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s），请检查本地服务或上游网络状态`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let activeClientWorkspaceRoot = '';

export function setClientWorkspaceRoot(root: string | null | undefined) {
  activeClientWorkspaceRoot = String(root || '').trim();
}

export function getClientWorkspaceRoot(): string {
  return activeClientWorkspaceRoot;
}

export const api = {
  getWorkspace: () => requestJson<WorkspaceData>('/api/workspace'),
  runAudit: () => requestJson<AuditReport>('/api/audit'),
  getArchiveDoc: (relativePath: string) =>
    requestJson<{ path: string; name: string; content: string }>(
      `/api/archive-doc?path=${encodeURIComponent(relativePath)}`
    ),
  getEvidenceFile: (name: string) =>
    requestJson<{ name: string; data: EvidenceRecord; check: EvidenceCheckResult }>(
      `/api/evidence/file?name=${encodeURIComponent(name)}`
    ),
  checkEvidence: (record: EvidenceRecord) =>
    requestJson<EvidenceCheckResult>('/api/evidence/check', {
      method: 'POST',
      body: JSON.stringify(record),
    }),
  saveEvidence: (fileName: string, record: EvidenceRecord) =>
    requestJson<{ ok: boolean; fileName: string; path: string; check: EvidenceCheckResult }>(
      '/api/evidence/save',
      {
        method: 'POST',
        body: JSON.stringify({ fileName, record }),
      }
    ),
  previewMutation: (action: string, payload: Record<string, unknown>) =>
    requestJson<MutationPreview>('/api/mutate/preview', {
      method: 'POST',
      body: JSON.stringify({ action, payload }),
    }),
  commitMutation: (action: string, payload: Record<string, unknown>) =>
    requestJson<{ ok: boolean; committed: boolean; backupId: string | null; auditRecorded?: boolean; auditError?: string }>('/api/mutate/commit', {
      method: 'POST',
      body: JSON.stringify({ action, payload }),
    }),
  listBackups: () => requestJson<{ backups: BackupManifest[] }>('/api/backups'),
  restoreBackup: (backupId: string) =>
    requestJson<{ ok: boolean; backupId: string; auditRecorded?: boolean; auditError?: string }>('/api/backups/restore', {
      method: 'POST',
      body: JSON.stringify({ backupId }),
    }),
  fetchDailyMarket: (date?: string, watchStocks?: string[]) =>
    requestJson<{ ok: boolean; packet: MarketPacket }>('/api/market/fetch-daily', {
      method: 'POST',
      body: JSON.stringify({ date, watchStocks }),
    }),
  getAiConfig: (refresh = false) =>
    requestJson<{ ok: boolean; config: AiSafeConfig }>(`/api/ai/config${refresh ? '?refresh=1' : ''}`),
  saveAiConfig: (patch: Record<string, unknown>) =>
    requestJson<{ ok: boolean; config: AiSafeConfig }>('/api/ai/config', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  testAiConnection: (provider?: AiProvider) =>
    requestJson<{ ok: boolean; provider: string; model: string; latencyMs: number; sample: string }>(
      '/api/ai/test',
      {
        method: 'POST',
        body: JSON.stringify({ provider }),
      }
    ),
  buildReviewPrompt: (packet: MarketPacket, extraNotes: string) =>
    requestJson<{ ok: boolean; systemPrompt: string; userPrompt: string; combinedPrompt: string }>(
      '/api/ai/daily-review/prompt',
      {
        method: 'POST',
        body: JSON.stringify({ packet, extraNotes }),
      }
    ),
  runAutoDailyReview: (packet: MarketPacket, extraNotes: string, provider?: AiProvider) =>
    requestJson<AutoReviewResult>('/api/ai/daily-review/run', {
      method: 'POST',
      body: JSON.stringify({ packet, extraNotes, provider }),
    }),
  parseManualReviewJson: (packet: MarketPacket, rawText: string) =>
    requestJson<{ ok: boolean; form: Record<string, any>; warnings: string[]; reconcile?: ReconcileReport }>(
      '/api/ai/daily-review/parse-json',
      {
        method: 'POST',
        body: JSON.stringify({ packet, rawText }),
      }
    ),
  applyReconcileFixes: (payload: {
    kind: 'daily' | 'judgment';
    form: Record<string, any>;
    items: ReconcileItem[];
    packet?: MarketPacket | null;
    researchPacket?: StockResearchPacket | null;
  }) =>
    requestJson<{ ok: boolean; form: Record<string, any>; applied: number; reconcile: ReconcileReport | null }>(
      '/api/ai/reconcile/apply',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  extractDocument: (fileName: string, base64: string) =>
    requestJson<{ ok: boolean; extracted: ExtractedDoc }>('/api/ingest/extract', {
      method: 'POST',
      body: JSON.stringify({ fileName, base64 }),
    }),
  transcribeAudio: (fileName: string, mimeType: string, base64: string) =>
    requestJson<{ ok: boolean; text: string; engine: string; latencyMs: number }>('/api/audio/transcribe', {
      method: 'POST',
      body: JSON.stringify({ fileName, mimeType, base64 }),
    }),
  buildIngestionPrompt: (
    targetLibrary: 'methodology' | 'cognition',
    sourceText: string,
    meta: { sourceName?: string; batchNote?: string; hint?: string; isVoiceInput?: boolean }
  ) =>
    requestJson<{ ok: boolean; systemPrompt: string; userPrompt: string; combinedPrompt: string }>(
      '/api/ingest/prompt',
      {
        method: 'POST',
        body: JSON.stringify({ targetLibrary, sourceText, meta }),
      }
    ),
  runAiIngestion: (
    targetLibrary: 'methodology' | 'cognition',
    sourceText: string,
    meta: { sourceName?: string; batchNote?: string; hint?: string },
    provider?: AiProvider
  ) =>
    requestJson<{
      ok: boolean;
      targetLibrary: 'methodology' | 'cognition';
      result: AiIngestionResult;
      auditTrail: { provider: string; model: string; latencyMs: number; sourceChars: number };
    }>('/api/ingest/run', {
      method: 'POST',
      body: JSON.stringify({ targetLibrary, sourceText, meta, provider }),
    }),
  parseManualIngestionJson: (
    targetLibrary: 'methodology' | 'cognition',
    rawText: string,
    meta: { sourceName?: string; batchNote?: string }
  ) =>
    requestJson<{ ok: boolean; targetLibrary: 'methodology' | 'cognition'; result: AiIngestionResult }>(
      '/api/ingest/parse-json',
      {
        method: 'POST',
        body: JSON.stringify({ targetLibrary, rawText, meta }),
      }
    ),
  listJobs: () => requestJson<{ ok: boolean; jobs: BackgroundJobSummary[] }>('/api/jobs'),
  getJob: (jobId: string) =>
    requestJson<{ ok: boolean; job: BackgroundJobDetail }>(`/api/jobs/${encodeURIComponent(jobId)}`),
  startAutoDailyReviewJob: (packet: MarketPacket, extraNotes: string, provider?: AiProvider) =>
    requestJson<{ ok: boolean; job: BackgroundJobSummary }>('/api/ai/daily-review/start', {
      method: 'POST',
      body: JSON.stringify({ packet, extraNotes, provider }),
    }),
  startAiIngestionJob: (
    targetLibrary: 'methodology' | 'cognition',
    sourceText: string,
    meta: { sourceName?: string; batchNote?: string; hint?: string; isVoiceInput?: boolean },
    provider?: AiProvider
  ) =>
    requestJson<{ ok: boolean; job: BackgroundJobSummary }>('/api/ingest/start', {
      method: 'POST',
      body: JSON.stringify({ targetLibrary, sourceText, meta, provider }),
    }),
  fetchStockSnapshot: (code: string) =>
    requestJson<{ ok: boolean; snapshot: StockSnapshot }>('/api/market/stock-snapshot', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  collectStockResearch: (query: string) =>
    requestJson<{ ok: boolean; packet: StockResearchPacket }>('/api/market/stock-research', {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),
  buildJudgmentPrompt: (
    sourceText: string,
    meta: { targetHint?: string; stockCode?: string; sourceName?: string; hint?: string },
    researchPacket?: StockResearchPacket | null,
    enableWebResearch = true
  ) =>
    requestJson<{
      ok: boolean;
      systemPrompt: string;
      userPrompt: string;
      combinedPrompt: string;
      researchPacket: StockResearchPacket | null;
    }>('/api/ai/judgment/prompt', {
      method: 'POST',
      body: JSON.stringify({ sourceText, meta, researchPacket, enableWebResearch }),
    }),
  parseManualJudgmentJson: (
    rawText: string,
    meta: { targetHint?: string; stockCode?: string; sourceName?: string },
    researchPacket?: StockResearchPacket | null
  ) =>
    requestJson<{ ok: boolean; summary: string; form: Record<string, any>; warnings: string[]; gaps: string[] }>(
      '/api/ai/judgment/parse-json',
      {
        method: 'POST',
        body: JSON.stringify({ rawText, meta, researchPacket }),
      }
    ),
  startAiJudgmentJob: (
    sourceText: string,
    meta: { targetHint?: string; stockCode?: string; sourceName?: string; hint?: string },
    provider?: AiProvider,
    options?: { researchPacket?: StockResearchPacket | null; enableWebResearch?: boolean; debateMode?: boolean }
  ) =>
    requestJson<{ ok: boolean; job: BackgroundJobSummary }>('/api/ai/judgment/start', {
      method: 'POST',
      body: JSON.stringify({
        sourceText,
        meta,
        provider,
        researchPacket: options?.researchPacket || null,
        enableWebResearch: options?.enableWebResearch !== false,
        debateMode: Boolean(options?.debateMode),
      }),
    }),
  renderDraftDailyHtml: (form: Record<string, any>, packet: MarketPacket | null, theme: 'light' | 'dark' = 'light') =>
    requestJson<{ ok: boolean; html: string; fileName: string }>('/api/daily-review/html-draft', {
      method: 'POST',
      body: JSON.stringify({ form, packet, embedded: false, theme }),
    }),
  saveDailyReviewHtml: (payload: { id?: string; date?: string; form?: Record<string, any>; packet?: MarketPacket | null; theme?: 'light' | 'dark' }) =>
    requestJson<{ ok: boolean; fileName: string; fullPath: string; dir: string; sizeBytes: number }>(
      '/api/daily-review/save-html',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  searchSecurities: (q: string) =>
    requestJson<{ ok: boolean; items: SecuritySearchItem[] }>(
      `/api/market/search?q=${encodeURIComponent(q)}`
    ),
  getWatchlist: () =>
    requestJson<{
      ok: boolean;
      workspaceRoot?: string;
      items: WatchlistItem[];
      crossPairs: CrossMarketPairConfig[];
      updatedAt: string | null;
      isDefault?: boolean;
      configured?: boolean;
      isDemo?: boolean;
      demoSampleCount?: number;
    }>('/api/watchlist'),
  saveWatchlist: async (payload: {
    workspaceRoot?: string;
    items?: WatchlistItem[];
    crossPairs?: CrossMarketPairConfig[];
    reset?: boolean;
    empty?: boolean;
    isDemo?: boolean;
  }) => {
    const targetWorkspaceRoot = (payload.workspaceRoot ?? activeClientWorkspaceRoot) || undefined;
    const res = await requestJson<{
      ok: boolean;
      workspaceRoot?: string;
      items: WatchlistItem[];
      crossPairs: CrossMarketPairConfig[];
      updatedAt: string | null;
      isDefault?: boolean;
      configured?: boolean;
      isDemo?: boolean;
      demoSampleCount?: number;
    }>('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({ ...payload, ...(targetWorkspaceRoot ? { workspaceRoot: targetWorkspaceRoot } : {}) }),
    });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('srw-watchlist-changed', { detail: res }));
    }
    return res;
  },
  addWatchlistItem: async (item: Partial<WatchlistItem>, prepend = true, workspaceRoot?: string) => {
    const targetWorkspaceRoot = (workspaceRoot ?? activeClientWorkspaceRoot) || undefined;
    const res = await requestJson<{
      ok: boolean;
      workspaceRoot?: string;
      added: boolean;
      alreadyExists: boolean;
      item: WatchlistItem;
      items: WatchlistItem[];
      crossPairs: CrossMarketPairConfig[];
      updatedAt: string | null;
      isDefault?: boolean;
      configured?: boolean;
      isDemo?: boolean;
      demoSampleCount?: number;
    }>('/api/watchlist/add', {
      method: 'POST',
      body: JSON.stringify({ item, prepend, ...(targetWorkspaceRoot ? { workspaceRoot: targetWorkspaceRoot } : {}) }),
    });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('srw-watchlist-changed', { detail: res }));
    }
    return res;
  },
  getWatchlistLive: (includeIntraday = true) =>
    requestJson<WatchlistLiveResponse>(`/api/watchlist/live?intraday=${includeIntraday ? '1' : '0'}`),
  getSecurityDetail: (secid: string, timeframe: KlineTimeframe = 'day') =>
    requestJson<SecurityDetailData>(
      `/api/watchlist/detail?secid=${encodeURIComponent(secid)}&tf=${encodeURIComponent(timeframe)}`
    ),
  getTechnicalRules: () =>
    requestJson<{
      ok: boolean;
      metricCatalog: TechnicalMetricOption[];
      rules: TechnicalAlertRule[];
      updatedAt: string | null;
      isDefault: boolean;
      driftAudit?: RuleCardDriftAudit;
    }>('/api/technical/rules'),
  saveTechnicalRules: (payload: { rules?: TechnicalAlertRule[]; reset?: boolean; syncHashes?: boolean }) =>
    requestJson<{
      ok: boolean;
      metricCatalog: TechnicalMetricOption[];
      rules: TechnicalAlertRule[];
      updatedAt: string | null;
      isDefault: boolean;
      driftAudit?: RuleCardDriftAudit;
    }>('/api/technical/rules', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getSentimentChain: () =>
    requestJson<{ ok: boolean; history: SentimentNodeEntry[]; updatedAt: string | null }>('/api/technical/sentiment-chain'),
  getTechnicalRadar: () => requestJson<TechnicalRadarResponse>('/api/technical/radar'),
  analyzeTechnical: (queryOrSecid: string, timeframe: KlineTimeframe = 'day') =>
    requestJson<TechnicalAnalysisResponse>(
      `/api/technical/analyze?q=${encodeURIComponent(queryOrSecid)}&tf=${encodeURIComponent(timeframe)}`
    ),
  extractTechnicalRulesFromCards: (cardIds: string[], useAi = false, provider?: AiProvider) =>
    requestJson<{
      ok: boolean;
      mode: 'deterministic' | 'ai';
      provider?: string;
      model?: string;
      latencyMs?: number;
      extractedRules: TechnicalAlertRule[];
      sourceCards: { id: string; title: string }[];
    }>('/api/technical/extract-from-cards', {
      method: 'POST',
      body: JSON.stringify({ cardIds, useAi, provider }),
    }),
  // P0-1 / P0-2：盘前预检、研判 T+N 追踪、否决观察池、监管红线名单
  getPreflight: () => requestJson<PreflightReport>('/api/preflight'),
  getJudgmentTracker: (refresh = false) =>
    requestJson<JudgmentTrackerResponse>(`/api/judgments/tracker${refresh ? '?refresh=1' : ''}`),
  addVetoEntry: (entry: Partial<VetoLedgerItem>) =>
    requestJson<{ ok: boolean; item: VetoLedgerItem }>('/api/veto-ledger', {
      method: 'POST',
      body: JSON.stringify(entry),
    }),
  deleteVetoEntry: (id: string) =>
    requestJson<{ ok: boolean; deleted: boolean; count: number }>('/api/veto-ledger', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', id }),
    }),
  getRegulatoryWatchlist: () =>
    requestJson<{ ok: boolean; items: RegulatoryWatchItem[]; updatedAt: string | null }>('/api/regulatory-watchlist'),
  saveRegulatoryWatchlist: (items: RegulatoryWatchItem[]) =>
    requestJson<{ ok: boolean; items: RegulatoryWatchItem[]; updatedAt: string | null }>('/api/regulatory-watchlist', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
  // P1-1：实盘/模拟交易账本与归因
  getTradeAnalytics: (refresh = false) =>
    requestJson<TradeLedgerAnalytics>(`/api/trades/analytics${refresh ? '?refresh=1' : ''}`),
  getTradeMarkers: (codeOrSecid: string) =>
    requestJson<{ ok: boolean } & SymbolTradeMarkers>(
      `/api/trades/markers?code=${encodeURIComponent(codeOrSecid)}`
    ),
  addTrades: (trades: Partial<TradeRecord>[]) =>
    requestJson<{ ok: boolean; added: TradeRecord[]; total: number; auditRecorded?: boolean; auditError?: string }>('/api/trades', {
      method: 'POST',
      body: JSON.stringify({ trades }),
    }),
  deleteTrade: (id: string) =>
    requestJson<{ ok: boolean; deleted: boolean; total: number; auditRecorded?: boolean; auditError?: string }>('/api/trades', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', id }),
    }),
  updateTradeSettings: (settings: Partial<TradeLedgerAnalytics['settings']>) =>
    requestJson<{ ok: boolean; settings: TradeLedgerAnalytics['settings']; auditRecorded?: boolean; auditError?: string }>('/api/trades', {
      method: 'POST',
      body: JSON.stringify({ action: 'settings', settings }),
    }),
  parseBrokerCsv: (csvText: string) =>
    requestJson<{ ok: boolean; trades: TradeRecord[]; errors: string[] }>('/api/trades/parse-csv', {
      method: 'POST',
      body: JSON.stringify({ csvText }),
    }),
  parseTradesWithAi: (payload: { text?: string; imageBase64?: string; imageMimeType?: string; provider?: AiProvider }) =>
    requestJson<{ ok: boolean; provider: string; model: string; latencyMs: number; trades: TradeRecord[] }>(
      '/api/trades/parse-ai',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  // P2-3：K 线自定义画线持久化
  getChartDrawings: (secid: string, timeframe: KlineTimeframe) =>
    requestJson<{ ok: boolean; secid: string; timeframe: string; drawings: ChartDrawing[]; updatedAt: string | null }>(
      `/api/chart/drawings?secid=${encodeURIComponent(secid)}&tf=${encodeURIComponent(timeframe)}`
    ),
  saveChartDrawings: (secid: string, timeframe: KlineTimeframe, drawings: ChartDrawing[]) =>
    requestJson<{ ok: boolean; secid: string; timeframe: string; drawings: ChartDrawing[]; updatedAt: string | null }>(
      '/api/chart/drawings',
      {
        method: 'POST',
        body: JSON.stringify({ secid, timeframe, drawings }),
      }
    ),
  // P1-3：盘中定时巡检与多通道告警推送
  getSchedulerStatus: () => requestJson<SchedulerStatusResponse>('/api/scheduler/status'),
  saveSchedulerConfig: (patch: Partial<SchedulerConfig>) =>
    requestJson<{ ok: boolean; config: SchedulerConfig }>('/api/scheduler/config', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  testWebhook: (channel?: string) =>
    requestJson<{ ok: boolean; results: { channel: string; ok: boolean; error?: string }[] }>(
      '/api/scheduler/test-webhook',
      {
        method: 'POST',
        body: JSON.stringify({ channel }),
      }
    ),
  runSchedulerScanNow: () =>
    requestJson<{ ok: boolean; totalAlerts: number; freshCount: number; drawingAlertCount: number }>('/api/scheduler/run-scan', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  runPostMarketCaptureNow: () =>
    requestJson<{ ok: boolean; date: string; packetBars: number }>('/api/scheduler/run-postmarket', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // P2-2：周报/月报聚合复盘与 HTML 导出
  getPeriodicSummary: (payload: { periodType: 'week' | 'month'; startDate?: string; endDate?: string }) =>
    requestJson<PeriodicSummary>('/api/periodic-review/summary', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  runPeriodicAi: (payload: { summary: PeriodicSummary; provider?: AiProvider }) =>
    requestJson<{ ok: boolean; provider: string; model: string; latencyMs: number; report: PeriodicAiReport; summary: PeriodicSummary }>(
      '/api/periodic-review/ai',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  renderPeriodicHtml: (payload: { summary: PeriodicSummary; aiReport?: PeriodicAiReport | null; theme?: 'light' | 'dark'; saveToDisk?: boolean }) =>
    requestJson<{ ok: boolean; html: string; fileName: string; saved?: { fileName: string; fullPath: string } | null }>(
      '/api/periodic-review/html',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  // 方案 A：多工作空间管理 & 离线 Ed25519 授权管理 + EULA + 离线演示包
  getAppProfile: () => requestJson<AppProfileResponse>('/api/app/profile'),
  getEula: () => requestJson<{ ok: boolean; eula: any }>('/api/app/eula'),
  acceptEula: () =>
    requestJson<{ ok: boolean; eula: any }>('/api/app/eula/accept', {
      method: 'POST',
      body: JSON.stringify({ agreed: true }),
    }),
  getDemoMarketPacket: () => requestJson<{ ok: boolean; packet: MarketPacket }>('/api/demo/market-packet'),
  switchWorkspace: (payload: {
    targetDir: string;
    label?: string;
    initIfMissing?: boolean;
    template?: 'starter' | 'blank';
  }) =>
    requestJson<{ ok: boolean; workspaceProfile: WorkspaceProfileInfo; auditRecorded?: boolean; auditError?: string }>('/api/app/workspace/switch', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  createWorkspace: (payload: { name: string; template?: 'starter' | 'blank' }) =>
    requestJson<{ ok: boolean; workspaceProfile: WorkspaceProfileInfo; auditRecorded?: boolean; auditError?: string }>('/api/app/workspace/create', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  activateLicense: (licenseKey: string) =>
    requestJson<{ ok: boolean; license: LicenseStatusInfo; entitlements?: any; auditRecorded?: boolean; auditError?: string }>('/api/app/license/activate', {
      method: 'POST',
      body: JSON.stringify({ licenseKey }),
    }),
  deactivateLicense: () =>
    requestJson<{ ok: boolean; license: LicenseStatusInfo; entitlements?: any; auditRecorded?: boolean; auditError?: string }>('/api/app/license/deactivate', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // 情报信源与定时进化中心（Intel Hub）
  getIntelOverview: () => requestJson<IntelHubOverviewResponse>('/api/intel/overview'),
  saveIntelConfig: (patch: Partial<IntelHubConfig>) =>
    requestJson<{ ok: boolean; config: IntelHubConfig; wechatBridge: WechatBridgeStatus }>('/api/intel/config', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  probeZsxqGroups: (testAccess = true) =>
    requestJson<{
      ok: boolean;
      installed: boolean;
      authenticated: boolean;
      totalCount?: number;
      readableCount?: number;
      groups: IntelZsxqGroupConfig[];
      config: IntelHubConfig;
      message?: string;
    }>('/api/intel/zsxq/probe', {
      method: 'POST',
      body: JSON.stringify({ testAccess }),
    }),
  syncWechatSubscriptions: (bookId = '') =>
    requestJson<{ ok: boolean; summary: any; bridgeStatus: WechatBridgeStatus }>('/api/intel/wechat/sync', {
      method: 'POST',
      body: JSON.stringify({ bookId }),
    }),
  launchWechatWebUi: () =>
    requestJson<{ ok: boolean; alreadyRunning?: boolean; started?: boolean; webUiUrl: string; note?: string }>(
      '/api/intel/wechat/launch-ui',
      {
        method: 'POST',
        body: JSON.stringify({}),
      }
    ),
  fetchSingleIntelUrl: (url: string, route: IntelRoute = 'cognition') =>
    requestJson<{ ok: boolean; item: IntelRawItem }>('/api/intel/url-fetch', {
      method: 'POST',
      body: JSON.stringify({ url, route }),
    }),
  startIntelRunJob: (payload: {
    runAi?: boolean;
    lookbackDays?: number;
    syncWechatFirst?: boolean;
    ignoreWatermarks?: boolean;
    channels?: string[];
    provider?: AiProvider;
    extraItems?: IntelRawItem[];
    pushSummary?: boolean;
  }) =>
    requestJson<{ ok: boolean; job: BackgroundJobSummary }>('/api/intel/run', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateIntelCandidateStatus: (batchId: string, cid: string, status: 'pending' | 'committed' | 'dismissed') =>
    requestJson<{ ok: boolean; candidate: any }>('/api/intel/candidate/status', {
      method: 'POST',
      body: JSON.stringify({ batchId, cid, status }),
    }),
  resetIntelWatermarks: () =>
    requestJson<{ ok: boolean }>('/api/intel/watermarks/reset', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // 存量本地知识库一键扫描与批量导入
  scanLocalVault: (dirPath: string, maxFiles = 300) =>
    requestJson<VaultScanResponse>('/api/vault/scan', {
      method: 'POST',
      body: JSON.stringify({ dirPath, maxFiles }),
    }),
  startVaultImportJob: (payload: {
    dirPath: string;
    selectedRelPaths?: string[];
    mode?: 'auto' | 'cognition' | 'methodology' | 'both';
    provider?: AiProvider;
  }) =>
    requestJson<{ ok: boolean; job: BackgroundJobSummary }>('/api/vault/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // 蓝色史莱姆团子 · 高权限可调悬浮 Bot
  getBotState: () => requestJson<SlimeBotStateResponse>('/api/bot/state'),
  saveBotConfig: (patch: Partial<SlimeBotConfig>) =>
    requestJson<SlimeBotStateResponse>('/api/bot/config', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  getBotTicker: (refresh = false) =>
    requestJson<SlimeMiniTickerData>(`/api/bot/ticker${refresh ? '?refresh=1' : ''}`),
  sendBotChat: (message: string, provider?: AiProvider) =>
    requestJson<{
      ok: boolean;
      message: SlimeBotMessage;
      libraryChanged?: boolean;
      state: SlimeBotStateResponse;
      ticker?: SlimeMiniTickerData | null;
    }>('/api/bot/chat', {
      method: 'POST',
      body: JSON.stringify({ message, provider }),
    }),
  approveBotAction: (messageId: string, actionId: string) =>
    requestJson<{ ok: boolean; result?: any; libraryChanged?: boolean; state: SlimeBotStateResponse }>(
      '/api/bot/approve',
      {
        method: 'POST',
        body: JSON.stringify({ messageId, actionId }),
      }
    ),
  undoBotBackup: (backupId?: string) =>
    requestJson<{ ok: boolean; restoredFrom: string; state: SlimeBotStateResponse }>('/api/bot/undo', {
      method: 'POST',
      body: JSON.stringify({ backupId }),
    }),
  clearBotHistory: () =>
    requestJson<SlimeBotStateResponse>('/api/bot/clear', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  launchDesktopSlimePet: () =>
    requestJson<{ ok: boolean; exe: string; port: number }>('/api/bot/launch-desktop-pet', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // 左上角工作台品牌图标与标题个性化
  getBrandState: () => requestJson<BrandStateResponse>('/api/brand'),
  saveBrandProfile: (patch: Partial<BrandProfile> & { reset?: boolean }) =>
    requestJson<BrandStateResponse>('/api/brand', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  stylizeBrandIconWithAi: (payload: {
    imageBase64?: string;
    imageMimeType?: string;
    promptHint?: string;
    title?: string;
    stylePreset?: string;
    provider?: AiProvider;
  }) =>
    requestJson<{ ok: boolean; svgMarkup: string; provider: string; model: string }>('/api/brand/ai-stylize', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // v2.0 全球股票 / 期货 / 加密货币总览
  getGlobalMarketsOverview: () =>
    requestJson<GlobalMarketsOverviewResponse>('/api/market/global-overview'),
  // v2.0 短线作战模式全引擎
  getShortTermDashboard: (force = false) =>
    requestJson<any>(`/api/short-term/dashboard${force ? '?force=1' : ''}`),
  getMarketTickerStrip: (force = false) =>
    requestJson<any>(`/api/market/ticker-strip${force ? '?force=1' : ''}`),
  getShortTermLadder: (date = '') =>
    requestJson<any>(`/api/short-term/ladder${date ? `?date=${encodeURIComponent(date)}` : ''}`),
  getShortTermAnomaly: (q = '') =>
    requestJson<any>(`/api/short-term/anomaly${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getShortTermThemesRange: (params?: { indexSecid?: string; themeCode?: string; startDate?: string; endDate?: string }) => {
    const sp = new URLSearchParams();
    if (params?.indexSecid) sp.set('indexSecid', params.indexSecid);
    if (params?.themeCode) sp.set('themeCode', params.themeCode);
    if (params?.startDate) sp.set('startDate', params.startDate);
    if (params?.endDate) sp.set('endDate', params.endDate);
    const qs = sp.toString();
    return requestJson<any>(`/api/short-term/themes-range${qs ? `?${qs}` : ''}`);
  },
  searchShortTermThemes: (q = '', kind: 'all' | 'concept' | 'industry' | 'custom' = 'all', limit = 100) =>
    requestJson<{
      ok: boolean;
      fetchedAt: string;
      query: string;
      kind: string;
      totalCatalogCount: number;
      totalConcepts: number;
      totalIndustries: number;
      customCount: number;
      matchedTotal: number;
      pinnedCodes: string[];
      items: any[];
    }>(
      `/api/short-term/themes/search?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kind)}&limit=${limit}`
    ),
  saveCustomTheme: (payload: {
    id?: string;
    name: string;
    thesis?: string;
    stocks: { secid: string; code: string; name: string }[];
  }) =>
    requestJson<{ ok: boolean; theme: any; store: any }>('/api/short-term/themes/custom', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteCustomTheme: (id: string) =>
    requestJson<{ ok: boolean; deleted: boolean; store: any }>('/api/short-term/themes/custom/delete', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  togglePinTheme: (code: string) =>
    requestJson<{ ok: boolean; pinned: boolean; code: string; store: any }>('/api/short-term/themes/pin', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  getStockFullscreenDossier: (q: string, tf: KlineTimeframe = 'day') =>
    requestJson<any>(`/api/short-term/stock-dossier?q=${encodeURIComponent(q)}&tf=${encodeURIComponent(tf)}`),
  analyzeChartVision: (payload: {
    secid?: string;
    query?: string;
    timeframe?: KlineTimeframe;
    chartTab?: 'kline' | 'intraday';
    imageBase64?: string;
    imageMimeType?: string;
    userQuestion?: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
    strategySignals?: any[];
    provider?: string;
  }) =>
    requestJson<{
      ok: boolean;
      analyzedAt: string;
      target: any;
      timeframe: string;
      chartTab: string;
      provider: string;
      providerLabel: string;
      model: string;
      visionMode: 'multimodal' | 'quant_grounded_text';
      visionNotice: string;
      answerMarkdown: string;
      latencyMs: number;
      keyTelemetry: {
        price: number | null;
        pct: number | null;
        trendRegime: string | null;
        r1: number | null;
        s1: number | null;
        poc: number | null;
        stop2N: number | null;
      };
      disclaimer: string;
    }>('/api/ai/chart-vision-analyze', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getShortTermSprite: (side = 'all', limit = 45) =>
    requestJson<any>(`/api/short-term/sprite?side=${encodeURIComponent(side)}&limit=${limit}`),
  getHotRankBoard: (limit = 25) =>
    requestJson<any>(`/api/short-term/hot-rank?limit=${limit}`),
  getShortTermNewsFeeds: () =>
    requestJson<any>('/api/short-term/news-feeds'),
  getCloudTreemaps: () =>
    requestJson<any>('/api/short-term/clouds'),
  getAuctionRadar: () =>
    requestJson<any>('/api/short-term/auction'),
  getDragonTigerList: () =>
    requestJson<any>('/api/short-term/dragon-tiger'),
  getSectorRotationQuadrant: () =>
    requestJson<any>('/api/short-term/rotation'),
  getReviewTraining: () =>
    requestJson<any>('/api/short-term/review-training'),
  saveReviewTraining: (entry: Record<string, any>) =>
    requestJson<any>('/api/short-term/review-training', {
      method: 'POST',
      body: JSON.stringify(entry),
    }),
  // v2.0 Bot 盯盘预警与自定义定时任务
  getBotWatchState: () =>
    requestJson<BotWatchFullState>('/api/bot/watch/state'),
  saveBotWatchSettings: (patch: { enabled?: boolean; forwardTechnicalRules?: boolean; forwardAnomalyRedline?: boolean; pollIntervalSec?: number }) =>
    requestJson<BotWatchFullState>('/api/bot/watch/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  mutateBotWatchAlert: (payload: Record<string, any>) =>
    requestJson<BotWatchFullState>('/api/bot/watch/alerts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  evaluateBotWatchAlertsNow: (ignoreCooldown = false) =>
    requestJson<{ ok: boolean; triggered: BotNotificationItem[]; watchState: BotWatchFullState }>('/api/bot/watch/alerts/evaluate', {
      method: 'POST',
      body: JSON.stringify({ ignoreCooldown }),
    }),
  mutateBotSchedule: (payload: Record<string, any>) =>
    requestJson<BotWatchFullState>('/api/bot/watch/schedules', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  runBotScheduleNow: (id: string) =>
    requestJson<{ ok: boolean; reportText: string; watchState: BotWatchFullState }>('/api/bot/watch/schedules/run', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  markBotNotificationsRead: (ids?: string[]) =>
    requestJson<BotWatchFullState>('/api/bot/watch/notifications/read', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  // 模块一：可插拔数据源管理、Webhook 被动推流与五档/L2 盘口
  getDataSources: () => requestJson<DataSourceConfigResponse>('/api/data-sources'),
  saveDataSources: (patch: Record<string, any>) =>
    requestJson<DataSourceConfigResponse>('/api/data-sources', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  testDataSourceChannel: (channel: DataSourceChannelId, draft?: Record<string, any>) =>
    requestJson<{ ok: boolean; channel: string; mode: string; latencyMs: number; message: string }>(
      '/api/data-sources/test',
      {
        method: 'POST',
        body: JSON.stringify({ channel, draft }),
      }
    ),
  revealFeedWebhookToken: () =>
    requestJson<{ ok: boolean; webhookUrl: string; token: string }>('/api/data-sources/webhook-token', {
      method: 'POST',
      headers: { 'X-SRW-Local-Confirm': 'reveal-token' },
      body: JSON.stringify({}),
    }),
  sendTestWebhookFeed: () =>
    requestJson<{ ok: boolean; acceptedCount: number; totalStored: number }>('/api/feeds/ingest-test', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getIngestedFeeds: (limit = 50) =>
    requestJson<{ ok: boolean; items: any[] }>(`/api/feeds/ingested?limit=${limit}`),
  clearIngestedFeeds: () =>
    requestJson<{ ok: boolean; totalStored: number }>('/api/feeds/ingested/clear', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getStockOrderBook: (secid: string) =>
    requestJson<StockOrderBookResponse>(`/api/market/orderbook?secid=${encodeURIComponent(secid)}`),
  cancelJob: (jobId: string) =>
    requestJson<{ ok: boolean; job?: BackgroundJobSummary }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Stage 4：Python + DuckDB 策略回测实验室
  getQuantEnv: () => requestJson<QuantEnvStatus>('/api/quant/env'),
  saveQuantConfig: (patch: { pythonPath?: string; dataDir?: string; defaultMarket?: string; defaultInitialCash?: number }) =>
    requestJson<QuantEnvStatus>('/api/quant/env/config', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  startQuantEnvSetup: () =>
    requestJson<{ ok: boolean; job: BackgroundJobSummary }>('/api/quant/env/setup', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getQuantDataSummary: () => requestJson<QuantDataSummary>('/api/quant/data/summary'),
  getQuantSymbolBars: (params: { symbol: string; market?: string; start?: string; end?: string; freq?: string }) => {
    const qs = new URLSearchParams();
    qs.set('symbol', params.symbol);
    if (params.market) qs.set('market', params.market);
    if (params.start) qs.set('start', params.start);
    if (params.end) qs.set('end', params.end);
    if (params.freq) qs.set('freq', params.freq);
    return requestJson<{
      ok: boolean;
      symbol: string;
      market: string;
      name: string;
      freq: string;
      bars: { time: string; open: number; high: number; low: number; close: number; volume: number; amount: number }[];
      error?: string;
    }>(`/api/quant/data/bars?${qs.toString()}`);
  },
  startQuantDataSync: (payload: {
    symbols: string[] | string;
    market?: string;
    start?: string;
    end?: string;
    freq?: string;
    source?: string;
    force?: boolean;
  }) =>
    requestJson<{ ok: boolean; job: BackgroundJobSummary }>('/api/quant/data/sync', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  importQuantCsv: (payload: {
    symbol: string;
    market?: string;
    freq?: string;
    filePath?: string;
    csvText?: string;
    fileName?: string;
    volumeMultiplier?: number;
    name?: string;
    colMap?: Record<string, string>;
  }) =>
    requestJson<{ ok: boolean; result: any; summary: QuantDataSummary }>('/api/quant/data/import-csv', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  listQuantStrategies: () => requestJson<{ ok: boolean; strategies: QuantStrategyItem[] }>('/api/quant/strategies'),
  saveQuantStrategy: (payload: Partial<QuantStrategyItem>) =>
    requestJson<{ ok: boolean; strategy: QuantStrategyItem }>('/api/quant/strategies', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteQuantStrategy: (id: string) =>
    requestJson<{ ok: boolean; deletedId: string }>(`/api/quant/strategies/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  generateQuantStrategyFromCards: (payload: {
    cardIds: string[];
    market?: string;
    extraRequirements?: string;
    provider?: AiProvider;
  }) =>
    requestJson<{
      ok: boolean;
      provider: string;
      model: string;
      latencyMs: number;
      draft: { name: string; description: string; cardRefs: string[]; defaultParams: Record<string, any>; code: string };
    }>('/api/quant/strategies/from-cards', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  startQuantBacktest: (spec: Record<string, any>) =>
    requestJson<{ ok: boolean; job: BackgroundJobSummary }>('/api/quant/backtest/run', {
      method: 'POST',
      body: JSON.stringify(spec),
    }),
  cancelQuantBacktest: (jobId: string) =>
    requestJson<{ ok: boolean; job?: BackgroundJobSummary }>(`/api/quant/backtest/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  listQuantRuns: () => requestJson<{ ok: boolean; runs: BacktestRunSummary[] }>('/api/quant/runs'),
  getQuantRun: (runId: string) => requestJson<BacktestResultFull>(`/api/quant/runs/${encodeURIComponent(runId)}`),
  deleteQuantRun: (runId: string) =>
    requestJson<{ ok: boolean; deletedRunId: string }>(`/api/quant/runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
    }),
  listPublishedStrategies: () =>
    requestJson<{
      ok: boolean;
      updatedAt: string | null;
      defaultActiveId: string;
      items: any[];
      presets: any[];
      allStrategies: any[];
    }>('/api/quant/published-strategies'),
  publishLiveStrategy: (payload: Record<string, any>) =>
    requestJson<{ ok: boolean; strategy: any; store: any }>('/api/quant/published-strategies', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deletePublishedStrategy: (id: string) =>
    requestJson<{ ok: boolean; deleted: boolean; store: any }>('/api/quant/published-strategies/delete', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  evaluateStrategySignals: (payload: { strategyId: string; secid?: string; timeframe?: string; klines?: DailyKlinePoint[] }) =>
    requestJson<{
      ok: boolean;
      strategy: { id: string; name: string; engineKind: string };
      signals: { date: string; barIndex: number; side: 'BUY' | 'SELL'; price: number; reason: string; strategyId: string; strategyName: string }[];
      latestSignal: { date: string; side: 'BUY' | 'SELL'; price: number; reason: string; barsAgo: number } | null;
      inPosition: boolean;
      buyCount: number;
      sellCount: number;
    }>('/api/quant/strategy-signals/evaluate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  evaluateStrategyBatch: (payload: { strategyId: string; secids: string[]; timeframe?: string }) =>
    requestJson<{
      ok: boolean;
      strategy: { id: string; name: string; engineKind: string };
      timeframe: string;
      results: Record<
        string,
        {
          secid: string;
          latestSignal: { date: string; side: 'BUY' | 'SELL'; price: number; reason: string; barsAgo: number } | null;
          inPosition: boolean;
          buyCount: number;
          sellCount: number;
        }
      >;
    }>('/api/quant/strategy-signals/batch', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  screenLiveMarketStocks: (payload: Record<string, any>) =>
    requestJson<{
      ok: boolean;
      scannedAt: string;
      totalPoolScanned: number;
      matchedCount: number;
      strategyApplied: { id: string; name: string } | null;
      items: {
        secid: string;
        code: string;
        symbol: string;
        name: string;
        price: number;
        pct: number | null;
        amountYi: number;
        turnoverPct: number;
        volumeRatio: number;
        mainNetYi: number | null;
        latestSignal: { date: string; side: 'BUY' | 'SELL'; price: number; reason: string; barsAgo: number } | null;
        inPosition: boolean;
      }[];
    }>('/api/quant/screen-live', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // A 股半自动交易计划卡 & 可选券商官方 MiniQMT 本地合规插件槽位
  getExecutionSlot: () => requestJson<ExecutionSlotStateResponse>('/api/execution/slot'),
  saveExecutionSlot: (payload: Record<string, any>) =>
    requestJson<ExecutionSlotStateResponse>('/api/execution/slot', {
      method: 'POST',
      headers: { 'X-SRW-Local-Confirm': 'execution-slot-write' },
      body: JSON.stringify(payload),
    }),
  probeExecutionSlot: (payload?: Record<string, any>) =>
    requestJson<MiniQmtProbeResult>('/api/execution/slot/probe', {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    }),
  calcTradePlanCard: (payload: Record<string, any>) =>
    requestJson<Record<string, any>>('/api/execution/plan-card/calc', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // Stage U2：原生目录选择、盘中闪念速记与全量备份 ZIP 还原
  getSidebarSummary: () =>
    requestJson<{
      ok: boolean;
      intelPendingCount: number;
      techAlertCount: number;
      techHighSeverityCount: number;
      enabledTechRules: number;
      unreadBotAlerts: number;
      updatedAt: string;
    }>('/api/workbench/sidebar-summary'),
  pickFolder: (title?: string) =>
    requestJson<{
      ok: boolean;
      cancelled: boolean;
      path: string;
      message?: string;
      error?: string;
      errorCode?: string;
      inProgress?: boolean;
    }>('/api/app/pick-folder', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  listQuickNotes: () => requestJson<{ ok: boolean; items: any[] }>('/api/quick-notes'),
  addQuickNote: (payload: { text: string; symbol?: string; symbolName?: string; tag?: string }) =>
    requestJson<{ ok: boolean; item: any; items: any[] }>('/api/quick-notes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteQuickNote: (id: string) =>
    requestJson<{ ok: boolean; deleted: boolean; items: any[] }>(`/api/quick-notes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  markQuickNoteConverted: (id: string, target: string) =>
    requestJson<{ ok: boolean; item: any; items: any[] }>('/api/quick-notes/convert', {
      method: 'POST',
      body: JSON.stringify({ id, target }),
    }),
  importBackupZip: (zipBase64: string) =>
    requestJson<{
      ok: boolean;
      preRestoreBackupId: string;
      restoredMarkdown: string[];
      restoredState: string[];
      skippedCount: number;
      auditRecorded?: boolean;
      auditError?: string;
    }>('/api/backups/import-zip', {
      method: 'POST',
      headers: { 'X-SRW-Local-Confirm': 'backup-zip-restore' },
      body: JSON.stringify({ zipBase64 }),
    }),
  // Stage U3：机构级操作审计日志
  getAuditTrail: (params?: { category?: string; q?: string; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.category) sp.set('category', params.category);
    if (params?.q) sp.set('q', params.q);
    if (params?.limit) sp.set('limit', String(params.limit));
    const qs = sp.toString();
    return requestJson<{
      ok: boolean;
      total: number;
      filteredTotal: number;
      categoryCounts: Record<string, number>;
      items: {
        id: string;
        timestamp: string;
        category: string;
        action: string;
        summary: string;
        targetIds: string[];
        backupId: string | null;
        actor: string;
      }[];
    }>(`/api/maintenance/audit-trail${qs ? `?${qs}` : ''}`);
  },
  // Three Libraries v2 (kb-v2) 混合检索 / 活视图 / 时效巡检 / 单卡时间轴 / 双模迁移与导出
  kbSearch: (
    params: {
      q?: string;
      ticker?: string;
      regime?: string;
      domain?: string;
      chain?: string;
      kinds?: string | string[];
      limit?: number;
    },
    signal?: AbortSignal
  ) => {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.ticker) sp.set('ticker', params.ticker);
    if (params.regime) sp.set('regime', params.regime);
    if (params.domain) sp.set('domain', params.domain);
    if (params.chain) sp.set('chain', params.chain);
    if (params.kinds) sp.set('kinds', Array.isArray(params.kinds) ? params.kinds.join(',') : params.kinds);
    if (params.limit) sp.set('limit', String(params.limit));
    const qs = sp.toString();
    return requestJson<KbSearchResponse>(`/api/kb/search${qs ? `?${qs}` : ''}`, signal ? { signal } : undefined);
  },
  kbTopics: () =>
    requestJson<{ ok: boolean; kbMode?: 'v1' | 'v2'; topics: KbTopicView[] }>('/api/kb/topics'),
  kbSynthesizeTopic: (topicId: string, provider?: AiProvider) =>
    requestJson<{
      ok: boolean;
      topicId: string;
      draftSummary: string;
      provider?: string;
      model?: string;
      latencyMs?: number;
    }>('/api/kb/topics/synthesize', {
      method: 'POST',
      body: JSON.stringify(provider ? { topicId, provider } : { topicId }),
    }),
  kbSaveTopicSummary: (topicId: string, summaryMarkdown: string) =>
    requestJson<{ ok: boolean; topic?: KbTopicView; filePath?: string }>('/api/kb/topics/save-summary', {
      method: 'POST',
      body: JSON.stringify({ topicId, summaryMarkdown }),
    }),
  kbStale: (date?: string) =>
    requestJson<{ ok?: boolean } & KbStaleReport>(
      `/api/kb/stale${date ? `?date=${encodeURIComponent(date)}` : ''}`
    ),
  kbCardTimeline: (id: string) =>
    requestJson<KbCardTimelineResponse>(`/api/kb/card/timeline?id=${encodeURIComponent(id)}`),
  kbMigrateFromV1: (force = false) =>
    requestJson<{
      ok: boolean;
      kbDir?: string;
      kbMode?: 'v2';
      summary?: Record<string, any>;
      stats?: Record<string, any>;
      verified?: boolean;
      message?: string;
    }>('/api/kb/migrate-from-v1', {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  kbExportMonolith: () =>
    requestJson<{
      ok: boolean;
      methodologySnapshot?: { path: string; bytes: number; cardCount: number; conflictCount: number };
      cognitionSnapshot?: { path: string; bytes: number; cardCount: number };
      files?: string[];
      message?: string;
    }>('/api/kb/export-monolith', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
};
