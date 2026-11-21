# 08: 快照落库 + 重启回看

**What to build:** 终端输出的持久化口径（ADR 0033：不全量落库，只留终态快照）：新增轻量表 `terminal_sessions`（骨架：任务归属、名称、来源、shell、状态、起止时间、快照文本），`CREATE TABLE IF NOT EXISTS` 建表、无 ALTER 无迁移（ADR 0021 纪律）；三条终止路径写最后 64KB 快照（正常退出 / 被 kill / 退出屏障 flush 挂点接通）；重启后列表页「已退出」组从库恢复、点开只读回看，快照随任务 view 快照并行字段一次性下发（TaskManager 子代理快照同款）。快照只供回看，**不进模型上下文**。文件指针见 notes.md §2/§6。

**Blocked by:** 03, 04。

**Status:** ready-for-agent

- [ ] `terminal_sessions` 表建立，旧库打开自动补建、无迁移
- [ ] 三条终止路径都落快照（不足 64KB 取全量）；快照内容为尾部原文
- [ ] 重启后「已退出」组从库恢复并只读回看；重启前后 UI 呈现一致
- [ ] 快照随 view 载荷并行字段下发，不走按需拉取（对齐恢复传输惯例）
- [ ] 快照不进恢复后的模型上下文（与子代理记录同口径）
- [ ] 单测覆盖建表/写入/快照重建（先例：persistence 与 subagent 快照测试）+ 重启手测记录 Comments
