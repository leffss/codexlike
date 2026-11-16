# ai-agent

## Agent skills

### Issue tracker

Issues 以本地 markdown 文件形式跟踪，存放在 `.scratch/<feature>/` 下。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五角色标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

Single-context 布局：根目录一个 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。

### 构建与检查

检查命令（test / e2e / dist）直接运行取退出码，不接 `| tail` 类管道（管道会吞退出码，已多次发生假绿/假死）。desktop/ui 测试加载 agent-core 构建产物 dist——agent-core 源码改动后未重建 dist 会报 `not a function` 假红，两包 `test` script 已前置 agent-core build（2026-11-16 subagent-records 合并轮踩坑）。

#### Worktree

新 worktree 先 `pnpm install --frozen-lockfile` 再跑任何检查；清理时 `git worktree remove` 报 `Directory not empty` 说明 git 侧已注销、磁盘残留 node_modules，`rm -rf <dir>` 单独收尾即可。

## Git 提交

每个会话只提交当前会话修改过的文件：提交前 `git status` 核对改动清单，确认每个文件都是本会话所改，再按显式路径逐个 `git add <file>`。工作区常有其他会话或手工操作留下的未提交改动，全量暂存（`git add -A` / `git add .`）会把它们混进本次提交。
