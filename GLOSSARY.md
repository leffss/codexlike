# CodexLike

一个类似 Codex Desktop 的本地 AI coding agent 桌面应用（Electron）：agent 在用户本机的工作区里读文件、改代码、跑命令、搜网络，用户通过界面审批与检视结果。

## Language

**会话（Session）**:
一次持续的任务对话：用户在其中下达指令，agent 多轮执行工具并返回结果，直到完成或被打断。多个会话可同时运行。
_Avoid_: chat、conversation、task、聊天

**工作区（Workspace）**:
一个会话所绑定的本机目录，agent 的所有文件与终端操作都被限制在其中。
_Avoid_: repo、folder

**项目（Project）**:
同一工作区目录上所有会话（含在该目录上检出的托管 Worktree 会话）的聚合分组，由会话的工作区自动派生，随首个会话的创建而诞生，用户不手动创建或归类。
_Avoid_: 文件夹、分组、folder

**审批模式（Approval Mode）**:
会话级权限档位，可随时切换（ADR 0004）：`ask`（请求批准——编辑文件、执行命令与联网搜索前一律先询问）、`assist`（帮我批准——文件编辑与联网自动放行，仅危险命令（rm、强推等，见 `isRiskyCommand`）询问）、`full-access`（完全访问——全自动执行且不受限读写本地任意文件，工作区边界失效，切换前 UI 弹风险确认）。
_Avoid_: 权限级别、mode、沙箱模式、readonly/suggest/full（旧三档名）

**Agent Core**:
纯 TypeScript 的 agent 运行时模块（对话循环、工具执行、审批状态机），不依赖 Electron；Electron 主进程只是它的宿主。
_Avoid_: 后端、server

**工具注册表（Tool Registry）**:
内置工具（`read_file`、`write_file`、`apply_patch`、`glob`、`grep`、`run_terminal_command`、`web_search`、浏览器工具）与 MCP 工具统一注册、统一调度的接口。
_Avoid_: 插件系统

**MCP**:
Model Context Protocol，外接第三方工具服务器的开放协议；CodexLike 作为 MCP 客户端接入。
_Avoid_: 插件

**Compact（压缩）**:
把长会话历史压缩为摘要以释放上下文窗口的操作，由用户手动触发。
_Avoid_: 总结、summary

**子代理（Subagent）**:
主会话通过 `spawn_subagent` 工具委派的临时 agent：独立上下文、完整工具集（但不可再生成子代理）、使用可全局配置的子代理模型，并发上限 3，完成后向主会话返回报告。
_Avoid_: 子任务、worker、worker agent

**托管 Worktree（Managed Worktree）**:
worktree 模式下由 CodexLike 在 `~/.codexlike/worktrees/` 自动创建的 git worktree 隔离副本（独立分支），自动清理只保留最近 15 个。
_Avoid_: 分支副本、隔离区

**斜杠命令（Slash Command）**:
聊天输入框中以 `/` 开头的会话指令（`/new` `/compact` `/model` `/status` `/rename` `/archive`），与对应的 UI 按钮等效。
_Avoid_: 快捷命令

**@文件引用（@ Mention）**:
在输入框中以 `@` 引用工作区文件、将其内容附加到消息的输入方式。
_Avoid_: 附件、文件上传

**Provider Profile**:
一份 LLM 接入配置（`baseURL` / `apiKey` / `model`），全部走 OpenAI 兼容协议，可在界面中配置多份并切换。
_Avoid_: api config、model config、账号

**主题（Theme）**:
应用级外观偏好（`light` / `dark`），默认浅色；持久化到主进程设置文件，窗口底色与界面配色随之整体切换（ADR 0006）。
_Avoid_: 皮肤、skin、暗黑模式（dark mode）
