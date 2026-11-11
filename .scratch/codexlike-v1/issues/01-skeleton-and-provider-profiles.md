# 01: 项目骨架 + Provider Profile 设置

**What to build:** 从零建立 pnpm monorepo（`agent-core` 纯 TS 包、`desktop` Electron 主进程包、`ui` React 渲染包），`pnpm dev` 一条命令启动 Electron 应用：中文界面、空三栏布局（会话列表/消息流/输入框）与设置页。设置页可创建/编辑/删除多个 Provider Profile（名称、`baseURL`、`apiKey`、`model`），`apiKey` 经 Electron `safeStorage` 加密后落盘（磁盘上无明文），重启应用配置完整恢复。`agent-core` 提供 Provider Profile 类型与 OpenAI 兼容 provider 构造（Vercel AI SDK），有基于 `MockLanguageModel` 的单测。tsc strict + vitest 构成 CI 检查。

遵循 `GLOSSARY.md` 术语与 `docs/adr/0001`、`docs/adr/0002`。完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `pnpm install && pnpm dev` 启动应用，显示中文三栏布局与设置页
- [x] 设置页可增删改查多个 Provider Profile，表单校验（URL 合法、model 非空）
- [x] `apiKey` 加密落盘：数据文件中检索不到明文 key
- [x] 重启应用后全部 Profile 完整恢复
- [x] `agent-core` 的 provider 构造单测通过（OpenAI 兼容 `baseURL` 透传）
- [x] tsc strict 与 vitest 全绿；`agent-core` 无任何 Electron 依赖（ADR-0002）

## Comments

### 脚手架选型（实现者调研决定）

**手搭 Vite + esbuild + Electron，不用 electron-vite 模板。** 理由：electron-vite 模板是单包结构（main/preload/renderer 挤在一个包里），与本工单的三包 monorepo 边界（`agent-core` / `desktop` / `ui`，ADR-0002）直接冲突，套用模板反而要先拆包；手搭成本很低——`desktop` 用 esbuild 两个入口（main/preload → `dist/*.cjs`，external electron），`ui` 是标准 Vite + React + Tailwind 4，`agent-core` 用 tsc 构建带 d.ts 的稳定出口。换来的是包边界与依赖方向完全受控（`ui` 对 `desktop` 仅 type-only import）。

### AC 逐条核对（2026-11-10，分支 `feature/01-skeleton`）

1. **`pnpm install && pnpm dev` 启动应用** ✅ 实测：vite dev server 就绪（5173）、esbuild 打包、Electron 主进程启动（日志 `[main] CodexLike 已启动，数据目录：C:\Users\leffss\.codexlike`），窗口加载渲染页；中文三栏布局（会话列表/消息流/输入框）与设置页（Provider Profiles）均有实现。
2. **设置页增删改查 + 校验** ✅ `SettingsPage` 列表 + 编辑表单（新建/编辑共用），删除带确认；校验复用 `agent-core` 的 `validateProviderProfile`（baseURL 合法 http(s) URL、name/model 非空，错误中文提示），主进程 IPC 边界再做一遍校验（不信任渲染层输入）。校验规则有 4 个单测。
3. **apiKey 加密落盘无明文** ✅ 三层验证：(a) 单测（注入 fake safeStorage）读数据文件断言不含明文 key；(b) 真实 Electron + Windows DPAPI 端到端脚本（`packages/desktop/scripts/verify-safestorage.mjs`）输出 `noPlaintext: true`；(c) 落盘形态只有 `encryptedApiKey`（base64）。safeStorage 不可用时 create/update 直接拒绝写盘（无明文降级路径），对应单测。
4. **重启后完整恢复** ✅ 单测「同目录重建 store 等价重启 → list() 完整恢复（含 apiKey 解密）」+ 真实 Electron 端到端 `restoredOk: true`。
5. **provider 构造单测（baseURL 透传）** ✅ `createLanguageModelFromProfile` 3 个用例：请求发往 `<baseURL>/chat/completions`、`Authorization: Bearer <apiKey>` 头、`generateText` 文本往返。统一走 chat completions（而非 Responses API）——OpenAI 兼容生态（GLM/DeepSeek/Ollama）的最大公约数。
6. **tsc strict + vitest 全绿；agent-core 零 Electron 依赖** ✅ 三包 `tsc --noEmit` strict 全过；vitest 12 个用例全绿（agent-core 8 + desktop 4）；agent-core 的 dependencies 仅 `ai` + `@ai-sdk/openai`，源码与依赖图无任何 electron 引用（ADR-0002）。

### 关键实现事实（后续 13 张工单建立在这些接口上）

- **稳定公共接口**：`@codexlike/agent-core` 出口 `ProviderProfile` / `ProviderProfileInput` / `ProviderProfileErrors` / `validateProviderProfile` / `createLanguageModelFromProfile(profile, { fetch? })`。
- **IPC 契约**：`@codexlike/desktop/ipc` 导出 `IPC` channel 常量与 `CodexLikeApi`；preload 暴露 `window.codexlike.providerProfiles.{list,create,update,remove}`；ui 侧 `global.d.ts` 声明。
- **存储**：`~/.codexlike/provider-profiles.json`，`createProfileStore({ dir, safeStorage })` 注入式（SafeStorageLike 为 async 接口）。

### 踩坑记录（对后续工单有用）

- **ai@7 的 mock 导出版本化**：`ai/test` 不再导出 `MockLanguageModel`，需按模型 spec 版本选 `MockLanguageModelV4`；其 `doGenerate` 返回 `content` 数组 + `finishReason: { unified, raw }` + 嵌套 `usage`（`inputTokens: { total, noCache, ... }`）。`tests/provider/mock-model.test.ts` 是最小样板。
- **Electron 45 safeStorage**：同步 API（`isEncryptionAvailable` 等）已弃用，直接用 async 版（`isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`，最后一个返回 `{ result, shouldReEncrypt }`）。
- **pnpm 12 构建脚本许可**：postinstall 需在 `pnpm-workspace.yaml` 的 `allowBuilds` 放行（不是 package.json 的 `pnpm` 字段，也不是旧键名 `onlyBuiltDependencies`）；electron 二进制若因中途放行未下载，需 `node node_modules/.pnpm/electron@*/node_modules/electron/install.js`（带 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）补装。
- **版本选择**：TypeScript 用 ^5.9（npm 最新 7.0 是 Go 移植版，生态兼容未验证）；vite ^7 + @vitejs/plugin-react ^5 + vitest ^5 组合。
