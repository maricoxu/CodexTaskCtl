# Codex 会话投递与确认边界

## 本轮目标与结果（2026-10-07）

目标：插件选中提醒后请求新建并发送 Codex 会话，修复 `MCP error -32001: Request timed out` 的状态处理。成功标准是无需第二次人工发送就出现新 thread 和测试响应；单凭按钮点击或 `send:true` 不算成功。

结果：**当前宿主的免确认新会话未实现**。已经确认在用户手动确认后可以创建会话和执行；插件端的回执、超时和重复点击处理已改进。定时派发和 Capture Bar 立即运行开关仍属于后续功能，本轮未启用。

## 已验证的宿主行为

本机 Codex/ChatGPT 桌面版 26.930.61225（build 13232）：

- 插件使用 `@openai/mcp-extensions` 的 `message.send`，传递 `target: "new", send: true`，从一开始就不是 `send:false` 草稿请求。
- 对已安装应用包的只读检查发现：`ui/message` 把插件内容带上 `untrustedAppMessage`，新 thread 的 app-server 路径对外部输入返回 `App input requires confirmation before legacy delivery`，随后宿主进入 `requestConfirmation` 分支。
- 用户确认后宿主再进行会话提交。这是宿主确认边界；插件不得伪造已审核标记、注入点击确认，或修改 Codex 应用包来跳过它。
- `ui/message` 回执只证明宿主接受消息，不代表模型完成或提醒事项完成。请求超时也不证明消息未投递。

用户提供的截图和 thread 回读相符：`Help me work on these reminders`（`01a11480-5336-77c2-b546-0233cbca2590`）已输出测试串、`17 × 19 = 323` 和提醒标题。用户明确报告曾手动确认发送，因此这证明手动链路，不能标作无人干预成功。

## 插件端修复

`ui/src/conversation-delivery.ts` 管理准备、等待、宿主接受、拒绝和结果未知五个状态。`bridge.ts` 保留 SDK promise 与结果，检查 `isError`，并给宿主审核设置有界的 10 分钟等待。

`main.tsx` 独立显示投递状态，避免让整个提醒事项工作区一直处于 `Working…`。待回执时禁用发送按钮；超时或断连保留未知状态，用户检查 Codex 后才能再次发送。浏览器 sessionStorage 仅存不含正文的未确认标记，防止同一页面重载后直接重发；它不是跨标签页、跨设备或后台任务的完整幂等系统。

不能把 `void message.send(...).catch(console.error)` 当作修复：这种方式会隐藏失败并提前关闭对话框。本轮曾试做该方案，已用保留回执的状态控制器替换。

## 验证与限制

- `npm --prefix ui run check`、`npm --prefix ui run test`、`npm --prefix ui run build`。
- 新增测试：晚到回执、重复点击、`isError` 拒绝、上下文准备失败、超时、断连、刷新恢复、不自动重发。
- 本地发布包通过 manifest 校验并安装。现有插件页面可保留旧 JavaScript；须关闭旧页重新打开后验证新提示。安装成功不等于已打开的旧页已热更新。
- 自动运行仍未验收；不会把增加等待时间或消除原始报错当作自动运行已实现。

## 后续入口

如继续做无人值守调度，首先核实宿主正式支持的预授权任务接口与当前版本的可用性。之后才能接入收集箱筛选、稳定任务 ID、执行权、去重和结果回写。不要把 MCP UI 的确认过程移到控制台隐藏，也不要恢复已退役的 Taskboard/CDP 注入链路。
