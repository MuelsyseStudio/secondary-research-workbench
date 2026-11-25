'use strict';

/**
 * 统一双模知识库存储门面（server/knowledge-store.cjs）
 *
 * 自动根据当前激活工作空间模式路由：
 * - v1 模式：直接委派 server/parser.cjs，保持 100% 兼容并附加 kbMode: 'v1'；
 * - v2 模式：执行 15ms 增量 SQLite 对账，并从 kb/ 目录组装 100% WorkspaceData 兼容对象，
 *   增量附加 kbMode: 'v2'、kbSummary、topics、staleReport 及单卡 v2Meta。
 *
 * 同时对外暴露 v2 混合检索、活视图读写、时效巡检、单卡时间轴、只读无损迁移与逆向单文件编译导出能力。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { PATHS, detectKbMode, notifyWorkspaceChanged } = require('./app-paths.cjs');
const {
  pad3,
  sha256,
  extractReferences,
  parseLedger,
  loadWorkspace: loadLegacyV1Workspace,
} = require('./parser.cjs');
const kb = require('./kb/index.cjs');

function pad2(n) {
  return String(Number(n)).padStart(2, '0');
}

function uniqueSorted(arr) {
  return [...new Set(arr)].sort();
}

function listMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f));
}

function readJsonlSafe(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const out = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function parseBoldBulletLines(sectionText) {
  const out = [];
  if (!sectionText) return out;
  for (const line of String(sectionText).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^- \*\*(.+?)\*\*[：:]\s*([\s\S]*)$/);
    if (m) {
      out.push({ label: m[1].trim(), content: m[2].trim(), line: 0 });
    } else if (trimmed.startsWith('- ')) {
      const body = trimmed.slice(2);
      const colonIdx = body.search(/[：:]/);
      if (colonIdx !== -1 && colonIdx <= 48) {
        out.push({ label: body.slice(0, colonIdx).trim(), content: body.slice(colonIdx + 1).trim(), line: 0 });
      } else {
        out.push({ label: '记录', content: body.trim(), line: 0 });
      }
    } else if (out.length > 0) {
      out[out.length - 1].content += `\n${line}`;
    }
  }
  return out;
}

function buildBacklinks(methodology, cognition, ledger) {
  const methodBacklinks = {};
  const cognitionBacklinks = {};

  const pushMap = (map, key, item) => {
    if (!map[key]) map[key] = [];
    map[key].push(item);
  };

  for (const card of methodology.cards) {
    for (const target of card.references.methodIds) {
      pushMap(methodBacklinks, target, { type: 'methodology', id: card.id, label: `卡片 ${card.id} | ${card.title}` });
    }
    for (const target of card.references.cognitionIds) {
      pushMap(cognitionBacklinks, target, { type: 'methodology', id: card.id, label: `卡片 ${card.id} | ${card.title}` });
    }
  }

  for (const conf of methodology.conflicts) {
    for (const target of conf.relatedMethodIds) {
      pushMap(methodBacklinks, target, { type: 'conflict', id: String(conf.id), label: `冲突 ${conf.id}：${conf.title}` });
    }
    for (const target of conf.relatedCognitionIds) {
      pushMap(cognitionBacklinks, target, { type: 'conflict', id: String(conf.id), label: `冲突 ${conf.id}：${conf.title}` });
    }
  }

  for (const card of cognition.cards) {
    for (const target of card.references.methodIds) {
      pushMap(methodBacklinks, target, { type: 'cognition', id: card.id, label: `认知卡 ${card.id} | ${card.title}` });
    }
    for (const target of card.references.cognitionIds) {
      pushMap(cognitionBacklinks, target, { type: 'cognition', id: card.id, label: `认知卡 ${card.id} | ${card.title}` });
    }
  }

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

function listEvidenceFilesForRoot(projectRoot) {
  const reviewCandidate = path.join(projectRoot, '日度复盘工作台_2026-11-23');
  const reviewDir = fs.existsSync(reviewCandidate)
    ? reviewCandidate
    : path.join(projectRoot, '复盘证据工作台');
  if (!fs.existsSync(reviewDir)) return [];
  return fs
    .readdirSync(reviewDir)
    .filter((f) => f.endsWith('.json'))
    .map((name) => {
      const fullPath = path.join(reviewDir, name);
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

function reconstructMethodRawMarkdown(fm, fields, reviewLogs) {
  const numStr = pad3(fm.num);
  const heading = fm.legacy_meta?.raw_heading || `## 卡片 ${numStr} | ${fm.title}`;
  const lines = [heading];
  if (fields.coreThesis) lines.push(`- 核心论断：${fields.coreThesis}`);
  if (fields.logicChain) lines.push(`- 逻辑链条：${fields.logicChain}`);
  if (fields.applicableConditions) lines.push(`- 适用条件：${fields.applicableConditions}`);
  if (fields.invalidationSignals) lines.push(`- 失效信号：${fields.invalidationSignals}`);
  if (fields.historicalCases) lines.push(`- 历史案例：${fields.historicalCases}`);
  if (fields.credibilityRaw) lines.push(`- 可信度：${fields.credibilityRaw}`);
  if (fields.source) lines.push(`- 来源：${fields.source}`);
  for (const am of fields.amendments) {
    lines.push(`- ${am.label}：${am.content}`);
  }
  for (const ex of fields.otherFields) {
    lines.push(`- ${ex.label}：${ex.content}`);
  }
  for (const rl of reviewLogs) {
    lines.push(rl.rawLine || `- ${rl.label}：${rl.content}`);
  }
  return lines.join('\n');
}

function reconstructCognitionRawMarkdown(fm, fields) {
  const numStr = pad3(fm.num);
  const heading = fm.legacy_meta?.raw_heading || `## 认知卡 ${numStr} | ${fm.title}`;
  const lines = [heading];
  if (fields.facts) lines.push(`- 事实/要点：${fields.facts}`);
  if (fields.source) lines.push(`- 来源：${fields.source}`);
  if (fields.evidenceLevelRaw) lines.push(`- 证据等级：${fields.evidenceLevelRaw}`);
  if (fields.industryImplications) lines.push(`- 产业含义（分析）：${fields.industryImplications}`);
  if (fields.aShareMapping) lines.push(`- A股映射（分析）：${fields.aShareMapping}`);
  if (fields.confidence) lines.push(`- 置信度：${fields.confidence}`);
  if (fields.invalidationConditions) lines.push(`- 失效/更新条件：${fields.invalidationConditions}`);
  if (fields.relatedRaw) lines.push(`- ${fields.relatedRaw}`);
  for (const am of fields.amendments) {
    lines.push(`- ${am.label}：${am.content}`);
  }
  if (fields.updateLog) lines.push(`- 更新日志：${fields.updateLog}`);
  for (const ex of fields.otherFields) {
    lines.push(`- ${ex.label}：${ex.content}`);
  }
  return lines.join('\n');
}

/**
 * 加载 KB v2 工作空间，组装 100% WorkspaceData 兼容结构 + 增量 v2 字段
 */
function loadKbV2Workspace(kbDir, projectRoot) {
  const today = new Date().toISOString().slice(0, 10);
  const resolvedKbDir = path.resolve(kbDir);
  const resolvedRoot = path.resolve(projectRoot || path.dirname(resolvedKbDir));
  const currentDir = path.join(resolvedRoot, '现行三库');

  // 1. 15ms 增量 SQLite 对账（只读加载期间 refreshTopics: false，避免读操作篡改磁盘）
  const syncRes = kb.syncKbToSqlite(resolvedKbDir, { forceRebuild: false, refreshTopics: false });
  const sqliteAvailable = Boolean(syncRes.sqliteAvailable);

  // 2. 读取元数据（manifest / registry / legacy-headers / research-archives）
  const manifestPath = path.join(resolvedKbDir, 'kb.manifest.yaml');
  const manifest = fs.existsSync(manifestPath)
    ? kb.parseYamlLines(fs.readFileSync(manifestPath, 'utf8'))
    : {};

  const registryPath = path.join(resolvedKbDir, 'meta', 'registry.yaml');
  const registry = fs.existsSync(registryPath)
    ? kb.parseYamlLines(fs.readFileSync(registryPath, 'utf8'))
    : {};

  const legacyHeadersPath = path.join(resolvedKbDir, 'meta', 'legacy-headers.json');
  const legacyHeaders = fs.existsSync(legacyHeadersPath)
    ? JSON.parse(fs.readFileSync(legacyHeadersPath, 'utf8'))
    : {};

  const archivesPath = path.join(resolvedKbDir, 'meta', 'research-archives.yaml');
  let researchArchives = [];
  if (fs.existsSync(archivesPath)) {
    const parsedArch = kb.parseYamlLines(fs.readFileSync(archivesPath, 'utf8'));
    if (Array.isArray(parsedArch.archives)) {
      researchArchives = parsedArch.archives.map((a) => ({
        date: a.date || '',
        title: a.title || '',
        relativePath: a.relativePath || '',
        exists: a.relativePath ? fs.existsSync(path.resolve(currentDir, a.relativePath)) : false,
        summary: a.summary || '',
      }));
    }
  }

  // 3. 读取独立事件流（review-log.jsonl & ingestion-log.jsonl）
  const allReviewEvents = readJsonlSafe(path.join(resolvedKbDir, 'events', 'review-log.jsonl'));
  const reviewsByCard = new Map();
  for (const ev of allReviewEvents) {
    if (!ev || !ev.card_id) continue;
    if (!reviewsByCard.has(ev.card_id)) reviewsByCard.set(ev.card_id, []);
    reviewsByCard.get(ev.card_id).push(ev);
  }

  const allIngestionLogs = readJsonlSafe(path.join(resolvedKbDir, 'events', 'ingestion-log.jsonl'));
  const methodIngestionLogs = allIngestionLogs
    .filter((l) => l.library === 'methodology')
    .map((l) => ({
      title: l.title || '',
      anchor: l.anchor || '',
      startLine: Number(l.startLine || 1),
      content: l.content || '',
    }));
  const cogUpdateLogs = allIngestionLogs
    .filter((l) => l.library === 'cognition')
    .map((l) => ({
      title: l.title || '',
      content: l.content || '',
      startLine: Number(l.startLine || 1),
    }));

  // 4. 从 SQLite 读取图谱边与索引统计（或在无 SQLite 时由内存文件推导）
  const outEdgesByCard = new Map();
  const inEdgesByCard = new Map();
  const cardMetaById = new Map();
  let dbEdgeCount = 0;
  let dbTagCount = 0;
  let dbEntityCount = 0;

  if (sqliteAvailable) {
    const { db } = kb.openKbDatabase(resolvedKbDir);
    try {
      for (const row of db.prepare('SELECT id, kind, num, title, status, independent_chains, verification_tier FROM cards').all()) {
        cardMetaById.set(row.id, row);
      }
      const edges = db.prepare('SELECT source_id, edge_type, target_id, note FROM edges').all();
      dbEdgeCount = edges.length;
      for (const e of edges) {
        if (!outEdgesByCard.has(e.source_id)) outEdgesByCard.set(e.source_id, []);
        outEdgesByCard.get(e.source_id).push(e);
        if (!inEdgesByCard.has(e.target_id)) inEdgesByCard.set(e.target_id, []);
        inEdgesByCard.get(e.target_id).push(e);
      }
      dbTagCount = db.prepare('SELECT COUNT(*) AS cnt FROM card_tags').get().cnt;
      dbEntityCount = db.prepare('SELECT COUNT(*) AS cnt FROM card_entities').get().cnt;
    } finally {
      db.close();
    }
  }

  // 5. 先读取全部原始卡片文件（供构建 cardMetaById 兜底与组装 WorkspaceData）
  const methodFilePaths = listMdFiles(path.join(resolvedKbDir, 'cards', 'methodology'));
  const conflictFilePaths = listMdFiles(path.join(resolvedKbDir, 'cards', 'conflicts'));
  const cogFilePaths = listMdFiles(path.join(resolvedKbDir, 'cards', 'cognition'));

  const rawMethodDocs = methodFilePaths.map((f) => {
    const raw = fs.readFileSync(f, 'utf8');
    return { absPath: f, relPath: path.relative(resolvedKbDir, f).replace(/\\/g, '/'), raw, ...kb.parseFrontmatter(raw) };
  });
  const rawConflictDocs = conflictFilePaths.map((f) => {
    const raw = fs.readFileSync(f, 'utf8');
    return { absPath: f, relPath: path.relative(resolvedKbDir, f).replace(/\\/g, '/'), raw, ...kb.parseFrontmatter(raw) };
  });
  const rawCogDocs = cogFilePaths.map((f) => {
    const raw = fs.readFileSync(f, 'utf8');
    return { absPath: f, relPath: path.relative(resolvedKbDir, f).replace(/\\/g, '/'), raw, ...kb.parseFrontmatter(raw) };
  });

  if (!sqliteAvailable) {
    for (const [kind, docs] of [
      ['methodology', rawMethodDocs],
      ['conflict', rawConflictDocs],
      ['cognition', rawCogDocs],
    ]) {
      for (const doc of docs) {
        const fm = doc.frontmatter;
        const id = String(fm.id || '');
        if (!id) continue;
        cardMetaById.set(id, {
          id,
          kind,
          num: Number(fm.num || 0),
          title: String(fm.title || ''),
          status: String(fm.status || 'active'),
          independent_chains: Number(fm.epistemic?.independent_chains || 0),
          verification_tier: fm.epistemic?.verification_tier || null,
        });
        for (const rel of fm.relations || []) {
          if (!rel || !rel.type || !rel.target) continue;
          const e = { source_id: id, edge_type: rel.type, target_id: rel.target, note: rel.note || '' };
          dbEdgeCount++;
          if (!outEdgesByCard.has(id)) outEdgesByCard.set(id, []);
          outEdgesByCard.get(id).push(e);
          if (!inEdgesByCard.has(rel.target)) inEdgesByCard.set(rel.target, []);
          inEdgesByCard.get(rel.target).push(e);
        }
        dbTagCount +=
          (fm.domains?.length || 0) +
          (fm.regimes?.length || 0) +
          (fm.horizons?.length || 0) +
          (fm.asset_classes?.length || 0) +
          (fm.chain_nodes?.length || 0);
        dbEntityCount += fm.tickers?.length || 0;
      }
    }
  }

  const buildEnrichedEdges = (kbId) => {
    const out = (outEdgesByCard.get(kbId) || []).map((e) => {
      const targetMeta = cardMetaById.get(e.target_id);
      return {
        direction: 'out',
        type: e.edge_type,
        target: e.target_id,
        targetLegacyId: kb.toLegacyId(e.target_id, targetMeta?.num),
        targetTitle: targetMeta?.title || '',
        note: e.note || '',
      };
    });
    const inc = (inEdgesByCard.get(kbId) || []).map((e) => {
      const srcMeta = cardMetaById.get(e.source_id);
      return {
        direction: 'in',
        type: e.edge_type,
        target: e.source_id,
        targetLegacyId: kb.toLegacyId(e.source_id, srcMeta?.num),
        targetTitle: srcMeta?.title || '',
        note: e.note || '',
      };
    });
    return [...out, ...inc];
  };

  // 6. 解析台账（仍由 parseLedger 从 现行三库/研判与复盘台账.md 解析；不存在时返回标准空台账）
  const ledgerPath = path.join(currentDir, '研判与复盘台账.md');
  const ledgerRaw = fs.existsSync(ledgerPath)
    ? fs.readFileSync(ledgerPath, 'utf8')
    : '# 研判与复盘台账\n\n> 版本：v1.0。\n';
  const ledger = parseLedger(ledgerRaw);

  // 7. 组装方法论库（MethodologyData）
  rawMethodDocs.sort(
    (a, b) =>
      (a.frontmatter.legacy_meta?.order_in_source || a.frontmatter.num || 0) -
      (b.frontmatter.legacy_meta?.order_in_source || b.frontmatter.num || 0)
  );

  const methodSectionsMap = new Map();
  for (const s of legacyHeaders.methodologySections || []) {
    if (s && s.title && !methodSectionsMap.has(s.title)) {
      methodSectionsMap.set(s.title, {
        title: s.title,
        anchor: s.anchor || `sec-${methodSectionsMap.size + 1}`,
        index: methodSectionsMap.size + 1,
        startLine: Number(s.startLine || 1),
      });
    }
  }

  let methodTotalBytes = 0;
  let methodTotalLines = 0;
  const methodHashAcc = crypto.createHash('sha256');
  const methodCards = [];
  let methodLatestDate = manifest.created_at || '';

  for (const doc of rawMethodDocs) {
    const fm = doc.frontmatter;
    const body = doc.body;
    methodTotalBytes += Buffer.byteLength(doc.raw, 'utf8');
    methodTotalLines += doc.raw.split(/\r?\n/).length;
    methodHashAcc.update(doc.relPath + '\n' + doc.raw + '\n');

    const num = Number(fm.num || 0);
    const id = pad3(num);
    const kbId = String(fm.id || `M:${id}`);
    const sectionTitle = fm.legacy_meta?.original_section || '第一编 未分编';
    if (!methodSectionsMap.has(sectionTitle)) {
      methodSectionsMap.set(sectionTitle, {
        title: sectionTitle,
        anchor: `m-sec-${methodSectionsMap.size + 1}`,
        index: methodSectionsMap.size + 1,
        startLine: 1,
      });
    }
    const secInfo = methodSectionsMap.get(sectionTitle);

    const coreThesis = kb.extractBodySection(body, /^## 核心论断/);
    const logicChain = kb.extractBodySection(body, /^## 逻辑链条/);
    const applicableConditions = kb.extractBodySection(body, /^## 适用条件/);
    const invalidationSignals = kb.extractBodySection(body, /^## 失效信号/);
    const historicalCases = kb.extractBodySection(body, /^## 历史案例/);
    const source = kb.extractBodySection(body, /^## 来源/) || fm.sources_raw || '';
    const amendments = parseBoldBulletLines(kb.extractBodySection(body, /^## 增订记录/));
    const otherFields = parseBoldBulletLines(kb.extractBodySection(body, /^## 附注与补充字段/)).map(({ label, content }) => ({
      label,
      content,
    }));

    const cardReviewsRaw = reviewsByCard.get(kbId) || [];
    const reviewLogs = cardReviewsRaw.map((ev) => ({
      label: ev.raw_label || `复盘记录 ${ev.date || ''}`.trim(),
      date: ev.date || '',
      content: ev.note || '',
      line: Number(ev.source_line || 0),
      rawLine: ev.raw_line || '',
    }));

    const credibilityScore =
      fm.legacy_credibility && typeof fm.legacy_credibility.score === 'number'
        ? fm.legacy_credibility.score
        : null;
    const credibilityRaw =
      fm.legacy_credibility?.raw || (credibilityScore !== null ? String(credibilityScore) : '');

    const rawMarkdown = reconstructMethodRawMarkdown(
      fm,
      {
        coreThesis,
        logicChain,
        applicableConditions,
        invalidationSignals,
        historicalCases,
        credibilityRaw,
        source,
        amendments,
        otherFields,
      },
      reviewLogs
    );

    const refs = extractReferences(rawMarkdown);
    const mRefSet = new Set(refs.methodIds.filter((x) => x !== id));
    const cRefSet = new Set(refs.cognitionIds);
    const cfRefSet = new Set(refs.conflictIds);
    for (const rel of fm.relations || []) {
      if (!rel || !rel.target) continue;
      if (rel.target.startsWith('M:') && rel.target !== kbId) mRefSet.add(pad3(rel.target.slice(2)));
      else if (rel.target.startsWith('C:')) cRefSet.add(pad3(rel.target.slice(2)));
      else if (rel.target.startsWith('CF:')) cfRefSet.add(String(Number(rel.target.slice(3))));
    }

    const title = String(fm.title || '');
    const sysMatch = title.match(/^([^（(：:]+?)(?:[（(](.+)[）)]|[：:](.+))$/);
    const system = fm.legacy_meta?.system || (sysMatch ? sysMatch[1].trim() : sectionTitle.replace(/^第.+?编\s*/, '').split('（')[0].trim());
    const topic = sysMatch ? (sysMatch[2] || sysMatch[3] || title).trim() : title;

    const status = String(fm.status || 'active');
    const isRevoked = status === 'revoked' || fm.card_kind === 'tombstone';
    const isArchived = status === 'dormant_archived' || Boolean(fm.legacy_credibility?.archived_flag);
    const isHighPaused = Boolean(fm.legacy_credibility?.high_paused);
    const isPendingVerify = Boolean(fm.epistemic?.pending_verify);
    const isPendingRetire = status === 'pending_retire' || (credibilityScore !== null && credibilityScore < 0.3);

    const dbMeta = cardMetaById.get(kbId);
    const chainSet = new Set(cardReviewsRaw.map((e) => e.evidence_chain_id).filter(Boolean));
    const independentChains = dbMeta?.independent_chains ?? fm.epistemic?.independent_chains ?? chainSet.size;

    if (fm.updated_at && fm.updated_at > methodLatestDate) methodLatestDate = fm.updated_at;

    methodCards.push({
      id,
      num,
      rawHeading: fm.legacy_meta?.raw_heading || `## 卡片 ${id} | ${title}`,
      title,
      system,
      topic,
      batchTag: fm.legacy_meta?.batch_tag || '',
      sectionTitle,
      sectionIndex: secInfo.index,
      anchorId: fm.legacy_meta?.anchor_id || `method-${id}`,
      startLine: Number(fm.legacy_meta?.source_start_line || 1),
      endLine: Number(fm.legacy_meta?.source_end_line || 1),
      coreThesis,
      logicChain,
      applicableConditions,
      invalidationSignals,
      historicalCases,
      credibilityRaw,
      credibilityScore,
      source,
      otherFields,
      isRevoked,
      isArchived,
      isHighPaused,
      isPendingVerify,
      isPendingRetire,
      amendments,
      reviewLogs: reviewLogs.map(({ rawLine, ...rest }) => rest),
      references: {
        methodIds: uniqueSorted([...mRefSet]),
        cognitionIds: uniqueSorted([...cRefSet]),
        conflictIds: [...cfRefSet].sort((a, b) => Number(a) - Number(b)),
      },
      rawMarkdown,
      v2Meta: {
        kbId,
        filePath: doc.relPath,
        cardKind: fm.card_kind || 'framework',
        status,
        domains: Array.isArray(fm.domains) ? fm.domains : [],
        regimes: Array.isArray(fm.regimes) ? fm.regimes : [],
        horizons: Array.isArray(fm.horizons) ? fm.horizons : [],
        assetClasses: Array.isArray(fm.asset_classes) ? fm.asset_classes : [],
        tickers: Array.isArray(fm.tickers) ? fm.tickers : [],
        verificationTier: fm.epistemic?.verification_tier || 'unverified',
        independentChains,
        reviewEventCount: cardReviewsRaw.length,
        enrichmentStatus: fm.legacy_meta?.enrichment_status || 'raw_migrated',
        updatedAt: fm.updated_at || fm.created_at || null,
        relations: buildEnrichedEdges(kbId),
      },
    });
  }

  rawConflictDocs.sort((a, b) => Number(a.frontmatter.num || 0) - Number(b.frontmatter.num || 0));
  const conflicts = rawConflictDocs.map((doc) => {
    const fm = doc.frontmatter;
    const body = doc.body;
    methodTotalBytes += Buffer.byteLength(doc.raw, 'utf8');
    methodTotalLines += doc.raw.split(/\r?\n/).length;
    methodHashAcc.update(doc.relPath + '\n' + doc.raw + '\n');

    const num = Number(fm.num || 0);
    const sides = kb.extractBodySection(body, /^## 冲突双方/);
    const conflictPoint = kb.extractBodySection(body, /^## 冲突点/);
    const resolution = kb.extractBodySection(body, /^## 折中思路/);
    const rawHeading = fm.legacy_meta?.raw_heading || `## 冲突 ${num}：${fm.title || ''}`;
    const rawMarkdown = [
      rawHeading,
      sides ? `- 双方：${sides}` : null,
      conflictPoint ? `- 冲突点：${conflictPoint}` : null,
      resolution ? `- 折中思路：${resolution}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const refs = extractReferences(rawMarkdown);
    const mSet = new Set(refs.methodIds);
    const cSet = new Set(refs.cognitionIds);
    for (const rel of fm.relations || []) {
      if (rel?.target?.startsWith('M:')) mSet.add(pad3(rel.target.slice(2)));
      if (rel?.target?.startsWith('C:')) cSet.add(pad3(rel.target.slice(2)));
    }

    return {
      id: num,
      anchorId: fm.legacy_meta?.anchor_id || `conflict-${num}`,
      rawHeading,
      title: String(fm.title || ''),
      versionTag: fm.version_tag || '',
      sides,
      conflictPoint,
      resolution,
      relatedMethodIds: uniqueSorted([...mSet]),
      relatedCognitionIds: uniqueSorted([...cSet]),
      startLine: Number(fm.legacy_meta?.source_start_line || 1),
      endLine: Number(fm.legacy_meta?.source_end_line || 1),
      rawMarkdown,
      v2Meta: {
        kbId: String(fm.id || `CF:${pad2(num)}`),
        filePath: doc.relPath,
        status: fm.status || 'open',
        relations: buildEnrichedEdges(String(fm.id || `CF:${pad2(num)}`)),
      },
    };
  });

  const reservedMissing = Array.isArray(registry?.methodology?.reserved_missing)
    ? uniqueSorted(registry.methodology.reserved_missing.map((x) => pad3(x)))
    : [];
  const activeMethodCards = methodCards.filter((c) => !c.isRevoked);
  const maxMethodNum = methodCards.reduce((acc, c) => Math.max(acc, c.num), 0);
  const maxConflictNum = conflicts.reduce((acc, c) => Math.max(acc, c.id), 0);
  const presentMNums = new Set(methodCards.map((c) => c.num).filter((n) => n > 0));
  const reservedMNums = new Set(reservedMissing.map((x) => Number(x)).filter((n) => n > 0));
  const numberGaps = [];
  if (methodCards.length > 0 && maxMethodNum > 0) {
    for (let n = 1; n <= maxMethodNum; n++) {
      if (!presentMNums.has(n)) numberGaps.push(pad3(n));
    }
  }
  const declaredMissing = uniqueSorted([...reservedMissing, ...numberGaps]);
  let nextMethodNum = maxMethodNum + 1;
  while (presentMNums.has(nextMethodNum) || reservedMNums.has(nextMethodNum)) nextMethodNum++;

  const methodVersion =
    legacyHeaders.sourceBaseline?.methodology?.version ||
    manifest.source_baseline?.methodology_version ||
    'v2.0';
  const cogVersion =
    legacyHeaders.sourceBaseline?.cognition?.version ||
    manifest.source_baseline?.cognition_version ||
    'v2.0';
  const ledgerVersion = ledger.meta?.version || 'v1.0';

  const methodSections = [...methodSectionsMap.values()];
  const methodTocEntries = [
    ...methodSections.map((s) => ({ level: 1, title: s.title, anchor: s.anchor, status: '编目', sourceLine: '—', line: s.startLine })),
    ...methodCards.map((c) => ({ level: 2, title: c.rawHeading.replace(/^## /, ''), anchor: c.anchorId, status: c.v2Meta.status, sourceLine: '—', line: c.startLine })),
    ...conflicts.map((cf) => ({ level: 2, title: cf.rawHeading.replace(/^## /, ''), anchor: cf.anchorId, status: '冲突', sourceLine: '—', line: cf.startLine })),
  ];

  const methodology = {
    meta: {
      version: methodVersion,
      syncDate: legacyHeaders.sourceBaseline?.methodology?.syncDate || methodLatestDate || today,
      latestReviewDate: ledger.stats?.latestDailyDate || '',
      companionLine: `配套现行文件：行业前沿认知库 ${cogVersion}；研判与复盘台账 ${ledgerVersion}（KB v2 单卡托管）`,
      revisionSummaries: [],
      htmlComment: '',
    },
    fileSize: methodTotalBytes,
    lineCount: methodTotalLines,
    sha256: methodHashAcc.digest('hex'),
    stats: {
      totalTitles: methodCards.length,
      activeCount: activeMethodCards.length,
      revokedCount: methodCards.filter((c) => c.isRevoked).length,
      reservedMissing,
      numberGaps,
      declaredMissing,
      conflictCount: conflicts.length,
      sectionCount: methodSections.length,
      nextCardId: pad3(nextMethodNum),
      nextConflictId: maxConflictNum + 1,
      highCredCount: activeMethodCards.filter((c) => (c.credibilityScore ?? 0) >= 0.7).length,
      withReviewsCount: activeMethodCards.filter((c) => c.reviewLogs.length > 0).length,
      pendingVerifyCount: activeMethodCards.filter((c) => c.isPendingVerify).length,
      pendingRetireCount: activeMethodCards.filter((c) => c.isPendingRetire).length,
    },
    sections: methodSections,
    cards: methodCards,
    conflicts,
    ingestionLogs: methodIngestionLogs,
    tocEntries: methodTocEntries,
  };

  // 8. 组装行业前沿认知库（CognitionData）
  rawCogDocs.sort(
    (a, b) =>
      (a.frontmatter.legacy_meta?.order_in_source || a.frontmatter.num || 0) -
      (b.frontmatter.legacy_meta?.order_in_source || b.frontmatter.num || 0)
  );

  const cogBatchesMap = new Map();
  for (const b of legacyHeaders.cognitionBatches || []) {
    if (b && b.title && !cogBatchesMap.has(b.title)) {
      cogBatchesMap.set(b.title, {
        title: b.title,
        anchor: b.anchor || `c-batch-${cogBatchesMap.size + 1}`,
        startLine: Number(b.startLine || 1),
      });
    }
  }

  let cogTotalBytes = 0;
  let cogTotalLines = 0;
  const cogHashAcc = crypto.createHash('sha256');
  const cognitionCards = [];
  let cogLatestDate = manifest.created_at || '';

  for (const doc of rawCogDocs) {
    const fm = doc.frontmatter;
    const body = doc.body;
    cogTotalBytes += Buffer.byteLength(doc.raw, 'utf8');
    cogTotalLines += doc.raw.split(/\r?\n/).length;
    cogHashAcc.update(doc.relPath + '\n' + doc.raw + '\n');

    const num = Number(fm.num || 0);
    const id = pad3(num);
    const kbId = String(fm.id || `C:${id}`);
    const batchTitle = fm.legacy_meta?.original_batch || '第一编 初始认知批次';
    if (!cogBatchesMap.has(batchTitle)) {
      cogBatchesMap.set(batchTitle, {
        title: batchTitle,
        anchor: `c-batch-${cogBatchesMap.size + 1}`,
        startLine: 1,
      });
    }

    const facts = kb.extractBodySection(body, /^## (?:事实与要点|客观事实)/);
    const source = kb.extractBodySection(body, /^## 来源/) || fm.sources_raw || '';
    const industryImplications = kb.extractBodySection(body, /^## 产业含义/);
    const aShareMapping = kb.extractBodySection(body, /^## A股映射/);
    const invalidationConditions = kb.extractBodySection(body, /^## 失效与更新条件/);
    const updateLog = kb.extractBodySection(body, /^## 原卡更新日志/);
    const relatedLines = parseBoldBulletLines(kb.extractBodySection(body, /^## 原文关联说明/));
    const relatedRaw = relatedLines.map((r) => `${r.label}：${r.content}`).join('；');
    const amendments = parseBoldBulletLines(kb.extractBodySection(body, /^## 增订与校准记录/));
    const otherFields = parseBoldBulletLines(kb.extractBodySection(body, /^## 附注与补充字段/)).map(({ label, content }) => ({
      label,
      content,
    }));

    const evidenceLevelRaw = fm.legacy_grade || '';
    const evidenceGrades = Array.isArray(fm.evidence_grades) && fm.evidence_grades.length > 0 ? fm.evidence_grades : ['C'];
    const primaryGrade = fm.primary_grade || evidenceGrades[0] || 'U';
    const confidence = fm.confidence_raw || '';
    const status = String(fm.status || 'active');
    const isArchived = status === 'archived';
    const isPartiallyFalsified = status === 'partially_falsified';

    const outEdges = outEdgesByCard.get(kbId) || [];
    const inEdges = inEdgesByCard.get(kbId) || [];
    const supersededEdge = outEdges.find((e) => e.edge_type === 'superseded_by');
    const updatedToId = supersededEdge ? kb.toLegacyId(supersededEdge.target_id) : null;

    // 收集所有反证卡（入边 partially_falsifies 或出边 partially_falsified_by）
    const refuterMap = new Map();
    for (const e of inEdges) {
      if (e.edge_type === 'partially_falsifies') {
        const meta = cardMetaById.get(e.source_id);
        refuterMap.set(e.source_id, {
          id: e.source_id,
          legacyId: kb.toLegacyId(e.source_id, meta?.num),
          title: meta?.title || '',
          note: e.note || '',
        });
      }
    }
    for (const e of outEdges) {
      if (e.edge_type === 'partially_falsified_by') {
        const meta = cardMetaById.get(e.target_id);
        if (!refuterMap.has(e.target_id)) {
          refuterMap.set(e.target_id, {
            id: e.target_id,
            legacyId: kb.toLegacyId(e.target_id, meta?.num),
            title: meta?.title || '',
            note: e.note || '',
          });
        }
      }
    }

    const validUntil = fm.valid_until || null;
    const nextCheckDate = fm.next_check_date || null;
    const isExpired = Boolean(status === 'active' && validUntil && validUntil < today);
    const isCheckDue = Boolean(status === 'active' && !isExpired && nextCheckDate && nextCheckDate <= today);

    const rawMarkdown = reconstructCognitionRawMarkdown(fm, {
      facts,
      source,
      evidenceLevelRaw,
      industryImplications,
      aShareMapping,
      confidence,
      invalidationConditions,
      relatedRaw,
      amendments,
      updateLog,
      otherFields,
    });

    const refs = extractReferences(rawMarkdown);
    const mRefSet = new Set(refs.methodIds);
    const cRefSet = new Set(refs.cognitionIds.filter((x) => x !== id));
    const cfRefSet = new Set(refs.conflictIds);
    for (const rel of fm.relations || []) {
      if (!rel || !rel.target) continue;
      if (rel.target.startsWith('M:')) mRefSet.add(pad3(rel.target.slice(2)));
      else if (rel.target.startsWith('C:') && rel.target !== kbId) cRefSet.add(pad3(rel.target.slice(2)));
      else if (rel.target.startsWith('CF:')) cfRefSet.add(String(Number(rel.target.slice(3))));
    }

    if (fm.updated_at && fm.updated_at > cogLatestDate) cogLatestDate = fm.updated_at;

    cognitionCards.push({
      id,
      num,
      rawHeading: fm.legacy_meta?.raw_heading || `## 认知卡 ${id} | ${fm.title || ''}`,
      title: String(fm.title || ''),
      ingestedDate: fm.ingested_at || '',
      categoryTag: fm.legacy_meta?.original_category_tag || '',
      batchTitle,
      anchorId: fm.legacy_meta?.anchor_id || `cognition-${id}`,
      startLine: Number(fm.legacy_meta?.source_start_line || 1),
      endLine: Number(fm.legacy_meta?.source_end_line || 1),
      facts,
      source,
      evidenceLevelRaw,
      evidenceGrades,
      primaryGrade,
      industryImplications,
      aShareMapping,
      confidence,
      invalidationConditions,
      updateLog,
      relatedRaw,
      otherFields,
      isArchived,
      isPartiallyFalsified,
      updatedToId,
      amendments,
      references: {
        methodIds: uniqueSorted([...mRefSet]),
        cognitionIds: uniqueSorted([...cRefSet]),
        conflictIds: [...cfRefSet].sort((a, b) => Number(a) - Number(b)),
      },
      rawMarkdown,
      v2Meta: {
        kbId,
        filePath: doc.relPath,
        claimType: fm.claim_type || 'mixed_fact_forecast',
        status,
        eventDate: fm.event_date || null,
        publishDate: fm.publish_date || null,
        updatedAt: fm.updated_at || fm.ingested_at || null,
        validUntil,
        nextCheckDate,
        isExpired,
        isCheckDue,
        topics: Array.isArray(fm.topics) ? fm.topics : [],
        chainNodes: Array.isArray(fm.chain_nodes) ? fm.chain_nodes : [],
        tickers: Array.isArray(fm.tickers) ? fm.tickers : [],
        relations: buildEnrichedEdges(kbId),
        refuters: [...refuterMap.values()],
      },
    });
  }

  const maxCogNum = cognitionCards.reduce((acc, c) => Math.max(acc, c.num), 0);
  const cogBatches = [...cogBatchesMap.values()];
  const cogTocEntries = [
    ...cogBatches.map((b) => ({ level: 1, title: b.title, anchor: b.anchor, status: '批次', sourceLine: '—', line: b.startLine })),
    ...cognitionCards.map((c) => ({ level: 2, title: c.rawHeading.replace(/^## /, ''), anchor: c.anchorId, status: c.v2Meta.status, sourceLine: '—', line: c.startLine })),
  ];

  const cognition = {
    meta: {
      version: cogVersion,
      syncDate: legacyHeaders.sourceBaseline?.cognition?.syncDate || cogLatestDate || today,
      latestReviewDate: ledger.stats?.latestDailyDate || '',
      companionLine: `配套现行文件：方法论卡片库 ${methodVersion}；研判与复盘台账 ${ledgerVersion}（KB v2 单卡托管）`,
      revisionSummaries: [],
      htmlComment: '',
    },
    fileSize: cogTotalBytes,
    lineCount: cogTotalLines,
    sha256: cogHashAcc.digest('hex'),
    stats: {
      totalCount: cognitionCards.length,
      nextCardId: pad3(maxCogNum + 1),
      gradeACount: cognitionCards.filter((c) => c.evidenceGrades.includes('A')).length,
      gradeBCount: cognitionCards.filter((c) => c.evidenceGrades.includes('B')).length,
      gradeCCount: cognitionCards.filter((c) => c.evidenceGrades.includes('C')).length,
      archivedCount: cognitionCards.filter((c) => c.isArchived).length,
      falsifiedCount: cognitionCards.filter((c) => c.isPartiallyFalsified).length,
      withAmendmentsCount: cognitionCards.filter((c) => c.amendments.length > 0).length,
      batchCount: cogBatches.length,
    },
    researchArchives,
    batches: cogBatches,
    cards: cognitionCards,
    updateLogs: cogUpdateLogs,
    tocEntries: cogTocEntries,
  };

  // 9. Backlinks、高频核心卡、活视图 Topics、时效巡检报告、图谱摘要
  const backlinks = buildBacklinks(methodology, cognition, ledger);
  const evidenceFiles = listEvidenceFilesForRoot(resolvedRoot);
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

  const topics = kb.listTopics(resolvedKbDir);
  const staleReport = kb.checkStaleCognition(resolvedKbDir, today);
  const kbSummary = {
    nodeCount: methodCards.length + cognitionCards.length + conflicts.length,
    methodCount: methodCards.length,
    cognitionCount: cognitionCards.length,
    conflictCount: conflicts.length,
    byKind: {
      methodology: methodCards.length,
      cognition: cognitionCards.length,
      conflict: conflicts.length,
    },
    edgeCount: dbEdgeCount,
    tagCount: dbTagCount,
    entityCount: dbEntityCount,
    reviewEventCount: allReviewEvents.length,
    topicCount: topics.length,
    sqliteAvailable,
    lastSyncMs: syncRes.elapsedMs || 0,
    lastSyncAt: new Date().toISOString(),
  };

  return {
    loadedAt: new Date().toISOString(),
    kbMode: 'v2',
    paths: {
      projectRoot: resolvedRoot,
      methodology: path.join(currentDir, '方法论卡片库.md'),
      cognition: path.join(currentDir, '行业前沿认知库.md'),
      ledger: ledgerPath,
      kbDir: resolvedKbDir,
      kbSqlitePath: path.join(resolvedKbDir, '.index', 'knowledge.sqlite'),
    },
    methodology,
    cognition,
    ledger,
    backlinks,
    highFreqCards,
    evidenceFiles,
    kbSummary,
    topics,
    staleReport,
  };
}

/**
 * 统一双模工作空间加载入口
 */
function loadWorkspace() {
  const mode = PATHS.kbMode;
  if (mode === 'v2') {
    return loadKbV2Workspace(PATHS.kbDir, PATHS.projectRoot);
  }
  const legacy = loadLegacyV1Workspace();
  return {
    ...legacy,
    kbMode: 'v1',
  };
}

/**
 * 三路混合检索（针对当前激活工作空间）
 */
function getKbSearch(opts = {}) {
  if (PATHS.kbMode !== 'v2') {
    return {
      ok: false,
      kbMode: 'v1',
      error: '当前工作空间处于 v1 单文件模式，请先无损升级至 KB v2 后使用混合图谱检索。',
      query: opts.query ?? opts.q ?? '',
      detectedEntities: [],
      matchedSynonyms: [],
      vectorUsed: false,
      redirectNotes: [],
      results: [],
      attachedConflicts: [],
      attachedTopics: [],
      attachedRefuters: [],
    };
  }
  const normalized = {
    query: String(opts.query ?? opts.q ?? '').trim(),
    ticker: String(opts.ticker ?? '').trim(),
    regime: String(opts.regime ?? '').trim(),
    domain: String(opts.domain ?? '').trim(),
    chainNode: String(opts.chainNode ?? opts.chain ?? '').trim(),
    kinds: Array.isArray(opts.kinds) && opts.kinds.length > 0 ? opts.kinds : ['methodology', 'cognition'],
    limit: Math.max(1, Math.min(50, Number(opts.limit || 15))),
    includeInactive: Boolean(opts.includeInactive),
    queryVector: opts.queryVector || null,
    asOfDate: opts.asOfDate || opts.date || undefined,
  };
  const res = kb.hybridSearch(PATHS.kbDir, normalized);
  return { ok: true, kbMode: 'v2', ...res };
}

/**
 * 获取当前激活工作空间的产业链活视图列表
 */
function getKbTopics() {
  if (PATHS.kbMode !== 'v2') {
    return { ok: true, kbMode: 'v1', topics: [] };
  }
  return { ok: true, kbMode: 'v2', topics: kb.listTopics(PATHS.kbDir) };
}

/**
 * 获取当前激活工作空间的时效巡检报告
 */
function getKbStale(asOfDate = null) {
  const today = asOfDate || new Date().toISOString().slice(0, 10);
  if (PATHS.kbMode !== 'v2') {
    return {
      ok: true,
      kbMode: 'v1',
      asOfDate: today,
      activeTotal: 0,
      expiredCount: 0,
      checkDueCount: 0,
      expired: [],
      checkDue: [],
    };
  }
  return { ok: true, kbMode: 'v2', ...kb.checkStaleCognition(PATHS.kbDir, today) };
}

/**
 * 获取单卡复盘实证时间轴与图谱入/出边
 */
function getKbCardTimeline(cardId) {
  if (PATHS.kbMode !== 'v2') {
    return {
      ok: false,
      kbMode: 'v1',
      error: '当前工作空间处于 v1 模式，升级至 KB v2 后可查看结构化复盘时间轴与图谱边。',
      cardId: String(cardId || ''),
      card: null,
      events: [],
      edges: { out: [], in: [] },
      summary: { eventCount: 0, independentChains: 0, confirmedCount: 0, falsifiedCount: 0, holdCount: 0 },
    };
  }
  return { kbMode: 'v2', ...kb.getCardTimeline(PATHS.kbDir, cardId) };
}

/**
 * 保存活视图共识摘要（支持 2 参数 (topicId, summaryMarkdown) 与 3 参数 (kbDir, topicId, summaryMarkdown)）
 */
function saveTopicConsensusSummary(arg1, arg2, arg3) {
  if (arguments.length >= 3) {
    return kb.saveTopicConsensusSummary(arg1, arg2, arg3);
  }
  if (PATHS.kbMode !== 'v2') {
    throw new Error('当前工作空间未启用 KB v2 模式，无法保存活视图共识摘要。');
  }
  return kb.saveTopicConsensusSummary(PATHS.kbDir, arg1, arg2);
}

/**
 * 为当前激活工作空间编译 AI 真相上下文包（供四大 AI 引擎统一调用）
 */
function compileAiContextForActiveWorkspace(opts = {}) {
  if (PATHS.kbMode !== 'v2') {
    return null;
  }
  return kb.compileAiContext(PATHS.kbDir, opts);
}

/**
 * 严格只读原件将当前工作空间从 v1 无损迁移至 v2（<projectRoot>/kb/）
 */
function migrateCurrentWorkspaceToV2(opts = {}) {
  const projectRoot = opts.projectRoot ? path.resolve(opts.projectRoot) : PATHS.projectRoot;
  const currentDir = path.join(projectRoot, '现行三库');
  const methodPath = path.join(currentDir, '方法论卡片库.md');
  const cognitionPath = path.join(currentDir, '行业前沿认知库.md');
  const ledgerPath = path.join(currentDir, '研判与复盘台账.md');
  const targetKbDir = path.join(projectRoot, 'kb');

  if (!fs.existsSync(methodPath) || !fs.existsSync(cognitionPath)) {
    throw new Error(`未在 "${currentDir}" 找到《方法论卡片库.md》与《行业前沿认知库.md》，无法执行 v1→v2 迁移。`);
  }

  const manifestPath = path.join(targetKbDir, 'kb.manifest.yaml');
  if (fs.existsSync(manifestPath) && !opts.force) {
    return {
      ok: false,
      alreadyExists: true,
      kbMode: 'v2',
      kbDir: targetKbDir,
      error: '当前工作空间已存在 kb/kb.manifest.yaml；如需重新无损生成，请传入 force: true。',
    };
  }

  // 迁移前计算原件 SHA-256 基线（严格只读证明）
  const beforeHashes = {
    methodology: sha256(fs.readFileSync(methodPath, 'utf8')),
    cognition: sha256(fs.readFileSync(cognitionPath, 'utf8')),
    ledger: fs.existsSync(ledgerPath) ? sha256(fs.readFileSync(ledgerPath, 'utf8')) : null,
  };

  if (opts.force && fs.existsSync(targetKbDir)) {
    fs.rmSync(targetKbDir, { recursive: true, force: true });
  }

  const migration = kb.runMigration({ methodPath, cognitionPath, targetKbDir });
  const sync = kb.syncKbToSqlite(targetKbDir, { forceRebuild: true, refreshTopics: true });
  const lossless = kb.verifyLosslessMigration({ kbDir: targetKbDir, methodPath, cognitionPath });

  // 迁移后复核原件 SHA-256 100% 零改动
  const afterHashes = {
    methodology: sha256(fs.readFileSync(methodPath, 'utf8')),
    cognition: sha256(fs.readFileSync(cognitionPath, 'utf8')),
    ledger: fs.existsSync(ledgerPath) ? sha256(fs.readFileSync(ledgerPath, 'utf8')) : null,
  };
  const originalsUnchanged =
    beforeHashes.methodology === afterHashes.methodology &&
    beforeHashes.cognition === afterHashes.cognition &&
    beforeHashes.ledger === afterHashes.ledger;

  if (!lossless.ok) {
    throw new Error(
      `无损核验未通过：methodDiffs=${lossless.methodContentDiffs.length}, cognitionDiffs=${lossless.cognitionContentDiffs.length}, conflictDiffs=${lossless.conflictDiffs.length}`
    );
  }
  if (!originalsUnchanged) {
    throw new Error('安全校验失败：检测到现行三库原件哈希变化！');
  }

  if (!opts.projectRoot) {
    notifyWorkspaceChanged();
  }

  return {
    ok: true,
    kbMode: detectKbMode(projectRoot),
    kbDir: targetKbDir,
    counts: migration.counts,
    sync,
    lossless,
    originalsUnchanged,
    sourceHashes: migration.sourceHashes,
  };
}

/**
 * 逆向编译导出经典单文件兼容快照（kb/exports/*.compiled.md）
 */
function exportKbMonolithSnapshots(kbDirOverride = null) {
  const targetKbDir = kbDirOverride ? path.resolve(kbDirOverride) : PATHS.kbDir;
  if (!fs.existsSync(path.join(targetKbDir, 'kb.manifest.yaml'))) {
    throw new Error('当前工作空间尚未启用 KB v2 模式，无法导出单文件编译快照。');
  }
  return kb.compileMonolithSnapshots(targetKbDir);
}

module.exports = {
  PATHS,
  detectKbMode,
  isNativeSqliteAvailable: kb.isNativeSqliteAvailable,
  getSqliteProbeInfo: kb.getSqliteProbeInfo,
  loadWorkspace,
  loadKbV2Workspace,
  getKbSearch,
  getKbTopics,
  getKbStale,
  getKbCardTimeline,
  saveTopicConsensusSummary,
  compileAiContextForActiveWorkspace,
  migrateCurrentWorkspaceToV2,
  exportKbMonolithSnapshots,
};
