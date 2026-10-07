# CodexTaskCtl 本地发布包

这是 macOS 本地构建，包含已编译的 Capture Bar、构建后的 Codex 插件页面、MCP 客户端和安装器。Apple Reminders 仍由现有 RemCTL Capability Host 访问；不覆盖或重新签名该 Host。

解压后运行 Install.command。已有 RemCTL 必须已授权，Codex CLI 必须在 PATH。安装器先验证 manifest.json 的文件 SHA-256，再复制到 ~/.local/share/CodexTaskCtl/releases；Codex 加载 current 指向的版本。旧 Capture.app 保留在 backups 下。本地构建采用 ad-hoc 签名，未公证，不作为公开发行安装器。

使用：
- 在任意 App 按 ⌘⇧Space，输入内容或 ⌘V 粘贴截图，再回车保存。
- 默认优先使用 RemCTL 的 defaultList；未配置则留空，由提醒事项选择默认列表。可在浮窗覆盖。
- Esc 保留草稿并返回原 App；点击其他窗口也可收起；保存结束不抢回已切走的窗口。
- 截图 PNG 不超过 8 MiB。保存未确认会保留并锁定草稿，先检查提醒事项再清空，避免重复新增。
- 图片以 Apple Reminders 附件保存。在插件中选中提醒后 Attach/Ask ChatGPT 将读取实际图片块。
- Raycast、Alfred、Keyboard Maestro、Shortery 和快捷指令可直接执行：
  open "$HOME/Applications/CodexTaskCtl Capture.app"
  它们只负责唤起浮窗，无需打开 Codex。

Codex 当前已打开的旧插件页可能保留旧进程。关闭旧页并重新打开；必要时重新启用插件，不要重置 Reminders 权限。

代码里的 RemCTL EventService 只观察快照变化并投递事件，不判断开工、不创建 Codex 会话。本包未启用自动派发或周期监控。
