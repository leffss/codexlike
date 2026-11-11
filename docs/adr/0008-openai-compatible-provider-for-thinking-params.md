# 模型 provider 由 @ai-sdk/openai 迁移至 @ai-sdk/openai-compatible

为支持思考档位（Thinking Effort，见 GLOSSARY.md）——向 OpenAI 兼容端点透传 GLM 的 `thinking` 参数、并流式消费 `reasoning_content` 思考内容——`language-model.ts` 的模型工厂从 `@ai-sdk/openai` 的 `provider.chat` 换为 `@ai-sdk/openai-compatible`。决定原因：`@ai-sdk/openai@4.x` 的 chat 路径对 `providerOptions.openai` 未知键做 zod strip（`thinking` 静默进不了请求 body），chunk schema 也不含 `reasoning_content`（思考内容在解析层即被丢弃）；而 openai-compatible 原生解析 `reasoning_content` 并把未知 `providerOptions` 键原样透传进 body，正是本仓库「统一走 chat completions 兼容协议（GLM/DeepSeek/Ollama）」这一既定意图的正统实现。

## Considered Options

- **留在 `@ai-sdk/openai` + 自定义 fetch wrapper**（改写请求 body 注入 `thinking`、改写 SSE 流搬运 `reasoning_content`）：改动局部，但需自维护流改写逻辑，SDK 升级易碎，长期负债，弃。
- 注意：`reasoningEffort`（camelCase）在两个包中均可用；仅 `thinking`（`off` 档）与 `reasoning_content` 消费依赖本次迁移。

## Consequences

- 全局 provider 库更换影响所有请求路径，落地时须全量回归（单测 + E2E）。
- ~~openai-compatible 下 `reasoningEffort` 到 body 的映射形态（camelCase 透传 vs 映射为 `reasoning_effort`）以实现时实际请求抓包为准。~~ 实施查证（票 01，`@ai-sdk/openai-compatible@3.0.87`）：SDK 的 `reasoningEffort` 映射为 body 的 snake_case `reasoning_effort`，非 camelCase 透传；本实现不经该顶层选项，而是由统一工厂在自有 providerOptions 命名空间下同时透传 `thinking` 与 snake_case `reasoning_effort`，最终 body 与 spec 契约一致。
- 实施查证补充：compatible 的消息转换会把 assistant 消息中的 reasoning part 序列化回 `reasoning_content`（即 `response.messages` 回填工具轮次时思考会自动进入请求历史）。工厂已在 SDK `transformParams` 边界统一剥离 assistant reasoning part，正文与 tool-call 配对原样往返，思考保持仅运行期展示。
