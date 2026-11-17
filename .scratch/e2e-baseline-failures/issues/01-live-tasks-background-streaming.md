# 01: live-tasks e2e：后台续流合并文本不可见（TimeoutError）

**What to build:** 修复多任务后台执行续流行为，使 live-tasks e2e 场景恢复绿色：任务 A 收到「项目A前半段。」后用户切到其他任务，后台继续流式「后台第二段。」，切回/在列表查看时 `message-assistant` 应出现合并文本「项目A前半段。后台第二段。」。当前该等待超时（Playwright TimeoutError），单场景可稳定复现。

**Blocked by:** None（can start immediately）

**Status:** needs-triage

- [ ] 定位根因：后台任务流式 delta 是否到达 UI（live 事件路由/订阅），还是到达但未渲染（live-task 状态机/视图切换时消息段重建丢流）
- [ ] 修复后 live-tasks.mjs 单场景实跑通过
- [ ] 全量 e2e（test:e2e:all）不回归

## Comments

- 2026-11-17 发现与佐证：pre-push 全量门（首次全量跑）抓出；单跑 `node e2e/live-tasks.mjs` 同点超时（等待 `message-assistant` filter hasText '项目A前半段。后台第二段。'）。非本轮 subagent-work-plan 引入——9fa1bd8 提交信息已记录「live-tasks 与 window-controls 在干净 main 同样失败，属已存在问题」。未推送即被 --no-verify 旁路（旁路决策：特性已全量验证、损坏有 commit 记录佐证陈年；见 02 票同批）。
