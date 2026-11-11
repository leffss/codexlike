# CodexLike

本地 AI coding agent 桌面工作台（Electron，Windows 优先，全中文界面）：agent 在你本机的工作区里读文件、改代码、跑命令、搜网络，你通过界面审批与检视结果——一个自己可控的「Codex Desktop 功能平替」。

## 功能一览

- **任意 OpenAI 兼容端点**：多份 Provider Profile（`baseURL` / `apiKey` / `model`，GLM、DeepSeek、OpenAI、Ollama……），API key 经系统加密（Windows DPAPI）落盘，会话中随时切换。
- **会话与工具**：会话绑定工作区目录；agent 自主使用 `read_file` / `write_file` / `apply_patch` / `glob` / `grep` / `run_terminal_command`；工具调用以可展开卡片呈现；随时打断。
- **三档审批模式**：`readonly`（只读，写入与命令真实拦截）/ `suggest`（协作，文件编辑自动应用、终端命令逐条审批：批准 / 拒绝 / 本会话总是允许）/ `full`（自主）。文件操作限制在工作区内。
- **git 集成**：改动面板 `git status` + Monaco 双栏 diff；一键创建 `codexlike/<会话名>` 分支、模型生成（可编辑）提交消息并 commit。
- **会话持久化**：SQLite 落库，重启后消息、工具卡片、审批记忆完整恢复，继续对话。
- **上下文管理**：全局与项目 `AGENTS.md` 每条消息自动刷新；全局/项目技能按需加载，输入框 `$` 显式选择技能、`@` 引用工作区文件；“规范与技能”查看来源和生效状态，`/compact` 压缩历史、`/status` 查看用量。
- **托管 Worktree**：会话可选 worktree 模式在隔离副本上运行，同仓库多会话并行改动互不冲突（`.worktreeinclude` 声明需复制的被 ignore 文件，LRU 自动清理）。
- **扩展能力**：`web_search`（默认 Tavily）+ Playwright headless Chromium 浏览器工具组；stdio MCP server 逐工具启停；`spawn_subagent` 委派调研（嵌套卡片进度）。
- **斜杠命令**：`/new` `/rename` `/archive` `/compact` `/model` `/status`。

## 环境要求

- Windows 10/11 x64
- 使用终端命令工具需 Git Bash（默认探测常见安装路径）或 PowerShell/cmd
- MCP server、`node calc.js` 类命令依赖系统 Node.js（可选）
- 首次使用浏览器工具会自动下载 Chromium（默认走 npmmirror 镜像）

## 安装

发布产物在 `packages/desktop/release/`（由 `pnpm dist` 生成）：

| 产物                            | 说明                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| `CodexLike-Setup-<版本>.exe`    | NSIS 安装包：向导式安装，可选安装目录，附开始菜单/桌面快捷方式与卸载器 |
| `CodexLike-<版本>-portable.zip` | 便携版：解压到任意目录，双击 `CodexLike.exe` 即用，不写注册表          |

未做代码签名：首次运行 Windows SmartScreen 可能提示「更多信息 → 仍要运行」，属预期。

## 首次使用

1. 启动 CodexLike → 设置页 → **+ 新建 Profile**：填写名称、`baseURL`（如 `https://open.bigmodel.cn/api/paas/v4`）、API Key、模型名，保存。
2. （可选）设置页 **搜索源** 区填写 [Tavily](https://tavily.com) API key（免费 1000 次/月），`web_search` 工具即可使用。
3. （可选）设置页 **子代理** 区配置子代理模型与并发上限（默认同主模型、上限 3）。
4. （可选）设置页 **MCP** 区添加 stdio MCP server（命令 + 参数 + 环境变量），逐工具启停。
5. 返回工作台 → **+ 新建会话** → 选择工作区目录 →（可选 worktree 模式）→ 开始对话。

## 数据目录

应用数据默认位于 `~/.codexlike/`（即 `C:\Users\<你>\.codexlike\`），可由 `CODEXLIKE_HOME` 覆盖；兼容技能还可以来自 `~/.agents/skills/`：

```
~/.codexlike/
├── codexlike.db            # 会话、消息、工具调用、审批记忆、compact 记录（SQLite）
├── provider-profiles.json  # Provider Profiles（apiKey 加密存储）
├── search-settings.json    # 搜索源设置（key 加密存储）
├── mcp-servers.json        # MCP server 配置（env 值加密存储）
├── subagent-settings.json  # 子代理模型与并发设置
├── AGENTS.md               # 你的全局个人规范（自动注入所有会话）
├── skills/<name>/SKILL.md   # 全局技能（默认仅索引进入上下文）
├── worktrees/              # 托管 Worktree 隔离副本（LRU 清理，保留最近 15 个）
└── sessions/               # 会话截图等数据
```

删除该目录会清空应用配置与历史，但不会删除工作区文件或 `~/.agents/skills/` 中的兼容技能。

## 规范与按需技能

### AGENTS.md

每条新消息读取全局 `AGENTS.md`，再从 Git 根到会话工作目录逐层读取项目 `AGENTS.md`。非 Git 工作区只读取所选目录；更具体的项目规范在冲突时优先。合并内容上限 32 KiB，截断及读取诊断在“规范与技能”中可见。Worktree 读取副本中的文件，不自动回退到原目录；访问更深层文件不会临时切换规范。

### 技能目录与格式

| 作用域             | 应用目录                              | 兼容目录                           |
| ------------------ | ------------------------------------- | ---------------------------------- |
| 全局               | `~/.codexlike/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` |
| 项目目录链的每一层 | `.codexlike/skills/<name>/SKILL.md`   | `.agents/skills/<name>/SKILL.md`   |

`CODEXLIKE_HOME` 只覆盖应用全局目录。技能同名时：较近项目目录 > 较远项目目录 > 全局；同一层 `.codexlike` > `.agents`。被覆盖来源仍可查看；无效高优先级条目不会悄悄回退到同名低优先级条目。

例如 `.agents/skills/code-review/SKILL.md`：

```markdown
---
name: code-review
description: 审查当前代码改动，检查行为回归与缺失的测试
---

先了解改动目标，再阅读差异及相关测试。只报告有证据支持的问题。
需要审查清单时，按需读取 references/checklist.md。
```

`name` 与目录名一致，使用小写字母、数字和单连字符，最长 64 字符，且至少包含一个字母（避免 `$123` 一类金额歧义）；`description` 必须为非空文本。正文和附属文件只在需要时读取，技能文件不会自动运行。

### 调用与生效范围

- 输入 `$` 可按名称/描述选择技能；例如 `$code-review 请审查当前改动`。可以在同一条消息引用多个技能，宿主会在首次模型请求前加载；未知或无法加载的显式技能会阻止发送，而不是忽略它继续执行。
- 未显式指定时，模型只能看到技能索引，需要时调用 `load_skill` 加载正文，再通过 `read_skill_resource` 读取该技能目录内的文本资料。
- 每条消息使用同一份规范/技能目录快照。已读取文本在本轮缓存；尚未读取的文件如果变更，会提示下一条消息重试。
- 技能正文仅本条消息有效，不会因下一条消息、应用重启或 compact 而自动激活。子代理共享规范与可用目录，但独立选择和加载技能。
- 资源读取拒绝路径逃逸、越界符号链接、非普通文件、二进制和超限内容；技能不提升权限，脚本执行仍需使用现有工具并遵循审批。
- 上限：索引 16 KiB、单技能正文 64 KiB、单附属文本 32 KiB、单执行者本轮加载总量 256 KiB。索引排除项可见，正文超限报错而非静默截断。

工作台“规范与技能”区分**当前运行快照**、**最近一轮加载记录**和**下条消息磁盘预览**。文件仍由外部编辑器维护；首版不提供安装、市场或内置编辑器。

## 开发

pnpm monorepo，三个包：

| 包                    | 说明                                                                              |
| --------------------- | --------------------------------------------------------------------------------- |
| `packages/agent-core` | Agent Core：对话循环、工具注册表、审批状态机（纯 TS，零 Electron 依赖，ADR-0002） |
| `packages/desktop`    | Electron 主进程、类型化 IPC 桥、本地配置存储                                      |
| `packages/ui`         | React + Vite + Tailwind 渲染进程（全中文界面）                                    |

```bash
pnpm install          # 安装依赖（electron 二进制国内可加 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
pnpm dev              # 开发模式（agent-core watch + vite + electron）
pnpm typecheck        # 三包 tsc --noEmit
pnpm test             # 三包 vitest 单测
pnpm test:e2e         # Electron 基础冒烟（先全仓 build）
pnpm test:e2e:skills  # 规范与按需技能专项（隔离目录 + 本地 mock 模型）
pnpm test:e2e:all     # 全套 Electron E2E（详见 packages/desktop/e2e/）
pnpm build            # 三包构建
pnpm dist             # 打包发行：NSIS 安装包 + 便携 zip（见下）
```

### 打包

```bash
pnpm dist   # = pnpm build + electron-builder（Windows NSIS + zip）
```

流程（`packages/desktop/scripts/dist.mjs` + `electron-builder.template.yml`）：

1. 校验三包构建产物（`dist/main.cjs` / `dist/preload.cjs` / `ui/dist`）。
2. 组装 `.dist-vendor/`：主进程单文件（业务依赖已由 esbuild 全部 bundle，仅 external `electron` 与 `playwright-core`）、ui 静态产物、playwright-core 实体拷贝、自绘图标。
3. electron-builder 产出 `packages/desktop/release/` 下的 NSIS 安装包与便携 zip。

要点：ui 产物与 playwright-core 放 `resources/`（asar 外的 extraResources）——主进程按 `app.isPackaged` 加载 `resources/ui-dist/index.html`，playwright-core 放 `resources/node_modules/` 使 Node 模块解析从 asar 向上命中（chromium 安装器 spawn cli.js 也要求真实文件）。图标由 `pnpm --filter @codexlike/desktop run icon` 重新生成（纯 Node 自绘终端提示符「>_」，无第三方素材）。

国内网络下载 electron-builder 二进制（NSIS/7zip）可设 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

### 打包产物 E2E 走查

E2E 支持指向打包产物执行（验收工单 14 引入）：

```bash
CODEXLIKE_PACKAGED_EXE="<安装版或便携版 CodexLike.exe 路径>" \
  pnpm --filter @codexlike/desktop run test:e2e
```

## 项目结构

- 架构决策：`docs/adr/`（Electron 桌面形态、Agent Core 与 Electron 解耦、SQLite 选型）
- 领域术语：`GLOSSARY.md`
- 工单与规格：`.scratch/codexlike-v1/`
