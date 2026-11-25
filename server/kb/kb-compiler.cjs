'use strict';

/**
 * 逆向单文件编译导出器（Snapshot Compiler）
 *
 * 将 v2 分卡目录（kb/）一键编译为只读合并版单文件 Markdown：
 * - exports/方法论卡片库.compiled.md
 * - exports/行业前沿认知库.compiled.md
 * 确保：
 * 1) 外部大模型（ChatGPT Projects / NotebookLM）可随时单文件投喂；
 * 2) 既有《三库工作台》legacy parser.cjs 与 auditor.cjs 可 100% 无报错解析并还原全部统计与可信度。
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter, parseYamlLines } = require('./kb-yaml.cjs');

function extractBodySection(body, headingRegex) {
  const lines = String(body || '').split(/\r?\n/);
  let capture = false;
  const out = [];
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (capture) break;
      if (headingRegex.test(line)) {
        capture = true;
        continue;
      }
    } else if (capture) {
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

function escapeTocTitle(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f));
}

function compileMonolithSnapshots(kbDir) {
  const legacyHeadersPath = path.join(kbDir, 'meta', 'legacy-headers.json');
  const legacyHeaders = fs.existsSync(legacyHeadersPath)
    ? JSON.parse(fs.readFileSync(legacyHeadersPath, 'utf8'))
    : {};

  const reviewEvents = readJsonl(path.join(kbDir, 'events', 'review-log.jsonl'));
  const reviewsByCard = new Map();
  for (const ev of reviewEvents) {
    if (!reviewsByCard.has(ev.card_id)) reviewsByCard.set(ev.card_id, []);
    reviewsByCard.get(ev.card_id).push(ev);
  }

  const ingestionLogs = readJsonl(path.join(kbDir, 'events', 'ingestion-log.jsonl'));
  const methodLogs = ingestionLogs.filter((l) => l.library === 'methodology');
  const cogLogs = ingestionLogs.filter((l) => l.library === 'cognition');

  // -------------------------------------------------------------------------
  // 1. 编译《方法论卡片库.compiled.md》
  // -------------------------------------------------------------------------
  const methodCards = listMd(path.join(kbDir, 'cards', 'methodology')).map((f) => {
    const parsed = parseFrontmatter(fs.readFileSync(f, 'utf8'));
    return { ...parsed, file: f };
  });
  methodCards.sort(
    (a, b) =>
      (a.frontmatter.legacy_meta?.order_in_source || a.frontmatter.num || 0) -
      (b.frontmatter.legacy_meta?.order_in_source || b.frontmatter.num || 0)
  );

  const conflictCards = listMd(path.join(kbDir, 'cards', 'conflicts')).map((f) => {
    const parsed = parseFrontmatter(fs.readFileSync(f, 'utf8'));
    return { ...parsed, file: f };
  });
  conflictCards.sort((a, b) => Number(a.frontmatter.num || 0) - Number(b.frontmatter.num || 0));

  const mTocRows = [];
  const mBodyLines = [];
  const sectionsMeta = legacyHeaders.methodologySections || [];
  const sectionAnchorMap = new Map(sectionsMeta.map((s) => [s.title, s.anchor]));

  const emittedSections = new Set();
  const conflictSectionTitle =
    legacyHeaders.conflictSectionTitle ||
    sectionsMeta.find((s) => /冲突/.test(s.title))?.title ||
    '冲突解决矩阵';
  const conflictSectionAnchor =
    legacyHeaders.conflictSectionAnchor || sectionAnchorMap.get(conflictSectionTitle) || 'sec-conflict';
  let conflictsEmitted = false;

  const emitConflictsBlock = () => {
    if (conflictsEmitted || conflictCards.length === 0) return;
    conflictsEmitted = true;
    mTocRows.push(`| H1 | [${escapeTocTitle(conflictSectionTitle)}](#${conflictSectionAnchor}) | 冲突矩阵 | — |`);
    mBodyLines.push('', `<a id="${conflictSectionAnchor}"></a>`, '', `# ${conflictSectionTitle}`, '');
    for (const cf of conflictCards) {
      const fm = cf.frontmatter;
      const anchor = fm.legacy_meta?.anchor_id || `conflict-${fm.num}`;
      const heading = fm.legacy_meta?.raw_heading || `## 冲突 ${fm.num}：${fm.title}`;
      mTocRows.push(`| H2 | [${escapeTocTitle(heading.replace(/^## /, ''))}](#${anchor}) | 冲突条目 | — |`);
      mBodyLines.push(`<a id="${anchor}"></a>`, '', heading);
      const sides = extractBodySection(cf.body, /^## 冲突双方/);
      const point = extractBodySection(cf.body, /^## 冲突点/);
      const res = extractBodySection(cf.body, /^## 折中思路/);
      if (sides) mBodyLines.push(`- 双方：${sides}`);
      if (point) mBodyLines.push(`- 冲突点：${point}`);
      if (res) mBodyLines.push(`- 折中思路：${res}`);
      mBodyLines.push('');
    }
  };

  for (const card of methodCards) {
    const fm = card.frontmatter;
    const secTitle = fm.legacy_meta?.original_section || '第一编 未分编';

    if (!conflictsEmitted && /第十三编/.test(secTitle) && /第十一编/.test(conflictSectionTitle)) {
      emitConflictsBlock();
    }

    if (!emittedSections.has(secTitle)) {
      emittedSections.add(secTitle);
      const secAnchor = sectionAnchorMap.get(secTitle) || `m-sec-${emittedSections.size}`;
      mTocRows.push(`| H1 | [${escapeTocTitle(secTitle)}](#${secAnchor}) | 编目 | — |`);
      mBodyLines.push('', `<a id="${secAnchor}"></a>`, '', `# ${secTitle}`, '');
    }

    const numStr = String(fm.num || 0).padStart(3, '0');
    const anchor = fm.legacy_meta?.anchor_id || `method-${numStr}`;
    const heading = fm.legacy_meta?.raw_heading || `## 卡片 ${numStr} | ${fm.title}`;
    mTocRows.push(`| H2 | [${escapeTocTitle(heading.replace(/^## /, ''))}](#${anchor}) | ${fm.status} | — |`);

    mBodyLines.push(`<a id="${anchor}"></a>`, '', heading);
    const core = extractBodySection(card.body, /^## 核心论断/);
    const logic = extractBodySection(card.body, /^## 逻辑链条/);
    const cond = extractBodySection(card.body, /^## 适用条件/);
    const inv = extractBodySection(card.body, /^## 失效信号/);
    const cases = extractBodySection(card.body, /^## 历史案例/);
    const src = extractBodySection(card.body, /^## 来源/);
    const amends = extractBodySection(card.body, /^## 增订记录/);
    const extras = extractBodySection(card.body, /^## 附注与补充字段/);

    if (core) mBodyLines.push(`- 核心论断：${core}`);
    if (logic) mBodyLines.push(`- 逻辑链条：${logic}`);
    if (cond) mBodyLines.push(`- 适用条件：${cond}`);
    if (inv) mBodyLines.push(`- 失效信号：${inv}`);
    if (cases) mBodyLines.push(`- 历史案例：${cases}`);
    if (fm.legacy_credibility?.raw) mBodyLines.push(`- 可信度：${fm.legacy_credibility.raw}`);
    else if (typeof fm.legacy_credibility?.score === 'number') mBodyLines.push(`- 可信度：${fm.legacy_credibility.score}`);
    if (src) mBodyLines.push(`- 来源：${src}`);
    if (amends) {
      for (const line of amends.split(/\r?\n/)) {
        const m = line.match(/^- \*\*(.+?)\*\*：([\s\S]*)$/);
        if (m) mBodyLines.push(`- ${m[1]}：${m[2]}`);
        else if (line.trim()) mBodyLines.push(line);
      }
    }
    if (extras) {
      for (const line of extras.split(/\r?\n/)) {
        const m = line.match(/^- \*\*(.+?)\*\*：([\s\S]*)$/);
        if (m) mBodyLines.push(`- ${m[1]}：${m[2]}`);
        else if (line.trim()) mBodyLines.push(line);
      }
    }
    const rlogs = reviewsByCard.get(fm.id) || [];
    for (const rl of rlogs) {
      if (rl.raw_line) mBodyLines.push(rl.raw_line);
      else mBodyLines.push(`- ${rl.raw_label || `复盘记录 ${rl.date}`}：${rl.note}`);
    }
    mBodyLines.push('');
  }
  emitConflictsBlock();

  const appendicesPath = path.join(kbDir, 'meta', 'appendices.md');
  if (fs.existsSync(appendicesPath)) {
    const appRaw = fs.readFileSync(appendicesPath, 'utf8').trim();
    if (appRaw) mBodyLines.push('---', '', appRaw, '');
  }
  for (const lg of methodLogs) {
    mBodyLines.push('', `<a id="${lg.anchor || 'm-log'}"></a>`, '', `# ${lg.title}`, '', lg.content, '');
  }

  const mHeaderLines = legacyHeaders.methodologyHeaderLines || ['# 方法论卡片库', '> 版本：v2.0。'];
  const mFull = [
    ...mHeaderLines,
    '',
    '## 完整目录（由 kb-compiler 自动编译生成）',
    '',
    '| 层级 | 正文标题 | 状态／用途 | 原件行 |',
    '|---|---|---|---:|',
    ...mTocRows,
    '',
    '---',
    ...mBodyLines,
  ].join('\n');

  const exportsDir = path.join(kbDir, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const mOutPath = path.join(exportsDir, '方法论卡片库.compiled.md');
  fs.writeFileSync(mOutPath, mFull, 'utf8');

  // -------------------------------------------------------------------------
  // 2. 编译《行业前沿认知库.compiled.md》
  // -------------------------------------------------------------------------
  const cogCards = listMd(path.join(kbDir, 'cards', 'cognition')).map((f) => {
    const parsed = parseFrontmatter(fs.readFileSync(f, 'utf8'));
    return { ...parsed, file: f };
  });
  cogCards.sort(
    (a, b) =>
      (a.frontmatter.legacy_meta?.order_in_source || a.frontmatter.num || 0) -
      (b.frontmatter.legacy_meta?.order_in_source || b.frontmatter.num || 0)
  );

  const cTocRows = [];
  const cBodyLines = [];
  const emittedBatches = new Set();
  const batchesMeta = legacyHeaders.cognitionBatches || [];
  const batchAnchorMap = new Map(batchesMeta.map((b) => [b.title, b.anchor]));

  for (const card of cogCards) {
    const fm = card.frontmatter;
    const batchTitle = fm.legacy_meta?.original_batch || '第一编 初始认知批次';
    if (!emittedBatches.has(batchTitle)) {
      emittedBatches.add(batchTitle);
      const bAnchor = batchAnchorMap.get(batchTitle) || `c-batch-${emittedBatches.size}`;
      cTocRows.push(`| H1 | [${escapeTocTitle(batchTitle)}](#${bAnchor}) | 批次/编目 | — |`);
      cBodyLines.push('', `<a id="${bAnchor}"></a>`, '', `# ${batchTitle}`, '');
    }

    const numStr = String(fm.num || 0).padStart(3, '0');
    const anchor = fm.legacy_meta?.anchor_id || `cognition-${numStr}`;
    const heading = fm.legacy_meta?.raw_heading || `## 认知卡 ${numStr} | ${fm.title}`;
    cTocRows.push(`| H2 | [${escapeTocTitle(heading.replace(/^## /, ''))}](#${anchor}) | ${fm.status} | — |`);

    cBodyLines.push(`<a id="${anchor}"></a>`, '', heading);
    const facts = extractBodySection(card.body, /^## (?:事实与要点|客观事实)/);
    const src = extractBodySection(card.body, /^## 来源/);
    const imp = extractBodySection(card.body, /^## 产业含义/);
    const mapping = extractBodySection(card.body, /^## A股映射/);
    const inv = extractBodySection(card.body, /^## 失效与更新条件/);
    const rels = extractBodySection(card.body, /^## 原文关联说明/);
    const amends = extractBodySection(card.body, /^## 增订与校准记录/);
    const ulog = extractBodySection(card.body, /^## 原卡更新日志/);
    const extras = extractBodySection(card.body, /^## 附注与补充字段/);

    if (facts) {
      if (facts.startsWith('- **事实')) {
        for (const line of facts.split(/\r?\n/)) {
          const m = line.match(/^- \*\*(.+?)\*\*：([\s\S]*)$/);
          if (m) cBodyLines.push(`- ${m[1]}：${m[2]}`);
          else if (line.trim()) cBodyLines.push(line);
        }
      } else {
        cBodyLines.push(`- 事实/要点：${facts}`);
      }
    }
    if (src) cBodyLines.push(`- 来源：${src}`);
    if (fm.legacy_grade) cBodyLines.push(`- 证据等级：${fm.legacy_grade}`);
    if (imp) cBodyLines.push(`- 产业含义（分析）：${imp}`);
    if (mapping) cBodyLines.push(`- A股映射（分析）：${mapping}`);
    if (fm.confidence_raw) cBodyLines.push(`- 置信度：${fm.confidence_raw}`);
    if (inv) cBodyLines.push(`- 失效/更新条件：${inv}`);
    if (rels) {
      for (const line of rels.split(/\r?\n/)) {
        const m = line.match(/^- \*\*(.+?)\*\*：([\s\S]*)$/);
        if (m) cBodyLines.push(`- ${m[1]}：${m[2]}`);
        else if (line.trim()) cBodyLines.push(line);
      }
    }
    if (amends) {
      for (const line of amends.split(/\r?\n/)) {
        const m = line.match(/^- \*\*(.+?)\*\*：([\s\S]*)$/);
        if (m) cBodyLines.push(`- ${m[1]}：${m[2]}`);
        else if (line.trim()) cBodyLines.push(line);
      }
    }
    if (ulog) cBodyLines.push(`- 更新日志：${ulog}`);
    if (extras) {
      for (const line of extras.split(/\r?\n/)) {
        const m = line.match(/^- \*\*(.+?)\*\*：([\s\S]*)$/);
        if (m) cBodyLines.push(`- ${m[1]}：${m[2]}`);
        else if (line.trim()) cBodyLines.push(line);
      }
    }
    cBodyLines.push('');
  }

  for (const lg of cogLogs) {
    cBodyLines.push('', `<a id="${lg.anchor || 'c-log'}"></a>`, '', `## ${lg.title}`, '', lg.content, '');
  }

  const archivesPath = path.join(kbDir, 'meta', 'research-archives.yaml');
  const archiveLines = [];
  if (fs.existsSync(archivesPath)) {
    const parsed = parseYamlLines(fs.readFileSync(archivesPath, 'utf8'));
    if (Array.isArray(parsed.archives) && parsed.archives.length > 0) {
      archiveLines.push('', '## 研究观点归档', '');
      for (const a of parsed.archives) {
        archiveLines.push(a.rawLine || `- ${a.date} · [${a.title}](<${a.relativePath}>) · ${a.summary}`);
      }
    }
  }

  const cHeaderLines = legacyHeaders.cognitionHeaderLines || ['# 行业前沿认知库', '> 版本：v2.0。'];
  const cFull = [
    ...cHeaderLines,
    ...archiveLines,
    '',
    '## 完整目录（由 kb-compiler 自动编译生成）',
    '',
    '| 层级 | 正文标题 | 状态／用途 | 原件行 |',
    '|---|---|---|---:|',
    ...cTocRows,
    '',
    '---',
    ...cBodyLines,
  ].join('\n');

  const cOutPath = path.join(exportsDir, '行业前沿认知库.compiled.md');
  fs.writeFileSync(cOutPath, cFull, 'utf8');

  return {
    ok: true,
    exportedAt: new Date().toISOString(),
    methodologySnapshot: {
      path: mOutPath,
      bytes: Buffer.byteLength(mFull, 'utf8'),
      cardCount: methodCards.length,
      conflictCount: conflictCards.length,
    },
    cognitionSnapshot: {
      path: cOutPath,
      bytes: Buffer.byteLength(cFull, 'utf8'),
      cardCount: cogCards.length,
    },
  };
}

module.exports = {
  compileMonolithSnapshots,
};
