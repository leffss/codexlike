# 04: 终端命令超时两项

**What to build:** 用户在现有终端分区调整命令超时与最大命令超时，跑构建/测试不被默认 30s 打断；终端工具按注入值执行，与既有 shell 注入同构。本票不依赖「执行」分区，可与 01 并行。

**Blocked by:** None (can start immediately).

**Status:** done

## Parent

[执行设置 spec](../spec.md)；实施前先读 [notes.md](../notes.md) 与 [ADR 0017](../../../docs/adr/0017-execution-settings.md)。

## Acceptance criteria

- [x] 终端分区新增「命令超时」（默认 30s、范围 5–600s）与「最大命令超时」（默认 120s、范围 10–1800s）。
- [x] 校验：命令超时 ≤ 最大命令超时；越界或非法输入回退默认。
- [x] 终端设置文件扩展两项，持久化与损坏 fallback 与现有终端设置一致。
- [x] 内置终端工具经 options/resolver 按注入值消费超时（不硬编码）；输出截断上限不暴露、保持现状。
- [x] 三层测试覆盖：工具行为测试（注入超时值生效）、desktop 存储与 IPC、ui 分区渲染与联动校验。

## Comments

- 实现提交 bd61fb7（分支 execution-settings-04，已并入集成分支）；实现报告全绿：agent-core 454 / desktop 277 / ui 334。
- code-review 修复 e4c85ff：读取侧越界由夹紧统一为回退默认（整对回退保持「最大 ≥ 命令超时」形状约束）；48fa604 补记 ADR 0017。
- 工具描述改为不含硬编码数字（e4c85ff）——设置改后模型可见文案不再过时。
