# 07: 生命周期硬边——中断不杀 / 归档 / 退出屏障 / 重启收尾

**What to build:** 终端会话生命周期与任务/应用生命周期的四条硬边界（ADR 0033 的核心取舍）：任务中断**不**终止会话（中断路径不触达终端注册表——与子代理 abort 共存亡明确相反）；任务归档时若有存活会话，提示后关闭；应用退出并入退出屏障——有存活会话时确认提示「N 个终端会话将关闭」，屏障 flush 留快照挂点（写入本身归 08 票）；托盘驻留下关闭主窗口不触发屏障、会话继续跑；应用重启的启动收尾清空终端注册表（残留 running 会话按已退出收尾）。文件指针见 notes.md §6。

**Blocked by:** 03, 04。

**Status:** done

- [x] 任务中断后终端会话仍存活、输出继续产生（与子代理行为对照验证）
- [x] 任务归档：存活会话提示后关闭，拒绝归档/确认两条路径都可用
- [x] 退出屏障：存活会话计入确认提示；确认后退出、取消后留驻两条路径可用
- [x] 托盘驻留：关主窗口不触发屏障、会话继续；托盘「退出」走完整屏障
- [x] 重启收尾：注册表清空、UI 无幽灵会话
- [x] desktop 单测（先例 exit-flush / close-to-tray）+ dev 手测记录票面 Comments（GUI 链路已在 04 就绪且事件驱动，以单测+集成测试为证据；e2e 实跑 exit-recovery 通过）

## Comments

- 【03 票衔接】应用退出 flush 路径已通：releaseResources 已并入 `terminalSessions.killAll()`（等 exit 齐全 + 2s 兜底强制置终态；测试注入小 `killAllTimeoutMs` 防吃满兜底）。本票补三件事：退出屏障确认提示「N 个终端会话将关闭」（挂进现有退出屏障确认流程）、任务归档提示后关闭（先杀后归档——**顺手闭合 03 票未决口**：任务移除后存活会话的 terminal-exited 事件无现场可挂而静默丢弃）、重启收尾清注册表。
- 【03 票衔接】`terminal-exited` 事件已走 TaskEvent 通道且 live-tasks 白名单三任务态验证过——屏障/归档杀会话后 UI 会自然收到 exited 推进，无需额外通知机制。
- 【任务中断不杀】验证口径：中断路径（InterruptRegistry abort）不触达 manager——desktop 单测断言 abort 后会话仍 running 且输出继续产生（fake pty），与子代理 abort 共存亡行为对照。
- 【04 票衔接】UI 已事件驱动：terminal-exited 推进呈现、已退出详情只读（disableStdin + subscribe buffered 回看）、重启收尾清注册表后 UI 自然无幽灵会话——desktop 侧实现上述生命周期动作即可，无需为 UI 加通知机制。主题如需新语义色只动 `lib/terminal-theme.ts`（语义 token→palette 已收口）。
- 【e2e 现状】rail 系 e2e 已回归通过（changes/subagents/subagent-recovery-review/width-tiers）；subagent-interrupted 为既有损坏（main HEAD 即失败，已两轮基线对照确认）——本票动中断收尾链路时**不要顺手修它**，保持既有失败边界，单独诊断。
- 落地：票分支 ts-07-lifecycle-hard-edges commit `f35a836`，集成合入 `83c9bf6`。15 文件 +1481/−16；desktop 563 绿（+33）/ ui 676 绿（+6）/ agent-core 662 绿，typecheck 0 错，e2e 实跑 exit-recovery 通过。
- **显式偏离声明（编排者接受）**：票面「不动 ui」与「退出确认含 N / 归档提示后关闭」冲突（确认 UI 全在 ui 包）——按最小面动两处：ApplicationExit confirming 终端提示行 + ArchiveTerminalDialog 归档确认卡；终端呈现面（rail/xterm/status/theme/task-view）未动。spec 用户故事 10/11 为权威。
- **挂点清单（08 票接）**：①屏障 flush 快照写入——main.ts registerApplicationExit 的 releaseResources 内 `terminalSessions.killAll()` 调用处（killAll 返回即 exit 齐全、快照已定格，逐条取 exited 记录落库，须在 app.quit 前；注释锚「【08 票衔接挂点】」）；②重启收尾库层衔接——main.ts whenReady 启动收尾区 `settleTerminalSessionsOnStartup(...)` 调用处（08 落库后同点位补库中残留 running 行置终态，须在 UI 从库读已退出列表之前）。
- **行为语义变更（08/09 注意）**：`tasks:archive` 已 async 化——handler 拒绝从同步 throw 变 rejection、返回 Promise；新增 archive 用例按 `await invoke(...)` / `rejects.toThrow` 写。
- **e2e 断言面（09 用）**：退出确认卡终端行 `exit-terminal-note`（「N 个终端会话将关闭。」，N>0 才渲染；`exit-confirm`/`exit-cancel`/`exit-progress` 不变）；归档确认卡 `archive-terminal-dialog` / `archive-terminal-cancel` / `archive-terminal-confirm`，标题「归档「{任务名}」？」正文「该任务有 N 个终端会话仍在运行，归档将关闭它们。……」按钮「取消」/「归档并关闭会话」，Escape=取消；取消归档**不发起 archive IPC**。
- **已知 flaky（非本票引入，单变量排除）**：sidebar-archive e2e 断言「取消置顶恢复最近发送顺序」失败且失败点漂移，基线 4 跑 1 败——疑似毫秒级 lastUsedAt 并列的排序时序敏感；09 收口时失败重跑或单独诊断。
- **未决口（编排者记入积压）**：aliveSessionCount 只数现存任务归属的会话（manager 无全部会话枚举 API，不动 agent-core 约束下）；项目移除删任务后残留孤儿会话不计入提示数但仍被 killAll 清理——项目移除路径的会话收尾提示留后续票。
