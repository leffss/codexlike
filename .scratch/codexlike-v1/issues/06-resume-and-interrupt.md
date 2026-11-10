# 06: 会话恢复 + 打断

**What to build:** 关闭应用重开后，任意会话可无损恢复：完整消息历史（含工具调用卡片）、审批记忆（总是允许清单）、所选模型与审批模式全部还原，「继续」即在既有历史上续跑。运行中的会话可随时打断：停止按钮在模型流式输出时立即中断本轮，在工具执行中（如长命令）终止子进程；打断后消息流标记中断点，会话可继续发新消息。中断能力经 `AbortController` 贯穿 `agent-core` 循环、工具执行与 IPC。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 03 (六件核心工具 + 工具卡片)

**Status:** done

- [x] 重启应用后消息历史（含工具卡片展开内容）与原会话一致
- [x] 「总是允许」审批记忆恢复后生效
- [x] 流式输出中点停止：本轮立即终止，UI 标记中断
- [x] 工具执行中（运行中的长命令）点停止：子进程被杀死，结果标记为用户中断
- [x] 中断后继续发新消息正常工作（上下文包含中断前的历史）
- [x] `agent-core` 测试：会话快照恢复等价性、AbortController 贯穿（流式与工具两层）

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/06-resume-and-interrupt`，已合并 integration tip `18bc4e9` 含工单 08/10）

1. **重启后消息历史（含工具卡片展开内容）与原会话一致** ✅ 消息 + 工具卡片恢复链路 03 已有（transcript）；本工单补齐两处恢复缺口并锁定等价性：(a) **@引用 随消息持久化**（messages 表新增 `mentions` JSON 列，幂等迁移）——修复前恢复后续跑的模型上下文丢失 @引用 附件内容；(b) **中断标记持久化**（`aborted` 列）——重启后中断点仍显示「（已中断，以上为部分回复）」。核心测试 `tests/session/resume-equivalence.test.ts`：含工具轮次 + @引用 + 被中断回复的完整历史，「重启恢复后续跑」与「不重启原地续跑」发给模型的 prompt **深相等**（doStreamCalls toEqual），且 @引用 内容、工具轮结果、中断部分文本全部在恢复后的上下文里。E2E：smoke 重启恢复既有断言 + `interrupt.mjs` 第 ④ 段（重启后中断标记 ≥2、工具卡片含中断结果）。
2. **「总是允许」审批记忆恢复后生效** ✅（按接口预留）工单 04 尚未并入集成（tip 到 10），按工单指示预留：`approval_decisions` 表（id/session_id/decision[`allow`|`allow-always`|`deny`]/subject/created_at）+ `SessionPersistence.insertApprovalDecision/listApprovalDecisions` + `SessionManager.recordApprovalDecision/approvalDecisions`。测试：写入 allow-always（subject `npm`）→ 同库重建 manager（等价重启）→ 清单完整恢复。04 并入后审批状态机直接从此接口读写，持久层不再动。审批模式本身已随会话记录恢复（见下）。
3. **流式输出中点停止** ✅ 输入区按钮在本轮进行中切换为「停止」（`composer-stop`）→ IPC `sessions:interrupt` → `InterruptRegistry`（Map<sessionId, AbortController>）abort → `sendMessage` 的 signal 贯穿 `streamText` abortSignal → 本轮立即中断；已生成部分文本保留为 assistant 消息（`aborted` 标记落库）+ 事件流 `assistant-aborted` → UI 标记中断点、streaming 复位、输入区恢复。E2E ①：慢速流式（20 段×300ms）第 0 段出现后点停止，断言标记出现、无完整 20 段、发送按钮回来。
4. **工具执行中点停止** ✅ 同一 signal 贯穿工具执行上下文 → terminal 工具 `onAbort` → `taskkill /T /F` 杀进程树 → 输出标记 `[已被用户中断，进程已终止]`（**区别于超时标记**，修复前两者同路径混标记）；结果落库 tool_calls（isError + 标记），下一轮 streamText 立即 abort（E2E 断言 mock 仅收到 3 次请求，工具中断后模型不再被调用）。时序细节：生成器在 `tool-call` 事件 yield 处暂停，若 abort 落在事件与执行之间，已 abort 的 signal 不会再触发 listener——会话循环显式短路（「已被用户中断，未执行」，测试断言命令无痕迹文件）。E2E ③：`echo started; sleep 30` 执行中点停止，<15 秒完成中断（不等满 30 秒）。
5. **中断后继续发新消息** ✅ 中断路径 finally 把会话状态复位 idle（残留 streaming 落库也在应用启动/manager.get 恢复时统一重置，02 已有、回归覆盖）。agent-core 测试：流式中断与工具中断两个用例都断言「下一轮正常完成 + prompt 含中断前完整历史（user 原文 + 中断的部分回复文本）」；E2E ②：中断后发新消息得到完整回复。
6. **agent-core 测试** ✅ 快照恢复等价性（resume-equivalence，prompt 深相等）；AbortController 流式层（02 既有用例 + aborted 落库断言增强）；工具层（agent-session-tools 两个新用例：执行中中断 + 执行前短路）；terminal 中断/超时标记区分（terminal.test.ts）。附带：审批模式恢复（sessions 表 `approval_mode` 列 + `SessionRecord.approvalMode`，默认 `suggest`，旧库 NULL 行恢复为默认档；manager `setApprovalMode` 落库、跨重启恢复——切换 UI 与拦截语义归工单 04）。

### 关键实现事实（后续工单建立在这些接口上）

- **中断链路**：desktop `createInterruptRegistry`（`sessions/interrupt-registry.ts`，单测 4 用例）——`begin(sessionId)` 登记每条消息流的 controller，`end(sessionId, controller)` 防迟到的旧流 finally 清掉新流，`interrupt(sessionId)` 幂等（空闲返回 false）。IPC `sessions:interrupt`，preload 已暴露。
- **SessionEvent 不变**：中断复用既有 `assistant-aborted` / `tool-result` 事件（工具中断结果的 output 带「已被用户中断」文本标记），无新增事件类型。
- **持久化新增列**（全部 ALTER TABLE + try/catch 幂等迁移，含工单 03 旧库真实重建测试）：messages.`mentions`（JSON，损坏数据静默视作无引用）、messages.`aborted`、sessions.`approval_mode`、表 `approval_decisions`。
- **快照等价性的实质**：`toModelMessage` 恢复路径三分支——assistant 原文 / compact-summary 包装（08）/ user `composeUserContent(原文, mentions)` 重组；08 的 `replaceHistory` 重写历史复用统一 `insertMessage`（含 mentions/aborted 列），compact 后保留轮次的 @引用 与中断标记不丢。
- **中断 vs 超时**：terminal 工具 finish 的 outcome 三态（code / timedOut / aborted），输出标记分别为 `[退出码 N]` / `[命令超时（N 秒），已强制终止]` / `[已被用户中断，进程已终止]`。

### 设计决策与偏离说明

- **@引用 持久化改变 07 的恢复语义**：07 时恢复后续跑的上下文不含 @引用 附件内容（只在内存）。本工单按 AC「上下文与原一致」将其随消息落库、恢复时重组；08 的重启等价用例断言已按新语义更新（保留轮次的 @引用 恢复后仍在上下文，与压缩后立即发送一致）。落库与消息流回显仍保持用户原文，仅 mentions 单独成列。
- **审批记忆只做持久化接口**：04 未并入，不猜审批状态机的消费方式；表结构贴合 spec 原文（审批决定表、按命令首词/前缀记忆），`decision` 枚举即审批卡片三选一。
- **中断后工具结果的回填**：中断的工具结果照常作为 tool 消息进入 pending，但下一轮 streamText 因 signal 已 abort 立即终止、不发请求（E2E requestCount 断言锁定），无浪费调用。

### 踩坑记录（对后续工单有用）

- **生成器 yield 处暂停与 abort 时序**：`for await` 消费方在处理事件期间，生成器停在 yield；「收到 tool-call 事件再 abort」打的是执行**前**的空档（工具根本没启动），且已 abort 的 signal 上 `addEventListener('abort')` 永不回调——必须显式检查 `signal.aborted` 短路。要测「执行中中断」，用循环外的并发定时器 abort，别在循环体内 sleep。
- **集成分支的 merge 提交可能被重做**：merge 进行中发现 tip 从 `7923324` 换成内容近似但不全同的 `18bc4e9`（E2E 小修）；worktree 的 MERGE_HEAD 在主仓库 `.git/worktrees/<name>/` 下（worktree 的 `.git` 是文件不是目录），直接改写它即可把 merge 目标换成新 tip，树差异文件单独 checkout。
- **08 的 compact 与 06 的恢复等价性交叉**：`replaceHistory` 内联 SQL 只写 5 列，与新 7 列 prepared statement 参数不匹配（运行时绑定错误）——历史重写类操作必须复用统一的消息写入函数，别复制粘贴列清单。
- **interrupt E2E 的 Profile 保存按钮**：设置页有搜索源区后出现两个「保存」按钮，`getByRole('button', {name: /保存|创建/})` 命中 2 个报 strict mode 违规；限定 `window.locator('form').getByRole(...)`（08 集成侧 compact.mjs 同样修法，新 E2E 直接照抄）。

### 测试与验证

- `pnpm typecheck` 三包全过；`pnpm test`：agent-core 177 + desktop 28 + ui 33 = 238 用例全绿。
- E2E 四条全过：`test:e2e`（02/03 冒烟）、`test:e2e:commands`（07）、`test:e2e:compact`（08）、`test:e2e:interrupt`（本工单新增，root 与 desktop 包均有入口）。
