# 04: e2e：子代理工作计划全链场景与 dev fixtures 样例

**What to build:** e2e 新场景走通全链：任务委派子代理 → 子代理建计划 → 更新计划（步骤推进）→ 完成 → 右栏详情底部计划卡显示终态 → 应用重启后计划卡照常回看（已完成子代理，数据走子代理工具调用表恢复快照，不依赖运行期内存）。dev fixtures 增补子代理 `update_plan` 样例，dev 预览中子代理详情直接可见计划卡形态。调研事实见 `../notes.md`。

**Blocked by:** 01（子代理真实具备 update_plan 能力），02（详情计划卡）

**Status:** done

- [ ] e2e 场景实跑通过：委派 → 建计划 → 更新 → 完成 → 详情底部计划卡终态 → 重启回看
- [ ] dev fixtures 含子代理 `update_plan` 样例，dev 预览子代理详情可见计划卡
- [ ] 三包测试与既有 e2e 场景（含 subagent-interrupted、subagent-recovery-review）不回归
