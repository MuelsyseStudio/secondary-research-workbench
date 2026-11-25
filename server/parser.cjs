'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PATHS } = require('./app-paths.cjs');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function splitLines(text) {
  return text.split(/\r?\n/);
}

function pad3(n) {
  return String(Number(n)).padStart(3, '0');
}

function uniqueSorted(arr) {
  return [...new Set(arr)].sort();
}

/**
 * 提取文本中的三库显式引用（方法论卡片、认知卡、冲突）
 */
function extractReferences(text, options = {}) {
  const { skipLegacyMethod = false } = options;
  const methodIds = new Set();
  const cognitionIds = new Set();
  const conflictIds = new Set();

  if (!text) return { methodIds: [], cognitionIds: [], conflictIds: [] };

  // 1. 显式锚点链接 (#method-001, #cognition-044, #conflict-24)
  for (const m of text.matchAll(/#method-(\d{3})/g)) methodIds.add(m[1]);
  for (const m of text.matchAll(/#cognition-(\d{3})/g)) cognitionIds.add(m[1]);
  for (const m of text.matchAll(/#conflict-(\d+)/g)) conflictIds.add(String(Number(m[1])));

  // 2. 认知卡引用：认知卡015、017、130、131 / 认知084 / 认知卡[044]
  for (const m of text.matchAll(/认知卡?\s*([0-9]{3}(?:[、/／,，\-—–~及和与\s]+(?:\[)?[0-9]{3}(?:\])?(?:\(#cognition-[0-9]{3}\))?)*)/g)) {
    const seg = m[1];
    expandIdSegment(seg, cognitionIds);
  }

  // 3. 冲突引用：冲突23 / 冲突 24
  for (const m of text.matchAll(/冲突\s*(\d{1,2})/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 99) conflictIds.add(String(n));
  }

  // 4. 方法论卡片引用
  if (!skipLegacyMethod) {
    for (const m of text.matchAll(/(?:方法论)?卡片\s*([0-9]{3}(?:[、/／,，\-—–~及和与\s]+[0-9]{3})*)/g)) {
      expandIdSegment(m[1], methodIds);
    }
    for (const m of text.matchAll(/关联方法论卡片[：:]\s*([^\n；;。]+)/g)) {
      expandIdSegment(m[1], methodIds);
    }
  }

  return {
    methodIds: uniqueSorted([...methodIds]),
    cognitionIds: uniqueSorted([...cognitionIds]),
    conflictIds: [...conflictIds].sort((a, b) => Number(a) - Number(b)),
  };
}

function expandIdSegment(seg, targetSet) {
  // 处理区间如 196-198 或 135—137
  const rangeRe = /(\d{3})\s*[—–\-~]\s*(\d{3})/g;
  for (const rm of seg.matchAll(rangeRe)) {
    const start = Number(rm[1]);
    const end = Number(rm[2]);
    if (end >= start && end - start <= 15) {
      for (let i = start; i <= end; i++) targetSet.add(pad3(i));
    }
  }
  for (const nm of seg.matchAll(/\b(\d{3})\b/g)) {
    const n = Number(nm[1]);
    if (n >= 1 && n <= 500) targetSet.add(pad3(n));
  }
}

/**
 * 解析文件头部的版本、同步日期、修订摘要等元数据
 */
function parseHeaderMeta(lines) {
  const metaLines = [];
  for (let i = 0; i < Math.min(lines.length, 45); i++) {
    const line = lines[i];
    if (/^## 完整目录/.test(line) || /^## 研究观点归档/.test(line)) break;
    if (line.startsWith('> ') || line.startsWith('<!--')) metaLines.push(line);
  }
  const joined = metaLines.join('\n');
  const versionMatch = joined.match(/>\s*版本[：:]\s*(v\d+(?:\.\d+)*)/);
  const syncMatch = joined.match(/同步日期[：:]\s*(\d{4}-\d{2}-\d{2})/);
  const latestReviewMatch = joined.match(/日度复盘(?:仍)?截至\s*(\d{4}-\d{2}-\d{2})|最新日度正文(?:仍为|对应)\s*(\d{4}-\d{2}-\d{2})/);
  const companionLine = metaLines.find((l) => /^>\s*(?:配套现行文件|关联文件)[：:]/.test(l)) || '';
  const revisionSummaries = metaLines
    .filter((l) => /^>\s*v\d+(?:\.\d+)*\+?\s*(?:修订摘要|质检修复|版本基线)/.test(l) || /^>\s*\d{4}-\d{2}-\d{2}\s*增订摘要/.test(l))
    .map((l) => l.replace(/^>\s*/, ''));

  const htmlComment = lines[0]?.startsWith('<!--') ? lines[0] : '';

  return {
    version: versionMatch ? versionMatch[1] : 'unknown',
    syncDate: syncMatch ? syncMatch[1] : '',
    latestReviewDate: latestReviewMatch ? (latestReviewMatch[1] || latestReviewMatch[2]) : '',
    companionLine: companionLine.replace(/^>\s*/, ''),
    revisionSummaries,
    htmlComment,
  };
}

/**
 * 从方法论库文件头部/目录区动态提取显式声明的保留缺号（如 "150为声明缺号"、"声明缺号：002"），零硬编码私库编号
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

  // 形如 "150为声明缺号" / "150、153为声明缺号" / "002 为保留缺号" / "150 缺号保留"
  for (const m of text.matchAll(/(?:^|[^0-9])(\d{3}(?:[、/／,，及和与\s]+\d{3})*)\s*(?:号|卡)?\s*(?:为|是)?\s*(?:永久)?(?:(?:声明|保留)缺号|缺号(?:保留|声明))/g)) {
    addDigits(m[1]);
  }

  // 形如 "声明缺号：002、005" / "保留缺号 002" / "缺号 002" / "（缺号 002）" / "缺号：002、003"
  for (const m of text.matchAll(/(?:(?:声明|保留)?缺号(?:声明|保留)?)(?:[：:]\s*|\s+)(\d{3}(?:[、/／,，及和与\s]+\d{3})*)/g)) {
    addDigits(m[1]);
  }

  return uniqueSorted([...reserved]);
}

/**
 * 解析《方法论卡片库.md》
 */
function parseMethodology(rawText) {
  const lines = splitLines(rawText);
  const meta = parseHeaderMeta(lines);

  // 找到正文起点（第一个 # 第一编）
  const bodyStartIdx = lines.findIndex((l) => /^# 第一编/.test(l));
  const startScan = bodyStartIdx >= 0 ? bodyStartIdx : 0;
  const reservedMissing = extractReservedMissingIds(lines.slice(0, startScan > 0 ? startScan : Math.min(lines.length, 45)));

  const sections = [];
  const cards = [];
  const conflicts = [];
  const ingestionLogs = [];
  const tocEntries = [];

  // 解析完整目录表用于质检对照
  for (let i = 0; i < startScan; i++) {
    const tm = lines[i].match(/^\|\s*H(\d)\s*\|\s*\[(.+?)\]\(#([a-zA-Z0-9_-]+)\)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/);
    if (tm) {
      tocEntries.push({
        level: Number(tm[1]),
        title: tm[2].replace(/\\\|/g, '|'),
        anchor: tm[3],
        status: tm[4],
        sourceLine: tm[5],
        line: i + 1,
      });
    }
  }

  let currentSection = { title: '未分编', anchor: '', index: 0, startLine: startScan + 1 };
  const h1Indexes = [];
  const h2Blocks = [];

  for (let i = startScan; i < lines.length; i++) {
    const line = lines[i];
    if (/^# /.test(line)) {
      const anchorLine = i >= 2 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 2]) ? lines[i - 2].match(/^<a id="([^"]+)"><\/a>$/)[1] : '';
      const title = line.slice(2).trim();
      h1Indexes.push({ lineIdx: i, title, anchor: anchorLine });
      if (/^第.+编/.test(title)) {
        currentSection = { title, anchor: anchorLine, index: sections.length + 1, startLine: i + 1 };
        sections.push(currentSection);
      } else if (/^入库清单/.test(title)) {
        ingestionLogs.push({ title, anchor: anchorLine, startLine: i + 1, lineIdx: i });
      }
    } else if (/^## /.test(line)) {
      h2Blocks.push({ lineIdx: i, heading: line, sectionTitle: currentSection.title, sectionIndex: currentSection.index });
    }
  }

  // 计算每个 H2 块的结束行（到下一个 # 或 ## 或 <a id=...> 前）
  for (let idx = 0; idx < h2Blocks.length; idx++) {
    const block = h2Blocks[idx];
    let endIdx = lines.length - 1;
    for (let j = block.lineIdx + 1; j < lines.length; j++) {
      if (/^#{1,2} /.test(lines[j])) {
        endIdx = j - 1;
        break;
      }
    }
    // 去掉末尾紧贴下一标题的锚点行与分隔线
    while (endIdx > block.lineIdx && (lines[endIdx].trim() === '' || lines[endIdx].trim() === '---' || /^<a id="[^"]+"><\/a>$/.test(lines[endIdx].trim()))) {
      endIdx--;
    }

    const blockLines = lines.slice(block.lineIdx, endIdx + 1);
    const rawMarkdown = blockLines.join('\n');

    // 检查是否方法论卡片
    const cardMatch = block.heading.match(/^## 卡片 (\d{3})\s*\|(.*)$/);
    if (cardMatch) {
      const id = cardMatch[1];
      const rawTitlePart = cardMatch[2].trim();
      // 去掉末尾冗余的同号数字（例如 "宏观周期001" -> "宏观周期"）
      const cleanTitlePart = rawTitlePart.endsWith(id)
        ? rawTitlePart.slice(0, -id.length).trim()
        : rawTitlePart;

      const batchMatch = cleanTitlePart.match(/【([^】]+)】/g);
      const batchTag = batchMatch ? batchMatch.join('') : '';
      const titleNoTag = cleanTitlePart.replace(/【[^】]+】/g, '').trim();
      const sysMatch = titleNoTag.match(/^([^（(：:]+?)(?:[（(](.+)[）)]|[：:](.+))$/);
      const system = sysMatch ? sysMatch[1].trim() : block.sectionTitle.replace(/^第.+?编\s*/, '').split('（')[0].trim();
      const topic = sysMatch ? (sysMatch[2] || sysMatch[3] || titleNoTag).trim() : titleNoTag;

      const fields = {
        coreThesis: '',
        logicChain: '',
        applicableConditions: '',
        invalidationSignals: '',
        historicalCases: '',
        credibilityRaw: '',
        source: '',
        otherFields: [],
      };
      const amendments = [];
      const reviewLogs = [];

      for (let k = 1; k < blockLines.length; k++) {
        const bl = blockLines[k];
        if (!bl.startsWith('- ')) continue;
        const body = bl.slice(2);
        const colonIdx = body.search(/[：:]/);
        if (colonIdx === -1) {
          fields.otherFields.push({ label: '说明', content: body });
          continue;
        }
        const key = body.slice(0, colonIdx).replace(/^\*\*|\*\*$/g, '').trim();
        const val = body.slice(colonIdx + 1).trim();

        if (key === '核心论断') fields.coreThesis = val;
        else if (key === '逻辑链条') fields.logicChain = val;
        else if (key === '适用条件') fields.applicableConditions = val;
        else if (key === '失效信号') fields.invalidationSignals = val;
        else if (key === '历史案例') fields.historicalCases = val;
        else if (key === '可信度') fields.credibilityRaw = val;
        else if (key === '来源') fields.source = val;
        else if (/^复盘(?:记录|日志)/.test(key)) {
          const dm = key.match(/(\d{4}-\d{2}-\d{2})/) || val.match(/(\d{4}-\d{2}-\d{2})/);
          reviewLogs.push({ label: key, date: dm ? dm[1] : '', content: val, line: block.lineIdx + k + 1 });
        } else if (/增订|修订|补充/.test(key)) {
          amendments.push({ label: key, content: val, line: block.lineIdx + k + 1 });
        } else {
          fields.otherFields.push({ label: key, content: val });
        }
      }

      const scoreMatch = fields.credibilityRaw.match(/(\d+(?:\.\d+)?)/);
      const credibilityScore = scoreMatch ? parseFloat(scoreMatch[1]) : null;
      const isRevoked = /已撤销|已并入卡片|撤销.*保留不复用|【撤销】/.test(block.heading);
      const combinedStatus = `${block.heading} ${fields.credibilityRaw} ${reviewLogs.slice(-2).map((r) => r.content).join(' ')}`;
      const isArchived = /封存/.test(combinedStatus);
      const isHighPaused = /高位暂停|暂停上调/.test(combinedStatus);
      const isPendingVerify = /【(?:部分)?待核/.test(`${block.heading} ${fields.credibilityRaw} ${fields.source}`);
      const isPendingRetire = (credibilityScore !== null && credibilityScore < 0.3) || /【待淘汰】/.test(combinedStatus);

      const refs = extractReferences(rawMarkdown);
      // 剔除自身引用
      refs.methodIds = refs.methodIds.filter((x) => x !== id);

      cards.push({
        id,
        num: Number(id),
        rawHeading: block.heading,
        title: titleNoTag || cleanTitlePart,
        system,
        topic,
        batchTag,
        sectionTitle: block.sectionTitle,
        sectionIndex: block.sectionIndex,
        anchorId: `method-${id}`,
        startLine: block.lineIdx + 1,
        endLine: endIdx + 1,
        ...fields,
        credibilityScore,
        isRevoked,
        isArchived,
        isHighPaused,
        isPendingVerify,
        isPendingRetire,
        amendments,
        reviewLogs,
        references: refs,
        rawMarkdown,
      });
      continue;
    }

    // 检查是否冲突条目
    const conflictMatch = block.heading.match(/^## 冲突 (\d+)(?:（([^）]+)）)?[：:]\s*(.+)$/);
    if (conflictMatch) {
      const id = Number(conflictMatch[1]);
      const versionTag = conflictMatch[2] || '';
      const title = conflictMatch[3].trim();
      let sides = '';
      let conflictPoint = '';
      let resolution = '';
      for (let k = 1; k < blockLines.length; k++) {
        const bl = blockLines[k].replace(/^- \*\*([^*]+)\*\*/, '- $1');
        if (/^- (?:冲突)?双方[：:]/.test(bl)) sides = bl.replace(/^- (?:冲突)?双方[：:]\s*/, '');
        else if (/^- 冲突点[：:]/.test(bl)) conflictPoint = bl.replace(/^- 冲突点[：:]\s*/, '');
        else if (/^- (?:折中思路|判别与折中|折中|解决原则)[：:]/.test(bl)) {
          resolution = bl.replace(/^- (?:折中思路|判别与折中|折中|解决原则)[：:]\s*/, '');
        }
      }
      const refs = extractReferences(rawMarkdown);
      conflicts.push({
        id,
        anchorId: `conflict-${id}`,
        rawHeading: block.heading,
        title,
        versionTag,
        sides,
        conflictPoint,
        resolution,
        relatedMethodIds: refs.methodIds,
        relatedCognitionIds: refs.cognitionIds,
        startLine: block.lineIdx + 1,
        endLine: endIdx + 1,
        rawMarkdown,
      });
    }
  }

  // 解析入库清单内容
  for (const log of ingestionLogs) {
    let endIdx = lines.length - 1;
    for (let j = log.lineIdx + 1; j < lines.length; j++) {
      if (/^# /.test(lines[j])) {
        endIdx = j - 1;
        break;
      }
    }
    log.content = lines.slice(log.lineIdx + 1, endIdx + 1).join('\n').trim();
  }

  // 按编号排序的副本及统计（分别解析显式声明保留号与编号推导空缺，下一可用编号自动跳过所有保留号）
  const activeCards = cards.filter((c) => !c.isRevoked);
  const maxCardNum = cards.reduce((acc, c) => Math.max(acc, c.num), 0);
  const maxConflictNum = conflicts.reduce((acc, c) => Math.max(acc, c.id), 0);
  const presentNums = new Set(cards.map((c) => c.num).filter((n) => Number.isFinite(n) && n > 0));
  const reservedNumSet = new Set(
    reservedMissing.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)
  );
  const numberGaps = [];
  if (cards.length > 0 && maxCardNum > 0) {
    for (let n = 1; n <= maxCardNum; n++) {
      if (!presentNums.has(n)) numberGaps.push(pad3(n));
    }
  }
  const declaredMissing = uniqueSorted([...reservedMissing, ...numberGaps]);
  let nextCardNum = maxCardNum + 1;
  while (presentNums.has(nextCardNum) || reservedNumSet.has(nextCardNum)) {
    nextCardNum += 1;
  }

  return {
    meta,
    fileSize: Buffer.byteLength(rawText, 'utf8'),
    lineCount: lines.length,
    sha256: sha256(rawText),
    stats: {
      totalTitles: cards.length,
      activeCount: activeCards.length,
      revokedCount: cards.filter((c) => c.isRevoked).length,
      reservedMissing,
      numberGaps,
      declaredMissing,
      conflictCount: conflicts.length,
      sectionCount: sections.length,
      nextCardId: pad3(nextCardNum),
      nextConflictId: maxConflictNum + 1,
      highCredCount: activeCards.filter((c) => (c.credibilityScore ?? 0) >= 0.7).length,
      withReviewsCount: activeCards.filter((c) => c.reviewLogs.length > 0).length,
      pendingVerifyCount: activeCards.filter((c) => c.isPendingVerify).length,
      pendingRetireCount: activeCards.filter((c) => c.isPendingRetire).length,
    },
    sections,
    cards,
    conflicts,
    ingestionLogs: ingestionLogs.map(({ lineIdx, ...rest }) => rest),
    tocEntries,
  };
}

/**
 * 解析《行业前沿认知库.md》
 */
function parseCognition(rawText) {
  const lines = splitLines(rawText);
  const meta = parseHeaderMeta(lines);

  // 解析研究观点归档
  const researchArchives = [];
  const archStart = lines.findIndex((l) => /^## 研究观点归档/.test(l));
  const tocStart = lines.findIndex((l) => /^## 完整目录/.test(l));
  if (archStart >= 0 && tocStart > archStart) {
    for (let i = archStart + 1; i < tocStart; i++) {
      const m = lines[i].match(/^- (\d{4}-\d{2}-\d{2})\s*·\s*\[(.+?)\]\(<?([^)>]+)>?\)\s*·?\s*(.*)$/);
      if (m) {
        const resolved = path.resolve(PATHS.currentDir, m[3]);
        researchArchives.push({
          date: m[1],
          title: m[2],
          relativePath: m[3],
          exists: fs.existsSync(resolved),
          summary: m[4].trim(),
        });
      }
    }
  }

  const bodyStartIdx = lines.findIndex((l) => /^# 第一编/.test(l));
  const startScan = bodyStartIdx >= 0 ? bodyStartIdx : 0;

  const tocEntries = [];
  for (let i = 0; i < startScan; i++) {
    const tm = lines[i].match(/^\|\s*H(\d)\s*\|\s*\[(.+?)\]\(#([a-zA-Z0-9_-]+)\)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/);
    if (tm) {
      tocEntries.push({
        level: Number(tm[1]),
        title: tm[2].replace(/\\\|/g, '|'),
        anchor: tm[3],
        status: tm[4],
        sourceLine: tm[5],
        line: i + 1,
      });
    }
  }

  const batches = [];
  const cards = [];
  const updateLogs = [];
  let currentBatch = { title: '第一编 AI算力', anchor: '', startLine: startScan + 1 };
  const h2Blocks = [];

  for (let i = startScan; i < lines.length; i++) {
    const line = lines[i];
    if (/^# /.test(line)) {
      const anchorLine = i >= 2 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 2]) ? lines[i - 2].match(/^<a id="([^"]+)"><\/a>$/)[1] : '';
      currentBatch = { title: line.slice(2).trim(), anchor: anchorLine, startLine: i + 1 };
      batches.push(currentBatch);
    } else if (/^## /.test(line)) {
      h2Blocks.push({ lineIdx: i, heading: line, batchTitle: currentBatch.title });
    }
  }

  for (let idx = 0; idx < h2Blocks.length; idx++) {
    const block = h2Blocks[idx];
    let endIdx = lines.length - 1;
    for (let j = block.lineIdx + 1; j < lines.length; j++) {
      if (/^#{1,2} /.test(lines[j])) {
        endIdx = j - 1;
        break;
      }
    }
    while (endIdx > block.lineIdx && (lines[endIdx].trim() === '' || lines[endIdx].trim() === '---' || /^<a id="[^"]+"><\/a>$/.test(lines[endIdx].trim()))) {
      endIdx--;
    }

    const blockLines = lines.slice(block.lineIdx, endIdx + 1);
    const rawMarkdown = blockLines.join('\n');

    if (/^## 更新日志/.test(block.heading)) {
      updateLogs.push({
        title: block.heading.slice(3).trim(),
        content: blockLines.slice(1).join('\n').trim(),
        startLine: block.lineIdx + 1,
      });
      continue;
    }

    const cardMatch = block.heading.match(/^## 认知卡 (\d{3})\s*\|(.*)$/);
    if (!cardMatch) continue;

    const id = cardMatch[1];
    const rawRest = cardMatch[2].trim();
    const dateMatch = rawRest.match(/(\d{4}-\d{2}-\d{2})\s*入库/);
    const ingestedDate = dateMatch ? dateMatch[1] : '';
    const catMatch = rawRest.match(/（([^）]*增补[^）]*|[^）]*核心卡[^）]*|[^）]*线[^）]*)）/);
    const categoryTag = catMatch ? catMatch[1] : '';
    const updatedMatch = rawRest.match(/【已更新→(?:卡号)?(\d{3})】/) || rawMarkdown.match(/【已更新→(?:卡号)?(\d{3})】/);
    const isPartiallyFalsified = /部分证伪/.test(rawRest);
    const isArchived = /整卡归档|已过期/.test(rawRest);
    const title = rawRest
      .replace(/【[^】]+】/g, '')
      .replace(/（(?:第[^）]+增补|[^）]*增补[^）]*)）/g, '')
      .trim();

    const fields = {
      facts: '',
      source: '',
      evidenceLevelRaw: '',
      industryImplications: '',
      aShareMapping: '',
      confidence: '',
      invalidationConditions: '',
      updateLog: '',
      relatedRaw: '',
      otherFields: [],
    };
    const amendments = [];

    for (let k = 1; k < blockLines.length; k++) {
      const bl = blockLines[k];
      if (!bl.startsWith('- ')) continue;
      const body = bl.slice(2);
      const colonIdx = body.search(/[：:]/);
      if (colonIdx === -1) {
        fields.otherFields.push({ label: '说明', content: body });
        continue;
      }
      const key = body.slice(0, colonIdx).replace(/^\*\*|\*\*$/g, '').trim();
      const val = body.slice(colonIdx + 1).trim();

      if (/^(?:核心)?事实/.test(key)) fields.facts = fields.facts ? `${fields.facts}\n${val}` : val;
      else if (key === '来源') fields.source = val;
      else if (key === '证据等级') fields.evidenceLevelRaw = val;
      else if (/^产业含义/.test(key)) fields.industryImplications = val;
      else if (/^A\s*股映射/.test(key)) fields.aShareMapping = val;
      else if (key === '置信度') fields.confidence = val;
      else if (/失效|更新条件|证伪条件/.test(key)) fields.invalidationConditions = val;
      else if (key === '更新日志') fields.updateLog = val;
      else if (/^关联/.test(key)) fields.relatedRaw = fields.relatedRaw ? `${fields.relatedRaw}；${key}：${val}` : `${key}：${val}`;
      else if (/增订|更新|补充|校准|复核/.test(key)) {
        amendments.push({ label: key, content: val, line: block.lineIdx + k + 1 });
      } else {
        fields.otherFields.push({ label: key, content: val });
      }
    }

    // 提炼主证据等级 A / B / C
    const evidenceGrades = [];
    if (/(?:^|[^A-Za-z])A[+\-]?(?:$|[^A-Za-z])/.test(fields.evidenceLevelRaw)) evidenceGrades.push('A');
    if (/(?:^|[^A-Za-z])B[+\-]?(?:$|[^A-Za-z])/.test(fields.evidenceLevelRaw)) evidenceGrades.push('B');
    if (/(?:^|[^A-Za-z])C[+\-]?(?:$|[^A-Za-z])/.test(fields.evidenceLevelRaw)) evidenceGrades.push('C');
    const primaryGrade = evidenceGrades[0] || 'U';

    const refs = extractReferences(rawMarkdown);
    refs.cognitionIds = refs.cognitionIds.filter((x) => x !== id);

    // 额外从 "关联方法论卡片：159、177" 与 "关联认知卡：044、045" 精确提取
    const mRelMatch = rawMarkdown.match(/- 关联(?:方法论)?卡片[：:]\s*([^\n]+)/);
    if (mRelMatch) {
      const mSet = new Set(refs.methodIds);
      const beforeCog = mRelMatch[1].split(/关联认知卡/)[0];
      expandIdSegment(beforeCog, mSet);
      refs.methodIds = uniqueSorted([...mSet]);
    }
    const cRelMatch = rawMarkdown.match(/关联认知卡[：:]\s*([^\n；;]+)/);
    if (cRelMatch) {
      const cSet = new Set(refs.cognitionIds);
      const beforeMethod = cRelMatch[1].split(/关联(?:方法论)?卡片/)[0];
      expandIdSegment(beforeMethod, cSet);
      cSet.delete(id);
      refs.cognitionIds = uniqueSorted([...cSet]);
    }

    cards.push({
      id,
      num: Number(id),
      rawHeading: block.heading,
      title,
      ingestedDate,
      categoryTag,
      batchTitle: block.batchTitle,
      anchorId: `cognition-${id}`,
      startLine: block.lineIdx + 1,
      endLine: endIdx + 1,
      ...fields,
      evidenceGrades,
      primaryGrade,
      isArchived,
      isPartiallyFalsified,
      updatedToId: updatedMatch ? updatedMatch[1] : null,
      amendments,
      references: refs,
      rawMarkdown,
    });
  }

  const maxNum = cards.reduce((acc, c) => Math.max(acc, c.num), 0);
  return {
    meta,
    fileSize: Buffer.byteLength(rawText, 'utf8'),
    lineCount: lines.length,
    sha256: sha256(rawText),
    stats: {
      totalCount: cards.length,
      nextCardId: pad3(maxNum + 1),
      gradeACount: cards.filter((c) => c.evidenceGrades.includes('A')).length,
      gradeBCount: cards.filter((c) => c.evidenceGrades.includes('B')).length,
      gradeCCount: cards.filter((c) => c.evidenceGrades.includes('C')).length,
      archivedCount: cards.filter((c) => c.isArchived).length,
      falsifiedCount: cards.filter((c) => c.isPartiallyFalsified).length,
      withAmendmentsCount: cards.filter((c) => c.amendments.length > 0).length,
      batchCount: batches.length,
    },
    researchArchives,
    batches,
    cards,
    updateLogs,
    tocEntries,
  };
}

/**
 * 解析《研判与复盘台账.md》
 */
function parseLedger(rawText) {
  const lines = splitLines(rawText);
  const meta = parseHeaderMeta(lines);

  // 解析头部复盘框架增订 ①-⑥
  const frameworkAmendments = [];
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const m = lines[i].match(/^>\s*([①②③④⑤⑥⑦⑧])(.+)$/);
    if (m) frameworkAmendments.push({ index: m[1], text: m[2].trim() });
  }

  const firstEntryIdx = lines.findIndex((l) => /^## 研判记录 #001/.test(l));
  const startScan = firstEntryIdx >= 0 ? firstEntryIdx : 0;

  const tocEntries = [];
  for (let i = 0; i < startScan; i++) {
    const tm = lines[i].match(/^\|\s*H(\d)\s*\|\s*\[(.+?)\]\(#([a-zA-Z0-9_-]+)\)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/);
    if (tm) {
      tocEntries.push({
        level: Number(tm[1]),
        title: tm[2].replace(/\\\|/g, '|'),
        anchor: tm[3],
        status: tm[4],
        sourceLine: tm[5],
        line: i + 1,
      });
    }
  }

  const h2Blocks = [];
  for (let i = startScan; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      let anchorLine = '';
      if (i >= 1 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 1].trim())) {
        anchorLine = lines[i - 1].trim().match(/^<a id="([^"]+)"><\/a>$/)[1];
      } else if (i >= 2 && /^<a id="([^"]+)"><\/a>$/.test(lines[i - 2].trim())) {
        anchorLine = lines[i - 2].trim().match(/^<a id="([^"]+)"><\/a>$/)[1];
      }
      h2Blocks.push({ lineIdx: i, heading: lines[i], anchor: anchorLine });
    }
  }

  const judgments = [];
  const backfills = [];
  const dailyReviews = [];
  const specialEntries = [];

  for (let idx = 0; idx < h2Blocks.length; idx++) {
    const block = h2Blocks[idx];
    let endIdx = lines.length - 1;
    for (let j = block.lineIdx + 1; j < lines.length; j++) {
      if (/^## /.test(lines[j])) {
        endIdx = j - 1;
        break;
      }
    }
    while (endIdx > block.lineIdx && (lines[endIdx].trim() === '' || lines[endIdx].trim() === '---' || /^<a id="[^"]+"><\/a>$/.test(lines[endIdx].trim()))) {
      endIdx--;
    }

    const blockLines = lines.slice(block.lineIdx, endIdx + 1);
    const rawMarkdown = blockLines.join('\n');
    const title = block.heading.slice(3).trim();

    // 拆分内部 ### 小节
    const subsections = [];
    let curSub = null;
    for (let k = 1; k < blockLines.length; k++) {
      const bl = blockLines[k];
      if (/^<a id="[^"]+"><\/a>$/.test(bl.trim())) continue;
      if (/^### /.test(bl)) {
        curSub = { title: bl.slice(4).trim(), lines: [] };
        subsections.push(curSub);
      } else if (curSub) {
        curSub.lines.push(bl);
      }
    }
    const formattedSubsections = subsections.map((s) => ({
      title: s.title,
      content: s.lines.join('\n').trim(),
    }));

    // 1. 日度复盘记录
    const dailyMatch = title.match(/^复盘记录 (\d{4}-\d{2}-\d{2})(?:（(.*)）)?$/);
    if (dailyMatch) {
      const date = dailyMatch[1];
      const subtitleFull = dailyMatch[2] || '';
      const shortHeadline = subtitleFull.split(/[：:]/)[0].trim() || `日度复盘 ${date}`;

      // 提取评分 x/10
      const scoreMatch =
        rawMarkdown.match(/(?:盘面评分|大盘整体评分)[^0-9\n]{0,40}\*{0,2}([0-9]+(?:\.[0-9]+)?)\s*\/\s*10/) ||
        rawMarkdown.match(/评分[：:]\s*\*{0,2}([0-9]+(?:\.[0-9]+)?)\s*\/\s*10/);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

      // 提取市场状态行
      const stateMatch = rawMarkdown.match(/- \*\*市场状态\*\*[：:]\s*([^\n]+)/);
      const marketState = stateMatch ? stateMatch[1].trim() : '';

      // 提取次日跟踪锚
      const nextAnchorMatch = rawMarkdown.match(/- \*\*[^*]*跟踪锚\*\*[：:]\s*([^\n]+)/);
      const nextAnchorsRaw = nextAnchorMatch ? nextAnchorMatch[1].trim() : '';
      const nextAnchors = nextAnchorsRaw
        ? nextAnchorsRaw.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩])/).map((s) => s.replace(/[；;]\s*$/, '').trim()).filter(Boolean)
        : [];

      // 提取缺口登记
      const gapMatch = rawMarkdown.match(/\*\*缺口登记[^*]*\*\*[：:]\s*([^\n]+)/);
      const gapsRaw = gapMatch ? gapMatch[1].trim() : '';
      const gaps = gapsRaw
        ? gapsRaw.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩⑪⑫])/).map((s) => s.replace(/[；;]\s*$/, '').trim()).filter(Boolean)
        : [];

      // 提取优化建议行
      const optMatch = rawMarkdown.match(/\*\*优化建议（待拍板[^*]*\*\*[：:]\s*([^\n]+)/);
      const pendingOptNote = optMatch ? optMatch[1].trim() : '';

      // 提取第六节锚核对表格
      const anchorChecks = [];
      const tableRe = /^\|\s*([①②③④⑤⑥⑦⑧⑨⑩][^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|$/gm;
      for (const tm of rawMarkdown.matchAll(tableRe)) {
        anchorChecks.push({
          anchor: tm[1].trim(),
          preset: tm[2].trim(),
          evidence: tm[3].trim(),
          verdict: tm[4].replace(/\*\*/g, '').trim(),
        });
      }

      // 提取第七节卡片可信度记录
      const credSection = formattedSubsections.find((s) => /卡片可信度/.test(s.title));
      const credibilityEntries = [];
      if (credSection) {
        for (const cl of credSection.content.split('\n')) {
          const cm = cl.match(/^- (\d{3})（([^）]+)）[：:]\s*(.+)$/);
          if (cm) {
            credibilityEntries.push({ cardId: cm[1], statusText: cm[2], detail: cm[3] });
          }
        }
      }

      const refs = extractReferences(rawMarkdown);
      // 也把第七节里明确列出的高频卡纳入引用
      const mSet = new Set(refs.methodIds);
      for (const ce of credibilityEntries) mSet.add(ce.cardId);
      refs.methodIds = uniqueSorted([...mSet]);

      dailyReviews.push({
        id: `daily-${date}`,
        type: 'daily',
        date,
        title: shortHeadline,
        fullTitle: title,
        anchor: block.anchor,
        score,
        marketState,
        nextAnchors,
        gaps,
        pendingOptNote,
        anchorChecks,
        credibilityEntries,
        subsections: formattedSubsections,
        references: refs,
        startLine: block.lineIdx + 1,
        endLine: endIdx + 1,
        rawMarkdown,
      });
      continue;
    }

    // 2. 标的研判记录
    const judgeMatch = title.match(/^研判记录 (#\d+[a-zA-Z]*)(.*)$/);
    if (judgeMatch) {
      const recordKey = judgeMatch[1];
      const suffix = judgeMatch[2].trim();
      const targetMatch = rawMarkdown.match(/^- (?:标的|观察标的|核心标的)[：:]\s*([^\n]+)/m);
      const dateMatch = rawMarkdown.match(/^- 研判日期[：:]\s*(\d{4}-\d{2}-\d{2})/m) || title.match(/(\d{4}-\d{2}-\d{2})/);
      const scoreMatch = rawMarkdown.match(/^- (?:综合)?评分[：:]\s*\*{0,2}([0-9]+(?:\.[0-9]+)?)\s*\/\s*10/m);
      const conclusionMatch = rawMarkdown.match(/^- 一句话结论[：:]\s*([^\n]+)/m);
      const isLegacyRef = /穿透三部曲旧库|旧库编号/.test(rawMarkdown);

      // 提取关键假设清单 A1/B1/C1...
      const hypotheses = [];
      for (const hm of rawMarkdown.matchAll(/^\s*- ([A-Z]\d+|H\d+)[：:]\s*(.+)$/gm)) {
        hypotheses.push({ id: hm[1], content: hm[2].trim() });
      }

      const refs = extractReferences(rawMarkdown, { skipLegacyMethod: isLegacyRef && !/现行库/.test(rawMarkdown) });
      // 从 `- 引用卡片（方法论）：067/074/...` 精细提取
      const refLine = rawMarkdown.match(/^- 引用卡片（方法论）[：:]\s*([^\n]+)/m);
      if (refLine) {
        const mSet = new Set(refs.methodIds);
        const beforeCog = refLine[1].split(/；认知卡|;认知卡/)[0];
        expandIdSegment(beforeCog, mSet);
        refs.methodIds = uniqueSorted([...mSet]);
      }

      judgments.push({
        id: `judge-${recordKey.replace('#', '')}-${block.lineIdx}`,
        type: 'judgment',
        recordKey,
        title,
        suffix,
        target: targetMatch ? targetMatch[1].trim() : title,
        date: dateMatch ? dateMatch[1] : '',
        score: scoreMatch ? parseFloat(scoreMatch[1]) : null,
        conclusion: conclusionMatch ? conclusionMatch[1].trim() : '',
        hypotheses,
        isLegacyRef,
        anchor: block.anchor,
        subsections: formattedSubsections,
        references: refs,
        startLine: block.lineIdx + 1,
        endLine: endIdx + 1,
        rawMarkdown,
      });
      continue;
    }

    // 3. 编号复盘回填
    const backfillMatch = title.match(/^复盘(?:记录|回填) (#\d+[a-zA-Z]*)(.*)$/);
    if (backfillMatch) {
      const recordKey = backfillMatch[1];
      const dateMatch = title.match(/(\d{4}-\d{2}-\d{2})/) || rawMarkdown.match(/复盘日[期]?\s*(\d{4}-\d{2}-\d{2})/);
      const isPostHoc = /事后复盘，无事前/.test(title);
      const isLegacyRef = /旧库/.test(rawMarkdown) && ['#001', '#002', '#003a'].includes(recordKey);
      const refs = extractReferences(rawMarkdown, { skipLegacyMethod: isLegacyRef });
      backfills.push({
        id: `backfill-${recordKey.replace('#', '')}-${block.lineIdx}`,
        type: 'backfill',
        recordKey,
        title,
        date: dateMatch ? dateMatch[1] : '',
        isPostHoc,
        isLegacyRef,
        anchor: block.anchor,
        subsections: formattedSubsections,
        references: refs,
        startLine: block.lineIdx + 1,
        endLine: endIdx + 1,
        rawMarkdown,
      });
      continue;
    }

    specialEntries.push({
      id: `special-${block.lineIdx}`,
      type: 'special',
      title,
      anchor: block.anchor,
      startLine: block.lineIdx + 1,
      endLine: endIdx + 1,
      rawMarkdown,
    });
  }

  // 为研判记录提取标准化标的身份（股票代码 / 简称），并建立「同标的历次研判与验证轨迹」分组
  const byRecordKey = new Map();
  for (const j of judgments) {
    const codeM =
      j.target.match(/(\d{6})\.(?:SH|SZ|BJ)/i) ||
      j.target.match(/[（(](\d{6})[）)]/) ||
      j.target.match(/\b([A-Z]{1,6})\.(?:US|O|N|A|NASDAQ|NYSE)\b/i) ||
      j.target.match(/\b(\d{5})\.HK\b/i) ||
      j.title.match(/(\d{6})\.(?:SH|SZ|BJ)/i) ||
      j.title.match(/\b([A-Z]{1,6})\.(?:US|O|N|A)\b/i);
    const stockCode = codeM ? codeM[1].toUpperCase() : '';
    let stockName = '';
    if (!/^研判记录\s+#/.test(j.target)) {
      stockName = j.target
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/\d{6}(?:\.[A-Z]{2})?/gi, '')
        .replace(/\b[A-Z]{1,6}\.(?:US|O|N|A|NASDAQ|NYSE)\b/gi, '')
        .replace(/\b\d{5}\.HK\b/gi, '')
        .replace(/[：:].*$/, '')
        .trim();
    }
    j.stockCode = stockCode;
    j.stockName = stockName;
    if (!byRecordKey.has(j.recordKey)) {
      byRecordKey.set(j.recordKey, j);
    }
  }

  // 小写字母补充记录（如 #004a）自动继承主编号（#004）的标的身份；大写 B（#003B/#004B 短线筛选）保持独立
  for (const j of judgments) {
    if (!j.stockCode && !j.stockName) {
      const lowerParent = j.recordKey.match(/^(#\d+)[a-z]+$/);
      if (lowerParent && byRecordKey.has(lowerParent[1])) {
        const parent = byRecordKey.get(lowerParent[1]);
        j.stockCode = parent.stockCode;
        j.stockName = parent.stockName;
      }
    }
    const baseRevKey = j.recordKey.replace(/[a-z]+$/, '');
    j.targetKey = j.stockCode
      ? `code:${j.stockCode}`
      : j.stockName
      ? `name:${j.stockName}`
      : `key:${baseRevKey}`;
    j.targetDisplayName = j.stockName
      ? j.stockCode
        ? `${j.stockName}（${j.stockCode}）`
        : j.stockName
      : j.target;
  }

  // 聚合生成 targetGroups
  const groupMap = new Map();
  for (const j of judgments) {
    if (!groupMap.has(j.targetKey)) {
      groupMap.set(j.targetKey, {
        targetKey: j.targetKey,
        stockCode: j.stockCode,
        stockName: j.stockName,
        displayName: j.targetDisplayName,
        judgments: [],
      });
    }
    const grp = groupMap.get(j.targetKey);
    if (!grp.stockCode && j.stockCode) grp.stockCode = j.stockCode;
    if (!grp.stockName && j.stockName) grp.stockName = j.stockName;
    if (j.stockName && j.stockCode) grp.displayName = `${j.stockName}（${j.stockCode}）`;
    grp.judgments.push(j);
  }

  // 最新日度复盘
  const sortedDaily = [...dailyReviews].sort((a, b) => b.date.localeCompare(a.date));
  const latestDaily = sortedDaily[0] || null;

  const targetGroups = [];
  for (const grp of groupMap.values()) {
    grp.judgments.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.startLine - b.startLine);
    const jKeys = new Set(grp.judgments.map((x) => x.recordKey));
    const jBaseKeys = new Set(grp.judgments.map((x) => x.recordKey.replace(/[a-z]+$/, '')));

    const matchedBackfills = backfills.filter((bf) => {
      if (jKeys.has(bf.recordKey)) return true;
      const bfLowerBase = bf.recordKey.replace(/[a-z]+$/, '');
      if (bfLowerBase !== bf.recordKey && jBaseKeys.has(bfLowerBase)) return true;
      for (const jk of jKeys) {
        if (bf.title.includes(`研判 ${jk}`) || bf.title.includes(`研判${jk}`)) return true;
      }
      return false;
    });

    const dailyMentionIds =
      grp.stockName && grp.stockName.length >= 2
        ? sortedDaily
            .filter((d) => d.rawMarkdown.includes(grp.stockName) || (grp.stockCode && d.rawMarkdown.includes(grp.stockCode)))
            .slice(0, 10)
            .map((d) => ({ id: d.id, date: d.date, score: d.score, title: d.title }))
        : [];

    const scoreSeries = grp.judgments
      .filter((x) => x.score !== null)
      .map((x) => ({ id: x.id, recordKey: x.recordKey, date: x.date, score: x.score }));

    const judgmentIds = grp.judgments.map((x) => x.id);
    for (const j of grp.judgments) {
      j.sameTargetCount = grp.judgments.length;
      j.relatedJudgmentIds = judgmentIds;
    }

    targetGroups.push({
      targetKey: grp.targetKey,
      stockCode: grp.stockCode,
      stockName: grp.stockName,
      displayName: grp.displayName,
      judgmentIds,
      backfillIds: matchedBackfills.map((b) => b.id),
      dailyMentions: dailyMentionIds,
      scoreSeries,
      count: grp.judgments.length,
      latestDate: grp.judgments[grp.judgments.length - 1]?.date || '',
      latestScore: scoreSeries[scoreSeries.length - 1]?.score ?? null,
    });
  }
  targetGroups.sort((a, b) => b.count - a.count || (b.latestDate || '').localeCompare(a.latestDate || ''));

  // 解析台账中 ①-⑧ 待拍板优化建议（固定声明未拍板、不自动执行）
  const pendingSuggestions = extractPendingSuggestions(rawText);

  // 生成日度评分时间轴（按日期升序）
  const scoreTimeline = dailyReviews
    .filter((d) => d.score !== null)
    .map((d) => ({ date: d.date, score: d.score, title: d.title }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 下一个研判主编号
  const maxJudgeNum = judgments.reduce((acc, j) => {
    const nm = j.recordKey.match(/^#(\d+)/);
    return nm ? Math.max(acc, Number(nm[1])) : acc;
  }, 0);

  return {
    meta,
    fileSize: Buffer.byteLength(rawText, 'utf8'),
    lineCount: lines.length,
    sha256: sha256(rawText),
    frameworkAmendments,
    stats: {
      judgmentCount: judgments.length,
      backfillCount: backfills.length,
      dailyReviewCount: dailyReviews.length,
      latestDailyDate: latestDaily ? latestDaily.date : '',
      latestDailyScore: latestDaily ? latestDaily.score : null,
      nextJudgmentKey: `#${pad3(maxJudgeNum + 1)}`,
      openGapCount: latestDaily ? latestDaily.gaps.length : 0,
      pendingSuggestionCount: pendingSuggestions.length,
    },
    judgments,
    backfills,
    targetGroups,
    dailyReviews: sortedDaily,
    specialEntries,
    scoreTimeline,
    pendingSuggestions,
    latestDailySummary: latestDaily
      ? {
          date: latestDaily.date,
          title: latestDaily.title,
          score: latestDaily.score,
          marketState: latestDaily.marketState,
          nextAnchors: latestDaily.nextAnchors,
          gaps: latestDaily.gaps,
          pendingOptNote: latestDaily.pendingOptNote,
        }
      : null,
    tocEntries,
  };
}

function extractPendingSuggestions(rawText) {
  if (!rawText || !/优化建议|待拍板/.test(rawText)) return [];

  const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫'];
  const byNum = new Map();
  const lines = splitLines(rawText);
  let currentDate = '';
  let inSuggestionBlock = false;

  const extractCardIds = (s) => {
    const str = String(s || '');
    const explicit = [...str.matchAll(/(?:卡片\s*|【)(\d{3})(?!\d)/g)].map((m) => m[1]);
    // 同步识别裸三位卡号（例如「（067复盘记录行注记层级）」或「067/174」），避开小数/百分比/金额/年份
    const bare = [...str.matchAll(/(?:^|[^\d.])(\d{3})(?![\d.%万亿元倍天日板])/g)]
      .map((m) => m[1])
      .filter((code) => Number(code) >= 1 && Number(code) <= 999);
    return [...new Set([...explicit, ...bare])];
  };

  const inferTargetCard = (text, titleHint = '') => {
    const full = String(text || '');
    const posM = full.match(/拟改位置[：:=]\s*([^\n。]+)/);
    const posText = posM ? posM[1] : '';
    if (posText) {
      const posCards = extractCardIds(posText);
      if (posCards.length > 0) return posCards.slice(0, 2).join('/');
      if (/评分|台账/.test(posText)) return '台账评分';
    }
    const titleCards = extractCardIds(titleHint);
    if (titleCards.length > 0) return titleCards.slice(0, 2).join('/');
    const explicitCards = [...new Set([...full.matchAll(/(?:卡片\s*|【)(\d{3})(?!\d)/g)].map((m) => m[1]))];
    if (explicitCards.length > 0) return explicitCards.slice(0, 2).join('/');
    if (/评分|台账/.test(`${titleHint} ${full}`)) return '台账评分';
    return '待定';
  };

  const upsert = (num, name, summary, proposedDate, fullParagraph) => {
    if (!num || !name) return;
    const cleanName = String(name).replace(/\*+/g, '').replace(/[（(]待拍板[）)]/g, '').trim();
    const cleanSummary = String(summary || cleanName).replace(/\*+/g, '').trim().slice(0, 180);
    if (!cleanName) return;
    if (!byNum.has(num)) {
      byNum.set(num, {
        num,
        name: cleanName.slice(0, 64),
        targetCard: inferTargetCard(fullParagraph, cleanName),
        proposedDate: proposedDate || '',
        summary: cleanSummary,
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dateHdr = line.match(/^##\s*复盘记录\s*(\d{4}-\d{2}-\d{2})/);
    if (dateHdr) {
      currentDate = dateHdr[1];
      inSuggestionBlock = false;
      continue;
    }

    if (/^\*\*优化建议/.test(line.trim())) {
      inSuggestionBlock = true;
      // 按完整建议段落切分：同一行可能有多个 "**新增⑤...**；**新增⑥...**" 或 "**新增⑧...**：改动假设=...；...；拟改位置=..."
      const addStarts = [...line.matchAll(/\*\*新增([①②③④⑤⑥⑦⑧⑨⑩⑪⑫])([^*\n]*?)\*\*[：:]?\s*/g)];
      for (let idx = 0; idx < addStarts.length; idx++) {
        const m = addStarts[idx];
        const num = m[1];
        const inner = m[2].trim();
        const segStart = m.index + m[0].length;
        const segEnd = idx + 1 < addStarts.length ? addStarts[idx + 1].index : line.length;
        const fullTail = line.slice(segStart, segEnd).replace(/[；;。\s]+$/, '').trim();
        let name = '';
        let summary = '';
        const colonSplit = inner.split(/[：:]/);
        if (colonSplit.length >= 2) {
          const rest = colonSplit.slice(1).join('：').trim();
          const dashSplit = rest.split(/——|改动假设[：:=]/);
          name = dashSplit[0].trim();
          summary = (rest.match(/改动假设[：:=]([^；;。]+)/)?.[1] || dashSplit[1] || rest).trim();
        } else {
          name = inner;
          summary = (fullTail.match(/改动假设[：:=]([^；;。]+)/)?.[1] || fullTail.split(/[；;。]/)[0] || inner).trim();
        }
        upsert(num, name, summary, currentDate, `${inner} ${fullTail}`);
      }
      continue;
    }

    if (inSuggestionBlock) {
      const trimmed = line.trim();
      if (!trimmed || /^<a id=|^#{1,3}\s|^\*\*(?!\d)/.test(trimmed)) {
        if (/^#{1,3}\s|^\*\*/.test(trimmed)) inSuggestionBlock = false;
        continue;
      }
      // 匹配有序建议项：1. **【159适用条件量化】**改动假设：...
      const numItem = trimmed.match(/^(\d{1,2})\.\s*\*\*【([^】]+)】\*\*(.*)$/);
      if (numItem) {
        const idx = Number(numItem[1]) - 1;
        const num = CIRCLED[idx] || `#${numItem[1]}`;
        const name = numItem[2].trim();
        const body = numItem[3].trim();
        const hyp = body.match(/改动假设[：:=]\s*([^。]+)/);
        upsert(num, name, hyp ? hyp[1].trim() : body, currentDate, `${name} ${body}`);
        continue;
      }
      // 兼容普通项目符号：- ① 建议标题：摘要（待拍板）
      const bulletItem = trimmed.match(/^[-*]\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫])\s*([^：:。\n]+)(?:[：:]\s*(.+))?$/);
      if (bulletItem) {
        upsert(bulletItem[1], bulletItem[2].trim(), (bulletItem[3] || bulletItem[2]).trim(), currentDate, trimmed);
      }
    }
  }

  // 按正文佐证子句精确归属每个编号（排除头部元数据行、范围统称 ①-⑦、否定句「无新增有效佐证」）
  const evidenceCountByNum = new Map();
  const CIRCLED_SET = new Set(CIRCLED);
  const bodyLines = lines.filter((l) => !/^\s*(?:>|<!--)/.test(l));
  for (const line of bodyLines) {
    if (!line.includes('佐证')) continue;
    // 保留括号内部细节作为独立子句或内联子句切分，先按分号/句号切段，再提取明确紧邻佐证的编号
    const segments = line.split(/[。；;]+/);
    for (const seg of segments) {
      if (!seg.includes('佐证')) continue;
      if (/无新增(?:有效)?佐证|未获(?:新增)?佐证|不构成(?:同向)?佐证/.test(seg)) continue;
      // 去掉范围统称（例如 "①-⑦维持待拍板" / "①—⑧"），避免范围端点被误计
      const cleanedSeg = seg.replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]\s*[-—–~～]\s*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]/g, '');
      // 优先检查括号内明确写佐证的细项，例如 "（②监管天花板...佐证+1；⑦双轨...佐证+1）"
      const subClauses = cleanedSeg.split(/[（(）)，,]+/).filter((c) => c.includes('佐证'));
      const targetClauses = subClauses.length > 0 ? subClauses : [cleanedSeg];
      const citedInSeg = new Set();
      for (const clause of targetClauses) {
        if (/无新增(?:有效)?佐证|未获(?:新增)?佐证|不构成/.test(clause)) continue;
        // 提取该佐证子句中明确列举的圆圈编号（支持 "①④本日各+1佐证"、"②⑦各获佐证+1"、"建议③（...）获佐证+1"、"优化建议②）佐证+1"）
        const beforeEv = clause.slice(0, clause.indexOf('佐证'));
        let found = [...beforeEv.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]/g)].map((m) => m[0]);
        if (found.length === 0) {
          // 兼容编号写在括号前紧贴佐证子句的情形，如 "（优化建议②）佐证+1" 切分后 "佐证+1" 前一个子句含 "优化建议②"
          const clausePos = cleanedSeg.indexOf(clause);
          const prefix = cleanedSeg.slice(Math.max(0, clausePos - 28), clausePos);
          const nearM = prefix.match(/(?:优化建议|建议|新增)[^。；;，,]{0,12}([①②③④⑤⑥⑦⑧⑨⑩⑪⑫]+)/);
          if (nearM) {
            found = [...nearM[1]].filter((ch) => CIRCLED_SET.has(ch));
          }
        }
        for (const num of found) {
          citedInSeg.add(num);
        }
      }
      for (const num of citedInSeg) {
        evidenceCountByNum.set(num, (evidenceCountByNum.get(num) || 0) + 1);
      }
    }
  }

  return [...byNum.values()]
    .sort((a, b) => {
      const ia = CIRCLED.indexOf(a.num);
      const ib = CIRCLED.indexOf(b.num);
      return (ia >= 0 ? ia : 99) - (ib >= 0 ? ib : 99);
    })
    .map((item) => ({
      ...item,
      evidenceMentions: evidenceCountByNum.get(item.num) || 0,
      status: '待拍板（未采纳，不自动执行）',
    }));
}

/**
 * 构建跨三库反向引用索引（Backlinks）
 */
function buildBacklinks(methodology, cognition, ledger) {
  const methodBacklinks = {};
  const cognitionBacklinks = {};

  const pushMap = (map, key, item) => {
    if (!map[key]) map[key] = [];
    map[key].push(item);
  };

  // 方法论之间互引
  for (const card of methodology.cards) {
    for (const target of card.references.methodIds) {
      pushMap(methodBacklinks, target, { type: 'methodology', id: card.id, label: `卡片 ${card.id} | ${card.title}` });
    }
    for (const target of card.references.cognitionIds) {
      pushMap(cognitionBacklinks, target, { type: 'methodology', id: card.id, label: `卡片 ${card.id} | ${card.title}` });
    }
  }

  // 冲突矩阵引用
  for (const conf of methodology.conflicts) {
    for (const target of conf.relatedMethodIds) {
      pushMap(methodBacklinks, target, { type: 'conflict', id: String(conf.id), label: `冲突 ${conf.id}：${conf.title}` });
    }
    for (const target of conf.relatedCognitionIds) {
      pushMap(cognitionBacklinks, target, { type: 'conflict', id: String(conf.id), label: `冲突 ${conf.id}：${conf.title}` });
    }
  }

  // 认知卡引用
  for (const card of cognition.cards) {
    for (const target of card.references.methodIds) {
      pushMap(methodBacklinks, target, { type: 'cognition', id: card.id, label: `认知卡 ${card.id} | ${card.title}` });
    }
    for (const target of card.references.cognitionIds) {
      pushMap(cognitionBacklinks, target, { type: 'cognition', id: card.id, label: `认知卡 ${card.id} | ${card.title}` });
    }
  }

  // 台账引用
  for (const j of ledger.judgments) {
    for (const target of j.references.methodIds) {
      pushMap(methodBacklinks, target, { type: 'judgment', id: j.id, label: `研判 ${j.recordKey} · ${j.target}` });
    }
    for (const target of j.references.cognitionIds) {
      pushMap(cognitionBacklinks, target, { type: 'judgment', id: j.id, label: `研判 ${j.recordKey} · ${j.target}` });
    }
  }
  for (const d of ledger.dailyReviews) {
    for (const target of d.references.methodIds) {
      pushMap(methodBacklinks, target, { type: 'daily', id: d.id, label: `日度复盘 ${d.date} · ${d.title}` });
    }
    for (const target of d.references.cognitionIds) {
      pushMap(cognitionBacklinks, target, { type: 'daily', id: d.id, label: `日度复盘 ${d.date} · ${d.title}` });
    }
  }

  return { methodBacklinks, cognitionBacklinks };
}

/**
 * 扫描日度复盘工作台中的证据 JSON 文件
 */
function listEvidenceFiles() {
  if (!fs.existsSync(PATHS.reviewWorkbenchDir)) return [];
  return fs
    .readdirSync(PATHS.reviewWorkbenchDir)
    .filter((f) => f.endsWith('.json'))
    .map((name) => {
      const fullPath = path.join(PATHS.reviewWorkbenchDir, name);
      let summary = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8').replace(/^\uFEFF/, ''));
        summary = {
          review_date: parsed.review_date || '',
          mode: parsed.mode || '',
          factCount: Array.isArray(parsed.facts) ? parsed.facts.length : 0,
        };
      } catch {
        summary = { parseError: true };
      }
      return { name, ...summary };
    });
}

/**
 * 加载并解析完整三库工作区状态
 */
function loadWorkspace() {
  const mRaw = fs.readFileSync(PATHS.methodology, 'utf8');
  const cRaw = fs.readFileSync(PATHS.cognition, 'utf8');
  const lRaw = fs.readFileSync(PATHS.ledger, 'utf8');

  const methodology = parseMethodology(mRaw);
  const cognition = parseCognition(cRaw);
  const ledger = parseLedger(lRaw);
  const backlinks = buildBacklinks(methodology, cognition, ledger);
  const evidenceFiles = listEvidenceFiles();

  // 提取高频复盘核心卡矩阵
  const highFreqCards = methodology.cards
    .filter((c) => !c.isRevoked && c.reviewLogs.length > 0)
    .sort((a, b) => b.reviewLogs.length - a.reviewLogs.length || (b.credibilityScore ?? 0) - (a.credibilityScore ?? 0))
    .map((c) => ({
      id: c.id,
      title: c.title,
      system: c.system,
      credibilityScore: c.credibilityScore,
      credibilityRaw: c.credibilityRaw,
      reviewCount: c.reviewLogs.length,
      latestReviewDate: c.reviewLogs[c.reviewLogs.length - 1]?.date || '',
      latestReviewContent: c.reviewLogs[c.reviewLogs.length - 1]?.content || '',
      isArchived: c.isArchived,
      isHighPaused: c.isHighPaused,
      isPendingRetire: c.isPendingRetire,
    }));

  return {
    loadedAt: new Date().toISOString(),
    paths: {
      projectRoot: PATHS.projectRoot,
      methodology: PATHS.methodology,
      cognition: PATHS.cognition,
      ledger: PATHS.ledger,
    },
    methodology,
    cognition,
    ledger,
    backlinks,
    highFreqCards,
    evidenceFiles,
  };
}

module.exports = {
  PATHS,
  pad3,
  sha256,
  extractReferences,
  parseMethodology,
  parseCognition,
  parseLedger,
  loadWorkspace,
};
