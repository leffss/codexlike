# 04: 右栏「终端」tab 最小交互闭环

**What to build:** 第一张用户可见竖切：RailPanel 新增第四个「终端」tab（tab 徽章显示运行中计数），tab 体按 ADR 0032 拆页导航——分组列表页（运行中 / 已退出两组，空组不渲染；富行两行式：会话名 + 状态/来源/已用时元信息，来源标注用户 / agent）↔ 详情页（顶栏返回 + 状态点 + 已用时 + kill 按钮；主体 xterm.js + fit addon，主题对接语义 token）。列表页「+ 新建会话」按钮（超上限给提示）、会话默认名「shell 类型 · 序号」、用户 kill 不弹确认。字节流 IPC 直写 xterm；已退出会话（内存内）点开只读回看尾部输出。状态口径集中一处（subagent-status 同款收敛，命名 terminal-status）。**xterm 交互区是 canvas，SSR 只测列表页与详情壳**。本票 live-only，重启恢复归 08 票。文件指针见 notes.md §5。

**Blocked by:** 03。

**Status:** done

- [x] 第四 tab 就位，徽章计数正确；拖拽分栏行为与现有 tab 一致
- [x] 拆页导航：列表页分组渲染（运行中/已退出、空组不渲染、富行元信息）↔ 详情页；SSR 单测覆盖列表页与详情壳（先例 subagent-rail-ui / subagent-rail-switch）
- [x] xterm.js 交互区：真 TTY 保真（颜色/光标/交互程序）、字节流直写、跟随语义 token 主题
- [x] 新建会话入口（含上限提示）、用户 kill 无确认；已退出会话只读回看
- [x] terminal-status 状态口径单一来源
- [x] `terminal-*` 事件在 task-view 的归并有单测（先例 task-view.test.ts）
- [x] ui test / typecheck 绿；改动 e2e 交互面后实跑相关场景或手测（AGENTS.md 纪律）——rail 系四场景实跑回归通过，subagent-interrupted 失败经基线对照确认为既有损坏非本票回归

## Comments

- 【03 票衔接】渲染端数据面已就绪（集成 `d048e08`）：操作走 `window.codexlike.terminals`（create/write/resize/kill/session/list-for）；**字节流与回放走 subscribe 三合一**——回放 `buffered` + 实时转发 + record 快照一次返回，重复订阅幂等（主进程防重复转发），收到 `terminal-started` 后立即 subscribe 即不丢数据；`terminals:session-data` 专用通道直写 xterm.js，**绝不进 React 状态**。
- 【03 票衔接】生命周期事件走 `onTaskEvent` 信封：`terminal-started` / `terminal-exited`（record 完整副本，exited 含 exitCode/snapshot）。**ui task-view.ts 里这两个类型现在是 no-op case（03 票为过穷尽性所加）——本票替换为真实归并**（TerminalSegment 段类型 + 状态推进 + 列表分组数据源），先例 SubagentSegment/appendSubagentTurnDelta/subagentFromSnapshot；dev/browser-stub 的 terminals stub 已备好单测可用。
- 【03 票衔接】已退出会话详情 = subscribe 取 buffered 只读回看；record.name 形如 `git-bash · 1`；来源 origin（user|agent）直接映射列表富行标注；activity 字段随事件信封下发（idle 任务 running=false/queued=false），tab 徽章计数以 record.status 为准。
- 【03 票衔接】新建会话 `create({taskId, initialCommand?})` 超上限返回 `{ok:false, reason 中文}`，直接展示不另造错误态；kill 走 `terminals:kill` 不弹确认（票面既定）。
- 【设计注解】列表页「已退出」组数据源 = `list-for`（含已退出记录）；xterm 主题对接语义 token 时注意 xterm 自有 palette 结构与 CSS token 的换算放 terminal-status/主题适配一处收口。
- 落地：票分支 ts-04-terminal-rail-tab commit `5045976`，集成合入 `b7797ba`。18 文件 +2192/−11；ui 670 绿（+46）、desktop 540 绿、typecheck 0 错、pre-commit 全链过；e2e 实跑回归：changes/subagents/subagent-recovery-review/width-tiers ✅，subagent-interrupted ❌ 经 stash 基线对照确认为既有损坏（与 notes §9 口径一致，非本票回归）。
- **渲染端结构与数据流**（06 票接线用）：tab 体入口 RailPanel `tab==="terminals"` → `data-testid="terminals-panel"`（tabpanel）→ TerminalRailPanelBody（列表页↔详情页 page state）；第四 tab 按钮 `rail-tab-terminals`、徽章 `terminal-rail-badge`；详情页根 `terminal-rail-detail-header`（返回 `terminal-rail-back`、标题 `terminal-rail-title`、kill `terminal-rail-kill`）、xterm 容器 `terminal-xterm-host`、面板体 `terminals-panel-body`。数据自 RailPanel 内 `useTerminalSessions(taskId)`（list-for 初始 + terminal-* 信封增量 + 切任务重建）。**当前无外部 focus 信号入口——06 票给 body 加 focus prop（照 SubagentFocus seq 幂等模式）并从 WorkspacePage 传 onOpenTerminal 类回调**。
- **TerminalSegment 模型**（task-view.ts MessageSegment 成员）：`{ kind:"terminal", sessionId, name, shell, origin, status, createdAt, exitedAt?, exitCode?, signal? }` + 公共底座（id=sessionId、seq/turnId/responseId/at）；record.snapshot 与 taskId **有意不进段**（快照大文本不进 React 状态，回看走 subscribe 的 buffered）。applyTaskEvent 按 sessionId 幂等 upsert（整段替换保 seq、终态不可回退守卫、迟到 exited 兜底建段）；rail 同构 `terminalSegmentsFromRecords` / `upsertTerminalSession`。消息流 terminal 段当前渲染 null——06 票换标记行 + 直跳。
- xterm 适配：@xterm/xterm 6.0.0 + @xterm/addon-fit 0.11.0；**6.0 是 UMD 包，node 下 named import 不可靠——组件动态 import、顶层零 xterm 运行时依赖**（SSR/jsdom/浏览器三态安全；jsdom 测试 vi.mock 拦动态 import）。主题换算收口 `lib/terminal-theme.ts`（`terminalXtermTheme()` 读 computed style，ANSI 16 色映射语义 token，MutationObserver 随 `data-theme` 翻转重读）。
- 踩坑：term.onData 返回 IDisposable（对象非函数）——直接 push 退订数组 cleanup 抛错并连锁 React 重挂载（表现为 subscribe 双调用），已包装 dispose；kill 已退出会话的拒绝是正常竞态（按钮已被事件推进隐藏），未造错误态。
