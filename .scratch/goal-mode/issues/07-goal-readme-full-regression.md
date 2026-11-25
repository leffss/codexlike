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
