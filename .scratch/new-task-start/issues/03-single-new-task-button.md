# 03: 顶栏「+」菜单退役为单按钮

**What to build:** 侧栏顶栏「+」不再弹出「新建独立任务 / 在 {项目} 新建任务…」多选项菜单，改为单一「新建任务」按钮直达新建任务页（独立入口语境，归属在页面内选）。项目组头/独立组头悬停「+」保留为带语境直达。e2e 交互面变化（菜单 testid 退役）在票面记录，实跑归 05。

**Blocked by:** 02（归属选择器——单按钮直达前页面内必须能切归属）

**Status:** ready-for-agent

- [ ] 顶栏「+」单击直接进入新建任务页，无菜单弹出；多选项菜单及其 testid（new-standalone-task-item / new-project-task-item）退役
- [ ] 项目组头「+」直达该项目新建页、独立组头「+」直达独立新建页（带语境，预选归属）
- [ ] 侧栏单测更新过绿（菜单断言删除、单按钮直达断言、组头入口保留断言）
- [ ] 空侧栏空态文案与新入口一致（如有「新建」引导文案则指向单按钮）

## Comments

**票 02 衔接（bf9d6ee）**：① `NewTaskStartProps.onSwitchProject` 为必填 prop（当前仅 WorkspacePage 一处挂载，测试桩需同步）。② 单一「新建任务」按钮直达走 `startCreateTask(null)`，**不要**复用 `switchDraftProject`——那是页面内选择器的切换动作，含「切到独立就重置已选目录」副作用，外部入口首次进入独立草稿不应重置。③ `startCreateTask` 现返回 `Promise<boolean>`（false = 恢复失败被更新请求取代，已有中文 toast）；入口点击 `void` 调用即可。④ `/new` 的「沿用显式管理归属」在 `runCommand` 的 `case "new-task"`，无需改动。⑤ e2e：`new-task`/`new-standalone-task-item`/`new-project-task-item` testid 存废会叠加票 02 新增的选择器断言（`draft-project-select` 系），05 号票一并对账 entry-consistency。
