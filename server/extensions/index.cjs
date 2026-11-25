'use strict';

/**
 * 后端可插拔市场扩展自动发现加载器
 *
 * 设计原则：
 * - 核心代码不硬编码任何可选扩展文件名或外部资产域名；
 * - 启动/调用时根据当前 edition.features 开关自动扫描同目录下的扩展插件 (*.cjs)；
 * - 若发行版本关闭对应特性，或打包期已物理剔除扩展文件，则静默返回 null（调用方使用 No-Op 空实现，零报错）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { getEditionInfo } = require('../edition.cjs');

let cachedByFeature = null;
let cachedEditionKey = null;

function discoverExtensions() {
  const ed = getEditionInfo();
  const edKey = `${ed.edition}:${JSON.stringify(ed.features)}`;
  if (cachedByFeature && cachedEditionKey === edKey) {
    return cachedByFeature;
  }

  const extDir = path.basename(__dirname) === 'extensions' ? __dirname : path.join(__dirname, 'extensions');
  const map = new Map();
  let entries = [];
  try {
    if (fs.existsSync(extDir)) {
      entries = fs.readdirSync(extDir, { withFileTypes: true });
    }
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.cjs') || entry.name === 'index.cjs') continue;
    const fullPath = path.join(extDir, entry.name);
    try {
      // 使用运行时动态加载，避免打包工具将可选扩展静态内联进主束
      const dynamicRequire = eval('require');
      const mod = dynamicRequire(fullPath);
      const flag = typeof mod?.featureFlag === 'string' ? mod.featureFlag : '';
      if (!flag) continue;
      if (ed.features && ed.features[flag] === true) {
        map.set(flag, mod);
      }
    } catch {
      // Optional extension unavailable or failed to load -> safely ignored
    }
  }

  cachedByFeature = map;
  cachedEditionKey = edKey;
  return map;
}

function getMarketExtension(featureFlag) {
  const ed = getEditionInfo();
  if (!ed.features || ed.features[featureFlag] !== true) {
    return null;
  }
  const map = discoverExtensions();
  return map.get(featureFlag) || null;
}

function resetExtensionCache() {
  cachedByFeature = null;
  cachedEditionKey = null;
}

module.exports = {
  getMarketExtension,
  resetExtensionCache,
};
