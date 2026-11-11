# ai-agent

## Agent skills

### Issue tracker

Issues 以本地 markdown 文件形式跟踪，存放在 `.scratch/<feature>/` 下。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五角色标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

Single-context 布局：根目录一个 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。

### 构建与检查

E2E 命令直接运行，不接管道（`| tail` 会吞退出码，已多次发生假绿/假死）。
