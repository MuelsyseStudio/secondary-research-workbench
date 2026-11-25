'use strict';

/**
 * Stage U2/R1 全量数据备份 ZIP 导出、真实状态覆盖、审计历史保留、原子回滚与盘中闪念速记测试（不打包进 release/）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srw-u2-test-'));
process.env.SRW_DATA_DIR = tmpDir;
process.env.SRW_STATE_DIR = tmpDir;

const { buildZipBuffer } = require('./diagnostic-service.cjs');
const { PATHS, initializeWorkspaceDir } = require('./app-paths.cjs');
const { exportFullBackupZip, importFullBackupZip, parseZipBuffer } = require('./backup-zip-service.cjs');
const { restoreBackup } = require('./writer.cjs');
const { appendAuditLog, queryAuditTrail } = require('./audit-trail.cjs');
const { listQuickNotes, addQuickNote, deleteQuickNote, markQuickNoteConverted } = require('./quick-notes.cjs');

try {
  // 硬安全护栏：绝不允许测试触碰真实现行三库目录！
  initializeWorkspaceDir(tmpDir, 'blank');
  assert.ok(
    path.resolve(PATHS.currentDir).startsWith(path.resolve(tmpDir)),
    `SAFETY GUARD: PATHS.currentDir (${PATHS.currentDir}) must reside inside tmpDir (${tmpDir})`
  );

  // 1. Seed sample 3-library markdown + real persisted state files (watchlist.local.json + technical-alerts.local.json) + secret file
  fs.writeFileSync(path.join(PATHS.currentDir, '方法论卡片库.md'), '# 方法论测试原件 v1\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'watchlist.local.json'), JSON.stringify({ items: [{ secid: '1.600519', code: '600519', name: '贵州茅台' }] }), 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'technical-alerts.local.json'), JSON.stringify({ rules: [{ id: 'rule_1', name: '均线预警' }] }), 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'ai-config.local.json'), JSON.stringify({ deepseek: { apiKey: 'sk-secret-must-not-export' } }), 'utf8');

  appendAuditLog({ category: 'system', action: 'pre.backup.marker', summary: '导出前审计记录' });

  // 2. Quick notes CRUD & convert
  const added = addQuickNote({ text: '光模块早盘放量突破前高', symbol: '300308', tag: '盘中灵感' });
  assert.equal(added.ok, true);
  assert.equal(listQuickNotes().items.length, 1);
  const conv = markQuickNoteConverted(added.item.id, 'cognition');
  assert.equal(conv.item.convertedTo, 'cognition');

  // 3. Export full backup ZIP -> verify contains markdown + watchlist.local.json + technical-alerts.local.json + quick-notes, excludes secrets
  const exported = exportFullBackupZip();
  assert.equal(exported.buffer.subarray(0, 4).toString('binary'), 'PK\x03\x04');
  const parsedEntries = parseZipBuffer(exported.buffer);
  assert.ok(parsedEntries.some((e) => e.name === '现行三库/方法论卡片库.md'), '备份包必须包含三库 Markdown');
  assert.ok(parsedEntries.some((e) => e.name === 'state/watchlist.local.json'), '备份包必须包含实际自选文件 watchlist.local.json');
  assert.ok(parsedEntries.some((e) => e.name === 'state/technical-alerts.local.json'), '备份包必须包含实际预警文件 technical-alerts.local.json');
  assert.ok(parsedEntries.some((e) => e.name === 'state/quick-notes.local.json'), '备份包必须包含闪念速记');
  assert.equal(
    parsedEntries.some((e) => e.name.includes('ai-config.local.json')),
    false,
    '默认全量备份必须排除 ai-config.local.json 密钥文件'
  );
  assert.equal(exported.buffer.includes('sk-secret-must-not-export'), false);

  // 4. Modify markdown & watchlist, append a newer live audit record, then restore from ZIP
  fs.writeFileSync(path.join(PATHS.currentDir, '方法论卡片库.md'), '# 被误改的内容 v2\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'watchlist.local.json'), JSON.stringify({ items: [{ secid: '0.000001', code: '000001', name: '平安银行' }] }), 'utf8');
  appendAuditLog({ category: 'system', action: 'post.backup.must.survive', summary: '此条新审计在还原旧ZIP后必须保留' });

  const restored = importFullBackupZip(exported.buffer.toString('base64'));
  assert.equal(restored.ok, true);
  assert.ok(restored.preRestoreBackupId.startsWith('pre-zip-restore-'));
  assert.equal(fs.readFileSync(path.join(PATHS.currentDir, '方法论卡片库.md'), 'utf8'), '# 方法论测试原件 v1\n');
  assert.ok(fs.readFileSync(path.join(tmpDir, 'watchlist.local.json'), 'utf8').includes('600519'));
  // Live audit history MUST be preserved (never overwritten by old ZIP)
  const auditAfterZip = queryAuditTrail({ all: true });
  assert.ok(
    auditAfterZip.items.some((x) => x.action === 'post.backup.must.survive'),
    'ZIP 还原不得覆盖现行审计历史'
  );

  // 5. Restore from pre-zip-restore snapshot via standard writer.cjs:restoreBackup() -> restores BOTH Markdown and state files!
  const rolledBack = restoreBackup(restored.preRestoreBackupId);
  assert.equal(rolledBack.committed, true);
  assert.equal(fs.readFileSync(path.join(PATHS.currentDir, '方法论卡片库.md'), 'utf8'), '# 被误改的内容 v2\n');
  assert.ok(
    fs.readFileSync(path.join(tmpDir, 'watchlist.local.json'), 'utf8').includes('000001'),
    '标准 restoreBackup 必须兼容恢复 pre-zip-restore 快照中的状态文件'
  );

  // 6. Mid-restore failure must atomically roll back all touched files (no mixed state!)
  let writeCount = 0;
  assert.throws(
    () =>
      importFullBackupZip(exported.buffer, {
        _writeFileFn: (target, buf) => {
          writeCount += 1;
          if (writeCount >= 2) throw new Error('simulated disk full');
          fs.writeFileSync(target, buf);
        },
      }),
    /已自动回滚/
  );
  assert.equal(
    fs.readFileSync(path.join(PATHS.currentDir, '方法论卡片库.md'), 'utf8'),
    '# 被误改的内容 v2\n',
    '中途写入失败后必须自动回滚首个已覆盖文件'
  );

  // 7. Path traversal malicious ZIP must be rejected
  const evilZip = buildZipBuffer([{ name: '../../evil.txt', content: 'pwned' }]);
  assert.throws(() => importFullBackupZip(evilZip), /非法路径/, 'ZIP 路径穿越攻击必须被拦截');

  // 8. 空白空间全量备份导出 absentStateFiles 并可还原空自选（含中途失败回滚 & 旧版 v2 兼容）
  const wlFile = path.join(tmpDir, 'watchlist.local.json');
  if (fs.existsSync(wlFile)) fs.unlinkSync(wlFile);
  const blankExport = exportFullBackupZip();
  assert.equal(blankExport.manifest.schema, 'srw-workspace-backup-v3');
  assert.ok(
    Array.isArray(blankExport.manifest.absentStateFiles) &&
      blankExport.manifest.absentStateFiles.includes('watchlist.local.json'),
    '空白空间导出清单必须显式记录 absentStateFiles: watchlist.local.json'
  );

  // 目标空间已有自选 -> 导入空白空间 v3 备份后应清空旧自选
  fs.writeFileSync(wlFile, JSON.stringify({ items: [{ secid: '1.600519', code: '600519', name: '贵州茅台' }] }), 'utf8');
  const restoredBlank = importFullBackupZip(blankExport.buffer);
  assert.equal(restoredBlank.ok, true);
  assert.ok(restoredBlank.clearedState.includes('watchlist.local.json'), '导入空白空间备份必须清理目标旧自选');
  assert.equal(fs.existsSync(wlFile), false, '导入空白空间备份后目标 watchlist.local.json 必须不存在');

  // 中途失败（删除 watchlist 后触发异常）必须回滚恢复旧自选
  fs.writeFileSync(wlFile, JSON.stringify({ items: [{ secid: '0.300308', code: '300308', name: '中际旭创' }] }), 'utf8');
  assert.throws(
    () =>
      importFullBackupZip(blankExport.buffer, {
        _unlinkFileFn: (target) => {
          fs.unlinkSync(target);
          throw new Error('simulated failure right after clearing watchlist');
        },
      }),
    /已自动回滚/
  );
  assert.equal(fs.existsSync(wlFile), true, '空自选清理后若还原失败必须回滚恢复原自选文件');
  assert.ok(fs.readFileSync(wlFile, 'utf8').includes('300308'));

  // 旧格式 v2 ZIP（无 absentStateFiles 字段且缺失 state/watchlist.local.json）必须保持兼容，不删除现有自选
  const legacyV2Zip = buildZipBuffer([
    { name: '现行三库/方法论卡片库.md', content: '# 旧格式 v2 备份\n' },
    {
      name: 'backup-manifest.json',
      content: JSON.stringify({ schema: 'srw-workspace-backup-v2', markdownFiles: ['方法论卡片库.md'], stateFiles: [] }),
    },
  ]);
  const legacyRestored = importFullBackupZip(legacyV2Zip);
  assert.equal(legacyRestored.ok, true);
  assert.equal(fs.existsSync(wlFile), true, '旧格式 v2 备份缺少自选条目时不得误删现有自选');
  assert.ok(fs.readFileSync(wlFile, 'utf8').includes('300308'));

  // 8b. 空白工作空间（原无 watchlist.local.json）导入含自选的备份包后，手工恢复 pre-zip-restore 快照必须连带删除导入产生的自选文件
  const withWlExport = exportFullBackupZip(); // 此刻存在 300308 自选
  assert.equal(withWlExport.manifest.stateFiles.includes('watchlist.local.json'), true);
  fs.unlinkSync(wlFile);
  assert.equal(fs.existsSync(wlFile), false, '前置：目标工作空间应为空白无自选文件');
  const importedIntoBlank = importFullBackupZip(withWlExport.buffer);
  assert.equal(importedIntoBlank.ok, true);
  assert.equal(fs.existsSync(wlFile), true, '导入含自选备份后 watchlist.local.json 应已写入');
  assert.ok(importedIntoBlank.preRestoreBackupId, '导入前应自动生成 pre-zip-restore 快照');
  const manualRollback = restoreBackup(importedIntoBlank.preRestoreBackupId);
  assert.equal(manualRollback.committed, true, '手工恢复导入前快照必须成功');
  assert.equal(fs.existsSync(wlFile), false, '恢复导入前快照后，原空白空间不得遗留导入产生的 watchlist.local.json');

  // 8c. 兼容旧快照（manifest.stateFiles 无 existed: false 项时，手工恢复不误删当前自选）
  fs.writeFileSync(wlFile, JSON.stringify({ items: [{ secid: '1.600519', code: '600519', name: '贵州茅台' }] }), 'utf8');
  const legacySnapId = 'pre-zip-restore-legacy-compat';
  const legacySnapDir = path.join(tmpDir, 'backups', legacySnapId);
  fs.mkdirSync(path.join(legacySnapDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(legacySnapDir, '方法论卡片库.md'), '# 旧快照方法论\n', 'utf8');
  fs.writeFileSync(
    path.join(legacySnapDir, 'manifest.json'),
    JSON.stringify({
      backupId: legacySnapId,
      files: [{ key: 'methodology', label: '方法论卡片库.md', fileName: '方法论卡片库.md' }],
      stateFiles: [],
    }),
    'utf8'
  );
  restoreBackup(legacySnapId);
  assert.equal(fs.existsSync(wlFile), true, '旧格式快照缺失 absent 记录时，手工恢复不得误删现有自选');

  // 9. Quick notes delete
  const del = deleteQuickNote(added.item.id);
  assert.equal(del.deleted, true);
  assert.equal(listQuickNotes().items.length, 0);

  console.log('STAGE_U2_BACKUP_ZIP_ROLLBACK_AND_QUICK_NOTES_PASSED (30/30 assertions)');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
