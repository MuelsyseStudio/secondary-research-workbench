'use strict';

/**
 * 商业版首次启动 EULA（《软件许可与工具中立免责协议》）本地签署门
 *
 * - 状态文件：stateFile('eula-consent.local.json')（打包隐私门禁自动排除）
 * - personal 开发模式默认不强制阻断（required = false）
 * - cn_commercial / global_commercial / partner 首次启动必须显式勾选同意方可进入主界面
 */

const fs = require('node:fs');
const path = require('node:path');
const { stateFile } = require('./app-paths.cjs');
const { getEditionInfo, DISCLAIMER_TEXT, EXECUTION_BOUNDARY_TEXT } = require('./edition.cjs');

const EULA_VERSION = '2026-11-v1';
const EULA_CONSENT_PATH = stateFile('eula-consent.local.json');

const EULA_CLAUSES = [
  {
    title: '一、软件工具中立定位（非证券投资咨询服务）',
    body: DISCLAIMER_TEXT,
  },
  {
    title: '二、数据源独立合规与本地自托管责任',
    body: '本软件核心付费本体为本地三库知识工程框架、图表与研究工作流软件，不转售、不承诺任何第三方未授权财经网站的商业行情与社区数据。内置离线演示数据包仅用于零配置功能体验；商业或高频研究使用，请通过标准数据源适配协议、本地 CSV/Markdown 导入或您本人合法采购的合规接口接入。',
  },
  {
    title: '三、AI 辅助输出与去荐股化红线',
    body: '通过 BYOAI（用户自备大模型 API 或本机授权 CLI）生成的一切笔记草稿、逻辑核验、假设证伪清单与复盘报告，均属于公开信息整理与结构化辅助，不构成任何买卖评级、目标价预测或投资建议。所有分析结论与交易决策均由用户自行独立判断并承担全部盈亏风险。',
  },
  {
    title: '四、交易执行边界声明',
    body: EXECUTION_BOUNDARY_TEXT,
  },
  {
    title: '五、本地数据隐私与离线授权条款',
    body: '您的研究笔记、三库文档、交易账本、API Key 与策略脚本均仅存储于您本机磁盘，软件不向开发者服务器上传您的私人持仓或策略源码。商业版离线授权码（SRW2）仅用于本地 Ed25519 验签与授权范围校验；年度订阅含永久回退权（对应订阅期内发布的版本号可永久离线使用）。',
  },
];

function readConsentRaw() {
  try {
    if (fs.existsSync(EULA_CONSENT_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(EULA_CONSENT_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // ignore corrupted file
  }
  return null;
}

function getEulaStatus() {
  const ed = getEditionInfo();
  const raw = readConsentRaw();
  const accepted = Boolean(raw && raw.accepted === true && raw.version === EULA_VERSION);
  return {
    required: ed.isCommercial,
    accepted: ed.isCommercial ? accepted : true,
    rawAccepted: accepted,
    version: EULA_VERSION,
    acceptedAt: accepted ? raw.acceptedAt || null : null,
    edition: ed.edition,
    title: '软件许可协议与工具中立免责声明（EULA）',
    clauses: EULA_CLAUSES,
    disclaimerText: DISCLAIMER_TEXT,
    executionBoundaryText: EXECUTION_BOUNDARY_TEXT,
  };
}

function acceptEula(payload = {}) {
  const ed = getEditionInfo();
  if (payload.agreed === false) {
    throw new Error('请先阅读并勾选同意《软件许可与工具中立免责协议》');
  }
  const record = {
    version: EULA_VERSION,
    accepted: true,
    edition: ed.edition,
    acceptedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(EULA_CONSENT_PATH), { recursive: true });
  fs.writeFileSync(EULA_CONSENT_PATH, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return getEulaStatus();
}

module.exports = {
  EULA_VERSION,
  EULA_CONSENT_PATH,
  EULA_CLAUSES,
  getEulaStatus,
  acceptEula,
};
