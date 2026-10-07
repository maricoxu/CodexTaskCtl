# CodexTaskCtl Capture Bar

独立于 Codex workspace 的 Mac 快速收集入口。按 `Cmd+Shift+Space` 唤出窗口，输入文字或把截图直接粘贴到窗口，再回车写入 Apple Reminders。

它调用已安装的 `~/bin/remctl`，由 RemCTL Capability Host 持有权限，不直接读写 Reminders 数据库。

安装：`./capture-bar/install.sh`
