'use strict';

/**
 * 三库 v2（kb-v2）核心后端回归与契约验证套件（node server/kb-v2.test.cjs）
 *
 * 严格隔离在系统临时目录运行，严禁修改真实 现行三库/ 目录！
 * 覆盖：
 * 1. isNativeSqliteAvailable() 探针与 YAML 往返
 * 2. templates/starter-workspace 无损 v1→v2 迁移 + 双模 loadWorkspace() 全字段对等 + 质检零报错
 * 3. 只读抽样/全量验证 现行三库/（若存在）无损迁移、C:040←C:096 反证图谱、688809 实体检索、同义词检索、时效巡检、时间轴与逆向单文件编译（且验证原件 SHA-256 100% 零变动）
 * 4. 单卡原子写库（preview/baseHashes/commit/409乐观锁/review-log.jsonl 追加/batch 事务/台账联动/backup 回滚恢复 + SQLite 联动）
 * 5. saveTopicConsensusSummary() 活视图共识摘要落盘与 SQLite 同步
 * 6. 纯 v2 空间识别（无 现行三库/ 时 detectKbMode & hasThreeLibraries 均正确放行）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srw-kb-v2-test-'));
const realSampleTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srw-kb-v2-real-ro-'));
const pureV2TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srw-kb-v2-pure-'));

process.env.SRW_DATA_DIR = tmpDir;
process.env.SRW_STATE_DIR = tmpDir;

const {
  PATHS,
  detectKbMode,
  hasThreeLibraries,
  initializeWorkspaceDir,
  getWorkspaceProfileInfo,
} = require('./app-paths.cjs');
initializeWorkspaceDir(tmpDir, 'starter');

assert.ok(
  path.resolve(PATHS.currentDir).startsWith(path.resolve(tmpDir)),
  `SAFETY GUARD: PATHS.currentDir (${PATHS.currentDir}) must reside inside tmpDir (${tmpDir})`
);

const kb = require('./kb/index.cjs');
const store = require('./knowledge-store.cjs');
const { parseMethodology, parseCognition, sha256 } = require('./parser.cjs');
const { runQualityAudit } = require('./auditor.cjs');
const { buildMutationPlan, commitMutationPlan, restoreBackup } = require('./writer.cjs');

function fileSha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// 记录真实 现行三库/ 哈希（如存在）以确保整个测试全程严格只读、字节级零变动
const realRepoRoot = path.resolve(__dirname, '..', '..');
const realCurrentDir = path.join(realRepoRoot, '现行三库');
const realMethodPath = path.join(realCurrentDir, '方法论卡片库.md');
const realCogPath = path.join(realCurrentDir, '行业前沿认知库.md');
const realLedgerPath = path.join(realCurrentDir, '研判与复盘台账.md');
const hasRealSample =
  fs.existsSync(realMethodPath) && fs.existsSync(realCogPath) && fs.existsSync(realLedgerPath);

const realHashesBefore = hasRealSample
  ? {
      methodology: fileSha256(realMethodPath),
      cognition: fileSha256(realCogPath),
      ledger: fileSha256(realLedgerPath),
    }
  : null;

let assertions = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  assertions++;
}

try {
  // -------------------------------------------------------------------------
  // 1. 运行时探针与 YAML Frontmatter 往返
  // -------------------------------------------------------------------------
  const probe = kb.getSqliteProbeInfo();
  check(typeof kb.isNativeSqliteAvailable() === 'boolean', 'isNativeSqliteAvailable() 应返回布尔值');
  check(probe.available === kb.isNativeSqliteAvailable(), 'getSqliteProbeInfo().available 应与探针一致');
  check(kb.isNativeSqliteAvailable() === true, `当前 Node ${process.version} 应支持原生 node:sqlite`);

  const yamlSample = {
    id: 'C:001',
    num: 1,
    title: '测试：含"引号"、冒号:与括号（2026）',
    active: true,
    score: 0.85,
    emptyArr: [],
    tags: ['ai.optical', 'semi.memory'],
    nested: { score: 0.8, flag: false },
    relations: [{ type: 'conflicts_with', target: 'CF:01', note: '示例冲突' }],
  };
  const yamlMd = kb.stringifyFrontmatter(yamlSample, '## 核心论断\n正文\n  - 缩进子行');
  const yamlParsed = kb.parseFrontmatter(yamlMd);
  assert.deepEqual(yamlParsed.frontmatter, yamlSample);
  check(yamlParsed.body.includes('缩进子行'), 'YAML 往返应完整保留正文与缩进子行');

  // -------------------------------------------------------------------------
  // 2. 起步模板 v1 基线加载 → 无损迁移至 v2 → 双模 loadWorkspace() 对等性验证
  // -------------------------------------------------------------------------
  check(detectKbMode(tmpDir) === 'v1', '迁移前 detectKbMode 应为 v1');
  check(PATHS.kbMode === 'v1', '迁移前 PATHS.kbMode 应为 v1');
  const profileV1 = getWorkspaceProfileInfo();
  check(profileV1.kbMode === 'v1', '迁移前 WorkspaceProfileInfo.kbMode 应为 v1');

  const wsV1 = store.loadWorkspace();
  check(wsV1.kbMode === 'v1', 'v1 模式 loadWorkspace() 必须带 kbMode="v1"');
  check(wsV1.methodology.cards.length === 12, 'starter 模板应包含 12 张方法论卡');
  check(wsV1.methodology.conflicts.length === 2, 'starter 模板应包含 2 条冲突矩阵');
  check(wsV1.cognition.cards.length === 4, 'starter 模板应包含 4 张认知卡');

  const migRes = store.migrateCurrentWorkspaceToV2();
  check(migRes.ok === true, 'starter 模板 v1→v2 迁移必须成功');
  check(migRes.lossless.ok === true, 'starter 模板迁移字符级无损核验必须 100% 通过');
  check(migRes.originalsUnchanged === true, '迁移后原件 SHA-256 必须零变动');
  check(PATHS.kbMode === 'v2', '迁移后 PATHS.kbMode 应自动切换为 v2');
  check(getWorkspaceProfileInfo().kbMode === 'v2', '迁移后 WorkspaceProfileInfo.kbMode 应为 v2');

  // 重复迁移无 force 必须安全拒绝
  const dupMig = store.migrateCurrentWorkspaceToV2();
  check(dupMig.ok === false && dupMig.alreadyExists === true, '未传 force 重复迁移应安全返回 alreadyExists');

  const wsV2 = store.loadWorkspace();
  check(wsV2.kbMode === 'v2', 'v2 模式 loadWorkspace() 必须返回 kbMode="v2"');
  assert.equal(wsV2.methodology.cards.length, wsV1.methodology.cards.length, 'v1/v2 方法论卡数必须一致');
  assert.equal(wsV2.methodology.conflicts.length, wsV1.methodology.conflicts.length, 'v1/v2 冲突数必须一致');
  assert.equal(wsV2.cognition.cards.length, wsV1.cognition.cards.length, 'v1/v2 认知卡数必须一致');
  assert.equal(wsV2.ledger.dailyReviews.length, wsV1.ledger.dailyReviews.length, 'v1/v2 台账日度复盘数必须一致');
  assert.equal(wsV2.highFreqCards.length, wsV1.highFreqCards.length, 'v1/v2 高频复盘卡数必须一致');
  assert.deepEqual(wsV2.methodology.stats.reservedMissing, [], 'starter 模板不得包含硬编码私库保留号 150');

  // 校验 v2 扩展结构
  check(wsV2.kbSummary && wsV2.kbSummary.nodeCount === 18, 'kbSummary.nodeCount 应等于 12+4+2=18');
  check(wsV2.kbSummary.sqliteAvailable === true, 'kbSummary.sqliteAvailable 应为 true');
  check(Array.isArray(wsV2.topics) && wsV2.topics.length === 8, 'topics 应包含 8 个活视图专题');
  check(wsV2.staleReport && typeof wsV2.staleReport.activeTotal === 'number', 'staleReport 必须存在');
  const m001 = wsV2.methodology.cards.find((c) => c.id === '001');
  check(m001 && m001.v2Meta && m001.v2Meta.kbId === 'M:001', '方法论卡必须附带 v2Meta.kbId');
  check(Array.isArray(m001.v2Meta.domains) && m001.v2Meta.domains.length > 0, '方法论卡 v2Meta.domains 必须非空');
  check(m001.v2Meta.reviewEventCount === 1, 'starter 模板 M:001 应剥离 1 条复盘事件');
  const c001 = wsV2.cognition.cards.find((c) => c.id === '001');
  check(c001 && c001.v2Meta && c001.v2Meta.kbId === 'C:001', '认知卡必须附带 v2Meta.kbId');
  check(Array.isArray(c001.v2Meta.chainNodes) && c001.v2Meta.chainNodes.length > 0, '认知卡 v2Meta.chainNodes 必须非空');
  check(typeof c001.v2Meta.isExpired === 'boolean' && typeof c001.v2Meta.isCheckDue === 'boolean', '认知卡 v2Meta 应含时效布尔标记');

  // 质检引擎在 v2 WorkspaceData 上运行零 error
  const v2Audit = runQualityAudit(wsV2);
  assert.equal(v2Audit.summary.errorCount, 0, `v2 starter 模板质检应为 0 error，实际：${JSON.stringify(v2Audit.issues)}`);
  assertions++;

  // -------------------------------------------------------------------------
  // 3. 混合检索、AI 真相编译器、时效巡检、单卡时间轴与活视图共识保存
  // -------------------------------------------------------------------------
  const searchRes = store.getKbSearch({ q: '光模块 CPO 1.6T', limit: 10 });
  check(searchRes.ok === true && searchRes.results.length > 0, 'hybridSearch 应命中 starter 光互联认知卡');
  check(searchRes.results.some((r) => r.id === 'C:001'), '搜索光模块/CPO 应通过同义词/BM25 命中 C:001');

  const aiCtx = store.compileAiContextForActiveWorkspace({
    mode: 'judgment',
    query: '光模块 800G 1.6T 海外映射 MA5 乖离',
    charBudget: 8000,
  });
  check(aiCtx && aiCtx.promptText.includes('AI 真相编译上下文包'), 'compileAiContext 应生成结构化上下文包');
  check(aiCtx.charLength <= 8100, 'compileAiContext 应遵守 charBudget 预算');

  const staleFuture = store.getKbStale('2027-06-01');
  check(staleFuture.ok === true && staleFuture.expiredCount === 4, '在未来日期 2027-06-01 巡检应全部标为过期');

  const timeline001 = store.getKbCardTimeline('M:001');
  check(timeline001.ok === true && timeline001.events.length === 1, 'getKbCardTimeline(M:001) 应返回 1 条复盘事件');
  const cf01InEdge = timeline001.edges.in.find((e) => e.sourceId === 'CF:01');
  check(
    Boolean(cf01InEdge && cf01InEdge.direction === 'in' && cf01InEdge.type === 'conflicts_with' && cf01InEdge.source === 'CF:01' && cf01InEdge.target === 'M:001'),
    'M:001 入边应包含 CF:01 且完整导出 direction/type/source/target 字段'
  );

  // 活视图共识摘要保存与 SQLite 同步
  const savedTopic = store.saveTopicConsensusSummary(
    'T:ai-optical',
    '## 一、当前核心共识与多空张力\n\n- **核心共识**：800G 放量与 1.6T 导入同步加速。\n- **关键分歧**：CPO 渗透节奏与可插拔周期长度。'
  );
  check(savedTopic.ok === true && savedTopic.status === 'synced', 'saveTopicConsensusSummary 必须将状态更新为 synced');
  check(Boolean(savedTopic.lastSynthesizedAt), 'saveTopicConsensusSummary 必须写入 last_synthesized_at');
  const topicFileRaw = fs.readFileSync(path.join(PATHS.kbTopicsDir, 'T-ai-optical.md'), 'utf8');
  check(topicFileRaw.includes('<!-- AUTO-GENERATED:START -->'), '保存共识摘要不得破坏 AUTO-GENERATED 区块');
  check(topicFileRaw.includes('800G 放量与 1.6T 导入同步加速'), '保存共识摘要内容必须写入磁盘');
  const refreshedTopics = store.getKbTopics().topics;
  const opticalTopic = refreshedTopics.find((t) => t.id === 'T:ai-optical');
  check(opticalTopic && opticalTopic.status === 'synced' && opticalTopic.consensusSummary.includes('1.6T'), 'SQLite topics 表必须即时同步新摘要');

  // -------------------------------------------------------------------------
  // 4. 单卡原子写库（preview/commit/409乐观锁/JSONL追加/backup回滚 + SQLite联动）
  // -------------------------------------------------------------------------
  // 4a. 新增单卡 M-013 + 校验单卡 Diff + 提交 + 回滚删除
  const createPlan = buildMutationPlan('methodology.createCard', {
    system: '风控体系',
    topic: 'v2 单卡原子写入验证',
    coreThesis: '单卡写入仅改动目标单卡 MD，不重写大文件。',
    invalidationSignals: '若改动波及非目标卡片即视为失效。',
    source: 'kb-v2.test.cjs',
    credibility: 0.75,
    date: '2026-11-25',
  });
  check(createPlan.ok === true, 'v2 methodology.createCard 校验应通过');
  const createFileKeys = Object.keys(createPlan.files);
  assert.equal(createFileKeys.length, 1, '新增单卡仅应产生 1 个单卡文件变更');
  const newCardEntry = createPlan.files[createFileKeys[0]];
  check(newCardEntry.label === 'kb/cards/methodology/M-013.md', '新增单卡标签应为 kb/cards/methodology/M-013.md');
  check(newCardEntry.existedBefore === false, '新建单卡 existedBefore 应为 false');

  const createCommit = commitMutationPlan(createPlan, { actor: 'kb_v2_test' });
  check(createCommit.committed === true && createCommit.kbSync?.ok === true, '提交后应自动触发 SQLite 同步');
  check(fs.existsSync(path.join(PATHS.kbDir, 'cards', 'methodology', 'M-013.md')), 'M-013.md 必须已落盘');
  check(store.loadWorkspace().methodology.cards.some((c) => c.id === '013'), '提交后 loadWorkspace() 应包含卡片 013');

  // 回滚创建快照 -> M-013.md 必须被干净删除且 SQLite 移除 M:013
  const undoCreate = restoreBackup(createCommit.backupId, { actor: 'kb_v2_test' });
  check(undoCreate.committed === true, 'restoreBackup 回滚新建单卡必须成功');
  check(!fs.existsSync(path.join(PATHS.kbDir, 'cards', 'methodology', 'M-013.md')), '回滚后 M-013.md 必须被移除');
  check(!store.loadWorkspace().methodology.cards.some((c) => c.id === '013'), '回滚后 SQLite 与 loadWorkspace() 不得残留 013');

  // 4b. 可信度复盘调整（M-001.md + events/review-log.jsonl）+ 乐观锁 409 + 回滚还原
  const beforeM001 = fs.readFileSync(path.join(PATHS.kbDir, 'cards', 'methodology', 'M-001.md'), 'utf8');
  const beforeLog = fs.readFileSync(path.join(PATHS.kbEventsDir, 'review-log.jsonl'), 'utf8');

  const stalePlan = buildMutationPlan('methodology.adjustCredibility', {
    cardId: '001',
    delta: 0.05,
    reason: '模拟并发冲突前的旧预览',
    date: '2026-11-25',
  });
  const adjPlan = buildMutationPlan('methodology.adjustCredibility', {
    cardId: '001',
    delta: 0.05,
    reason: '实盘突破趋势线并回踩确认，验证为真',
    date: '2026-11-25',
  });
  check(adjPlan.ok === true && Object.keys(adjPlan.files).length === 2, '可信度调整应精准修改 M-001.md 与 review-log.jsonl');
  const adjCommit = commitMutationPlan(adjPlan, { actor: 'kb_v2_test' });
  check(adjCommit.committed === true, '可信度复盘调整提交应成功');

  // 用先前生成的 stalePlan 提交必须抛出 HTTP 409 乐观锁冲突
  assert.throws(
    () => commitMutationPlan(stalePlan, { actor: 'kb_v2_test' }),
    (err) => err && err.statusCode === 409,
    '并发修改后使用旧计划提交必须触发 409 乐观锁冲突'
  );
  assertions++;

  const timelineAfterAdj = store.getKbCardTimeline('M:001');
  check(timelineAfterAdj.events.length === 2, '追加复盘后 M:001 时间轴应为 2 条事件');
  check(timelineAfterAdj.card.legacyScore === 0.9, 'M:001 可信度应更新为 0.9');

  const undoAdj = restoreBackup(adjCommit.backupId, { actor: 'kb_v2_test' });
  check(undoAdj.committed === true, '回滚可信度调整快照必须成功');
  assert.equal(
    fs.readFileSync(path.join(PATHS.kbDir, 'cards', 'methodology', 'M-001.md'), 'utf8'),
    beforeM001,
    '回滚后 M-001.md 内容必须字节级还原'
  );
  assert.equal(
    fs.readFileSync(path.join(PATHS.kbEventsDir, 'review-log.jsonl'), 'utf8'),
    beforeLog,
    '回滚后 review-log.jsonl 内容必须字节级还原'
  );
  check(store.getKbCardTimeline('M:001').events.length === 1, '回滚后 SQLite 时间轴应恢复为 1 条');

  // 4c. 批量事务（新增认知卡 + 增订方法论卡 + 冲突卡）& 台账联动
  const batchPlan = buildMutationPlan('batch.commitOperations', {
    date: '2026-11-25',
    operations: [
      {
        action: 'cognition.createCard',
        payload: {
          title: '测试：AI 光模块 1.6T 批量交付加速',
          facts: '海外头部云厂 1.6T 光模块进入量产爬坡阶段。',
          evidenceLevel: 'A级（公开财报与供应链订单）',
          invalidationConditions: '云厂资本开支连续两季下修。',
          source: 'kb-v2.test.cjs',
          relatedMethodIds: '008',
        },
      },
      {
        action: 'methodology.appendAmendment',
        payload: {
          cardId: '002',
          content: '补充：极端流动性枯竭时配合单股上限 20%。',
          batchNote: 'v2单卡增订测试',
        },
      },
      {
        action: 'methodology.createConflict',
        payload: {
          title: '测试冲突：趋势持有 vs 乖离减仓',
          sides: '卡片 001 与卡片 006',
          conflictPoint: '趋势未破但短线乖离偏大',
          resolution: '保留底仓、高抛浮仓',
        },
      },
    ],
  });
  check(batchPlan.ok === true && Object.keys(batchPlan.files).length === 3, 'batch.commitOperations 应合并为 3 个单卡文件变更');
  const batchCommit = commitMutationPlan(batchPlan, { actor: 'kb_v2_test' });
  check(batchCommit.committed === true, 'batch.commitOperations 提交应成功');
  check(fs.existsSync(path.join(PATHS.kbDir, 'cards', 'cognition', 'C-005.md')), '批量新建应落盘 C-005.md');
  check(fs.existsSync(path.join(PATHS.kbDir, 'cards', 'conflicts', 'CF-03.md')), '批量新建应落盘 CF-03.md');

  // 台账日度复盘联动更新单卡 + review-log.jsonl
  const dailyPlan = buildMutationPlan('ledger.createDailyReview', {
    date: '2026-11-25',
    headline: '测试复盘：光互联领涨结构性轮动',
    marketFacts: '两市成交 1.4 万亿，光互联方向领涨。',
    score: 7.2,
    credibilityAdjustments: [{ cardId: '006', delta: 0.02, reason: 'MA5 乖离纪律有效避免追高回撤' }],
  });
  check(dailyPlan.ok === true, 'v2 ledger.createDailyReview 计划应通过校验');
  check(Boolean(dailyPlan.files.ledger), '日度复盘应写入 研判与复盘台账.md');
  check(Boolean(dailyPlan.files.kb_review_log), '日度复盘联动应追加 kb/events/review-log.jsonl');
  const dailyCommit = commitMutationPlan(dailyPlan, { actor: 'kb_v2_test' });
  check(dailyCommit.committed === true, 'v2 日度复盘提交应成功');

  // -------------------------------------------------------------------------
  // 5. 逆向单文件编译导出验证（starter workspace）
  // -------------------------------------------------------------------------
  const exported = store.exportKbMonolithSnapshots();
  check(exported.ok === true, 'exportKbMonolithSnapshots() 必须成功');
  check(fs.existsSync(exported.methodologySnapshot.path), '应生成 方法论卡片库.compiled.md');
  check(fs.existsSync(exported.cognitionSnapshot.path), '应生成 行业前沿认知库.compiled.md');
  const compiledM = parseMethodology(fs.readFileSync(exported.methodologySnapshot.path, 'utf8'));
  const compiledC = parseCognition(fs.readFileSync(exported.cognitionSnapshot.path, 'utf8'));
  assert.equal(compiledM.cards.length, 12, '逆向编译方法论卡数应精确匹配');
  assert.equal(compiledM.conflicts.length, 3, '逆向编译冲突数应包含新增 CF-03 共 3 项');
  assert.equal(compiledC.cards.length, 5, '逆向编译认知卡数应包含新增 C-005 共 5 张');
  assertions += 3;

  // -------------------------------------------------------------------------
  // 6. 纯 v2 空间识别（无 现行三库/ 时）
  // -------------------------------------------------------------------------
  fs.cpSync(PATHS.kbDir, path.join(pureV2TmpDir, 'kb'), { recursive: true });
  check(detectKbMode(pureV2TmpDir) === 'v2', '纯 v2 目录 detectKbMode 必须返回 v2');
  check(hasThreeLibraries(pureV2TmpDir) === true, '纯 v2 目录（无 现行三库/）hasThreeLibraries 必须返回 true');
  const pureWs = store.loadKbV2Workspace(path.join(pureV2TmpDir, 'kb'), pureV2TmpDir);
  check(pureWs.kbMode === 'v2' && pureWs.methodology.cards.length === 12 && pureWs.ledger.dailyReviews.length === 0, '纯 v2 目录无台账时应安全加载空台账');

  // -------------------------------------------------------------------------
  // 7. 只读真实 现行三库/ 抽样迁移与图谱真相验证（严禁触碰原件！）
  // -------------------------------------------------------------------------
  if (hasRealSample) {
    const realKbDir = path.join(realSampleTmpDir, 'kb');
    const realMig = kb.runMigration({
      methodPath: realMethodPath,
      cognitionPath: realCogPath,
      targetKbDir: realKbDir,
    });
    const realSync = kb.syncKbToSqlite(realKbDir, { forceRebuild: true, refreshTopics: true });
    const realLossless = kb.verifyLosslessMigration({
      kbDir: realKbDir,
      methodPath: realMethodPath,
      cognitionPath: realCogPath,
    });
    check(realLossless.ok === true, `真实 现行三库 无损核验必须 100% 通过：${JSON.stringify(realLossless)}`);
    check(realSync.ok === true && realSync.totals.reviewEvents >= 300, '真实三库应剥离完整逐日复盘流水');

    // 二次增量对账幂等性验证
    const secondSync = kb.syncKbToSqlite(realKbDir, { forceRebuild: false, refreshTopics: false });
    check(secondSync.insertedOrUpdated === 0, '二次增量对账应 0 重解析');

    const realV2Ws = store.loadKbV2Workspace(realKbDir, realSampleTmpDir);
    const origM = parseMethodology(fs.readFileSync(realMethodPath, 'utf8'));
    const origC = parseCognition(fs.readFileSync(realCogPath, 'utf8'));
    assert.equal(realV2Ws.methodology.cards.length, origM.cards.length, '真实三库方法论卡数必须 100% 对齐');
    assert.equal(realV2Ws.methodology.conflicts.length, origM.conflicts.length, '真实三库冲突数必须 100% 对齐');
    assert.equal(realV2Ws.cognition.cards.length, origC.cards.length, '真实三库认知卡数必须 100% 对齐');
    if (origM.stats.reservedMissing.length > 0) {
      assert.deepEqual(realV2Ws.methodology.stats.reservedMissing, origM.stats.reservedMissing, '真实三库声明缺号必须完整保留');
      assertions++;
    }

    // 若样本库包含带部分证伪互引的认知卡（如 C:040 ← C:096），验证反证图谱挂载
    const c040 = realV2Ws.cognition.cards.find((c) => c.id === '040');
    const c096 = realV2Ws.cognition.cards.find((c) => c.id === '096');
    if (c040 && c096 && /040/.test(c096.rawHeading || '')) {
      check(c040.v2Meta.refuters.some((r) => r.id === 'C:096'), 'C:040 必须挂载反证卡 C:096');
    }

    // 若样本库含 688809 标的，验证实体精确检索路由
    if (origC.cards.some((c) => (c.rawMarkdown || '').includes('688809'))) {
      const tkSearch = kb.hybridSearch(realKbDir, { ticker: '688809', query: '探针卡 MEMS', asOfDate: '2026-11-25' });
      check(tkSearch.results.length > 0 && tkSearch.detectedEntities.some((e) => e.code === '688809.SH'), '688809 实体路由必须命中');
    }

    // 验证时效巡检
    const realStale = kb.checkStaleCognition(realKbDir, '2026-11-25');
    check(typeof realStale.activeTotal === 'number', '真实三库时效巡检应正常返回结构化结果');

    // 验证逆向编译单文件与旧 parser 100% 同构
    const realCompiled = kb.compileMonolithSnapshots(realKbDir);
    const compM = parseMethodology(fs.readFileSync(realCompiled.methodologySnapshot.path, 'utf8'));
    const compC = parseCognition(fs.readFileSync(realCompiled.cognitionSnapshot.path, 'utf8'));
    assert.equal(compM.stats.totalTitles, origM.stats.totalTitles, '逆向编译方法论总标题数必须一致');
    assert.equal(compM.stats.activeCount, origM.stats.activeCount, '逆向编译方法论活跃数必须一致');
    assert.equal(compC.stats.totalCount, origC.stats.totalCount, '逆向编译认知卡总数必须一致');
    assertions += 3;

    // 最终铁律验证：真实 现行三库/ 三大文件 SHA-256 100% 未被触碰
    assert.equal(fileSha256(realMethodPath), realHashesBefore.methodology, '严禁修改现行方法论卡片库原件');
    assert.equal(fileSha256(realCogPath), realHashesBefore.cognition, '严禁修改现行认知库原件');
    assert.equal(fileSha256(realLedgerPath), realHashesBefore.ledger, '严禁修改现行台账原件');
    assertions += 3;
  }

  console.log(`TEST_KB_V2_CORE_ALL_PASSED (${assertions} assertions, realSample=${hasRealSample})`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(realSampleTmpDir, { recursive: true, force: true });
  fs.rmSync(pureV2TmpDir, { recursive: true, force: true });
}
