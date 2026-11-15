# 04: 终端命令超时两项

**What to build:** 用户在现有终端分区调整命令超时与最大命令超时，跑构建/测试不被默认 30s 打断；终端工具按注入值执行，与既有 shell 注入同构。本票不依赖「执行」分区，可与 01 并行。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Parent

[执行设置 spec](../spec.md)；实施前先读 [notes.md](../notes.md) 与 [ADR 0017](../../../docs/adr/0017-execution-settings.md)。

## Acceptance criteria

- [ ] 终端分区新增「命令超时」（默认 30s、范围 5–600s）与「最大命令超时」（默认 120s、范围 10–1800s）。
- [ ] 校验：命令超时 ≤ 最大命令超时；越界或非法输入回退默认。
- [ ] 终端设置文件扩展两项，持久化与损坏 fallback 与现有终端设置一致。
- [ ] 内置终端工具经 options/resolver 按注入值消费超时（不硬编码）；输出截断上限不暴露、保持现状。
- [ ] 三层测试覆盖：工具行为测试（注入超时值生效）、desktop 存储与 IPC、ui 分区渲染与联动校验。

