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
- **ui**：`src/components/GoalBudgetControl.tsx`（新，独立组件）、`GoalProgressRow.tsx`（一个 prop 与预算控件的挂载点；并入票 04 后位于只读播报区之后、按钮组之前，编辑态同样保留）、`src/lib/goal-view.ts`（`goalPauseReason` 扩展、`formatGoalTokens`、`parseGoalBudgetInput`）、`pages/WorkspacePage.tsx`（两处导入 + 一个 prop）、`dev/browser-stub.ts`。
- **e2e**：`e2e/goal-budget.mjs`（`pnpm test:e2e:goal-budget`；含恢复腿——加预算 → 显式恢复 → 按新预算不再受限 → 续跑到已完成）、`e2e/goal-idle.mjs`（`pnpm test:e2e:goal-idle`），已追加到 `test:e2e:all` 链尾；并入票 04 后链尾顺序为 `goal-controls` → `goal-budget` → `goal-idle`（e2e README 索引第 39、40 行，第 38 行是票 04 的 `goal-controls`）；`e2e/helpers.mjs` 与 `e2e/goal-stub.mjs` 的 usage 能力（见下）。
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

- 进度行：`GoalProgressRow` 新增 prop `spentTokens`（目标用量 = `goalSpentTokens(goal, taskUsageTokens(current))`，`WorkspacePage` 从任务列表取）；行内只有一个挂载点 `<GoalBudgetControl>`——在只读的状态播报区（`role="status"`）之外、按钮组 `goal-controls` 之前（live region 不含可聚焦控件），编辑态（`goal-edit-form`）下同样保留。`pauseReason` 的语义扩为「停留原因」：`goalPauseReason` 对未达成返回「连续 N 轮判定未过且无实质工具活动」、对预算受限返回「目标用量已达到 token 预算」；并入票 04 后 `WorkspacePage` 传的是 `goalPauseReason(goal) ?? goalPauseNote`（按状态推导的原因优先，其次才是宿主随快照下发的暂停说明）。
- testid：`goal-budget-trigger`（带 `data-over`）、`goal-budget-spent`、`goal-budget-limit`、`goal-budget-add`、`goal-budget-editor`、`goal-budget-input`、`goal-budget-save`、`goal-budget-cancel`、`goal-budget-quick-add`、`goal-budget-error`。
- 标记行不变：阻断轮仍显示「第 N 次迭代 · 未完成 · 下一步」，阻断原因由进度行承载（票 03 的口径）。
- 用量显示取任务列表的最新账目，靠既有的目标事件 → `refreshTasks` 触发链刷新（每轮判定之后更新一次）。

### 并入票 04：合并决定

两票同基线并行开发，票 04 先合入集成分支（`555bc4c` / `53b718a`），本票后合入：先把本票的实现单独提交（`64accb1`，保护工作），再 `git merge feat/goal-mode`，14 个冲突文件由本票解决，合并提交 `a1ca6f3`。原则是**两边的实现与用例全部保留**，逐项决定如下：

- **编排器**（`goal-orchestrator.ts`）：只有类型区冲突——票 04 的 `GoalContinueResult` 与本票的 `GoalBlockReason` 并列保留。`afterTurn` 判定之后的逻辑票 04 没碰，两道护栏原样在其位；票 04 提为工厂内局部函数的 `continueTurn`（返回发起结局）、`resume` / `edit` 接缝、带说明的暂停（`applyTransition` / `pauseIfActive` 的 `pauseReason`）原样保留，公开接缝 `transition(taskId, change)` 的签名不变。
- **进度行**（`GoalProgressRow.tsx`）：以票 04 的版本为底，只叠本票的增量——`spentTokens` prop 与 `<GoalBudgetControl>` 的挂载点。位置按票 04 票面的提示：只读状态播报区（`role="status"`）之外、按钮组之前；编辑态同样保留（预算受限时改目标文本与加预算是并行的两件事）。票 04 的按钮组、行内编辑、已清除不渲染都原样保留。
- **工作台**（`WorkspacePage.tsx`，git 自动合并）：进度行同时带票 04 的 `controls` 与本票的 `spentTokens`；**停留原因保持「按状态推导」**（票 04 给的两条路里的 (a)）：`pauseReason={goalPauseReason(goal) ?? goalPauseNote}`，没有改用快照携带，两种原因同时存在时按状态推导的优先。
- **IPC 表 / preload / 主进程 handler**：取并集，顺序 `goalSet` → `goalResume` / `goalEdit` / `goalClear` → `goalSetBudget`。
- **e2e 登记**：`test:e2e:all` 链尾 `goal-controls` → `goal-budget` → `goal-idle`；e2e README 索引第 38 行 `goal-controls`、第 39 行 `goal-budget`、第 40 行 `goal-idle`（本票此前写的「第 38、39 行」随之更正）。
- **测试**：编排器接缝测试的替身取并集（`setGoalBudget` / `editGoal` / `verifyGoal` / `goalVerifications`，`list` 带用量账目），两票新增的用例组都完整保留；测试装配同时支持 usage（本票）与 `json`（票 04）；dev 替身的目标记录统一经票 04 的 `devGoal` 生成并补全 `budgetTokens / baselineTokens`；票 04 新增用例里的 `GoalRecord` 字面量在合并时补了这两个必填字段（单测运行时不报，typecheck 才报）。
- agent-core（`index.ts` 根出口、`manager.ts` 的 `setGoalBudget` 与 `editGoal`）是「两边各加」的冲突，全部保留。

### 写给票 04（控制面）——边界与衔接结果

- **本票没有实现任何按钮组**（暂停 / 恢复 / 编辑 / 清除都归票 04）。进度行只多了预算控件这一个挂载点，`WorkspacePage` 只多了两处导入与一个 prop。
- **恢复腿已在真实应用里走通**（此前写的「恢复腿留票 07」作废）：`goal-budget` 场景在「预算受限 → 一键加预算（停留状态不变）→ 重启后预算受限原样保持」之后接着走——点进度行的恢复按钮（`goal-resume`，走 `tasks:goal-resume`，本地命令反馈「目标已恢复」）→ 从暂停点续跑（不产生用户气泡）→ 该轮判定未过，但目标用量按新预算对账、不再受限 → 续跑一轮 → 判定通过 → 已完成。合并后预算受限态的按钮矩阵（恢复可用、可编辑、可清除、无暂停）也在该场景里断言。
- **加预算不自动恢复**：预算受限的目标加预算后仍是「预算受限」，恢复由用户显式发起——与票 04 的恢复入口是两个动作，接缝上没有耦合。
- 「改目标后恢复」：编辑入口在票 04（预算受限 / 未达成可编辑）；状态机的 `resume` 不关心目标文本是否改过，走的是同一条恢复路径（`goal-controls` 场景覆盖「编辑后恢复」）。
- 接缝层证据仍在：`goal-orchestrator.test.ts`「预算受限后加预算并恢复」（加预算后恢复续跑、下一轮不再受限；对照：不加预算就恢复会立刻再次受限）。
- 加预算后不发本地命令反馈（预算显示本身就是即时反馈）；`GoalBudgetControl` 的 `setBudget` prop 是可注入的变更入口。

### 写给票 06（重启恢复）

- **重启时「预算受限」「未达成」必须原样保持，不得被恢复链路改成已暂停**：启动收尾只把 `active` 转 `paused`。这两个是护栏给出的停留态，原因（`idleStreak = 3` / 预算）要留着给用户看；改成已暂停会把「为什么停了」抹掉。
- 随目标落库、重启不需要动的：`budgetTokens`、`baselineTokens`、两个连续计数、逐轮验证记录。重启后目标用量显示 = 任务用量账目（已落库）− 基线，无需重算（e2e 的重启段已验证：「预算受限」与「未达成」原样保持、预算与用量可读）。
- **恢复入口在重启后与会话内是同一条**：`goal-budget` 场景的重启段之后接着点恢复按钮续跑到已完成（并入票 04 后补的恢复腿）。你把启动收尾改成「进行中 → 已暂停」时不要碰到「预算受限」「未达成」这两态的恢复路径。
- 本票 e2e 两个场景的重启段是在你的恢复链路落地**之前**验证的（当前重启后非进行中的目标本就不变），你改恢复链路后请重跑：链尾现在有三个新场景 `goal-controls`（票 04）/ `goal-budget` / `goal-idle`（e2e README 索引第 38–40 行），单跑分别是 `pnpm test:e2e:goal-controls`、`test:e2e:goal-budget`、`test:e2e:goal-idle`。

### 写给票 07（收口）——需同步进 GLOSSARY / ADR / README 的护栏措辞

- ADR 0035「护栏」一句可细化为：token 预算是**目标级参数**（进度行上设定，缺省不限；`/goal` 不带预算）；消耗 = 目标设定以来任务用量账目的增量（设定时拍基线，含主任务、子代理、压缩与判定自身）；对账在每轮判定之后，达到预算 → 预算受限（非终止）；连续 3 轮判定未过且无实质工具活动 → 未达成。
- 「实质工具活动」的口径需要落文档：**只认实际执行了的调用**（被拒绝 / 参数无效 / 未注册的不算；执行出错仍算；`update_plan` 除外）。
- 处置优先序（建议写进 ADR 或 GLOSSARY「目标模式」）：完成 > 判定连续不可用暂停 > 未达成 > 预算受限。
- 空转阈值 3 是规格定值、不做成配置项（常量 `GOAL_MAX_IDLE_ROUNDS`，与 `GOAL_MAX_VERIFICATION_FAILURES` 并列）。
- 「用量达到预算即超」（`≥`）与「完成优先于预算」是本票的细化，ADR 里没有，核对时请注明。
- README 功能清单的护栏一句话（随你的收口票）。
- **全量链尾新增三个场景**（并入票 04 后的顺序）：`goal-controls.mjs`（票 04）、`goal-budget.mjs`（本票，含恢复腿）、`goal-idle.mjs`（本票）；e2e README 索引第 38、39、40 行。本票此前写的「第 38、39 行」已更正。
- **`goal-budget` 的恢复腿已在本票走通**（加预算 → 显式恢复 → 按新预算不再受限 → 续跑到已完成），不需要再补走；此前「恢复腿留票 07」的说法作废。
- 两票合并后的一处呈现口径可一并核对：进度行的停留原因（`goal-progress-reason`）现在统一承载四种来源——完成判定连续不可用而暂停、护栏阻断为未达成 / 预算受限（按状态推导，`goalPauseReason`）、下一轮没能发起而暂停（宿主随快照下发的 `goalPauseNote`，票 04 追加 C）；前三种优先于最后一种。

### 验收自证

| 验收项                                                    | 证据                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 预算超限 → 预算受限；进度行与标记行口径正确，不误伤正常轮 | desktop `goal-guardrails-ipc`「目标用量达到预算 → 「预算受限」…」（越线轮的回复与判定完整留痕、原因事件序、不再续跑）「达到预算的那一轮判定通过 → 已完成」「对账基线：目标设定之前任务的用量不计入」；编排器接缝「token 预算」「完成优先于预算」；ui `goal-progress-row-ui`「护栏阻断的停留原因」、`workspace-goal-ui`「预算受限：…」；e2e `goal-budget` |
| 子代理与压缩计入对账（口径 = 任务用量，含跨轮累计）       | agent-core `goal-guardrails`「主任务各轮、子代理、压缩与完成判定自身的用量都计入目标消耗」（四轮对话 + 真实 `task.compact` + 真实 `verifyGoal` + 子代理列入账，账目手算 3510）；desktop「对账口径 = 任务用量账目（主任务列 + 子代理列），跨轮累计」                                                                                                      |
| 加预算或改目标后可恢复续跑                                | desktop「预算受限态直接加预算：…恢复后续跑按新预算对账」、`goal-set-budget` 两条；编排器接缝「加预算 → 状态机恢复 → continueTurn…」及对照用例；e2e `goal-budget`（加预算 → 重启保持预算受限 → 显式恢复 → 按新预算不再受限 → 续跑到已完成）；票 04 的 `goal-controls-ipc`「恢复」组经真实 IPC 覆盖预算受限 / 未达成的恢复                                 |
| 连续 3 空轮 → 未达成并呈现原因；有活动的未过轮清零        | desktop「第 3 轮空转 → 「未达成」…」「有实质工具活动的未过轮清零空转计数，不误触」「判定不可用的轮次不参与空转判定」「被用户拒绝…」「参数无效与不存在…」；编排器接缝「空转阻断」；ui `goal-guardrails-view`；e2e `goal-idle`                                                                                                                             |
| 未设预算不受影响                                          | desktop「未设预算 = 不限」；编排器接缝「未设预算 = 不限」；agent-core `isGoalBudgetExceeded` 用例                                                                                                                                                                                                                                                        |
| desktop 单测绿                                            | `goal-guardrails-ipc`（13）、`goal-orchestrator`（19，含本票新增 7）                                                                                                                                                                                                                                                                                     |
| e2e 两场景                                                | `goal-budget.mjs`（含恢复腿）、`goal-idle.mjs`（各 3 跑 3 绿）                                                                                                                                                                                                                                                                                           |

### 验证记录

- 单测与静态检查（2026-11-26，**并入票 04 之后从头重跑**；被中断那一轮与合并之前的检查结果按编排者要求全部作废、不沿用）：先重建 agent-core dist，再逐包跑——agent-core 764（基线 744；本票 +9、票 04 +11）、desktop 681 + 1 skipped（基线 626 + 1；本票 +25、票 04 +30）、ui 847（基线 782；本票 +21、票 04 +44），退出码全 0；每包都等于「基线加两票新增之和」，两边的用例一条未丢。`pnpm -r run typecheck` 0 错；`pnpm lint` 0 error（9 条既有 warning，均在未触碰的文件）；相对票 04 尖端的 42 个改动文件 `prettier --check` 通过；`check:e2e-locators`（56 个场景文件）与 `check:adr`（35 篇）通过；全仓 `pnpm build` 通过。
- e2e（2026-11-26，全仓 build 之后逐个实跑，每个场景是独立进程）：**24 次执行、退出码全 0**。
  - 桌面锁屏状态如实记录：实跑前查询 `LogonUI` 存在（锁屏），全部跑完后再查已不存在（解锁）——锁屏状态在这批实跑期间发生了切换，无法逐场景断定各自运行时是否锁屏。
  - 本票场景：`goal-budget`（扩展后含恢复腿）3 跑 3 绿（另有首跑 1 次绿）；`goal-idle` 3 跑 3 绿。
  - 票 04 的 `goal-controls`（合并后必须仍绿）绿。
  - 既有 goal：`goal-mode`、`goal-continuation`、`goal-stub-probe` 绿。
  - 动了 `helpers.mjs` 的 provider 公共路径，按票 01 口径加跑：`compact`、`mcp`、`acceptance` 绿。
  - 最靠近改动面（`tool-result` 事件、循环经 `end()` 收尾、停止按钮）：`interrupt`、`live-tasks`、`smoke`、`work-plan` 绿。
  - 链外：输入队列族五个（`input-queue` / `-items` / `-pause` / `-composer` / `-restart`）、`task-queue-restart`、`exit-recovery` 绿。
  - **没有跑全量链 `test:e2e:all`**，也不声称全量链绿；锁屏下基线即红的六个场景（`sidebar-archive` / `task-search` / `message-order` / `process-segments` / `persistent-workbench` / `window-controls`）未跑。
- 先红后绿：每条护栏规则都先有会红的测试——基线与预算字段、`setGoalBudget`、对账纯函数、旧库迁移、`isGoalToolActivity` 新定义、`tool-result` 的 `executed`、空转阻断、被拒 / 无效调用不算活动、预算阻断、`goal-set-budget` IPC、ui 停留原因 / 文案 / 解析 / 预算控件三步 / 进度行挂载 / 工作台接线、stub 的 usage 能力。
- 实现之后才补的守护用例逐组做了变异核查，确认撤掉对应实现时恰好对应用例变红：空转阈值改成 2 → 空转三条全红；撤掉空转阻断分支 → 接缝与 IPC 用例红；撤掉预算对账分支 → 接缝两条与 IPC 用例红；预算检查抢在「判定通过」之前 / 对账只读主任务列 / 未设预算当成 0 / 对账不看基线 → 各自对应用例红。空转阻断的主用例在实现后调整过结构（见踩坑点），同样以变异核查确认了最终版本敏感。
- 变异核查用的一次性脚本与取证探针均已删除，不进提交。
- 并入票 04 之后补的 e2e 恢复腿是在实现已存在之后加的，同样做了变异核查：让主进程拒绝预算受限目标的恢复 → 场景前六段照常通过、在恢复腿精确变红（「目标已恢复」的反馈不出现，请求时序里没有恢复后的续跑轮）；撤掉变异（源码与提交版本逐字一致、全仓重建）后 3 跑 3 绿。
- 用例初版有几处错在测试自身（非实现），都已修正：预算边界用例里一行多余的断言；工具活动用例把另一个工具的副作用也计入了期望；e2e 两处观察点有时序竞争、一处期望值笔误、一处依赖会被折叠的中间回复。

### 踩坑点

- **阻断后输入队列立刻自动发出排队消息**：断言「任务回到空闲」之前得先接住排队消息的工作请求，否则 `idle` 永远等不到（任务随即进入那条消息的新回合）。
- **`usage` 在流式协议的 chunk 顶层，不在 `choices[0]` 里**：测试装配与 e2e stub 各踩一次，症状都是账目为 0 / 字段为空。
- **循环走得快，状态读取会抢在判定之后**：要观察「第 N 轮之后仍在进行」，让第 N+1 次判定在 stub 侧挂起，在「验证中」窗口里断言。
- **同一轮次分组里较早的助手回复会被折叠**：e2e 的观察点用标记行与「验证中」占位，等文本只等最新一条回复。
- **`text-accent-fg` / `bg-accent-soft` 不是存在的 Tailwind 类**（仓里 `QueueBar` 留过同坑注释）：主按钮是 `bg-accent text-on-accent hover:bg-accent-hover`。
- **非空断言留给局部常量**：一键加预算里 `goal.budgetTokens!` 在闭包中收窄不了，先取 `const limit` 再用。
- **长行冲突替换时别丢行首的公共部分**：`packages/desktop/package.json` 的 `test:e2e:all` 是一整行长命令，解决冲突时替换文本只写了链尾、把行首的 `"test:e2e:all": "node … &&` 弄丢了，直到 `pnpm` 报 manifest 解析失败才发现。解决完冲突先让 `node -e "JSON.parse(...)"` 过一遍，并与自己提交里的那一行逐字对比（只应差出对方新增的那一段）。
- **以对方版本为底叠自己的增量时，用 `git diff <对方尖端> -- <文件>` 反查**：被删掉的行应当只有有意改写的几处——靠这一步发现替换时带掉了对方写在 `goalSet` 上方的两行注释。
- **新增必填字段要让并行分支的夹具补上**：并入后 typecheck 报对方新增用例里的 `GoalRecord` 字面量缺 `budgetTokens / baselineTokens`——单测在运行时不报，typecheck 才报。

### 遗留与已知限制

- **越线的那一轮不会被中途打断**（编排者裁决 4 的对账时点）：越线后最多再多花「一轮工作 + 一次判定」的用量。
- **判定请求失败时的用量不入账**（ADR 0029 尽力而为：usage 未结算记 0），这部分消耗不计入预算。
- **目标停留期间的普通对话也计入目标用量**：用量 = 任务账目 − 基线是字面口径，预算受限 / 未达成 / 已暂停时用户在同一任务里的普通消息同样入账——进度行的「用量」会继续涨，恢复后的对账也把它算进去。常见预算量级（十万级）与一键加预算的档位下不构成问题，如实记录。
- **宿主层没有跑真实的子代理 / 压缩流程**：目标进行中 `/compact` 被拒绝（规格项，票 04 已落地：提示先暂停目标），宿主用例的子代理列经 `manager.addUsage`（子代理运行时的同一入账入口）入账；压缩走真实路径的证据在 agent-core 层（`task.compact` 的 usage 入主任务列并计入目标用量）。
- **e2e 没有覆盖「被拒绝的调用不算活动」的真实界面路径**（需要审批卡片的拒绝交互）；该规则由 agent-core（真实事件流）与 desktop（真实 HTTP mock）两层单测覆盖。
- **回合出错仍是直接已暂停、不重试**（票 03 转来的待定项）：不在本票七个验收项内，没有扩展。无人值守长跑里一次网络抖动会停下，若要续跑需配连续失败计数防死循环——建议票 07 或后续安排。
- 旧库里升级前设定的目标基线读回 0：给这类目标设预算时，目标之前的任务用量会被算进来（只影响开发期数据）。
