# CodexTaskCtl 本地发布包

这是 macOS 本地构建，包含已编译的 Capture Bar、构建后的 Codex 插件页面、MCP 客户端和安装器。Apple Reminders 仍由现有 RemCTL Capability Host 访问；不覆盖或重新签名该 Host。

解压后运行 Install.command。已有 RemCTL 必须已授权，Codex CLI 必须在 PATH。安装器先验证 manifest.json 的文件 SHA-256，再复制到 ~/.local/share/CodexTaskCtl/releases；Codex 加载 current 指向的版本。旧 Capture.app 保留在 backups 下。本地构建采用 ad-hoc 签名，未公证，不作为公开发行安装器。

使用：
- 在任意 App 按默认快捷键 ⌘⇧Space，输入内容或在大输入框中按 ⌘V 粘贴截图，再点击“添加提醒”。快捷键可从菜单栏 Capture Bar 的设置中修改。
- 默认优先使用 RemCTL 的 defaultList；未配置则留空，由提醒事项选择默认列表。
- Esc 保留草稿并返回原 App；点击其他窗口也可收起；保存结束不抢回已切走的窗口。
- 每张截图 PNG 不超过 8 MiB，最多暂存 8 张、总大小 32 MiB；连续按 ⌘V 会追加图片，保存时作为同一提醒的多个附件写入。保存未确认会保留并锁定草稿，先检查提醒事项再清空，避免重复新增。
- 输入区支持多行文字、截图和图片文件粘贴；界面预留“立马要做（预留）”按钮，当前不会触发执行。
- 图片以 Apple Reminders 附件保存。在插件中选中提醒后 Attach/Ask ChatGPT 将读取实际图片块。
- Raycast、Alfred、Keyboard Maestro、Shortery 和快捷指令可直接执行：
  open "$HOME/Applications/CodexTaskCtl Capture.app"
  它们只负责唤起浮窗，无需打开 Codex。

Codex 当前已打开的旧插件页可能保留旧进程。关闭旧页并重新打开；必要时重新启用插件，不要重置 Reminders 权限。

会话投递现在单独显示等待、已接受或结果未确认。超时、断连不会自动重发；须先检查 Codex 再决定是否重试。`send:true` 会请求自动发送，但当前 Codex 宿主仍可能要求审核外部输入，本版不承诺无人确认开工。详见源码的 `docs/codex-conversation-delivery.md`。

本地 Dispatcher 已随发布包收录，默认扫描“延后交给 Codex”列表（当前本机列表 ID 为 34），每 10 分钟轮询一次；成功接受 thread 和首个 turn 后立即勾选提醒。立即触发仍可传 `--reminder-id ID`。安装常驻服务：`python3 ~/.local/share/CodexTaskCtl/current/install_dispatcher_launchagent.py --workspace '/absolute/workspace' --list-id 34 --interval-seconds 600`。Reminders 不镜像 Codex 的执行中/待验收状态；详见 `DISPATCHER-MVP.md`。

对话式任务整理的本地协议和 OAuth Relay 回放代码位于 `remote/`，说明见 `docs/codextaskctl-remote-bridge.md`。当前只做本地协议测试，不自动发布公网或修改现有 Tailscale 配置。

代码里的 RemCTL EventService 只观察快照变化并投递事件，不判断开工、不创建 Codex 会话。本包未启用自动派发或周期监控。
