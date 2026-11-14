# 01: 标题栏任务上下文行 + workspace-info 收纳

**What to build:** 打开任务时，标题栏显示任务上下文——任务名、「项目 · Worktree/本地」徽章、任务搜索——消息流直接从标题栏下方开始；workspace-info 整行取消，完整工作区路径与来源目录收进徽章（hover/点击可见）；无任务时标题栏回退品牌展示。草稿场景的目录选择与工作区模式入口保持可用。相关 testid 与 e2e 场景同票联动。

**Blocked by:** None (can start immediately)

**Status:** done

**Status:** ready-for-agent

- [x] 打开任务后标题栏显示任务名与「项目 · Worktree/本地」徽章，hover/点击可见完整工作区路径与来源目录
- [x] 无任务（未选任务/草稿入口）时标题栏回退品牌展示
- [x] 任务头行与 workspace-info 行不再渲染，消息流上方无其他常驻行
- [x] 任务搜索从任务头行迁入标题栏，搜索与切换任务能力不回归
- [x] 草稿场景：选择已有目录、使用专用目录、工作区模式切换入口仍可用
- [x] 标题栏拖动区与窗口控制按钮行为不变（window-controls 场景通过）
- [x] 相关 e2e（window-controls / entry-consistency / worktree / packaged 等）联动更新且通过
- [x] 定位器检查脚本通过

## Comments

### 实现（ui-redesign-t01，2026-11-14）

**组件**

- 新增 `packages/ui/src/components/TitlebarTaskContext.tsx`：
  - `TitlebarContext` 类型（task/search/panels 三段）+ `TitlebarTask`/`TitlebarPanels`；
  - `TitlebarTaskContext`（标题栏左区）：任务态渲染「CodexLike › 任务名 + 徽章」；无任务回退品牌展示；TaskSearch 两种形态都可用；
  - `WorkspaceBadge` + `WorkspaceBadgePopover`：徽章文案「项目名/独立任务 · Worktree/本地」，hover title 为「工作区：{完整路径}\n来源目录：{来源}」，点击弹层展示完整工作区路径（`workspace-path`）与来源目录（`workspace-origin`），pointerdown 捕获点击外部关闭 / Escape / focusin（先例 ComposerSelect/TaskContextMenu）；
  - `TitlebarPanelToggles`：规范与技能/改动两开关迁入标题栏 nav，保留 testid 与 aria-expanded/disabled，分栏渲染行为不变（overlay 抽屉化是票 03）。
- 数据流：WorkspacePage 新增 `onTitlebarContext` 上报（useMemo 按内容记忆 + effect），App 持 state 装配进 Header；设置视图不渲染任务上下文。工作台视图左区 `window-no-drag`（任务名/徽章/搜索可交互），品牌空白区与设置视图品牌区保持可拖动，窗口控制免拖不变。
- `TaskSearch` 整体迁入标题栏后补面板水平收口（打开时按开关锚点钳位回视口，resize 重算）——冷启动态开关贴近左缘，原 `right-0` 锚点会溢出窗口（task-search 场景的 `assertSearchLayout` 抓到）。
- WorkspacePage：任务头行与 workspace-info 行删除；草稿场景就地收纳（`draft-workspace-info` 行，仅草稿期间渲染，非常驻）——保留 `workspace-path`/`draft-workspace-mode`/`draft-select-workspace`/`draft-managed-workspace`/`draft-error` 原定位器与文案，内容列对齐几何不变。

**测试**

- 新增 `packages/ui/tests/titlebar-task-context.test.tsx`（静态渲染 6 例）：任务态骨架/徽章 hover title 与弹层内容/独立任务与本地模式回退/品牌回退不渲染任务名与徽章/面板开关 aria 与禁用/动作透传。
- `agent-resources-ui.test.tsx` 首例联动改写：旧断言「页内顶栏开关禁用」随迁移失效，改为断言开关/任务头行/workspace-info 行不再在页内渲染（禁用态由新测试覆盖）。
- e2e 联动：`worktree.mjs`（draft 行容器改名、任务态路径/模式改读标题栏徽章弹层）、`entry-consistency.mjs`（4 处路径/来源改读徽章弹层）、`projects-sidebar.mjs`（3 处）、`width-tiers.mjs`（assertAligned 草稿行条件对齐、删任务头行高度断言、双面板断言改标题栏控件不越窗）。

**运行结果（均直接运行取退出码）**

- 组件：`pnpm --filter @codexlike/ui run test` 31 文件 / 286 测试全过；全仓 `pnpm test`（46+34+31 文件，986 测试）全过；`pnpm typecheck`、`pnpm lint`、`pnpm check:adr`、`node scripts/check-e2e-locators.mjs` 全过（退出码 0）。
- e2e 单场景（`pnpm build` 后逐个跑，全过）：window-controls、theme、task-search、smoke、worktree、entry-consistency、projects-sidebar、width-tiers、skills、commands、sidebar-archive、packaged（`pnpm dist` 后）、persistent-workbench、launch-state-target。
- 未跑全链（票 05 终验）；acceptance/changes/interactions/membership/reasoning-recovery 等仅复用未改定位器（changes-toggle、draft-select-workspace 等）且模式已被上述场景覆盖。

**遗留**

- 打包 exe（`packages/desktop/release/`）为本地验证产物，未提交。
- 搜索面板收口仅在标题栏消费方验证；若未来其他位置复用 TaskSearch 需确认锚点方向。

### 勘误（审查修复，2026-11-14）

- **上面「实现」摘要中的拖动区描述与 spec 不符**：原文「工作台视图左区 `window-no-drag`（任务名/徽章/搜索可交互），品牌空白区与设置视图品牌区保持可拖动」——实际实现把整个左区（含无任务品牌回退态）都包进了 `window-no-drag`，可拖区只剩 header 根元素 `px-4` 的细条，违背 spec「拖动区（标题栏拖拽 + 控件免拖）行为保留」。已修复：`window-no-drag` 只包真正的交互控件（工作区徽章容器含弹层、任务搜索容器含面板），任务名文本、徽章间空白与品牌回退态区域恢复可拖（父级保持 `window-titlebar-drag` 作用域）；设置视图品牌区本就可拖，未动。
- **window-controls 的拖动断言原为假绿**：只断言 computed style（drag/no-drag），验证不了拖动行为——`-webkit-app-region` 的窗口拖动走系统命中测试（Windows 命中 drag 区返回 HTCAPTION），Playwright 合成鼠标事件只进渲染器输入管线、不走该路径，合成拖拽既不动窗口、事件也被 drag 区吞掉。已补系统级真实输入断言（user32 SetCursorPos + mouse_event，与用户手势同路径）：拖动区拖拽应移动窗口（按显示器缩放折算 DIP 断言）、免拖控件同样手势不得移动窗口。以本项目 e2e 实际运行环境（Windows 有头桌面）为准；无头/虚拟桌面会话下该断言不适用。
- 组件级新增静态断言兜底任务态拖动划分（徽章与搜索容器免拖、任务名与品牌文本不带 no-drag）：任务态拖拽无真实任务可依赖（window-controls 场景不建任务），以类名归属作回归哨兵。
