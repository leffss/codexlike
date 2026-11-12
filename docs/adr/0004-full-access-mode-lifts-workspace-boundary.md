# 完全访问档放开工作区文件边界

> 会话授权记忆约束已由 [ADR 0012](0012-persistent-session-auto-approval.md) 部分替代；`full-access` 的文件访问含义保持不变。

审批模式从 `readonly / suggest / full` 重构为 `ask 请求批准 / assist 帮我批准 / full-access 完全访问`（GLOSSARY「审批模式」）。其中 `full-access` 明确承诺「可不受限地访问互联网和本地电脑文件」，这推翻了 spec「审批与安全」的原决定——`resolveInWorkspace` 对文件工具的强制工作区边界不再适用于该档。

**决定**：新增 `resolvePath(workspacePath, target, mode)`（`packages/agent-core/src/tools/workspace.ts`）——`full-access` 档下绝对路径原样解析、相对路径仍以工作区为基准，跳过边界断言；其余档位走原 `resolveInWorkspace`（realpath 防 `..` 与符号链接逃逸，不变）。当前审批模式经 `ToolExecutionContext.approvalMode` 传入工具执行器，与审批门（`decideApproval`）同步读取同一会话状态。工作区外的 git-service / worktree-service 仍强制边界（宿主侧服务，不随会话档位变化）。

**配套约束**：

- 切换到 `full-access` 时 UI 先弹风险确认对话框（`FullAccessConfirmDialog`），确认才发起 `setApprovalMode` IPC；取消不切换。
- 三档语义随之重构：`ask` = 写入/命令/联网一律询问（旧 `readonly` 是直接拒绝，语义不同）；`assist` = 写入与联网自动放行、命令按危险黑名单（`isRiskyCommand`：rm/del/format/git push --force 等）询问，其余自动放行。
- 「本会话总是允许」记忆机制随之移除：`assist` 下非危险命令不再逐条审批（无记忆场景），危险命令与 `ask` 档不允许记忆（避免批准一次 `rm` 后全自动）。审批卡 `always` 键仅放行本次；`approvals` 表与持久化接口保留（旧库兼容），无写入调用方。
- 旧库迁移只做读侧映射（`persistence.ts` 的 `toRecord`：`readonly→ask`、`suggest→assist`、`full→full-access`），不回写数据；`web_search` 从 `readonly` 权限类改为新增的 `network` 类（`ask` 档询问联网）。

**替代方案**：保持文件边界、`full-access` 仅放开审批——但这样「不受限访问本地文件」的承诺不成立，用户在完全信任场景下无法让 Agent 跨目录工作（如同时改两个 repo、写用户级配置）。放开边界 + 显式风险确认是更诚实的权衡。

**后果**：`full-access` 下误操作可波及工作区外文件（不可逆范围变大），依赖用户在确认对话框处把关；这是产品语义（对标 danger-full-access 类档位）而非技术缺口。
