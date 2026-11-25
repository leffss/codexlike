# 04: 控制面完整：暂停/恢复/编辑/清除

**What to build:** 目标进度行按钮组全量：**暂停**（补按钮，语义同 Stop）、**恢复**（已暂停 → 进行中，从暂停点续跑，累计 token/时长账目连续）、**编辑**（修改目标文本，新文本对后续判定生效，逐轮验证历史保留可回看）、**清除**（目标转「已清除」，任务回普通对话形态、输入队列立即恢复自动消费，历史验证记录随任务留痕）。各操作配本地命令反馈与失败原因呈现。

**Blocked by:** 03

**Status:** done

**上下文指针:** `.scratch/goal-mode/spec.md`（命令与控制面）、`.scratch/goal-mode/notes.md`（本地命令反馈通道、interrupt-registry 接线点）

- [x] 暂停按钮：进行中 → 已暂停，续跑停止、账目冻结；与 Stop 语义一致
- [x] 恢复按钮：已暂停 → 进行中，从暂停点续跑，累计账目连续不重置
- [x] 编辑：修改目标文本后下一轮起按新文本判定；编辑前验证历史完整保留
- [x] 清除：目标「已清除」，任务回空闲、输入队列恢复自动消费，进度行退场，验证历史仍随任务可查
- [x] 六态下按钮可用性矩阵正确（如已完成后无暂停/恢复、进行中无恢复、已清除全退场）
- [x] ui 单测绿：按钮组状态矩阵、编辑入口
- [x] desktop 单测绿：暂停/恢复编排流转、编辑生效链路、清除退场
- [x] e2e 场景实跑绿：暂停→发排队消息→恢复（消息不抢跑、恢复后续跑）；编辑目标；清除
- [x] （编排者追加 A）目标进行中（在途回合、判定在途、轮间窗口）点 Stop → 目标转已暂停，排队消息自动逐条发出（之后作为普通回合运行，目标保持已暂停）；非目标任务的 Stop 行为不变；补 e2e
- [x] （编排者追加 B）目标进行中执行 `/compact` 给本地命令反馈「请先暂停目标」、不执行压缩；已暂停 / 终态期间照常可用；其他斜杠命令在目标进行中是否可用的决定写进 Comments
- [x] （编排者追加 C）续跑轮发起失败导致的暂停，原因对用户可见（接入进度行的暂停原因）

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

---

（票 04 实现轮，2026-11-26。上方票 03 的衔接说明原文保留；下面依次是交付物、行为定案、对接面、验收自证、验证记录、踩坑点，以及写给票 06 / 票 07 的要点。）

### 交付物

- **agent-core**：`src/goal/state-machine.ts` 新增 `canTransitionGoal(status, transition)`（不抛错地查询转换表）与 `isGoalEditable(status)`（可编辑的目标状态）；`src/task/manager.ts` 新增 `TaskManager.editGoal(taskId, text)`；根出口与 node 出口同步导出——ui 的六态矩阵直接取用，不另存一份转换表。
- **desktop**：`src/tasks/goal-orchestrator.ts`——公开接缝新增 `resume` / `edit`，`continueTurn` 由返回对象上的方法提为工厂内局部函数再暴露（公开形状不变）并返回发起结局 `GoalContinueResult`，转已暂停可携带说明；`src/tasks/task-ipc.ts`——`tasks:goal-resume` / `tasks:goal-edit` / `tasks:goal-clear` 三个 handler、interrupt handler 的队列规则（追加 A）、`/compact` 在目标进行中的拒绝文案（追加 B）；`src/shared/ipc.ts`——IPC 表键 `goalResume` / `goalEdit` / `goalClear`、`TaskApi` 三个方法、`goal-changed` 事件新增可选字段 `pauseReason`；`src/preload.ts`。
- **ui**：`src/components/GoalProgressRow.tsx`（按钮组、行内编辑、已清除不渲染）、`src/lib/goal-view.ts`（`goalControls`）、`src/lib/slash-command-actions.ts`（`busyCommandFeedback`）、`src/lib/live-task.ts`（`LiveTask.goalPauseNote`）、`src/pages/WorkspacePage.tsx`（四个操作的接线与本地命令反馈）、`src/dev/browser-stub.ts`；`src/lib/use-composer-menu.ts`（顺带修复一处既有问题，见「追加 B」）。
- **e2e**：`e2e/goal-controls.mjs`（`pnpm test:e2e:goal-controls`，已追加到 `test:e2e:all` 链尾；README 索引第 38 行）。
- **单测**：agent-core `tests/task/goal.test.ts`（+11）；desktop `tests/tasks/goal-controls-ipc.test.ts`（新，27 条）、`goal-orchestrator.test.ts`（+3）、`goal-ipc.test.ts` 与 `goal-continuation-ipc.test.ts`（改写票 03 留下的两条旧断言，并给「续跑轮发起失败」补暂停原因）、`goal-harness.ts`（`PendingRound.json`：应答非流式请求，供 /compact 用例）；ui `goal-progress-row-ui.test.tsx`、`workspace-goal-ui.test.tsx`、`goal-view.test.ts`、`slash-command-actions.test.ts`、`live-task.test.ts`。

### 行为定案

**暂停**：进度行的暂停按钮与停止按钮是同一通道（`tasks:interrupt`），不另设 IPC——两者语义不可能分叉。在途回合 / 判定在途由宿主中断并在 idle 边界转已暂停，轮间窗口直接暂停；续跑停止，累计时长随状态机闭合当前进行中区段而定格。

**恢复**（`tasks:goal-resume`）：`goals.resume(taskId)` = 状态机 `resume`（进行中区段另起、连续计数清零）→ `continueTurn({ kind: "resume" })` 以内部输入从暂停点发起下一轮（不产生用户气泡）。三种可恢复态（已暂停 / 预算受限 / 未达成）走同一条路径。前置：任务存在、未归档、有目标；在可恢复态下要求任务**真实空闲**——有在途回合、等待审批 / 问答、任务排队中都以明确原因拒绝（否则续跑轮在发起处被拒、目标随即转回已暂停，等于白暂停一次）。不在可恢复态的越界转换交状态机拒绝（「目标已完成，不能恢复」等）。下一轮没能发起（如任务所用模型已被删除）：目标回已暂停、原因随快照下发到进度行，并以「恢复目标失败：无法发起下一轮：…」抛回渲染层。

**编辑**（`tasks:goal-edit` → `TaskManager.editGoal`）：只在已暂停 / 预算受限 / 未达成可编辑；进行中拒绝「目标进行中，不能编辑：请先暂停目标」（与 `/compact` 同口径：完成判定以目标文本为判据，不与在途判定竞态——这条按编排者指示，覆盖上方票 03「回合进行中编辑也无妨」的说法）；已完成与已清除是定稿的历史，不可编辑。校验同 `setGoal`（trim 后非空、不超过 4000 字符）。原地更新同一条记录的 `text`——id、状态、累计时长、连续计数、设定与更新时间都不动（目标记录的更新时间只随状态机转换变化，与票 03 的记账口径一致）。验证记录按 `goalId` 归属、不存目标文本，编辑前的历史原样保留；下一次判定（`buildGoalVerificationPrompt` 读 `manager.goal().text`）与续跑指令（每轮重新读目标原文）即按新文本。多窗口同时编辑同一条目标没有 CAS，后保存者覆盖（一任务一目标，实际很少见）。

**清除**（`tasks:goal-clear` → `goals.transition(taskId, "clear")`）：目标转「已清除」并下发完整快照；任务回空闲，输入队列恢复自动消费，并发名额让出；逐轮验证记录与消息流的标记行仍随任务留痕；未结束目标的名额让出，可重新 `/goal`。

- **进行中清除时在途回合一并中断**（编排者留给本票决定）：清除 = 用户明确放弃这个目标。留着回合继续朝已被清除的目标跑，既不是「任务回到普通对话形态」，排队消息也要等回合自然结束才发得出。做法与 Stop 同一路径——先过状态机（已清除后再清除被拒时不动任何执行），再中断在途回合或判定（不留结论、不续跑），回合收尾的 `end()` 负责唤醒输入队列与并发名额；轮间窗口没有在途执行可中断，由清除入口自己补唤醒（待发起的续跑轮经 `deliverMessage` 的 `goals.isRunning` 复查作废）。
- 目标不在进行中时清除只改状态：正在运行的普通回合（如暂停后发出的排队消息）不属于目标循环，照常跑完。
- 「已清除」是落库的终态：`view.goal` 返回 `status = "cleared"` 的那条记录（不是 `null`，原文保留），界面据此让进度行退场；重启后同样不渲染。重复清除、清除后恢复 / 编辑都被状态机拒绝。

**六态按钮矩阵**（`goalControls`，直接取自状态机的转换表与可编辑状态）：

| 状态                       | 暂停                 | 恢复   | 编辑                     | 清除 |
| -------------------------- | -------------------- | ------ | ------------------------ | ---- |
| 进行中（含「验证中」）     | 可用                 | 不出现 | 禁用（悬停：先暂停目标） | 可用 |
| 已暂停 / 预算受限 / 未达成 | 不出现               | 可用   | 可用                     | 可用 |
| 已完成                     | 不出现               | 不出现 | 禁用（悬停：不再修改）   | 可用 |
| 已清除                     | 整行退场，不占布局行 |

暂停与恢复在同一位置互换（布局稳定）；不可用的按钮禁用而非隐藏，悬停说明原因；已归档的任务只读呈现（不渲染按钮组）。

**追加 A——目标进行中点 Stop 后输入队列自动发出**：`tasks:interrupt` handler 里，本次停止让目标离开进行中时（停止之前循环在本进程存活——在途回合 / 判定在途 / 轮间窗口，或本次调用直接把尚未开跑的目标转已暂停）不再调用 `queues.pause`。三条路径的唤醒都晚于目标转已暂停：在途回合与判定在途由回合收尾的 `end()` 唤醒；轮间窗口与「任务排队中、首轮未开跑」由 handler 里既有的 `wakeAfterLoopEnd` 补唤醒（排在 `goals.pause` 之后）。排队消息随后作为普通回合运行，不触发判定，目标保持已暂停等用户恢复。**非目标的停止路径不变**：普通任务 Stop、以及目标已暂停后停止正在运行的普通回合，仍把输入队列置为「队列暂停」。票 03 留下的两条把旧行为写进断言的用例已按新行为改写。

**追加 B——斜杠命令在目标进行中的口径**：

- 普通执行中任务的既有规则：回复进行中时全部斜杠命令不入队不执行，提示「命令 /x 不入队：回复结束后可用（输入已保留）」。目标循环期间任务恒为执行中，这条规则原样生效。
- **决定**：目标进行中，其余斜杠命令（`/rename` `/model` `/status` `/new` `/archive` `/goal` 等）维持不可用——与普通执行中任务同口径，不开后门、不加限制。放宽（比如放行 `/status` `/model`）会牵动「任务当前模型」与完成判定的关系，留作后续演进。其中 `/goal` 在目标进行中本就被「任务已有未结束的目标」拒绝，`/archive` 本就被归档保护拒绝。
- `/compact` 在目标进行中给规格指定的专门提示：「目标进行中不能压缩历史：请先暂停目标（完成判定依赖完整历史）（输入已保留）」，不执行压缩。目标已暂停 / 终态期间照常可用。主进程 `tasks:compact` 的拒绝文案一并对齐（按 `goals.isRunning` 判别：「目标进行中，请先暂停目标再压缩历史」），非目标任务仍是通用文案。
- 其余命令的提示把可用时机说准：目标进行中时为「命令 /x 不入队：目标暂停或结束后可用（输入已保留）」——目标的每一轮回复都会结束但循环继续，「回复结束后可用」在目标进行中并不成立。
- **顺带修复一处既有问题**（不在票面，但与「输入已保留」这句承诺直接相关）：从命令菜单选中无参命令（输入 `/compact` 后按 Enter / Tab / 点菜单项）时，`use-composer-menu` 原先在 `onSend` **之前**就把输入清空，忙时被拒后提示写着「输入已保留」而输入已经没了。改为输入先留作命令原文、由发送路径在受理后清空；空闲态的可见结果不变（受理后同样清空），忙时输入真的还在。既有 e2e 走的是点按钮那条路径所以没有暴露；`commands` 与 `input-queue-composer` 两个场景实跑仍绿。

**追加 C——下一轮没能发起的暂停原因对用户可见**：`continueTurn` 的发起失败路径把原因（「无法发起下一轮：<错误信息>」）随已暂停的状态快照下发（`goal-changed` 事件新增可选字段 `pauseReason`，不落库）；ui 记入 `LiveTask.goalPauseNote`，显示在进度行的暂停原因位置（`goal-progress-reason`），之后不带原因的状态快照到达即清除；恢复时发生则同时以「恢复目标失败：…」走本地命令反馈。重启后说明不再有（目标只显示「已暂停」，再次恢复失败会重新出现）。

### IPC、事件与 testid

- IPC 通道：`tasks:goal-resume (taskId)`、`tasks:goal-edit (taskId, text)`、`tasks:goal-clear (taskId)`；IPC 表键与 preload 方法名 `goalResume` / `goalEdit` / `goalClear`（browser-stub 契约测试覆盖），三者都返回更新后的 `GoalRecord`。暂停不设通道（`tasks:interrupt`）。
- 事件：`goal-changed { goal, pauseReason? }`——沿用既有事件类型，三道闸（live-tasks 放行清单、ui `starts` 清单、字段映射）与侧栏刷新的触发清单都不用新增。
- testid：按钮 `goal-pause` / `goal-resume` / `goal-edit` / `goal-clear`（容器 `goal-controls`）；编辑态 `goal-edit-form` / `goal-edit-input` / `goal-edit-save` / `goal-edit-cancel`。进度行 `goal-progress-row` 在目标已清除时不渲染。
- 本地命令反馈（GLOSSARY「本地命令反馈」）：暂停「目标已暂停：可随时恢复，累计时长与逐轮验证记录保留」；恢复「目标已恢复：从暂停点继续推进」；编辑「目标已更新：下一次完成判定按新文本进行，逐轮验证记录保留」；清除「目标已清除：任务回到普通对话，逐轮验证记录仍可回看」；失败一律「<暂停 / 恢复 / 编辑 / 清除>目标失败：<原因>」（编辑另加「（编辑内容已保留）」，编辑框保持打开）。

### 验收自证

| 验收项             | 证据                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 暂停按钮（= Stop） | desktop `goal-controls-ipc`「首轮回合在途点 Stop…」「判定在途点 Stop…」（暂停与 Stop 同通道）；ui `workspace-goal-ui`「暂停按钮：与停止按钮同一通道…」「暂停失败…」；e2e `goal-controls` 第 2 段（停止按钮）与第 4 段（进度行的暂停按钮）                                                                                      |
| 恢复按钮           | desktop `goal-controls-ipc`「恢复」组 8 条（三种可恢复态、累计时长不重置、三类前置拒绝、发起失败的原因）；ui `workspace-goal-ui`「恢复按钮…」「恢复失败…」；e2e 第 3、4 段                                                                                                                                                     |
| 编辑               | agent-core `goal.test`「TaskManager.editGoal」组；desktop `goal-controls-ipc`「编辑」组 3 条与 `goal-orchestrator`「编辑：…」；ui `goal-progress-row-ui`「编辑目标」组 9 条、`workspace-goal-ui`「编辑…」「编辑失败…」；e2e 第 4 段（取消 / 保存 / 恢复后的判定请求带新文本）                                                  |
| 清除               | desktop `goal-controls-ipc`「清除」组 7 条（已暂停、回合在途、判定在途、轮间窗口、普通回合在途不打断、恢复途中、拒绝）；ui `goal-progress-row-ui`「已清除：进度行退场…」「目标在编辑期间被清除…」、`workspace-goal-ui`「清除…」「清除失败…」「已清除的目标…」、`live-task`「…清除下发「已清除」的目标记录」；e2e 第 5、7、8 段 |
| 六态按钮矩阵       | ui `goal-view`「goalControls」（六态逐项）与 `goal-progress-row-ui`「控制面按钮组的六态可用性矩阵」；agent-core `goal.test`「canTransitionGoal 与转换表一致」「可编辑的状态…」；e2e 第 1–3 段在真实界面上逐态核对                                                                                                              |
| ui 单测            | `goal-progress-row-ui`（31）、`workspace-goal-ui`（24）、`goal-view`、`slash-command-actions`、`live-task`、`browser-stub`                                                                                                                                                                                                     |
| desktop 单测       | `goal-controls-ipc`（27，新）、`goal-orchestrator`（12）、`goal-ipc`（11）、`goal-continuation-ipc`（16）                                                                                                                                                                                                                      |
| e2e                | `goal-controls.mjs`（见验证记录）                                                                                                                                                                                                                                                                                              |
| 追加 A             | desktop `goal-controls-ipc`「目标进行中点 Stop 后输入队列恢复自动发出」5 条 + 改写的两条；e2e 第 2 段（带排队消息的 Stop，脚本内置互锁哨兵）                                                                                                                                                                                   |
| 追加 B             | desktop `goal-controls-ipc`「/compact 与目标状态」4 条；ui `slash-command-actions`「busyCommandFeedback」3 条、`workspace-goal-ui`「/compact 在目标进行中…」「/compact 在目标已暂停 / 已完成时照常可用」「其他斜杠命令…」「普通任务忙时从命令菜单选中…」；e2e 第 1 段                                                          |
| 追加 C             | desktop `goal-orchestrator`「续跑轮发起失败…原因随状态快照下发」、`goal-continuation-ipc`「续跑轮发起失败…」、`goal-controls-ipc`「恢复时下一轮没能发起…」；ui `live-task`「目标暂停说明随 goal-changed 接续」、`workspace-goal-ui`「下一轮没能发起而暂停…」                                                                   |

### 验证记录

- 单测与静态检查（2026-11-26，从头重跑：先重建 agent-core dist，再跑三包）：agent-core 755（基线 744）、desktop 656 + 1 skipped（基线 626）、ui 826（基线 782），退出码全 0；`pnpm typecheck` 0 错；`pnpm lint` 0 error（9 条既有 warning，均在未触碰的文件）；31 个改动文件 `prettier --check` 通过；`check:e2e-locators`（54 个场景文件）与 `check:adr`（35 篇）通过；全仓 `pnpm build` 通过。
- e2e（2026-11-26，桌面**未锁屏**，全仓 build 之后逐个实跑；每个场景都是独立进程，与链的跑法一致）：**未跑全量链** `test:e2e:all`（全量回归归票 07）。实跑 23 个场景文件、25 次执行，**全部通过**（退出码全 0）：
  - 本票要求的 15 个：`goal-controls`（新，连跑 3 次）、`goal-mode`、`goal-continuation`、`goal-stub-probe`、`interrupt`、`live-tasks`、`exit-recovery`、`input-queue`、`input-queue-items`、`input-queue-pause`、`input-queue-composer`、`input-queue-restart`、`task-queue-restart`，以及改动直接波及的 `compact`（compact handler 的目标判别）与 `commands`（菜单选中命令的提交路径）。
  - 另有 8 个会走到本票改动路径（命令菜单 / 无参命令提交 / 停止按钮）的既有场景：`skills`、`sidebar-archive`、`subagent-recovery-review`、`persistent-workbench`、`interactions`、`process-segments`、`thinking`、`worktree`。
  - 此前桌面锁屏时那 15 个也实跑过一轮全绿；解锁后按编排者要求把该轮结果作废、从头重跑，以本记录为准。
- 先红后绿：每条控制流转规则都先有会红的测试。变异核查（确认撤掉对应实现时恰好对应用例变红）：
  - 追加 A 的轮间窗口补唤醒——初版用例有盲区：`settleAfterStream` 在续跑轮没能发起时自己也会补唤醒，去掉 handler 里的唤醒用例仍绿。改成「目标首条执行因满员在任务排队中、名额刚空出尚未开跑时点 Stop」（此刻没有别的触发点）后恰好变红。
  - 清除在轮间窗口的补唤醒——同样的盲区，改成「恢复的下一轮还在发起途中时清除、另一个任务在任务排队里等名额」后恰好变红。
  - 其余规则在实现前都实跑确认过红（未注册通道 / `edit is not a function` / 旧的通用文案等）。
- 一次与本票无关的抖动（发生在被作废的那一轮）：agent-core 全量里 `subagents.test.ts`「并发多子代理受控挂起：逐轮正文与逐条工具调用的归属互不串联」红过一次（两条并发子代理的工具结果事件先后顺序对调）。该文件本票未触碰、不走目标代码；当时同一命令重跑全绿、该文件单跑 8 次全绿；解锁后的从头重跑一次通过（755）。同机当时另有一位实现者在跑 e2e，按并发时序抖动记，留给票 07 全量回归时留意。
- 一次性取证探针（e2e 里读事件流与 DOM 的 `PROBE-TEMP` 段）与临时日志均在提交前删除 / 不进提交。

### 踩坑点

- **长 heredoc 会截断**（票 03 记过，这次又踩）：往测试文件追加大段内容时 heredoc 在多字节字符中间断掉、留下半截。一律用编辑工具写文件。
- **vitest 假定时器下 `waitFor` 会挂死**：进度行的测试文件用了 `vi.useFakeTimers()`，异步断言要用 `await act(async () => { … })` 包住触发动作再同步断言。
- **「证明某次唤醒是必需的」要造出没有别的触发点的场景**：`settleAfterStream`、回合收尾的 `end()`、任务排队推进都会补唤醒，轮间窗口里的唤醒很容易被别处掩盖。用「Provider Profile 读取闸」把发起卡在半途、并让另一条执行确实在排队，才能把唤醒钉住。
- **用例里的 `void invoke(...)` 不等于前提已成立**：没 await 的发送还没走到并发闸门，清除就已经发生，「另一个任务在排队」的前提根本没建立。涉及前提的调用要 await 并断言前提。
- **e2e 里「已中断」提示不能按全局序号数**：消息流会把较早的轮次折叠收起（不在 DOM 里），`nth(2)` 会等不到。限定到对应那条消息内定位（`getByTestId("message-assistant").filter({ hasText }).getByText(...)`）。
- **续跑轮回复太快会直接判定通过**：断言「恢复后进行中」要在慢速流的第一段到达时读，不能等回复结束。
- **编排器的公开方法是返回对象上的成员**：方法之间互调要先把被调方提成工厂内的局部函数再暴露，否则 `continueTurn is not defined`。
- **清除在途回合时，已清除的快照活动态仍是运行中**：中断尚未落定，界面会短暂显示「没有进度行、仍在流式中」，随后由中断的终态事件收回——与事实一致，不是缺陷。

### 写给票 06（重启恢复为暂停态）

- 重启时需要收场的循环内状态仍然只有编排器内存里的循环存活状态（`loops`），进程重启自然清空；本票没有新增别的循环内状态。新增的不落库状态只有 ui 的暂停说明（`goalPauseNote`），重启后消失——已暂停的目标只显示「已暂停」。
- 启动收尾把「进行中」转「已暂停」时直接写持久层即可（循环不在本进程存活，没有存活状态要结束）。会话内的暂停走 `goals.pause`（`pauseIfActive`），两条路都调状态机的 `pause`，累计时长记账一致。
- 恢复入口在重启后与会话内是同一条 IPC（`tasks:goal-resume`），它要求任务真实空闲——启动收尾时任务都是空闲的；启动时若消费了排队消息，等那条回合结束再恢复即可（进行中会被以明确原因拒绝，不会白暂停一次）。
- 「队列暂停」与目标暂停是两件事：目标进行中点 Stop 不再置队列暂停（追加 A），所以重启后不会因为「之前 Stop 过」而看到队列暂停标志；该标志仍可能来自普通回合的 Stop。目标不在进行中时输入队列照常自动消费（互锁只在循环存活时成立）。
- 终态不动：「已清除」是落库的终态，重启后 `view.goal` 是 `status = "cleared"` 的记录（不是 `null`），ui 进度行不渲染；已完成 / 未达成 / 预算受限 / 已暂停同样原样。启动收尾只需处理 `active → paused`。
- 强杀重启的中间态与票 03 描述的同形：杀在恢复后的首轮或续跑轮进行中时，消息流最后一条内部输入是 `goal-continuation`、其后没有回复或是一条中断的回复；标记行只到上一个已落库的结论。
- 提醒：在票 06 落地前，重启后残留的「进行中」目标仍会被该任务的下一轮回合重新带入循环（票 03 / 票 06 票面已记）。本票没有改变这一点。

### 写给票 07（收口）

- **GLOSSARY 需要同步的措辞**：
  - 「队列暂停」词条现写「用户打断回复后输入队列停止自动发出的状态」——需要补例外：目标进行中点 Stop = 暂停目标，输入队列不进入队列暂停，排队消息在目标转已暂停后自动逐条发出。
  - 「目标」词条的「可暂停 / 恢复 / 编辑 / 清除」与实现一致；可补两句：编辑只在已暂停 / 预算受限 / 未达成时可用（进行中先暂停）；清除后任务回到普通对话，逐轮验证记录仍随任务可查。
  - 「目标模式」词条的「暂停或完成后恢复自动发出」现在在 Stop 路径上也成立。
  - 是否为「暂停说明」（`goal-changed.pauseReason`：下一轮没能发起的原因）立词条，由票 07 定夺。
- **ADR 0035**：「控制面」与「其他照旧」段的 `/compact` 描述与实现一致。建议补一句：目标进行中其余斜杠命令沿用「忙时命令不入队」，不放行。
- **斜杠命令口径的决定**（见「追加 B」）：目标进行中全部斜杠命令不可用（与普通执行中任务同口径）；`/compact` 给专门提示；其余命令的提示把可用时机说准为「目标暂停或结束后可用」。
- **README**：目标模式条目里控制面一句话（进度行按钮 暂停 / 恢复 / 编辑 / 清除；Stop = 暂停；暂停后排队消息自动发出）；e2e 索引已加第 38 行。
- **全量回归提醒**：`use-composer-menu.ts` 的行为有一处变化（菜单选中无参命令不再抢先清空输入）。空闲态的可见结果不变；会走到这条路径与停止按钮的既有场景（`commands`、`input-queue-composer`、`compact`、`skills` 等）已在解锁桌面后实跑绿，全量链里请继续留意这两类场景。
- **锁屏已知红的复核线索**：票 03 / 票 07 票面列的锁屏已知红里，`sidebar-archive`、`persistent-workbench`、`process-segments` 三个在本分支上解锁态各实跑 1 次、均为绿；`message-order`、`task-search`、`window-controls` 本票没有跑。本票未跑全量链，这三个只说明解锁后在本分支上没有红，不替代票 07 的全量回归。
- 追加 B 的提示文案与追加 A 的队列规则都改了用户可见行为，README / GLOSSARY 核对时请一并对照。
