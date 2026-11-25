'use strict';

/**
 * Bot 自主定时任务调度器 + 实时盯盘预警与主动推送引擎
 *
 * 响应用户需求：
 * - 取消死板的 6 时段 AI 专家广场，改为完全可由用户（或聊天指令）给自己的 Bot（史莱姆/大肥鱼/开源伙伴）自由设定定时任务；
 * - Bot 加入盯盘与预警功能：支持在工作台任意页面设置价格/涨跌幅/量比/严重异动红线预警，也可一键转发工作台技术预警规则（见顶/破位/趋势线），触发时 Bot 主动弹窗气泡 + 写入聊天记录 + 同步 Windows 桌面悬浮宠物 + 可选推飞书/企微/钉钉/Bark！
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { workspaceStateFile } = require('./app-paths.cjs');
const { atomicWriteFileSync } = require('./lru-cache.cjs');
const { getEditionInfo } = require('./edition.cjs');
const {
  inferMarketMetaFromSecid,
  isUnsupportedAssetSecid,
  isCryptoSecid,
  cryptoPairFromSecid,
  fetchCryptoTickers,
} = require('./global-markets.cjs');
const { resolveStockQuery } = require('./stock-researcher.cjs');
const { dispatchWebhookMessage } = require('./scheduler-service.cjs');

function getAlertsPath() {
  return workspaceStateFile('bot-watch-alerts.local.json');
}
function getSchedulesPath() {
  return workspaceStateFile('bot-schedules.local.json');
}
function getNotifsPath() {
  return workspaceStateFile('bot-notifications.local.json');
}

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
};

const ALERT_CONDITIONS = [
  { id: 'price_above', labelZh: '价格突破上限 ≥', labelEn: 'Price >= Target', unit: '' },
  { id: 'price_below', labelZh: '价格跌破下限 ≤', labelEn: 'Price <= Target', unit: '' },
  { id: 'pct_above', labelZh: '盘中涨幅达 ≥', labelEn: 'Intraday Change >= %', unit: '%' },
  { id: 'pct_below', labelZh: '盘中跌幅达 ≤', labelEn: 'Intraday Change <= %', unit: '%' },
  { id: 'vol_ratio_above', labelZh: '放量异动（量比 ≥）', labelEn: 'Volume Ratio >=', unit: 'x' },
];

const SCHEDULE_TEMPLATES = [
  {
    id: 'tpl_premarket',
    name: '盘前早报与异动排雷',
    nameEn: 'Pre-Market Brief & Anomaly Check',
    timeHHMM: '08:30',
    weekdaysOnly: true,
    taskType: 'premarket_brief',
    prompt: '汇总隔夜美股/台韩欧股与全球期货核心异动，检查自选与高连板股的严重异动红线（卡片174），给出今日开盘 3 条观察重点。',
  },
  {
    id: 'tpl_auction',
    name: '竞价异动与主线快扫',
    nameEn: 'Opening Auction Pulse',
    timeHHMM: '09:27',
    weekdaysOnly: true,
    taskType: 'market_pulse',
    prompt: '扫描今日自选股与连板梯队开盘竞价强弱，标出大幅高开/核按钮风险标的并给出仓位提醒。',
  },
  {
    id: 'tpl_midday',
    name: '午盘温度与资金总结',
    nameEn: 'Midday Temperature Summary',
    timeHHMM: '12:30',
    weekdaysOnly: true,
    taskType: 'midday_check',
    prompt: '播报半日两市成交额与盘面温度、主力净流入前三方向、炸板率变化，给出下午盯盘重点。',
  },
  {
    id: 'tpl_close',
    name: '收盘连板复盘与自选诊断',
    nameEn: 'Market Close Review',
    timeHHMM: '15:30',
    weekdaysOnly: true,
    taskType: 'close_review',
    prompt: '总结今日涨跌停与连板天梯高度、昨日涨停溢价及自选股收盘强弱，提示触发技术预警的标的。',
  },
];

function nowOffsetISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function readJson(p, fallback) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // ignore
  }
  return fallback;
}

function writeJson(p, obj) {
  atomicWriteFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function isCnTradingHour(now = new Date()) {
  const d = now.getDay();
  if (d === 0 || d === 6) return false;
  const hm = now.getHours() * 60 + now.getMinutes();
  return (hm >= 555 && hm <= 695) || (hm >= 775 && hm <= 910);
}

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

// ============================================================================
// 1. 预警规则存取（支持全局技术预警转发开关 + 个股/期货价格/涨跌/量比规则）
// ============================================================================

function loadWatchAlertsStore() {
  const raw = readJson(getAlertsPath(), null);
  if (!raw || typeof raw !== 'object') {
    return {
      enabled: true,
      forwardTechnicalRules: false,
      forwardAnomalyRedline: true,
      pollIntervalSec: 120,
      alerts: [],
      techCooldownMap: {},
      updatedAt: null,
    };
  }
  return {
    enabled: raw.enabled !== false,
    forwardTechnicalRules: Boolean(raw.forwardTechnicalRules),
    forwardAnomalyRedline: raw.forwardAnomalyRedline !== false,
    pollIntervalSec: Math.max(60, Math.min(600, Number(raw.pollIntervalSec) || 120)),
    alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
    techCooldownMap: raw.techCooldownMap && typeof raw.techCooldownMap === 'object' ? raw.techCooldownMap : {},
    updatedAt: raw.updatedAt || null,
  };
}

function saveWatchAlertsStore(store) {
  const payload = {
    ...store,
    updatedAt: nowOffsetISO(),
  };
  writeJson(getAlertsPath(), payload);
  return payload;
}

function updateWatchSettings(patch = {}) {
  const store = loadWatchAlertsStore();
  if (typeof patch.enabled === 'boolean') store.enabled = patch.enabled;
  if (typeof patch.forwardTechnicalRules === 'boolean') store.forwardTechnicalRules = patch.forwardTechnicalRules;
  if (typeof patch.forwardAnomalyRedline === 'boolean') store.forwardAnomalyRedline = patch.forwardAnomalyRedline;
  if (patch.pollIntervalSec != null) {
    store.pollIntervalSec = Math.max(20, Math.min(300, Number(patch.pollIntervalSec) || 45));
  }
  return saveWatchAlertsStore(store);
}

async function upsertWatchAlert(input = {}) {
  const store = loadWatchAlertsStore();
  let secid = String(input.secid || '').trim();
  let name = String(input.name || '').trim();
  let code = String(input.code || '').trim();
  let secuCode = String(input.secuCode || '').trim();
  let marketKind = String(input.marketKind || '').trim();
  let currency = String(input.currency || '').trim();

  if (!secid && input.query) {
    const resolved = await resolveStockQuery(String(input.query).trim());
    if (!resolved?.resolved || !resolved.secid) {
      throw new Error(`无法识别预警标的：${input.query}`);
    }
    secid = resolved.secid;
    name = name || resolved.name;
    code = code || resolved.code;
    secuCode = secuCode || resolved.secuCode;
    marketKind = marketKind || resolved.marketKind;
    currency = currency || resolved.currency;
  }

  if (isUnsupportedAssetSecid(secid) || (!getEditionInfo().features.crypto && String(marketKind || '').toUpperCase() === 'CRYPTO')) {
    throw new Error('当前版本不支持该资产类型');
  }
  if (!secid || !/^(?:\d+|crypto)\.[A-Za-z0-9._-]+$/i.test(secid)) {
    throw new Error(getEditionInfo().features.crypto ? '请先选择有效的预警标的（支持全球股票、期货与扩展资产）' : '请先选择有效的预警标的（支持 A股、港美股、全球股市与期货）');
  }
  const meta = inferMarketMetaFromSecid(secid);
  const condition = ALERT_CONDITIONS.some((c) => c.id === input.condition) ? input.condition : 'price_above';
  const threshold = Number(input.threshold);
  if (!Number.isFinite(threshold)) {
    throw new Error('请填写合法的预警触发数值');
  }

  const id = String(input.id || `alrt-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`);
  const item = {
    id,
    secid,
    code: code || meta.code,
    secuCode: secuCode || meta.secuCode,
    name: name || meta.name || meta.code,
    marketKind: marketKind || meta.marketKind,
    currency: currency || meta.currency,
    condition,
    threshold,
    note: String(input.note || '').trim().slice(0, 120),
    cooldownMinutes: Math.max(5, Math.min(1440, Number(input.cooldownMinutes) || 30)),
    notifyWebhook: Boolean(input.notifyWebhook),
    enabled: input.enabled !== false,
    createdAt: input.createdAt || nowOffsetISO(),
    lastTriggeredAt: input.lastTriggeredAt || null,
    lastValue: input.lastValue ?? null,
    triggerCount: Number(input.triggerCount || 0),
  };

  const idx = store.alerts.findIndex((a) => a.id === id);
  if (idx >= 0) store.alerts[idx] = { ...store.alerts[idx], ...item };
  else store.alerts.unshift(item);

  saveWatchAlertsStore(store);
  return { alert: item, store };
}

function toggleWatchAlert(id, enabled) {
  const store = loadWatchAlertsStore();
  const target = store.alerts.find((a) => a.id === id);
  if (!target) throw new Error('未找到对应预警规则');
  target.enabled = typeof enabled === 'boolean' ? enabled : !target.enabled;
  saveWatchAlertsStore(store);
  return store;
}

function deleteWatchAlert(id) {
  const store = loadWatchAlertsStore();
  store.alerts = store.alerts.filter((a) => a.id !== id);
  saveWatchAlertsStore(store);
  return store;
}

// ============================================================================
// 2. Bot 自定义定时任务存取（取代死板的 6 时段专家广场）
// ============================================================================

function loadBotSchedulesStore() {
  const raw = readJson(getSchedulesPath(), null);
  if (!raw || typeof raw !== 'object') {
    return {
      tasks: [],
      updatedAt: null,
    };
  }
  return {
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    updatedAt: raw.updatedAt || null,
  };
}

function saveBotSchedulesStore(store) {
  const payload = { ...store, updatedAt: nowOffsetISO() };
  writeJson(getSchedulesPath(), payload);
  return payload;
}

function upsertBotSchedule(input = {}) {
  const store = loadBotSchedulesStore();
  const timeHHMM = String(input.timeHHMM || '09:27').trim();
  if (!/^\d{2}:\d{2}$/.test(timeHHMM)) {
    throw new Error('定时时间格式需为 HH:mm（例如 08:30 或 15:30）');
  }
  const name = String(input.name || 'Bot 定时播报').trim().slice(0, 60);
  const prompt = String(input.prompt || '').trim().slice(0, 600);
  if (!prompt) throw new Error('请填写定时任务的执行指令内容');

  const id = String(input.id || `sched-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`);
  const task = {
    id,
    name,
    timeHHMM,
    weekdaysOnly: input.weekdaysOnly !== false,
    taskType: String(input.taskType || 'custom_prompt'),
    prompt,
    useAi: input.useAi !== false,
    notifyWebhook: Boolean(input.notifyWebhook),
    enabled: input.enabled !== false,
    createdAt: input.createdAt || nowOffsetISO(),
    lastRunAt: input.lastRunAt || null,
    lastRunDate: input.lastRunDate || null,
    lastSummary: input.lastSummary || '',
  };

  const idx = store.tasks.findIndex((t) => t.id === id);
  if (idx >= 0) store.tasks[idx] = { ...store.tasks[idx], ...task };
  else store.tasks.push(task);

  store.tasks.sort((a, b) => a.timeHHMM.localeCompare(b.timeHHMM));
  saveBotSchedulesStore(store);
  return { task, store };
}

function toggleBotSchedule(id, enabled) {
  const store = loadBotSchedulesStore();
  const t = store.tasks.find((x) => x.id === id);
  if (!t) throw new Error('未找到对应定时任务');
  t.enabled = typeof enabled === 'boolean' ? enabled : !t.enabled;
  saveBotSchedulesStore(store);
  return store;
}

function deleteBotSchedule(id) {
  const store = loadBotSchedulesStore();
  store.tasks = store.tasks.filter((x) => x.id !== id);
  saveBotSchedulesStore(store);
  return store;
}

// ============================================================================
// 3. 主动推送通知队列（同时供给网页悬浮 Bot 气泡 + Windows 桌面宠物 + Webhook）
// ============================================================================

function loadNotificationsStore() {
  const raw = readJson(getNotifsPath(), null);
  if (!raw || !Array.isArray(raw.items)) {
    return { items: [], updatedAt: null };
  }
  return raw;
}

function pushBotNotification(notif) {
  const store = loadNotificationsStore();
  const entry = {
    id: `ntf-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    kind: notif.kind || 'watch_alert', // watch_alert | technical_rule | anomaly_redline | schedule_report
    severity: notif.severity || 'high', // high | medium | info
    title: String(notif.title || '盯盘提醒'),
    body: String(notif.body || ''),
    secid: notif.secid || '',
    stockName: notif.stockName || '',
    read: false,
    createdAt: nowOffsetISO(),
  };
  store.items.unshift(entry);
  store.items = store.items.slice(0, 60);
  store.updatedAt = entry.createdAt;
  writeJson(getNotifsPath(), store);
  return entry;
}

function markNotificationsRead(ids = null) {
  const store = loadNotificationsStore();
  const idSet = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
  for (const it of store.items) {
    if (!idSet || idSet.has(it.id)) it.read = true;
  }
  store.updatedAt = nowOffsetISO();
  writeJson(getNotifsPath(), store);
  return store;
}

function getUnreadAlertSummary() {
  const store = loadNotificationsStore();
  const unread = store.items.filter((x) => !x.read);
  return {
    unreadCount: unread.length,
    latestUnread: unread[0] || null,
    recent: store.items.slice(0, 20),
  };
}

async function sendOptionalWebhook(title, text) {
  try {
    const results = await dispatchWebhookMessage(title, text);
    return Array.isArray(results) && results.some((r) => r && r.ok);
  } catch {
    return false;
  }
}

// ============================================================================
// 4. 实时盯盘预警评估（支持全球股票 & 期货 + 联动工作台技术预警）
// ============================================================================

async function evaluateWatchAlertsNow(deps = {}) {
  const store = loadWatchAlertsStore();
  if (!store.enabled) return { ok: true, triggered: [], skipped: 'disabled' };

  const activeAlerts = store.alerts.filter((a) => a.enabled);
  const triggered = [];
  const nowMs = Date.now();

  // 4A. 评估自定义价格 / 涨跌幅 / 量比预警（单次批量查全球股票与期货实时报价）
  const cryptoEnabled = getEditionInfo().features.crypto;
  const supportedAlerts = activeAlerts.filter((a) => !isUnsupportedAssetSecid(a.secid) && (cryptoEnabled || a.marketKind !== 'CRYPTO'));
  if (supportedAlerts.length > 0) {
    const emSecids = [...new Set(supportedAlerts.filter((a) => !isCryptoSecid(a.secid)).map((a) => a.secid))];
    const cryptoPairs = cryptoEnabled
      ? [...new Set(supportedAlerts.filter((a) => isCryptoSecid(a.secid)).map((a) => cryptoPairFromSecid(a.secid)))]
      : [];
    try {
      const [emJson, cryptoMap] = await Promise.all([
        emSecids.length > 0
          ? fetch(
              `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f10,f12,f13,f14&secids=${encodeURIComponent(emSecids.join(','))}`,
              { headers: HEADERS, signal: AbortSignal.timeout(8000) }
            )
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          : Promise.resolve(null),
        cryptoEnabled && cryptoPairs.length > 0 ? fetchCryptoTickers(cryptoPairs).catch(() => new Map()) : Promise.resolve(new Map()),
      ]);
      const bySecid = new Map();
      for (const r of emJson?.data?.diff || []) {
        bySecid.set(`${r.f13}.${r.f12}`, r);
      }

      for (const al of supportedAlerts) {
        let price = null;
        let pct = null;
        let volRatio = null;
        if (isCryptoSecid(al.secid)) {
          const cl = cryptoMap.get(cryptoPairFromSecid(al.secid));
          if (!cl) continue;
          price = cl.price;
          pct = cl.pct;
        } else {
          const q = bySecid.get(al.secid);
          if (!q) continue;
          price = q.f2 !== '-' ? round2(q.f2) : null;
          pct = q.f3 !== '-' ? round2(q.f3) : null;
          volRatio = q.f10 !== '-' ? round2(q.f10) : null;
          if (q.f14) al.name = q.f14;
        }

        let actualVal = null;
        let hit = false;
        let desc = '';

        if (al.condition === 'price_above' && price != null) {
          actualVal = price;
          hit = price >= al.threshold;
          desc = `现价 ${price} 突破设定上限 ${al.threshold}`;
        } else if (al.condition === 'price_below' && price != null) {
          actualVal = price;
          hit = price <= al.threshold;
          desc = `现价 ${price} 跌破设定下限 ${al.threshold}`;
        } else if (al.condition === 'pct_above' && pct != null) {
          actualVal = pct;
          hit = pct >= al.threshold;
          desc = `盘中涨幅 ${pct >= 0 ? '+' : ''}${pct}% 达到预警线 +${al.threshold}%`;
        } else if (al.condition === 'pct_below' && pct != null) {
          actualVal = pct;
          hit = pct <= al.threshold;
          desc = `盘中跌幅 ${pct}% 触及止损预警线 ${al.threshold}%`;
        } else if (al.condition === 'vol_ratio_above' && volRatio != null) {
          actualVal = volRatio;
          hit = volRatio >= al.threshold;
          desc = `盘中量比放大至 ${volRatio}x（预警线 ${al.threshold}x）`;
        }

        al.lastValue = actualVal;
        if (!hit) continue;

        const lastMs = al.lastTriggeredAt ? Date.parse(al.lastTriggeredAt) : 0;
        if (!deps.ignoreCooldown && lastMs && nowMs - lastMs < al.cooldownMinutes * 60000) {
          continue;
        }

        al.lastTriggeredAt = nowOffsetISO();
        al.triggerCount = Number(al.triggerCount || 0) + 1;

        const title = `盯盘预警触发：${al.name} (${al.secuCode})`;
        const body = `${desc}${pct != null ? `（当前 ${pct >= 0 ? '+' : ''}${pct}%）` : ''}${al.note ? ` · 备注：${al.note}` : ''}`;

        const ntf = pushBotNotification({
          kind: 'watch_alert',
          severity: al.condition.includes('below') ? 'high' : 'medium',
          title,
          body,
          secid: al.secid,
          stockName: al.name,
        });
        if (typeof deps.appendBotMessage === 'function') {
          deps.appendBotMessage({
            content: `🔔 【${title}】\n${body}\n\n点右下角可一键全屏查看 K 线与支撑压力位！`,
            mood: al.condition.includes('below') ? 'alert' : 'excited',
          });
        }
        if (al.notifyWebhook) {
          sendOptionalWebhook(title, body).catch(() => {});
        }
        triggered.push(ntf);
      }
    } catch {
      // network error non-fatal
    }
  }

  // 4B. 转发工作台技术预警规则（scanTechnicalRadar）
  if (store.forwardTechnicalRules && typeof deps.scanTechnicalRadar === 'function') {
    try {
      const radar = await deps.scanTechnicalRadar(false);
      const highAlerts = [];
      const formatRuleMetric = (a) => {
        if (a.operator === '==' && Number(a.threshold) === 1 && Number(a.actualValue) === 1) {
          return '条件已触发';
        }
        return `实测 ${a.actualValue ?? '-'} ${a.operator || ''} ${a.threshold ?? '-'}`;
      };
      for (const a of radar?.marketAlerts || []) {
        if (a.severity === 'high') {
          highAlerts.push({
            key: `mkt:${a.ruleId}`,
            title: `盘面情绪高危预警：${a.ruleName}`,
            body: `${a.actionAdvice || a.message || '触发风控纪律预警'}（${formatRuleMetric(a)}）`,
            secid: '1.000001',
            stockName: '大盘情绪',
          });
        }
      }
      for (const s of radar?.stockScans || radar?.stocks || []) {
        for (const a of s.alerts || s.triggeredAlerts || []) {
          if (a.severity === 'high') {
            highAlerts.push({
              key: `stk:${s.secid}:${a.ruleId}`,
              title: `技术面高危预警：${s.name} · ${a.ruleName}`,
              body: `${a.actionAdvice || a.message || '触发个股技术面风控'}（现价 ${s.price ?? '-'}，${formatRuleMetric(a)}）`,
              secid: s.secid,
              stockName: s.name,
            });
          }
        }
      }

      for (const ha of highAlerts.slice(0, 6)) {
        const lastTs = Number(store.techCooldownMap[ha.key] || 0);
        // 同一条技术预警 4 小时内最多主动弹 1 次，避免刷屏
        if (!deps.ignoreCooldown && lastTs && nowMs - lastTs < 4 * 3600000) continue;
        store.techCooldownMap[ha.key] = nowMs;
        const ntf = pushBotNotification({
          kind: 'technical_rule',
          severity: 'high',
          title: ha.title,
          body: ha.body,
          secid: ha.secid,
          stockName: ha.stockName,
        });
        if (typeof deps.appendBotMessage === 'function') {
          deps.appendBotMessage({
            content: `⚠️ 【工作台技术预警转发】${ha.title}\n${ha.body}`,
            mood: 'alert',
          });
        }
        triggered.push(ntf);
      }
    } catch {
      // non-fatal
    }
  }

  // 清理超过 24 小时的冷却键，防止长期挂机 Map 无限增长
  let cooldownPruned = false;
  for (const [k, ts] of Object.entries(store.techCooldownMap || {})) {
    if (!Number.isFinite(Number(ts)) || nowMs - Number(ts) > 24 * 3600000) {
      delete store.techCooldownMap[k];
      cooldownPruned = true;
    }
  }

  // 仅当有触发记录或冷却清理变更时才原子写盘，杜绝空转高频刷 SSD
  if (triggered.length > 0 || cooldownPruned) {
    saveWatchAlertsStore(store);
  }
  return { ok: true, triggered, checkedAt: nowOffsetISO() };
}

// ============================================================================
// 5. Bot 定时任务执行器（到点或手动立即执行，并主动推送到 Bot 气泡/聊天/Webhook）
// ============================================================================

async function runBotScheduledTask(taskId, deps = {}) {
  const store = loadBotSchedulesStore();
  const task = store.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error('未找到对应的 Bot 定时任务');

  let reportText = '';
  let usedAi = false;

  if (task.useAi && typeof deps.runBotChat === 'function') {
    try {
      const chatRes = await deps.runBotChat(`[定时任务自动触发：${task.name}] ${task.prompt}`, null);
      reportText = chatRes?.message?.content || '';
      usedAi = true;
    } catch (err) {
      reportText = `（AI 播报执行降级：${err.message}）`;
    }
  }

  if (!reportText || !usedAi) {
    // 零 Token 实时快报兜底（读取当前盘面温度 + 自选涨跌 + 异动摘要）
    const snap = typeof deps.getMiniTickerSnapshot === 'function' ? await deps.getMiniTickerSnapshot(true).catch(() => null) : null;
    const stockLines = (snap?.stocks || [])
      .slice(0, 6)
      .map((s) => `${s.name} ${s.pct != null ? `${s.pct >= 0 ? '+' : ''}${s.pct}%` : '-'}`)
      .join(' ｜ ');
    reportText = `⏰ 定时任务「${task.name}」播报：\n盘面情绪：${snap?.sentiment?.label || '已更新'}（温度 ${snap?.sentiment?.score ?? '-'} 分，涨停 ${snap?.sentiment?.ztCount ?? '-'} / 跌停 ${snap?.sentiment?.dtCount ?? '-'}）\n核心自选：${stockLines || '暂无数据'}\n预设指令：${task.prompt}`;
    if (typeof deps.appendBotMessage === 'function') {
      deps.appendBotMessage({ content: reportText, mood: 'happy' });
    }
  }

  task.lastRunAt = nowOffsetISO();
  task.lastRunDate = task.lastRunAt.slice(0, 10);
  task.lastSummary = reportText.slice(0, 220);
  saveBotSchedulesStore(store);

  const ntf = pushBotNotification({
    kind: 'schedule_report',
    severity: 'info',
    title: `⏰ Bot 定时播报：${task.name}`,
    body: reportText.slice(0, 220),
  });
  if (task.notifyWebhook) {
    sendOptionalWebhook(`Bot定时任务·${task.name}`, reportText).catch(() => {});
  }

  return { ok: true, task, reportText, notification: ntf, store };
}

function getVisibleAlertsStore() {
  const store = loadWatchAlertsStore();
  const cryptoEnabled = getEditionInfo().features.crypto;
  if (cryptoEnabled) {
    return {
      ...store,
      filteredUnsupportedCount: 0,
      unsupportedNotice: null,
    };
  }
  const visible = [];
  let hiddenCount = 0;
  for (const al of store.alerts || []) {
    if (isUnsupportedAssetSecid(al?.secid) || String(al?.marketKind || '').toUpperCase() === 'CRYPTO') {
      hiddenCount += 1;
      continue;
    }
    visible.push(al);
  }
  return {
    ...store,
    alerts: visible,
    filteredUnsupportedCount: hiddenCount,
    unsupportedNotice:
      hiddenCount > 0 ? `已自动过滤 ${hiddenCount} 条当前版本不支持的历史资产预警（原配置已保留，未修改本地文件）` : null,
  };
}

function getBotWatchFullState() {
  return {
    alertsStore: getVisibleAlertsStore(),
    schedulesStore: loadBotSchedulesStore(),
    notifications: getUnreadAlertSummary(),
    conditionCatalog: ALERT_CONDITIONS,
    scheduleTemplates: SCHEDULE_TEMPLATES,
  };
}

let daemonTimer = null;
let isPolling = false;
let lastWatchEvalAt = 0;

function startBotWatchDaemon(deps = {}) {
  if (daemonTimer) return;
  daemonTimer = setInterval(async () => {
    if (isPolling) return;
    isPolling = true;
    try {
      const now = new Date();
      const day = now.getDay();
      const isWeekday = day >= 1 && day <= 5;
      const pad = (n) => String(n).padStart(2, '0');
      const curHHMM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

      // 1) 检查到点的 Bot 定时任务
      const schedStore = loadBotSchedulesStore();
      for (const task of schedStore.tasks) {
        if (!task.enabled) continue;
        if (task.weekdaysOnly && !isWeekday) continue;
        if (task.lastRunDate === todayStr) continue;
        if (task.timeHHMM === curHHMM) {
          await runBotScheduledTask(task.id, deps).catch(() => {});
        }
      }

      // 2) 按 pollIntervalSec 节流并门控交易时段：无活跃预警且非交易时段绝不 24x7 盲扫上游行情
      const alStore = loadWatchAlertsStore();
      const intervalMs = Math.max(60, Number(alStore.pollIntervalSec) || 120) * 1000;
      const hasCustomAlerts = alStore.alerts.some((a) => a.enabled);
      const hasNonCnAlert = alStore.alerts.some((a) => a.enabled && String(a.marketKind || 'CN') !== 'CN');
      const shouldScanTech = Boolean(alStore.forwardTechnicalRules) && isCnTradingHour(now);
      const shouldEvalAlerts = hasCustomAlerts && (hasNonCnAlert || isCnTradingHour(now));

      if (alStore.enabled && (shouldEvalAlerts || shouldScanTech) && Date.now() - lastWatchEvalAt >= intervalMs) {
        lastWatchEvalAt = Date.now();
        await evaluateWatchAlertsNow(deps).catch(() => {});
      }
    } finally {
      isPolling = false;
    }
  }, 60 * 1000);
  if (daemonTimer.unref) daemonTimer.unref();
}

module.exports = {
  ALERT_CONDITIONS,
  SCHEDULE_TEMPLATES,
  loadWatchAlertsStore,
  updateWatchSettings,
  upsertWatchAlert,
  toggleWatchAlert,
  deleteWatchAlert,
  loadBotSchedulesStore,
  upsertBotSchedule,
  toggleBotSchedule,
  deleteBotSchedule,
  loadNotificationsStore,
  pushBotNotification,
  markNotificationsRead,
  getUnreadAlertSummary,
  evaluateWatchAlertsNow,
  runBotScheduledTask,
  getBotWatchFullState,
  startBotWatchDaemon,
};
