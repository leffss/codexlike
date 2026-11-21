# 06: 消息流工具卡 + 点击直跳详情

**What to build:** terminal 四工具的调用卡在消息流过程段的呈现（摘要显示会话名/状态/读取摘要，输出语义与现有工具卡一致），点击卡片直跳右栏「终端」tab 对应会话详情页——focus 机制照搬子代理标记行（点击 → setFocus → RailPanel 自动切 tab 并落到详情页）。文件指针见 notes.md §5。

**Blocked by:** 04, 05。

**Status:** done

- [x] 四工具调用卡过程段正常渲染、完成态收起行为与过程段规则一致
- [x] 点击直跳：自动切终端 tab + 落对应详情页；幂等守卫沿用现有 focus 模式
- [x] 单测：卡片渲染 + focus 直跳（先例：子代理标记行 / message-rendering 系）
- [x] ui test / typecheck 绿；涉及 e2e 交互面的实跑相关场景（8 场景 6 绿，2 个基线对照确认既有红）

## Comments

- 【05 票衔接】四工具参数与返回形状（卡片渲染直接引用，集成 `0792c15`）：`spawn_terminal`（permission=command，参数 `command?` 可选初始命令，成功文案含 sessionId 与会话名）/ `terminal_write`（command，参数字段**名就叫 `command`**）/ `terminal_read`（readonly，`sessionId` + `wait?` + `timeoutMs?`，返回增量原文带中文标注）/ `terminal_kill`（write，`sessionId`）。工具结果含 sessionId 串起后续调用——卡片摘要可用 `command` 原文 + sessionId 关联。
- 【05 票衔接】`origin: "agent"` 的会话即 agent 自启（所有权语义）；工具卡点击直跳的 focus 目标 = 卡片参数里的 sessionId → 右栏终端 tab 详情页（子代理标记行 focus 同款机制：点击 → setFocus → RailPanel 自动切 tab 落详情，幂等守卫沿用）。
- 【03 票衔接】ui 侧 terminal-* 事件目前在 task-view 是 no-op case（04 票正在替换为真实 TerminalSegment 归并）——本票开工时若 04 已合入则直接在 Segment 模型上做卡片/直跳；若尚未合入，与 04 有同文件风险（task-view.ts / RailPanel 系），**以集成分支最新 tip 为准合并并优先保持 04 的模型**，冲突找编排者。
- 【设计注解】卡片完成态收起遵循过程段规则（当前活动段默认展开、完成自动收起、一行摘要回看）；terminal_read 的输出可能很长（保尾 30k），卡片摘要不展开全文、进详情看。
- 【04 票衔接】渲染端结构已就绪（集成 `b7797ba`）：TerminalSegment 模型已在 task-view（`kind:"terminal"`，id=sessionId，幂等 upsert）；消息流 terminal 段当前渲染 null——**本票把它换成标记行 + 直跳**。focus 直跳接线：TerminalRailPanelBody 当前无外部 focus 入口——给 body 加 focus prop（照 SubagentFocus 的 seq 幂等模式）+ WorkspacePage 传 onOpenTerminal 类回调；目标定位 testid：`terminal-rail-detail-header` / `rail-tab-terminals` / `terminals-panel-body`（04 票 Comments 有完整清单）。
- 【04 票衔接】xterm 动态 import 纪律：涉及 xterm 的组件顶层零运行时依赖（6.0 UMD，node 下 named import 不可靠）——本票若触碰 TerminalSessionView 相关文件沿用该形态，SSR 测试用 vi.mock 拦动态 import。
- 落地：票分支 ts-06-tool-card-focus commit `a226070`，集成合入 `3285001`。11 文件 +503/−7；ui 691 绿（+12），typecheck 0 错，pre-commit 全链过；e2e 实跑 8 场景：smoke/process-segments/subagents/subagent-thinking/subagent-recovery-review/reasoning-recovery 绿，message-order/subagent-interrupted 基线对照确认既有红（stash 验证，非本票引入）。
- **标记行与 focus 面（09 断言用）**：标记行 testid `terminal-stream-marker`（li）/ `terminal-stream-marker-toggle`（button，`data-terminal-state="running|exited"`）；文案 = 终端徽章 + 动作摘要 + agent/用户来源标 + 状态点 + 状态文案 + 已用时 mm:ss + 右栏查看→；agent 会话「启动了终端会话 git-bash · 1」、用户手开「终端会话 git-bash · 1」（无动词）。工具卡摘要（tool-call-card summary）：`$ pnpm test` / `启动终端会话` / `写入 ts-1：$ y` / `读取 ts-1 的新输出`（wait=true 加「（等待新输出）」）/ `终止 ts-1`。
- **focus 直跳路径**：标记行点击 → openTerminalFromStream(sessionId) → setRailOpen + setTerminalFocus({sessionId, seq}) → RailPanel effect 切 rail-tab-terminals → body focus effect（seq 消费守卫；**目标会话不在列表时暂存不跳、入列后补跳**——terminal-started 晚到场景）→ setSelectedId + page=detail → `terminal-rail-detail-header` + `terminal-rail-title`。「不落列表页」断言锚：跳转后 `terminal-rail-back` 存在、列表行 `terminal-rail-item` 不渲染。**TerminalFocus 字段名 {sessionId, seq} 与 SubagentFocus {id, seq} 不同，勿混用**。
- 工具卡点击保持既有 toggle 展开收起（票面「不重做卡片系统」口径），直跳入口只在标记行。
- 踩坑：测试造数据 name 必须唯一（同名会话导致 title 断言歧义）；给 RailPanel 加新 required prop 后先全仓 grep 装配点补 stub（typecheck 抓出两处测试文件）。
