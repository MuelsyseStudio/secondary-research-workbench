'use strict';

/**
 * A 股半自动交易计划卡测算 & 可选用户自购券商官方 MiniQMT (xtquant) 本地合规插件槽位
 *
 * 合规边界：
 * 1. 国内商业版仅支持模拟盘回测、A 股半自动交易计划卡（仓位/止损测算与一键复制）
 *    及默认关闭的券商官方 MiniQMT (xtquant) 本地合规接口槽位；
 * 2. 不内置、不分发任何券商客户端、模拟点击外挂或虚拟货币交易接入；
 * 3. 本地槽位配置文件 execution-slot.local.json 自动受打包隐私门禁排除，账号字段对外严格脱敏。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stateFile } = require('./app-paths.cjs');
const { atomicWriteFileSync } = require('./lru-cache.cjs');
const { encryptSecret, decryptSecret } = require('./secret-vault.cjs');
const { getEditionInfo } = require('./edition.cjs');
const { resolvePythonExecutable } = require('./quant-bridge.cjs');

const SLOT_CONFIG_PATH = stateFile('execution-slot.local.json');

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

function maskAccountId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(4, s.length - 4))}${s.slice(-2)}`;
}

function inferAShareBoard(code) {
  const clean = String(code || '').replace(/[^\d]/g, '');
  if (clean.startsWith('688')) return { board: 'STAR', label: '科创板 (±20%)', limitPct: 20 };
  if (clean.startsWith('300') || clean.startsWith('301')) return { board: 'CHINEXT', label: '创业板 (±20%)', limitPct: 20 };
  if (clean.startsWith('4') || clean.startsWith('8') || clean.startsWith('92')) {
    return { board: 'BSE', label: '北交所 (±30%)', limitPct: 30 };
  }
  return { board: 'MAIN', label: '沪深主板 (±10%)', limitPct: 10 };
}

/**
 * A 股半自动交易计划卡纯函数测算（严格按 A 股 100 股/手向下取整 + 单笔风险与单票仓位双约束）
 */
function calculateAShareTradePlan(input = {}) {
  const code = String(input.code || '').trim().toUpperCase();
  const name = String(input.name || '').trim();
  const accountCapital = Number(input.accountCapital);
  const riskPct = Number(input.riskPct ?? 1.5);
  const maxSinglePct = Number(input.maxSinglePct ?? 25);
  const entryPrice = Number(input.entryPrice);
  const stopLossPrice = Number(input.stopLossPrice);
  const targetPrice = input.targetPrice !== '' && input.targetPrice != null ? Number(input.targetPrice) : null;
  const commissionRate = Number(input.commissionRate ?? 0.00025);
  const note = String(input.note || '').trim();

  if (!Number.isFinite(accountCapital) || accountCapital <= 0) {
    throw new Error('账户总资金必须大于 0');
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error('计划买入价必须大于 0');
  }
  if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) {
    throw new Error('硬止损价必须大于 0');
  }
  if (Math.abs(entryPrice * 10000 - Math.round(entryPrice * 10000)) > 1e-6 || Math.abs(stopLossPrice * 10000 - Math.round(stopLossPrice * 10000)) > 1e-6) {
    throw new Error('买入价与硬止损价最多支持 4 位小数精度');
  }
  if (stopLossPrice >= entryPrice) {
    throw new Error('硬止损价必须严格低于计划买入价');
  }
  const rawRiskPerShare = entryPrice - stopLossPrice;
  if (rawRiskPerShare < 0.0001) {
    throw new Error('买入价与硬止损价价差过小（需 ≥ ¥0.0001），无法进行有效风险仓位测算');
  }
  if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > 20) {
    throw new Error('单笔最大风险比例需在 0% ~ 20% 之间');
  }
  if (!Number.isFinite(maxSinglePct) || maxSinglePct <= 0 || maxSinglePct > 100) {
    throw new Error('单票最大仓位上限需在 0% ~ 100% 之间');
  }

  const boardInfo = inferAShareBoard(code);
  const rawRiskBudget = accountCapital * (riskPct / 100);
  if (!Number.isFinite(rawRiskBudget) || rawRiskBudget <= 0) {
    throw new Error('单笔风险预算必须大于 0');
  }
  const riskBudget = round2(rawRiskBudget);
  const riskPerShare = round4(rawRiskPerShare);
  const stopLossPct = round2((rawRiskPerShare / entryPrice) * 100);

  const sharesByRisk = Math.max(0, Math.floor(rawRiskBudget / rawRiskPerShare / 100) * 100);
  const maxCapitalByPos = round2(accountCapital * (maxSinglePct / 100));
  const sharesByPos = Math.max(0, Math.floor(maxCapitalByPos / entryPrice / 100) * 100);

  const suggestedShares = Math.min(sharesByRisk, sharesByPos);
  const suggestedLots = suggestedShares / 100;
  const bindingConstraint = sharesByRisk <= sharesByPos ? '单笔风险预算约束' : '单票仓位上限约束';

  const plannedAmount = round2(suggestedShares * entryPrice);
  const positionPct = round2((plannedAmount / accountCapital) * 100);
  const maxLossAmount = round2(suggestedShares * rawRiskPerShare);
  const actualRiskPct = round2((maxLossAmount / accountCapital) * 100);
  const estCommission = plannedAmount > 0 ? Math.max(5, round2(plannedAmount * Math.max(0, commissionRate))) : 0;

  let rewardRiskRatio = null;
  let targetGainPct = null;
  let expectedProfit = null;
  if (targetPrice != null && Number.isFinite(targetPrice) && targetPrice > entryPrice) {
    rewardRiskRatio = round2((targetPrice - entryPrice) / rawRiskPerShare);
    targetGainPct = round2(((targetPrice - entryPrice) / entryPrice) * 100);
    expectedProfit = round2(suggestedShares * (targetPrice - entryPrice));
  }

  const ed = getEditionInfo();
  const stockTitle = [code || '待填代码', name].filter(Boolean).join(' ');
  const lines = [
    `【A股半自动交易计划卡】${stockTitle}（${boardInfo.label}）`,
    `方向：买入计划 | 计划买价：¥${entryPrice.toFixed(2)} | 硬止损价：¥${stopLossPrice.toFixed(2)}（止损幅度 -${stopLossPct.toFixed(2)}%）`,
    targetPrice && targetPrice > entryPrice
      ? `目标止盈：¥${targetPrice.toFixed(2)}（+${targetGainPct?.toFixed(2)}% | 盈亏比 ${rewardRiskRatio?.toFixed(2)} : 1 | 预期毛利 ¥${expectedProfit?.toLocaleString()}）`
      : `目标止盈：未设（请按分批兑现纪律跟踪）`,
    `建议股数：${suggestedShares.toLocaleString()} 股（${suggestedLots} 手，100股整数倍） | 计划金额：¥${plannedAmount.toLocaleString()}（占总资金 ${positionPct.toFixed(2)}%）`,
    `最大止损亏损：¥${maxLossAmount.toLocaleString()}（占总资金 ${actualRiskPct.toFixed(2)}% / 预算 ${riskPct}%） | 主约束：${bindingConstraint} | 预估佣金：¥${estCommission.toFixed(2)}`,
    ...(note ? [`执行逻辑与纪律：${note}`] : []),
    `边界说明：本计划卡仅作个人投研测算与人工核对复制，不构成投资建议；${ed.executionBoundaryText}`,
  ];

  return {
    ok: true,
    code,
    name,
    board: boardInfo.board,
    boardLabel: boardInfo.label,
    accountCapital: round2(accountCapital),
    riskPct,
    maxSinglePct,
    entryPrice: round2(entryPrice),
    stopLossPrice: round2(stopLossPrice),
    targetPrice: targetPrice && targetPrice > entryPrice ? round2(targetPrice) : null,
    riskBudget,
    riskPerShare,
    stopLossPct,
    sharesByRisk,
    sharesByPos,
    suggestedShares,
    suggestedLots,
    bindingConstraint,
    plannedAmount,
    positionPct,
    maxLossAmount,
    actualRiskPct,
    estCommission,
    rewardRiskRatio,
    targetGainPct,
    expectedProfit,
    copyText: lines.join('\n'),
  };
}

function createDefaultSlotConfig() {
  return {
    version: 1,
    updatedAt: null,
    miniqmt: {
      enabled: false,
      mode: 'plan_card_only',
      userdataMiniPath: '',
      accountId: '',
      accountType: 'STOCK',
      readOnlyConfirmLock: true,
      notes: '',
    },
  };
}

function loadRawSlotConfig() {
  const def = createDefaultSlotConfig();
  if (!fs.existsSync(SLOT_CONFIG_PATH)) return def;
  try {
    const raw = JSON.parse(fs.readFileSync(SLOT_CONFIG_PATH, 'utf8'));
    const mq = raw && typeof raw.miniqmt === 'object' ? raw.miniqmt : {};
    return {
      version: 1,
      updatedAt: raw.updatedAt || null,
      miniqmt: {
        ...def.miniqmt,
        ...mq,
        accountId: decryptSecret(mq.accountId),
        enabled: Boolean(mq.enabled),
        mode: mq.enabled ? 'miniqmt_local_slot' : 'plan_card_only',
        accountType: 'STOCK',
        readOnlyConfirmLock: mq.readOnlyConfirmLock !== false,
      },
    };
  } catch {
    return def;
  }
}

function getSafeExecutionSlotState() {
  const ed = getEditionInfo();
  const cfg = loadRawSlotConfig();
  return {
    ok: true,
    edition: ed.edition,
    executionBoundaryText: ed.executionBoundaryText,
    disclaimerText: ed.disclaimerText,
    updatedAt: cfg.updatedAt,
    slot: {
      miniqmt: {
        enabled: cfg.miniqmt.enabled,
        mode: cfg.miniqmt.enabled ? 'miniqmt_local_slot' : 'plan_card_only',
        userdataMiniPath: cfg.miniqmt.userdataMiniPath,
        hasAccountId: Boolean(cfg.miniqmt.accountId),
        maskedAccountId: maskAccountId(cfg.miniqmt.accountId),
        accountType: 'STOCK',
        readOnlyConfirmLock: cfg.miniqmt.readOnlyConfirmLock,
        notes: cfg.miniqmt.notes,
      },
    },
    capabilities: {
      planCard: true,
      miniqmtSlotRegistered: true,
      miniqmtEnabled: cfg.miniqmt.enabled,
      autoClickForbidden: true,
      cryptoExecutionForbidden: !ed.features.crypto,
    },
  };
}

function saveExecutionSlotConfig(patch = {}) {
  const cur = loadRawSlotConfig();
  const incoming = patch && typeof patch.miniqmt === 'object' ? patch.miniqmt : patch || {};

  if (incoming.mode && !['plan_card_only', 'miniqmt_local_slot'].includes(String(incoming.mode))) {
    throw new Error('仅支持 plan_card_only（半自动计划卡）或 miniqmt_local_slot（券商官方 MiniQMT 本地合规槽位）');
  }
  if (incoming.accountType && String(incoming.accountType).toUpperCase() !== 'STOCK') {
    throw new Error('国内合规槽位仅支持 A 股现货账户 (STOCK)');
  }

  const nextEnabled =
    typeof incoming.enabled === 'boolean'
      ? incoming.enabled
      : incoming.mode === 'miniqmt_local_slot'
      ? true
      : incoming.mode === 'plan_card_only'
      ? false
      : cur.miniqmt.enabled;

  const next = {
    ...cur.miniqmt,
    enabled: nextEnabled,
    mode: nextEnabled ? 'miniqmt_local_slot' : 'plan_card_only',
    userdataMiniPath:
      typeof incoming.userdataMiniPath === 'string'
        ? incoming.userdataMiniPath.trim()
        : cur.miniqmt.userdataMiniPath,
    accountType: 'STOCK',
    readOnlyConfirmLock:
      typeof incoming.readOnlyConfirmLock === 'boolean'
        ? incoming.readOnlyConfirmLock
        : cur.miniqmt.readOnlyConfirmLock,
    notes: typeof incoming.notes === 'string' ? incoming.notes.trim().slice(0, 300) : cur.miniqmt.notes,
  };

  if (incoming.clearAccountId) {
    next.accountId = '';
  } else if (typeof incoming.accountId === 'string') {
    const trimmed = incoming.accountId.trim();
    if (trimmed && trimmed !== maskAccountId(cur.miniqmt.accountId)) {
      next.accountId = trimmed;
    }
  }

  const toWrite = {
    version: 1,
    updatedAt: new Date().toISOString(),
    miniqmt: {
      ...next,
      accountId: next.accountId ? encryptSecret(next.accountId) : '',
    },
  };
  atomicWriteFileSync(SLOT_CONFIG_PATH, JSON.stringify(toWrite, null, 2) + '\n', 'utf8', { mode: 0o600 });
  return getSafeExecutionSlotState();
}

function probeMiniQmtSlot(draft = {}) {
  const cur = loadRawSlotConfig();
  const mq = draft && typeof draft.miniqmt === 'object' ? draft.miniqmt : draft || {};
  const enabled = typeof mq.enabled === 'boolean' ? mq.enabled : cur.miniqmt.enabled;
  const userdataMiniPath =
    typeof mq.userdataMiniPath === 'string' ? mq.userdataMiniPath.trim() : cur.miniqmt.userdataMiniPath;

  if (!enabled) {
    return {
      ok: false,
      ready: false,
      status: 'disabled',
      pathExists: false,
      xtquantInstalled: false,
      message:
        'MiniQMT 本地合规插件槽位默认关闭（当前仅使用模拟回测与 A 股半自动交易计划卡）。如需对接您本人已开通的券商官方极简版 QMT，请先开启槽位并填写 userdata_mini 路径。',
    };
  }

  const pathExists = Boolean(userdataMiniPath && fs.existsSync(userdataMiniPath));
  let xtquantInstalled = false;
  let pythonReady = false;
  try {
    const py = resolvePythonExecutable();
    if (py && py.found) {
      pythonReady = true;
      const r = spawnSync(py.executable, ['-c', 'import importlib.util; print("OK" if importlib.util.find_spec("xtquant") else "NO")'], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
      });
      xtquantInstalled = r.status === 0 && String(r.stdout || '').trim() === 'OK';
    }
  } catch {
    xtquantInstalled = false;
  }

  const ready = pathExists && xtquantInstalled;
  const missing = [];
  if (!pathExists) missing.push(userdataMiniPath ? '未找到指定的本机 userdata_mini 目录' : '尚未填写券商官方 QMT 的 userdata_mini 目录路径');
  if (!xtquantInstalled) missing.push('当前 Python 环境未安装用户自购券商提供的 xtquant 包');

  return {
    ok: ready,
    ready,
    status: ready ? 'ready' : 'incomplete',
    pathExists,
    xtquantInstalled,
    pythonReady,
    message: ready
      ? '本机 MiniQMT (xtquant) 合规槽位前置检测通过：userdata_mini 目录与 xtquant 模块均已就绪（只读核对与计划导出模式）。'
      : `MiniQMT 本地槽位尚未就绪：${missing.join('；')}。本软件不内置券商客户端，请使用券商官方极简版 QMT 并按需自配。`,
  };
}

module.exports = {
  SLOT_CONFIG_PATH,
  inferAShareBoard,
  calculateAShareTradePlan,
  getSafeExecutionSlotState,
  saveExecutionSlotConfig,
  probeMiniQmtSlot,
};
