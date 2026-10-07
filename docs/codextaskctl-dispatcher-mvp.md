# CodexTaskCtl Trusted Dispatcher MVP

当前 Dispatcher 扫描“延后交给 Codex”列表里的未完成提醒，直接通过本机 Codex App Server 创建 thread 和首轮 turn；普通收集箱不会被定时扫描，也不要求标题包含 `Codex`。提醒在首个 turn 被 Codex 接受后立即标记完成。

## 运行

```bash
node /Users/xuyehua/Code/CodexTaskCtl/scripts/codextaskctl-dispatcher.mjs \
  --once \
  --list-id 34 \
  --workspace '/Users/xuyehua/Library/Mobile Documents/iCloud~md~obsidian/Documents/yehua的笔记'
```

持续轮询可以去掉 `--once`，用 `--interval-ms 600000` 控制间隔。立即触发可以传 `--reminder-id ID`；这条路径绕过延后列表扫描，但仍然使用同一个幂等状态文件。要安装每 10 分钟的本机 LaunchAgent，可运行 `python3 scripts/install_dispatcher_launchagent.py --workspace '/absolute/workspace' --list-id 34 --interval-seconds 600`。LaunchAgent 使用一个常驻 Dispatcher 进程内部轮询。

默认使用 `approvalPolicy=never` 和 `sandbox=read-only`。投递账本写入 `~/.config/remctl/desktop/dispatcher-state.json`，锁文件用于防止两个 Dispatcher 同时发送。Reminders 只承载收集和延后队列；Codex thread/turn 的运行、复核和失败状态不再回写成 Reminders 列表状态。首个 turn 接受后写入 `completed=true`；图片作为本机图片输入传给 Codex。

可以用 `--status --state ~/.config/remctl/desktop/dispatcher-state.json` 查看最近扫描时间、最近结果和各状态数量；这个命令只读状态文件，不启动 Codex。每次 `turn/start` 有明确的 60 秒响应超时；Codex 返回完成后，Dispatcher 还会回读提醒确认 `completed=true`，确认失败会保留为异常状态。

## 状态与幂等

分发以提醒身份去重：保存原始/当前数字 ID、移动产生的 ID 别名和 deepLink。标题、正文、日期或所属清单变化都不会解除已经保存的分发占用记录。内容指纹仅供追踪，不再决定是否重发。

顺序为：读取延后列表 → 保存分发占用记录 → 创建 thread 并立即保存 ID → 提交 turn 并保存 ID → 确认交付后勾选提醒。不会移动 Reminders 列表，也不会用 Codex 的运行状态改变提醒状态；进程重启、提交超时、`unknown` 和旧重试开关都不会重新创建会话。

这提供保守的至多一次自动分发：如果进程在收到创建会话回执前崩溃，任务会保留为未知，需要核查；不会以自动再发来掩盖不确定性。不要删除状态文件来解决异常。生产入口统一使用默认状态文件；自定义状态文件仅供隔离实验，不是生产去重库。

“延后交给 Codex”绑定现有清单 ID。当前 Mac 使用列表 ID 34；列表不存在时停止扫描，不自动把收集箱内容当成待投递任务。

`--dry-run` 只读，不启动会话、不完成提醒、不改状态。`--once` 只扫描一次延后列表，但会保持连接直到本次提交的 turn 结束，避免一提交就中断任务。

发送给 Codex 的用户消息只包含提醒标题和正文的组合，附件作为独立的本地图片输入。执行状态协议放在 `thread/start.developerInstructions`，不会混入用户任务正文。

当前 App Server 的 `ThreadStartParams` 没有 `projectId` 字段，后台 stdio Dispatcher 不能直接把新会话挂到 Codex 侧栏项目。项目分类保存在状态记录中，并通过项目映射的 `cwd` 和该目录下的 Codex 配置表达；没有配置专用目录时回退到统一工作区。

桌面原生 `create_thread` 工具支持 `target.projectId`，但当前后台 Dispatcher 没有接入该桌面入口。2026-10-07 核验的“提效基建”“微信公众号”“yehua的笔记”共用同一路径，所以目录映射不能代替侧栏项目归属。可选目录配置为 `CODEX_TASKCTL_TECHNICAL_CWD` / `CODEX_TASKCTL_WRITING_CWD` / `CODEX_TASKCTL_FALLBACK_CWD`；未设置时使用 `--workspace`，不自动创建目录。

## 触发契约与测试矩阵

| 场景 | 周期扫描 | 立即送往 Codex | 预期结果 |
|---|---:|---:|---|
| 普通收集箱提醒 | 否 | 未点击 | 完全忽略，不创建 thread/turn |
| 延后列表中的未完成提醒 | 是 | 未点击 | 创建一次 thread/turn，成功交付后勾选提醒 |
| 不含 Codex，点击立即送往 Codex | 否 | 是 | 写入幂等请求队列，常驻 Dispatcher 立即消费并创建一次 thread/turn |
| 含 Codex，同时点击立即送往 Codex | 是 | 是 | 立即请求优先，只消费一次；周期扫描不会再次创建会话 |
| 重复点击立即按钮 | 任意 | 多次 | 同一提醒只保留一个请求和一个会话绑定 |
| Reminders 完成写回失败 | 任意 | 任意 | 保留 delivered 账本，只重试勾选，不重建会话 |
| turn/start 或进程重启后状态未知 | 任意 | 任意 | 保留已有 thread/turn，不自动重发 |

2026-10-07 实测：普通任务 767 未被周期扫描；微信公众号 Codex 任务 768 返回 `TEST_WECHAT_DISPATCH_OK` 并完成；无 Codex 的立即任务 771 返回 `TEST_IMMEDIATE_PLAIN_OK` 并完成；含 Codex 的立即任务 770 返回 `TEST_IMMEDIATE_CODEX_OK` 并完成；769 的首次立即测试在旧进程重载时被中断并保留为 `unknown`，随后用 771 验证了修复后的成功路径。测试提醒已删除。

立即触发通过 `~/.config/remctl/desktop/dispatcher-state.json.requests` 请求目录与 `SIGUSR1` 唤醒常驻 Dispatcher；请求文件按 reminder ID 去重，常驻进程消费后删除。这样 Capture Bar 启动的临时进程遇到全局锁时不会把“启动成功”误报成“已执行”，而是明确返回已排队。

## 这版为什么先这样收敛

旧 Taskboard 的执行核心是有效的：`thread/start → turn/start → delivery ledger → Reminders completed=true`。当前实现只保留本机 App Server stdio、单进程锁、延后列表准入、read-only sandbox 和幂等状态；Codex 的运行状态不再同步到 Reminders。
