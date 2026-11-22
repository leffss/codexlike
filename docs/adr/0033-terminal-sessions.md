---
status: accepted
---

# 终端会话：双端共用的任务级持久 shell 会话

项目目前没有任何长命令管理机制：`run_terminal_command` 纯前台同步执行（输出内存收集、进程 close 后一次性返回、中断粒度只有任务级 AbortController），命令要么等完要么连任务一起停。决定新增「终端会话」实体：node-pty 驱动的持久 shell 会话，用户可在右栏「终端」tab 的内嵌终端面板中直接交互，agent 也可通过工具操作——两端共用同一会话，这是它与子代理的本质区别之一；另一条本质区别是生命周期：子代理轮末 `orchestrator.wait()` 挂在消息循环上、随任务 abort 共存亡，终端会话是宿主级常驻实体，**任务中断不杀**——长命令要躲开任务中断正是这个功能的存在理由。会话归属任务、在 rail 第四个 tab 用 ADR 0032 拆页导航模式检视（分组列表页 ↔ 详情页，详情页主体为 xterm.js 终端区）。

## 关键边界

- **agent 侧四工具 + 所有权边界**：`spawn_terminal` / `terminal_write` / `terminal_read` / `terminal_kill`；`terminal_write` 与 `terminal_kill` 仅限 agent 自己启动的会话，用户手开的会话对 agent 只读（用户正在 vim 里编辑时会话被模型插字是灾难，read 任意保留「帮我看下刚才那个命令为什么报错」场景）；`terminal_read` 按会话读取水位增量返回，可带 wait 参数阻塞等新输出（带超时），长命令不用反复轮询。read 的「任意会话」澄清为**本任务内**任意来源/状态的会话（会话归属任务，跨任务拒绝）——任务是终端会话的组织与可见性边界。
- **审批逐次照搬现有三档**：`ask` 全问、`assist` 走 `isRiskyCommand`、`full-access` 放行；spawn 的初始命令与每次 write 都算一次命令执行。用户在面板里手敲天然无需审批（用户即授权者）。
- **工作区边界不开口子**：会话起始目录一律为任务工作区，shell 类型跟随执行设置；`spawn_terminal` 不提供 cwd 参数——那是绕过 ADR 0004 权限线的通道。
- **与 `run_terminal_command` 共存**：前台短命令继续用现有工具（跑完拿输出一次往返最省），长命令/交互式/需后台存活的走终端会话，工具描述写清适用边界。
- **输出不全量落库**：每会话内存环形缓冲 1MB，会话终止时把最后 64KB 写入轻量快照记录供回看（正常退出、被 kill、应用退出前 flush 三条路径都尽力写）；重启后会话不恢复。子代理是逐轮批量写、终端是逐字节流，全量落库会打爆 SQLite。
- **退出并入退出屏障**：有存活会话时退出确认提示「N 个终端会话将关闭」；托盘驻留下关闭主窗口照旧不触发、会话继续跑。任务归档时若有存活会话则提示后关闭。
- **进程管理**：node-pty（Windows 走 conpty）出真 TTY，渲染端 xterm.js；引入 Electron 原生模块重编译链。kill 走按 sessionId 的注册表（形态仿 `interrupt-registry`）——现有中断设施没有任何 per-entity 粒度，这是必须新增的缺口。git-bash 的 spawn 形态（标题功能轮从 `--login -i` 调整为**非登录交互 + 托管 init 文件**）：rail 面板窄（约 60 列），登录态默认两行 PS1（`user@host MINGW64 全路径` + `$`，profile.d/git-prompt.sh 无条件设置）路径一长折成两三行英文噪音，正是「会话首屏莫名信息」的来源；托管 init（userData 下生成）自补 PATH、保用户链（.bash_profile/.bashrc）、挂 git 补全并设**单行提示符**（绿色 cwd 末段 + git 分支 + `$`），OSC 0 标题转义保留在 PS1 里喂动态标题。cmd 会话的启动 banner（`Microsoft Windows [版本…]` 两行）无 NoLogo 旗标，以 `/k cls` 清屏消除。
- **事件与恢复**：`terminal-*` 事件走现有 TaskEvent 通道（`live-tasks.ts` 事件白名单需加入），快照恢复照搬子代理快照模式。
- **渲染与尺寸纪律（2026-11-22「首屏重复字符垃圾行 + 复制空选区」根因轮）**：`@xterm/xterm/css/xterm.css` 必须显式引入——包不带 `style` 字段自动注入，缺它时 `.xterm` 失去 `position:relative`（viewport 绝对定位塌陷、选区层坐标基准错乱成空选区、字形 span 缺 `white-space: pre`），终端在「几乎能用」的退化结构下运行；字节闸门：回放与实时字节一律先攒后冲，首个「稳定」fit（相邻两次 ResizeObserver 触发的提案尺寸一致，50ms 兜底防单 fire 卡死）后才按序冲入——pty 全程不经历过渡尺寸，首屏只发生一次 resize，消灭「80×24 spawn → 过渡尺寸 fit → observer 补 fit」多轮 conpty 全屏重绘与 xterm 6.0.0 DOM 渲染器行 diff 交错产出的「单字形平铺整行」垃圾行（字节层干净、`term.refresh` 无法自愈）；管理器 resize 同尺寸去重（ResizeObserver 双 fire 不再触发重复全屏重绘）；剪贴板吞键分支必须显式 `preventDefault`——`return false` 只跳过 xterm 自身按键处理，Chromium 仍由 Ctrl+V 生成原生 paste 事件、xterm 内建粘贴处理器再插一份，与 IPC 桥粘贴叠加成双份。
- **默认值**：每任务同时存活会话上限 5（超限模型侧拒绝、用户侧提示）；会话默认名「shell 类型 · 序号」；列表页分「运行中 / 已退出（快照回看）」两组、富行标注来源（用户 / agent）；用户 kill 不弹确认（非破坏性）。
- **展示标题（标题功能轮，放开 v1「不做重命名」）**：record 增 `title` / `titleSource`，呈现一律 `title ?? name`——默认名退为稳定标识（工具结果、消息流标记行仍用它）。标题两来源：shell 的 OSC 0/2 序列经增量扫描器动态写入（source=auto，conpty 的 exe 绝对路径回声过滤不产出）；用户在详情页顶栏改名（source=user），改名后 OSC 更新不再覆盖（手动命名优先）。标题变化走 `terminal-title-changed` 事件：rail 列表归并跟随；**消息流标记行保持启动时会话身份不重写历史**（ui live-task 闸门不放行该事件）。标题随终态落库（`terminal_sessions` 增 title / title_source 两列，旧库 ALTER 迁移），重启恢复的只读回看行保留标题。

## 取舍

- 拒绝仅用户终端（类似 VS Code 集成终端）：解决不了「运行时间很久的命令没人管」这个功能起点；拒绝仅模型侧：浪费桌面应用做终端 UI 的天然优势，且用户侧交互是检视长命令最直接的形态。
- 拒绝宿主级按工作区组织会话：rail 按任务组织，独立组织维度要新做一套 UI 骨架，第一期不值；任务归属换取子代理整套路 rail/快照/恢复模式可照搬。
- 拒绝任务中断连带杀会话（子代理 abort 语义）：与长命令诉求正相反——终端要躲的正是任务中断。
- 拒绝消息流内嵌终端卡：海量高频输出与轮次分组的消息段模型相克，过程段折叠也架不住逐字节流。
- 拒绝无 TTY 管道模式 + 自绘输出（零原生依赖）：交互保真是终端的核心价值，管道模式做出来是输出查看器不是终端；node-pty 是 VS Code 同款方案。
- 拒绝会话级授权（spawn 批一次、会话内 write 永不再批）：开了「批一次后任意执行」的口子，与「任务自动批准须明确授予」的精神冲突；长命令主痛点在 spawn 那一条（批一次即解决），write 是少数派。
- 拒绝 `spawn_terminal` 替代 `run_terminal_command`：`ls` 这类命令背上一个会话实体的生命周期纯属浪费，「一次性执行」与「持续会话」是两种语义各管一段。
- 拒绝尾部读取（每次返回缓冲最后 N 字节）：把输出去重负担丢给模型，长输出场景必错；水位机制在宿主侧只是一行状态。
- 拒绝全量落库：见「关键边界」；快照口径（最后 64KB）已覆盖「跑了一夜的命令在崩掉前打印了什么」的回看诉求。
