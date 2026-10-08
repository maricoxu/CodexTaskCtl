# CodexTaskCtl Capture Bar

独立于 Codex workspace 的 Mac 快速收集入口。默认按 `Cmd+Shift+Space` 唤出窗口，输入文字或把截图直接粘贴到大输入框，再点击“添加提醒”写入 Apple Reminders。

窗口内快捷键：`⌘1` 立即清空标题、正文和图片，`⌘2` 保存并立即交给 Codex，`Return` 添加提醒，`Shift-Return` 换行，`Esc` 收起并保留草稿。清空草稿不会关闭窗口、重置当前收集框或改变所选清单；若上次写入结果不确定，清空后仍保留防重复保护。标题输入框按 `Tab` 可切到正文输入框，`Shift-Tab` 可返回标题。输入区分为标题和正文：上方标题保存为提醒标题，下方正文保存为提醒 notes；标题必填，正文可以为空；图片粘贴到正文区后保存为提醒附件。点击“保存并立即交给 Codex”后，窗口会保持可见直到 RemCTL 确认提醒已创建；保存失败时直接显示错误并保留草稿，保存成功后才收起窗口，并把 numeric ID 写入立即请求队列；常驻 Dispatcher 再创建 Codex thread/turn。立即触发不依赖 `dispatcherWorkspace` 设置。

快捷键可以在菜单栏的 Capture Bar 图标中打开“设置全局快捷键…”进行修改。设置保存在当前用户的 macOS 应用偏好中，Capture Bar 重启后仍会保留；至少需要包含一个修饰键（⌘、⌃、⌥ 或 ⇧）。如果快捷键被其他应用占用，Capture Bar 会保留旧快捷键并提示从菜单栏重新设置。

输入区支持多行文字。对截图、PNG、JPEG、HEIC 或图片文件执行 `⌘V` 时，Capture Bar 会识别图片并追加到草稿中；连续按多次 `⌘V` 可以暂存多张图片，并显示缩略图。每张缩略图右上角的“×”可以单独删除该图片。当前最多 8 张、总大小 32 MiB；点击“清空草稿”会同时清除文字和全部图片。

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

Capture Bar 是独立的菜单栏程序，由 LaunchAgent 在登录后自动运行。它不需要打开 Codex，也不直接访问提醒事项数据库；保存操作仍通过已安装的 `~/bin/remctl` 完成。
˜˜
