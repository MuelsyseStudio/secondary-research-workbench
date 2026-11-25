# 安全政策 / Security Policy

## 本地优先安全模型

- **仅监听本机回环**：HTTP 服务默认仅绑定 `127.0.0.1`，不向公网暴露端口。
- **严格 Origin 与 CSRF 防护**：所有本地 API 校验本机 Origin 白名单，写操作要求自定义客户端头（外部 Webhook 推送需独立 Bearer Token）。
- **凭证本地加密**：用户配置的 AI API Key、自定义数据源 Token 与 Webhook 地址由 `server/secret-vault.cjs` 使用 **AES-256-GCM** 加密存储，密钥隔离保存于用户本机系统配置目录（`0600` 权限）。
- **写库保护**：三库修改均经 Diff 确认门 + 哈希乐观锁（防并发覆写）+ 自动备份快照。

## 报告安全漏洞

如发现本地路径穿越、命令注入、XSS 或凭证泄露等安全问题，请勿在公开 Issue 中直接披露利用细节；请通过 GitHub Security Advisories 私密提交复现步骤，我们将在核实后尽快修复并致谢。
