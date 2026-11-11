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
