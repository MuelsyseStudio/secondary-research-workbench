/**
 * 编译期发行版本与特性常量（Vite define 静态折叠 + Rollup Tree-Shaking 物理剔除）
 *
 * - 国内商业版构建命令传入 VITE_EDITION=cn_commercial VITE_ENABLE_CRYPTO=false，
 *   所有 `if (CRYPTO_ENABLED)` / `CRYPTO_ENABLED && (...)` 分支将在编译压缩期被彻底删除，
 *   确保 dist/assets/*.js 中零残留。
 * - 本地开发默认 `personal`，保持全部个人研究扩展功能零回归。
 */

export type AppEdition = 'personal' | 'open_source' | 'cn_commercial' | 'global_commercial' | 'partner';

export const APP_EDITION = (import.meta.env.VITE_EDITION || 'personal') as AppEdition;
export const IS_OPEN_SOURCE_EDITION = APP_EDITION === 'open_source';
export const IS_CN_EDITION = APP_EDITION === 'cn_commercial';
export const IS_PARTNER_EDITION = APP_EDITION === 'partner';
export const IS_COMMERCIAL_EDITION =
  APP_EDITION === 'cn_commercial' || APP_EDITION === 'global_commercial' || APP_EDITION === 'partner';
export const CRYPTO_ENABLED =
  !IS_CN_EDITION && !IS_PARTNER_EDITION && !IS_OPEN_SOURCE_EDITION && import.meta.env.VITE_ENABLE_CRYPTO === 'true';
export const ALLOW_COMMUNITY_SCRAPERS = !IS_COMMERCIAL_EDITION && !IS_OPEN_SOURCE_EDITION;

export const EDITION_DISPLAY_LABEL = IS_OPEN_SOURCE_EDITION
  ? '开源社区版'
  : IS_CN_EDITION
  ? '国内商业版'
  : APP_EDITION === 'global_commercial'
  ? '海外商业版'
  : IS_PARTNER_EDITION
  ? '机构合作版'
  : '个人研究版';

export const LOCAL_TOOL_DISCLAIMER =
  '本软件为本地个人投研笔记、公开数据整理与策略研究工具框架，不提供证券投资咨询、荐股或代客理财服务。内嵌免费公开接口仅作体验演示，商业/高频使用请由用户在遵守当地法律法规前提下自行配置合规数据源或本地导入数据。一切投资决策与风险由用户自行承担。';

export const EXECUTION_BOUNDARY_NOTICE =
  'A 股交易执行边界：本版本仅支持模拟盘回测、A 股半自动交易计划卡（仓位/止损测算与一键复制）及可选用户自购券商官方合规本地接口槽位，不内置、不支持任何第三方行情/交易客户端模拟点击外挂或虚拟货币交易接入。';
