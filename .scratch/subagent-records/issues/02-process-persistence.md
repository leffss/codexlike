# 02: 逐条工具调用与逐轮正文/思考落库 + subagent-text-delta 事件

**What to build:** 子代理过程内容与主代理同密度实时落库：工具调用完成即写 subagent_tool_calls（名称/参数/截断结果/is_error/时间戳/归属），轮终态写 subagent_messages（正文 + 思考，保留轮边界）；TaskEvent 新增 subagent-text-delta（形态对齐 subagent-reasoning）运行期发射。任何时刻强杀应用，已发生的工具与已完成轮的正文/思考都已在库。

**Blocked by:** 01（持久化通道与骨架行归属）

**Status:** ready-for-agent

指针：[spec.md](../spec.md)、[notes.md](../notes.md)、ADR 0021。

- [ ] 子代理工具调用完成即写行，output 截断口径同主代理 tool_calls
- [ ] 轮终态写逐轮正文与思考（轮边界可辨，时间戳与双归属齐全）
- [ ] TaskEvent 联合新增 subagent-text-delta，子代理循环发射；断言照 subagent-reasoning 既有写法
- [ ] spawn_subagent 行**照旧**（reasoning 继续拼接思考全文）——旧恢复路径与本特性中间态全程绿；瘦身属 04 的 contract 步
- [ ] 并发多子代理受控挂起用例：各自归属互不串联
- [ ] subagents harness 测试：事件断言叠加 persistence 行断言（含轮边界与中断时点的已落库内容）
- [ ] agent-core 全绿、typecheck 0、eslint 0 error
