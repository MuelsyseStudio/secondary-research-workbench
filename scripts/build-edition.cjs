'use strict';

/**
 * 跨平台多版本前端构建脚本（Windows PowerShell / CMD / macOS / Linux 通用）
 *
 * 用法：
 *   node scripts/build-edition.cjs personal
 *   node scripts/build-edition.cjs cn_commercial
 *   node scripts/build-edition.cjs global_commercial
 *   node scripts/build-edition.cjs cn_commercial --out-dir release/cn/.../dist
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const editionArg = (args[0] && !args[0].startsWith('--') ? args[0] : 'personal').trim().toLowerCase();

let outDir = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir' && args[i + 1]) {
    outDir = path.resolve(APP_ROOT, args[i + 1]);
    i += 1;
  }
}

const EDITION_MAP = {
  personal: { viteEdition: 'personal', enableCrypto: 'true' },
  oss: { viteEdition: 'open_source', enableCrypto: 'false' },
  open_source: { viteEdition: 'open_source', enableCrypto: 'false' },
  cn: { viteEdition: 'cn_commercial', enableCrypto: 'false' },
  cn_commercial: { viteEdition: 'cn_commercial', enableCrypto: 'false' },
  partner: { viteEdition: 'partner', enableCrypto: 'false' },
  global: { viteEdition: 'global_commercial', enableCrypto: 'true' },
  global_commercial: { viteEdition: 'global_commercial', enableCrypto: 'true' },
};

const cfg = EDITION_MAP[editionArg];
if (!cfg) {
  console.error(`[build-edition] 不支持的版本参数: ${editionArg}（可选: personal | open_source | cn_commercial | partner | global_commercial）`);
  process.exit(2);
}

const env = {
  ...process.env,
  VITE_EDITION: cfg.viteEdition,
  VITE_ENABLE_CRYPTO: cfg.enableCrypto,
};

const tscBin = path.join(APP_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const viteBin = path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

console.log(`[build-edition] 构建目标: VITE_EDITION=${cfg.viteEdition}, VITE_ENABLE_CRYPTO=${cfg.enableCrypto}${outDir ? `, outDir=${outDir}` : ''}`);

execFileSync(process.execPath, [tscBin, '--noEmit'], { cwd: APP_ROOT, env, stdio: 'inherit' });

const viteArgs = [viteBin, 'build'];
if (outDir) {
  viteArgs.push('--outDir', outDir, '--emptyOutDir');
}
execFileSync(process.execPath, viteArgs, { cwd: APP_ROOT, env, stdio: 'inherit' });
