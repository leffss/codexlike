# Notes: 子代理工作计划（调研事实沉淀）

来源：2026-11-17 grill 会话的子代理代码调研（Explore 报告）+ ADR 0023。各实现票按指针复用，避免重复探索。spec 见 `spec.md`，决策全文见 `docs/adr/0023-subagent-work-plan.md`。

## 子代理工具表构建（票 01 挂载点）

- 编排器每次委派逐次解析：`packages/agent-core/src/task/subagent.ts` 的 `resolveSubagentTools()`（约 221-225 行）——唯一过滤是剔除 `SUBAGENT_TOOL_NAME`（spawn_subagent）。
- 每次运行把 questionsTool push 进去，再并入资源快照 execution tools（约 423-436 行），对重名与 spawn_subagent 抛「工具名称冲突」——planTool 追加与撞名检查加在同一点（questionsTool 同款模式）。
- update_plan 现状是**结构性缺席**：主任务在 `agent-task.ts` 的 `resolveTaskTools()`（约 433-448 行）内部创建并入（且显式拒绝宿主工具撞名）；宿主装配（`packages/desktop/src/main.ts` 约 522-541 行）传给编排器的 taskTools 不含 update_plan。desktop 侧零改动。

## 策略注入（票 01）

- `PLAN_USAGE_POLICY` 目前仅随主任务每轮 turnSystemPrompt 注入（`agent-task.ts` 约 555-570 行）；`TOOL_STYLE_POLICY` 同为仅主任务（ADR 0016）。
- 子代理系统提示是静态一次性组装：`subagent.ts` 约 392-398 行 `SUBAGENT_SYSTEM_PROMPT + snapshot.systemPrompt`；两条策略常量追加于此（子代理无每轮注入机制）。

## 必破断言（票 01）

- `packages/agent-core/tests/task/subagents.test.ts` 约第 358 行：子代理提示不含「## 工作计划策略」→ 反转为含。
- 同文件约第 366-367 行：子代理工具表不含 update_plan → 反转为含。
- 防递归测试（约 857-915 行，spawn_subagent 剔除）不受影响。
- `update-plan.test.ts` 只测工具本体（parsePlanSteps 校验 + 契约/输出），无任务级集成。

## 子代理记录结构与恢复（票 01/02）

- `SubagentToolCallRecord`（`agent-core/src/task/types.ts` 约 208-221 行）：toolName + arguments JSON 字符串 + output + isError，与主任务同口径；完成即写 `subagent_tool_calls` 表（`persistence.ts` 约 220-231 行建表）。
- 恢复快照 `SubagentSnapshot`（types.ts 约 229-236 行：record + messages + toolCalls）经 manager → desktop live-tasks → IPC 随初始 history 一次性发给 UI。
- 主任务收报告：延迟 tool-result 落主任务 tool_calls 表（`agent-task.ts` 约 825-844 行），子代理过程事件不进主消息流——ui 侧主任务序列零改动。

## plan-view 复用口径（票 02）

- `packages/ui/src/lib/plan-view.ts`：`collectPlanSnapshots` 吃 `MessageSegment[]`（`isPlanSegment` 认 `kind === "tool-call" && toolName === "update_plan"`）——**不能直接喂子代理数据**。
- 子代理工具调用在 ui 侧是 `SubagentToolCall`（`task-view.ts` 约 155-167 行，嵌在 `SubagentSegment.tools`，无 kind 判别字段）。
- `parsePlanSteps(tool.arguments)` 可直接复用（同为 JSON 字符串）；需新增 `SubagentToolCall[]` 的过滤/收集薄壳，`currentPlan` = 最后一次快照。

## 详情体结构与挂卡点（票 02）

- 层级：WorkspacePage → RailPanel（子代理 tab）→ `SubagentRailPanelBody`（摘要行 + 当前行 + 浮层 + 详情）→ `SubagentDetail`（`packages/ui/src/components/SubagentRailPanel.tsx` 约 227-302 行）。
- 滚动容器内容顺序：DelegationBrief → 思考折叠 → 正文折叠 → 状态区（RunningStatus / 排队提示 / interrupted（含工具清单）/ done（报告 + 操作行 + 工具清单））——计划卡挂容器**末尾**（工具清单之后）。
- 主任务卡先例：`WorkPlanCardFromSegments`（items=MessageSegment[]，内部派生，无计划渲染 null 不占行）挂 WorkspacePage 中列 MessageStream 与输入区之间（约 1734-1748 行）——WorkPlanCard 本体已按 items + taskId 参数化，taskId 即 collapse-memory 开合记忆作用域，扩展 subagentId 维度即可。

## 工具摘要与导出（票 03）

- `summarizeToolCall`（`packages/ui/src/lib/tool-summary.ts` 约 75-83 行 default 分支）输出压缩 JSON 截断 60 字符，无 update_plan 专项——加分支输出中文统计摘要（与工具执行输出同口径）。
- `subagentExportMarkdown`（`packages/ui/src/lib/subagent-export.ts`）：现状 = 委派说明头 + 状态/起止 + 逐轮思考/正文 + 最终报告，**不含工具调用**；终态段插「## 最终报告」之前，无计划省略；旧记录（无逐轮数据）回退纯报告导出路径不动。

## 测试基建

- agent-core：`makeSubagentTask` 装配器（subagents.test.ts 约 268-298 行）。
- ui：`subagent-rail-ui.test.tsx`（详情结构）、`subagent-view.test.ts`（段归并/恢复快照，tools 通道已覆盖）、`work-plan-ui.test.tsx`（plan-view 纯函数 + 卡片）、`tool-view.test.ts`、`subagent-export.test.ts`。
- e2e 先例：subagent-interrupted、subagent-recovery-review（消息流标记行定位右栏）、work-plan（plan-card 系 testid）。
- 通用：desktop/ui 测试加载 agent-core dist，两包 test script 已前置 build；检查命令直跑取退出码，不接 `| tail` 类管道（repo AGENTS.md）。

## 嵌套

子代理不能再委派子代理（工具表过滤 + 未注册兜底 + 系统提示 + 守护测试多层防护）——只考虑一层，无孙代理问题。
