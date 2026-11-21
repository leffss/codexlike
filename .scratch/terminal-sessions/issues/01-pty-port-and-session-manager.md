# 01: PtyPort 接口 + TerminalSessionManager 核心

**What to build:** 终端会话的语义心脏：agent-core 里定义 `PtyPort` 小接口（spawn / write / resize / kill / onData / onExit），并实现 `TerminalSessionManager`——会话注册表、1MB 环形缓冲、增量读取水位、wait 等新输出（带超时）、kill 置终态、来源标记（user / agent）、每任务同时存活上限 5、会话终止时生成尾部 64KB 快照。本票不实现持久化、UI、模型工具（后续票），验证手段是 fake PtyPort 驱动的单测。决策权威：ADR 0033；文件指针见 notes.md §1/§3。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `PtyPort` 接口落 agent-core，agent-core 不引入任何原生依赖（node-pty 被端口隔离在外）
- [ ] Manager 支持按任务归属注册、来源标记、状态机（running → exited，含退出码/信号）
- [ ] 环形缓冲上限 1MB，超限淘汰最旧内容；读取水位增量返回自上次以来的新增输出；wait 参数可阻塞等新输出并受超时约束
- [ ] kill 终止会话置终态；每任务存活上限 5，超限 spawn 返回明确拒绝原因
- [ ] 终止时生成最后 64KB 快照文本（供 08 票落库）
- [ ] fake PtyPort 单测覆盖上述全部语义（先例：browser-manager-lifecycle / browser-tools 测试结构）
- [ ] agent-core test 与 typecheck 绿
