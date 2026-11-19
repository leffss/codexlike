# 03: 输入面家族——输入卡 / 新建任务起点 / 交互面板

**What to build:** 三个输入壳同形换 D 语言：正式任务输入卡、新建任务起点页（工作区卡+决策行+专属输入卡）、交互面板（执行审批三键 + 问答选项）统一为无边框 `#f7f6f3` 暖灰圆角块，聚焦深色细描边淡入；审批的批准/批量/拒绝保持绿/警示/红语义；问答单选/多选/自定义呈白卡选项 + inset 黑描边选中态；新建起点页居中布局观感与任务态连续。

**Blocked by:** 01（token 基座）

**Status:** ready-for-agent

- [x] composer-card / new-task-composer / interaction-panel 三壳同形：暖灰块 + 聚焦描边淡入（白底上光晕不可见，用描边——原型已验证）
- [x] 审批三键语义色可辨；批量批准警示文案区样式统一
- [x] 问答选项白卡 + 选中 inset 黑描边；自定义回答输入同语言
- [x] 新建任务起点页（new-task-start）整体继承：工作区卡、决策行、归属选择器
- [x] 等待交互期间输入区禁用/替换行为、斜杠命令/@文件/技能菜单触发行为不变
- [x] ui 单测全绿
- [x] e2e 实跑绿：approvals / interactions / persistent-workbench / thinking / width-tiers（composer 几何断言）
- [x] dev 双主题走查截图留证（含审批态与问答态——dev 预览 fixtures 三态可达）

## Comments

**2026-11-19 实施记录（票03）**

实施序列（TDD：产物断言红→绿，沿用票 01 先例）：

1. 基线：ui 单测 562 全绿；build 产物 grep 断言不含本票目标类串（`focus-within:shadow-[0_0_0_1px_color-mix…` / `shadow-[inset_0_0_0_1.5px_var(--fg)]` / `rounded-[10px]` 均 0 命中，红基线证明断言有效）。
2. 三壳同形（MessageComposer/NewTaskStart/InteractionPanel）：`border/shadow` 全去，`bg-surface` → `bg-surface-muted` 暖灰块；圆角 composer-card 10px（`rounded-[10px]`）、new-task-composer 与 interaction-panel 12px（`rounded-xl`）；聚焦态统一 `focus-within:shadow-[0_0_0_1px_color-mix(in_oklab,var(--fg)_32%,transparent),0_0_0_5px_color-mix(in_oklab,var(--fg)_5%,transparent)]`——描边色取 `--fg` 低透明（原型 rgba(55,53,47,.3/.05) 的语义化），深色自动翻亮白主张，免主题分支；`transition-shadow duration-150`（原型 160ms 就近）。composer-input 行高 1.7、padding 12/16/6px；工具栏水平 10px（原型定案值直译）。
3. 问答选项白卡：未选/选中均为 `bg-surface`（浅色=白卡浮暖灰、深色=暗一档凹片，同一「卡上内容片」语义）；选中态 `shadow-[inset_0_0_0_1.5px_var(--fg)]`（浅黑深亮随 token）；hover 统一 `bg-hover`。自定义回答输入 `bg-surface` + focus 1.5px `--fg` 45% 描边。审批/历史卡内命令 pre 由 `bg-code-bg`（与面板同底色灰上加灰）改 `bg-surface` 白卡，双主题同一解。
   - **中途方案修正**：首版用 `bg-white/[0.72]`（原型字面值）+ useTheme 深色分支，被 interaction-ui「所有颜色都来自双主题语义 token」架构纪律断言拦截（源码禁 Tailwind 原生色板/硬编码色）——改全 token 方案后通过，且免分支、深浅自洽。教训：原型硬编码白/黑值折回时优先找语义 token 等价物。
4. 审批三键与警示区：actionClass 与提交按钮去 `border-line`、`rounded`→`rounded-md`（6px 小钮）；ok/warn/danger 淡底语义 token 不动（浅色 computedStyle 实证 #e9f1e9/#f9efcf/#fbe5e1 三色可辨）；批量批准警示文案加 `bg-warn-bg` 淡底圆角块（与三键淡底同语言）。
5. 起点页继承（NewTaskStart/WorkspaceModeSelector）：工作区卡 `rounded-[10px] bg-surface-muted p-3.5`（暖灰 callout）；引导卡去边框去阴影 `rounded-xl bg-surface`；专属输入卡同三壳形（12px/内距 14-16px）；WorkspaceModeSelector 原生 select 与「选择已有目录/使用专用目录」按钮去边框（后者由 text-accent+hover:border-accent 改 text-fg-muted+hover:bg-hover，遵循票 01「组件内勿用 accent 表链接/激活」注意 2）。
6. 外壳呼吸（ComposerRegion）：`py-3` → `pt-2.5 pb-4`（原型 region 定案 10px/16px），composer-region/interaction-region 共用组件一次改双壳。
7. 单测跟随（interaction-ui.test.tsx 两处样式字面断言，意图不变、字面值随新形态）：外壳同构断言 `py-3`→`pt-2.5 pb-4`；面板形态断言 `rounded-2xl+shadow-lg`（旧浮卡快照）→ `rounded-xl+bg-surface-muted+not.shadow-lg`（暖灰块+无阴影纪律）。与票 01 改 theme.mjs 期望值同类（样式值镜像同步，非行为断言改写）。
8. 未动文件与理由：ComposerIcons（图标绘制纪律不动）；ComposerMenuList（补全菜单浮层本体归票 06 弹层语汇）；styles.css（边界禁改，全部样式经既有语义 token 表达）。

绿验证（全部直接取退出码）：

- ui 单测 562 全绿（exit 0）· typecheck 0 · build 0；产物断言绿：三壳聚焦描边/inset 选中/rounded-[10px] 类串在 JS 产物命中，CSS 产物含 `color-mix(in oklab,var(--fg) 32%,…)` 规则与 `.shadow-[inset…]` 完整规则（--tw-shadow 变量 + box-shadow 输出双确认）。
- e2e 五场景实跑绿（先构建 desktop 主进程）：approvals / interactions / persistence(persistent-workbench) / thinking / width(composer 几何断言) 全部 exit 0，width-tiers「全部断言通过」。
- dev 双主题走查（vite 5177，IAB 实测）：fixtures 临时注入 task-4 审批等待、task-2 问答等待（单选+多选），走查后已还原不入提交。8 张截图存 `.scratch/ui-modern/screenshots/03/`（light/dark × 任务态聚焦输入卡/审批/问答/新建起点）。computedStyle 机器核验：浅色面板 #f7f6f3+无边框+12px 圆角、pre 纯白、三键三色淡底；深色面板 #2a2827、选项 #242322 凹片、选中 inset 亮白 1.5px、聚焦描边 oklab(0.919…/0.32) 1px+0.05 外晕。AI 目视深色选中描边曾读作「琥珀色」——computedStyle 实证为 --fg 亮白（rgb(230,228,223) inset），与票 01 同类目视误判，机器值为准；「待处理」warn 琥珀为语义 token 正确。

给下游票的衔接注意：

1. **票 06（弹层）**：ComposerSelect 触发钮（approval-mode-select / model-thinking-select / draft-project-select）现为默认皮肤 `border-line bg-surface-muted`——在三壳暖灰块上呈「同底色淡边小片」，不破相但缺原型「白色半透明小片」层次（原型 variant-d 对灰卡内触发钮有 rgba(255,255,255,0.75) 规则）。本票受「只改清单内 .tsx」约束未动 ComposerSelect；票 06 改其弹层语汇时建议一并处理触发钮皮肤（届时同样注意语义 token 纪律与双主题）。ComposerMenuList 浮层本体（白卡+发丝线+阴影）也归票 06 统一。
2. **票 04（消息流）**：InteractionHistory 已去边框（bg-surface-muted 暖灰块）+ pre 白卡；QueueBar 在 composer-region 内渲染、现为旧皮肤（border+bg-surface-muted），归票 04 按暖灰块语言统一即可，与本票三壳无冲突。
3. **通用表达沉淀**：「卡上内容片」= `bg-surface`（浅白卡/深凹片）、「选中态」= `bg-surface` + `shadow-[inset_0_0_0_1.5px_var(--fg)]`、「聚焦描边」= color-mix(var(--fg) 32%) 1px + 5% 外晕——票 05/06/07 遇同类形态可直接复用该类串。
4. interaction-ui.test 有「InteractionPanel/InteractionHistory 源码禁原生色板与硬编码色」的架构断言，后续改这两个组件时注意保持全 token。
