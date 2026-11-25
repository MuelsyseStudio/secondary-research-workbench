'use strict';

/**
 * 商业化权益门控引擎（路由级 + 能力级单一真源）
 *
 * 严格遵循《商业化总蓝图与 Phase 1 实施规格》第 2.2 节映射表：
 * - Free 基础版：三库闭环、单图基础盯盘、手工交易账本、基础复盘与 Prompt 复制永久不拦截；
 * - Pro 专业版：多工作空间、AI 自动复盘与对账、投委会红队辩论、文献/语音/情报批量提纯、
 *   交割单 CSV/AI 解析、持久化画线预警、定时巡检/Webhook/自定义源、周/月报聚合、
 *   SlimeBot L2-L3 写库与桌面挂件、品牌定制、K 线盲测回放、多图同屏；
 * - Max 量化版：Stage 4 Python + DuckDB 策略回测实验室写操作与回测执行（只读环境检查与预览开放）；
 * - Partner 合作版：机构白标清单钩子（partner-manifest.json）；
 * - personal 开发者模式 & enforcementMode === 'permissive'（好友体验包）自动全量放行，零回归！
 */

const fs = require('node:fs');
const path = require('node:path');
const { APP_ROOT } = require('./app-paths.cjs');
const { getLicenseStatus } = require('./license-service.cjs');

const FEATURE_CATALOG = {
  multi_workspace: {
    requiredTier: 'pro',
    label: '多工作空间 & Obsidian / Git 热切换',
    desc: '自由创建和挂载多个独立三库目录，隔离实盘与模拟研究档案',
  },
  ai_daily_review: {
    requiredTier: 'pro',
    label: 'AI 全自动日度复盘与数值防幻觉对账',
    desc: '基于真实 1 分钟数据自动生成十节复盘草稿、校验数值并一键归档 HTML',
  },
  ic_adversarial_debate: {
    requiredTier: 'pro',
    label: 'AI 标的研判与红队反驳辩论',
    desc: '自动拉取公开财务/公告生成客观研究笔记与逻辑证伪清单',
  },
  ai_batch_ingest: {
    requiredTier: 'pro',
    label: '文献 / 语音 / 情报中心 / 存量库批量提纯',
    desc: 'PDF/Word/录音转写与多源资料批量分流提纯至方法论/认知候选箱',
  },
  trade_ledger_ai_import: {
    requiredTier: 'pro',
    label: '券商交割单批量解析与 AI 坏习惯归因',
    desc: '一键解析交割单 CSV/截图并统计方法论卡片胜率与坏习惯成本',
  },
  custom_chart_drawings: {
    requiredTier: 'pro',
    label: 'K 线画线本地持久化与穿线预警',
    desc: '趋势线/支撑阻力线永久存档并自动接入盘中穿线监测',
  },
  scheduler_webhooks: {
    requiredTier: 'pro',
    label: '自动化定时巡检与 Webhook 推送',
    desc: '开启盘中/盘后定时巡检任务及飞书/企微/钉钉自动化推送（用户自配合规数据源永久向免费基础版开放）',
  },
  periodic_meta_review: {
    requiredTier: 'pro',
    label: '周报 / 月报聚合复盘与独立 HTML 导出',
    desc: '跨日评分演化、跟踪锚命中率统计与 AI 周期深度反思',
  },
  slime_bot_autonomous: {
    requiredTier: 'pro',
    label: 'SlimeBot L2–L3 写库管家与桌面悬浮挂件',
    desc: '授权 Bot 自动提案写库与独立透明桌宠挂件联动',
  },
  brand_custom: {
    requiredTier: 'pro',
    label: '工作台个性化品牌图标与 AI 矢量重绘',
    desc: '自定义左上角图标、标题与专属工作台视觉风格',
  },
  bar_replay_trainer: {
    requiredTier: 'pro',
    label: 'K 线历史盲测回放训练器',
    desc: '遮蔽未来 K 线逐根推进推演并实时核算模拟交易净值与回撤',
  },
  multi_chart: {
    requiredTier: 'pro',
    label: '短线多图同屏盯盘（2 屏 / 4 屏）',
    desc: '同时监控多只核心标的的分时与 K 线走势，联动或独立盯盘',
  },
  quant_backtest: {
    requiredTier: 'max',
    label: 'Python + DuckDB 策略回测实验室（Max）',
    desc: '本地 DuckDB 历史行情仓、可视化/Python 策略撮合回测与 K 线 B/S 复盘',
  },
  partner_whitelabel: {
    requiredTier: 'partner',
    label: '机构合作白标与只读内容包（Partner）',
    desc: '签名机构清单锁定品牌免责栏与机构合规分发能力',
  },
};

// 静态路由级门控映射表（对齐 Spec 2.2，除 2 个需读取 body 的条件路由外均在此声明）
const STATIC_ROUTE_GUARDS = [
  { method: 'POST', path: '/api/app/workspace/switch', feature: 'multi_workspace' },
  { method: 'POST', path: '/api/app/workspace/create', feature: 'multi_workspace' },

  { method: 'POST', path: '/api/ai/daily-review/run', feature: 'ai_daily_review' },
  { method: 'POST', path: '/api/ai/daily-review/start', feature: 'ai_daily_review' },
  { method: 'POST', path: '/api/ai/reconcile/apply', feature: 'ai_daily_review' },
  { method: 'POST', path: '/api/daily-review/save-html', feature: 'ai_daily_review' },

  { method: 'POST', path: '/api/ai/judgment/start', feature: 'ic_adversarial_debate' },
  { method: 'POST', path: '/api/ai/chart-vision-analyze', feature: 'ic_adversarial_debate' },

  { method: 'POST', path: '/api/ingest/run', feature: 'ai_batch_ingest' },
  { method: 'POST', path: '/api/ingest/start', feature: 'ai_batch_ingest' },
  { method: 'POST', path: '/api/audio/transcribe', feature: 'ai_batch_ingest' },
  { method: 'POST', path: '/api/intel/run', feature: 'ai_batch_ingest' },
  { method: 'POST', path: '/api/vault/import', feature: 'ai_batch_ingest' },

  { method: 'POST', path: '/api/trades/parse-csv', feature: 'trade_ledger_ai_import' },
  { method: 'POST', path: '/api/trades/parse-ai', feature: 'trade_ledger_ai_import' },

  { method: 'POST', path: '/api/chart/drawings', feature: 'custom_chart_drawings' },

  { method: 'POST', path: '/api/scheduler/config', feature: 'scheduler_webhooks' },
  { method: 'POST', path: '/api/scheduler/test-webhook', feature: 'scheduler_webhooks' },
  { method: 'POST', path: '/api/scheduler/run-scan', feature: 'scheduler_webhooks' },
  { method: 'POST', path: '/api/scheduler/run-postmarket', feature: 'scheduler_webhooks' },

  { method: 'POST', path: '/api/periodic-review/summary', feature: 'periodic_meta_review' },
  { method: 'POST', path: '/api/periodic-review/ai', feature: 'periodic_meta_review' },
  { method: 'POST', path: '/api/periodic-review/html', feature: 'periodic_meta_review' },

  { method: 'POST', path: '/api/bot/approve', feature: 'slime_bot_autonomous' },
  { method: 'POST', path: '/api/bot/launch-desktop-pet', feature: 'slime_bot_autonomous' },

  { method: 'POST', path: '/api/brand', feature: 'brand_custom' },
  { method: 'POST', path: '/api/brand/ai-stylize', feature: 'brand_custom' },

  { method: 'POST', path: '/api/quant/env/setup', feature: 'quant_backtest' },
  { method: 'POST', path: '/api/quant/data/sync', feature: 'quant_backtest' },
  { method: 'POST', path: '/api/quant/data/import-csv', feature: 'quant_backtest' },
  { method: 'POST', path: '/api/quant/strategies', feature: 'quant_backtest' },
  { method: 'POST', path: '/api/quant/strategies/from-cards', feature: 'quant_backtest' },
  { method: 'POST', path: '/api/quant/backtest/run', feature: 'quant_backtest' },
  { method: 'POST', path: '/api/quant/published-strategies', feature: 'quant_backtest' },
  { method: 'POST', path: '/api/quant/screen-live', feature: 'quant_backtest' },
];

const STATIC_GUARD_INDEX = new Map(STATIC_ROUTE_GUARDS.map((r) => [`${r.method} ${r.path}`, r.feature]));

function loadPartnerManifest() {
  const mp = path.join(APP_ROOT, 'partner-manifest.json');
  try {
    if (fs.existsSync(mp)) {
      const parsed = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // ignore malformed partner manifest
  }
  return null;
}

function isFeatureUnlocked(featureKey, licenseStatus = null) {
  const lic = licenseStatus || getLicenseStatus();
  const meta = FEATURE_CATALOG[featureKey];
  if (!meta) return true;

  // personal 开发模式、开源社区版或 permissive 好友体验态自动放行
  if (
    lic.tier === 'developer' ||
    lic.tier === 'community_oss' ||
    lic.enforcementMode === 'open_source' ||
    lic.enforcementMode !== 'enforced'
  ) {
    return true;
  }

  // 检查显式特性通配符（SRW2 features 数组）
  const explicit = Array.isArray(lic.features) ? lic.features : [];
  if (
    explicit.includes('*') ||
    explicit.includes(featureKey) ||
    explicit.includes(`${meta.requiredTier}:*`)
  ) {
    return true;
  }

  if (meta.requiredTier === 'pro') return Boolean(lic.proUnlocked);
  if (meta.requiredTier === 'max') return Boolean(lic.maxUnlocked);
  if (meta.requiredTier === 'partner') return Boolean(lic.partnerUnlocked);
  return true;
}

function getEntitlementsSnapshot(licenseStatus = null) {
  const lic = licenseStatus || getLicenseStatus();
  const features = {};
  const featureMeta = {};
  for (const [k, meta] of Object.entries(FEATURE_CATALOG)) {
    features[k] = isFeatureUnlocked(k, lic);
    featureMeta[k] = {
      requiredTier: meta.requiredTier,
      label: meta.label,
      desc: meta.desc,
    };
  }
  const unlockedTiers = ['free'];
  if (lic.proUnlocked) unlockedTiers.push('pro');
  if (lic.maxUnlocked) unlockedTiers.push('max');
  if (lic.partnerUnlocked) unlockedTiers.push('partner');

  return {
    enforced: lic.enforcementMode === 'enforced' && lic.tier !== 'developer' && lic.tier !== 'community_oss',
    tier: lic.tier,
    unlockedTiers,
    features,
    featureMeta,
    partnerManifest: loadPartnerManifest(),
  };
}

function buildUpgradeRequiredPayload(featureKey, licenseStatus = null) {
  const lic = licenseStatus || getLicenseStatus();
  const meta = FEATURE_CATALOG[featureKey] || {
    requiredTier: 'pro',
    label: featureKey,
    desc: '',
  };
  const tierName = meta.requiredTier === 'max' ? 'Max 量化版' : meta.requiredTier === 'partner' ? 'Partner 合作版' : 'Pro 专业版';
  return {
    ok: false,
    code: 'UPGRADE_REQUIRED',
    feature: featureKey,
    requiredTier: meta.requiredTier,
    featureLabel: meta.label,
    machineCode: lic.machineCode,
    message: `「${meta.label}」属于 ${tierName} 权益，请激活对应 SRW2 离线授权码后使用（当前档位：${lic.tierLabel}）。`,
  };
}

function checkStaticRouteFeature(method, pathname) {
  return STATIC_GUARD_INDEX.get(`${String(method || '').toUpperCase()} ${pathname}`) || null;
}

/**
 * 校验某功能权限；未授权时返回 402 载荷，授权通过返回 null
 */
function checkFeatureEntitlement(featureKey, licenseStatus = null) {
  if (!featureKey) return null;
  const lic = licenseStatus || getLicenseStatus();
  if (isFeatureUnlocked(featureKey, lic)) return null;
  return buildUpgradeRequiredPayload(featureKey, lic);
}

/**
 * 合规原则：免费基础版必须永久允许用户接入自己合法购买/配置的合规数据源（POST /api/data-sources custom 模式），
 * 绝不把合规数据源接入锁进付费墙。
 */
function isCustomDataSourcePayload() {
  return false;
}

module.exports = {
  FEATURE_CATALOG,
  STATIC_ROUTE_GUARDS,
  loadPartnerManifest,
  isFeatureUnlocked,
  getEntitlementsSnapshot,
  buildUpgradeRequiredPayload,
  checkStaticRouteFeature,
  checkFeatureEntitlement,
  isCustomDataSourcePayload,
};
