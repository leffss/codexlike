# 04: 审批模式三档 + 审批卡片

**What to build:** 会话获得审批模式（`readonly` / `suggest` / `full`，随时切换、立即生效）：`readonly` 下一切写入与命令类工具被真实拦截、拒绝原因返回模型；`suggest` 下文件编辑自动应用、终端命令暂停等待用户审批；`full` 全自动。审批卡片三键：批准 / 拒绝 / 本会话总是允许（按命令首词记忆，随会话入库）。UI 顶栏或输入区可切换模式。审批状态机在 `agent-core`（不依赖 Electron），等待审批时会话处于明确的「等待审批」状态（侧栏可见）。

审批三档与 Codex 两轴的映射见 spec「Implementation Decisions → 审批模式」。遵循 `GLOSSARY.md`。

**Blocked by:** 03 (六件核心工具 + 工具卡片)

**Status:** done

- [x] `readonly`：`write_file` / `apply_patch` / `run_terminal_command` 被拒，模型收到拒绝原因后可改用只读工具完成任务
- [x] `suggest`：文件编辑自动应用；终端命令暂停，卡片等待审批
- [x] `full`：全部自动执行
- [x] 「本会话总是允许」：同首词命令后续不再询问；记忆入库、重启会话恢复后仍生效
- [x] 中途切换模式对下一次工具调用立即生效
- [x] 拒绝审批后模型收到结果并正常继续（不崩循环）
- [x] `agent-core` 审批状态机测试：三档行为、审批记忆、等待/批准/拒绝路径

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/04-approval-modes`，基线 26e6d5c）

1. **readonly 三工具被拒 + 拒绝原因回填 + 只读替代可用** ✅ `decideApproval`（`agent-core/src/session/approval.ts`，浏览器安全）三档矩阵：readonly 下 write/command 一律 `blocked`，拒绝文案中文、指引模型改用 read_file/glob/grep。单测（`agent-session-approval.test.ts`）一轮三工具调用全拒：isError + output 含 readonly、文件不落盘、第二轮 doStream prompt 含拒绝原因、`assistant-done` 正常收尾；readonly 工具（read/glob/grep）任何模式放行（矩阵单测）。E2E：切 readonly 后 `write_file` 卡片输出含 readonly、`deny.txt` 不存在、模型收到拒绝后正常给最终回复。
2. **suggest：文件自动应用 + 命令暂停等审批** ✅ 单测：suggest 下 `write_file` 直接落盘且无 approval-request 事件；`run_terminal_command` 触发 `approval-request`（命令原文 + 首词齐全）→ 会话落库 `waiting-approval` → `respondApproval('approve')` 唤醒 → 命令真实执行（临时工作区断言产物）。事件序：`tool-call → approval-request → approval-resolved → tool-result`。E2E：审批卡三键可见、侧栏「等待审批」徽标出现。
3. **full 全自动** ✅ 单测：命令直接执行、无审批请求事件、产物落盘。
4. **本会话总是允许：记忆 + 恢复** ✅ always 决定 → 命令首词入 `approvals` 表（session_id+command_word 主键，`INSERT OR IGNORE` 幂等）+ 内存 Set 即时命中 → 同首词下一条不再询问（单测 + E2E 同会话第二条 echo 直落）；同持久层重建会话对象（manager.get 恢复路径读 `listApprovals`）后 suggest 下同首词命令仍直接执行（单测）；E2E 真实重启应用后 echo 命令不弹卡直接执行。首词 `commandFirstWord`（trim + 空白分割 + 小写归一，Windows 命令大小写不敏感）；命令类工具无 command 参数时回退按工具名记忆（为工单 12 MCP 命令类工具预留）。
5. **中途切换立即生效** ✅ 单测：readonly 下被拒的 `write_file`，`setApprovalMode('full')` 后同会话下一条消息同一工具放行落盘。manager 层：落库 + 缓存实例 `setApprovalMode`（对下一次工具调用生效，等待中的决定不受影响——语义即「下一次」）。UI 选择器随时可切（suggest/readonly/full），IPC 边界三档枚举校验。
6. **拒绝后正常继续** ✅ 单测：reject → isError 结果（中文原因，指引模型换思路或询问用户）→ 第二轮 prompt 含拒绝 → 最终 `assistant-done` + tool_calls 落库 1 条。`respondApproval` 幂等防护：无等待/ id 不匹配/重复响应均返回 false（单测）。
7. **agent-core 审批状态机测试** ✅ 新增 25 用例全绿：`approval.test.ts`（三档矩阵 6 + 首词提取 1）、`agent-session-approval.test.ts`（readonly 拒绝 / suggest 文件放行+命令审批 / reject 路径 / full / always 记忆+恢复 / 中途切换 / respondApproval false / 等待中 abort 防御共 8）、sqlite-store（approvalMode 落库、approvals 幂等+重启恢复、旧库迁移 3）、manager（默认 suggest + setApprovalMode、未实例化会话切模式、waiting-approval 残留重置 3）。

### 关键实现事实（后续工单建立在这些接口上）

- **审批插点**（03 注明的位置）：`agent-session` 工具循环内 `yield tool-call` 之后、`runTool` 之前；`approval-request` 事件流出后生成器 `await` 外部 `respondApproval` 唤醒——desktop 的后台消费循环在生成器暂停时同步挂起，事件流不丢。等待中 signal abort 视为 reject（防生成器永久卡死；06 打断恢复在此之上加固即可，无需改这段）。
- **agent-core 出口**：主出口新增 `ApprovalMode` / `ApprovalDecision` / `ApprovalRequest` / `ApprovalGate` 类型与 `decideApproval` / `commandFirstWord`（浏览器安全，ui 值导入）；`./node` 经 `AgentSession.pendingApproval` / `setApprovalMode` / `respondApproval` 与 `SessionManager.setApprovalMode` 暴露。
- **持久化**：`SessionPersistence` 新增 `insertApproval` / `listApprovals`；sessions 表加 `approval_mode`（新库 DEFAULT 'suggest'，旧库 ALTER 迁移，旧行读回 suggest）；`SessionStatus` 新增 `'waiting-approval'`；`SessionRecord.approvalMode` 落库，manager.create 默认 suggest、恢复时连同审批记忆一起读回。
- **IPC 新增**：`sessions:set-approval-mode` / `sessions:respond-approval` / `sessions:pending-approval`（切回会话时恢复审批卡片）；`SessionStatusInfo.approvalMode` 自 null 预留落位为真实值（07 的 /status 显示「协作（suggest）：文件编辑自动应用，终端命令逐条审批」等三档中文文案）。
- **UI**：`ApprovalCard`（三键 data-testid：`approval-approve` / `approval-reject` / `approval-always`，响应后转结果态）；`session-view` 归并 approval-request/resolved 为 `UiApproval`；输入区审批模式选择器（只读/协作/自主）；侧栏 waiting-approval 徽标。

### 设计决策与偏离说明

- **拒绝结果的 isError=true**：readonly 拒绝与用户拒绝均以 isError 落库并在卡片显示失败态——拒绝语义是「未执行成功」，与 03 的失败口径一致；具体原因全在 output 文本（前缀「工具调用被审批策略拒绝：」/「工具调用被用户拒绝：」），模型可读。
- **审批历史不单独落库**：spec 提到「审批决定」表，实际只需持久化 always 记忆（approve/reject 是一次性决定，随 tool_calls 记录的 output 已可追溯）；approvals 表即该语义的最小实现。
- **新建会话默认 suggest**：安全默认（Codex Desktop 同款协作档），readonly/full 由用户显式切换。
- **MCP 预留**：命令类工具无 command 参数时按工具名记忆，工单 12 的 MCP 命令类工具天然获得「按工具名总是允许」语义。

### 踩坑记录（对后续工单有用）

- **AsyncGenerator 内的审批等待**：`yield approval-request` 后生成器挂起在 yield 表达式，直到消费者再次 next()；因此审批等待的 Promise 必须在 yield 之前创建好、`respondApproval` 由外部（IPC handler）随时可调——不要试图在生成器内部轮询。
- **`record.approvalMode` 是必填字段**：所有手写 `SessionRecord` 的测试工厂都要补（4 个 agent-core 测试文件 + desktop status 测试 + ui 测试），漏了运行时是「SQLite parameter cannot bind undefined」而非类型错误先行。
- **E2E 用 `.last()` 定位新工具卡片是竞态**：waitFor 对已存在元素立即返回，会命中重启恢复的旧卡片；按 `[data-testid][data-tool-name]` 联合属性精确定位新卡片。
- **等待审批期间 `pendingApproval` 快照供 UI 恢复**：切走再切回会话时事件流里的 approval-request 已丢失，`sessions:pending-approval` 查询 + `applySessionEvent` 复用归并逻辑重建卡片。

### 测试与验证

- `pnpm typecheck` 三包 0 错误；`pnpm test`：agent-core 164 + desktop 18 + ui 31 = 213 用例全绿。
- E2E：`smoke.mjs`（02/03 冒烟）回归通过；`commands.mjs`（07）回归通过；新增 `approvals.mjs`（`pnpm --filter @codexlike/desktop run test:e2e:approvals`）通过——覆盖 suggest 审批卡三键、always 记忆、/status 真实值、真实重启记忆恢复、readonly 拦截全链路。
