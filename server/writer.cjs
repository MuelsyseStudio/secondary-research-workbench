'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PATHS, pad3, sha256, loadWorkspace, parseMethodology, parseCognition, parseLedger } = require('./parser.cjs');
const { safeAppendAuditLog } = require('./audit-trail.cjs');
const { buildKbV2MutationPlan } = require('./kb/kb-writer.cjs');
const { syncKbToSqlite } = require('./kb/kb-sqlite.cjs');

function isPathInsideDir(baseDir, targetPath) {
  if (!baseDir || !targetPath) return false;
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 版本号递增（如 v3.14 -> v3.15, v1.3 -> v1.4）
 */
function bumpMinorVersion(ver) {
  const m = String(ver || '').match(/^v(\d+)\.(\d+)$/);
  if (!m) return 'v1.0';
  return `v${m[1]}.${Number(m[2]) + 1}`;
}

function todayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function escapeTocTitle(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

/**
 * 轻量行级 Diff 生成器（展示变更上下 3 行语境，简洁清晰不卡浏览器）
 */
function buildUnifiedDiff(oldText, newText, fileName) {
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  const hunks = [];

  // 找出所有不同区间（按行对齐的实用快速算法，适配 3000-5000 行长文档）
  // 先求公共前缀与后缀
  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  if (prefix === a.length && prefix === b.length) {
    return { fileName, added: 0, removed: 0, hunks: [] };
  }

  // 在变动区间内部，再做一次基于锚点行的细粒度分段，避免头部+尾部同时改动导致中间全输出
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  // 对常见“头改动+中/尾改动”做精确锚点切分
  const ops = computeLineOps(midA, midB, prefix);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    if (op.type === 'del') removed++;
  }

  // 聚合成带 2 行上下文的 Hunks
  const CTX = 2;
  const changeIndices = [];
  ops.forEach((op, idx) => {
    if (op.type !== 'eq') changeIndices.push(idx);
  });

  if (changeIndices.length === 0) {
    return { fileName, added: 0, removed: 0, hunks: [] };
  }

  let rangeStart = Math.max(0, changeIndices[0] - CTX);
  let rangeEnd = Math.min(ops.length - 1, changeIndices[0] + CTX);

  const flush = (s, e) => {
    const slice = ops.slice(s, e + 1);
    const first = slice[0];
    hunks.push({
      oldStart: first.oldLine,
      newStart: first.newLine,
      lines: slice.slice(0, 120), // 单 hunk 上限防超大渲染
      truncated: slice.length > 120 ? slice.length - 120 : 0,
    });
  };

  for (let i = 1; i < changeIndices.length; i++) {
    const nextStart = Math.max(0, changeIndices[i] - CTX);
    const nextEnd = Math.min(ops.length - 1, changeIndices[i] + CTX);
    if (nextStart <= rangeEnd + 1) {
      rangeEnd = Math.max(rangeEnd, nextEnd);
    } else {
      flush(rangeStart, rangeEnd);
      rangeStart = nextStart;
      rangeEnd = nextEnd;
    }
  }
  flush(rangeStart, rangeEnd);

  return { fileName, added, removed, hunks };
}

/**
 * 快速行比对：利用唯一行作为同步锚点，O(N) 处理 5000 行大文件无卡顿
 */
function computeLineOps(a, b, baseOffset) {
  // 建立 b 中每行的出现位置表
  const bPos = new Map();
  b.forEach((line, idx) => {
    if (!bPos.has(line)) bPos.set(line, []);
    bPos.get(line).push(idx);
  });

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', oldLine: baseOffset + i + 1, newLine: baseOffset + j + 1, text: a[i] });
      i++;
      j++;
      continue;
    }
    // 尝试在局部窗口内向前寻找同步点
    let bestI = -1;
    let bestJ = -1;
    let bestDist = Infinity;

    const searchMaxA = Math.min(a.length, i + 60);
    for (let ti = i; ti < searchMaxA; ti++) {
      const candidates = bPos.get(a[ti]);
      if (!candidates) continue;
      for (const tj of candidates) {
        if (tj < j || tj > j + 120) continue;
        // 优先找连续2行匹配或非空行匹配
        const isGood = a[ti].trim().length > 0 || (ti + 1 < a.length && tj + 1 < b.length && a[ti + 1] === b[tj + 1]);
        if (!isGood) continue;
        const dist = (ti - i) + (tj - j);
        if (dist < bestDist) {
          bestDist = dist;
          bestI = ti;
          bestJ = tj;
        }
        break;
      }
      if (bestDist <= 4) break;
    }

    if (bestI !== -1) {
      while (i < bestI) {
        ops.push({ type: 'del', oldLine: baseOffset + i + 1, newLine: baseOffset + j + 1, text: a[i] });
        i++;
      }
      while (j < bestJ) {
        ops.push({ type: 'add', oldLine: baseOffset + i + 1, newLine: baseOffset + j + 1, text: b[j] });
        j++;
      }
    } else {
      // 未找到近距同步点：先消耗一对修改行
      ops.push({ type: 'del', oldLine: baseOffset + i + 1, newLine: baseOffset + j + 1, text: a[i] });
      ops.push({ type: 'add', oldLine: baseOffset + i + 1, newLine: baseOffset + j + 1, text: b[j] });
      i++;
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ type: 'del', oldLine: baseOffset + i + 1, newLine: baseOffset + j + 1, text: a[i] });
    i++;
  }
  while (j < b.length) {
    ops.push({ type: 'add', oldLine: baseOffset + i + 1, newLine: baseOffset + j + 1, text: b[j] });
    j++;
  }
  return ops;
}

/**
 * 更新方法论卡片库头部元数据（版本、同步日期、修订摘要、总数）
 */
function updateMethodologyHeader(content, { oldVersion, newVersion, date, summaryLine, totalTitles, activeCount, conflictCount, maxId, cogVersion, ledgerVersion }) {
  let out = content;
  // 1. HTML 注释首行
  out = out.replace(
    /^<!-- 项目现行文档 \|[^\n]+-->/,
    `<!-- 项目现行文档 | 同步日期: ${date} | 版本: ${newVersion} | 基线: ${oldVersion} | ${summaryLine.slice(0, 80)} -->`
  );
  // 2. 版本前缀行
  out = out.replace(
    new RegExp(`^> 版本：${oldVersion.replace('.', '\\.')}（`, 'm'),
    `> 版本：${newVersion}（${date} ${newVersion}：${summaryLine}；`
  );
  // 3. 同步日期行 + 插入最新修订摘要（仅更新日期与基线，保留原行末尾的保留号/缺号声明等用户注记）
  out = out.replace(/^> 同步日期：([^\n]*)$/m, (_full, rest) => {
    let lineBody = String(rest || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(lineBody)) {
      lineBody = lineBody.replace(/^\d{4}-\d{2}-\d{2}/, date);
    } else if (lineBody) {
      lineBody = `${date}；${lineBody}`;
    } else {
      lineBody = date;
    }
    if (/基线[：:]\s*v\d+(?:\.\d+)*/.test(lineBody)) {
      lineBody = lineBody.replace(/(基线[：:]\s*)v\d+(?:\.\d+)*/, `$1${oldVersion}`);
    } else if (!/基线/.test(lineBody)) {
      lineBody = `${lineBody.replace(/[。.]\s*$/, '')}；基线：${oldVersion}。`;
    }
    return `> 同步日期：${lineBody}\n> ${newVersion} 修订摘要（${date}，通过三库工作台确认落库）：${summaryLine}`;
  });
  // 4. 配套现行文件
  if (cogVersion && ledgerVersion) {
    const curDirSlash = PATHS.currentDir.replace(/\\/g, '/');
    out = out.replace(
      /^> 配套现行文件：[^\n]+/m,
      `> 配套现行文件：[行业前沿认知库 ${cogVersion}](<${curDirSlash}/行业前沿认知库.md>)；[研判与复盘台账 ${ledgerVersion}](<${curDirSlash}/研判与复盘台账.md>)。历史记录中的版本、旧库映射和“已核验”字样按当时记录解释，不自动等于本轮重验通过。`
    );
  }
  // 5. 索引行和目录统计行（仅更新计算数值，完整保留原文声明的保留号、撤销号与历史说明，绝不注入固定私库文本）
  if (totalTitles != null && activeCount != null && conflictCount != null && maxId) {
    out = out.replace(/^(> 编号\d{3}—)\d{3}([^\n]*)$/m, (_full, prefix, rest) => {
      let updated = `${prefix}${maxId}${rest}`;
      updated = updated.replace(/\d+个保留标题/, `${totalTitles}个保留标题`);
      updated = updated.replace(/未撤销条目\d+个/, `未撤销条目${activeCount}个`);
      updated = updated.replace(/冲突矩阵\d+项/, `冲突矩阵${conflictCount}项`);
      updated = updated.replace(/(205—)\d{3}(全部列入目录)/, `$1${maxId}$2`);
      return updated;
    });
    out = out.replace(
      /^\d+个卡片标题、\d+项冲突均可定位；/m,
      `${totalTitles}个卡片标题、${conflictCount}项冲突均可定位；`
    );
  }
  return out;
}

/**
 * 更新认知库头部元数据
 */
function updateCognitionHeader(content, { oldVersion, newVersion, date, summaryLine, totalCount, methodVersion, ledgerVersion }) {
  let out = content;
  out = out.replace(
    /^> 版本：v\d+(?:\.\d+)*（[^）]+）。/m,
    `> 版本：${newVersion}（${date}）。`
  );
  out = out.replace(
    /^> 同步日期：[^\n]+/m,
    `> 同步日期：${date}；全库共${totalCount}张。\n> ${newVersion} 修订摘要（${date}，通过三库工作台确认落库）：${summaryLine}`
  );
  if (methodVersion && ledgerVersion) {
    const curDirSlash = PATHS.currentDir.replace(/\\/g, '/');
    out = out.replace(
      /^> 配套现行文件：[^\n]+/m,
      `> 配套现行文件：[方法论卡片库 ${methodVersion}](<${curDirSlash}/方法论卡片库.md>)；[研判与复盘台账 ${ledgerVersion}](<${curDirSlash}/研判与复盘台账.md>)。文件版本不代表所有事实截至同步日仍然有效。`
    );
  }
  out = out.replace(
    /^## 完整目录（更新至\d{4}-\d{2}-\d{2}）/m,
    `## 完整目录（更新至${date}）`
  );
  out = out.replace(
    /^认知卡001—\d{3}均可定位。/m,
    `认知卡001—${pad3(totalCount)}均可定位。`
  );
  return out;
}

/**
 * 更新台账头部元数据
 */
function updateLedgerHeader(content, { oldVersion, newVersion, date, summaryLine, latestDailyDate, methodVersion, cogVersion }) {
  let out = content;
  out = out.replace(
    new RegExp(`^> 版本：${oldVersion.replace('.', '\\.')}（`, 'm'),
    `> 版本：${newVersion}（${date} ${newVersion}：${summaryLine}；`
  );
  out = out.replace(
    /^> 同步日期：[^\n]+/m,
    `> 同步日期：${date}；基线：${oldVersion}，最新日度正文为${latestDailyDate || date}。\n> ${newVersion} 修订摘要（${date}，通过三库工作台确认落库）：${summaryLine}`
  );
  if (methodVersion && cogVersion) {
    const curDirSlash = PATHS.currentDir.replace(/\\/g, '/');
    out = out.replace(
      /^> 关联文件：[^\n]+/m,
      `> 关联文件：[方法论卡片库.md](<${curDirSlash}/方法论卡片库.md>) ${methodVersion}；[行业前沿认知库.md](<${curDirSlash}/行业前沿认知库.md>) ${cogVersion}（文档同步日期${date}；“卡片XXX”与“认知卡XXX”分别指对应库，局部明确标记的旧库引用除外）。历史正文的版本标记保留当时含义。`
    );
  }
  return out;
}

/**
 * 在完整目录表的末尾插入新的 TOC 行
 */
function appendTocRows(content, newRows) {
  const lines = content.split(/\r?\n/);
  const tocStart = lines.findIndex((l) => /^## 完整目录/.test(l));
  if (tocStart === -1) return content;

  let lastTableRow = -1;
  for (let i = tocStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith('| H')) lastTableRow = i;
    else if (lastTableRow !== -1 && !lines[i].startsWith('|')) break;
  }
  if (lastTableRow === -1) return content;
  lines.splice(lastTableRow + 1, 0, ...newRows);
  return lines.join('\n');
}

/**
 * 生成写盘变更计划（不触碰磁盘，用于确认门预览）
 */
function buildMutationPlan(action, payload, virtualState = null) {
  if (!virtualState && PATHS.kbMode === 'v2') {
    return buildKbV2MutationPlan(action, payload || {}, {
      kbDir: PATHS.kbDir,
      paths: PATHS,
      todayISO,
      buildUnifiedDiff,
      bumpMinorVersion,
      appendTocRows,
      updateLedgerHeader,
      escapeTocTitle,
      parseLedger,
    });
  }

  const date = payload.date || todayISO();

  const mOrig = virtualState ? virtualState.mOrig : fs.readFileSync(PATHS.methodology, 'utf8');
  const cOrig = virtualState ? virtualState.cOrig : fs.readFileSync(PATHS.cognition, 'utf8');
  const lOrig = virtualState ? virtualState.lOrig : fs.readFileSync(PATHS.ledger, 'utf8');
  const ws = virtualState
    ? {
        methodology: parseMethodology(mOrig),
        cognition: parseCognition(cOrig),
        ledger: parseLedger(lOrig),
      }
    : loadWorkspace();

  // =========================================================================
  // 0. 批量合并事务（一次 Diff 预览 + 一次原子快照写入多张卡片/增订）
  // =========================================================================
  if (action === 'batch.commitOperations') {
    const ops = Array.isArray(payload.operations) ? payload.operations : [];
    if (ops.length === 0) {
      return { ok: false, action, date, validationErrors: ['请至少勾选 1 条待入库操作。'], summaryBullets: [], diffs: [], files: {} };
    }
    let mCur = mOrig;
    let cCur = cOrig;
    let lCur = lOrig;
    const allSummary = [];
    const allErrors = [];
    let mVerAfter = ws.methodology.meta.version;
    let cVerAfter = ws.cognition.meta.version;
    let lVerAfter = ws.ledger.meta.version;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || !op.action || op.action === 'batch.commitOperations') continue;
      const subPlan = buildMutationPlan(op.action, { ...(op.payload || {}), date }, { mOrig: mCur, cOrig: cCur, lOrig: lCur });
      if (!subPlan.ok) {
        allErrors.push(`第 ${i + 1} 项 (${op.action}) 失败：${subPlan.validationErrors.join('；')}`);
        continue;
      }
      if (subPlan.files.methodology) {
        mCur = subPlan.files.methodology.after;
        mVerAfter = subPlan.files.methodology.versionAfter;
      }
      if (subPlan.files.cognition) {
        cCur = subPlan.files.cognition.after;
        cVerAfter = subPlan.files.cognition.versionAfter;
      }
      if (subPlan.files.ledger) {
        lCur = subPlan.files.ledger.after;
        lVerAfter = subPlan.files.ledger.versionAfter;
      }
      allSummary.push(...subPlan.summaryBullets);
    }

    const batchFiles = {};
    if (mCur !== mOrig) {
      batchFiles.methodology = {
        path: PATHS.methodology,
        label: '方法论卡片库.md',
        before: mOrig,
        after: mCur,
        versionBefore: ws.methodology.meta.version,
        versionAfter: mVerAfter,
      };
    }
    if (cCur !== cOrig) {
      batchFiles.cognition = {
        path: PATHS.cognition,
        label: '行业前沿认知库.md',
        before: cOrig,
        after: cCur,
        versionBefore: ws.cognition.meta.version,
        versionAfter: cVerAfter,
      };
    }
    if (lCur !== lOrig) {
      batchFiles.ledger = {
        path: PATHS.ledger,
        label: '研判与复盘台账.md',
        before: lOrig,
        after: lCur,
        versionBefore: ws.ledger.meta.version,
        versionAfter: lVerAfter,
      };
    }

    const diffs = Object.entries(batchFiles).map(([key, f]) => ({
      key,
      label: f.label,
      versionBefore: f.versionBefore,
      versionAfter: f.versionAfter,
      diff: buildUnifiedDiff(f.before, f.after, f.label),
    }));

    return {
      ok: allErrors.length === 0 && Object.keys(batchFiles).length > 0,
      action,
      date,
      validationErrors: allErrors.length > 0 ? allErrors : Object.keys(batchFiles).length === 0 ? ['无有效文件变更'] : [],
      summaryBullets: [`批量合并提交共 ${ops.length} 项操作（合并为 1 次原子快照备份）：`, ...allSummary.slice(0, 18)],
      diffs,
      files: batchFiles,
    };
  }

  const files = {}; // key -> { path, label, before, after, versionBefore, versionAfter }
  const summaryBullets = [];
  const validationErrors = [];

  // =========================================================================
  // 1. 新增方法论卡片
  // =========================================================================
  if (action === 'methodology.createCard') {
    const existingIds = new Set((ws.methodology.cards || []).map((c) => c.id));
    const reservedIds = new Set(
      Array.isArray(ws.methodology.stats?.reservedMissing) ? ws.methodology.stats.reservedMissing : []
    );
    let candidateNum = Number(ws.methodology.stats.nextCardId) || 1;
    while (
      existingIds.has(String(candidateNum).padStart(3, '0')) ||
      reservedIds.has(String(candidateNum).padStart(3, '0'))
    ) {
      candidateNum += 1;
    }
    const id = String(candidateNum).padStart(3, '0');
    if (reservedIds.has(id) || existingIds.has(id)) {
      validationErrors.push(`目标卡片编号 ${id} 已被占用或声明为保留号，无法写入。`);
    }
    if (!payload.system?.trim() || !payload.topic?.trim()) validationErrors.push('请填写体系名与主题名。');
    if (!payload.coreThesis?.trim()) validationErrors.push('核心论断必填。');
    if (!payload.invalidationSignals?.trim()) validationErrors.push('失效信号必填（契约铁律：写不出可证伪性不得入库）。');
    if (!payload.source?.trim()) validationErrors.push('来源必填。');

    if (validationErrors.length === 0) {
      const oldVer = ws.methodology.meta.version;
      const newVer = bumpMinorVersion(oldVer);
      const batchNote = payload.batchNote?.trim() || '日常维护批次';
      const cred = Number.isFinite(Number(payload.credibility)) ? Number(payload.credibility) : 0.5;
      const headingTitle = `卡片 ${id} | ${payload.system.trim()}（${payload.topic.trim()}）【${date} 入库，${batchNote}】`;

      const cardBlock = [
        `<a id="method-${id}"></a>`,
        '',
        `## ${headingTitle}`,
        `- 核心论断：${payload.coreThesis.trim()}`,
        payload.logicChain?.trim() ? `- 逻辑链条：${payload.logicChain.trim()}` : null,
        `- 适用条件：${(payload.applicableConditions || '待补充具体适用条件').trim()}`,
        `- 失效信号：${payload.invalidationSignals.trim()}`,
        `- 历史案例：${(payload.historicalCases || '待实盘验证补充').trim()}`,
        `- 可信度：${cred}`,
        `- 来源：${payload.source.trim()}`,
      ]
        .filter((x) => x !== null)
        .join('\n');

      const newSectionTitle = payload.newSectionTitle?.trim();
      const tocRows = [];
      let appendBody = '';
      if (newSectionTitle) {
        const secAnchor = `m-sec-${Date.now().toString(36)}`;
        tocRows.push(`| H1 | [${escapeTocTitle(newSectionTitle)}](#${secAnchor}) | ${date} 新增节 | — |`);
        appendBody += `\n\n---\n\n<a id="${secAnchor}"></a>\n\n# ${newSectionTitle}\n\n${cardBlock}`;
      } else {
        appendBody += `\n\n${cardBlock}`;
      }
      tocRows.push(`| H2 | [${escapeTocTitle(headingTitle)}](#method-${id}) | ${date} 新增 | — |`);

      let mNext = appendTocRows(mOrig, tocRows) + appendBody;
      const summaryLine = `新增卡片 ${id}（${payload.system.trim()}：${payload.topic.trim()}，${batchNote}）`;
      mNext = updateMethodologyHeader(mNext, {
        oldVersion: oldVer,
        newVersion: newVer,
        date,
        summaryLine,
        totalTitles: ws.methodology.stats.totalTitles + 1,
        activeCount: ws.methodology.stats.activeCount + 1,
        conflictCount: ws.methodology.stats.conflictCount,
        maxId: id,
        cogVersion: ws.cognition.meta.version,
        ledgerVersion: ws.ledger.meta.version,
      });

      files.methodology = {
        path: PATHS.methodology,
        label: '方法论卡片库.md',
        before: mOrig,
        after: mNext,
        versionBefore: oldVer,
        versionAfter: newVer,
      };
      summaryBullets.push(`方法论卡片库 ${oldVer} → ${newVer}：新增卡片 ${id}（${payload.topic.trim()}），同步完整目录与文件头索引。`);
    }
  }

  // =========================================================================
  // 2. 方法论卡片追加增订（不覆盖原字段）
  // =========================================================================
  else if (action === 'methodology.appendAmendment') {
    const card = ws.methodology.cards.find((c) => c.id === payload.cardId);
    if (!card) validationErrors.push(`未找到方法论卡片 ${payload.cardId}。`);
    if (!payload.content?.trim()) validationErrors.push('增订内容不能为空。');

    if (validationErrors.length === 0) {
      const oldVer = ws.methodology.meta.version;
      const newVer = bumpMinorVersion(oldVer);
      const batchNote = payload.batchNote?.trim() || '日常增订';
      const amendLine = `- ${newVer} 增订（${date}，${batchNote}）：${payload.content.trim()}`;

      const lines = mOrig.split(/\r?\n/);
      lines.splice(card.endLine, 0, amendLine);
      let mNext = lines.join('\n');
      const summaryLine = `增订卡片 ${card.id}（${batchNote}，保留原字段不覆盖）`;
      mNext = updateMethodologyHeader(mNext, {
        oldVersion: oldVer,
        newVersion: newVer,
        date,
        summaryLine,
        cogVersion: ws.cognition.meta.version,
        ledgerVersion: ws.ledger.meta.version,
      });

      files.methodology = {
        path: PATHS.methodology,
        label: '方法论卡片库.md',
        before: mOrig,
        after: mNext,
        versionBefore: oldVer,
        versionAfter: newVer,
      };
      summaryBullets.push(`方法论卡片库 ${oldVer} → ${newVer}：在卡片 ${card.id} 末尾追加增订记录，保留历史原字段。`);
    }
  }

  // =========================================================================
  // 3. 方法论卡片可信度复盘调整
  // =========================================================================
  else if (action === 'methodology.adjustCredibility') {
    const card = ws.methodology.cards.find((c) => c.id === payload.cardId);
    if (!card) validationErrors.push(`未找到方法论卡片 ${payload.cardId}。`);
    if (!payload.reason?.trim()) validationErrors.push('必须填写复盘验证依据或维持说明。');

    if (validationErrors.length === 0) {
      const oldVer = ws.methodology.meta.version;
      const newVer = bumpMinorVersion(oldVer);
      const delta = Number(payload.delta || 0); // +0.1 | -0.15 | 0
      const oldScore = card.credibilityScore ?? 0.5;
      const newScore = Math.max(0, Math.min(1, Number((oldScore + delta).toFixed(2))));
      const retireTag = newScore < 0.3 ? '【待淘汰】' : '';
      const modeLabel = delta > 0 ? `验证为真（${oldScore}→${newScore}，+${delta}）` : delta < 0 ? `证伪（${oldScore}→${newScore}，${delta}）` : `维持现值（${oldScore}）`;

      const lines = mOrig.split(/\r?\n/);
      // 找到卡片内的 `- 可信度：` 行
      let credLineIdx = -1;
      for (let i = card.startLine - 1; i < card.endLine; i++) {
        if (/^- 可信度[：:]/.test(lines[i])) {
          credLineIdx = i;
          break;
        }
      }
      if (credLineIdx === -1) {
        validationErrors.push(`卡片 ${card.id} 正文中未定位到可信度字段行。`);
      } else {
        if (delta !== 0) {
          const shortNote = payload.shortNote?.trim() || `${date}复盘${delta > 0 ? `+${delta}` : delta}`;
          lines[credLineIdx] = `- 可信度：${newScore}${retireTag}（${shortNote}）`;
        }
        const reviewLine = `- 复盘记录 ${date}：${modeLabel}——${payload.reason.trim()}`;
        lines.splice(card.endLine, 0, reviewLine);

        let mNext = lines.join('\n');
        const summaryLine = `复盘回填卡片 ${card.id}：${modeLabel}`;
        mNext = updateMethodologyHeader(mNext, {
          oldVersion: oldVer,
          newVersion: newVer,
          date,
          summaryLine,
          cogVersion: ws.cognition.meta.version,
          ledgerVersion: ws.ledger.meta.version,
        });

        files.methodology = {
          path: PATHS.methodology,
          label: '方法论卡片库.md',
          before: mOrig,
          after: mNext,
          versionBefore: oldVer,
          versionAfter: newVer,
        };
        summaryBullets.push(`方法论卡片库 ${oldVer} → ${newVer}：卡片 ${card.id} ${modeLabel}，并追加 ${date} 复盘记录行。`);
        if (newScore < 0.3) {
          summaryBullets.push(`⚠️ 卡片 ${card.id} 可信度降至 ${newScore} (<0.3)，已自动附加【待淘汰】标记，待用户裁决。`);
        }
      }
    }
  }

  // =========================================================================
  // 4. 方法论卡片高级原文局部编辑
  // =========================================================================
  else if (action === 'methodology.editCardRaw') {
    const card = ws.methodology.cards.find((c) => c.id === payload.cardId);
    if (!card) validationErrors.push(`未找到方法论卡片 ${payload.cardId}。`);
    if (!payload.rawMarkdown?.trim()) validationErrors.push('正文不能为空。');
    else if (!payload.rawMarkdown.trim().startsWith(`## 卡片 ${payload.cardId}`)) {
      validationErrors.push(`必须保留「## 卡片 ${payload.cardId}」标题前缀以维持编号锚点。`);
    }

    if (validationErrors.length === 0) {
      const oldVer = ws.methodology.meta.version;
      const newVer = bumpMinorVersion(oldVer);
      const lines = mOrig.split(/\r?\n/);
      const replacementLines = payload.rawMarkdown.replace(/\r\n/g, '\n').trimEnd().split('\n');
      lines.splice(card.startLine - 1, card.endLine - card.startLine + 1, ...replacementLines);

      let mNext = lines.join('\n');
      const summaryLine = payload.summary?.trim() || `定向修订卡片 ${card.id} 正文`;
      mNext = updateMethodologyHeader(mNext, {
        oldVersion: oldVer,
        newVersion: newVer,
        date,
        summaryLine,
        cogVersion: ws.cognition.meta.version,
        ledgerVersion: ws.ledger.meta.version,
      });
      files.methodology = {
        path: PATHS.methodology,
        label: '方法论卡片库.md',
        before: mOrig,
        after: mNext,
        versionBefore: oldVer,
        versionAfter: newVer,
      };
      summaryBullets.push(`方法论卡片库 ${oldVer} → ${newVer}：修订卡片 ${card.id}（${summaryLine}）。`);
    }
  }

  // =========================================================================
  // 5. 新增冲突矩阵条目
  // =========================================================================
  else if (action === 'methodology.createConflict') {
    const id = ws.methodology.stats.nextConflictId;
    if (!payload.title?.trim() || !payload.sides?.trim() || !payload.conflictPoint?.trim() || !payload.resolution?.trim()) {
      validationErrors.push('冲突标题、双方观点、冲突点、折中思路/判别变量均为必填。');
    }

    if (validationErrors.length === 0) {
      const oldVer = ws.methodology.meta.version;
      const newVer = bumpMinorVersion(oldVer);
      const headingText = `冲突 ${id}（${newVer} 新增，${date}）：${payload.title.trim()}`;
      const conflictBlock = [
        '',
        `<a id="conflict-${id}"></a>`,
        '',
        `## ${headingText}`,
        `- 双方：${payload.sides.trim()}`,
        `- 冲突点：${payload.conflictPoint.trim()}`,
        `- 折中思路：${payload.resolution.trim()}`,
      ].join('\n');

      const lastConflict = ws.methodology.conflicts[ws.methodology.conflicts.length - 1];
      const lines = mOrig.split(/\r?\n/);
      lines.splice(lastConflict.endLine, 0, conflictBlock);
      let mNext = lines.join('\n');

      // 插入到 TOC 最后一个冲突条目后
      const tocLines = mNext.split(/\r?\n/);
      const lastConfTocIdx = tocLines.findIndex((l) => l.includes(`#conflict-${lastConflict.id})`));
      if (lastConfTocIdx !== -1) {
        tocLines.splice(
          lastConfTocIdx + 1,
          0,
          `| H2 | [${escapeTocTitle(headingText)}](#conflict-${id}) | ${date} 新增冲突条目 | — |`
        );
        mNext = tocLines.join('\n');
      }

      const summaryLine = `新增冲突 ${id}（${payload.title.trim()}）`;
      mNext = updateMethodologyHeader(mNext, {
        oldVersion: oldVer,
        newVersion: newVer,
        date,
        summaryLine,
        totalTitles: ws.methodology.stats.totalTitles,
        activeCount: ws.methodology.stats.activeCount,
        conflictCount: ws.methodology.stats.conflictCount + 1,
        maxId: pad3(Math.max(...ws.methodology.cards.map((c) => c.num))),
        cogVersion: ws.cognition.meta.version,
        ledgerVersion: ws.ledger.meta.version,
      });

      files.methodology = {
        path: PATHS.methodology,
        label: '方法论卡片库.md',
        before: mOrig,
        after: mNext,
        versionBefore: oldVer,
        versionAfter: newVer,
      };
      summaryBullets.push(`方法论卡片库 ${oldVer} → ${newVer}：新增冲突 ${id}（${payload.title.trim()}），同步冲突目录与索引总数。`);
    }
  }

  // =========================================================================
  // 6. 新增行业前沿认知卡
  // =========================================================================
  else if (action === 'cognition.createCard') {
    const id = ws.cognition.stats.nextCardId;
    if (!payload.title?.trim()) validationErrors.push('请填写认知卡主题标题。');
    if (!payload.facts?.trim()) validationErrors.push('事实/要点必填。');
    if (!payload.evidenceLevel?.trim() || !/[ABC]/.test(payload.evidenceLevel)) {
      validationErrors.push('证据等级必填且须包含 A / B / C 级别（认知库铁律①）。');
    }
    if (!payload.invalidationConditions?.trim()) {
      validationErrors.push('失效/更新条件必填（认知库铁律②，写不出不得入库）。');
    }
    if (!payload.source?.trim()) validationErrors.push('来源必填。');

    if (validationErrors.length === 0) {
      const oldVer = ws.cognition.meta.version;
      const newVer = bumpMinorVersion(oldVer);
      const catTag = payload.categoryTag?.trim() ? `（${payload.categoryTag.trim()}）` : '';
      const headingTitle = `认知卡 ${id} | ${payload.title.trim()}【${date} 入库】${catTag}`;

      const relParts = [];
      if (payload.relatedMethodIds?.trim()) relParts.push(payload.relatedMethodIds.trim());
      const relatedCogLinks = payload.relatedCognitionIds?.trim()
        ? payload.relatedCognitionIds
            .split(/[,，、/\s]+/)
            .filter((x) => /^\d{3}$/.test(x))
            .map((x) => `[${x}](#cognition-${x})`)
            .join('、')
        : '';

      const cardBlock = [
        `<a id="cognition-${id}"></a>`,
        '',
        `## ${headingTitle}`,
        `- 事实/要点：${payload.facts.trim()}`,
        `- 来源：${payload.source.trim()}`,
        `- 证据等级：${payload.evidenceLevel.trim()}`,
        `- 产业含义（分析）：${(payload.industryImplications || '待补充产业含义分析').trim()}`,
        `- A 股映射（分析）：${(payload.aShareMapping || '待补充 A 股映射分析').trim()}`,
        `- 置信度：${(payload.confidence || '中').trim()}`,
        `- 失效/更新条件：${payload.invalidationConditions.trim()}`,
        `- 关联方法论卡片：${relParts.join('、') || '待关联'}${relatedCogLinks ? `；关联认知卡：${relatedCogLinks}` : ''}。`,
        `- 更新日志：${date} 正式入库（${payload.batchName?.trim() || '日常维护批次'}）。`,
      ].join('\n');

      const newBatchTitle = payload.newBatchTitle?.trim();
      const tocRows = [];
      let appendBody = '';
      if (newBatchTitle) {
        const bAnchor = `c-batch-${Date.now().toString(36)}`;
        tocRows.push(`| H1 | [${escapeTocTitle(newBatchTitle)}](#${bAnchor}) | ${date} 新增批次 | — |`);
        appendBody += `\n\n---\n\n<a id="${bAnchor}"></a>\n\n# ${newBatchTitle}\n\n${cardBlock}`;
      } else {
        appendBody += `\n\n${cardBlock}`;
      }
      tocRows.push(`| H2 | [${escapeTocTitle(headingTitle)}](#cognition-${id}) | ${date} 新增 | — |`);

      let cNext = appendTocRows(cOrig, tocRows) + appendBody;
      const summaryLine = `新增认知卡 ${id}（${payload.title.trim()}，证据等级 ${payload.evidenceLevel.trim().slice(0, 12)}）`;
      cNext = updateCognitionHeader(cNext, {
        oldVersion: oldVer,
        newVersion: newVer,
        date,
        summaryLine,
        totalCount: ws.cognition.stats.totalCount + 1,
        methodVersion: ws.methodology.meta.version,
        ledgerVersion: ws.ledger.meta.version,
      });

      files.cognition = {
        path: PATHS.cognition,
        label: '行业前沿认知库.md',
        before: cOrig,
        after: cNext,
        versionBefore: oldVer,
        versionAfter: newVer,
      };
      summaryBullets.push(`行业前沿认知库 ${oldVer} → ${newVer}：新增认知卡 ${id}，同步目录与版本号。`);
    }
  }

  // =========================================================================
  // 7. 认知卡追加增订或状态标记
  // =========================================================================
  else if (action === 'cognition.appendAmendment' || action === 'cognition.markStatus') {
    const card = ws.cognition.cards.find((c) => c.id === payload.cardId);
    if (!card) validationErrors.push(`未找到认知卡 ${payload.cardId}。`);
    if (action === 'cognition.appendAmendment' && !payload.content?.trim()) {
      validationErrors.push('增订内容不能为空。');
    }
    if (action === 'cognition.markStatus' && !payload.statusType) {
      validationErrors.push('请选择状态标记类型。');
    }

    if (validationErrors.length === 0) {
      const oldVer = ws.cognition.meta.version;
      const newVer = bumpMinorVersion(oldVer);
      const lines = cOrig.split(/\r?\n/);
      let summaryLine = '';

      if (action === 'cognition.appendAmendment') {
        const note = payload.batchNote?.trim() || '跨源互证增订';
        lines.splice(card.endLine, 0, `- ${date} 增订（${note}）：${payload.content.trim()}`);
        summaryLine = `增订认知卡 ${card.id}（${note}，不覆盖原数据）`;
      } else {
        let badge = '';
        if (payload.statusType === 'updated' && payload.targetCardId) {
          badge = `【已更新→卡号${pad3(payload.targetCardId)}】`;
        } else if (payload.statusType === 'falsified') {
          badge = `【⚠️部分证伪 ${date}：${(payload.statusDetail || '待补充依据').trim()}】`;
        } else if (payload.statusType === 'archived') {
          badge = `【${date} 整卡归档】`;
        }
        if (badge) {
          lines[card.startLine - 1] = `${lines[card.startLine - 1]}${badge}`;
          if (payload.statusDetail?.trim()) {
            lines.splice(card.endLine, 0, `- ${date} 状态更新：${badge} ${payload.statusDetail.trim()}`);
          }
        }
        summaryLine = `更新认知卡 ${card.id} 状态标记为 ${badge}`;
      }

      let cNext = lines.join('\n');
      cNext = updateCognitionHeader(cNext, {
        oldVersion: oldVer,
        newVersion: newVer,
        date,
        summaryLine,
        totalCount: ws.cognition.stats.totalCount,
        methodVersion: ws.methodology.meta.version,
        ledgerVersion: ws.ledger.meta.version,
      });

      files.cognition = {
        path: PATHS.cognition,
        label: '行业前沿认知库.md',
        before: cOrig,
        after: cNext,
        versionBefore: oldVer,
        versionAfter: newVer,
      };
      summaryBullets.push(`行业前沿认知库 ${oldVer} → ${newVer}：${summaryLine}。`);
    }
  }

  // =========================================================================
  // 8. 认知卡高级原文编辑
  // =========================================================================
  else if (action === 'cognition.editCardRaw') {
    const card = ws.cognition.cards.find((c) => c.id === payload.cardId);
    if (!card) validationErrors.push(`未找到认知卡 ${payload.cardId}。`);
    if (!payload.rawMarkdown?.trim()) validationErrors.push('正文不能为空。');
    else if (!payload.rawMarkdown.trim().startsWith(`## 认知卡 ${payload.cardId}`)) {
      validationErrors.push(`必须保留「## 认知卡 ${payload.cardId}」标题前缀。`);
    }

    if (validationErrors.length === 0) {
      const oldVer = ws.cognition.meta.version;
      const newVer = bumpMinorVersion(oldVer);
      const lines = cOrig.split(/\r?\n/);
      const replacementLines = payload.rawMarkdown.replace(/\r\n/g, '\n').trimEnd().split('\n');
      lines.splice(card.startLine - 1, card.endLine - card.startLine + 1, ...replacementLines);
      let cNext = lines.join('\n');
      const summaryLine = payload.summary?.trim() || `定向修订认知卡 ${card.id}`;
      cNext = updateCognitionHeader(cNext, {
        oldVersion: oldVer,
        newVersion: newVer,
        date,
        summaryLine,
        totalCount: ws.cognition.stats.totalCount,
        methodVersion: ws.methodology.meta.version,
        ledgerVersion: ws.ledger.meta.version,
      });

      files.cognition = {
        path: PATHS.cognition,
        label: '行业前沿认知库.md',
        before: cOrig,
        after: cNext,
        versionBefore: oldVer,
        versionAfter: newVer,
      };
      summaryBullets.push(`行业前沿认知库 ${oldVer} → ${newVer}：${summaryLine}。`);
    }
  }

  // =========================================================================
  // 9. 台账新增标的研判记录（工作模式二）
  // =========================================================================
  else if (action === 'ledger.createJudgment') {
    const recordKey = payload.recordKey?.trim() || ws.ledger.stats.nextJudgmentKey;
    if (!payload.target?.trim()) validationErrors.push('请填写标的名称与代码。');
    if (!payload.conclusion?.trim()) validationErrors.push('请填写一句话综合结论。');
    const validHyps = (payload.hypotheses || []).filter((h) => h.claim?.trim());
    if (validHyps.length === 0) validationErrors.push('至少填写 1 条可证伪的关键假设（含验证方式/时点/证伪条件）。');

    if (validationErrors.length === 0) {
      const oldVer = ws.ledger.meta.version;
      const newVer = bumpMinorVersion(oldVer);
      const anchor = `l-judge-${recordKey.replace('#', '')}-${date.replaceAll('-', '')}`;
      const heading = `研判记录 ${recordKey}（${payload.target.trim()}，${date}）`;

      const hypLines = validHyps.map(
        (h, idx) =>
          `  - H${idx + 1}：${h.claim.trim()}｜验证方式：${(h.verifyMethod || '待补').trim()}｜验证时点：${(h.verifyDate || '待定').trim()}｜证伪条件：${(h.falsifyCond || '待补').trim()}`
      );

      const block = [
        '',
        '---',
        '',
        `<a id="${anchor}"></a>`,
        '',
        `## ${heading}`,
        '',
        `- 标的：${payload.target.trim()}`,
        `- 研判日期：${date}（数据截止：${payload.dataCutoff?.trim() || date}）`,
        `- 评分：${payload.score ?? '待定'} / 10（仅供研究，不构成投资建议）`,
        `- 市场状态与双线定位：${(payload.marketState || '趋势池 / 短线池分别管理').trim()}`,
        `- 一句话结论：${payload.conclusion.trim()}`,
        payload.industryPosition?.trim() ? `- 产业定位：${payload.industryPosition.trim()}` : null,
        payload.bullArgs?.trim() ? `- 多头核心论断：${payload.bullArgs.trim()}` : null,
        payload.bearArgs?.trim() ? `- 空头核心论断：${payload.bearArgs.trim()}` : null,
        payload.tradingStructure?.trim() ? `- 交易结构（介入/失效/仓位边界）：${payload.tradingStructure.trim()}` : null,
        payload.behavioralCheck?.trim() ? `- 行为金融检视：${payload.behavioralCheck.trim()}` : null,
        `- 关键假设清单：`,
        ...hypLines,
        `- 引用卡片（方法论）：${(payload.methodIds || '待关联').trim()}；认知卡：${(payload.cognitionIds || '待关联').trim()}`,
      ]
        .filter((x) => x !== null)
        .join('\n');

      let lNext = appendTocRows(lOrig, [`| H2 | [${escapeTocTitle(heading)}](#${anchor}) | ${date} 新增标的研判 | — |`]) + '\n' + block;
      const summaryLine = `新增标的研判 ${recordKey}（${payload.target.trim()}，评分 ${payload.score ?? '待定'}/10）`;
      lNext = updateLedgerHeader(lNext, {
        oldVersion: oldVer,
        newVersion: newVer,
        date,
        summaryLine,
        latestDailyDate: ws.ledger.stats.latestDailyDate,
        methodVersion: ws.methodology.meta.version,
        cogVersion: ws.cognition.meta.version,
      });

      files.ledger = {
        path: PATHS.ledger,
        label: '研判与复盘台账.md',
        before: lOrig,
        after: lNext,
        versionBefore: oldVer,
        versionAfter: newVer,
      };
      summaryBullets.push(`研判与复盘台账 ${oldVer} → ${newVer}：新增 ${heading}，含 ${validHyps.length} 条可证伪假设。`);
    }
  }

  // =========================================================================
  // 10. 台账新增每日 A 股复盘（工作模式四 + 可选原子联动方法论库可信度）
  // =========================================================================
  else if (action === 'ledger.createDailyReview') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) validationErrors.push('请填写有效的复盘日期 YYYY-MM-DD。');
    if (ws.ledger.dailyReviews.some((d) => d.date === date)) {
      validationErrors.push(`台账中已存在 ${date} 的日度复盘记录，请勿重复创建。`);
    }
    if (!payload.headline?.trim()) validationErrors.push('请填写当日盘面一句话定性标题。');
    if (!payload.marketFacts?.trim()) validationErrors.push('请填写指数与盘面事实（含数据来源）。');

    if (validationErrors.length === 0) {
      const oldLVer = ws.ledger.meta.version;
      const newLVer = bumpMinorVersion(oldLVer);
      const anchor = `l-daily-${date.replaceAll('-', '')}`;
      const heading = `复盘记录 ${date}（${payload.headline.trim()}）`;

      const anchorChecks = Array.isArray(payload.anchorChecks) ? payload.anchorChecks : [];
      const anchorTable =
        anchorChecks.length > 0
          ? [
              '| 锚 | 预设 | 当日证据 | 判定 |',
              '|---|---|---|---|',
              ...anchorChecks.map(
                (r) =>
                  `| ${String(r.anchor || '').replaceAll('|', '｜')} | ${String(r.preset || '').replaceAll('|', '｜')} | ${String(r.evidence || '待核').replaceAll('|', '｜')} | **${String(r.verdict || '未判定')}** |`
              ),
            ].join('\n')
          : '- 无上期预设跟踪锚需核对。';

      const credAdjusts = Array.isArray(payload.credibilityAdjustments)
        ? payload.credibilityAdjustments.filter((x) => x.cardId)
        : [];

      const credSectionLines =
        credAdjusts.length > 0
          ? credAdjusts.map((adj) => {
              const card = ws.methodology.cards.find((c) => c.id === adj.cardId);
              const oldScore = card?.credibilityScore ?? 0.5;
              const delta = Number(adj.delta || 0);
              const newScore = Math.max(0, Math.min(1, Number((oldScore + delta).toFixed(2))));
              const tag = delta > 0 ? `${oldScore}→${newScore}，+${delta}` : delta < 0 ? `${oldScore}→${newScore}，${delta}` : `${oldScore}维持`;
              return `- ${adj.cardId}（${tag}）：${(adj.reason || '按框架记录').trim()}`;
            })
          : ['- 本日无卡片可信度数值调整（全部高频卡维持现值）。'];

      const block = [
        '',
        '---',
        '',
        `<a id="${anchor}"></a>`,
        '',
        `## ${heading}`,
        '',
        '### 一、前置检查与数据口径',
        `- 交易日：${date}；数据来源与口径：${(payload.dataSource || '用户实盘取数').trim()}。`,
        payload.evidenceCutoff ? `- 证据冻结时点：${payload.evidenceCutoff}` : null,
        '',
        '### 二、隔夜美股与宏观事件（框架增订①）',
        (payload.macroNotes || '- 无重大宏观变量。').trim(),
        '',
        '### 三、指数与盘面事实',
        payload.marketFacts.trim(),
        '',
        '### 四、日内结构（框架增订②）',
        (payload.intradayStructure || '- 待补充分钟级分时结构与关键转折点。').trim(),
        '',
        '### 五、主跌段拆分：投机高标 vs 价值成长',
        (payload.dualLineSplit || '- 投机高标与价值成长两线独立管理，不互相强清。').trim(),
        '',
        '### 六、上期跟踪锚逐条回填',
        anchorTable,
        '',
        '### 七、卡片可信度调整（三处一致）',
        ...credSectionLines,
        '',
        '### 八、方法论失效 vs 应用错误',
        `- **方法论失效**：${(payload.methodFailure || '无').trim()}`,
        `- **应用错误**：${(payload.applicationError || '无新增').trim()}`,
        '',
        '### 九、行为金融检视（常设模块）',
        (payload.behavioralReview || '- 保持事实与叙事分离，防范锚定与近因偏差。').trim(),
        '',
        '### 十、评分与下一交易日观察（仅供研究，不构成投资建议）',
        `- **${date.slice(5)}盘面评分：${payload.score ?? '5.0'}/10**。${(payload.scoreReason || '').trim()}`,
        `- **市场状态**：${(payload.marketState || '待标注').trim()}`,
        `- **次日跟踪锚**：${(payload.nextAnchors || '① 待补充次日关键观察锚').trim()}`,
        '',
        `**缺口登记（更新）**：${(payload.gaps || '无新增数据缺口').trim()}`,
        '',
        `**优化建议（待拍板，不得擅自落库）**：①-⑧维持待拍板，未拍板规则不自动执行。`,
      ]
        .filter((x) => x !== null)
        .join('\n');

      // 如果有需要同步回写方法论卡片库的条目，原子联动修改方法论库
      let finalMVer = ws.methodology.meta.version;
      if (credAdjusts.length > 0 && payload.syncMethodology !== false) {
        const oldMVer = ws.methodology.meta.version;
        const newMVer = bumpMinorVersion(oldMVer);
        finalMVer = newMVer;

        const mLines = mOrig.split(/\r?\n/);
        // 为避免行号偏移，按卡片在文件中的 endLine 从后往前修改！
        const sortedAdjusts = [...credAdjusts]
          .map((adj) => ({ adj, card: ws.methodology.cards.find((c) => c.id === adj.cardId) }))
          .filter((x) => x.card)
          .sort((a, b) => b.card.endLine - a.card.endLine);

        const changedIds = [];
        for (const { adj, card } of sortedAdjusts) {
          const delta = Number(adj.delta || 0);
          const oldScore = card.credibilityScore ?? 0.5;
          const newScore = Math.max(0, Math.min(1, Number((oldScore + delta).toFixed(2))));
          const retireTag = newScore < 0.3 ? '【待淘汰】' : '';
          const modeLabel = delta > 0 ? `验证为真（${oldScore}→${newScore}）` : delta < 0 ? `证伪（${oldScore}→${newScore}）` : `维持（${oldScore}）`;

          if (delta !== 0) {
            for (let i = card.startLine - 1; i < card.endLine; i++) {
              if (/^- 可信度[：:]/.test(mLines[i])) {
                mLines[i] = `- 可信度：${newScore}${retireTag}（${date.slice(5)}复盘${delta > 0 ? `+${delta}` : delta}）`;
                break;
              }
            }
          }
          mLines.splice(card.endLine, 0, `- 复盘记录 ${date}：${modeLabel}——${(adj.reason || '见台账同日复盘').trim()}`);
          changedIds.push(card.id);
        }

        let mNext = mLines.join('\n');
        const mSummary = `${date.slice(5)}日度复盘联动回填（${changedIds.sort().join('/')} 共${changedIds.length}张追加复盘记录）`;
        mNext = updateMethodologyHeader(mNext, {
          oldVersion: oldMVer,
          newVersion: newMVer,
          date,
          summaryLine: mSummary,
          cogVersion: ws.cognition.meta.version,
          ledgerVersion: newLVer,
        });

        files.methodology = {
          path: PATHS.methodology,
          label: '方法论卡片库.md',
          before: mOrig,
          after: mNext,
          versionBefore: oldMVer,
          versionAfter: newMVer,
        };
        summaryBullets.push(`方法论卡片库 ${oldMVer} → ${newMVer}：联动回填 ${changedIds.length} 张卡片（三处一致）。`);
      }

      let lNext = appendTocRows(lOrig, [`| H2 | [${escapeTocTitle(heading)}](#${anchor}) | ${date} 日度复盘 | — |`]) + '\n' + block;
      const lSummary = `${date} 日度复盘入库（${payload.headline.trim()}，评分 ${payload.score ?? '5.0'}/10）`;
      lNext = updateLedgerHeader(lNext, {
        oldVersion: oldLVer,
        newVersion: newLVer,
        date,
        summaryLine: lSummary,
        latestDailyDate: date,
        methodVersion: finalMVer,
        cogVersion: ws.cognition.meta.version,
      });

      files.ledger = {
        path: PATHS.ledger,
        label: '研判与复盘台账.md',
        before: lOrig,
        after: lNext,
        versionBefore: oldLVer,
        versionAfter: newLVer,
      };
      summaryBullets.push(`研判与复盘台账 ${oldLVer} → ${newLVer}：新增 ${date} 日度复盘并同步目录。`);
    }
  }

  // =========================================================================
  // 11. 同步三库头部版本互挂声明（不改任何历史正文）
  // =========================================================================
  else if (action === 'maintenance.syncCompanionVersions') {
    const mVer = ws.methodology.meta.version;
    const cVer = ws.cognition.meta.version;
    const lVer = ws.ledger.meta.version;

    const curDirSlash = PATHS.currentDir.replace(/\\/g, '/');
    const mNext = mOrig.replace(
      /^> 配套现行文件：[^\n]+/m,
      `> 配套现行文件：[行业前沿认知库 ${cVer}](<${curDirSlash}/行业前沿认知库.md>)；[研判与复盘台账 ${lVer}](<${curDirSlash}/研判与复盘台账.md>)。历史记录中的版本、旧库映射和“已核验”字样按当时记录解释，不自动等于本轮重验通过。`
    );
    const cNext = cOrig.replace(
      /^> 配套现行文件：[^\n]+/m,
      `> 配套现行文件：[方法论卡片库 ${mVer}](<${curDirSlash}/方法论卡片库.md>)；[研判与复盘台账 ${lVer}](<${curDirSlash}/研判与复盘台账.md>)。文件版本不代表所有事实截至同步日仍然有效。`
    );
    const lNext = lOrig.replace(
      /^> 关联文件：[^\n]+/m,
      `> 关联文件：[方法论卡片库.md](<${curDirSlash}/方法论卡片库.md>) ${mVer}；[行业前沿认知库.md](<${curDirSlash}/行业前沿认知库.md>) ${cVer}（文档同步日期${date}；“卡片XXX”与“认知卡XXX”分别指对应库，局部明确标记的旧库引用除外）。历史正文的版本标记保留当时含义。`
    );

    if (mNext !== mOrig) {
      files.methodology = { path: PATHS.methodology, label: '方法论卡片库.md', before: mOrig, after: mNext, versionBefore: mVer, versionAfter: mVer };
    }
    if (cNext !== cOrig) {
      files.cognition = { path: PATHS.cognition, label: '行业前沿认知库.md', before: cOrig, after: cNext, versionBefore: cVer, versionAfter: cVer };
    }
    if (lNext !== lOrig) {
      files.ledger = { path: PATHS.ledger, label: '研判与复盘台账.md', before: lOrig, after: lNext, versionBefore: lVer, versionAfter: lVer };
    }

    if (Object.keys(files).length === 0) {
      summaryBullets.push('三库头部版本互挂已完全一致，无需修改。');
    } else {
      summaryBullets.push(`仅同步文件头关联版本声明至（方法论 ${mVer} / 认知库 ${cVer} / 台账 ${lVer}），历史正文零修改。`);
    }
  }

  // =========================================================================
  // 12. 撤销 / 删减方法论卡片（保留原子快照备份，支持蓝团子高权限删减）
  // =========================================================================
  else if (action === 'methodology.revokeCard') {
    const cid = pad3(String(payload.cardId || '').replace(/\D/g, ''));
    const card = ws.methodology.cards.find((c) => c.id === cid);
    if (!card) validationErrors.push(`未找到方法论卡片 ${cid}。`);
    const reason = String(payload.reason || '用户指令撤销/清理').trim();
    const hardDelete = Boolean(payload.hardDelete);

    if (validationErrors.length === 0) {
      const oldVer = ws.methodology.meta.version;
      const newVer = bumpMinorVersion(oldVer);
      const lines = mOrig.split(/\r?\n/);

      if (hardDelete) {
        let startIdx = card.startLine - 1;
        while (startIdx > 0 && (lines[startIdx - 1].trim() === '' || /^<a id="method-/.test(lines[startIdx - 1].trim()))) {
          startIdx -= 1;
        }
        lines.splice(startIdx, card.endLine - startIdx);
        // 同步清理 TOC 对应行
        const filtered = lines.filter((l) => !l.includes(`(#method-${cid})`));
        let mNext = filtered.join('\n').replace(/\n{3,}/g, '\n\n');
        mNext = updateMethodologyHeader(mNext, {
          oldVersion: oldVer,
          newVersion: newVer,
          date,
          summaryLine: `移除方法论卡片 ${cid}（${reason}）`,
          totalTitles: Math.max(0, ws.methodology.stats.totalTitles - 1),
          activeCount: Math.max(0, ws.methodology.stats.activeCount - (card.isRevoked ? 0 : 1)),
          conflictCount: ws.methodology.stats.conflictCount,
          cogVersion: ws.cognition.meta.version,
          ledgerVersion: ws.ledger.meta.version,
        });
        files.methodology = { path: PATHS.methodology, label: '方法论卡片库.md', before: mOrig, after: mNext, versionBefore: oldVer, versionAfter: newVer };
        summaryBullets.push(`方法论卡片库 ${oldVer} → ${newVer}：已移除卡片 ${cid}（${reason}，已留原子快照可随时回滚）。`);
      } else {
        if (!/已撤销/.test(lines[card.startLine - 1])) {
          lines[card.startLine - 1] = `${lines[card.startLine - 1]}【已撤销 ${date}】`;
        }
        lines.splice(card.endLine, 0, `- 撤销记录 ${date}：${reason}`);
        let mNext = lines.join('\n');
        mNext = updateMethodologyHeader(mNext, {
          oldVersion: oldVer,
          newVersion: newVer,
          date,
          summaryLine: `撤销方法论卡片 ${cid}（${reason}）`,
          activeCount: Math.max(0, ws.methodology.stats.activeCount - (card.isRevoked ? 0 : 1)),
          cogVersion: ws.cognition.meta.version,
          ledgerVersion: ws.ledger.meta.version,
        });
        files.methodology = { path: PATHS.methodology, label: '方法论卡片库.md', before: mOrig, after: mNext, versionBefore: oldVer, versionAfter: newVer };
        summaryBullets.push(`方法论卡片库 ${oldVer} → ${newVer}：已标记撤销卡片 ${cid}（保留历史编号不复用，原因：${reason}）。`);
      }
    }
  }

  // =========================================================================
  // 13. 删除 / 移除行业前沿认知卡（保留原子快照备份，支持蓝团子高权限删减）
  // =========================================================================
  else if (action === 'cognition.removeCard') {
    const cid = pad3(String(payload.cardId || '').replace(/\D/g, ''));
    const card = ws.cognition.cards.find((c) => c.id === cid);
    if (!card) validationErrors.push(`未找到认知卡 ${cid}。`);
    const reason = String(payload.reason || '用户指令清理/移出').trim();

    if (validationErrors.length === 0) {
      const oldVer = ws.cognition.meta.version;
      const newVer = bumpMinorVersion(oldVer);
      const lines = cOrig.split(/\r?\n/);
      let startIdx = card.startLine - 1;
      while (startIdx > 0 && (lines[startIdx - 1].trim() === '' || /^<a id="cognition-/.test(lines[startIdx - 1].trim()))) {
        startIdx -= 1;
      }
      lines.splice(startIdx, card.endLine - startIdx);
      const filtered = lines.filter((l) => !l.includes(`(#cognition-${cid})`));
      let cNext = filtered.join('\n').replace(/\n{3,}/g, '\n\n');
      cNext = updateCognitionHeader(cNext, {
        oldVersion: oldVer,
        newVersion: newVer,
        date,
        summaryLine: `移出认知卡 ${cid}（${reason}）`,
        totalCount: Math.max(0, ws.cognition.stats.totalCount - 1),
        methodVersion: ws.methodology.meta.version,
        ledgerVersion: ws.ledger.meta.version,
      });
      files.cognition = { path: PATHS.cognition, label: '行业前沿认知库.md', before: cOrig, after: cNext, versionBefore: oldVer, versionAfter: newVer };
      summaryBullets.push(`行业前沿认知库 ${oldVer} → ${newVer}：已移出认知卡 ${cid}（${reason}，已留原子快照可随时撤回）。`);
    }
  } else {
    validationErrors.push(`不支持的写库操作：${action}`);
  }

  const diffs = Object.entries(files).map(([key, f]) => ({
    key,
    label: f.label,
    versionBefore: f.versionBefore,
    versionAfter: f.versionAfter,
    diff: buildUnifiedDiff(f.before, f.after, f.label),
  }));

  return {
    ok: validationErrors.length === 0,
    action,
    date,
    validationErrors,
    summaryBullets,
    diffs,
    files,
  };
}

/**
 * 从变更计划中提取实际涉及的对象标识（库名 + 卡号/研判号/日期），供统一审计边界使用
 */
function extractMutationTargetIds(plan, entries) {
  const ids = new Set();
  if (Array.isArray(plan.targetIds)) {
    for (const id of plan.targetIds) {
      if (id) ids.add(String(id));
    }
  }
  const bullets = Array.isArray(plan.summaryBullets) ? plan.summaryBullets : [];
  for (const line of bullets) {
    for (const m of String(line).matchAll(/(?:卡片|认知卡|冲突|研判|#|快照)\s*([A-Za-z0-9_-]{1,32})/g)) {
      ids.add(m[0].trim());
    }
    for (const m of String(line).matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
      ids.add(m[1]);
    }
  }
  for (const [key, f] of entries) {
    ids.add(f?.label || key);
  }
  return [...ids];
}

/**
 * 执行写盘前原子备份，然后安全落盘（统一在业务写入边界落审计日志）
 */
function commitMutationPlan(plan, opts = {}) {
  if (!plan.ok) {
    throw new Error(`校验未通过：${plan.validationErrors.join('；')}`);
  }
  const entries = Object.entries(plan.files || {});
  if (entries.length === 0) {
    return { committed: false, message: '无文件变更', backupId: null, auditRecorded: false, auditError: null };
  }

  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
    String(now.getMilliseconds()).padStart(3, '0'),
  ].join('');
  const randHex = crypto.randomBytes(2).toString('hex');
  const backupId = `${stamp}_${randHex}_${plan.action.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const backupPath = path.join(PATHS.backupsDir, backupId);

  // 乐观锁冲突检查：避免双标签页或自动化写盘并发覆盖（Lost Update）
  if (!opts.skipConflictCheck) {
    for (const [, f] of entries) {
      if (f.existedBefore === false && fs.existsSync(f.path)) {
        const conflictErr = new Error(`写入冲突：新建文件「${f.label}」在预览后已存在，请刷新后重新预览确认。`);
        conflictErr.statusCode = 409;
        throw conflictErr;
      }
      if (f.existedBefore !== false && typeof f.before === 'string' && fs.existsSync(f.path)) {
        const diskNow = fs.readFileSync(f.path, 'utf8');
        if (sha256(diskNow) !== sha256(f.before)) {
          const conflictErr = new Error(`写入冲突：文件「${f.label}」在预览后已被其他操作修改，请刷新后重新预览确认。`);
          conflictErr.statusCode = 409;
          throw conflictErr;
        }
      }
    }
  }

  fs.mkdirSync(backupPath, { recursive: true });

  const manifest = {
    backupId,
    createdAt: now.toISOString(),
    action: plan.action,
    kbMode: plan.kbMode || PATHS.kbMode || 'v1',
    summary: plan.summaryBullets || [],
    files: [],
  };

  for (const [key, f] of entries) {
    // 1. 写入原件备份（兼容 v1 扁平文件名与 v2 子路径单卡安全扁平化文件名）
    const backupFileName =
      f.backupFileName ||
      (/[\\/]/.test(String(f.label || ''))
        ? String(f.label).replace(/[\\/]+/g, '__')
        : f.label);
    const bakFile = path.join(backupPath, backupFileName);
    if (f.existedBefore !== false) {
      fs.writeFileSync(bakFile, f.before, 'utf8');
    }
    manifest.files.push({
      key,
      label: f.label,
      backupFileName,
      existedBefore: f.existedBefore !== false,
      deleteAfter: Boolean(f.deleteAfter),
      targetPath: f.path,
      relToProject: path.relative(PATHS.projectRoot, f.path).replace(/\\/g, '/'),
      sha256Before: sha256(f.before),
      sha256After: sha256(f.after),
      versionBefore: f.versionBefore,
      versionAfter: f.versionAfter,
    });
  }
  fs.writeFileSync(path.join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // 2. 原子写回三库（先写唯一随机 .tmp 再 rename 覆盖，遇 Windows 文件占用短退避重试，中途失败立即回滚）
  const renameWithRetry = (src, dest) => {
    let lastErr = null;
    for (let i = 0; i < 4; i++) {
      try {
        fs.renameSync(src, dest);
        return;
      } catch (e) {
        lastErr = e;
        if (e && (e.code === 'EPERM' || e.code === 'EBUSY') && i < 3) {
          const until = Date.now() + 20 * (i + 1);
          while (Date.now() < until) { /* wait */ }
          continue;
        }
        break;
      }
    }
    throw lastErr;
  };
  const written = [];
  try {
    for (const [, f] of entries) {
      if (f.deleteAfter === true) {
        if (fs.existsSync(f.path)) {
          fs.unlinkSync(f.path);
        }
        written.push(f);
      } else {
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        const tmpPath = `${f.path}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(tmpPath, f.after, 'utf8');
        renameWithRetry(tmpPath, f.path);
        written.push(f);
      }
    }
  } catch (err) {
    for (let i = written.length - 1; i >= 0; i--) {
      const f = written[i];
      try {
        if (f.existedBefore === false) {
          if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        } else {
          fs.mkdirSync(path.dirname(f.path), { recursive: true });
          const tmpPath = `${f.path}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.rollback.tmp`;
          fs.writeFileSync(tmpPath, f.before, 'utf8');
          renameWithRetry(tmpPath, f.path);
        }
      } catch {
        // best effort rollback
      }
    }
    throw err;
  }

  // 2b. KB v2 写后自动 15ms 增量同步 SQLite 并按需刷新活视图成员表
  let kbSync = null;
  let kbSyncError = null;
  const touchesKb =
    plan.kbMode === 'v2' ||
    PATHS.kbMode === 'v2' ||
    entries.some(([, f]) => isPathInsideDir(PATHS.kbDir, f.path));
  if (touchesKb && fs.existsSync(path.join(PATHS.kbDir, 'kb.manifest.yaml'))) {
    try {
      kbSync = syncKbToSqlite(PATHS.kbDir, { forceRebuild: false, refreshTopics: true });
    } catch (syncErr) {
      kbSyncError = syncErr?.message || String(syncErr);
    }
  }

  // 自动滚动清理超出配额的历史快照（保留最近 50 份，避免长期挂机磁盘膨胀）
  try {
    const allDirs = fs
      .readdirSync(PATHS.backupsDir)
      .filter((d) => fs.existsSync(path.join(PATHS.backupsDir, d, 'manifest.json')))
      .sort();
    if (allDirs.length > 50) {
      for (const oldDir of allDirs.slice(0, allDirs.length - 50)) {
        try {
          fs.rmSync(path.join(PATHS.backupsDir, oldDir), { recursive: true, force: true });
        } catch {
          // non-fatal
        }
      }
    }
  } catch {
    // non-fatal
  }

  // 3. 共享写入边界审计落档（绝不因审计异常抛出 500 掩盖已落盘事实，显式返回状态）
  let auditRecorded = false;
  let auditError = null;
  if (!opts.skipAudit) {
    const category =
      opts.category || (String(plan.action || '').startsWith('restore_') ? 'backup_restore' : 'library_mutation');
    const summaryText =
      (Array.isArray(plan.summaryBullets) && plan.summaryBullets.length > 0
        ? plan.summaryBullets.join('；')
        : `写入三库变更 (${plan.action})`) || '';
    const targetIds = Array.isArray(opts.targetIds) && opts.targetIds.length > 0
      ? opts.targetIds
      : extractMutationTargetIds(plan, entries);
    const aud = safeAppendAuditLog({
      category,
      action: String(plan.action || 'mutate.commit'),
      summary: summaryText,
      targetIds,
      backupId,
      actor: opts.actor || 'local_user',
    });
    auditRecorded = aud.ok;
    auditError = aud.error;
  }

  return {
    committed: true,
    backupId,
    manifest,
    auditRecorded,
    ...(kbSync ? { kbSync } : {}),
    ...(kbSyncError ? { kbSyncError } : {}),
    ...(auditError ? { auditError } : {}),
  };
}

/**
 * 列出所有历史快照备份
 */
function listBackups() {
  if (!fs.existsSync(PATHS.backupsDir)) return [];
  return fs
    .readdirSync(PATHS.backupsDir)
    .map((dir) => {
      const mPath = path.join(PATHS.backupsDir, dir, 'manifest.json');
      if (!fs.existsSync(mPath)) return null;
      try {
        return JSON.parse(fs.readFileSync(mPath, 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * 一键回滚指定快照备份（兼容三库 Markdown 与 ZIP 还原前状态快照，失败自动回滚）
 */
function restoreBackup(backupId, opts = {}) {
  if (!backupId || /[\\/]/.test(backupId)) throw new Error('非法的备份 ID');
  const backupPath = path.join(PATHS.backupsDir, backupId);
  const mPath = path.join(backupPath, 'manifest.json');
  if (!fs.existsSync(mPath)) throw new Error(`未找到备份：${backupId}`);

  const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  const safeCurrentRoot = path.resolve(PATHS.currentDir);
  const safeKbRoot = path.resolve(PATHS.kbDir);
  const safeStateRoot = path.resolve(PATHS.stateDir);
  const clampInside = (baseDir, candidatePath, fallbackFileName) => {
    const baseResolved = path.resolve(baseDir);
    const safeName = path.basename(String(fallbackFileName || ''));
    const defaultTarget = path.join(baseResolved, safeName);
    if (!candidatePath) return defaultTarget;
    const resolved = path.resolve(candidatePath);
    const rel = path.relative(baseResolved, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      // 便携目录迁移后拒绝旧绝对路径越界，自动映射回当前激活工作空间内对应文件
      return defaultTarget;
    }
    return resolved;
  };
  const resolveKbTarget = (item) => {
    const relRaw = String(item.relToProject || item.label || '').replace(/\\/g, '/');
    if (relRaw.startsWith('kb/')) {
      const subRel = relRaw.slice(3);
      const resolved = path.resolve(safeKbRoot, subRel);
      if (isPathInsideDir(safeKbRoot, resolved)) return resolved;
    }
    if (item.targetPath && isPathInsideDir(safeKbRoot, item.targetPath)) {
      return path.resolve(item.targetPath);
    }
    return null;
  };
  const files = {};
  let touchesKb = false;
  for (const item of manifest.files || []) {
    const label = item.label || item.fileName;
    const bakFileName = item.backupFileName || label;
    if (!bakFileName || /[\\/]/.test(bakFileName)) continue;

    const relNorm = String(item.relToProject || label || '').replace(/\\/g, '/');
    const isKbFile =
      relNorm.startsWith('kb/') || (item.targetPath && isPathInsideDir(safeKbRoot, item.targetPath));

    let targetPath = null;
    if (isKbFile) {
      targetPath = resolveKbTarget(item);
      if (!targetPath) continue;
      touchesKb = true;
    } else {
      targetPath = clampInside(safeCurrentRoot, item.targetPath, label);
    }

    const key =
      item.key ||
      (label === '方法论卡片库.md'
        ? 'methodology'
        : label === '行业前沿认知库.md'
        ? 'cognition'
        : label === '研判与复盘台账.md'
        ? 'ledger'
        : `md_${bakFileName}`);

    if (item.existedBefore === false) {
      if (!fs.existsSync(targetPath)) continue;
      const curContent = fs.readFileSync(targetPath, 'utf8');
      files[key] = {
        path: targetPath,
        label,
        backupFileName: bakFileName,
        existedBefore: true,
        deleteAfter: true,
        before: curContent,
        after: '',
        versionBefore: item.versionAfter || 'current',
        versionAfter: 'removed_on_restore',
      };
      continue;
    }

    const bakFile = path.join(backupPath, bakFileName);
    if (!fs.existsSync(bakFile)) continue;
    const bakContent = fs.readFileSync(bakFile, 'utf8');
    const existedNow = fs.existsSync(targetPath);
    const curContent = existedNow ? fs.readFileSync(targetPath, 'utf8') : '';
    files[key] = {
      path: targetPath,
      label,
      backupFileName: bakFileName,
      existedBefore: existedNow,
      deleteAfter: false,
      before: curContent,
      after: bakContent,
      versionBefore: item.versionAfter || 'current',
      versionAfter: item.versionBefore || 'restored',
    };
  }

  // 若快照含研究状态文件（如 pre-zip-restore-*），先校验并准备可回滚的状态恢复队列（绝不覆盖审计日志）
  // 支持 existed: false 记录：导入前原工作空间不存在的工作空间级状态文件（如 watchlist.local.json），恢复快照时一并清理并纳入回滚
  const stateSnapDir = path.join(backupPath, 'state');
  const stateRestores = [];
  for (const st of manifest.stateFiles || []) {
    const label = st.label;
    if (!label || label === 'audit-trail.local.jsonl' || /[\\/]/.test(label)) continue;
    const targetPath = clampInside(safeStateRoot, st.targetPath, label);
    const existedNow = fs.existsSync(targetPath);
    if (st.existed === false) {
      stateRestores.push({
        label,
        src: null,
        targetPath,
        shouldDelete: true,
        existed: existedNow,
        prevBuf: existedNow ? fs.readFileSync(targetPath) : null,
      });
      continue;
    }
    const src = path.join(stateSnapDir, label);
    if (!fs.existsSync(src)) continue;
    stateRestores.push({
      label,
      src,
      targetPath,
      shouldDelete: false,
      existed: existedNow,
      prevBuf: existedNow ? fs.readFileSync(targetPath) : null,
    });
  }

  const mdLabels = Object.values(files).map((f) => f.label);
  const stLabels = stateRestores.map((s) => s.label);
  if (mdLabels.length === 0 && stLabels.length === 0) {
    throw new Error(`快照 ${backupId} 不包含可恢复的档案文件`);
  }

  let mdRes = { committed: false, backupId: null, manifest: null, auditRecorded: false, auditError: null };
  if (mdLabels.length > 0) {
    const restorePlan = {
      ok: true,
      kbMode: touchesKb ? 'v2' : undefined,
      action: `restore_${backupId.slice(0, 20)}`,
      date: todayISO(),
      validationErrors: [],
      summaryBullets: [
        `从快照 ${backupId} 恢复 ${mdLabels.join('、')}${stLabels.length ? ` 及 ${stLabels.length} 份研究状态` : ''}`,
      ],
      files,
    };
    mdRes = commitMutationPlan(restorePlan, {
      category: 'backup_restore',
      actor: opts.actor || 'local_user',
      targetIds: [backupId, ...mdLabels, ...stLabels],
    });
  }

  // 恢复关联状态文件（如发生异常立即回滚状态文件及刚写入的三库 Markdown）
  const touchedStates = [];
  try {
    for (const item of stateRestores) {
      if (item.shouldDelete) {
        if (fs.existsSync(item.targetPath)) {
          fs.unlinkSync(item.targetPath);
        }
        touchedStates.push(item);
      } else {
        const nextBuf = fs.readFileSync(item.src);
        const tmpPath = `${item.targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.restore.tmp`;
        fs.writeFileSync(tmpPath, nextBuf);
        fs.renameSync(tmpPath, item.targetPath);
        touchedStates.push(item);
      }
    }
  } catch (err) {
    for (let i = touchedStates.length - 1; i >= 0; i--) {
      const item = touchedStates[i];
      try {
        if (item.existed && item.prevBuf) fs.writeFileSync(item.targetPath, item.prevBuf);
        else if (!item.existed && fs.existsSync(item.targetPath)) fs.unlinkSync(item.targetPath);
      } catch {
        // best effort
      }
    }
    for (const f of Object.values(files)) {
      try {
        fs.writeFileSync(f.path, f.before, 'utf8');
      } catch {
        // best effort
      }
    }
    throw new Error(`快照状态恢复失败，已完整回滚：${err.message}`);
  }

  if (mdLabels.length === 0 && stLabels.length > 0) {
    const aud = safeAppendAuditLog({
      category: 'backup_restore',
      action: `restore_${backupId.slice(0, 20)}`,
      summary: `从快照 ${backupId} 恢复 ${stLabels.length} 份研究状态文件`,
      targetIds: [backupId, ...stLabels],
      backupId,
      actor: opts.actor || 'local_user',
    });
    mdRes = {
      committed: true,
      backupId,
      manifest,
      auditRecorded: aud.ok,
      ...(aud.error ? { auditError: aud.error } : {}),
    };
  }

  return {
    ...mdRes,
    restoredMarkdown: mdLabels,
    restoredState: stLabels,
  };
}

module.exports = {
  buildMutationPlan,
  commitMutationPlan,
  listBackups,
  restoreBackup,
};
