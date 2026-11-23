# 07: 收口：README 与全量回归

**What to build:** 目标模式全量收口：README 功能清单补目标模式条目（与审批模式条目同族表述，含 `/goal` 用法一句）；全量检查实跑全绿；GLOSSARY 三词条与 ADR 0035 同实现口径核对（有漂移就地修正并注明缘由，不静默改写）；本 feature 各票验收 checkbox 逐项核对勾选。

**Blocked by:** 02、03、04、05、06

**Status:** ready-for-agent

**上下文指针:** `.scratch/goal-mode/spec.md`（Out of Scope——收口时勿越界做 steering/迭代摘要卡）、`.scratch/goal-mode/notes.md`（e2e 纪律：检查命令不接管道、dist 重建链）

- [ ] README 特性清单含目标模式条目（`/goal`、进度行、护栏一句话级表述）
- [ ] 全量检查实跑全绿：agent-core / desktop / ui 三包 test + typecheck、全仓 build、`test:e2e:all`、`pnpm check:adr`
- [ ] GLOSSARY「目标 / 目标模式 / 完成判定」与 ADR 0035 同实现一致（无静默漂移；有修正注明）
- [ ] 票 02-06 验收 checkbox 全部勾选、Status 置 done；票面 Comments 衔接注意事项完整
