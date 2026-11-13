# 04: 重启自动继续与后台消费

Spec: `.scratch/input-queue/spec.md`（术语见 `GLOSSARY.md`；架构见 ADR 0013）

**What to build:** 应用重启后，每个会话的输入队列原样恢复：非暂停的队列在会话空闲时自动继续逐条消费；处于队列暂停的队列保持暂停，等用户手动恢复（用户按过停止的意图不被重启偷偷推翻）。用户没有打开的会话，其队列照样在后台消费。

**Blocked by:** 01（忙时入队与逐条自动消费）、02（队列暂停状态机与暂停标志持久化）

**Status:** done

- [x] 应用启动时扫描所有会话：队列非空且会话空闲且非暂停的，自动开始消费
- [x] 暂停标志随队列持久化：重启后暂停态队列保持暂停，不自动消费，恢复入口可用
- [x] 重启后打开会话，队列条显示与重启前一致的队列内容与顺序
- [x] 用户未打开/未查看的会话，其队列在后台照常逐条消费（主进程推进，与查看状态无关）
- [x] e2e：入队两条 → 重启应用 → 队列自动继续消费完毕
- [x] e2e 或集成测试：后台会话（从未切换过去查看）的队列被消费

## Comments

- 实现提交:4e76907(分支经 merger fast-forward 合入 input-queue)
- 双轴 code-review(Standards/Spec)后集中修复:90b18af——pending 拒绝入队、待发计数口径、队列操作收拢等,全部分项见该提交
- 终验(直接退出码):三包 vitest agent-core 434 / desktop 223 / ui 280,lint、typecheck、check:adr、check:e2e-locators 全过;e2e input-queue / -pause / -composer / -items / -restart 及 exit 回归全绿
- Status -> done(2026-11-13,implement-spec 流程)
