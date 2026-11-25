'use strict';

/**
 * 多版本发行与能力开关唯一真源（单代码库 + 编译期/打包期物理隔离）
 *
 * 版本判定优先级：
 *   1. APP_ROOT/release-config.json（打包成品的权威配置，不可被环境变量放宽国内合规限制）
 *   2. 环境变量 process.env.SRW_EDITION（开发调试期可用：personal | cn_commercial | global_commercial）
 *   3. 默认值：personal（本地个人自用研究模式，零回归）
 */

const fs = require('node:fs');
const path = require('node:path');
const { APP_ROOT } = require('./app-paths.cjs');

const RELEASE_CONFIG_PATH = path.join(APP_ROOT, 'release-config.json');

const DISCLAIMER_TEXT =
  '本软件为本地个人投研笔记、公开数据整理与策略研究工具框架，不提供证券投资咨询、荐股或代客理财服务。内嵌免费公开接口仅作体验演示，商业/高频使用请由用户在遵守当地法律法规前提下自行配置合规数据源或本地导入数据。一切投资决策与风险由用户自行承担。';

const EXECUTION_BOUNDARY_TEXT =
  'A 股交易执行边界：本版本仅支持模拟盘回测、A 股半自动交易计划卡（仓位/止损测算与一键复制）及可选用户自购券商官方合规本地接口槽位，不内置、不支持任何第三方行情/交易客户端模拟点击外挂或虚拟货币交易接入。';

function normalizeEditionId(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'oss' || s === 'open_source' || s === 'opensource' || s === 'community') {
    return 'open_source';
  }
  if (s === 'cn' || s === 'cn_commercial' || s === 'commercial_pro' || s === 'portable_friend') {
    return 'cn_commercial';
  }
  if (s === 'global' || s === 'global_commercial') {
    return 'global_commercial';
  }
  if (s === 'partner' || s === 'partner_whitelabel') {
    return 'partner';
  }
  if (s === 'personal' || s === 'developer' || s === 'dev') {
    return 'personal';
  }
  return null;
}

function readReleaseConfigRaw() {
  try {
    if (fs.existsSync(RELEASE_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(RELEASE_CONFIG_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // ignore malformed release-config.json
  }
  return null;
}

function defaultBuildDateISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 编译期固化常量（商业发行包经 esbuild 注入，优先级高于外部明文 release-config.json，防记事本篡改绕过）
const BAKED_EDITION = typeof __SRW_BAKED_EDITION__ === 'string' && __SRW_BAKED_EDITION__ ? __SRW_BAKED_EDITION__ : null;
const BAKED_BUILD_DATE = typeof __SRW_BAKED_BUILD_DATE__ === 'string' && __SRW_BAKED_BUILD_DATE__ ? __SRW_BAKED_BUILD_DATE__ : null;
const BAKED_FEATURES = typeof __SRW_BAKED_FEATURES__ === 'object' && __SRW_BAKED_FEATURES__ ? __SRW_BAKED_FEATURES__ : null;

function getEditionInfo() {
  const relCfg = readReleaseConfigRaw();
  const bakedEdition = normalizeEditionId(BAKED_EDITION);
  const relEdition = normalizeEditionId(relCfg?.edition);
  const envEdition = normalizeEditionId(process.env.SRW_EDITION);
  // 商业打包产物以编译期固化常量为最高权威，不受外部 release-config.json 或环境变量降级篡改
  const edition = bakedEdition || relEdition || envEdition || 'personal';

  const isOpenSource = edition === 'open_source';
  const isCnCommercial = edition === 'cn_commercial';
  const isGlobalCommercial = edition === 'global_commercial';
  const isPartner = edition === 'partner';
  const isCommercial = isCnCommercial || isGlobalCommercial || isPartner;
  const isPersonal = edition === 'personal';

  const buildDate =
    (BAKED_BUILD_DATE && /^\d{4}-\d{2}-\d{2}/.test(BAKED_BUILD_DATE) && BAKED_BUILD_DATE.slice(0, 10)) ||
    (typeof relCfg?.buildDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(relCfg.buildDate) && relCfg.buildDate.slice(0, 10)) ||
    (typeof relCfg?.builtAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(relCfg.builtAt) && relCfg.builtAt.slice(0, 10)) ||
    defaultBuildDateISO();

  // cn_commercial / partner / open_source 严格锁死对应合规与扩展边界，防止外部篡改放宽
  const featureSrc = BAKED_FEATURES || relCfg?.features || {};
  const features = {
    crypto: isCnCommercial || isPartner || isOpenSource
      ? false
      : typeof featureSrc.crypto === 'boolean'
      ? featureSrc.crypto
      : true,
    liveCryptoExecution: isCnCommercial || isPartner || isOpenSource
      ? false
      : typeof featureSrc.liveCryptoExecution === 'boolean'
      ? featureSrc.liveCryptoExecution
      : false,
    allowCommunityScrapers: isCommercial || isOpenSource
      ? false
      : typeof featureSrc.allowCommunityScrapers === 'boolean'
      ? featureSrc.allowCommunityScrapers
      : true,
    showDisclaimerBanner: isCommercial || isOpenSource
      ? true
      : Boolean(featureSrc.showDisclaimerBanner),
    lockBrandDisclaimer: isPartner
      ? true
      : Boolean(featureSrc.lockBrandDisclaimer),
  };

  const editionLabel = isOpenSource
    ? '开源社区版 (Open Source)'
    : isCnCommercial
    ? '国内商业版 (CN)'
    : isGlobalCommercial
    ? '海外商业版 (Global)'
    : isPartner
    ? '机构合作版 (Partner)'
    : '个人研究版 (Personal)';

  return {
    edition,
    editionLabel,
    buildDate,
    isOpenSource,
    isCnCommercial,
    isGlobalCommercial,
    isPartner,
    isCommercial,
    isPersonal,
    features,
    disclaimerText: DISCLAIMER_TEXT,
    executionBoundaryText: EXECUTION_BOUNDARY_TEXT,
    releaseConfig: relCfg,
  };
}

module.exports = {
  RELEASE_CONFIG_PATH,
  DISCLAIMER_TEXT,
  EXECUTION_BOUNDARY_TEXT,
  normalizeEditionId,
  readReleaseConfigRaw,
  getEditionInfo,
};
