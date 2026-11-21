---
status: partially superseded by ADR-0032（tab 体拆页导航；正文收纳右栏与消息流标记行的大结构维持本文决定）
---

# 子代理：正文迁右栏「子代理」tab，消息流留单行标记

工单 13 落地的子代理嵌套卡片（SubagentCard）把报告、思考流、工具进度全部渲染在主代理消息流内：完成态报告默认收起但展开是 max-h-72 的大块 markdown，多个并发委派时消息流被过程内容淹没——主代理的叙事线（问了什么、答了什么）与子代理的过程内容（调研细节）争夺同一空间。右栏常驻（ADR 0018）后「检视」有了天然归属：git 改动看「改动」tab、资源快照看「规范与技能」tab，子代理过程内容同属检视诉求。经三变体原型对比（分支 prototype/subagent-rail：A 主从分栏 / B 堆叠折叠卡 / C 通读章节流），用户选定变体 A 转正，并追加要求报告操作行（复制 / 导出 Markdown / 完成时间，与主代理 AssistantActions 同款）。

## 关键边界

- **主从分栏（变体 A）**：右栏第三 tab「子代理」内上段子代理列表（状态点 + 任务截断 + 状态 + 已用时，运行中每秒跳动），下段选中者完整详情——与「改动」tab 的 文件列表 → diff 视觉同构。无选中时默认最后一个（最新）；列表为空显示占位提示。
- **消息流残留**：单行轻量标记（SubagentStreamMarker）——子代理徽章 + 任务截断 + 状态 + 已用时 + 「右栏查看 →」，保留时序锚点（何时委派、何时完成在叙事线原位可读）；整行可点，一步完成开右栏 + 切 tab + 列表定位选中（WorkspacePage 持 focus 信号 `{id, seq}`，RailPanel 响应切 tab，面板体响应选中并滚动到项）。
- **详情区结构**：任务头 → 思考折叠块（与主任务思考块同构：流式默认展开、结束自动收起、摘要回看，collapse-memory 键 `subagent-thinking-{id}` 沿用）→ 运行态（当前活动工具 + 已执行次数）/ 完成态（报告 markdown 直接渲染 + 操作行 + 工具清单折叠）。失败委派报告红字、无完成时间；恢复态记录无起止对自然缺耗时与完成时间。
- **tab 徽章**：运行中/排队计数（不含已完成），title 说明语义。
- **数据流**：WorkspacePage 从 displayMessages 过滤 subagent 段传入（subagents prop），RailPanel 不依赖全量消息段；标记行点击回调经 MessageStream props 穿透（同 questionDraft 先例）。

## 取舍

- 拒绝变体 B（现卡整体平移进右栏、消息流零痕迹）：失去时序锚点后，「主轮何时委派」只能去右栏翻找，叙事线断裂；且堆叠卡自带开合记忆在右栏场景冗余。
- 拒绝变体 C（通读章节流、报告全文无折叠直读）：多委派长报告时整栏滚动负担大，「一次聚焦读一个」的主从结构更贴检视场景；C 的全文直读优点被详情区「报告直接渲染（无展开门槛）」部分吸收。
- SubagentCard 整文件退役：开合记忆键 `subagent-{id}`（卡身）随之失效，思考块键 `subagent-thinking-{id}` 保留沿用（呈现语义不变）。
- 子代理正文不再随消息流导出（导出走报告操作行逐委派出 Markdown，默认文件名 `子代理-<委派说明>.md`，清洗复用 AssistantActions 的 exportFileNameBase）。
- 结构完整快照（三变体 + 切换药丸 + 模块 store 原型设施）留在 prototype/subagent-rail 分支。

影响面：ui 新增 components/SubagentRailPanel（面板体 + 操作行 + 共享小件）与 components/SubagentStreamMarker（标记行），删除 components/SubagentCard；RailPanel 第三 tab（联合类型 + 按钮 + 徽章 + subagentFocus 响应），MessageStream subagent 分派改标记行（onOpenSubagent 穿透），WorkspacePage 过滤 + focus 信号；fixtures 补子代理样例（恢复态记录 + 运行中事件链）；e2e helpers 新增 openSubagentDetail、openRailPanel 支持 subagents tab；e2e subagents/subagent-thinking/reasoning-recovery/exit-recovery/interactions 五场景改标记行 + 右栏详情基线。
