# 10: web_search 工具（Tavily）

**What to build:** agent 获得 `web_search` 工具：模型发起查询 → 搜索服务（默认 Tavily）返回结果（标题/URL/片段）→ 作为工具输出回填模型；消息流中显示搜索结果卡片。搜索源抽象为接口（查询→结果列表），Tavily 为默认实现，设置页配置搜索源 API key。未配置 key 或调用失败时工具返回明确中文错误，会话不崩。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`（用户需自备 Tavily key）。

**Blocked by:** 03 (六件核心工具 + 工具卡片)

**Status:** done

- [x] 设置页可配置搜索 key；未配置时工具报「未配置搜索源」
- [x] `web_search` 结果（标题/URL/片段）正确回填模型上下文
- [x] 搜索结果卡片渲染（可展开）
- [x] 搜索源为接口抽象，Tavily 实现可被替换（注入式）
- [x] mock HTTP 测试：正常、空结果、超时、错误四种路径

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/10-web-search`，基线 26e6d5c）

1. **设置页可配置搜索 key；未配置时工具报「未配置搜索源」** ✅ 设置页新增「搜索源」区（Tavily 徽标 + 已配置/未配置状态 + key 编辑/保存/清除 + 中文结果提示）；key 经 safeStorage 加密落盘 `~/.codexlike/search-settings.json`（沿用 01 模式，desktop 单测断言磁盘无明文、safeStorage 不可用时拒绝保存）。`searchSource()` 返回 null 时工具输出 `未配置搜索源：请在设置页填写搜索服务（Tavily）的 API key`（isError，中文指引）；agent-session 测试覆盖该错误回填模型后会话继续不崩。smoke E2E 端到端：设置页填 key → 状态变「已配置」→ 落盘文件不含明文。
2. **结果正确回填模型上下文** ✅ 工具输出格式 `N. 标题\n   URL\n   摘要`（空行分隔）；`tests/session/agent-session-tools.test.ts` 两例：mock 模型发起 `web_search` → 注入的搜索源被真实调用 → 标题/URL/摘要三要素进入第二次 doStream prompt；未配置路径错误中文回填后会话继续到最终回复。
3. **搜索结果卡片渲染（可展开）** ✅ 复用 03 的 `ToolCallCard`：折叠态摘要 `搜「query」`（tool-summary 新增 case，ui 单测），展开见完整输出；smoke E2E 断言 `data-tool-name=web_search` 卡片展开输出含三要素，重启恢复后卡片仍在。
4. **搜索源接口抽象，注入式** ✅ `SearchSource { search(query, options?) → {title,url,snippet}[] }` 接口 + `createWebSearchTool({ searchSource: () => SearchSource | null })`（逐次解析，改 key 免重启生效）+ `createTavilySearchSource` 默认实现（POST `https://api.tavily.com/search`，api_key + query 进 JSON 体，`baseUrl`/`fetch`/`timeoutMs` 均可注入）。全部测试经 fake fetch / fake source 注入，零真实网络。
5. **mock HTTP 四路径** ✅ `tests/tools/web-search.test.ts` 12 例：正常（结果映射 + 请求体 `api_key`/`query` 断言）、空结果（`results: []` → 空列表；工具层输出「未搜到「X」，请尝试更换关键词」）、超时（hanging fetch 尊重 abort signal，20ms 窗口 → 中文超时错误）、错误（HTTP 432 → `Tavily API 返回错误（HTTP 432）`；网络拒绝 → `搜索请求发送失败`；另有非法 JSON、缺 results 字段、baseUrl 覆盖）。工具层再加：未配置、格式化输出、失败包装、maxResults 透传封顶 10/非法回退、builtin 聚合注册 5 例。

### 关键实现事实（后续工单建立在这些接口上）

- **agent-core `./node` 出口新增**：`createWebSearchTool` / `createTavilySearchSource` + 类型 `SearchSource` / `SearchResult` / `SearchOptions` / `TavilySearchSourceOptions` / `WebSearchToolOptions`。`BuiltinToolsOptions.webSearch?: WebSearchToolOptions`（传入即在工具表追加 `web_search`，permission 为 `readonly`）。
- **Tavily 请求形态**：POST JSON `{ api_key, query, max_results }`（api_key 在请求体，工单原文约定）；超时 15s 可调；结果取 `results[].{title,url,content}` 映射 snippet。`baseUrl` 可覆盖（E2E/自建代理）。
- **desktop**：`createSearchSettingsStore({ dir, safeStorage })`（get/set，空串清除=删文件）；IPC `search-settings:get/set`；main.ts 内存缓存 `searchSource` 逐次解析——设置页保存/清除后**无需重启**即对进行中的会话生效。
- **E2E 钩子**：`CODEXLIKE_TAVILY_URL` 环境变量覆盖 Tavily 端点（与 `CODEXLIKE_TEST_WORKSPACE` 同款模式），smoke 的 mock server 提供 `/search` 端点并记录请求体断言 `api_key + query` 真实到达。

### 踩坑记录（对后续工单有用）

- **设置页多区后按钮选择器歧义**：smoke/commands E2E 的 `getByRole('button', { name: /保存|创建/ })` 在新增搜索源区（也有「保存」）后 strict mode 命中 2 元素直接失败；且无名 `<form>` 没有 `form` role，需用 `window.locator('form').getByRole(...)` 限定。后续工单再往设置页加区（MCP、shell 偏好）时，跨区选择器一律先限定容器。
- **E2E 断言卡片文本不要用 `getByText` 部分匹配**：query 关键词同时出现在折叠摘要、参数 JSON、输出 pre 三处；断言展开内容用 `card.getByTestId('tool-call-output')` 的 textContent 包含判断。
- **Tavily key 明文判断要看 JSON 值而非原始串**：fake safeStorage 的 `enc:` 前缀经 base64 再编码后文件里不含字面量 `enc:`；无明文断言用 `not.toContain('<原 key>')` 即可。
- **`cmd | tail` 管道吞退出码**（已有坑重申）：`pnpm typecheck 2>&1 | tail` 失败时链条继续走，需 `${PIPESTATUS[0]}` 取真实退出码——本次 desktop typecheck 因 agent-core dist 未重建报旧类型错误，被管道掩盖了一轮。

### 测试与验证

- `pnpm typecheck` 三包全过；`pnpm test`：agent-core 157 + desktop 22 + ui 28 = 207 用例全绿（本工单新增 21：agent-core web-search 12 + 会话链路 2、desktop 存储层 5、ui 摘要断言 1、E2E 内含新断言）。
- `pnpm test:e2e`（smoke，含 web_search 全链路）与 `test:e2e:commands` 回归均通过。
