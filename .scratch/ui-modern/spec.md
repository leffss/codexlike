# Spec: 全 UI 应用「留白呼吸」设计语言（ui-modern）

Label: ready-for-agent
ADR: 0028（设计语言定案）· 原型分支 `prototype/ui-modern`（primary source）

## Problem Statement

工作台界面是早期视觉体系的产物：冷灰蓝基调、细边框分区、紧凑偏工具感。用户希望整个应用（含全部子界面）现代化、简洁、有呼吸感，但**不能丢失任何功能**——审批、问答、队列、检视、设置一个都不能少、不能难找。

## Solution

以五变体原型实机评审选定的 **D「留白呼吸（Notion 式）」** 为唯一设计语言，重构 ui 包全部 web 界面：暖白底、无边框、暖灰分层（`#f7f6f3` 系）、大间距高行高、黑色 accent 主张、阴影只给悬浮物。语义 token 机制（ADR 0006）不变，重定 token 值与组件排版；信息架构与全部交互行为冻结不动。

## User Stories

### 工作台外壳

1. As a 工作台用户, I want 标题栏无边框融入画布，so that 界面顶部不再有生硬的分区线、整体更轻。
2. As a 工作台用户, I want 侧栏透明无色块、行 hover 才浮现暖灰圆角底，so that 任务列表安静不抢注意力。
3. As a 工作台用户, I want 侧栏当前任务行用暖灰底与字重区分（非彩色胶囊），so that 定位当前任务不靠颜色刺激。
4. As a 工作台用户, I want 窗口控制与标题栏按钮统一无边框浅淡样式，so that chrome 感降到最低。
5. As a 工作台用户, I want 项目分组、worktree/本地徽章、排队/运行/等待徽章在暖色体系下依然一眼可辨，so that 状态识别不受换肤影响。

### 消息流

6. As a 工作台用户, I want 消息段之间有大间距、正文行高 1.7–1.75，so that 长回复阅读舒适不压迫。
7. As a 工作台用户, I want 工具调用卡是极轻暖灰底块（无边框、摘要行放宽），so that 过程信息可见但不喧哗。
8. As a 工作台用户, I want 工作计划卡呈暖灰圆角块且收起态信息（百分比/N/M/当前下一步）不变，so that 进度一眼可读。
9. As a 工作台用户, I want 子代理标记行保持单行形态、点击仍定位右栏，so that 子代理呈现密度不因换肤改变。
10. As a 工作台用户, I want 思考块/过程段/压缩摘要/历史交互的去边框暖灰形态与可折叠行为不变，so that 消息段语义仍可区分。
11. As a 工作台用户, I want 用户消息呈右对齐暖灰圆角块，so that 我的话与 agent 回复在视觉上松弛分列。
12. As a 工作台用户, I want 队列条与排队消息（编辑/删除/拖拽）在暖色体系下照常可用，so that 输入队列管理不受影响。
13. As a 工作台用户, I want 「回到底部」浮钮是白卡轻阴影（全页唯一阴影语汇的悬浮物），so that 浮钮浮而不突兀。

### 输入面

14. As a 工作台用户, I want 输入框是无边框暖灰圆角块、聚焦时深色细描边淡入，so that 输入区放松且焦点清晰。
15. As a 新建任务用户, I want 居中起点页（工作区卡/决策行/专属输入卡）继承同一语言，so that 从新建到对话视觉连续。
16. As a 工作台用户, I want 审批面板（批准本次/批量/拒绝）在暖色下保持绿/警示/红的语义可辨，so that 执行审批的严肃性不丢。
17. As a 工作台用户, I want 交互问答的单选/多选/自定义回答呈白卡选项与 inset 黑描边选中态，so that 问答选项清晰可点。
18. As a 工作台用户, I want 等待交互期间输入区的禁用/替换行为不变，so that 交互优先级不被视觉重构削弱。

### 右栏与检视

19. As a 工作台用户, I want 检视右栏白底无边界、tab 用暖灰底+字重表达激活，so that 检视面板轻量融入。
20. As a 工作台用户, I want diff 视图（Monaco）与代码块在暖色体系下可读性不降，so that 改动检视不受换肤影响。
21. As a 工作台用户, I want 子代理详情（委派说明/逐轮正文/工具清单/计划卡）与资源快照在右栏保持现有信息密度，so that 检视能力一个不少。
22. As a 工作台用户, I want git 改动清单与提交动作区样式统一，so that 提交流程观感一致。

### 弹层

23. As a 工作台用户, I want 模型/思考档位选择器、通用下拉、右键菜单、确认对话框统一为白卡+发丝线+柔和小阴影，so that 全部弹层一个语汇。
24. As a 工作台用户, I want toast 通知呈中性 hairline 白卡（类别语义色保留），so that 通知可见但不刺眼。
25. As a 工作台用户, I want 弹层的定位/开合/键盘导航行为完全不变，so that 肌肉记忆有效。

### 设置页

26. As a 工作台用户, I want 设置页七个分区（模型/外观/启动与托盘/执行/终端执行/子代理/搜索源）继承同一语言，so that 全应用观感一致。
27. As a 工作台用户, I want Provider Profile 表单、MCP server 管理等复杂表单在暖色下保持清晰层级，so that 配置操作不因换肤变难。

### 双主题与一致性

28. As a 深色主题用户, I want 深色套按 D 的暖色逻辑重新设计（非浅色反转），so that 夜间使用同样有呼吸感。
29. As a 工作台用户, I want 圆角（8–12px）、间距、字重、阴影遵循同一体系贯穿全部界面，so that 应用像一个产品而非拼贴。
30. As a 工作台用户, I want 全部 40 个 e2e 场景与 55 个组件单测保持全绿，so that 功能零丢失可被机器证明。

## Implementation Decisions

- **纯样式层重构**（评审定案）：零新依赖、图标继续内联 SVG（lucide path 手写惯例）、系统字体栈、不引字体文件。
- **Token 机制不变，值重定**（ADR 0006 → ADR 0028）：styles.css 两个 `[data-theme]` 块按 D 重定全部语义变量；组件只写语义 class 的纪律延续。浅色 = 原型定案值；深色 = 按 D 暖灰逻辑新设计（原型未覆盖），Monaco/highlight.js `--hl-*` 随动。
- **原型折回方式**：样式基线取原型分支 `prototype/ui-modern` 的变体 D CSS（作用域前缀剥除后翻译为 token 值与组件 Tailwind 类），**不做运行时 variant 切换**——切换器/fixtures 三态样例留原型分支存档，不进 main。
- **信息架构冻结**（ADR 0018/0019/0020/0022/0026）：布局结构、testid、交互行为、信息归属一律不动；本次只动 className/样式值/排版参数。
- **排版参数**：正文行高 1.7–1.75、消息段间距放大档、圆角体系 8–12px、暖灰层级（`#f7f6f3`/`#ebeae8`/`#787774` 系）、accent 黑主张 `#2f3437`、链接蓝 `#2383e2` 降调仅用于正文链接、阴影白名单（弹层/浮钮/toast）。
- **已知基线缺口**：QueueBar「发送中/编辑中」徽章引用的 `bg-accent-soft`/`text-accent-fg` 是不存在的 Tailwind 类（基线即无样式），实施时按 D 语言补正确样式（原型 E 已就地修复过，翻译其思路）。
- **编排惯例**：实现开始前把探索事实沉淀 `notes.md`（组件清单/testid 盘点/token 现状/e2e 覆盖面），实现票以指针复用；子代理编排时下游衔接信息落下游票面 Comments。

## Testing Decisions

- **接缝即现有测试金字塔，零新接缝**：组件单测（testing-library，按 testid/角色断言外部行为）+ e2e（真实 Electron 生产产物 + 公开 IPC + mock SSE，40 场景）。重构的验收定义就是**从现有接缝下原样穿过**：testid 不动、行为不动 → 两层全绿即功能零丢失的机器证明。
- 好测试标准：只测外部行为（元素可达、层级关系、交互结果），不断言 className/样式值；几何断言场景（如宽度三档、工具栏边界）保持绿色。
- Prior art：ui 包 `*-ui.test.tsx` 组件单测模式；desktop 包 e2e 场景模式（helpers 定位器规范）。
- 改动 e2e 交互面（浮层/遮罩/面板结构/标记行定位）的票，合入前实跑对应 e2e 场景或 `test:e2e:all`（AGENTS.md 既有规矩）；收尾票实跑全量。

## Out of Scope

- 原生托盘菜单与系统对话框（Electron 原生控件，web 样式不可达）。
- 信息架构重排、任何新功能、布局结构变更。
- 系统级 vibrancy/窗口透明（Electron 窗口参数）。
- 图标库或字体文件引入。
- 深色主题的独立原型评审轮（按 D 逻辑直接实施，分歧点实机确认）。

## Further Notes

- 设计语言理由与败者谱系记录见 `docs/adr/0028-ui-design-language-breathing-minimal.md`；败者变体（A/B/C/E）留在 `prototype/ui-modern` 分支作微调素材池。
- 原型 dev 预览三态（任务进行/审批/问答/新建起点）在分支上可随时复跑对照（`pnpm --filter @codexlike/ui run dev` + `?variant=d`）。

## Comments

**2026-11-19 实施完成（票 08 收档总结）**

**实施序列总述**：01 token 基座（双主题全套语义值 + 四档阴影 token + markdown 排版）→ 02 外壳（标题栏/侧栏/窗口控制/徽章）→ 03 输入面（三壳同形暖灰块 + 聚焦描边 + 问答白卡选项）→ 04 消息流（轮距 24/14px + 暖灰块家族 + QueueBar 缺陷修复）→ 05 右栏（白底无边界 + tab 暖灰激活 + GitActions 输入卡化）→ 06 弹层（白卡+发丝线+四档阴影消费，含票 02 转办的徽章弹层/opener 菜单）→ 07 设置页（七分区暖灰块 + 表单层级）→ 08 收尾（聚焦语汇统一 + auto-approve 卡补齐 + 全量验证 + 关单）。全程纯样式层：零行为/testid/信息架构改动，38 组件全覆盖。

**收尾轮裁决（五议题）**：

1. 聚焦语汇统一为「描边淡入」单一机制：三壳 focus-within color-mix（原型正源）+ 单输入 `focus:input-focus-ring`（@utility 语义类，--fg 45% 1.5px + transition-shadow）；替换 border-accent / ring-fg/50 两个分叉共 24 处。
2. task-auto-approve 提示卡补 D 语言（去 warn 描边留淡底块）。
3. 深色时间戳 fg-subtle **保留**：深 3.10:1 优于浅定案同级 2.9:1（原型正源），「最弱信息定位」层级深浅对称是定案观感。
4. 关闭钮 hover 暖灰**保留**：实机复核与全排标题栏按钮一致（暖灰 6%），「关闭=危险」由 ✕ 图标承担。
5. 设置页行操作小钮**保留**：深色理论约 5.6:1 + 目视清晰可读，不构成「弱」。

**残留清单及允许理由**：

- 深色主底与次级面明度差含蓄（#1f1e1c vs #2a2827）——「次级面亮一档」纪律固有对比；激活/层次表达均有底色+字重+前景三通道，可辨（票 05 走查结论维持）。
- 起点页标题层级偏弱、工作计划卡信息密度偏高——信息架构冻结（ADR 0018-0026），非样式层可动。
- 深色 Monaco 走内置 vs-dark（与 --hl-* 六 token 独立体系），票 05 走查可读性过关。
- toast 类别色留在底色 token（边框中性化）——票 06 定案。
- 原生托盘菜单/系统对话框不变（Out of Scope）。
- 已知工具链怪癖：@tailwindcss/vite dev 扫描器不提取 `1.5px+color-mix` 组合的 arbitrary shadow 候选（build 正常）——已用 @utility 语义类绕开并沉淀教训（票 08 Comments 1）；后续新工具类若含同类组合，直接走 @utility。

**验证基线（最终态）**：三包单测 587/507+1skip/591 全绿；`test:e2e:all` 40 场景全量绿；theme.mjs 一处旧语汇断言镜像同步（票 03 去边框的连带，意图不变）；双主题 11 面走查截图存 `.scratch/ui-modern/screenshots/08/`（各票分目录另有 01-07 走查留证）。票 01-08 全部关单；`prototype/ui-modern` 原型分支保留存档。

**2026-11-19 code-review 补记（className 镜像断言偏差落档）**：Spec 审查指出新增 `popover-family-ui.test.tsx` 与 `settings-d-language.test.tsx` 共 136 处 className 镜像断言，与「好测试标准：不断言 className」存在张力；裁定：保留——它们是设计语言语汇的回归锁（防止旧语汇悄悄回流），沿用仓库既有 `*-ui.test.tsx` prior art（02/04 票同型），记为已知偏差而非规范。
