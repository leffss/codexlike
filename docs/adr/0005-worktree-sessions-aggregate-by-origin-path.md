# Worktree 会话按原始仓库路径聚合进项目

> 本文保留旧实现的决策背景；目标设计由 [ADR 0010](0010-session-workbench-project-membership-and-workspace.md) 替代：项目改为独立实体、会话归属可选，Worktree 来源仍保留。新设计尚未实施。

侧边栏的「项目」分组按工作区目录聚合会话（见 GLOSSARY「项目」），但 worktree 模式落库的 `workspacePath` 是 `~/.codexlike/worktrees/<会话id>`，原仓库路径无处可查（worktree 服务自己的记录会随「只保留最近 15 个」的自动清理消失，而 session 记录是永久的）。因此 sessions 表增加 `workspace_origin_path` 列：worktree 会话创建时写入原仓库路径，项目聚合键取 `origin ?? workspacePath`。

## Considered Options

- 按 `workspacePath` 原值聚合：同一仓库的 local / worktree 会话被拆成两组，且 worktree 组的项目名是一串会话 id——不可读，弃。
- 从 worktree 服务记录反查原始路径：记录随清理消失，不可靠，弃。

## Consequences

- 旧库无此列的存量 worktree 会话恢复为 null，按其 worktree 路径独立成组（这些 worktree 副本早已被清理，多为归档壳，可接受）。
- 项目保持纯派生视图，不建 projects 表；将来若需要重命名或项目级设置，按聚合键一次性 seed 成实体表即可。
