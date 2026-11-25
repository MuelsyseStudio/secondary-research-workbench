export interface HeaderMeta {
  version: string;
  syncDate: string;
  latestReviewDate: string;
  companionLine: string;
  revisionSummaries: string[];
  htmlComment: string;
}

export interface CrossReferences {
  methodIds: string[];
  cognitionIds: string[];
  conflictIds: string[];
}

export interface AmendmentItem {
  label: string;
  content: string;
  line: number;
}

export interface ReviewLogItem {
  label: string;
  date: string;
  content: string;
  line: number;
}

export interface MethodologyCard {
  id: string;
  num: number;
  rawHeading: string;
  title: string;
  system: string;
  topic: string;
  batchTag: string;
  sectionTitle: string;
  sectionIndex: number;
  anchorId: string;
  startLine: number;
  endLine: number;
  coreThesis: string;
  logicChain: string;
  applicableConditions: string;
  invalidationSignals: string;
  historicalCases: string;
  credibilityRaw: string;
  credibilityScore: number | null;
  source: string;
  otherFields: { label: string; content: string }[];
  isRevoked: boolean;
  isArchived: boolean;
  isHighPaused: boolean;
  isPendingVerify: boolean;
  isPendingRetire: boolean;
  amendments: AmendmentItem[];
  reviewLogs: ReviewLogItem[];
  references: CrossReferences;
  rawMarkdown: string;
  v2Meta?: MethodologyV2Meta;
}

export interface ConflictItem {
  id: number;
  anchorId: string;
  rawHeading: string;
  title: string;
  versionTag: string;
  sides: string;
  conflictPoint: string;
  resolution: string;
  relatedMethodIds: string[];
  relatedCognitionIds: string[];
  startLine: number;
  endLine: number;
  rawMarkdown: string;
}

export interface MethodologyData {
  meta: HeaderMeta;
  fileSize: number;
  lineCount: number;
  sha256: string;
  stats: {
    totalTitles: number;
    activeCount: number;
    revokedCount: number;
    declaredMissing: string[];
    conflictCount: number;
    sectionCount: number;
    nextCardId: string;
    nextConflictId: number;
    highCredCount: number;
    withReviewsCount: number;
    pendingVerifyCount: number;
    pendingRetireCount: number;
  };
  sections: { title: string; anchor: string; index: number; startLine: number }[];
  cards: MethodologyCard[];
  conflicts: ConflictItem[];
  ingestionLogs: { title: string; anchor: string; startLine: number; content: string }[];
}

export interface ResearchArchiveLink {
  date: string;
  title: string;
  relativePath: string;
  exists: boolean;
  summary: string;
}

export interface CognitionCard {
  id: string;
  num: number;
  rawHeading: string;
  title: string;
  ingestedDate: string;
  categoryTag: string;
  batchTitle: string;
  anchorId: string;
  startLine: number;
  endLine: number;
  facts: string;
  source: string;
  evidenceLevelRaw: string;
  evidenceGrades: string[];
  primaryGrade: string;
  industryImplications: string;
  aShareMapping: string;
  confidence: string;
  invalidationConditions: string;
  updateLog: string;
  relatedRaw: string;
  otherFields: { label: string; content: string }[];
  isArchived: boolean;
  isPartiallyFalsified: boolean;
  updatedToId: string | null;
  amendments: AmendmentItem[];
  references: CrossReferences;
  rawMarkdown: string;
  v2Meta?: CognitionV2Meta;
}

export interface CognitionData {
  meta: HeaderMeta;
  fileSize: number;
  lineCount: number;
  sha256: string;
  stats: {
    totalCount: number;
    nextCardId: string;
    gradeACount: number;
    gradeBCount: number;
    gradeCCount: number;
    archivedCount: number;
    falsifiedCount: number;
    withAmendmentsCount: number;
    batchCount: number;
  };
  researchArchives: ResearchArchiveLink[];
  batches: { title: string; anchor: string; startLine: number }[];
  cards: CognitionCard[];
  updateLogs: { title: string; content: string; startLine: number }[];
}

export interface LedgerSubsection {
  title: string;
  content: string;
}

export interface JudgmentEntry {
  id: string;
  type: 'judgment';
  recordKey: string;
  title: string;
  suffix: string;
  target: string;
  stockCode?: string;
  stockName?: string;
  targetKey?: string;
  targetDisplayName?: string;
  sameTargetCount?: number;
  relatedJudgmentIds?: string[];
  date: string;
  score: number | null;
  conclusion: string;
  hypotheses: { id: string; content: string }[];
  isLegacyRef: boolean;
  anchor: string;
  subsections: LedgerSubsection[];
  references: CrossReferences;
  startLine: number;
  endLine: number;
  rawMarkdown: string;
}

export interface TargetJudgmentGroup {
  targetKey: string;
  stockCode: string;
  stockName: string;
  displayName: string;
  judgmentIds: string[];
  backfillIds: string[];
  dailyMentions: { id: string; date: string; score: number | null; title: string }[];
  scoreSeries: { id: string; recordKey: string; date: string; score: number }[];
  count: number;
  latestDate: string;
  latestScore: number | null;
}

export interface BackfillEntry {
  id: string;
  type: 'backfill';
  recordKey: string;
  title: string;
  date: string;
  isPostHoc: boolean;
  isLegacyRef: boolean;
  anchor: string;
  subsections: LedgerSubsection[];
  references: CrossReferences;
  startLine: number;
  endLine: number;
  rawMarkdown: string;
}

export interface DailyReviewEntry {
  id: string;
  type: 'daily';
  date: string;
  title: string;
  fullTitle: string;
  anchor: string;
  score: number | null;
  marketState: string;
  nextAnchors: string[];
  gaps: string[];
  pendingOptNote: string;
  anchorChecks: { anchor: string; preset: string; evidence: string; verdict: string }[];
  credibilityEntries: { cardId: string; statusText: string; detail: string }[];
  subsections: LedgerSubsection[];
  references: CrossReferences;
  startLine: number;
  endLine: number;
  rawMarkdown: string;
}

export interface PendingSuggestion {
  num: string;
  name: string;
  targetCard: string;
  proposedDate: string;
  summary: string;
  evidenceMentions: number;
  status: string;
}

export interface LedgerData {
  meta: HeaderMeta;
  fileSize: number;
  lineCount: number;
  sha256: string;
  frameworkAmendments: { index: string; text: string }[];
  stats: {
    judgmentCount: number;
    backfillCount: number;
    dailyReviewCount: number;
    latestDailyDate: string;
    latestDailyScore: number | null;
    nextJudgmentKey: string;
    openGapCount: number;
    pendingSuggestionCount: number;
  };
  judgments: JudgmentEntry[];
  backfills: BackfillEntry[];
  targetGroups?: TargetJudgmentGroup[];
  dailyReviews: DailyReviewEntry[];
  scoreTimeline: { date: string; score: number; title: string }[];
  pendingSuggestions: PendingSuggestion[];
  latestDailySummary: {
    date: string;
    title: string;
    score: number | null;
    marketState: string;
    nextAnchors: string[];
    gaps: string[];
    pendingOptNote: string;
  } | null;
}

export interface BacklinkItem {
  type: 'methodology' | 'cognition' | 'conflict' | 'judgment' | 'daily';
  id: string;
  label: string;
}

export interface HighFreqCard {
  id: string;
  title: string;
  system: string;
  credibilityScore: number | null;
  credibilityRaw: string;
  reviewCount: number;
  latestReviewDate: string;
  latestReviewContent: string;
  isArchived: boolean;
  isHighPaused: boolean;
  isPendingRetire: boolean;
}

export interface EvidenceFileMeta {
  name: string;
  review_date?: string;
  mode?: string;
  factCount?: number;
}

export interface WorkspaceData {
  loadedAt: string;
  paths: {
    projectRoot: string;
    methodology: string;
    cognition: string;
    ledger: string;
  };
  methodology: MethodologyData;
  cognition: CognitionData;
  ledger: LedgerData;
  backlinks: {
    methodBacklinks: Record<string, BacklinkItem[]>;
    cognitionBacklinks: Record<string, BacklinkItem[]>;
  };
  highFreqCards: HighFreqCard[];
  evidenceFiles: EvidenceFileMeta[];
  kbMode?: 'v1' | 'v2';
  kbSummary?: KbSummary;
  topics?: KbTopicView[];
  staleReport?: KbStaleReport;
}

export interface AuditIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  target: string;
  title: string;
  detail: string;
  suggestion: string;
  fixAction: string | null;
}

export interface AuditReport {
  summary: {
    checkedAt: string;
    errorCount: number;
    warningCount: number;
    infoCount: number;
    passedChecks: string[];
    versions: { methodology: string; cognition: string; ledger: string };
  };
  issues: AuditIssue[];
}

export interface DiffLine {
  type: 'eq' | 'add' | 'del';
  oldLine: number;
  newLine: number;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
  truncated: number;
}

export interface MutationPreview {
  ok: boolean;
  action: string;
  date: string;
  validationErrors: string[];
  summaryBullets: string[];
  diffs: {
    key: string;
    label: string;
    versionBefore: string;
    versionAfter: string;
    diff: {
      fileName: string;
      added: number;
      removed: number;
      hunks: DiffHunk[];
    };
  }[];
}

export interface BackupManifest {
  backupId: string;
  createdAt: string;
  action: string;
  summary: string[];
  files: {
    key: string;
    label: string;
    sha256Before: string;
    sha256After: string;
    versionBefore: string;
    versionAfter: string;
  }[];
}

export interface EvidenceFact {
  id: string;
  metric: string;
  date: string;
  kind?: 'same_day' | 'prior';
  state: 'observed' | 'archived' | 'missing' | 'conflict' | 'not_applicable';
  value: number | null;
  unit?: string;
  scope?: string;
  source?: string;
  chain?: string;
  available_at?: string | null;
  reason?: string;
  subtract_pp?: [string, string];
}

export interface EvidenceRecord {
  review_date: string;
  mode: 'daily' | 'archive_replay';
  cutoff: string | null;
  facts: EvidenceFact[];
}

export interface EvidenceCheckResult {
  ok: boolean;
  status: string;
  errors: string[];
  items: { id: string; metric: string; status: string }[];
  calculations: { id: string; recomputed: number; unit: string }[];
  chains: string[];
}

export type MarketKind = 'CN' | 'US' | 'HK' | 'TW' | 'KR' | 'FR' | 'UK' | 'JP' | 'DE' | 'FUT' | 'CRYPTO';
export type CurrencyCode = 'CNY' | 'USD' | 'HKD' | 'TWD' | 'KRW' | 'EUR' | 'GBP' | 'GBp' | 'JPY' | 'PTS' | 'USDT';
export type WorkbenchMode = 'research' | 'short_term';

export type ActiveTab =
  | 'dashboard'
  | 'watchlist'
  | 'technical'
  | 'trades'
  | 'backtest'
  | 'intel'
  | 'methodology'
  | 'cognition'
  | 'ledger'
  | 'maintenance'
  | 'st_watch'
  | 'st_ladder'
  | 'st_clouds'
  | 'st_anomaly'
  | 'st_themes'
  | 'st_lhb';

export interface EntityRef {
  kind: 'methodology' | 'cognition' | 'conflict' | 'judgment' | 'daily';
  id: string;
}

export interface IntradayPoint {
  t: string;
  p: number;
  a: number;
  c: number;
}

export interface IntradayAnalysis {
  available: boolean;
  barCount: number;
  openPct?: number;
  closePct?: number;
  amplitudePct?: number;
  closePosPct?: number;
  firstMinAmtYi?: number | null;
  dayHigh?: { price: number; time: string; pct: number | null };
  dayLow?: { price: number; time: string; pct: number | null };
  amSession?: {
    high: { price: number; time: string };
    low: { price: number; time: string };
    close: number;
    closePct: number;
  } | null;
  pmEarlyHigh?: { price: number; time: string; pct: number } | null;
  maxUp10m?: { deltaPct: number; deltaPts: number; fromTime: string; toTime: string } | null;
  maxDown10m?: { deltaPct: number; deltaPts: number; fromTime: string; toTime: string } | null;
  aboveAvgRatioPct?: number;
  tail30mPct?: number;
  tailDirection?: string;
  sparkline?: IntradayPoint[];
}

export interface DailyAuthBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  preClose: number | null;
  pct: number | null;
  amountYi: number | null;
  prevAmountYi?: number | null;
  turnoverPct?: number | null;
}

export interface IndexPacketItem {
  code: string;
  secid: string;
  name: string;
  dailyAuth: DailyAuthBar;
  intradayDate: string;
  intradaySource: string;
  dailySource: string;
  intraday: IntradayAnalysis;
}

export interface WatchStockPacketItem {
  code: string;
  fullCode: string;
  name: string;
  role: string;
  dailyAuth: DailyAuthBar;
  intradayDate: string;
  intradaySource: string;
  intraday: IntradayAnalysis;
}

export interface MarketPacket {
  fetchedAt: string;
  requestedDate: string;
  actualTradeDate: string;
  dateMismatchWarning: string | null;
  totalIntradayBars: number;
  marketSummary: {
    twoMarketAmtYi: number | null;
    prevTwoMarketAmtYi: number | null;
    volDeltaYi: number | null;
    volDeltaPct: number | null;
    breadth: {
      ok: boolean;
      source?: string;
      up?: number;
      down?: number;
      flat?: number;
      total?: number;
      redRatePct?: number | null;
      shAmtYi?: number | null;
      szAmtYi?: number | null;
      bjAmtYi?: number | null;
      error?: string;
    };
  };
  indices: IndexPacketItem[];
  limitPools: {
    ok: boolean;
    source: string;
    actualDate?: string;
    ztCount: number | null;
    dtCount: number | null;
    zbCount: number | null;
    sealRatePct: number | null;
    burstRatePct: number | null;
    maxBoard: number;
    lianbanCount: number;
    boardLadder: {
      board: number;
      count: number;
      stocks: {
        code: string;
        name: string;
        stat: string;
        industry: string;
        boardStyle: string;
        firstSealTime: string;
        turnoverPct: number | null;
        amountYi: number | null;
      }[];
    }[];
    clustersGe3: {
      industry: string;
      count: number;
      maxBoard: number;
      lianbanStocks: string[];
      sampleStocks: string[];
    }[];
    dtStocks: { code: string; name: string; industry: string; days: number; sealFundYi: number | null }[];
    zbSample: { code: string; name: string; industry: string; pct: number | null; openCount: number }[];
    error?: string;
  };
  watchStocks: WatchStockPacketItem[];
  usOvernight: {
    ok: boolean;
    source: string;
    items: { code: string; name: string; close: number; pct: number; tradeTimeET: string }[];
  };
  evidenceRecord: EvidenceRecord;
  evidenceCheck: EvidenceCheckResult;
}

export type AiProvider =
  | 'codex_cli'
  | 'gemini_cli'
  | 'deepseek'
  | 'qwen'
  | 'moonshot'
  | 'zhipu'
  | 'gemini'
  | 'openai'
  | 'custom';

export interface LocalCliStatus {
  command: string;
  model: string;
  reasoningEffort?: string;
  installed: boolean;
  version: string;
  loggedIn: boolean;
  authStatus: string;
}

export interface SafeApiProviderConfig {
  label?: string;
  hasApiKey: boolean;
  maskedKey: string;
  baseUrl: string;
  model: string;
  enableGoogleSearch?: boolean;
}

export interface AiSafeConfig {
  hasSavedConfig?: boolean;
  watchStocksConfigured?: boolean;
  watchStocksSource?: 'user' | 'legacy_unconfirmed' | 'unset';
  watchStocksLegacyPendingConfirm?: boolean;
  legacyWatchStocks?: string[];
  provider: AiProvider;
  temperature: number;
  watchStocks: string[];
  codex_cli: LocalCliStatus;
  gemini_cli: LocalCliStatus;
  deepseek: SafeApiProviderConfig;
  qwen: SafeApiProviderConfig;
  moonshot: SafeApiProviderConfig;
  zhipu: SafeApiProviderConfig;
  gemini: SafeApiProviderConfig & { enableGoogleSearch: boolean };
  openai: SafeApiProviderConfig;
  custom: SafeApiProviderConfig & { label: string };
}

export interface QuickDraftNotePayload {
  noteId: string;
  target: 'cognition' | 'method' | 'judgment';
  symbol: string;
  symbolName: string;
  tag: string;
  text: string;
  createdAt: string;
  nonce: number;
}

export interface BenchmarkIndexItem {
  secid: string;
  code: string;
  name: string;
  nameEn?: string;
  marketKind: MarketKind;
  price: number | null;
  pct: number | null;
  chg: number | null;
  high: number | null;
  low: number | null;
  preClose: number | null;
  amplitudePct: number | null;
  amountYi: number | null;
  tradeTime?: string;
}

export interface StockResearchPacket {
  ok: boolean;
  collectedAt: string;
  target: {
    resolved: boolean;
    rawQuery: string;
    marketKind?: 'CN' | 'US' | 'HK';
    currency?: 'CNY' | 'USD' | 'HKD';
    secid?: string;
    code: string;
    market: string;
    secuCode: string;
    f10Code: string;
    usF10Code?: string;
    name: string;
    boardType: string;
  };
  snapshot: StockSnapshot | null;
  profile: {
    orgName: string;
    secType: string;
    emIndustry: string;
    csrcIndustry: string;
    hShareCode: string | null;
    chairman: string;
    mainBusiness: string;
    grade: string;
  } | null;
  concepts: string[];
  coreHighlights: { keyword: string; detail: string }[];
  financials: {
    period: string;
    noticeDate: string;
    currency?: string;
    revenueYi: number | null;
    revenueUsdB?: number | null;
    revenueYoyPct: number | null;
    parentNetProfitYi: number | null;
    parentNetProfitUsdB?: number | null;
    parentNetProfitYoyPct: number | null;
    deductNetProfitYi: number | null;
    deductNetProfitYoyPct: number | null;
    grossMarginPct: number | null;
    netMarginPct: number | null;
    roePct: number | null;
    debtRatioPct: number | null;
    eps: number | null;
    ocfPerShare: number | null;
    currentRatio?: number | null;
    inventoryDays?: number | null;
    grade: string;
  }[];
  businessBreakdown: {
    reportDate: string;
    dimension: string;
    item: string;
    revenueYi: number | null;
    revenueSharePct: number | null;
    grossMarginPct: number | null;
    grade: string;
  }[];
  shareholders: {
    gdrs: {
      endDate: string;
      holderCount: number | null;
      holderChangePct: number | null;
      concentration: string;
      avgHoldAmtWan: number | null;
    }[];
    lockups: {
      unlockDate: string;
      sharesWan: number | null;
      ratioOfTotalPct: number | null;
      type: string;
    }[];
    topHolders: { name: string; ratioPct: number | null; change: string }[];
    grade: string;
  } | null;
  announcements: { date: string; category: string; title: string; url: string; grade: string }[];
  brokerReports: {
    date: string;
    org: string;
    title: string;
    rating: string;
    epsThisYear: number | null;
    peThisYear: number | null;
    epsNextYear: number | null;
    peNextYear: number | null;
    epsNextTwoYear: number | null;
    url: string;
    grade: string;
  }[];
  news: { date: string; title: string; media: string; summary: string; url: string; grade: string }[];
  crossMarketBenchmarks?: BenchmarkIndexItem[];
  counts: {
    financialPeriods: number;
    announcements: number;
    brokerReports: number;
    news: number;
  };
  errors: string[];
}

export interface ExtractedDoc {
  fileName: string;
  ext: string;
  sizeBytes: number;
  pageCount: number | null;
  originalChars: number;
  extractedChars: number;
  truncated: boolean;
  warnings: string[];
  text: string;
}

export interface AiIngestionResult {
  summary: string;
  newCards: Record<string, any>[];
  amendments: {
    cardId: string;
    cardTitle: string;
    batchNote: string;
    content: string;
    valid: boolean;
  }[];
  conflicts: {
    title: string;
    sides: string;
    conflictPoint: string;
    resolution: string;
  }[];
  discarded: { item: string; reason: string }[];
  warnings: string[];
}

export interface StockSnapshot {
  ok: boolean;
  fetchedAt?: string;
  source?: string;
  marketKind?: MarketKind;
  currency?: CurrencyCode;
  secid?: string;
  code: string;
  name?: string;
  tradeDate?: string;
  close?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  preClose?: number | null;
  pct?: number | null;
  amountYi?: number | null;
  amountUsdM?: number | null;
  amountUsdB?: number | null;
  volume?: number | null;
  turnoverPct?: number | null;
  volumeRatio?: number | null;
  amplitudePct?: number | null;
  totalCapYi?: number | null;
  totalCapUsdB?: number | null;
  floatCapYi?: number | null;
  peTtm?: number | null;
  pb?: number | null;
  ma5?: number | null;
  ma10?: number | null;
  ma20?: number | null;
  aboveMa5?: boolean | null;
  ma5BiasPct?: number | null;
  ret5dPct?: number | null;
  ret20dPct?: number | null;
  high20d?: number | null;
  low20d?: number | null;
  error?: string;
}

export interface SecuritySearchItem {
  resolved: boolean;
  marketKind: MarketKind;
  currency: CurrencyCode;
  mktNum: string;
  secid: string;
  code: string;
  market: string;
  secuCode: string;
  name: string;
  nameEn?: string;
  boardType: string;
  classify: string;
}

export interface WatchlistItem {
  secid: string;
  code: string;
  secuCode: string;
  name: string;
  marketKind: MarketKind;
  currency: CurrencyCode;
  exchange?: string;
  group: string;
  note: string;
}

export interface WatchlistIntradayPoint {
  t: string;
  p: number;
  a: number | null;
  v: number | null;
  up: boolean;
}

export interface WatchlistIntradayData {
  available: boolean;
  barCount: number;
  preClose: number | null;
  tradeDate: string;
  firstTime?: string;
  lastTime?: string;
  aboveAvgRatioPct?: number | null;
  points: WatchlistIntradayPoint[];
}

export interface WatchlistQuoteItem extends WatchlistItem {
  price: number | null;
  preClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  pct: number | null;
  chg: number | null;
  volume: number | null;
  amount: number | null;
  amountYi: number | null;
  amountUsdM: number | null;
  amountUsdB: number | null;
  amplitudePct: number | null;
  turnoverPct: number | null;
  peTtm: number | null;
  volumeRatio: number | null;
  pb: number | null;
  totalCapYi: number | null;
  totalCapUsdB: number | null;
  closePosPct: number | null;
  intraday: WatchlistIntradayData | null;
}

export interface CrossMarketPairConfig {
  id: string;
  title: string;
  usSecids: string[];
  cnSecids: string[];
  methodCards: string[];
  note: string;
}

export interface CrossMarketPairLive extends CrossMarketPairConfig {
  usLegs: { secid: string; code: string; name: string; price: number | null; pct: number | null }[];
  cnLegs: { secid: string; code: string; name: string; price: number | null; pct: number | null }[];
  usAvgPct: number | null;
  cnAvgPct: number | null;
  spreadPct: number | null;
  signal: string;
  signalTone: string;
}

export interface WatchlistLiveResponse {
  ok: boolean;
  workspaceRoot?: string;
  fetchedAt: string;
  benchmarks: BenchmarkIndexItem[];
  items: WatchlistQuoteItem[];
  crossPairs: CrossMarketPairLive[];
  summary: {
    total: number;
    cnCount: number;
    usCount: number;
    hkCount: number;
    globalCount?: number;
    futCount?: number;
    cryptoCount?: number;
    upCount: number;
    downCount: number;
  };
}

export interface DailyKlinePoint {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  vol: number | null;
  amt: number | null;
  ampPct: number | null;
  pct: number | null;
  chg: number | null;
  turnoverPct: number | null;
}

export type KlineTimeframe = 'day' | 'week' | '60m' | '15m' | '1m';

export interface TrendlineSegment {
  school: 'victor' | 'demark';
  kind: 'resistance' | 'support';
  label: string;
  cardId: string;
  x1: number;
  y1: number;
  date1: string;
  x2: number;
  y2: number;
  date2: string;
  endX: number;
  currentPrice: number | null;
  distPct: number | null;
  targetPrice?: number | null;
  slopePerBar: number | null;
  status: string;
  broken: boolean;
}

export interface RegressionChannel {
  school: 'regression';
  cardId: string;
  startX: number;
  endX: number;
  startDate: string;
  endDate: string;
  startMid: number;
  endMid: number;
  startUpper: number;
  endUpper: number;
  startLower: number;
  endLower: number;
  sigma: number;
  rSquared: number;
  slopePctTotal: number;
  posPct: number;
  direction: string;
  zoneLabel: string;
}

export interface TrendlineAnalysis {
  windowStartIdx: number;
  victor: {
    downLine: TrendlineSegment | null;
    upLine: TrendlineSegment | null;
  };
  demark: {
    supplyLine: TrendlineSegment | null;
    demandLine: TrendlineSegment | null;
    lowerChannel?: TrendlineSegment | null;
  };
  regressionChannel: RegressionChannel | null;
  patternLabel: string;
  signals: {
    vicUpBreakdown: number;
    vicDownBreakout: number;
    tdDemandBreakdown: number;
    tdSupplyBreakout: number;
    regChannelPosPct: number | null;
  };
}

export interface SecurityDetailData {
  ok: boolean;
  fetchedAt: string;
  timeframe?: KlineTimeframe;
  secid: string;
  code: string;
  secuCode: string;
  marketKind: MarketKind;
  currency: CurrencyCode;
  name: string;
  quote: {
    price: number | null;
    preClose: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    pct: number | null;
    chg: number | null;
    volume: number | null;
    amountYi: number | null;
    amountUsdM: number | null;
    amplitudePct: number | null;
    turnoverPct: number | null;
    volumeRatio: number | null;
    peTtm: number | null;
    pb: number | null;
    totalCapYi: number | null;
    totalCapUsdB: number | null;
    ma5: number | null;
    ma10: number | null;
    ma20: number | null;
    ma5BiasPct: number | null;
    ret5dPct: number | null;
    ret20dPct: number | null;
  };
  intraday: WatchlistIntradayData;
  klines: DailyKlinePoint[];
  trendlines?: TrendlineAnalysis | null;
  tradeMarkers?: SymbolTradeMarkers | null;
  drawings?: ChartDrawing[];
  drawingAlerts?: ChartDrawingAlert[];
}

export interface TechnicalMetricOption {
  key: string;
  label: string;
  scope: 'market_sentiment' | 'stock_peak';
  unit: string;
  desc: string;
}

export interface TechnicalAlertRule {
  id: string;
  name: string;
  scope: 'market_sentiment' | 'stock_peak';
  metric: string;
  operator: '>=' | '<=' | '>' | '<' | '==';
  threshold: number;
  severity: 'high' | 'medium' | 'info';
  enabled: boolean;
  sourceCardId: string;
  sourceCardTitle: string;
  actionAdvice: string;
}

export interface TriggeredTechnicalAlert {
  ruleId: string;
  ruleName: string;
  scope?: 'market_sentiment' | 'stock_peak';
  metric: string;
  actualValue: number;
  operator: string;
  threshold: number;
  severity: 'high' | 'medium' | 'info';
  sourceCardId: string;
  sourceCardTitle: string;
  actionAdvice: string;
  secid?: string;
  secuCode?: string;
  stockName?: string;
  marketKind?: MarketKind;
  currency?: CurrencyCode;
  price?: number | null;
  pct?: number | null;
}

export interface MarketSentimentSnapshot {
  fetchedAt: string;
  up: number | null;
  down: number | null;
  flat: number | null;
  redRatePct: number | null;
  twoMarketAmtYi: number | null;
  ztCount: number | null;
  dtCount: number | null;
  zbCount: number | null;
  sealRatePct: number | null;
  burstRatePct: number | null;
  maxBoard: number;
  lianbanCount: number;
  topLeaders: { code: string; name: string; board: number; industry: string }[];
  sentimentScore: number;
  stage: string;
}

export interface TechnicalIndicators {
  price: number;
  preClose: number | null;
  pct: number | null;
  turnoverPct: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  ma5BiasPct: number | null;
  ma20BiasPct: number | null;
  ma60BiasPct: number | null;
  macdDif: number | null;
  macdDea: number | null;
  macdHist: number | null;
  macdTopDivergence: number;
  rsi6: number | null;
  rsi14: number | null;
  bollUpper: number | null;
  bollMid: number | null;
  bollLower: number | null;
  bollPosPct: number | null;
  atr14: number | null;
  atrPct: number | null;
  volRatio5d: number | null;
  upperShadowPct: number;
  lowerShadowPct: number;
  is2BTopSignal: number;
  isHighVolStall: number;
  vicUpBreakdown?: number;
  vicDownBreakout?: number;
  tdDemandBreakdown?: number;
  tdSupplyBreakout?: number;
  regChannelPosPct?: number | null;
  ret5dPct: number | null;
  ret20dPct: number | null;
  consecutiveUpDays: number;
  high20d: number | null;
  low20d: number | null;
  high60d: number | null;
  low60d: number | null;
  trendRegime: string;
}

export interface SupportResistanceLevel {
  code: string;
  price: number;
  distPct: number;
  kind: 'resistance' | 'support' | 'pivot';
  strength: '强共振' | '中级' | '参考';
  resonanceCount: number;
  score: number;
  schools: string[];
  cardIds: string[];
  labels: string[];
  primaryLabel: string;
}

export interface VolumeProfileBin {
  priceLow: number;
  priceHigh: number;
  priceMid: number;
  volume: number;
  pctOfMax: number;
}

export interface TechnicalAnalysisResponse {
  ok: boolean;
  analyzedAt: string;
  timeframe: KlineTimeframe;
  totalBars: number;
  target: {
    secid: string;
    code: string;
    secuCode: string;
    name: string;
    marketKind: MarketKind;
    currency: CurrencyCode;
    exchange?: string;
  };
  indicators: TechnicalIndicators;
  levels: {
    resistances: SupportResistanceLevel[];
    pivots: SupportResistanceLevel[];
    supports: SupportResistanceLevel[];
    volumeProfile: {
      bins: VolumeProfileBin[];
      poc: number | null;
      vah: number | null;
      val: number | null;
    };
    turtleStop2N: number | null;
    rewardRiskRatio: number | null;
    markdownSummary: string;
  };
  trendlines?: TrendlineAnalysis | null;
  tradeMarkers?: SymbolTradeMarkers | null;
  drawings?: ChartDrawing[];
  drawingAlerts?: ChartDrawingAlert[];
  triggeredAlerts: TriggeredTechnicalAlert[];
  klines: DailyKlinePoint[];
}

export interface StockRadarScanItem {
  secid: string;
  code: string;
  secuCode: string;
  name: string;
  marketKind: MarketKind;
  currency: CurrencyCode;
  price: number | null;
  pct: number | null;
  ma5BiasPct: number | null;
  ma20BiasPct: number | null;
  rsi6: number | null;
  volRatio5d: number | null;
  ret5dPct: number | null;
  macdTopDivergence: number;
  is2BTopSignal: number;
  isHighVolStall: number;
  trendRegime: string;
  alerts: TriggeredTechnicalAlert[];
}

export interface TechnicalRadarResponse {
  ok: boolean;
  fetchedAt: string;
  sentiment: MarketSentimentSnapshot;
  sentimentChain?: {
    current: SentimentNodeEntry;
    history: SentimentNodeEntry[];
    updatedAt: string | null;
  };
  driftAudit?: RuleCardDriftAudit;
  marketAlerts: TriggeredTechnicalAlert[];
  stockAlerts: TriggeredTechnicalAlert[];
  stockScans: StockRadarScanItem[];
  summary: {
    totalAlerts: number;
    highSeverityCount: number;
    alertedStockCount: number;
    scannedStockCount: number;
  };
}

export interface BackgroundJobSummary {
  id: string;
  kind:
    | 'daily_review'
    | 'ingest_methodology'
    | 'ingest_cognition'
    | 'judgment_draft'
    | 'intel_digest'
    | 'quant_sync'
    | 'quant_backtest'
    | 'quant_setup';
  title: string;
  stage?: string;
  pct?: number;
  logs?: { time: string; level: string; msg: string }[];
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  meta: Record<string, any>;
  error: string | null;
  hasResult: boolean;
}

export interface BackgroundJobDetail extends BackgroundJobSummary {
  result: any;
}

export interface AutoReviewResult {
  ok: boolean;
  form: Record<string, any>;
  reconcile?: ReconcileReport | null;
  auditTrail: {
    provider: string;
    model: string;
    latencyMs: number;
    tradeDate: string;
    intradayBarsGrounded: number;
    fetchedAt: string;
    usage?: Record<string, any> | null;
    groundingSources?: { title: string; uri: string }[];
    warnings: string[];
  };
}

// ============================================================================
// P0 / P1 / P2 全量演进类型定义
// ============================================================================

export interface ReconcileItem {
  id: string;
  field: string;
  fieldLabel: string;
  metricLabel: string;
  aiValue: string;
  authValue: string;
  diffText: string;
  status: 'pass' | 'drift' | 'info';
  severity: 'ok' | 'low' | 'medium' | 'high';
  snippet: string;
  replacement: string;
  autoFixable: boolean;
}

export interface ReconcileReport {
  checkedCount: number;
  driftCount: number;
  passCount: number;
  items: ReconcileItem[];
  fullTagCrossCheck?: {
    tags: string[];
    draggingSignals: string[];
    regulatory: { hit: boolean; hits: RegulatoryWatchItem[]; summary: string };
    overseasDivergence: { usAvgPct: number; cnAvgPct: number; stockPct: number; spreadVsUs: number } | null;
  };
}

export interface RegulatoryWatchItem {
  id: string;
  code: string;
  name: string;
  reason: string;
  level: 'ban' | 'monitor' | 'warning';
  startDate: string;
  endDate: string;
  active: boolean;
}

export interface SentimentNodeEntry {
  date: string;
  recordedAt: string;
  sentimentScore: number;
  redRatePct: number | null;
  ztCount: number | null;
  dtCount: number | null;
  burstRatePct: number | null;
  maxBoard: number;
  twoMarketAmtYi: number | null;
  node: string;
  prevNode: string | null;
  scoreDelta: number;
  channel: 'attack_ok' | 'trial_only' | 'realize_only' | 'forbidden_new';
  channelLabel: string;
  maxPositionPct: number;
  colorTone: string;
  boundCards: string[];
  actionNote: string;
}

export interface RuleCardDriftAudit {
  ok: boolean;
  trackedCount: number;
  totalCardLinked: number;
  driftedCount: number;
  cardVersion: string;
  driftedRules: {
    ruleId: string;
    ruleName: string;
    sourceCardId: string;
    sourceCardTitle: string;
    savedHash: string;
    currentHash: string;
    credibilityScore: number | null;
  }[];
}

export interface PreflightInboxItem {
  id: string;
  severity: 'high' | 'medium' | 'info';
  category: string;
  title: string;
  detail: string;
  actionTab: ActiveTab;
  actionEntity: EntityRef | null;
}

export interface StopLossCoverage {
  withMarketData: boolean;
  openHoldingsCount: number;
  trackedStopCount: number;
  verifiedCount: number;
  unverifiedCount: number;
  triggeredCount: number;
  quoteAsOf: string | null;
  status: 'no_stop_holdings' | 'verified_ok' | 'triggered' | 'unverified';
  error: string | null;
}

export interface PreflightReport {
  ok: boolean;
  checkedAt: string;
  today: string;
  latestSentimentNode: SentimentNodeEntry | null;
  stopLossCoverage?: StopLossCoverage;
  summary: {
    totalItems: number;
    highCount: number;
    mediumCount: number;
    dueHypCount: number;
    soonHypCount: number;
    driftedRuleCount: number;
    regulatoryCount: number;
    vetoCount: number;
    unverifiedStopCount?: number;
    triggeredStopCount?: number;
  };
  items: PreflightInboxItem[];
}

export interface ForwardPerf {
  matched: boolean;
  entryDate?: string | null;
  entryPrice?: number | null;
  latestDate?: string | null;
  latestPrice?: number | null;
  tradingDaysElapsed?: number;
  retT1Pct?: number | null;
  retT5Pct?: number | null;
  retT20Pct?: number | null;
  retT60Pct?: number | null;
  retSincePct?: number | null;
  maxGainPct?: number | null;
  maxDrawdownPct?: number | null;
}

export interface TrackedJudgmentItem {
  id: string;
  recordKey: string;
  target: string;
  stockCode: string;
  stockName: string;
  secid: string;
  marketKind: 'CN' | 'US' | 'HK';
  currency: 'CNY' | 'USD' | 'HKD';
  date: string;
  score: number | null;
  conclusion: string;
  methodIds: string[];
  perf: ForwardPerf;
  hypothesisAlerts: {
    id: string;
    content: string;
    dueDate: string | null;
    daysLeft: number | null;
    status: 'due' | 'soon' | 'upcoming' | 'unscheduled';
  }[];
  dueCount: number;
  soonCount: number;
}

export interface VetoLedgerItem {
  id: string;
  date: string;
  code: string;
  name: string;
  resolvedName?: string;
  secid?: string;
  marketKind: 'CN' | 'US' | 'HK';
  vetoType: 'veto' | 'watch_pass' | 'missed';
  priceAtVeto: number | null;
  reason: string;
  cardIds: string[];
  direction: string;
  createdAt: string;
  perf?: ForwardPerf;
  qualityLabel?: string;
}

export interface JudgmentTrackerResponse {
  ok: boolean;
  updatedAt: string;
  judgments: TrackedJudgmentItem[];
  calibrationBuckets: {
    key: string;
    label: string;
    count: number;
    winRatePct: number | null;
    avgRetT5Pct: number | null;
    avgRetT20Pct: number | null;
    avgRetSincePct: number | null;
  }[];
  vetos: VetoLedgerItem[];
  buyVsVetoAudit: {
    bullishCount: number;
    vetoCount: number;
    avgBullishRetPct: number | null;
    avgVetoRetPct: number | null;
    alphaSpreadPct: number | null;
    dodgeCrashCount: number;
    missedBigWinCount: number;
    overTighteningWarning: boolean;
    verdict: string;
  };
}

export interface TradeRecord {
  id: string;
  accountType: 'real' | 'sim';
  date: string;
  time: string;
  code: string;
  name: string;
  marketKind: 'CN' | 'US' | 'HK';
  currency: 'CNY' | 'USD' | 'HKD';
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  fee: number;
  stopLossPrice: number | null;
  targetPrice: number | null;
  cardIds: string[];
  themes: string[];
  emotionTag: string;
  planScore: number;
  note: string;
  isDayT?: boolean;
  realizedPnl?: number | null;
  returnPct?: number | null;
  rMultiple?: number | null;
  holdingDays?: number | null;
  mfePct?: number | null;
  maePct?: number | null;
  exitAudit?: {
    afterT1Pct: number | null;
    afterT5Pct: number | null;
    afterT20Pct: number | null;
    verdict: string;
  } | null;
}

export interface TradeHolding {
  code: string;
  secid: string;
  name: string;
  marketKind: 'CN' | 'US' | 'HK';
  currency: 'CNY' | 'USD' | 'HKD';
  quantity: number;
  avgCost: number;
  currentPrice: number;
  marketValue: number;
  weightPct: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  stopLossPrice: number | null;
  stopDistPct: number | null;
  hitStop: boolean;
  exceedsSingleCap: boolean;
  themes: string[];
  cardIds: string[];
  firstEntryDate: string;
}

export interface TradeLedgerAnalytics {
  ok: boolean;
  updatedAt: string | null;
  settings: {
    accountCapital: number;
    commissionRate: number;
    maxSinglePct: number;
    maxThemePct: number;
  };
  emotionTagOptions: string[];
  kpi: {
    totalTrades: number;
    closedCount: number;
    openHoldingsCount: number;
    totalRealizedPnl: number;
    totalUnrealizedPnl: number;
    totalPnl: number;
    totalMarketValue: number;
    positionRatioPct: number;
    winRatePct: number | null;
    profitFactor: number | null;
    avgR: number | null;
    avgWin: number;
    avgLoss: number;
    avgPlanScore: number;
    edgeScore: number;
    dayTCount: number;
    dayTPnl: number;
    totalMistakeCost: number;
  };
  holdings: TradeHolding[];
  holdingStopAlerts: { code: string; name: string; detail: string }[];
  themeExposure: { theme: string; marketValue: number; weightPct: number; exceedsThemeCap: boolean }[];
  trades: TradeRecord[];
  pnlCalendar: { date: string; pnl: number; count: number; wins: number; losses: number; dayTCount: number }[];
  cardAttribution: { cardId: string; cardTitle: string; count: number; winRatePct: number; avgR: number | null; totalPnl: number }[];
  mistakeAttribution: { tag: string; count: number; winRatePct: number; totalPnl: number; lossCost: number; isDiscipline: boolean }[];
}

export interface SymbolTradeMarkers {
  code?: string;
  markers: {
    id: string;
    date: string;
    time: string;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    emotionTag: string;
    cardIds: string[];
    note: string;
  }[];
  holdingQty: number;
  avgCostPrice: number | null;
  stopLossPrice: number | null;
}

export interface ChartDrawing {
  id: string;
  type: 'trendline' | 'hline' | 'note';
  color: string;
  label?: string;
  alertEnabled?: boolean;
  alertDirection?: 'above' | 'below' | 'both';
  extendRight?: boolean;
  date1?: string;
  price1?: number;
  date2?: string;
  price2?: number;
  date?: string;
  price?: number;
  text?: string;
  createdAt?: string;
}

export interface ChartDrawingAlert {
  id: string;
  ruleId: string;
  secid: string;
  stockName: string;
  ruleName: string;
  actualValue: number;
  threshold: number;
  severity: 'high' | 'medium' | 'info';
  actionAdvice: string;
}

export interface SchedulerConfig {
  enabled: boolean;
  intradayScanEnabled: boolean;
  intradayIntervalMin: number;
  postMarketSnapshotEnabled: boolean;
  postMarketHour: number;
  postMarketMinute: number;
  onlyHighSeverityPush: boolean;
  webhooks: {
    feishu: { enabled: boolean; url: string };
    wecom: { enabled: boolean; url: string };
    dingtalk: { enabled: boolean; url: string };
    bark: { enabled: boolean; url: string };
    custom: { enabled: boolean; url: string };
  };
  lastIntradayScanAt: string | null;
  lastPostMarketDate: string | null;
  updatedAt: string | null;
}

export interface SchedulerStatusResponse {
  ok: boolean;
  config: SchedulerConfig;
  inTradingWindow: boolean;
  logs: { id: string; time: string; type: string; source: string; status: string; summary: string; pushResults?: any[] }[];
  recentBrowserNotifs: { id: string; time: string; title: string; body: string; count: number }[];
}

export interface PeriodicSummary {
  ok: boolean;
  periodType: 'week' | 'month';
  periodLabel: string;
  startDate: string;
  endDate: string;
  stats: {
    dailyReviewCount: number;
    avgDailyScore: number | null;
    minDailyScore: number | null;
    maxDailyScore: number | null;
    anchorTotal: number;
    anchorHit: number;
    anchorFail: number;
    anchorHitRatePct: number | null;
    judgmentCount: number;
    vetoCount: number;
    tradeCount: number;
    closedTradeCount: number;
    periodRealizedPnl: number;
    periodWinRate: number | null;
    openGapCount: number;
  };
  dailySeries: { id: string; date: string; title: string; score: number | null; marketState: string; gapCount: number }[];
  judgments: { id: string; recordKey: string; date: string; target: string; score: number | null; conclusion: string }[];
  vetos: VetoLedgerItem[];
  sentimentHistory: SentimentNodeEntry[];
  topCards: { id: string; title: string; count: number }[];
  gaps: string[];
}

export interface PeriodicAiReport {
  headline: string;
  marketRegimeReview: string;
  researchAndExecutionReview: string;
  topLessons: string[];
  cardEvolutionProposals: { cardId: string; action: string; reason: string }[];
  nextPeriodFocus: string[];
}

export interface DebateTranscript {
  enabled: boolean;
  totalLatencyMs: number;
  bullBrief: { thesis?: string; catalysts?: string[]; keyNumbers?: string[]; cardRefs?: string[]; upsideScenario?: string };
  bearBrief: { thesis?: string; killSwitches?: string[]; crowdingRisks?: string[]; cardRefs?: string[]; downsideScenario?: string };
  chiefArbitration: string;
}

export interface WorkspaceEntryItem {
  path: string;
  label: string;
  exists: boolean;
  isActive: boolean;
  isDefault: boolean;
  kbMode?: 'v1' | 'v2';
}

export interface WorkspaceProfileInfo {
  ok: boolean;
  appVersion: string;
  isPortableMode: boolean;
  activeProjectRoot: string;
  activeCurrentDir: string;
  stateDir: string;
  kbMode?: 'v1' | 'v2';
  workspaces: WorkspaceEntryItem[];
}

export interface LicenseStatusInfo {
  ok: boolean;
  activated: boolean;
  valid: boolean;
  schemaVersion?: number;
  tier:
    | 'developer'
    | 'friend_trial'
    | 'pro_lifetime'
    | 'pro_annual'
    | 'max_lifetime'
    | 'max_annual'
    | 'partner'
    | 'free'
    | string;
  tierLabel: string;
  holder: string;
  licenseId: string;
  issuedAt: string;
  expiresAt: string | null;
  updatesUntil?: string | null;
  perpetualFallback?: boolean;
  perpetualFallbackActive?: boolean;
  fallbackMajor?: number;
  maxDevices?: number;
  boundDevicesCount?: number;
  machineCode?: string;
  buildDate?: string;
  daysRemaining: number | null;
  note: string;
  activatedAt: string | null;
  keyPreview: string;
  enforcementMode: 'permissive' | 'enforced' | string;
  edition: string;
  features?: string[];
  proUnlocked: boolean;
  maxUnlocked?: boolean;
  partnerUnlocked?: boolean;
  proFeatures: string[];
  maxFeatures?: string[];
}

export interface EntitlementsSnapshot {
  enforced: boolean;
  tier: string;
  unlockedTiers: string[];
  features: Record<string, boolean>;
  featureMeta?: Record<string, { requiredTier: string; label: string; desc: string }>;
  partnerManifest?: Record<string, any> | null;
}

export interface UpgradeRequiredEventDetail {
  ok: false;
  code: 'UPGRADE_REQUIRED';
  feature: string;
  requiredTier: 'pro' | 'max' | 'partner' | string;
  featureLabel?: string;
  machineCode?: string;
  message: string;
}

export interface EulaStatusInfo {
  required: boolean;
  accepted: boolean;
  rawAccepted?: boolean;
  version: string;
  acceptedAt: string | null;
  edition: string;
  title: string;
  clauses: { title: string; body: string }[];
  disclaimerText: string;
  executionBoundaryText: string;
}

export interface AppProfileResponse {
  ok: boolean;
  edition?: 'personal' | 'cn_commercial' | 'global_commercial' | 'partner' | string;
  editionLabel?: string;
  buildDate?: string;
  features?: {
    crypto: boolean;
    liveCryptoExecution: boolean;
    allowCommunityScrapers?: boolean;
    showDisclaimerBanner: boolean;
    lockBrandDisclaimer?: boolean;
  };
  disclaimerText?: string;
  executionBoundaryText?: string;
  eula?: EulaStatusInfo;
  workspaceProfile: WorkspaceProfileInfo;
  license: LicenseStatusInfo;
  entitlements?: EntitlementsSnapshot;
}

export type IntelRoute = 'cognition' | 'methodology' | 'both' | 'sentiment';

export interface IntelZsxqGroupConfig {
  groupId: string;
  name: string;
  type?: string;
  memberCount?: number;
  readable?: boolean;
  latestDate?: string;
  accessError?: string;
  enabled: boolean;
  route: IntelRoute;
}

export interface IntelLocalFolderConfig {
  id: string;
  name: string;
  dirPath: string;
  route: IntelRoute;
  extensions?: string[];
  nameIncludes?: string;
  maxAgeDays?: number;
  enabled: boolean;
}

export interface IntelPublicFeedConfig {
  id: string;
  name: string;
  route: IntelRoute;
  enabled: boolean;
}

export interface IntelRssFeedConfig {
  id: string;
  name: string;
  url: string;
  route: IntelRoute;
  enabled: boolean;
}

export interface IntelHubConfig {
  version: string;
  schedule: {
    enabled: boolean;
    dailyHour: number;
    dailyMinute: number;
    autoAiDistill: boolean;
    autoWechatSync: boolean;
    pushWebhookSummary: boolean;
    lookbackDays: number;
    lastRunDate: string | null;
    lastRunAt: string | null;
  };
  zsxq: {
    enabled: boolean;
    groups: IntelZsxqGroupConfig[];
    maxTopicsPerGroup: number;
    minChars: number;
  };
  wechat: {
    enabled: boolean;
    toolDir: string;
    webPort: number;
    minChars: number;
    accountRoutes: Record<string, { enabled: boolean; route: IntelRoute }>;
  };
  localFolders: IntelLocalFolderConfig[];
  publicFeeds: IntelPublicFeedConfig[];
  rssFeeds: IntelRssFeedConfig[];
  updatedAt: string | null;
}

export interface WechatBridgeAccount {
  id: string;
  bookId: string;
  name: string;
  category: string;
  sourceEnabled: boolean;
  enabled: boolean;
  route: IntelRoute;
  lastArticleDate: string;
  lastArticleTitle: string;
  totalSynced: number;
  recent7dCount: number;
  lastStatus: string;
  lastError: string;
}

export interface WechatBridgeStatus {
  ok: boolean;
  connected: boolean;
  toolDir: string;
  archiveDir?: string;
  webUiUrl: string;
  webUiRunning: boolean;
  totalArchived: number;
  latestArchivedDate?: string;
  accounts: WechatBridgeAccount[];
  lastGlobalCheckAt?: string;
  message?: string;
}

export interface IntelCandidateItem {
  cid: string;
  targetLibrary: 'cognition' | 'methodology';
  kind: 'new_card' | 'amendment' | 'conflict';
  action: string;
  title: string;
  subtitle: string;
  status: 'pending' | 'committed' | 'dismissed';
  sourceTag: string;
  payload: Record<string, any>;
}

export interface IntelRawItem {
  itemKey: string;
  channel: 'zsxq' | 'wechat' | 'local_folder' | 'public_feed' | 'rss' | 'manual_url';
  sourceName: string;
  sourceId: string;
  route: IntelRoute;
  title: string;
  author: string;
  publishedAt: string;
  date: string;
  url: string;
  tags: string[];
  wordCount: number;
  excerpt?: string;
  content: string;
}

export interface IntelBatchRecord {
  id: string;
  createdAt: string;
  date: string;
  sinceDate: string;
  trigger: string;
  runAi: boolean;
  stats: {
    totalFetched: number;
    freshCount: number;
    byChannel: Record<string, number>;
    candidateCount: number;
    cognitionCandidateCount: number;
    methodologyCandidateCount: number;
    discardedCount: number;
  };
  aiSummaries: { cognition: string; methodology: string };
  aiMeta?: { provider?: string; cognitionLatencyMs?: number; methodologyLatencyMs?: number };
  sentimentDigest: {
    itemCount: number;
    sourceHighlights: { sourceName: string; count: number; latestTitle: string; latestDate: string; excerpt: string; url: string }[];
    hotThemes: { kw: string; hits: number }[];
  } | null;
  candidates: IntelCandidateItem[];
  discarded: { targetLibrary: string; item: string; reason: string }[];
  rawItems: IntelRawItem[];
  errors: string[];
}

export interface IntelHubOverviewResponse {
  ok: boolean;
  isPortableMode: boolean;
  config: IntelHubConfig;
  publicFeedCatalog: { id: string; name: string; kind: string; route: IntelRoute; desc: string }[];
  rssPresetCatalog: { id: string; name: string; url: string; route: IntelRoute; category: string; desc: string }[];
  batches: IntelBatchRecord[];
  pendingCandidatesCount: number;
  watermarkCount: number;
  wechatBridge: WechatBridgeStatus;
}

export interface VaultScanFileItem {
  relPath: string;
  name: string;
  ext: string;
  sizeBytes: number;
  modifiedAt: string;
  suggestedTrack: IntelRoute;
}

export interface VaultScanResponse {
  ok: boolean;
  rootDir: string;
  totalFiles: number;
  truncated: boolean;
  skippedDirs: number;
  byExt: Record<string, number>;
  totalSizeKb: number;
  files: VaultScanFileItem[];
}

export interface SlimeBotConfig {
  permissionLevel: 0 | 1 | 2 | 3;
  personaId: string;
  avatarId: string;
  customAvatarDataUrl: string;
  botName: string;
  customPrompt: string;
  language?: 'auto' | 'zh' | 'en';
  slimeColor: 'sky' | 'ice' | 'cobalt' | 'mint';
  autoMoodSync: boolean;
  proactiveTips: boolean;
}

export interface SlimeMascotItem {
  id: string;
  name: string;
  tag: string;
  imageUrl: string;
  defaultBotName: string;
  recommendedPersona: string;
  desc: string;
}

export interface SlimeBotActionCard {
  id: string;
  kind: 'library_mutation' | 'watchlist_add' | 'watchlist_remove' | 'rollback_backup';
  action?: string;
  label: string;
  payload: Record<string, any>;
  status: 'pending' | 'applied';
  summary?: string;
  backupId?: string | null;
  resultSummary?: string;
}

export interface SlimeBotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  mood?: string;
  uiAction?: 'none' | 'show_ticker' | 'show_slime';
  createdAt: string;
  toolsUsed?: string[];
  proposedActions?: SlimeBotActionCard[];
  appliedActions?: SlimeBotActionCard[];
}

export interface SlimeBotStateResponse {
  ok: boolean;
  config: SlimeBotConfig;
  messages: SlimeBotMessage[];
  lastBackupId: string | null;
  permissionLevels: { level: number; code: string; label: string; desc: string }[];
  personaPresets: { id: string; name: string; badge: string; tagline: string; prompt: string; greeting: string }[];
  mascotCatalog?: SlimeMascotItem[];
  hasDesktopPet: boolean;
}

export interface BrandProfile {
  title: string;
  subtitle: string;
  iconMode: 'preset' | 'monogram' | 'custom_image' | 'ai_svg';
  presetId: string;
  monogramText: string;
  monogramTone: 'navy' | 'crimson' | 'emerald' | 'amber' | 'sky';
  customImageDataUrl: string;
  customImageStyle: 'workbench_harmonize' | 'ink_seal' | 'clean_cutout' | 'original';
  aiSvgMarkup: string;
  updatedAt: string | null;
}

export interface BrandStateResponse {
  ok: boolean;
  profile: BrandProfile;
  presets: { id: string; name: string; tag: string; desc: string }[];
  monogramTones: { id: string; name: string; bg: string; fg: string; border: string }[];
}

export interface SlimeMiniTickerData {
  ok: boolean;
  updatedAt: string;
  mood: string;
  botName?: string;
  avatarId?: string;
  unreadAlerts?: number;
  latestAlert?: BotNotificationItem | null;
  sentiment: {
    date: string;
    node: string;
    score: number;
    channelLabel: string;
    maxPositionPct: number;
  } | null;
  summary: { total: number; upCount: number; downCount: number };
  benchmarks: { name: string; code: string; price: number | null; pct: number | null; marketKind: string }[];
  stocks: {
    secid: string;
    code: string;
    name: string;
    marketKind: string;
    currency: string;
    price: number | null;
    pct: number | null;
    group: string;
  }[];
}

// ============================================================================
// v2.0 全球多市场（台/韩/法/英/期货/加密）+ 短线作战模式 + Bot 盯盘预警/定时任务
// ============================================================================

export interface GlobalMarketOverviewItem {
  secid: string;
  code: string;
  secuCode: string;
  name: string;
  nameEn?: string;
  marketKind: MarketKind;
  currency: CurrencyCode;
  exchange: string;
  category?: string;
  categoryZh?: string;
  categoryEn?: string;
  group?: string;
  price: number | null;
  pct: number | null;
  chg: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  preClose: number | null;
  volume: number | null;
  amountUsdM?: number | null;
  amplitudePct: number | null;
}

export interface GlobalMarketsOverviewResponse {
  ok: boolean;
  fetchedAt: string;
  futures: GlobalMarketOverviewItem[];
  globalStocks: GlobalMarketOverviewItem[];
  cryptos: GlobalMarketOverviewItem[];
  exchanges: { code: string; nameZh: string; nameEn: string; currency: string }[];
}

export interface BotWatchAlertItem {
  id: string;
  secid: string;
  code: string;
  secuCode: string;
  name: string;
  marketKind: MarketKind;
  currency: CurrencyCode;
  condition: 'price_above' | 'price_below' | 'pct_above' | 'pct_below' | 'vol_ratio_above';
  threshold: number;
  note: string;
  cooldownMinutes: number;
  notifyWebhook: boolean;
  enabled: boolean;
  createdAt: string;
  lastTriggeredAt: string | null;
  lastValue: number | null;
  triggerCount: number;
}

export interface BotScheduleTaskItem {
  id: string;
  name: string;
  timeHHMM: string;
  weekdaysOnly: boolean;
  taskType: string;
  prompt: string;
  useAi: boolean;
  notifyWebhook: boolean;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastRunDate: string | null;
  lastSummary: string;
}

export interface BotNotificationItem {
  id: string;
  kind: 'watch_alert' | 'technical_rule' | 'anomaly_redline' | 'schedule_report';
  severity: 'high' | 'medium' | 'info';
  title: string;
  body: string;
  secid?: string;
  stockName?: string;
  read: boolean;
  createdAt: string;
}

export interface BotWatchFullState {
  ok?: boolean;
  alertsStore: {
    enabled: boolean;
    forwardTechnicalRules: boolean;
    forwardAnomalyRedline: boolean;
    pollIntervalSec: number;
    alerts: BotWatchAlertItem[];
    updatedAt: string | null;
  };
  schedulesStore: {
    tasks: BotScheduleTaskItem[];
    updatedAt: string | null;
  };
  notifications: {
    unreadCount: number;
    latestUnread: BotNotificationItem | null;
    recent: BotNotificationItem[];
  };
  conditionCatalog: { id: string; labelZh: string; labelEn: string; unit: string }[];
  scheduleTemplates: {
    id: string;
    name: string;
    nameEn: string;
    timeHHMM: string;
    weekdaysOnly: boolean;
    taskType: string;
    prompt: string;
  }[];
}

// ============================================================================
// 模块一：可插拔数据源架构与五档/L2 盘口类型
// ============================================================================

export type DataSourceChannelId = 'cn_quotes' | 'cn_short_term' | 'news_feeds' | 'global_markets';

export interface DataSourcePresetItem {
  id: string;
  label: string;
  mode: 'default' | 'custom';
  desc: string;
  baseUrl?: string;
  quotePath?: string;
  orderbookPath?: string;
  tickPath?: string;
  intradayPath?: string;
  klinePath?: string;
  spritePath?: string;
  auctionPath?: string;
  sealFlowPath?: string;
  lhbPath?: string;
  chipPath?: string;
  pollUrl?: string;
  communityUrl?: string;
  cryptoExchange?: string;
  authHeaderName?: string;
  authHeaderPrefix?: string;
}

export interface DataSourceConfigResponse {
  ok?: boolean;
  version: number;
  updatedAt: string | null;
  webhookUrl: string;
  ingestedCount?: number;
  presets: Record<DataSourceChannelId, DataSourcePresetItem[]>;
  capabilities: {
    customChannelCount: number;
    cnQuotesSource: string;
    orderbook5Level: { available: boolean; tier: string; label: string };
    l2Orderbook10: { available: boolean; tier: string; channel: DataSourceChannelId; label: string };
    l2TickByTick: { available: boolean; tier: string; channel: DataSourceChannelId; label: string };
    sealFlowIntraday: { available: boolean; tier: string; channel: DataSourceChannelId; label: string };
    communityDeepPost: {
      available: boolean;
      hasCommunityPull: boolean;
      hasWebhook: boolean;
      tier: string;
      channel: DataSourceChannelId;
      label: string;
    };
    globalPremium: { available: boolean; tier: string; channel: DataSourceChannelId; label: string };
  };
  lastChecks: Record<
    string,
    { checkedAt: string; ok: boolean; latencyMs: number | null; mode: string; message: string }
  >;
  channels: Record<DataSourceChannelId, Record<string, any>>;
  contracts?: { channel: DataSourceChannelId; title: string; curl: string; responseSample: string }[];
}

export interface OrderBookLevel {
  level: number;
  price: number | null;
  volume: number | null;
}

export interface OrderBookTick {
  time: string;
  price: number | null;
  volume: number | null;
  orders: number | null;
  side: 'buy' | 'sell' | 'neutral';
  amountWan: number | null;
  isBigOrder?: boolean;
}

export interface StockOrderBookResponse {
  ok: boolean;
  secid: string;
  fetchedAt: string;
  orderbook: {
    secid: string;
    code: string;
    name: string;
    last: number | null;
    preClose: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    chg: number | null;
    pct: number | null;
    avgPrice: number | null;
    volumeLots: number | null;
    amountYi: number | null;
    outVol: number | null;
    inVol: number | null;
    turnoverPct: number | null;
    peTtm: number | null;
    amplitudePct: number | null;
    circCapYi: number | null;
    totalCapYi: number | null;
    limitUp: number | null;
    limitDown: number | null;
    volumeRatio: number | null;
    weibi: number | null;
    weicha: number | null;
    orderbookDepth: number;
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    bids6to10: OrderBookLevel[] | null;
    asks6to10: OrderBookLevel[] | null;
    sourceTier: string;
    sourceLabel: string;
  } | null;
  ticks: OrderBookTick[];
  tickSourceTier: string;
  tickSourceLabel: string;
  sealFlow: {
    available: boolean;
    series: { t: string; sealYi: number | null }[] | null;
    slot: { available: boolean; channel: DataSourceChannelId; label: string };
  };
  chips?: {
    available: boolean;
    sourceTier?: string;
    data: {
      profitRatioPct: number | null;
      avgCost: number | null;
      concentration90Pct: number | null;
      bins: any[] | null;
    } | null;
    slot: { available: boolean; channel: DataSourceChannelId; label: string };
  };
  wsUrl?: string | null;
  fallbackError?: string | null;
  slots: {
    l2Orderbook10: { available: boolean; channel: DataSourceChannelId; label: string };
    l2BigOrderTicks: { available: boolean; channel: DataSourceChannelId; label: string };
    sealFlowIntraday: { available: boolean; channel: DataSourceChannelId; label: string };
    chipsDistribution?: { available: boolean; channel: DataSourceChannelId; label: string };
  };
}

// ============================================================================
// Stage 4：Python + DuckDB 多市场策略回测实验室类型定义
// ============================================================================

export type QuantMarket = 'CN' | 'US' | 'HK' | 'CRYPTO' | 'FUT';

export interface QuantConfig {
  pythonPath: string;
  dataDir: string;
  defaultMarket: string;
  defaultInitialCash: number;
  updatedAt: string | null;
}

export interface QuantEnvStatus {
  ok: boolean;
  available: boolean;
  pythonFound: boolean;
  pythonVersion?: string;
  pythonExecutable?: string;
  pythonSource?: string;
  isVenv?: boolean;
  canAutoSetup?: boolean;
  systemPython?: { executable: string; version: string } | null;
  venvPath?: string;
  venvExists?: boolean;
  engineVersion?: string;
  dataDir: string;
  dbPath?: string;
  dbExists?: boolean;
  diskFreeGb?: number;
  reason?: string;
  dependencies: Record<string, { installed: boolean; version: string | null }>;
  config: QuantConfig;
  engineRoot?: string;
}

export interface QuantSeriesItem {
  symbol: string;
  freq: string;
  market: string;
  minDate: string;
  maxDate: string;
  rowCount: number;
  source: string;
  updatedAt: string;
  name: string;
  currency: string;
  lotSize: number;
  boardType: string;
}

export interface QuantDataSummary {
  ok: boolean;
  available?: boolean;
  error?: string;
  dataDir?: string;
  dbPath: string;
  dbSizeMb: number;
  totalSeries: number;
  marketsCount: Record<string, number>;
  benchmarksReady: Record<string, boolean>;
  calendars: Record<string, { openDays: number; minDate: string; maxDate: string }>;
  items: QuantSeriesItem[];
  writeLocked?: boolean;
}

export interface VisualRuleCondition {
  indicator: 'CLOSE' | 'MA' | 'EMA' | 'RSI' | 'MACD_HIST' | 'BIAS' | 'BOLL_UPPER' | 'BOLL_LOWER' | 'VOL_RATIO';
  period?: number;
  op: '>' | '>=' | '<' | '<=' | 'cross_above' | 'cross_below';
  rhsType: 'value' | 'indicator';
  value?: number;
  rhsIndicator?: 'MA' | 'EMA' | 'BOLL_UPPER' | 'BOLL_LOWER';
  rhsPeriod?: number;
}

export interface VisualRuleConfig {
  name: string;
  positionWeight: number;
  entryLogic: 'AND' | 'OR';
  exitLogic: 'AND' | 'OR';
  entryConditions: VisualRuleCondition[];
  exitConditions: VisualRuleCondition[];
}

export interface QuantStrategyItem {
  id: string;
  key?: string;
  name: string;
  description: string;
  mode: 'python' | 'visual';
  market: string;
  builtin: boolean;
  code: string;
  ruleConfig: VisualRuleConfig | null;
  cardRefs: string[];
  defaultParams: Record<string, any>;
  updatedAt: string | null;
}

export interface BacktestMetrics {
  totalReturnPct: number;
  annualizedReturnPct: number;
  benchmarkReturnPct: number;
  excessReturnPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdownPct: number;
  maxDrawdownStart: string;
  maxDrawdownEnd: string;
  calmarRatio: number;
  winRatePct: number;
  profitLossRatio: number;
  tradeCount: number;
  closedTradeCount: number;
  turnoverRatio: number;
  totalFees: number;
  rejectCount: number;
  finalEquity: number;
}

export interface BacktestEquityPoint {
  date: string;
  equity: number;
  nav: number;
  benchmarkNav: number;
  drawdownPct: number;
  positionPct: number;
  cash: number;
}

export interface BacktestMonthlyReturn {
  year: number;
  months?: Record<string, number>;
  yearTotalPct?: number | null;
  month?: number;
  returnPct?: number;
}

export interface BacktestTradeItem {
  symbol: string;
  date: string;
  side: 'BUY' | 'SELL';
  price: number;
  shares: number;
  amount: number;
  fee: number;
  pnl: number | null;
  pnlPct: number | null;
  reason: string;
}

export interface BacktestRejectItem {
  symbol: string;
  date: string;
  side: string;
  requestedShares: number;
  reason: string;
}

export interface BacktestRunMeta {
  strategyId: string;
  strategyName: string;
  strategyMode: 'python' | 'visual';
  market: string;
  currency: string;
  symbols: string[];
  symbolNames: Record<string, string>;
  startDate: string;
  endDate: string;
  freq: string;
  adjust: string;
  matchMode: 'next_open' | 'close';
  initialCash: number;
  benchmark: string;
  sources: string[];
  gapWarnings: { symbol: string; missingDays: number; coveragePct: number; note?: string }[];
  cardRefs: string[];
  profile: Record<string, any>;
  params: Record<string, any>;
  risk: Record<string, any>;
}

export interface BacktestRunSummary {
  runId: string;
  createdAt: string | null;
  meta: BacktestRunMeta;
  metrics: BacktestMetrics;
  tradeCount: number;
  rejectCount: number;
}

export interface BacktestResultFull {
  ok: boolean;
  runId: string;
  createdAt: string;
  meta: BacktestRunMeta;
  metrics: BacktestMetrics;
  equityCurve: BacktestEquityPoint[];
  monthlyReturns: BacktestMonthlyReturn[];
  trades: BacktestTradeItem[];
  rejects: BacktestRejectItem[];
}

export interface ExecutionSlotStateResponse {
  ok: boolean;
  edition: string;
  executionBoundaryText: string;
  disclaimerText: string;
  updatedAt: string | null;
  slot: {
    miniqmt: {
      enabled: boolean;
      mode: 'plan_card_only' | 'miniqmt_local_slot';
      userdataMiniPath: string;
      hasAccountId: boolean;
      maskedAccountId: string;
      accountType: 'STOCK';
      readOnlyConfirmLock: boolean;
      notes: string;
    };
  };
  capabilities: {
    planCard: boolean;
    miniqmtSlotRegistered: boolean;
    miniqmtEnabled: boolean;
    autoClickForbidden: boolean;
    cryptoExecutionForbidden: boolean;
  };
}

export interface MiniQmtProbeResult {
  ok: boolean;
  ready: boolean;
  status: string;
  pathExists: boolean;
  xtquantInstalled: boolean;
  pythonReady?: boolean;
  pythonExecutable?: string | null;
  message: string;
}

// ============================================================================
// Three Libraries v2 (kb-v2) 架构类型定义
// ============================================================================

export interface KbRelationEdge {
  type?: string;
  edge_type?: string;
  target?: string;
  target_id?: string;
  source?: string;
  source_id?: string;
  note?: string;
  direction?: 'out' | 'in';
  targetTitle?: string;
  sourceTitle?: string;
}

export interface KbTickerRef {
  code: string;
  name?: string;
  role?: string;
}

export interface MethodologyV2Meta {
  kbId: string;
  cardKind?: string;
  status?: string;
  domains?: string[];
  regimes?: string[];
  horizons?: string[];
  assetClasses?: string[];
  verificationTier?: string | null;
  independentChains?: number;
  reviewEventCount?: number;
  relations?: KbRelationEdge[];
  enrichmentStatus?: string;
  updatedAt?: string | null;
}

export interface CognitionV2Meta {
  kbId: string;
  claimType?: string;
  status?: string;
  validUntil?: string | null;
  nextCheckDate?: string | null;
  topics?: string[];
  chainNodes?: string[];
  tickers?: (KbTickerRef | string)[];
  relations?: KbRelationEdge[];
  refuters?: (string | { id: string; title?: string; primaryGrade?: string })[];
  isExpired?: boolean;
  isCheckDue?: boolean;
  updatedAt?: string | null;
}

export interface KbSummary {
  nodeCount: number;
  edgeCount: number;
  tagCount: number;
  entityCount: number;
  reviewEventCount: number;
  topicCount: number;
  sqliteAvailable: boolean;
  byKind?: Record<string, number>;
  lastSyncAt?: string | null;
}

export interface KbTopicMemberItem {
  id: string;
  cardId?: string;
  num?: number;
  title: string;
  status: string;
  primaryGrade?: string | null;
  primary_grade?: string | null;
  subKind?: string;
  sub_kind?: string;
  claimType?: string;
  ingestedAt?: string | null;
  ingested_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  validUntil?: string | null;
  valid_until?: string | null;
}

export interface KbTopicView {
  id: string;
  slug?: string;
  title: string;
  chainPrefix?: string;
  chain_prefix?: string;
  status: 'dirty' | 'synced' | string;
  filePath?: string;
  lastSynthesizedAt?: string | null;
  last_synthesized_at?: string | null;
  lastCardEventAt?: string | null;
  last_card_event_at?: string | null;
  consensusSummary?: string;
  consensus_summary?: string;
  memberCount: number;
  activeCount?: number;
  inactiveCount?: number;
  activeMembers?: KbTopicMemberItem[];
  inactiveMembers?: KbTopicMemberItem[];
  members?: KbTopicMemberItem[];
  linkedMethods?: { id?: string; target_id?: string; title?: string; legacyScore?: number | null; legacy_score?: number | null; status?: string }[];
  linkedConflicts?: { id?: string; target_id?: string; title?: string }[];
}

export interface KbStaleItem {
  id: string;
  cardId?: string;
  num?: number;
  title: string;
  subKind?: string;
  sub_kind?: string;
  primaryGrade?: string | null;
  primary_grade?: string | null;
  ingestedAt?: string | null;
  ingested_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  validUntil?: string | null;
  valid_until?: string | null;
  nextCheckDate?: string | null;
  next_check_date?: string | null;
  status?: string;
}

export interface KbStaleReport {
  asOfDate: string;
  activeTotal: number;
  expiredCount: number;
  checkDueCount: number;
  expired: KbStaleItem[];
  checkDue: KbStaleItem[];
}

export interface KbSearchHit {
  id: string;
  kind: 'methodology' | 'cognition' | 'conflict' | string;
  subKind?: string;
  title: string;
  status: string;
  primaryGrade?: string | null;
  legacyScore?: number | null;
  verificationTier?: string | null;
  independentChains?: number;
  updatedAt?: string | null;
  validUntil?: string | null;
  score: number;
  reasons: string[];
  warnings: string[];
  coreSummary?: string;
  invalidationText?: string;
}

export interface KbSearchResponse {
  ok?: boolean;
  kbMode?: 'v1' | 'v2';
  elapsedMs: number;
  query: string;
  detectedEntities?: { code: string; name: string; role?: string }[];
  matchedSynonyms?: string[];
  vectorUsed?: boolean;
  redirectNotes?: string[];
  results: KbSearchHit[];
  attachedConflicts?: { id: string; title: string; conflictPoint?: string; resolution?: string }[];
  attachedTopics?: { id: string; title: string; status: string; memberCount: number }[];
  attachedRefuters?: { id: string; title: string; primaryGrade?: string | null; coreSummary?: string }[];
}

export interface KbReviewEvent {
  event_id?: string;
  eventId?: string;
  date: string;
  card_id?: string;
  cardId?: string;
  ledger_ref?: string;
  ledgerRef?: string;
  evidence_chain_id?: string;
  evidenceChainId?: string;
  regime?: string;
  verdict: string;
  legacy_delta?: number;
  legacyDelta?: number;
  legacy_score_after?: number | null;
  legacyScoreAfter?: number | null;
  note: string;
}

export interface KbCardTimelineResponse {
  ok?: boolean;
  cardId: string;
  events: KbReviewEvent[];
  reviewEvents?: KbReviewEvent[];
  edges?: {
    out: KbRelationEdge[];
    in: KbRelationEdge[];
  };
  outEdges?: KbRelationEdge[];
  inEdges?: KbRelationEdge[];
}








