# 05: 右栏检视家族——三分 tab / 子代理详情 / diff / git 动作

**What to build:** 检视右栏换 D 语言：白底无边界（去左边框），tab 去描边、激活态暖灰底+字重 600；改动文件清单、diff 视图（Monaco 随主题）、子代理详情（委派说明/逐轮正文思考/工具清单/计划卡/导出）、资源快照在暖色体系下信息密度不减、层级清晰；git 提交动作区样式统一。

**Blocked by:** 01（token 基座）

**Status:** ready-for-agent

- [x] rail-panel 白底去边界；拖拽分隔条平时隐形、hover/拖动暖灰现形（保留可拖宽度与键盘操作）
- [x] tab 激活态暖灰底+字重（非描边胶囊）；三 tab 互斥与开关状态同步行为不变
- [x] Monaco diff 浅深主题下可读性过关（theme prop 随 useTheme 已有，token 重定后走查）
- [x] 子代理详情与资源快照样式统一到 D 语言，导出/定位行为不变
- [x] git 文件行状态色（增/删/改/重命名）暖色下可辨；建分支/生成提交消息/提交动作区样式统一
- [x] ui 单测全绿
- [x] e2e 实跑绿：width-tiers（rail 几何三档+tab 断言）/ changes / subagent-recovery-review
- [x] dev 双主题走查截图留证

## Comments

**2026-11-19 实施记录（票05）**

实施序列（TDD：产物 grep 断言红→绿，同票 01 手法；零新测试接缝，spec Testing Decisions）：

1. 基线合并 `git merge ui-modern`（fast-forward bc7736e..6d866d2，票 01 token 基座入位）。
2. 红基线：build 产物 grep 确认 6 旧串在（`border-l border-line bg-surface` / `bg-accent/60` / `hover:bg-accent/40` / `shadow-[0_8px_24px_rgba(0,0,0,0.16)]` / `border border-ok-fg/40` / `bg-accent/15 font-medium`）、4 新串不在——断言有效性证明。
3. 实施（只动组件 className，行为/逻辑/testid 零改动）：
   - **RailPanel**：根 aside 去 `border-l border-line bg-surface` → `bg-canvas`（白底无边界；深色 #1f1e1c 与 canvas 同源）；分隔条 `bg-accent/60`/`hover:bg-accent/40` → `bg-fg/15`/`hover:bg-fg/15`（= 原型 rgba(55,53,47,0.14)，即 --fg 14% 透明度，深色随 fg 自动换向为亮灰）；三 tab 去描边 `rounded-md px-2.5 py-[5px]`（原型 6px 圆角 + 5px 10px 内距），激活 `border-accent text-accent` → `bg-surface-muted font-semibold text-fg`；kind 徽章（增/删/改/重命名）去语义描边，纯淡底+前景色（ok/info/danger/worktree 四色走查目视可辨）；非 git 提示块与 tablist/分支行/diff 分隔发丝线处理（前者去描边，后者保留——原型未覆盖即定案保留）。
   - **GitActions**：创建分支/生成消息按钮去描边改 `rounded-md hover:bg-hover`；提交消息 textarea 改输入卡语言（`border border-transparent bg-surface-muted focus:border-accent`——聚焦黑细描边淡入，border-width 常驻保证 focus 描边可见）；提交按钮去描边 `bg-ok-bg text-ok-fg hover:opacity-85`。
   - **SubagentRailPanel**：完整列表浮层 `rounded-b-lg shadow-[0_8px_24px...]` → `rounded-lg shadow-popover`（原型第 6 节该浮层规则 = popover 双层柔影，深色随 token 加深，勿覆写）；运行态块/逐轮折叠块去描边（`rounded-lg bg-surface-muted`）；工具行 `rounded` → `rounded-md`（6px 行级圆角）；复制/导出图标钮去边框 6px（对应原型 assistant-copy/assistant-export 规则：border:none + 6px，底色不动）；**委派说明块 `border-l-2 border-accent` 保留**——黑主张下黑色引述竖线（深色白竖线），单测 subagent-rail-ui 断言依赖且语义成立。
   - **ResourceSnapshotSummary**：SnapshotSwitcher 容器去描边去底（透明），chip 与 rail tab 完全同语言（激活 `bg-surface-muted font-semibold text-fg`，hover 暖灰）——产物中激活串计数 4 = 三 tab + 一 switcher。
4. 绿验证：产物 grep 全绿（7 旧串消失含 kind 徽章模板漏删的 `border` 基础类——走查 computedStyle 发现 0.8px(=1px@DPR1.25) 边框仍在，补删）；typecheck exit 0；ui build exit 0；ui 单测 562 全绿 exit 0。
5. e2e 实跑（desktop dist 先建）：width-tiers（rail 三档几何 400±2/min(400,行宽−480) + tab 互斥/开关同步断言）exit 0；changes（清单/双栏 diff/刷新/建分支/生成消息/提交/非 git 降级）exit 0；subagent-recovery-review（恢复回看全链）exit 0。宽度断言走 inline style 不受 className 改动影响。
6. dev 双主题走查（vite 5179，IAB 实测）：浅/深逐项 computedStyle 核验——rail-panel 底色 canvas（浅 rgb(255,255,255) / 深 rgb(31,30,28)）、borderLeftWidth 0、激活 tab 暖灰底+600（浅 #f7f6f3/#37352f、深 #2a2827/#e6e4df）、浮层 shadow-popover 双层影（深色 0.3/0.45 黑）、Switcher chip 同语言、分隔条 hover 现形为浅灰竖条（目视）。截图 8 张存 `.scratch/ui-modern/screenshots/05/`（浅/深 × 改动+diff/规范/子代理 + 浅色整页）。

走查发现与说明：

- **dev 纯浏览器模式 Monaco worker 报错横幅**（webWorker.js 堆栈渲染进 diff 区）：经 git stash 基线复验为**既有问题非本票回归**（vite dev 下 worker 加载失败，堆栈带 `?v=` 预构建号）；生产 Electron 不受影响（changes e2e 的 Monaco 双栏 diff 断言全绿）。diff 内容区双栏红/绿行 + 语法色双主题可读（走查目视确认，深色 vs-dark）。
- 深色下 tab 激活暖灰底与 canvas 明度差小（#2a2827 vs #1f1e1c，「次级面亮一档」纪律的固有弱对比），激活表达靠底色+字重 600+fg 亮字三通道，可辨；如后续觉过弱可在组件层微调，不动 token。
- 主题切换按钮只有 title 无 aria-label（走查时按 aria-label 定位不到，基线现状，非本票范围）。

给下游票的衔接注意：

- **票 06 弹层**：右栏内浮层（subagent-rail-list）已用 `shadow-popover` + `border-line` + `bg-surface` + 8px 圆角，弹层家族照此语汇统一即可；票 01 预注册的四档 shadow 类可直接用。
- **票 04 AssistantActions**：本票的 SubagentReportActions（复制/导出/完成时间）已按原型 assistant-copy/export 规则去边框 6px（bg-surface-muted 底保留），票 04 改主代理同款按钮时请保持同构（去边框、不改底色）。
- **票 02 标题栏**：resources-toggle（右栏开关）激活态仍是旧 `border-accent text-accent` 描边语言（原型已有覆盖规则：去描边+暖灰底+600），归票 02 处理，本票未动（不在组件清单）。
