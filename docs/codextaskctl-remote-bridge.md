# CodexTaskCtl Remote Bridge

这部分实现了手机 ChatGPT 连接 Mac RemCTL 所需的第一版协议骨架：

```text
手机 ChatGPT --OAuth/MCP--> Relay --任务队列--> Mac Agent --remctl--> Apple Reminders
```

当前代码是本地可测试版本，Relay 默认只绑定 `127.0.0.1`，没有自动发布公网，也没有改动现有 Tailscale 配置。

## 首次授权

1. ChatGPT 通过动态客户端注册拿到 `client_id`。
2. ChatGPT 打开 `/oauth/authorize`。
3. 用户第一次输入本机配对码并点击允许。
4. Relay 返回一次性 authorization code。
5. ChatGPT 用 PKCE verifier 换取 access token 和 refresh token。
6. 后续调用自动使用 access token，过期时使用 refresh token 刷新。

配对码只用于首次连接或重新授权；它不应写进聊天消息、URL 或提交到代码仓库。

## 本地回放

```bash
node remote/codextaskctl-relay.mjs
CODEX_TASKCTL_RELAY_URL=http://127.0.0.1:8787 \
CODEX_TASKCTL_AGENT_TOKEN=... \
node remote/codextaskctl-agent.mjs
```

Agent 只在 Mac 上执行 RemCTL；Relay 不读写提醒数据库。生产部署必须提供 HTTPS、持久化队列、密钥保护、速率限制、审计日志和撤销机制。当前 `RelayStore` 是内存实现，只用于协议回放与测试。

## 工具边界

远程入口只公开四个工具：

- `get_task_context`
- `preview_task_plan`
- `apply_task_plan`
- `capture_reminder`

`apply_task_plan` 必须带 preview 返回的短期 confirmation token 和 `confirmed=true`。计划使用幂等键，重复请求不会重复创建提醒。删除、完成和完整 RemCTL 管理能力没有暴露给手机端入口。

## 当前限制

- 还没有部署到 Vercel、Cloudflare 或 Tailscale Funnel。
- 还没有把 OAuth 页面接入真实 ChatGPT 账号。
- 内存队列和授权状态在进程重启后消失。
- Mac Agent 当前是前台/手动启动脚本，尚未安装成新的 LaunchAgent。

因此这版完成的是“可验证协议和本地执行链路”，不是公网生产服务。
