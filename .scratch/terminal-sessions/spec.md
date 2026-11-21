# Spec：终端会话（Terminal Sessions）

Status: ready-for-agent

决策权威来源：ADR 0033（docs/adr/0033-terminal-sessions.md）。词条：GLOSSARY「终端会话」「内嵌终端」。探索事实与文件指针见同目录 notes.md。

## Problem Statement

应用里 agent 执行的命令全是前台同步的：输出在内存里攒到进程退出才一次性返回、有 30k 字符截断、中断粒度只有「停整个任务流」。一条要跑几十分钟的命令（构建、长测试、watch、数据迁移）要么阻塞对话轮直到超时上限，要么用户只能把任务连同它一起停掉；期间 agent 拿不到任何中间输出，用户也看不到进展。用户自己也缺少一个应用内的终端：想敲几条命令就得切出去开系统终端窗口，脱离任务上下文。

## Solution

新增「终端会话」实体：node-pty 驱动的持久 shell 会话，用户与 agent 双端共用。用户在右栏「终端」tab 的新面板里直接交互（全保真：颜色、光标、交互式程序），agent 通过四个工具启动/写入/读取/终止会话——长命令在会话里后台跑，agent 用增量读取追进展，任务中断不杀会话。会话归属任务、按 ADR 0032 拆页导航模式检视；输出不全量落库，会话终止时保留最后一段快照供回看。与现有前台命令工具共存，各管「一次性执行」与「持续会话」两种语义。

## User Stories

用户侧：

1. As a 用户, I want 在任务右栏「终端」tab 新建终端会话, so that 我不切出应用就能敲命令
2. As a 用户, I want 会话以任务工作区为起始目录、shell 类型跟随执行设置, so that 命令直接作用于当前任务的项目且环境与我配置的一致
3. As a 用户, I want 终端完整支持交互式程序（vim、颜色、进度条、交互确认）, so that 应用内的终端体验与系统终端无异
4. As a 用户, I want 列表页按状态分组展示会话（运行中 / 已退出），每行有状态点、名称、来源（用户 / agent）、shell 类型与已用时, so that 一眼掌握有哪些终端在跑什么
5. As a 用户, I want 点开运行中会话进入全保真交互区直接输入, so that 我可以随时介入会话里正在跑的东西
6. As a 用户, I want kill 一个会话且不弹确认, so that 清理终端不需要额外点击（会话可再开，非破坏性）
7. As a 用户, I want 已退出的会话保留最后一段输出快照、点开只读回看, so that 跑了一夜的命令崩掉前打印了什么仍可查
8. As a 用户, I want agent 启动的会话出现在同一列表并标注来源, so that 我能检视模型在终端里做了什么
9. As a 用户, I want 任务中断时终端会话不被连带终止, so that 长命令不因我停止任务而丢失
10. As a 用户, I want 归档任务时若有存活会话收到提示, so that 我不会无意丢掉还在跑的命令
11. As a 用户, I want 应用退出时若有存活会话，退出确认里提示「N 个终端会话将关闭」, so that 退出不会无提示杀死长命令
12. As a 用户, I want 托盘驻留下关闭主窗口时会话继续跑, so that 窗口隐藏不影响长命令
13. As a 用户, I want 会话数超上限时收到明确提示, so that 我知道为什么开不了新会话

agent 侧：

14. As a 主任务 agent, I want spawn_terminal 启动会话并可带初始命令, so that 长命令在后台跑、我的对话轮不被阻塞
15. As a 主任务 agent, I want terminal_read 按读取水位增量返回新输出、可带 wait 参数阻塞等新输出（带超时）, so that 不反复轮询也能追上长命令进展
16. As a 主任务 agent, I want terminal_write 向自己启动的会话追加输入, so that 我能应付交互式提示（y/n 确认等）
17. As a 主任务 agent, I want terminal_kill 终止自己启动的会话, so that 我能收尾超时或失控的命令
18. As a 主任务 agent, I want terminal_read 读取任意会话（含用户手开的）, so that 我能帮用户诊断他们终端里出现的问题
19. As a 主任务 agent, I want spawn 超上限被拒绝且返回说明, so that 我知道应等待会话释放而不是继续尝试
20. As a 主任务 agent, I want 两类命令执行工具的描述写清适用边界, so that 我能为每条命令选对工具（一次性执行 vs 持续会话）

审批与安全：

21. As a 用户, I want agent 的 spawn 与 write 按现有审批模式逐次过审批（ask 全问 / assist 危险命令问 / full-access 放行）, so that 终端不会成为绕过审批的通道
22. As a 用户, I want agent 无法写入或终止我手开的会话, so that 我正在交互的终端不被模型干扰

## Implementation Decisions

- **分层与缝隙**：会话管理器 `TerminalSessionManager` 放 agent-core（纯逻辑：会话注册表、环形缓冲、读取水位、快照、终止），依赖一个小端口接口 `PtyPort`（spawn / write / resize / kill / onData / onExit）；desktop 提供 node-pty 适配器实现该端口——ABI 敏感的原生依赖不进 agent-core。管理器为宿主级常驻（browser-manager 先例），**不挂消息循环、无轮末等待**。
- **进程树终止**：desktop 侧维护按 sessionId 的 kill 注册表（形态仿 interrupt-registry 的 Map）；node-pty 的 kill 需覆盖 Windows 子进程树（参考现有 killTree 的 taskkill /T /F 思路）。
- **agent 侧四工具**：`spawn_terminal`（可带初始命令）、`terminal_write(sessionId, input)`、`terminal_read(sessionId, wait?, timeout?)`、`terminal_kill(sessionId)`。所有权边界：write / kill 仅限 agent 自己启动的会话（用户会话对 agent 只读），read 任意会话。四工具经 host port 注入 agent-core（子代理 host port 同款装配）。
- **审批**：spawn 的初始命令与每次 write 都按现有审批三档逐次判定（复用 decideApproval 与 isRiskyCommand）；用户侧输入天然不审批。
- **工作区边界**：会话 cwd 一律为任务工作区，shell 类型跟随执行设置；`spawn_terminal` 不提供 cwd 参数。
- **生命周期**：会话归属任务；任务中断不杀会话；任务归档时若有存活会话提示后关闭；应用退出并入退出屏障（有存活会话时确认提示）；托盘驻留下关主窗口不触发屏障、会话继续跑。每任务同时存活上限 5：agent spawn 超限拒绝并说明、用户创建超限提示。
- **输出与持久化**：每会话内存环形缓冲 1MB；会话终止时把最后 64KB 写入快照（正常退出 / 被 kill / 应用退出前 flush 三条路径都尽力写）。新增轻量表 `terminal_sessions`（骨架：任务归属、名称、来源、shell、状态、起止时间、快照文本），`CREATE TABLE IF NOT EXISTS` 建表、无迁移（ADR 0021 同款纪律）。重启后存活会话不恢复；已退出会话的快照随任务 view 快照并行字段下发（子代理快照同款）。
- **事件与字节流双通道**：生命周期 `terminal-*` 事件并入现有 TaskEvent 通道（live-tasks 事件白名单加入 terminal 类）；PTY 字节流走专用 IPC 通道直写 xterm.js，不进 React 状态——逐字节流过 React 归并会拖垮渲染；会话读取水位由管理器维护（read 语义：默认增量，wait 参数阻塞等新输出）。
- **UI**：RailPanel 新增第四个「终端」tab，tab 体按 ADR 0032 拆页导航：分组列表页（运行中 / 已退出，空组不渲染；富行两行式：名称 + 状态/来源/已用时元信息）↔ 详情页（顶栏返回 + 状态 + 已用时 + kill 按钮；主体 xterm.js 交互区；已退出会话为只读快照回看）。会话默认名「shell 类型 · 序号」，v1 不做重命名。agent 的 terminal 工具调用卡出现在消息流过程段，点击直跳 rail 终端详情页（子代理标记行 focus 同款机制）。状态口径集中一处（subagent-status 同款收敛）。
- **技术选型**：node-pty（Windows 走 conpty）+ xterm.js（含 fit addon）；引入 Electron 原生模块重编译链（electron-rebuild），desktop 构建链补齐该步骤。xterm.js 的渲染主题对接现有语义 token（ADR 0006/0028）。
- **与前台工具共存**：`run_terminal_command` 保留；两边工具描述写清边界（一次性执行拿输出 vs 持续会话后台跑）。

## Testing Decisions

- 只测外部行为，不测实现细节：工具返回值、事件序列、UI 可见状态、快照内容，不摸内部私有状态。
- **唯一新缝隙 `PtyPort`**：agent-core 单测用 fake PtyPort 驱动 `TerminalSessionManager`（生命周期、缓冲上限、增量水位与 wait 超时、上限 5、快照写入时机、所有权过滤）与四工具（审批门、拒绝路径、输出格式）。先例：browser-manager-lifecycle / browser-tools 同款测试结构。
- **ui SSR**：终端 tab 列表页分组与富行、详情页壳、`terminal-*` 事件在 task-view 的归并（含快照重建）。先例：subagent-rail-ui / subagent-rail-switch / task-view。xterm.js 交互区是 canvas，不做 SSR。
- **desktop e2e**：真 node-pty 场景——新建会话→手敲命令输出可见→agent 侧 spawn/read/write→kill→重启后快照回看→退出屏障提示。先例：desktop e2e subagents 系列。
- 纪律：desktop/ui 的 test 与 typecheck script 已前置 agent-core build（改 agent-core 源码后直接跑会假红）；改 e2e 交互面后合入前必须实跑相关场景（AGENTS.md 既有约定）。

## Out of Scope

- 会话按工作区独立组织、跨任务共享（ADR 0033 已拒绝）
- 重启后恢复存活会话（tmux / attach 类机制）
- 全量输出落库、输出搜索与导出（v1 只有终态快照回看）
- 会话重命名
- `spawn_terminal` 自定义 cwd
- agent 写入 / 终止用户手开的会话
- `run_terminal_command` 退役或改造
- macOS / Linux 下的 pty 适配验证（node-pty 跨平台，但本仓产线只在 Windows 验证）

## Further Notes

- 实现票开工前先读 `notes.md`（探索事实、符号名指针、先例清单），避免重复探索。
- ADR 0033 的「取舍」节记录了全部被拒备选；实现中若想「顺手改进」其中任何一条（如给 spawn 加 cwd、会话级授权），先回 ADR 重开决策，不要在票内自行变更。
- xterm.js 交互区的 e2e 断言走其可访问性/文本层，不依赖 canvas 像素。
