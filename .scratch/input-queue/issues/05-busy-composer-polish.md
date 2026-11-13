# 05: 忙时输入区收口

Spec: `.scratch/input-queue/spec.md`（术语见 `GLOSSARY.md`；架构见 ADR 0013）

**What to build:** 会话忙时输入区的按钮与输入行为收口：输入框有内容时显示「加入队列」与「停止」并排双按钮（点「加入队列」与 Enter 等效）；无内容时仅显示停止按钮（与现状一致）。忙时提交斜杠命令得到「不入队」提示而不执行、不排队；等待用户交互（审批/问答）期间输入框维持现有禁用行为。

**Blocked by:** 01（忙时入队与逐条自动消费）

**Status:** done

- [x] 忙且有输入：「加入队列」（主操作）与「停止」并排；点「加入队列」将输入内容入队，与 Enter 行为一致
- [x] 忙且无输入：仅停止按钮，外观与现状一致
- [x] 空闲时：按钮区与现状一致（单发送按钮），无队列相关变化
- [x] 忙时提交斜杠命令：提示命令将在回复结束后可用（不入队、不执行）；空闲时命令行为不变
- [x] 等待用户交互期间输入框禁用（现状维持），不提供入队
- [x] e2e：忙时双按钮并排、按钮入队生效、斜杠命令提示

## Comments

- 实现提交:eef03e4(分支经 merger fast-forward 合入 input-queue)
- 双轴 code-review(Standards/Spec)后集中修复:90b18af——pending 拒绝入队、待发计数口径、队列操作收拢等,全部分项见该提交
- 终验(直接退出码):三包 vitest agent-core 434 / desktop 223 / ui 280,lint、typecheck、check:adr、check:e2e-locators 全过;e2e input-queue / -pause / -composer / -items / -restart 及 exit 回归全绿
- Status -> done(2026-11-13,implement-spec 流程)
