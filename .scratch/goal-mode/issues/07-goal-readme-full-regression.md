# 07: 收口：README 与全量回归

**What to build:** 目标模式全量收口：README 功能清单补目标模式条目（与审批模式条目同族表述，含 `/goal` 用法一句）；全量检查实跑全绿；GLOSSARY 三词条与 ADR 0035 同实现口径核对（有漂移就地修正并注明缘由，不静默改写）；本 feature 各票验收 checkbox 逐项核对勾选。

**Blocked by:** 02、03、04、05、06

**Status:** ready-for-agent

**上下文指针:** `.scratch/goal-mode/spec.md`（Out of Scope——收口时勿越界做 steering/迭代摘要卡）、`.scratch/goal-mode/notes.md`（e2e 纪律：检查命令不接管道、dist 重建链）

- [ ] README 特性清单含目标模式条目（`/goal`、进度行、护栏一句话级表述）
- [ ] 全量检查实跑全绿：agent-core / desktop / ui 三包 test + typecheck、全仓 build、`test:e2e:all`、`pnpm check:adr`
- [ ] GLOSSARY「目标 / 目标模式 / 完成判定」与 ADR 0035 同实现一致（无静默漂移；有修正注明）
- [ ] 票 02-06 验收 checkbox 全部勾选、Status 置 done；票面 Comments 衔接注意事项完整

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
