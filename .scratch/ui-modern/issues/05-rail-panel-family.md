# 05: 右栏检视家族——三分 tab / 子代理详情 / diff / git 动作

**What to build:** 检视右栏换 D 语言：白底无边界（去左边框），tab 去描边、激活态暖灰底+字重 600；改动文件清单、diff 视图（Monaco 随主题）、子代理详情（委派说明/逐轮正文思考/工具清单/计划卡/导出）、资源快照在暖色体系下信息密度不减、层级清晰；git 提交动作区样式统一。

**Blocked by:** 01（token 基座）

**Status:** ready-for-agent

- [ ] rail-panel 白底去边界；拖拽分隔条平时隐形、hover/拖动暖灰现形（保留可拖宽度与键盘操作）
- [ ] tab 激活态暖灰底+字重（非描边胶囊）；三 tab 互斥与开关状态同步行为不变
- [ ] Monaco diff 浅深主题下可读性过关（theme prop 随 useTheme 已有，token 重定后走查）
- [ ] 子代理详情与资源快照样式统一到 D 语言，导出/定位行为不变
- [ ] git 文件行状态色（增/删/改/重命名）暖色下可辨；建分支/生成提交消息/提交动作区样式统一
- [ ] ui 单测全绿
- [ ] e2e 实跑绿：width-tiers（rail 几何三档+tab 断言）/ changes / subagent-recovery-review
- [ ] dev 双主题走查截图留证

## Comments
