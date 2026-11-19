# 04: 消息流段家族——工具卡 / 计划卡 / 子代理标记 / 队列条

**What to build:** 消息流内容区换 D 语言：轮间距放大到五变体最大（轮间 24px/轮内 14px），用户消息右对齐暖灰圆角块；工具调用卡/工作计划卡/子代理标记行/思考块/过程段/压缩摘要/历史交互全部去边框极轻暖灰底块；「回到底部」浮钮白卡轻阴影（阴影白名单成员）；顺手修复 QueueBar「发送中/编辑中」徽章引用不存在 Tailwind 类的基线缺陷。

**Blocked by:** 01（token 基座）

**Status:** ready-for-human

- [x] 消息段间距/行距按定案值放宽；用户消息右对齐暖灰块
- [x] 工具卡（含连发分组、状态/耗时/参数输出）暖灰块化，展开/折叠行为与折叠记忆不变
- [x] 工作计划卡（plan-card）暖灰圆角块，收起态百分比/N/M/预览信息不变
- [x] 子代理标记行单行形态、点击定位右栏不变
- [x] 「回到底部」浮钮白卡 hairline 小阴影
- [x] QueueBar 徽章缺陷修复（`bg-accent-soft`/`text-accent-fg` 不存在类——见 notes.md「已知基线缺陷」，按 D 语言补正确样式）
- [x] ui 单测全绿
- [x] e2e 实跑绿：message-order / process-segments / work-plan / subagents / scroll-following / compact（队列条链外场景 input-queue 系五条按需抽跑）
- [x] dev 双主题走查截图留证

## Comments

**2026-11-19 实施记录（票04）**

改动 6 个 .tsx + 1 测试镜像同步，全部按原型 variant-d.css 第 4/6/7/8 节折回：

1. **段间距定案值**：`message-list` gap-4→gap-6（24px）、轮内 ol gap-3→gap-[14px]、`message-turn` 移除 `[&:not(:first-child)]:pt-4`（轮距 24px 全由外层 gap 提供，原型无轮内叠加留白）；流容器 py-4→py-5（原型 20px）；正文 `.markdown` text-sm/leading-6→text-[0.9375rem]/leading-[1.75]（15px 组件级规则，票 01 遗留项落地）。
2. **暖灰块化（去边框）**：用户消息 bg-selected→bg-surface-muted + rounded-[10px] + px-3.5/py-2.5 + leading-[1.7]；工具卡/工具组头/思考块/过程段/子代理标记行 bg-surface（或加 border）→bg-surface-muted 去边框，摘要行内距 9px 14px（px-3.5 py-[9px]）；message-status 同步暖灰；message-error/compacting-indicator/压缩摘要外壳去彩色描边（保留语义软底）。ToolDetailsBody pre 的 bg-code-bg 与暖灰卡同源融合（原型注释认可「徽章底色与暖灰块同源即可」），未做白卡——原型只对 interaction 面板内 pre 做了白卡，工具卡展开区不在覆盖列表，折回基线即原型呈现。
3. **计划卡**：rounded-xl+border+bg-surface+shadow-sm→rounded-[10px]+bg-surface-muted（无边框无阴影）；百分比徽章保留 bg-accent/15 text-accent（黑主张淡底，卡面换暖灰后仍成立）；展开区 border-t 保留（内容分隔属「line 仅必要处」）。
4. **浮钮**：shadow-sm→shadow-floating（浅色恰为原型定案值 `0 2px 8px rgba(15,15,15,0.08)`）、hover 由 accent 色改 border-fg/30 + text-fg（原型 hover 形态）。
5. **QueueBar 徽章缺陷修复**：`bg-accent-soft`/`text-accent-fg`（不存在类，基线无样式）→ `bg-selected`/`text-fg`（--selected 暖灰选中底 + 主文字色，双主题自动成立；编辑中预览文字 text-accent-fg→text-fg 靠已有 font-medium 表达激活）；容器去边框、块内取消/恢复/清空按钮去描边（原型「queue-bar button 去描边」）。
6. **AssistantActions**：复制/导出图标钮去边框 rounded→rounded-md（6px）。

验证（均直接取退出码，不接管道）：

- TDD 产物断言：改前产物 grep D 定案值全 0 + `bg-accent-soft` 存在（红基线证明断言有效）；改后 JS 产物含 gap-6/gap-[14px]/shadow-floating/text-[0.9375rem]/rounded-[10px]×2，缺陷类 0 处；CSS 产物含 border-radius:10px、gap:14px、font-size:.9375rem、background-color:var(--selected)。
- `pnpm --filter @codexlike/ui run test` 562 全绿（exit 0；一处 `message-actions-ui` className 镜像断言按 D 语言同步：border border-line bg-surface-muted→rounded-md bg-surface-muted）；typecheck 0；build 0。
- e2e（desktop 先重建 dist）：message-order / process-segments / work-plan / subagents / scroll / compact / input-queue-items（链外抽跑，含「正在发出：区别显示且锁定」徽章场景）七场景全绿 exit 0。
- dev 走查（vite 5178，IAB）：浅/深双主题 computedStyle 逐项核验——24px/14px/15px/26.25px/10px/9px 14px 全中；浅深卡面各为 #f7f6f3 / #2a2827（深色比主底 #1f1e1c 亮一档，D 深色纪律成立）；边框全 0；浮钮浅色恰为原型阴影值、深色 #242322 + 0.35 黑阴影；浅色 AI 目视确认无框暖灰/留白宽松/层次靠底色观感成立。截图存 `.scratch/ui-modern/screenshots/04/`（light-message-stream.png / dark-message-stream.png）。

给下游（票 08 收尾）的衔接注意：

1. 深色 fg-subtle 实测（票 01 遗留观察）：on 暖灰卡 3.10:1、on canvas 3.4:1——不弱于浅色定案同级（#9f9e9b on #f7f6f3 ≈2.9:1），「最弱信息定位」层级是原型定案观感的一部分，本票未升档 fg-muted；收尾票若统一调对比再动。
2. 队列条 dev fixture 队列为空（queueState.queue: []），QueueBar 未在走查中出现——其视觉由 queue-bar-ui 7 测 + workspace-queue-ui 20 测 + input-queue-items e2e 覆盖，形态与已走查暖灰块同构（surface-muted + rounded-lg + bg-selected 徽章）。
3. `InteractionHistory`（历史交互卡）在票 03 清单内未动——消息流内它的呈现仍是旧样式（border+bg-surface），票 03 落地后与本票暖灰块家族对齐。
