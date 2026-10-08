# CodexTaskCtl Trusted Dispatcher MVP

当前 Dispatcher 默认扫描“延后交给 Codex”中的未完成提醒；Codex 接受 thread 和首个 turn 后就勾选提醒。提醒完成表示交付成功，不表示 Codex 工作完成，也无需机器状态标记。

## 运行

```bash
node /Users/xuyehua/Code/CodexTaskCtl/scripts/codextaskctl-dispatcher.mjs \
  --once \
  --list-id 34 \
  --workspace '/Users/xuyehua/Library/Mobile Documents/iCloud~md~obsidian/Documents/yehua的笔记'
```

持续轮询可以去掉 `--once`，用 `--interval-ms 600000` 控制间隔。立即触发可以传 `--reminder-id ID`；这条路径绕过列表扫描，但仍然使用同一个幂等状态文件。要安装每 10 分钟的本机 LaunchAgent，可运行 `python3 scripts/install_dispatcher_launchagent.py --workspace '/absolute/workspace' --list-id 34 --interval-seconds 600`。LaunchAgent 使用一个常驻 Dispatcher 进程内部轮询。

每台电脑有一个本地开关 `dispatcherEnabled`，默认是 `true`，存于本机 `~/.config/remctl/desktop/settings.json`，重启和升级后保留。通过 RemCTL MCP 调用 `set_dispatcher_enabled({"enabled": false})` 暂停，调用 `set_dispatcher_enabled({"enabled": true})` 恢复。开关不依赖 API 账号。

`get_dispatcher_status({})` 返回设备名、配置值、进程是否存在和 `runtimeState`：enabled / disabled / pending / stopped。常驻进程每秒检测设置变化并唤醒扫描；已开始的操作可能先结束，查询返回 disabled 才代表进程确认暂停。pending 表示尚未确认，stopped 表示进程未运行。开启设置不会启动未安装或停止的 LaunchAgent。工具控制的是 MCP 所连接的这台 Mac，不接受远端主机参数，也不创建远程连接。

关闭时拦截周期扫描、单条立即分发、立即排队、新会话创建及完成回写。保留尚未发送的队列，重新开启后继续处理。已创建的 Codex 会话保持连接、继续执行；暂停期间不观察或回写，恢复后跟进原会话。Capture 仍保存提醒，分发被关闭时窗口明确显示保存成功和关闭原因，不要重复创建提醒。

**本机开关不是跨设备锁。** 两台电脑默认都开启，必须手动关闭不承担分发的设备。切换前确认原设备 disabled，并处理好未完成会话：绑定账本不跨设备同步，另一台电脑不能自动接管原会话，可能再次领取共享清单中尚未完成的任务。同一个 API 账号不能解决这个问题；自动跨设备接管需要共享任务归属及租约。

此次更新保留既有 LaunchAgent 配置：2026-10-08 当前 Mac 扫描“延后交给 Codex”（ID 34）、空关键词、10 分钟周期。CLI 默认也为该清单及 10 分钟；可显式指定 `--keyword Codex --list-id 2 --interval-ms 300000` 改成每 5 分钟检查收集箱关键词任务。

默认使用 `approvalPolicy=never` 和 `sandbox=read-only`。投递账本写入 `~/.config/remctl/desktop/dispatcher-state.json`，锁文件用于防止两个 Dispatcher 同时发送。Reminders 承载收集队列；Codex thread/turn 的运行、复核和失败状态保留在账本，交付确认后写入 `completed=true`；图片作为本机图片输入传给 Codex。

可以用 `--status --state ~/.config/remctl/desktop/dispatcher-state.json` 查看最近扫描时间、最近结果和各状态数量；这个命令只读状态文件，不启动 Codex。每次 `turn/start` 有明确的 60 秒响应超时；Codex 返回完成后，Dispatcher 还会回读提醒确认 `completed=true`，确认失败会保留为异常状态。

## 状态与幂等

分发以提醒身份去重：保存原始/当前数字 ID、移动产生的 ID 别名和 deepLink。标题、正文、日期或所属清单变化都不会解除已经保存的分发占用记录。内容指纹仅供追踪，不再决定是否重发。

顺序为：保存分发占用记录 → 创建 thread 并持久化 → 提交 turn 并保存交付回执及待勾选标记 → 勾选并回读提醒。勾选失败只补写，不重复发起会话。后续失败、中断或复核不撤销 Reminders 的交付完成状态。

这提供保守的至多一次自动分发：如果进程在收到创建会话回执前崩溃，任务会保留为未知，需要核查；不会以自动再发来掩盖不确定性。不要删除状态文件来解决异常。生产入口统一使用默认状态文件；自定义状态文件仅供隔离实验，不是生产去重库。

“延后交给 Codex”绑定现有清单 ID。当前 Mac 使用列表 ID 34；列表不存在时停止扫描，不自动把收集箱内容当成待投递任务。

`--dry-run` 只读，不启动会话、不完成提醒、不改状态。`--once` 只扫描一次延后列表，但会保持连接直到本次提交的 turn 结束，避免一提交就中断任务。

发送给 Codex 的用户消息只包含提醒标题和正文的组合，附件作为独立的本地图片输入。不再要求 Codex 在回答末尾输出机器状态标记。`threadId`、`turnId` 和 turn 生命周期用于防重复、故障追踪和保持执行连接，不把 Codex 的运行状态映射回 Reminders。旧会话可能仍保留创建时注入的指令；新派发使用本协议。

当前 App Server 的 `ThreadStartParams` 没有 `projectId` 字段，后台 stdio Dispatcher 不能直接把新会话挂到 Codex 侧栏项目。项目分类保存在状态记录中，并通过项目映射的 `cwd` 和该目录下的 Codex 配置表达；没有配置专用目录时回退到统一工作区。

桌面原生 `create_thread` 工具支持 `target.projectId`，但当前后台 Dispatcher 没有接入该桌面入口。2026-10-07 核验的“提效基建”“微信公众号”“yehua的笔记”共用同一路径，所以目录映射不能代替侧栏项目归属。可选目录配置为 `CODEX_TASKCTL_TECHNICAL_CWD` / `CODEX_TASKCTL_WRITING_CWD` / `CODEX_TASKCTL_FALLBACK_CWD`；未设置时使用 `--workspace`，不自动创建目录。

## 触发契约与测试矩阵

| 场景 | 周期扫描 | 立即送往 Codex | 预期结果 |
|---|---:|---:|---|
| 普通收集箱提醒 | 否 | 未点击 | 完全忽略，不创建 thread/turn |
| 延后列表中的未完成提醒 | 是 | 未点击 | 创建一次 thread/turn，成功接受首个 turn 后勾选提醒 |
| 不含 Codex，点击立即送往 Codex | 否 | 是 | 写入幂等请求队列，常驻 Dispatcher 立即消费并创建一次 thread/turn |
| 含 Codex，同时点击立即送往 Codex | 是 | 是 | 立即请求优先，只消费一次；周期扫描不会再次创建会话 |
| 重复点击立即按钮 | 任意 | 多次 | 同一提醒只保留一个请求和一个会话绑定 |
| Reminders 完成写回失败 | 任意 | 任意 | 保留 delivered 账本，只重试勾选，不重建会话 |
| turn/start 或进程重启后状态未知 | 任意 | 任意 | 保留已有 thread/turn，不自动重发 |
| 本机关闭后点击立即按钮 | 否 | 是 | 提醒正常保存，分发返回 disabled |
| 扫描过程中关闭 | 停止后续任务 | 保留未消费队列 | 已开始的操作可结束，查询状态确认暂停 |
| 关闭后重启、重新开启 | 关闭持久化，开启后唤醒 | 恢复原队列 | 跟进原绑定，不重复投递 |
| 设置无效或无法读取 | 停止 | 停止 | 报告错误，不继续分发 |

2026-10-07 实测：普通任务 767 未被周期扫描；微信公众号 Codex 任务 768 返回 `TEST_WECHAT_DISPATCH_OK` 并完成；无 Codex 的立即任务 771 返回 `TEST_IMMEDIATE_PLAIN_OK` 并完成；含 Codex 的立即任务 770 返回 `TEST_IMMEDIATE_CODEX_OK` 并完成；769 的首次立即测试在旧进程重载时被中断并保留为 `unknown`，随后用 771 验证了修复后的成功路径。测试提醒已删除。

立即触发通过 `~/.config/remctl/desktop/dispatcher-state.json.requests` 请求目录与 `SIGUSR1` 唤醒常驻 Dispatcher；请求文件按 reminder ID 去重，常驻进程消费后删除。这样 Capture Bar 启动的临时进程遇到全局锁时不会把“启动成功”误报成“已执行”，而是明确返回已排队。

## 这版为什么先这样收敛

当前保留本机 App Server stdio、单进程锁、清单准入、read-only sandbox 和身份幂等记录；投递成功与任务完成分开。控制开关的回归覆盖默认值、持久化、MCP 参数验证、队列保留、扫描中关闭、暂停完成回写、恢复后去重和设置变化唤醒。
