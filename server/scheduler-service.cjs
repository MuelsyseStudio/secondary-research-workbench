'use strict';

/**
 * P1-3：盘中定时巡检 + 离屏多通道告警推送（飞书 / 企业微信 / 钉钉 / Bark / 自定义 Webhook）+ 盘后自动快照与补跑调度器
 * 灵感源自 ai-mock-trade scheduler.ts（交易时段门控 + 休眠漏跑补跑）与 daily_stock_analysis_workbench（多通道推送）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { scanTechnicalRadar } = require('./technical-engine.cjs');
const { fetchDailyMarketPacket } = require('./market-fetcher.cjs');
const { evaluateAllDrawingAlerts } = require('./chart-drawings.cjs');
const { loadIntelConfig, runIntelPipeline } = require('./intel-hub.cjs');

const { stateFile } = require('./app-paths.cjs');
const { atomicWriteFileSync } = require('./lru-cache.cjs');
const { encryptSecret, decryptSecret } = require('./secret-vault.cjs');
const CONFIG_PATH = stateFile('scheduler-config.local.json');
const LOGS_PATH = stateFile('scheduler-logs.local.json');

const DEFAULT_CONFIG = {
  enabled: false,
  intradayScanEnabled: true,
  intradayIntervalMin: 15,
  postMarketSnapshotEnabled: true,
  postMarketHour: 15,
  postMarketMinute: 12,
  onlyHighSeverityPush: false,
  webhooks: {
    feishu: { enabled: false, url: '' },
    wecom: { enabled: false, url: '' },
    dingtalk: { enabled: false, url: '' },
    bark: { enabled: false, url: '' },
    custom: { enabled: false, url: '' },
  },
  lastIntradayScanAt: null,
  lastPostMarketDate: null,
  updatedAt: null,
};

function nowOffsetISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isCnTradingWindow(now = new Date()) {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const hm = now.getHours() * 60 + now.getMinutes();
  return (hm >= 570 && hm <= 692) || (hm >= 780 && hm <= 902);
}

function loadSchedulerConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        webhooks: {
          feishu: { ...DEFAULT_CONFIG.webhooks.feishu, ...(raw.webhooks?.feishu || {}), url: decryptSecret(raw.webhooks?.feishu?.url) },
          wecom: { ...DEFAULT_CONFIG.webhooks.wecom, ...(raw.webhooks?.wecom || {}), url: decryptSecret(raw.webhooks?.wecom?.url) },
          dingtalk: { ...DEFAULT_CONFIG.webhooks.dingtalk, ...(raw.webhooks?.dingtalk || {}), url: decryptSecret(raw.webhooks?.dingtalk?.url) },
          bark: { ...DEFAULT_CONFIG.webhooks.bark, ...(raw.webhooks?.bark || {}), url: decryptSecret(raw.webhooks?.bark?.url) },
          custom: { ...DEFAULT_CONFIG.webhooks.custom, ...(raw.webhooks?.custom || {}), url: decryptSecret(raw.webhooks?.custom?.url) },
        },
      };
    }
  } catch {
    // fallback
  }
  return { ...DEFAULT_CONFIG };
}

function maskWebhookUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const segs = u.pathname.split('/').filter(Boolean);
    const maskedPath = segs
      .map((seg, i) => (i === segs.length - 1 && seg.length > 8 ? `${seg.slice(0, 4)}***${seg.slice(-3)}` : seg))
      .join('/');
    const maskedQuery = u.search ? '?***' : '';
    return `${u.origin}/${maskedPath}${maskedQuery}`;
  } catch {
    return s.length > 12 ? `${s.slice(0, 6)}***${s.slice(-4)}` : '***';
  }
}

function saveSchedulerConfig(patch) {
  const cur = loadSchedulerConfig();
  const mergeHook = (key) => {
    const prev = cur.webhooks[key] || { enabled: false, url: '' };
    const inc = patch?.webhooks?.[key] || {};
    let nextUrl = prev.url;
    if (typeof inc.url === 'string') {
      const trimmed = inc.url.trim();
      // 若前端回传了脱敏后的 Webhook URL，保留原磁盘完整密钥地址不覆盖
      if (!trimmed) nextUrl = '';
      else if (prev.url && trimmed === maskWebhookUrl(prev.url)) nextUrl = prev.url;
      else nextUrl = trimmed;
    }
    return { ...prev, ...inc, url: nextUrl };
  };
  const next = {
    ...cur,
    ...patch,
    intradayIntervalMin: Math.max(5, Math.min(60, Number(patch?.intradayIntervalMin ?? cur.intradayIntervalMin) || 15)),
    postMarketHour: Math.max(15, Math.min(23, Number(patch?.postMarketHour ?? cur.postMarketHour) || 15)),
    postMarketMinute: Math.max(0, Math.min(59, Number(patch?.postMarketMinute ?? cur.postMarketMinute) || 12)),
    webhooks: {
      feishu: mergeHook('feishu'),
      wecom: mergeHook('wecom'),
      dingtalk: mergeHook('dingtalk'),
      bark: mergeHook('bark'),
      custom: mergeHook('custom'),
    },
    updatedAt: nowOffsetISO(),
  };
  const toDisk = JSON.parse(JSON.stringify(next));
  for (const k of ['feishu', 'wecom', 'dingtalk', 'bark', 'custom']) {
    if (toDisk.webhooks?.[k]?.url) {
      toDisk.webhooks[k].url = encryptSecret(toDisk.webhooks[k].url);
    }
  }
  atomicWriteFileSync(CONFIG_PATH, JSON.stringify(toDisk, null, 2) + '\n', 'utf8', { mode: 0o600 });
  return getSanitizedSchedulerConfig(next);
}

function getSanitizedSchedulerConfig(cfgInput = null) {
  const cfg = cfgInput || loadSchedulerConfig();
  const webhooks = {};
  for (const [k, v] of Object.entries(cfg.webhooks || {})) {
    webhooks[k] = {
      enabled: Boolean(v?.enabled),
      hasUrl: Boolean(v?.url),
      url: v?.url ? maskWebhookUrl(v.url) : '',
    };
  }
  return { ...cfg, webhooks };
}

function loadSchedulerLogs() {
  try {
    if (fs.existsSync(LOGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LOGS_PATH, 'utf8'));
      if (Array.isArray(raw)) return raw;
    }
  } catch {
    // ignore
  }
  return [];
}

function appendSchedulerLog(entry) {
  const logs = loadSchedulerLogs();
  logs.unshift({
    id: `slog-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    time: nowOffsetISO(),
    ...entry,
  });
  const trimmed = logs.slice(0, 50);
  try {
    fs.writeFileSync(LOGS_PATH, JSON.stringify(trimmed, null, 2) + '\n', 'utf8');
  } catch {
    // non-fatal
  }
  return trimmed[0];
}

// ============================================================================
// 多通道 Webhook 推送引擎（飞书 / 企业微信 / 钉钉 / Bark / 自定义）
// ============================================================================

async function sendToChannel(channelKey, url, title, markdownBody) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl) throw new Error(`${channelKey} Webhook URL 为空`);

  if (channelKey === 'bark') {
    const base = cleanUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ title, body: markdownBody.slice(0, 1000), group: '二级投研工作台' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Bark HTTP ${res.status}`);
    return { ok: true, channel: 'bark' };
  }

  let payload;
  if (channelKey === 'feishu') {
    payload = {
      msg_type: 'post',
      content: {
        post: {
          zh_cn: {
            title,
            content: [[{ tag: 'text', text: markdownBody }]],
          },
        },
      },
    };
  } else if (channelKey === 'wecom') {
    payload = {
      msgtype: 'markdown',
      markdown: { content: `### ${title}\n${markdownBody}` },
    };
  } else if (channelKey === 'dingtalk') {
    payload = {
      msgtype: 'markdown',
      markdown: { title, text: `### ${title}\n${markdownBody}` },
    };
  } else {
    payload = { title, content: markdownBody, sentAt: nowOffsetISO(), source: '二级投研三库工作台' };
  }

  const res = await fetch(cleanUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${channelKey} HTTP ${res.status}: ${t.slice(0, 120)}`);
  }
  return { ok: true, channel: channelKey };
}

async function dispatchWebhookMessage(title, markdownBody, targetChannel = null) {
  const cfg = loadSchedulerConfig();
  const results = [];
  const entries = Object.entries(cfg.webhooks || {});
  for (const [key, ch] of entries) {
    if (targetChannel && targetChannel !== key) continue;
    if (!targetChannel && !ch.enabled) continue;
    if (!ch.url) {
      if (targetChannel) results.push({ channel: key, ok: false, error: '未配置 Webhook 地址' });
      continue;
    }
    try {
      await sendToChannel(key, ch.url, title, markdownBody);
      results.push({ channel: key, ok: true });
    } catch (err) {
      results.push({ channel: key, ok: false, error: err.message });
    }
  }
  return results;
}

// ============================================================================
// 去重预警队列 + 手动/定时巡检执行器
// ============================================================================

const sentAlertKeysToday = new Set();
let sentAlertDate = todayISO();
const recentBrowserNotifs = [];

function resetDailyDedupeIfNeeded() {
  const t = todayISO();
  if (t !== sentAlertDate) {
    sentAlertKeysToday.clear();
    sentAlertDate = t;
  }
}

async function runIntradayScan(triggerSource = 'manual') {
  resetDailyDedupeIfNeeded();
  const cfg = loadSchedulerConfig();
  const radar = await scanTechnicalRadar();
  const drawingAlerts = await evaluateAllDrawingAlerts(radar.stockScans || []);

  const allAlerts = [
    ...(radar.marketAlerts || []).map((a) => ({ ...a, group: '全市场情绪' })),
    ...(radar.stockAlerts || []).map((a) => ({ ...a, group: a.stockName || a.secuCode || '自选标的' })),
    ...drawingAlerts.map((a) => ({ ...a, group: `${a.stockName || a.secid}·自定义画线` })),
  ];

  const filtered = cfg.onlyHighSeverityPush ? allAlerts.filter((a) => a.severity === 'high') : allAlerts;
  const freshAlerts = [];
  for (const a of filtered) {
    const dedupeKey = `${sentAlertDate}::${a.ruleId || a.id}::${a.secid || 'MKT'}`;
    if (triggerSource === 'scheduler' && sentAlertKeysToday.has(dedupeKey)) continue;
    sentAlertKeysToday.add(dedupeKey);
    freshAlerts.push(a);
  }

  let pushResults = [];
  if (freshAlerts.length > 0) {
    const nodeInfo = radar.sentimentChain?.current;
    const scoreTxt = radar.sentiment?.sentimentScore != null ? `${radar.sentiment.sentimentScore}分` : '数据降级';
    const title = `【三库工作台预警】${freshAlerts.length} 项技术/画线信号触发（情绪：${nodeInfo?.node || radar.sentiment?.stage || '暂缺'} ${scoreTxt}）`;
    const body = freshAlerts
      .slice(0, 12)
      .map(
        (a, i) =>
          `${i + 1}. [${a.severity === 'high' ? '高危' : a.severity === 'medium' ? '中级' : '提示'}] ${a.group} · ${a.ruleName}（当前 ${a.actualValue ?? '-'}）— ${a.actionAdvice || ''}`
      )
      .join('\n');

    pushResults = await dispatchWebhookMessage(title, body);
    recentBrowserNotifs.unshift({
      id: `notif-${Date.now()}`,
      time: nowOffsetISO(),
      title,
      body: freshAlerts.slice(0, 4).map((a) => `${a.group}: ${a.ruleName}`).join('；'),
      count: freshAlerts.length,
    });
    if (recentBrowserNotifs.length > 20) recentBrowserNotifs.pop();
  }

  saveSchedulerConfig({ lastIntradayScanAt: nowOffsetISO() });
  const logRec = appendSchedulerLog({
    type: 'intraday_scan',
    source: triggerSource,
    status: 'ok',
    summary: `扫描 ${radar.summary.scannedStockCount} 只标的，命中 ${allAlerts.length} 条预警（含画线 ${drawingAlerts.length} 条），新增推送 ${freshAlerts.length} 条`,
    pushResults,
  });

  return {
    ok: true,
    totalAlerts: allAlerts.length,
    freshCount: freshAlerts.length,
    drawingAlertCount: drawingAlerts.length,
    sentimentNode: radar.sentimentChain?.current || null,
    pushResults,
    log: logRec,
  };
}

async function runPostMarketCapture(triggerSource = 'manual') {
  const today = todayISO();
  const { loadWatchlistConfig } = require('./watchlist-service.cjs');
  const wl = loadWatchlistConfig();
  const workspaceCnCodes =
    !wl.isDemo && Array.isArray(wl.items)
      ? wl.items
          .filter((x) => x && x.marketKind === 'CN' && /^\d{6}$/.test(String(x.code || '')))
          .map((x) => String(x.code))
          .slice(0, 10)
      : [];
  const [radar, packet] = await Promise.all([
    scanTechnicalRadar(),
    fetchDailyMarketPacket({ date: today, watchStocks: workspaceCnCodes }).catch(() => null),
  ]);
  const node = radar.sentimentChain?.current;
  const scoreTxt = radar.sentiment?.sentimentScore != null ? `${radar.sentiment.sentimentScore}分` : '数据降级';
  const title = `【三库工作台盘后快照】${today} · ${node?.node || radar.sentiment?.stage || '行情暂缺'}（${scoreTxt}）`;
  const body = [
    `• 市场节点：${node?.node || '-'}（通道：${node?.channelLabel || '-'}，建议上限 ${node?.maxPositionPct ?? '-'}%）`,
    `• 盘面统计：红盘率 ${radar.sentiment.redRatePct ?? '-'}%｜涨停 ${radar.sentiment.ztCount ?? '-'} / 跌停 ${radar.sentiment.dtCount ?? '-'} / 炸板率 ${radar.sentiment.burstRatePct ?? '-'}%｜最高连板 ${radar.sentiment.maxBoard}板`,
    packet ? `• 1分钟实盘数据包已自动落盘（${packet.totalIntradayBars} 条正式分钟K线），打开「研判与复盘台账」即可直接 AI 撰写复盘。` : '• 行情包抓取暂缺，请稍后手动刷新。',
  ].join('\n');

  const pushResults = await dispatchWebhookMessage(title, body);
  saveSchedulerConfig({ lastPostMarketDate: today });
  const logRec = appendSchedulerLog({
    type: 'post_market',
    source: triggerSource,
    status: 'ok',
    summary: `${today} 盘后快照已落盘（节点=${node?.node || '-'}，1m数据包=${packet ? packet.totalIntradayBars + '条' : '未拉取'}）`,
    pushResults,
  });

  return { ok: true, date: today, node, packetBars: packet?.totalIntradayBars || 0, pushResults, log: logRec };
}

async function dispatchIntelWebhookSummary(batch) {
  if (!batch) return [];
  const s = batch.stats || {};
  const title = `【三库工作台·每日情报进化】新增 ${s.candidateCount || 0} 条候选入库建议（认知 ${s.cognitionCandidateCount || 0} / 方法论 ${s.methodologyCandidateCount || 0}）`;
  const lines = [
    `• 采集概览（自 ${batch.sinceDate}）：共拉取 ${s.totalFetched || 0} 条（新增 ${s.freshCount || 0} 条）｜星球 ${s.byChannel?.zsxq || 0} · 公众号 ${s.byChannel?.wechat || 0} · 本地日报 ${s.byChannel?.local_folder || 0} · 电报/RSS ${(s.byChannel?.public_feed || 0) + (s.byChannel?.rss || 0)}`,
  ];
  if (batch.aiSummaries?.cognition) lines.push(`• 行业认知摘要：${batch.aiSummaries.cognition}`);
  if (batch.aiSummaries?.methodology) lines.push(`• 方法论摘要：${batch.aiSummaries.methodology}`);
  const pendingTitles = (batch.candidates || []).slice(0, 6).map((c, i) => `${i + 1}. [${c.targetLibrary === 'cognition' ? '认知' : '方法论'}] ${c.title}`);
  if (pendingTitles.length > 0) {
    lines.push('• 待审阅候选：');
    lines.push(...pendingTitles);
  }
  lines.push('• 请打开三库工作台「情报信源与进化」勾选并通过 Diff 确认门一键入库。');
  return dispatchWebhookMessage(title, lines.join('\n'));
}

let schedulerTimer = null;
let tickBusy = false;

async function schedulerTick() {
  if (tickBusy) return;
  const cfg = loadSchedulerConfig();
  const intelCfg = loadIntelConfig();
  if (!cfg.enabled && !intelCfg.schedule?.enabled) return;
  tickBusy = true;
  try {
    const now = new Date();
    const today = todayISO();
    const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
    const hm = now.getHours() * 60 + now.getMinutes();

    // 1) 盘中交易时段巡检
    if (cfg.enabled && cfg.intradayScanEnabled && isCnTradingWindow(now)) {
      const lastTs = cfg.lastIntradayScanAt ? new Date(cfg.lastIntradayScanAt).getTime() : 0;
      if (Date.now() - lastTs >= cfg.intradayIntervalMin * 60 * 1000) {
        await runIntradayScan('scheduler');
      }
    }

    // 2) 盘后快照与漏跑补跑（工作日过了设定时间如 15:12 且今日尚未落盘）
    if (cfg.enabled && cfg.postMarketSnapshotEnabled && isWeekday && cfg.lastPostMarketDate !== today) {
      const targetHm = cfg.postMarketHour * 60 + cfg.postMarketMinute;
      if (hm >= targetHm) {
        await runPostMarketCapture('scheduler');
      }
    }

    // 3) 每日情报信源定时采集与 AI 提纯（支持全周每天定时执行，如 20:30，并支持漏跑补跑）
    if (intelCfg.schedule?.enabled && intelCfg.schedule.lastRunDate !== today) {
      const intelTargetHm = Number(intelCfg.schedule.dailyHour ?? 20) * 60 + Number(intelCfg.schedule.dailyMinute ?? 30);
      if (hm >= intelTargetHm) {
        const res = await runIntelPipeline({
          trigger: 'scheduler',
          runAi: intelCfg.schedule.autoAiDistill !== false,
          syncWechatFirst: Boolean(intelCfg.schedule.autoWechatSync),
          lookbackDays: intelCfg.schedule.lookbackDays || 1,
        });
        let pushResults = [];
        if (intelCfg.schedule.pushWebhookSummary !== false && res?.batch) {
          pushResults = await dispatchIntelWebhookSummary(res.batch);
        }
        appendSchedulerLog({
          type: 'intel_daily',
          source: 'scheduler',
          status: 'ok',
          summary: `${today} 定时情报进化完成：拉取 ${res.batch?.stats?.totalFetched || 0} 条，产出 ${res.batch?.stats?.candidateCount || 0} 条待审阅候选`,
          pushResults,
        });
      }
    }
  } catch (err) {
    appendSchedulerLog({ type: 'error', source: 'scheduler', status: 'failed', summary: err.message });
  } finally {
    tickBusy = false;
  }
}

function startBackgroundScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    schedulerTick();
  }, 60 * 1000);
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
  // 启动后 10 秒检查一次是否需要盘后漏跑补跑
  const bootTimer = setTimeout(() => schedulerTick(), 10000);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();
}

function getSchedulerStatus() {
  return {
    ok: true,
    config: getSanitizedSchedulerConfig(),
    inTradingWindow: isCnTradingWindow(),
    logs: loadSchedulerLogs(),
    recentBrowserNotifs: recentBrowserNotifs.slice(0, 10),
  };
}

module.exports = {
  loadSchedulerConfig,
  saveSchedulerConfig,
  getSchedulerStatus,
  dispatchWebhookMessage,
  dispatchIntelWebhookSummary,
  runIntradayScan,
  runPostMarketCapture,
  startBackgroundScheduler,
};
