# task-concurrency-limit 探索事实（notes）

2026-11-16 会话调研沉淀（grilling → to-spec 阶段的 Explore 报告浓缩）。各实现票从这里取事实，不必重复探索；与本文件冲突时以代码为准并回改本文件。

## 任务启动与发送链路（闸门挂接点）

- UI 发首条消息：`packages/ui/src/pages/WorkspacePage.tsx` `sendFirst`（:802-831）→ `window.codexlike.tasks.start`；后续 `send` → `tasks.send`。
- IPC 通道：`packages/desktop/src/shared/ipc.ts`（`IPC.tasks.start` :98 / `IPC.tasks.send` :112）；preload 暴露在 `packages/desktop/src/preload.ts`。
- 主进程 handler：`packages/desktop/src/tasks/task-ipc.ts` `registerTaskHandlers`（:54）；`tasks:start` handler（:312-493）在 worktree/工作区准备后 `manager.create()`（:435）→ `send()`（:443）。
- 发送核心 `deliverMessage`（:526-665）：校验 → 忙时入输入队列（:592-601）→ `beginExecution`（:195-214，登记 `executions`/interrupts/liveTasks）→ `task.sendMessage()`（:626）。
- **现状无全局闸门**：`executions` 是按 taskId 的 Map（:89）；退出时统一打断（`stopAndDrain` :1163-1174）。任务级排队是全新机制。
- 单任务互斥：`busy` 标志在 agent-core（`packages/agent-core/src/task/agent-task.ts` :450、:516-518）；desktop 不报错而是忙时入队。

## 排队机制要新接触的既有设施

- 输入队列（ADR 0013，本功能最强 prior art）：`packages/desktop/src/tasks/input-queue.ts`（协调器 `createTaskInputQueues` :99，`pump` :163-205，暂停/插话 :297-327）+ `input-queue-store.ts`（持久化）。**排队任务视同忙 → 后续消息走这条路，不改它**。
- 任务活动状态：`packages/desktop/src/tasks/live-tasks.ts`（`createLiveTasks` :30，`TaskActivity` running/waitingForUser/outcome :31-44）→ `tasks.list` 附带（task-ipc.ts :244-249）→ UI `TaskListItem.activity`。`queued` 态加在这条链上。
- 任务状态：`TaskRecord.status`（idle/streaming/waiting-user 等，agent-task.ts :337-345 回调更新）。
- 中断注册：`packages/desktop/src/tasks/interrupt-registry.ts`；任务管理校验 `task-management.ts` `assertCanExecute`（:33-39）只看单任务。

## 设置链路样板（四件套，扩展一个字段）

- store：`packages/desktop/src/execution/agent-settings-store.ts`（六项参数 :33-58，`agent-settings.json`）。
- IPC：同目录 `agent-settings-ipc.ts`（`registerAgentSettingsHandlers` :16-40，边界校验 `parseAgentSettingsInput` :122-165）。
- 主进程缓存：`main.ts` :472-476 → resolver 注入（本功能不走 agent-core，desktop 消费）。
- 范围/默认值单一来源：`packages/agent-core/src/task/execution-settings.ts`（新字段照此模式）。
- UI：`packages/ui/src/pages/SettingsPage.tsx` `ExecutionSettingsSection`（:345-444）。
- 对照先例（desktop 消费的设置）：terminal-settings（`packages/desktop/src/terminal/`）。

## 子代理并发（不要动）

- 上限消费点：`packages/agent-core/src/task/subagent.ts` `startQueued` `while (runningCount() < config.settings().maxConcurrent)`（:258），FIFO :256-283，默认 3（:62），配置接口 :65-88。
- store：`packages/desktop/src/subagents/subagent-settings-store.ts`（1-8 校验 :66-87）。

## UI 呈现接触点

- 侧栏：`packages/ui/src/components/TaskSidebar.tsx`（:123-762）每行 `TaskActivityBadge`（:415）；组件 `packages/ui/src/components/TaskActivityBadge.tsx`（:4-80）。
- 后台任务事件 → 侧栏刷新：WorkspacePage.tsx :640-729（当前打开任务归并消息，其余仅刷侧栏）。
- 任务内状态提示与输入框：WorkspacePage（QueueBar 先例：队列快照随 `tasks.view` 返回，task-ipc.ts :250-258）。

## 测试先例（seam 已确认：唯一新 seam 是任务排队协调器）

- 协调器单测模板：`packages/desktop/tests/tasks/input-queue.test.ts`（依赖全注入 + 内存 store 假件 + 只测状态转移）；持久化 `input-queue-store` 有对应测试。
- IPC 集成：`packages/desktop/tests/tasks/input-queue-ipc.test.ts`、`input-queue-restart.test.ts`（跨重启）、`live-task-ipc.test.ts`、`interactions-ipc.test.ts`。
- 设置：`packages/desktop/tests/execution/agent-settings-store.test.ts` + `agent-settings-ipc.test.ts`。
- UI：`packages/ui/tests/task-sidebar-ui.test.tsx`、`execution-settings-ui.test.tsx`。

## repo 约定提醒（AGENTS.md）

- 检查命令直接跑取退出码，不接 `| tail`；desktop/ui 测试前置 agent-core build（`not a function` 假红教训）。
- 提交只 add 本会话改的文件，逐个显式路径。
