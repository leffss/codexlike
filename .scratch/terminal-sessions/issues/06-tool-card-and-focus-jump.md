# 06: 消息流工具卡 + 点击直跳详情

**What to build:** terminal 四工具的调用卡在消息流过程段的呈现（摘要显示会话名/状态/读取摘要，输出语义与现有工具卡一致），点击卡片直跳右栏「终端」tab 对应会话详情页——focus 机制照搬子代理标记行（点击 → setFocus → RailPanel 自动切 tab 并落到详情页）。文件指针见 notes.md §5。

**Blocked by:** 04, 05。

**Status:** ready-for-agent

- [ ] 四工具调用卡过程段正常渲染、完成态收起行为与过程段规则一致
- [ ] 点击直跳：自动切终端 tab + 落对应详情页；幂等守卫沿用现有 focus 模式
- [ ] 单测：卡片渲染 + focus 直跳（先例：子代理标记行 / message-rendering 系）
- [ ] ui test / typecheck 绿；涉及 e2e 交互面的实跑相关场景

## Comments

- 【05 票衔接】四工具参数与返回形状（卡片渲染直接引用，集成 `0792c15`）：`spawn_terminal`（permission=command，参数 `command?` 可选初始命令，成功文案含 sessionId 与会话名）/ `terminal_write`（command，参数字段**名就叫 `command`**）/ `terminal_read`（readonly，`sessionId` + `wait?` + `timeoutMs?`，返回增量原文带中文标注）/ `terminal_kill`（write，`sessionId`）。工具结果含 sessionId 串起后续调用——卡片摘要可用 `command` 原文 + sessionId 关联。
- 【05 票衔接】`origin: "agent"` 的会话即 agent 自启（所有权语义）；工具卡点击直跳的 focus 目标 = 卡片参数里的 sessionId → 右栏终端 tab 详情页（子代理标记行 focus 同款机制：点击 → setFocus → RailPanel 自动切 tab 落详情，幂等守卫沿用）。
- 【03 票衔接】ui 侧 terminal-* 事件目前在 task-view 是 no-op case（04 票正在替换为真实 TerminalSegment 归并）——本票开工时若 04 已合入则直接在 Segment 模型上做卡片/直跳；若尚未合入，与 04 有同文件风险（task-view.ts / RailPanel 系），**以集成分支最新 tip 为准合并并优先保持 04 的模型**，冲突找编排者。
- 【设计注解】卡片完成态收起遵循过程段规则（当前活动段默认展开、完成自动收起、一行摘要回看）；terminal_read 的输出可能很长（保尾 30k），卡片摘要不展开全文、进详情看。
- 【04 票衔接】渲染端结构已就绪（集成 `b7797ba`）：TerminalSegment 模型已在 task-view（`kind:"terminal"`，id=sessionId，幂等 upsert）；消息流 terminal 段当前渲染 null——**本票把它换成标记行 + 直跳**。focus 直跳接线：TerminalRailPanelBody 当前无外部 focus 入口——给 body 加 focus prop（照 SubagentFocus 的 seq 幂等模式）+ WorkspacePage 传 onOpenTerminal 类回调；目标定位 testid：`terminal-rail-detail-header` / `rail-tab-terminals` / `terminals-panel-body`（04 票 Comments 有完整清单）。
- 【04 票衔接】xterm 动态 import 纪律：涉及 xterm 的组件顶层零运行时依赖（6.0 UMD，node 下 named import 不可靠）——本票若触碰 TerminalSessionView 相关文件沿用该形态，SSR 测试用 vi.mock 拦动态 import。
