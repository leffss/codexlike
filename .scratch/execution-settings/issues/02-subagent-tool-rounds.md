# 02: 子代理工具轮次上限

**What to build:** 用户在「执行」分区调整子代理工具轮次上限，复杂委派不再被默认值截断；被截断时报告末尾的截断标记携带当前上限值，主模型据此知道委派未完成。

**Blocked by:** [01: 主任务工具轮次上限端到端](01-main-task-tool-rounds.md)——复用其「执行」分区、存储链路与 resolver 注入模式。

**Status:** done

## Parent

[执行设置 spec](../spec.md)；实施前先读 [notes.md](../notes.md) 与 [ADR 0017](../../../docs/adr/0017-execution-settings.md)。

## Acceptance criteria

- [x] 「执行」分区新增「子代理工具轮次上限」：默认 200、范围 10–1000，非法输入回退默认。
- [x] 子代理配置扩展 resolver（与现有子代理并发设置的注入方式同构）；子代理循环按注入值判断撞限。
- [x] 子代理报告截断标记携带动态上限值；默认 200 时现有截断测试的数字与语义不变、保持全绿。
- [x] 截断标记语义不回归：主模型据此知道委派未完成，不伪造成完成。
- [x] 三层测试覆盖：agent-core 行为测试（注入低值提前截断 + 动态标记）、desktop 存储与 IPC、ui 分区项。

## Comments

- 实现提交 854edbd（分支 execution-settings-02，快进并入集成分支）；实现报告全绿：agent-core 459 / desktop 286 / ui 341。
- 快照点为子代理开始运行时（runSubagent 内）——子代理无独立用户回合，映射理由与 ADR 0017 落地补记一致（48fa604）。
