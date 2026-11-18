# Notes: 新建任务居中起点式（探索事实沉淀）

各实现票以本文件为共享探索基线，避免重复探索。定位写符号名配验证性 grep 提示；行号会漂移，不写。

## 定稿形态

- 一手材料：`prototype/new-task-start` 分支（`5b065fe` 三变体 + `42f9d95` 变体 A 四项修订）。**定稿 = 变体 A「决策台」修订版**：800px 居中列、标题行右侧「项目」选择器、工作区单独成卡、审批/模型/思考一级行（无技能）、圆形上箭头发送按钮。原型组件头注释含全部变体说明；生产转正时按 UI 原型规矩重写（原型代码受 throwaway 约束，不直接提升）。
- 决策记录：`docs/adr/0026-new-task-centered-start.md`；spec：本目录 `spec.md`。

## 草稿态现状（改造对象）

- 挂载分支：`WorkspacePage` 中 `draft`（由 `draftProjectId` 派生，`workspaceState.newDraft(projectId, ...)`）非 null 的渲染路径。grep 提示：`draft-workspace-info`（现工作区信息行）、`draft-select-workspace`、`draft-managed-workspace`、`draft-error`。
- 入口收敛：`startCreateTask(projectId | null)`（flush → loadNewDraft → 上报启动现场 → 清任务态）；调用方：`TaskSidebar` 顶栏「+」菜单（testid `new-task`/`new-standalone-task-item`/`new-project-task-item`）、项目组头 `project-new-task`、独立组头 `standalone-new-task`、斜杠命令 `slash-command-actions` 的 `/new`、冷启动恢复（`initialTarget` kind=new）。
- 草稿持久化：按入口 key `["new", projectId]` 分份，经 `persistent-workbench` → `workbench:read/write` IPC（revision 乐观并发）。**归属选择器切换 = 调用同一 loadNewDraft 语义切入口**，持久化模型不动。
- 首条发送：`sendFirst` → `tasks.start(StartTaskInput{requestId,...})`；成功 `completeNewDraft` + `openTask`，失败 `draft.error` 保留输入。幂等/补偿在 desktop `task-ipc.ts` 的 `tasks:start` handler，本次不动。
- 决策项现状接线：审批 `selectApprovalMode`、模型/思考 `workspaceState.editNewDraft(projectId, {...})`、模式 `WorkspaceModeSelector`（`draft-workspace-mode`）、目录对话框 `tasks.selectWorkspace`（`selectDraftWorkspace`）。

## composer 子件复用（票 01 的 make-change-easy）

- 正式输入卡 `MessageComposer`：审批/模型/思考选择器与 `/`·`@`·`$` 菜单的独立成件程度不一——动手前先 grep 其内部是否已抽出子组件（如 ApprovalModeIcon 已是独立函数）；未抽的按需抽子件，**正式任务侧的 MessageComposer 行为零波及**（只允许 import 共享，不允许改它的行为）。
- 发送图标：`ArrowUpIcon`（MessageComposer 内），圆形 accent 按钮形态照抄。
- `@引用` 候选：`tasks.workspaceFiles`；技能目录：`tasks.draftResources`（草稿态资源预览，见 ADR 0007）。

## 布局与主题

- 主列容器：`@container/task`（内容列宽度分档以本栏为断点，非视口）；内容列宽 `contentWidthClass` + `contentPadding` 对齐惯例——新建页居中列是新形态，不复用 contentWidthClass，但左右留白要与其协调。
- 主题：语义 token Tailwind 类（`bg-canvas`/`bg-surface`/`bg-surface-muted`/`text-fg`/`text-fg-muted`/`text-fg-subtle`/`border-line`/`text-accent`/`bg-selected`/`bg-hover`/`text-on-accent`/`bg-warn-bg`/`text-warn-fg`/`bg-overlay`/`bg-danger-solid`），随 `data-theme` 双态（ADR 0006）。
- e2e 的 ui dist 新鲜度：desktop e2e 加载 ui dist——改 ui 源码后必须重建再跑 e2e（launchTarget 有 mtime 检查会拦截，但别依赖拦截）。

## 测试

- ui 组件单测先例：`tests/task-sidebar-ui.test.tsx`、`tests/workspace-opener-ui.test.tsx`（@testing-library/react，testid + 中文文案断言）。
- e2e 场景（desktop `e2e/`）：`entry-consistency.mjs`（入口收敛断言，本次语义大改）、`projects-sidebar.mjs`、`persistent-workbench.mjs`、worktree 首发断言散在相关场景；helpers 有 `prepareDraft` 共用前置。
- 检查命令直接取退出码，不接管道（AGENTS.md）。

## 分支上待带上的顺手修复

- `packages/ui/src/dev/browser-stub.ts` 补 `openers` 与 `tasks.draftResources` 两个 stub 缺口（缺它们纯浏览器 dev 预览进草稿态即整树崩）。已在原型分支，实现票合入时带上 main。

## 域语义红线（票面勿越）

首条发送才创建任务；草稿按入口持久化；requestId 幂等与失败补偿；独立入口无 Worktree；工作区首次执行后固定；内部标识符与 `draft-*` testid 不改。
