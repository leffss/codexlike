# 05: e2e 场景改造实跑

**What to build:** 新建任务交互面（居中起点页、归属选择器、单按钮入口）落定后的 e2e 收口：`entry-consistency` 按新入口语义重写断言（顶栏单按钮、组头语境直达、`/new`、冷启动恢复仍收敛到同一新建页），`projects-sidebar`、`persistent-workbench`（含切归属 = 切入口草稿的新场景）与 worktree 首发流程场景适配改造，全部实跑取绿。AGENTS.md 规矩：改 e2e 交互面合入前必须实跑，单测全绿不算数。

**Blocked by:** 01, 02, 03

**Status:** ready-for-agent

- [ ] `entry-consistency` 新语义断言过绿：四个入口（顶栏单按钮/组头×2/`/new`）进入同一新建页且语境正确；冷启动恢复场景保持
- [ ] `persistent-workbench` 过绿：新建草稿按入口持久化；归属切换后各入口草稿独立恢复
- [ ] `projects-sidebar` 及 worktree 首发流程场景过绿（项目任务本地/Worktree 两种首发路径）
- [ ] ui dist 重建后实跑（e2e 加载 dist，源码改动未重建会假绿/假红，见 notes.md）
- [ ] 相关冒烟场景（window-close/exit-recovery 触及新建态的部分）实跑无回归

## Comments
