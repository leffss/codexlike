---
status: accepted
---

# 子代理：过程记录独立落库，与主任务 transcript 同密度

子代理此前不落库任何过程记录：运行期只有内存事件流（经 desktop 转发给 UI 实时展示），落盘的仅是轮末一条 `spawn_subagent` 工具调用行（委派参数 + 最终报告 + thinking 全文拼接）。重启后子代理的工具清单清空、起止时间丢失、逐轮边界不可辨；运行中被杀则整个委派无痕消失（spawn 行轮末才写）。决定让子代理与主代理同等密度记录全程——逐轮正文、逐轮 thinking 边界、逐条工具调用、起止时间、被中断留痕——但独立存储、只供检视：子代理对主任务模型上下文的贡献仍然只有报告本身。

## 关键边界

- **三张新表**：`subagents`（委派骨架：委派说明、状态、起止时间）、`subagent_messages`（逐轮正文 + thinking）、`subagent_tool_calls`（逐条工具调用，output 截断口径同主代理）；`CREATE TABLE IF NOT EXISTS` 建表，旧库打开自动补建，无 ALTER、无数据迁移。
- **注册行 queued 即写**：入队瞬间插入（status=queued），启动 UPDATE 为 running，终态 UPDATE 状态与完成时间；应用重启的启动收尾把残留 queued/running 行标记 `interrupted`（与 pending 交互的收尾同款思路）。被杀委派已发生部分完整可回看。
- **逐条实时落库**：与主代理主循环一致（工具调用完成即写、轮终态即写），不做轮末批量——「一样」的留痕语义要求已发生即已落盘。
- **不进主任务模型上下文**：恢复后主代理 transcript 组装不读子代理表。`spawn_subagent` 工具行保留但瘦身：output=最终报告（主任务上下文的 tool result 自包含性不变），reasoning 不再拼 thinking 全文（权威记录在子代理侧，双份存储无消费者）。
- **记录与呈现一致**：运行期新增 `subagent-text-delta` 事件，右栏详情新增「正文」折叠块（逐轮分段，与 thinking 折叠同构，collapse-memory 各自记忆），最终轮即报告轮；恢复后同构回看，导出 Markdown 随之含逐轮结构。
- **恢复传输**：子代理记录随初始 history 一次性经 IPC 发给 UI（与 messages 全量发送惯例对齐），不走按需拉取。
- **旧数据回退**：旧任务仍走 `subagentFromToolRecord` 反推路径——有新表行用新路径，无则回退；旧汇总记录里没有逐轮信息可拆，迁移无意义。

## 取舍

- 拒绝复用 `messages`/`tool_calls` 表加 `subagent_id` 归属列：隔离寄托在「每次 transcript 组装都记得过滤」上，漏一处就把子代理正文喂回模型上下文，踩穿「不进上下文」边界。
- 拒绝单张 `subagent_events` 事件表（类型列 + JSON payload）：查询与重建都要解 JSON，与主代理分表结构不对齐，后续演进加列困难。
- 拒绝「start 才写注册行」（排队期无痕）：「曾委派过」的事实从入队就成立，省一次 insert 换来排队中被杀的委派消失，与留痕语义相悖。
