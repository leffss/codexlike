# 04: 控制面完整：暂停/恢复/编辑/清除

**What to build:** 目标进度行按钮组全量：**暂停**（补按钮，语义同 Stop）、**恢复**（已暂停 → 进行中，从暂停点续跑，累计 token/时长账目连续）、**编辑**（修改目标文本，新文本对后续判定生效，逐轮验证历史保留可回看）、**清除**（目标转「已清除」，任务回普通对话形态、输入队列立即恢复自动消费，历史验证记录随任务留痕）。各操作配本地命令反馈与失败原因呈现。

**Blocked by:** 03

**Status:** ready-for-agent

**上下文指针:** `.scratch/goal-mode/spec.md`（命令与控制面）、`.scratch/goal-mode/notes.md`（本地命令反馈通道、interrupt-registry 接线点）

- [ ] 暂停按钮：进行中 → 已暂停，续跑停止、账目冻结；与 Stop 语义一致
- [ ] 恢复按钮：已暂停 → 进行中，从暂停点续跑，累计账目连续不重置
- [ ] 编辑：修改目标文本后下一轮起按新文本判定；编辑前验证历史完整保留
- [ ] 清除：目标「已清除」，任务回空闲、输入队列恢复自动消费，进度行退场，验证历史仍随任务可查
- [ ] 六态下按钮可用性矩阵正确（如已完成后无暂停/恢复、进行中无恢复、已清除全退场）
- [ ] ui 单测绿：按钮组状态矩阵、编辑入口
- [ ] desktop 单测绿：暂停/恢复编排流转、编辑生效链路、清除退场
- [ ] e2e 场景实跑绿：暂停→发排队消息→恢复（消息不抢跑、恢复后续跑）；编辑目标；清除

## Comments

（来自票 03 实现轮的衔接说明，2026-11-25；末尾转达两条已划给本票的规格项）

### 恢复如何再入循环（接缝方法）

- 恢复 = 两步：`manager.transitionGoal(taskId, "resume")`（状态机：进行中区段另起、空转计数与连续故障计数清零）→ `goals.continueTurn(taskId, { kind: "resume" })`（`src/tasks/goal-orchestrator.ts`）。`continueTurn` 把循环标记为在本进程存活，并以**内部输入**发起一轮回合——不产生用户气泡，续跑指令由 agent-core 的 `buildGoalContinuationInput(goal, { kind: "resume" })` 构造（复述目标原文、要求从暂停点继续）。不要自己拼恢复指令，也不要走用户发送路径。
- 恢复后的那一轮结束即回到常态：idle 边界判定 → 未过自动续跑。接缝已有单测锁定（`tests/tasks/goal-orchestrator.test.ts`「已暂停的目标经状态机恢复后…」），还没有 IPC 调用方——恢复 IPC 与按钮是本票的活。
- `transitionGoal` 不发事件：恢复的 `goal-changed` 快照由调用方经 `pushTaskEvent` 下发。`continueTurn` 发起的回合以 `goal-continuation` 事件开头（ui 把它当新执行的起点信号）。
- 启动失败的处置在 `continueTurn` 内：目标转已暂停、原因只进主进程日志；应用退出中目标状态原样。
- 前置：`continueTurn` 只对「进行中」的目标生效（先 resume 再调）。任务有在途回合或等待用户交互时不要恢复——续跑轮的发起处 `assertCanExecute` 会以「任务正在执行或等待用户回应」拒绝，目标随即转已暂停。

### 状态推进请经编排器

- `goals.transition(taskId, change)`（票 03 新增的公开入口）= `manager.transitionGoal` + 结束循环存活状态 + 下发 `goal-changed`。**清除**用它（`"clear"`）。不要直接调 `manager.transitionGoal`：循环存活状态不会随之结束，任务会一直显示运行中、输入队列一直不消费。
- 暂停：`goals.pause(taskId)`（进行中 → 已暂停，幂等）。回合在途时先中断回合——`tasks:interrupt` handler 已经同时处理两种情况：有在途回合 → 中断，idle 边界转已暂停；两轮之间没有在途回合 → 直接暂停。
- 判定在途时暂停同理：请连带中断该回合的 signal（Stop 路径就是这样，判定请求被中止、不留结论）。只调 `goals.pause` 而不中断的话，在途的判定请求会跑完并落一条验证记录，随后编排器推进状态时被状态机以「目标已暂停，不能完成」拒绝——这条异常会被兜底接住（循环结束、记主进程日志，目标保持已暂停），但会留下一条多余的结论记录。当前控制面只有 Stop，走不到这条路；暂停按钮请沿用 Stop 的做法。
- 回合在途时清除：循环立即结束，回合照常跑完，idle 边界不再判定也不再续跑；需要立即停下就先中断。越界转换（如已完成后暂停）由状态机以中文错误拒绝，循环存活状态不受影响。

### 暂停与输入队列守卫的交互

- 互锁是 `input-queue` 的 `isBusy` 里的显式条件 `goals.isRunning(taskId)`（`src/tasks/task-ipc.ts`），不再依赖执行登记：判定在途与两轮之间没有执行登记，队列照旧不消费。
- 目标离开进行中后队列如何恢复，分两条路径：
  - 经 idle 边界的收尾（回合出错 / 判定在途被停止 / 判定通过 / 故障阈值）：上一轮的 `end()` 负责唤醒队列，不需要额外动作。
  - 不经 `end()` 的路径（两轮之间点停止、续跑轮发起失败）：由 `wakeAfterLoopEnd(taskId)` 补一次唤醒。新增的「离开进行中」入口如果发生在回合收尾之外，记得调它。
- 两轮之间用户发来的消息照旧入队、不直发：`deliverMessage` 的用户路径按管理规则的执行态判忙闲，而执行态已含「目标循环在进行」。

### ui 对接面

- `GoalProgressRow` 现有三个 prop：`goal`、`verifying`（判定在途 → 状态显示「验证中」）、`pauseReason`（`goalPauseReason(goal)` 给出的暂停原因，没有则不渲染）。按钮组仍留在这行内接入。行上 `data-goal-status` 仍是六态，`data-goal-phase="verifying"` 标副状态。
- 标记行三态的 testid：`goal-verifying-marker`（占位，`data-goal-round`）/ `goal-verification-marker`（结论，`data-goal-verdict` = passed / unpassed / unavailable；下一步方向在 `goal-verification-next-step`）。目标离开进行中时 ui 自动撤下还没出结论的占位行（收到非进行中的 `goal-changed`），暂停按钮不用管它。
- **目标进行中 `streaming` 恒为真**（循环期间任务视为执行中），于是既有的「忙时命令不入队」规则会挡住全部斜杠命令（提示「命令 /x 不入队：回复结束后可用」，输入保留）——包括 `/rename` `/model` `/status` `/new` `/archive`。整段目标运行期间用户用不了任何命令，是否放宽请在本票定夺。
- 侧栏徽章与「N 个执行中」统计靠 `goal-changed` / `goal-verifying` / `goal-verification` / `goal-continuation` 四个事件触发 `refreshTasks`（`WorkspacePage`）。新增的控制面事件若影响运行口径，记得加进这个触发清单，否则后台目标任务的侧栏会停在旧状态。

### 转达：两条已划给本票的规格项（票 02 未做，票 03 亦未动）

1. **目标进行中 Stop 后，输入队列应恢复自动逐条发出**（规格故事 12 与互锁决定）。现状与规格相悖，**票 03 没有实现这一条**：`tasks:interrupt` handler 在所有停止路径上沿用旧规则「有排队消息时置队列暂停」，目标转已暂停后排队消息并不自动发出，要手动恢复。两条停止路径都是如此——续跑轮在途时点 Stop（回合中断 → idle 边界转已暂停 → `end()` 收尾），以及两轮之间点 Stop（handler 直接 `goals.pause`，再由 `wakeAfterLoopEnd` 补一次唤醒；唤醒排在置暂停之后，所以不会趁停止抢发队首）。修正点就在该 handler：本次调用让目标离开了进行中时不再调 `queues.pause`，其后的唤醒（`end()` 的收尾或 `wakeAfterLoopEnd`）即恢复逐条消费；非目标的普通停止路径保持旧规则。把旧行为写进断言的用例有两条，修正时同步改：`tests/tasks/goal-ipc.test.ts` 的「续跑期间队列持续互锁；目标离开进行中（已暂停）后…」与 `tests/tasks/goal-continuation-ipc.test.ts` 的「轮间窗口点停止时有排队消息：不趁停止抢发…」。
2. **目标进行中执行 `/compact` 给本地命令反馈「请先暂停目标」**，暂停 / 终态期间照常可用。现状有两层：主进程侧 `beginExecution → assertCanExecute` 以通用文案「任务正在执行或等待用户回应，请先停止再整理」拒绝（目标循环期间恒如此）；渲染层侧如上所述，命令在忙时根本到不了主进程。本票需要在 `runCommand` 的 compact 分支前加目标判别并给规格文案；主进程的文案建议一并对齐（按 `goals.isRunning(taskId)` 判别）。

### 编辑目标

- `TaskPersistence.updateGoal(id, { text })` 已支持改文本，但 `TaskManager` 没有编辑入口——本票补一个（校验同 `setGoal`：非空、不超过 4000 字符）。验证记录按 `goalId` 归属、不存目标文本，历史天然保留；下一次判定即按新文本（`buildGoalVerificationPrompt` 读 `manager.goal(taskId).text`）。回合进行中编辑也无妨：续跑指令每轮重新读目标原文，下一轮自动带上新文本。
