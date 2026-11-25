'use strict';

/**
 * KB v2 单卡原子写库变更计划器
 *
 * 在 PATHS.kbMode === 'v2' 时接管所有卡片与冲突变更：
 * - 新增/增订/修订/撤销/删除方法论卡、认知卡、冲突卡均精准落在单个 cards/<kind>/<ID>.md 文件上；
 * - 复盘可信度调整与日度复盘联动直接向 events/review-log.jsonl 追加结构化事件，告别重写 599KB 大文件；
 * - 台账研判与日度复盘正文继续安全写入 现行三库/研判与复盘台账.md；
 * - 完整支持 batch.commitOperations 多步内存虚拟串联 + 精准单卡 Diff 预览 + 乐观锁 baseHashes + 原子快照回滚。
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter, stringifyFrontmatter, parseYamlLines } = require('./kb-yaml.cjs');
const { extractEntities, inferMethodTaxonomy, inferCognitionTopicsAndNodes } = require('./kb-taxonomy.cjs');
const { extractRefs, parseReviewVerdict } = require('./kb-migrator.cjs');
const { extractBodySection } = require('./kb-sqlite.cjs');

function pad3(n) {
  return String(Number(n)).padStart(3, '0');
}

function pad2(n) {
  return String(Number(n)).padStart(2, '0');
}

function addDaysISO(isoDate, days) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function makeBackupFileName(relLabel) {
  return String(relLabel || 'file')
    .replace(/[\\/]+/g, '__')
    .replace(/[^a-zA-Z0-9_\-.\u4e00-\u9fa5]/g, '_');
}

function makeFileKey(prefix, relPath) {
  return `${prefix}_${String(relPath || '')
    .replace(/[\\/]+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * 在 Markdown 正文的指定 H2 节末尾追加一行 bullet（若节不存在则在末尾 HTML 注释前创建新节）
 */
function appendBulletToSection(body, sectionHeading, bulletLine) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const secIdx = lines.findIndex((l) => l.trim() === sectionHeading.trim());
  if (secIdx !== -1) {
    let insertIdx = lines.length;
    for (let i = secIdx + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i]) || /^<!--/.test(lines[i].trim())) {
        insertIdx = i;
        break;
      }
    }
    while (insertIdx > secIdx + 1 && lines[insertIdx - 1].trim() === '') {
      insertIdx--;
    }
    lines.splice(insertIdx, 0, bulletLine);
    return lines.join('\n').trim();
  }

  // 若尚无该节，则在末尾 <!-- ... --> 注释前插入
  let commentIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue;
    if (/^<!--[\s\S]*-->$/.test(lines[i].trim())) {
      commentIdx = i;
    }
    break;
  }
  const block = `${sectionHeading}\n${bulletLine}`;
  if (commentIdx !== -1) {
    const before = lines.slice(0, commentIdx).join('\n').trimEnd();
    const after = lines.slice(commentIdx).join('\n').trim();
    return `${before}\n\n${block}\n\n${after}`.trim();
  }
  const base = lines.join('\n').trimEnd();
  return base ? `${base}\n\n${block}` : block;
}

/**
 * 合并现有关系边与新提取的跨卡引用边（不覆盖手工关系、不重复、不自引）
 */
function mergeRelations(existing, selfId, refs, kind) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out.map((r) => `${r.type}|${r.target}`));
  const add = (type, target, note) => {
    if (!target || target === selfId) return;
    const k = `${type}|${target}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ type, target, note });
  };
  for (const cf of refs.conflictIds || []) {
    add('conflicts_with', `CF:${pad2(cf)}`, '关联冲突矩阵');
  }
  for (const mid of refs.methodIds || []) {
    const target = `M:${mid}`;
    if (target !== selfId) add(kind === 'cognition' ? 'uses_method' : 'related_to', target, '关联方法论卡片');
  }
  for (const cid of refs.cognitionIds || []) {
    const target = `C:${cid}`;
    if (target !== selfId) add('related_to', target, '关联认知卡');
  }
  return out;
}

function readVirtualOrDisk(absPath, virtualFiles) {
  const norm = path.resolve(absPath);
  if (virtualFiles && virtualFiles.has(norm)) {
    const val = virtualFiles.get(norm);
    return { exists: val !== null, content: val === null ? '' : val };
  }
  if (fs.existsSync(norm)) {
    return { exists: true, content: fs.readFileSync(norm, 'utf8') };
  }
  return { exists: false, content: '' };
}

function listCardNums(dir, prefixRegex, virtualFiles) {
  const nums = new Set();
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(prefixRegex);
      if (m) {
        const abs = path.resolve(path.join(dir, f));
        if (virtualFiles && virtualFiles.has(abs) && virtualFiles.get(abs) === null) continue;
        nums.add(Number(m[1]));
      }
    }
  }
  if (virtualFiles) {
    const normDir = path.resolve(dir).toLowerCase();
    for (const [abs, val] of virtualFiles.entries()) {
      if (val === null) continue;
      if (path.resolve(path.dirname(abs)).toLowerCase() === normDir) {
        const m = path.basename(abs).match(prefixRegex);
        if (m) nums.add(Number(m[1]));
      }
    }
  }
  return nums;
}

function readReservedMissing(kbDir) {
  const regPath = path.join(kbDir, 'meta', 'registry.yaml');
  if (!fs.existsSync(regPath)) return [];
  try {
    const reg = parseYamlLines(fs.readFileSync(regPath, 'utf8'));
    const list = reg?.methodology?.reserved_missing;
    return Array.isArray(list) ? list.map((x) => pad3(x)) : [];
  } catch {
    return [];
  }
}

function ensureLedgerText(ledgerPath, virtualFiles, date) {
  const state = readVirtualOrDisk(ledgerPath, virtualFiles);
  if (state.exists) return { existedBefore: true, content: state.content };
  const blank = [
    '# 研判与复盘台账',
    '',
    `> 版本：v1.0（${date} 初始台账）。`,
    `> 同步日期：${date}；基线：v1.0，最新日度正文为-。`,
    '> 关联文件：[方法论卡片库.md](方法论卡片库.md) v2.0；[行业前沿认知库.md](行业前沿认知库.md) v2.0。',
    '',
    '## 完整目录',
    '',
    '| 层级 | 正文标题 | 状态／用途 | 原件行 |',
    '|---|---|---|---:|',
    '',
    '---',
    '',
    '# 一、标的研判与验证台账',
    '',
    '---',
    '',
    '# 二、每日 A 股复盘台账',
    '',
  ].join('\n');
  return { existedBefore: false, content: blank };
}

function buildReviewEventLine({ existingJsonl, date, cardId, delta, oldScore, newScore, reason, regime }) {
  const existingLines = String(existingJsonl || '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const dateCompact = String(date || '00000000').replace(/-/g, '');
  const idClean = String(cardId || '').replace(':', '');
  const prefix = `RV-${dateCompact}-${idClean}-`;
  let seq = 1;
  for (const l of existingLines) {
    if (l.includes(prefix)) seq++;
  }
  const modeLabel =
    delta > 0
      ? `验证为真（${oldScore}→${newScore}，+${delta}）`
      : delta < 0
      ? `证伪（${oldScore}→${newScore}，${delta}）`
      : `维持现值（${oldScore}）`;
  const rawLine = `- 复盘记录 ${date}：${modeLabel}——${reason}`;
  const parsed = parseReviewVerdict(`${modeLabel} ${reason}`);
  const verdict =
    delta > 0 ? 'confirmed' : delta < 0 ? 'falsified' : parsed.verdict || 'hold_boundary';

  const eventObj = {
    event_id: `${prefix}${String(seq).padStart(2, '0')}`,
    date,
    card_id: cardId,
    ledger_ref: `DAILY:${date}`,
    evidence_chain_id: date ? `EC-${date.slice(0, 7)}-DAILY` : 'EC-UNDATED',
    regime: regime || 'all',
    verdict,
    legacy_delta: delta,
    legacy_score_after: newScore,
    raw_label: `复盘记录 ${date}`,
    note: `${modeLabel}——${reason}`,
    raw_line: rawLine,
  };
  const nextJsonl = existingLines.length > 0 ? `${existingLines.join('\n')}\n${JSON.stringify(eventObj)}\n` : `${JSON.stringify(eventObj)}\n`;
  return { eventObj, modeLabel, nextJsonl };
}

/**
 * 解析传统方法论单卡 Markdown（## 卡片 NNN | ...）更新现有 v2 Frontmatter + Body
 */
function applyLegacyMethodRawEdit(existingFm, existingBody, rawMarkdown, date) {
  const lines = String(rawMarkdown || '').replace(/\r\n/g, '\n').trimEnd().split('\n');
  const heading = lines[0] || existingFm.legacy_meta?.raw_heading || `## 卡片 ${pad3(existingFm.num)} | ${existingFm.title}`;
  const cardMatch = heading.match(/^## 卡片 (\d{3})\s*\|(.*)$/);
  const rawTitlePart = cardMatch ? cardMatch[2].trim() : existingFm.title;
  const titleNoTag = rawTitlePart.replace(/【[^】]+】/g, '').trim();

  const sections = {
    coreThesis: '',
    logicChain: '',
    applicableConditions: '',
    invalidationSignals: '',
    historicalCases: '',
    credibilityRaw: existingFm.legacy_credibility?.raw || '',
    source: '',
    amendments: [],
    extraFields: [],
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('- ')) continue;
    const body = line.slice(2);
    const colonIdx = body.search(/[：:]/);
    if (colonIdx === -1) {
      sections.extraFields.push({ label: '说明', content: body });
      continue;
    }
    const key = body.slice(0, colonIdx).replace(/^\*\*|\*\*$/g, '').trim();
    const val = body.slice(colonIdx + 1).trim();
    if (key === '核心论断') sections.coreThesis = val;
    else if (key === '逻辑链条') sections.logicChain = val;
    else if (key === '适用条件') sections.applicableConditions = val;
    else if (key === '失效信号') sections.invalidationSignals = val;
    else if (key === '历史案例') sections.historicalCases = val;
    else if (key === '可信度') sections.credibilityRaw = val;
    else if (key === '来源') sections.source = val;
    else if (/^复盘(?:记录|日志)|^【复盘记录/.test(key)) {
      // 复盘流水独立存储于 events/review-log.jsonl，不重复写回正文
      continue;
    } else if (/增订|修订|补充/.test(key)) {
      sections.amendments.push({ label: key, content: val });
    } else {
      sections.extraFields.push({ label: key, content: val });
    }
  }

  const scoreM = sections.credibilityRaw.match(/(\d+(?:\.\d+)?)/);
  const nextScore = scoreM ? parseFloat(scoreM[1]) : existingFm.legacy_credibility?.score ?? null;
  const nextFm = {
    ...existingFm,
    title: titleNoTag || existingFm.title,
    updated_at: date,
    legacy_credibility: {
      ...(existingFm.legacy_credibility || {}),
      score: nextScore,
      raw: sections.credibilityRaw,
    },
    sources_raw: sections.source || existingFm.sources_raw || '',
    legacy_meta: {
      ...(existingFm.legacy_meta || {}),
      raw_heading: heading,
    },
  };

  const bodyParts = [];
  if (sections.coreThesis) bodyParts.push(`## 核心论断\n${sections.coreThesis}`);
  if (sections.logicChain) bodyParts.push(`## 逻辑链条\n${sections.logicChain}`);
  if (sections.applicableConditions) bodyParts.push(`## 适用条件\n${sections.applicableConditions}`);
  if (sections.invalidationSignals) bodyParts.push(`## 失效信号\n${sections.invalidationSignals}`);
  if (sections.historicalCases) bodyParts.push(`## 历史案例\n${sections.historicalCases}`);
  if (sections.source) bodyParts.push(`## 来源\n${sections.source}`);
  if (sections.amendments.length > 0) {
    bodyParts.push(`## 增订记录\n${sections.amendments.map((a) => `- **${a.label}**：${a.content}`).join('\n')}`);
  }
  if (sections.extraFields.length > 0) {
    bodyParts.push(`## 附注与补充字段\n${sections.extraFields.map((e) => `- **${e.label}**：${e.content}`).join('\n')}`);
  }
  const trailingComment = String(existingBody || '').match(/<!-- 已剥离[^\n]*-->/);
  if (trailingComment) bodyParts.push(trailingComment[0]);

  return stringifyFrontmatter(nextFm, bodyParts.join('\n\n'));
}

/**
 * 解析传统认知卡 Markdown（## 认知卡 NNN | ...）更新现有 v2 Frontmatter + Body
 */
function applyLegacyCognitionRawEdit(existingFm, rawMarkdown, date) {
  const lines = String(rawMarkdown || '').replace(/\r\n/g, '\n').trimEnd().split('\n');
  const heading = lines[0] || existingFm.legacy_meta?.raw_heading || `## 认知卡 ${pad3(existingFm.num)} | ${existingFm.title}`;
  const cardMatch = heading.match(/^## 认知卡 (\d{3})\s*\|(.*)$/);
  const rawRest = cardMatch ? cardMatch[2].trim() : existingFm.title;
  const title = rawRest
    .replace(/【[^】]+】/g, '')
    .replace(/（(?:第[^）]+增补|[^）]*增补[^）]*)）/g, '')
    .trim();

  const sections = {
    facts: [],
    source: '',
    evidenceLevelRaw: existingFm.legacy_grade || '',
    industryImplications: '',
    aShareMapping: '',
    confidence: existingFm.confidence_raw || '',
    invalidationConditions: '',
    updateLog: '',
    relatedLines: [],
    amendments: [],
    extraFields: [],
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('- ')) continue;
    const body = line.slice(2);
    const colonIdx = body.search(/[：:]/);
    if (colonIdx === -1) {
      sections.extraFields.push({ label: '说明', content: body });
      continue;
    }
    const key = body.slice(0, colonIdx).replace(/^\*\*|\*\*$/g, '').trim();
    const val = body.slice(colonIdx + 1).trim();
    if (/^(?:核心)?事实/.test(key)) sections.facts.push({ label: key, content: val });
    else if (key === '来源') sections.source = val;
    else if (key === '证据等级') sections.evidenceLevelRaw = val;
    else if (/^产业含义/.test(key)) sections.industryImplications = val;
    else if (/^A\s*股映射/.test(key)) sections.aShareMapping = val;
    else if (key === '置信度') sections.confidence = val;
    else if (/失效|更新条件|证伪条件/.test(key)) sections.invalidationConditions = val;
    else if (key === '更新日志') sections.updateLog = val;
    else if (/^关联/.test(key)) sections.relatedLines.push({ label: key, content: val });
    else if (/增订|更新|补充|校准|复核/.test(key)) sections.amendments.push({ label: key, content: val });
    else sections.extraFields.push({ label: key, content: val });
  }

  const evidenceGrades = [];
  if (/(?:^|[^A-Za-z])A[+\-]?(?:$|[^A-Za-z])/.test(sections.evidenceLevelRaw)) evidenceGrades.push('A');
  if (/(?:^|[^A-Za-z])B[+\-]?(?:$|[^A-Za-z])/.test(sections.evidenceLevelRaw)) evidenceGrades.push('B');
  if (/(?:^|[^A-Za-z])C[+\-]?(?:$|[^A-Za-z])/.test(sections.evidenceLevelRaw)) evidenceGrades.push('C');

  const nextFm = {
    ...existingFm,
    title: title || existingFm.title,
    updated_at: date,
    evidence_grades: evidenceGrades.length > 0 ? evidenceGrades : existingFm.evidence_grades || ['C'],
    primary_grade: evidenceGrades[0] || existingFm.primary_grade || 'C',
    legacy_grade: sections.evidenceLevelRaw,
    confidence_raw: sections.confidence,
    sources_raw: sections.source || existingFm.sources_raw || '',
    legacy_meta: {
      ...(existingFm.legacy_meta || {}),
      raw_heading: heading,
    },
  };

  const bodyParts = [];
  if (sections.facts.length === 1) {
    bodyParts.push(`## 事实与要点（原件无损迁入）\n${sections.facts[0].content}`);
  } else if (sections.facts.length > 1) {
    bodyParts.push(`## 事实与要点（原件无损迁入）\n${sections.facts.map((f) => `- **${f.label}**：${f.content}`).join('\n')}`);
  }
  if (sections.source) bodyParts.push(`## 来源\n${sections.source}`);
  if (sections.industryImplications) bodyParts.push(`## 产业含义（分析）\n${sections.industryImplications}`);
  if (sections.aShareMapping) bodyParts.push(`## A股映射（分析）\n${sections.aShareMapping}`);
  if (sections.invalidationConditions) bodyParts.push(`## 失效与更新条件\n${sections.invalidationConditions}`);
  if (sections.relatedLines.length > 0) {
    bodyParts.push(`## 原文关联说明\n${sections.relatedLines.map((r) => `- **${r.label}**：${r.content}`).join('\n')}`);
  }
  if (sections.amendments.length > 0) {
    bodyParts.push(`## 增订与校准记录\n${sections.amendments.map((a) => `- **${a.label}**：${a.content}`).join('\n')}`);
  }
  if (sections.updateLog) bodyParts.push(`## 原卡更新日志\n${sections.updateLog}`);
  if (sections.extraFields.length > 0) {
    bodyParts.push(`## 附注与补充字段\n${sections.extraFields.map((e) => `- **${e.label}**：${e.content}`).join('\n')}`);
  }

  return stringifyFrontmatter(nextFm, bodyParts.join('\n\n'));
}

/**
 * 构建 KB v2 单卡变更计划
 */
function buildKbV2MutationPlan(action, payload = {}, helpers = {}) {
  const {
    kbDir,
    paths,
    virtualFiles = null,
    todayISO,
    buildUnifiedDiff,
    bumpMinorVersion,
    appendTocRows,
    updateLedgerHeader,
    escapeTocTitle,
    parseLedger,
  } = helpers;

  const date = payload.date || todayISO();
  const methodDir = path.join(kbDir, 'cards', 'methodology');
  const cogDir = path.join(kbDir, 'cards', 'cognition');
  const confDir = path.join(kbDir, 'cards', 'conflicts');
  const reviewLogPath = path.join(kbDir, 'events', 'review-log.jsonl');

  // =========================================================================
  // 0. 批量合并事务（虚拟文件系统串联，单次 Diff 预览 + 单次原子快照落盘）
  // =========================================================================
  if (action === 'batch.commitOperations') {
    const ops = Array.isArray(payload.operations) ? payload.operations : [];
    if (ops.length === 0) {
      return {
        ok: false,
        kbMode: 'v2',
        action,
        date,
        validationErrors: ['请至少勾选 1 条待入库操作。'],
        summaryBullets: [],
        diffs: [],
        files: {},
      };
    }

    const vfs = new Map(virtualFiles ? [...virtualFiles.entries()] : []);
    const mergedByPath = new Map();
    const allSummary = [];
    const allErrors = [];

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || !op.action || op.action === 'batch.commitOperations') continue;
      const subPlan = buildKbV2MutationPlan(op.action, { ...(op.payload || {}), date }, {
        ...helpers,
        virtualFiles: vfs,
      });
      if (!subPlan.ok) {
        allErrors.push(`第 ${i + 1} 项 (${op.action}) 失败：${subPlan.validationErrors.join('；')}`);
        continue;
      }
      for (const [k, f] of Object.entries(subPlan.files || {})) {
        const norm = path.resolve(f.path);
        vfs.set(norm, f.deleteAfter ? null : f.after);
        if (!mergedByPath.has(norm)) {
          mergedByPath.set(norm, { key: k, entry: { ...f } });
        } else {
          const prev = mergedByPath.get(norm).entry;
          prev.after = f.after;
          prev.deleteAfter = Boolean(f.deleteAfter);
          prev.versionAfter = f.versionAfter;
        }
      }
      allSummary.push(...(subPlan.summaryBullets || []));
    }

    const batchFiles = {};
    for (const { key, entry } of mergedByPath.values()) {
      if (!entry.deleteAfter && entry.existedBefore !== false && entry.before === entry.after) continue;
      batchFiles[key] = entry;
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
      kbMode: 'v2',
      action,
      date,
      validationErrors:
        allErrors.length > 0 ? allErrors : Object.keys(batchFiles).length === 0 ? ['无有效文件变更'] : [],
      summaryBullets: [`批量合并提交共 ${ops.length} 项操作（KB v2 单卡级原子快照）：`, ...allSummary.slice(0, 18)],
      diffs,
      files: batchFiles,
    };
  }

  const files = {};
  const summaryBullets = [];
  const validationErrors = [];
  const targetIds = [];

  const registerFile = (key, absPath, relLabel, { existedBefore, before, after, versionBefore, versionAfter, deleteAfter = false }) => {
    files[key] = {
      path: absPath,
      label: relLabel,
      backupFileName: makeBackupFileName(relLabel),
      existedBefore,
      deleteAfter,
      before,
      after,
      versionBefore,
      versionAfter,
    };
  };

  // =========================================================================
  // 1. 新增方法论卡片（单文件 kb/cards/methodology/M-NNN.md）
  // =========================================================================
  if (action === 'methodology.createCard') {
    const existingNums = listCardNums(methodDir, /^M-(\d{3})\.md$/, virtualFiles);
    const reservedSet = new Set(readReservedMissing(kbDir).map((x) => Number(x)));
    const maxNum = existingNums.size > 0 ? Math.max(...existingNums) : 0;
    let nextNum = maxNum + 1;
    while (existingNums.has(nextNum) || reservedSet.has(nextNum)) nextNum++;
    const id = pad3(nextNum);

    if (!payload.system?.trim() || !payload.topic?.trim()) validationErrors.push('请填写体系名与主题名。');
    if (!payload.coreThesis?.trim()) validationErrors.push('核心论断必填。');
    if (!payload.invalidationSignals?.trim()) validationErrors.push('失效信号必填（契约铁律：写不出可证伪性不得入库）。');
    if (!payload.source?.trim()) validationErrors.push('来源必填。');

    if (validationErrors.length === 0) {
      const batchNote = payload.batchNote?.trim() || '日常维护批次';
      const cred = Number.isFinite(Number(payload.credibility)) ? Number(payload.credibility) : 0.5;
      const system = payload.system.trim();
      const topic = payload.topic.trim();
      const headingTitle = `## 卡片 ${id} | ${system}（${topic}）【${date} 入库，${batchNote}】`;
      const sectionTitle = payload.newSectionTitle?.trim() || payload.sectionTitle?.trim() || '第一编 未分编';

      const cardDraft = {
        title: `${system}（${topic}）`,
        system,
        sectionTitle,
        coreThesis: payload.coreThesis.trim(),
        applicableConditions: (payload.applicableConditions || '待补充具体适用条件').trim(),
        isRevoked: false,
        reviewLogsCount: 0,
      };
      const inferredTax = inferMethodTaxonomy(cardDraft);
      const textForExtract = `${cardDraft.title} ${payload.coreThesis} ${payload.logicChain || ''} ${payload.historicalCases || ''} ${payload.source || ''}`;
      const entities =
        Array.isArray(payload.tickers) && payload.tickers.length > 0
          ? payload.tickers
          : extractEntities(textForExtract);
      const refs = extractRefs(textForExtract);
      const relations = mergeRelations(
        Array.isArray(payload.relations) ? payload.relations : [],
        `M:${id}`,
        refs,
        'methodology'
      );

      const fm = {
        id: `M:${id}`,
        num: nextNum,
        title: cardDraft.title,
        card_kind: payload.cardKind || inferredTax.card_kind,
        status: 'active',
        created_at: date,
        updated_at: date,
        domains: Array.isArray(payload.domains) && payload.domains.length > 0 ? payload.domains : inferredTax.domains,
        regimes: Array.isArray(payload.regimes) && payload.regimes.length > 0 ? payload.regimes : inferredTax.regimes,
        horizons: Array.isArray(payload.horizons) && payload.horizons.length > 0 ? payload.horizons : inferredTax.horizons,
        asset_classes:
          Array.isArray(payload.assetClasses) && payload.assetClasses.length > 0
            ? payload.assetClasses
            : inferredTax.asset_classes,
        tickers: entities,
        legacy_credibility: {
          score: cred,
          raw: `${cred}`,
          high_paused: false,
          archived_flag: false,
        },
        epistemic: {
          verification_tier: 'unverified',
          review_event_count: 0,
          independent_chains: 0,
          backtest_status: 'not_run',
          pending_verify: false,
        },
        relations,
        sources_raw: payload.source.trim(),
        legacy_meta: {
          raw_heading: headingTitle,
          system,
          batch_tag: `【${date} 入库，${batchNote}】`,
          original_section: sectionTitle,
          section_order: 1,
          order_in_source: nextNum,
          anchor_id: `method-${id}`,
          source_start_line: 1,
          source_end_line: 1,
          legacy_alias: null,
          enrichment_status: 'v2_native',
        },
      };

      const bodyParts = [
        `## 核心论断\n${payload.coreThesis.trim()}`,
        payload.logicChain?.trim() ? `## 逻辑链条\n${payload.logicChain.trim()}` : null,
        `## 适用条件\n${(payload.applicableConditions || '待补充具体适用条件').trim()}`,
        `## 失效信号\n${payload.invalidationSignals.trim()}`,
        `## 历史案例\n${(payload.historicalCases || '待实盘验证补充').trim()}`,
        `## 来源\n${payload.source.trim()}`,
      ].filter(Boolean);

      const relLabel = `kb/cards/methodology/M-${id}.md`;
      const absPath = path.join(methodDir, `M-${id}.md`);
      const after = stringifyFrontmatter(fm, bodyParts.join('\n\n'));
      registerFile(makeFileKey('kb_method', id), absPath, relLabel, {
        existedBefore: false,
        before: '',
        after,
        versionBefore: 'new',
        versionAfter: date,
      });
      targetIds.push(`M:${id}`, `卡片 ${id}`);
      summaryBullets.push(`KB v2 单卡新建：新增方法论卡 M:${id}（${topic}）→ ${relLabel}，写后自动 15ms 同步 SQLite。`);
    }
  }

  // =========================================================================
  // 2. 方法论卡片追加增订（仅修改单卡 M-NNN.md）
  // =========================================================================
  else if (action === 'methodology.appendAmendment') {
    const id = pad3(String(payload.cardId || '').replace(/\D/g, ''));
    const absPath = path.join(methodDir, `M-${id}.md`);
    const fileState = readVirtualOrDisk(absPath, virtualFiles);
    if (!fileState.exists) validationErrors.push(`未找到方法论卡片 M:${id}（${id}）。`);
    if (!payload.content?.trim()) validationErrors.push('增订内容不能为空。');

    if (validationErrors.length === 0) {
      const { frontmatter: fm, body } = parseFrontmatter(fileState.content);
      const oldUpdated = fm.updated_at || fm.created_at || 'v2';
      const batchNote = payload.batchNote?.trim() || '日常增订';
      const amendLine = `- **${date} 增订（${batchNote}）**：${payload.content.trim()}`;
      fm.updated_at = date;
      const newRefs = extractRefs(payload.content);
      fm.relations = mergeRelations(fm.relations, `M:${id}`, newRefs, 'methodology');
      const nextBody = appendBulletToSection(body, '## 增订记录', amendLine);
      const after = stringifyFrontmatter(fm, nextBody);
      const relLabel = `kb/cards/methodology/M-${id}.md`;
      registerFile(makeFileKey('kb_method', id), absPath, relLabel, {
        existedBefore: true,
        before: fileState.content,
        after,
        versionBefore: oldUpdated,
        versionAfter: date,
      });
      targetIds.push(`M:${id}`, `卡片 ${id}`);
      summaryBullets.push(`KB v2 单卡增订：在 ${relLabel} 追加增订记录（保留原字段不覆盖）。`);
    }
  }

  // =========================================================================
  // 3. 方法论卡片可信度复盘调整（单卡 M-NNN.md + 追加 events/review-log.jsonl）
  // =========================================================================
  else if (action === 'methodology.adjustCredibility') {
    const id = pad3(String(payload.cardId || '').replace(/\D/g, ''));
    const absPath = path.join(methodDir, `M-${id}.md`);
    const fileState = readVirtualOrDisk(absPath, virtualFiles);
    if (!fileState.exists) validationErrors.push(`未找到方法论卡片 M:${id}（${id}）。`);
    if (!payload.reason?.trim()) validationErrors.push('必须填写复盘验证依据或维持说明。');

    if (validationErrors.length === 0) {
      const { frontmatter: fm, body } = parseFrontmatter(fileState.content);
      const oldUpdated = fm.updated_at || fm.created_at || 'v2';
      const delta = Number(payload.delta || 0);
      const oldScore = typeof fm.legacy_credibility?.score === 'number' ? fm.legacy_credibility.score : 0.5;
      const newScore = Math.max(0, Math.min(1, Number((oldScore + delta).toFixed(2))));
      const retireTag = newScore < 0.3 ? '【待淘汰】' : '';

      const logState = readVirtualOrDisk(reviewLogPath, virtualFiles);
      const { modeLabel, nextJsonl } = buildReviewEventLine({
        existingJsonl: logState.content,
        date,
        cardId: `M:${id}`,
        delta,
        oldScore,
        newScore,
        reason: payload.reason.trim(),
        regime: Array.isArray(fm.regimes) && fm.regimes[0] ? fm.regimes[0] : 'all',
      });

      fm.updated_at = date;
      if (delta !== 0) {
        const shortNote = payload.shortNote?.trim() || `${date}复盘${delta > 0 ? `+${delta}` : delta}`;
        fm.legacy_credibility = {
          ...(fm.legacy_credibility || {}),
          score: newScore,
          raw: `${newScore}${retireTag}（${shortNote}）`,
        };
      }
      if (newScore < 0.3) fm.status = 'pending_retire';
      const nextCount = Number(fm.epistemic?.review_event_count || 0) + 1;
      fm.epistemic = {
        ...(fm.epistemic || {}),
        review_event_count: nextCount,
        verification_tier: nextCount >= 3 ? 'live_multi_chain' : 'single_sample',
      };

      const afterCard = stringifyFrontmatter(fm, body);
      const relCard = `kb/cards/methodology/M-${id}.md`;
      registerFile(makeFileKey('kb_method', id), absPath, relCard, {
        existedBefore: true,
        before: fileState.content,
        after: afterCard,
        versionBefore: oldUpdated,
        versionAfter: date,
      });

      registerFile('kb_review_log', reviewLogPath, 'kb/events/review-log.jsonl', {
        existedBefore: logState.exists,
        before: logState.content,
        after: nextJsonl,
        versionBefore: 'jsonl',
        versionAfter: date,
      });

      targetIds.push(`M:${id}`, `卡片 ${id}`);
      summaryBullets.push(`KB v2 单卡复盘回填：M:${id} ${modeLabel}，并 O(1) 追加至 kb/events/review-log.jsonl。`);
      if (newScore < 0.3) {
        summaryBullets.push(`⚠️ 卡片 M:${id} 可信度降至 ${newScore} (<0.3)，已标记 pending_retire（待淘汰）。`);
      }
    }
  }

  // =========================================================================
  // 4. 方法论卡片高级原文局部编辑（兼容 YAML Frontmatter 原文与旧版 ## 卡片 NNN）
  // =========================================================================
  else if (action === 'methodology.editCardRaw') {
    const id = pad3(String(payload.cardId || '').replace(/\D/g, ''));
    const absPath = path.join(methodDir, `M-${id}.md`);
    const fileState = readVirtualOrDisk(absPath, virtualFiles);
    if (!fileState.exists) validationErrors.push(`未找到方法论卡片 M:${id}（${id}）。`);
    const raw = String(payload.rawMarkdown || '').trim();
    if (!raw) validationErrors.push('正文不能为空。');
    else if (!raw.startsWith('---') && !raw.startsWith(`## 卡片 ${id}`)) {
      validationErrors.push(`必须保留 YAML Frontmatter 或「## 卡片 ${id}」标题前缀以维持编号锚点。`);
    }

    if (validationErrors.length === 0) {
      const { frontmatter: oldFm, body: oldBody } = parseFrontmatter(fileState.content);
      let after = '';
      if (raw.startsWith('---')) {
        const parsedNew = parseFrontmatter(raw);
        parsedNew.frontmatter.id = `M:${id}`;
        parsedNew.frontmatter.num = Number(id);
        parsedNew.frontmatter.updated_at = date;
        after = stringifyFrontmatter(parsedNew.frontmatter, parsedNew.body);
      } else {
        after = applyLegacyMethodRawEdit(oldFm, oldBody, raw, date);
      }
      const relLabel = `kb/cards/methodology/M-${id}.md`;
      registerFile(makeFileKey('kb_method', id), absPath, relLabel, {
        existedBefore: true,
        before: fileState.content,
        after,
        versionBefore: oldFm.updated_at || 'v2',
        versionAfter: date,
      });
      targetIds.push(`M:${id}`, `卡片 ${id}`);
      summaryBullets.push(`KB v2 单卡修订：定向更新 ${relLabel}（${payload.summary?.trim() || '修订正文'}）。`);
    }
  }

  // =========================================================================
  // 5. 新增冲突矩阵条目（单文件 kb/cards/conflicts/CF-NN.md）
  // =========================================================================
  else if (action === 'methodology.createConflict') {
    if (!payload.title?.trim() || !payload.sides?.trim() || !payload.conflictPoint?.trim() || !payload.resolution?.trim()) {
      validationErrors.push('冲突标题、双方观点、冲突点、折中思路/判别变量均为必填。');
    }

    if (validationErrors.length === 0) {
      const existingNums = listCardNums(confDir, /^CF-(\d{2,3})\.md$/, virtualFiles);
      const nextNum = existingNums.size > 0 ? Math.max(...existingNums) + 1 : 1;
      const cfId = `CF:${pad2(nextNum)}`;
      const fileSlug = `CF-${pad2(nextNum)}.md`;
      const headingText = `## 冲突 ${nextNum}（v2 新增，${date}）：${payload.title.trim()}`;
      const refs = extractRefs(`${payload.sides} ${payload.conflictPoint} ${payload.resolution}`);
      const relations = [];
      for (const mid of refs.methodIds) {
        relations.push({ type: 'conflicts_with', target: `M:${mid}`, note: '冲突涉及方法论卡' });
      }
      for (const cid of refs.cognitionIds) {
        relations.push({ type: 'conflicts_with', target: `C:${cid}`, note: '冲突涉及认知卡' });
      }

      const fm = {
        id: cfId,
        num: nextNum,
        title: payload.title.trim(),
        card_kind: 'conflict',
        status: 'open',
        created_at: date,
        version_tag: `v2 新增，${date}`,
        relations,
        legacy_meta: {
          raw_heading: headingText,
          anchor_id: `conflict-${nextNum}`,
          source_start_line: 1,
          source_end_line: 1,
          enrichment_status: 'v2_native',
        },
      };
      const body = [
        `## 冲突双方\n${payload.sides.trim()}`,
        `## 冲突点\n${payload.conflictPoint.trim()}`,
        `## 折中思路与判别变量\n${payload.resolution.trim()}`,
      ].join('\n\n');

      const relLabel = `kb/cards/conflicts/${fileSlug}`;
      const absPath = path.join(confDir, fileSlug);
      registerFile(makeFileKey('kb_conflict', pad2(nextNum)), absPath, relLabel, {
        existedBefore: false,
        before: '',
        after: stringifyFrontmatter(fm, body),
        versionBefore: 'new',
        versionAfter: date,
      });
      targetIds.push(cfId, `冲突 ${nextNum}`);
      summaryBullets.push(`KB v2 单卡新建：新增冲突矩阵 ${cfId}（${payload.title.trim()}）→ ${relLabel}。`);
    }
  }

  // =========================================================================
  // 6. 新增行业前沿认知卡（单文件 kb/cards/cognition/C-NNN.md）
  // =========================================================================
  else if (action === 'cognition.createCard') {
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
      const existingNums = listCardNums(cogDir, /^C-(\d{3})\.md$/, virtualFiles);
      const nextNum = existingNums.size > 0 ? Math.max(...existingNums) + 1 : 1;
      const id = pad3(nextNum);
      const catTag = payload.categoryTag?.trim() ? `（${payload.categoryTag.trim()}）` : '';
      const rawHeading = `## 认知卡 ${id} | ${date} 入库 | ${payload.title.trim()}${catTag}`;
      const batchTitle = payload.newBatchTitle?.trim() || payload.batchName?.trim() || '第一编 日常维护批次';

      const evRaw = payload.evidenceLevel.trim();
      const evidenceGrades = [];
      if (/(?:^|[^A-Za-z])A[+\-]?(?:$|[^A-Za-z])/.test(evRaw)) evidenceGrades.push('A');
      if (/(?:^|[^A-Za-z])B[+\-]?(?:$|[^A-Za-z])/.test(evRaw)) evidenceGrades.push('B');
      if (/(?:^|[^A-Za-z])C[+\-]?(?:$|[^A-Za-z])/.test(evRaw)) evidenceGrades.push('C');
      const primaryGrade = evidenceGrades[0] || 'C';

      const inferred = inferCognitionTopicsAndNodes({
        title: payload.title.trim(),
        categoryTag: payload.categoryTag?.trim() || '',
        batchTitle,
        facts: payload.facts.trim(),
        industryImplications: payload.industryImplications || '',
        evidenceLevelRaw: evRaw,
        evidenceGrades,
      });

      const claimType = payload.claimType || inferred.claim_type;
      const ttlDays = claimType === 'event_calendar' ? 7 : primaryGrade === 'A' && claimType === 'fact' ? 180 : 90;
      const validUntil = payload.validUntil || addDaysISO(date, ttlDays);
      const nextCheckDate = payload.nextCheckDate || addDaysISO(date, Math.min(60, ttlDays));

      const relText = [
        payload.relatedMethodIds?.trim() ? `关联方法论卡片：${payload.relatedMethodIds.trim()}` : '',
        payload.relatedCognitionIds?.trim() ? `关联认知卡：${payload.relatedCognitionIds.trim()}` : '',
      ]
        .filter(Boolean)
        .join('；');

      const allText = `${payload.title} ${payload.facts} ${payload.industryImplications || ''} ${payload.aShareMapping || ''} ${relText}`;
      const refs = extractRefs(allText);
      const relations = mergeRelations(
        Array.isArray(payload.relations) ? payload.relations : [],
        `C:${id}`,
        refs,
        'cognition'
      );
      const entities =
        Array.isArray(payload.tickers) && payload.tickers.length > 0 ? payload.tickers : extractEntities(allText);

      const fm = {
        id: `C:${id}`,
        num: nextNum,
        title: payload.title.trim(),
        claim_type: claimType,
        status: 'active',
        event_date: date,
        publish_date: date,
        ingested_at: date,
        updated_at: date,
        valid_until: validUntil,
        next_check_date: nextCheckDate,
        evidence_grades: evidenceGrades.length > 0 ? evidenceGrades : ['C'],
        primary_grade: primaryGrade,
        legacy_grade: evRaw,
        confidence_raw: (payload.confidence || '中').trim(),
        topics: Array.isArray(payload.topics) && payload.topics.length > 0 ? payload.topics : inferred.topics,
        chain_nodes:
          Array.isArray(payload.chainNodes) && payload.chainNodes.length > 0 ? payload.chainNodes : inferred.chain_nodes,
        tickers: entities,
        relations,
        sources_raw: payload.source.trim(),
        legacy_meta: {
          raw_heading: rawHeading,
          original_batch: batchTitle,
          batch_order: 1,
          original_category_tag: payload.categoryTag?.trim() || '',
          order_in_source: nextNum,
          anchor_id: `cognition-${id}`,
          source_start_line: 1,
          source_end_line: 1,
          enrichment_status: 'v2_native',
        },
      };

      const bodyParts = [
        `## 事实与要点（原件无损迁入）\n${payload.facts.trim()}`,
        `## 来源\n${payload.source.trim()}`,
        `## 产业含义（分析）\n${(payload.industryImplications || '待补充产业含义分析').trim()}`,
        `## A股映射（分析）\n${(payload.aShareMapping || '待补充 A 股映射分析').trim()}`,
        `## 失效与更新条件\n${payload.invalidationConditions.trim()}`,
        relText ? `## 原文关联说明\n- **关联**：${relText}` : null,
        `## 原卡更新日志\n${date} 正式入库（${payload.batchName?.trim() || '日常维护批次'}）。`,
      ].filter(Boolean);

      const relLabel = `kb/cards/cognition/C-${id}.md`;
      const absPath = path.join(cogDir, `C-${id}.md`);
      registerFile(makeFileKey('kb_cognition', id), absPath, relLabel, {
        existedBefore: false,
        before: '',
        after: stringifyFrontmatter(fm, bodyParts.join('\n\n')),
        versionBefore: 'new',
        versionAfter: date,
      });
      targetIds.push(`C:${id}`, `认知卡 ${id}`);
      summaryBullets.push(`KB v2 单卡新建：新增认知卡 C:${id}（${payload.title.trim()}）→ ${relLabel}，写后自动刷新活视图与 SQLite。`);
    }
  }

  // =========================================================================
  // 7. 认知卡追加增订或状态标记（仅修改单卡 C-NNN.md）
  // =========================================================================
  else if (action === 'cognition.appendAmendment' || action === 'cognition.markStatus') {
    const id = pad3(String(payload.cardId || '').replace(/\D/g, ''));
    const absPath = path.join(cogDir, `C-${id}.md`);
    const fileState = readVirtualOrDisk(absPath, virtualFiles);
    if (!fileState.exists) validationErrors.push(`未找到认知卡 C:${id}（${id}）。`);
    if (action === 'cognition.appendAmendment' && !payload.content?.trim()) {
      validationErrors.push('增订内容不能为空。');
    }
    if (action === 'cognition.markStatus' && !payload.statusType) {
      validationErrors.push('请选择状态标记类型。');
    }

    if (validationErrors.length === 0) {
      const { frontmatter: fm, body } = parseFrontmatter(fileState.content);
      const oldUpdated = fm.updated_at || fm.ingested_at || 'v2';
      fm.updated_at = date;
      let nextBody = body;
      let summaryLine = '';

      if (action === 'cognition.appendAmendment') {
        const note = payload.batchNote?.trim() || '跨源互证增订';
        nextBody = appendBulletToSection(body, '## 增订与校准记录', `- **${date} 增订（${note}）**：${payload.content.trim()}`);
        fm.relations = mergeRelations(fm.relations, `C:${id}`, extractRefs(payload.content), 'cognition');
        summaryLine = `增订认知卡 C:${id}（${note}，不覆盖原数据）`;
      } else {
        let badge = '';
        if (payload.statusType === 'updated' && payload.targetCardId) {
          const targetId = pad3(payload.targetCardId);
          badge = `【已更新→卡号${targetId}】`;
          fm.status = 'superseded';
          fm.relations = Array.isArray(fm.relations) ? [...fm.relations] : [];
          if (!fm.relations.some((r) => r.type === 'superseded_by' && r.target === `C:${targetId}`)) {
            fm.relations.push({ type: 'superseded_by', target: `C:${targetId}`, note: payload.statusDetail?.trim() || '已更新替代' });
          }
        } else if (payload.statusType === 'falsified') {
          badge = `【⚠️部分证伪 ${date}：${(payload.statusDetail || '待补充依据').trim()}】`;
          fm.status = 'partially_falsified';
        } else if (payload.statusType === 'archived') {
          badge = `【${date} 整卡归档】`;
          fm.status = 'archived';
        } else if (payload.statusType === 'extend' || payload.statusType === 'active') {
          fm.status = 'active';
          fm.valid_until = payload.validUntil || addDaysISO(date, 90);
          fm.next_check_date = payload.nextCheckDate || addDaysISO(date, 60);
          badge = `【${date} 复核延期至 ${fm.valid_until}】`;
        }
        if (badge) {
          fm.legacy_meta = {
            ...(fm.legacy_meta || {}),
            raw_heading: `${fm.legacy_meta?.raw_heading || `## 认知卡 ${id} | ${fm.title}`}${badge}`,
          };
          if (payload.statusDetail?.trim()) {
            nextBody = appendBulletToSection(
              body,
              '## 增订与校准记录',
              `- **${date} 状态更新**：${badge} ${payload.statusDetail.trim()}`
            );
          }
        }
        summaryLine = `更新认知卡 C:${id} 状态标记为 ${badge || fm.status}`;
      }

      const relLabel = `kb/cards/cognition/C-${id}.md`;
      registerFile(makeFileKey('kb_cognition', id), absPath, relLabel, {
        existedBefore: true,
        before: fileState.content,
        after: stringifyFrontmatter(fm, nextBody),
        versionBefore: oldUpdated,
        versionAfter: date,
      });
      targetIds.push(`C:${id}`, `认知卡 ${id}`);
      summaryBullets.push(`KB v2 单卡更新：${summaryLine}（${relLabel}）。`);
    }
  }

  // =========================================================================
  // 8. 认知卡高级原文编辑
  // =========================================================================
  else if (action === 'cognition.editCardRaw') {
    const id = pad3(String(payload.cardId || '').replace(/\D/g, ''));
    const absPath = path.join(cogDir, `C-${id}.md`);
    const fileState = readVirtualOrDisk(absPath, virtualFiles);
    if (!fileState.exists) validationErrors.push(`未找到认知卡 C:${id}（${id}）。`);
    const raw = String(payload.rawMarkdown || '').trim();
    if (!raw) validationErrors.push('正文不能为空。');
    else if (!raw.startsWith('---') && !raw.startsWith(`## 认知卡 ${id}`)) {
      validationErrors.push(`必须保留 YAML Frontmatter 或「## 认知卡 ${id}」标题前缀。`);
    }

    if (validationErrors.length === 0) {
      const { frontmatter: oldFm } = parseFrontmatter(fileState.content);
      let after = '';
      if (raw.startsWith('---')) {
        const parsedNew = parseFrontmatter(raw);
        parsedNew.frontmatter.id = `C:${id}`;
        parsedNew.frontmatter.num = Number(id);
        parsedNew.frontmatter.updated_at = date;
        after = stringifyFrontmatter(parsedNew.frontmatter, parsedNew.body);
      } else {
        after = applyLegacyCognitionRawEdit(oldFm, raw, date);
      }
      const relLabel = `kb/cards/cognition/C-${id}.md`;
      registerFile(makeFileKey('kb_cognition', id), absPath, relLabel, {
        existedBefore: true,
        before: fileState.content,
        after,
        versionBefore: oldFm.updated_at || 'v2',
        versionAfter: date,
      });
      targetIds.push(`C:${id}`, `认知卡 ${id}`);
      summaryBullets.push(`KB v2 单卡修订：定向更新 ${relLabel}（${payload.summary?.trim() || '修订正文'}）。`);
    }
  }

  // =========================================================================
  // 9. 台账新增标的研判记录（继续写 现行三库/研判与复盘台账.md）
  // =========================================================================
  else if (action === 'ledger.createJudgment') {
    const ledgerState = ensureLedgerText(paths.ledger, virtualFiles, date);
    const parsedLedger = parseLedger(ledgerState.content);
    const recordKey = payload.recordKey?.trim() || parsedLedger.stats.nextJudgmentKey;
    if (!payload.target?.trim()) validationErrors.push('请填写标的名称与代码。');
    if (!payload.conclusion?.trim()) validationErrors.push('请填写一句话综合结论。');
    const validHyps = (payload.hypotheses || []).filter((h) => h.claim?.trim());
    if (validHyps.length === 0) validationErrors.push('至少填写 1 条可证伪的关键假设（含验证方式/时点/证伪条件）。');

    if (validationErrors.length === 0) {
      const oldVer = parsedLedger.meta.version;
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

      let lNext = appendTocRows(ledgerState.content, [`| H2 | [${escapeTocTitle(heading)}](#${anchor}) | ${date} 新增标的研判 | — |`]) + '\n' + block;
      const summaryLine = `新增标的研判 ${recordKey}（${payload.target.trim()}，评分 ${payload.score ?? '待定'}/10）`;
      lNext = updateLedgerHeader(lNext, {
        oldVersion: oldVer,
        newVersion: newVer,
        date,
        summaryLine,
        latestDailyDate: parsedLedger.stats.latestDailyDate,
      });

      registerFile('ledger', paths.ledger, '研判与复盘台账.md', {
        existedBefore: ledgerState.existedBefore,
        before: ledgerState.existedBefore ? ledgerState.content : '',
        after: lNext,
        versionBefore: oldVer,
        versionAfter: newVer,
      });
      targetIds.push(`研判 ${recordKey}`);
      summaryBullets.push(`研判与复盘台账 ${oldVer} → ${newVer}：新增 ${heading}，含 ${validHyps.length} 条可证伪假设。`);
    }
  }

  // =========================================================================
  // 10. 台账新增每日 A 股复盘（台账写盘 + v2 单卡可信度与 review-log.jsonl 原子联动）
  // =========================================================================
  else if (action === 'ledger.createDailyReview') {
    const ledgerState = ensureLedgerText(paths.ledger, virtualFiles, date);
    const parsedLedger = parseLedger(ledgerState.content);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) validationErrors.push('请填写有效的复盘日期 YYYY-MM-DD。');
    if (parsedLedger.dailyReviews.some((d) => d.date === date)) {
      validationErrors.push(`台账中已存在 ${date} 的日度复盘记录，请勿重复创建。`);
    }
    if (!payload.headline?.trim()) validationErrors.push('请填写当日盘面一句话定性标题。');
    if (!payload.marketFacts?.trim()) validationErrors.push('请填写指数与盘面事实（含数据来源）。');

    if (validationErrors.length === 0) {
      const oldLVer = parsedLedger.meta.version;
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

      const credSectionLines = [];
      let workingJsonl = readVirtualOrDisk(reviewLogPath, virtualFiles);
      let jsonlAfter = workingJsonl.content;
      const linkedCards = [];

      for (const adj of credAdjusts) {
        const cid = pad3(String(adj.cardId).replace(/\D/g, ''));
        const cardPath = path.join(methodDir, `M-${cid}.md`);
        const cardState = readVirtualOrDisk(cardPath, virtualFiles);
        let oldScore = 0.5;
        let cardParsed = null;
        if (cardState.exists) {
          cardParsed = parseFrontmatter(cardState.content);
          if (typeof cardParsed.frontmatter.legacy_credibility?.score === 'number') {
            oldScore = cardParsed.frontmatter.legacy_credibility.score;
          }
        }
        const delta = Number(adj.delta || 0);
        const newScore = Math.max(0, Math.min(1, Number((oldScore + delta).toFixed(2))));
        const tag = delta > 0 ? `${oldScore}→${newScore}，+${delta}` : delta < 0 ? `${oldScore}→${newScore}，${delta}` : `${oldScore}维持`;
        credSectionLines.push(`- ${cid}（${tag}）：${(adj.reason || '按框架记录').trim()}`);

        if (payload.syncMethodology !== false && cardParsed) {
          const fm = cardParsed.frontmatter;
          const oldUpdated = fm.updated_at || fm.created_at || 'v2';
          const retireTag = newScore < 0.3 ? '【待淘汰】' : '';
          fm.updated_at = date;
          if (delta !== 0) {
            fm.legacy_credibility = {
              ...(fm.legacy_credibility || {}),
              score: newScore,
              raw: `${newScore}${retireTag}（${date.slice(5)}复盘${delta > 0 ? `+${delta}` : delta}）`,
            };
          }
          if (newScore < 0.3) fm.status = 'pending_retire';
          const nextCount = Number(fm.epistemic?.review_event_count || 0) + 1;
          fm.epistemic = {
            ...(fm.epistemic || {}),
            review_event_count: nextCount,
            verification_tier: nextCount >= 3 ? 'live_multi_chain' : 'single_sample',
          };

          const relCard = `kb/cards/methodology/M-${cid}.md`;
          registerFile(makeFileKey('kb_method', cid), cardPath, relCard, {
            existedBefore: true,
            before: cardState.content,
            after: stringifyFrontmatter(fm, cardParsed.body),
            versionBefore: oldUpdated,
            versionAfter: date,
          });

          const evRes = buildReviewEventLine({
            existingJsonl: jsonlAfter,
            date,
            cardId: `M:${cid}`,
            delta,
            oldScore,
            newScore,
            reason: (adj.reason || '见台账同日复盘').trim(),
            regime: Array.isArray(fm.regimes) && fm.regimes[0] ? fm.regimes[0] : 'all',
          });
          jsonlAfter = evRes.nextJsonl;
          linkedCards.push(`M:${cid}`);
        }
      }

      if (linkedCards.length > 0) {
        registerFile('kb_review_log', reviewLogPath, 'kb/events/review-log.jsonl', {
          existedBefore: workingJsonl.exists,
          before: workingJsonl.content,
          after: jsonlAfter,
          versionBefore: 'jsonl',
          versionAfter: date,
        });
        summaryBullets.push(`KB v2 单卡复盘联动：回填 ${linkedCards.join('/')} 共 ${linkedCards.length} 张单卡并追加 review-log.jsonl。`);
      }

      const finalCredLines =
        credSectionLines.length > 0
          ? credSectionLines
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
        ...finalCredLines,
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
        `**优化建议（待拍板，不得擅自落库）**：未拍板规则不自动执行。`,
      ]
        .filter((x) => x !== null)
        .join('\n');

      let lNext = appendTocRows(ledgerState.content, [`| H2 | [${escapeTocTitle(heading)}](#${anchor}) | ${date} 日度复盘 | — |`]) + '\n' + block;
      const lSummary = `${date} 日度复盘入库（${payload.headline.trim()}，评分 ${payload.score ?? '5.0'}/10）`;
      lNext = updateLedgerHeader(lNext, {
        oldVersion: oldLVer,
        newVersion: newLVer,
        date,
        summaryLine: lSummary,
        latestDailyDate: date,
      });

      registerFile('ledger', paths.ledger, '研判与复盘台账.md', {
        existedBefore: ledgerState.existedBefore,
        before: ledgerState.existedBefore ? ledgerState.content : '',
        after: lNext,
        versionBefore: oldLVer,
        versionAfter: newLVer,
      });
      targetIds.push(date, ...linkedCards);
      summaryBullets.push(`研判与复盘台账 ${oldLVer} → ${newLVer}：新增 ${date} 日度复盘并同步目录。`);
    }
  }

  // =========================================================================
  // 11. 同步三库头部版本互挂声明（KB v2 下自动无损跳过）
  // =========================================================================
  else if (action === 'maintenance.syncCompanionVersions') {
    summaryBullets.push('当前工作空间已处于 KB v2 单卡模式，无需同步传统三库单文件头部版本互挂。');
  }

  // =========================================================================
  // 12. 撤销 / 删除方法论卡片
  // =========================================================================
  else if (action === 'methodology.revokeCard') {
    const id = pad3(String(payload.cardId || '').replace(/\D/g, ''));
    const absPath = path.join(methodDir, `M-${id}.md`);
    const fileState = readVirtualOrDisk(absPath, virtualFiles);
    if (!fileState.exists) validationErrors.push(`未找到方法论卡片 M:${id}（${id}）。`);
    const reason = String(payload.reason || '用户指令撤销/清理').trim();
    const hardDelete = Boolean(payload.hardDelete);

    if (validationErrors.length === 0) {
      const { frontmatter: fm, body } = parseFrontmatter(fileState.content);
      const relLabel = `kb/cards/methodology/M-${id}.md`;
      if (hardDelete) {
        registerFile(makeFileKey('kb_method', id), absPath, relLabel, {
          existedBefore: true,
          deleteAfter: true,
          before: fileState.content,
          after: '',
          versionBefore: fm.updated_at || 'v2',
          versionAfter: 'deleted',
        });
        summaryBullets.push(`KB v2 单卡删除：移除 ${relLabel}（${reason}，已留原子快照可随时回滚）。`);
      } else {
        const oldUpdated = fm.updated_at || 'v2';
        fm.status = 'revoked';
        fm.card_kind = 'tombstone';
        fm.updated_at = date;
        if (fm.legacy_meta?.raw_heading && !/已撤销/.test(fm.legacy_meta.raw_heading)) {
          fm.legacy_meta.raw_heading = `${fm.legacy_meta.raw_heading}【已撤销 ${date}】`;
        }
        const nextBody = appendBulletToSection(body, '## 增订记录', `- **撤销记录 ${date}**：${reason}`);
        registerFile(makeFileKey('kb_method', id), absPath, relLabel, {
          existedBefore: true,
          before: fileState.content,
          after: stringifyFrontmatter(fm, nextBody),
          versionBefore: oldUpdated,
          versionAfter: date,
        });
        summaryBullets.push(`KB v2 单卡撤销：将 ${relLabel} 转为 tombstone（保留编号不复用，原因：${reason}）。`);
      }
      targetIds.push(`M:${id}`, `卡片 ${id}`);
    }
  }

  // =========================================================================
  // 13. 删除 / 移除行业前沿认知卡
  // =========================================================================
  else if (action === 'cognition.removeCard') {
    const id = pad3(String(payload.cardId || '').replace(/\D/g, ''));
    const absPath = path.join(cogDir, `C-${id}.md`);
    const fileState = readVirtualOrDisk(absPath, virtualFiles);
    if (!fileState.exists) validationErrors.push(`未找到认知卡 C:${id}（${id}）。`);
    const reason = String(payload.reason || '用户指令清理/移出').trim();

    if (validationErrors.length === 0) {
      const { frontmatter: fm } = parseFrontmatter(fileState.content);
      const relLabel = `kb/cards/cognition/C-${id}.md`;
      registerFile(makeFileKey('kb_cognition', id), absPath, relLabel, {
        existedBefore: true,
        deleteAfter: true,
        before: fileState.content,
        after: '',
        versionBefore: fm.updated_at || 'v2',
        versionAfter: 'deleted',
      });
      targetIds.push(`C:${id}`, `认知卡 ${id}`);
      summaryBullets.push(`KB v2 单卡移除：移出 ${relLabel}（${reason}，已留原子快照可随时撤回）。`);
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
    kbMode: 'v2',
    action,
    date,
    targetIds,
    validationErrors,
    summaryBullets,
    diffs,
    files,
  };
}

module.exports = {
  buildKbV2MutationPlan,
  appendBulletToSection,
};
