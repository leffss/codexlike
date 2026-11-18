# 05: e2e 场景改造实跑

**What to build:** 新建任务交互面（居中起点页、归属选择器、单按钮入口）落定后的 e2e 收口：`entry-consistency` 按新入口语义重写断言（顶栏单按钮、组头语境直达、`/new`、冷启动恢复仍收敛到同一新建页），`projects-sidebar`、`persistent-workbench`（含切归属 = 切入口草稿的新场景）与 worktree 首发流程场景适配改造，全部实跑取绿。AGENTS.md 规矩：改 e2e 交互面合入前必须实跑，单测全绿不算数。

**Blocked by:** 01, 02, 03

**Status:** ready-for-agent

- [ ] `entry-consistency` 新语义断言过绿：四个入口（顶栏单按钮/组头×2/`/new`）进入同一新建页且语境正确；冷启动恢复场景保持
- [ ] `persistent-workbench` 过绿：新建草稿按入口持久化；归属切换后各入口草稿独立恢复
- [ ] `projects-sidebar` 及 worktree 首发流程场景过绿（项目任务本地/Worktree 两种首发路径）
- [ ] ui dist 重建后实跑（e2e 加载 dist，源码改动未重建会假绿/假红，见 notes.md）
- [ ] 相关冒烟场景（window-close/exit-recovery 触及新建态的部分）实跑无回归

## Comments

**票 01 衔接（6bf8e47）**：`worktree.mjs` 在草稿态取 `composer-card` boundingBox 做宽度对齐断言——新布局草稿态为 `new-task-composer`，该断言需改造；`packaged.mjs`/`workspace-opener.mjs` 断言的 `draft-workspace-info` 内 `workspace-path`/`draft-workspace-mode` 嵌套关系已保留；`helpers.mjs` 的 `prepareDraft`（`composer-input`/`composer-send`/`draft-select-workspace`/`approval-mode-select` data-value）全部兼容。另：草稿态 `@` 引用候选现状为空数组（枚举管线只在 openTask 跑），如需补 draft 态 `@` 候选属域语义层变更，不在本票范围。

**票 02 衔接（bf9d6ee）**：新建页标题行为项目选择器（新 testid `draft-project-select`/`-listbox`/`-option-standalone`/`-option-<projectId>`）；标题行「项目 · <名>」「独立任务」静态文本不再渲染，entry-consistency / projects-sidebar 相关断言需改。

**票 03 衔接（ce8e9dd）**：顶栏「+」已为单一按钮（`new-task` testid 保留、单击直达），菜单与 `new-standalone-task-item`/`new-project-task-item`/`new-task-menu` 退役。desktop e2e 共 42 处 `new-standalone-task-item` 引用需替换为 `new-task` 单击一步直达；**`helpers.mjs` 的 `prepareDraft` 共用前置是杠杆点，改一处可救大片**。完整对账清单见 03 号票面 Comments「票 03 完成记录」。
