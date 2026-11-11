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

**用户交互（User Interaction）**:
agent 在会话中向用户发起、等待用户回应后才能继续的请求，包括执行审批和对话内交互问答。
_Avoid_: 交互模式、审批（泛指所有用户交互时）

**执行审批（Execution Approval）**:
用户对某次待执行操作给予或拒绝授权的用户交互；与提供任务信息的问答不同，审批回答决定该操作是否允许执行。
_Avoid_: 问答、确认问题

**对话内交互问答（Interactive Questions）**:
agent 在会话中发起的一组问题，用户通过单选、多选或自定义回答提供信息，供 agent 继续处理当前任务。
_Avoid_: 问卷模式、交互模式、执行审批

**审批模式（Approval Mode）**:
会话级权限档位，可随时切换（ADR 0004）：`ask`（请求批准——编辑文件、执行命令与联网搜索前一律先询问）、`assist`（帮我批准——文件编辑与联网自动放行，仅危险命令（rm、强推等，见 `isRiskyCommand`）询问）、`full-access`（完全访问——全自动执行且不受限读写本地任意文件，工作区边界失效，切换前 UI 弹风险确认）。
_Avoid_: 权限级别、mode、沙箱模式、readonly/suggest/full（旧三档名）

**Agent Core**:
纯 TypeScript 的 agent 运行时模块（对话循环、工具执行、用户交互），不依赖 Electron；Electron 主进程只是它的宿主。
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

**规范（Agent Instructions）**:
用户针对全局或特定项目制定的持续行为约定，适用于该范围内的主会话与子代理；与按任务选用的技能不同。
_Avoid_: 技能、系统配置

**技能（Skill）**:
面向特定任务的可复用操作说明及配套材料；用户显式选择或 agent 按需选用，只对当前这条消息所发起的任务生效。
_Avoid_: 插件、工具、命令

**资源快照（Resource Snapshot）**:
一条消息执行期间确定采用的规范与可用技能目录；与可能已被外部编辑、将在下条消息生效的磁盘预览区分。
_Avoid_: 缓存、配置副本

**Provider Profile**:
一份 LLM 接入配置（`baseURL` / `apiKey` / `model`），全部走 OpenAI 兼容协议，可在界面中配置多份并切换。
_Avoid_: api config、model config、账号

**思考档位（Thinking Effort）**:
逐条消息生效的模型思考强度档位，共五档：`auto`（自动——不传参，用服务端默认）、`low`（低）、`medium`（中）、`high`（高）、`off`（关）。切换只对下一条消息生效，历史不受影响；与 Provider Profile 选择一样属于「下一条消息怎么发」的参数，不做会话级记忆。子代理不设独立档位，以快照方式继承触发它的那次请求的档位。
_Avoid_: 思考模式、thinking mode、推理等级、推理开关

**主题（Theme）**:
应用级外观偏好（`light` / `dark`），默认浅色；持久化到主进程设置文件，窗口底色与界面配色随之整体切换（ADR 0006）。
_Avoid_: 皮肤、skin、暗黑模式（dark mode）
