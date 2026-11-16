# 03: 恢复数据面——并行 subagents 字段（agent-core + desktop）

**What to build:** 重启后子代理记录随初始 history 一次性到达 UI 侧的数据通道：view 载荷新增并行 subagents 字段（骨架 + 逐轮消息 + 工具调用一次读出）；transcript 联合类型保持四种 kind 不动，模型上下文组装不读并行字段；desktop 恢复时随 history 一次发，compact 触发 history 整体替换时并行字段保留。

**Blocked by:** 01, 02（要有落库数据才有恢复面）

**Status:** ready-for-agent

指针：[spec.md](../spec.md)、[notes.md](../notes.md)、ADR 0021。

- [ ] view 载荷并行 subagents 字段（骨架+消息+工具一次读出）；transcript 联合类型与组装逻辑不动
- [ ] resume-equivalence：恢复续跑 prompt 与不重启一致，且不含任何子代理过程内容（隔离的结构性守护）
- [ ] desktop 恢复：并行字段随初始 history 同一次 IPC 发出，不走按需拉取
- [ ] compact 替换 history 时并行 subagents 字段保留
- [ ] desktop 重启恢复测试断言完整子代理数据（含 interrupted 骨架）
- [ ] agent-core、desktop 全绿、typecheck 0、eslint 0 error
