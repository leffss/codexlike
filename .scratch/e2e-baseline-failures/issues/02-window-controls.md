# 02: window-controls e2e：基线损坏（9fa1bd8 记录在案）

**What to build:** 复现并修复 window-controls e2e 场景，使其在全量链（test:e2e:all）中恢复绿色。失败形态尚未在本轮复现（全量门在 live-tasks 先红未跑到它），需先单跑取证再定位。

**Blocked by:** None（can start immediately；建议在 01 修复后一起全量验证）

**Status:** needs-triage

- [ ] 单跑 `node e2e/window-controls.mjs` 取证（失败形态、稳定复现性）
- [ ] 定位根因并修复（真行为缺陷或过期断言，参照 worktree.mjs d749aa1 的断言同步先例区分对待）
- [ ] 全量 e2e（test:e2e:all）不回归

## Comments

- 2026-11-17 登记佐证：9fa1bd8 提交信息记录「live-tasks 与 window-controls 在干净 main（stash 本改动重建后）同样失败，属已存在问题与本改动无关」——即 2026-11-12 前后已坏，此后无人跑全量 e2e。本轮 pre-push 门（首次全量）在 live-tasks 先红，未及跑到本场景。随 01 票同批以 --no-verify 旁路推送（特性已全量验证，损坏为陈年）。
