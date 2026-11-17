# 01: agent-core：子代理获得 update_plan 与策略，执行落库

**What to build:** 主任务委派的子代理现在也能像主任务一样维护自己的工作计划：子代理每次运行的工具表强制并入 `update_plan`（readonly 免审批；资源快照 execution tools 与其撞名即拒绝——同 questionsTool 模式）；子代理系统提示注入工作计划使用策略（`PLAN_USAGE_POLICY`）与通用风格条款（`TOOL_STYLE_POLICY`），复用主任务同一常量，「计划未全部完成前不结束回合」持续执行条款随之适用子代理；子代理调用 `update_plan` 在子代理循环内正常执行（中文统计摘要输出），逐条落子代理工具调用表、随恢复快照重建；最终报告保持纯文本，不附计划统计摘要。既有「子代理工具表不含 update_plan」「子代理提示不含工作计划策略」两条反向断言反转为正向。调研事实见 `../notes.md`。

**Blocked by:** None（can start immediately）

**Status:** done

- [ ] 子代理每次运行的工具表含 `update_plan`；资源快照 execution tools 与 `update_plan` 撞名被拒绝
- [ ] 子代理系统提示含工作计划使用策略与风格条款（复用同一常量），且不随轮次重复注入
- [ ] 子代理调用 `update_plan` 免审批执行、输出中文统计摘要；调用逐条落子代理工具调用表，恢复快照包含这些行
- [ ] 子代理最终报告不附计划统计摘要（现状断言保留）
- [ ] 两条既有反向断言反转为正向；防递归断言（spawn_subagent 剔除）不受影响
- [ ] agent-core 全部测试通过
