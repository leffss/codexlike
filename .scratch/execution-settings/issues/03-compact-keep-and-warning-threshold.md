# 03: 压缩保留轮数与上下文告警阈值

**What to build:** 用户在「执行」分区调整压缩保留对话轮数与上下文告警阈值：下次 /compact 按新轮数保留现场；上下文用量告警按新阈值提前或延后出现。两项均逐次读取（无回合快照）。

**Blocked by:** [01: 主任务工具轮次上限端到端](01-main-task-tool-rounds.md)——复用其「执行」分区、存储链路与 resolver 注入模式。

**Status:** done

## Parent

[执行设置 spec](../spec.md)；实施前先读 [notes.md](../notes.md) 与 [ADR 0017](../../../docs/adr/0017-execution-settings.md)。

## Acceptance criteria

- [x] 「执行」分区新增「压缩保留对话轮数」（默认 3、范围 1–10）与「上下文告警阈值」（百分比呈现 50–95%、默认 80%），非法输入回退默认。
- [x] compact 按注入值保留最近对话轮数；与现有 `COMPACT_KEEP_ROUNDS` 的行为兼容（默认值下行为不变）。
- [x] 上下文告警按注入阈值判断；与 Provider Profile 逐模型上下文窗口配置正确叠加（阈值是占比，窗口来自 Profile）。
- [x] 两项均逐次读取，无回合快照语义。
- [x] 三层测试覆盖：agent-core 行为测试（compact 保留轮数随注入值变化、告警触发点随阈值移动）、desktop 存储与 IPC、ui 分区项。

## Comments

- 实现提交 85beaa2（分支 execution-settings-03，快进并入集成分支）；实现报告全绿：agent-core 466 / desktop 288 / ui 351。
- 告警阈值评估点在渲染层（ui lib/context-warning.ts 经 IPC 逐次读取），不走 manager/task resolver 装配——偏离 ADR 影响面原文、理由充分，已由 48fa604 补记进 ADR 0017。
- code-review 修复 f4a40cd 将本票 IPC 边界统一为 parse 纯函数（字符串数字拒收）。
