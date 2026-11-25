'use strict';

/**
 * 二级投研 · 三库工作台本地服务端（零外部 npm 依赖）
 * - 提供三库解析、检索、质检、证据核验、预览 Diff、确认写盘与备份回滚 REST API
 * - 生产态直接托管 dist/ 前端静态资源，双击批处理即可 1 秒启动
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');

const {
  loadWorkspace,
  getKbSearch,
  getKbTopics,
  getKbStale,
  getKbCardTimeline,
  migrateCurrentWorkspaceToV2,
  exportKbMonolithSnapshots,
  saveTopicConsensusSummary,
} = require('./knowledge-store.cjs');
const { PATHS, APP_ROOT, stateFile, registerWorkspaceChangeHook } = require('./app-paths.cjs');
const { invokeModel } = require('./ai-provider.cjs');
const { getEditionInfo } = require('./edition.cjs');
const { getEulaStatus, acceptEula } = require('./eula-service.cjs');
const { buildDiagnosticZipBuffer, recordServerError } = require('./diagnostic-service.cjs');
const { exportFullBackupZip, importFullBackupZip } = require('./backup-zip-service.cjs');
const { listQuickNotes, addQuickNote, deleteQuickNote, markQuickNoteConverted } = require('./quick-notes.cjs');
const {
  appendAuditLog,
  safeAppendAuditLog,
  queryAuditTrail,
  exportAuditTrailCsv,
  exportWorkspaceSummaryCsv,
} = require('./audit-trail.cjs');
const {
  checkStaticRouteFeature,
  checkFeatureEntitlement,
  getEntitlementsSnapshot,
  isCustomDataSourcePayload,
} = require('./entitlement-guard.cjs');
const { runQualityAudit } = require('./auditor.cjs');
const { checkEvidenceRecord } = require('./evidence-checker.cjs');
const { buildMutationPlan, commitMutationPlan, listBackups, restoreBackup } = require('./writer.cjs');
const { fetchDailyMarketPacket, fetchStockSnapshotForJudgment } = require('./market-fetcher.cjs');
const { getSafeConfigForClient, saveConfig } = require('./ai-config.cjs');
const {
  buildDailyReviewPrompt,
  parseJsonFromModelOutput,
  sanitizeDraft,
  testAiConnection,
  runAutoDailyReview,
} = require('./ai-reviewer.cjs');
const { extractDocumentText } = require('./doc-extractor.cjs');
const { transcribeAudio } = require('./audio-transcriber.cjs');
const { buildIngestionPrompt, sanitizeIngestionResult, runAiIngestion } = require('./ai-ingestor.cjs');
const { buildJudgmentPrompt, sanitizeJudgmentDraft, runAiJudgmentDraft } = require('./ai-judgment.cjs');
const { collectStockResearchPacket, searchSecurities } = require('./stock-researcher.cjs');
const {
  loadWatchlistConfig,
  saveWatchlistConfig,
  addWatchlistItem,
  resetWatchlistConfig,
  fetchWatchlistLiveBoard,
  fetchSecurityDetailChart,
  fetchMultiTimeframeKlines,
} = require('./watchlist-service.cjs');
const {
  METRIC_CATALOG,
  loadAlertRules,
  saveAlertRules,
  resetAlertRules,
  auditRuleCardDrift,
  syncRuleCardHashes,
  loadSentimentChain,
  computeTrendlines,
  analyzeSecurityTechnicals,
  scanTechnicalRadar,
  clearTechnicalRadarCache,
  extractRulesFromMethodologyCards,
} = require('./technical-engine.cjs');
const {
  renderArchivedDailyReviewHtml,
  renderDraftDailyReviewHtml,
  saveReportHtmlToDisk,
} = require('./daily-html-renderer.cjs');
const { startJob, cancelJob, cancelAllRunningJobs, listJobs, getJob } = require('./job-runner.cjs');
const {
  loadRegulatoryWatchlist,
  saveRegulatoryWatchlist,
  reconcileDailyReviewDraft,
  reconcileJudgmentDraft,
  applyReconcileFixes,
} = require('./reconcile-service.cjs');
const {
  loadVetoLedger,
  addVetoEntry,
  deleteVetoEntry,
  trackJudgmentsAndVetos,
  buildPreflightReport,
} = require('./judgment-tracker.cjs');
const {
  addTrades,
  updateTrade,
  deleteTrade,
  updateTradeSettings,
  parseBrokerCsvText,
  parseTradesWithAi,
  computeTradeLedgerAnalytics,
  getTradeMarkersForSymbol,
} = require('./trade-ledger.cjs');
const {
  getChartDrawings,
  saveChartDrawings,
  evaluateDrawingsOnKlines,
} = require('./chart-drawings.cjs');
const {
  saveSchedulerConfig,
  getSchedulerStatus,
  dispatchWebhookMessage,
  dispatchIntelWebhookSummary,
  runIntradayScan,
  runPostMarketCapture,
  startBackgroundScheduler,
} = require('./scheduler-service.cjs');
const {
  getIntelHubOverview,
  saveIntelConfig,
  probeZsxqGroups,
  getWechatBridgeStatus,
  launchWechatWebUi,
  triggerWechatIncrementalSync,
  fetchSinglePublicUrl,
  runIntelPipeline,
  updateCandidateStatus,
  resetWatermarks,
} = require('./intel-hub.cjs');
const { scanLocalVault, runVaultBatchImport } = require('./vault-importer.cjs');
const {
  getBotState,
  updateBotConfig,
  appendProactiveBotMessage,
  clearBotHistory,
  getMiniTickerSnapshot,
  runBotChat,
  approveBotAction,
  undoBotBackup,
  launchDesktopSlimePet,
  clearBotRuntimeCaches,
} = require('./slime-bot.cjs');
const { fetchGlobalMarketsOverview } = require('./global-markets.cjs');
const {
  fetchShortTermDashboard,
  fetchMarketTickerStrip,
  clearShortTermCaches,
  fetchBoardLadderAndCycle,
  fetchAnomalyCenter,
  searchThemeCatalog,
  loadCustomThemesStore,
  saveCustomTheme,
  deleteCustomTheme,
  togglePinTheme,
  fetchThemeMatrixAndRangeStats,
  fetchStockFullscreenDossier,
} = require('./short-term-engine.cjs');
const { runChartVisionAnalysis } = require('./chart-vision-analyzer.cjs');
const {
  fetchShortTermSprite,
  fetchHotRankBoard,
  fetchShortTermNewsFeeds,
  fetchCloudTreemapData,
  fetchAuctionSealRadar,
  fetchDragonTigerList,
  fetchSectorRotationQuadrant,
  loadReviewTrainingStore,
  saveReviewTrainingEntry,
} = require('./short-term-extras.cjs');
const {
  updateWatchSettings,
  upsertWatchAlert,
  toggleWatchAlert,
  deleteWatchAlert,
  upsertBotSchedule,
  toggleBotSchedule,
  deleteBotSchedule,
  markNotificationsRead,
  evaluateWatchAlertsNow,
  runBotScheduledTask,
  getBotWatchFullState,
  startBotWatchDaemon,
} = require('./bot-watch-service.cjs');
const {
  getBrandState,
  saveBrandProfile,
  resetBrandProfile,
  stylizeBrandIconWithAi,
} = require('./brand-service.cjs');
const {
  buildPeriodicSummary,
  runPeriodicAiSynthesis,
  renderPeriodicReviewHtml,
  savePeriodicHtmlToDisk,
} = require('./periodic-review.cjs');
const {
  getWorkspaceProfileInfo,
  switchActiveWorkspace,
  createSubWorkspace,
} = require('./app-paths.cjs');
const {
  calculateAShareTradePlan,
  getSafeExecutionSlotState,
  saveExecutionSlotConfig,
  probeMiniQmtSlot,
} = require('./execution-slot.cjs');
const {
  getLicenseStatus,
  activateLicenseKey,
  deactivateLicenseKey,
} = require('./license-service.cjs');
const {
  getSafeDataSourceConfig,
  getWebhookTokenRaw,
  saveDataSourceConfig,
} = require('./data-source-config.cjs');
const {
  clearRouterCaches,
  verifyBearerWebhookToken,
  ingestWebhookFeeds,
  listIngestedFeeds,
  clearIngestedFeeds,
  fetchStockOrderBookAndTicks,
  fetchShortTermChips,
  testChannelConnection,
  getAdapterContracts,
} = require('./data-source-router.cjs');
const {
  detectQuantEnv,
  saveQuantConfig,
  startQuantEnvSetupJob,
  getDataSummary,
  getSymbolBars,
  startDataSyncJob,
  importCsvHistory,
  listStrategies,
  saveStrategy,
  deleteStrategy,
  generateStrategyFromCards,
  startBacktestJob,
  listBacktestRuns,
  getBacktestRun,
  deleteBacktestRun,
  getRunCsvContent,
} = require('./quant-bridge.cjs');
const {
  loadPublishedStrategiesStore,
  publishLiveStrategy,
  deletePublishedStrategy,
  findStrategyById,
  evaluateStrategyOnKlines,
  evaluateStrategyBatch,
  screenLiveMarketStocks,
} = require('./strategy-signal-engine.cjs');

const PORT = Number(process.env.PORT || 3721);
const HOST = '127.0.0.1';
const DIST_DIR = path.join(__dirname, '..', 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

let activeListenPort = PORT;
let folderPickerInFlight = false;

function getActiveListenPort() {
  try {
    const addr = server && typeof server.address === 'function' ? server.address() : null;
    if (addr && typeof addr === 'object' && addr.port) return addr.port;
  } catch {
    // ignore
  }
  return activeListenPort || PORT;
}

function isExplicitDevOriginEnabled() {
  return process.env.SRW_DEV_ORIGIN === '1' || process.env.SRW_ALLOW_VITE_DEV === '1';
}

function getAllowedLocalHosts() {
  const p = getActiveListenPort();
  const hosts = new Set([
    `127.0.0.1:${p}`,
    `localhost:${p}`,
    `[::1]:${p}`,
  ]);
  if (isExplicitDevOriginEnabled()) {
    hosts.add('127.0.0.1:5173');
    hosts.add('localhost:5173');
    hosts.add('[::1]:5173');
  }
  return hosts;
}

function isAllowedLocalHostHeader(req) {
  const rawHost = String(req?.headers?.host || '').trim().toLowerCase();
  if (!rawHost) return false;
  return getAllowedLocalHosts().has(rawHost);
}

function getAllowedLocalOrigins() {
  const p = getActiveListenPort();
  const origins = new Set([
    `http://127.0.0.1:${p}`,
    `http://localhost:${p}`,
    `http://[::1]:${p}`,
  ]);
  if (isExplicitDevOriginEnabled()) {
    origins.add('http://127.0.0.1:5173');
    origins.add('http://localhost:5173');
  }
  return origins;
}

function isAllowedLocalOrigin(origin) {
  if (!origin) return true;
  return getAllowedLocalOrigins().has(String(origin).trim().toLowerCase());
}

function isLoopbackRemote(req) {
  const ip = String(req?.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '';
}

function isTrustedLocalRequest(req) {
  if (!isAllowedLocalHostHeader(req)) return false;
  const origin = req?.headers?.origin || '';
  const referer = req?.headers?.referer || '';
  const secFetchSite = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
  if (secFetchSite === 'cross-site') return false;
  const refererOrigin = referer
    ? (() => {
        try {
          return new URL(referer).origin;
        } catch {
          return '';
        }
      })()
    : '';
  return (
    isLoopbackRemote(req) &&
    isAllowedLocalOrigin(origin) &&
    (!refererOrigin || isAllowedLocalOrigin(refererOrigin))
  );
}

function isValidExternalBearerFeedRequest(req, pathname) {
  if (pathname !== '/api/feeds/ingest' || req.method !== 'POST') return false;
  return verifyBearerWebhookToken(req?.headers).ok;
}

function pickFolderAsync(description, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const safeDesc = String(description || '请选择本地三库或 Obsidian / Git 文件夹').replace(/['"`$]/g, '');
    let cmd = '';
    let args = [];
    if (process.platform === 'win32') {
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$owner = New-Object System.Windows.Forms.Form',
        '$owner.TopMost = $true',
        '$owner.StartPosition = "Manual"',
        '$owner.Location = New-Object System.Drawing.Point(-2000, -2000)',
        '$owner.Size = New-Object System.Drawing.Size(1, 1)',
        '$owner.ShowInTaskbar = $false',
        '$owner.Show()',
        '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
        `$dlg.Description = '${safeDesc}'`,
        '$dlg.ShowNewFolderButton = $true',
        '$res = $dlg.ShowDialog($owner)',
        '$owner.Close()',
        'if ($res -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dlg.SelectedPath }',
      ].join('; ');
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-STA', '-Command', psScript];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript';
      args = ['-e', `POSIX path of (choose folder with prompt "${safeDesc}")`];
    } else {
      resolve({
        status: 200,
        payload: {
          ok: false,
          cancelled: false,
          errorCode: 'UNSUPPORTED_OS',
          path: '',
          message: '当前操作系统暂不支持原生弹窗选目录，请直接粘贴本地绝对路径',
        },
      });
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({
        status: 500,
        payload: {
          ok: false,
          cancelled: false,
          errorCode: 'LAUNCH_FAILED',
          path: '',
          error: `无法启动系统目录选择器：${err.message}`,
        },
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 500);
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      finish({
        status: 500,
        payload: {
          ok: false,
          cancelled: false,
          errorCode: 'LAUNCH_FAILED',
          path: '',
          error: `启动原生目录选择器失败：${err.message}`,
        },
      });
    });
    child.on('close', (code) => {
      if (timedOut) {
        finish({
          status: 504,
          payload: {
            ok: false,
            cancelled: false,
            errorCode: 'TIMEOUT',
            path: '',
            error: '目录选择器等待超时，请重试或直接粘贴本地路径',
          },
        });
        return;
      }
      const selected = String(stdout || '').trim();
      const errText = String(stderr || '').trim();
      if (process.platform === 'darwin' && code !== 0 && /User canceled|-128/i.test(errText)) {
        finish({ status: 200, payload: { ok: true, cancelled: true, path: '' } });
        return;
      }
      if (code !== 0) {
        finish({
          status: 500,
          payload: {
            ok: false,
            cancelled: false,
            errorCode: 'LAUNCH_FAILED',
            path: '',
            error: errText || `目录选择器异常退出 (code=${code})`,
          },
        });
        return;
      }
      finish({
        status: 200,
        payload: { ok: true, cancelled: !selected, path: selected },
      });
    });
  });
}

function readLightweightSidebarSummary() {
  let intelPendingCount = 0;
  try {
    const inboxPath = stateFile('intel-hub-inbox.local.json');
    if (fs.existsSync(inboxPath)) {
      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      const batches = Array.isArray(inbox?.batches) ? inbox.batches : [];
      for (const b of batches) {
        for (const c of b?.candidates || []) {
          if (!c?.status || c.status === 'pending') intelPendingCount += 1;
        }
      }
    }
  } catch {
    intelPendingCount = 0;
  }

  let techAlertCount = 0;
  let techHighSeverityCount = 0;
  let unreadBotAlerts = 0;
  let enabledTechRules = 0;
  try {
    const rules = loadAlertRules();
    enabledTechRules = (rules?.rules || []).filter((r) => r.enabled !== false).length;
  } catch {
    enabledTechRules = 0;
  }
  try {
    const notifsPath = stateFile('bot-notifications.local.json');
    if (fs.existsSync(notifsPath)) {
      const raw = JSON.parse(fs.readFileSync(notifsPath, 'utf8'));
      const items = Array.isArray(raw?.items) ? raw.items : [];
      for (const n of items) {
        if (!n || n.read) continue;
        unreadBotAlerts += 1;
        if (n.kind === 'technical_rule' || n.kind === 'watch_alert') {
          techAlertCount += 1;
          if (n.severity === 'high') techHighSeverityCount += 1;
        }
      }
    }
  } catch {
    // ignore
  }
  return {
    ok: true,
    intelPendingCount,
    techAlertCount,
    techHighSeverityCount,
    enabledTechRules,
    unreadBotAlerts,
    updatedAt: new Date().toISOString(),
  };
}

function buildCorsHeaders(req) {
  const origin = String(req?.headers?.origin || '').trim();
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-SRW-Client, X-SRW-Local-Confirm, X-SRW-Workspace',
    Vary: 'Origin',
  };
  if (origin && isAllowedLocalOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function sendJson(res, status, data, req = null) {
  const body = JSON.stringify(data);
  const effReq = req || res._srwReq || null;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...buildCorsHeaders(effReq),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 35 * 1024 * 1024) {
  const limit = Math.max(1024, Number(maxBytes) || 35 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('读取请求体超时'));
      try { req.destroy(); } catch { /* ignore */ }
    }, 30000);
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`请求体超过 ${(limit / (1024 * 1024)).toFixed(1)}MB 限制`));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('无效的 JSON 请求体'));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function safeResolveInProject(relPath) {
  const resolved = path.resolve(PATHS.currentDir, relPath);
  const rootNorm = path.resolve(PATHS.projectRoot);
  const rel = path.relative(rootNorm, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('禁止访问项目目录之外的文件');
  }
  return resolved;
}

const server = http.createServer(async (req, res) => {
  res._srwReq = req;
  const parsedUrl = new URL(req.url, `http://${HOST}:${getActiveListenPort()}`);
  const pathname = parsedUrl.pathname;

  // 防 DNS Rebinding：在分发任何请求前先校验 HTTP Host 与实际监听端口（合法外部推送入口仅限本机监听地址）
  if (!isAllowedLocalHostHeader(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin' });
    res.end(JSON.stringify({ ok: false, error: '非法 Host 请求头：仅允许访问本机实际监听端口' }));
    return;
  }

  if (req.method === 'OPTIONS') {
    const origin = String(req.headers?.origin || '').trim();
    if (origin && !isAllowedLocalOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin' });
      res.end(JSON.stringify({ ok: false, error: '禁止跨源预检访问本地三库工作台 API' }));
      return;
    }
    res.writeHead(204, buildCorsHeaders(req));
    res.end();
    return;
  }

  // 全局本地防跨源与写操作 CSRF 门禁（统一强制要求 X-SRW-Client: workbench，仅对通过有效 Bearer Token 校验的 /api/feeds/ingest 保留外部推送例外）
  const isValidBearerFeed = isValidExternalBearerFeedRequest(req, pathname);
  if (pathname.startsWith('/api/') && !isValidBearerFeed) {
    if (!isTrustedLocalRequest(req)) {
      return sendJson(res, 403, { ok: false, error: '禁止跨源访问本地三库工作台 API（仅允许本机受信任端口）' }, req);
    }
    const isWriteMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase());
    if (isWriteMethod) {
      const clientHdr = String(req.headers?.['x-srw-client'] || '').trim().toLowerCase();
      if (clientHdr !== 'workbench') {
        return sendJson(res, 403, { ok: false, error: '写操作缺少本机客户端校验头 X-SRW-Client: workbench' }, req);
      }
    }
  }

  try {
    // -----------------------------------------------------------------------
    // 商业版 EULA 未签署后端硬拦截（仅放行健康检查、版本档案、EULA/授权、诊断导出与关机，阻断所有业务写操作）
    // -----------------------------------------------------------------------
    const edCur = getEditionInfo();
    const isWriteReq = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase());
    if (
      edCur.isCommercial &&
      isWriteReq &&
      pathname.startsWith('/api/') &&
      !pathname.startsWith('/api/app/eula') &&
      !pathname.startsWith('/api/app/license') &&
      pathname !== '/api/shutdown'
    ) {
      const eulaCur = getEulaStatus();
      if (eulaCur.required && !eulaCur.accepted) {
        return sendJson(
          res,
          451,
          {
            ok: false,
            code: 'EULA_REQUIRED',
            error: '商业版首次使用前必须先阅读并同意《软件许可与合规免责声明 (EULA)》',
          },
          req
        );
      }
    }

    // -----------------------------------------------------------------------
    // 商业版物理阻断社区/公众号/知识星球抓取接口与国内实时选股接口
    // -----------------------------------------------------------------------
    if (
      !edCur.features.allowCommunityScrapers &&
      (pathname.startsWith('/api/intel/wechat/') ||
        pathname.startsWith('/api/intel/zsxq/') ||
        pathname === '/api/intel/url-fetch')
    ) {
        return sendJson(
          res,
          403,
          {
            ok: false,
            code: 'EDITION_FEATURE_DISABLED',
            error: edCur.isOpenSource
              ? '开源版默认关闭第三方社区/公众号/任意网页抓取接口，请使用本地研报目录或合规 RSS/Webhook'
              : '商业版已按合规要求关闭第三方社区/公众号/任意网页抓取接口，请使用本地研报目录或合规 RSS/Webhook',
          },
          req
        );
    }

    if (edCur.edition === 'cn_commercial' && pathname === '/api/quant/screen-live') {
      return sendJson(
        res,
        403,
        {
          ok: false,
          code: 'EDITION_FEATURE_DISABLED',
          error: '国内商业版不提供全市场实时选股功能，请使用本地历史数据回测实验室进行策略研究验证',
        },
        req
      );
    }

    // -----------------------------------------------------------------------
    // 商业化路由级权益门控（personal / permissive 自动放行；enforced 按 Free/Pro/Max 拦截并返回 HTTP 402）
    // -----------------------------------------------------------------------
    const staticFeature = checkStaticRouteFeature(req.method, pathname);
    if (staticFeature) {
      const denied = checkFeatureEntitlement(staticFeature);
      if (denied) return sendJson(res, 402, denied, req);
    }

    // -----------------------------------------------------------------------
    // API Routes
    // -----------------------------------------------------------------------
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        time: new Date().toISOString(),
        projectRoot: PATHS.projectRoot,
        isPortable: PATHS.isPortableMode,
        kbMode: PATHS.kbMode || 'v1',
      });
    }

    if (pathname === '/api/shutdown' && req.method === 'POST') {
      const confirmHdr = String(req.headers?.['x-srw-local-confirm'] || '').trim();
      if (confirmHdr !== 'shutdown') {
        return sendJson(res, 403, { ok: false, error: '缺少本机安全关机确认头' }, req);
      }
      sendJson(res, 200, { ok: true, shuttingDown: true }, req);
      setTimeout(() => {
        try { cancelAllRunningJobs(); } catch { /* ignore */ }
        try { server.closeAllConnections?.(); } catch { /* ignore */ }
        try { server.close(() => process.exit(0)); } catch { process.exit(0); }
        setTimeout(() => process.exit(0), 1200).unref();
      }, 60);
      return;
    }

    if (pathname === '/api/market/ticker-strip' && req.method === 'GET') {
      const force = parsedUrl.searchParams.get('force') === '1';
      return sendJson(res, 200, await fetchMarketTickerStrip(force), req);
    }

    // 轻量侧栏徽标摘要（零外部网络请求，保障懒挂载下首屏即可显示已有高危预警与情报待办）
    if (pathname === '/api/workbench/sidebar-summary' && req.method === 'GET') {
      return sendJson(res, 200, readLightweightSidebarSummary(), req);
    }

    // 方案 A：工作空间切换、新建本地三库空间 & 离线 Ed25519 授权管理 + 版本特性真源 + EULA 签署门
    if (pathname === '/api/app/profile' && req.method === 'GET') {
      const ed = getEditionInfo();
      const lic = getLicenseStatus();
      return sendJson(res, 200, {
        ok: true,
        edition: ed.edition,
        editionLabel: ed.editionLabel,
        buildDate: ed.buildDate,
        features: ed.features,
        disclaimerText: ed.disclaimerText,
        executionBoundaryText: ed.executionBoundaryText,
        eula: getEulaStatus(),
        workspaceProfile: getWorkspaceProfileInfo(),
        license: lic,
        entitlements: getEntitlementsSnapshot(lic),
      });
    }

    if (pathname === '/api/app/eula' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, eula: getEulaStatus() });
    }

    if (pathname === '/api/app/eula/accept' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const eula = acceptEula(body || {});
      return sendJson(res, 200, { ok: true, eula });
    }

    if (pathname === '/api/demo/market-packet' && req.method === 'GET') {
      const demoPath = path.join(APP_ROOT, 'templates', 'demo-market-packet', 'demo-daily-packet.json');
      if (!fs.existsSync(demoPath)) {
        return sendJson(res, 404, { error: '未找到内置离线演示数据包' });
      }
      const packet = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
      return sendJson(res, 200, { ok: true, packet });
    }

    if (pathname === '/api/app/workspace/switch' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const profile = switchActiveWorkspace({
        targetDir: body.targetDir,
        label: body.label,
        initIfMissing: Boolean(body.initIfMissing),
        template: body.template || 'starter',
      });
      const aud = safeAppendAuditLog({
        category: 'workspace_switch',
        action: 'workspace.switch',
        summary: `切换工作空间至 ${body.label || body.targetDir || ''}`,
        targetIds: [body.label || body.targetDir || 'workspace'],
      });
      return sendJson(res, 200, { ok: true, workspaceProfile: profile, auditRecorded: aud.ok, ...(aud.error ? { auditError: aud.error } : {}) });
    }

    if (pathname === '/api/app/workspace/create' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const profile = createSubWorkspace({
        name: body.name,
        template: body.template || 'starter',
      });
      const aud = safeAppendAuditLog({
        category: 'workspace_switch',
        action: 'workspace.create',
        summary: `新建工作空间「${body.name || ''}」（模板：${body.template || 'starter'}）`,
        targetIds: [body.name || 'new-workspace'],
      });
      return sendJson(res, 200, { ok: true, workspaceProfile: profile, auditRecorded: aud.ok, ...(aud.error ? { auditError: aud.error } : {}) });
    }

    if (pathname === '/api/app/pick-folder' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (folderPickerInFlight) {
        return sendJson(res, 409, {
          ok: false,
          inProgress: true,
          cancelled: false,
          errorCode: 'IN_PROGRESS',
          path: '',
          error: '系统目录选择器已打开，请先完成当前选择或关闭后再试',
        }, req);
      }
      folderPickerInFlight = true;
      try {
        const picked = await pickFolderAsync(body.title, Number(body.timeoutMs) || 120000);
        return sendJson(res, picked.status, picked.payload, req);
      } finally {
        folderPickerInFlight = false;
      }
    }

    // 盘中闪念速记框（Ctrl+Shift+N）
    if (pathname === '/api/quick-notes' && req.method === 'GET') {
      return sendJson(res, 200, listQuickNotes());
    }
    if (pathname === '/api/quick-notes' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, addQuickNote(body || {}));
    }
    if (pathname === '/api/quick-notes/convert' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, markQuickNoteConverted(body.id, body.target));
    }
    if (pathname.startsWith('/api/quick-notes/') && req.method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/quick-notes/'.length));
      return sendJson(res, 200, deleteQuickNote(id));
    }

    if (pathname === '/api/app/license' && req.method === 'GET') {
      const license = getLicenseStatus();
      return sendJson(res, 200, { ok: true, license, entitlements: getEntitlementsSnapshot(license) });
    }

    if (pathname === '/api/app/license/activate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const license = activateLicenseKey(body.licenseKey || '');
      const aud = safeAppendAuditLog({
        category: 'license_change',
        action: 'license.activate',
        summary: `激活授权档位 ${license.tierLabel || license.tier}（编号 ${license.licenseId || '-'}）`,
        targetIds: [license.licenseId || license.tier],
      });
      return sendJson(res, 200, { ok: true, license, entitlements: getEntitlementsSnapshot(license), auditRecorded: aud.ok, ...(aud.error ? { auditError: aud.error } : {}) });
    }

    if (pathname === '/api/app/license/deactivate' && req.method === 'POST') {
      const license = deactivateLicenseKey();
      const aud = safeAppendAuditLog({
        category: 'license_change',
        action: 'license.deactivate',
        summary: '移除本机离线授权码',
      });
      return sendJson(res, 200, { ok: true, license, entitlements: getEntitlementsSnapshot(license), auditRecorded: aud.ok, ...(aud.error ? { auditError: aud.error } : {}) });
    }

    // -----------------------------------------------------------------------
    // 情报信源与定时进化中心（Intel Hub：知识星球 + 公众号双向桥接 + 本地目录 + 公开电报/RSS）
    // -----------------------------------------------------------------------
    if (pathname === '/api/intel/overview' && req.method === 'GET') {
      const overview = getIntelHubOverview();
      const wechatBridge = await getWechatBridgeStatus(overview.config);
      return sendJson(res, 200, { ...overview, wechatBridge });
    }

    if (pathname === '/api/intel/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const config = saveIntelConfig(body);
      const wechatBridge = await getWechatBridgeStatus(config);
      return sendJson(res, 200, { ok: true, config, wechatBridge });
    }

    if (pathname === '/api/intel/zsxq/probe' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const probe = await probeZsxqGroups({ testAccess: body.testAccess !== false });
      return sendJson(res, 200, { ...probe, config: getIntelHubOverview().config });
    }

    if (pathname === '/api/intel/wechat/status' && req.method === 'GET') {
      const status = await getWechatBridgeStatus();
      return sendJson(res, 200, status);
    }

    if (pathname === '/api/intel/wechat/sync' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await triggerWechatIncrementalSync(null, body.bookId || '');
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/intel/wechat/launch-ui' && req.method === 'POST') {
      const result = await launchWechatWebUi();
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/intel/url-fetch' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const item = await fetchSinglePublicUrl(body.url, body.route || 'cognition');
      return sendJson(res, 200, { ok: true, item });
    }

    if (pathname === '/api/intel/run' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const runAi = body.runAi !== false;
      const lookbackDays = Number(body.lookbackDays || 1);
      const job = startJob({
        kind: 'intel_digest',
        title: runAi ? `多信源情报采集与 AI 双轨提纯（近 ${lookbackDays} 天）` : `多信源情报原文拉取（近 ${lookbackDays} 天）`,
        meta: { lookbackDays, runAi, provider: body.provider || '' },
        runner: async (ctx) => {
          const resData = await runIntelPipeline({
            trigger: 'manual',
            runAi,
            lookbackDays,
            sinceDate: body.sinceDate,
            ignoreWatermarks: Boolean(body.ignoreWatermarks),
            syncWechatFirst: Boolean(body.syncWechatFirst),
            channels: body.channels,
            provider: body.provider,
            extraItems: body.extraItems,
            onProgress: (p) => ctx.update({ stage: p.stage }),
          });
          if (body.pushSummary && resData.batch) {
            await dispatchIntelWebhookSummary(resData.batch).catch(() => {});
          }
          return resData;
        },
      });
      return sendJson(res, 200, { ok: true, job });
    }

    if (pathname === '/api/intel/candidate/status' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = updateCandidateStatus(body.batchId, body.cid, body.status);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/intel/watermarks/reset' && req.method === 'POST') {
      return sendJson(res, 200, resetWatermarks());
    }

    // -----------------------------------------------------------------------
    // 本地存量知识库一键扫描与批量导入（Vault Batch Importer）
    // -----------------------------------------------------------------------
    if (pathname === '/api/vault/scan' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, scanLocalVault(body.dirPath, Number(body.maxFiles || 300)));
    }

    if (pathname === '/api/vault/import' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const count = Array.isArray(body.selectedRelPaths) ? body.selectedRelPaths.length : 0;
      const job = startJob({
        kind: 'intel_digest',
        title: `存量本地知识库一键批量导入（${count || '自动'} 份文档）`,
        meta: { dirPath: body.dirPath, mode: body.mode || 'auto' },
        runner: async (ctx) =>
          runVaultBatchImport({
            dirPath: body.dirPath,
            selectedRelPaths: body.selectedRelPaths,
            mode: body.mode || 'auto',
            providerOverride: body.provider,
            onProgress: (p) => ctx.update({ stage: p.stage }),
          }),
      });
      return sendJson(res, 200, { ok: true, job });
    }

    // -----------------------------------------------------------------------
    // 蓝色史莱姆团子 · 高权限可调桌面悬浮 Bot API
    // -----------------------------------------------------------------------
    if (pathname === '/api/bot/state' && req.method === 'GET') {
      return sendJson(res, 200, getBotState());
    }

    if (pathname === '/api/bot/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body && Number(body.permissionLevel) >= 2) {
        const denied = checkFeatureEntitlement('slime_bot_autonomous');
        if (denied) return sendJson(res, 402, denied, req);
      }
      return sendJson(res, 200, updateBotConfig(body));
    }

    if (pathname === '/api/bot/ticker' && req.method === 'GET') {
      const refresh = parsedUrl.searchParams.get('refresh') === '1';
      return sendJson(res, 200, await getMiniTickerSnapshot(refresh));
    }

    if (pathname === '/api/bot/chat' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await runBotChat({ message: body.message, providerOverride: body.provider });
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/bot/approve' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await approveBotAction({ messageId: body.messageId, actionId: body.actionId }));
    }

    if (pathname === '/api/bot/undo' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await undoBotBackup(body.backupId));
    }

    if (pathname === '/api/bot/clear' && req.method === 'POST') {
      return sendJson(res, 200, clearBotHistory());
    }

    if (pathname === '/api/bot/launch-desktop-pet' && req.method === 'POST') {
      return sendJson(res, 200, launchDesktopSlimePet(PORT));
    }

    // -----------------------------------------------------------------------
    // 左上角工作台品牌图标、标题自定义 & AI 风格一致性图标重绘
    // -----------------------------------------------------------------------
    if (pathname === '/api/brand' && req.method === 'GET') {
      return sendJson(res, 200, getBrandState());
    }

    if (pathname === '/api/brand' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.reset) return sendJson(res, 200, resetBrandProfile());
      return sendJson(res, 200, saveBrandProfile(body));
    }

    if (pathname === '/api/brand/ai-stylize' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const resData = await stylizeBrandIconWithAi({
        imageBase64: body.imageBase64,
        imageMimeType: body.imageMimeType,
        promptHint: body.promptHint,
        title: body.title,
        stylePreset: body.stylePreset,
        providerOverride: body.provider,
      });
      return sendJson(res, 200, resData);
    }

    if (pathname === '/api/workspace' && req.method === 'GET') {
      const ws = loadWorkspace();
      return sendJson(res, 200, ws);
    }

    if (pathname === '/api/audit' && req.method === 'GET') {
      const result = runQualityAudit();
      return sendJson(res, 200, result);
    }

    // -----------------------------------------------------------------------
    // Three Libraries v2 (kb-v2)：混合图谱检索 / 活视图 Topics / 时效巡检 / 单卡时间轴 / 无损迁移与单文件快照导出
    // -----------------------------------------------------------------------
    if (pathname === '/api/kb/search' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q') || parsedUrl.searchParams.get('query') || '';
      const ticker = parsedUrl.searchParams.get('ticker') || '';
      const regime = parsedUrl.searchParams.get('regime') || '';
      const domain = parsedUrl.searchParams.get('domain') || '';
      const chain = parsedUrl.searchParams.get('chain') || parsedUrl.searchParams.get('chainNode') || '';
      const kindsRaw = parsedUrl.searchParams.get('kinds') || '';
      const kinds = kindsRaw
        ? kindsRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const limitRaw = Number(parsedUrl.searchParams.get('limit') || 15);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(60, Math.floor(limitRaw)) : 15;
      const includeInactive = parsedUrl.searchParams.get('includeInactive') === '1';
      const asOfDate = parsedUrl.searchParams.get('date') || undefined;
      const result = getKbSearch({
        q,
        query: q,
        ticker,
        regime,
        domain,
        chain,
        chainNode: chain,
        ...(kinds && kinds.length ? { kinds } : {}),
        limit,
        includeInactive,
        ...(asOfDate ? { asOfDate } : {}),
      });
      return sendJson(res, 200, { ok: true, kbMode: PATHS.kbMode || 'v1', ...result });
    }

    if (pathname === '/api/kb/topics' && req.method === 'GET') {
      const resTopics = getKbTopics();
      const topics = Array.isArray(resTopics) ? resTopics : Array.isArray(resTopics?.topics) ? resTopics.topics : [];
      return sendJson(res, 200, {
        ok: true,
        kbMode: PATHS.kbMode || 'v1',
        ...(resTopics && !Array.isArray(resTopics) ? resTopics : {}),
        topics,
      });
    }

    if (pathname === '/api/kb/topics/synthesize' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const topicId = String(body?.topicId || '').trim();
      if (!topicId) {
        return sendJson(res, 400, { ok: false, error: '请提供有效的 topicId（如 T-ai-optical）' });
      }
      const resTopics = getKbTopics();
      const topics = Array.isArray(resTopics) ? resTopics : Array.isArray(resTopics?.topics) ? resTopics.topics : [];
      const topic = topics.find((t) => t && t.id === topicId);
      if (!topic) {
        return sendJson(res, 404, { ok: false, error: `未找到指定产业链活视图专题：${topicId}` });
      }

      const ws = loadWorkspace();
      const memberEntries = Array.isArray(topic.members)
        ? topic.members
        : [...(Array.isArray(topic.activeMembers) ? topic.activeMembers : []), ...(Array.isArray(topic.inactiveMembers) ? topic.inactiveMembers : [])];
      const memberIdSet = new Set(
        memberEntries.map((m) => String(typeof m === 'string' ? m : m?.id || m?.cardId || m?.kbId || '').replace(/[^\d]/g, '').padStart(3, '0')).filter(Boolean)
      );
      const memberCards = ws.cognition.cards
        .filter((c) => memberIdSet.has(c.id) || (Array.isArray(c.v2Meta?.topics) && c.v2Meta.topics.includes(topicId)))
        .map((c) => ({
          id: c.v2Meta?.kbId || `C:${c.id}`,
          title: c.title,
          date: c.ingestedDate || '',
          grade: c.evidenceGrades.join('/'),
          status: c.v2Meta?.status || 'active',
          refuters: c.v2Meta?.refuters || [],
          isExpired: Boolean(c.v2Meta?.isExpired),
          validUntil: c.v2Meta?.validUntil || null,
          facts: String(c.facts || '').slice(0, 420),
          industryImplications: String(c.industryImplications || '').slice(0, 260),
          aShareMapping: String(c.aShareMapping || '').slice(0, 200),
          invalidationConditions: String(c.invalidationConditions || '').slice(0, 200),
        }));

      if (memberCards.length === 0) {
        return sendJson(res, 400, { ok: false, error: `专题「${topic.title || topicId}」暂无成员认知卡可供起草共识摘要` });
      }

      const systemPrompt = `你是专业二级投研产业链首席研究员，正在为知识库 v2 活视图专题起草「人工审核前共识摘要草稿」。

【铁律】
1. 事实零编造：只能基于下方提供的成员认知卡提炼，每个核心论断后必须标注来源卡号（如 [C:096]）。
2. 防幻觉与真相裁决：若某张成员卡 status 为 partially_falsified（存在 refuters）或 isExpired=true，必须明确降权并在「多空分歧与已证伪边界」中交代最新反证卡如何修正旧结论。
3. 合规红线：本软件为个人投研笔记工具，严禁输出买卖评级、目标价预测或投资建议。
4. 输出严格合法的单个 JSON 对象：{"draftSummary": "结构化中文 Markdown 共识摘要（含：### 一、当前核心共识 / ### 二、分歧与已部分证伪边界 / ### 三、关键观测指标与失效触发点 / ### 四、产业链映射要点）"}。`;

      const userPrompt = `请为专题 **${topic.id}｜${topic.title || topicId}** 基于以下 ${memberCards.length} 张成员认知卡起草新版共识摘要。

=== 既有共识摘要（如有，供对比演进） ===
${String(topic.consensusSummary || topic.summaryMarkdown || '').trim() || '（暂无既有共识摘要）'}

=== 专题成员认知卡清单 ===
${JSON.stringify(memberCards, null, 2)}

请严格仅输出单个 JSON 对象：{"draftSummary": "..."}`;

      const modelRes = await invokeModel({
        providerOverride: body?.provider,
        systemPrompt,
        userPrompt,
        expectJson: true,
        timeoutMs: 180000,
      });

      let draftSummary = '';
      try {
        const parsed = parseJsonFromModelOutput(modelRes.rawText);
        draftSummary = String(parsed?.draftSummary || parsed?.summaryMarkdown || parsed?.summary || '').trim();
      } catch {
        draftSummary = String(modelRes.rawText || '').trim();
      }
      if (!draftSummary) {
        draftSummary = String(modelRes.rawText || '').trim();
      }

      return sendJson(res, 200, {
        ok: true,
        topicId,
        topicTitle: topic.title || topicId,
        memberCount: memberCards.length,
        draftSummary,
        provider: modelRes.provider,
        model: modelRes.model,
        latencyMs: modelRes.latencyMs,
      });
    }

    if (pathname === '/api/kb/topics/save-summary' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const topicId = String(body?.topicId || '').trim();
      if (!topicId) {
        return sendJson(res, 400, { ok: false, error: '请提供有效的 topicId' });
      }
      if (typeof body?.summaryMarkdown !== 'string') {
        return sendJson(res, 400, { ok: false, error: '请提供 summaryMarkdown 字符串内容' });
      }
      const saved = saveTopicConsensusSummary(topicId, body.summaryMarkdown);
      const aud = safeAppendAuditLog({
        category: 'library_mutation',
        action: 'kb.topic.saveSummary',
        summary: `更新产业链活视图 ${topicId} 共识摘要并同步 SQLite 索引`,
        targetIds: [topicId],
      });
      return sendJson(res, 200, {
        ok: true,
        ...(saved && typeof saved === 'object' ? saved : { topic: saved }),
        auditRecorded: aud.ok,
        ...(aud.error ? { auditError: aud.error } : {}),
      });
    }

    if (pathname === '/api/kb/stale' && req.method === 'GET') {
      const dateParam = parsedUrl.searchParams.get('date') || undefined;
      const report = getKbStale(dateParam);
      return sendJson(res, 200, { ok: true, kbMode: PATHS.kbMode || 'v1', ...report });
    }

    if (
      req.method === 'GET' &&
      (pathname === '/api/kb/card/timeline' || /^\/api\/kb\/card\/[^/]+\/timeline$/.test(pathname))
    ) {
      const id =
        pathname === '/api/kb/card/timeline'
          ? String(parsedUrl.searchParams.get('id') || '').trim()
          : decodeURIComponent(pathname.slice('/api/kb/card/'.length, -'/timeline'.length)).trim();
      if (!id) {
        return sendJson(res, 400, { ok: false, error: '请提供卡片 id 参数（如 M:067 或 067）' });
      }
      const timeline = getKbCardTimeline(id);
      return sendJson(res, 200, { ok: true, kbMode: PATHS.kbMode || 'v1', ...timeline });
    }

    if (pathname === '/api/kb/migrate-from-v1' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = migrateCurrentWorkspaceToV2({ force: Boolean(body?.force) });
      if (result && result.ok === false) {
        return sendJson(res, result.alreadyExists ? 409 : 400, result);
      }
      const aud = safeAppendAuditLog({
        category: 'library_mutation',
        action: 'kb.migrateFromV1',
        summary: `只读迁移现行三库至 KB v2 卡片库（原件严格只读留存）`,
        targetIds: [result?.kbDir || PATHS.kbDir || 'kb'],
      });
      return sendJson(res, 200, {
        ok: true,
        ...(result && typeof result === 'object' ? result : {}),
        verified: Boolean(result?.lossless?.ok),
        stats: result?.counts || null,
        auditRecorded: aud.ok,
        ...(aud.error ? { auditError: aud.error } : {}),
      });
    }

    if (pathname === '/api/kb/export-monolith' && req.method === 'POST') {
      const result = exportKbMonolithSnapshots();
      const files = [
        result?.methodologySnapshot?.path,
        result?.cognitionSnapshot?.path,
      ].filter(Boolean);
      const aud = safeAppendAuditLog({
        category: 'library_mutation',
        action: 'kb.exportMonolith',
        summary: `导出 KB v2 经典单文件兼容快照（exports/*.compiled.md）`,
        targetIds: files.length > 0 ? files : ['exports'],
      });
      return sendJson(res, 200, {
        ok: true,
        ...(result && typeof result === 'object' ? result : {}),
        files,
        auditRecorded: aud.ok,
        ...(aud.error ? { auditError: aud.error } : {}),
      });
    }

    if (pathname === '/api/archive-doc' && req.method === 'GET') {
      const rel = parsedUrl.searchParams.get('path') || '';
      const resolved = safeResolveInProject(rel);
      if (!fs.existsSync(resolved) || !resolved.endsWith('.md')) {
        return sendJson(res, 404, { error: '未找到对应归档 Markdown 文件' });
      }
      const content = fs.readFileSync(resolved, 'utf8');
      return sendJson(res, 200, { path: resolved, name: path.basename(resolved), content });
    }

    if (pathname === '/api/evidence/file' && req.method === 'GET') {
      const name = parsedUrl.searchParams.get('name') || '';
      if (!name || /[\\/]/.test(name) || !name.endsWith('.json')) {
        return sendJson(res, 400, { error: '非法文件名' });
      }
      const target = path.join(PATHS.reviewWorkbenchDir, name);
      if (!fs.existsSync(target)) return sendJson(res, 404, { error: '文件不存在' });
      const data = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, ''));
      const check = checkEvidenceRecord(data);
      return sendJson(res, 200, { name, data, check });
    }

    if (pathname === '/api/evidence/check' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const check = checkEvidenceRecord(body);
      return sendJson(res, 200, check);
    }

    if (pathname === '/api/evidence/save' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const { fileName, record } = body;
      const check = checkEvidenceRecord(record);
      if (!check.ok) {
        return sendJson(res, 400, { error: '证据核验未通过，拒绝保存', check });
      }
      const safeName = (fileName || `${record.review_date}_复盘证据.json`).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5.]/g, '_');
      const finalName = safeName.endsWith('.json') ? safeName : `${safeName}.json`;
      fs.mkdirSync(PATHS.reviewWorkbenchDir, { recursive: true });
      const target = path.join(PATHS.reviewWorkbenchDir, finalName);
      fs.writeFileSync(target, JSON.stringify(record, null, 2) + '\n', 'utf8');
      return sendJson(res, 200, { ok: true, fileName: finalName, path: target, check });
    }

    if (pathname === '/api/mutate/preview' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const plan = buildMutationPlan(body.action, body.payload || {});
      const baseHashes = {};
      for (const [k, f] of Object.entries(plan.files || {})) {
        if (typeof f.before === 'string') baseHashes[k] = require('./parser.cjs').sha256(f.before);
      }
      return sendJson(res, 200, {
        ok: plan.ok,
        action: plan.action,
        date: plan.date,
        baseHashes,
        validationErrors: plan.validationErrors,
        summaryBullets: plan.summaryBullets,
        diffs: plan.diffs,
      });
    }

    if (pathname === '/api/mutate/commit' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const plan = buildMutationPlan(body.action, body.payload || {});
      if (!plan.ok) {
        return sendJson(res, 400, { error: plan.validationErrors.join('；'), validationErrors: plan.validationErrors });
      }
      if (body.expectedBaseHashes && typeof body.expectedBaseHashes === 'object') {
        const { sha256: calcHash } = require('./parser.cjs');
        for (const [k, expected] of Object.entries(body.expectedBaseHashes)) {
          const targetFile = plan.files?.[k];
          if (expected && targetFile && typeof targetFile.before === 'string' && calcHash(targetFile.before) !== expected) {
            return sendJson(res, 409, {
              ok: false,
              code: 'CONFLICT_MODIFIED',
              error: `写入冲突：文件「${targetFile.label}」在预览后已被其他操作修改，请刷新后重新预览确认。`,
            });
          }
        }
      }
      const result = commitMutationPlan(plan, { actor: 'local_user' });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (pathname === '/api/backups' && req.method === 'GET') {
      return sendJson(res, 200, { backups: listBackups() });
    }

    if (pathname === '/api/backups/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = restoreBackup(body.backupId, { actor: 'local_user' });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (pathname === '/api/backups/export-zip' && req.method === 'GET') {
      const pack = exportFullBackupZip();
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${pack.fileName}"`,
        'Content-Length': String(pack.buffer.length),
        ...buildCorsHeaders(req),
        'Cache-Control': 'no-store',
      });
      res.end(pack.buffer);
      return;
    }

    if (pathname === '/api/backups/import-zip' && req.method === 'POST') {
      const confirmHdr = String(req.headers?.['x-srw-local-confirm'] || '').trim();
      if (confirmHdr !== 'backup-zip-restore') {
        return sendJson(res, 403, { error: '缺少本机备份还原确认头 X-SRW-Local-Confirm: backup-zip-restore' }, req);
      }
      const body = await readJsonBody(req);
      if (!body.zipBase64) return sendJson(res, 400, { error: '请提供 zipBase64 备份包内容' }, req);
      const out = importFullBackupZip(body.zipBase64);
      const aud = safeAppendAuditLog({
        category: 'backup_restore',
        action: 'backups.importZip',
        summary: `从全量备份 ZIP 还原 ${out.restoredMarkdown.length} 份三库与 ${out.restoredState.length} 份状态文件（现行审计历史已保留）`,
        targetIds: [...out.restoredMarkdown, ...out.restoredState],
        backupId: out.preRestoreBackupId,
      });
      return sendJson(res, 200, { ...out, auditRecorded: aud.ok, ...(aud.error ? { auditError: aud.error } : {}) }, req);
    }

    // 机构级操作审计日志与三库/交割单 Excel(CSV) 汇总导出
    if (pathname === '/api/maintenance/audit-trail' && req.method === 'GET') {
      const category = parsedUrl.searchParams.get('category') || '';
      const q = parsedUrl.searchParams.get('q') || '';
      const limit = Number(parsedUrl.searchParams.get('limit') || 200);
      return sendJson(res, 200, queryAuditTrail({ category, q, limit }), req);
    }

    if (pathname === '/api/maintenance/audit-trail/csv' && req.method === 'GET') {
      const category = parsedUrl.searchParams.get('category') || '';
      const q = parsedUrl.searchParams.get('q') || '';
      const csv = exportAuditTrailCsv({ category, q });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csv.fileName}"`,
        ...buildCorsHeaders(req),
        'Cache-Control': 'no-store',
      });
      res.end(csv.content);
      return;
    }

    if (pathname === '/api/maintenance/export-summary-csv' && req.method === 'GET') {
      const scope = parsedUrl.searchParams.get('scope') || 'all';
      const csv = exportWorkspaceSummaryCsv(scope);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csv.fileName}"`,
        ...buildCorsHeaders(req),
        'Cache-Control': 'no-store',
      });
      res.end(csv.content);
      return;
    }

    if (pathname === '/api/maintenance/diagnostic-zip' && req.method === 'GET') {
      if (!isTrustedLocalRequest(req)) {
        return sendJson(res, 403, { error: '诊断包导出接口仅允许本机受信任前端访问' }, req);
      }
      const diag = buildDiagnosticZipBuffer(PORT);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${diag.fileName}"`,
        'Content-Length': String(diag.buffer.length),
        ...buildCorsHeaders(req),
        'Cache-Control': 'no-store',
      });
      res.end(diag.buffer);
      return;
    }

    // -----------------------------------------------------------------------
    // 真实分钟级行情采集 & GPT/Gemini 自动复盘 API
    // -----------------------------------------------------------------------
    if (pathname === '/api/market/fetch-daily' && req.method === 'POST') {
      const body = await readJsonBody(req);
      let resolvedWatchStocks;
      if (Array.isArray(body.watchStocks)) {
        // 显式传入数组（包含显式空数组 []）：严格按调用方意图执行，绝不回退固定示例股
        resolvedWatchStocks = body.watchStocks;
      } else {
        // 未指定观察池时，仅读取当前工作空间真实非演示 A 股自选；空工作空间则跳过个股采集
        const wl = loadWatchlistConfig();
        resolvedWatchStocks =
          !wl.isDemo && Array.isArray(wl.items)
            ? wl.items
                .filter((x) => x && x.marketKind === 'CN' && /^\d{6}$/.test(String(x.code || '')))
                .map((x) => String(x.code))
                .slice(0, 10)
            : [];
      }
      const packet = await fetchDailyMarketPacket({
        date: body.date,
        watchStocks: resolvedWatchStocks,
      });
      return sendJson(res, 200, { ok: true, packet });
    }

    if (pathname === '/api/ai/config' && req.method === 'GET') {
      const refresh = parsedUrl.searchParams.get('refresh') === '1';
      return sendJson(res, 200, { ok: true, config: getSafeConfigForClient(refresh) });
    }

    if (pathname === '/api/ai/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const saved = saveConfig(body || {});
        return sendJson(res, 200, { ok: true, config: saved });
      } catch (err) {
        if (err && err.statusCode === 409) {
          return sendJson(res, 409, {
            ok: false,
            code: err.code || 'CONFLICT',
            error: err.message,
            config: getSafeConfigForClient(false),
          });
        }
        throw err;
      }
    }

    if (pathname === '/api/ai/test' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await testAiConnection(body.provider);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/ai/chart-vision-analyze' && req.method === 'POST') {
      const body = await readJsonBody(req, 12 * 1024 * 1024);
      const result = await runChartVisionAnalysis(body || {});
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/ai/daily-review/prompt' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.packet || !body.packet.indices) {
        return sendJson(res, 400, { error: '请先拉取真实分钟级行情数据包再生成 Prompt。' });
      }
      const ws = loadWorkspace();
      const { systemPrompt, userPrompt, inferredRegime, kbContextMeta } = buildDailyReviewPrompt(ws, body.packet, body.extraNotes || '');
      return sendJson(res, 200, {
        ok: true,
        systemPrompt,
        userPrompt,
        combinedPrompt: `${systemPrompt}\n\n---\n\n${userPrompt}`,
        ...(inferredRegime ? { inferredRegime } : {}),
        ...(kbContextMeta ? { kbContext: kbContextMeta } : {}),
      });
    }

    if (pathname === '/api/ai/daily-review/run' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      const result = await runAutoDailyReview({
        workspace: ws,
        packet: body.packet,
        extraNotes: body.extraNotes || '',
        providerOverride: body.provider,
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/ai/daily-review/parse-json' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.packet) return sendJson(res, 400, { error: '请先拉取真实分钟级数据包。' });
      const ws = loadWorkspace();
      const parsed = parseJsonFromModelOutput(body.rawText || '');
      const { form, warnings, reconcile } = sanitizeDraft(parsed, ws, body.packet);
      return sendJson(res, 200, { ok: true, form, warnings, reconcile });
    }

    if (pathname === '/api/ai/reconcile/apply' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const { form, applied } = applyReconcileFixes(body.form || {}, body.items || []);
      let nextReconcile = null;
      if (body.kind === 'daily' && body.packet) {
        nextReconcile = reconcileDailyReviewDraft(form, body.packet);
      } else if (body.kind === 'judgment' && body.researchPacket) {
        nextReconcile = reconcileJudgmentDraft(form, body.researchPacket);
      }
      return sendJson(res, 200, { ok: true, form, applied, reconcile: nextReconcile });
    }

    // -----------------------------------------------------------------------
    // 工作模式一：方法论卡片库 & 行业前沿认知库 AI 文献/文档转化 API
    // -----------------------------------------------------------------------
    if (pathname === '/api/ingest/extract' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const extracted = await extractDocumentText({
        fileName: body.fileName,
        base64: body.base64,
      });
      return sendJson(res, 200, { ok: true, extracted });
    }

    if (pathname === '/api/audio/transcribe' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await transcribeAudio({
        fileName: body.fileName || 'voice.webm',
        mimeType: body.mimeType || '',
        base64: body.base64 || '',
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/ingest/prompt' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      const { systemPrompt, userPrompt } = buildIngestionPrompt(
        body.targetLibrary,
        ws,
        body.sourceText || '',
        body.meta || {}
      );
      return sendJson(res, 200, {
        ok: true,
        systemPrompt,
        userPrompt,
        combinedPrompt: `${systemPrompt}\n\n---\n\n${userPrompt}`,
      });
    }

    if (pathname === '/api/ingest/run' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      const resData = await runAiIngestion({
        targetLibrary: body.targetLibrary,
        workspace: ws,
        sourceText: body.sourceText || '',
        meta: body.meta || {},
        providerOverride: body.provider,
      });
      return sendJson(res, 200, resData);
    }

    if (pathname === '/api/ingest/parse-json' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      const parsed = parseJsonFromModelOutput(body.rawText || '');
      const result = sanitizeIngestionResult(body.targetLibrary, parsed, ws, body.meta || {});
      return sendJson(res, 200, { ok: true, targetLibrary: body.targetLibrary, result });
    }

    // -----------------------------------------------------------------------
    // 后台持久 AI 任务队列（切换页面、刷新浏览器任务继续运行不中断）
    // -----------------------------------------------------------------------
    if (pathname === '/api/jobs' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, jobs: listJobs() });
    }

    if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/cancel') && req.method === 'POST') {
      const jobId = pathname.slice('/api/jobs/'.length, -'/cancel'.length);
      const out = cancelJob(jobId);
      if (!out.ok) return sendJson(res, 404, out);
      return sendJson(res, 200, out);
    }

    if (pathname.startsWith('/api/jobs/') && req.method === 'GET') {
      const jobId = pathname.slice('/api/jobs/'.length);
      const job = getJob(jobId);
      if (!job) return sendJson(res, 404, { error: '未找到指定后台任务' });
      return sendJson(res, 200, { ok: true, job });
    }

    if (pathname === '/api/ai/daily-review/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.packet || !body.packet.indices || body.packet.totalIntradayBars === 0) {
        return sendJson(res, 400, { error: '缺少真实分钟级数据包！请先拉取当日真实 1 分钟数据。' });
      }
      const tradeDate = body.packet.actualTradeDate || '当日';
      const job = startJob({
        kind: 'daily_review',
        title: `${tradeDate} 每日复盘自动撰写 (${body.provider || '默认引擎'})`,
        meta: {
          tradeDate,
          provider: body.provider || '',
          intradayBars: body.packet.totalIntradayBars,
        },
        runner: async () => {
          const ws = loadWorkspace();
          return runAutoDailyReview({
            workspace: ws,
            packet: body.packet,
            extraNotes: body.extraNotes || '',
            providerOverride: body.provider,
          });
        },
      });
      return sendJson(res, 200, { ok: true, job });
    }

    if (pathname === '/api/ingest/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.sourceText || String(body.sourceText).trim().length < 20) {
        return sendJson(res, 400, { error: '待转化文本过短（至少 20 字）。' });
      }
      const isMethod = body.targetLibrary === 'methodology';
      const job = startJob({
        kind: isMethod ? 'ingest_methodology' : 'ingest_cognition',
        title: `${isMethod ? '方法论' : '认知库'}文献转化：${body.meta?.sourceName || '粘贴文本'}`,
        meta: {
          targetLibrary: body.targetLibrary,
          sourceName: body.meta?.sourceName || '粘贴文本',
          provider: body.provider || '',
        },
        runner: async () => {
          const ws = loadWorkspace();
          return runAiIngestion({
            targetLibrary: body.targetLibrary,
            workspace: ws,
            sourceText: body.sourceText || '',
            meta: body.meta || {},
            providerOverride: body.provider,
          });
        },
      });
      return sendJson(res, 200, { ok: true, job });
    }

    // -----------------------------------------------------------------------
    // 工作模式二：标的研判 AI 联网一键分析 + 实时资料搜集
    // -----------------------------------------------------------------------
    if (pathname === '/api/market/stock-snapshot' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const snap = await fetchStockSnapshotForJudgment(body.code || '');
      if (!snap) return sendJson(res, 400, { error: '请输入有效的 6 位 A 股代码（如 688809 / 300308 / 002384）。' });
      return sendJson(res, 200, { ok: snap.ok, snapshot: snap });
    }

    if (pathname === '/api/market/stock-research' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const query = String(body.query || body.code || body.targetHint || '').trim();
      if (!query) return sendJson(res, 400, { error: '请输入标的名称或代码（支持 A股如 688809/中际旭创、美股如 NVDA/英伟达/TSM、港股如 00700）。' });
      const packet = await collectStockResearchPacket(query);
      return sendJson(res, 200, { ok: packet.ok, packet });
    }

    // -----------------------------------------------------------------------
    // 跨市场证券搜索 & 实时自选盯盘看板（A股 + 美股 + 港股）
    // -----------------------------------------------------------------------
    if (pathname === '/api/market/search' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q') || '';
      const items = await searchSecurities(q, 16);
      return sendJson(res, 200, { ok: true, items });
    }

    if (pathname === '/api/market/global-overview' && req.method === 'GET') {
      const data = await fetchGlobalMarketsOverview();
      return sendJson(res, 200, data);
    }

    // -----------------------------------------------------------------------
    // 短线模式引擎 API（全景看盘 / 连板天梯与情绪周期 / 异动中心 / 题材与区间 / 双云图 / 竞价 / 龙虎榜 / 复盘训练营 / 个股全屏工作台）
    // -----------------------------------------------------------------------
    if (pathname === '/api/short-term/dashboard' && req.method === 'GET') {
      const force = parsedUrl.searchParams.get('force') === '1';
      return sendJson(res, 200, await fetchShortTermDashboard(force));
    }

    if (pathname === '/api/short-term/ladder' && req.method === 'GET') {
      const dateParam = parsedUrl.searchParams.get('date') || '';
      return sendJson(res, 200, await fetchBoardLadderAndCycle(dateParam));
    }

    if (pathname === '/api/short-term/anomaly' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q') || '';
      return sendJson(res, 200, await fetchAnomalyCenter(q || null));
    }

    if (pathname === '/api/short-term/themes-range' && req.method === 'GET') {
      const params = {
        indexSecid: parsedUrl.searchParams.get('indexSecid') || '1.000001',
        themeCode: parsedUrl.searchParams.get('themeCode') || '',
        startDate: parsedUrl.searchParams.get('startDate') || '',
        endDate: parsedUrl.searchParams.get('endDate') || '',
      };
      return sendJson(res, 200, await fetchThemeMatrixAndRangeStats(params));
    }

    if (pathname === '/api/short-term/themes/search' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q') || '';
      const kind = parsedUrl.searchParams.get('kind') || 'all';
      const limit = Number(parsedUrl.searchParams.get('limit') || 80);
      return sendJson(res, 200, await searchThemeCatalog({ q, kind, limit }));
    }

    if (pathname === '/api/short-term/themes/custom' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...loadCustomThemesStore() });
    }

    if (pathname === '/api/short-term/themes/custom' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, saveCustomTheme(body || {}));
    }

    if (pathname === '/api/short-term/themes/custom/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, deleteCustomTheme(body?.id || body?.code || ''));
    }

    if (pathname === '/api/short-term/themes/pin' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, togglePinTheme(body?.code || ''));
    }

    if (pathname === '/api/short-term/stock-dossier' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q') || parsedUrl.searchParams.get('secid') || '';
      const tf = parsedUrl.searchParams.get('tf') || 'day';
      const data = await fetchStockFullscreenDossier(q, tf);
      if (data.technical?.target?.secid) {
        const drw = getChartDrawings(data.technical.target.secid, tf);
        data.technical.drawings = drw.drawings;
        data.technical.drawingAlerts = evaluateDrawingsOnKlines(
          data.technical.target.secid,
          data.technical.target.name,
          drw.drawings,
          data.technical.klines || []
        );
        data.technical.tradeMarkers = getTradeMarkersForSymbol(data.technical.target.code || data.technical.target.secid);
      }
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/short-term/sprite' && req.method === 'GET') {
      const side = parsedUrl.searchParams.get('side') || 'all';
      const limit = Number(parsedUrl.searchParams.get('limit') || 40);
      return sendJson(res, 200, await fetchShortTermSprite(limit, side));
    }

    if (pathname === '/api/short-term/hot-rank' && req.method === 'GET') {
      const limit = Number(parsedUrl.searchParams.get('limit') || 25);
      return sendJson(res, 200, await fetchHotRankBoard(limit));
    }

    if (pathname === '/api/short-term/news-feeds' && req.method === 'GET') {
      return sendJson(res, 200, await fetchShortTermNewsFeeds());
    }

    if (pathname === '/api/short-term/clouds' && req.method === 'GET') {
      return sendJson(res, 200, await fetchCloudTreemapData());
    }

    if (pathname === '/api/short-term/auction' && req.method === 'GET') {
      return sendJson(res, 200, await fetchAuctionSealRadar());
    }

    if (pathname === '/api/short-term/dragon-tiger' && req.method === 'GET') {
      return sendJson(res, 200, await fetchDragonTigerList(14));
    }

    if (pathname === '/api/short-term/rotation' && req.method === 'GET') {
      return sendJson(res, 200, await fetchSectorRotationQuadrant());
    }

    if (pathname === '/api/short-term/review-training' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...loadReviewTrainingStore() });
    }

    if (pathname === '/api/short-term/review-training' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, saveReviewTrainingEntry(body || {}));
    }

    // -----------------------------------------------------------------------
    // Bot 自主定时任务 & 盯盘主动预警中心 API
    // -----------------------------------------------------------------------
    if (pathname === '/api/bot/watch/state' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...getBotWatchFullState() });
    }

    if (pathname === '/api/bot/watch/settings' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const alertsStore = updateWatchSettings(body || {});
      return sendJson(res, 200, { ok: true, alertsStore, ...getBotWatchFullState() });
    }

    if (pathname === '/api/bot/watch/alerts' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.action === 'toggle') {
        toggleWatchAlert(body.id, body.enabled);
      } else if (body.action === 'delete') {
        deleteWatchAlert(body.id);
      } else {
        await upsertWatchAlert(body || {});
      }
      return sendJson(res, 200, { ok: true, ...getBotWatchFullState() });
    }

    if (pathname === '/api/bot/watch/alerts/evaluate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const resEval = await evaluateWatchAlertsNow({
        ignoreCooldown: Boolean(body?.ignoreCooldown),
        appendBotMessage: appendProactiveBotMessage,
        scanTechnicalRadar,
      });
      return sendJson(res, 200, { ...resEval, watchState: getBotWatchFullState() });
    }

    if (pathname === '/api/bot/watch/schedules' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.action === 'toggle') {
        toggleBotSchedule(body.id, body.enabled);
      } else if (body.action === 'delete') {
        deleteBotSchedule(body.id);
      } else {
        upsertBotSchedule(body || {});
      }
      return sendJson(res, 200, { ok: true, ...getBotWatchFullState() });
    }

    if (pathname === '/api/bot/watch/schedules/run' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = await runBotScheduledTask(body.id, {
        runBotChat: (msg, providerOverride) => runBotChat({ message: msg, providerOverride }),
        appendBotMessage: appendProactiveBotMessage,
        getMiniTickerSnapshot,
      });
      return sendJson(res, 200, { ...out, watchState: getBotWatchFullState() });
    }

    if (pathname === '/api/bot/watch/notifications/read' && req.method === 'POST') {
      const body = await readJsonBody(req);
      markNotificationsRead(body?.ids || null);
      return sendJson(res, 200, { ok: true, ...getBotWatchFullState() });
    }

    if (pathname === '/api/watchlist' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        workspaceRoot: path.resolve(PATHS.projectRoot),
        ...loadWatchlistConfig(),
      });
    }

    if (pathname === '/api/watchlist' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const requestedWs = String(body?.workspaceRoot || req.headers?.['x-srw-workspace'] || '').trim();
      const activeWs = path.resolve(PATHS.projectRoot);
      if (requestedWs && path.resolve(requestedWs).toLowerCase() !== activeWs.toLowerCase()) {
        return sendJson(res, 409, {
          ok: false,
          code: 'WORKSPACE_MISMATCH',
          error: '当前窗口所属工作空间已切换，已阻止过期自选写入，请刷新页面后重试',
          activeWorkspaceRoot: activeWs,
          requestedWorkspaceRoot: requestedWs,
        });
      }
      const saved = body.reset ? resetWatchlistConfig({ empty: Boolean(body.empty) }) : saveWatchlistConfig(body || {});
      return sendJson(res, 200, { ok: true, workspaceRoot: activeWs, ...saved });
    }

    if (pathname === '/api/watchlist/add' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const requestedWs = String(body?.workspaceRoot || req.headers?.['x-srw-workspace'] || '').trim();
      const activeWs = path.resolve(PATHS.projectRoot);
      if (requestedWs && path.resolve(requestedWs).toLowerCase() !== activeWs.toLowerCase()) {
        return sendJson(res, 409, {
          ok: false,
          code: 'WORKSPACE_MISMATCH',
          error: '当前窗口所属工作空间已切换，已阻止过期自选写入，请刷新页面后重试',
          activeWorkspaceRoot: activeWs,
          requestedWorkspaceRoot: requestedWs,
        });
      }
      const saved = addWatchlistItem(body?.item || body, { prepend: body?.prepend !== false });
      return sendJson(res, 200, { ok: true, workspaceRoot: activeWs, ...saved });
    }

    if (pathname === '/api/watchlist/live' && req.method === 'GET') {
      const includeIntraday = parsedUrl.searchParams.get('intraday') !== '0';
      const data = await fetchWatchlistLiveBoard({ includeIntraday });
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/watchlist/detail' && req.method === 'GET') {
      const secid = parsedUrl.searchParams.get('secid') || '';
      const tf = parsedUrl.searchParams.get('tf') || 'day';
      const detail = await fetchSecurityDetailChart(secid, tf);
      detail.trendlines = computeTrendlines(detail.klines || [], tf === 'week' ? 80 : 90);
      detail.tradeMarkers = getTradeMarkersForSymbol(detail.code || secid);
      const drw = getChartDrawings(detail.secid || secid, tf);
      detail.drawings = drw.drawings;
      detail.drawingAlerts = evaluateDrawingsOnKlines(detail.secid || secid, detail.name, drw.drawings, detail.klines || []);
      return sendJson(res, 200, detail);
    }

    // -----------------------------------------------------------------------
    // 技术流派引擎：阶段性情绪/股价高点预警 + 多流派一键支撑压力位 + 趋势线流派 + 10态情绪链 + 漂移审计
    // -----------------------------------------------------------------------
    if (pathname === '/api/technical/rules' && req.method === 'GET') {
      const ws = loadWorkspace();
      return sendJson(res, 200, {
        ok: true,
        metricCatalog: METRIC_CATALOG,
        ...loadAlertRules(),
        driftAudit: auditRuleCardDrift(ws),
      });
    }

    if (pathname === '/api/technical/rules' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      const saved = body.reset
        ? resetAlertRules()
        : body.syncHashes
        ? syncRuleCardHashes(ws)
        : saveAlertRules(body.rules || []);
      const aud = safeAppendAuditLog({
        category: 'rule_change',
        action: body.reset ? 'technical.rules.reset' : body.syncHashes ? 'technical.rules.syncHashes' : 'technical.rules.save',
        summary: body.reset
          ? '重置技术预警规则为默认集'
          : body.syncHashes
          ? '同步规则库与方法论卡片哈希基线'
          : `更新技术预警规则库（共 ${(saved.rules || []).length} 条）`,
        targetIds: (saved.rules || []).map((r) => r.id || r.name).filter(Boolean),
      });
      return sendJson(res, 200, {
        ok: true,
        metricCatalog: METRIC_CATALOG,
        ...saved,
        driftAudit: auditRuleCardDrift(ws),
        auditRecorded: aud.ok,
        ...(aud.error ? { auditError: aud.error } : {}),
      });
    }

    if (pathname === '/api/technical/sentiment-chain' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...loadSentimentChain() });
    }

    if (pathname === '/api/technical/radar' && req.method === 'GET') {
      const data = await scanTechnicalRadar();
      const ws = loadWorkspace();
      data.driftAudit = auditRuleCardDrift(ws);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/technical/analyze' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q') || parsedUrl.searchParams.get('secid') || '';
      const tf = parsedUrl.searchParams.get('tf') || 'day';
      const data = await analyzeSecurityTechnicals(q, tf);
      data.tradeMarkers = getTradeMarkersForSymbol(data.target?.code || data.target?.secid || q);
      const drw = getChartDrawings(data.target?.secid || q, tf);
      data.drawings = drw.drawings;
      data.drawingAlerts = evaluateDrawingsOnKlines(data.target?.secid || q, data.target?.name || q, drw.drawings, data.klines || []);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/technical/extract-from-cards' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      const result = await extractRulesFromMethodologyCards({
        workspace: ws,
        cardIds: body.cardIds || [],
        useAi: Boolean(body.useAi),
        providerOverride: body.provider,
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/ai/judgment/prompt' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      let researchPacket = body.researchPacket || null;
      const queryStr = String(body.meta?.stockCode || body.meta?.targetHint || '').trim();
      if (!researchPacket && body.enableWebResearch !== false && queryStr) {
        researchPacket = await collectStockResearchPacket(queryStr);
      }
      const { systemPrompt, userPrompt, kbContextMeta } = buildJudgmentPrompt(ws, body.sourceText || '', body.meta || {}, researchPacket);
      return sendJson(res, 200, {
        ok: true,
        systemPrompt,
        userPrompt,
        combinedPrompt: `${systemPrompt}\n\n---\n\n${userPrompt}`,
        researchPacket,
        ...(kbContextMeta ? { kbContext: kbContextMeta } : {}),
      });
    }

    if (pathname === '/api/ai/judgment/parse-json' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      const parsed = parseJsonFromModelOutput(body.rawText || '');
      const sanitized = sanitizeJudgmentDraft(parsed, ws, body.meta || {}, body.researchPacket || null);
      return sendJson(res, 200, { ok: true, ...sanitized });
    }

    if (pathname === '/api/ai/judgment/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const text = String(body.sourceText || '').trim();
      const targetHint = String(body.meta?.targetHint || '').trim();
      const stockCode = String(body.meta?.stockCode || '').trim();
      if (text.length < 15 && !targetHint && !stockCode) {
        return sendJson(res, 400, { error: '请输入标的名称或代码（支持 A股/美股/港股）以联网搜集资料，或上传/粘贴至少 15 字材料。' });
      }
      const label = targetHint || stockCode || body.meta?.sourceName || '目标标的';
      const enableWebResearch = body.enableWebResearch !== false;
      const debateMode = Boolean(body.debateMode);
      const job = startJob({
        kind: 'judgment_draft',
        title: `标的研判${debateMode ? '投委会对抗' : enableWebResearch ? '联网' : ''}分析：${label}`,
        meta: {
          targetHint: label,
          stockCode,
          enableWebResearch,
          debateMode,
          provider: body.provider || '',
        },
        runner: async () => {
          const ws = loadWorkspace();
          return runAiJudgmentDraft({
            workspace: ws,
            sourceText: text,
            meta: body.meta || {},
            researchPacket: body.researchPacket || null,
            enableWebResearch,
            debateMode,
            providerOverride: body.provider,
          });
        },
      });
      return sendJson(res, 200, { ok: true, job });
    }

    // -----------------------------------------------------------------------
    // P0-1 / P0-2：盘前预检收件箱 + 研判 T+N 自动追踪 + 否决观察池 + 交易所重点监管名单
    // -----------------------------------------------------------------------
    if (pathname === '/api/preflight' && req.method === 'GET') {
      const ws = loadWorkspace();
      const drift = auditRuleCardDrift(ws);
      let tradeQuick = null;
      try {
        tradeQuick = await computeTradeLedgerAnalytics(ws, { withMarketData: true });
      } catch (err) {
        const msg = err?.message || '持仓实时行情核验失败';
        tradeQuick = {
          holdingStopAlerts: [],
          holdingStopUnverified: [
            {
              code: 'ALL',
              name: '全部持仓止损',
              detail: `持仓止损校验异常（${msg}），请进入交易账本手动核验现价与止损位。`,
            },
          ],
          stopLossCoverage: {
            withMarketData: true,
            openHoldingsCount: 0,
            trackedStopCount: 0,
            verifiedCount: 0,
            unverifiedCount: 1,
            triggeredCount: 0,
            quoteAsOf: null,
            status: 'unverified',
            error: msg,
          },
        };
      }
      const report = buildPreflightReport(ws, {
        driftedRules: drift.driftedRules,
        holdingStopAlerts: tradeQuick.holdingStopAlerts || [],
        holdingStopUnverified: tradeQuick.holdingStopUnverified || [],
        stopLossCoverage: tradeQuick.stopLossCoverage || null,
      });
      const chain = loadSentimentChain();
      report.latestSentimentNode = chain.history.length ? chain.history[chain.history.length - 1] : null;
      return sendJson(res, 200, report);
    }

    if (pathname === '/api/judgments/tracker' && req.method === 'GET') {
      const force = parsedUrl.searchParams.get('refresh') === '1';
      const ws = loadWorkspace();
      const data = await trackJudgmentsAndVetos(ws, force);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/veto-ledger' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...loadVetoLedger() });
    }

    if (pathname === '/api/veto-ledger' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.action === 'delete' && body.id) {
        return sendJson(res, 200, { ok: true, ...deleteVetoEntry(body.id) });
      }
      const item = addVetoEntry(body || {});
      return sendJson(res, 200, { ok: true, item });
    }

    if (pathname === '/api/regulatory-watchlist' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...loadRegulatoryWatchlist() });
    }

    if (pathname === '/api/regulatory-watchlist' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const saved = saveRegulatoryWatchlist(body.items || []);
      const aud = safeAppendAuditLog({
        category: 'rule_change',
        action: 'regulatory.watchlist.save',
        summary: `更新卡片174监管红线监控名单（共 ${(saved.items || []).length} 只）`,
        targetIds: (saved.items || []).map((x) => x.code || x.name).filter(Boolean),
      });
      return sendJson(res, 200, { ok: true, ...saved, auditRecorded: aud.ok, ...(aud.error ? { auditError: aud.error } : {}) });
    }

    // -----------------------------------------------------------------------
    // P1-1：实盘 / 模拟交易账本与交割单归因中心（含 CSV/AI截图导入 & B/S点位）
    // -----------------------------------------------------------------------
    if (pathname === '/api/trades/analytics' && req.method === 'GET') {
      const force = parsedUrl.searchParams.get('refresh') === '1';
      const ws = loadWorkspace();
      const data = await computeTradeLedgerAnalytics(ws, { withMarketData: true, forceRefresh: force });
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/trades/markers' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('code') || parsedUrl.searchParams.get('secid') || '';
      return sendJson(res, 200, { ok: true, ...getTradeMarkersForSymbol(q) });
    }

    if (pathname === '/api/trades' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.action === 'delete' && body.id) {
        const delRes = deleteTrade(body.id);
        const aud = safeAppendAuditLog({
          category: 'trade_import',
          action: 'trades.delete',
          summary: `删除交易记录 ${body.id}`,
          targetIds: [body.id],
        });
        return sendJson(res, 200, { ok: true, ...delRes, auditRecorded: aud.ok, ...(aud.error ? { auditError: aud.error } : {}) });
      }
      if (body.action === 'update' && body.id) {
        const updated = updateTrade(body.id, body.patch || {});
        const aud = safeAppendAuditLog({
          category: 'trade_import',
          action: 'trades.update',
          summary: `更新交易记录 ${body.id}`,
          targetIds: [body.id],
        });
        return sendJson(res, 200, { ok: true, trade: updated, auditRecorded: aud.ok, ...(aud.error ? { auditError: aud.error } : {}) });
      }
      if (body.action === 'settings') {
        const saved = updateTradeSettings(body.settings || {});
        const aud = safeAppendAuditLog({
          category: 'trade_import',
          action: 'trades.settings',
          summary: '更新交易账本风控资金配置',
        });
        return sendJson(res, 200, { ok: true, settings: saved, auditRecorded: aud.ok, ...(aud.error ? { auditError: aud.error } : {}) });
      }
      const entries = Array.isArray(body.trades) ? body.trades : [body.trade || body];
      const resAdd = addTrades(entries);
      const allTradeIds = (resAdd.added || []).map((tr) => `${tr.id}${tr.code ? `:${tr.code}` : ''}`).filter(Boolean);
      const aud = safeAppendAuditLog({
        category: 'trade_import',
        action: 'trades.add',
        summary: `新增/导入 ${(resAdd.added || []).length} 笔交易记录（总计 ${resAdd.total} 笔）`,
        targetIds: allTradeIds,
        meta: { addedCount: (resAdd.added || []).length, totalCount: resAdd.total },
      });
      return sendJson(res, 200, { ok: true, ...resAdd, auditRecorded: aud.ok, ...(aud.error ? { auditError: aud.error } : {}) });
    }

    if (pathname === '/api/trades/parse-csv' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const parsed = parseBrokerCsvText(body.csvText || '');
      return sendJson(res, 200, { ok: true, ...parsed });
    }

    if (pathname === '/api/trades/parse-ai' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const parsed = await parseTradesWithAi({
        text: body.text || '',
        imageBase64: body.imageBase64 || '',
        imageMimeType: body.imageMimeType || 'image/png',
        providerOverride: body.provider,
      });
      return sendJson(res, 200, parsed);
    }

    // -----------------------------------------------------------------------
    // 模块一：可插拔数据源架构（4 通道适配 + Webhook 被动推流 + 五档/L2 盘口）
    // -----------------------------------------------------------------------
    if (pathname.startsWith('/api/data-sources')) {
      if (!isTrustedLocalRequest(req)) {
        return sendJson(res, 403, { error: '数据源配置接口仅允许本机受信任前端访问' }, req);
      }
    }

    if (pathname === '/api/data-sources' && req.method === 'GET') {
      const safe = getSafeDataSourceConfig(PORT);
      return sendJson(
        res,
        200,
        {
          ok: true,
          ...safe,
          ingestedCount: listIngestedFeeds(200).length,
          contracts: getAdapterContracts(PORT),
        },
        req
      );
    }

    if (pathname === '/api/data-sources' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (isCustomDataSourcePayload(body)) {
        const denied = checkFeatureEntitlement('scheduler_webhooks');
        if (denied) return sendJson(res, 402, denied, req);
      }
      const saved = saveDataSourceConfig(body || {}, PORT);
      clearRouterCaches();
      return sendJson(
        res,
        200,
        {
          ok: true,
          ...saved,
          ingestedCount: listIngestedFeeds(200).length,
          contracts: getAdapterContracts(PORT),
        },
        req
      );
    }

    if (pathname === '/api/data-sources/test' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await testChannelConnection(body.channel, body.draft || null);
      return sendJson(res, 200, result, req);
    }

    if (pathname === '/api/data-sources/webhook-token') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: '禁止通过 GET 读取完整 Token，请在本机配置弹窗通过受信任 POST 确认操作获取' }, req);
      }
      const confirmHdr = String(req.headers?.['x-srw-local-confirm'] || '').trim();
      if (confirmHdr !== 'reveal-token') {
        return sendJson(res, 403, { error: '缺少本机配置确认头 X-SRW-Local-Confirm: reveal-token' }, req);
      }
      return sendJson(
        res,
        200,
        {
          ok: true,
          webhookUrl: `http://127.0.0.1:${PORT}/api/feeds/ingest`,
          token: getWebhookTokenRaw(),
        },
        req
      );
    }

    if (pathname === '/api/short-term/chips' && req.method === 'GET') {
      const secid = (parsedUrl.searchParams.get('secid') || '').trim();
      if (!secid) return sendJson(res, 400, { error: '请提供 secid 参数' });
      return sendJson(res, 200, await fetchShortTermChips(secid));
    }

    if (pathname === '/api/feeds/ingest' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = ingestWebhookFeeds(body, {
        reqHeaders: req.headers,
        allowLegacyHeader: !isValidBearerFeed,
      });
      return sendJson(res, result.status || (result.ok ? 200 : 400), result);
    }

    if (pathname === '/api/feeds/ingest-test' && req.method === 'POST') {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const result = ingestWebhookFeeds(
        {
          title: '【Webhook 联通自测】短线自定义电报推流已打通',
          content: `来自本地测试按钮的实时推送（${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}）。外部付费电报或自建脚本按标准契约 POST /api/feeds/ingest 即可毫秒级直达短线信息流。`,
          source: 'Webhook自测电报',
          channel: 'webhook',
          important: true,
        },
        { bypassAuth: true }
      );
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/feeds/ingested' && req.method === 'GET') {
      const limit = Number(parsedUrl.searchParams.get('limit') || 50);
      return sendJson(res, 200, { ok: true, items: listIngestedFeeds(limit) });
    }

    if (pathname === '/api/feeds/ingested/clear' && req.method === 'POST') {
      return sendJson(res, 200, clearIngestedFeeds());
    }

    if (pathname === '/api/market/orderbook' && req.method === 'GET') {
      const secid = (parsedUrl.searchParams.get('secid') || '').trim();
      if (!secid) return sendJson(res, 400, { error: '请提供 secid 参数，例如 0.300308' });
      const ob = await fetchStockOrderBookAndTicks(secid);
      return sendJson(res, 200, ob);
    }

    // -----------------------------------------------------------------------
    // P2-3：K 线自定义交互画线持久化与预警
    // -----------------------------------------------------------------------
    if (pathname === '/api/chart/drawings' && req.method === 'GET') {
      const secid = parsedUrl.searchParams.get('secid') || '';
      const tf = parsedUrl.searchParams.get('tf') || 'day';
      return sendJson(res, 200, getChartDrawings(secid, tf));
    }

    if (pathname === '/api/chart/drawings' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const saved = saveChartDrawings(body.secid, body.timeframe || 'day', body.drawings || []);
      return sendJson(res, 200, saved);
    }

    // -----------------------------------------------------------------------
    // P1-3：盘中定时巡检 + 离屏多通道告警推送（飞书/企微/钉钉/Bark）+ 盘后自动快照
    // -----------------------------------------------------------------------
    if (pathname === '/api/scheduler/status' && req.method === 'GET') {
      return sendJson(res, 200, getSchedulerStatus());
    }

    if (pathname === '/api/scheduler/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const saved = saveSchedulerConfig(body || {});
      return sendJson(res, 200, { ok: true, config: saved });
    }

    if (pathname === '/api/scheduler/test-webhook' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const channel = body.channel || null;
      const results = await dispatchWebhookMessage(
        '【二级投研·三库工作台】告警推送连通性测试',
        `测试时间：${new Date().toLocaleString('zh-CN')}\n若你收到此消息，说明工作台盘中技术高点/趋势线破位/盘后快照推送已成功打通！`,
        channel
      );
      return sendJson(res, 200, { ok: results.some((r) => r.ok), results });
    }

    if (pathname === '/api/scheduler/run-scan' && req.method === 'POST') {
      const result = await runIntradayScan('manual');
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/scheduler/run-postmarket' && req.method === 'POST') {
      const result = await runPostMarketCapture('manual');
      return sendJson(res, 200, result);
    }

    // -----------------------------------------------------------------------
    // P2-2：周度 / 月度聚合复盘 + AI 深度反思 + 独立 HTML 导出
    // -----------------------------------------------------------------------
    if (pathname === '/api/periodic-review/summary' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      const summary = await buildPeriodicSummary(ws, body || {});
      return sendJson(res, 200, summary);
    }

    if (pathname === '/api/periodic-review/ai' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      const summary = body.summary || (await buildPeriodicSummary(ws, body || {}));
      const aiRes = await runPeriodicAiSynthesis(ws, summary, body.provider);
      return sendJson(res, 200, { ...aiRes, summary });
    }

    if (pathname === '/api/periodic-review/html' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      const summary = body.summary || (await buildPeriodicSummary(ws, body || {}));
      const html = renderPeriodicReviewHtml(summary, body.aiReport || null, { theme: body.theme || 'light' });
      const saved = body.saveToDisk ? savePeriodicHtmlToDisk(summary, html) : null;
      return sendJson(res, 200, {
        ok: true,
        html,
        fileName: `${summary.startDate}_至_${summary.endDate}_${summary.periodLabel}.html`,
        saved,
      });
    }

    // -----------------------------------------------------------------------
    // 每日复盘可视化研报 HTML 生成、下载与本地保存（支持已入库复盘 & 未落库草稿）
    // -----------------------------------------------------------------------
    if (pathname === '/api/daily-review/html' && req.method === 'GET') {
      const id = parsedUrl.searchParams.get('id') || '';
      const dateParam = parsedUrl.searchParams.get('date') || '';
      const embedded = parsedUrl.searchParams.get('embedded') === '1';
      const download = parsedUrl.searchParams.get('download') === '1';
      const theme = parsedUrl.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
      const ws = loadWorkspace();
      const entry =
        ws.ledger.dailyReviews.find((d) => d.id === id) ||
        ws.ledger.dailyReviews.find((d) => d.date === dateParam) ||
        ws.ledger.dailyReviews[0];
      if (!entry) return sendJson(res, 404, { error: '未找到对应的每日复盘记录' });

      const html = renderArchivedDailyReviewHtml(entry, ws, { embedded, theme });
      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      };
      if (download) {
        const fname = `${entry.date}_A股复盘研报.html`;
        headers['Content-Disposition'] = `attachment; filename="${entry.date}_daily_review.html"; filename*=UTF-8''${encodeURIComponent(fname)}`;
      }
      res.writeHead(200, headers);
      res.end(html);
      return;
    }

    if (pathname === '/api/daily-review/html-draft' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      const html = renderDraftDailyReviewHtml(body.form || {}, body.packet || null, ws, {
        embedded: Boolean(body.embedded),
        theme: body.theme === 'dark' ? 'dark' : 'light',
      });
      const d = body.form?.date || body.packet?.actualTradeDate || 'draft';
      return sendJson(res, 200, {
        ok: true,
        html,
        fileName: `${d}_A股复盘研报_草稿.html`,
      });
    }

    if (pathname === '/api/daily-review/save-html' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ws = loadWorkspace();
      let html = '';
      let dateStr = '';
      let suffix = '';

      if (body.id || body.date) {
        const entry =
          ws.ledger.dailyReviews.find((d) => d.id === body.id) ||
          ws.ledger.dailyReviews.find((d) => d.date === body.date);
        if (!entry) return sendJson(res, 404, { error: '未找到指定交易日的复盘记录' });
        dateStr = entry.date;
        html = renderArchivedDailyReviewHtml(entry, ws, { embedded: false, theme: body.theme || 'light' });
      } else if (body.form) {
        dateStr = body.form.date || body.packet?.actualTradeDate || 'draft';
        suffix = '草稿';
        html = renderDraftDailyReviewHtml(body.form, body.packet || null, ws, {
          embedded: false,
          theme: body.theme || 'light',
        });
      } else {
        return sendJson(res, 400, { error: '请提供复盘记录 id 或草稿表单 form。' });
      }

      const saved = saveReportHtmlToDisk(dateStr, html, suffix);
      return sendJson(res, 200, { ok: true, ...saved });
    }

    // -----------------------------------------------------------------------
    // Stage 4：Python + DuckDB 多市场策略回测实验室 API
    // -----------------------------------------------------------------------
    if (pathname === '/api/quant/env' && req.method === 'GET') {
      // 安全加固：禁止通过无确认头的 GET 查询参数执行任意外部可执行路径，仅允许读取已保存配置
      return sendJson(res, 200, detectQuantEnv());
    }

    if (pathname === '/api/quant/env/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      saveQuantConfig(body || {});
      return sendJson(res, 200, detectQuantEnv());
    }

    if (pathname === '/api/quant/env/setup' && req.method === 'POST') {
      const job = startQuantEnvSetupJob();
      return sendJson(res, 200, { ok: true, job });
    }

    if (pathname === '/api/quant/data/summary' && req.method === 'GET') {
      return sendJson(res, 200, getDataSummary());
    }

    if (pathname === '/api/quant/data/bars' && req.method === 'GET') {
      const symbol = parsedUrl.searchParams.get('symbol') || '';
      if (!symbol) return sendJson(res, 400, { error: '请提供 symbol 参数' });
      const data = getSymbolBars({
        symbol,
        market: parsedUrl.searchParams.get('market') || '',
        start: parsedUrl.searchParams.get('start') || '',
        end: parsedUrl.searchParams.get('end') || '',
        freq: parsedUrl.searchParams.get('freq') || '1d',
      });
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/quant/data/sync' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const job = startDataSyncJob(body || {});
      return sendJson(res, 200, { ok: true, job });
    }

    if (pathname === '/api/quant/data/import-csv' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = await importCsvHistory(body || {});
      return sendJson(res, 200, out);
    }

    if (pathname === '/api/quant/strategies' && req.method === 'GET') {
      return sendJson(res, 200, listStrategies());
    }

    if (pathname === '/api/quant/strategies' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, saveStrategy(body || {}));
    }

    if (pathname.startsWith('/api/quant/strategies/') && req.method === 'DELETE') {
      const sid = decodeURIComponent(pathname.slice('/api/quant/strategies/'.length));
      return sendJson(res, 200, deleteStrategy(sid));
    }

    if (pathname === '/api/quant/strategies/from-cards' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = await generateStrategyFromCards({
        cardIds: body.cardIds || [],
        market: body.market || 'CN',
        extraRequirements: body.extraRequirements || '',
        providerOverride: body.provider || null,
      });
      return sendJson(res, 200, out);
    }

    if (pathname === '/api/quant/backtest/run' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const job = startBacktestJob(body || {});
      return sendJson(res, 200, { ok: true, job });
    }

    if (pathname.startsWith('/api/quant/backtest/') && pathname.endsWith('/cancel') && req.method === 'POST') {
      const jobId = decodeURIComponent(pathname.slice('/api/quant/backtest/'.length, -'/cancel'.length));
      const out = cancelJob(jobId);
      if (!out.ok) return sendJson(res, 404, out);
      return sendJson(res, 200, out);
    }

    if (pathname === '/api/quant/runs' && req.method === 'GET') {
      return sendJson(res, 200, listBacktestRuns());
    }

    if (pathname === '/api/quant/published-strategies' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...loadPublishedStrategiesStore() });
    }

    if (pathname === '/api/quant/published-strategies' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, publishLiveStrategy(body || {}));
    }

    if (pathname === '/api/quant/published-strategies/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, deletePublishedStrategy(body?.id || ''));
    }

    if (pathname === '/api/quant/strategy-signals/evaluate' && req.method === 'POST') {
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      const strategy = findStrategyById(body?.strategyId || '');
      if (!strategy) return sendJson(res, 404, { ok: false, error: '未找到指定策略指标' });
      let klines = Array.isArray(body?.klines) ? body.klines : null;
      if (!klines && body?.secid) {
        const secid = String(body.secid);
        const mk = secid.startsWith('105.') || secid.startsWith('106.') || secid.startsWith('107.')
          ? 'US'
          : secid.startsWith('116.')
          ? 'HK'
          : 'CN';
        klines = await fetchMultiTimeframeKlines(secid, mk, body?.timeframe || 'day', 200);
      }
      const ev = evaluateStrategyOnKlines(strategy, klines || []);
      return sendJson(res, 200, {
        ok: true,
        strategy: { id: strategy.id, name: strategy.name, engineKind: strategy.engineKind },
        ...ev,
      });
    }

    if (pathname === '/api/quant/strategy-signals/batch' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = await evaluateStrategyBatch({
        strategyId: body?.strategyId || '',
        secids: Array.isArray(body?.secids) ? body.secids : [],
        timeframe: body?.timeframe || 'day',
      });
      return sendJson(res, 200, out);
    }

    if (pathname === '/api/quant/screen-live' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = await screenLiveMarketStocks(body || {});
      return sendJson(res, 200, out);
    }

    if (pathname.startsWith('/api/quant/runs/') && pathname.endsWith('/csv') && req.method === 'GET') {
      const runId = decodeURIComponent(pathname.slice('/api/quant/runs/'.length, -'/csv'.length));
      const kind = parsedUrl.searchParams.get('kind') === 'equity' ? 'equity' : 'trades';
      const csvObj = getRunCsvContent(runId, kind);
      if (!csvObj) return sendJson(res, 404, { error: '未找到指定回测 CSV 导出文件' });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvObj.fileName}"`,
        'Cache-Control': 'no-store',
      });
      res.end(csvObj.content);
      return;
    }

    if (pathname.startsWith('/api/quant/runs/') && req.method === 'GET') {
      const runId = decodeURIComponent(pathname.slice('/api/quant/runs/'.length));
      const run = getBacktestRun(runId);
      if (!run) return sendJson(res, 404, { error: '未找到指定回测归档' });
      return sendJson(res, 200, run);
    }

    if (pathname.startsWith('/api/quant/runs/') && req.method === 'DELETE') {
      const runId = decodeURIComponent(pathname.slice('/api/quant/runs/'.length));
      return sendJson(res, 200, deleteBacktestRun(runId));
    }

    // -----------------------------------------------------------------------
    // A 股半自动交易计划卡 & 可选券商官方 MiniQMT 本地合规插件槽位 API
    // -----------------------------------------------------------------------
    if (pathname.startsWith('/api/execution/slot')) {
      if (!isTrustedLocalRequest(req)) {
        return sendJson(res, 403, { error: 'MiniQMT 合规槽位配置接口仅允许本机受信任前端访问' }, req);
      }
    }

    if (pathname === '/api/execution/slot' && req.method === 'GET') {
      return sendJson(res, 200, getSafeExecutionSlotState(), req);
    }

    if (pathname === '/api/execution/slot' && req.method === 'POST') {
      const confirmHdr = String(req.headers?.['x-srw-local-confirm'] || '').trim();
      if (confirmHdr !== 'execution-slot-write') {
        return sendJson(res, 403, { error: '缺少本机写入确认头 X-SRW-Local-Confirm: execution-slot-write' }, req);
      }
      const body = await readJsonBody(req);
      return sendJson(res, 200, saveExecutionSlotConfig(body || {}), req);
    }

    if (pathname === '/api/execution/slot/probe' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, probeMiniQmtSlot(body || {}), req);
    }

    if (pathname === '/api/execution/plan-card/calc' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, calculateAShareTradePlan(body || {}));
    }

    // -----------------------------------------------------------------------
    // Static Frontend Hosting (dist/)
    // -----------------------------------------------------------------------
    if (fs.existsSync(DIST_DIR)) {
      const rel = pathname === '/' ? '/index.html' : pathname;
      const safeRel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
      let filePath = path.join(DIST_DIR, safeRel);
      const isStaticAssetReq = /^[/\\](assets|mascots)[/\\]/i.test(safeRel);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        if (isStaticAssetReq) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('Not Found');
          return;
        }
        filePath = path.join(DIST_DIR, 'index.html');
      }
      const ext = path.extname(filePath).toLowerCase();
      const cacheControl =
        ext === '.html'
          ? 'no-cache, no-store, must-revalidate'
          : /[\\/]assets[\\/]/.test(safeRel)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': cacheControl,
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', (streamErr) => {
        recordServerError(streamErr, `STATIC ${safeRel}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        if (!res.writableEnded) res.end('Static asset read error');
      });
      stream.pipe(res);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('三库工作台 API 服务已就绪（前端 dist/ 尚未构建，请运行 npm run build 或 npm run dev）。');
  } catch (err) {
    recordServerError(err, `${req.method || 'GET'} ${pathname}`);
    if (!res.headersSent) {
      const status =
        Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 600
          ? err.statusCode
          : 500;
      sendJson(res, status, { error: err.message || '服务端内部错误' });
    }
  }
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  recordServerError(err, 'unhandledRejection');
  console.error('[SRW unhandledRejection]', err.message);
});

process.on('uncaughtException', (err) => {
  recordServerError(err, 'uncaughtException');
  console.error('[SRW uncaughtException]', err?.stack || err?.message || err);
});

registerWorkspaceChangeHook(() => {
  try { clearShortTermCaches(); } catch { /* ignore */ }
  try { clearTechnicalRadarCache(); } catch { /* ignore */ }
  try { clearBotRuntimeCaches(); } catch { /* ignore */ }
});

const handleGracefulSignal = (sig) => {
  console.log(`[SRW] 收到 ${sig} 信号，正在优雅中止后台任务并关闭服务...`);
  try { cancelAllRunningJobs(`服务端收到 ${sig} 优雅退出`); } catch { /* ignore */ }
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', () => handleGracefulSignal('SIGTERM'));
process.on('SIGINT', () => handleGracefulSignal('SIGINT'));

server.listen(PORT, HOST, () => {
  const addr = server.address();
  if (addr && typeof addr === 'object' && addr.port) activeListenPort = addr.port;
  startBackgroundScheduler();
  startBotWatchDaemon({
    runBotChat: (msg, providerOverride) => runBotChat({ message: msg, providerOverride }),
    appendBotMessage: appendProactiveBotMessage,
    getMiniTickerSnapshot,
    scanTechnicalRadar,
  });
  console.log(`\n  [二级投研 · 三库工作台] 服务已启动`);
  console.log(`  访问地址: http://${HOST}:${PORT}`);
  console.log(`  三库目录: ${PATHS.currentDir}\n`);
});
