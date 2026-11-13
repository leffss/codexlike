# 01: 忙时入队与逐条自动消费（主干）

Spec: `.scratch/input-queue/spec.md`（术语见 `GLOSSARY.md`；架构见 ADR 0013）

**What to build:** 回复进行中，用户在输入框提交普通消息后，消息不再被拒绝而是进入该会话的输入队列：输入框上方出现只读队列条显示排队情况；当前回复结束后，队列由主进程自动逐条发出（发一条、等其回复完成、再发下一条），直到队列空。用户切走会话不影响该过程。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 会话忙时提交普通消息：经现有 send 通道入队（主进程为单一真相，忙时 send 不再报错），入队时快照 Provider Profile、思考档位、审批模式与 @文件引用，消费按快照发送
- [x] 排队消息随会话持久化到 SQLite；消费成功后从队列移除并入会话消息历史
- [x] 回复结束（activity running=false）后自动取队首发送、等完成再取下一条；入队时若会话已空闲则立即触发消费
- [x] 队列变更（入队、出队发送）作为会话事件推送，复用现有事件信封与会话/序号过滤
- [x] 输入框上方显示只读队列条：条目预览、条数，超过 5 条折叠为「+N 更多」；不进入消息流
- [x] 每会话队列独立：在 A 会话排队不影响 B 会话；切换会话队列原样保留
- [x] 队列模块单测（参照现有会话层纯逻辑测试模式）：逐条消费时序、忙时入队不丢、参数快照、持久化往返
- [x] e2e（参照现有中断用例驱动方式）：回复进行中入队两条 → 回复结束后自动逐条发出

## Comments

- 实现提交:c4fffc1(分支经 merger fast-forward 合入 input-queue)
- 双轴 code-review(Standards/Spec)后集中修复:90b18af——pending 拒绝入队、待发计数口径、队列操作收拢等,全部分项见该提交
- 终验(直接退出码):三包 vitest agent-core 434 / desktop 223 / ui 280,lint、typecheck、check:adr、check:e2e-locators 全过;e2e input-queue / -pause / -composer / -items / -restart 及 exit 回归全绿
- Status -> done(2026-11-13,implement-spec 流程)
