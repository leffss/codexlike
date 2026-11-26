# 07: 收口：README 与全量回归

**What to build:** 目标模式全量收口：README 功能清单补目标模式条目（与审批模式条目同族表述，含 `/goal` 用法一句）；全量检查实跑全绿；GLOSSARY 三词条与 ADR 0035 同实现口径核对（有漂移就地修正并注明缘由，不静默改写）；本 feature 各票验收 checkbox 逐项核对勾选。

**Blocked by:** 02、03、04、05、06

**Status:** done

**上下文指针:** `.scratch/goal-mode/spec.md`（Out of Scope——收口时勿越界做 steering/迭代摘要卡）、`.scratch/goal-mode/notes.md`（e2e 纪律：检查命令不接管道、dist 重建链）

- [x] README 特性清单含目标模式条目（`/goal`、进度行、护栏一句话级表述）
- [x] 全量检查实跑全绿：agent-core / desktop / ui 三包 test + typecheck、全仓 build、`test:e2e:all`、`pnpm check:adr`
- [x] GLOSSARY「目标 / 目标模式 / 完成判定」与 ADR 0035 同实现一致（无静默漂移；有修正注明）
- [x] 票 02-06 验收 checkbox 全部勾选、Status 置 done；票面 Comments 衔接注意事项完整

## Comments

（来自票 03 实现轮的衔接说明，2026-11-25 / 26）

### 全量回归

- `test:e2e:all` 链尾新增 `goal-continuation.mjs`（README 索引第 37 行），单跑 `pnpm test:e2e:goal-continuation`。
- 票 03 轮（2026-11-26，桌面处于锁屏）把链上 46 个场景文件逐个实跑：40 绿，6 红——`sidebar-archive`、`task-search`、`message-order`、`process-segments`、`persistent-workbench`、`window-controls`。六个都在基线 c773c5c 上同条件复现（当日 stash 取证，失败断言与票 03 分支逐一相同）；`window-controls` 的报错指明桌面处于锁屏（`LockScreenBackstopFrame` 遮挡拖拽起点）。**请在解锁桌面后复核这六个**；若仍红再当既有红追。
- 失败性质：`message-order`、`sidebar-archive`、`task-search`、`persistent-workbench` 四个的失败断言都是「点击后立刻同步读值」的写法——`message-order` 读 `thinking-content` 与异步渲染竞态（受控 `<details>` 的 toggle 事件之后才挂载内容，段序列断言本身通过）；`persistent-workbench` 点击新建任务后不等异步草稿加载（两次 IPC 读盘 + 一次写盘）就读审批模式（基线 10 跑 1 红，票 03 分支 10 跑 3 红，同一断言）；`sidebar-archive` 在不同断言处交替失败。`process-segments` 等到了「已复制」反馈后读系统剪贴板却读回空串（是否与锁屏有关未单独验证）；`window-controls` 是锁屏挡住了真实鼠标拖拽。前四个根治大概率是在断言前补等待，而不是调实现。
- 链外（不在 `test:e2e:all` 里）的输入队列族五个、`task-queue-restart`、`export-markdown` 在票 03 分支上全绿。全量链不覆盖它们——票 05 / 06 / 07 动到输入队列或重启链路时记得单独跑。

### GLOSSARY 与 ADR 0035 的口径核对要点（票 03 引入的细化，核对时请注明）

- 标记行多了一种措辞：ADR 0035「呈现」段与 GLOSSARY「完成判定」只列「验证中 / 已完成 / 未完成」，实现里判定自身故障的轮次显示「判定不可用」。
- 判定自身故障连续 3 轮时目标转「已暂停」：ADR 只写了「走 fail-open，不设独立用户态」。实现复用「已暂停」态，没有新增用户态；但验证记录上有结论种类的区分（`passed` / `unpassed` / `unavailable`）——这是数据面的区分，不是状态集的两分，与 ADR「拒绝 notSatisfied/failed 两分」不冲突，核对时建议写明。
- 新增一种随任务落库的消息角色 `goal-continuation`（续跑指令：进模型上下文、不产生用户气泡）。GLOSSARY 是否为「续跑指令 / 续跑轮」立词条，由本票定夺。
- 「实质工具活动」「空转计数」的口径写在票 05 票面，护栏文案落定后一并核对。

### 提醒

- 票 06 落地前，重启后残留的「进行中」目标会被该任务的下一轮回合重新带入续跑循环（详见票 06 票面）。收口前请确认 06 已落地。

---

（来自票 06 实现轮的衔接说明，2026-11-26。票 06 已落地：重启后「进行中」目标恢复为「已暂停」的窗口已关闭。）

### 需同步进 GLOSSARY / ADR 0035 / README 的措辞

- **停机时长不计入累计时长（编排者裁决，规格与 ADR 均未写，建议补进文档）**：强杀到下次启动之间不产生模型请求、也没有活动记录，进行中区段闭合在**该任务落库里最晚的时间戳**上（停机前最后一次有记录的活动），并夹在 `[activeSince, 重启时刻]` 之间——时钟回拨后启动不产生「未来」时长，落库里没有晚于进行中起点的记录时该段按 0 计。落地在 agent-core `goalRestartPauseAt`（state-machine.ts）+ `lastPersistedAt`（manager.ts）；单测「停机时长不计入累计时长」锁定。
- ADR 0035「取舍」段的「重启恢复为暂停态、用户手动恢复」与实现一致，无需改写；README 目标模式条目（随你的收口票）可带一句「重启后恢复为已暂停、停机时长不计入累计时长」。
- 无其他偏离：票面验收六条与 spec「重启与恢复」全部按字面实现；票面留白两点（强杀消息流的 `goal-continuation` 衔接＝任务侧既有口径不特判；重启后输入队列按票 04 既定规则自动消费）已在票 06 Comments「决定 2」记录。

### 全量链与回归的新增登记

- `test:e2e:all` 链尾现为 `goal-stub-probe → goal-mode → goal-continuation → goal-controls → goal-budget → goal-idle → goal-restart-paused`（本票追加最后一个）；e2e README 索引第 41 行；单跑 `pnpm test:e2e:goal-restart`。
- **场景名与文件名刻意不同**：场景名 `goal-restart`、文件 `goal-restart-paused.mjs`（先例 `goal-stub` / `goal-stub-probe.mjs`）——README 表格「场景名」列再往长里改名会让 prettier 把整表重排，收口时改名请先量列宽。
- 票 06 轮实测的两次时序抖动与本票无关，全量链如再红请按既有 flaky 追：`sidebar-archive`（hover 点击后同步读值，红在「取消置顶恢复最近发送顺序」）、`message-order`（思考折叠块异步渲染竞态，红在「两段思考应交错独立存在」），两者重跑均绿。

### 核对票 02–06 验收 checkbox 时的注意

- `goal-continuation.test.ts` 有一条旧断言在票 06 轮被改写（「连续计数随目标落库」：重启后目标从 `active` 改为 `paused`）——那是票 03 时代的过渡行为事实，不是回归。
- 启动收尾的目标重置**先于**任务侧收尾写入（补记中断提示 / 结算交互 / 子代理置终态）——顺序约束由变异核查锁定，全量回归无需额外覆盖，但改动启动收尾时请保序。

---

（票 07 实现轮，2026-11-26。上方票 03 / 06 的衔接说明原文保留；下面是收口的核对、修正与全量回归结果。）

### GLOSSARY / ADR 0035 的核对与修正（逐条注明缘由）

对照实现逐一核对，以下措辞有漂移、已就地修正（均注明「与实现对齐，见 goal-mode 票 07」，不静默改写）：

- **标记行「判定不可用」措辞**：ADR 0035「呈现」段与 GLOSSARY「完成判定」原先只列「验证中 / 已完成 / 未完成」三种，实现里判定自身故障的轮次显示「判定不可用」（`data-goal-verdict="unavailable"`）。已在 ADR「呈现」段补「判定不可用」，并在 GLOSSARY「完成判定」词条写明四种措辞。
- **判定自身故障连续 3 轮 → 复用「已暂停」态**：ADR 只写了「走 fail-open，不设独立用户态」。实现复用「已暂停」态（`failureStreak ≥ GOAL_MAX_VERIFICATION_FAILURES` 即转已暂停，出现正常结论即清零），验证记录以结论种类 `passed / unpassed / unavailable` 在数据面区分（`unavailable` 不代表未达成，与 ADR「拒绝 notSatisfied/failed 两分」不冲突）。已写入 ADR「状态机六态」段与 GLOSSARY「完成判定」。
- **续跑指令角色 `goal-continuation`**：随任务落库的新消息角色（进模型上下文、不产生用户气泡）。已立 GLOSSARY「续跑指令（Goal Continuation）」词条。
- **护栏措辞（票 05 定稿）**：ADR「护栏」段原为一句概述，已细化为实现口径——token 预算是目标级参数（进度行设定、缺省不限、`/goal` 不带预算参数）；消耗 = 目标设定以来任务用量账目的增量（设定时拍基线，含主任务各轮、子代理、压缩与判定自身）；对账在每轮判定之后；「用量达到预算即超」（`≥`）与「完成优先于预算」是票 05 的细化、规格未写，已注明；空转阈值 3 为定值不做配置项；「实质工具活动」只认实际执行了的调用（被拒 / 参数无效 / 未注册不算，执行出错仍算，`update_plan` 除外）；处置优先序完成 > 判定连续不可用暂停 > 未达成 > 预算受限。GLOSSARY「目标模式」词条同步补了一句护栏概述与处置优先序。
- **控制面（票 04）**：GLOSSARY「队列暂停」词条补例外（目标进行中点 Stop = 暂停目标，输入队列不进入队列暂停，排队消息在目标转已暂停后自动逐条发出）；GLOSSARY「目标」词条补编辑可用性（只在已暂停 / 预算受限 / 未达成，进行中先暂停）与清除后回普通对话；ADR「控制面」段补编辑可用性与「目标进行中其余斜杠命令沿用忙时命令不入队、不放行」。GLOSSARY 与 README 的「斜杠命令」清单各补 `/goal`。
- **停机时长不计入累计时长（票 06 / 编排者裁决，规格与 ADR 均未写）**：已补进 ADR「取舍」段与 GLOSSARY「目标模式」词条——进行中区段闭合在该任务落库里最晚的时间戳上、夹在 `[activeSince, 重启时刻]` 之间，无更晚记录按 0 计。
- **未立新词条的决定**：`goal-changed.pauseReason`（下一轮没能发起而暂停的暂停说明）不单独立词条——它是进度行停留原因的四类来源之一（前三种按状态推导的优先于它，票 05 已说明），口径已在票 04 / 05 票面记录，窄于词条粒度。

### README 目标模式条目

特性清单「三档审批模式」后新增同族条目：

> **目标模式**：`/goal <目标>` 为任务设定持久目标，agent 每轮回复后自动完成判定、未过则续跑直至完成。输入框上方进度行可暂停 / 恢复 / 编辑 / 清除；token 预算与连续空转阻断两道护栏防无限消耗。重启后恢复为已暂停，停机时长不计入累计时长。

斜杠命令清单同步补 `/goal`。

### 全量检查（真实退出码，均不接管道）

- agent-core 单测 **784** 通过、desktop **688 + 1 skipped**、ui **847**，退出码全 0（与基线一致，本票纯文档改动、无新增用例）。
- `pnpm typecheck` 0 错；`pnpm lint` 0 error（9 条既有 warning，全部在未触碰的 ui 文件）；改动文件（README / GLOSSARY / ADR 0035）`prettier --check` 通过；`pnpm check:e2e-locators` 通过（57 个场景文件）；`pnpm check:adr` 通过（35 篇）；全仓 `pnpm build` 通过。
- `pnpm --filter @codexlike/desktop run test:e2e:all`：**50 个场景串行全绿，退出码 0**。桌面全程解锁（实跑前后各查一次 `LogonUI` 均不存在）。票 03 轮锁屏下基线即红的六个场景（`sidebar-archive` / `task-search` / `message-order` / `process-segments` / `persistent-workbench` / `window-controls`）本次解锁态一次通过、无需重跑；`window-controls` 的锁屏遮挡报错未复现。七个 goal 场景（`goal-stub-probe` / `goal-mode` / `goal-continuation` / `goal-controls` / `goal-budget` / `goal-idle` / `goal-restart-paused`）全绿。无 flaky 红、无重跑。

### 票 02-06 核对结果

票 02（10 条）、03（11 条）、04（11 条）、05（7 条）、06（6 条）验收 checkbox 全部 `[x]`、`Status: done`、Comments 衔接说明完整，**无需补勾或改 Status**；未做任何改动。

### 遗留（非本票验收项）

- 回合出错（模型请求失败且重试耗尽）仍为直接已暂停、不重试（票 05 转来的待定项，无人值守长跑下一次网络抖动即停）；如需续跑要配连续失败计数防死循环，留作后续。
- 目标停留期间的普通对话也计入目标用量（用量 = 任务账目 − 基线的字面口径），已如实记录在票 05。
