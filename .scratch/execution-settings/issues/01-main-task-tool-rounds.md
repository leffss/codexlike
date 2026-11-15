# 01: 主任务工具轮次上限端到端（建立「执行」设置链路）

**What to build:** 用户在设置页新增的「执行」分区调整主任务工具轮次上限，保存后下一个回合按新值执行，撞限提示显示当前值。本票随第一项参数打通存储、IPC、设置页分区与 agent-core resolver 注入全链路，建立「执行」分区的完整模式——后续执行参数票（02/03）复用此模式。

**Blocked by:** None (can start immediately).

**Status:** done

## Parent

[执行设置 spec](../spec.md) 是完整契约；实施前先读 [notes.md](../notes.md)（现有链路与消费点事实）与 [ADR 0017](../../../docs/adr/0017-execution-settings.md)（范围界定与注入模式）。

## Acceptance criteria

- [x] 设置页出现「执行」分区，含「主任务工具轮次上限」一项：数字输入、默认 200、范围 10–1000，非法输入回退默认；文案遵循 GLOSSARY「工具轮次」术语。
- [x] 设置经独立设置文件持久化（与现有各设置文件同形态），重启后保留；文件损坏回退默认值。
- [x] IPC get/set 链路可用，主进程持有内存缓存，与现有设置频道同构。
- [x] agent-core 任务创建选项扩展逐次解析的取值函数（resolver 范式，不依赖存储实现）；主任务回合开始时读取一次并快照，进行中回合不受中途调小影响。
- [x] 撞限落库 error 提示携带动态上限值；默认 200 时现有满轮撞限测试的数字与语义不变、保持全绿。
- [x] 主任务撞限后用户可发消息继续（既有行为不回归）。
- [x] 三层测试覆盖：agent-core 行为测试（注入低值提前撞限 + 动态文案）、desktop 存储与 IPC 测试、ui 分区渲染与校验测试。

## Comments

- 实现提交 0a99eac（分支 execution-settings-01，已并入集成分支）；实现报告全绿：agent-core 452 / desktop 276 / ui 334。
- code-review 修复 48fa604 补记 ADR 0017 落地细节；f4a40cd 将本票 IPC 边界统一为 parse 纯函数（字符串数字拒收）。
