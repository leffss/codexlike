# 02: 项目归属选择器

**What to build:** 新建任务页标题行右侧新增「项目」选择器：可选某个项目或「不选项目（独立任务）」。选择某项目即切换到该项目入口的持久草稿（文字、发送偏好随之恢复），选「不选」切到独立入口草稿——切换语义等同从对应入口进入（复用既有 loadNewDraft 路径，持久化模型一寸不动）；工作区行形态随归属即时变化，切换时重置独立任务的已选目录状态。`/new` 与组头「+」的语境直达照旧。

**Blocked by:** 01（居中起点页骨架）

**Status:** done

- [x] 选择器列出「不选项目（独立任务）」与全部项目；初始值为进入入口的语境
- [x] 切到某项目：工作区行变项目目录 + 本地/Worktree；该项目入口持久草稿的文字与设置恢复到输入壳
- [x] 切到不选：工作区行变独立任务形态；独立入口持久草稿恢复；已选目录状态重置
- [x] 切换后发送首条消息，任务按当前归属创建（项目任务/独立任务各验证一次）
- [x] 启动现场上报的 target 随切换更新（切走的入口现场不被错误恢复）
- [x] 单测覆盖：切换驱动工作区形态、草稿内容随切换恢复/保留
- [x] 归属选择器变更随 e2e 交互面记录，供 05 号票实跑（本票不跑 e2e）

## Comments

**票 01 衔接（6bf8e47）**：接入点已预留——`NewTaskStart.tsx` 标题行右侧现为静态语境 `<span>`（组件内搜「票 02」注释有标记），`projects` 与 `onEditDraft` 已传入组件；工作区卡已按 `draft.projectId` 驱动形态，无需再动。切换归属在 WorkspacePage 层新增回调（走 `startCreateTask(projectId)` 同语义）并按 spec 重置独立任务已选目录。

**票 02 实现记录**：标题行右侧替换为「项目」选择器（`ComposerSelect` 同款）；`NewTaskStart` 新增必填 prop `onSwitchProject(projectId | null)`；`WorkspacePage.switchDraftProject` 走 `startCreateTask` 同语义（该函数改为返回 `Promise<boolean>`：恢复失败/被更新请求取代时 false，切换失败不误重置目录），切到独立入口时经既有 `editNewDraft(null, { workspacePath: undefined })` 重置已选目录并写回持久（与「使用专用目录」回退同一路径）；冷启动恢复不走选择器切换、不受重置影响。验收第 4/5 条的端到端实跑归 05 号票（本票以单测钉数据面：`workspace-state.test.ts` 断言切换后各入口草稿 `projectId`/文字/目录/模式随入口恢复，启动现场上报为 `startCreateTask` 既有行为 `reportWorkbenchTarget({kind:"new", projectId})`）。

**票 02 → 05 e2e 交互面变更**：

- 新 testid：`draft-project-select`（触发器，`data-value` = projectId 或 `standalone`）、`draft-project-select-listbox`（弹出菜单）、`draft-project-select-option-standalone`（选项「不选项目（独立任务）」）、`draft-project-select-option-<projectId>`（选项 label = 项目名）。
- 移除面：标题行右侧静态语境文本「项目 · <名>」与「独立任务」不再渲染——entry-consistency / projects-sidebar 若有依赖该文本的断言需改为选择器断言。
- 交互语义：选择即切换入口（持久草稿按 `["new", projectId]` 分份恢复、启动现场 target 随切换更新）；切到独立重置已选目录（回「选择已有目录」默认形态）；busy（首条发送中）选择器 disabled。
- 建议场景断言：persistent-workbench 在草稿态输入文字后经选择器切换再切回，断言各入口文字分份恢复；切换后首条发送按当前归属创建（项目/独立各一次）。
