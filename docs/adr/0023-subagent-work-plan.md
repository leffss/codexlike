---
status: accepted
---

# 子代理工作计划：update_plan 下放子代理，计划卡常驻右栏详情底部

ADR 0016 定稿 update_plan 时把子代理明确排除——「计划是任务级状态由主任务独占维护」：子代理工具表不含 update_plan，`PLAN_USAGE_POLICY` 与 `TOOL_STYLE_POLICY` 均仅注入主任务。子代理委派常常天然多步，过程记录已与主代理同密度独立落库（ADR 0021），用户却看不到子代理「打算做什么、做到第几步」。决定下放：子代理获得同款 update_plan 工具与使用策略，计划卡复用主代理形态（ADR 0019 长条形进度折叠卡）常驻右栏详情正文最下方。

## 关键边界

- **归属模型——各自独立**：主任务与每个子代理各自维护自己的计划，互不汇聚、互不可见；主任务计划里「等子代理完成」只是普通计划项。子代理计划只存在于子代理记录（`subagent_tool_calls` 表天然承载，`parsePlanSteps` 纯函数复用），不进主任务模型上下文——ADR 0021「子代理对主任务上下文的贡献只有报告」边界不变。
- **工具挂载**：编排器 `resolveSubagentTools` 追加 planTool——同 questionsTool 模式（每次运行强制并入，资源快照 execution tools 撞名拒绝）；工具本体（readonly 免审批、全量替换语义、计划项 1–50 项/内容 ≤200 字符、中文统计输出）复用同一实现，不复制。
- **策略注入**：`PLAN_USAGE_POLICY` 与 `TOOL_STYLE_POLICY` 复用同一常量注入子代理系统提示（静态注入——子代理无每轮 turnSystemPrompt 机制，随 SUBAGENT_SYSTEM_PROMPT 一次性组装）；「计划未全部完成前不结束回合」持续执行条款随之适用子代理（单回合工具轮次上限 200 对子代理本就生效）。
- **报告边界**：最终报告保持纯文本自包含，不附计划完成度摘要——未完成信号已有兜底（撞工具轮次上限报告追加截断标记；中断随主任务联动中断）。
- **呈现**：复用 `WorkPlanCard`（ADR 0019 形态）挂 SubagentDetail 滚动容器末尾（状态区与工具清单之后）——运行中实时、已完成回看终态、已中断回看最后快照，任何状态常驻；无计划渲染 null 不占布局行；开合记忆走 collapse-memory，作用域按 subagentId（各子代理各自记忆，默认收起同主任务）。
- **工具清单统计行**：`summarizeToolCall` 加 update_plan 专项分支——行内显示中文统计摘要（与工具执行输出同口径），不走 default 分支的压缩 JSON；工具调用计数照常含 update_plan。
- **导出终态段**：`subagentExportMarkdown` 在「## 最终报告」之前插「## 工作计划」终态段（完整清单三态回看），无计划省略——导出定位是子代理记录的离线孪生（ADR 0021 票 04），计划卡成为记录一等检视元素后归档不缺位。
- **摘要行不跟进**：子代理列表摘要行/当前选中行保持现状（总数 + 非零状态计数），不加计划进度微显示——摘要行刚经重构定稿（4568d69/335acb1），保持简洁。

## 取舍

- 拒绝汇聚式（主任务计划自动聚合各子代理进度）：跨代理合成语义复杂，与「独立上下文、贡献只有报告」相悖。
- 拒绝报告附带计划统计行：不扩报告契约，未完成信号已有截断标记与中断联动兜底。
- 拒绝子代理专用简化卡：`WorkPlanCard` 已参数化（items + 作用域 id），不复制组件。
- 拒绝在子代理详情做主消息流式的 PlanMarkerRow 标记行：子代理工具调用本就只有工具清单折叠区一个呈现位，统计摘要分支已覆盖回看，无需第二个标记机制。

影响面：agent-core `task/subagent.ts`（工具表追加 + 撞名检查 + 策略注入）、`tools/update-plan.ts`（注释口径修正——「子代理不注入/工具表不含」表述作废）；ui `lib/plan-view`（SubagentToolCall[] 收集薄壳）、`components/SubagentRailPanel`（挂卡）、`lib/tool-summary`（专项分支）、`lib/subagent-export`（终态段）、collapse-memory（subagentId 作用域）；必破断言反转——subagents.test.ts「子代理提示不含工作计划策略」「子代理工具表不含 update_plan」两条断言改为正向，防递归测试（spawn_subagent 剔除）不受影响；新增 e2e 场景（子代理建计划→更新→完成→重启回看计划卡）与 dev fixtures 子代理 update_plan 样例；GLOSSARY「工作计划」「子代理」词条已更新；本 ADR 修订 ADR 0016 的「仅主任务」边界。
