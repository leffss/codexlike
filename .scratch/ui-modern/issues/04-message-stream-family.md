# 04: 消息流段家族——工具卡 / 计划卡 / 子代理标记 / 队列条

**What to build:** 消息流内容区换 D 语言：轮间距放大到五变体最大（轮间 24px/轮内 14px），用户消息右对齐暖灰圆角块；工具调用卡/工作计划卡/子代理标记行/思考块/过程段/压缩摘要/历史交互全部去边框极轻暖灰底块；「回到底部」浮钮白卡轻阴影（阴影白名单成员）；顺手修复 QueueBar「发送中/编辑中」徽章引用不存在 Tailwind 类的基线缺陷。

**Blocked by:** 01（token 基座）

**Status:** ready-for-agent

- [ ] 消息段间距/行距按定案值放宽；用户消息右对齐暖灰块
- [ ] 工具卡（含连发分组、状态/耗时/参数输出）暖灰块化，展开/折叠行为与折叠记忆不变
- [ ] 工作计划卡（plan-card）暖灰圆角块，收起态百分比/N/M/预览信息不变
- [ ] 子代理标记行单行形态、点击定位右栏不变
- [ ] 「回到底部」浮钮白卡 hairline 小阴影
- [ ] QueueBar 徽章缺陷修复（`bg-accent-soft`/`text-accent-fg` 不存在类——见 notes.md「已知基线缺陷」，按 D 语言补正确样式）
- [ ] ui 单测全绿
- [ ] e2e 实跑绿：message-order / process-segments / work-plan / subagents / scroll-following / compact（队列条链外场景 input-queue 系五条按需抽跑）
- [ ] dev 双主题走查截图留证

## Comments
