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
