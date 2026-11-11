# 02: 主会话思考档位与折叠展示全链路

**What to build:** 用户在审批胶囊旁选择思考档位，下一条发送通过 IPC 将选择传到模型，并在主会话中流式查看独立、可折叠的思考内容。打通完整用户路径，不只交付 core 事件或 UI 占位。

**Blocked by:** [01: 迁移兼容 provider，守住现有行为](01-compatible-provider.md)。01 提供已经验证的模型工厂、请求参数和 reasoning 流契约。

**Status:** done

## Parent

[思考档位 spec](../spec.md) 是完整契约；实施前阅读生效边界、接入契约和事件展示要求。

## Acceptance criteria

- [x] 输入框工具栏审批胶囊旁提供胶囊内嵌 select：自动、低、中、高、关；默认自动，显示文字及档位颜色，具备可访问名称和键盘可操作性，无会话时禁用。
- [x] 档位为前端临时发送设置，不建立会话级持久化或全局设置；不新增 schema，不保存最近使用档位，不改变既有模型选择记忆方式。
- [x] 运行中仍可修改选择；发送入口固定本条消息快照。一次发送内所有工具往返保持该档位，下一条消息才采用新选择，历史消息不修改、不重算。
- [x] 五档通过 IPC 与 Agent Core 公共发送入口传到最终请求 body，符合 spec 的映射；未传字段的调用按 `auto` 处理，枚举边界得到验证。
- [x] 主会话独立关联 reasoning 与正文，流式思考块可展开/收起；不把思考拼进 assistant 正文，连续工具轮次及不同消息不串流。
- [x] 只有思考尚无正文、没有 reasoning、正常结束、失败和停止均有正确展示；取消后不残留思考进行中状态，也不继续追加内容。
- [x] 思考内容不进入持久化消息、历史恢复或后续请求上下文；不主动开启 `clear_thinking: false`。重启后不声称能恢复思考内容。
- [x] compact 和 commit 草稿不使用胶囊选择，不附加控制参数；本票保持子代理既有行为，子代理继承及展示由 03 交付。
- [x] 服务端拒绝不支持的档位时沿用错误展示，不静默降档，不增加兼容性自动重试；UI 不声称“关”能强制所有模型关闭思考。
- [x] 主会话公开入口测试覆盖档位快照、跨消息切换、事件隔离、终态处理以及不持久化/不回传；复用现有 UI 状态归并测试。
- [x] Desktop E2E 从选择胶囊到本地 mock provider 的实际请求 JSON贯通验证，并检查流式思考与正文隔离、折叠交互、运行中切档只影响下一条消息。
- [x] 执行相关单测和新增端到端场景，记录真实退出码及结果；保留已有对话、工具与取消行为。

## Testing notes

沿用既有模型 mock、事件收集器、内存持久化及 desktop 本地 HTTP/SSE mock。UI 状态断言验证归并语义；折叠可操作性和完整 IPC 链路由 E2E 验证。以可观测行为为断言，不锁死内部函数调用和 CSS 实现。

## Comments

### 2026-11-11 · 02 implementer（worktree feat/thinking-effort-02，基于 1f96e15）

**交付摘要**

- agent-core：`SendMessageOptions.thinkingEffort`（缺省 auto、枚举外入口拒绝）；发送入口固定快照，工具循环每轮 `modelFor(profile, { thinkingEffort })` 复用同一快照；`CreateAgentSessionOptions.languageModelFor` 签名扩展为 `(profile, options)`（少参注入仍兼容，compact 传 `{}` 不附加控制参数）；fullStream 消费 reasoning-delta → 新事件 `assistant-reasoning { messageId, delta }`（SessionEvent 联合新增 variant，随既有 type-only 出口导出）；`THINKING_EFFORTS` 常量自 `src/index.ts` 导出。
- desktop：`sessions:send` IPC 增加 `thinkingEffort` 参数，主进程枚举校验（`auto/low/medium/high/off`，未传等价 auto）后传入 sendMessage（shared/ipc.ts、preload.ts、session-ipc.ts）。
- ui：MessageComposer 审批胶囊旁新增思考档位胶囊内嵌 select（`data-testid="thinking-effort-select"`，五档中文文案 + 档位颜色 Record，默认自动，无会话禁用，运行中可改选）；WorkspacePage 持有临时选择（默认 auto，无会话级记忆）随消息传 IPC；session-view 归并 `assistant-reasoning`（只更新所属消息、未知 messageId 忽略、error 时清除 streaming 终态收敛、历史加载不造思考块）；MessageStream assistant 气泡内渲染可折叠思考块（`thinking-block`，默认收起、流式指示、与正文 `assistant-content` 分离渲染）。
- E2E：新增 `packages/desktop/e2e/thinking.mjs`（挂进 `test:e2e:all` 与 `test:e2e:thinking`），复用 helpers 的 startMockProvider/seenBodies/SSE 发送器。

**TDD 红绿证据**

- agent-core（`tests/session/thinking.test.ts`）：红 = 8 failed / 3 passed（档位快照、reasoning 事件均未实现）；绿 = 11 passed（含真实 provider 工厂 + fetch 替身全链路：reasoning SSE → 事件流出、两轮请求 body 不回传思考、high 档 body 字段）。
- ui（`tests/session-view.test.ts`）：红 = 5 failed / 9 passed；绿 = 14 passed。

**验证退出码（真实执行，不接管道）**

- `pnpm test`（根全量单测）：**0** —— agent-core 42 files / 333 tests、desktop 13 files / 66 tests、ui 9 files / 64 tests 全部 passed。
- `pnpm typecheck`（根，含 agent-core build + 三包 tsc）：**0**。
- `pnpm build`（全仓）：**0**。
- E2E 新场景 `test:e2e:thinking`：**0** —— 五档 body 契约（auto 无控制字段、low/medium/high = thinking.enabled + reasoning_effort、off = disabled 且无 reasoning_effort）、reasoning 折叠展示与正文隔离 + 展开/收起、运行中切档（本轮工具回填轮保持 medium 快照、下一条消息采用 off）。
- E2E smoke 基线 `test:e2e`：**0**。

**范围说明**

- 子代理档位继承与 SubagentCard 思考展示未动（03 票）；compact/commit 草稿不附加档位参数；无持久化/schema/`/thinking` 命令改动。
- E2E 尾部日志的 `database is not open` 为应用关闭后事件流 finally 收尾的既有噪音（断言全部通过后出现），非本票引入。

### 2026-11-11 · 关闭（终验）

集成分支 `feat/thinking-effort` 终态 `9b42536`。最终回归（集成 worktree）：`pnpm build` / `pnpm test` / `pnpm typecheck` / `pnpm test:e2e:all` 退出码全 0（含本票新增 thinking E2E 场景）。两轴 code-review 无硬违规、spec 逐项无相悖；review 后续修复（`9b42536`）涉及本票的是 IPC 枚举校验改用 `@codexlike/agent-core/node` 的 `parseThinkingEffort` 统一入口（错误文案随之为「无效的思考档位：<值>」，行为等价、无测试断言旧文案）。AC 全部勾选，Status → done。
