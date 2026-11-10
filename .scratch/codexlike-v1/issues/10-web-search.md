# 10: web_search 工具（Tavily）

**What to build:** agent 获得 `web_search` 工具：模型发起查询 → 搜索服务（默认 Tavily）返回结果（标题/URL/片段）→ 作为工具输出回填模型；消息流中显示搜索结果卡片。搜索源抽象为接口（查询→结果列表），Tavily 为默认实现，设置页配置搜索源 API key。未配置 key 或调用失败时工具返回明确中文错误，会话不崩。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`（用户需自备 Tavily key）。

**Blocked by:** 03 (六件核心工具 + 工具卡片)

**Status:** ready-for-agent

- [ ] 设置页可配置搜索 key；未配置时工具报「未配置搜索源」
- [ ] `web_search` 结果（标题/URL/片段）正确回填模型上下文
- [ ] 搜索结果卡片渲染（可展开）
- [ ] 搜索源为接口抽象，Tavily 实现可被替换（注入式）
- [ ] mock HTTP 测试：正常、空结果、超时、错误四种路径
