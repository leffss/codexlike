# 02: 队列暂停状态机

Spec: `.scratch/input-queue/spec.md`（术语见 `GLOSSARY.md`；架构见 ADR 0013）

**What to build:** 排队消息存在时用户点停止：当前回复中断，队列原样保留并进入「队列暂停」。暂停态下用户可通过队列条手动恢复（从队首继续逐条消费）或清空（作废全部）；也可以不解除暂停直接发新消息插话，插话的回复结束后暂停自动解除、队列继续消费。

**Blocked by:** 01（忙时入队与逐条自动消费）

**Status:** done

- [x] 排队存在时点停止：当前回复按现有中断行为终止，队列原样保留，进入暂停态
- [x] 暂停态在队列条上可见，并提供「恢复」与「清空」操作
- [x] 手动恢复：暂停标志清除，从队首继续逐条自动消费
- [x] 清空：全部排队消息作废删除，队列条消失，无残留
- [x] 暂停期间直接发新消息无需先解除暂停（会话空闲，直接发送）
- [x] 插话的回复结束后自动清除暂停标志并恢复队列消费
- [x] 单测：暂停门控（暂停时不出队）、插话完成→自动恢复的状态转移、清空后不再消费
- [x] e2e：排队 → 停止 → 暂停可见 → 插话 → 插话回复结束 → 队列自动继续

## Comments

- 实现提交:0f37d24(分支经 merger fast-forward 合入 input-queue)
- 双轴 code-review(Standards/Spec)后集中修复:90b18af——pending 拒绝入队、待发计数口径、队列操作收拢等,全部分项见该提交
- 终验(直接退出码):三包 vitest agent-core 434 / desktop 223 / ui 280,lint、typecheck、check:adr、check:e2e-locators 全过;e2e input-queue / -pause / -composer / -items / -restart 及 exit 回归全绿
- Status -> done(2026-11-13,implement-spec 流程)
