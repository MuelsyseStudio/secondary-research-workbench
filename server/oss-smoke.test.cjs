'use strict';

/**
 * 开源社区版（Open-Source Edition）自包含核心回归与冷启动烟测
 * 零外部私钥依赖、零私有三库依赖，可直接在 GitHub CI 或任何开发者本机执行：
 *   node server/oss-smoke.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_ROOT = path.resolve(__dirname, '..');

async function waitHealth(port, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) return await r.json();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`OSS server did not become healthy on port ${port} within ${timeoutMs}ms`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'srw-oss-smoke-'));
  const port = 3800 + Math.floor(Math.random() * 160);
  let stderr = '';
  const child = spawn(process.execPath, [path.join(APP_ROOT, 'server', 'index.cjs')], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SRW_EDITION: 'open_source',
      SRW_DATA_DIR: tmpData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  try {
    const health = await waitHealth(port);
    assert.equal(health.ok, true, 'health endpoint should return ok=true');

    // 1. Starter workspace auto-initialized in empty SRW_DATA_DIR
    const wsRes = await fetch(`http://127.0.0.1:${port}/api/workspace`);
    assert.equal(wsRes.status, 200);
    const ws = await wsRes.json();
    assert.ok((ws.methodology?.cards?.length || 0) >= 1, 'starter methodology cards should load');
    assert.ok((ws.cognition?.cards?.length || 0) >= 1, 'starter cognition cards should load');

    // 2. Edition & open-source unlock checks (zero paywall / zero EULA wall)
    const profRes = await fetch(`http://127.0.0.1:${port}/api/app/profile`);
    assert.equal(profRes.status, 200);
    const prof = await profRes.json();
    assert.equal(prof.ok, true);
    assert.equal(prof.edition, 'open_source');
    assert.equal(prof.features?.crypto, false, 'crypto must stay disabled in OSS core');
    assert.equal(prof.features?.allowCommunityScrapers, false, 'unauthorized community scrapers must stay disabled in OSS core');

    const licRes = await fetch(`http://127.0.0.1:${port}/api/app/license`);
    assert.equal(licRes.status, 200);
    const licWrap = await licRes.json();
    const lic = licWrap.license;
    const ent = licWrap.entitlements;
    assert.equal(lic.tier, 'community_oss');
    assert.equal(lic.proUnlocked, true);
    assert.equal(lic.maxUnlocked, true);
    assert.equal(lic.enforcementMode, 'open_source');
    assert.equal(ent.enforced, false, 'OSS edition must not enforce commercial paywalls');
    assert.equal(ent.features?.quant_backtest, true, 'quant backtest must be unlocked in OSS');
    assert.equal(ent.features?.multi_workspace, true, 'multi workspace must be unlocked in OSS');

    const eulaRes = await fetch(`http://127.0.0.1:${port}/api/app/eula`);
    assert.equal(eulaRes.status, 200);
    const eulaWrap = await eulaRes.json();
    assert.equal(eulaWrap.eula?.required, false, 'OSS edition must not block behind commercial EULA wall');

    // 3. Community scraper routes remain safely blocked in OSS core
    const blockedRes = await fetch(`http://127.0.0.1:${port}/api/intel/url-fetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
        'X-SRW-Client': 'workbench',
      },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    assert.equal(blockedRes.status, 403, 'arbitrary scraper endpoint should return 403 in OSS');
    const blockedJson = await blockedRes.json();
    assert.equal(blockedJson.code, 'EDITION_FEATURE_DISABLED', 'must be blocked by OSS edition policy, not CSRF');

    // 4. Write action succeeds without commercial license/EULA gate (Quick Notes)
    const noteRes = await fetch(`http://127.0.0.1:${port}/api/quick-notes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
        'X-SRW-Client': 'workbench',
      },
      body: JSON.stringify({ text: 'OSS Smoke Test Note: Verified local-first write path.', tag: '验证' }),
    });
    assert.equal(noteRes.status, 200, 'local write API should succeed with zero paywall in OSS');
    const noteJson = await noteRes.json();
    assert.equal(noteJson.ok, true);

    // 5. Original-IP mascot filter active
    const botRes = await fetch(`http://127.0.0.1:${port}/api/bot/state`);
    assert.equal(botRes.status, 200);
    const botJson = await botRes.json();
    const mascotIds = (botJson.mascotCatalog || []).map((m) => m.id);
    assert.deepEqual(mascotIds, ['slime_mochi'], 'OSS must only expose original IP mascot');

    // 6. Dual-mode KB v2 lifecycle in OSS (lossless migration -> workspace v2 -> search/topics/stale/export)
    const writeHeaders = {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${port}`,
      'X-SRW-Client': 'workbench',
    };
    const migRes = await fetch(`http://127.0.0.1:${port}/api/kb/migrate-from-v1`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(migRes.status, 200, 'KB v2 migration endpoint must succeed in OSS');
    const migJson = await migRes.json();
    assert.equal(migJson.ok, true, 'KB v2 migration should return ok=true');
    assert.equal(migJson.originalsUnchanged, true, 'KB v2 migration must leave v1 source files strictly untouched');

    const wsV2Res = await fetch(`http://127.0.0.1:${port}/api/workspace`);
    assert.equal(wsV2Res.status, 200);
    const wsV2 = await wsV2Res.json();
    assert.equal(wsV2.kbMode, 'v2', 'workspace must switch to kbMode=v2 after migration');
    assert.ok((wsV2.kbSummary?.nodeCount || 0) >= 1, 'kbSummary.nodeCount should be populated in v2 mode');
    assert.ok(Array.isArray(wsV2.topics) && wsV2.topics.length >= 1, 'living topics should be populated in v2 mode');

    const searchRes = await fetch(
      `http://127.0.0.1:${port}/api/kb/search?q=${encodeURIComponent('光模块 CPO')}&limit=5`
    );
    assert.equal(searchRes.status, 200);
    const searchJson = await searchRes.json();
    assert.equal(searchJson.ok, true);
    assert.equal(searchJson.kbMode, 'v2');
    assert.ok(Array.isArray(searchJson.results) && searchJson.results.length >= 1, 'KB v2 hybrid search should return hits');

    const topicsRes = await fetch(`http://127.0.0.1:${port}/api/kb/topics`);
    assert.equal(topicsRes.status, 200);
    const topicsJson = await topicsRes.json();
    assert.equal(topicsJson.ok, true);
    assert.ok(Array.isArray(topicsJson.topics) && topicsJson.topics.length >= 1, 'KB v2 topics endpoint should list living topics');

    const staleRes = await fetch(`http://127.0.0.1:${port}/api/kb/stale`);
    assert.equal(staleRes.status, 200);
    const staleJson = await staleRes.json();
    assert.equal(staleJson.ok, true);
    assert.equal(typeof staleJson.activeTotal, 'number');

    const exportRes = await fetch(`http://127.0.0.1:${port}/api/kb/export-monolith`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(exportRes.status, 200, 'KB v2 monolith snapshot export must succeed in OSS');
    const exportJson = await exportRes.json();
    assert.equal(exportJson.ok, true);
    assert.ok(fs.existsSync(exportJson.methodologySnapshot?.path), 'compiled methodology snapshot must exist');
    assert.ok(fs.existsSync(exportJson.cognitionSnapshot?.path), 'compiled cognition snapshot must exist');

    console.log('OSS_OPEN_SOURCE_SMOKE_ALL_PASSED (32/32 assertions)');
  } finally {
    await stopChild(child);
    fs.rmSync(tmpData, { recursive: true, force: true });
    if (stderr.trim()) {
      console.error('[OSS STDERR]', stderr.trim());
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
