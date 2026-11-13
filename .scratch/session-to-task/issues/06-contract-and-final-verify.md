# 06: contract 收尾与终验

术语依据换词后的 `GLOSSARY.md`；上游票 02–05 全部完成后本票解锁（expand–contract 的 contract 阶段）。

**What to build:** 删干净所有兼容层与旧名残留——agent-core 旧名导出、desktop 旧 channel 双注册；全仓残留 session 词汇清扫，全链终验绿。

**Blocked by:** 02, 03, 04, 05

**Status:** ready-for-agent

- [ ] 删除 agent-core 公共导出的旧名 re-export 别名
- [ ] 删除 desktop IPC 旧 channel 双注册兼容层
- [ ] 全仓 grep 清扫：`session`/`Session`/`sessionId` 标识符仅存于允许处（GLOSSARY 避免词列表、ADR 历史记录、git 历史），残留清单逐项确认或清除
- [ ] 子代理 `task` 参数与事件字段确认仍为原名（撞名决策未被误伤）
- [ ] 终验全绿（直接退出码）：三包 vitest、lint、typecheck、`check:adr`、`check:e2e-locators`、e2e 全量链、dist
- [ ] `.scratch/session-to-task/` 系列票状态收口
