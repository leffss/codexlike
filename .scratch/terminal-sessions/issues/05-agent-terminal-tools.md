# 05: agent 四工具 + 审批 + 所有权

**What to build:** 模型可真用终端：`spawn_terminal`（初始命令可选）/ `terminal_write(sessionId, input)` / `terminal_read(sessionId, wait?, timeout?)` / `terminal_kill(sessionId)` 经 host port 注入任务循环（SubagentHostPort 装配范式），接 01 的管理器。所有权边界：write / kill 仅限 agent 自己启动的会话（用户会话对 agent 只读），read 任意会话。审批：spawn 的初始命令与每次 write 按现有审批三档逐次判定（复用 decideApproval 与 isRiskyCommand）；超上限 spawn 拒绝并说明。**主任务轮末不得等待会话**——终端不挂 orchestrator.wait 模式，工具即返（spawn 返回会话标识）。工具描述写清与 `run_terminal_command` 的边界（一次性执行 vs 持续会话），后者一字不改。文件指针见 notes.md §2。

**Blocked by:** 01, 02（不需要 03 / 04——工具语义不依赖 UI）。

**Status:** ready-for-agent

- [ ] 四工具落地并进工具注册表；spawn 即返不阻塞对话轮；任务中断不影响已建会话
- [ ] 所有权过滤：write/kill 对用户会话返回明确拒绝；read 任意会话可用
- [ ] 审批逐次：ask 全问 / assist 走 isRiskyCommand / full-access 放行；拒绝路径有测试
- [ ] terminal_read 增量水位 + wait 超时语义有单测（fake port，先例 browser-tools）
- [ ] 超上限 spawn 返回说明性拒绝
- [ ] 工具描述含两类命令工具的适用边界
- [ ] agent-core 单测绿；dev 实跑一条模型侧 spawn → read → kill 通路（结果记票面 Comments）

## Comments

- 【01 票衔接】管理器不做权限过滤——**所有权边界在工具层实现**：write/kill 前判 `record.origin`（且需是本任务 agent 自启的会话，不是任意 origin=agent）；read 任意会话。所有拒绝路径返回可直接回模型的中文 reason。
- 【01 票衔接】`terminal_read` 对已退出会话仍可读（缓冲保留至 discard）——正好支撑「帮用户诊断刚跑完的命令」场景；不要把已退出当错误拒绝。
- 【01 票衔接】工具 read 用增量水位；UI 的 `bufferedOutput` 回放不推水位——两条读取通道互不干扰，勿混用。
- 【类型/接线】agent-core 侧 `createTerminalSessionManager` 经 `/node` 出口；host port 注入范式先例见 notes.md §2（SubagentHostPort）。
- 【中断语义】任务中断不杀会话（ADR 0033）：工具注册/接线时不得把管理器生命周期挂到任务 AbortController 上；abort 中的工具调用自身取消即可，会话留存。
