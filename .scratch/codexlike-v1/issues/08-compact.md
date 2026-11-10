# 08: /compact 手动压缩

**What to build:** 用户在长会话中执行 `/compact`：当前模型把既有消息历史压缩为摘要，摘要替换旧历史、仅保留最近 3 轮原始对话，压缩记录入库，`/status` 显示「已压缩」状态与当前用量；压缩后继续对话上下文连贯。UI 在压缩过程中有状态提示，被压缩的历史折叠显示为一张摘要卡片（可展开看摘要全文）。

遵循 `GLOSSARY.md`（术语：Compact）；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 07 (AGENTS.md + 斜杠命令 + @引用 + /status)

**Status:** done

- [x] `/compact` 触发压缩：旧历史替换为摘要 + 最近 3 轮原始对话
- [x] 压缩记录与摘要入库；重启会话恢复后仍可见摘要卡片
- [x] `/status` 显示已压缩标记与压缩后用量
- [x] 压缩后对话上下文连贯（`MockLanguageModel` 断言注入的消息序列）
- [x] 压缩过程中 UI 有进行中提示，不可重复触发
- [x] 压缩请求失败时原历史不受损、可重试

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/08-compact`，基线 6b94a6f；期间合并 `integration/codexlike-v1` tip 26e6d5c 即工单 03）

1. **`/compact` 触发压缩：旧历史替换为摘要 + 最近 3 轮原始对话** ✅ `AgentSession.compact({ profile })`（agent-core `./node`）：`generateText` 以压缩专用 system 指令请求当前模型 → 摘要落为 `compact-summary` 角色消息 + 保留轮次重新落库（新 id、递增时间戳，摘要卡片排最前）。测试：`tests/session/compact.test.ts`「压缩成功」（listMessages = 1 摘要 + 最近 3 轮 6 条原文，doGenerate prompt 含被压缩轮次、不含保留轮次）+ E2E 断言压缩请求体（system 为压缩指令、只携带第 1 轮）。
2. **压缩记录与摘要入库；重启恢复后仍可见摘要卡片** ✅ `compact_records` 表（id/session_id/summary/messages_compacted/created_at，多次压缩累积追加、末条生效）；`SessionPersistence.replaceHistory` 单事务（BEGIN…COMMIT）删除旧消息 + 写新历史 + 追加 compact 记录 + 清理被压缩轮次的 tool_calls。测试：sqlite-store「重开库完整恢复」「多次压缩正序」「02/07 旧库自动建表」；E2E 第二次启动断言摘要卡片与压缩后消息数。
3. **`/status` 显示已压缩标记与压缩后用量** ✅ `SessionStatusInfo.compacted: { at, messagesCompacted } | null`（manager.latestCompact ← listCompacts 末条）；压缩后用量 = AGENTS.md + user/assistant/compact-summary 消息估算（摘要按上下文消息计入）。`formatSessionStatus` 输出「压缩状态：已压缩（时间，压缩了 N 条历史消息）」。desktop status.test 2 用例 + E2E 文案断言。
4. **压缩后对话上下文连贯（MockLanguageModel 断言注入序列）** ✅ compact.test.ts「压缩后继续对话」：`doStreamCalls.at(-1).prompt` = [摘要 user（`<compact-summary>` 包装）, 第 2/3/4 轮 u/a, 新消息]，role 序列与逐条内容精确断言；「重启等价」用例覆盖恢复路径（toModelMessage 对 compact-summary 统一包装，与压缩后内存上下文一致）。E2E 断言真实 HTTP 请求体 = 摘要标记 + 最近 3 轮 + 新消息、不含被压缩轮次原文。
5. **压缩中 UI 有进行中提示，不可重复触发** ✅ 渲染层 `compacting` state：消息流底部 `compacting-indicator`（脉动指示 + 「压缩期间输入已暂停」）、composer hint 切换、输入禁用；压缩中再次 `/compact` 与发送均被拦截。主进程侧与 sendMessage 共享 busy 互斥（单测「互斥」：压缩挂起时发送/重复压缩抛中文错误，完成后恢复）。
6. **压缩请求失败时原历史不受损、可重试** ✅ 摘要在副本上生成（先 generateText 后落库），失败路径零写入：单测「压缩请求失败」（APICallError 401 → rejects 中文提示，库消息/compact 记录逐字节原样，第二次 compact 成功替换）。历史过短（≤3 轮）中文提示且不发起请求。

### 关键实现事实（后续工单建立在这些接口上）

- **持久化扩展**：`SessionPersistence` 新增 `replaceHistory(sessionId, messages, compact, pruneToolCallsBefore?)` 与 `listCompacts(sessionId)`；`StoredMessage.role` 增加 `'compact-summary'`（进上下文时按 user 角色注入，error 仍排除）；`compact_records` 表随 SCHEMA 自动建（旧库幂等）。
- **agent-core 出口**：`CompactRecord` / `CompactResult` 类型（主出口 type-only）；`COMPACT_KEEP_ROUNDS = 3`；`SessionManager.latestCompact(sessionId)`。`SLASH_COMMANDS` 新增 `/compact`（命令菜单/解析层自动生效）。
- **IPC**：`sessions:compact`（`compact(sessionId, profileId)` 返回 `{ compactedMessages }`，失败中文异常抛回）；`sessions:status` 响应新增 `compacted` 字段。
- **UI**：`MessageStream` 新增 `compacting` prop 与摘要折叠卡片（`<details>` 展开 markdown 全文，testid `message-compact-summary`）；`planSlashCommand` 新增 `compact` 动作；压缩成功后重拉 transcript 渲染。

### 设计决策与偏离说明

- **摘要即消息**：摘要作为 `compact-summary` 角色消息存 messages 表（而非仅存 compact_records），重启恢复路径与压缩后立即路径共用同一事实来源，UI 无需拼装。保留轮次重新落库（新 id/时间戳）以保证摘要卡片排序在最前——内容原文保留，仅 id/时间戳是实现细节。
- **压缩清理被压缩轮次的 tool_calls**（合并工单 03 时发现）：transcript 按 createdAt 合并消息与工具卡片，残留的旧 tool_calls 会排在摘要卡片之前破坏「折叠为一张卡片」；`replaceHistory` 以保留轮次最老消息时间戳为界，同事务删除更早的 tool_calls（保留轮次的工具卡片不动）。
- **@引用 附加内容在重启后回到原文**：与未压缩会话的重启行为一致（07 设计：落库保持原文）；压缩后未重启的内存上下文仍保真（单测双向断言）。
- **压缩不走事件流**：`compact` 返回 Promise（不 AsyncIterable），进行中状态由渲染层 compacting state 承担，成功后主动重拉 transcript；失败经 IPC 异常抛回，库零写入天然可重试。
- **压缩用当前所选 Profile**：与 sendMessage 同源解析（主进程 profiles.list），并落库 providerProfileId/model；压缩请求不注入 AGENTS.md system（一次性总结任务，用压缩专用指令）。

### 踩坑记录（对后续工单有用）

- **`generateText` 对 5xx APICallError 会自动重试**（SDK 默认 maxRetries=2）：测试「失败→可重试」路径要用不可重试类错误（401/429 之外注意 5xx 会先被 SDK 吞掉重试，观察不到失败）。
- **ai v7 传给 provider 层的 prompt content 是 parts 数组**（`[{type:'text',...}]`）而非 string：断言消息内容要经 `textOf` 归一（tests/session/compact.test.ts 有 helper）；流式 mock 的 finish part 必须带 `type: 'finish'`（漏掉报 `Unknown chunk type: undefined`）。
- **`<details>` 折叠内容仍在 DOM**：E2E 断言「折叠态不可见」要用 `isVisible()`（textContent 永远含全文）；Playwright `fill` 触发一次 input，菜单交互用 `press`。
- **E2E mock 需按 `stream` 字段分流**：对话（streamText）要 SSE，压缩（generateText）要 JSON chat.completion——同一 endpoint 返回错格式会静默重试然后失败。
- **合并工单 03 的冲突面**：persistence/manager/agent-session 是双侧共同扩展点（工具记录 vs compact 记录），解决模式是两侧方法/表全保留；03 的 sendMessage 工具循环只把最终 user/assistant 纯文本 push 进持久 context（tool 消息在局部 pending），compact 的轮次切分假设在合并后依然成立。

### 测试与验证

- `pnpm typecheck` 三包全过（0 错误）；`pnpm test`：agent-core 155 + desktop 19 + ui 32 = 206 用例全绿（含 03 合并进来的工具测试）。
- `pnpm test:e2e`（02 冒烟，03 扩展后含工具卡片）回归通过；`test:e2e:commands`（07）回归通过；`test:e2e:compact`（本工单新增，`packages/desktop/e2e/compact.mjs`）通过。
