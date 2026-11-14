# 03: 右栏 overlay 抽屉 tab 化

**What to build:** 「规范与技能」「改动」两面板收进同一个 overlay 抽屉：浮在消息流上方（不挤压内容列宽度），抽屉内 tab 切换，标题栏开关按钮状态与抽屉同步。面板内部滚动、刷新、独立关闭能力不回归。width-tiers 场景按「抽屉自身宽度约束」重新基线。相关 testid 与 e2e 场景同票联动。

**Blocked by:** 01

**Status:** done

**Status:** ready-for-agent

- [x] 两面板在同一 overlay 抽屉内 tab 切换，浮于消息流上方
- [x] 抽屉打开时消息流宽度不变（原展开挤压行为消除）
- [x] 标题栏开关按钮 aria-expanded 与抽屉状态同步；× 关闭抽屉
- [x] 面板内部滚动、刷新、关闭能力不回归（改动面板 diff/分支/提交、规范面板快照/技能列表）
- [x] width-tiers 场景重基线（断言抽屉自身宽度约束与容器分档行为）并通过
- [x] 相关 testid/e2e 联动更新且通过
- [x] 定位器检查脚本通过

## Comments

### 实现（ui-redesign-t03，2026-11-14）

**组件**

- 新增 `packages/ui/src/components/PanelsDrawer.tsx`：右栏 overlay 抽屉容器（原型变体 D 骨架重写进真实组件）——`absolute inset-y-0 right-0 z-20 w-[30rem] max-w-[60%]`，浮于消息流上方；`DrawerTabHeader`（role=tablist，两 tab 按钮 `drawer-tab-resources`/`drawer-tab-changes` + `drawer-close`（×））；面板本体经 props 注入、仅当前 tab 挂载，容器以 `[&>aside]:` 覆盖类收敛面板原固定宽高与左缘描边，面板本体零改动。
- `WorkspacePage`：`resourcesOpen`/`changesOpen` 两状态合并为 `drawer: DrawerTab | null`；两开关语义保留——各自打开抽屉到对应 tab、再次点击收起；切到「规范与技能」页即刷新资源（与原「开面板即刷新」一致，「改动」面板挂载自刷新）；MessageStream 包 `relative flex min-h-0 flex-1 flex-col` 容器作抽屉定位基准；原分栏 rail 块删除；面板内关闭按钮（含 `changes-close`）语义改为关闭整个抽屉。
- `TitlebarPanelToggles`：aria-expanded 与抽屉状态同步（派生 `drawer === tab`）；所在 tab 开关持久高亮（`border-accent text-accent`）；两开关文案恒定（去掉「收起改动」动态文案，开合状态由 aria + 高亮承载）。

**行为决策**

- tab 切换为条件挂载（原型一致）：切走再切回会重置面板内部临时 UI 态（如改动面板已选 diff 文件），面板能力（diff/分支/提交/快照/技能列表/滚动/刷新）不回归；两面板不再并发挂载。
- 抽屉只覆盖消息流区域（不含 composer 与其上方横条）；五类横条保留现状（票 02 负责迁移）。

**测试**

- 新增 `packages/ui/tests/panels-drawer-ui.test.tsx`（4 例）：浮层骨架与宽度约束类、tab 头与 aria-selected、按 tab 挂载对应面板、tab/× 动作回传（先例：window-controls-ui 直接调用元素 props）。
- `titlebar-task-context.test.tsx` 联动：新增高亮态断言；「收起改动」断言随文案恒定化删除。
- e2e 重基线 `width-tiers.mjs`：原「面板占据主列旁边空间/不覆盖主列/双面板并列」断言改为——抽屉打开内容列宽度不变（±1px）、6xl 档留白不变、抽屉自身宽度 = min(480, 60% 任务容器)（1600 命中 30rem、1000 命中 60% 上限）、抽屉与内容列水平重叠（覆盖而非并列）、两开关驱动同一抽屉（单浮层 + 面板互斥挂载 + aria 互斥同步）、抽屉底不越 composer 顶、`changes-close` 关闭整个抽屉；README 表 29 行同步。

**运行结果（均直接运行取退出码）**

- 组件：`pnpm vitest run`（ui 包 32 文件 / 291 测试）全过；全仓 `pnpm test`（agent-core 434 + desktop 265 + ui 291 = 990 测试）全过。
- `pnpm typecheck`、`pnpm lint`（0 error 0 warning）、`pnpm check:adr`、`node scripts/check-e2e-locators.mjs` 全过（退出码 0）。
- e2e 单场景（`pnpm build` 后逐个跑，全过）：width-tiers（重基线）、changes（diff/建分支/提交/非 git 降级）、skills（规范刷新/按需加载/子代理隔离）、acceptance（改动面板全链 + 双任务并行）。
- 未跑全链（票 05 终验）。

**遗留**

- 打开抽屉状态下切到新建草稿：抽屉随 currentId 置空隐藏、状态保留，回到任务后恢复（与原分栏行为一致）；草稿态本身无面板入口（开关禁用）。
