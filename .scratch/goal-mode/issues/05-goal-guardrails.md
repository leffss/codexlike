# 05: 护栏：token 预算与空转阻断

**What to build:** 两道护栏。①**token 预算**（可选）：按任务用量口径（含主任务、子代理与压缩的账目式累计）逐轮对账，超限 → 「预算受限」暂停（非终止，可加预算/改目标后恢复）；未设定预算 = 不限。②**空转阻断**：连续 3 轮判定未过且无实质工具活动（票 03 的计数）→ 「未达成」暂停并呈现原因。配置入口（执行设置 vs goal 级参数）实现时定夺并在票面 Comments 记录决策。

**Blocked by:** 03

**Status:** done

**上下文指针:** `.scratch/goal-mode/spec.md`（护栏段）、`.scratch/goal-mode/notes.md`（执行设置 toolRoundsLimit 先例、任务用量口径 GLOSSARY 词条）

- [x] 预算超限 → 「预算受限」暂停：进度行与标记行口径正确，不误伤正常轮
- [x] 子代理与压缩的 token 计入对账（口径 = 任务用量，含跨轮累计）
- [x] 加预算或改目标后可从「预算受限」恢复续跑
- [x] 连续 3 空轮 → 「未达成」暂停并呈现原因；有实质工具活动的未过轮清零计数（不误触）
- [x] 未设预算的目标不受预算护栏影响（默认不限）
- [x] desktop 单测绿：对账、空转计数消费、两阻断态转换与恢复
- [x] e2e 两场景实跑绿：预算受限、空转未达成

## Comments

（来自票 03 实现轮的衔接说明，2026-11-25）

### 空转计数：字段与判据

- 当前值在目标记录上：`manager.goal(taskId).idleStreak`（随 `goal-changed` 快照下发到界面）。含义：本段进行中内连续「判定未过且无实质工具活动」的轮数。
  - 判定未过且本轮无实质工具活动：+1；判定未过但有活动：清零；判定通过：清零；判定自身不可用（`unavailable`）：**保持原值**（故障轮不参与空转判定）。
  - 暂停后恢复清零（状态机 `advanceGoal` 的 `resume`）——恢复视作新的进行中区段。
- 逐轮事实在验证记录上：`verification.outcome`（`passed` / `unpassed` / `unavailable`）与 `verification.toolActivity`（本轮是否有实质工具活动）。记录不存计数快照；历史轮次的计数可由记录重放。
- **「实质工具活动」的定义**（agent-core `isGoalToolActivity(toolName)`）：一轮之内除 `update_plan` 外出现过任何工具调用即算有活动——只改计划不算，避免「每轮只动计划」被判为有进展而永不阻断。宿主在 `deliverMessage` 的事件泵里按 `tool-call` 事件逐条套用，再经 `goals.afterTurn` → `verifyGoal({ toolActivity })` 带进记账。
  - 已知口径边界：被用户拒绝、被审批策略拒绝、参数无效而未执行的调用也发过 `tool-call` 事件，按现定义**计入活动**。是否收紧到「实际执行过」由本票定夺（收紧点在事件泵：改按 `tool-result` 判别）。
  - `spawn_subagent` 的委派本身算一次活动（主任务位的 `tool-call`）；子代理内部的工具调用不单独计。

### 判定故障的结论种类与连续计数（编排者裁决「fail-open 定案」，票 03 已落地）

- `verification.outcome = "unavailable"` 表示判定自身故障（请求失败 / 坏输出 / 任务当前模型不可用），没有结论；兼容字段 `passed` 同为 false，但**不代表未达成**。`reason` 是故障说明，`nextAction` 为空串。
- 连续故障计数：`manager.goal(taskId).failureStreak`；阈值常量 `GOAL_MAX_VERIFICATION_FAILURES = 3`（agent-core 根出口）。达到阈值时编排器在 `afterTurn` 里把目标转已暂停并返回 `{ action: "paused", reason: "verification-unavailable" }`。出现一次正常结论即清零；恢复时清零。
- 界面：标记行「第 N 次迭代 · 判定不可用」（`data-goal-verdict="unavailable"`，原因在 title）；进度行的暂停原因「完成判定连续 3 次不可用」（ui `goalPauseReason`：已暂停且 `failureStreak ≥ 3`）。

### 空转阻断的接入点

- 判定处：`goal-orchestrator.ts` 的 `afterTurn`，紧跟在不可用阈值判断之后（此时结论与两个计数都已落库）。`idleStreak ≥ 3` → 把目标转为「未达成」，返回 `{ action: "paused", reason: … }`（`GoalPauseReason` 加一个值）。这条路径的收尾由上一轮的 `end()` 负责唤醒输入队列，不需要额外动作。
- 界面：`goalVerificationText` 不用改（未过轮仍显示「未完成 · 下一步」）；`goalPauseReason` 加「未达成」的原因文案（如「连续 3 轮没有实质进展」）。进度行的 `STATUS_CLASSES.unmet` 已是警示色。

### token 预算的建议挂点

- 同一位置（`afterTurn` 内、判定之后）：判定请求的 usage 在 `verifyGoal` 里已 `settleTaskUsage` 入账，此时对账天然包含本轮判定。任务用量读 `manager.list()` 里任务记录的四列（主任务 / 子代理 × 输入 / 输出，压缩与判定的辅助调用都在其中）。
- 超限 → 目标转「预算受限」，返回 `{ action: "paused", reason: … }`。
- 状态推进请经 `goals.transition(taskId, change)`（票 03 新增的公开入口）或编排器内部路径——它会把循环的存活状态一并结束。直接调 `manager.transitionGoal` 会让循环存活状态残留：任务一直显示运行中、输入队列不消费。
- 恢复（加预算 / 改目标后）走票 04 的恢复入口（`resume` → `goals.continueTurn`）；本票只需保证「预算受限」态能被恢复。

### 另一个值得本票定夺的点

- 回合出错（模型请求失败且重试耗尽）现为**直接已暂停、不重试**（沿用票 02 的规则，`afterTurn` 的 `turn-failed`）。无人值守长跑里一次网络抖动就会停下。若要给回合失败也做续跑或重试，需要像判定故障那样的连续计数来防死循环（如模型配置失效时每轮立即失败）。规格只对判定故障提了 fail-open，本票可按需扩展。

## Comments（票 05 实现轮，2026-11-26）

（写给票 04（控制面）、票 06（重启恢复）、票 07（收口）的衔接说明。上方是票 03 转来的要点；本节记录本票的决定、数据面、接缝与验证。）

### 交付物

- **agent-core**：`src/goal/budget.ts`（新）——`taskUsageTokens`（任务用量四列之和）、`goalSpentTokens`（账目 − 基线）、`isGoalBudgetExceeded`；`src/goal/types.ts`——`GoalRecord.budgetTokens / baselineTokens`、阈值常量 `GOAL_MAX_IDLE_ROUNDS = 3`；`src/goal/continuation.ts`——`isGoalToolActivity(toolName, executed)`；`src/task/types.ts`——`tool-result` 事件新增可选字段 `executed`；`src/task/agent-task.ts`——发出 `executed` 标注；`src/task/manager.ts`——`setGoal` 拍基线、新 API `setGoalBudget`；`src/task/persistence.ts`——两列与旧库迁移；`src/index.ts`——根出口。
- **desktop**：`src/tasks/goal-orchestrator.ts`（`afterTurn` 内两道护栏与处置结果 `blocked`）、`src/tasks/task-ipc.ts`（事件泵按 `tool-result` 判别实质工具活动、`tasks:goal-set-budget` handler）、`src/shared/ipc.ts` 与 `src/preload.ts`（`goalSetBudget`）。
- **ui**：`src/components/GoalBudgetControl.tsx`（新，独立组件）、`GoalProgressRow.tsx`（一个 prop + 一行挂载点）、`src/lib/goal-view.ts`（`goalPauseReason` 扩展、`formatGoalTokens`、`parseGoalBudgetInput`）、`pages/WorkspacePage.tsx`（两处导入 + 一个 prop）、`dev/browser-stub.ts`。
- **e2e**：`e2e/goal-budget.mjs`（`pnpm test:e2e:goal-budget`）、`e2e/goal-idle.mjs`（`pnpm test:e2e:goal-idle`），已追加到 `test:e2e:all` 链尾（README 索引第 38、39 行）；`e2e/helpers.mjs` 与 `e2e/goal-stub.mjs` 的 usage 能力（见下）。
- **单测**：agent-core `tests/task/goal-guardrails.test.ts`（8 条），另在 `goal-continuation.test.ts` / `goal.test.ts` / `sqlite-store.test.ts` 增补；desktop `tests/tasks/goal-guardrails-ipc.test.ts`（13 条）、`goal-orchestrator.test.ts`（+7）、`tests/e2e-stub/goal-stub.test.ts`（+5），`goal-harness.ts` 扩展；ui `goal-guardrails-view.test.ts`（6 条）、`goal-budget-control-ui.test.tsx`（10 条）、`goal-progress-row-ui`（+2）、`workspace-goal-ui`（+3）。

### 决定 1：配置入口——预算是 goal 级参数，入口在进度行；`/goal` 不附带预算参数

- 按编排者裁决落地：`GoalRecord.budgetTokens: number | null`（`null` = 未设预算 = 不限，缺省）。不进执行设置（ADR 0017），空转阈值 `GOAL_MAX_IDLE_ROUNDS = 3` 是固定值、不做成配置项。
- **入口 = 进度行上的预算控件**（`GoalBudgetControl`）：
  - 未设预算：「预算 不限」入口（点击打开编辑浮层，填总数）；
  - 已设预算：「用量 X / Y」，达到预算标警示色；
  - **预算受限态**：入口旁有醒目的「加预算」，浮层里有一键加预算（+10 万 / +50 万 / +100 万，在现有预算上累加），点一下即提交；
  - 已结束的目标（已完成 / 已清除）只回看数字、不可改（宿主同样拒绝）。
- **`/goal` 不附带预算参数**。理由：斜杠命令的参数先例都是单一的自由文本（`/rename 新名称`、`/model 关键词`），没有「自由文本 + 结构化次参数」的先例；目标原文本身是自由文本（三要素），再切一个预算标志位要自造语法且与原文歧义。预算在目标设定之后随时可设（进行中亦可），不损失能力。
- **加预算不自动恢复**：预算受限的目标加预算后仍是「预算受限」，由用户经控制面（票 04 的恢复按钮）显式恢复——与 ADR 0035「不在用户不知情时自动消耗 token」的保守口径一致。

### 决定 2：「实质工具活动」只认实际执行了的调用

- 定义（编排者裁决 2，已落地）：一轮之内除 `update_plan` 外出现过**实际执行了**的工具调用才算有活动。
  - 不算：被审批策略拒绝、被用户拒绝、审批被取消、参数无效、工具不存在、被中断的调用；
  - 仍算：实际执行但结果出错（如命令非零退出）；被接受的 `spawn_subagent` 委派；
  - 继续除外：`update_plan`（只改计划不算）。
- **实现机制与票 03 的建议不同，需要知道**：票 03 建议「改按 `tool-result` 判别」，但单靠 `tool-result` 不够——未执行的调用同样发 `tool-result`，且 `isError` 无法区分「没执行」与「执行了但出错」。所以给 `tool-result` 事件加了可选字段 **`executed`**（agent-core `agent-task.ts` 在工具循环里按「执行器是否真的跑过」标注；缺省 `undefined` = 来源未标注，消费方按已执行计，保守）。`isGoalToolActivity(toolName, executed = true)`，desktop 事件泵改按 `tool-result` 逐条套用。
- 效果：每轮只发出被拒 / 无效的调用同样是空转，连续 3 轮 → 未达成（此前会永不阻断）。

### 决定 3：恢复时两个连续计数都清零（确认）

- 已确认：`advanceGoal` 的 `resume` 把 `idleStreak` 与 `failureStreak` 都置 0（票 03 已实现，agent-core `goal.test.ts` 对「已暂停 / 预算受限 / 未达成」三处恢复均有用例）。本票在宿主层补了一条：预算受限的目标经状态机 `resume` 后两个计数为 0、对账基线不变。

### 决定 4：预算对账口径与挂点

- **消耗量 = 目标设定以来该任务的用量增量**：`setGoal` 时对任务用量账目（GLOSSARY「任务用量」四列之和）拍基线 `baselineTokens`；目标用量 = 当前账目 − 基线（`goalSpentTokens`）。涵盖主任务各轮、子代理、压缩与完成判定自身；同一任务先后有多个目标各算各的；恢复不重置基线。
- **对账时点**：`afterTurn` 内、每次判定之后、下一轮发起之前。不打断在途回合——越线的那一轮与它的判定照常跑完，之后才转「预算受限」。
- **判定顺序**（`afterTurn`，结论落库之后）：判定通过 → 已完成（**完成优先于预算**，越线那轮判定通过就是已完成）→ 判定连续不可用达阈值 → 已暂停 → `idleStreak ≥ GOAL_MAX_IDLE_ROUNDS` → 未达成 → 目标用量 ≥ 预算 → 预算受限 → 否则续跑。「达到」即超（`≥`）：预算是最多可消耗的量，用尽之后没有余量再跑一轮。未设预算恒不超。
- 两道护栏都经 `goals.transition(taskId, "unmet" | "budget-limit")` 推进（循环存活状态随之结束），处置结果为 `{ action: "blocked", reason: "idle" | "budget-exceeded", status }`；收尾由上一轮的 `end()` 唤醒输入队列、让出并发名额。

### 数据面变化

- `GoalRecord` 新增两个**必填**字段：`budgetTokens: number | null`、`baselineTokens: number`。**下游新增的 GoalRecord 字面量（测试夹具等）要补这两个字段**。
- `TaskEvent` 的 `tool-result` 变体新增可选字段 `executed?: boolean`。
- `TaskManager.setGoalBudget(taskId, tokens)`：只对未结束的目标生效；正整数校验；不是状态机转换（不动状态、时长、连续计数、基线与 `updatedAt`）。
- IPC：`tasks:goal-set-budget`（表键 `goalSetBudget`，`tasks.goalSetBudget(taskId, tokens) => GoalRecord`），同步下发 `goal-changed`。
- 旧库迁移：`goals` 表补 `budget_tokens INTEGER`（NULL = 不限）与 `baseline_tokens INTEGER NOT NULL DEFAULT 0`（`PRAGMA table_info` 探测后 `ALTER TABLE`，重开幂等）。既有目标读回为「未设预算」——预算护栏对升级前的目标不生效。

### 界面对接面

- 进度行：`GoalProgressRow` 新增 prop `spentTokens`（目标用量 = `goalSpentTokens(goal, taskUsageTokens(current))`，`WorkspacePage` 从任务列表取）；行内只有一个挂载点 `<GoalBudgetControl>`（在累计时长之后）。`pauseReason` 的语义扩为「停留原因」：`goalPauseReason` 对未达成返回「连续 N 轮判定未过且无实质工具活动」、对预算受限返回「目标用量已达到 token 预算」。
- testid：`goal-budget-trigger`（带 `data-over`）、`goal-budget-spent`、`goal-budget-limit`、`goal-budget-add`、`goal-budget-editor`、`goal-budget-input`、`goal-budget-save`、`goal-budget-cancel`、`goal-budget-quick-add`、`goal-budget-error`。
- 标记行不变：阻断轮仍显示「第 N 次迭代 · 未完成 · 下一步」，阻断原因由进度行承载（票 03 的口径）。
- 用量显示取任务列表的最新账目，靠既有的目标事件 → `refreshTasks` 触发链刷新（每轮判定之后更新一次）。

### 写给票 04（控制面）——边界与衔接点

- **本票没有实现任何按钮组**（暂停 / 恢复 / 编辑 / 清除都归你）。进度行只多了一个 prop 与一行挂载点（在累计时长之后），`WorkspacePage` 只多了两处导入与一个 prop。
- 恢复按钮须对「预算受限」「未达成」可用：恢复 = `goals.transition(taskId, "resume")` → `goals.continueTurn(taskId, { kind: "resume" })`，接缝已有用例锁定（`goal-orchestrator.test.ts`「预算受限后加预算并恢复」：加预算后恢复续跑、下一轮不再受限；对照：不加预算就恢复会立刻再次受限）。
- **「预算受限 → 加预算 → 恢复 → 续跑」的 e2e 整条腿没有走**：你合入时我这边还没有恢复入口。现状覆盖：e2e 走到「预算受限 → 一键加预算 → 停留状态不变 → 重启保持」；恢复后的续跑由编排器接缝用例与宿主 IPC 用例覆盖。**请票 07 回归时补走这条腿**。
- 「改目标后恢复」同理：编辑入口在你那边；状态机的 `resume` 不关心目标文本是否改过。
- `goalPauseReason(goal)` 现在对未达成 / 预算受限也返回原因——如果你的按钮布局读 `pauseReason`，注意它不再只属于「已暂停」。
- 加预算后不发本地命令反馈（预算显示本身就是即时反馈）；如果你想配 toast，`GoalBudgetControl` 的 `setBudget` prop 是可注入的变更入口。

### 写给票 06（重启恢复）

- **重启时「预算受限」「未达成」必须原样保持，不得被恢复链路改成已暂停**：启动收尾只把 `active` 转 `paused`。这两个是护栏给出的停留态，原因（`idleStreak = 3` / 预算）要留着给用户看；改成已暂停会把「为什么停了」抹掉。
- 随目标落库、重启不需要动的：`budgetTokens`、`baselineTokens`、两个连续计数、逐轮验证记录。重启后目标用量显示 = 任务用量账目（已落库）− 基线，无需重算（e2e 的重启段已验证：「预算受限」与「未达成」原样保持、预算与用量可读）。
- 本票 e2e 两个场景的重启段是在你的恢复链路落地**之前**验证的（当前重启后非进行中的目标本就不变），你改恢复链路后请把这两个场景重跑一遍。

### 写给票 07（收口）——需同步进 GLOSSARY / ADR / README 的护栏措辞

- ADR 0035「护栏」一句可细化为：token 预算是**目标级参数**（进度行上设定，缺省不限；`/goal` 不带预算）；消耗 = 目标设定以来任务用量账目的增量（设定时拍基线，含主任务、子代理、压缩与判定自身）；对账在每轮判定之后，达到预算 → 预算受限（非终止）；连续 3 轮判定未过且无实质工具活动 → 未达成。
- 「实质工具活动」的口径需要落文档：**只认实际执行了的调用**（被拒绝 / 参数无效 / 未注册的不算；执行出错仍算；`update_plan` 除外）。
- 处置优先序（建议写进 ADR 或 GLOSSARY「目标模式」）：完成 > 判定连续不可用暂停 > 未达成 > 预算受限。
- 空转阈值 3 是规格定值、不做成配置项（常量 `GOAL_MAX_IDLE_ROUNDS`，与 `GOAL_MAX_VERIFICATION_FAILURES` 并列）。
- 「用量达到预算即超」（`≥`）与「完成优先于预算」是本票的细化，ADR 里没有，核对时请注明。
- README 功能清单的护栏一句话（随你的收口票）。
- 全量链尾新增两个场景：`goal-budget.mjs`、`goal-idle.mjs`（README 索引第 38、39 行）。

### 验收自证

| 验收项                                                    | 证据                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 预算超限 → 预算受限；进度行与标记行口径正确，不误伤正常轮 | desktop `goal-guardrails-ipc`「目标用量达到预算 → 「预算受限」…」（越线轮的回复与判定完整留痕、原因事件序、不再续跑）「达到预算的那一轮判定通过 → 已完成」「对账基线：目标设定之前任务的用量不计入」；编排器接缝「token 预算」「完成优先于预算」；ui `goal-progress-row-ui`「护栏阻断的停留原因」、`workspace-goal-ui`「预算受限：…」；e2e `goal-budget` |
| 子代理与压缩计入对账（口径 = 任务用量，含跨轮累计）       | agent-core `goal-guardrails`「主任务各轮、子代理、压缩与完成判定自身的用量都计入目标消耗」（四轮对话 + 真实 `task.compact` + 真实 `verifyGoal` + 子代理列入账，账目手算 3510）；desktop「对账口径 = 任务用量账目（主任务列 + 子代理列），跨轮累计」                                                                                                      |
| 加预算或改目标后可恢复续跑                                | desktop「预算受限态直接加预算：…恢复后续跑按新预算对账」、`goal-set-budget` 两条；编排器接缝「加预算 → 状态机恢复 → continueTurn…」及对照用例；e2e `goal-budget`（加预算与重启保持；恢复腿留票 07）                                                                                                                                                      |
| 连续 3 空轮 → 未达成并呈现原因；有活动的未过轮清零        | desktop「第 3 轮空转 → 「未达成」…」「有实质工具活动的未过轮清零空转计数，不误触」「判定不可用的轮次不参与空转判定」「被用户拒绝…」「参数无效与不存在…」；编排器接缝「空转阻断」；ui `goal-guardrails-view`；e2e `goal-idle`                                                                                                                             |
| 未设预算不受影响                                          | desktop「未设预算 = 不限」；编排器接缝「未设预算 = 不限」；agent-core `isGoalBudgetExceeded` 用例                                                                                                                                                                                                                                                        |
| desktop 单测绿                                            | `goal-guardrails-ipc`（13）、`goal-orchestrator`（16，含新增 7）                                                                                                                                                                                                                                                                                         |
| e2e 两场景                                                | `goal-budget.mjs`、`goal-idle.mjs`（各 3 跑 3 绿）                                                                                                                                                                                                                                                                                                       |

### 验证记录

- 单测：agent-core 753（基线 744）、desktop 651 + 1 skipped（基线 626 + 1）、ui 803（基线 782），全绿；`pnpm -r run typecheck` 0 错；`pnpm lint` 0 error（9 条既有 warning，均在未触碰的文件）；`check:adr`、`check:e2e-locators`（55 个场景文件）通过。
- e2e（2026-11-26，**桌面处于锁屏**，`LogonUI` 存在）：
  - 新场景 `goal-budget` 3 跑 3 绿、`goal-idle` 3 跑 3 绿；
  - 回归绿：`goal-stub-probe`、`goal-mode`、`goal-continuation`；动了 `helpers.mjs` 的 provider 公共路径，按票 01 口径加跑 `compact`、`mcp`、`acceptance` 绿；最靠近改动面（`tool-result` 事件、循环经 `end()` 收尾）的 `smoke`、`work-plan`、`interrupt`、`live-tasks`、`input-queue` 绿。
  - **没有跑全量链 `test:e2e:all`**，也不声称全量链绿；锁屏下基线即红的六个场景（`sidebar-archive` / `task-search` / `message-order` / `process-segments` / `persistent-workbench` / `window-controls`）未追。
- 先红后绿：每条护栏规则都先有会红的测试——基线与预算字段、`setGoalBudget`、对账纯函数、旧库迁移、`isGoalToolActivity` 新定义、`tool-result` 的 `executed`、空转阻断、被拒 / 无效调用不算活动、预算阻断、`goal-set-budget` IPC、ui 停留原因 / 文案 / 解析 / 预算控件三步 / 进度行挂载 / 工作台接线、stub 的 usage 能力。
- 实现之后才补的守护用例逐组做了变异核查，确认撤掉对应实现时恰好对应用例变红：空转阈值改成 2 → 空转三条全红；撤掉空转阻断分支 → 接缝与 IPC 用例红；撤掉预算对账分支 → 接缝两条与 IPC 用例红；预算检查抢在「判定通过」之前 / 对账只读主任务列 / 未设预算当成 0 / 对账不看基线 → 各自对应用例红。空转阻断的主用例在实现后调整过结构（见踩坑点），同样以变异核查确认了最终版本敏感。
- 变异核查用的一次性脚本与取证探针均已删除，不进提交。
- 用例初版有几处错在测试自身（非实现），都已修正：预算边界用例里一行多余的断言；工具活动用例把另一个工具的副作用也计入了期望；e2e 两处观察点有时序竞争、一处期望值笔误、一处依赖会被折叠的中间回复。

### 踩坑点

- **阻断后输入队列立刻自动发出排队消息**：断言「任务回到空闲」之前得先接住排队消息的工作请求，否则 `idle` 永远等不到（任务随即进入那条消息的新回合）。
- **`usage` 在流式协议的 chunk 顶层，不在 `choices[0]` 里**：测试装配与 e2e stub 各踩一次，症状都是账目为 0 / 字段为空。
- **循环走得快，状态读取会抢在判定之后**：要观察「第 N 轮之后仍在进行」，让第 N+1 次判定在 stub 侧挂起，在「验证中」窗口里断言。
- **同一轮次分组里较早的助手回复会被折叠**：e2e 的观察点用标记行与「验证中」占位，等文本只等最新一条回复。
- **`text-accent-fg` / `bg-accent-soft` 不是存在的 Tailwind 类**（仓里 `QueueBar` 留过同坑注释）：主按钮是 `bg-accent text-on-accent hover:bg-accent-hover`。
- **非空断言留给局部常量**：一键加预算里 `goal.budgetTokens!` 在闭包中收窄不了，先取 `const limit` 再用。

### 遗留与已知限制

- **越线的那一轮不会被中途打断**（编排者裁决 4 的对账时点）：越线后最多再多花「一轮工作 + 一次判定」的用量。
- **判定请求失败时的用量不入账**（ADR 0029 尽力而为：usage 未结算记 0），这部分消耗不计入预算。
- **目标停留期间的普通对话也计入目标用量**：用量 = 任务账目 − 基线是字面口径，预算受限 / 未达成 / 已暂停时用户在同一任务里的普通消息同样入账——进度行的「用量」会继续涨，恢复后的对账也把它算进去。常见预算量级（十万级）与一键加预算的档位下不构成问题，如实记录。
- **宿主层没有跑真实的子代理 / 压缩流程**：目标进行中 `/compact` 被主进程执行检查拒绝（规格项，归票 04），宿主用例的子代理列经 `manager.addUsage`（子代理运行时的同一入账入口）入账；压缩走真实路径的证据在 agent-core 层（`task.compact` 的 usage 入主任务列并计入目标用量）。
- **e2e 没有覆盖「被拒绝的调用不算活动」的真实界面路径**（需要审批卡片的拒绝交互）；该规则由 agent-core（真实事件流）与 desktop（真实 HTTP mock）两层单测覆盖。
- **回合出错仍是直接已暂停、不重试**（票 03 转来的待定项）：不在本票七个验收项内，没有扩展。无人值守长跑里一次网络抖动会停下，若要续跑需配连续失败计数防死循环——建议票 07 或后续安排。
- 旧库里升级前设定的目标基线读回 0：给这类目标设预算时，目标之前的任务用量会被算进来（只影响开发期数据）。
