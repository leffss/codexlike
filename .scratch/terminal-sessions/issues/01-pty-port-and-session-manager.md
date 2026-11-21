# 01: PtyPort 接口 + TerminalSessionManager 核心

**What to build:** 终端会话的语义心脏：agent-core 里定义 `PtyPort` 小接口（spawn / write / resize / kill / onData / onExit），并实现 `TerminalSessionManager`——会话注册表、1MB 环形缓冲、增量读取水位、wait 等新输出（带超时）、kill 置终态、来源标记（user / agent）、每任务同时存活上限 5、会话终止时生成尾部 64KB 快照。本票不实现持久化、UI、模型工具（后续票），验证手段是 fake PtyPort 驱动的单测。决策权威：ADR 0033；文件指针见 notes.md §1/§3。

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `PtyPort` 接口落 agent-core，agent-core 不引入任何原生依赖（node-pty 被端口隔离在外）
- [x] Manager 支持按任务归属注册、来源标记、状态机（running → exited，含退出码/信号）
- [x] 环形缓冲上限 1MB，超限淘汰最旧内容；读取水位增量返回自上次以来的新增输出；wait 参数可阻塞等新输出并受超时约束
- [x] kill 终止会话置终态；每任务存活上限 5，超限 spawn 返回明确拒绝原因
- [x] 终止时生成最后 64KB 快照文本（供 08 票落库）
- [x] fake PtyPort 单测覆盖上述全部语义（先例：browser-manager-lifecycle / browser-tools 测试结构）
- [x] agent-core test 与 typecheck 绿

## Comments

- 落地：票分支 ts-01-pty-port-manager commit `5b8e8d7`，集成合入 `fd6072e`。6 文件 +1321 行；新增 32 用例全绿，agent-core 625 全量绿，typecheck 0 错，pre-commit 全链绿。
- 落位：`agent-core/src/terminal/`（pty-port.ts 接口 / types.ts 域类型与常量 / manager.ts 实现）；类型经根出口 type-only、实现与常量经 `/node` 出口（ui 可安全 import type）。
- **PtyPort 形状**：`spawn(request) → PtyProcess` 同步返回（对齐 node-pty；shell 不可用 throw）；PtyProcess 含 pid / write / resize / kill / onData / onExit（均返回退订函数）；**约定 kill 后适配器必须触发 onExit**——管理器终态与快照由 exit 事件驱动，killAll 的兜底超时只是防挂死不是正常路径。
- **Manager API**：`createTerminalSessionManager({ port, maxAlivePerTask=5, maxBufferBytes=1MiB, killAllTimeoutMs=2000, generateId, now })`；spawn（ok/reason 判别 union，中文 reason）/ write / resize（已退出静默）/ read（增量水位，waitMs 阻塞，truncated 标记未读被淘汰）/ kill（只调端口）/ killAll（等 exit 齐全，退出 flush 用）/ session / sessionsFor（含已退出）/ discard（仅移除已退出）/ onEvent（terminal-started/exited 携带 record 副本）/ onSessionData（实时字节流）/ bufferedOutput（不推水位的初始回放）。record：sessionId/taskId/name（「shell · 任务内序号」不复用）/shell/origin/status/createdAt/exitedAt/exitCode/signal/snapshot。
- 未决问题（下游出现场景再议）：read 并发 wait 同会话共享水位（先唤醒者取走全部增量）；名字序号计数器随宿主常驻不清理（序号不复用语义）；兜底置终态 record 无 exitCode（08 票落库需容忍缺省）。
- 踩坑：单条输出超 1MB 时「至少保留一个 chunk」保护会突破缓冲上限——已改为单块超限截尾保留。
