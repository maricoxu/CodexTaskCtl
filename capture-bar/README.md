# CodexTaskCtl Capture Bar

独立于 Codex workspace 的 Mac 快速收集入口。按 `Cmd+Shift+Space` 唤出窗口，输入文字或把截图直接粘贴到窗口，再回车写入 Apple Reminders。

它调用已安装的 `~/bin/remctl`，由 RemCTL Capability Host 持有权限，不直接读写 Reminders 数据库。

安装：

```sh
./capture-bar/install.sh
```

如果你希望由 Raycast、Alfred、Keyboard Maestro 或 Shortery 负责触发，可以把它们的动作指向：

```sh
./capture-bar/open.sh
```

这些工具只负责唤起窗口；文字、图片、草稿恢复和写入幂等仍由 Capture Bar 统一处理。
