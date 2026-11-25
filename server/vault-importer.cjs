'use strict';

/**
 * 本地存量知识库一键扫描与批量分诊导入引擎（Vault Batch Importer）
 *
 * 面向“朋友已有 Obsidian / Notion 导出目录 / 本地研报 PDF 文件夹”的一键迁移场景：
 * 1) 递归扫描全目录（自动跳过 .git / .obsidian / node_modules / assets / backups），统计文件清单、字数与扫描 PDF 预警；
 * 2) 智能分诊 + 自动分块批处理（每批 ~18,000 字；超长单文档自动分段 Map 提炼，不截断丢中间）；
 * 3) 动态滚雪球去重（前一批提炼出的新卡主题自动传入后一批，防止 100 篇老笔记重复建卡）；
 * 4) 所有结果汇总进「情报候选收件箱（Intel Inbox）」，支持多选后走一次合并 Diff 确认门一键全量落库！
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { extractDocumentText } = require('./doc-extractor.cjs');
const { loadWorkspace } = require('./knowledge-store.cjs');
const { runAiIngestion } = require('./ai-ingestor.cjs');
const { stateFile } = require('./app-paths.cjs');

const SKIP_DIRS = new Set([
  '.git',
  '.obsidian',
  '.trash',
  '.vscode',
  '.idea',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  'backups',
  'assets',
  'images',
  'attachments',
]);

const SUPPORTED_EXTS = new Set(['.md', '.markdown', '.txt', '.pdf', '.docx', '.html', '.htm']);

function inboxPath() {
  return stateFile('intel-hub-inbox.local.json');
}

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

function stripYamlFrontmatter(md) {
  const s = String(md || '');
  if (s.startsWith('---')) {
    const end = s.indexOf('\n---', 3);
    if (end > 0) return s.slice(end + 4).trim();
  }
  return s.trim();
}

function guessFileTrack(relPath, contentSample = '') {
  const text = `${relPath} ${contentSample.slice(0, 1200)}`;
  const methodScore = (
    text.match(/方法论|体系|框架|策略|交易纪律|风控|止损|仓位|周期|估值方法|原则|规律|心法|复盘总结|行为金融|技术分析|均线|趋势线|量价/g) || []
  ).length;
  const cogScore = (
    text.match(/财报|季报|营收|毛利率|产能|订单|出货|产业链|调研|纪要|公告|半导体|光模块|算力|机器人|医药|储能|电网|涨价|渗透率|指引|CapEx/gi) || []
  ).length;
  if (methodScore >= 3 && cogScore >= 3) return 'both';
  if (methodScore > cogScore + 1) return 'methodology';
  if (cogScore > 0) return 'cognition';
  return 'both';
}

function scanLocalVault(dirPath, maxFiles = 300) {
  const rawDir = String(dirPath || '').trim();
  if (!rawDir) throw new Error('请填写要扫描的本地知识库文件夹绝对路径');
  const root = path.resolve(rawDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`目录不存在或不是有效文件夹：${root}`);
  }

  const files = [];
  let skippedDirs = 0;

  function walk(curDir, depth) {
    if (depth > 8 || files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(curDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(curDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) {
          skippedDirs += 1;
          continue;
        }
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) continue;
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.size < 80 || stat.size > 25 * 1024 * 1024) continue;

        const relPath = path.relative(root, full).replace(/\\/g, '/');
        let sample = '';
        if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
          try {
            sample = fs.readFileSync(full, 'utf8').slice(0, 1200);
          } catch {}
        }
        const suggestedTrack = guessFileTrack(relPath, sample);
        files.push({
          relPath,
          name: entry.name,
          ext,
          sizeBytes: stat.size,
          modifiedAt: new Date(stat.mtimeMs).toISOString().slice(0, 10),
          suggestedTrack,
        });
      }
    }
  }

  walk(root, 0);
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.relPath.localeCompare(b.relPath));

  const byExt = {};
  for (const f of files) byExt[f.ext] = (byExt[f.ext] || 0) + 1;

  return {
    ok: true,
    rootDir: root,
    totalFiles: files.length,
    truncated: files.length >= maxFiles,
    skippedDirs,
    byExt,
    totalSizeKb: Math.round(files.reduce((s, f) => s + f.sizeBytes, 0) / 1024),
    files,
  };
}

function splitLongTextIntoChunks(text, chunkChars = 22000, overlap = 800) {
  if (text.length <= chunkChars) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length && chunks.length < 6) {
    const end = Math.min(text.length, start + chunkChars);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - overlap;
  }
  return chunks;
}

function packDocsIntoBatches(docs, maxCharsPerBatch = 20000) {
  const batches = [];
  let curDocs = [];
  let curChars = 0;

  for (const doc of docs) {
    const parts = splitLongTextIntoChunks(doc.text, maxCharsPerBatch, 600);
    for (let idx = 0; idx < parts.length; idx++) {
      const label = parts.length > 1 ? `${doc.relPath} (第${idx + 1}/${parts.length}段)` : doc.relPath;
      const snippet = `=== 文档：${label}（修改日 ${doc.modifiedAt}）===\n${parts[idx]}`;
      if (curChars + snippet.length > maxCharsPerBatch && curDocs.length > 0) {
        batches.push({ labels: curDocs.map((x) => x.label), text: curDocs.map((x) => x.snippet).join('\n\n') });
        curDocs = [];
        curChars = 0;
      }
      curDocs.push({ label, snippet });
      curChars += snippet.length;
    }
  }
  if (curDocs.length > 0) {
    batches.push({ labels: curDocs.map((x) => x.label), text: curDocs.map((x) => x.snippet).join('\n\n') });
  }
  return batches;
}

function makeCandidate(targetLibrary, kind, rawObj, sourceTag) {
  const cid = `vcand-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  if (targetLibrary === 'cognition' && kind === 'new_card') {
    return {
      cid,
      targetLibrary: 'cognition',
      kind: 'new_card',
      action: 'cognition.createCard',
      title: rawObj.title || '未命名认知候选卡',
      subtitle: `${rawObj.evidenceLevel || 'B级'} · ${rawObj.categoryTag || '本地知识库导入'}`,
      status: 'pending',
      sourceTag,
      payload: {
        title: rawObj.title || '',
        categoryTag: rawObj.categoryTag || '存量知识库迁移',
        batchName: rawObj.batchName || sourceTag,
        facts: rawObj.facts || '',
        source: rawObj.source || sourceTag,
        evidenceLevel: rawObj.evidenceLevel || 'B级（本地知识库导入）',
        industryImplications: rawObj.industryImplications || '',
        aShareMapping: rawObj.aShareMapping || '',
        confidence: rawObj.confidence || '中',
        invalidationConditions: rawObj.invalidationConditions || '',
        relatedMethodIds: rawObj.relatedMethodIds || '',
        relatedCognitionIds: rawObj.relatedCognitionIds || '',
      },
    };
  }
  if (targetLibrary === 'cognition' && kind === 'amendment') {
    return {
      cid,
      targetLibrary: 'cognition',
      kind: 'amendment',
      action: 'cognition.appendAmendment',
      title: `增订认知卡 ${rawObj.cardId} · ${rawObj.cardTitle || ''}`,
      subtitle: rawObj.batchNote || sourceTag,
      status: 'pending',
      sourceTag,
      payload: {
        cardId: rawObj.cardId,
        batchNote: rawObj.batchNote || sourceTag,
        content: rawObj.content || '',
      },
    };
  }
  if (targetLibrary === 'methodology' && kind === 'new_card') {
    return {
      cid,
      targetLibrary: 'methodology',
      kind: 'new_card',
      action: 'methodology.createCard',
      title: `${rawObj.system || '综合'}（${rawObj.topic || '未命名方法论'}）`,
      subtitle: `初始可信度 ${rawObj.credibility ?? 0.5}`,
      status: 'pending',
      sourceTag,
      payload: {
        system: rawObj.system || '投研框架',
        topic: rawObj.topic || '',
        batchNote: rawObj.batchNote || sourceTag,
        coreThesis: rawObj.coreThesis || '',
        logicChain: rawObj.logicChain || '',
        applicableConditions: rawObj.applicableConditions || '',
        invalidationSignals: rawObj.invalidationSignals || '',
        historicalCases: rawObj.historicalCases || '待实盘验证补充',
        credibility: Number(rawObj.credibility ?? 0.5),
        source: rawObj.source || sourceTag,
      },
    };
  }
  if (targetLibrary === 'methodology' && kind === 'amendment') {
    return {
      cid,
      targetLibrary: 'methodology',
      kind: 'amendment',
      action: 'methodology.appendAmendment',
      title: `增订方法论卡片 ${rawObj.cardId} · ${rawObj.cardTitle || ''}`,
      subtitle: rawObj.batchNote || sourceTag,
      status: 'pending',
      sourceTag,
      payload: {
        cardId: rawObj.cardId,
        batchNote: rawObj.batchNote || sourceTag,
        content: rawObj.content || '',
      },
    };
  }
  return {
    cid,
    targetLibrary: 'methodology',
    kind: 'conflict',
    action: 'methodology.createConflict',
    title: `冲突候选：${rawObj.title || '新冲突'}`,
    subtitle: rawObj.sides || '',
    status: 'pending',
    sourceTag,
    payload: {
      title: rawObj.title || '',
      sides: rawObj.sides || '',
      conflictPoint: rawObj.conflictPoint || '',
      resolution: rawObj.resolution || '',
    },
  };
}

async function runVaultBatchImport({
  dirPath,
  selectedRelPaths = [],
  mode = 'auto', // 'auto' | 'cognition' | 'methodology' | 'both'
  providerOverride,
  onProgress = () => {},
}) {
  const scan = scanLocalVault(dirPath, 300);
  const selectedSet = Array.isArray(selectedRelPaths) && selectedRelPaths.length > 0 ? new Set(selectedRelPaths) : null;
  const targetFiles = selectedSet ? scan.files.filter((f) => selectedSet.has(f.relPath)) : scan.files.slice(0, 40);

  if (targetFiles.length === 0) {
    throw new Error('未选中任何可导入文件');
  }

  onProgress({ stage: `正在解析 ${targetFiles.length} 份本地文档原文...` });

  const cogDocs = [];
  const methodDocs = [];
  const errors = [];
  const rawItems = [];

  for (let i = 0; i < targetFiles.length; i++) {
    const f = targetFiles[i];
    const full = path.join(scan.rootDir, f.relPath);
    try {
      let text = '';
      if (f.ext === '.pdf' || f.ext === '.docx' || f.ext === '.html' || f.ext === '.htm') {
        const buf = fs.readFileSync(full);
        const ex = await extractDocumentText({ fileName: f.name, base64: buf.toString('base64') });
        text = ex.text || '';
        if (ex.warnings?.length) errors.push(`${f.relPath}: ${ex.warnings.join('；')}`);
      } else {
        text = stripYamlFrontmatter(fs.readFileSync(full, 'utf8'));
      }
      if (text.trim().length < 80) continue;

      const route = mode === 'auto' ? f.suggestedTrack : mode;
      const docObj = { relPath: f.relPath, name: f.name, modifiedAt: f.modifiedAt, text, route };
      if (route === 'cognition' || route === 'both') cogDocs.push(docObj);
      if (route === 'methodology' || route === 'both') methodDocs.push(docObj);

      rawItems.push({
        itemKey: `vault:${crypto.createHash('sha1').update(full).digest('hex').slice(0, 12)}`,
        channel: 'local_folder',
        sourceName: `本地知识库 · ${path.basename(scan.rootDir)}`,
        sourceId: scan.rootDir,
        route,
        title: f.relPath,
        author: '本地存量知识库',
        publishedAt: f.modifiedAt,
        date: f.modifiedAt,
        url: '',
        tags: ['存量库导入', f.ext],
        wordCount: text.length,
        excerpt: text.replace(/\s+/g, ' ').slice(0, 180),
        content: text.slice(0, 4000),
      });
    } catch (err) {
      errors.push(`读取 ${f.relPath} 失败: ${err.message}`);
    }
  }

  const ws = loadWorkspace();
  const batchTag = `${todayISO()} 存量库导入（${path.basename(scan.rootDir)}）`;
  const candidates = [];
  const discarded = [];
  const summariesCog = [];
  const summariesMethod = [];

  const cogBatches = packDocsIntoBatches(cogDocs, 20000);
  const methodBatches = packDocsIntoBatches(methodDocs, 20000);
  const totalSteps = cogBatches.length + methodBatches.length;
  let stepDone = 0;

  // 滚雪球去重记忆：记录前序批次已生成的候选标题
  const extractedCogTitles = [];
  for (let i = 0; i < cogBatches.length; i++) {
    stepDone += 1;
    const cb = cogBatches[i];
    onProgress({ stage: `AI 正在提纯行业认知批次 (${stepDone}/${totalSteps})：${cb.labels.slice(0, 2).join('、')}...` });
    try {
      const priorHint =
        extractedCogTitles.length > 0
          ? `本轮前面批次已提取以下候选认知卡，请勿重复生成：${extractedCogTitles.join('；')}。`
          : '';
      const res = await runAiIngestion({
        targetLibrary: 'cognition',
        workspace: ws,
        sourceText: cb.text,
        meta: {
          sourceName: `${batchTag} [认知批 ${i + 1}/${cogBatches.length}]`,
          batchNote: batchTag,
          hint: `这是用户存量本地知识库批量迁移导入。严格区分客观事实与主观映射，标注 A/B/C 证据等级与失效条件。${priorHint}`,
        },
        providerOverride,
      });
      if (res.result.summary) summariesCog.push(res.result.summary);
      for (const c of res.result.newCards || []) {
        candidates.push(makeCandidate('cognition', 'new_card', c, batchTag));
        if (c.title) extractedCogTitles.push(c.title);
      }
      for (const a of res.result.amendments || []) {
        if (a.valid !== false) candidates.push(makeCandidate('cognition', 'amendment', a, batchTag));
      }
      for (const d of res.result.discarded || []) discarded.push({ targetLibrary: 'cognition', ...d });
    } catch (err) {
      errors.push(`认知批次 ${i + 1} AI 提纯失败: ${err.message}`);
    }
  }

  const extractedMethodTopics = [];
  for (let i = 0; i < methodBatches.length; i++) {
    stepDone += 1;
    const mb = methodBatches[i];
    onProgress({ stage: `AI 正在提纯方法论批次 (${stepDone}/${totalSteps})：${mb.labels.slice(0, 2).join('、')}...` });
    try {
      const priorHint =
        extractedMethodTopics.length > 0
          ? `本轮前面批次已提取以下方法论候选，请勿重复生成：${extractedMethodTopics.join('；')}。`
          : '';
      const res = await runAiIngestion({
        targetLibrary: 'methodology',
        workspace: ws,
        sourceText: mb.text,
        meta: {
          sourceName: `${batchTag} [方法论批 ${i + 1}/${methodBatches.length}]`,
          batchNote: batchTag,
          hint: `这是用户存量本地知识库批量迁移导入。严控方法论纯度，每张卡必须具备可证伪的失效信号，与库内既有卡高度相似则走增订。${priorHint}`,
        },
        providerOverride,
      });
      if (res.result.summary) summariesMethod.push(res.result.summary);
      for (const c of res.result.newCards || []) {
        candidates.push(makeCandidate('methodology', 'new_card', c, batchTag));
        if (c.topic) extractedMethodTopics.push(c.topic);
      }
      for (const a of res.result.amendments || []) {
        if (a.valid !== false) candidates.push(makeCandidate('methodology', 'amendment', a, batchTag));
      }
      for (const cf of res.result.conflicts || []) {
        candidates.push(makeCandidate('methodology', 'conflict', cf, batchTag));
      }
      for (const d of res.result.discarded || []) discarded.push({ targetLibrary: 'methodology', ...d });
    } catch (err) {
      errors.push(`方法论批次 ${i + 1} AI 提纯失败: ${err.message}`);
    }
  }

  const batchRecord = {
    id: `vault-${Date.now().toString(36)}`,
    createdAt: nowOffsetISO(),
    date: todayISO(),
    sinceDate: todayISO(),
    trigger: 'vault_import',
    runAi: true,
    stats: {
      totalFetched: rawItems.length,
      freshCount: rawItems.length,
      byChannel: { zsxq: 0, wechat: 0, local_folder: rawItems.length, public_feed: 0, rss: 0, manual_url: 0 },
      candidateCount: candidates.length,
      cognitionCandidateCount: candidates.filter((c) => c.targetLibrary === 'cognition').length,
      methodologyCandidateCount: candidates.filter((c) => c.targetLibrary === 'methodology').length,
      discardedCount: discarded.length,
    },
    aiSummaries: {
      cognition: summariesCog.join('；'),
      methodology: summariesMethod.join('；'),
    },
    aiMeta: { provider: providerOverride || '' },
    sentimentDigest: null,
    candidates,
    discarded: discarded.slice(0, 60),
    rawItems: rawItems.slice(0, 80),
    errors,
  };

  // 直接并入 Intel Hub 候选收件箱，统一走批量勾选 + 合并 Diff 确认门！
  let inbox = { batches: [], updatedAt: null };
  try {
    if (fs.existsSync(inboxPath())) inbox = JSON.parse(fs.readFileSync(inboxPath(), 'utf8'));
  } catch {}
  inbox.batches = [batchRecord, ...(inbox.batches || [])].slice(0, 20);
  inbox.updatedAt = nowOffsetISO();
  fs.writeFileSync(inboxPath(), JSON.stringify(inbox, null, 2) + '\n', 'utf8');

  return { ok: true, batch: batchRecord };
}

module.exports = {
  scanLocalVault,
  runVaultBatchImport,
};
