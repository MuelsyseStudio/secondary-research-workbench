'use strict';

/**
 * Stage U3/R1 机构级操作审计日志、无截断 CSV 导出、公式注入中和、parser 动态缺号测试（不打包进 release/）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srw-u3-audit-'));
process.env.SRW_DATA_DIR = tmpDir;
process.env.SRW_STATE_DIR = tmpDir;

const { PATHS, initializeWorkspaceDir } = require('./app-paths.cjs');
initializeWorkspaceDir(tmpDir, 'starter');
assert.ok(
  path.resolve(PATHS.currentDir).startsWith(path.resolve(tmpDir)),
  `SAFETY GUARD: PATHS.currentDir (${PATHS.currentDir}) must reside inside tmpDir (${tmpDir})`
);

const { loadWorkspace, parseMethodology } = require('./parser.cjs');
const {
  appendAuditLog,
  safeAppendAuditLog,
  queryAuditTrail,
  exportAuditTrailCsv,
  exportWorkspaceSummaryCsv,
} = require('./audit-trail.cjs');
const { addTrades, computeTradeLedgerAnalytics } = require('./trade-ledger.cjs');
const { buildPreflightReport } = require('./judgment-tracker.cjs');
const { fetchMarketSentimentSnapshot } = require('./technical-engine.cjs');
const { fetchDailyMarketPacket } = require('./market-fetcher.cjs');

(async () => {
  try {
    // 1. Parser dynamic missing number check (NO hardcoded '150' on empty or starter libraries)
    const emptyParsed = parseMethodology('# 方法论卡片库\n\n> 版本：v1.0。\n');
    assert.deepEqual(emptyParsed.stats.declaredMissing, [], '空方法论库不得返回硬编码缺号 150');
    const starterWs = loadWorkspace();
    assert.deepEqual(starterWs.methodology.stats.declaredMissing, [], '起步模板 001..012 连续编号不得返回缺号 150');

    // 2. Append > 1,050 audit rows + 650-trade chunked batch (ZERO truncation at 500!) + formula neutralization
    const e1 = appendAuditLog({
      category: 'library_mutation',
      action: 'methodology.createCard',
      summary: "=CMD|' /C calc'!A0 恶意公式字面测试",
      targetIds: ['013', '+1+1', '@SUM(A1:A2)'],
      backupId: 'bk-test-1',
    });
    const batch650Ids = Array.from({ length: 650 }, (_, i) => `tr_${i + 1}:600519`);
    const e2 = appendAuditLog({
      category: 'trade_import',
      action: 'trades.add',
      summary: '导入 650 笔交割记录',
      targetIds: batch650Ids,
    });
    assert.ok(e1 && e2);
    assert.equal(e2.chunkCount, 2, '650 笔交易应拆分为 2 个关联批次分段保存，绝不截断');
    assert.equal(e2.totalTargetCount, 650);

    // Bulk seed 1,050 extra rows directly to verify CSV exports ALL filtered rows (no silent 1,000 truncation!)
    const auditFile = path.join(tmpDir, 'audit-trail.local.jsonl');
    const bulkLines = [];
    for (let i = 0; i < 1050; i++) {
      bulkLines.push(
        JSON.stringify({
          id: `aud_bulk_${i}`,
          timestamp: new Date(Date.now() - i * 1000).toISOString(),
          category: 'system',
          action: `bulk.op.${i}`,
          summary: `批量记录 ${i}`,
          targetIds: [`id_${i}`],
          backupId: null,
          actor: 'local_user',
        })
      );
    }
    fs.appendFileSync(auditFile, bulkLines.join('\n') + '\n', 'utf8');

    const qAll = queryAuditTrail();
    assert.equal(qAll.total, 1053); // e1 + 2 chunks of e2 + 1050 bulk
    assert.equal(qAll.truncated, true);

    const qFiltered = queryAuditTrail({ category: 'library_mutation', q: '013' });
    assert.equal(qFiltered.filteredTotal, 1);

    const csvAudit = exportAuditTrailCsv({ category: 'all' });
    assert.ok(csvAudit.content.startsWith('\uFEFF'), '审计日志 CSV 必须带 UTF-8 BOM 兼容 Excel');
    assert.ok(csvAudit.content.includes('bulk.op.1049'), '审计 CSV 必须导出全部筛选记录，不得静默截断于 1000 条');
    assert.ok(csvAudit.content.includes('tr_1:600519'), '650 笔导入的第 1 笔 ID 必须完整保留在 CSV 中');
    assert.ok(csvAudit.content.includes('tr_501:600519'), '650 笔导入的第 501 笔 ID 不得被截断');
    assert.ok(csvAudit.content.includes('tr_650:600519'), '650 笔导入的第 650 笔 ID 必须完整保留在 CSV 中');
    assert.ok(csvAudit.content.includes("'=CMD|"), '以 = 开头的用户输入必须在 CSV 中中和为字面值输出');
    assert.ok(csvAudit.content.includes('【合规免责声明】'), 'CSV 页脚必须带合规免责声明');

    for (const scope of ['all', 'methodology', 'cognition', 'ledger', 'trades']) {
      const out = exportWorkspaceSummaryCsv(scope);
      assert.ok(out.content.startsWith('\uFEFF'), `${scope} CSV 必须带 UTF-8 BOM`);
      assert.ok(out.content.includes('【合规免责声明】'), `${scope} CSV 必须带合规免责声明`);
    }

    // 3. Holding stop-loss verification across ALL 3 paths: triggered / verified_ok / unverified
    addTrades([
      {
        date: '2026-11-20',
        time: '10:00',
        side: 'BUY',
        code: '600519',
        name: '测试标的',
        price: 100,
        quantity: 100,
        stopLossPrice: 95,
      },
    ]);

    // Path A: Live close 80 <= stop 95 -> MUST trigger high-severity stop alert!
    const triggeredRes = await computeTradeLedgerAnalytics(starterWs, {
      withMarketData: true,
      fetchDailySeries: async () => ({
        secid: '1.600519',
        name: '测试标的',
        klines: [{ date: '2026-11-24', close: 80, high: 82, low: 79, open: 81 }],
      }),
    });
    assert.equal(triggeredRes.holdingStopAlerts.length, 1, '现价 80 跌破止损 95 必须触发止损红线');
    assert.equal(triggeredRes.stopLossCoverage.status, 'triggered');
    assert.equal(triggeredRes.stopLossCoverage.quoteAsOf, '2026-11-24');
    const pfTrig = buildPreflightReport(starterWs, {
      holdingStopAlerts: triggeredRes.holdingStopAlerts,
      holdingStopUnverified: triggeredRes.holdingStopUnverified,
      stopLossCoverage: triggeredRes.stopLossCoverage,
    });
    assert.ok(pfTrig.items.some((x) => x.id === 'hold-stop-600519' && x.severity === 'high'));

    // Path B: Live close 105 > stop 95 -> verified_ok, zero stop alerts
    const okRes = await computeTradeLedgerAnalytics(starterWs, {
      withMarketData: true,
      fetchDailySeries: async () => ({
        secid: '1.600519',
        name: '测试标的',
        klines: [{ date: '2026-11-24', close: 105, high: 106, low: 103, open: 104 }],
      }),
    });
    assert.equal(okRes.holdingStopAlerts.length, 0);
    assert.equal(okRes.holdingStopUnverified.length, 0);
    assert.equal(okRes.stopLossCoverage.status, 'verified_ok');
    assert.equal(okRes.stopLossCoverage.verifiedCount, 1);

    // Path C: Missing / failed quote -> MUST report unverified (NEVER claim healthy using cost 100!)
    const unverifiedRes = await computeTradeLedgerAnalytics(starterWs, {
      withMarketData: true,
      fetchDailySeries: async () => null,
    });
    assert.equal(unverifiedRes.holdingStopAlerts.length, 0);
    assert.equal(unverifiedRes.holdingStopUnverified.length, 1, '行情缺失时必须标为待核验而非健康');
    assert.equal(unverifiedRes.stopLossCoverage.status, 'unverified');
    assert.equal(unverifiedRes.stopLossCoverage.unverifiedCount, 1);
    const pfUnv = buildPreflightReport(starterWs, {
      holdingStopAlerts: unverifiedRes.holdingStopAlerts,
      holdingStopUnverified: unverifiedRes.holdingStopUnverified,
      stopLossCoverage: unverifiedRes.stopLossCoverage,
    });
    assert.ok(pfUnv.items.some((x) => x.id === 'hold-stop-unverified-600519' && x.severity === 'medium'));

    // 4. Short-term sentiment snapshot offline simulation: all 4 upstreams fail -> MUST return null score & valid:false (NEVER fake 50!)
    const offlineSent = await fetchMarketSentimentSnapshot({
      fetchJsonImpl: async () => {
        throw new Error('simulated upstream network failure');
      },
    });
    assert.equal(offlineSent.valid, false, '4 个情绪上游全失败时 valid 必须为 false');
    assert.equal(offlineSent.sentimentScore, null, '4 个情绪上游全失败时不得伪造 50 分');
    assert.equal(offlineSent.stage, null);
    assert.equal(offlineSent.sourceAsOf, null);

    // 5. Explicit empty watchStocks: [] MUST skip individual stocks and never inject author's fixed stock list
    const origFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('offline mock');
    };
    try {
      const emptyPacket = await fetchDailyMarketPacket({ date: '2026-11-24', watchStocks: [] });
      assert.equal(emptyPacket.watchStocks.length, 0, '显式传入空观察池 [] 时不得采集任何作者固定个股');
    } finally {
      global.fetch = origFetch;
    }

    // 6. Simulated audit write failure -> safeAppendAuditLog must explicitly return ok:false with error message
    fs.rmSync(auditFile, { force: true });
    fs.mkdirSync(auditFile); // Replace file with directory so appendFileSync fails deterministically
    const failedAud = safeAppendAuditLog({
      category: 'library_mutation',
      action: 'test.fail',
      summary: '模拟审计落盘失败',
    });
    assert.equal(failedAud.ok, false, '审计文件不可写时必须显式返回 ok:false');
    assert.ok(failedAud.error && failedAud.error.length > 0, '审计失败必须携带明确错误信息');

    console.log('STAGE_U3_AND_R2_AUDIT_STOP_SENTIMENT_TESTS_PASSED (36/36 assertions)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
