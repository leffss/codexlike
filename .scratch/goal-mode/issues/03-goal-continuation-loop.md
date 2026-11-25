# 03: 续跑循环：判定未过自动续跑

**What to build:** 判定未通过时目标自动续跑：verifier 的下一步方向（nextAction）作为内部输入发起下一轮（消息流**不产生用户气泡**），轮内工具照常（工作计划、子代理可用，单回合工具轮次上限 200 照旧）；每轮判定后消息流落完整标记行——「第 N 次迭代 · 验证中 / 已完成 / 未完成」，未完成附下一步方向一句摘要。连续多轮后判定通过 → 已完成，全部标记行留痕可回看。空转计数逐轮记账（连续未过且无实质工具活动），阻断逻辑在票 05。

**Blocked by:** 02

**Status:** done

**上下文指针:** `.scratch/goal-mode/spec.md`（续跑循环、完成判定契约）、`.scratch/goal-mode/notes.md`（标记行先例 PlanMarkerRow、PLAN_USAGE_POLICY 并存说明）

- [x] 判定未过 → 自动发起下一轮；nextAction 进入续跑指令；续跑轮不产生用户气泡
- [x] 逐轮标记行完整：验证中 → 已完成/未完成三态，未完成含下一步方向摘要
- [x] 多轮（≥2 轮未过）后通过 → 已完成，全部标记行与验证记录留痕可回看
- [x] 轮内工具照常：工作计划可在续跑轮内更新、子代理可委派、审批等待照旧（waiting-approval 处理完毕回到循环）
- [x] 空转计数逐轮落库（供票 05 消费）：判定未过且无实质工具活动计 1，有活动清零
- [x] 对话型（非任务型）目标判定直接通过的引导生效（单测或 e2e 覆盖）
- [x] desktop 单测绿：多轮续跑编排流转、中断后不重复续跑
- [x] e2e 多轮续跑场景实跑绿（脚本化 ≥2 轮未过后通过；stub 两线见票 01）
- [x] （编排者追加）fail-open 定案：验证记录区分「判定正常给出未过」与「判定自身故障」（保留 `passed` 兼容字段）；故障轮目标继续续跑、续跑指令如实告知判定不可用、不计入空转计数；连续 3 轮故障 → 转已暂停且原因对用户可见；出现正常结论后连续计数清零，恢复时亦清零；任何情况下故障不判为通过、不导致「未达成」；标记行对故障轮如实呈现
- [x] （编排者追加）输入队列互锁是 `isBusy` 里的显式条件（不再依赖执行登记持有）；有单测真实到达「目标进行中且任务空闲（轮间窗口）」并断言队首不被取走
- [x] （编排者追加）「验证中」副状态不得让侧栏显示空闲：判定在途与轮间窗口期间，任务在侧栏与运行口径上都呈现为执行中

## Comments

（写给票 04（控制面）、票 05（护栏）、票 06（重启恢复）与票 07（收口）的衔接说明，2026-11-25 票 03 实现轮。各下游票的专项要点已分别抄入其票面 Comments，这里记本票的全貌。）

### 交付物

- **agent-core**：`src/goal/continuation.ts`（新）——续跑指令构造 `buildGoalContinuationInput`、「实质工具活动」判据 `isGoalToolActivity`、发起依据类型 `GoalContinuationBasis`；`src/goal/types.ts`——结论种类 `GoalVerificationOutcome`、阈值常量 `GOAL_MAX_VERIFICATION_FAILURES`、目标记录上的两个连续计数；`src/goal/verifier.ts`——`unavailableGoalVerdict` 取代票 02 的 `failOpenGoalVerdict`（不再编造下一步方向），请求结局类型改名 `GoalVerdictResult`；`src/goal/state-machine.ts`——恢复时连续计数清零；`src/task/manager.ts`——`verifyGoal` 逐轮记账；`src/task/persistence.ts`——两张目标表加列与旧库迁移；`src/task/agent-task.ts`——`sendMessage` 的内部输入与 compact 对续跑指令的保留；`src/task/types.ts`——消息角色与事件 `goal-continuation`；`src/git/commit-message.ts`——提交消息生成排除续跑指令。
- **desktop**：`src/tasks/goal-orchestrator.ts`（续跑循环的决策与循环存活状态）、`src/tasks/task-ipc.ts`（续跑轮的发起、显式互锁守卫、活动态叠加、轮间窗口的停止）、`src/tasks/task-management.ts`（执行态含目标循环）、`src/tasks/live-tasks.ts` 与 `src/shared/ipc.ts`（`goal-verifying` 事件、`TaskActivity.goalPhase`）、`src/tasks/status.ts`（上下文估算计入续跑指令）。
- **ui**：`src/lib/goal-view.ts`、`src/lib/task-view.ts`、`src/lib/live-task.ts`、`src/components/GoalVerificationMarker.tsx`、`src/components/GoalProgressRow.tsx`、`src/components/MessageStream.tsx`、`src/pages/WorkspacePage.tsx`。
- **e2e**：`e2e/goal-continuation.mjs`（`pnpm test:e2e:goal-continuation`，已追加到 `test:e2e:all` 链尾，README 索引第 37 行）。
- **单测**：agent-core `tests/task/goal-continuation.test.ts`（21 条），另在 `goal.test.ts` / `sqlite-store.test.ts` 增补；desktop `tests/tasks/goal-harness.ts`（从 `goal-ipc.test.ts` 抽出的共用装配）、`goal-continuation-ipc.test.ts`（16 条）、`goal-orchestrator.test.ts`（9 条）、`goal-ipc.test.ts`（改用共用装配，11 条）、`status.test.ts`（+1）；ui `tests/goal-continuation-view.test.ts`（10 条）、`goal-marker-ui`（5 → 7 条）、`goal-progress-row-ui`（+2）、`workspace-goal-ui`（+4）。

### 续跑循环的结构

- **每一轮回合是一次独立的宿主执行**（各自的执行登记、中断通道与事件现场；事件日志仍只留最后一轮）。循环靠 idle 边界串起来：回合收尾 → `goals.afterTurn`（完成判定与处置）→ `end()`（注销上一轮的执行登记）→ `goals.continueTurn`（以内部输入发起下一轮）。
- **续跑轮是内部输入**：`task.sendMessage({ …, goalContinuation: true })`。指令进入模型上下文（user 角色）并随任务落库为 `goal-continuation` 角色，但以 `goal-continuation` 事件开头、不发 `user-message`——消息流不产生用户气泡，续跑轮的回复与工具照常成段并归入目标所在的轮次（用户只说过一次话）。重启恢复与压缩都保留它。
- **循环存活状态**（`goals.isRunning(taskId)`）是 desktop 进程内存里的一张表，只在两种场合开始存活：目标进行中的任务开始一轮回合（`turnStarted`，首轮与每个续跑轮同此），以及恢复（`continueTurn`）。目标离开进行中即结束。
- **接缝**（下游直接复用）：
  - `goals.continueTurn(taskId, basis)`——发起下一轮。`basis` 为 `{ kind: "verification", verification }`（判定未过 / 不可用）或 `{ kind: "resume" }`（票 04 的恢复）。
  - `goals.transition(taskId, change)`——推进状态机 + 结束循环存活状态 + 下发 `goal-changed`。票 04 的清除、票 05 的未达成 / 预算受限经此。
  - `goals.pause(taskId)`——进行中转已暂停（幂等）。
  - 预算检查的建议挂点在 `afterTurn` 内判定之后（详见票 05 票面）。

### 行为定案（覆盖票 02 的过渡行为）

- **判定未过 → 续跑**（票 02 为转已暂停）。判定未过与判定不可用都续跑。
- **fail-open 定案**（编排者裁决 1）：见上方追加验收项。连续故障阈值 `GOAL_MAX_VERIFICATION_FAILURES = 3`；达到阈值时编排器把目标转已暂停，原因经两条路对用户可见——标记行「第 N 次迭代 · 判定不可用」（原因在悬停提示里）与进度行的暂停原因「完成判定连续 3 次不可用」。
- **输入队列互锁**（裁决 2）：`input-queue` 的 `isBusy` = 退出冻结 ∨ 真实在途执行（登记 / 任务状态 / 待回应交互）∨ 任务排队中 ∨ **目标循环在进行**（显式条件）。管理规则的执行态（`management.execution`）另把目标循环算作「执行中」，供其余消费方（并发占席、归档保护、直发入队判定、退出屏障的 `hasWork`）统一取用。续跑轮自己发起时越过这一条（`assertCanExecute` 的 `forGoalLoop`），且不占新席。
- **运行口径**（裁决 3）：`activityOf` 在目标循环进行中把任务叠加为执行中，判定在途另带 `goalPhase: "verifying"`。回合的终态事件本身也带着运行中的活动态——循环存活状态在回合开始时就登记，终态事件到 idle 边界之间没有空闲空窗。
- **中断语义**：续跑轮进行中 Stop → 已暂停；判定在途被中断 → 不留结论、已暂停；两轮之间点 Stop → 直接已暂停，待发起的续跑轮作废（`tasks:interrupt` handler 在没有在途回合时调 `goals.pause`）；续跑轮出错 → 不判定、已暂停；应用退出 → 目标状态原样。两轮之间点 Stop 时，输入队列按既有停止规则进入「队列暂停」、不趁停止抢发队首（补唤醒排在置暂停之后），并发名额同时让出。
- **空转计数**（只记账不阻断）：`manager.goal(taskId).idleStreak`。判定未过且无实质工具活动 +1；有活动清零；通过清零；判定不可用保持原值；恢复清零。
- **「实质工具活动」定义**：一轮之内除 `update_plan` 外出现过任何工具调用即算有活动（只改计划不算）。宿主在 `deliverMessage` 的事件泵里按 `tool-call` 事件统计。

### 数据面变化

- `GoalRecord`：新增 `idleStreak`、`failureStreak`。
- `GoalVerificationRecord`：新增 `outcome`（`passed` / `unpassed` / `unavailable`）与 `toolActivity`；`passed` 保留为兼容字段（`unavailable` 与 `unpassed` 同为 false）。
- `MessageRole` 新增 `goal-continuation`；`TaskEvent` 新增 `goal-continuation`。
- desktop 事件信封新增 `goal-verifying { goalId, round }`；`TaskActivity` 新增可选的 `goalPhase: "verifying"`。
- 旧库迁移：两张目标表补列（`PRAGMA table_info` 探测后 `ALTER TABLE`）。票 02 时代的旧行读回时连续计数为 0，结论种类按 `passed` 与理由回推，是否有工具活动未知时按「有」计（不把历史轮次误判为空转）。
- `TaskManager.verifyGoal` 签名变为 `(taskId, { profile?, signal?, toolActivity? })`，选项整体可省。

### 用户可见文案与 testid

- 标记行：验证中 `goal-verifying-marker`（`data-goal-round`）；结论 `goal-verification-marker`（`data-goal-round`、`data-goal-verdict` = `passed` / `unpassed` / `unavailable`；下一步方向在 `goal-verification-next-step`）。可见文本：`第 N 次迭代 · 验证中` / `· 已完成` / `· 未完成 · 下一步：<方向>` / `· 判定不可用`。「验证中」占位与结论是同一行，结论到达后原位升级；目标离开进行中时未出结论的占位行撤下。
- 进度行：状态在判定在途时为「验证中」（行上 `data-goal-phase="verifying"`）；暂停原因在 `goal-progress-reason`。
- `GoalProgressRow` 的 prop：`goal`、`verifying`、`pauseReason`。

### 验收自证

| 验收项                                                 | 证据                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未过 → 自动续跑，nextAction 进续跑指令，不产生用户气泡 | desktop `goal-continuation-ipc`「判定未过 → 自动发起下一轮…」；agent-core `goal-continuation`「续跑轮不发 user-message…」「重启等价…」；ui `goal-continuation-view`「goal-continuation 事件不产生用户段…」、`workspace-goal-ui`「续跑轮不产生用户气泡…」；e2e `goal-continuation` 第 3、4 段 |
| 标记行三态与下一步方向摘要                             | ui `goal-continuation-view`（文案 + 原位升级）、`goal-marker-ui`（验证中 / 未完成 / 判定不可用 / 多轮留痕）、`workspace-goal-ui`「验证中：…」；desktop `goal-ipc`「编排器单次流转…」的事件序含 `goal-verifying`；e2e 第 2–5 段                                                               |
| 多轮后通过 → 已完成，留痕可回看                        | desktop「多轮（≥2 轮未过）后判定通过…」；ui `goal-marker-ui`「多轮判定各留一行」「重启恢复…」；e2e 第 5、7、8 段（重启后三行标记由落库数据恢复）                                                                                                                                             |
| 轮内工具照常（计划 / 子代理 / 审批等待回到循环）       | agent-core「轮内工具照常…」「审批等待照旧…」「子代理可在续跑轮内委派…」；desktop「轮内工具照常：续跑轮里可更新工作计划、调用需审批的工具…」                                                                                                                                                  |
| 空转计数逐轮落库                                       | desktop「空转计数逐轮落库：未过且无实质工具活动逐轮 +1；只改计划不算活动；有实质工具活动清零」；agent-core「空转计数…」「故障轮…」「连续计数随目标落库…」「恢复后连续计数从 0 起算…」；`sqlite-store`「连续计数随目标记录读写…」                                                             |
| 对话型目标引导                                         | agent-core「对话型目标的判定引导…」（对实际发出的判定请求做结构性断言；该引导自票 02 已存在，本条是补覆盖）                                                                                                                                                                                  |
| desktop 单测绿                                         | `goal-continuation-ipc`（16）、`goal-orchestrator`（9）、`goal-ipc`（11），含「中断后不重复续跑」五种中断情形（续跑轮在途 Stop、判定在途被中断、轮间窗口 Stop、轮间窗口 Stop 且有排队消息、续跑轮出错）                                                                                      |
| e2e 多轮场景                                           | `goal-continuation.mjs`（两轮未过后通过，实跑绿）                                                                                                                                                                                                                                            |
| 追加 1：fail-open 定案                                 | desktop「判定不可用的轮次目标照常续跑…」「连续 3 轮判定不可用 → 已暂停…」「出现一次正常结论后连续故障计数清零…」；agent-core「验证记录的结论种类…」；ui `goal-continuation-view`「判定不可用不写成未完成」「暂停原因」；e2e 不含故障轮（stub 判定线脚本须写足）                              |
| 追加 2：显式互锁守卫                                   | desktop「目标进行中且任务空闲（轮间窗口…）：队首不被取走…」（用 Provider Profile 读取闸真实停在窗口里：无执行登记、任务状态空闲；断言队首未被取走且没有「正在发出」的条目）、「轮间窗口任务仍占任务并发一席…」                                                                               |
| 追加 3：验证中副状态不显示空闲                         | desktop「判定在途与轮间窗口任务都呈现为执行中…」；ui `goal-progress-row-ui`「验证中…」、`workspace-goal-ui`「验证中：…」；e2e 第 2 段（判定在途侧栏显示运行中、停止按钮可用）                                                                                                                |

### 验证记录

- 单测：agent-core 744（基线 720）、desktop 626 + 1 skipped（基线 602）、ui 782（基线 764），全绿；`pnpm typecheck` 0 错；`pnpm lint` 0 error（9 条既有 warning，均在未触碰的文件）；`check:e2e-locators`（53 个场景文件）与 `check:adr` 通过。
- e2e（2026-11-26，桌面处于锁屏）：`test:e2e:all` 链遇第一个红即停，于是把链上 **46 个场景文件逐个实跑**（每个都是独立进程，与链的跑法一致）：40 绿；6 红——`sidebar-archive`、`task-search`、`message-order`、`process-segments`、`persistent-workbench`、`window-controls`。**六个都在基线 c773c5c 上同条件复现**（当日 stash 取证，失败断言与本分支逐一相同）：
  - `sidebar-archive` 基线 3 跑 3 红、`message-order` 2 跑 2 红、`process-segments` 2 跑 2 红、`window-controls` 1 跑 1 红（报错直接指明「拖拽起点被 LockScreenBackstopFrame 覆盖」）；
  - `task-search` 基线 3 跑 1 红（本分支 3 跑 1 红）；`sidebar-archive` 两次失败落在不同断言上；
  - `persistent-workbench` 基线 10 跑 1 红、本分支 10 跑 3 红，同一断言「新任务不能继承完全访问」——场景在点击新建任务后不等异步草稿加载（两次 IPC 读盘 + 一次写盘）就读审批模式，是既有竞态；3/10 对 1/10 在这个样本量下不构成统计差异（Fisher 双侧 p≈0.58），本票也没有在这条路径上增加任何主进程或渲染工作，但不能凭这组样本排除差别。
  - 失败性质：`message-order`、`sidebar-archive`、`task-search`、`persistent-workbench` 四个的失败断言都是「点击后立刻同步读值」的写法，对渲染与磁盘的瞬时延迟敏感；`process-segments` 等到了「已复制」反馈后读系统剪贴板却读回空串（是否与锁屏有关未单独验证）；`window-controls` 是锁屏挡住了真实鼠标拖拽。都留给票 07 在解锁桌面后复核。
- 本票相关 e2e 全绿：`goal-mode`（票 02）、`goal-stub-probe`（票 01）、`goal-continuation`（新）；链外的输入队列族五个（`input-queue` / `-items` / `-pause` / `-composer` / `-restart`）、`task-queue-restart`、`export-markdown`；链上的 `interrupt`、`live-tasks`、`exit-recovery`。基线对照后重建 dist，又把这批里最靠近改动面的十个重跑了一遍确认全绿。
- 先红后绿：续跑流转的每条规则都先有会红的测试。少数后补的用例做了变异核查，确认撤掉对应实现时恰好对应用例变红：
  - agent-core——恢复清零（去掉清零 → 2 条红）、`isGoalToolActivity`、对话型规则、故障轮不计空转、正常结论清零故障计数。
  - desktop——`isBusy` 的显式目标条件（去掉 → 轮间窗口用例红）、回合开始登记循环（去掉 → 运行口径用例红）、续跑轮越过执行检查、轮间窗口复查循环是否仍在进行、续跑轮发起失败转已暂停、判定不可用即暂停（3 条红）、故障阈值、工具活动恒为否（2 条红）、验证中副状态。
  - 其中两条用例的初版断言有盲区，是变异核查暴露后补强的（轮间窗口补「没有正在发出的条目」；轮间窗口点停止补等待时间）。
- 自查发现并修正的一处顺序问题（先有会红的用例）：两轮之间点 Stop 时，补唤醒原本排在置「队列暂停」之前，排队消息会趁停止被抢发——把用例「轮间窗口点停止时有排队消息：不趁停止抢发…」先写出来确认变红，再把唤醒挪到置暂停之后转绿。
- 变异核查用的一次性脚本与取证探针均已删除，不进提交。

### 踩坑点

- **循环存活状态不能在首轮之前登记**：那样目标任务会被并发闸门算成「已在执行」，首轮满员时排不进任务排队。改为回合开始时登记（`turnStarted`）。
- **终态事件早于 idle 边界**：回合的 `assistant-done` 下发时若循环尚未登记，侧栏会闪一帧空闲——登记点必须早于终态事件，所以放在回合开始。
- **轮间窗口里卡住的不一定是续跑轮**：用「下一次 Provider Profile 读取」做闸口时，若实现有误，队列泵抢发的排队消息会先撞上闸口，断言会假绿。要同时断言没有「正在发出」的条目。
- **「证明没发生」的断言要留等待时间**：放行闸口后立刻断言「没有续跑请求」会在请求到达前通过。
- **目标事件过滤**：`goal-continuation` 是 agent-core 事件，同样以 `goal-` 开头；按前缀过滤「目标状态事件」会把它算进去。
- **续跑轮走得很快**：判定结论到达后下一轮的「验证中」可能立刻出现，e2e 断言要按 `data-goal-round` 区分，不能断言「没有任何验证中占位行」。
- **桌面测试加载 agent-core 的 dist**：基线对照（stash）后必须重建，否则编排器测试报 `buildGoalContinuationInput is not a function` 假红。
- **长 heredoc 会被截断**：往测试文件追加大段内容时内联 heredoc 中途截断、留下半截标记；改用写临时文件再并入。

### 遗留与已知限制

- **重启后残留的「进行中」目标会自行复活**（票 06 落地前的窗口行为）：循环不在本进程存活，但该任务一旦有任何一轮回合（启动时消费的排队消息或用户手发的一条），回合结束就会判定并自动续跑。已写进票 06 票面。
- **目标进行中全部斜杠命令不可用**：循环期间 `streaming` 恒为真，既有「忙时命令不入队」规则把 `/rename` `/model` `/status` 等一并挡住。已转给票 04 定夺。
- **续跑轮发起失败的原因只在主进程日志里**（目标转已暂停，界面只看到「已暂停」）。现实诱因基本只有任务所用模型在轮间被删除。
- **回合出错不重试**（沿用票 02 规则）。已提示票 05。
- **被拒绝 / 无效的工具调用计入实质工具活动**。已提示票 05。
- 票 02 遗留的两项（Stop 后队列应恢复自动发出、目标进行中禁用 `/compact` 并给规格文案）已按编排者指示转给票 04。**本票没有实现「Stop 后队列自动发出」**：所有停止路径仍沿用票 02 的旧规则「有排队消息时置队列暂停」，两条用例把这个旧行为钉住了（见票 04 票面，修正时同步改断言）。
