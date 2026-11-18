# 05: e2e 场景改造实跑

**What to build:** 新建任务交互面（居中起点页、归属选择器、单按钮入口）落定后的 e2e 收口：`entry-consistency` 按新入口语义重写断言（顶栏单按钮、组头语境直达、`/new`、冷启动恢复仍收敛到同一新建页），`projects-sidebar`、`persistent-workbench`（含切归属 = 切入口草稿的新场景）与 worktree 首发流程场景适配改造，全部实跑取绿。AGENTS.md 规矩：改 e2e 交互面合入前必须实跑，单测全绿不算数。

**Blocked by:** 01, 02, 03

**Status:** done

- [x] `entry-consistency` 新语义断言过绿：四个入口（顶栏单按钮/组头×2/`/new`）进入同一新建页且语境正确；冷启动恢复场景保持
- [x] `persistent-workbench` 过绿：新建草稿按入口持久化；归属切换后各入口草稿独立恢复
- [x] `projects-sidebar` 及 worktree 首发流程场景过绿（项目任务本地/Worktree 两种首发路径）
- [x] ui dist 重建后实跑（e2e 加载 dist，源码改动未重建会假绿/假红，见 notes.md）
- [x] 相关冒烟场景（window-close/exit-recovery 触及新建态的部分）实跑无回归

## Comments

**票 05 完成记录（impl-new-task-05）**：

- **42 处对账落地**：desktop e2e 40 处 `new-standalone-task-item` 全部替换为 `new-task` 单击直达（38 处为「new-task click 后紧跟菜单 click」同构删除，`helpers.mjs` prepareDraft 与 `task-search.mjs` create() 两处结构特殊单独改）；ui 单测 2 处为负向断言（断言退役）保留不动。`new-task-menu`/`new-project-task-item` 全仓 e2e 零引用。
- **prepareDraft 杠杆**：`helpers.mjs` 独立分支去掉菜单中间步，`draft-select-workspace`.click()（经 CODEXLIKE_TEST_WORKSPACE 选目录）保留。
- **entry-consistency 语义重写**：顶栏按钮断言改为 title===「新建任务」且无 `aria-haspopup`；新增四入口收敛断言组——顶栏单按钮/独立组头 `standalone-new-task`（e2e 首次覆盖）/项目组头 `project-new-task` 进入同一 `new-task-start` 页，语境经 `draft-project-select` data-value（standalone/projectId）断言；/new 双语境与重启恢复沿用既有断言。
- **新场景**：`persistent-workbench` 增加「切归属 = 切入口草稿」——页面内 `draft-project-select` 独立⇄项目来回切换，各自入口持久草稿（文本 + 思考档位）独立恢复不串用。
- **草稿态断言重写**：`worktree.mjs` 草稿态对齐断言 `composer-card`→`new-task-composer`（工作区卡与输入卡在 800px 居中列内左右缘一致）；`scroll-following.mjs` 两处切走信号 `message-empty`→`new-task-start`；`width-tiers.mjs` 草稿档位断言按居中列语义重写（`assertNewTaskStart`：min(clientWidth,800)−48 期望宽、内容区基准水平居中、工作区卡/输入卡同宽；「已有转新建不跳宽」随旧布局退役删除）。
- **无 Profile 冷启动适配**（spec 用户故事 10 的连带）：`packaged.mjs` 冷启动改为断言引导卡（`draft-empty-start`/`draft-goto-settings`、无表单），经真实 UI 建 Profile 后保留原工作区卡/`workspace-path`/ask 默认断言；`window-controls.mjs` 场景开头补建 Profile（其「草稿跨真退出保存」核心断言需要表单态草稿）。
- **实跑 21 场景全绿**（agent-core→ui→desktop dist 全量重建后）：smoke、entry-consistency、projects-sidebar、persistent-workbench、worktree、width-tiers（两轮修正：居中列内容宽公式与滚动条内容区基准）、scroll-following、exit-recovery、window-controls、interactions、live-tasks、task-search、membership、sidebar-archive、message-order、reasoning-recovery、compact、export-markdown、external-links、launch-state-target（冷启动恢复③⑤b 在内）、packaged（electron-builder 产物实跑）。
- 遗留：无。宽度视觉双主题走查（spec 测试决策的「视觉走查（非自动化）」）不属自动化范围，未在本票执行。

**票 01 衔接（6bf8e47）**：`worktree.mjs` 在草稿态取 `composer-card` boundingBox 做宽度对齐断言——新布局草稿态为 `new-task-composer`，该断言需改造；`packaged.mjs`/`workspace-opener.mjs` 断言的 `draft-workspace-info` 内 `workspace-path`/`draft-workspace-mode` 嵌套关系已保留；`helpers.mjs` 的 `prepareDraft`（`composer-input`/`composer-send`/`draft-select-workspace`/`approval-mode-select` data-value）全部兼容。另：草稿态 `@` 引用候选现状为空数组（枚举管线只在 openTask 跑），如需补 draft 态 `@` 候选属域语义层变更，不在本票范围。

**票 02 衔接（bf9d6ee）**：新建页标题行为项目选择器（新 testid `draft-project-select`/`-listbox`/`-option-standalone`/`-option-<projectId>`）；标题行「项目 · <名>」「独立任务」静态文本不再渲染，entry-consistency / projects-sidebar 相关断言需改。

**票 03 衔接（ce8e9dd）**：顶栏「+」已为单一按钮（`new-task` testid 保留、单击直达），菜单与 `new-standalone-task-item`/`new-project-task-item`/`new-task-menu` 退役。desktop e2e 共 42 处 `new-standalone-task-item` 引用需替换为 `new-task` 单击一步直达；**`helpers.mjs` 的 `prepareDraft` 共用前置是杠杆点，改一处可救大片**。完整对账清单见 03 号票面 Comments「票 03 完成记录」。
