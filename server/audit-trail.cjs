'use strict';

/**
 * 机构级结构化操作审计日志与三库/交割单 Excel(CSV) 汇总导出服务
 *
 * - 审计日志追加写入本机 stateFile('audit-trail.local.jsonl')（打包严格排除）
 * - 支持按分类/关键词筛选与 UTF-8 BOM Excel 兼容 CSV 导出（页脚自动带合规免责声明）
 * - 支持将现行三库（方法论/认知/台账）与交易账本导出为结构化 CSV 汇总表
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { stateFile } = require('./app-paths.cjs');
const { getEditionInfo } = require('./edition.cjs');
const { loadWorkspace } = require('./knowledge-store.cjs');

function readRawTradesSync() {
  try {
    const p = stateFile('trade-ledger.local.json');
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && Array.isArray(parsed.trades)) return parsed.trades;
    }
  } catch {
    // ignore
  }
  return [];
}

function getAuditFilePath() {
  return stateFile('audit-trail.local.jsonl');
}

const AUDIT_CHUNK_SIZE = 500;

function appendAuditLogStrict({ category = 'system', action = '', summary = '', targetIds = [], backupId = null, actor = 'local_user', meta = null } = {}) {
  const cleanIds = Array.isArray(targetIds) ? targetIds.map((x) => String(x)).filter(Boolean) : [];
  const ts = new Date().toISOString();
  const baseCategory = String(category || 'system');
  const baseAction = String(action || '');
  const baseSummary = String(summary || '').slice(0, 600);
  const baseBackupId = backupId ? String(backupId) : null;
  const baseActor = String(actor || 'local_user');

  // 单批超过 500 条对象 ID 时，按 500 条分段写入关联批次审计记录（共享 batchId），确保全量对象零截断可对账
  if (cleanIds.length > AUDIT_CHUNK_SIZE) {
    const batchId = `audb_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    const chunkTotal = Math.ceil(cleanIds.length / AUDIT_CHUNK_SIZE);
    const entries = [];
    const lines = [];
    for (let i = 0; i < chunkTotal; i += 1) {
      const slice = cleanIds.slice(i * AUDIT_CHUNK_SIZE, (i + 1) * AUDIT_CHUNK_SIZE);
      const entry = {
        id: `aud_${Date.now()}_${i + 1}_${crypto.randomBytes(2).toString('hex')}`,
        batchId,
        chunkIndex: i + 1,
        chunkTotal,
        totalTargetCount: cleanIds.length,
        timestamp: ts,
        category: baseCategory,
        action: baseAction,
        summary: `${baseSummary} [分段 ${i + 1}/${chunkTotal} · 共 ${cleanIds.length} 项]`,
        targetIds: slice,
        targetCount: slice.length,
        backupId: baseBackupId,
        actor: baseActor,
        ...(meta && typeof meta === 'object' ? { meta: { ...meta, batchId, chunkIndex: i + 1, chunkTotal, totalTargetCount: cleanIds.length } } : {}),
      };
      entries.push(entry);
      lines.push(JSON.stringify(entry));
    }
    fs.appendFileSync(getAuditFilePath(), lines.join('\n') + '\n', 'utf8');
    return {
      ...entries[0],
      chunkCount: chunkTotal,
      totalTargetCount: cleanIds.length,
    };
  }

  const entry = {
    id: `aud_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
    timestamp: ts,
    category: baseCategory,
    action: baseAction,
    summary: baseSummary,
    targetIds: cleanIds,
    targetCount: cleanIds.length,
    backupId: baseBackupId,
    actor: baseActor,
    ...(meta && typeof meta === 'object' ? { meta } : {}),
  };
  fs.appendFileSync(getAuditFilePath(), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function safeAppendAuditLog(payload = {}) {
  try {
    const entry = appendAuditLogStrict(payload);
    return { ok: true, entry, error: null };
  } catch (err) {
    const msg = err?.message || '审计日志写入失败';
    console.error('[audit-trail] 审计日志写入失败:', msg);
    return { ok: false, entry: null, error: msg };
  }
}

function appendAuditLog(payload = {}) {
  return safeAppendAuditLog(payload).entry;
}

function readAllAuditLogs() {
  const filePath = getAuditFilePath();
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && obj.timestamp) rows.push(obj);
    } catch {
      // ignore corrupted line
    }
  }
  return rows.reverse();
}

function queryAuditTrail({ category = '', q = '', limit = 200, all: returnAll = false } = {}) {
  const all = readAllAuditLogs();
  const counts = {};
  for (const r of all) {
    counts[r.category] = (counts[r.category] || 0) + 1;
  }
  const catFilter = String(category || '').trim().toLowerCase();
  const kw = String(q || '').trim().toLowerCase();
  const filtered = all.filter((r) => {
    if (catFilter && catFilter !== 'all' && String(r.category || '').toLowerCase() !== catFilter) return false;
    if (kw) {
      const hay = `${r.action} ${r.summary} ${(r.targetIds || []).join(' ')} ${r.backupId || ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  const unlimited = Boolean(returnAll) || limit === 0 || limit === Infinity || limit === 'all';
  const maxN = unlimited ? filtered.length : Math.max(1, Math.min(1000, Number(limit) || 200));
  return {
    ok: true,
    total: all.length,
    filteredTotal: filtered.length,
    truncated: !unlimited && filtered.length > maxN,
    categoryCounts: counts,
    items: unlimited ? filtered : filtered.slice(0, maxN),
  };
}

function csvCell(val) {
  let s = String(val ?? '').replace(/\r?\n/g, ' ');
  // Neutralize spreadsheet formula triggers so arbitrary user text always renders as literal text
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d+(?:\.\d+)?$/.test(s))) {
    s = `'${s}`;
  }
  if (/[",\t\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsvWithDisclaimer(headers, rows, title) {
  const ed = getEditionInfo();
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((r) => r.map(csvCell).join(',')),
    '',
    [csvCell('【合规免责声明】'), csvCell(`${title} · 导出时间 ${new Date().toISOString()} · ${ed.disclaimerText}`)].join(','),
  ];
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function exportAuditTrailCsv({ category = '', q = '' } = {}) {
  const res = queryAuditTrail({ category, q, all: true });
  const headers = ['审计ID', '批次ID/分段', '时间(ISO)', '分类', '操作动作', '变更摘要', '对象数', '涉及对象ID', '关联快照ID', '操作者'];
  const rows = res.items.map((it) => [
    it.id,
    it.batchId ? `${it.batchId} (${it.chunkIndex || 1}/${it.chunkTotal || 1})` : '',
    it.timestamp,
    it.category,
    it.action,
    it.summary,
    it.totalTargetCount ?? it.targetCount ?? (it.targetIds || []).length,
    (it.targetIds || []).join(' | '),
    it.backupId || '',
    it.actor || 'local_user',
  ]);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  return {
    fileName: `audit-trail-${stamp}.csv`,
    content: buildCsvWithDisclaimer(headers, rows, '三库工作台操作审计日志'),
  };
}

function exportWorkspaceSummaryCsv(scope = 'all') {
  const s = String(scope || 'all').toLowerCase();
  const ws = loadWorkspace();
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);

  if (s === 'methodology') {
    const headers = ['卡号', '标题', '体系', '状态', '可信度', '复盘次数', '来源', '核心论断'];
    const rows = (ws.methodology?.cards || []).map((c) => [
      c.id,
      c.title,
      c.system,
      c.isRevoked ? '已撤销' : c.isArchived ? '封存' : c.isHighPaused ? '高位暂停' : c.isPendingRetire ? '待淘汰' : '活跃',
      c.credibilityScore ?? '',
      (c.reviewLogs || []).length,
      c.source || '',
      (c.coreThesis || '').slice(0, 260),
    ]);
    return {
      fileName: `methodology-cards-${stamp}.csv`,
      content: buildCsvWithDisclaimer(headers, rows, '方法论卡片库汇总导出'),
    };
  }

  if (s === 'cognition') {
    const headers = ['认知卡号', '入库日期', '标题', '证据等级', '置信度', '标签', '标的映射', '核心事实'];
    const rows = (ws.cognition?.cards || []).map((c) => [
      c.id,
      c.ingestedDate || '',
      c.title,
      c.primaryGrade || c.evidenceLevelRaw || '',
      c.confidence || '',
      c.categoryTag || '',
      (c.aShareMapping || '').slice(0, 180),
      (c.facts || '').slice(0, 260),
    ]);
    return {
      fileName: `cognition-cards-${stamp}.csv`,
      content: buildCsvWithDisclaimer(headers, rows, '行业前沿认知库汇总导出'),
    };
  }

  if (s === 'ledger') {
    const headers = ['记录键', '类型', '日期', '标题/标的', '评分', '结论/市场状态'];
    const rows = [
      ...(ws.ledger?.dailyReviews || []).map((d) => [d.id, '日度复盘', d.date, d.title, d.score ?? '', d.marketState || '']),
      ...(ws.ledger?.judgments || []).map((j) => [j.recordKey || j.id, '标的研判', j.date, j.target || j.title, j.score ?? '', (j.conclusion || '').slice(0, 240)]),
    ];
    return {
      fileName: `review-ledger-${stamp}.csv`,
      content: buildCsvWithDisclaimer(headers, rows, '研判与复盘台账汇总导出'),
    };
  }

  if (s === 'trades') {
    const trades = readRawTradesSync();
    const headers = ['交易ID', '日期', '账户类型', '代码', '名称', '市场', '方向', '价格', '数量', '情绪标签', '关联卡片', '备注'];
    const rows = trades.map((tr) => [
      tr.id,
      tr.date || '',
      tr.accountType || 'real',
      tr.code || '',
      tr.name || '',
      tr.marketKind || 'CN',
      tr.side || '',
      tr.price ?? '',
      tr.quantity ?? '',
      tr.emotionTag || '',
      Array.isArray(tr.cardIds) ? tr.cardIds.join('|') : '',
      (tr.note || '').slice(0, 200),
    ]);
    return {
      fileName: `trade-ledger-${stamp}.csv`,
      content: buildCsvWithDisclaimer(headers, rows, '交易账本汇总导出'),
    };
  }

  // scope === 'all' unified institutional export
  const trades = readRawTradesSync();
  const headers = ['模块', '编号/键', '日期', '标题/标的', '等级/评分/方向', '关键摘要'];
  const rows = [
    ...(ws.methodology?.cards || []).map((c) => [
      '方法论卡',
      c.id,
      ws.methodology?.meta?.syncDate || '',
      c.title,
      c.credibilityScore != null ? `可信度 ${c.credibilityScore}` : '-',
      (c.coreThesis || '').slice(0, 220),
    ]),
    ...(ws.cognition?.cards || []).map((c) => [
      '行业认知卡',
      c.id,
      c.ingestedDate || '',
      c.title,
      c.primaryGrade || '-',
      (c.facts || '').slice(0, 220),
    ]),
    ...(ws.ledger?.dailyReviews || []).map((d) => [
      '日度复盘',
      d.id,
      d.date || '',
      d.title,
      d.score != null ? `${d.score}/10` : '-',
      d.marketState || '',
    ]),
    ...(ws.ledger?.judgments || []).map((j) => [
      '标的研判',
      j.recordKey || j.id,
      j.date || '',
      j.target || j.title,
      j.score != null ? `${j.score}/10` : '-',
      (j.conclusion || '').slice(0, 220),
    ]),
    ...trades.map((tr) => [
      '交易记录',
      tr.id,
      tr.date || '',
      `${tr.name || ''} (${tr.code || ''})`,
      `${tr.side} @${tr.price} x${tr.quantity}`,
      `${tr.emotionTag || ''} ${tr.note || ''}`.trim().slice(0, 200),
    ]),
  ];
  return {
    fileName: `research-workbench-summary-${stamp}.csv`,
    content: buildCsvWithDisclaimer(headers, rows, '二级投研三库与交易账本全量汇总'),
  };
}

module.exports = {
  appendAuditLog,
  appendAuditLogStrict,
  safeAppendAuditLog,
  queryAuditTrail,
  exportAuditTrailCsv,
  exportWorkspaceSummaryCsv,
};
