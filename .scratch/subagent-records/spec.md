# Spec: 子代理过程记录独立落库

Status: done

对应 ADR 0021（`docs/adr/0021-subagent-process-records-persisted.md`）；GLOSSARY 词条「子代理记录（Subagent Record）」为术语权威口径。

## Problem Statement

子代理运行时用户在右栏「子代理」tab 能看到完整过程（思考流、工具进度、正文），但这一切只存在于内存：重启应用后，子代理详情里工具清单是空的、没有起止时间、思考被拼成一整段失去轮边界；更糟的是，如果应用在子代理运行中退出，整个委派消失得无影无踪——用户连「曾经委派过什么」都无法查证。主代理的每一步都完整落库可回看，子代理却是二等公民。

## Solution

子代理与主代理同等密度记录全程过程：逐轮正文、逐轮思考（保留轮边界）、逐条工具调用、起止时间，逐条实时落库到独立的三张表。重启后右栏子代理详情完整回看（与运行时所见一致）；运行中被中断的委派以「运行中被中断」状态保留已发生的全部内容。这些记录只供检视与导出，不进入主任务恢复后的模型上下文——主任务上下文仍然只拿最终报告。

## User Stories

1. 作为用户，我希望重启应用后打开任务时，子代理详情的工具清单完整回看（名称、参数、结果、成败），以便知道子代理当时具体做了什么。
2. 作为用户，我希望重启后子代理详情显示起止时间与耗时，以便评估这次委派的成本。
3. 作为用户，我希望重启后能逐轮回看子代理正文与思考（保留轮边界，不再是一整段拼接），以便检视子代理的推理叙事在哪里拐弯。
4. 作为用户，我希望运行期右栏详情就有「正文」折叠块逐轮流式出现（与思考折叠块同构），以便运行中跟进子代理进展，而不是只看工具计数。
5. 作为用户，我希望应用在子代理运行中退出后重启，该委派以「运行中被中断」状态出现在列表里，已发生的正文、思考、工具调用全部可回看，以便不丢失已花费的工作痕迹。
6. 作为用户，我希望排队中尚未启动的委派被中断也有记录（含委派说明），以便知道当时排了什么队、为什么没跑。
7. 作为用户，我希望中断委派在消息流的单行标记行上也显示中断状态，以便在叙事线原位看到「这里断过」。
8. 作为用户，我希望失败委派的错误信息在重启后仍可在详情中回看，以便诊断失败原因。
9. 作为用户，我希望导出的子代理 Markdown 包含逐轮正文与思考的结构，以便离线归档与分享。
10. 作为用户，我希望多个子代理并发时各自的记录互不串联（归属清晰），以便逐个检视。
11. 作为用户，我希望旧任务（本特性落地前的记录）恢复后仍照旧显示（工具清单空、无起止时间），以便历史不被破坏。
12. 作为用户，我希望恢复后的会话继续对话时，模型上下文不被子代理过程正文膨胀，以便续聊的质量与 token 成本不受影响。
13. 作为用户，我希望子代理每一步完成即落库（而非攒到结束），以便任意时刻强杀应用都不丢已发生的部分。

## Implementation Decisions

- **存储：三张新表，建表即兼容**。`subagents`（委派骨架：id、所属任务、委派说明、状态、排队/启动/完成时间）、`subagent_messages`（逐轮正文 + 思考 + 时间戳 + 双归属列）、`subagent_tool_calls`（工具名、参数、结果、is_error、时间戳 + 双归属列）；全部 `CREATE TABLE IF NOT EXISTS`，旧库打开自动补建，无 ALTER、无数据迁移。工具结果落库截断口径与主代理 `tool_calls` 一致。
- **状态机**：`queued → running → completed | failed`，新增终态 `interrupted`。注册行 **queued 即写**（入队瞬间插入，status=queued），启动时更新为 running，终态更新状态与完成时间；应用重启的启动收尾把残留 queued/running 行标记 interrupted（与现有 pending 交互收尾同款思路）。
- **持久化通道**：`SubagentHostPort` 增加持久化成员（今天子代理编排器不持有 persistence 引用、零落库调用）；子代理循环内逐条实时写——工具调用完成即写、轮终态即写正文与思考、终态更新骨架行。写点收在子代理循环内，测试仍经 `createAgentTask` 顶层入口驱动。
- **事件模型**：`TaskEvent` 联合新增 `subagent-text-delta`（正文流式增量，形态对齐既有 `subagent-reasoning`），运行期驱动右栏「正文」折叠块。恢复侧不重放该事件——恢复数据走并行字段（见下）。
- **恢复数据面：并行字段而非 transcript 第五种 kind**。transcript 联合类型保持四种 kind 不动（其消费者是模型上下文组装）；`view(id)` 的载荷新增并行 `subagents` 字段，恢复时随初始 history 一次性经 IPC 发给 UI（与 messages 全量发送惯例对齐）。compact 触发 history 整体替换时，并行子代理字段保留（子代理记录与 compact 无关）。
- **spawn_subagent 工具行瘦身**：轮末仍写（主任务 transcript 的 tool result 自包含性不变），output=最终报告，reasoning 不再拼接思考全文（权威记录在子代理侧）。
- **ui 恢复重建**：`initialTranscript` 分支——载荷带并行子代理数据时走新路径（重建骨架 + 逐轮正文块 + 分轮思考 + 工具清单 + 起止时间 + interrupted 状态），无则回退现有 `subagentFromToolRecord` 旧路径。
- **右栏呈现**：详情新增「正文」折叠块（逐轮分段，与思考折叠块同构，collapse-memory 独立键；最终轮即报告轮，完成态报告块呈现不变）；interrupted 状态进列表状态点、详情徽章与消息流标记行。
- **模型上下文隔离**：恢复后 prompt 组装只读 transcript，不读并行子代理字段——这是「不进上下文」的结构性保证，由 resume-equivalence 测试守护。

## Testing Decisions

- 只测外部行为，不测实现细节：断言持久化行内容、事件序列、恢复后的视图形状，不断言内部调用次数或私有方法。
- 五层缝全部复用现有先例（已核对存在直接模板）：
  1. Schema：真 SQLite（`node:sqlite`）——`:memory:` 插入/读回往返 + 手工建旧 schema 验证幂等补表 + 临时目录文件库关-重开等价重启。
  2. 子代理循环落库：`createAgentTask` + 主/子双 MockLanguageModelV4 脚本化驱动，事件断言叠加 persistence 行断言；`subagent-text-delta` 断言照 `subagent-reasoning` 既有写法；受控挂起（gate Promise + waitFor）覆盖中断与并发归属。
  3. 恢复回放：agent-core 层 transcript 合并用例 + resume-equivalence（恢复续跑 prompt 与不重启一致，且**不含**子代理过程内容）；desktop 层「重开库 → createLiveTasks → view/history」先例改造，断言并行 subagents 字段与 interrupted 收尾。
  4. ui：纯函数直测（恢复重建新路径 + 旧路径回退，现有「恢复后 tools 为空」断言翻转为过程重建）+ SSR `renderToStaticMarkup` 的 testid 断言（正文折叠块照思考块模式）+ dev fixtures 补新恢复记录与事件链样例。
  5. e2e：照「重启恢复回放」现成模板改造——跑带子代理的任务 → 关应用 → 重启 → 断言恢复的详情（工具清单、逐轮正文、起止时间）；中断场景（运行中强杀）与排队中断各一例。
- 先例文件：agent-core 的 sqlite-store / subagents / subagent-thinking / task-manager / resume-equivalence 测试，desktop 的 live-task-ipc / exit-recovery 测试，ui 的 subagent-view / rail-panel SSR 测试，e2e 的 subagents / subagent-thinking / reasoning-recovery 场景。

## Out of Scope

- 旧汇总记录的数据迁移（源头无逐轮信息，无意义）。
- 子代理过程内容进入模型上下文（显式排除，见 ADR 0021）。
- 导出格式重设计（只在现有报告导出上补逐轮结构）。
- 子代理记录的独立管理/清理 UI（生命周期跟随任务数据）。
- compact 与子代理记录的交互（天然无关：记录不进上下文，compact 只压缩上下文）。

## Further Notes

- 任务删除/清理路径若清理主任务 messages/tool_calls，子代理三表行须同步清理——implementer 落地时核对现有任务数据清理入口并对齐（勿留孤儿行）。
- 并发写放大不构成约束：并发上限 3、每子代理写入频率与主代理同量级，主代理逐条实时写已是既定事实。
- 多票实现开始前，按仓库惯例把探索事实（布局结构/依赖面/repo 约定）沉淀为 `.scratch/subagent-records/notes.md`，各实现票以指针复用。
- 实现顺序建议：schema 与持久化接口先行（其余全依赖它），随后子代理循环落库与状态机，再恢复数据面（agent-core → desktop），最后 ui 呈现与 e2e。
