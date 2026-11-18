# 03: 顶栏「+」菜单退役为单按钮

**What to build:** 侧栏顶栏「+」不再弹出「新建独立任务 / 在 {项目} 新建任务…」多选项菜单，改为单一「新建任务」按钮直达新建任务页（独立入口语境，归属在页面内选）。项目组头/独立组头悬停「+」保留为带语境直达。e2e 交互面变化（菜单 testid 退役）在票面记录，实跑归 05。

**Blocked by:** 02（归属选择器——单按钮直达前页面内必须能切归属）

**Status:** done

- [x] 顶栏「+」单击直接进入新建任务页，无菜单弹出；多选项菜单及其 testid（new-standalone-task-item / new-project-task-item）退役
- [x] 项目组头「+」直达该项目新建页、独立组头「+」直达独立新建页（带语境，预选归属）
- [x] 侧栏单测更新过绿（菜单断言删除、单按钮直达断言、组头入口保留断言）
- [x] 空侧栏空态文案与新入口一致（如有「新建」引导文案则指向单按钮）

## Comments

**票 02 衔接（bf9d6ee）**：① `NewTaskStartProps.onSwitchProject` 为必填 prop（当前仅 WorkspacePage 一处挂载，测试桩需同步）。② 单一「新建任务」按钮直达走 `startCreateTask(null)`，**不要**复用 `switchDraftProject`——那是页面内选择器的切换动作，含「切到独立就重置已选目录」副作用，外部入口首次进入独立草稿不应重置。③ `startCreateTask` 现返回 `Promise<boolean>`（false = 恢复失败被更新请求取代，已有中文 toast）；入口点击 `void` 调用即可。④ `/new` 的「沿用显式管理归属」在 `runCommand` 的 `case "new-task"`，无需改动。⑤ e2e：`new-task`/`new-standalone-task-item`/`new-project-task-item` testid 存废会叠加票 02 新增的选择器断言（`draft-project-select` 系），05 号票一并对账 entry-consistency。

**票 03 完成记录（05 号票 e2e 对账清单）**：

- **testid 存废**：`new-task` 保留（仍是顶栏按钮，单击直达）；`new-task-menu` 容器、`new-standalone-task-item`、`new-project-task-item` 随菜单退役，全仓不再存在。
- **交互面变化**：顶栏「+」原「先点 `new-task` 开菜单 → 点 `new-standalone-task-item`」两步，现为 `getByTestId("new-task").click()` 一步直达独立入口草稿。**desktop e2e 共 42 处引用 `new-standalone-task-item`**（compact / export-markdown / external-links / helpers / entry-consistency×2 / exit-recovery×7 / membership / interactions×4 / live-tasks×2 / launch-state-target / persistent-workbench×3 / packaged / message-order / smoke / reasoning-recovery×2 / projects-sidebar×3 / scroll-following×2 / sidebar-archive / window-controls×2 / width-tiers / task-search / worktree×2），合入本票后这些场景全部会红，05 号票统一替换。`helpers.mjs:294` 的共用前置 `prepareDraft` 也在其中——改一处可救一大片。
- **按钮语义变化**：`new-task` 无 `aria-haspopup`/`aria-expanded`（不再有 menu 语义）；title/aria-label 从「新建任务（独立 / 项目）」→「新建任务」。e2e 若按 aria 名定位不受影响（aria-label 一直是「新建任务」）。
- **项目语境入口**：`new-project-task-item`（带 data-project-id）在 e2e 无引用；项目语境直达 e2e 一直走组头 `project-new-task`（保留不动），独立组头 `standalone-new-task` 同样保留。
- **空态文案**：侧栏空态引导去掉「（独立 / 项目）」罗列。注：`groupTasksByProject` 恒含独立分区，侧栏空态分支实际不可达（历史死代码），文案仅同步更新防误导；「暂无任务」无 e2e 引用。
- 单测新增交互直达断言在 `packages/ui/tests/task-sidebar-ui.test.tsx`（文件已转 jsdom + @testing-library，SSR 结构断言保留）。
