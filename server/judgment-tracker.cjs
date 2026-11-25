'use strict';

/**
 * P0-1：研判假设自动 T+5/T+20/T+60 绩效追踪 + 否决观察池（Veto Ledger）+ 盘前预检收件箱（Preflight Inbox）
 * - 借鉴 ai-mock-trade journal.ts / review-guide.md / preflight.ts：
 *   1) 自动拉取台账每份研判（#001–#015...）自研判日至今的真实价格走势与评分校准曲线；
 *   2) 记录被否决/放弃的候选标的（Veto Ledger），自动对比「看多研判 vs 否决标的」T+5/T+20 表现，防标准过严踏空；
 *   3) 零 Token 生成「今日盘前预检收件箱」：到期假设、卡片-规则漂移、未归档复盘、监管红线、待拍板建议一网打尽。
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveStockQuery } = require('./stock-researcher.cjs');
const { fetchDailyKlinesRobust } = require('./watchlist-service.cjs');
const { loadRegulatoryWatchlist } = require('./reconcile-service.cjs');

const { stateFile } = require('./app-paths.cjs');
const VETO_PATH = stateFile('veto-ledger.local.json');
const CACHE_PATH = stateFile('judgment-prices.cache.json');

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowOffsetISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ============================================================================
// 1. 轻量 K 线缓存（避免重复拉取历史价格导致页面变慢，TTL 15 分钟）
// ============================================================================

let memKlineCache = null;

function loadKlineCache() {
  if (memKlineCache) return memKlineCache;
  try {
    if (fs.existsSync(CACHE_PATH)) {
      memKlineCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) || {};
      return memKlineCache;
    }
  } catch {
    // ignore
  }
  memKlineCache = {};
  return memKlineCache;
}

function saveKlineCache(cache) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8');
  } catch {
    // non-fatal
  }
}

async function getDailySeriesForQuery(queryKey, forceRefresh = false) {
  const cleanKey = String(queryKey || '').trim();
  if (!cleanKey) return null;
  const cache = loadKlineCache();
  const hit = cache[cleanKey];
  const now = Date.now();
  if (!forceRefresh && hit && now - (hit.ts || 0) < 15 * 60 * 1000 && Array.isArray(hit.klines) && hit.klines.length > 0) {
    return hit;
  }

  try {
    const resolved = await resolveStockQuery(cleanKey);
    if (!resolved || !resolved.secid) return null;
    const klines = await fetchDailyKlinesRobust(resolved.secid, resolved.marketKind || 'CN', 260);
    if (!Array.isArray(klines) || klines.length === 0) return null;
    const rec = {
      ts: now,
      secid: resolved.secid,
      code: resolved.code,
      secuCode: resolved.secuCode,
      name: resolved.name,
      marketKind: resolved.marketKind || 'CN',
      currency: resolved.currency || 'CNY',
      klines: klines.map((k) => ({ date: k.date, close: k.close, high: k.high, low: k.low })),
    };
    cache[cleanKey] = rec;
    saveKlineCache(cache);
    return rec;
  } catch {
    return hit || null;
  }
}

/**
 * 基于日 K 序列计算某起始日期后的 T+1 / T+5 / T+20 / T+60 / 至今收益、最大涨幅与最大回撤
 */
function computeForwardPerformance(klines, baseDate) {
  if (!Array.isArray(klines) || klines.length === 0 || !baseDate) {
    return {
      matched: false,
      entryDate: null,
      entryPrice: null,
      latestDate: null,
      latestPrice: null,
      tradingDaysElapsed: 0,
      retT1Pct: null,
      retT5Pct: null,
      retT20Pct: null,
      retT60Pct: null,
      retSincePct: null,
      maxGainPct: null,
      maxDrawdownPct: null,
    };
  }
  // 找到 >= baseDate 的第一个交易日；若 baseDate 晚于最新交易日，则取最新交易日
  let startIdx = klines.findIndex((k) => k.date >= baseDate);
  if (startIdx === -1) startIdx = klines.length - 1;
  const entry = klines[startIdx];
  const latest = klines[klines.length - 1];
  if (!entry || !entry.close || entry.close <= 0) {
    return { matched: false };
  }

  const pctAt = (offset) => {
    const idx = startIdx + offset;
    if (idx >= klines.length) return null;
    return round2(((klines[idx].close - entry.close) / entry.close) * 100);
  };

  let maxHigh = entry.close;
  let minLow = entry.close;
  for (let i = startIdx + 1; i < klines.length; i++) {
    if (klines[i].high > maxHigh) maxHigh = klines[i].high;
    if (klines[i].low < minLow) minLow = klines[i].low;
  }

  return {
    matched: true,
    entryDate: entry.date,
    entryPrice: round2(entry.close),
    latestDate: latest.date,
    latestPrice: round2(latest.close),
    tradingDaysElapsed: Math.max(0, klines.length - 1 - startIdx),
    retT1Pct: pctAt(1),
    retT5Pct: pctAt(5),
    retT20Pct: pctAt(20),
    retT60Pct: pctAt(60),
    retSincePct: round2(((latest.close - entry.close) / entry.close) * 100),
    maxGainPct: round2(((maxHigh - entry.close) / entry.close) * 100),
    maxDrawdownPct: round2(((minLow - entry.close) / entry.close) * 100),
  };
}

// ============================================================================
// 2. 研判假设到期解析（扫描 verifyDate / 时间窗口）
// ============================================================================

function parseHypothesisDueStatus(hypContent, judgmentDate, todayStr) {
  const text = String(hypContent || '');
  // 提取验证时点：匹配 YYYY-MM-DD 或 YYYY-MM 或 "未来N个交易日/天"
  const fullDateMatch = text.match(/(?:验证时点|时点|截至|到期)[^0-9]{0,8}(\d{4}-\d{2}-\d{2})/) || text.match(/\b(202[5-9]-\d{2}-\d{2})\b/);
  const ymMatch = !fullDateMatch
    ? text.match(/(?:验证时点|时点)[^0-9]{0,8}(\d{4}-\d{2})/) || text.match(/\b(202[5-9]-\d{2})\b/)
    : null;
  const relDaysMatch = !fullDateMatch && !ymMatch ? text.match(/(?:未来|近)\s*(\d{1,2})\s*(?:个?交易日|天|日)/) : null;

  let dueDate = null;
  if (fullDateMatch) {
    dueDate = fullDateMatch[1];
  } else if (ymMatch) {
    dueDate = `${ymMatch[1]}-28`;
  } else if (relDaysMatch && judgmentDate) {
    const base = new Date(`${judgmentDate}T00:00:00Z`);
    if (!Number.isNaN(base.getTime())) {
      const addCal = Math.ceil(Number(relDaysMatch[1]) * 1.45);
      base.setUTCDate(base.getUTCDate() + addCal);
      dueDate = base.toISOString().slice(0, 10);
    }
  }

  if (!dueDate) {
    return { dueDate: null, daysLeft: null, status: 'unscheduled' };
  }

  const diffMs = new Date(`${dueDate}T00:00:00Z`).getTime() - new Date(`${todayStr}T00:00:00Z`).getTime();
  const daysLeft = Math.round(diffMs / 86400000);
  let status = 'upcoming';
  if (daysLeft <= 0) status = 'due';
  else if (daysLeft <= 14) status = 'soon';
  return { dueDate, daysLeft, status };
}

// ============================================================================
// 3. 否决 / 放弃观察池（Veto Ledger）CRUD
// ============================================================================

function loadVetoLedger() {
  try {
    if (fs.existsSync(VETO_PATH)) {
      const raw = JSON.parse(fs.readFileSync(VETO_PATH, 'utf8'));
      if (Array.isArray(raw.items)) {
        return { items: raw.items, updatedAt: raw.updatedAt || null };
      }
    }
  } catch {
    // fallback
  }
  return { items: [], updatedAt: null };
}

function saveVetoLedgerData(items) {
  const payload = { updatedAt: nowOffsetISO(), items };
  fs.writeFileSync(VETO_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

function addVetoEntry(entry) {
  const { items } = loadVetoLedger();
  const item = {
    id: `veto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    date: String(entry.date || todayISO()).trim(),
    code: String(entry.code || '').trim().toUpperCase(),
    name: String(entry.name || '').trim(),
    marketKind: ['CN', 'US', 'HK'].includes(entry.marketKind) ? entry.marketKind : 'CN',
    vetoType: ['veto', 'watch_pass', 'missed'].includes(entry.vetoType) ? entry.vetoType : 'veto',
    priceAtVeto: Number.isFinite(Number(entry.priceAtVeto)) && Number(entry.priceAtVeto) > 0 ? Number(entry.priceAtVeto) : null,
    reason: String(entry.reason || '').trim(),
    cardIds: Array.isArray(entry.cardIds)
      ? entry.cardIds.map((c) => String(c).trim()).filter(Boolean)
      : String(entry.cardIds || '')
          .split(/[,，/\s]+/)
          .map((c) => c.trim())
          .filter(Boolean),
    direction: String(entry.direction || '').trim(),
    createdAt: nowOffsetISO(),
  };
  if (!item.code && !item.name) {
    throw new Error('请填写标的名称或代码');
  }
  if (!item.reason) {
    throw new Error('按否决留痕纪律，必须填写放弃/否决原因（禁止静默放弃）');
  }
  items.unshift(item);
  saveVetoLedgerData(items);
  return item;
}

function deleteVetoEntry(id) {
  const { items } = loadVetoLedger();
  const next = items.filter((x) => x.id !== id);
  saveVetoLedgerData(next);
  return { deleted: next.length !== items.length, count: next.length };
}

// ============================================================================
// 4. 研判全量 T+N 自动追踪 + 否决 vs 看多对照审计
// ============================================================================

async function trackJudgmentsAndVetos(workspace, forceRefresh = false) {
  const todayStr = todayISO();
  const judgments = (workspace?.ledger?.judgments || []).filter((j) => !j.isLegacyRef);
  const vetoData = loadVetoLedger();

  // 收集去重查询键，限量并发 4 防止接口限流
  const queryMap = new Map();
  for (const j of judgments) {
    const q = j.stockCode || j.stockName || j.target;
    if (q) queryMap.set(`j:${j.id}`, q);
  }
  for (const v of vetoData.items) {
    const q = v.code || v.name;
    if (q) queryMap.set(`v:${v.id}`, q);
  }

  const uniqueQueries = [...new Set(queryMap.values())];
  const resolvedSeries = new Map();
  const CONCURRENCY = 4;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, uniqueQueries.length) }, async () => {
    while (cursor < uniqueQueries.length) {
      const q = uniqueQueries[cursor++];
      const series = await getDailySeriesForQuery(q, forceRefresh);
      if (series) resolvedSeries.set(q, series);
    }
  });
  await Promise.all(workers);

  // 1) 组装正式研判绩效追踪
  const trackedJudgments = judgments.map((j) => {
    const q = queryMap.get(`j:${j.id}`);
    const series = q ? resolvedSeries.get(q) : null;
    const perf = series ? computeForwardPerformance(series.klines, j.date) : { matched: false };

    const hypothesisAlerts = (j.hypotheses || []).map((h) => ({
      id: h.id,
      content: h.content,
      ...parseHypothesisDueStatus(h.content, j.date, todayStr),
    }));

    return {
      id: j.id,
      recordKey: j.recordKey,
      target: j.target,
      stockCode: series?.secuCode || j.stockCode || '',
      stockName: series?.name || j.stockName || j.target,
      secid: series?.secid || '',
      marketKind: series?.marketKind || 'CN',
      currency: series?.currency || 'CNY',
      date: j.date,
      score: j.score,
      conclusion: j.conclusion,
      methodIds: j.references?.methodIds || [],
      perf,
      hypothesisAlerts,
      dueCount: hypothesisAlerts.filter((h) => h.status === 'due').length,
      soonCount: hypothesisAlerts.filter((h) => h.status === 'soon').length,
    };
  });

  // 2) 评分校准曲线分桶（高分看多 vs 中性观察 vs 谨慎低分）
  const bucketsDef = [
    { key: 'high', label: '高分看多 (≥7.0分)', filter: (x) => x.score != null && x.score >= 7.0 },
    { key: 'mid', label: '中性偏多 (6.0–6.9分)', filter: (x) => x.score != null && x.score >= 6.0 && x.score < 7.0 },
    { key: 'low', label: '谨慎/偏空 (<6.0分)', filter: (x) => x.score != null && x.score < 6.0 },
  ];
  const calibrationBuckets = bucketsDef.map((b) => {
    const list = trackedJudgments.filter((x) => b.filter(x) && x.perf?.matched);
    const retsSince = list.map((x) => x.perf.retSincePct).filter((v) => Number.isFinite(v));
    const retsT5 = list.map((x) => x.perf.retT5Pct).filter((v) => Number.isFinite(v));
    const retsT20 = list.map((x) => x.perf.retT20Pct).filter((v) => Number.isFinite(v));
    const wins = retsSince.filter((r) => r > 0).length;
    return {
      key: b.key,
      label: b.label,
      count: list.length,
      winRatePct: retsSince.length ? round2((wins / retsSince.length) * 100) : null,
      avgRetT5Pct: retsT5.length ? round2(retsT5.reduce((a, c) => a + c, 0) / retsT5.length) : null,
      avgRetT20Pct: retsT20.length ? round2(retsT20.reduce((a, c) => a + c, 0) / retsT20.length) : null,
      avgRetSincePct: retsSince.length ? round2(retsSince.reduce((a, c) => a + c, 0) / retsSince.length) : null,
    };
  });

  // 3) 组装否决池绩效追踪
  const trackedVetos = vetoData.items.map((v) => {
    const q = queryMap.get(`v:${v.id}`);
    const series = q ? resolvedSeries.get(q) : null;
    const perf = series ? computeForwardPerformance(series.klines, v.date) : { matched: false };
    let qualityLabel = '待验证';
    if (perf.matched && Number.isFinite(perf.retSincePct)) {
      if (perf.retSincePct <= -5) qualityLabel = '精准排雷';
      else if (perf.retSincePct <= 2) qualityLabel = '合理规避';
      else if (perf.retSincePct >= 10) qualityLabel = '严重踏空/误杀';
      else qualityLabel = '小幅踏空';
    }
    return {
      ...v,
      secid: series?.secid || '',
      resolvedName: series?.name || v.name,
      perf,
      qualityLabel,
    };
  });

  // 4) 看多研判 vs 否决标的 对照审计（源自 ai-mock-trade review-guide.md）
  const bullishRets = trackedJudgments
    .filter((j) => j.score != null && j.score >= 6.5 && j.perf?.matched && Number.isFinite(j.perf.retSincePct))
    .map((j) => j.perf.retSincePct);
  const vetoRets = trackedVetos
    .filter((v) => v.perf?.matched && Number.isFinite(v.perf.retSincePct))
    .map((v) => v.perf.retSincePct);
  const avgBull = bullishRets.length ? round2(bullishRets.reduce((a, b) => a + b, 0) / bullishRets.length) : null;
  const avgVeto = vetoRets.length ? round2(vetoRets.reduce((a, b) => a + b, 0) / vetoRets.length) : null;
  const vetoWinCount = trackedVetos.filter((v) => v.perf?.matched && v.perf.retSincePct >= 8).length;
  const dodgeCrashCount = trackedVetos.filter((v) => v.perf?.matched && v.perf.retSincePct <= -5).length;

  let auditVerdict = '样本积累中（记录否决标的与看多研判后将自动量化筛选 Alpha）';
  let overTighteningWarning = false;
  if (avgBull != null && avgVeto != null) {
    const alpha = round2(avgBull - avgVeto);
    if (alpha >= 2) {
      auditVerdict = `筛选有效正向 Alpha（看多均收益 ${avgBull}% vs 否决均收益 ${avgVeto}%，差额 +${alpha}%），否决纪律正在创造正价值。`;
    } else if (alpha <= -3 && vetoRets.length >= 3) {
      overTighteningWarning = true;
      auditVerdict = `⚠ 筛选过严/逆向预警：被否决标的均收益（${avgVeto}%）跑赢看多标的（${avgBull}%）达 ${Math.abs(alpha)}%，请复核是否红线过紧导致主线踏空！`;
    } else {
      auditVerdict = `看多均收益 ${avgBull}% vs 否决均收益 ${avgVeto}%（差额 ${alpha >= 0 ? '+' : ''}${alpha}%），排雷 ${dodgeCrashCount} 次 / 误杀 ${vetoWinCount} 次。`;
    }
  }

  return {
    ok: true,
    updatedAt: nowOffsetISO(),
    judgments: trackedJudgments,
    calibrationBuckets,
    vetos: trackedVetos,
    buyVsVetoAudit: {
      bullishCount: bullishRets.length,
      vetoCount: vetoRets.length,
      avgBullishRetPct: avgBull,
      avgVetoRetPct: avgVeto,
      alphaSpreadPct: avgBull != null && avgVeto != null ? round2(avgBull - avgVeto) : null,
      dodgeCrashCount,
      missedBigWinCount: vetoWinCount,
      overTighteningWarning,
      verdict: auditVerdict,
    },
  };
}

// ============================================================================
// 5. 零 Token 每日盘前预检与 Attention 问题收件箱（Preflight Inbox）
// ============================================================================

function buildPreflightReport(workspace, extraDeps = {}) {
  const todayStr = todayISO();
  const inbox = [];

  // 1) 检查研判假设到期情况
  const judgments = (workspace?.ledger?.judgments || []).filter((j) => !j.isLegacyRef);
  let dueHypCount = 0;
  let soonHypCount = 0;
  for (const j of judgments) {
    for (const h of j.hypotheses || []) {
      const parsed = parseHypothesisDueStatus(h.content, j.date, todayStr);
      if (parsed.status === 'due') {
        dueHypCount += 1;
        inbox.push({
          id: `hyp-due-${j.id}-${h.id}`,
          severity: 'high',
          category: '假设到期核验',
          title: `${j.recordKey} ${j.stockName || j.target} · ${h.id} 已到验证时点（${parsed.dueDate}）`,
          detail: h.content.slice(0, 120),
          actionTab: 'ledger',
          actionEntity: { kind: 'judgment', id: j.id },
        });
      } else if (parsed.status === 'soon') {
        soonHypCount += 1;
        inbox.push({
          id: `hyp-soon-${j.id}-${h.id}`,
          severity: 'medium',
          category: '假设临期提醒',
          title: `${j.recordKey} ${j.stockName || j.target} · ${h.id} 将在 ${parsed.daysLeft} 天后到期（${parsed.dueDate}）`,
          detail: h.content.slice(0, 120),
          actionTab: 'ledger',
          actionEntity: { kind: 'judgment', id: j.id },
        });
      }
    }
  }

  // 2) 检查方法论卡片与技术预警规则漂移（由 technical-engine 注入）
  const driftedRules = Array.isArray(extraDeps.driftedRules) ? extraDeps.driftedRules : [];
  for (const dr of driftedRules) {
    inbox.push({
      id: `drift-${dr.ruleId}`,
      severity: 'medium',
      category: '规则-卡片漂移',
      title: `预警规则「${dr.ruleName}」对应卡片 ${dr.sourceCardId} 已更新`,
      detail: `《方法论卡片库》中卡片 ${dr.sourceCardId} 正文已变更，请核对技术预警阈值是否需要同步。`,
      actionTab: 'technical',
      actionEntity: null,
    });
  }

  // 3) 检查最新每日复盘的未闭环缺口与昨日归档状态
  const latestDaily = workspace?.ledger?.latestDailySummary || null;
  if (latestDaily) {
    if (latestDaily.date < todayStr) {
      const dayOfWeek = new Date().getDay();
      if (dayOfWeek >= 1 && dayOfWeek <= 5) {
        inbox.push({
          id: 'daily-gap-today',
          severity: 'info',
          category: '复盘进度',
          title: `最新已归档复盘为 ${latestDaily.date}（评分 ${latestDaily.score ?? '-'}）`,
          detail: `上期预留 ${latestDaily.nextAnchors.length} 条今日跟踪锚，收盘后别忘拉取 1 分钟实盘包完成复盘。`,
          actionTab: 'ledger',
          actionEntity: null,
        });
      }
    }
    if (Array.isArray(latestDaily.gaps) && latestDaily.gaps.length > 0) {
      inbox.push({
        id: 'daily-open-gaps',
        severity: 'medium',
        category: '上期复盘缺口',
        title: `${latestDaily.date} 复盘存在 ${latestDaily.gaps.length} 项待补事实缺口`,
        detail: latestDaily.gaps.slice(0, 2).join('；'),
        actionTab: 'ledger',
        actionEntity: null,
      });
    }
  }

  // 4) 待拍板优化建议 & 待验/待退卡片
  const pendingSugs = workspace?.ledger?.pendingSuggestions || [];
  if (pendingSugs.length > 0) {
    inbox.push({
      id: 'pending-suggestions',
      severity: 'info',
      category: '待拍板建议',
      title: `台账中有 ${pendingSugs.length} 项待拍板方法论优化建议`,
      detail: pendingSugs.slice(0, 3).map((s) => `${s.num} ${s.name}`).join('；'),
      actionTab: 'ledger',
      actionEntity: null,
    });
  }

  const pendingRetire = (workspace?.methodology?.cards || []).filter((c) => !c.isRevoked && c.isPendingRetire);
  if (pendingRetire.length > 0) {
    inbox.push({
      id: 'cards-pending-retire',
      severity: 'medium',
      category: '卡片治理',
      title: `${pendingRetire.length} 张方法论卡片处于“待退/观察”状态`,
      detail: pendingRetire.slice(0, 4).map((c) => `${c.id} ${c.title}`).join('；'),
      actionTab: 'methodology',
      actionEntity: { kind: 'methodology', id: pendingRetire[0].id },
    });
  }

  // 5) 重点监管异动红线（卡片174）
  const regList = loadRegulatoryWatchlist().items.filter((x) => x.active !== false);
  if (regList.length > 0) {
    inbox.push({
      id: 'regulatory-redline',
      severity: 'high',
      category: '监管红线(卡174)',
      title: `当前有 ${regList.length} 只标的处于交易所重点监管/异动监控名单`,
      detail: regList.slice(0, 4).map((r) => `${r.name || r.code}(${r.reason})`).join('；'),
      actionTab: 'technical',
      actionEntity: null,
    });
  }

  // 6) 持仓触发止损提醒 & 未核验止损提醒（严禁将未获取现价的持仓伪装为健康清零）
  const stopAlerts = Array.isArray(extraDeps.holdingStopAlerts) ? extraDeps.holdingStopAlerts : [];
  for (const sa of stopAlerts) {
    inbox.push({
      id: `hold-stop-${sa.code}`,
      severity: 'high',
      category: '持仓止损红线',
      title: `持仓 ${sa.name}（${sa.code}）触及预设止损计划`,
      detail: sa.detail,
      actionTab: 'trades',
      actionEntity: null,
    });
  }
  const stopUnverified = Array.isArray(extraDeps.holdingStopUnverified) ? extraDeps.holdingStopUnverified : [];
  for (const su of stopUnverified) {
    inbox.push({
      id: `hold-stop-unverified-${su.code}`,
      severity: 'medium',
      category: '持仓止损待核验',
      title: `持仓 ${su.name}（${su.code}）缺少有效现价，止损待核验`,
      detail: su.detail,
      actionTab: 'trades',
      actionEntity: null,
    });
  }
  const stopLossCoverage = extraDeps.stopLossCoverage || {
    withMarketData: false,
    openHoldingsCount: 0,
    trackedStopCount: stopAlerts.length + stopUnverified.length,
    verifiedCount: stopAlerts.length,
    unverifiedCount: stopUnverified.length,
    triggeredCount: stopAlerts.length,
    quoteAsOf: null,
    status: stopAlerts.length > 0 ? 'triggered' : stopUnverified.length > 0 ? 'unverified' : 'no_stop_holdings',
    error: null,
  };
  if (stopLossCoverage.error && stopUnverified.length === 0) {
    inbox.push({
      id: 'hold-stop-check-error',
      severity: 'medium',
      category: '持仓止损待核验',
      title: '持仓止损实时行情核验未完成',
      detail: stopLossCoverage.error,
      actionTab: 'trades',
      actionEntity: null,
    });
  }

  const order = { high: 0, medium: 1, info: 2 };
  inbox.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  return {
    ok: true,
    checkedAt: nowOffsetISO(),
    today: todayStr,
    stopLossCoverage,
    summary: {
      totalItems: inbox.length,
      highCount: inbox.filter((x) => x.severity === 'high').length,
      mediumCount: inbox.filter((x) => x.severity === 'medium').length,
      dueHypCount,
      soonHypCount,
      driftedRuleCount: driftedRules.length,
      regulatoryCount: regList.length,
      vetoCount: loadVetoLedger().items.length,
      unverifiedStopCount: stopLossCoverage.unverifiedCount || 0,
      triggeredStopCount: stopLossCoverage.triggeredCount || 0,
    },
    items: inbox,
  };
}

module.exports = {
  loadVetoLedger,
  addVetoEntry,
  deleteVetoEntry,
  trackJudgmentsAndVetos,
  buildPreflightReport,
  computeForwardPerformance,
  getDailySeriesForQuery,
};
