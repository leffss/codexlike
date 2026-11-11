# 01: 迁移兼容 provider，守住现有行为

**What to build:** 按 ADR 0006 将统一模型工厂迁移至 `@ai-sdk/openai-compatible`，让既有主会话、子代理、compact 和 commit 草稿继续可用，并提供经过真实请求与响应测试的思考参数/流解析接入能力。本票是必要的前置改造，不新增思考 UI。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Parent

[思考档位 spec](../spec.md) 是完整契约；实施前阅读其中的接入契约和测试边界。迁移理由见 [ADR 0006](../../../docs/adr/0006-openai-compatible-provider-for-thinking-params.md)。

## Acceptance criteria

- [ ] 统一工厂使用兼容 provider，保留 chat completions 协议；Provider Profile 的 baseURL、鉴权、模型标识与可注入 fetch 行为保持可用。
- [ ] 根据当前 SDK 及锁文件选择兼容依赖，更新依赖声明和锁文件；不从历史调研报告直接推断安装版本。
- [ ] 在模型工厂公开入口通过 fetch spy 或本地 HTTP 服务验证最终请求 body：`auto` 不带控制字段；低/中/高分别带 `thinking.type = enabled` 和相应 snake_case `reasoning_effort`；关只带 `thinking.type = disabled`。不得以内部 providerOptions 的对象断言代替此验证。
- [ ] 受控 reasoning SSE 能转为独立 reasoning 流片段，普通正文仍按原有语义输出；覆盖同一流包含思考、正文和工具调用的场景。
- [ ] 工具调用参数、工具结果往返、非流式文本生成、错误及中断保持可用；不自行增加 fetch/SSE 改写补丁。
- [ ] 默认既有调用方不附加思考控制参数；compact 和 commit 草稿保持该默认行为。
- [ ] 明确检查兼容 provider 的消息转换行为，保证后续展示用 reasoning 不会被无意加入请求历史；如服务端必须接收思考回传，记录限制，不主动启用 Preserved Thinking。
- [ ] 执行全量单测与项目全套 E2E，直接记录退出码和结果；检查既有文本、工具、子代理、审批及取消行为。环境阻塞或失败如实记录，不用历史测试数量代替本次结果。

## Testing notes

复用现有 provider 请求 spy、受控 SSE 与 desktop mock provider，验证网络边界和用户可见行为。此票只将档位映射能力在接入边界验证完成；由 02 负责把用户选择真正接入主会话。真实服务端支持范围不由 mock 测试担保。

## Comments

### 2026-11-11 · 票 01 实施验收证据

- 统一工厂 `createLanguageModelFromProfile` 迁移至 `@ai-sdk/openai-compatible@3.0.87`（精确 pin；`^3.0.90` 触发 pnpm minimumReleaseAge 供应链策略，3.0.87 复用既有 `@ai-sdk/provider-utils@5.0.76`，无需 workspace 排除条目），`chatModel` 走 chat completions；baseURL、`Authorization: Bearer`、模型标识、可注入 fetch 由既有测试 + 新增断言回归。
- 五档实际 HTTP body（fetch spy 断言序列化 JSON，非内部对象）：`auto` 无 `thinking`/`reasoning_effort`；低/中/高 = `thinking.type=enabled` + snake_case `reasoning_effort`；关 = 仅 `thinking.type=disabled`。
- 受控 reasoning SSE：`reasoning_content` → 独立 reasoning-delta 流（与 text-delta、分片工具参数并存）；reasoning-only 流可随 AbortSignal 中断；400 拒绝原样抛出不降档不重试。
- `response.messages` 回传风险已查证并阻断：compatible 会把 assistant reasoning part 序列化回 `reasoning_content`，工厂在 `transformParams` 边界剥离，工具往返 body 不含思考、正文与 tool-call 配对不变；未启用 Preserved Thinking。
- compact 与 commit 草稿走同一工厂默认不附加控制字段（真实 HTTP body 断言）。
- TDD 红→绿记录：旧 provider 丢 `reasoning_content`（红）→ 迁移（绿）；五档 body（红）→ providerOptions 透传（绿）；回传含 `reasoning_content`（红）→ 边界剥离（绿）；未知档位（红）→ 枚举拒绝（绿）。
- 验证退出码：`pnpm test`=0（agent-core 322 / desktop 66 / ui 58），`pnpm typecheck`=0，`pnpm test:e2e:all`=0（12 场景全绿，含文本、工具、审批、中断、compact、worktree、MCP、子代理、项目侧栏），`pnpm check:adr`=0。
- 兼容限制：真实远端对各档位的支持不由 mock 担保；GLM `thinking` 协议要求思考回传的场景未启用（本仓库明确剥离），若服务端强制要求将按 spec 报告为兼容性限制。
