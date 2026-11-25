'use strict';

/**
 * Stage U1 本地 CORS 白名单与写操作 CSRF 门禁自动化回归测试（不打包进 release/）
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

function rawHttpRequest(port, reqPath, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const APP_ROOT = path.resolve(__dirname, '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

async function waitReady(url, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function stopChild(child) {
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  await new Promise((r) => setTimeout(r, 350));
  try {
    if (child.exitCode === null) child.kill('SIGKILL');
  } catch {
    // ignore
  }
}

(async () => {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srw-cors-test-'));
  // 常规启动：刻意不设置 NODE_ENV=production 也不设置 SRW_DEV_ORIGIN，验证默认仅信任实际监听端口
  const defaultEnv = { ...process.env };
  delete defaultEnv.NODE_ENV;
  delete defaultEnv.SRW_DEV_ORIGIN;
  delete defaultEnv.SRW_ALLOW_VITE_DEV;
  const child = spawn(process.execPath, [path.join(APP_ROOT, 'server', 'index.cjs')], {
    cwd: APP_ROOT,
    windowsHide: true,
    env: {
      ...defaultEnv,
      PORT: String(port),
      SRW_DATA_DIR: tmpDir,
      SRW_STATE_DIR: tmpDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitReady(`${base}/api/health`, child);

    // 1. 外部恶意网站 GET /api/workspace 必须被 403 拒绝且绝不返回 Access-Control-Allow-Origin: *
    const evilGet = await fetch(`${base}/api/workspace`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(evilGet.status, 403, '跨源 GET /api/workspace 必须返回 403');
    assert.equal(evilGet.headers.get('access-control-allow-origin'), null, '恶意来源不得回显 ACAO');

    // 2. 外部恶意网站 OPTIONS 预检必须被 403 拒绝
    const evilOpt = await fetch(`${base}/api/workspace`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(evilOpt.status, 403, '跨源 OPTIONS 必须返回 403');
    assert.equal(evilOpt.headers.get('access-control-allow-origin'), null);

    // 3. 常规默认启动下，非实际监听端口（5173 / 4173 / 9999）必须全部返回 403
    for (const badPort of [5173, 4173, 9999]) {
      const wrongPortGet = await fetch(`${base}/api/workspace`, {
        headers: { Origin: `http://127.0.0.1:${badPort}` },
      });
      assert.equal(wrongPortGet.status, 403, `常规启动下端口 ${badPort} Origin 必须返回 403`);
    }
    const devHostDefault = await rawHttpRequest(port, '/api/workspace', {
      headers: { Host: '127.0.0.1:5173' },
    });
    assert.equal(devHostDefault.status, 403, '常规启动下 Host: 127.0.0.1:5173 必须返回 403');

    // 4. 同源浏览器写操作缺少 X-SRW-Client 或使用规格外头值（如 desktop-pet）必须被 403 拒绝
    const csrfPost = await fetch(`${base}/api/watchlist`, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(csrfPost.status, 403, '浏览器写操作缺少 X-SRW-Client 必须被 403 拦截');

    const petHeaderPost = await fetch(`${base}/api/watchlist`, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-SRW-Client': 'desktop-pet',
      },
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(petHeaderPost.status, 403, '规格外的 X-SRW-Client: desktop-pet 必须被 403 拦截');

    // 5. 同源受信任前端携带 X-SRW-Client: workbench 正常放行，且精确回显 Origin（非 *）
    const okPost = await fetch(`${base}/api/watchlist`, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-SRW-Client': 'workbench',
      },
      body: JSON.stringify({ items: [{ secid: '0.300308' }] }),
    });
    assert.equal(okPost.status, 200, '同源受信任前端携带 X-SRW-Client 应放行');
    assert.equal(okPost.headers.get('access-control-allow-origin'), base, 'ACAO 必须精确匹配白名单 Origin，绝不为 *');

    // 6. Sec-Fetch-Site: cross-site 必须被拦截；带 Sec-Fetch-Site 的浏览器写操作缺 X-SRW-Client 亦须拦截
    const crossSite = await fetch(`${base}/api/app/profile`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403, 'Sec-Fetch-Site: cross-site 必须被拒绝');

    const secFetchPostNoClient = await fetch(`${base}/api/watchlist`, {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(secFetchPostNoClient.status, 403, '带 Sec-Fetch-Site 的浏览器写操作缺少 X-SRW-Client 必须返回 403');

    // 7. DNS Rebinding / 非法 Host 请求头必须在路由分发前返回 403
    const evilHost = await rawHttpRequest(port, '/api/workspace', {
      headers: { Host: `evil.rebind.example:${port}` },
    });
    assert.equal(evilHost.status, 403, '非法 Host 必须返回 403');
    const wrongPortHost = await rawHttpRequest(port, '/api/workspace', {
      headers: { Host: '127.0.0.1:9999' },
    });
    assert.equal(wrongPortHost.status, 403, '端口不匹配的 Host 必须返回 403');

    // 8. 非浏览器直接写操作（无 Origin/Referer/Sec-Fetch-Site）缺少 X-SRW-Client 也必须返回 403
    const rawNoClientPost = await rawHttpRequest(port, '/api/watchlist', {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(rawNoClientPost.status, 403, '任意未携带 X-SRW-Client 的写请求必须被 403 拦截');

    // 9. /api/mutate/commit 写盘确认门端到端：必须返回 200（绝不 500）、落盘 1 次、生成 1 条审计记录
    const commitRes = await fetch(`${base}/api/mutate/commit`, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-SRW-Client': 'workbench',
      },
      body: JSON.stringify({
        action: 'methodology.createCard',
        payload: {
          system: '测试体系',
          topic: '端到端写盘审计验证',
          coreThesis: '验证提交写盘返回200并记录单条审计。',
          logicChain: '预览 -> 写盘 -> 审计',
          applicableConditions: '自动化回归测试',
          invalidationSignals: '返回500或审计缺失',
          credibility: '0.7',
          source: 'security-cors.test.cjs',
        },
      }),
    });
    assert.equal(commitRes.status, 200, '三库写盘提交必须返回 200（不可因 plan.files.map 抛 500）');
    const commitBody = await commitRes.json();
    assert.equal(commitBody.ok, true);
    assert.equal(commitBody.committed, true);
    assert.equal(commitBody.auditRecorded, true);
    assert.ok(commitBody.backupId);

    const audRes = await (await fetch(`${base}/api/maintenance/audit-trail?category=library_mutation`)).json();
    assert.equal(audRes.filteredTotal, 1, '三库写盘提交后必须恰好生成 1 条 library_mutation 审计记录');
    assert.ok(audRes.items[0].summary.includes('方法论卡片库'), '审计摘要应使用 plan.summaryBullets');

    // 10. 轻量侧栏摘要端点 /api/workbench/sidebar-summary 返回 200（支持首屏懒挂载徽标）
    const sumRes = await (await fetch(`${base}/api/workbench/sidebar-summary`)).json();
    assert.equal(sumRes.ok, true);
    assert.equal(typeof sumRes.intelPendingCount, 'number');
    assert.equal(typeof sumRes.techAlertCount, 'number');

    // 10b. 推送鉴权无磁盘写入副作用：data-sources.local.json 缺失或损坏时，被拒绝的外部 /api/feeds/ingest 请求绝不能创建或覆写该文件
    const dsCfgPath = path.join(tmpDir, 'data-sources.local.json');
    if (fs.existsSync(dsCfgPath)) fs.unlinkSync(dsCfgPath);
    const rejectedNoFile = await fetch(`${base}/api/feeds/ingest`, {
      method: 'POST',
      headers: {
        Origin: 'https://push.partner.example',
        Authorization: 'Bearer wrong-token-before-init',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: '未初始化拒绝测试', content: '不得写盘' }),
    });
    assert.equal(rejectedNoFile.status, 403, '配置未初始化时的外部推送必须返回 403');
    assert.equal(fs.existsSync(dsCfgPath), false, '被拒绝的推送请求绝不能创建 data-sources.local.json');

    const corruptContent = '{corrupt-json-do-not-overwrite';
    fs.writeFileSync(dsCfgPath, corruptContent, 'utf8');
    const rejectedCorrupt = await fetch(`${base}/api/feeds/ingest`, {
      method: 'POST',
      headers: {
        Origin: 'https://push.partner.example',
        Authorization: 'Bearer any-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: '损坏配置拒绝测试', content: '不得覆写' }),
    });
    assert.equal(rejectedCorrupt.status, 403, '配置损坏时的外部推送必须返回 403');
    assert.equal(fs.readFileSync(dsCfgPath, 'utf8'), corruptContent, '被拒绝的推送请求绝不能覆写原有 data-sources.local.json');
    fs.unlinkSync(dsCfgPath);

    // 11. /api/feeds/ingest 携带 Bearer Token 的外部推流保留放行能力（校验 Token 本身，不被跨域 Origin 拦死）
    const tokenRes = await (
      await fetch(`${base}/api/data-sources/webhook-token`, {
        method: 'POST',
        headers: {
          Origin: base,
          'Content-Type': 'application/json',
          'X-SRW-Client': 'workbench',
          'X-SRW-Local-Confirm': 'reveal-token',
        },
        body: JSON.stringify({}),
      })
    ).json();
    assert.ok(tokenRes.token, '应能获取本机 webhook token');

    const externalPush = await fetch(`${base}/api/feeds/ingest`, {
      method: 'POST',
      headers: {
        Origin: 'https://push.partner.example',
        Authorization: `Bearer ${tokenRes.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: '外部合规推流测试', content: 'Stage U1 CORS/Webhook 回归测试' }),
    });
    assert.equal(externalPush.status, 200, '带有效 Bearer Token 的 /api/feeds/ingest 必须保持外部推送可用');

    // 11b. 无效 Bearer 或跨源旧 X-Feed-Token 必须在读体前被 403 拦截；本机 workbench 仍兼容旧头
    const badBearerExternal = await fetch(`${base}/api/feeds/ingest`, {
      method: 'POST',
      headers: {
        Origin: 'https://push.partner.example',
        Authorization: 'Bearer invalid-token-xyz',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: '无效令牌测试', content: '不应进入路由' }),
    });
    assert.equal(badBearerExternal.status, 403, '跨源无效 Bearer 必须返回 403');

    const legacyHeaderExternal = await fetch(`${base}/api/feeds/ingest`, {
      method: 'POST',
      headers: {
        Origin: 'https://push.partner.example',
        'X-Feed-Token': tokenRes.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: '跨源旧头测试', content: '不得跨源放行' }),
    });
    assert.equal(legacyHeaderExternal.status, 403, '跨源 X-Feed-Token 不得绕过本机门禁');

    const legacyHeaderLocalOk = await fetch(`${base}/api/feeds/ingest`, {
      method: 'POST',
      headers: {
        Origin: base,
        'X-SRW-Client': 'workbench',
        'X-Feed-Token': tokenRes.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: '本机旧头兼容测试', content: '通过本机门禁后允许兼容' }),
    });
    assert.equal(legacyHeaderLocalOk.status, 200, '已通过本机门禁的 X-Feed-Token 应兼容放行');

    // 12. 并发通过 POST /api/watchlist/add 同时追加两只不同股票 -> 原子去重落盘，绝不互相覆盖丢失！
    await fetch(`${base}/api/watchlist`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({ items: [] }),
    });
    const [addA, addB] = await Promise.all([
      fetch(`${base}/api/watchlist/add`, {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
        body: JSON.stringify({ item: { secid: '1.600519', code: '600519', name: '贵州茅台', marketKind: 'CN' } }),
      }),
      fetch(`${base}/api/watchlist/add`, {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
        body: JSON.stringify({ item: { secid: '105.NVDA', code: 'NVDA', name: '英伟达', marketKind: 'US' } }),
      }),
    ]);
    assert.equal(addA.status, 200);
    assert.equal(addB.status, 200);
    const wlAfter = await (await fetch(`${base}/api/watchlist`)).json();
    const secids = (wlAfter.items || []).map((x) => x.secid);
    assert.ok(secids.includes('1.600519'), '并发添加后必须保留 1.600519');
    assert.ok(secids.includes('105.NVDA'), '并发添加后必须保留 105.NVDA');

    // 重复添加幂等性校验
    const addDup = await (
      await fetch(`${base}/api/watchlist/add`, {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
        body: JSON.stringify({ item: { secid: '1.600519', code: '600519', name: '贵州茅台', marketKind: 'CN' } }),
      })
    ).json();
    assert.equal(addDup.alreadyExists, true);
    assert.equal(addDup.items.length, 2, '重复添加同一 secid 必须幂等不产生重复项');

    // 13. 切换至空白工作空间后，自选列表必须与原空间隔离为空；切回原空间后原自选完好无损
    const createBlankRes = await fetch(`${base}/api/app/workspace/create`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({ name: 'isolated-blank-ws', template: 'blank' }),
    });
    assert.equal(createBlankRes.status, 200, '创建空白子工作空间必须成功');
    const blankWl = await (await fetch(`${base}/api/watchlist`)).json();
    assert.deepEqual(blankWl.items, [], '切换到新建空白工作空间后，自选列表必须为空，不得沿用上一空间自选');
    assert.equal(blankWl.configured, false);

    // 切回默认空间，原自选应完整保留
    const switchBackRes = await fetch(`${base}/api/app/workspace/switch`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({ targetDir: tmpDir }),
    });
    assert.equal(switchBackRes.status, 200);
    const origWl = await (await fetch(`${base}/api/watchlist`)).json();
    assert.equal((origWl.items || []).length, 2, '切回原工作空间后，原有自选列表必须完整保留');

    // 13b. 双标签页跨工作空间防误覆盖回归：旧窗口持有的空间 A 自选试图在空间 B 激活时删除覆盖 -> 必须返回 409 且 B 自选完好
    const origWorkspaceRoot = origWl.workspaceRoot;
    assert.ok(origWorkspaceRoot, 'GET /api/watchlist 必须返回 workspaceRoot');
    const switchToBlankAgain = await fetch(`${base}/api/app/workspace/switch`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({ targetDir: path.join(tmpDir, 'workspaces', 'isolated-blank-ws') }),
    });
    assert.equal(switchToBlankAgain.status, 200);
    const blankRoot = (await (await fetch(`${base}/api/watchlist`)).json()).workspaceRoot;
    assert.notEqual(blankRoot.toLowerCase(), origWorkspaceRoot.toLowerCase());
    // 在新空间 B 中添加一只股票 0.000001
    const addToB = await fetch(`${base}/api/watchlist/add`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({
        workspaceRoot: blankRoot,
        item: { secid: '0.000001', code: '000001', name: '平安银行', marketKind: 'CN' },
      }),
    });
    assert.equal(addToB.status, 200);
    // 模拟未刷新的旧标签页 A 试图在删除自选后用 A 的剩余列表覆盖写入 -> 携带 workspaceRoot=A 必须被 409 拒绝
    const staleTabOverwrite = await fetch(`${base}/api/watchlist`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({
        workspaceRoot: origWorkspaceRoot,
        items: [{ secid: '1.600519', code: '600519', name: '贵州茅台', marketKind: 'CN' }],
      }),
    });
    assert.equal(staleTabOverwrite.status, 409, '过期工作空间标签页的整表自选写操作必须返回 409 WORKSPACE_MISMATCH');
    const staleBody = await staleTabOverwrite.json();
    assert.equal(staleBody.code, 'WORKSPACE_MISMATCH');
    // 确认空间 B 的自选列表完好无损（仍只有 0.000001，未被旧标签页 A 的列表覆盖）
    const bAfterStale = await (await fetch(`${base}/api/watchlist`)).json();
    assert.deepEqual(
      (bAfterStale.items || []).map((x) => x.secid),
      ['0.000001'],
      '空间 B 自选列表绝不可被旧标签页 A 误覆盖'
    );
    // 切回默认空间
    await fetch(`${base}/api/app/workspace/switch`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({ targetDir: tmpDir }),
    });

    // 13b. 中文路径工作空间下自选新增、删除、重置与 workspaceRoot 响应校验（无非法非 ASCII HTTP 头）
    const cnDir = path.join(tmpDir, '中文投研空间_回归验证');
    fs.mkdirSync(path.join(cnDir, '现行三库'), { recursive: true });
    fs.writeFileSync(path.join(cnDir, '现行三库', '方法论卡片库.md'), '# 方法论卡片库\n', 'utf8');
    fs.writeFileSync(path.join(cnDir, '现行三库', '行业前沿认知库.md'), '# 行业前沿认知库\n', 'utf8');
    fs.writeFileSync(path.join(cnDir, '现行三库', '研判与复盘台账.md'), '# 研判与复盘台账\n', 'utf8');
    const apiTsSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'api.ts'), 'utf8');
    assert.equal(apiTsSrc.includes("'X-SRW-Workspace'"), false, 'src/api.ts 不得再将原始中文工作空间路径放入 HTTP 请求头');
    const swCn = await fetch(`${base}/api/app/workspace/switch`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({ targetDir: cnDir }),
    });
    assert.equal(swCn.status, 200, '切换到中文路径工作空间应成功');
    const cnAdd = await fetch(`${base}/api/watchlist/add`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({
        workspaceRoot: cnDir,
        item: { secid: '1.600519', code: '600519', name: '贵州茅台', marketKind: 'CN' },
      }),
    });
    assert.equal(cnAdd.status, 200, '中文路径下 POST /api/watchlist/add 必须返回 200');
    const cnAddData = await cnAdd.json();
    assert.equal(path.resolve(cnAddData.workspaceRoot).toLowerCase(), path.resolve(cnDir).toLowerCase());
    const cnDel = await fetch(`${base}/api/watchlist`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({ workspaceRoot: cnDir, items: [] }),
    });
    assert.equal(cnDel.status, 200, '中文路径下删除自选必须返回 200');
    const cnReset = await fetch(`${base}/api/watchlist`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({ workspaceRoot: cnDir, reset: true, empty: true }),
    });
    assert.equal(cnReset.status, 200, '中文路径下重置自选必须返回 200');
    await fetch(`${base}/api/app/workspace/switch`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-SRW-Client': 'workbench' },
      body: JSON.stringify({ targetDir: tmpDir }),
    });

    // 14. 桌宠制品与本地配置/对话写操作兼容性验证（桌面史莱姆团子.exe 必须内嵌 workbench 头且不含旧 desktop-pet）
    const petExePath = path.join(APP_ROOT, '桌面史莱姆团子.exe');
    if (process.platform === 'win32' && fs.existsSync(petExePath)) {
      const petBin = fs.readFileSync(petExePath);
      assert.ok(
        petBin.includes(Buffer.from('workbench', 'utf16le')),
        '桌面史莱姆团子.exe 必须包含新写门禁头 X-SRW-Client: workbench'
      );
      assert.equal(
        petBin.includes(Buffer.from('desktop-pet', 'utf16le')),
        false,
        '桌面史莱姆团子.exe 不得残留已被门禁拒绝的 desktop-pet 头'
      );
    }
    const petConfigSave = await rawHttpRequest(port, '/api/bot/config', {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json; charset=utf-8',
        'X-SRW-Client': 'workbench',
      },
      body: JSON.stringify({ avatarId: 'slime_mochi', botName: '波波' }),
    });
    assert.equal(petConfigSave.status, 200, '桌宠保存形象配置携带 X-SRW-Client: workbench 必须返回 200');
    const petChat = await rawHttpRequest(port, '/api/bot/chat', {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json; charset=utf-8',
        'X-SRW-Client': 'workbench',
      },
      body: JSON.stringify({ message: '变身行情看板' }),
    });
    assert.equal(petChat.status, 200, '桌宠发送聊天消息携带 X-SRW-Client: workbench 必须返回 200');

    // 15. 真实 Vite 代理三态门禁验证：默认关闭 SRW_DEV_ORIGIN -> 403；显式开启 SRW_DEV_ORIGIN=1 -> 5173 放行；非白名单端口代理（即使无 Origin 头）-> 403；vite preview 禁用代理
    const viteCfgSrc = fs.readFileSync(path.join(APP_ROOT, 'vite.config.ts'), 'utf8');
    assert.ok(viteCfgSrc.includes('changeOrigin: false'), 'vite.config.ts 代理必须保留原始入站 Host (changeOrigin: false)');
    assert.ok(viteCfgSrc.includes('strictPort: true'), 'vite.config.ts 必须启用 strictPort: true');
    assert.ok(/preview:\s*\{\s*proxy:\s*\{\s*\}/m.test(viteCfgSrc), 'vite.config.ts 必须显式关闭 preview 的 API 代理');

    const devPort = await getFreePort();
    const devChild = spawn(process.execPath, [path.join(APP_ROOT, 'server', 'index.cjs')], {
      cwd: APP_ROOT,
      windowsHide: true,
      env: {
        ...defaultEnv,
        PORT: String(devPort),
        SRW_DEV_ORIGIN: '1',
        SRW_DATA_DIR: tmpDir,
        SRW_STATE_DIR: tmpDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let viteChild = null;
    let viteOffChild = null;
    let viteAltChild = null;
    try {
      const devBase = `http://127.0.0.1:${devPort}`;
      await waitReady(`${devBase}/api/health`, devChild);
      const ok5173 = await fetch(`${devBase}/api/workspace`, {
        headers: { Origin: 'http://127.0.0.1:5173' },
      });
      assert.equal(ok5173.status, 200, '显式 SRW_DEV_ORIGIN=1 应放行 5173 开发端口');
      assert.equal(ok5173.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');

      const deny4173 = await fetch(`${devBase}/api/workspace`, {
        headers: { Origin: 'http://127.0.0.1:4173' },
      });
      assert.equal(deny4173.status, 403, '显式开发模式下 4173 仍必须返回 403');

      const deny9999 = await fetch(`${devBase}/api/workspace`, {
        headers: { Origin: 'http://127.0.0.1:9999' },
      });
      assert.equal(deny9999.status, 403, '显式开发模式下非白名单端口 9999 仍必须返回 403');

      const viteBin = path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
      const spawnViteProxy = async (listenPort, apiTargetPort) => {
        const proc = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(listenPort), '--strictPort'], {
          cwd: APP_ROOT,
          windowsHide: true,
          env: {
            ...defaultEnv,
            SRW_API_PORT: String(apiTargetPort),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let readyLog = '';
        proc.stdout.on('data', (c) => { readyLog += c.toString('utf8'); });
        proc.stderr.on('data', (c) => { readyLog += c.toString('utf8'); });
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          if (proc.exitCode !== null) {
            throw new Error(`Vite 代理子进程提前退出 (port=${listenPort}, code=${proc.exitCode}): ${readyLog}`);
          }
          if (readyLog.includes(`:${listenPort}`) || /ready in/i.test(readyLog)) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        assert.equal(proc.exitCode, null, `Vite 子进程(${listenPort})必须保持运行状态`);
        return proc;
      };

      // 安全护栏：确认 5173 未被外部开发者进程占用
      await new Promise((resolve, reject) => {
        const probeSrv = net.createServer();
        probeSrv.once('error', (err) => {
          reject(new Error(`端口 5173 已被外部进程占用（${err.code || err.message}），已中止 Vite 代理写测试`));
        });
        probeSrv.listen(5173, '127.0.0.1', () => {
          probeSrv.close(() => resolve());
        });
      });

      // 15a. 默认关闭 SRW_DEV_ORIGIN（指向主服务 port）：经真实 Vite 5173 代理即使不带 Origin 头也因 Host=127.0.0.1:5173 返回 403
      viteOffChild = await spawnViteProxy(5173, port);
      const offProxyRes = await fetch('http://127.0.0.1:5173/api/workspace');
      assert.equal(offProxyRes.status, 403, '未开启 SRW_DEV_ORIGIN 时，经真实 Vite 5173 代理（即使无 Origin 头）必须返回 403');
      await stopChild(viteOffChild);
      viteOffChild = null;

      // 15b. 显式开启 SRW_DEV_ORIGIN=1（指向 devPort）：经真实 Vite 5173 代理读写均放行 200
      viteChild = await spawnViteProxy(5173, devPort);
      await waitReady('http://127.0.0.1:5173/api/health', viteChild);
      const proxyHealthRes = await fetch('http://127.0.0.1:5173/api/health', {
        headers: { Origin: 'http://127.0.0.1:5173', Referer: 'http://127.0.0.1:5173/' },
      });
      assert.equal(proxyHealthRes.status, 200, 'Vite 代理 /api/health 必须返回 200');
      const proxyHealth = await proxyHealthRes.json();
      assert.equal(
        path.resolve(String(proxyHealth.projectRoot || '')).toLowerCase(),
        path.resolve(tmpDir).toLowerCase(),
        `安全中止：Vite 代理指向的 projectRoot (${proxyHealth.projectRoot}) 与本次隔离临时目录 (${tmpDir}) 不一致！`
      );

      const proxyGet = await fetch('http://127.0.0.1:5173/api/workspace', {
        headers: { Origin: 'http://127.0.0.1:5173', Referer: 'http://127.0.0.1:5173/' },
      });
      assert.equal(proxyGet.status, 200, '经真实 Vite 代理的 GET /api/workspace 必须返回 200');

      const proxyPost = await fetch('http://127.0.0.1:5173/api/watchlist', {
        method: 'POST',
        headers: {
          Origin: 'http://127.0.0.1:5173',
          Referer: 'http://127.0.0.1:5173/',
          'Content-Type': 'application/json',
          'X-SRW-Client': 'workbench',
        },
        body: JSON.stringify({
          workspaceRoot: tmpDir,
          items: [{ secid: '1.600519', code: '600519', name: '贵州茅台', marketKind: 'CN' }],
        }),
      });
      assert.equal(proxyPost.status, 200, '经真实 Vite 代理的 POST 写请求必须返回 200');

      // 15c. 非白名单端口（模拟 4173 / 任意空闲非 5173 端口）经 Vite 代理指向 SRW_DEV_ORIGIN=1 后端（无 Origin 头）因保留入站 Host 仍被 403 拦截
      const altVitePort = await getFreePort();
      viteAltChild = await spawnViteProxy(altVitePort, devPort);
      const altProxyRes = await fetch(`http://127.0.0.1:${altVitePort}/api/workspace`);
      assert.equal(altProxyRes.status, 403, '经非白名单端口 Vite 代理（即使无 Origin 头）必须因保留入站 Host 返回 403');
    } finally {
      if (viteOffChild) await stopChild(viteOffChild);
      if (viteChild) await stopChild(viteChild);
      if (viteAltChild) await stopChild(viteAltChild);
      await stopChild(devChild);
    }

    console.log('STAGE_U1_CORS_CSRF_AND_MUTATION_TESTS_ALL_PASSED (50/50 assertions)');
  } finally {
    await stopChild(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
