# ui-redesign 实现探索笔记（供实现票使用）

## 一手材料指针

- Spec：`.scratch/ui-redesign/spec.md`；票：`.scratch/ui-redesign/issues/01..05`
- 原型 primary source：分支 `prototype/ui-redesign`（abf070e）
  - **胜者变体 D**：`packages/ui/src/prototype/variants/variant-d.tsx`（标题栏 + overlay 抽屉 + toast 的 JSX 骨架与观感参数）
  - 样例内容库：`variants/sample-content.tsx`；切换条：`prototype-switcher.tsx`
  - 查看方式：`git show prototype/ui-redesign:packages/ui/src/prototype/variants/variant-d.tsx`
  - 原型定位：throwaway 参照物——把骨架**重写进真实组件**（真实数据管线 + testid + 错误处理），不是搬静态样例
- 定位器约定：`CODING_STANDARDS.md` §「E2E 定位器」；强制检查 `node scripts/check-e2e-locators.mjs`
- e2e 场景登记三处：desktop package.json scripts + 全链脚本 + `packages/desktop/e2e/README.md` 表

## 现状结构（重构前）

- 主窗口：`App.tsx`——frameless Header（品牌 + 副标题 + `theme-toggle` / `settings-open`|`settings-back` + WindowControls，testid `window-titlebar`）+ main（workspace/settings 视图切换）
- `WorkspacePage`（pages/WorkspacePage.tsx，约 1580 行）：
  - 左栏 `TaskSidebar`：w-72 固定常驻（testid `task-list` / `task-row` / `task-item` / `task-label` / `new-task` / `add-project`，DOM 属性 `data-task-id`）——**本 feature 不动**
  - 中列 `@container/task` 容器（宽度分档 `TASK_CONTENT_WIDTH_CLASS`：`@min-[864px]/task`、`@min-[1280px]/task` 三档）从上到下：
    1. 任务头行：`task-title` + TaskSearch + `resources-toggle` + `changes-toggle`
    2. workspace-info 行：`workspace-path` + `workspace-mode` + `workspace-origin` + 草稿目录选择（`draft-select-workspace` / `draft-managed-workspace` / WorkspaceModeSelector）
    3. 五类提示横条：`workbench-save-error` / `unavailable-profile` / `context-warning` / WorkspaceSharingNotice / TaskAutoApproveStatus
    4. MessageStream（flex-1 滚动；滚动跟随、阅读位置记忆，testid `message-stream` 等）
    5. 底部：InteractionPanel 或 MessageComposer（`composer-region` / `composer-card` / `composer-input`，-mx-2 外扩 8px）+ QueueBar
  - 右栏 rail：resourcesOpen||changesOpen 时渲染，`w-96`/`w-[30rem]`，`max-w-[40%]`，两面板纵向堆叠共享高度（AgentResourcesPanel `resources-panel`、ChangesPanel `changes-panel`）
- 主题：语义 token（--canvas/--surface/--fg/--fg-muted/--fg-subtle/--line/--accent/--ok/--warn/--danger/--info/--worktree 等）`@theme inline`（ADR 0006），light/dark 双主题
- 状态：`workspace-state.ts` 自定义 observable store + `useSyncExternalStore`；事件经 `window.codexlike.onTaskEvent`
- 窗口：desktop main 进程 BrowserWindow 默认 1280×800、`frame: false`、**无 minWidth/minHeight**；launch-state 恢复 bounds
- IPC：`window.codexlike`（`CodexLikeApi`，desktop/src/shared/ipc.ts 单一类型契约）

## e2e 依赖面（联动范围）

- `window-controls.mjs`：`window-titlebar` + 窗口控制行为
- `width-tiers.mjs`：容器分档宽度 + `workspace-info` 断言——**重基线点**：右栏改 overlay 后断言抽屉自身宽度约束
- `projects-sidebar.mjs` / `sidebar-archive.mjs`：侧栏布局（侧栏本身不动，改中列时别破）
- `entry-consistency.mjs`：`new-task` / `add-project` / `workspace-info`（workspace-info 删除后重基线）
- `worktree.mjs`：composer 8px 外扩断言（composer-region 结构保留则低风险）
- `theme.mjs`：`theme-toggle`（迁标题栏后仍按 testid 断言）
- `packaged.mjs`：冷启动断言含 `workspace-info`（票 05 更新）
- 运行方式：`packages/desktop/e2e/README.md`（单场景直跑；全链 `test:e2e:all`——单票只跑相关场景，全链留给票 05）

## 关键约束（repo 约定，AGENTS.md / CODING_STANDARDS.md 为准）

- 注释与提交信息中文；代码标识符英文
- 提交只按显式路径 `git add <file>`（禁 `git add -A`/`git add .`）
- 检查命令直接运行取退出码，**不接 `| tail` 类管道**
- 主题只用现有语义 token，不引入组件库（ADR 0006）
- 词汇遵循 ADR 0014（任务/工作区/托管 Worktree/消息流……），GLOSSARY.md 为准
