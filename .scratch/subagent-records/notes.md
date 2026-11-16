# Notes: subagent-records 探索事实

各实现票以本文件为探索指针，避免重复侦查。权威口径：[spec.md](./spec.md)、[ADR 0021](../../docs/adr/0021-subagent-process-records-persisted.md)、GLOSSARY「子代理记录（Subagent Record）」词条。

## 现状事实（改动前的世界）

- 子代理编排器（agent-core `src/task/subagent.ts`）**零持久化调用**：`SubagentHostPort` 只有 emit / requestApproval / now / generateId，无 persistence 通道。
- 落盘唯一样本：轮末等待后 `resultFor()` 把「报告 + thinking 全文拼接」交回主任务，由 agent-task 侧写**一条** `spawn_subagent` 的 ToolCallRecord（thinking 进 reasoning 列）。
- 恢复路径：ui `task-view.ts` 的 `subagentFromToolRecord` 从该行反推——工具清单硬编码空、起止时间置 null；运行中被杀则整条不落（轮末才写）。
- `text-delta` 目前纯内存累积（不发事件、不分轮）；`subagent-reasoning` / `subagent-tool` 事件已有，经 desktop 泛型转发给 UI。
- transcript 联合类型四种 kind（message / tool-call / interaction / compact），消费者是模型上下文组装（恢复续跑 prompt）。

## 关键代码位置

- **agent-core**：`src/task/persistence.ts`（TaskPersistence 接口 + 建表 SQL + ALTER 迁移惯例）；`src/task/agent-task.ts`（主循环落库写入点：工具完成即写、轮终态写 messages，本特性对齐对象）；`src/task/subagent.ts`（子代理循环、SubagentEntry、事件发射点）；`src/task/manager.ts`（启动收尾：pending 交互结算、未完成轮补 aborted——interrupted 收尾对齐此思路；transcript 组装）；`src/task/types.ts`（TaskEvent 联合）。
- **desktop**：`src/tasks/live-tasks.ts`（恢复时 `view(id).history = manager.transcript(id)`；compact 时 `event.history` 整体替换——并行字段须在此保留；事件转发泛型，新事件免费）。
- **ui**：`src/lib/task-view.ts`（`initialTranscript` 恢复重建、`subagentFromToolRecord` 旧路径、`applyTaskEvent` 流式折叠）；`src/components/SubagentRailPanel.tsx`（右栏详情：委派说明块/思考折叠/报告/工具清单折叠）；`src/components/SubagentStreamMarker.tsx`（消息流标记行，`data-subagent-state`）；`src/dev/fixtures.ts`（MAIN_HISTORY + SUBAGENT_EVENTS 样例，DEV 预览用）。
- **e2e**：`packages/desktop/e2e/`（helpers.mjs 的 startMockProvider/openRailPanel/openSubagentDetail；subagents / subagent-thinking / reasoning-recovery 场景）。

## 测试先例（五层缝，票内验收的模板）

1. **Schema**：agent-core `tests/task/sqlite-store.test.ts`——`:memory:` 往返、手工旧 schema 幂等补列/补表（compact_records 补表先例）、临时目录文件库关-重开。
2. **子代理循环**：`tests/task/subagents.test.ts`（makeSubagentTask harness：主/子双 MockLanguageModelV4 按 profile.id 路由、gate Promise + vi.waitFor 受控挂起、事件收集断言、persistence 行断言）+ `tests/task/subagent-thinking.test.ts`（subagent-reasoning 增量断言，subagent-text-delta 的直接模板）。
3. **恢复**：`tests/task/task-manager.test.ts`（transcript 合并；同一文件库两个 manager = 等价重启）+ `tests/task/resume-equivalence.test.ts`（恢复续跑 prompt 一致性 seam）；desktop `tests/tasks/exit-recovery.test.ts`（close → 重开库 → createLiveTasks → view/transcript）。
4. **ui**：`tests/subagent-view.test.ts`（applyTaskEvent / initialTranscript 纯函数直测；现有「恢复后 tools 为空」断言将翻转）+ `tests/rail-panel-ui.test.tsx`（renderToStaticMarkup SSR testid 断言）。
5. **e2e**：`reasoning-recovery.mjs`（跑任务 → closeApp → 重启 → 恢复断言，完整模板）；纯 node 脚本 + playwright-core `_electron` 启生产产物，非 playwright spec。

## repo 约定提醒

- 检查命令直接运行取退出码，不接 `| tail` 类管道。
- 每会话只提交本会话所改文件，按显式路径逐个 `git add`。
- 注释与文档中文；标识符/命令/报错原文不翻译。
- 本机 `python` 是 2，需要时显式 `python3`；heredoc 内不写反斜杠转义序列。
