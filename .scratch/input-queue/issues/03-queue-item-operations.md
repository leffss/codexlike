# 03: 队列条目操作

Spec: `.scratch/input-queue/spec.md`（术语见 `GLOSSARY.md`；架构见 ADR 0013）

**What to build:** 排队消息在队列条上是可操作的：单条删除（立即作废）；点击条目把内容取回输入框编辑、重新提交后**原地更新**（不改变顺序）；拖拽重排改变消费顺序。已被取出发送的条目视为「正在发出」，锁定不可操作。

**Blocked by:** 01（忙时入队与逐条自动消费）

**Status:** done

- [x] 单条删除：该条立即从队列与持久层移除，不会被消费
- [x] 取回编辑：点击条目 → 内容载入输入框 → 编辑提交后该条在**原位置**更新（顺序不变）；取消编辑则条目原样保留
- [x] 拖拽重排：改变条目顺序，消费按新顺序进行；顺序持久化
- [x] 正在发出的条目在 UI 上与排队条目区分（对应 spec 用户故事 25），且不可编辑、删除、重排
- [x] 队列操作 IPC（编辑、删除、重排）经主进程修改队列并推送变更事件，多窗口/重开后状态一致
- [x] e2e 或组件级测试覆盖三个操作与「正在发出锁定」

## Comments

- 实现提交:c5fcf05(分支经 merger fast-forward 合入 input-queue)
- 双轴 code-review(Standards/Spec)后集中修复:90b18af——pending 拒绝入队、待发计数口径、队列操作收拢等,全部分项见该提交
- 终验(直接退出码):三包 vitest agent-core 434 / desktop 223 / ui 280,lint、typecheck、check:adr、check:e2e-locators 全过;e2e input-queue / -pause / -composer / -items / -restart 及 exit 回归全绿
- Status -> done(2026-11-13,implement-spec 流程)
