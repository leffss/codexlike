# 02: agent-core 领域改名与新库文件（expand）

术语依据换词后的 `GLOSSARY.md`；决策见票 01 产出的 ADR。

**What to build:** agent-core 包内「会话」领域模型整体更名为「任务」：领域模块目录与文件名、公共类型与接口、事件类型、SQLite 表结构与库文件名、磁盘目录约定全部换为 task 系；对外公共导出暂留旧名别名，让 desktop 的既有引用不破。旧库文件不读不删，从零建新库（已有会话数据弃置，用户已确认）。

**Blocked by:** 01

**Status:** done

- [x] 会话领域模块目录（agent-core 内 session 系目录）及 14 个模块文件更名为 task 系
- [x] 公共类型与接口全改：`SessionRecord`→`TaskRecord`、`SessionManager`→`TaskManager`、`SessionEvent`→`TaskEvent`、`SessionStatus` 等；子代理事件载荷字段 `task` 与 `spawn_subagent` 的 `task` 参数**不动**
- [x] SCHEMA 全改：`sessions` 表→`tasks`，各表 `session_id` 外键列同步更名；增量迁移逻辑按新表名重写
- [x] 新库文件名启用（不复用旧库文件名）；检测到旧库文件存在时不读、不删、不迁移，直接使用新库
- [x] 磁盘截图子目录：实现点在 desktop（screenshots 模块），随票 03 落地（移交）；worktrees 目录用 id 本身做键，不动（已确认）
- [x] 公共导出（包入口的 index/node 出口）暂留旧名 re-export 别名，desktop 现有 import 不改也能通过 typecheck
- [x] agent-core 全部测试改绿（含 sqlite-store 对 schema/迁移的断言、resume 等价、子代理、思考档位等 15 个会话系测试文件）；architecture 守卫通过

## Comments

**实现记录（expand 阶段，2026-11-13）：**

- 提交序列（分支 `session-to-task-02`，每提交点三包 vitest + typecheck 全绿）：
  - `4a5f175` 目录/文件改名：`src/session/`→`src/task/`、`agent-session.ts`→`agent-task.ts`、`tests/session/`→`tests/task/` 及 8 个 session 系测试文件更名（`mcp-task.test.ts`、`parallel-tasks.test.ts` 等）
  - `edf100d` SCHEMA 与新库：`sessions`→`tasks`、5 张子表 `session_id`→`task_id`、索引名 `idx_*_task_*`；增量迁移按新表名重写；desktop `main.ts` 新库文件名常量 `WORKBENCH_DB_FILENAME = "task-workbench.db"`（本票 desktop 唯一改动）
  - `13679d8` 类型与标识符 + 别名：见下方清单
  - `6e91efe` 注释与测试标题词汇换「任务」；运行时字符串（斜杠命令描述、中文错误提示、模型提示词）**字节不变**，随票 05 文案联动

**保留的旧名别名清单（票 06 contract 阶段统一删除）：**

`src/index.ts`：

- `TaskPreferences as SessionPreferences`
- `TaskEvent as SessionEvent`
- `TaskRecord as SessionRecord`
- `TaskStatus as SessionStatus`
- `TaskSearchResult as SessionSearchResult`
- `TaskResourcesView as SessionResourcesView`
- `TaskResourceState as SessionResourceState`

`src/node.ts`：

- `TaskPersistence as SessionPersistence`
- `createSqliteTaskStore as createSqliteSessionStore`
- `AgentTask as AgentSession`
- `CreateAgentTaskOptions as CreateAgentSessionOptions`
- `createAgentTask as createAgentSession`
- `CreateTaskManagerOptions as CreateSessionManagerOptions`
- `TaskManager as SessionManager`
- `createTaskManager as createSessionManager`
- `createBrowserTaskManager as createBrowserSessionManager`
- `BrowserTaskManager as BrowserSessionManager`
- `BrowserTaskManagerOptions as BrowserSessionManagerOptions`

**遗留结构成员（被 desktop/ui 引用，expand 阶段保留旧名，票 03 随桌面侧翻转、票 06 终验清零）：**

- `TaskPersistence.updateSession` 方法（desktop `tests/sessions/exit-recovery.test.ts` 直接调用；同接口其余方法 `insertTask`/`listTasks` 等无 desktop 引用，已换新名）
- `WorktreeService.createForSession({ sessionId })`（desktop `worktree-flow.ts` 调用）
- `BrowserTaskManager.closeSession(sessionId)`（desktop `session-ipc.ts` 调用）
- `GitService.createSessionBranch(name)`（desktop `git-ipc.ts` 调用）
- `WorkbenchTarget` 判别式 `{ kind: "session"; sessionId }`（desktop/ui 构造；`workbenchKey` 输出键已换 `["task", id]`，输入形状待票 03）
- `TaskEvent` 变体的 `sessionId` 字段与 `"session-auto-approve-changed"` 事件字面量（desktop `live-sessions.ts` / ui 引用）
- `StoredMessage` / `ToolCallRecord` / `ApprovalRequest` / `InteractionRequest` 的 `sessionId` 字段（desktop/ui 全量引用，票 03/04 翻转）
- 票02 截图目录验收项移交票03：唯一实现点 desktop/src/sessions/screenshots.ts 及其字面断言测试受「desktop 测试不改必须绿」expand 约束，归属翻转（2026-11-13，编排确认）
- 勘误：验收项「14 个模块文件」为发布票时的调查口径；实际 git rename 检测为 src 9 个（session/ 整目录）+ tests 8 个，属计数表述差异，非范围缩减
