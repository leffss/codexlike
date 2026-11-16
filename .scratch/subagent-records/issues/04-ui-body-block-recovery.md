# 04: ui 恢复回看 + 右栏「正文」折叠块 + interrupted 呈现 + spawn 行瘦身

**What to build:** 记录与呈现一致：恢复后右栏详情完整回看（逐轮正文块、分轮思考、工具清单、起止时间、interrupted 状态），运行期右栏新增「正文」折叠块由 subagent-text-delta 流式驱动；旧任务照旧回退旧路径。ui 新路径就位后执行 contract 步：spawn_subagent 行瘦身（reasoning 不再拼接思考全文）。

**Blocked by:** 02（subagent-text-delta 事件）, 03（恢复数据契约）

**Status:** ready-for-agent

指针：[spec.md](../spec.md)、[notes.md](../notes.md)、ADR 0021。

- [ ] initialTranscript 新路径：并行数据重建骨架 + 逐轮正文块 + 分轮思考 + 工具清单 + 起止时间 + interrupted；无并行数据回退 subagentFromToolRecord 旧路径（现有「恢复后 tools 为空」断言翻转为过程重建）
- [ ] 运行期「正文」折叠块：subagent-text-delta 流式、逐轮分段、与思考折叠同构、collapse-memory 独立键；最终轮即报告轮，完成态报告块呈现不变
- [ ] interrupted 进右栏列表状态点、详情徽章与消息流标记行
- [ ] 导出 Markdown 含逐轮正文与思考结构
- [ ] contract 步：spawn 行瘦身（output=报告，reasoning 不再拼），受影响 e2e 断言迁到新路径
- [ ] dev fixtures 补新恢复记录与 subagent-text-delta 事件链样例；纯函数 + SSR 测试
- [ ] agent-core、desktop、ui 全绿、typecheck 0、eslint 0 error
