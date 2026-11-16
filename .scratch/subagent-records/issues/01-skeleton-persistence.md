# 01: 委派骨架落库与 interrupted 留痕

**What to build:** 子代理委派的「曾存在」事实从入队起就落库，且中断不丢：三张子代理表（subagents / subagent_messages / subagent_tool_calls）随库建表（本票只写骨架表，另两张先建空表）；注册行 queued 即写（含委派说明与排队时间）、启动更新 running、终态更新状态与完成时间；应用重启的启动收尾把残留 queued/running 行标记 interrupted。跑一个委派后重开库，骨架行与状态正确；运行中被杀，重开后该行标 interrupted。

**Blocked by:** None (can start immediately)

**Status:** done

指针：[spec.md](../spec.md)、[notes.md](../notes.md)、ADR 0021。

- [x] 三张表 `CREATE TABLE IF NOT EXISTS`，手工旧 schema 库打开幂等补建、旧行可读（照 sqlite-store 测试的补表先例）
- [x] TaskPersistence 扩骨架行接口（插入 / 状态更新 / 按任务列出），`:memory:` 往返 + 文件库关-重开测试
- [x] SubagentHostPort 增持久化通道；注册行 queued 即写、start 更新 running、终态更新状态与完成时间
- [x] 启动收尾把残留 queued/running 标记 interrupted（对齐 pending 交互收尾思路）；文件库重开测试覆盖
- [x] 任务数据清理路径清理 messages/tool_calls 时，子代理三表行同步清理，无孤儿行
- [x] agent-core 全绿、typecheck 0、eslint 0 error
