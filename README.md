# Secondary Research Workbench（二级投研 · 三库本地研究工作台）

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.11-339933.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-%3E%3D3.10%20(Optional)-3776AB.svg)](./quant_engine/README.md)
[![Version](https://img.shields.io/badge/Version-v2.0.0-indigo.svg)](#)

**本地优先（Local-First）、纯文本 Markdown 驱动的二级市场投研知识工程、K 线盯盘、交易复盘与策略回测工作台（Apache-2.0 开源社区版）。**

> **免责声明 / Disclaimer**：本项目仅作为个人投研笔记管理、公开数据整理、交互式图表分析与策略研究框架开源，**不提供证券投资咨询、荐股、目标价预测或自动交易下单服务**。一切数据接入与投资决策均由使用者独立完成并自负盈亏。

---

## 核心特性

1. **三库双模知识工程（v1 单文件 ↔ KB v2 单卡引擎，永不锁死，天然兼容 Obsidian / Git）**
   - **方法论卡片库**（核心论断 / 逻辑链条 / 适用条件 / 可证伪失效信号 / 冲突矩阵 / 可信度演化）
   - **行业前沿认知库**（A/B/C 三级证据定级、产业映射、时效到期锚与证伪条件）
   - **研判与复盘台账**（标的假设追踪、日度/周期复盘、Diff 确认门写库 + 自动备份回滚）
   - **KB v2 双模知识内核（内置零外部依赖）**：
     - **单卡单文件 YAML Markdown**（`kb/cards/{methodology,cognition,conflicts}/*.md`）+ **独立复盘事件流**（`kb/events/review-log.jsonl`），Diff 确认门从整库大文件收敛为精准单卡 Diff；
     - **原生 `node:sqlite` FTS5 派生索引 + 6ms 三路混合检索**（标的实体路由 + FTS5 BM25 + 投研同义词表，Node `>= 22.13` 原生加速，Node 20 自动优雅降级至内存 JSON 索引）；
     - **1-Hop 图谱真相编译器（AI Truth Compiler）**：研判、日度复盘、入库与助手检索自动挂载关联冲突矩阵（`CF:NN`）、部分证伪反证卡与过期提醒，杜绝 AI 误用旧认知；
     - **8 大产业链活视图（Living Topics）与主动时效巡检（Stale Patrol）**：自动聚合活跃/非活跃卡并支持 AI 起草共识摘要；
     - **一键无损升级与逆向编译导出**：支持严格只读原件一键 v1 → v2 无损迁移，以及一键逆向编译导出经典单文件快照（`kb/exports/*.compiled.md`）。
   - 支持一键多工作空间隔离与外部本地目录挂载
2. **交互式 K 线终端与技术分析实验室**
   - 基于 Apache-2.0 的 `klinecharts` v10，支持多周期切换、6 流派技术位叠加、画线持久化与预警、历史盲测回放训练器
   - 支持**个股全屏 K 线页内「AI 实时识图解盘」**（自动截取多图层画布并融合技术指标进行多轮对话）
3. **Python + DuckDB 策略回测实验室（可选模块，零强依赖）**
   - 100% 原创事件驱动回测内核（`quant_engine/`），全部采用 MIT / BSD / Apache-2.0 依赖
   - 支持指定标的 / DuckDB 全池 / 横截面动态选股回测，以及**一键提取为全市场盯盘 `策B` / `策S` 标记**
   - 未安装 Python 时工作台其余全部功能零报错正常运行
4. **本地优先安全与可插拔架构**
   - 所有笔记、账本、策略与凭证均保存在本机；API Key / Webhook Token 使用 AES-256-GCM 本地保险库加密
   - 支持 BYOK（自备 DeepSeek / Qwen / Kimi / OpenAI / Gemini / 本机 CLI）与标准可插拔数据源协议（CSV / Parquet / Tushare / BaoStock / Custom REST / 本地 Webhook）
   - 开源社区版**无付费墙、无商业激活码拦截、无遥测上报**

---

## 3 分钟快速启动

### 前置要求
- **Node.js** `>= 20.11.0`（推荐 **Node `>= 22.13` / 22 LTS+** 以原生开启零依赖 `node:sqlite` FTS5 混合检索；在旧版 Node 20 上将自动优雅降级至内存索引并正常运行）
- **Python** `>= 3.10`（仅在使用「量化回测实验室」时需要）

### 1. 安装依赖并启动

```bash
# 1. 安装前端与服务端依赖
npm install

# 2. 构建开源版前端产物
npm run build

# 3. 启动本地工作台服务（默认 http://127.0.0.1:3721）
npm start
```

首次启动时若未指定 `SRW_DATA_DIR`，系统会在当前项目下的 `./data/现行三库/` 自动初始化一套标准示例三库（已被 `.gitignore` 忽略），做到 **clone 即用**。

### 2. 开发热重载模式

```bash
# 终端 1：启动后端 API 服务（开发跨域模式）
npm run server:dev

# 终端 2：启动 Vite 前端热更新（http://127.0.0.1:5173）
npm run dev
```

### 3. （可选）启用 Python + DuckDB 量化回测实验室

```bash
cd quant_engine
python -m venv .venv

# Windows PowerShell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install -e .

# macOS / Linux
source .venv/bin/activate
pip install -r requirements.txt && pip install -e .
```

详细命令与策略模板参见 [quant_engine/README.md](./quant_engine/README.md)。

---

## 环境变量与配置

复制 `.env.example`（按需设置环境变量，所有选项均有合理默认值）：

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3721` | 本地 HTTP 服务监听端口（强制仅绑定 `127.0.0.1`） |
| `SRW_DATA_DIR` | `./data` | 自定义本地三库与状态数据根目录（可指向 Obsidian/Git 仓库） |
| `SRW_EDITION` | `open_source` | 运行版本标识（开源版默认为 `open_source`） |

---

## 目录结构

```text
.
├── src/                         # React 19 + TypeScript + Vite 前端界面
├── server/                      # 零框架原生 Node.js 本地服务与双模解析/写库/回测桥接引擎
│   ├── knowledge-store.cjs      # v1/v2 双模统一知识库存储门面
│   ├── kb/                      # KB v2 零依赖内核（YAML/迁移/SQLite FTS5/混合检索/真相编译/单卡写库）
│   └── extensions/index.cjs     # 可插拔扩展发现器（默认不含高风险抓取/加密扩展）
├── quant_engine/                # 原创 Python + DuckDB 量化回测与选股子项目
├── templates/                   # 新手示例三库与离线演示数据包
├── scripts/build-edition.cjs    # 跨平台前端构建脚本
├── public/mascots/              # 原创助手形象素材
├── LICENSE                      # Apache-2.0 开源协议
├── THIRD-PARTY-NOTICES.txt      # 第三方开源组件许可声明
├── CONTRIBUTING.md              # 贡献与合规规范
└── SECURITY.md                  # 本地安全架构与漏洞披露政策
```

---

## 运行测试

```bash
# 开源版端到端冷启动与 KB v2 迁移/检索烟测
npm test

# KB v2 核心内核单元测试（无损迁移、FTS5 检索、单卡 Diff/回滚、活视图与逆向编译）
npm run test:kb

# TypeScript 静态类型检查
npm run typecheck

# 服务端安全、备份与审计单元测试
node server/security-cors.test.cjs
node server/backup-quicknotes.test.cjs
node server/audit-trail.test.cjs

# Python 量化内核测试（如已配置 venv）
pytest quant_engine/tests -v
```

---

## 开源许可与合规边界

- 本项目源代码基于 **Apache License 2.0** 开源，详见 [LICENSE](./LICENSE) 与 [THIRD-PARTY-NOTICES.txt](./THIRD-PARTY-NOTICES.txt)。
- 本项目开源仓库严格剔除了一切个人私有笔记、商业授权私钥、第三方二创形象素材以及未授权财经社区/加密交易所抓取脚本。任何 PR 均须遵守 [CONTRIBUTING.md](./CONTRIBUTING.md) 中的合规边界。
