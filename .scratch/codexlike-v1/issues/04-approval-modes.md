# 04: 审批模式三档 + 审批卡片

**What to build:** 会话获得审批模式（`readonly` / `suggest` / `full`，随时切换、立即生效）：`readonly` 下一切写入与命令类工具被真实拦截、拒绝原因返回模型；`suggest` 下文件编辑自动应用、终端命令暂停等待用户审批；`full` 全自动。审批卡片三键：批准 / 拒绝 / 本会话总是允许（按命令首词记忆，随会话入库）。UI 顶栏或输入区可切换模式。审批状态机在 `agent-core`（不依赖 Electron），等待审批时会话处于明确的「等待审批」状态（侧栏可见）。

审批三档与 Codex 两轴的映射见 spec「Implementation Decisions → 审批模式」。遵循 `GLOSSARY.md`。

**Blocked by:** 03 (六件核心工具 + 工具卡片)

**Status:** ready-for-agent

- [ ] `readonly`：`write_file` / `apply_patch` / `run_terminal_command` 被拒，模型收到拒绝原因后可改用只读工具完成任务
- [ ] `suggest`：文件编辑自动应用；终端命令暂停，卡片等待审批
- [ ] `full`：全部自动执行
- [ ] 「本会话总是允许」：同首词命令后续不再询问；记忆入库、重启会话恢复后仍生效
- [ ] 中途切换模式对下一次工具调用立即生效
- [ ] 拒绝审批后模型收到结果并正常继续（不崩循环）
- [ ] `agent-core` 审批状态机测试：三档行为、审批记忆、等待/批准/拒绝路径
