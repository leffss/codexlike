# 05: 改动面板 + git 集成

**What to build:** 消息流区可唤起侧滑改动面板：列出工作区 `git status` 的变更文件（新增/修改/删除标识），点文件用 Monaco diff 视图查看改动；提供「一键创建分支（`codexlike/<会话名>`）」与「一键 commit」——commit 消息由模型按会话内容生成、可编辑，提交当前全部变更。非 git 工作区时面板明确降级提示。git 操作经 `simple-git` 封装在 `agent-core` 的 git 服务中，可脱离 Electron 测试。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 03 (六件核心工具 + 工具卡片)

**Status:** ready-for-agent

- [ ] 改动面板列出 `git status` 变更文件并正确标识类型
- [ ] Monaco diff 查看单文件改动（新旧两侧对比）
- [ ] 一键创建分支 `codexlike/<会话名>`，成功有反馈
- [ ] 一键 commit：模型生成消息（可编辑）→ 提交 → 面板刷新
- [ ] 非 git 目录显示「非 git 工作区」提示，不报错崩溃
- [ ] git 服务测试（临时 git repo fixture）：status/diff/branch/commit 全路径
