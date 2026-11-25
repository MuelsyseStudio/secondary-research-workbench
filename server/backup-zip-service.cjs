'use strict';

/**
 * 全量工作空间数据备份 ZIP 导出与安全还原服务（零外部依赖，纯 Node zlib PKZIP）
 *
 * 导出内容：
 * - 现行三库/*.md（方法论卡片库、行业前沿认知库、研判与复盘台账等）
 * - 个人研究状态数据（自选列表、画线、规则、交易账本、否决池、情绪链、闪念速记、短线复盘与审计日志）
 * - 默认排除 API Key 与授权私钥，避免备份文件外传时泄露凭证（可按需勾选仅恢复个人数据）
 *
 * 还原安全护栏：
 * - 严格禁止目录穿越（..）、绝对路径、未知后缀与未授权文件；
 * - 还原前自动在 backups/ 下留存当前现行三库的完整只读快照，100% 可逆。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { PATHS, getStateDir, stateSubDir, workspaceStateFile } = require('./app-paths.cjs');
const { buildZipBuffer } = require('./diagnostic-service.cjs');

// 按工作空间隔离的便携状态文件：空白空间缺失该文件时，导出清单需显式记录 absentStateFiles，还原时同步清空目标旧数据
const WORKSPACE_SCOPED_STATE_FILES = new Set([
  'watchlist.local.json',
  'custom-themes.local.json',
  'published-strategies.local.json',
  'trade-ledger.local.json',
  'quick-notes.local.json',
  'slime-bot.local.json',
]);

function resolvePortableStatePath(stateDir, name) {
  if (WORKSPACE_SCOPED_STATE_FILES.has(name)) {
    return workspaceStateFile(name);
  }
  return path.join(stateDir, name);
}

// 按实际持久化文件名生成完整迁移清单（默认排除 API Key、授权私钥与实时审计日志覆盖）
const PORTABLE_STATE_ALLOWLIST = new Set([
  'watchlist.local.json',
  'custom-themes.local.json',
  'published-strategies.local.json',
  'technical-alerts.local.json',
  'regulatory-watchlist.local.json',
  'chart-drawings.local.json',
  'sentiment-chain.local.json',
  'trade-ledger.local.json',
  'veto-ledger.local.json',
  'quick-notes.local.json',
  'short-term-cycle.local.json',
  'theme-rotation-history.local.json',
  'review-training.local.json',
  'brand-profile.local.json',
  'bot-watch-alerts.local.json',
  'bot-schedules.local.json',
  'bot-notifications.local.json',
  'slime-bot.local.json',
  'scheduler-config.local.json',
  'intel-hub-inbox.local.json',
  'intel-hub-watermarks.local.json',
]);

// 导出时可附带只读审计档案，还原时绝不覆盖当前存活的 audit-trail.local.jsonl
const AUDIT_TRAIL_FILENAME = 'audit-trail.local.jsonl';

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function inferMdKey(baseName) {
  if (baseName === '方法论卡片库.md') return 'methodology';
  if (baseName === '行业前沿认知库.md') return 'cognition';
  if (baseName === '研判与复盘台账.md') return 'ledger';
  return `md_${baseName.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_')}`;
}

// Standard IEEE 802.3 CRC32
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 纯 Node 解析标准 PKZIP 缓冲区（支持 Store=0 与 Deflate=8）
 */
function parseZipBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new Error('无效的 ZIP 备份文件（文件过小或损坏）');
  }
  // Locate End of Central Directory (0x06054b50) from end
  const minOffset = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('未检测到有效的 ZIP 文件尾签名（请确认上传的是标准 .zip 备份包）');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (totalEntries > 500 || cdOffset + cdSize > buf.length) {
    throw new Error('ZIP 目录索引越界或文件数量超过安全上限（500）');
  }

  const entries = [];
  let pos = cdOffset;
  let totalUncompressed = 0;
  const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB zip-bomb guard

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('ZIP 中央目录结构损坏');
    }
    const method = buf.readUInt16LE(pos + 10);
    const expectedCrc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const lfhOffset = buf.readUInt32LE(pos + 42);

    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // skip directory entry
    if (uncompSize > MAX_UNCOMPRESSED_BYTES || totalUncompressed + uncompSize > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('ZIP 解压后总体积超过 50MB 安全限制');
    }

    if (lfhOffset + 30 > buf.length || buf.readUInt32LE(lfhOffset) !== 0x04034b50) {
      throw new Error(`ZIP 本地文件头损坏: ${name}`);
    }
    const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    if (dataStart + compSize > buf.length) {
      throw new Error(`ZIP 压缩数据区间越界: ${name}`);
    }
    const compSlice = buf.subarray(dataStart, dataStart + compSize);
    const remainingBudget = MAX_UNCOMPRESSED_BYTES - totalUncompressed;

    let raw;
    if (method === 0) {
      if (compSlice.length > remainingBudget) {
        throw new Error('ZIP 实际解压体积超过 50MB 安全限制');
      }
      raw = Buffer.from(compSlice);
    } else if (method === 8) {
      try {
        raw = zlib.inflateRawSync(compSlice, { maxOutputLength: remainingBudget });
      } catch (err) {
        if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|Cannot create a Buffer/i.test(String(err.message)))) {
          throw new Error('ZIP 实际解压体积超过 50MB 安全限制（已拦截解压炸弹）');
        }
        throw new Error(`ZIP 解压失败 (${name}): ${err.message}`);
      }
    } else {
      throw new Error(`不支持的 ZIP 压缩方式 (${method}): ${name}`);
    }

    totalUncompressed += raw.length;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('ZIP 实际解压总体积超过 50MB 安全限制');
    }
    if (raw.length !== uncompSize) {
      throw new Error(`ZIP 文件解压长度与声明不一致: ${name}（声明 ${uncompSize}，实际 ${raw.length}）`);
    }

    if (crc32(raw) !== expectedCrc) {
      throw new Error(`ZIP 文件 CRC32 校验失败（文件可能损坏）: ${name}`);
    }

    entries.push({ name, content: raw });
  }

  return entries;
}

function sanitizeStateBufferForExport(name, rawBuf) {
  if (name !== 'scheduler-config.local.json') return rawBuf;
  try {
    const parsed = JSON.parse(rawBuf.toString('utf8'));
    if (parsed && parsed.webhooks && typeof parsed.webhooks === 'object') {
      for (const ch of Object.values(parsed.webhooks)) {
        if (ch && typeof ch === 'object' && ch.url) {
          ch.url = '';
          ch.redactedOnExport = true;
        }
      }
    }
    return Buffer.from(JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  } catch {
    return rawBuf;
  }
}

function exportFullBackupZip() {
  const entries = [];
  const markdownFiles = [];
  const stateFiles = [];
  let auditArchived = false;

  // 1. Collect all Markdown files in active 现行三库
  if (fs.existsSync(PATHS.currentDir)) {
    for (const ent of fs.readdirSync(PATHS.currentDir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const full = path.join(PATHS.currentDir, ent.name);
      entries.push({
        name: `现行三库/${ent.name}`,
        content: fs.readFileSync(full),
      });
      markdownFiles.push(ent.name);
    }
  }

  // 2. Collect all portable non-secret research state files from active state dir
  const stateDir = getStateDir();
  const absentStateFiles = [];
  if (fs.existsSync(stateDir)) {
    for (const name of PORTABLE_STATE_ALLOWLIST) {
      const full = resolvePortableStatePath(stateDir, name);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        entries.push({
          name: `state/${name}`,
          content: sanitizeStateBufferForExport(name, fs.readFileSync(full)),
        });
        stateFiles.push(name);
      } else if (WORKSPACE_SCOPED_STATE_FILES.has(name)) {
        absentStateFiles.push(name);
      }
    }
    const auditPath = path.join(stateDir, AUDIT_TRAIL_FILENAME);
    if (fs.existsSync(auditPath) && fs.statSync(auditPath).isFile()) {
      entries.push({
        name: `audit-archive/${AUDIT_TRAIL_FILENAME}`,
        content: fs.readFileSync(auditPath),
      });
      auditArchived = true;
    }
  } else {
    for (const name of WORKSPACE_SCOPED_STATE_FILES) {
      absentStateFiles.push(name);
    }
  }

  const manifest = {
    schema: 'srw-workspace-backup-v3',
    createdAt: new Date().toISOString(),
    markdownFiles,
    stateFiles,
    absentStateFiles,
    auditArchived,
    note: '本备份包含现行三库 Markdown、完整研究状态数据与只读审计归档（含空白空间的未配置自选状态），默认排除 AI API Key、数据源密钥与授权私钥。还原时不会覆盖当前审计历史。',
  };
  entries.push({
    name: 'backup-manifest.json',
    content: JSON.stringify(manifest, null, 2) + '\n',
  });

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const buffer = buildZipBuffer(entries);
  return {
    fileName: `research-workbench-backup-${stamp}.zip`,
    buffer,
    manifest,
  };
}

function createPreRestoreSnapshot() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupId = `pre-zip-restore-${stamp}`;
  const dir = path.join(stateSubDir('backups'), backupId);
  const stateSnapDir = path.join(dir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(stateSnapDir, { recursive: true });

  const files = [];
  if (fs.existsSync(PATHS.currentDir)) {
    for (const ent of fs.readdirSync(PATHS.currentDir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const src = path.join(PATHS.currentDir, ent.name);
      const rawBuf = fs.readFileSync(src);
      fs.writeFileSync(path.join(dir, ent.name), rawBuf);
      files.push({
        key: inferMdKey(ent.name),
        label: ent.name,
        fileName: ent.name,
        targetPath: src,
        sha256Before: sha256Buf(rawBuf),
        versionBefore: 'pre-zip',
        versionAfter: 'restored',
      });
    }
  }

  const stateFiles = [];
  const stateDir = getStateDir();
  for (const name of PORTABLE_STATE_ALLOWLIST) {
    const src = resolvePortableStatePath(stateDir, name);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      const rawBuf = fs.readFileSync(src);
      fs.writeFileSync(path.join(stateSnapDir, name), rawBuf);
      stateFiles.push({
        label: name,
        targetPath: src,
        sha256Before: sha256Buf(rawBuf),
        existed: true,
      });
    } else if (WORKSPACE_SCOPED_STATE_FILES.has(name)) {
      // 记录工作空间级状态文件的原始缺失状态，便于手工恢复此快照时一并清理后续导入产生的自选文件
      stateFiles.push({
        label: name,
        targetPath: src,
        sha256Before: null,
        existed: false,
      });
    }
  }

  const existingStateCount = stateFiles.filter((s) => s.existed !== false).length;
  const manifest = {
    backupId,
    createdAt: new Date().toISOString(),
    action: 'backup.zip_import_pre_snapshot',
    summary: [`ZIP 全量备份还原前自动留存快照（${files.length} 份三库 Markdown + ${existingStateCount} 份研究状态文件）`],
    files,
    stateFiles,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { backupId, dir, stateSnapDir, manifest };
}

function atomicWriteBuffer(targetPath, buf) {
  const tmpPath = `${targetPath}.srw-zip.tmp`;
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, targetPath);
}

function importFullBackupZip(zipInput, options = {}) {
  const buf = Buffer.isBuffer(zipInput)
    ? zipInput
    : Buffer.from(String(zipInput || '').replace(/^data:[^;]+;base64,/, ''), 'base64');

  const entries = parseZipBuffer(buf);
  const validMd = [];
  const validState = [];
  const skipped = [];
  let archivedImportedAudit = null;
  let parsedManifest = null;

  for (const entry of entries) {
    const norm = String(entry.name || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!norm || norm.includes('..') || norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
      throw new Error(`检测到非法路径条目，已中止还原: ${entry.name}`);
    }
    if (norm === 'backup-manifest.json') {
      try {
        parsedManifest = JSON.parse(entry.content.toString('utf8'));
      } catch {
        parsedManifest = null;
      }
      continue;
    }

    // 1. 现行三库/*.md (also allow top-level 3-library *.md)
    const mdMatch = norm.match(/^(?:现行三库\/)?([^/]+\.md)$/i);
    if (mdMatch) {
      const baseName = mdMatch[1];
      if (!/^[\u4e00-\u9fa5A-Za-z0-9._\-（）() ]+\.md$/.test(baseName)) {
        skipped.push(norm);
        continue;
      }
      validMd.push({ baseName, content: entry.content });
      continue;
    }

    // 2. 审计历史绝不覆盖现行 audit-trail.local.jsonl，改为归档留存
    const auditMatch = norm.match(/^(?:state\/|audit-archive\/)?([^/]+)$/);
    if (auditMatch && auditMatch[1] === AUDIT_TRAIL_FILENAME) {
      archivedImportedAudit = entry.content;
      continue;
    }

    // 3. state/<allowed-state-file>
    const stateMatch = norm.match(/^(?:state\/)?([^/]+)$/);
    if (stateMatch && PORTABLE_STATE_ALLOWLIST.has(stateMatch[1])) {
      const text = entry.content.toString('utf8');
      if (stateMatch[1].endsWith('.json')) {
        JSON.parse(text);
      }
      validState.push({ baseName: stateMatch[1], content: entry.content });
      continue;
    }

    skipped.push(norm);
  }

  const presentStateNames = new Set(validState.map((x) => x.baseName));
  // 仅当新版备份清单显式声明 absentStateFiles 时，还原期才清理目标工作空间对应旧状态文件（保留旧格式 v2 缺项兼容行为）
  const explicitAbsentState = Array.isArray(parsedManifest?.absentStateFiles)
    ? parsedManifest.absentStateFiles.filter(
        (name) =>
          typeof name === 'string' &&
          PORTABLE_STATE_ALLOWLIST.has(name) &&
          WORKSPACE_SCOPED_STATE_FILES.has(name) &&
          !presentStateNames.has(name)
      )
    : [];

  if (validMd.length === 0 && validState.length === 0 && explicitAbsentState.length === 0) {
    throw new Error('备份包中未检测到任何有效的三库 Markdown 或受支持的状态文件');
  }

  // Always snapshot current 3-library files + state files before overwriting!
  const snap = createPreRestoreSnapshot();
  const stateDir = getStateDir();

  fs.mkdirSync(PATHS.currentDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Track every touched target so any mid-restore failure rolls back cleanly without mixed state
  const rollbackLog = [];
  const writerFn = typeof options._writeFileFn === 'function' ? options._writeFileFn : atomicWriteBuffer;
  const clearedState = [];

  try {
    for (const item of validMd) {
      const target = path.join(PATHS.currentDir, item.baseName);
      const existed = fs.existsSync(target);
      const snapCopy = path.join(snap.dir, item.baseName);
      rollbackLog.push({ target, existed, snapCopy });
      writerFn(target, item.content, item.baseName);
    }
    for (const item of validState) {
      const target = resolvePortableStatePath(stateDir, item.baseName);
      const existed = fs.existsSync(target);
      const snapCopy = path.join(snap.stateSnapDir, item.baseName);
      rollbackLog.push({ target, existed, snapCopy });
      writerFn(target, item.content, item.baseName);
    }
    for (const absentName of explicitAbsentState) {
      const target = resolvePortableStatePath(stateDir, absentName);
      const existed = fs.existsSync(target);
      const snapCopy = path.join(snap.stateSnapDir, absentName);
      if (existed) {
        rollbackLog.push({ target, existed: true, snapCopy });
        if (typeof options._unlinkFileFn === 'function') {
          options._unlinkFileFn(target, absentName);
        } else {
          fs.unlinkSync(target);
        }
        clearedState.push(absentName);
      }
    }
    if (archivedImportedAudit) {
      const archiveStamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archiveFile = path.join(stateDir, `audit-trail.imported-${archiveStamp}.jsonl`);
      fs.writeFileSync(archiveFile, archivedImportedAudit);
    }
  } catch (err) {
    // Atomic rollback in reverse order
    for (let i = rollbackLog.length - 1; i >= 0; i--) {
      const rec = rollbackLog[i];
      try {
        if (rec.existed && fs.existsSync(rec.snapCopy)) {
          atomicWriteBuffer(rec.target, fs.readFileSync(rec.snapCopy));
        } else if (!rec.existed && fs.existsSync(rec.target)) {
          fs.unlinkSync(rec.target);
        }
      } catch {
        // best effort rollback
      }
    }
    throw new Error(`备份还原中途失败，已自动回滚至还原前状态（快照 ${snap.backupId}）：${err.message}`);
  }

  return {
    ok: true,
    preRestoreBackupId: snap.backupId,
    restoredMarkdown: validMd.map((x) => x.baseName),
    restoredState: validState.map((x) => x.baseName),
    clearedState,
    auditTrailPreserved: true,
    skippedCount: skipped.length,
  };
}

module.exports = {
  PORTABLE_STATE_ALLOWLIST,
  parseZipBuffer,
  exportFullBackupZip,
  createPreRestoreSnapshot,
  importFullBackupZip,
};
