# 04: 右栏「终端」tab 最小交互闭环

**What to build:** 第一张用户可见竖切：RailPanel 新增第四个「终端」tab（tab 徽章显示运行中计数），tab 体按 ADR 0032 拆页导航——分组列表页（运行中 / 已退出两组，空组不渲染；富行两行式：会话名 + 状态/来源/已用时元信息，来源标注用户 / agent）↔ 详情页（顶栏返回 + 状态点 + 已用时 + kill 按钮；主体 xterm.js + fit addon，主题对接语义 token）。列表页「+ 新建会话」按钮（超上限给提示）、会话默认名「shell 类型 · 序号」、用户 kill 不弹确认。字节流 IPC 直写 xterm；已退出会话（内存内）点开只读回看尾部输出。状态口径集中一处（subagent-status 同款收敛，命名 terminal-status）。**xterm 交互区是 canvas，SSR 只测列表页与详情壳**。本票 live-only，重启恢复归 08 票。文件指针见 notes.md §5。

**Blocked by:** 03。

**Status:** ready-for-agent

- [ ] 第四 tab 就位，徽章计数正确；拖拽分栏行为与现有 tab 一致
- [ ] 拆页导航：列表页分组渲染（运行中/已退出、空组不渲染、富行元信息）↔ 详情页；SSR 单测覆盖列表页与详情壳（先例 subagent-rail-ui / subagent-rail-switch）
- [ ] xterm.js 交互区：真 TTY 保真（颜色/光标/交互程序）、字节流直写、跟随语义 token 主题
- [ ] 新建会话入口（含上限提示）、用户 kill 无确认；已退出会话只读回看
- [ ] terminal-status 状态口径单一来源
- [ ] `terminal-*` 事件在 task-view 的归并有单测（先例 task-view.test.ts）
- [ ] ui test / typecheck 绿；改动 e2e 交互面后实跑相关场景或手测（AGENTS.md 纪律）

## Comments

- 【03 票衔接】渲染端数据面已就绪（集成 `d048e08`）：操作走 `window.codexlike.terminals`（create/write/resize/kill/session/list-for）；**字节流与回放走 subscribe 三合一**——回放 `buffered` + 实时转发 + record 快照一次返回，重复订阅幂等（主进程防重复转发），收到 `terminal-started` 后立即 subscribe 即不丢数据；`terminals:session-data` 专用通道直写 xterm.js，**绝不进 React 状态**。
- 【03 票衔接】生命周期事件走 `onTaskEvent` 信封：`terminal-started` / `terminal-exited`（record 完整副本，exited 含 exitCode/snapshot）。**ui task-view.ts 里这两个类型现在是 no-op case（03 票为过穷尽性所加）——本票替换为真实归并**（TerminalSegment 段类型 + 状态推进 + 列表分组数据源），先例 SubagentSegment/appendSubagentTurnDelta/subagentFromSnapshot；dev/browser-stub 的 terminals stub 已备好单测可用。
- 【03 票衔接】已退出会话详情 = subscribe 取 buffered 只读回看；record.name 形如 `git-bash · 1`；来源 origin（user|agent）直接映射列表富行标注；activity 字段随事件信封下发（idle 任务 running=false/queued=false），tab 徽章计数以 record.status 为准。
- 【03 票衔接】新建会话 `create({taskId, initialCommand?})` 超上限返回 `{ok:false, reason 中文}`，直接展示不另造错误态；kill 走 `terminals:kill` 不弹确认（票面既定）。
- 【设计注解】列表页「已退出」组数据源 = `list-for`（含已退出记录）；xterm 主题对接语义 token 时注意 xterm 自有 palette 结构与 CSS token 的换算放 terminal-status/主题适配一处收口。
