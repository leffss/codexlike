# 03: desktop 主进程与 IPC 契约改名（expand）

术语依据换词后的 `GLOSSARY.md`；上游票 02 已就位（agent-core 新名 + 旧名别名）。

**What to build:** 主进程会话模块目录与文件、IPC 契约全部 channel 与载荷类型、preload 转发整体更名为 task 系；旧 channel 名做双注册兼容，让 UI 与 e2e 在不改的情况下保持全绿。

**Blocked by:** 02

**Status:** done

- [x] 主进程会话模块目录（desktop 内 sessions 系目录）及 14 个模块文件更名为 task 系（IPC 注册、会话管理、live 执行现场、归属、worktree 流程、输入队列等）
- [x] IPC 契约全改：33 个 `sessions:*` channel → `tasks:*`；`SessionEventEnvelope`/`SessionListItem`/`StartSessionInput` 等载荷类型同步更名；主→渲染事件流 channel 同步
- [x] preload 转发表同步更名；渲染层全局类型声明同步更新（ui/src/global.d.ts 属 ui 包零改动面：其 import 的 `CodexLikeApi` 保留旧 `sessions`/`onSessionEvent` 兼容成员，typecheck 不改即绿）
- [x] 旧 channel 字符串**双注册兼容**：同一 handler 同时挂新旧两个 channel 名，现有 UI 调用与 e2e 不改仍绿（票 06 收尾删除）
- [x] 主进程抛给用户的中文异常文案换词（「原会话已移除」等「会话」→「任务」）
- [x] 磁盘 sessions/<id>/screenshots 截图目录约定换为 task 系（自票 02 移交；对应测试的字面断言同步改）
- [x] expand 约束（与票 02 同构）：desktop 侧一切改动须让 ui 包零改动全绿——类型名用反向别名（如 SessionListItem = TaskListItem），channel 双注册；UI 消费面的字段级命名（taskId、kind:"task"、事件字面量 session-auto-approve-changed 等）暂留旧名，随票 04 定稿。agent-core 遗留结构成员（updateSession、createForSession、closeSession、createSessionBranch 等，desktop 是唯一消费者）在本票一并更名并同步 desktop 调用点
- [x] desktop 全部测试改绿（含输入队列系 5 个、live 事件、搜索、恢复等 19 个会话系测试文件）

## Comments

**实现记录（expand 阶段，2026-11-13，分支 `session-to-task-03`）：**

- 提交序列（每提交点三包 vitest + typecheck + build 全绿，pre-commit 含 lint/check:adr/check:e2e-locators）：
  - `0938acb` agent-core 遗留结构成员翻转（见下方清单）+ desktop 调用点
  - `d03d208` desktop `src/sessions/`→`src/tasks/`、4 个 session 系文件更名（task-ipc/task-management/task-membership/live-tasks）、`tests/sessions/`→`tests/tasks/`（live-session-ipc→live-task-ipc）、模块导出标识符翻转、desktop 全量切 agent-core 新名、input_queue 表列 `session_id`→`task_id`
  - `7d4b17d` IPC.tasks 33 channel + 类型更名与反向别名 + preload 双命名空间 + 双注册/双发 + 新增 channel-aliases / preload-task-namespace 测试
  - `265d4a4` 截图目录 tasks/<id>/screenshots + 主进程中文文案换词 + e2e/browser.mjs 截图落盘断言联动

**双注册与双发清单（票 06 contract 阶段删除）：**

- `task-ipc.ts` 的 `dualHandle(task, session, handler)`：33 个 `tasks:*` 与 `sessions:*` channel 同一 handler（新增 `tests/tasks/channel-aliases.test.ts` 断言同引用）
- 事件流：`emit`/`acceptQueue` 推送处向 `task:events` 与 `session:events` 双发同一信封（live-task-ipc.test.ts 断言两 channel 序列一致）
- preload：`taskApi(IPC.tasks)`（新 channel）+ `sessions: taskApi(IPC.sessions)`（**仍走旧 channel**——e2e 对 `sessions:search`/`sessions:view`/`sessions:archive` 的 handler 劫持依赖旧 channel 真实流量）；`onTaskEvent`/`onSessionEvent` 分别订阅 `task:events`/`session:events`

**契约类型反向别名（`shared/ipc.ts`，ui 正在 import，票 06 删除）：**

`SessionEventEnvelope = TaskEventEnvelope`、`SessionActivity = TaskActivity`、`SessionListItem = TaskListItem`、`SessionView = TaskView`、`StartSessionInput = StartTaskInput`、`SessionExecutionState = TaskExecutionState`、`export type { TaskStatusInfo as SessionStatusInfo }`；`CodexLikeApi` 抽出 `TaskApi`，`tasks` 与旧 `sessions` 成员同形状。

**agent-core 遗留成员翻转清单（提交 0938acb）：**

- `TaskPersistence.updateSession` → `updateTask`（agent-task.ts 9 处、manager.ts 3 处、sqlite-store/interactions/task-manager/manager-commands 测试与 desktop exit-recovery 测试同步）
- `WorktreeService.createForSession({ sessionId })` → `createForTask({ taskId })`（worktree-service/parallel-tasks/workbench-ipc 测试同步；其内部中文错误文案字节不动，随票 05）
- `BrowserTaskManager.closeSession` → `closeTask`（browser-manager/browser-tools 测试同步）
- `GitService.createSessionBranch` → `createTaskBranch`（git-service 测试与 desktop git-ipc 同步）

**字段级暂留清单（随票 04/06 定稿清零）：**

- 类型字段 `sessionId`：`TaskEventEnvelope`、`TaskView`、`TaskExecutionState`、`QueueOperationResult`、`WorkspaceSharingTarget`、`ProjectRemoval.sessionIds`、`WorkspaceSharingView.runningSessions`、`QueuedMessage.sessionId`（TS 侧；其 SQL 列已改 `task_id`）
- `WorkbenchTarget` 判别式 `{ kind: "session"; sessionId }`（desktop/ui 构造处字面量暂留）
- `"session-auto-approve-changed"` 事件字面量（agent-core TaskEvent 变体 + live-tasks/ui 判断处）
- `IPC.sessions` 旧 channel 常量集、`IPC.sessionEvents`、preload `sessions` 命名空间与 `onSessionEvent`（见双注册清单）
- 独立任务专用持久目录 `sessions/<id>/workspace`（`task-ipc.ts` 分配/回滚两处）：e2e `projects-sidebar`/`packaged` 直接断言 `<home>/sessions` 目录行为，属 e2e 大面积联动，随票 04/05 处理
- desktop 内部局部词汇：局部变量 `sessionId`、live-tasks 的 `sessions` Map、`mcp-service.sessionTools`/main.ts `sessionTools`、`[sessions]` console tag

**验证：** 三包 vitest（agent-core 434、desktop 265、ui 280）+ 三包 typecheck + desktop/agent-core build + 根 eslint 全绿；`git diff 1c64f48..HEAD -- packages/ui` 为空；e2e 冒烟 smoke / session-search / input-queue（enqueue 场景）三场景退出码 0——其中 session-search 场景包含对 `sessions:search` 旧 channel 的 handler 劫持，直接验证双注册兼容。
