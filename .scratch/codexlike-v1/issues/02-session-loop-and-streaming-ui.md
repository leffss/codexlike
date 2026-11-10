# 02: 会话循环 + 流式消息 UI

**What to build:** 用户点「新会话」选择工作区目录，在输入框发消息，模型经所选 Provider Profile 流式回复，消息流实时增量渲染 markdown；会话与消息写入 SQLite（`~/.codexlike/`），侧栏会话列表显示全部会话，重启后列表仍在；输入区带模型（Provider Profile）选择器。`agent-core` 的会话对象（创建、发消息、流式事件、完成/出错状态）不依赖 Electron，主进程经类型化 IPC 把事件流桥接到渲染进程。含一条 Playwright `_electron` E2E 冒烟：启动 → 建会话 → 消息往返。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 01 (项目骨架 + Provider Profile 设置)

**Status:** done

- [x] 新建会话可选择工作区目录（原生目录选择器）
- [x] 发送消息后 token 增量流式渲染为 markdown（含代码块高亮）
- [x] 会话、消息落 SQLite；重启应用侧栏显示既有会话列表
- [x] 模型选择器切换 Provider Profile，对下一条消息生效
- [x] 模型 API 出错时消息流显示中文错误提示，会话可继续使用
- [x] `agent-core` 测试（`MockLanguageModel`）：单轮问答、多轮上下文保持、流式中断与错误路径
- [x] E2E 冒烟通过（预置 Profile → 建会话 → 往返一轮）

## Comments

### AC 逐条核对（2026-11-10，分支 `feature/02-session-loop`）

1. **新建会话选工作区目录** ✅ 输入区侧栏「+ 新建会话」→ `sessions:select-workspace` IPC → 主进程 `dialog.showOpenDialog`（原生目录选择器，取消返回 null）→ `sessions:create` 校验目录真实存在后绑定。E2E 实测（`CODEXLIKE_TEST_WORKSPACE` 钩子固定目录，因 Playwright 无法操作原生对话框）。
2. **token 增量流式渲染 markdown + 代码块高亮** ✅ ai SDK `streamText` fullStream 的 text-delta → agent-core `SessionEvent` → IPC `session:events`（按会话 ID 多路复用）→ ui `applySessionEvent` 纯函数归并 → `react-markdown` + `remark-gfm` + `rehype-highlight`（`code.hljs`）。E2E 断言代码块高亮元素与流式文本可见。
3. **SQLite 落库 + 重启恢复** ✅ `~/.codexlike/codexlike.db`（sessions / messages 两表，单语句即单事务）；应用启动读全部会话渲染侧栏，残留 `streaming` 状态统一重置 idle。E2E 第二次启动断言侧栏列表与消息历史完整恢复。
4. **模型选择器对下一条生效** ✅ 输入区 Provider Profile 下拉（名称 · 模型）；每次发送携带当前 `profileId`，主进程解析为完整 Profile（apiKey 解密）→ 会话记录持久化 `providerProfileId`/`model`（agent-core 测试覆盖）。
5. **API 出错中文提示 + 会话可继续** ✅ 模型错误（含 `APICallError` HTTP 状态、`RetryError`）转为 `模型请求失败（HTTP xxx）：<原文>` 落库为 `error` 角色消息并广播；error 不进入对话上下文。agent-core 测试：出错后下一轮正常完成、上下文无 error 痕迹。
6. **agent-core 测试四路径** ✅ vitest 13 个会话用例：单轮问答（事件序列 user-message → assistant-start → delta×2 → assistant-done + 落库断言）、多轮上下文（第二次 doStream 的 prompt 含第一轮往返；含「同库重开等价重启续聊」）、流式中断（首个 delta 后 abort → 部分文本保留为 assistant 消息、继续可发）、错误路径（error 事件 + 中文提示 + 继续可用）、并发发送拒绝。
7. **E2E 冒烟** ✅ `pnpm test:e2e`（root，先全仓 build 再跑）：本地 OpenAI 兼容 mock SSE server → 真实 Electron 设置页创建 Profile（真实 safeStorage 加密）→ 建会话 → 消息往返（流式 + 高亮）→ 重启恢复。实测通过。

### 关键实现事实（后续工单建立在这些接口上）

- **agent-core 双出口**：`.` 浏览器安全（类型 + `validateProviderProfile` + `createLanguageModelFromProfile`，ui 值导入不拉 Node 模块）；`./node` 含 `createAgentSession` / `createSessionManager` / `createSqliteSessionStore`（依赖 node:sqlite 等）。**后续 Node 专属功能一律加进 `./node`**，否则 ui 的 vite build 会炸。
- **会话事件**：`SessionEvent = user-message | assistant-start | assistant-delta | assistant-done | assistant-aborted | error`（全部可 JSON 序列化，`error` 消息带中文提示）；工具调用、审批事件后续在此联合类型上扩展。
- **SessionManager**：`create`（落库返回 AgentSession）/ `list`（updatedAt 倒序）/ `messages` / `get`（惰性恢复 + streaming 残留重置 + 实例缓存）。AgentSession 有 `record` 快照（IPC 返回用快照，会话对象本身不可结构化克隆）。
- **持久化表**：sessions（id/title/workspace_path/provider_profile_id/model/status/created_at/updated_at）+ messages（id/session_id/role/content/created_at，role 含 `error`）；工具调用、审批决定、compact 表后续在此 schema 上追加。

### 偏离说明：SQLite 驱动用 `node:sqlite` 而非工单原文的 better-sqlite3

better-sqlite3 是 native 模块，pnpm workspace 单副本无法同时满足系统 Node（vitest）与 Electron 两套 ABI——rebuild 一侧必坏另一侧。`node:sqlite`（`DatabaseSync`）为 Node 22.13+/Electron 45（Node 24.22）内置，零原生编译、双运行时一致；已实测 Electron 45 主进程可用。spec 的实质要求（SQLite、`~/.codexlike/`、事务写入、接口注入可换内存库）全部满足。

### 踩坑记录（对后续工单有用）

- **ai@7 流式 mock 必须带 text-start/text-end part**：`doStream` 只发 text-delta 会报 `text part text-1 not found`；每个文本块要用 `text-start`（带 id）→ `text-delta`（`delta` 字段，注意 provider 层字段名是 `delta`，SDK fullStream 层是 `text`）→ `text-end` 包裹。`MockLanguageModelV4.doStreamCalls` 可直接断言多轮上下文。
- **Electron IPC 返回值必须可结构化克隆**：`ipcMain.handle` 返回含闭包/生成器的对象报 `An object could not be cloned`；会话对象只回 `record` 快照。
- **agent-core 出口引入 Node 内置模块会连坐 ui 的 vite build**：值导出（哪怕 ui 只用别的函数）会把整个入口模块图拉进浏览器 bundle（rollup 对 `node:sqlite` external 化后命名导入不存在直接失败）。解法是双出口（见上）。
- **node:sqlite 的 `StatementSync.all()` 返回 `Record<string, SQLOutputValue>[]`**，行类型断言需经 `as unknown as`；Windows 上库文件句柄不 close 会锁文件（`rmSync` EPERM），接口含 `close()`，主进程 `will-quit` 调用。
- **Playwright `_electron` + pnpm**：`playwright-core` 自解析 electron 不可靠，`electron.launch({ executablePath: require('electron'), ... })` 显式指定；原生 `dialog.showOpenDialog` 无法自动化，用 `CODEXLIKE_TEST_WORKSPACE` 环境变量钩子固定返回目录（`CODEXLIKE_HOME` 同理隔离数据目录）。
- **vite 生产构建要 `base: './'`**：Electron 以 `file://` 加载 ui/dist 时默认 `/` 资源路径全 404。
