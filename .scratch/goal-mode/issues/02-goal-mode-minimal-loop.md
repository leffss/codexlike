# 02: 目标模式最小闭环（tracer bullet）

**What to build:** 用户输入 `/goal <目标文本>`，任务进入目标模式并端到端走通一次：目标原文作为用户消息显示在消息流；设定即触发首轮正常回合；回合结束后 goal 编排器（desktop，idle 边界，落位先例=输入队列）发起**完成判定**（agent-core：任务当前模型、无工具、目标文本+完整消息历史）；本票场景判定**通过** → 目标转「已完成」。输入框上方出现目标进度行（目标摘要、状态、累计时长）。Stop 按钮在目标进行中 = 暂停。目标进行中输入队列不自动消费、终态后恢复。目标实体（六态状态机）与逐轮验证记录随任务落库。

**Blocked by:** 01

**Status:** done

**上下文指针:** `.scratch/goal-mode/spec.md`（Implementation Decisions 全节）、`.scratch/goal-mode/notes.md`（agent-core/desktop/ui 各节 + e2e 纪律）、ADR 0035、GLOSSARY「目标 / 目标模式 / 完成判定」

- [x] `/goal <目标>` 设定成功走本地命令反馈；原文以用户消息呈现；无效输入（空目标等）反馈失败原因不落库
- [x] 设定后目标「进行中」、任务侧 status 四值不变、占任务并发一席口径照旧；进度行显示摘要/状态/累计时长
- [x] 首轮回合结束自动发起判定；判定通过 → 「已完成」，消息流出现「第 1 次迭代 · 已完成」标记行
- [x] Stop 在目标进行中 = 暂停（转「已暂停」；恢复按钮在票 04，本票内暂停后不得自行无限续跑、目标不丢失）
- [x] 目标进行中输入队列不自动消费；终态后恢复逐条自动发出（「等待用户交互期间输入框不可用」等既有规则不变）
- [x] 目标实体与验证记录随任务落库，重启后可读（恢复为暂停态的完整语义在票 06）
- [x] agent-core 单测绿：六态状态机转换、判定请求构造与响应解析容错、fail-open 基础行为
- [x] desktop 单测绿：编排器单次流转（回合结束→判定→完成）、队列互锁守卫、`/goal` 命令解析
- [x] ui 单测绿：进度行最小呈现（状态/摘要/时长/空态）
- [x] e2e 场景「设定→一轮→判定通过→已完成」实跑绿（含队列恢复断言；agent-core 改动后重建 dist 再跑）

## Comments

（写给票 03（续跑循环）、票 04（控制面）及 05/06 的衔接说明，2026-11-25 票 02 实现轮）

### 交付物

- **agent-core**：`src/goal/types.ts`（目标实体 / 验证记录 / 判定结论类型与六态词汇）、`src/goal/state-machine.ts`（六态转换表与累计时长记账）、`src/goal/verifier.ts`（判定 prompt 构造、解析容错、模型调用、fail-open）；`TaskManager` 新增目标 API；持久层新增 `goals` / `goal_verifications` 两表；`TranscriptItem` 新增 `goal-verification` 条目；斜杠命令表新增 `/goal`。
- **desktop**：`src/tasks/goal-orchestrator.ts`（goal 编排器，idle 边界与目标控制动作的唯一衔接点）；`src/tasks/task-ipc.ts` 的 `tasks:goal-set` handler 与流收尾接线；`src/shared/ipc.ts` 的目标事件与 `TaskView.goal`。
- **ui**：`src/components/GoalProgressRow.tsx`（进度行）、`src/components/GoalVerificationMarker.tsx`（标记行）、`src/lib/goal-view.ts`（时长 / 摘要 / 标记行文案的纯函数）；`WorkspacePage` 的 `/goal` 分发与进度行挂载；`src/dev/browser-stub.ts` 补 `goalSet`。
- **e2e**：`e2e/goal-mode.mjs`（`pnpm test:e2e:goal`，已追加到 `test:e2e:all` 链尾）。
- **单测**：agent-core `tests/task/goal.test.ts`（26 条）与 `tests/task/sqlite-store.test.ts` 目标表节（5 条）；desktop `tests/tasks/goal-ipc.test.ts`（13 条）；ui `goal-view` / `goal-progress-row-ui` / `goal-marker-ui` / `workspace-goal-ui`（另在 `live-task`、`slash-command-actions` 各补 1 条）。

### goal 实体 API 面（agent-core `TaskManager`，后续各票直接复用）

- `setGoal(taskId, text): GoalRecord` —— 校验：任务存在、原文 trim 后非空、长度 ≤ `GOAL_TEXT_MAX_LENGTH`（4000）、当前无未结束目标（`isGoalOpen`：进行中 / 已暂停 / 预算受限 / 未达成）。
- `goal(taskId): GoalRecord | null` —— 当前目标 = 该任务最后一条目标记录；同一任务的历次目标各留一行。
- `transitionGoal(taskId, transition): GoalRecord` —— 落库并返回新记录，越界转换抛中文错误。转换名：`pause` / `resume` / `complete` / `unmet` / `budget-limit` / `clear`。
- `discardGoal(taskId)` —— 撤销尚未执行的目标（首轮启动失败的回滚用）；已有验证记录即拒绝。
- `verifyGoal(taskId, { profile?, signal? }): Promise<GoalVerificationResult>` —— 一次完整判定：发请求、解析、落验证记录，**不改目标状态**（状态推进归编排器）。返回 `verified`（带 `verification`）/ `aborted`（被中断，无结论无记录）/ `skipped`（目标已不在进行中，未发请求）。缺省 `profile` = 任务当前模型不可用，走 fail-open。
- `goalVerifications(taskId): GoalVerificationRecord[]` —— 当前目标的验证记录，按轮次正序。
- 纯函数与常量（浏览器安全，经 `@codexlike/agent-core` 根出口供 ui 取用）：`GOAL_STATUSES`、`GOAL_STATUS_NAMES`（六态中文称谓的单一来源）、`advanceGoal(goal, transition, at)`、`isGoalOpen(status)`。

**六态状态机**（一次落全，本票只走加粗两条）：

| 当前状态                  | 允许的转换                                                    |
| ------------------------- | ------------------------------------------------------------- |
| 进行中 `active`           | **`pause`**、**`complete`**、`unmet`、`budget-limit`、`clear` |
| 已暂停 `paused`           | `resume`、`clear`                                             |
| 预算受限 `budget-limited` | `resume`、`clear`                                             |
| 未达成 `unmet`            | `resume`、`clear`                                             |
| 已完成 `completed`        | `clear`                                                       |
| 已清除 `cleared`          | （终态）                                                      |

`GoalRecord` 字段：`id / taskId / text / status / activeMs / activeSince / createdAt / updatedAt`。**累计时长**只计进行中的区段：离开进行中时把当前段计入 `activeMs` 并清空 `activeSince`，恢复时以转换时刻另起一段；呈现侧用 `goalElapsedMs(goal, now)`（ui `lib/goal-view.ts`）求值。

**验证记录** `GoalVerificationRecord`：`id / taskId / goalId / round / passed / reason / nextAction / createdAt`；`round` = 该目标已有记录数 + 1。

### 完成判定的调用路径与契约（票 01 对接契约已满足）

- **非流式 `generateText`**（与 compact 辅助调用同口径：不附加思考档位控制参数），**不带工具**，重试次数走 `modelMaxRetries` resolver，usage 入任务用量主列（ADR 0029）。
- system prompt **首部**带 `[goal-verification]`（`GOAL_VERIFICATION_MARKER`），e2e stub 默认识别成立；e2e 实跑用的是 `code-fence` 形态的判定应答，解析容错在真实链路上验证过。
- 输入 = 目标文本 + 完整历史，序列化为一条 user 消息：消息（user / assistant / compact-summary；error 提示不进；@引用 与问答附录照模型上下文组装）+ **工具调用摘要**（工具名、参数、结果，单条结果超过 4000 字符截断）——判定靠这些证据判断，verifier 自身不执行任何工具。
- 解析容错：裸 JSON、代码围栏、字符串字面量包裹、结论前后夹带说明文字均可；`passed` 不是布尔即视为坏输出。
- **fail-open 定案**：判定自身故障（请求失败 / 坏输出 / 任务当前模型不可用）**按未通过处理**——落一条 `passed: false` 的验证记录，`reason` 注明「完成判定不可用（原因），按未通过处理」，不抛错、不另设用户态。取这个偏向是为了**不误报完成**：网络抖动不至于把未验证的目标标成已完成。

### 编排器接缝（desktop `src/tasks/goal-orchestrator.ts`）

- 工厂 `createGoalOrchestrator({ manager, profileFor, emit, isStopping })`，两个方法：
  - `afterTurn(taskId, { signal, outcome })` —— **idle 边界**。`outcome` 取宿主活动态的 `completed / failed / interrupted`。
  - `pause(taskId)` —— 进行中的目标转已暂停，幂等。票 04 的暂停按钮直接复用。
- **边界回调位置**：`task-ipc.ts` 的 `deliverMessage` 里，消息流的 `.finally` 改为 `settleAfterStream(taskId, controller.signal, end)`——先 `goals.afterTurn`，再 `end()`（注销执行登记 → 唤醒输入队列 → 推进任务排队）。
- **本票的处置规则**：
  - 回合正常结束 → 判定 → 通过：`complete`；未通过（含 fail-open）：`pause`。**票 03 在 `afterTurn` 的未通过分支把 `pause` 换成续跑。**
  - 回合被中断 / 出错 → 不判定，直接 `pause`（不让目标停在「进行中却没有回合在跑」的空转态）。
  - 应用退出（`isStopping()`）→ 不做任何编排，目标状态原样。
- **Stop = 暂停不需要改 `tasks:interrupt` handler**：它由上面的「中断的回合 → 暂停」规则给出，且暂停发生在 `end()` 之前，队列唤醒时互锁已解除。

### 输入队列互锁的实现方式与票 03 的注意点

- 本票**没有**在 `input-queue` 的 `isBusy` 守卫里加目标条件。互锁靠的是：**判定全程持有执行登记**（`end()` 延后到判定落定之后），判定期间任务在 `management.execution` 口径下仍是 running，pump 自然不取队首。
- 本票所有可达路径里都不存在「目标进行中且任务空闲」的窗口，所以泵级守卫既无必要也无法被真实地测到。
- **票 03 如果在两轮之间释放执行登记（先 `end()` 再起新一轮）**，`end()` 会立刻唤醒队列、把用户排队的消息发出去，与续跑轮抢跑——那时**必须**在 `isBusy` 里加「目标进行中」条件，并补一条能到达该状态的用例。若续跑轮在同一个执行登记内发起（不调 `end()`），需先处理 `beginExecution` → `assertCanExecute` 对「任务正在执行」的拒绝。
- 既有规则不变：Stop 时若队列里有排队消息，输入队列照旧进入「队列暂停」（需手动恢复或插话），这与目标暂停是两件事。

### IPC 通道与事件

- `tasks:goal-set`——IPC 表键 `goalSet`，preload 方法 `tasks.goalSet(taskId, text, options?: GoalSendOptions)`，返回 `GoalRecord`。`GoalSendOptions` = `{ providerProfileId?, model?, thinkingEffort?, approvalMode? }`（首轮按它发出，缺省回退任务保存的发送偏好）。
  - 前置：任务存在、未归档、不在执行 / 等待交互 / 任务排队中；再加 agent-core 的 `setGoal` 校验。
  - 设定与首轮是同一个意图：目标先落库，随即以目标原文走用户发送主路径（满员照旧进任务排队）；**首轮启动失败即回滚**（`discardGoal`）并下发 `goal: null`。
- 事件（desktop `TaskEventEnvelope["event"]`，**不在** agent-core 的 `TaskEvent` 里）：
  - `goal-changed { goal: GoalRecord | null }` —— 设定与每次状态推进都下发完整快照；`null` = 已无目标（清除）。
  - `goal-verification { verification }` —— 一轮判定的结论，标记行的实时数据源。
  - 两者经 `pushTaskEvent` 下发（`ensureExecution` 延续任务水位，空闲任务也有信封可挂）。
- `TaskView.goal` —— 切换 / 重启时进度行的恢复数据源。

### ui 对接面

- **testid**：进度行 `goal-progress-row`（带 `data-goal-status`）、`goal-progress-summary`、`goal-progress-status`、`goal-progress-elapsed`；标记行 `goal-verification-marker`（带 `data-goal-round`、`data-goal-verdict` = `passed` / `unpassed`）。
- 进度行挂在 `WorkspacePage` 的过程胶囊条与输入区之间，宽度对齐正文列；没有目标时渲染 null（不占布局行）。**按钮组（暂停 / 恢复 / 编辑 / 清除）留在这行内接入**，`GoalProgressRow` 目前只收 `goal` 一个 prop。
- 标记行文案由 `goalVerificationText(verification)` 单点给出（「第 N 次迭代 · 已完成 / 未完成」）；票 03 的「验证中」占位与下一步方向摘要加在 `GoalVerificationMarker` 与该函数上。
- 数据流：`LiveTask.goal` 随 `view.goal` 恢复、随 `goal-changed` 接续；`goal-verification` 经 `appendGoalVerification` 追加为 `GoalVerificationSegment`（幂等）；重启后 `initialTranscript` 从任务时间线的 `goal-verification` 条目重建同形段。
- **新增任务级事件要过三道闸**，漏一道界面就收不到：desktop `live-tasks.ts` 的 `GOAL_EVENT_TYPES`（终态后与停止后放行）、ui `live-task.ts` 的 `starts` 清单（非运行态按水位接续）、以及 ui `receiveLiveEvent` 的字段映射。
- 命令反馈文案：成功「已设定目标，进入目标模式：每轮回复结束后自动进行完成判定」；无参「用法：/goal 目标描述（建议写明期望结果、约束与验证方式）」；失败「设定目标失败：<原因>（输入已保留）」——失败时输入框恢复成 `/goal <原文>`，修正后可直接重发。

### 踩坑点

- **预置中断的 signal 不会让 SDK 短路**：对注入的 mock 模型，已 abort 的 `abortSignal` 照样会打到模型——`verifyGoal` 显式前置检查 `signal.aborted`。
- **`view.history` 是执行起点快照**：`begin()` 之后才落库的验证记录不在 `view.history` 里，要等下一次 `begin()` 才出现；实时靠 `goal-verification` 事件，重启靠时间线。单测里读验证记录请走 `tasks:messages`（transcript），别读 `view.history`。
- **IPC 方法名要与 IPC 表键一致**：`browser-stub` 的契约测试按表键逐个对照替身方法（只有事件订阅类走别名表）。本票方法名即 `goalSet`（与 `queueResume` 一族的「名词在前」一致），新增 IPC 记得同步 `src/dev/browser-stub.ts`。
- **README 表格别写长行**：prettier 会按最宽单元格重新对齐整张表，一行过长就是 36 行的空白 diff。把新增行的末列控制在既有最宽行以内，diff 就只有新增行。
- **node:sqlite 默认开启外键级联**：`removeProject` 的「无孤儿行」用例靠外键就能过；仓内约定是显式清理，两表已补进显式清理清单。
- stub 的判定识别是**文本级**匹配：目标文本或历史里出现 `"tools": [` 加非空白字符会把判定请求误判成工作轮，e2e 目标文本里别写这类 JSON。
- 退出屏障会中断在途判定：这条路径不动目标状态（与「回合在途被退出中断」同口径），重启后的恢复统一交给恢复链路。

### 本票定下的行为与遗留缺口（供排期参考）

- **判定未通过 → 已暂停**是票 02 的过渡行为（无续跑循环时不让目标空转），票 03 改为续跑。
- **未做**：重启后「进行中」目标转「已暂停」（票 06）。当前重启后这类目标仍是「进行中」且没有任何回合在跑，进度行时长会继续累加；该任务的排队消息在启动时照常消费。06 的落点在 `createTaskManager` 的启动收尾循环（残留态重置处）。
- **未做**：目标进行中禁用 `/compact`。规格里有这条，但票 02–07 的票面都没有明确认领，建议在票 04 或票 07 安排。
- **未做**：侧栏的目标徽章（本票口径照旧——回合进行中显示运行中）。判定在途的短窗口里侧栏短暂显示为空闲，票 03 的「验证中」副状态可以一并处理。
- `/goal` 在新建草稿里不可用（提示先选择任务）；目标文本里的 @引用 不解析附件，按纯文本发出。
