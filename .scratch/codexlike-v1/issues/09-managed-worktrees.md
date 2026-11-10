# 09: 托管 Worktree

**What to build:** 新建会话时可选运行位置：「本目录直跑」（默认）或「worktree 模式」——CodexLike 在 `~/.codexlike/worktrees/<会话id>` 自动创建 git worktree 与独立分支 `codexlike/<会话id>`，会话的全部文件与终端操作发生在隔离副本中；项目内 `.worktreeinclude` 文件列出的被 ignore 文件（如 `.env`）在创建时复制进副本。会话结束（删除/归档）后 worktree 进入 LRU 清理：只保留最近 15 个，运行中会话的 worktree 永不清理。非 git 目录选 worktree 模式时明确报错。验收场景 5：同一仓库一本地会话 + 一 worktree 会话并行改动互不干扰。

遵循 `GLOSSARY.md`（术语：托管 Worktree）；完整需求见 `.scratch/codexlike-v1/spec.md`。不做 local↔worktree 中途迁移（handoff）。

**Blocked by:** 05 (改动面板 + git 集成), 06 (会话恢复 + 打断)

**Status:** ready-for-agent

- [ ] 新会话可选模式；worktree 创建于约定目录、独立分支命名正确
- [ ] `.worktreeinclude` 声明的被 ignore 文件被复制进副本
- [ ] 会话的读写与命令实际发生在 worktree 内（主工作区不受影响）
- [ ] LRU 清理保留最近 15 个；运行中会话的 worktree 不被清理
- [ ] 非 git 目录选 worktree 模式给出明确中文错误
- [ ] 集成测试：同一仓库双会话（本地 + worktree）并行改动互不干扰
- [ ] worktree 会话重启恢复后仍指向原 worktree
