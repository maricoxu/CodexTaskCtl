# CodexTaskCtl 提醒任务与 Codex 会话绑定设计

## 目标

建立一条可以恢复、校验和审计的映射链：

```text
提醒任务 -> 稳定任务 UID -> Dispatcher attempt -> Codex thread -> Codex turn
```

Dispatcher 根据这条链读取 Codex 执行状态，并自动更新提醒事项的粗粒度进展，用户不需要手动点击“更新进展”。

## 第一性原理

Apple Reminders 的数字 ID 不是稳定主键。提醒在“收集箱”与“执行中”之间移动时，RemCTL 可能返回新的数字 ID；因此不能用 `reminderId -> threadId` 作为唯一绑定。

Codex 的 `threadId` 是会话/上下文主键，`turnId` 只代表某一次执行。一个提醒任务可以在同一个 thread 中产生多个 turn，所以不能把 `turnId` 当作 session ID。

Dispatcher 的真实主键应当是本机生成的 `taskUid`。提醒的 CloudKit/object identity 用来找回任务，数字 ID 只作为当前操作句柄。

## ID 分层

| ID | 含义 | 稳定性 | 用途 |
|---|---|---:|---|
| `taskUid` | CodexTaskCtl 内部任务 UID，UUID | 最高 | 状态机、审计、跨提醒 ID 迁移 |
| `reminderIdentity` | 优先使用 CloudKit ID/object UUID/deep link | 高 | 找回同一提醒 |
| `reminderId` | Reminders 当前数字 ID | 中/低 | 调用 RemCTL；移动后可能变化 |
| `attemptId` | 一次 Dispatcher 认领尝试 | 高 | 幂等、失败恢复、人工重试 |
| `threadId` | Codex 会话 ID | 高 | 绑定会话、读取历史、继续执行 |
| `turnId` | 当前或最近一次 turn ID | 低于 thread | 读取执行状态、去重完成事件 |

对外称“session ID”时统一使用 `threadId`；内部日志同时记录 `attemptId` 和 `turnId`，避免把一次执行误认为整个会话。

## 建议的状态投影

在现有 `dispatcher-state.json` 上升级为 `version: 4`。生产上可以继续使用 JSON；当需要多进程、多设备或更长事件历史时迁移 SQLite。当前单机 Dispatcher 先保持一个写入者和原子替换文件。

```json
{
  "version": 4,
  "meta": {
    "schema": "task-thread-binding-v1",
    "lastScanAt": "2026-10-07T11:30:00Z",
    "dispatcherInstanceId": "..."
  },
  "tasks": {
    "taskUid": {
      "taskUid": "...",
      "reminder": {
        "identity": "cloudkit-or-object-identity",
        "currentId": 764,
        "knownIds": [764, 765],
        "sourceListId": 2,
        "currentListId": 33
      },
      "input": {
        "title": "Codex Dispatcher 基建验收",
        "revision": "sha256:...",
        "attachmentRefs": ["..."]
      },
      "binding": {
        "threadId": "01a...",
        "workspace": "/absolute/workspace",
        "projectId": "...",
        "host": "local"
      },
      "currentAttemptId": "...",
      "currentTurnId": "01a...",
      "lifecycle": "running",
      "progress": {
        "state": "RUNNING",
        "percent": null,
        "summary": "已完成资料读取，正在整理结果",
        "next": "等待 Codex 返回最终结果",
        "updatedAt": "2026-10-07T11:30:00Z"
      },
      "attempts": [
        {
          "attemptId": "...",
          "trigger": "poll|immediate|manual-retry",
          "threadId": "01a...",
          "turnId": "01a...",
          "inputRevision": "sha256:...",
          "startedAt": "...",
          "finishedAt": null,
          "outcome": "running"
        }
      ],
      "lastObservedAt": "..."
    }
  }
}
```

任务正文不应被反复写入“进度文本”。提醒正文是用户输入，机器进度放在 sidecar 状态里；这样不会改变任务指纹，也不会因为每次进度回写而触发重复执行。

## 状态机

```text
captured
  -> queued
  -> dispatching
  -> thread_bound
  -> running
  -> review
  -> completed

任意运行态 -> unknown（超时、进程崩溃、状态无法确认）
unknown -> manual-reconcile 或 manual-retry
```

提醒清单只承载用户可见的粗状态：

| Dispatcher 状态 | Reminders 表现 | 自动动作 |
|---|---|---|
| `queued` | 收集箱 | 等待关键词扫描或立即触发 |
| `dispatching` | 收集箱/短暂准备 | 先写 claim，再创建 thread |
| `running` | 执行中 | 保留提醒未完成，sidecar 更新进展 |
| `review` | 待验收 | 等用户确认或在同一 thread 中继续 |
| `completed` | 当前列表中标记完成 | 回读 `completed=true` 后才落状态 |
| `unknown` | 执行中，保留现场 | 不自动重发，等待核查 |

不要把 `unknown` 直接当成 `failed`。它可能是 Codex 已执行但回执丢失，自动重发会造成重复执行。

## 绑定时序

1. 读取提醒并生成 `reminderIdentity`、`inputRevision` 和 `taskUid`。
2. 在状态文件中写入 `dispatching` claim，包括 `attemptId` 和输入指纹。
3. 调用 `thread/start`。
4. `thread/start` 返回后立即持久化 `threadId`。即使后面的 `turn/start` 超时，也不能重新创建另一个 thread。
5. 调用 `turn/start`，返回后持久化 `turnId` 和 `turnDeadlineAt`。
6. 轮询 `turn/completed` 或 `thread/read`，更新 `lastObservedAt`、`progress` 和 `responseSummary`。
7. 只有 Codex 返回 `CODEX_TASKCTL_STATE: DONE` 且 Reminders 回读确认 `completed=true`，才把任务设为 `completed`。
8. `REVIEW` 移到待验收；后续继续执行时优先复用原 `threadId`，只创建新 turn。

## 进展如何自动更新

Codex 当前没有可靠的通用百分比进度，因此先采用“状态 + 最后摘要 + 下一步”三元组：

```text
state: RUNNING | REVIEW | DONE
summary: 最近一次可见的 Agent 摘要
next: 下一步或等待条件
```

Prompt 约定继续使用末尾机器标记：

```text
CODEX_TASKCTL_STATE: RUNNING|REVIEW|DONE
CODEX_TASKCTL_PROGRESS: 0-100   # 可选
CODEX_TASKCTL_NEXT: ...         # 可选
```

解析优先级：明确机器标记 > turn 生命周期 > 安全兜底。没有明确标记的已完成 turn 进入 `review`，不直接完成提醒。

## Codex 会话可观测状态

Codex App Server 不是只返回一个“成功/失败”字段，而是提供多层状态和事件。官方接口说明见 [Codex App Server API overview](https://learn.chatgpt.com/docs/app-server)。Dispatcher 应保留原始观测值，同时把它们归一化成用户不需要理解的任务状态。

### 1. 连接与投递层

这些状态回答“Dispatcher 是否还掌握这个会话”：

```text
transport_starting
transport_ready
transport_disconnected
transport_error
observation_unknown
```

连接断开不等于 Codex turn 已失败；它只能把任务暂时标为 `unknown` 或 `observation_lost`，等待下一次 `thread/read` 核查。

### 2. Thread 会话层

通过 `thread/read`、`thread/list` 和 `thread/status/changed` 可以观察 thread 的运行状态。当前本机实现至少会遇到：

```text
idle
running
unknown
```

协议允许未来增加状态，所以 sidecar 应保存原始 `threadRuntimeStatus`，不要把未知字符串直接当失败。

thread 还有独立的持久化生命周期：

```text
active
archiving
archived
unarchiving
deleted
```

其中 `archived` 不是 turn 完成的同义词。它表示会话日志已经进入归档目录。

### 3. Turn 执行层

通过 `turn/started`、`turn/completed`、`thread/read` 或 turn 列表可以观察单轮执行：

```text
inProgress
completed
failed
interrupted
cancelled / canceled
unknown
```

一个 thread 可以有多个 turn，因此 `currentTurnId` 只表示当前轮次；历史 turn 要追加到 `turns[]`，不能覆盖。

### 4. Item 与等待层

Turn 内还可以获得更细的事件：

- `item/started`、`item/completed` 和 item delta：模型消息、命令、文件修改、工具调用、MCP 调用等。
- 命令执行审批、文件变更审批、权限请求。
- `tool/requestUserInput`、MCP elicitation：等待用户或外部服务提供输入。
- 错误事件、警告事件、review mode 进入/退出事件。

这些信号可以映射为更丰富的内部进展：

```text
planning
searching
reading
editing
testing
waiting_approval
waiting_user_input
reviewing
finalizing
blocked
```

这些不是 Codex 固定的公共任务枚举，而是 CodexTaskCtl 根据 item 类型、工具名和最近摘要生成的内部投影。没有可靠证据时回退到 `running`，不猜测具体阶段。

## “归档才算完成”的完成握手

按你的要求，提醒事项的最终完成条件采用四步握手：

```text
turn completed
  + CODEX_TASKCTL_STATE: DONE
  + thread/archive 成功
  + thread/list(archived=true) 回读确认
  -> Reminders completed=true
```

具体规则：

1. Turn 仅完成：任务仍是 `running` 或 `review`，不能直接完成提醒。
2. Turn 返回 `REVIEW`：任务进入“待验收”，thread 保持 active，允许后续新 turn。
3. Turn 返回 `DONE`：Dispatcher 调用 `thread/archive`，保存 `archiveRequestedAt`。
4. 收到 `thread/archived` 或通过 `thread/list` 确认 archived 后，保存 `archivedAt` 和 `archiveVerified=true`。
5. 只有归档确认后，才调用 RemCTL 完成提醒，并回读 `completed=true`。
6. 如果归档成功但 Reminders 写回失败，任务进入 `completion_writeback_pending`；下一轮只补写完成状态，不重新创建 thread 或 turn。
7. 如果 turn 已标记 DONE 但归档失败，任务保持 `finalizing`，最多重试归档/核查，不重发任务内容。
8. 如果用户手动归档 thread，下一轮 reconciler 发现归档已确认且最近一次 turn 有 DONE 标记，也可以补完成提醒；没有 DONE 标记则进入 `review`，避免误完成。

这会把“Codex 做完了”和“Codex 会话已经正式归档”明确区分开，但对用户只展示一个简单结果：完成、待验收、执行中或需要核查。

### Reminders 的最终投影

| Codex 观测 | sidecar 内部状态 | Reminders 投影 |
|---|---|---|
| thread/turn 启动 | `running` | 执行中 |
| item 正在执行 | `running` + `phase` | 执行中 |
| 等待审批/用户输入 | `waiting_user` | 待验收或执行中并显示等待 |
| turn completed + REVIEW | `review` | 待验收 |
| turn completed + DONE，未归档 | `finalizing` | 待验收/执行中 |
| archived 已核验 + Reminders 写回成功 | `completed` | 已完成 |
| 连接断开、回执不确定 | `unknown` | 保留现场，不自动重发 |

这样，sidecar 可以保存几十种细粒度状态，Reminders 只显示少数稳定状态；人不需要理解内部映射，但 Dispatcher 可以据此自动推进和恢复。

## 外部修改与版本

- Dispatcher 发送的是某个 `inputRevision` 的快照。
- 运行期间用户修改提醒正文，不修改当前 thread 的输入；sidecar 标记 `revisionDrift=true`。
- 当前 turn 完成后，用户可以选择“用新版本继续”，这会在同一 thread 创建新 turn，并生成新的 `attemptId`。
- 用户手动完成提醒时，Dispatcher 发现 `completed=true` 后停止回写，不重新打开提醒。
- thread 失效时保留旧 binding，并把新 thread 记录为新的 binding generation；除非人工重试，不自动创建第二个执行会话。

## 查询和 UI

建议新增三个只读/受控入口：

1. `get_codex_task_status(taskUid|reminderId)`：返回当前状态、threadId、turnId、最近摘要和最后观测时间。
2. `list_codex_task_bindings(status?)`：查看 running/review/unknown 任务。
3. `retry_codex_task(taskUid, mode)`：明确选择 `same-thread` 或 `new-thread`，默认要求先核查 unknown。

Reminders UI 只显示摘要和状态徽标，并提供“打开 Codex 会话”链接。完整事件和输入指纹留在本机 sidecar，不污染提醒正文。

## 最小落地顺序

### 第一步：稳定绑定

- 把当前 `originalReminderId/reminderIds/threadId/turnId/attemptId` 统一为 `taskUid + reminder identity + binding + attempts`。
- `reminderIdentity` 优先级改为 CloudKit ID/object UUID/deep link，数字 ID 只作兜底。
- 迁移现有 version 3 状态文件，不丢失 757、762、764 等历史记录。

### 第二步：自动进展

- 增加 `progress`、`lastObservedAt`、`responseSummary`、`inputRevision`。
- 轮询 thread/turn 后更新 sidecar；列表只在 queued/running/review/completed 边界变化时移动。
- 增加状态查询入口和 UI 展示。

### 第三步：归档完成握手

- 在 DONE 分支加入 `thread/archive`。
- 等 `thread/archived` 或 `thread/list(archived=true)` 回读确认。
- 增加 `finalizing` 和 `completion_writeback_pending` 状态。
- 只有归档核验后才完成 Reminders。

### 第四步：人工恢复

- unknown 任务显示“先核查，再重试”。
- same-thread 继续使用新 turn；new-thread 创建新的 binding generation。
- 所有重试写入 attempts，不覆盖原 thread/turn 记录。

## 关键风险

1. **数字 ID 变化**：必须保留稳定 identity 和 ID 历史。
2. **回执丢失**：unknown 不得自动重发。
3. **状态文件损坏**：原子写入、0600 权限和备份/校验。
4. **多个 Dispatcher 并发**：单一默认 state lock，立即触发和定时轮询共用同一锁。
5. **进度污染用户正文**：机器状态只写 sidecar/UI，不追加到 notes。
6. **thread 复用错误**：同一任务复用 thread，不同任务绝不共享 thread；旧 thread 失效时保留历史。
7. **隐私**：sidecar 只保存必要摘要和 ID，完整提醒正文不做长期重复复制；文件限制为当前用户可读。

## 设计结论

当前最合适的绑定不是：

```text
reminderId -> sessionId
```

而是：

```text
taskUid
  -> reminderIdentity + reminderId history
  -> inputRevision
  -> attemptId
  -> threadId
  -> turnId history
  -> progress projection
  -> reminder lifecycle
```

这套结构可以让定时任务根据 Codex 会话继续执行和更新提醒进展，同时把“重复执行”和“回执不确定”隔离开。

## 修订后的职责边界：Reminders 只负责收集，完成表示已交付

前面的“收集箱 → 执行中 → 待验收 → 已完成”是过度耦合的设计。Reminders 不需要镜像 Codex 的执行状态；它只负责收集、粗分类、保留未来素材，以及记录是否已经成功交给 Codex。

### Reminders 的三种实际语义

| Reminders 状态 | 含义 | 是否勾选完成 |
|---|---|---:|
| 收集箱 / 分类收集列表 | 还没有决定交给 Codex，未来继续整理 | 否 |
| 延后交给 Codex | 已整理为待投递记录，等待定时 Dispatcher | 否 |
| 已交给 Codex | Dispatcher 已确认创建 thread 并接受首个 turn | 是 |

这里的“已完成”只表示**交付动作完成**。它不表示 Codex 已经完成实际工作。Codex 的运行、复核、继续执行和最终归档由 Codex thread 自己管理。

### 三条流转路径

```text
收集箱
  ├─ 只保留 / 未来再处理：继续留在收集箱或分类收集列表，保持未完成
  ├─ 延后交给 Codex：移动到“延后交给 Codex”，保持未完成
  └─ 立即交给 Codex：创建 thread + 首个 turn 被接受后，勾选提醒完成

延后交给 Codex
  └─ 定时 Dispatcher 成功交付后，勾选提醒完成
```

如果 thread 已创建但 `turn/start` 结果不确定，不能勾选完成；如果 thread 和首个 turn 都已确认接受，即使 Codex 后续运行失败，Reminders 仍可以保持已完成，因为交付本身已经发生。后续失败、复核和继续执行只写入 Codex 会话记录或 delivery ledger。

### Dispatcher 只保留薄投递账本

即使 Reminders 不再同步运行状态，Dispatcher 仍需保留：

```text
taskUid
reminderIdentity
reminderId history
input fingerprint
trigger: immediate | deferred
dispatchedAt
threadId
turnId
deliveryState: queued | dispatching | delivered | unknown
```

这个账本只用于防止 5 分钟轮询重复投递、保存来源关系和从 Reminders 跳到 Codex。它不负责把 `running/review/completed` 回写到 Reminders。

只收集的原始条目可以没有 `taskUid`。当条目被明确放入“延后交给 Codex”或触发立即投递时，再生成 `taskUid`；直接在 Codex 中发起的普通问答也不需要创建 Reminders task。

### Codex 复盘替代双向状态映射

每日复盘由 Codex 读取指定时间范围的 thread、turn 和结果，结合 Reminders 中仍未完成的收集条目，输出：

- 今天已经完成和交付了什么；
- 哪些 Codex 会话没有闭环；
- 哪些收集条目值得进入“延后交给 Codex”；
- 哪些工作应该沉淀成笔记、Skill 或 SOP；
- 下一阶段应该展开哪些任务。

因此，映射关系的价值变成投递去重、来源追踪和复盘筛选，而不是让 Reminders 复制 Codex 的完整生命周期。
