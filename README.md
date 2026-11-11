# CodexLike

本地 AI coding agent 桌面工作台（Electron，Windows 优先，全中文界面）：agent 在你本机的工作区里读文件、改代码、跑命令、搜网络，你通过界面审批与检视结果——一个自己可控的「Codex Desktop 功能平替」。

## 功能一览

- **任意 OpenAI 兼容端点**：多份 Provider Profile（`baseURL` / `apiKey` / `model`，GLM、DeepSeek、OpenAI、Ollama……），API key 经系统加密（Windows DPAPI）落盘，会话中随时切换。
- **会话与工具**：会话绑定工作区目录；agent 自主使用 `read_file` / `write_file` / `apply_patch` / `glob` / `grep` / `run_terminal_command`；工具调用以可展开卡片呈现；随时打断。
- **三档审批模式**：`readonly`（只读，写入与命令真实拦截）/ `suggest`（协作，文件编辑自动应用、终端命令逐条审批：批准 / 拒绝 / 本会话总是允许）/ `full`（自主）。文件操作限制在工作区内。
- **git 集成**：改动面板 `git status` + Monaco 双栏 diff；一键创建 `codexlike/<会话名>` 分支、模型生成（可编辑）提交消息并 commit。
- **会话持久化**：SQLite 落库，重启后消息、工具卡片、审批记忆完整恢复，继续对话。
- **上下文管理**：全局与项目 `AGENTS.md` 自动注入；`/compact` 手动压缩长会话、`/status` 查看用量；输入框 `@` 引用工作区文件。
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

| 产物 | 说明 |
| --- | --- |
| `CodexLike-Setup-<版本>.exe` | NSIS 安装包：向导式安装，可选安装目录，附开始菜单/桌面快捷方式与卸载器 |
| `CodexLike-<版本>-portable.zip` | 便携版：解压到任意目录，双击 `CodexLike.exe` 即用，不写注册表 |

未做代码签名：首次运行 Windows SmartScreen 可能提示「更多信息 → 仍要运行」，属预期。

## 首次使用

1. 启动 CodexLike → 设置页 → **+ 新建 Profile**：填写名称、`baseURL`（如 `https://open.bigmodel.cn/api/paas/v4`）、API Key、模型名，保存。
2. （可选）设置页 **搜索源** 区填写 [Tavily](https://tavily.com) API key（免费 1000 次/月），`web_search` 工具即可使用。
3. （可选）设置页 **子代理** 区配置子代理模型与并发上限（默认同主模型、上限 3）。
4. （可选）设置页 **MCP** 区添加 stdio MCP server（命令 + 参数 + 环境变量），逐工具启停。
5. 返回工作台 → **+ 新建会话** → 选择工作区目录 →（可选 worktree 模式）→ 开始对话。

## 数据目录

全部数据位于 `~/.codexlike/`（即 `C:\Users\<你>\.codexlike\`）：

```
~/.codexlike/
├── codexlike.db            # 会话、消息、工具调用、审批记忆、compact 记录（SQLite）
├── provider-profiles.json  # Provider Profiles（apiKey 加密存储）
├── search-settings.json    # 搜索源设置（key 加密存储）
├── mcp-servers.json        # MCP server 配置（env 值加密存储）
├── subagent-settings.json  # 子代理模型与并发设置
├── AGENTS.md               # 你的全局个人规范（自动注入所有会话）
├── worktrees/              # 托管 Worktree 隔离副本（LRU 清理，保留最近 15 个）
└── sessions/               # 会话截图等数据
```

删除该目录即完全清空全部配置与历史。

## 开发

pnpm monorepo，三个包：

| 包 | 说明 |
| --- | --- |
| `packages/agent-core` | Agent Core：对话循环、工具注册表、审批状态机（纯 TS，零 Electron 依赖，ADR-0002） |
| `packages/desktop` | Electron 主进程、类型化 IPC 桥、本地配置存储 |
| `packages/ui` | React + Vite + Tailwind 渲染进程（全中文界面） |

```bash
pnpm install          # 安装依赖（electron 二进制国内可加 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
pnpm dev              # 开发模式（agent-core watch + vite + electron）
pnpm typecheck        # 三包 tsc --noEmit
pnpm test             # 三包 vitest 单测
pnpm test:e2e         # Electron E2E（10 条，先全仓 build；详见 packages/desktop/e2e/）
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
