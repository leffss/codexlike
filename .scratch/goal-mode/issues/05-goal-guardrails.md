# 05: 护栏：token 预算与空转阻断

**What to build:** 两道护栏。①**token 预算**（可选）：按任务用量口径（含主任务、子代理与压缩的账目式累计）逐轮对账，超限 → 「预算受限」暂停（非终止，可加预算/改目标后恢复）；未设定预算 = 不限。②**空转阻断**：连续 3 轮判定未过且无实质工具活动（票 03 的计数）→ 「未达成」暂停并呈现原因。配置入口（执行设置 vs goal 级参数）实现时定夺并在票面 Comments 记录决策。

**Blocked by:** 03

**Status:** ready-for-agent

**上下文指针:** `.scratch/goal-mode/spec.md`（护栏段）、`.scratch/goal-mode/notes.md`（执行设置 toolRoundsLimit 先例、任务用量口径 GLOSSARY 词条）

- [ ] 预算超限 → 「预算受限」暂停：进度行与标记行口径正确，不误伤正常轮
- [ ] 子代理与压缩的 token 计入对账（口径 = 任务用量，含跨轮累计）
- [ ] 加预算或改目标后可从「预算受限」恢复续跑
- [ ] 连续 3 空轮 → 「未达成」暂停并呈现原因；有实质工具活动的未过轮清零计数（不误触）
- [ ] 未设预算的目标不受预算护栏影响（默认不限）
- [ ] desktop 单测绿：对账、空转计数消费、两阻断态转换与恢复
- [ ] e2e 两场景实跑绿：预算受限、空转未达成

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
