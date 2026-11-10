# Spec: CodexLike v1.0

Status: ready-for-agent
Feature: codexlike-v1
Created: 2026-11-10
Sources: grilling 会话（四轮面试，全部决策经用户确认）；Codex Desktop 功能调研报告（OpenAI 官方文档，2026-11）

## Problem Statement

我想在本地用 AI agent 完成真实的编码任务（修 bug、写功能、跑测试），但现有选择都有 friction：云端 agent（Codex Cloud 等）不碰我的本地文件；终端 agent（Codex CLI）没有图形化的审批与 diff 检视体验；而且大多绑定单一模型厂商。我需要一个自己可控的桌面工作台：接任意 OpenAI 兼容端点（如 GLM）、在本机工作区真实干活、有清晰的权限审批与结果检视——即「Codex Desktop 的功能完整平替」。

## Solution

**CodexLike**：Electron 桌面应用（Windows 优先，中文界面）。用户创建绑定工作区的会话，agent 在其中读文件、打补丁、跑命令、搜网络；协作模式下终端命令经审批卡片放行；改动通过 Monaco diff 审阅并一键 commit；支持多会话并行（含 worktree 隔离）、会话持久化恢复、子代理委派、MCP 扩展。所有 LLM 接入走 OpenAI 兼容协议的 Provider Profile。

## User Stories

### 配置与接入

1. As a user, I want to 创建/编辑/删除多个 Provider Profile（`baseURL`/`apiKey`/`model`）并在设置页管理切换, so that 我可以随时在不同模型供应商（GLM、DeepSeek、OpenAI、Ollama…）之间切换
2. As a user, I want API key 经系统加密存储, so that 凭据不以明文落在磁盘上
3. As a user, I want 在会话中用 `/model` 或选择器快速切换模型, so that 复杂任务用强模型、简单任务用便宜模型
4. As a user, I want 在设置页填入搜索服务（默认 Tavily）的 API key, so that `web_search` 工具开箱可用

### 会话与任务执行

5. As a user, I want 创建会话时选择一个工作区目录, so that agent 的所有文件与终端操作都发生在正确的项目里
6. As a user, I want agent 能 `read_file`、`write_file`、`apply_patch`、`glob`、`grep`、`run_terminal_command`, so that 它能自主完成编码任务
7. As a user, I want 消息流中每个工具调用显示为可展开卡片（命令、输出、diff、搜索结果）, so that 我始终知道 agent 在干什么
8. As a user, I want 随时打断正在运行的 agent, so that 它跑偏时我能立即止损
9. As a user, I want 同时开多个会话且并行运行, so that 多个任务互不等待
10. As a user, I want 侧栏会话列表显示每个会话的运行状态（运行中/等待审批/空闲）, so that 我一眼掌握全局
11. As a user, I want 关闭应用后重开会话完整恢复（消息、工具调用、审批记忆）, so that 工作不因重启丢失

### 审批与安全

12. As a user, I want 会话有 `readonly` / `suggest` / `full` 三档审批模式且可随时切换, so that 我按信任程度放权
13. As a user, I want `suggest` 模式下每条终端命令弹出审批卡片（批准 / 拒绝 / 本会话总是允许）, so that 危险命令必须过我的手
14. As a user, I want `readonly` 模式下一切写入与命令被真实拦截并告知 agent, so that 我放心让 agent 做纯调研
15. As a user, I want agent 的文件操作被限制在工作区内, so that 工作区外的文件不被误伤

### 结果检视与 git

16. As a user, I want 改动面板列出本会话涉及的改动文件并用 Monaco 查看 diff, so that 我能审阅 agent 的工作成果
17. As a user, I want 一键创建分支 / commit 会话改动, so that agent 的工作干净地落进 git 历史

### 上下文管理

18. As a user, I want 全局与项目的 AGENTS.md 自动注入会话系统提示, so that agent 遵守我的个人与项目规范
19. As a user, I want 用 `/compact` 手动压缩长会话, so that 深度任务不会撑爆上下文窗口
20. As a user, I want 用 `/status` 查看当前上下文用量, so that 我知道何时该压缩
21. As a user, I want 在输入框用 `@` 引用工作区文件把内容附加到消息, so that 精准给 agent 喂材料

### worktree 并行

22. As a user, I want 会话可选 worktree 模式在托管 Worktree 隔离副本上运行, so that 同一仓库多个会话并行改动互不冲突
23. As a user, I want 项目里放 `.worktreeinclude` 声明需复制的被 ignore 文件（如 `.env`）, so that 隔离副本里项目能跑起来
24. As a user, I want 旧 worktree 自动清理、只保留最近 15 个（使用中的除外）, so that 磁盘不被占满

### 扩展能力

25. As a user, I want agent 用 `web_search` 查最新资料, so that 它的知识不过期
26. As a user, I want agent 用浏览器工具导航、点击、输入、截图、读页面内容, so that 它能获取需要交互的网页信息
27. As a user, I want 在设置页配置 stdio MCP server 并逐工具启停, so that 接入任意第三方工具生态
28. As a user, I want agent 通过 `spawn_subagent` 委派调研任务、消息流里以嵌套卡片显示子代理进度, so that 大范围搜索不占用主会话上下文
29. As a user, I want 全局配置子代理模型与并发上限（默认 3）, so that 成本与速度可控

### 应用体验

30. As a user, I want 输入框支持斜杠命令（`/new` `/rename` `/archive` `/compact` `/model` `/status`）, so that 高频操作不依赖鼠标
31. As a user, I want 全中文界面, so that 使用门槛低
32. As a user, I want NSIS 安装包与便携版 zip, so that 在任意 Windows 机器上即装即用

## Implementation Decisions

### 架构

- **形态**：Electron 桌面应用（ADR-0001）。主进程为宿主，渲染进程为 React UI（Vite + Tailwind），contextBridge 暴露类型化 IPC。
- **Agent Core**：纯 TS 模块，零 Electron 依赖（ADR-0002）。对话循环、工具注册表与执行、审批状态机、compact、AGENTS.md 发现、worktree 管理、subagent 编排、会话持久化接口全部在此。Electron 主进程通过宿主接口装配它（注入真实 fs/shell/存储实现）。
- **仓库结构**：pnpm monorepo，三个包：`agent-core`、`desktop`（Electron 主进程 + IPC）、`ui`（React 渲染进程）。
- **IPC**：主→渲染为事件流（消息增量、工具事件、审批请求、子代理进度），按会话 ID 多路复用；渲染→主为指令（发送消息、审批响应、打断、切换审批模式）。

### LLM 接入

- **Vercel AI SDK**，统一 OpenAI 兼容协议（`baseURL` + `apiKey` + `model`）。Provider Profile 多份可配，会话级选择。
- API key 用 Electron `safeStorage` 加密后落盘，明文不出现在任何日志。
- 流式输出（token 增量推送到 UI）；请求带重试与超时。

### 审批模式（三档 = Codex 两轴的预设组合）

- `readonly` ≈ sandbox `read-only`：写文件/打补丁/终端命令一律拒绝（工具返回明确的拒绝原因，agent 可改用只读手段）。
- `suggest` ≈ `workspace-write` + 出界审批：文件编辑自动应用（diff 可审阅可撤销）；终端命令逐条审批。
- `full` ≈ `danger-full-access` + `never`：全自动。
- 审批卡片三选一：批准 / 拒绝 / 本会话总是允许（按命令首词/前缀记忆，会话内持久，存入会话记录）。
- 文件操作限制在工作区内（ realpath 校验，防 `..` 与符号链接逃逸）。

### 工具注册表与内置工具

- 统一工具接口：名称、JSON Schema 参数、权限需求（只读/写入/命令）、执行器。MCP 工具适配为同一接口。
- 内置：`read_file`（行号输出）、`write_file`、`apply_patch`（补丁式，上下文行必须匹配，失配即拒）、`glob`、`grep`、`run_terminal_command`、`web_search`、浏览器工具组（`browser_navigate` / `browser_click` / `browser_type` / `browser_screenshot` / `browser_read`）。
- 工具执行带超时；输出超长截断（终端输出、文件、网页内容均有上限）。
- `run_terminal_command`：默认 Git Bash（`bash.exe -c`），可配置 PowerShell/cmd；工作区内相对路径；Windows↔POSIX 路径转换在工具层完成；子进程环境变量用白名单（PATH、HOME、LANG 等基础项），不透传全部环境。

### 会话与持久化

- SQLite（`better-sqlite3`），数据库位于 `~/.codexlike/`。表：会话（id、工作区、审批模式、模型、worktree 信息、状态）、消息、工具调用记录、审批决定、compact 记录。全部事务写入，断电安全。
- 会话恢复：应用启动时从库中读出全部会话与消息渲染；「继续」即从既有消息历史续跑。

### 上下文管理

- AGENTS.md 发现：全局 `~/.codexlike/AGENTS.md` + 项目根（git 根）→ cwd 逐层每目录取一个、拼接注入系统提示，总量 32 KiB 上限。
- `/compact`：手动触发；用当前模型把既有历史压成摘要，替换旧消息，保留最近若干轮原始对话；摘要标记在 `/status` 中可见。
- `/status`：显示当前上下文 token 用量（按消息估算）。

### git 集成与托管 Worktree

- git 操作走 `simple-git`：改动面板 = `git status` + `git diff`；一键创建分支（`codexlike/<会话名>`）/ commit（消息默认由模型按会话内容生成、可编辑）。
- worktree 模式：会话创建托管 Worktree 于 `~/.codexlike/worktrees/<会话id>`，独立分支；`.worktreeinclude` 文件列出的被 ignore 文件复制进去；会话删除/完成后进入 LRU 清理，保留最近 15 个，运行中会话的 worktree 永不清理。**不做** local↔worktree 中途迁移（handoff）。

### subagents

- `spawn_subagent(task)` 工具：子代理拥有独立上下文与完整工具集，**不含** `spawn_subagent`（防递归）；模型用全局子代理模型配置（默认同主模型）；单会话并发上限 3；完成后向主会话返回文本报告；UI 以嵌套卡片显示进度与最终报告。

### web_search 与浏览器

- `web_search`：默认 Tavily API（key 在设置页配置），搜索源抽象为接口可替换；结果（标题/URL/摘要）作为工具输出返回模型。
- 浏览器：Playwright headless Chromium（首次使用时下载）；工具组见上；截图以图片内容返回模型（端点支持多模态时）或以路径+描述降级。

### MCP

- `@modelcontextprotocol/sdk` 客户端，stdio transport 优先；设置页配置 server（命令、参数、环境变量）；发现到的工具并入工具注册表，可逐工具启停；MCP 工具调用同样过审批模式。

### UI（中文）

- 三栏：左侧会话列表（状态徽标 + 新建）；中部消息流（用户消息、markdown 流式回复、工具卡片、审批卡片、子代理嵌套卡片）+ 底部输入框（模型选择器、审批模式选择器、发送/停止）；右侧侧滑改动面板（文件列表 + Monaco diff + commit 操作）。
- 设置页：Provider Profiles、子代理模型、搜索源、MCP servers、shell 偏好。
- 斜杠命令与 `@文件引用` 为输入框解析层（`/` 触发命令菜单，`@` 触发工作区文件模糊搜索菜单）。

### 打包

- `electron-builder`：Windows NSIS 安装包 + 便携 zip；无自动更新。

## Testing Decisions

- **好测试的标准**：只测外部行为——给定用户输入与脚本化的模型响应序列，断言可观察结果（会话状态机转换、文件系统实际变化、审批请求与放行结果、数据库中的记录），不断言内部实现细节。
- **主接缝（约 90% 测试量）**：`agent-core` 公共接口。用 Vercel AI SDK 的 `MockLanguageModel` 脚本化模型响应（先回工具调用、再回文本），真实临时目录作工作区，进程内 fake MCP server。覆盖：agent 循环、三档审批的真实拦截、审批记忆、每个工具、compact、AGENTS.md 逐层发现、会话持久化与恢复、worktree 创建/清理/`.worktreeinclude`、subagent 隔离与并发上限。
- **纯逻辑单测**：斜杠命令解析、`@` 引用解析、Windows↔POSIX 路径转换、输出截断。
- **Electron E2E 冒烟（1-2 条）**：Playwright `_electron` 启动真实应用走最小路径（配置 Provider → 建会话 → 消息往返 → 工具卡片出现 → 改动面板有 diff），只验证 IPC 桥与 UI 组装，不重复业务断言。
- 绿地项目无先例，本节即先例；后续工单的测试沿用此分层。

## Out of Scope

以下明确**不做**（多数为 v1.x 也不做，绑定 OpenAI 云生态或独立大子系统）：

- ChatGPT 账号 OAuth 登录（只用 API key 的 Provider Profile）
- 云端任务 / `codex cloud` 类远程执行
- automations 定时任务与 review queue
- skills 生态、plugins / marketplace
- hooks（PreToolUse 等事件外发）
- 非交互 `exec` 模式（CI 管道）
- IDE 扩展（VS Code / Cursor 等）
- worktree 的 local↔worktree 中途迁移（handoff）与快照恢复
- 自动 compact（只做手动 `/compact`）
- 自动更新（NSIS + 便携 zip 已够）
- 多语言 i18n（中文文案集中管理，留口子）
- macOS / Linux 打包（架构不绑定，但不做发行验证）

## Further Notes

### 验收标准（「完成」的定义，9 条端到端场景）

1. 全新安装 → 设置页配置 Provider Profile → 开始会话
2. 会话绑定工作区 → 下达「修复某 bug」→ agent 自主 read/grep/apply_patch/run_terminal_command（suggest 模式命令审批）→ 改动面板看 diff → 一键 commit
3. 关闭应用重开 → 会话列表完整恢复，继续对话
4. 长会话触发上下文告警 → `/compact` 后继续
5. 同一仓库开第二个会话（worktree 模式）→ 并行改动互不干扰
6. 任务中 `web_search` 查文档、浏览器工具抓取页面
7. 配置一个 stdio MCP server → 其工具可被调用
8. `spawn_subagent` 委派调研 → 嵌套卡片进度 → 报告回流主会话
9. 审批三档切换 + `readonly` 下写入被真实拦截

### 实施顺序原则

tracer-bullet：先打通「配置 → 会话 → 六件核心工具 → 审批 → diff → commit」端到端最小链路（对应验收 1、2、9），再按会话恢复（3）→ compact/AGENTS.md（4）→ worktree（5）→ web/浏览器（6）→ MCP（7）→ subagent（8）逐段加固。worktree 与 subagent 是两个独立子系统，排在后段。

### 参考文档

- `GLOSSARY.md`（领域术语，工单与代码命名必须遵循）
- `docs/adr/0001-electron-desktop-app.md`、`docs/adr/0002-agent-core-decoupled-from-electron.md`
- 调研要点：Codex 官方现为 sandbox（`read-only`/`workspace-write`/`danger-full-access`）× approval（`on-request`/`never`）两轴；本 spec 三档为其预设组合（见 Implementation Decisions）。

### 用户侧前置

- 注册 Tavily API key（https://tavily.com，免费 1000 次/月）用于验收场景 6。
