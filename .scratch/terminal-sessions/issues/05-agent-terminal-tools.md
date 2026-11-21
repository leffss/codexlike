# 05: agent 四工具 + 审批 + 所有权

**What to build:** 模型可真用终端：`spawn_terminal`（初始命令可选）/ `terminal_write(sessionId, input)` / `terminal_read(sessionId, wait?, timeout?)` / `terminal_kill(sessionId)` 经 host port 注入任务循环（SubagentHostPort 装配范式），接 01 的管理器。所有权边界：write / kill 仅限 agent 自己启动的会话（用户会话对 agent 只读），read 任意会话。审批：spawn 的初始命令与每次 write 按现有审批三档逐次判定（复用 decideApproval 与 isRiskyCommand）；超上限 spawn 拒绝并说明。**主任务轮末不得等待会话**——终端不挂 orchestrator.wait 模式，工具即返（spawn 返回会话标识）。工具描述写清与 `run_terminal_command` 的边界（一次性执行 vs 持续会话），后者一字不改。文件指针见 notes.md §2。

**Blocked by:** 01, 02（不需要 03 / 04——工具语义不依赖 UI）。

**Status:** done

- [x] 四工具落地并进工具注册表；spawn 即返不阻塞对话轮；任务中断不影响已建会话
- [x] 所有权过滤：write/kill 对用户会话返回明确拒绝；read 任意会话可用（口径收紧为本任务内任意来源/状态——见 Comments 与 ADR 0033 澄清）
- [x] 审批逐次：ask 全问 / assist 走 isRiskyCommand / full-access 放行；拒绝路径有测试
- [x] terminal_read 增量水位 + wait 超时语义有单测（fake port，先例 browser-tools）
- [x] 超上限 spawn 返回说明性拒绝
- [x] 工具描述含两类命令工具的适用边界
- [x] agent-core 单测绿；dev 实跑一条模型侧 spawn → read → kill 通路（mock model 任务循环口径——见 Comments）

## Comments

- 【01 票衔接】管理器不做权限过滤——**所有权边界在工具层实现**：write/kill 前判 `record.origin`（且需是本任务 agent 自启的会话，不是任意 origin=agent）；read 任意会话。所有拒绝路径返回可直接回模型的中文 reason。
- 【01 票衔接】`terminal_read` 对已退出会话仍可读（缓冲保留至 discard）——正好支撑「帮用户诊断刚跑完的命令」场景；不要把已退出当错误拒绝。
- 【01 票衔接】工具 read 用增量水位；UI 的 `bufferedOutput` 回放不推水位——两条读取通道互不干扰，勿混用。
- 【类型/接线】agent-core 侧 `createTerminalSessionManager` 经 `/node` 出口；host port 注入范式先例见 notes.md §2（SubagentHostPort）。
- 【中断语义】任务中断不杀会话（ADR 0033）：工具注册/接线时不得把管理器生命周期挂到任务 AbortController 上；abort 中的工具调用自身取消即可，会话留存。
- 【02 票衔接】desktop 适配器 `createNodePtyPort()` 无参工厂、真件动态加载——agent-core 工具侧无需关心 node-pty；管理器实例由 desktop 装配注入（03 票落 main.ts，本票不动 main.ts 避免合并冲突，`createBuiltinTools` 加可选注入面即可）。
- 【实跑验收口径】票面「dev 实跑一条 spawn → read → kill 通路」：本票（03 未合入时无 desktop 装配）以 **mock model 走真实任务循环**验证四工具接线+审批门+所有权+增量读取（tests/provider/mock-model 与 tests/task/agent-task.test.ts 先例），证据记报告；真凭据真 pty 全链路由 03 装配、09 e2e 与最终用户验收覆盖。按此口径勾验收。
- 落地：票分支 ts-05-agent-terminal-tools commit `74f81e0`，集成合入 `0792c15`。8 文件 +1755/−2（含 main.ts 最小接线，03 合入后解禁）；agent-core 662 绿（基线 625+37），desktop 540 / ui 624 绿，typecheck 0 错，pre-commit 全链过。
- **四工具规格**（06/09 引用）：`spawn_terminal`（permission=command，`command?` 可选初始命令，即返 sessionId+会话名不阻塞轮末）/ `terminal_write`（command，参数字段名定 `command`）/ `terminal_read`（readonly，`sessionId`+`wait?`+`timeoutMs?`，wait 缺省 10s、clamp 上限 60s，250ms 分片可中断）/ `terminal_kill`（write）。返回中文文案自带下一步指引；失败 isError + 管理器中文 reason（上限 5/启动失败/重复 kill 已退出）。
- **审批接入点**：四工具不自带审批——任务循环统一门（decideApproval(definition.permission, commandOfToolInput(input))）；write 参数字段名定 `command` 使命令原文零改动提取，ask 卡片显示命令、assist 走同款 isRiskyCommand 黑名单；agent-task.ts 一字未改，与 run_terminal_command 完全同构。
- **read 边界澄清**：「任意会话」实现为本任务内任意来源/状态（跨任务拒绝）——会话归属任务（ADR 0033），任务是组织与可见性边界；ADR 已补一句澄清，非决策反转。
- mock model 通路证据：tests/terminal/terminal-sessions-task.test.ts 8 用例——spawn→read 增量→write→kill 一条龙且工具结果落库回填 prompt、轮末不等待会话留存、ask 档弹审批卡、assist 档 rm -rf 弹卡且拒绝后 PTY 不启动、超上限 reason 回填、read 中断即断会话 running、kill 后已退出会话仍可读。
- 踩坑：fake pty 时序锚点用 doStream 调用序号注入输出/exit——setInterval 竞速会静默输给任务循环；timeoutMs 上限以描述文案断言夹住（真等 60s 不进全量测试）。
- 未决：env 白名单双处维护（desktop session-env.ts / agent-core filterEnv）待整合票统一单一来源（03 票同款未决）。
