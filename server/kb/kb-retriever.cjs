'use strict';

/**
 * Layer 3 · 三路混合检索引擎与 AI 真相编译器（Context Compiler）
 *
 * 路 1：结构化精确路由（Ticker 代码/名称、产业链节点、大盘 Regime、领域 Domain）
 * 路 2：SQLite FTS5 BM25 + 投研同义词表（离线零依赖、毫秒级；Node < 22.13 自动优雅降级为内存词袋检索）
 * 路 3：可选 SQLite 向量语义检索（embeddings_cache；未配置或离线时自动优雅跳过）
 * 后处理：RRF 融合 → 生命周期/证据等级加权 → 1-Hop 图谱真相解析（自动跳转 supersedes/merged_into、自动挂载 CF-NN 冲突矩阵、反证卡与所属 T-xxx 活视图）→ Token 预算打包
 */

const fs = require('node:fs');
const path = require('node:path');
const { isNativeSqliteAvailable, openKbDatabase, extractBodySection, toLegacyId } = require('./kb-sqlite.cjs');
const { parseFrontmatter } = require('./kb-yaml.cjs');
const { extractEntities, tokenizeForFts, expandQuerySynonyms } = require('./kb-taxonomy.cjs');

function safeFtsTokens(text) {
  const raw = tokenizeForFts(text)
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9\u4e00-\u9fa5]/g, ''))
    .filter((t) => t.length >= 2);
  return [...new Set(raw)].slice(0, 36);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Node < 22.13 无原生 SQLite 时的内存降级混合检索（保持输出结构 100% 一致）
 */
function hybridSearchMemoryFallback(kbDir, options) {
  const {
    query = '',
    kinds = ['methodology', 'cognition'],
    ticker = '',
    regime = '',
    domain = '',
    chainNode = '',
    limit = 15,
    includeInactive = false,
    asOfDate = new Date().toISOString().slice(0, 10),
  } = options;
  const t0 = Date.now();
  const kindSet = new Set(Array.isArray(kinds) ? kinds : [kinds]);

  const cardDirs = [
    { kind: 'methodology', dir: path.join(kbDir, 'cards', 'methodology') },
    { kind: 'cognition', dir: path.join(kbDir, 'cards', 'cognition') },
    { kind: 'conflict', dir: path.join(kbDir, 'cards', 'conflicts') },
  ];

  const allCards = new Map();
  for (const src of cardDirs) {
    if (!fs.existsSync(src.dir)) continue;
    for (const f of fs.readdirSync(src.dir).filter((x) => x.endsWith('.md')).sort()) {
      const { frontmatter: fm, body } = parseFrontmatter(fs.readFileSync(path.join(src.dir, f), 'utf8'));
      const id = String(fm.id || path.basename(f, '.md'));
      const coreSummary =
        src.kind === 'methodology'
          ? extractBodySection(body, /^## 核心论断/)
          : src.kind === 'cognition'
          ? extractBodySection(body, /^## (?:事实与要点|客观事实)/)
          : extractBodySection(body, /^## 冲突点/);
      const invalidationText =
        src.kind === 'methodology'
          ? extractBodySection(body, /^## 失效信号/)
          : src.kind === 'cognition'
          ? extractBodySection(body, /^## 失效与更新条件/)
          : extractBodySection(body, /^## 折中思路/);
      allCards.set(id, {
        id,
        kind: src.kind,
        num: Number(fm.num || 0),
        sub_kind: String(fm.card_kind || fm.claim_type || src.kind),
        title: String(fm.title || ''),
        status: String(fm.status || 'active'),
        primary_grade: fm.primary_grade || null,
        legacy_score: fm.legacy_credibility?.score ?? null,
        verification_tier: fm.epistemic?.verification_tier || null,
        independent_chains: Number(fm.epistemic?.independent_chains || 0),
        updated_at: fm.updated_at || fm.created_at || '',
        valid_until: fm.valid_until || null,
        core_summary: coreSummary,
        invalidation_text: invalidationText,
        fm,
        tokenSet: new Set(tokenizeForFts(`${id} ${fm.title || ''} ${body}`).split(/\s+/).filter(Boolean)),
      });
    }
  }

  const detectedEntities = extractEntities(`${ticker} ${query}`);
  const { matchedTerms, expandedPeers } = expandQuerySynonyms(query);
  const primaryTokens = safeFtsTokens(query);
  const synonymTokens = safeFtsTokens(expandedPeers.join(' ')).filter((t) => !primaryTokens.includes(t));

  const scored = [];
  for (const card of allCards.values()) {
    if (!kindSet.has(card.kind)) continue;
    if (!includeInactive && (card.status === 'revoked' || card.status === 'superseded' || card.status === 'archived')) {
      continue;
    }
    let score = 0;
    const reasons = [];
    const warnings = [];

    for (const ent of detectedEntities) {
      if ((card.fm.tickers || []).some((t) => String(t.code || '').toUpperCase() === ent.code)) {
        score += 3.0;
        reasons.push(`实体精确命中:${ent.name}(${ent.code})`);
      }
    }
    if (regime && (card.fm.regimes || []).includes(regime)) {
      score += 1.5;
      reasons.push(`市场态路由:${regime}`);
    }
    if (domain && (card.fm.domains || []).includes(domain)) {
      score += 1.3;
      reasons.push(`领域路由:${domain}`);
    }
    if (chainNode && (card.fm.chain_nodes || []).some((cn) => String(cn).startsWith(chainNode))) {
      score += 1.8;
      reasons.push(`产业链节点:${chainNode}`);
    }

    let primaryHits = 0;
    for (const tok of primaryTokens) {
      if (card.tokenSet.has(tok)) primaryHits++;
    }
    if (primaryHits > 0) {
      score += (primaryHits / Math.max(1, primaryTokens.length)) * 2.0;
      reasons.push('内存词元命中(降级模式)');
    }

    let synHits = 0;
    for (const tok of synonymTokens) {
      if (card.tokenSet.has(tok)) synHits++;
    }
    if (synHits > 0) {
      score += (synHits / Math.max(1, synonymTokens.length)) * 0.9;
      reasons.push(`同义词扩展(${matchedTerms.slice(0, 3).join('/')})`);
    }

    if (score <= 0) continue;

    if (card.kind === 'cognition') {
      if (card.status === 'partially_falsified') warnings.push('⚠️部分证伪');
      if (card.valid_until && card.valid_until < asOfDate) warnings.push(`⏰已过建议复核期(valid_until=${card.valid_until})`);
    }
    scored.push({ card, score, reasons, warnings });
  }

  scored.sort((a, b) => b.score - a.score);
  const ranked = scored.slice(0, limit);

  return {
    elapsedMs: Date.now() - t0,
    fallbackMode: 'memory',
    query,
    detectedEntities,
    matchedSynonyms: matchedTerms,
    vectorUsed: false,
    redirectNotes: [],
    results: ranked.map((x) => ({
      id: x.card.id,
      legacyId: toLegacyId(x.card.id, x.card.num),
      kind: x.card.kind,
      subKind: x.card.sub_kind,
      title: x.card.title,
      status: x.card.status,
      primaryGrade: x.card.primary_grade,
      legacyScore: x.card.legacy_score,
      verificationTier: x.card.verification_tier,
      independentChains: x.card.independent_chains,
      updatedAt: x.card.updated_at,
      validUntil: x.card.valid_until,
      score: Number(x.score.toFixed(4)),
      reasons: x.reasons,
      warnings: x.warnings,
      coreSummary: x.card.core_summary,
      invalidationText: x.card.invalidation_text,
    })),
    attachedConflicts: [],
    attachedTopics: [],
    attachedRefuters: [],
  };
}

/**
 * 核心三路混合检索
 */
function hybridSearch(kbDir, options = {}) {
  if (!isNativeSqliteAvailable()) {
    return hybridSearchMemoryFallback(kbDir, options);
  }

  const {
    query = '',
    kinds = ['methodology', 'cognition'],
    ticker = '',
    regime = '',
    domain = '',
    chainNode = '',
    limit = 15,
    includeInactive = false,
    queryVector = null,
    asOfDate = new Date().toISOString().slice(0, 10),
  } = options;

  const t0 = Date.now();
  const { db } = openKbDatabase(kbDir);

  try {
    const kindSet = new Set(Array.isArray(kinds) ? kinds : [kinds]);
    const rrfScores = new Map();
    const hitReasons = new Map();
    const RRF_K = 45;

    const addRank = (cardId, rank, weight, reason) => {
      const prev = rrfScores.get(cardId) || 0;
      rrfScores.set(cardId, prev + weight / (RRF_K + rank));
      if (!hitReasons.has(cardId)) hitReasons.set(cardId, []);
      if (reason && !hitReasons.get(cardId).includes(reason)) {
        hitReasons.get(cardId).push(reason);
      }
    };

    // -----------------------------------------------------------------------
    // 路 1：结构化精确路由（Ticker / Regime / Domain / ChainNode）
    // -----------------------------------------------------------------------
    const detectedEntities = extractEntities(`${ticker} ${query}`);
    if (ticker) {
      const normTk = String(ticker).trim().toUpperCase();
      if (/^\d{6}$/.test(normTk)) {
        const suf = normTk.startsWith('6') ? 'SH' : 'SZ';
        if (!detectedEntities.some((e) => e.code === `${normTk}.${suf}`)) {
          detectedEntities.unshift({ code: `${normTk}.${suf}`, name: normTk });
        }
      } else if (/^[A-Z]{1,6}(?:\.US)?$/.test(normTk)) {
        const code = normTk.endsWith('.US') ? normTk : `${normTk}.US`;
        if (!detectedEntities.some((e) => e.code === code)) {
          detectedEntities.unshift({ code, name: normTk });
        }
      }
    }

    if (detectedEntities.length > 0) {
      const entityStmt = db.prepare(`
        SELECT ce.card_id, c.kind, c.updated_at
        FROM card_entities ce
        JOIN cards c ON c.id = ce.card_id
        WHERE ce.entity_key = ?
        ORDER BY c.updated_at DESC
      `);
      for (const ent of detectedEntities) {
        const rows = entityStmt.all(ent.code);
        rows.forEach((r, idx) => {
          if (kindSet.has(r.kind)) addRank(r.card_id, idx + 1, 2.2, `实体精确命中:${ent.name}(${ent.code})`);
        });
      }
    }

    if (regime) {
      const rows = db
        .prepare(
          `SELECT ct.card_id, c.kind, c.independent_chains, c.legacy_score
           FROM card_tags ct JOIN cards c ON c.id = ct.card_id
           WHERE ct.axis = 'regime' AND ct.tag = ?
           ORDER BY c.independent_chains DESC, COALESCE(c.legacy_score, 0.5) DESC`
        )
        .all(regime);
      rows.forEach((r, idx) => {
        if (kindSet.has(r.kind)) addRank(r.card_id, idx + 1, 1.5, `市场态路由:${regime}`);
      });
    }

    if (domain) {
      const rows = db
        .prepare(`SELECT ct.card_id, c.kind FROM card_tags ct JOIN cards c ON c.id = ct.card_id WHERE ct.axis = 'domain' AND ct.tag = ?`)
        .all(domain);
      rows.forEach((r, idx) => {
        if (kindSet.has(r.kind)) addRank(r.card_id, idx + 1, 1.3, `领域路由:${domain}`);
      });
    }

    if (chainNode) {
      const rows = db
        .prepare(`SELECT ct.card_id, c.kind FROM card_tags ct JOIN cards c ON c.id = ct.card_id WHERE ct.axis = 'chain_node' AND ct.tag LIKE ?`)
        .all(`${chainNode}%`);
      rows.forEach((r, idx) => {
        if (kindSet.has(r.kind)) addRank(r.card_id, idx + 1, 1.8, `产业链节点:${chainNode}`);
      });
    }

    // -----------------------------------------------------------------------
    // 路 2：SQLite FTS5 BM25 + 投研同义词扩展
    // -----------------------------------------------------------------------
    const { matchedTerms, expandedPeers } = expandQuerySynonyms(query);
    const primaryTokens = safeFtsTokens(query);
    const synonymTokens = safeFtsTokens(expandedPeers.join(' ')).filter((t) => !primaryTokens.includes(t));

    if (primaryTokens.length > 0) {
      const ftsQuery = primaryTokens.map((t) => `"${t}"`).join(' OR ');
      const rows = db
        .prepare(
          `SELECT f.card_id, c.kind, bm25(cards_fts, 4.0, 1.0, 3.0) AS rank_score
           FROM cards_fts f
           JOIN cards c ON c.id = f.card_id
           WHERE cards_fts MATCH ?
           ORDER BY rank_score ASC
           LIMIT 60`
        )
        .all(ftsQuery);
      rows.forEach((r, idx) => {
        if (kindSet.has(r.kind)) addRank(r.card_id, idx + 1, 1.6, 'FTS5精确BM25');
      });
    }

    if (synonymTokens.length > 0) {
      const synQuery = synonymTokens.slice(0, 24).map((t) => `"${t}"`).join(' OR ');
      const rows = db
        .prepare(
          `SELECT f.card_id, c.kind, bm25(cards_fts, 3.0, 1.0, 2.0) AS rank_score
           FROM cards_fts f
           JOIN cards c ON c.id = f.card_id
           WHERE cards_fts MATCH ?
           ORDER BY rank_score ASC
           LIMIT 40`
        )
        .all(synQuery);
      rows.forEach((r, idx) => {
        if (kindSet.has(r.kind)) {
          addRank(r.card_id, idx + 1, 0.9, `同义词扩展(${matchedTerms.slice(0, 3).join('/')})`);
        }
      });
    }

    // -----------------------------------------------------------------------
    // 路 3：可选 Embedding 向量召回（存在 queryVector 且缓存表非空时激活）
    // -----------------------------------------------------------------------
    let vectorUsed = false;
    if (Array.isArray(queryVector) && queryVector.length > 0) {
      const vecRows = db
        .prepare(
          `SELECT ec.card_id, ec.vector_blob, c.kind
           FROM embeddings_cache ec JOIN cards c ON c.id = ec.card_id`
        )
        .all();
      if (vecRows.length > 0) {
        vectorUsed = true;
        const scoredVec = [];
        for (const vr of vecRows) {
          if (!kindSet.has(vr.kind)) continue;
          const buf = vr.vector_blob;
          const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          const sim = cosineSimilarity(queryVector, vec);
          if (sim > 0.25) scoredVec.push({ card_id: vr.card_id, sim });
        }
        scoredVec.sort((a, b) => b.sim - a.sim);
        scoredVec.slice(0, 35).forEach((r, idx) => {
          addRank(r.card_id, idx + 1, 1.4, `向量语义(${r.sim.toFixed(2)})`);
        });
      }
    }

    // -----------------------------------------------------------------------
    // 加载候选卡详情 + 生命周期/证据加权 + supersedes/merged_into 真相解析
    // -----------------------------------------------------------------------
    const candidateIds = [...rrfScores.keys()];
    const getCardStmt = db.prepare('SELECT * FROM cards WHERE id = ?');
    const getOutEdgesStmt = db.prepare('SELECT edge_type, target_id, note FROM edges WHERE source_id = ?');
    const getInEdgesStmt = db.prepare('SELECT source_id, edge_type, note FROM edges WHERE target_id = ?');

    const resolvedMap = new Map();
    const redirectNotes = [];

    for (const cid of candidateIds) {
      let card = getCardStmt.get(cid);
      if (!card) continue;

      if (!includeInactive && (card.status === 'revoked' || card.status === 'superseded')) {
        const out = getOutEdgesStmt.all(cid);
        const hop = out.find((e) => e.edge_type === 'merged_into' || e.edge_type === 'superseded_by');
        if (hop) {
          const newer = getCardStmt.get(hop.target_id);
          if (newer && newer.status !== 'revoked') {
            redirectNotes.push(`${cid}(${card.status}) → 已自动跳转至 ${newer.id}`);
            const baseScore = rrfScores.get(cid) || 0;
            rrfScores.set(newer.id, Math.max(rrfScores.get(newer.id) || 0, baseScore * 0.95));
            if (!hitReasons.has(newer.id)) hitReasons.set(newer.id, []);
            hitReasons.get(newer.id).push(`真相链重定向自:${cid}`);
            card = newer;
          } else {
            continue;
          }
        } else {
          continue;
        }
      }
      if (!includeInactive && card.status === 'archived') continue;

      let multiplier = 1.0;
      const warnings = [];
      if (card.kind === 'cognition') {
        if (card.primary_grade === 'A') multiplier *= 1.15;
        else if (card.primary_grade === 'B') multiplier *= 1.05;
        else if (card.primary_grade === 'C') multiplier *= 0.92;

        if (card.status === 'partially_falsified') {
          multiplier *= 0.78;
          const refuters = getInEdgesStmt
            .all(card.id)
            .filter((e) => e.edge_type === 'partially_falsifies')
            .map((e) => e.source_id);
          warnings.push(`⚠️部分证伪${refuters.length ? `（反证卡: ${refuters.join('/')}）` : ''}`);
        }
        if (card.valid_until && card.valid_until < asOfDate) {
          multiplier *= 0.85;
          warnings.push(`⏰已过建议复核期(valid_until=${card.valid_until})`);
        }
      } else if (card.kind === 'methodology') {
        if (card.legacy_score && card.legacy_score >= 0.7) multiplier *= 1.15;
        if (card.independent_chains >= 2) multiplier *= 1.1;
        if (card.status === 'dormant_archived') warnings.push('规则封存观察态');
      }

      const finalScore = (rrfScores.get(card.id) || 0) * multiplier;
      if (!resolvedMap.has(card.id) || finalScore > resolvedMap.get(card.id).score) {
        resolvedMap.set(card.id, {
          card,
          score: finalScore,
          reasons: hitReasons.get(card.id) || [],
          warnings,
        });
      }
    }

    const ranked = [...resolvedMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // -----------------------------------------------------------------------
    // 1-Hop 图谱展开：自动附带关联冲突矩阵 CF-NN、反证卡与所属活视图 T-xxx
    // -----------------------------------------------------------------------
    const attachedConflictIds = new Set();
    const attachedTopicIds = new Set();
    const attachedRefuterIds = new Set();

    const getCardTopicsStmt = db.prepare('SELECT topic_id FROM topic_members WHERE card_id = ?');

    for (const item of ranked) {
      const id = item.card.id;
      const outEdges = getOutEdgesStmt.all(id);
      const inEdges = getInEdgesStmt.all(id);
      item.edges = { out: outEdges, in: inEdges };

      for (const e of outEdges) {
        if (e.edge_type === 'conflicts_with' && e.target_id.startsWith('CF:')) attachedConflictIds.add(e.target_id);
        if (e.edge_type === 'partially_falsified_by') attachedRefuterIds.add(e.target_id);
      }
      for (const e of inEdges) {
        if (e.edge_type === 'conflicts_with' && e.source_id.startsWith('CF:')) attachedConflictIds.add(e.source_id);
        if (e.edge_type === 'partially_falsifies') attachedRefuterIds.add(e.source_id);
      }
      if (item.card.kind === 'cognition') {
        for (const tm of getCardTopicsStmt.all(id)) attachedTopicIds.add(tm.topic_id);
      }
    }

    const conflicts = [...attachedConflictIds]
      .map((cfId) => getCardStmt.get(cfId))
      .filter(Boolean)
      .map((cf) => ({
        id: cf.id,
        legacyId: toLegacyId(cf.id, cf.num),
        title: cf.title,
        conflictPoint: cf.core_summary,
        resolution: cf.invalidation_text,
      }));

    const topics = [...attachedTopicIds]
      .map((tid) => db.prepare('SELECT * FROM topics WHERE id = ?').get(tid))
      .filter(Boolean)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        memberCount: db.prepare('SELECT COUNT(*) AS c FROM topic_members WHERE topic_id = ?').get(t.id).c,
      }));

    const refuterCards = [...attachedRefuterIds]
      .filter((rid) => !ranked.some((x) => x.card.id === rid))
      .map((rid) => getCardStmt.get(rid))
      .filter(Boolean)
      .map((rc) => ({
        id: rc.id,
        legacyId: toLegacyId(rc.id, rc.num),
        title: rc.title,
        primaryGrade: rc.primary_grade,
        coreSummary: rc.core_summary.slice(0, 220),
      }));

    return {
      elapsedMs: Date.now() - t0,
      query,
      detectedEntities,
      matchedSynonyms: matchedTerms,
      vectorUsed,
      redirectNotes,
      results: ranked.map((x) => ({
        id: x.card.id,
        legacyId: toLegacyId(x.card.id, x.card.num),
        kind: x.card.kind,
        subKind: x.card.sub_kind,
        title: x.card.title,
        status: x.card.status,
        primaryGrade: x.card.primary_grade,
        legacyScore: x.card.legacy_score,
        verificationTier: x.card.verification_tier,
        independentChains: x.card.independent_chains,
        updatedAt: x.card.updated_at,
        validUntil: x.card.valid_until,
        score: Number(x.score.toFixed(4)),
        reasons: x.reasons,
        warnings: x.warnings,
        coreSummary: x.card.core_summary,
        invalidationText: x.card.invalidation_text,
      })),
      attachedConflicts: conflicts,
      attachedTopics: topics,
      attachedRefuters: refuterCards,
    };
  } finally {
    db.close();
  }
}

/**
 * 四场景 AI 真相编译器（Context Compiler）
 */
function compileAiContext(
  kbDir,
  { mode = 'judgment', query = '', ticker = '', regime = '', domain = '', chainNode = '', charBudget = 12000, asOfDate = null } = {}
) {
  const today = asOfDate || new Date().toISOString().slice(0, 10);
  const effectiveKinds =
    mode === 'ingest_method'
      ? ['methodology']
      : mode === 'ingest_cognition'
      ? ['cognition', 'methodology']
      : ['methodology', 'cognition'];

  const searchRes = hybridSearch(kbDir, {
    query,
    ticker,
    regime,
    domain,
    chainNode,
    kinds: effectiveKinds,
    limit: mode === 'daily_review' ? 24 : 18,
    asOfDate: today,
  });

  const sections = [];
  sections.push(`# AI 真相编译上下文包（mode=${mode} | asOf=${today} | 检索耗时 ${searchRes.elapsedMs}ms）`);

  if (searchRes.redirectNotes.length > 0) {
    sections.push(`## 真相链自动重定向\n${searchRes.redirectNotes.map((n) => `- ${n}`).join('\n')}`);
  }

  if (searchRes.attachedTopics.length > 0) {
    sections.push(
      `## 关联产业链活视图\n${searchRes.attachedTopics
        .map((t) => `- **${t.id}**｜${t.title}（${t.memberCount} 张卡，摘要状态：${t.status}）`)
        .join('\n')}`
    );
  }

  const methodItems = searchRes.results.filter((r) => r.kind === 'methodology');
  const cogItems = searchRes.results.filter((r) => r.kind === 'cognition');

  if (cogItems.length > 0) {
    const lines = ['## 精准召回的活跃认知事实（含证据等级、失效条件与时效预警）'];
    for (const c of cogItems) {
      const warn = c.warnings.length ? ` ｜ ${c.warnings.join(' ')}` : '';
      lines.push(
        `### [${c.id} · ${c.primaryGrade || '-'}级 · ${c.subKind} · 更新${c.updatedAt || '-'}] ${c.title}${warn}\n- 命中依据：${c.reasons.join(' + ')}\n- 事实摘要：${c.coreSummary.slice(0, 320)}\n- 失效/更新条件：${c.invalidationText.slice(0, 180)}`
      );
    }
    sections.push(lines.join('\n\n'));
  }

  if (searchRes.attachedRefuters.length > 0) {
    sections.push(
      `## 1-Hop 自动挂载反证卡（防误用已部分证伪旧卡）\n${searchRes.attachedRefuters
        .map((r) => `- **[${r.id} · ${r.primaryGrade}级]** ${r.title}：${r.coreSummary}`)
        .join('\n')}`
    );
  }

  if (methodItems.length > 0) {
    const lines = ['## 精准召回的活跃方法论（含核心论断、失效信号与双轨实证）'];
    for (const m of methodItems) {
      const warn = m.warnings.length ? ` ｜ ${m.warnings.join(' ')}` : '';
      lines.push(
        `### [${m.id} · ${m.subKind} · 原分${m.legacyScore ?? '-'} · ${m.verificationTier || '-'}] ${m.title}${warn}\n- 命中依据：${m.reasons.join(' + ')}\n- 核心论断：${m.coreSummary.slice(0, 260)}\n- 失效信号：${m.invalidationText.slice(0, 180)}`
      );
    }
    sections.push(lines.join('\n\n'));
  }

  if (searchRes.attachedConflicts.length > 0) {
    sections.push(
      `## 1-Hop 自动挂载冲突矩阵（必须用判别变量二选一）\n${searchRes.attachedConflicts
        .map(
          (cf) =>
            `- **${cf.id}：${cf.title}**\n  - 冲突点：${cf.conflictPoint.slice(0, 180)}\n  - 判别与折中：${cf.resolution.slice(0, 260)}`
        )
        .join('\n')}`
    );
  }

  let promptText = sections.join('\n\n');
  if (promptText.length > charBudget) {
    promptText = promptText.slice(0, charBudget) + '\n\n...（已按 charBudget 预算截断）';
  }

  return {
    mode,
    elapsedMs: searchRes.elapsedMs,
    charLength: promptText.length,
    methodCount: methodItems.length,
    cognitionCount: cogItems.length,
    conflictCount: searchRes.attachedConflicts.length,
    topicCount: searchRes.attachedTopics.length,
    refuterCount: searchRes.attachedRefuters.length,
    searchMeta: searchRes,
    promptText,
  };
}

module.exports = {
  hybridSearch,
  compileAiContext,
};
