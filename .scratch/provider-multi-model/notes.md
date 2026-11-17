# notes: Provider Profile 多模型 + maxRetries 透出

探索事实沉淀（2026-11-17 采访轮），供各实现票以指针复用。定位写符号名配验证性 grep 提示，不写行号——行号随各票合入漂移。

## 现状布局（改动面地图）

### agent-core（packages/agent-core）

- **Provider 类型与校验**：`ProviderProfile` / `ProviderProfileInput` / `ProviderProfileErrors` / `validateProviderProfile` 全在 `src/provider/provider-profile.ts`。grep：`validateProviderProfile`。`model` 为单个自由文本，校验仅非空。
- **模型工厂**：`createLanguageModelFromProfile`（`src/provider/language-model.ts`），`@ai-sdk/openai-compatible` 的 `createOpenAICompatible` 构造 + `wrapLanguageModel` 注入 thinking 参数中间件（ADR 0008）。`ThinkingEffort` / `parseThinkingEffort` 同文件。grep：`createLanguageModelFromProfile`。
- **对话循环**：`src/task/agent-task.ts` 内 `streamText`（对话）与 `generateText`（compact）两处模型调用；`modelFor` 可经 `options.languageModelFor` 注入（测试 seam）。grep：`languageModelFor`。
- **错误映射**：`describeModelError`（`src/task/errors.ts`）把 SDK `APICallError` / `RetryError` 翻成中文，含「已重试 N 次」固定文案。grep：`describeModelError`。
- **task 类型与持久化**：task 记录带 `providerProfileId`（`src/task/types.ts`），SQLite 列与读写见 `src/task/persistence.ts`（grep：`providerProfileId` 可同时定位列定义、roundtrip 与恢复路径）。
- **重试现状**：仓库零自管重试；`streamText`/`generateText` 均未传 `maxRetries`，全靠 Vercel AI SDK 默认（2 次、指数退避）。测试里显式关重试用 `maxRetries: 0`（`tests/provider/language-model.test.ts` 有先例）。

### desktop（packages/desktop）

- **profile 存储**：`createProfileStore({ dir, safeStorage })`（`src/profiles/profile-store.ts`），JSON 落 `~/.codexlike/provider-profiles.json`，`apiKey` 经 Electron `safeStorage` 加密为 `encryptedApiKey`（base64），损坏文件回退空列表。grep：`createProfileStore`。
- **IPC 面**：channels 与 API 声明在 `src/shared/ipc.ts`（grep：`providerProfile`），preload 暴露、`main.ts` 里 `registerProviderProfileHandlers` 注册（grep 同名）。task 侧 profile 解析在 `src/tasks/task-ipc.ts`（grep：`providerProfileId`）。
- **子代理设置**：`createSubagentSettingsStore`（`src/subagents/subagent-settings-store.ts`），`providerProfileId: string | null`（null = 同主模型）。grep：`subagentSettings`。
- **执行设置先例（maxRetries 注入范式）**：ADR 0017 六参数的 resolver 范式——设置存主进程 JSON（agent-settings），agent-core 经 options 收逐次解析的取值函数，不依赖存储实现（ADR 0002 边界）。grep：`agentSettings` / `executionSettings` 找 store 与 resolver 装配点。

### ui（packages/ui）

- **Profile 表单**：`ProviderProfileForm`（名称/baseURL/API Key/模型/上下文窗口五字段）。grep：`ProviderProfileForm`。
- **设置页**：`SettingsPage` 六分区（Provider/外观/终端/子代理/搜索/MCP）；子代理模型选择分区在文件后半；执行分区（ADR 0017）。grep：`SettingsPage`。
- **模型选择器**：`MessageComposer` 内下拉 `testId="profile-select"`，选项 label `${profile.name} · ${profile.model}`，含「未配置模型」「已保存的模型不可用」兜底态；共用组件 `ComposerSelect`。grep：`profile-select`。
- **preferences**：`WorkspacePage` 存 workspace preferences 里的 profile 选择。grep：`providerProfileId`（ui 侧命中）。

## repo 约定（实现票必读）

- desktop/ui 测试加载 agent-core 的 dist 产物——agent-core 改动后跑测试会前置 build（两包 `test` script 已前置）；改 e2e 交互面（表单/选择器/设置页结构）后合入前实跑相关 e2e 场景。
- 检查命令直接跑取退出码，不接 `| tail` 类管道。
- 测试基线（2026-11-17）：agent-core 493 / desktop 323 / ui 418；e2e 全量 40 场景。
- e2e 相关既有场景：settings（表单/分区）、interactions（选择器类交互）、width-tiers（composer 工具栏布局，选择器 min-w-0 shrink 惯例在这轮加过，别回退）。
- 已知 UI 惯例：模型选择器有 `min-w-0` shrink 降级（65ad205），改选择器结构时保持。

## 决策文档指针

- ADR 0024（本 feature 主体决策）：`docs/adr/0024-provider-profile-multi-model.md`
- ADR 0017（执行设置 resolver 范式与「即时保存、回合开始快照」语义，maxRetries 沿用）
- ADR 0008（openai-compatible + thinking 透传，已知限制的来源）
- GLOSSARY：Provider Profile / 执行设置 / 子代理 三词条已随采访更新
