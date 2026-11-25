'use strict';

/**
 * 100% 确定性无损迁移器（零 LLM、零幻觉、字符级完整保留、零硬编码私库编号）
 *
 * 读取现行《方法论卡片库.md》与《行业前沿认知库.md》（严格只读），输出至独立 v2 目录：
 * - kb.manifest.yaml
 * - meta/registry.yaml, meta/taxonomy.yaml, meta/synonyms.yaml, meta/appendices.md, meta/research-archives.yaml, meta/legacy-headers.json
 * - cards/methodology/M-NNN.md
 * - cards/cognition/C-NNN.md
 * - cards/conflicts/CF-NN.md
 * - topics/T-*.md
 * - events/review-log.jsonl
 * - events/ingestion-log.jsonl
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stringifyFrontmatter, parseFrontmatter, serializeYamlBlock } = require('./kb-yaml.cjs');
const {
  TAXONOMY,
  SYNONYM_GROUPS,
  INITIAL_TOPICS,
  extractEntities,
  inferMethodTaxonomy,
  inferCognitionTopicsAndNodes,
} = require('./kb-taxonomy.cjs');

function sha256(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function pad3(n) {
  return String(Number(n)).padStart(3, '0');
}

function pad2(n) {
  return String(Number(n)).padStart(2, '0');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function addDaysISO(isoDate, days) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function normalizeForContentCheck(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * 从方法论库头部/目录区动态提取显式声明的保留缺号（零硬编码私库编号）
 */
function extractReservedMissingIds(preambleLines) {
  const reserved = new Set();
  const text = (preambleLines || []).join('\n');
  if (!text) return [];

  const addDigits = (seg) => {
    for (const nm of String(seg || '').matchAll(/\b(\d{3})\b/g)) {
      const n = Number(nm[1]);
      if (n >= 1 && n <= 999) reserved.add(pad3(n));
    }
  };

  for (const m of text.matchAll(/(?:^|[^0-9])(\d{3}(?:[、/／,，及和与\s]+\d{3})*)\s*(?:号|卡)?\s*(?:为|是)?\s*(?:永久)?(?:(?:声明|保留)缺号|缺号(?:保留|声明))/g)) {
    addDigits(m[1]);
  }
  for (const m of text.matchAll(/(?:(?:声明|保留)?缺号(?:声明|保留)?)(?:[：:]\s*|\s+)(\d{3}(?:[、/／,，及和与\s]+\d{3})*)/g)) {
    addDigits(m[1]);
  }

  return [...reserved].sort();
}

/**
 * 解析一个卡片块中的所有顶级 bullet 与缩进续行（完整保留多行缩进子条目）
 */
function parseBulletsLossless(blockLines, blockStartLineNo) {
  const bullets = [];
  let current = null;

  for (let i = 1; i < blockLines.length; i++) {
    const rawLine = blockLines[i];
    if (rawLine.startsWith('- ')) {
      if (current) bullets.push(current);
      const body = rawLine.slice(2);
      const colonIdx = body.search(/[：:]/);
      let key = '';
      let val = body;
      if (colonIdx !== -1 && colonIdx <= 68 && !/^【复盘记录/.test(body)) {
        key = body.slice(0, colonIdx).replace(/^\*\*|\*\*$/g, '').trim();
        val = body.slice(colonIdx + 1).trim();
      } else if (/^【复盘记录/.test(body)) {
        const mBracket = body.match(/^(【复盘记录[^】]*】)(.*)$/);
        key = mBracket ? mBracket[1].trim() : '复盘记录';
        val = mBracket ? mBracket[2].replace(/^[：:]\s*/, '').trim() : body;
      }
      current = {
        key,
        val,
        rawLines: [rawLine],
        subLines: [],
        line: blockStartLineNo + i,
      };
    } else if (rawLine.trim() !== '') {
      if (current) {
        current.rawLines.push(rawLine);
        current.subLines.push(rawLine);
        current.val = current.val ? `${current.val}\n${rawLine}` : rawLine;
      } else {
        bullets.push({
          key: '自由段落',
          val: rawLine,
          rawLines: [rawLine],
          subLines: [],
          line: blockStartLineNo + i,
        });
      }
    }
  }
  if (current) bullets.push(current);
  return bullets;
}

/**
 * 提取跨库显式引用（方法论卡、认知卡、冲突）
 */
function expandIdSegment(seg, targetSet) {
  for (const rm of String(seg || '').matchAll(/(\d{3})\s*[—–\-~]\s*(\d{3})/g)) {
    const start = Number(rm[1]);
    const end = Number(rm[2]);
    if (end >= start && end - start <= 15) {
      for (let i = start; i <= end; i++) targetSet.add(pad3(i));
    }
  }
  for (const nm of String(seg || '').matchAll(/\b(\d{3})\b/g)) {
    const n = Number(nm[1]);
    if (n >= 1 && n <= 500) targetSet.add(pad3(n));
  }
}

function extractRefs(text) {
  const methodIds = new Set();
  const cognitionIds = new Set();
  const conflictIds = new Set();
  const s = String(text || '');

  for (const m of s.matchAll(/#method-(\d{3})/g)) methodIds.add(m[1]);
  for (const m of s.matchAll(/#cognition-(\d{3})/g)) cognitionIds.add(m[1]);
  for (const m of s.matchAll(/#conflict-(\d+)/g)) conflictIds.add(String(Number(m[1])));

  for (const m of s.matchAll(/认知卡?\s*([0-9]{3}(?:(?:（[^）]{1,18}）)?[、/／,，\-—–~及和与\s]+(?:\[)?[0-9]{3}(?:\])?(?:\(#cognition-[0-9]{3}\))?)*)/g)) {
    expandIdSegment(m[1], cognitionIds);
  }

  for (const m of s.matchAll(/冲突\s*(\d{1,2})/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 99) conflictIds.add(String(n));
  }

  for (const m of s.matchAll(/(?:方法论卡(?:片)?|(?<!认知)卡片)\s*([0-9]{3}(?:(?:（[^）]{1,18}）)?[、/／,，\-—–~及和与\s]+[0-9]{3})*)/g)) {
    expandIdSegment(m[1], methodIds);
  }
  for (const m of s.matchAll(/关联方法论卡片[：:]\s*([^\n]+)/g)) {
    const beforeCog = m[1].split(/关联认知卡|认知卡/)[0];
    expandIdSegment(beforeCog, methodIds);
  }
  for (const m of s.matchAll(/关联认知卡[：:]\s*([^\n；;]+)/g)) {
    const beforeMethod = m[1].split(/关联(?:方法论)?卡片|方法论卡/)[0];
    expandIdSegment(beforeMethod, cognitionIds);
  }

  return {
    methodIds: [...methodIds].sort(),
    cognitionIds: [...cognitionIds].sort(),
    conflictIds: [...conflictIds].sort((a, b) => Number(a) - Number(b)),
  };
}

function parseReviewVerdict(text) {
  const s = String(text || '');
  let delta = 0;
  let scoreAfter = null;
  const arrowM = s.match(/(\d\.\d+)\s*[→\->]+\s*(\d\.\d+)/);
  if (arrowM) {
    delta = Number((parseFloat(arrowM[2]) - parseFloat(arrowM[1])).toFixed(3));
    scoreAfter = parseFloat(arrowM[2]);
  } else {
    const dM = s.match(/([+\-]\s*0\.\d+)/);
    if (dM) delta = parseFloat(dM[1].replace(/\s+/g, ''));
    const curM = s.match(/(?:维持|现值|仍为|不动)\s*(\d\.\d+)|(\d\.\d+)\s*(?:维持|不动)/);
    if (curM) scoreAfter = parseFloat(curM[1] || curM[2]);
  }
  let verdict = 'hold_boundary';
  if (/证伪|失效/.test(s) && delta < 0) verdict = 'falsified';
  else if (/验证为真|验证通过|上调|兑现/.test(s) && delta > 0) verdict = 'confirmed';
  else if (/不适用|不计验证|自滤|无场景/.test(s)) verdict = 'regime_na';
  else if (/缺口|数据不足/.test(s)) verdict = 'data_gap';
  return { verdict, legacy_delta: delta, legacy_score_after: scoreAfter };
}

function extractHeaderMeta(lines) {
  const headerLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^## 完整目录/.test(lines[i]) || /^## 研究观点归档/.test(lines[i]) || /^# 第一编/.test(lines[i])) break;
    headerLines.push(lines[i]);
  }
  const joined = headerLines.join('\n');
  const versionMatch = joined.match(/>\s*版本[：:]\s*(v\d+(?:\.\d+)*)/);
  const syncMatch = joined.match(/同步日期[：:]\s*(\d{4}-\d{2}-\d{2})/);
  return {
    version: versionMatch ? versionMatch[1] : 'v1.0',
    syncDate: syncMatch ? syncMatch[1] : '',
    rawHeaderLines: headerLines,
  };
}

/**
 * 解析《方法论卡片库.md》
 */
function parseMethodSource(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const header = extractHeaderMeta(lines);
  const bodyStartIdx = lines.findIndex((l) => /^# 第一编/.test(l));
  const startScan = bodyStartIdx >= 0 ? bodyStartIdx : 0;
  const reservedMissing = extractReservedMissingIds(lines.slice(0, startScan > 0 ? startScan : Math.min(lines.length, 45)));

  let currentSection = { title: '未分编', anchor: '', order: 0 };
  const sections = [];
  const cards = [];
  const conflicts = [];
  const ingestionLogs = [];
  const appendices = [];
  let conflictSectionTitle = '';
  let conflictSectionAnchor = '';

  const blocks = [];
  for (let i = startScan; i < lines.length; i++) {
    const line = lines[i];
    if (/^# /.test(line)) {
      const anchor =
        i >= 1 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 1].trim())
          ? lines[i - 1].trim().match(/^<a id="([^"]+)"><\/a>$/)[1]
          : i >= 2 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 2].trim())
          ? lines[i - 2].trim().match(/^<a id="([^"]+)"><\/a>$/)[1]
          : '';
      const title = line.slice(2).trim();
      blocks.push({ level: 1, lineIdx: i, heading: line, title, anchor });
    } else if (/^## /.test(line)) {
      const anchor =
        i >= 1 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 1].trim())
          ? lines[i - 1].trim().match(/^<a id="([^"]+)"><\/a>$/)[1]
          : i >= 2 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 2].trim())
          ? lines[i - 2].trim().match(/^<a id="([^"]+)"><\/a>$/)[1]
          : '';
      blocks.push({ level: 2, lineIdx: i, heading: line, title: line.slice(3).trim(), anchor });
    }
  }

  for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
    const blk = blocks[bIdx];
    let endIdx = bIdx + 1 < blocks.length ? blocks[bIdx + 1].lineIdx - 1 : lines.length - 1;
    while (
      endIdx > blk.lineIdx &&
      (lines[endIdx].trim() === '' || lines[endIdx].trim() === '---' || /^<a id="[^"]+"><\/a>$/.test(lines[endIdx].trim()))
    ) {
      endIdx--;
    }
    const blockLines = lines.slice(blk.lineIdx, endIdx + 1);

    if (blk.level === 1) {
      if (/^第.+编/.test(blk.title)) {
        currentSection = { title: blk.title, anchor: blk.anchor, order: sections.length + 1, startLine: blk.lineIdx + 1 };
        sections.push(currentSection);
        if (/冲突/.test(blk.title)) {
          conflictSectionTitle = blk.title;
          conflictSectionAnchor = blk.anchor;
        }
      } else if (/冲突.*矩阵/.test(blk.title)) {
        conflictSectionTitle = blk.title;
        conflictSectionAnchor = blk.anchor;
      } else if (/^入库清单/.test(blk.title)) {
        let logEnd = lines.length - 1;
        for (let j = blk.lineIdx + 1; j < lines.length; j++) {
          if (/^# /.test(lines[j]) || /^## 卡片 /.test(lines[j])) {
            logEnd = j - 1;
            break;
          }
        }
        while (
          logEnd > blk.lineIdx &&
          (lines[logEnd].trim() === '' || lines[logEnd].trim() === '---' || /^<a id="[^"]+"><\/a>$/.test(lines[logEnd].trim()))
        ) {
          logEnd--;
        }
        ingestionLogs.push({
          library: 'methodology',
          title: blk.title,
          anchor: blk.anchor,
          startLine: blk.lineIdx + 1,
          content: lines.slice(blk.lineIdx + 1, logEnd + 1).join('\n').trim(),
        });
      } else if (/^附录/.test(blk.title)) {
        let appEnd = lines.length - 1;
        for (let j = blk.lineIdx + 1; j < lines.length; j++) {
          if (/^# /.test(lines[j])) {
            appEnd = j - 1;
            break;
          }
        }
        while (
          appEnd > blk.lineIdx &&
          (lines[appEnd].trim() === '' || lines[appEnd].trim() === '---' || /^<a id="[^"]+"><\/a>$/.test(lines[appEnd].trim()))
        ) {
          appEnd--;
        }
        appendices.push({
          title: blk.title,
          anchor: blk.anchor,
          startLine: blk.lineIdx + 1,
          rawMarkdown: lines.slice(blk.lineIdx, appEnd + 1).join('\n').trim(),
        });
      }
      continue;
    }

    const cardMatch = blk.heading.match(/^## 卡片 (\d{3})\s*\|(.*)$/);
    if (cardMatch) {
      const idNum = cardMatch[1];
      const rawTitlePart = cardMatch[2].trim();
      const cleanTitlePart = rawTitlePart.endsWith(idNum)
        ? rawTitlePart.slice(0, -idNum.length).trim()
        : rawTitlePart;
      const batchMatch = cleanTitlePart.match(/【([^】]+)】/g);
      const batchTag = batchMatch ? batchMatch.join('') : '';
      const titleNoTag = cleanTitlePart.replace(/【[^】]+】/g, '').trim();
      const sysMatch = titleNoTag.match(/^([^（(：:]+?)(?:[（(](.+)[）)]|[：:](.+))$/);
      const system = sysMatch ? sysMatch[1].trim() : currentSection.title.replace(/^第.+?编\s*/, '').split('（')[0].trim();

      const bullets = parseBulletsLossless(blockLines, blk.lineIdx + 1);
      const fields = {
        coreThesis: '',
        logicChain: '',
        applicableConditions: '',
        invalidationSignals: '',
        historicalCases: '',
        credibilityRaw: '',
        source: '',
        amendments: [],
        reviewLogs: [],
        extraFields: [],
      };

      for (const b of bullets) {
        if (b.key === '核心论断') fields.coreThesis = b.val;
        else if (b.key === '逻辑链条') fields.logicChain = b.val;
        else if (b.key === '适用条件') fields.applicableConditions = b.val;
        else if (b.key === '失效信号') fields.invalidationSignals = b.val;
        else if (b.key === '历史案例') fields.historicalCases = b.val;
        else if (b.key === '可信度') fields.credibilityRaw = b.val;
        else if (b.key === '来源') fields.source = b.val;
        else if (/^复盘(?:记录|日志)|^【复盘记录/.test(b.key)) {
          const dm = b.key.match(/(\d{4}-\d{2}-\d{2})/) || b.val.match(/(\d{4}-\d{2}-\d{2})/);
          fields.reviewLogs.push({
            date: dm ? dm[1] : '',
            rawLabel: b.key,
            content: b.val,
            rawLine: b.rawLines.join('\n'),
            line: b.line,
          });
        } else if (/增订|修订|补充/.test(b.key)) {
          fields.amendments.push({
            label: b.key,
            content: b.val,
            rawLine: b.rawLines.join('\n'),
            line: b.line,
          });
        } else {
          fields.extraFields.push({
            label: b.key || '说明',
            content: b.val,
            rawLine: b.rawLines.join('\n'),
            line: b.line,
          });
        }
      }

      const rawMarkdown = blockLines.join('\n');
      const scoreMatch = fields.credibilityRaw.match(/(\d+(?:\.\d+)?)/);
      const credibilityScore = scoreMatch ? parseFloat(scoreMatch[1]) : null;
      const isRevoked = /已撤销|已并入卡片|撤销.*保留不复用|【撤销】/.test(blk.heading);
      const combinedStatus = `${blk.heading} ${fields.credibilityRaw} ${fields.reviewLogs.slice(-2).map((r) => r.content).join(' ')}`;
      const isArchived = /封存/.test(combinedStatus);
      const isHighPaused = /高位暂停|暂停上调/.test(combinedStatus);
      const isPendingVerify = /【(?:部分)?待核/.test(`${blk.heading} ${fields.credibilityRaw} ${fields.source}`);
      const isPendingRetire = (credibilityScore !== null && credibilityScore < 0.3) || /【待淘汰】/.test(combinedStatus);

      const dateInTag = batchTag.match(/(\d{4}-\d{2}-\d{2})/);
      const createdAt = dateInTag ? dateInTag[1] : header.syncDate || new Date().toISOString().slice(0, 10);
      const lastReviewDate = fields.reviewLogs.reduce((acc, r) => (r.date && r.date > acc ? r.date : acc), '');
      const lastAmendDate = fields.amendments.reduce((acc, a) => {
        const m = `${a.label} ${a.content}`.match(/(\d{4}-\d{2}-\d{2})/);
        return m && m[1] > acc ? m[1] : acc;
      }, '');
      const updatedAt = [createdAt, lastReviewDate, lastAmendDate].filter(Boolean).sort().pop() || createdAt;

      cards.push({
        id: `M:${idNum}`,
        idNum,
        num: Number(idNum),
        orderInSource: cards.length + 1,
        rawHeading: blk.heading,
        title: titleNoTag || cleanTitlePart,
        system,
        batchTag,
        sectionTitle: currentSection.title,
        sectionOrder: currentSection.order,
        anchorId: blk.anchor || `method-${idNum}`,
        startLine: blk.lineIdx + 1,
        endLine: endIdx + 1,
        createdAt,
        updatedAt,
        credibilityScore,
        isRevoked,
        isArchived,
        isHighPaused,
        isPendingVerify,
        isPendingRetire,
        reviewLogsCount: fields.reviewLogs.length,
        fields,
        rawMarkdown,
      });
      continue;
    }

    const confMatch = blk.heading.match(/^## 冲突 (\d+)(?:（([^）]+)）)?[：:]\s*(.+)$/);
    if (confMatch) {
      const num = Number(confMatch[1]);
      const bullets = parseBulletsLossless(blockLines, blk.lineIdx + 1);
      let sides = '';
      let conflictPoint = '';
      let resolution = '';
      const extraFields = [];
      for (const b of bullets) {
        if (/^(?:冲突)?双方$/.test(b.key)) sides = b.val;
        else if (b.key === '冲突点') conflictPoint = b.val;
        else if (/^(?:折中思路|判别与折中|折中|解决原则)$/.test(b.key)) resolution = b.val;
        else extraFields.push({ label: b.key || '说明', content: b.val, rawLine: b.rawLines.join('\n') });
      }
      const dateM = `${confMatch[2] || ''} ${blk.heading}`.match(/(\d{4}-\d{2}-\d{2})/);
      conflicts.push({
        id: `CF:${pad2(num)}`,
        num,
        rawHeading: blk.heading,
        versionTag: confMatch[2] || '',
        title: confMatch[3].trim(),
        createdAt: dateM ? dateM[1] : header.syncDate || new Date().toISOString().slice(0, 10),
        sides,
        conflictPoint,
        resolution,
        extraFields,
        anchorId: blk.anchor || `conflict-${num}`,
        startLine: blk.lineIdx + 1,
        endLine: endIdx + 1,
        rawMarkdown: blockLines.join('\n'),
      });
    }
  }

  return {
    header,
    reservedMissing,
    sections,
    conflictSectionTitle,
    conflictSectionAnchor,
    cards,
    conflicts,
    ingestionLogs,
    appendices,
  };
}

/**
 * 解析《行业前沿认知库.md》
 */
function parseCognitionSource(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const header = extractHeaderMeta(lines);

  const researchArchives = [];
  const archStart = lines.findIndex((l) => /^## 研究观点归档/.test(l));
  const tocStart = lines.findIndex((l) => /^## 完整目录/.test(l));
  if (archStart >= 0 && tocStart > archStart) {
    for (let i = archStart + 1; i < tocStart; i++) {
      const m = lines[i].match(/^- (\d{4}-\d{2}-\d{2})\s*·\s*\[(.+?)\]\(<?([^)>]+)>?\)\s*·?\s*(.*)$/);
      if (m) {
        researchArchives.push({
          date: m[1],
          title: m[2],
          relativePath: m[3],
          summary: m[4].trim(),
          rawLine: lines[i],
        });
      }
    }
  }

  const bodyStartIdx = lines.findIndex((l) => /^# 第一编/.test(l));
  const startScan = bodyStartIdx >= 0 ? bodyStartIdx : 0;

  let currentBatch = { title: '第一编 AI算力', anchor: '', order: 0 };
  let currentSubGroup = '';
  const batches = [];
  const cards = [];
  const updateLogs = [];

  const blocks = [];
  for (let i = startScan; i < lines.length; i++) {
    const line = lines[i];
    if (/^# /.test(line)) {
      const anchor =
        i >= 1 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 1].trim())
          ? lines[i - 1].trim().match(/^<a id="([^"]+)"><\/a>$/)[1]
          : i >= 2 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 2].trim())
          ? lines[i - 2].trim().match(/^<a id="([^"]+)"><\/a>$/)[1]
          : '';
      blocks.push({ level: 1, lineIdx: i, heading: line, title: line.slice(2).trim(), anchor });
    } else if (/^## /.test(line)) {
      const anchor =
        i >= 1 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 1].trim())
          ? lines[i - 1].trim().match(/^<a id="([^"]+)"><\/a>$/)[1]
          : i >= 2 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 2].trim())
          ? lines[i - 2].trim().match(/^<a id="([^"]+)"><\/a>$/)[1]
          : '';
      blocks.push({ level: 2, lineIdx: i, heading: line, title: line.slice(3).trim(), anchor });
    }
  }

  for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
    const blk = blocks[bIdx];
    let endIdx = bIdx + 1 < blocks.length ? blocks[bIdx + 1].lineIdx - 1 : lines.length - 1;
    while (
      endIdx > blk.lineIdx &&
      (lines[endIdx].trim() === '' || lines[endIdx].trim() === '---' || /^<a id="[^"]+"><\/a>$/.test(lines[endIdx].trim()))
    ) {
      endIdx--;
    }
    const blockLines = lines.slice(blk.lineIdx, endIdx + 1);

    if (blk.level === 1) {
      currentBatch = { title: blk.title, anchor: blk.anchor, order: batches.length + 1, startLine: blk.lineIdx + 1 };
      currentSubGroup = '';
      batches.push(currentBatch);
      continue;
    }

    if (/^## 更新日志/.test(blk.heading)) {
      updateLogs.push({
        library: 'cognition',
        title: blk.title,
        anchor: blk.anchor,
        batchTitle: currentBatch.title,
        startLine: blk.lineIdx + 1,
        content: blockLines.slice(1).join('\n').trim(),
      });
      continue;
    }

    const cardMatch = blk.heading.match(/^## 认知卡 (\d{3})\s*\|(.*)$/);
    if (!cardMatch) {
      currentSubGroup = blk.title;
      continue;
    }

    const idNum = cardMatch[1];
    const rawRest = cardMatch[2].trim();
    const dateMatch = rawRest.match(/(\d{4}-\d{2}-\d{2})\s*入库/);
    const ingestedAt = dateMatch ? dateMatch[1] : header.syncDate || '';
    const catMatch = rawRest.match(/（([^）]*增补[^）]*|[^）]*核心卡[^）]*|[^）]*线[^）]*)）/);
    const categoryTag = catMatch ? catMatch[1] : currentSubGroup;
    const rawMarkdown = blockLines.join('\n');
    const updatedToMatch = rawRest.match(/【已更新→(?:卡号)?(\d{3})】/) || rawMarkdown.match(/【已更新→(?:卡号)?(\d{3})】/);
    const isPartiallyFalsified = /部分证伪/.test(rawRest);
    const isArchived = /整卡归档|已过期/.test(rawRest);
    const title = rawRest
      .replace(/【[^】]+】/g, '')
      .replace(/（(?:第[^）]+增补|[^）]*增补[^）]*)）/g, '')
      .trim();

    const bullets = parseBulletsLossless(blockLines, blk.lineIdx + 1);
    const fields = {
      factsEntries: [],
      source: '',
      evidenceLevelRaw: '',
      industryImplications: '',
      aShareMapping: '',
      confidence: '',
      invalidationConditions: '',
      updateLog: '',
      relatedLines: [],
      amendments: [],
      extraFields: [],
    };

    for (const b of bullets) {
      if (/^(?:核心)?事实/.test(b.key)) {
        fields.factsEntries.push({ label: b.key, content: b.val });
      } else if (b.key === '来源') fields.source = b.val;
      else if (b.key === '证据等级') fields.evidenceLevelRaw = b.val;
      else if (/^产业含义/.test(b.key)) fields.industryImplications = b.val;
      else if (/^A\s*股映射/.test(b.key)) fields.aShareMapping = b.val;
      else if (b.key === '置信度') fields.confidence = b.val;
      else if (/失效|更新条件|证伪条件/.test(b.key)) fields.invalidationConditions = b.val;
      else if (b.key === '更新日志') fields.updateLog = b.val;
      else if (/^关联/.test(b.key)) fields.relatedLines.push({ label: b.key, content: b.val });
      else if (/增订|更新|补充|校准|复核/.test(b.key)) {
        fields.amendments.push({ label: b.key, content: b.val, rawLine: b.rawLines.join('\n'), line: b.line });
      } else {
        fields.extraFields.push({ label: b.key || '说明', content: b.val, rawLine: b.rawLines.join('\n'), line: b.line });
      }
    }

    const factsText = fields.factsEntries
      .map((f) => (fields.factsEntries.length > 1 ? `- **${f.label}**：${f.content}` : f.content))
      .join('\n');

    const evidenceGrades = [];
    if (/(?:^|[^A-Za-z])A[+\-]?(?:$|[^A-Za-z])/.test(fields.evidenceLevelRaw)) evidenceGrades.push('A');
    if (/(?:^|[^A-Za-z])B[+\-]?(?:$|[^A-Za-z])/.test(fields.evidenceLevelRaw)) evidenceGrades.push('B');
    if (/(?:^|[^A-Za-z])C[+\-]?(?:$|[^A-Za-z])/.test(fields.evidenceLevelRaw)) evidenceGrades.push('C');
    const primaryGrade = evidenceGrades[0] || 'C';

    const pubDateMatch = fields.source.match(/(\d{4}-\d{2}-\d{2})/);
    const publishDate = pubDateMatch ? pubDateMatch[1] : ingestedAt;
    const lastAmendDate = fields.amendments.reduce((acc, a) => {
      const m = `${a.label} ${a.content}`.match(/(\d{4}-\d{2}-\d{2})/);
      return m && m[1] > acc ? m[1] : acc;
    }, '');
    const updatedAt = [ingestedAt, lastAmendDate].filter(Boolean).sort().pop() || ingestedAt;

    cards.push({
      id: `C:${idNum}`,
      idNum,
      num: Number(idNum),
      orderInSource: cards.length + 1,
      rawHeading: blk.heading,
      title,
      ingestedAt,
      publishDate,
      updatedAt,
      categoryTag,
      batchTitle: currentBatch.title,
      batchOrder: currentBatch.order,
      anchorId: blk.anchor || `cognition-${idNum}`,
      startLine: blk.lineIdx + 1,
      endLine: endIdx + 1,
      evidenceGrades,
      primaryGrade,
      isArchived,
      isPartiallyFalsified,
      updatedToId: updatedToMatch ? updatedToMatch[1] : null,
      facts: factsText,
      industryImplications: fields.industryImplications,
      aShareMapping: fields.aShareMapping,
      evidenceLevelRaw: fields.evidenceLevelRaw,
      fields,
      rawMarkdown,
    });
  }

  return { header, researchArchives, batches, cards, updateLogs };
}

/**
 * 执行全量确定性无损迁移（严格只读原件，零硬编码私库路径或私库卡号）
 */
function runMigration({ methodPath, cognitionPath, targetKbDir }) {
  const mBuf = fs.readFileSync(methodPath);
  const cBuf = fs.readFileSync(cognitionPath);
  const mSha = sha256(mBuf);
  const cSha = sha256(cBuf);
  const mText = mBuf.toString('utf8');
  const cText = cBuf.toString('utf8');

  const mParsed = parseMethodSource(mText);
  const cParsed = parseCognitionSource(cText);

  const dirs = [
    targetKbDir,
    path.join(targetKbDir, 'meta'),
    path.join(targetKbDir, 'cards', 'methodology'),
    path.join(targetKbDir, 'cards', 'cognition'),
    path.join(targetKbDir, 'cards', 'conflicts'),
    path.join(targetKbDir, 'topics'),
    path.join(targetKbDir, 'events'),
    path.join(targetKbDir, '.index'),
    path.join(targetKbDir, 'exports'),
  ];
  for (const d of dirs) ensureDir(d);

  const validMethodNums = new Set(mParsed.cards.map((c) => c.idNum));
  const validCogNums = new Set(cParsed.cards.map((c) => c.idNum));
  const validConfNums = new Set(mParsed.conflicts.map((c) => String(c.num)));

  const reviewEventsAll = [];
  const revokedTombstones = [];
  const dynamicAliases = [];

  // -------------------------------------------------------------------------
  // 1. 写出方法论卡片 cards/methodology/M-NNN.md + 抽取 review-log.jsonl
  // -------------------------------------------------------------------------
  for (const card of mParsed.cards) {
    const tax = inferMethodTaxonomy(card);
    const refs = extractRefs(card.rawMarkdown);
    const entities = extractEntities(`${card.title} ${card.fields.coreThesis} ${card.fields.historicalCases}`);

    const relations = [];
    const relKeySet = new Set();
    const addRel = (type, target, note = '') => {
      const k = `${type}|${target}`;
      if (target === card.id || relKeySet.has(k)) return;
      relKeySet.add(k);
      relations.push({ type, target, note });
    };

    if (card.isRevoked) {
      const mergeM = card.rawHeading.match(/并入卡片?(\d{3})/) || card.rawMarkdown.match(/并入卡片?(\d{3})/);
      const mergedInto = mergeM ? `M:${mergeM[1]}` : null;
      if (mergedInto) addRel('merged_into', mergedInto, '历史撤销并入，原编号永久保留不复用');
      revokedTombstones.push({
        id: card.id,
        merged_into: mergedInto,
        revoked_at: card.updatedAt || card.createdAt || null,
      });
    }
    for (const cf of refs.conflictIds) {
      if (validConfNums.has(cf)) addRel('conflicts_with', `CF:${pad2(cf)}`, '原文引用冲突矩阵');
    }
    for (const mid of refs.methodIds) {
      if (mid !== card.idNum && validMethodNums.has(mid)) addRel('related_to', `M:${mid}`, '原文跨卡互参');
    }
    for (const cid of refs.cognitionIds) {
      if (validCogNums.has(cid)) addRel('related_to', `C:${cid}`, '原文跨库互参');
    }

    const chainIdSet = new Set();
    card.fields.reviewLogs.forEach((rl, idx) => {
      const v = parseReviewVerdict(`${rl.rawLabel} ${rl.content}`);
      const chainBucket = rl.date ? `EC-${rl.date.slice(0, 7)}-DAILY` : 'EC-UNDATED';
      chainIdSet.add(chainBucket);
      reviewEventsAll.push({
        event_id: `RV-${(rl.date || '00000000').replace(/-/g, '')}-M${card.idNum}-${String(idx + 1).padStart(2, '0')}`,
        date: rl.date || '',
        card_id: card.id,
        ledger_ref: rl.date ? `DAILY:${rl.date}` : '',
        evidence_chain_id: chainBucket,
        regime: tax.regimes[0] || 'all',
        verdict: v.verdict,
        legacy_delta: v.legacy_delta,
        legacy_score_after: v.legacy_score_after,
        raw_label: rl.rawLabel,
        note: rl.content,
        raw_line: rl.rawLine,
        source_line: rl.line,
      });
    });

    let status = 'active';
    if (card.isRevoked) status = 'revoked';
    else if (card.isPendingRetire) status = 'pending_retire';
    else if (card.isArchived) status = 'dormant_archived';

    let verificationTier = 'unverified';
    if (card.fields.reviewLogs.length >= 3) verificationTier = 'live_multi_chain';
    else if (card.fields.reviewLogs.length > 0) verificationTier = 'single_sample';
    else if (/已核验/.test(`${card.rawHeading} ${card.fields.source}`)) verificationTier = 'literature_verified';

    // 动态检测原文是否显式声明旧编号映射（无任何私库硬编码）
    let legacyAlias = null;
    const oldAliasM = `${card.rawHeading} ${card.fields.source}`.match(/(?:旧短线卡?|原旧库卡?|原编号)\s*(\d{3})/);
    if (oldAliasM && oldAliasM[1] !== card.idNum) {
      legacyAlias = `LEGACY_${oldAliasM[1]}`;
      dynamicAliases.push({ old_id: legacyAlias, current_id: card.id, note: '原文声明历史编号映射' });
    }

    const frontmatter = {
      id: card.id,
      num: card.num,
      title: card.title,
      card_kind: tax.card_kind,
      status,
      created_at: card.createdAt,
      updated_at: card.updatedAt,
      domains: tax.domains,
      regimes: tax.regimes,
      horizons: tax.horizons,
      asset_classes: tax.asset_classes,
      tickers: entities,
      legacy_credibility: {
        score: card.credibilityScore,
        raw: card.fields.credibilityRaw,
        high_paused: card.isHighPaused,
        archived_flag: card.isArchived,
      },
      epistemic: {
        verification_tier: verificationTier,
        review_event_count: card.fields.reviewLogs.length,
        independent_chains: chainIdSet.size,
        backtest_status: 'not_run',
        pending_verify: card.isPendingVerify,
      },
      relations,
      sources_raw: card.fields.source,
      legacy_meta: {
        raw_heading: card.rawHeading,
        system: card.system,
        batch_tag: card.batchTag,
        original_section: card.sectionTitle,
        section_order: card.sectionOrder,
        order_in_source: card.orderInSource,
        anchor_id: card.anchorId,
        source_start_line: card.startLine,
        source_end_line: card.endLine,
        legacy_alias: legacyAlias,
        enrichment_status: 'raw_migrated',
      },
    };

    const bodyParts = [];
    if (card.fields.coreThesis) bodyParts.push(`## 核心论断\n${card.fields.coreThesis}`);
    if (card.fields.logicChain) bodyParts.push(`## 逻辑链条\n${card.fields.logicChain}`);
    if (card.fields.applicableConditions) bodyParts.push(`## 适用条件\n${card.fields.applicableConditions}`);
    if (card.fields.invalidationSignals) bodyParts.push(`## 失效信号\n${card.fields.invalidationSignals}`);
    if (card.fields.historicalCases) bodyParts.push(`## 历史案例\n${card.fields.historicalCases}`);
    if (card.fields.source) bodyParts.push(`## 来源\n${card.fields.source}`);
    if (card.fields.amendments.length > 0) {
      bodyParts.push(
        `## 增订记录\n${card.fields.amendments.map((a) => `- **${a.label}**：${a.content}`).join('\n')}`
      );
    }
    if (card.fields.extraFields.length > 0) {
      bodyParts.push(
        `## 附注与补充字段\n${card.fields.extraFields.map((e) => `- **${e.label}**：${e.content}`).join('\n')}`
      );
    }
    if (card.fields.reviewLogs.length > 0) {
      bodyParts.push(
        `<!-- 已剥离 ${card.fields.reviewLogs.length} 条逐日复盘记录至 events/review-log.jsonl（card_id=${card.id}） -->`
      );
    }

    const outPath = path.join(targetKbDir, 'cards', 'methodology', `M-${card.idNum}.md`);
    fs.writeFileSync(outPath, stringifyFrontmatter(frontmatter, bodyParts.join('\n\n')), 'utf8');
  }

  // -------------------------------------------------------------------------
  // 2. 写出冲突矩阵卡片 cards/conflicts/CF-NN.md
  // -------------------------------------------------------------------------
  for (const conf of mParsed.conflicts) {
    const refs = extractRefs(conf.rawMarkdown);
    const relations = [];
    for (const mid of refs.methodIds) {
      if (validMethodNums.has(mid)) relations.push({ type: 'conflicts_with', target: `M:${mid}`, note: '冲突涉及方法论卡' });
    }
    for (const cid of refs.cognitionIds) {
      if (validCogNums.has(cid)) relations.push({ type: 'conflicts_with', target: `C:${cid}`, note: '冲突涉及认知卡' });
    }

    const frontmatter = {
      id: conf.id,
      num: conf.num,
      title: conf.title,
      card_kind: 'conflict',
      status: 'open',
      created_at: conf.createdAt,
      version_tag: conf.versionTag,
      relations,
      legacy_meta: {
        raw_heading: conf.rawHeading,
        anchor_id: conf.anchorId,
        source_start_line: conf.startLine,
        source_end_line: conf.endLine,
        enrichment_status: 'raw_migrated',
      },
    };

    const bodyParts = [];
    if (conf.sides) bodyParts.push(`## 冲突双方\n${conf.sides}`);
    if (conf.conflictPoint) bodyParts.push(`## 冲突点\n${conf.conflictPoint}`);
    if (conf.resolution) bodyParts.push(`## 折中思路与判别变量\n${conf.resolution}`);
    if (conf.extraFields.length > 0) {
      bodyParts.push(`## 补充说明\n${conf.extraFields.map((e) => `- **${e.label}**：${e.content}`).join('\n')}`);
    }

    const outPath = path.join(targetKbDir, 'cards', 'conflicts', `CF-${pad2(conf.num)}.md`);
    fs.writeFileSync(outPath, stringifyFrontmatter(frontmatter, bodyParts.join('\n\n')), 'utf8');
  }

  // -------------------------------------------------------------------------
  // 3. 写出认知卡片 cards/cognition/C-NNN.md
  // -------------------------------------------------------------------------
  const topicMemberMap = new Map(INITIAL_TOPICS.map((t) => [t.id, []]));

  for (const card of cParsed.cards) {
    const inferred = inferCognitionTopicsAndNodes(card);
    const refs = extractRefs(card.rawMarkdown);
    const entities = extractEntities(`${card.title} ${card.facts} ${card.aShareMapping} ${card.industryImplications}`);

    let status = 'active';
    if (card.isArchived) status = 'archived';
    else if (card.updatedToId) status = 'superseded';
    else if (card.isPartiallyFalsified) status = 'partially_falsified';

    let validUntil = null;
    let nextCheckDate = null;
    if (inferred.claim_type === 'event_calendar') {
      validUntil = addDaysISO(card.ingestedAt, 7);
      nextCheckDate = addDaysISO(card.ingestedAt, 3);
    } else if (status === 'active') {
      const ttlDays = card.primaryGrade === 'A' && inferred.claim_type === 'fact' ? 180 : 90;
      validUntil = addDaysISO(card.updatedAt || card.ingestedAt, ttlDays);
      nextCheckDate = addDaysISO(card.updatedAt || card.ingestedAt, Math.min(60, ttlDays));
    }

    const relations = [];
    const relKeySet = new Set();
    const addRel = (type, target, note = '') => {
      const k = `${type}|${target}`;
      if (target === card.id || relKeySet.has(k)) return;
      relKeySet.add(k);
      relations.push({ type, target, note });
    };

    if (card.updatedToId && validCogNums.has(card.updatedToId)) {
      addRel('superseded_by', `C:${card.updatedToId}`, '原卡标注已更新替代');
    }
    const falsifyM = card.rawHeading.match(/触发认知卡(\d{3})证伪/);
    if (falsifyM && validCogNums.has(falsifyM[1])) {
      addRel('partially_falsifies', `C:${falsifyM[1]}`, '原文标题明确声明触发证伪更新');
    }
    const falsifiedByM = card.rawHeading.match(/部分证伪[^】]*认知卡(\d{3})/);
    if (falsifiedByM && validCogNums.has(falsifiedByM[1])) {
      addRel('partially_falsified_by', `C:${falsifiedByM[1]}`, '原文标题标注部分证伪来源');
    }

    for (const mid of refs.methodIds) {
      if (validMethodNums.has(mid)) addRel('uses_method', `M:${mid}`, '关联方法论卡片');
    }
    for (const cf of refs.conflictIds) {
      if (validConfNums.has(cf)) addRel('conflicts_with', `CF:${pad2(cf)}`, '关联冲突矩阵');
    }
    for (const cid of refs.cognitionIds) {
      if (cid !== card.idNum && validCogNums.has(cid)) addRel('related_to', `C:${cid}`, '关联既有认知卡');
    }

    for (const tid of inferred.topics) {
      if (topicMemberMap.has(tid)) topicMemberMap.get(tid).push(card.id);
    }

    const frontmatter = {
      id: card.id,
      num: card.num,
      title: card.title,
      claim_type: inferred.claim_type,
      status,
      event_date: card.publishDate || card.ingestedAt,
      publish_date: card.publishDate || card.ingestedAt,
      ingested_at: card.ingestedAt,
      updated_at: card.updatedAt,
      valid_until: validUntil,
      next_check_date: nextCheckDate,
      evidence_grades: card.evidenceGrades.length > 0 ? card.evidenceGrades : ['C'],
      primary_grade: card.primaryGrade,
      legacy_grade: card.fields.evidenceLevelRaw,
      confidence_raw: card.fields.confidence,
      topics: inferred.topics,
      chain_nodes: inferred.chain_nodes,
      tickers: entities,
      relations,
      sources_raw: card.fields.source,
      legacy_meta: {
        raw_heading: card.rawHeading,
        original_batch: card.batchTitle,
        batch_order: card.batchOrder,
        original_category_tag: card.categoryTag,
        order_in_source: card.orderInSource,
        anchor_id: card.anchorId,
        source_start_line: card.startLine,
        source_end_line: card.endLine,
        enrichment_status: 'raw_migrated',
      },
    };

    const bodyParts = [];
    if (card.fields.factsEntries.length === 1) {
      bodyParts.push(`## 事实与要点（原件无损迁入）\n${card.fields.factsEntries[0].content}`);
    } else if (card.fields.factsEntries.length > 1) {
      bodyParts.push(
        `## 事实与要点（原件无损迁入）\n${card.fields.factsEntries.map((f) => `- **${f.label}**：${f.content}`).join('\n')}`
      );
    }
    if (card.fields.source) bodyParts.push(`## 来源\n${card.fields.source}`);
    if (card.fields.industryImplications) bodyParts.push(`## 产业含义（分析）\n${card.fields.industryImplications}`);
    if (card.fields.aShareMapping) bodyParts.push(`## A股映射（分析）\n${card.fields.aShareMapping}`);
    if (card.fields.invalidationConditions) bodyParts.push(`## 失效与更新条件\n${card.fields.invalidationConditions}`);
    if (card.fields.relatedLines.length > 0) {
      bodyParts.push(
        `## 原文关联说明\n${card.fields.relatedLines.map((r) => `- **${r.label}**：${r.content}`).join('\n')}`
      );
    }
    if (card.fields.amendments.length > 0) {
      bodyParts.push(
        `## 增订与校准记录\n${card.fields.amendments.map((a) => `- **${a.label}**：${a.content}`).join('\n')}`
      );
    }
    if (card.fields.updateLog) bodyParts.push(`## 原卡更新日志\n${card.fields.updateLog}`);
    if (card.fields.extraFields.length > 0) {
      bodyParts.push(
        `## 附注与补充字段\n${card.fields.extraFields.map((e) => `- **${e.label}**：${e.content}`).join('\n')}`
      );
    }

    const outPath = path.join(targetKbDir, 'cards', 'cognition', `C-${card.idNum}.md`);
    fs.writeFileSync(outPath, stringifyFrontmatter(frontmatter, bodyParts.join('\n\n')), 'utf8');
  }

  // -------------------------------------------------------------------------
  // 4. 写出首批 8 份产业链/宏观主题活视图骨架 topics/T-*.md
  // -------------------------------------------------------------------------
  const defaultEventDate = cParsed.header.syncDate || mParsed.header.syncDate || new Date().toISOString().slice(0, 10);
  for (const t of INITIAL_TOPICS) {
    const members = topicMemberMap.get(t.id) || [];
    const fm = {
      id: t.id,
      title: t.title,
      chain_prefix: t.chain_prefix,
      status: 'dirty',
      last_synthesized_at: null,
      last_card_event_at: defaultEventDate,
      member_count_snapshot: members.length,
    };
    const body = [
      '## 一、当前核心共识与多空张力（待 AI 起草并人工审阅）',
      '> 状态：`dirty`（已完成确定性卡片自动归集，核心共识摘要待审阅生成）。',
      '',
      '<!-- AUTO-GENERATED:START -->',
      '（由 kb-sqlite 同步引擎自动填充）',
      '<!-- AUTO-GENERATED:END -->',
    ].join('\n');
    const outPath = path.join(targetKbDir, 'topics', `T-${t.slug}.md`);
    fs.writeFileSync(outPath, stringifyFrontmatter(fm, body), 'utf8');
  }

  // -------------------------------------------------------------------------
  // 5. 写出独立事件流 events/review-log.jsonl & events/ingestion-log.jsonl
  // -------------------------------------------------------------------------
  fs.writeFileSync(
    path.join(targetKbDir, 'events', 'review-log.jsonl'),
    reviewEventsAll.length > 0 ? reviewEventsAll.map((e) => JSON.stringify(e)).join('\n') + '\n' : '',
    'utf8'
  );

  const allIngestionLogs = [...mParsed.ingestionLogs, ...cParsed.updateLogs];
  fs.writeFileSync(
    path.join(targetKbDir, 'events', 'ingestion-log.jsonl'),
    allIngestionLogs.length > 0 ? allIngestionLogs.map((l) => JSON.stringify(l)).join('\n') + '\n' : '',
    'utf8'
  );

  // -------------------------------------------------------------------------
  // 6. 写出 meta/* 与 kb.manifest.yaml（零个人路径、零私库硬编码）
  // -------------------------------------------------------------------------
  const maxMethodNum = mParsed.cards.reduce((acc, c) => Math.max(acc, c.num), 0);
  const reservedSet = new Set(mParsed.reservedMissing.map((x) => Number(x)));
  let nextMethodNum = maxMethodNum + 1;
  while (reservedSet.has(nextMethodNum)) nextMethodNum++;

  const maxConflictNum = mParsed.conflicts.reduce((acc, c) => Math.max(acc, c.num), 0);
  const maxCogNum = cParsed.cards.reduce((acc, c) => Math.max(acc, c.num), 0);

  const registry = {
    schema_version: '2.0',
    methodology: {
      reserved_missing: mParsed.reservedMissing,
      revoked_tombstones: revokedTombstones,
      aliases: dynamicAliases,
      next_card_num: nextMethodNum,
      next_conflict_num: maxConflictNum + 1,
    },
    cognition: {
      reserved_missing: [],
      next_card_num: maxCogNum + 1,
    },
    legacy_namespaces: /穿透三部曲/.test(mText + cText)
      ? [{ prefix: 'LEGACY:穿透三部曲', note: '台账历史旧库编号引用，不可与现行同号混淆' }]
      : [],
  };
  fs.writeFileSync(path.join(targetKbDir, 'meta', 'registry.yaml'), serializeYamlBlock(registry) + '\n', 'utf8');
  fs.writeFileSync(path.join(targetKbDir, 'meta', 'taxonomy.yaml'), serializeYamlBlock(TAXONOMY) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(targetKbDir, 'meta', 'synonyms.yaml'),
    serializeYamlBlock({ groups: SYNONYM_GROUPS }) + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(targetKbDir, 'meta', 'research-archives.yaml'),
    serializeYamlBlock({ archives: cParsed.researchArchives }) + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(targetKbDir, 'meta', 'appendices.md'),
    mParsed.appendices.length > 0 ? mParsed.appendices.map((a) => a.rawMarkdown).join('\n\n---\n\n') + '\n' : '',
    'utf8'
  );
  fs.writeFileSync(
    path.join(targetKbDir, 'meta', 'legacy-headers.json'),
    JSON.stringify(
      {
        migratedAt: new Date().toISOString(),
        sourceBaseline: {
          methodology: {
            fileName: path.basename(methodPath),
            sha256: mSha,
            bytes: mBuf.length,
            version: mParsed.header.version,
            syncDate: mParsed.header.syncDate,
          },
          cognition: {
            fileName: path.basename(cognitionPath),
            sha256: cSha,
            bytes: cBuf.length,
            version: cParsed.header.version,
            syncDate: cParsed.header.syncDate,
          },
        },
        methodologyHeaderLines: mParsed.header.rawHeaderLines,
        cognitionHeaderLines: cParsed.header.rawHeaderLines,
        methodologySections: mParsed.sections,
        conflictSectionTitle: mParsed.conflictSectionTitle,
        conflictSectionAnchor: mParsed.conflictSectionAnchor,
        cognitionBatches: cParsed.batches,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  const manifest = {
    schema_version: '2.0',
    format: 'v2_card_vault',
    created_at: new Date().toISOString().slice(0, 10),
    source_baseline: {
      methodology_version: mParsed.header.version,
      methodology_sha256: mSha,
      cognition_version: cParsed.header.version,
      cognition_sha256: cSha,
    },
    counts: {
      methodology_files: mParsed.cards.length,
      methodology_active: mParsed.cards.filter((c) => !c.isRevoked).length,
      methodology_revoked: mParsed.cards.filter((c) => c.isRevoked).length,
      conflicts: mParsed.conflicts.length,
      cognition_files: cParsed.cards.length,
      topics: INITIAL_TOPICS.length,
      review_events: reviewEventsAll.length,
      ingestion_logs: allIngestionLogs.length,
    },
  };
  fs.writeFileSync(path.join(targetKbDir, 'kb.manifest.yaml'), serializeYamlBlock(manifest) + '\n', 'utf8');

  return {
    manifest,
    counts: manifest.counts,
    sourceHashes: { methodology: mSha, cognition: cSha },
  };
}

/**
 * 字符级无损迁移核验（逐卡比对全部实质字段 + 缩进子行 + review-log.jsonl）
 */
function verifyLosslessMigration({ kbDir, methodPath, cognitionPath }) {
  const mRaw = fs.readFileSync(methodPath, 'utf8');
  const cRaw = fs.readFileSync(cognitionPath, 'utf8');
  const mOrig = parseMethodSource(mRaw);
  const cOrig = parseCognitionSource(cRaw);

  const reviewLogPath = path.join(kbDir, 'events', 'review-log.jsonl');
  const reviewEvents = fs.existsSync(reviewLogPath)
    ? fs
        .readFileSync(reviewLogPath, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];
  const reviewMap = new Map();
  for (const ev of reviewEvents) {
    if (!reviewMap.has(ev.card_id)) reviewMap.set(ev.card_id, []);
    reviewMap.get(ev.card_id).push(ev);
  }

  const missingMethodCards = [];
  const methodContentDiffs = [];

  for (const orig of mOrig.cards) {
    const file = path.join(kbDir, 'cards', 'methodology', `M-${orig.idNum}.md`);
    if (!fs.existsSync(file)) {
      missingMethodCards.push(orig.id);
      continue;
    }
    const { frontmatter: fm, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const combinedNorm = normalizeForContentCheck(
      body +
        (fm.legacy_credibility?.raw || '') +
        (reviewMap.get(orig.id) || []).map((r) => r.raw_line || r.note).join('')
    );

    const checkFields = [
      ['核心论断', orig.fields.coreThesis],
      ['逻辑链条', orig.fields.logicChain],
      ['适用条件', orig.fields.applicableConditions],
      ['失效信号', orig.fields.invalidationSignals],
      ['历史案例', orig.fields.historicalCases],
      ['可信度', orig.fields.credibilityRaw],
      ['来源', orig.fields.source],
    ];
    for (const [label, val] of checkFields) {
      if (!val) continue;
      if (!combinedNorm.includes(normalizeForContentCheck(val))) {
        methodContentDiffs.push({ card: orig.id, field: label, snippet: val.slice(0, 60) });
      }
    }
    for (const am of orig.fields.amendments) {
      if (!combinedNorm.includes(normalizeForContentCheck(am.content))) {
        methodContentDiffs.push({ card: orig.id, field: `增订:${am.label}`, snippet: am.content.slice(0, 60) });
      }
    }
    for (const rl of orig.fields.reviewLogs) {
      if (!combinedNorm.includes(normalizeForContentCheck(rl.content))) {
        methodContentDiffs.push({ card: orig.id, field: `复盘:${rl.date}`, snippet: rl.content.slice(0, 60) });
      }
    }
    for (const ex of orig.fields.extraFields) {
      if (!combinedNorm.includes(normalizeForContentCheck(ex.content))) {
        methodContentDiffs.push({ card: orig.id, field: `附加:${ex.label}`, snippet: ex.content.slice(0, 60) });
      }
    }
  }

  const missingCognitionCards = [];
  const cognitionContentDiffs = [];
  for (const orig of cOrig.cards) {
    const file = path.join(kbDir, 'cards', 'cognition', `C-${orig.idNum}.md`);
    if (!fs.existsSync(file)) {
      missingCognitionCards.push(orig.id);
      continue;
    }
    const { frontmatter: fm, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const combinedNorm = normalizeForContentCheck(body + (fm.legacy_grade || '') + (fm.confidence_raw || ''));

    for (const fe of orig.fields.factsEntries) {
      if (!combinedNorm.includes(normalizeForContentCheck(fe.content))) {
        cognitionContentDiffs.push({ card: orig.id, field: fe.label, snippet: fe.content.slice(0, 60) });
      }
    }
    const checkFields = [
      ['来源', orig.fields.source],
      ['证据等级', orig.fields.evidenceLevelRaw],
      ['产业含义', orig.fields.industryImplications],
      ['A股映射', orig.fields.aShareMapping],
      ['置信度', orig.fields.confidence],
      ['失效条件', orig.fields.invalidationConditions],
      ['更新日志', orig.fields.updateLog],
    ];
    for (const [label, val] of checkFields) {
      if (!val) continue;
      if (!combinedNorm.includes(normalizeForContentCheck(val))) {
        cognitionContentDiffs.push({ card: orig.id, field: label, snippet: val.slice(0, 60) });
      }
    }
    for (const am of orig.fields.amendments) {
      if (!combinedNorm.includes(normalizeForContentCheck(am.content))) {
        cognitionContentDiffs.push({ card: orig.id, field: `增订:${am.label}`, snippet: am.content.slice(0, 60) });
      }
    }
    for (const ex of orig.fields.extraFields) {
      if (!combinedNorm.includes(normalizeForContentCheck(ex.content))) {
        cognitionContentDiffs.push({ card: orig.id, field: `附加:${ex.label}`, snippet: ex.content.slice(0, 60) });
      }
    }
  }

  const missingConflicts = [];
  const conflictDiffs = [];
  for (const conf of mOrig.conflicts) {
    const file = path.join(kbDir, 'cards', 'conflicts', `CF-${pad2(conf.num)}.md`);
    if (!fs.existsSync(file)) {
      missingConflicts.push(conf.id);
      continue;
    }
    const { body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const combinedNorm = normalizeForContentCheck(body);
    for (const [label, val] of [
      ['双方', conf.sides],
      ['冲突点', conf.conflictPoint],
      ['折中思路', conf.resolution],
    ]) {
      if (val && !combinedNorm.includes(normalizeForContentCheck(val))) {
        conflictDiffs.push({ conflict: conf.id, field: label, snippet: val.slice(0, 60) });
      }
    }
  }

  return {
    ok:
      missingMethodCards.length === 0 &&
      methodContentDiffs.length === 0 &&
      missingCognitionCards.length === 0 &&
      cognitionContentDiffs.length === 0 &&
      missingConflicts.length === 0 &&
      conflictDiffs.length === 0,
    methodChecked: mOrig.cards.length,
    cognitionChecked: cOrig.cards.length,
    conflictsChecked: mOrig.conflicts.length,
    reviewEventsExtracted: reviewEvents.length,
    missingMethodCards,
    methodContentDiffs,
    missingCognitionCards,
    cognitionContentDiffs,
    missingConflicts,
    conflictDiffs,
  };
}

module.exports = {
  runMigration,
  verifyLosslessMigration,
  parseMethodSource,
  parseCognitionSource,
  extractRefs,
  parseReviewVerdict,
  extractReservedMissingIds,
};
