# 04: UI 结构改名（文案与 testid 暂留）

术语依据换词后的 `GLOSSARY.md`；上游票 03 已就位（新 channel + 旧名兼容）。

**What to build:** 渲染层组件、状态与 lib 模块的标识符/文件名全部更名 task 系，`window.codexlike` 调用切到新 task 系命名空间与 channel；用户可见中文文案与 data-testid 值**本票一律不动**，保证 e2e 与文案断言不红。

**Blocked by:** 03

**Status:** done

- [x] `Session*` 系组件（侧栏、右键菜单、活跃徽标、搜索、归属对话框等 6 个）文件与导出名更名 task 系
- [x] 状态与 lib 模块更名：工作台页、外部 store、live 事件接续、消息段模型、项目分组、斜杠命令编排、workspace-state 等 session 系命名
- [x] 渲染层全部 `window.codexlike` API 调用切到 task 系命名空间/channel（兼容层仍在，但 UI 侧一步到位）
- [x] 用户可见中文文案与 data-testid 值保持旧值不动（票 05 统一换词）
- [x] UI 全部测试改绿（侧栏 UI、消息段、live、自动批准、项目分组、队列条等）；architecture 守卫通过
- [x] e2e 在本票结束时保持全绿（不动断言的前提下）

## Comments

**实现记录（2026-11-13 ~ 2026-11-14，分支 `session-to-task-04`；前半程原实现者因运行时中断停止，字段级定稿进行到一半（typecheck 已绿、未提交），由接手实现者复核 diff 意图、补全注释缺口后落库）：**

- 提交序列（每提交点 pre-commit 全链：lint / check:adr / check:e2e-locators / lint-staged / typecheck / test）：
  - `97851e7` ui 组件与 lib 结构性改名 session 系 → task 系（`Session*` 组件文件与导出、workspace-state、live 事件接续、消息段模型、项目分组、斜杠命令编排、工作台页）
  - `a8d4348` 渲染层 `window.codexlike` 调用切 `tasks` 命名空间 + `onTaskEvent`；e2e 劫持目标联动 `tasks:*` channel
  - `e1b8920` 跨包字段级定稿 task 系（57 文件，票 03「字段级暂留清单」的定稿项全部落地）：
    - agent-core：`TaskEvent` 自动批准事件 `session-auto-approve-changed`→`task-auto-approve-changed`、字段 `sessionId`→`taskId`；`WorkbenchTarget` 判别式 `{kind:"session",sessionId}`→`{kind:"task",taskId}`（持久化键本为 `["task",…]`，仅输入形状翻转）；manager/persistence 调用点联动
    - desktop：`shared/ipc.ts` 契约字段定稿（`TaskEventEnvelope`/`TaskView`/`TaskExecutionState`/`QueueOperationResult`/`ProjectRemoval.taskIds`/`WorkspaceSharingTarget`/`WorkspaceSharingView.runningTasks`/`QueuedMessage.taskId` 及 `TaskApi`、git API 形参全部 taskId 系）；tasks 各模块、git-ipc、launch-state、mcp-service、main 局部词汇（`liveTasks`/`taskTools`/`findSession` 形参等）与异常文案中参数名（「view：taskId 必须是字符串」等）联动；preload 形参更名
    - ui：workspace-state、WorkspacePage、组件与 lib 消费侧联动（`sharing.runningTasks` 等字段引用）
    - e2e/测试：launch-state 现场目标形状（磁盘 JSON `kind:"task"`/`taskId`，旧现场判非法走默认入口）、persistent-workbench `workbench.read` 载荷、worktree 劫持 `target.taskId`、三包 vitest 断言同步
    - 接手者补全：`shared/ipc.ts` 兼容层注释过时语义修正（「字段暂留旧名」→「字段已随票 04 定稿，别名待票 06 清零」）

**边界遵守：** 全部 diff 零 data-testid 改动、零「会话→任务」文案换词（异常文案仅参数名 `sessionId`→`taskId` 联动，非换词）；兼容层（双注册、preload 旧 `sessions` 命名空间走旧 channel、类型反向别名）原样保留。

**验证（直接退出码）：** 三包 vitest（agent-core 434、desktop 265、ui 280）+ `pnpm -r run typecheck` + `pnpm -r run build` 全绿；受影响 e2e 五场景全绿：smoke、session-search（search）、projects-sidebar（projects）、membership、persistent-workbench（persistence）。

**尚存 session 系残留（归票 05/06）：**

- 票 05：用户可见中文文案与「会话」字样、20 个 session 系 data-testid 值、`data-session-id`/`data-session-select` 焦点恢复 DOM 属性（设置与消费均在 ui 内，无跨界耦合）、磁盘 `sessions/<id>/workspace` 目录、agent-core 斜杠命令文案
- 票 06：agent-core 深层 record 字段 `sessionId`（`InteractionRequest`/`ToolCallRecord`/`StoredMessage`/`CompactRecord`/`ApprovalRequest`/`ToolExecutionContext` 等，与 DB 持久化 JSON 耦合，ui 消费侧已局部映射 `taskId: call.sessionId`）；agent-core/desktop 内部局部形参 `sessionId`；ipc.ts 类型反向别名与 preload 旧命名空间；异常文案中的内插变量名（如 manager.ts `会话不存在：${sessionId}`，「会话」字样本身归票 05）
