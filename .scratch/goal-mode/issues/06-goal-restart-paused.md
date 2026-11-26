# 06: 重启恢复为暂停态

**What to build:** 应用重启（含强杀）后，「进行中」的目标恢复为「已暂停」：目标文本、轮次、累计账目与逐轮验证历史完整，由用户点恢复才续跑，**不自动续**。挂进既有任务恢复链路（残留态重置处），与任务侧「已中断」等口径对齐、不特判。

**Blocked by:** 04

**Status:** done

**上下文指针:** `.scratch/goal-mode/spec.md`（重启与恢复）、`.scratch/goal-mode/notes.md`（重启恢复链路 countAsViewed 先例、强杀重启 e2e 先例 subagent-interrupted）

- [x] 强杀重启后目标为「已暂停」，目标文本/轮次/账目/验证历史完整无丢失
- [x] 用户点恢复后从暂停点续跑；不点不产生任何模型消耗
- [x] 终态目标（已完成/未达成/预算受限/已清除）重启后状态保持不变
- [x] 「已暂停（重启恢复）」的目标在侧栏/未读提醒等口径与任务侧一致，不特判
- [x] desktop 单测绿：恢复链路重置逻辑（进行中→已暂停、终态保持）
- [x] 强杀重启 e2e 场景实跑绿（沿用 subagent-interrupted 场景手法；注意主进程改动后重建 dist）

## Comments

（来自票 03 实现轮的衔接说明，2026-11-25）

### 重启时需要重置的循环内状态

- 循环存活状态在 desktop `goal-orchestrator.ts` 的内存表里（`loops`，任务 id → `turn` / `verifying`），进程重启自然为空——不需要也无法重置。它决定四件事：输入队列不自动消费（`isBusy` 的显式条件）、占任务并发一席与「执行中」判定（管理规则的执行态）、侧栏与进度行的运行口径（`activityOf` 的叠加）、退出屏障的 `hasWork`。
- 「验证中」占位行不落库，重启后不存在；只有已落库的结论行由任务时间线重建。
- 每轮的工具活动标记（`toolActivity`）是回合内的临时量，随回合产生与消费。
- 持久化侧随目标落库，**重启不需要动**：空转计数与连续故障计数（转已暂停不清零、恢复才清零）、逐轮验证记录、累计时长（转已暂停时闭合当前进行中区段，由 `transitionGoal(taskId, "pause")` 完成）。

### 落地前必须知道的一件事

- 重启后残留的「进行中」目标：循环不在本进程存活，所以任务显示空闲、启动扫描照常消费它的排队消息（与票 02 的过渡行为一致）。**但该任务一旦有任何一轮回合**（启动时消费的排队消息，或用户手发的一条），回合开始就会让循环重新存活，回合结束照常判定并自动续跑。也就是说在本票落地前，重启后一条排队消息就能让目标无人值守地重新跑起来。本票把「进行中」转「已暂停」之后这条路径才真正关上，请在票 07 收口前落地。

### 落点

- agent-core `createTaskManager` 的启动收尾循环（残留 streaming / 待回应交互重置处）遍历全部任务：当前目标状态为 `active` 的转 `paused`。此时 manager 对象还在构造中，直接写持久层（`persistence.updateGoal`，参照 `advanceGoal` 的 pause 记账：闭合当前进行中区段）比调实例方法稳妥。终态（已完成 / 未达成 / 预算受限 / 已清除）与已暂停保持不变。
- 转换只改状态与时长：不产生验证记录、不发事件（重启后由 `view.goal` / `tasks.list` 恢复呈现）。`tasks.execution` 因循环未存活而是空闲，侧栏无徽章——与任务侧口径一致，无需特判。
- 强杀重启的中间态：若杀在续跑轮进行中，agent-core 的启动收尾会补记一条 interrupted 的助手消息（既有机制）；消息流里最后一条内部输入是 `goal-continuation` 角色，其后没有回复或是一条中断的回复；标记行只到上一个已落库的结论，没有「验证中」占位。e2e 断言按这个形状写。
- ui：`initialTranscript` 对 `goal-continuation` 角色的消息不产生任何段，重启恢复后不会多出用户气泡。

---

（票 06 实现轮，2026-11-26。上方票 03 的衔接说明原文保留；下面依次是交付物、决定、对外接口、踩坑点、验收自证与验证记录，最后是写给票 07 的要点。）

## Comments（票 06 实现轮）

### 交付物

- **agent-core**：`src/task/manager.ts`——启动收尾循环逐任务先执行目标重置 `pauseGoalsAfterRestart(task.id)`（「进行中」→「已暂停」，直接写持久层）；新私有函数 `lastPersistedAt(taskId)`（该任务落库里最晚的时间戳，重启闭合终点的候选）与 `persistGoalTransition`（状态机推进结果落库的列集合，`transitionGoal` 与重启恢复共用，消灭两处重复）；`src/goal/state-machine.ts`——新纯函数 `goalRestartPauseAt(goal, lastPersistedAt, now)`（重启恢复闭合终点的夹取规则，浏览器安全）。**未进根出口 / node 出口**（manager 内部消费，不新增公共 API）。
- **desktop**：`tests/tasks/goal-harness.ts`——共用装配新增 `killAndRestart()`（强杀并重启：在途回合与挂起的判定原样留着、不中断不落库，同库文件上新建持久层连接 + 管理器 + IPC 处理器等价一次应用启动；被杀代的在途执行在用例收尾统一排空）；装配从单例改为 `launch()` 代际制，既有用例形状不变。
- **单测**：agent-core `tests/task/goal-restart.test.ts`（新，20 条）；`tests/task/goal-continuation.test.ts`（改写 1 条旧断言）；desktop `tests/tasks/goal-restart-ipc.test.ts`（新，7 条）。
- **e2e**：`e2e/goal-restart-paused.mjs`（单跑 `pnpm test:e2e:goal-restart`，已登记 `test:e2e:all` 链尾与 e2e README 索引第 41 行）。

### 决定 1：时长记账的落地方式（编排者裁决：停机时长不得计入）

- **闭合终点不取重启时刻，取该任务落库里最晚的时间戳**（停机前最后一次有记录的活动），由 `goalRestartPauseAt` 纯函数给出，并**夹在 `[activeSince, now]` 之间**：
  - 下界＝进行中起点：落库里没有晚于起点的记录（目标刚设定 / 刚恢复就退出）时，这一段按 0 计——此时累计时长不含这段空转；
  - 上界＝重启时刻：落库时间戳晚于重启时刻（系统时钟回拨后启动）时夹到重启时刻，不产生「未来」的时长。
- 「最晚的时间戳」覆盖该任务全部落库记录：消息、工具调用（记录以工具**开始**时刻为准，`createdAt` 是开始时写的）、交互（请求发出 / 回应）、逐轮验证记录，以及子代理的委派排队 / 启动时刻与逐轮消息、工具调用——子代理运行中被杀时主任务自己没有更晚的记录，不取子代理 `completedAt`（启动收尾会补记它，时间戳是重启时刻，取它就把停机记成进行中）。终端会话记录不取：它只有创建 / 退出两个时刻，且总会被同回合更晚的工具完成记录覆盖。
- **目标重置必须先于任务侧的收尾写入**（补记中断提示、结算 pending 交互、子代理置 interrupted——时间戳全是重启时刻）：重置取的「最晚时间戳」若是收尾之后算，闭合终点就变成重启时刻。这个顺序约束有变异核查锁定（撤掉顺序 →「启动收尾自己补记的记录不算」与「等待中的审批」两条用例红）。
- **记录的 `updatedAt` 如实取重启时刻**：累计时长闭合在停机前的活动上，但这条记录确实是在这次启动改写的——不拿停机前的活动时刻冒充记录时间（状态机推进落库与 `transitionGoal` 的记账口径一致）。
- 选择「落库最晚时间戳」而非其他方案的理由：进程被杀的时刻无从得知，而「最后一次有记录的活动」是停机前目标确实在推进的最近证据；比「取 activeSince（整段按 0 计）」更准（丢掉已发生的工作时长），比「取重启时刻」更保守（不把停机记成工作）。单测「停机时长不计入累计时长」直接锁定（5 小时停机 → 累计只记到停机前活动）。

### 决定 2：其余定夺（票面范围内）

- **强杀中间态的消息流衔接（票面留白）**：以任务侧既有口径为准、不特判——续跑轮在途被杀时，消息流最后一条内部输入是 `goal-continuation` 角色，其后**没有回复**（被杀的那轮不会落 assistant 消息），启动收尾补记一条 aborted 中断提示；desktop 用例断言消息角色序列＝强杀前 + 中断提示、用户气泡不多一条；e2e 断言同一形状（`user/assistant/user/assistant/goal-continuation/assistant`，最后一条 assistant 即中断提示）。
- **重启后输入队列的待发消息（票面留白）**：按票 04 既定规则处理、不另加逻辑——目标已离开进行中，`isBusy` 的 `goals.isRunning` 条件不成立（循环不在新进程存活），队列照常自动消费；desktop 用例「重启后用户手发一条消息只是普通回合」覆盖同一路径（回合结束不判定、不续跑）。跨重启的队列消费由既有 `input-queue-restart` / `task-queue-restart` 场景守护（本轮实跑绿）。
- **终态与已暂停逐字段不变**：启动收尾只处理 `active`；「未达成 / 预算受限」是护栏给出的停留态、原因（计数 / 预算）留在记录上给用户看，不得被改写成已暂停。agent-core 五个终态逐字段（含非默认的连续计数、预算、基线）断言 + desktop 已完成 / 已清除两条。
- **无模型请求**：重启恢复全程零请求——agent-core 用例的模型工厂被调用即失败；e2e 断言重启后到点恢复之前 stub 请求数不增加（含完成判定）。

### 决定 3：e2e 场景名

- 场景名（脚本名）定为 `goal-restart`，文件名保持 `goal-restart-paused.mjs`：README 索引表格的「场景名」列宽由最长场景名（`launch-state-target`）决定，`goal-restart-paused` 超长会让 prettier 把整个表格 60 行重排。与既有先例一致（`goal-stub` → `goal-stub-probe.mjs`、`subagent-recovery` → `subagent-recovery-review.mjs`）：场景名短、文件名完整。

### 对外接口变化

- **IPC / 事件 / testid：零新增、零修改**。重启恢复不发事件（重启后由 `view.goal` / `tasks.list` 恢复呈现），不产生验证记录；恢复入口沿用 `tasks:goal-resume`（会话内与重启后同一条路）。
- **数据面**：零 schema 变更。目标记录上只有 `status` / `activeMs` / `activeSince` / `updatedAt` 按状态机口径被改写，其余字段（文本、预算、基线、连续计数）与验证记录原样。
- **新 e2e 场景登记**：`packages/desktop/package.json` 单跑脚本 `test:e2e:goal-restart` 与 `test:e2e:all` 链尾（排在 `goal-idle` 之后）、根 `package.json` `test:e2e:goal-restart`、e2e README 索引第 41 行。

### 验收自证

| 验收项                                                | 证据                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 强杀重启后目标「已暂停」，文本/轮次/账目/验证历史完整 | agent-core `goal-restart`「目标进行中时应用重启」（逐字段不变）「真实流程」（原文/验证记录/累计时长跨重开库保留）；desktop `goal-restart-ipc`「续跑轮在途时被强杀」（原文、预算、基线、验证记录、累计时长闭合在续跑指令落库时刻）；e2e `goal-restart-paused` 第 2 段（进度行 `data-goal-status="paused"`、摘要=原文、标记行与验证记录由落库恢复、角色序列、目标记录经公开 IPC 逐字段核对） |
| 点恢复后从暂停点续跑；不点不产生任何模型消耗          | desktop「重启后不点恢复：没有任何模型请求」「点恢复：从暂停点续跑——以内部输入发起（不产生用户气泡），判定通过 → 已完成」；e2e 第 4 段（不点恢复零请求，含完成判定）、第 5 段（手发消息不带回循环、不判定不续跑）、第 6 段（点恢复续跑 → 无用户气泡 → 判定通过 → 已完成，恢复后恰好 2 个请求）                                                                                              |
| 终态保持不变                                          | agent-core「终态与已暂停的目标重启后逐字段不变」（已暂停/已完成/未达成/预算受限/已清除五态，非默认计数与预算带值断言）；desktop 终态组（已完成/已清除）；既有 e2e `goal-budget` / `goal-idle` / `goal-controls` 的重启段（本轮实跑绿）                                                                                                                                                     |
| 侧栏/未读提醒口径与任务侧一致，不特判                 | desktop「续跑轮在途时被强杀」断言 `activityOf`＝空闲 + `interrupted` + `unread: true`（与普通任务同口径）；e2e 第 2 段（侧栏「已中断」未读提醒、打开后熄灭、任务侧中断提示如实呈现、不显示运行中）                                                                                                                                                                                         |
| desktop 单测绿                                        | `goal-restart-ipc`（新，7 条）；`goal-harness` 重构后既有 5 个 goal 测试文件 86 条全绿                                                                                                                                                                                                                                                                                                     |
| 强杀重启 e2e 实跑绿                                   | `goal-restart-paused.mjs`：收口轮 3 跑 3 绿（另有合入前轮 2 跑 2 绿，按编排者要求作废、以收口轮为准）                                                                                                                                                                                                                                                                                      |

### 踩坑点

- **README 表格的列宽陷阱**：场景名 `goal-restart-paused` 比表格「场景名」列现有最长值（`launch-state-target`）长 1 字符，prettier 要求整列加宽 → 整个表格 60 行重排；描述列同理（首版描述 187 显示宽度 > 基线最长行 172）。解法＝场景名缩到 12 字符、描述压到 172 以内（用脚本量 CJK 显示宽度），最终 diff 恰好 1 行插入。
- **prettier --write 会整表重排**：先用仓库外副本实验 `prettier --write`，确认只有自己那行会变再往真文件上跑。
- **`updateGoal` 的 patch 类型不含 `baselineTokens`**（持久层注释明说基线建行后不变）：测试里想让基线带非默认值，得先 `addUsage` 再 `setGoal` 自然拍出，不能直写库。
- **Edit 工具与 git checkout 的时序**：git 恢复文件后必须重新 Read 才能 Edit，否则编辑被拒——被拒后跑出来的「绿」不是变异的结果，必须重做（变异核查期间连续踩了两次）。
- **变异核查必须串行**：恢复 + 编辑 + 跑测三步有依赖，并行批次里 git checkout 会让 Edit 拒绝，结果不可信。
- **e2e 场景首跑后要看日志再收手**：首跑虽然绿，界面层时长证据是「0 秒」（目标设定到续跑指令落库不足半秒）——把首轮改成约 3 秒慢速流，并加上「重启后时长 < 强杀前一刻」的界面层对比，时长证据才有分量。

### 验证记录

- 单测与静态检查（2026-11-26，被外部停止的一轮结果按编排者要求作废后从头重跑；先重建 agent-core dist，typecheck 亦前置重建）：
  - agent-core **784**（基线 764，+20：`goal-restart.test.ts`）、desktop **688 + 1 skipped**（基线 681 + 1，+7：`goal-restart-ipc.test.ts`）、ui **847**（基线 847，+0），退出码全 0；
  - `pnpm typecheck` 0 错（首轮 2 错均在新测试文件：`GoalTransition` import 来源与 `baselineTokens` 直写库，修正后 0）；`pnpm lint` 0 error、9 条既有 warning（全部在 ui 的未触碰文件）；改动文件 `prettier --check` 通过（README 见踩坑点）；`check:e2e-locators`（57 个场景文件）与 `check:adr`（35 篇）通过；全仓 `pnpm build` 通过。
- 先红后绿：agent-core 每条规则先有会红的测试（重启后已暂停、停机时长、0 计下界、时钟回拨上界、八个时间戳来源）；desktop 用例与 e2e 在实现已就位后补的，做了变异核查确认敏感（见下）。
- 变异核查（撤掉对应实现时恰好对应用例变红）：
  - 目标重置挪到任务侧收尾写入之后 →「收尾自己补记的记录不算」+「等待中的审批」红（顺序约束）；
  - 去掉「只处理进行中」过滤 → 五个终态保持用例全红，其余 15 条不受影响；
  - 终点跨任务取数 →「逐任务处理」红（第一任务的时长取到了别的任务的记录）；
  - 终点改回取重启时刻 → 13 条涉时长的用例红（含停机时长用例的 5 小时全部计入）；
  - 撤掉整个重启重置（重建 dist）→ desktop 5 条「进行中」用例红：其中「不点恢复」红在 `expected 'active' to be 'paused'`、「手发消息」红在执行态永远等不到空闲——正是票 03 警告的「重启后一条消息让目标无人值守复活」的窗口行为，5 红 2 绿（两条终态用例本就不依赖重置）。
- e2e（2026-11-26，桌面**解锁**——实跑前后各查一次 `LogonUI` 均不存在；全仓 build 之后逐场景独立进程实跑，直接取退出码）：
  - 新场景 `goal-restart-paused`：**3 跑 3 绿**；
  - 任务书清单 19 个场景全绿：`goal-budget`、`goal-idle`、`goal-controls`（票 05 要求的三个带重启段场景）、`goal-mode`、`goal-continuation`、`goal-stub-probe`、`subagent-interrupted`、`subagent-recovery-review`、`exit-recovery`、`launch-state`、`launch-state-target`、`reasoning-recovery`、`terminal-restart-recovery`、`task-queue-restart`、`input-queue-restart`、`input-queue`、`input-queue-items`、`input-queue-pause`、`input-queue-composer`、`live-tasks`、`interrupt`、`smoke`（含输入队列族全部五个）；
  - grep 补充（`launchApp` ≥ 2 的真实重启段场景，任务书「其他走到冷启动/恢复链路的场景一并跑」）：`projects-sidebar`、`persistent-workbench`、`credential-durability`、`worktree`、`workspace-opener`、`theme`、`subagents`、`subagent-work-plan`、`subagent-legacy-record`、`skills`、`sidebar-task-preview`、`task-search`、`membership`、`mcp`、`entry-consistency`、`compact`、`changes`、`approvals`、`window-controls` 全绿；
  - **两次时序抖动（如实记录，非本票回归）**：`sidebar-archive` 首跑红在「取消置顶恢复最近发送顺序」（hover 点击后同步读值，票 03 轮已知 flaky，本票不碰置顶/排序），重跑绿；`message-order` 首跑红在「两段思考应交错独立存在」（受控 `<details>` 异步渲染竞态，票 03 轮已知红之一），重跑绿。两者各 2 跑 1 绿 1 红、失败断言与本票改动面无关。
  - **未跑全量链** `test:e2e:all`（全量回归归票 07）。合计 37 个场景文件、39 次执行。
- code-review 双轴走查（Standards 对照 CODING_STANDARDS.md 六条 + 坏味道基线；Spec 对照票面六条验收 + 编排者裁决）：无需要修改的发现；`persistGoalTransition` 的提取消灭两处列集合重复、`goalRestartPauseAt` 与 `advanceGoal` 同处状态机模块职责一致。

### 写给票 07（收口）的要点

- **需同步进 GLOSSARY / ADR 0035 的措辞**：ADR 0035「取舍」段的「重启恢复为暂停态、用户手动恢复」与实现一致，无需改写；建议在「重启与恢复」相关表述（README 目标模式条目 + GLOSSARY「目标模式」若提及重启）补一句**停机时长不计入累计时长**（进行中区段闭合在该任务落库里最晚的时间戳上）——这是编排者裁决的口径，规格与 ADR 均未写。
- **新 e2e 场景登记位置**：链尾现为 `goal-stub-probe → goal-mode → goal-continuation → goal-controls → goal-budget → goal-idle → goal-restart-paused`；e2e README 索引第 41 行（场景名 `goal-restart`，文件 `goal-restart-paused.mjs`——场景名刻意短于文件名，防表格列宽重排，见踩坑点）；单跑 `pnpm test:e2e:goal-restart`。
- **无偏离**：实现与票面字面、spec「重启与恢复」、编排者裁决全部一致；票面留白的两点（消息流衔接、输入队列）按上文「决定 2」处理，未特判。
- **合入注意**：`goal-continuation.test.ts` 有一条旧断言被改写（重启后目标从 `active` 改为 `paused`）——那是票 03 时代的过渡行为事实，与本票无冲突的合并点。
- **全量回归提醒**：本轮两次时序抖动（`sidebar-archive` 的 hover 点击、`message-order` 的思考折叠块渲染）与本票无关，票 07 全量链如再红请按既有 flaky 追，不要记到本票头上。
- **遗留（非本票验收项）**：启动收尾对「进行中」目标的重置只发生在应用启动时；`launch-state-target` 等场景的强杀段走同一链路（本轮实跑绿），无需额外覆盖。
