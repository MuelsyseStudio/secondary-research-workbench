# 贡献指南 / Contributing

感谢关注 **Secondary Research Workbench**！欢迎通过 Issue 与 Pull Request 共同完善本地投研知识工程与量化研究工具链。

## 提交 PR 前的红线要求

1. **严禁引入未授权爬虫或外挂**：不接受针对财经社区/付费星球/公众号的反爬破解脚本，也不接受模拟点击第三方交易客户端的下订单外挂。数据源扩展请统一遵循 `server/data-source-router.cjs` 与 `quant_engine/quant_engine/storage/importers/custom_rest.py` 标准适配器协议。
2. **依赖协议审查**：新增的 npm 或 Python 依赖仅限 **MIT / BSD / Apache-2.0 / ISC** 等商业友好开源协议，严禁搬运 CC BY-NC 或 GPL/AGPL 强传染源码。
3. **隐私零提交**：绝不提交 `*.local.json`、真实 API Key、个人持仓交割单、私钥文件或包含本机用户名的绝对路径。
4. **验证门禁**：提交前请确保以下检查全部通过：
   - `npm run typecheck`（零 TypeScript 错误）
   - `npm run build`（构建通过）
   - `npm test`（开源版端到端烟测通过）
   - 如涉及 `quant_engine/` 修改，请运行 `pytest quant_engine/tests -v`
