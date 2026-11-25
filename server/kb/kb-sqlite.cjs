'use strict';

/**
 * 派生 SQLite 索引层（基于 Node >= 22.13 原生 node:sqlite，零外部原生二进制依赖）
 *
 * 核心能力：
 * 1. 运行时探针 isNativeSqliteAvailable()：在 Node < 22.13 环境优雅降级，不崩溃；
 * 2. 自动创建完整关系表 + FTS5 全文检索表 + 向量缓存表；
 * 3. 基于文件 mtime + SHA-256 的增量对账（未改动文件零重解析，支持全量重建）；
 * 4. 自动刷新 topics/T-*.md 中 <!-- AUTO-GENERATED:START/END --> 区块并维护 dirty 状态；
 * 5. 提供 saveTopicConsensusSummary()、listTopics()、getCardTimeline()、checkStaleCognition()。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseFrontmatter, stringifyFrontmatter } = require('./kb-yaml.cjs');
const { tokenizeForFts } = require('./kb-taxonomy.cjs');

let _sqliteChecked = false;
let _sqliteMod = null;
let _sqliteProbeError = null;

function getNativeSqliteModule() {
  if (_sqliteChecked) return _sqliteMod;
  _sqliteChecked = true;
  try {
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') {
      _sqliteMod = mod;
    } else {
      _sqliteProbeError = 'node:sqlite DatabaseSync unavailable';
    }
  } catch (err) {
    _sqliteProbeError = err?.message || String(err);
  }
  return _sqliteMod;
}

function isNativeSqliteAvailable() {
  return Boolean(getNativeSqliteModule());
}

function getSqliteProbeInfo() {
  const available = isNativeSqliteAvailable();
  return {
    available,
    nodeVersion: process.version,
    error: available ? null : _sqliteProbeError || 'node:sqlite requires Node >= 22.13',
  };
}

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cards (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,
  num                  INTEGER NOT NULL,
  sub_kind             TEXT NOT NULL,
  title                TEXT NOT NULL,
  status               TEXT NOT NULL,
  file_path            TEXT NOT NULL UNIQUE,
  file_sha256          TEXT NOT NULL,
  file_mtime_ms        INTEGER NOT NULL,
  event_date           TEXT,
  publish_date         TEXT,
  ingested_at          TEXT,
  updated_at           TEXT,
  valid_until          TEXT,
  next_check_date      TEXT,
  primary_grade        TEXT,
  evidence_grades_json TEXT,
  legacy_score         REAL,
  verification_tier    TEXT,
  independent_chains   INTEGER DEFAULT 0,
  enrichment_status    TEXT DEFAULT 'raw_migrated',
  core_summary         TEXT NOT NULL DEFAULT '',
  invalidation_text    TEXT NOT NULL DEFAULT '',
  extra_json           TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_cards_kind_status ON cards(kind, status);
CREATE INDEX IF NOT EXISTS idx_cards_valid_until ON cards(valid_until);
CREATE INDEX IF NOT EXISTS idx_cards_next_check ON cards(next_check_date);

CREATE TABLE IF NOT EXISTS card_tags (
  card_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  axis     TEXT NOT NULL,
  tag      TEXT NOT NULL,
  PRIMARY KEY (card_id, axis, tag)
);
CREATE INDEX IF NOT EXISTS idx_card_tags_lookup ON card_tags(axis, tag);

CREATE TABLE IF NOT EXISTS card_entities (
  card_id      TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_key   TEXT NOT NULL,
  entity_name  TEXT NOT NULL,
  role         TEXT DEFAULT 'mentioned',
  PRIMARY KEY (card_id, entity_type, entity_key)
);
CREATE INDEX IF NOT EXISTS idx_entities_key ON card_entities(entity_type, entity_key);

CREATE TABLE IF NOT EXISTS edges (
  source_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  edge_type  TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  note       TEXT DEFAULT '',
  PRIMARY KEY (source_id, edge_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);

CREATE TABLE IF NOT EXISTS review_events (
  event_id           TEXT PRIMARY KEY,
  date               TEXT NOT NULL,
  card_id            TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  ledger_ref         TEXT,
  evidence_chain_id  TEXT NOT NULL,
  regime             TEXT,
  verdict            TEXT NOT NULL,
  legacy_delta       REAL DEFAULT 0,
  legacy_score_after REAL,
  note               TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_review_card_date ON review_events(card_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_review_chain ON review_events(card_id, evidence_chain_id);

CREATE TABLE IF NOT EXISTS topics (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  chain_prefix         TEXT NOT NULL,
  status               TEXT NOT NULL,
  file_path            TEXT NOT NULL UNIQUE,
  file_sha256          TEXT NOT NULL,
  last_synthesized_at  TEXT,
  last_card_event_at   TEXT,
  consensus_summary    TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS topic_members (
  topic_id  TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  card_id   TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, card_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  card_id UNINDEXED,
  title_tokens,
  body_tokens,
  entity_tokens,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS embeddings_cache (
  card_id      TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  model_id     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  dims         INTEGER NOT NULL,
  vector_blob  BLOB NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function pad3(n) {
  return String(Number(n)).padStart(3, '0');
}

function pad2(n) {
  return String(Number(n)).padStart(2, '0');
}

function toLegacyId(kbId, num) {
  const s = String(kbId || '');
  if (s.startsWith('CF:')) return String(Number(s.slice(3)) || num || 0);
  if (s.startsWith('M:') || s.startsWith('C:')) return pad3(Number(s.slice(2)) || num || 0);
  return num ? pad3(num) : s;
}

function normalizeKbCardId(rawId, fallbackKind = 'M') {
  const s = String(rawId || '').trim();
  if (!s) return '';
  const m = s.match(/^([MC])[-:](\d{1,3})$/i);
  if (m) return `${m[1].toUpperCase()}:${pad3(m[2])}`;
  const cf = s.match(/^CF[-:](\d{1,2})$/i);
  if (cf) return `CF:${pad2(cf[1])}`;
  if (/^\d{1,3}$/.test(s)) return `${fallbackKind}:${pad3(s)}`;
  return s;
}

function openKbDatabase(kbDir) {
  const sqliteMod = getNativeSqliteModule();
  if (!sqliteMod) {
    const err = new Error('当前 Node 运行环境不支持原生 node:sqlite（需 Node >= 22.13），已自动降级为内存模式。');
    err.code = 'SQLITE_UNAVAILABLE';
    throw err;
  }
  const indexDir = path.join(kbDir, '.index');
  fs.mkdirSync(indexDir, { recursive: true });
  const dbPath = path.join(indexDir, 'knowledge.sqlite');
  const db = new sqliteMod.DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  return { db, dbPath };
}

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

function extractTopicConsensusText(body) {
  const raw = String(body || '');
  const markerIdx = raw.indexOf('<!-- AUTO-GENERATED:START -->');
  const above = (markerIdx >= 0 ? raw.slice(0, markerIdx) : raw).trim();
  const sec = extractBodySection(above, /^## 一、/);
  return sec || above;
}

function listMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f));
}

function readReviewLogJsonl(kbDir) {
  const reviewLogPath = path.join(kbDir, 'events', 'review-log.jsonl');
  if (!fs.existsSync(reviewLogPath)) return [];
  const raw = fs.readFileSync(reviewLogPath, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
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

/**
 * 增量对账同步（mtime + SHA-256，支持 forceRebuild；Node < 22.13 优雅降级返回内存统计）
 */
function syncKbToSqlite(kbDir, { forceRebuild = false, refreshTopics = true } = {}) {
  const t0 = Date.now();
  if (!isNativeSqliteAvailable()) {
    const mFiles = listMdFiles(path.join(kbDir, 'cards', 'methodology'));
    const cFiles = listMdFiles(path.join(kbDir, 'cards', 'cognition'));
    const cfFiles = listMdFiles(path.join(kbDir, 'cards', 'conflicts'));
    const tFiles = listMdFiles(path.join(kbDir, 'topics'));
    const revEvents = readReviewLogJsonl(kbDir);
    return {
      ok: true,
      sqliteAvailable: false,
      fallbackMode: 'memory',
      elapsedMs: Date.now() - t0,
      dbPath: path.join(kbDir, '.index', 'knowledge.sqlite'),
      insertedOrUpdated: 0,
      skippedUnchanged: mFiles.length + cFiles.length + cfFiles.length,
      removedCount: 0,
      reviewEventsSynced: revEvents.length,
      totals: {
        byKind: {
          methodology: mFiles.length,
          cognition: cFiles.length,
          conflict: cfFiles.length,
        },
        edges: 0,
        tags: 0,
        entities: 0,
        reviewEvents: revEvents.length,
        topics: tFiles.length,
      },
    };
  }

  const dbPath = path.join(kbDir, '.index', 'knowledge.sqlite');
  if (forceRebuild && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    for (const suf of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suf)) {
        try {
          fs.unlinkSync(dbPath + suf);
        } catch {
          // ignore
        }
      }
    }
  }
  const { db } = openKbDatabase(kbDir);

  const existingFiles = new Map();
  for (const row of db.prepare('SELECT id, file_path, file_sha256, file_mtime_ms FROM cards').all()) {
    existingFiles.set(row.file_path, row);
  }

  const cardSources = [
    { kind: 'methodology', dir: path.join(kbDir, 'cards', 'methodology') },
    { kind: 'cognition', dir: path.join(kbDir, 'cards', 'cognition') },
    { kind: 'conflict', dir: path.join(kbDir, 'cards', 'conflicts') },
  ];

  const seenPaths = new Set();
  let insertedOrUpdated = 0;
  let skippedUnchanged = 0;
  let removedCount = 0;

  const upsertCardStmt = db.prepare(`
    INSERT INTO cards (
      id, kind, num, sub_kind, title, status, file_path, file_sha256, file_mtime_ms,
      event_date, publish_date, ingested_at, updated_at, valid_until, next_check_date,
      primary_grade, evidence_grades_json, legacy_score, verification_tier,
      independent_chains, enrichment_status, core_summary, invalidation_text, extra_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind=excluded.kind, num=excluded.num, sub_kind=excluded.sub_kind, title=excluded.title,
      status=excluded.status, file_path=excluded.file_path, file_sha256=excluded.file_sha256,
      file_mtime_ms=excluded.file_mtime_ms, event_date=excluded.event_date, publish_date=excluded.publish_date,
      ingested_at=excluded.ingested_at, updated_at=excluded.updated_at, valid_until=excluded.valid_until,
      next_check_date=excluded.next_check_date, primary_grade=excluded.primary_grade,
      evidence_grades_json=excluded.evidence_grades_json, legacy_score=excluded.legacy_score,
      verification_tier=excluded.verification_tier, independent_chains=excluded.independent_chains,
      enrichment_status=excluded.enrichment_status, core_summary=excluded.core_summary,
      invalidation_text=excluded.invalidation_text, extra_json=excluded.extra_json
  `);

  const delTagsStmt = db.prepare('DELETE FROM card_tags WHERE card_id = ?');
  const insTagStmt = db.prepare('INSERT OR IGNORE INTO card_tags (card_id, axis, tag) VALUES (?, ?, ?)');
  const delEntitiesStmt = db.prepare('DELETE FROM card_entities WHERE card_id = ?');
  const insEntityStmt = db.prepare('INSERT OR IGNORE INTO card_entities (card_id, entity_type, entity_key, entity_name, role) VALUES (?, ?, ?, ?, ?)');
  const delEdgesStmt = db.prepare('DELETE FROM edges WHERE source_id = ?');
  const insEdgeStmt = db.prepare('INSERT OR IGNORE INTO edges (source_id, edge_type, target_id, note) VALUES (?, ?, ?, ?)');
  const delFtsStmt = db.prepare('DELETE FROM cards_fts WHERE card_id = ?');
  const insFtsStmt = db.prepare('INSERT INTO cards_fts (card_id, title_tokens, body_tokens, entity_tokens) VALUES (?, ?, ?, ?)');

  let inTx = false;
  try {
    db.exec('BEGIN');
    inTx = true;

    for (const src of cardSources) {
      for (const absPath of listMdFiles(src.dir)) {
        const relPath = path.relative(kbDir, absPath).replace(/\\/g, '/');
        seenPaths.add(relPath);
        const stat = fs.statSync(absPath);
        const mtimeMs = Math.floor(stat.mtimeMs);
        const prev = existingFiles.get(relPath);

        if (prev && prev.file_mtime_ms === mtimeMs) {
          skippedUnchanged++;
          continue;
        }
        const buf = fs.readFileSync(absPath);
        const hash = sha256(buf);
        if (prev && prev.file_sha256 === hash) {
          db.prepare('UPDATE cards SET file_mtime_ms = ? WHERE id = ?').run(mtimeMs, prev.id);
          skippedUnchanged++;
          continue;
        }

        const { frontmatter: fm, body } = parseFrontmatter(buf.toString('utf8'));
        const id = String(fm.id || path.basename(absPath, '.md'));
        const num = Number(fm.num || 0);
        const subKind = String(fm.card_kind || fm.claim_type || src.kind);
        const title = String(fm.title || '');
        const status = String(fm.status || 'active');

        let coreSummary = '';
        let invalidationText = '';
        if (src.kind === 'methodology') {
          coreSummary = extractBodySection(body, /^## 核心论断/);
          invalidationText = extractBodySection(body, /^## 失效信号/);
        } else if (src.kind === 'cognition') {
          coreSummary = extractBodySection(body, /^## (?:事实与要点|客观事实)/);
          invalidationText = extractBodySection(body, /^## 失效与更新条件/);
        } else {
          coreSummary = extractBodySection(body, /^## 冲突点/);
          invalidationText = extractBodySection(body, /^## 折中思路/);
        }

        const primaryGrade = fm.primary_grade || null;
        const evidenceGradesJson = Array.isArray(fm.evidence_grades) ? JSON.stringify(fm.evidence_grades) : null;
        const legacyScore =
          fm.legacy_credibility && typeof fm.legacy_credibility.score === 'number'
            ? fm.legacy_credibility.score
            : null;
        const verificationTier = fm.epistemic?.verification_tier || null;
        const independentChains = Number(fm.epistemic?.independent_chains || 0);
        const enrichmentStatus = fm.legacy_meta?.enrichment_status || 'raw_migrated';

        const extraObj = {
          legacy_credibility: fm.legacy_credibility || null,
          epistemic: fm.epistemic || null,
          sources_raw: fm.sources_raw || null,
          confidence_raw: fm.confidence_raw || null,
          legacy_grade: fm.legacy_grade || null,
          topics: fm.topics || [],
          legacy_meta: fm.legacy_meta || {},
          parameters: fm.parameters || null,
          claims: fm.claims || null,
        };

        upsertCardStmt.run(
          id,
          src.kind,
          num,
          subKind,
          title,
          status,
          relPath,
          hash,
          mtimeMs,
          fm.event_date || fm.created_at || null,
          fm.publish_date || fm.created_at || null,
          fm.ingested_at || fm.created_at || null,
          fm.updated_at || fm.created_at || null,
          fm.valid_until || null,
          fm.next_check_date || null,
          primaryGrade,
          evidenceGradesJson,
          legacyScore,
          verificationTier,
          independentChains,
          enrichmentStatus,
          coreSummary,
          invalidationText,
          JSON.stringify(extraObj)
        );

        delTagsStmt.run(id);
        const tagAxes = [
          ['domain', fm.domains],
          ['regime', fm.regimes],
          ['horizon', fm.horizons],
          ['asset_class', fm.asset_classes],
          ['chain_node', fm.chain_nodes],
        ];
        for (const [axis, arr] of tagAxes) {
          if (!Array.isArray(arr)) continue;
          for (const tag of arr) insTagStmt.run(id, axis, String(tag));
        }

        delEntitiesStmt.run(id);
        const entityTokensList = [];
        if (Array.isArray(fm.tickers)) {
          for (const tk of fm.tickers) {
            if (!tk || !tk.code) continue;
            insEntityStmt.run(id, 'ticker', String(tk.code).toUpperCase(), String(tk.name || tk.code), String(tk.role || 'mentioned'));
            entityTokensList.push(String(tk.code), String(tk.name || ''));
          }
        }

        delEdgesStmt.run(id);
        if (Array.isArray(fm.relations)) {
          for (const rel of fm.relations) {
            if (!rel || !rel.type || !rel.target) continue;
            insEdgeStmt.run(id, String(rel.type), String(rel.target), String(rel.note || ''));
          }
        }

        delFtsStmt.run(id);
        const idAlias = id.replace(/[:\-]/g, '');
        insFtsStmt.run(
          id,
          tokenizeForFts(`${id} ${idAlias} ${toLegacyId(id, num)} ${title}`),
          tokenizeForFts(body),
          tokenizeForFts(entityTokensList.join(' '))
        );

        insertedOrUpdated++;
      }
    }

    for (const [oldPath, row] of existingFiles.entries()) {
      if (!seenPaths.has(oldPath)) {
        delFtsStmt.run(row.id);
        db.prepare('DELETE FROM cards WHERE id = ?').run(row.id);
        removedCount++;
      }
    }

    const validCardIds = new Set(db.prepare('SELECT id FROM cards').all().map((r) => r.id));

    // 同步 events/review-log.jsonl
    const reviewLogPath = path.join(kbDir, 'events', 'review-log.jsonl');
    let reviewEventsSynced = 0;
    if (fs.existsSync(reviewLogPath)) {
      const rBuf = fs.readFileSync(reviewLogPath);
      const rHash = sha256(rBuf);
      const prevHashRow = db.prepare("SELECT value FROM sync_meta WHERE key = 'review_log_sha256'").get();
      if (!prevHashRow || prevHashRow.value !== rHash) {
        db.exec('DELETE FROM review_events');
        const insEv = db.prepare(`
          INSERT OR REPLACE INTO review_events (
            event_id, date, card_id, ledger_ref, evidence_chain_id,
            regime, verdict, legacy_delta, legacy_score_after, note
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const lines = rBuf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
        for (const line of lines) {
          let ev = null;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (!ev || !ev.event_id || !validCardIds.has(ev.card_id)) continue;
          insEv.run(
            ev.event_id,
            ev.date || '',
            ev.card_id,
            ev.ledger_ref || '',
            ev.evidence_chain_id || 'EC-DEFAULT',
            ev.regime || '',
            ev.verdict || 'hold_boundary',
            Number(ev.legacy_delta || 0),
            ev.legacy_score_after ?? null,
            ev.note || ''
          );
          reviewEventsSynced++;
        }
        db.exec(`
          UPDATE cards SET independent_chains = (
            SELECT COUNT(DISTINCT evidence_chain_id) FROM review_events WHERE review_events.card_id = cards.id
          ) WHERE kind = 'methodology'
        `);
        db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('review_log_sha256', ?)").run(rHash);
      }
    }

    // 同步 topics/T-*.md 与 topic_members
    const topicFiles = listMdFiles(path.join(kbDir, 'topics'));
    db.exec('DELETE FROM topic_members');
    const upsertTopicStmt = db.prepare(`
      INSERT INTO topics (id, title, chain_prefix, status, file_path, file_sha256, last_synthesized_at, last_card_event_at, consensus_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, chain_prefix=excluded.chain_prefix, status=excluded.status,
        file_path=excluded.file_path, file_sha256=excluded.file_sha256,
        last_synthesized_at=excluded.last_synthesized_at, last_card_event_at=excluded.last_card_event_at,
        consensus_summary=excluded.consensus_summary
    `);
    const insMemberStmt = db.prepare('INSERT OR IGNORE INTO topic_members (topic_id, card_id) VALUES (?, ?)');

    const topicInfoList = [];
    const seenTopicIds = new Set();
    for (const tf of topicFiles) {
      const buf = fs.readFileSync(tf);
      const { frontmatter: fm, body } = parseFrontmatter(buf.toString('utf8'));
      const tid = String(fm.id || path.basename(tf, '.md'));
      const consensus = extractTopicConsensusText(body);
      seenTopicIds.add(tid);
      upsertTopicStmt.run(
        tid,
        String(fm.title || tid),
        String(fm.chain_prefix || ''),
        String(fm.status || 'dirty'),
        path.relative(kbDir, tf).replace(/\\/g, '/'),
        sha256(buf),
        fm.last_synthesized_at || null,
        fm.last_card_event_at || null,
        consensus
      );
      topicInfoList.push({ id: tid, absPath: tf });
    }
    for (const row of db.prepare('SELECT id FROM topics').all()) {
      if (!seenTopicIds.has(row.id)) {
        db.prepare('DELETE FROM topics WHERE id = ?').run(row.id);
      }
    }

    const cogCards = db.prepare("SELECT id, extra_json FROM cards WHERE kind = 'cognition'").all();
    for (const c of cogCards) {
      let parsedExtra = {};
      try {
        parsedExtra = JSON.parse(c.extra_json || '{}');
      } catch {
        // ignore
      }
      for (const tid of parsedExtra.topics || []) {
        if (seenTopicIds.has(tid)) insMemberStmt.run(tid, c.id);
      }
    }

    db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync_at', ?)").run(new Date().toISOString());
    db.exec('COMMIT');
    inTx = false;

    if (refreshTopics && (insertedOrUpdated > 0 || removedCount > 0 || forceRebuild)) {
      refreshTopicAutoSections(db, kbDir, topicInfoList, { markDirtyOnChange: !forceRebuild });
    }

    const totalCards = db.prepare('SELECT kind, COUNT(*) AS cnt FROM cards GROUP BY kind').all();
    const totalEdges = db.prepare('SELECT COUNT(*) AS cnt FROM edges').get().cnt;
    const totalTags = db.prepare('SELECT COUNT(*) AS cnt FROM card_tags').get().cnt;
    const totalEntities = db.prepare('SELECT COUNT(*) AS cnt FROM card_entities').get().cnt;
    const totalReviewEvents = db.prepare('SELECT COUNT(*) AS cnt FROM review_events').get().cnt;

    db.close();
    return {
      ok: true,
      sqliteAvailable: true,
      elapsedMs: Date.now() - t0,
      dbPath,
      insertedOrUpdated,
      skippedUnchanged,
      removedCount,
      reviewEventsSynced,
      totals: {
        byKind: Object.fromEntries(totalCards.map((r) => [r.kind, r.cnt])),
        edges: totalEdges,
        tags: totalTags,
        entities: totalEntities,
        reviewEvents: totalReviewEvents,
        topics: topicInfoList.length,
      },
    };
  } catch (err) {
    if (inTx) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * 刷新所有活视图 topics/T-*.md 中的 <!-- AUTO-GENERATED:START/END --> 区块
 */
function refreshTopicAutoSections(db, kbDir, topicInfoList, { markDirtyOnChange = true } = {}) {
  const getMembersStmt = db.prepare(`
    SELECT c.id, c.num, c.title, c.status, c.primary_grade, c.sub_kind, c.ingested_at, c.updated_at, c.valid_until
    FROM topic_members tm
    JOIN cards c ON c.id = tm.card_id
    WHERE tm.topic_id = ?
    ORDER BY c.updated_at DESC, c.num DESC
  `);
  const getLinkedMethodsStmt = db.prepare(`
    SELECT DISTINCT e.target_id, m.title, m.legacy_score, m.status
    FROM topic_members tm
    JOIN edges e ON e.source_id = tm.card_id AND e.edge_type = 'uses_method'
    LEFT JOIN cards m ON m.id = e.target_id
    WHERE tm.topic_id = ?
    ORDER BY e.target_id
  `);
  const getLinkedConflictsStmt = db.prepare(`
    SELECT DISTINCT e.target_id, cf.title
    FROM topic_members tm
    JOIN edges e ON e.source_id = tm.card_id AND e.edge_type = 'conflicts_with'
    LEFT JOIN cards cf ON cf.id = e.target_id
    WHERE tm.topic_id = ?
    ORDER BY e.target_id
  `);
  const updateTopicMetaStmt = db.prepare(
    'UPDATE topics SET status = ?, last_card_event_at = ?, file_sha256 = ? WHERE id = ?'
  );

  const today = new Date().toISOString().slice(0, 10);

  for (const t of topicInfoList) {
    const members = getMembersStmt.all(t.id);
    const active = members.filter((m) => m.status === 'active');
    const inactive = members.filter((m) => m.status !== 'active');
    const methods = getLinkedMethodsStmt.all(t.id);
    const conflicts = getLinkedConflictsStmt.all(t.id);

    const lines = [
      '<!-- AUTO-GENERATED:START -->',
      `## 二、活跃认知卡注册表（共 ${active.length} 张，自动同步）`,
      '',
      '| 卡号 | 更新日期 | 证据 | 类型 | 到期巡检 | 标题摘要 |',
      '| :--- | :--- | :---: | :---: | :--- | :--- |',
    ];
    for (const c of active) {
      const numStr = pad3(c.num);
      lines.push(
        `| [${c.id}](../cards/cognition/C-${numStr}.md) | ${c.updated_at || c.ingested_at || '-'} | ${c.primary_grade || '-'} | ${c.sub_kind} | ${c.valid_until || '-'} | ${c.title.replace(/\|/g, '\\|')} |`
      );
    }

    lines.push('', `## 三、已替代 / 部分证伪 / 归档卡（共 ${inactive.length} 张，自动同步）`, '');
    if (inactive.length === 0) {
      lines.push('- （当前无非活跃卡）');
    } else {
      for (const c of inactive) {
        const numStr = pad3(c.num);
        lines.push(`- [${c.id}](../cards/cognition/C-${numStr}.md) \`${c.status}\`：${c.title}`);
      }
    }

    lines.push('', '## 四、关联方法论与冲突矩阵（自动同步）', '');
    if (methods.length > 0) {
      lines.push(
        `- **关联方法论（${methods.length} 张）**：${methods
          .slice(0, 15)
          .map((m) => `${m.target_id}（${(m.title || '').slice(0, 18)}）`)
          .join(' / ')}`
      );
    } else {
      lines.push('- **关联方法论**：（待关联）');
    }
    if (conflicts.length > 0) {
      lines.push(`- **关联冲突矩阵**：${conflicts.map((cf) => `${cf.target_id}（${cf.title || ''}）`).join(' / ')}`);
    }
    lines.push('<!-- AUTO-GENERATED:END -->');

    const raw = fs.readFileSync(t.absPath, 'utf8');
    const autoBlock = lines.join('\n');
    const replaced = /<!-- AUTO-GENERATED:START -->[\s\S]*?<!-- AUTO-GENERATED:END -->/.test(raw)
      ? raw.replace(/<!-- AUTO-GENERATED:START -->[\s\S]*?<!-- AUTO-GENERATED:END -->/, autoBlock)
      : `${raw.trimEnd()}\n\n${autoBlock}\n`;

    if (replaced !== raw) {
      const { frontmatter: fm, body } = parseFrontmatter(replaced);
      fm.member_count_snapshot = members.length;
      if (markDirtyOnChange && fm.status === 'synced') {
        fm.status = 'dirty';
        fm.last_card_event_at = today;
      }
      const finalText = stringifyFrontmatter(fm, body);
      fs.writeFileSync(t.absPath, finalText, 'utf8');
      updateTopicMetaStmt.run(
        String(fm.status || 'dirty'),
        fm.last_card_event_at || null,
        sha256(Buffer.from(finalText, 'utf8')),
        t.id
      );
    }
  }
}

/**
 * 列出所有产业链活视图及其成员卡/关联方法论与冲突（支持 SQLite 与内存双模）
 */
function listTopics(kbDir) {
  const topicsDir = path.join(kbDir, 'topics');
  if (!fs.existsSync(topicsDir)) return [];

  if (isNativeSqliteAvailable()) {
    const { db } = openKbDatabase(kbDir);
    try {
      const topicRows = db.prepare('SELECT * FROM topics ORDER BY id ASC').all();
      const getMembersStmt = db.prepare(`
        SELECT c.id, c.num, c.title, c.status, c.primary_grade, c.sub_kind, c.ingested_at, c.updated_at, c.valid_until, c.next_check_date
        FROM topic_members tm
        JOIN cards c ON c.id = tm.card_id
        WHERE tm.topic_id = ?
        ORDER BY c.updated_at DESC, c.num DESC
      `);
      const getLinkedMethodsStmt = db.prepare(`
        SELECT DISTINCT e.target_id AS id, m.num, m.title, m.legacy_score, m.status
        FROM topic_members tm
        JOIN edges e ON e.source_id = tm.card_id AND e.edge_type = 'uses_method'
        LEFT JOIN cards m ON m.id = e.target_id
        WHERE tm.topic_id = ?
        ORDER BY e.target_id
      `);
      const getLinkedConflictsStmt = db.prepare(`
        SELECT DISTINCT e.target_id AS id, cf.num, cf.title
        FROM topic_members tm
        JOIN edges e ON e.source_id = tm.card_id AND e.edge_type = 'conflicts_with'
        LEFT JOIN cards cf ON cf.id = e.target_id
        WHERE tm.topic_id = ?
        ORDER BY e.target_id
      `);

      return topicRows.map((tr) => {
        const members = getMembersStmt.all(tr.id).map((m) => ({
          id: m.id,
          legacyId: toLegacyId(m.id, m.num),
          num: m.num,
          title: m.title,
          status: m.status,
          primaryGrade: m.primary_grade || 'C',
          subKind: m.sub_kind,
          ingestedAt: m.ingested_at || '',
          updatedAt: m.updated_at || '',
          validUntil: m.valid_until || null,
          nextCheckDate: m.next_check_date || null,
        }));
        const activeMembers = members.filter((m) => m.status === 'active');
        const inactiveMembers = members.filter((m) => m.status !== 'active');
        const linkedMethods = getLinkedMethodsStmt.all(tr.id).map((m) => ({
          id: m.id,
          legacyId: toLegacyId(m.id, m.num),
          title: m.title || '',
          legacyScore: m.legacy_score ?? null,
          status: m.status || 'active',
        }));
        const linkedConflicts = getLinkedConflictsStmt.all(tr.id).map((cf) => ({
          id: cf.id,
          legacyId: toLegacyId(cf.id, cf.num),
          title: cf.title || '',
        }));
        const slug = path.basename(tr.file_path || tr.id, '.md').replace(/^T[-:]/, '');
        return {
          id: tr.id,
          slug,
          title: tr.title,
          chainPrefix: tr.chain_prefix || '',
          status: tr.status || 'dirty',
          filePath: tr.file_path,
          lastSynthesizedAt: tr.last_synthesized_at || null,
          lastCardEventAt: tr.last_card_event_at || null,
          consensusSummary: tr.consensus_summary || '',
          memberCount: members.length,
          activeCount: activeMembers.length,
          inactiveCount: inactiveMembers.length,
          activeMembers,
          inactiveMembers,
          linkedMethods,
          linkedConflicts,
        };
      });
    } finally {
      db.close();
    }
  }

  // 无原生 SQLite 时的内存降级实现
  const cogFiles = listMdFiles(path.join(kbDir, 'cards', 'cognition'));
  const cogCards = cogFiles.map((f) => parseFrontmatter(fs.readFileSync(f, 'utf8')).frontmatter);
  return listMdFiles(topicsDir).map((tf) => {
    const { frontmatter: fm, body } = parseFrontmatter(fs.readFileSync(tf, 'utf8'));
    const tid = String(fm.id || path.basename(tf, '.md'));
    const members = cogCards
      .filter((c) => Array.isArray(c.topics) && c.topics.includes(tid))
      .map((c) => ({
        id: c.id,
        legacyId: toLegacyId(c.id, c.num),
        num: Number(c.num || 0),
        title: String(c.title || ''),
        status: String(c.status || 'active'),
        primaryGrade: c.primary_grade || 'C',
        subKind: c.claim_type || 'mixed_fact_forecast',
        ingestedAt: c.ingested_at || '',
        updatedAt: c.updated_at || '',
        validUntil: c.valid_until || null,
        nextCheckDate: c.next_check_date || null,
      }));
    const activeMembers = members.filter((m) => m.status === 'active');
    const inactiveMembers = members.filter((m) => m.status !== 'active');
    return {
      id: tid,
      slug: path.basename(tf, '.md').replace(/^T[-:]/, ''),
      title: String(fm.title || tid),
      chainPrefix: String(fm.chain_prefix || ''),
      status: String(fm.status || 'dirty'),
      filePath: path.relative(kbDir, tf).replace(/\\/g, '/'),
      lastSynthesizedAt: fm.last_synthesized_at || null,
      lastCardEventAt: fm.last_card_event_at || null,
      consensusSummary: extractTopicConsensusText(body),
      memberCount: members.length,
      activeCount: activeMembers.length,
      inactiveCount: inactiveMembers.length,
      activeMembers,
      inactiveMembers,
      linkedMethods: [],
      linkedConflicts: [],
    };
  });
}

/**
 * 保存活视图共识摘要：替换 <!-- AUTO-GENERATED:START --> 上方内容，更新 YAML status: "synced" 与 last_synthesized_at，并重新同步 SQLite
 */
function saveTopicConsensusSummary(kbDir, topicId, summaryMarkdown) {
  const topicsDir = path.join(kbDir, 'topics');
  if (!fs.existsSync(topicsDir)) {
    throw new Error('未找到活视图目录 kb/topics/');
  }
  const rawId = String(topicId || '').trim();
  if (!rawId) throw new Error('topicId 不能为空');
  const cleanSummary = String(summaryMarkdown || '').trim();
  if (!cleanSummary) throw new Error('共识摘要内容不能为空');

  const files = listMdFiles(topicsDir);
  let targetFile = null;
  let targetParsed = null;
  const normSlug = rawId.replace(/^T[-:]/i, '').toLowerCase();

  for (const tf of files) {
    const parsed = parseFrontmatter(fs.readFileSync(tf, 'utf8'));
    const fmId = String(parsed.frontmatter.id || '');
    const fileSlug = path.basename(tf, '.md').replace(/^T[-:]/i, '').toLowerCase();
    if (
      fmId === rawId ||
      fmId.replace(':', '-').toLowerCase() === rawId.toLowerCase() ||
      fileSlug === normSlug
    ) {
      targetFile = tf;
      targetParsed = parsed;
      break;
    }
  }
  if (!targetFile || !targetParsed) {
    throw new Error(`未找到活视图专题：${rawId}`);
  }

  const { frontmatter: fm, body } = targetParsed;
  const marker = '<!-- AUTO-GENERATED:START -->';
  const markerIdx = body.indexOf(marker);
  const autoSection =
    markerIdx >= 0
      ? body.slice(markerIdx).trim()
      : `${marker}\n（由 kb-sqlite 同步引擎自动填充）\n<!-- AUTO-GENERATED:END -->`;

  const formattedTop = /^##\s+一、/.test(cleanSummary)
    ? cleanSummary
    : /^##\s+/.test(cleanSummary)
    ? cleanSummary
    : `## 一、当前核心共识与多空张力\n\n${cleanSummary}`;

  const nextBody = `${formattedTop}\n\n${autoSection}`;
  const nowIso = new Date().toISOString();
  fm.status = 'synced';
  fm.last_synthesized_at = nowIso;

  const finalContent = stringifyFrontmatter(fm, nextBody);
  const tmpPath = `${targetFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, finalContent, 'utf8');
  fs.renameSync(tmpPath, targetFile);

  syncKbToSqlite(kbDir, { forceRebuild: false, refreshTopics: false });
  const updatedTopic = listTopics(kbDir).find((t) => t.id === String(fm.id)) || null;

  return {
    ok: true,
    topicId: String(fm.id),
    filePath: path.relative(kbDir, targetFile).replace(/\\/g, '/'),
    status: 'synced',
    lastSynthesizedAt: nowIso,
    topic: updatedTopic,
  };
}

/**
 * 读取单卡的逐日复盘实证时间轴（events/review-log.jsonl）+ SQLite 入/出有向图谱边
 */
function getCardTimeline(kbDir, cardId) {
  const rawInput = String(cardId || '').trim();
  if (!rawInput) {
    throw new Error('cardId 不能为空');
  }

  let normalizedId = normalizeKbCardId(rawInput, 'M');
  let cardRow = null;
  let outEdges = [];
  let inEdges = [];

  if (isNativeSqliteAvailable()) {
    const { db } = openKbDatabase(kbDir);
    try {
      cardRow = db.prepare('SELECT * FROM cards WHERE id = ?').get(normalizedId);
      if (!cardRow && /^\d{1,3}$/.test(rawInput)) {
        const cogCand = `C:${pad3(rawInput)}`;
        const cogRow = db.prepare('SELECT * FROM cards WHERE id = ?').get(cogCand);
        if (cogRow) {
          normalizedId = cogCand;
          cardRow = cogRow;
        }
      }

      const rawOut = db
        .prepare(
          `SELECT e.source_id, e.edge_type, e.target_id, e.note, c.title AS target_title, c.status AS target_status, c.num AS target_num, c.kind AS target_kind
           FROM edges e
           LEFT JOIN cards c ON c.id = e.target_id
           WHERE e.source_id = ?
           ORDER BY e.edge_type, e.target_id`
        )
        .all(normalizedId);
      outEdges = rawOut.map((e) => ({
        direction: 'out',
        type: e.edge_type,
        edgeType: e.edge_type,
        source: e.source_id,
        sourceId: e.source_id,
        target: e.target_id,
        targetId: e.target_id,
        targetLegacyId: toLegacyId(e.target_id, e.target_num),
        targetKind: e.target_kind || (e.target_id.startsWith('C:') ? 'cognition' : e.target_id.startsWith('CF:') ? 'conflict' : 'methodology'),
        targetTitle: e.target_title || '',
        targetStatus: e.target_status || '',
        note: e.note || '',
      }));

      const rawIn = db
        .prepare(
          `SELECT e.source_id, e.edge_type, e.target_id, e.note, c.title AS source_title, c.status AS source_status, c.num AS source_num, c.kind AS source_kind
           FROM edges e
           LEFT JOIN cards c ON c.id = e.source_id
           WHERE e.target_id = ?
           ORDER BY e.edge_type, e.source_id`
        )
        .all(normalizedId);
      inEdges = rawIn.map((e) => ({
        direction: 'in',
        type: e.edge_type,
        edgeType: e.edge_type,
        source: e.source_id,
        sourceId: e.source_id,
        sourceLegacyId: toLegacyId(e.source_id, e.source_num),
        sourceKind: e.source_kind || (e.source_id.startsWith('C:') ? 'cognition' : e.source_id.startsWith('CF:') ? 'conflict' : 'methodology'),
        sourceTitle: e.source_title || '',
        sourceStatus: e.source_status || '',
        target: e.target_id,
        targetId: e.target_id,
        note: e.note || '',
      }));
    } finally {
      db.close();
    }
  } else {
    // 内存降级：直接扫描文件关系
    const allCardDirs = [
      { kind: 'methodology', dir: path.join(kbDir, 'cards', 'methodology') },
      { kind: 'cognition', dir: path.join(kbDir, 'cards', 'cognition') },
      { kind: 'conflict', dir: path.join(kbDir, 'cards', 'conflicts') },
    ];
    const cardMap = new Map();
    for (const src of allCardDirs) {
      for (const f of listMdFiles(src.dir)) {
        const { frontmatter: fm } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
        if (fm.id) cardMap.set(String(fm.id), { kind: src.kind, fm });
      }
    }
    if (!cardMap.has(normalizedId) && /^\d{1,3}$/.test(rawInput) && cardMap.has(`C:${pad3(rawInput)}`)) {
      normalizedId = `C:${pad3(rawInput)}`;
    }
    const hit = cardMap.get(normalizedId);
    if (hit) {
      cardRow = {
        id: hit.fm.id,
        kind: hit.kind,
        num: Number(hit.fm.num || 0),
        title: String(hit.fm.title || ''),
        status: String(hit.fm.status || 'active'),
        legacy_score: hit.fm.legacy_credibility?.score ?? null,
        verification_tier: hit.fm.epistemic?.verification_tier || null,
        independent_chains: Number(hit.fm.epistemic?.independent_chains || 0),
        valid_until: hit.fm.valid_until || null,
        next_check_date: hit.fm.next_check_date || null,
      };
      for (const rel of hit.fm.relations || []) {
        const tgt = cardMap.get(rel.target);
        outEdges.push({
          direction: 'out',
          type: rel.type,
          edgeType: rel.type,
          source: normalizedId,
          sourceId: normalizedId,
          target: rel.target,
          targetId: rel.target,
          targetLegacyId: toLegacyId(rel.target, tgt?.fm?.num),
          targetKind:
            tgt?.kind ||
            (String(rel.target || '').startsWith('C:')
              ? 'cognition'
              : String(rel.target || '').startsWith('CF:')
              ? 'conflict'
              : 'methodology'),
          targetTitle: tgt?.fm?.title || '',
          targetStatus: tgt?.fm?.status || '',
          note: rel.note || '',
        });
      }
    }
    for (const [sid, info] of cardMap.entries()) {
      for (const rel of info.fm.relations || []) {
        if (rel.target === normalizedId) {
          inEdges.push({
            direction: 'in',
            type: rel.type,
            edgeType: rel.type,
            source: sid,
            sourceId: sid,
            sourceLegacyId: toLegacyId(sid, info.fm.num),
            sourceKind: info.kind,
            sourceTitle: info.fm.title || '',
            sourceStatus: info.fm.status || '',
            target: normalizedId,
            targetId: normalizedId,
            note: rel.note || '',
          });
        }
      }
    }
  }

  // 直接读取 events/review-log.jsonl 以保留完整原始字段（含 raw_label / raw_line）
  const allEvents = readReviewLogJsonl(kbDir)
    .filter((ev) => ev && ev.card_id === normalizedId)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.event_id || '').localeCompare(String(a.event_id || '')));

  const events = allEvents.map((ev) => ({
    eventId: ev.event_id || '',
    date: ev.date || '',
    cardId: ev.card_id,
    ledgerRef: ev.ledger_ref || '',
    evidenceChainId: ev.evidence_chain_id || '',
    regime: ev.regime || '',
    verdict: ev.verdict || 'hold_boundary',
    legacyDelta: Number(ev.legacy_delta || 0),
    legacyScoreAfter: ev.legacy_score_after ?? null,
    rawLabel: ev.raw_label || '',
    note: ev.note || '',
  }));

  const chains = new Set(events.map((e) => e.evidenceChainId).filter(Boolean));
  const confirmedCount = events.filter((e) => e.verdict === 'confirmed').length;
  const falsifiedCount = events.filter((e) => e.verdict === 'falsified').length;
  const holdCount = events.filter((e) => e.verdict === 'hold_boundary').length;

  return {
    ok: true,
    cardId: normalizedId,
    legacyId: toLegacyId(normalizedId, cardRow?.num),
    card: cardRow
      ? {
          id: cardRow.id,
          legacyId: toLegacyId(cardRow.id, cardRow.num),
          kind: cardRow.kind,
          num: cardRow.num,
          title: cardRow.title,
          status: cardRow.status,
          legacyScore: cardRow.legacy_score ?? null,
          verificationTier: cardRow.verification_tier || null,
          independentChains: cardRow.independent_chains ?? chains.size,
          validUntil: cardRow.valid_until || null,
          nextCheckDate: cardRow.next_check_date || null,
        }
      : null,
    events,
    edges: {
      out: outEdges,
      in: inEdges,
    },
    summary: {
      eventCount: events.length,
      independentChains: chains.size,
      confirmedCount,
      falsifiedCount,
      holdCount,
    },
  };
}

/**
 * 主动时效巡检：列出已到期或到复核日期的活跃认知卡（支持 SQLite 与内存双模）
 */
function checkStaleCognition(kbDir, asOfDate = null) {
  const today = asOfDate || new Date().toISOString().slice(0, 10);
  let rows = [];

  if (isNativeSqliteAvailable()) {
    const { db } = openKbDatabase(kbDir);
    try {
      rows = db
        .prepare(
          `SELECT id, num, title, sub_kind, primary_grade, ingested_at, updated_at, valid_until, next_check_date, status
           FROM cards
           WHERE kind = 'cognition' AND status = 'active'
           ORDER BY valid_until ASC, num ASC`
        )
        .all();
    } finally {
      db.close();
    }
  } else {
    rows = listMdFiles(path.join(kbDir, 'cards', 'cognition'))
      .map((f) => parseFrontmatter(fs.readFileSync(f, 'utf8')).frontmatter)
      .filter((fm) => (fm.status || 'active') === 'active')
      .map((fm) => ({
        id: fm.id,
        num: Number(fm.num || 0),
        title: String(fm.title || ''),
        sub_kind: fm.claim_type || 'mixed_fact_forecast',
        primary_grade: fm.primary_grade || 'C',
        ingested_at: fm.ingested_at || '',
        updated_at: fm.updated_at || '',
        valid_until: fm.valid_until || null,
        next_check_date: fm.next_check_date || null,
        status: fm.status || 'active',
      }));
  }

  const normalizeRow = (r) => ({
    id: r.id,
    legacyId: toLegacyId(r.id, r.num),
    num: Number(r.num || 0),
    title: r.title,
    subKind: r.sub_kind,
    sub_kind: r.sub_kind,
    primaryGrade: r.primary_grade || 'C',
    primary_grade: r.primary_grade || 'C',
    ingestedAt: r.ingested_at || '',
    ingested_at: r.ingested_at || '',
    updatedAt: r.updated_at || '',
    updated_at: r.updated_at || '',
    validUntil: r.valid_until || null,
    valid_until: r.valid_until || null,
    nextCheckDate: r.next_check_date || null,
    next_check_date: r.next_check_date || null,
    status: r.status,
  });

  const expired = [];
  const checkDue = [];
  for (const r of rows) {
    if (r.valid_until && r.valid_until < today) expired.push(normalizeRow(r));
    else if (r.next_check_date && r.next_check_date <= today) checkDue.push(normalizeRow(r));
  }

  return {
    asOfDate: today,
    activeTotal: rows.length,
    expiredCount: expired.length,
    checkDueCount: checkDue.length,
    expired,
    checkDue,
  };
}

module.exports = {
  isNativeSqliteAvailable,
  getSqliteProbeInfo,
  openKbDatabase,
  syncKbToSqlite,
  listTopics,
  saveTopicConsensusSummary,
  getCardTimeline,
  checkStaleCognition,
  extractBodySection,
  toLegacyId,
  normalizeKbCardId,
};
