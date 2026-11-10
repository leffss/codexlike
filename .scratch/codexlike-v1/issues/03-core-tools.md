# 03: 六件核心工具 + 工具卡片

**What to build:** agent 获得工具注册表与六件内置工具——`read_file`（带行号）、`write_file`、`apply_patch`（补丁式编辑，上下文行必须精确匹配，失配拒绝并把原因返回模型）、`glob`、`grep`、`run_terminal_command`——并进入多轮自主循环：模型调工具 → 执行 → 结果回填 → 继续，直到给出最终回复。文件操作限制在工作区内（realpath 校验，`..` 与符号链接逃逸被拒）。`run_terminal_command` 默认经 Git Bash（`bash.exe -c`）执行、Windows↔POSIX 路径在工具层转换、可配置切换 PowerShell/cmd、环境变量白名单。所有工具带超时与输出截断。UI 中每次工具调用显示为可展开卡片（工具名、参数摘要、完整输出）。本工单内工具默认放行（审批三档在 04 引入）。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 02 (会话循环 + 流式消息 UI)

**Status:** done

- [x] 六件工具各自在真实临时目录上的行为测试通过
- [x] `apply_patch` 上下文失配时拒绝并返回可读原因，模型可据此重试
- [x] 工作区边界：逃逸路径（`..`、符号链接）被拒
- [x] Windows 上 `ls`、`&&`、管道等 POSIX 命令经 Git Bash 正常执行
- [x] 超长输出被截断（终端/文件/搜索各有上限），截断有标记
- [x] 多轮工具循环测试（`MockLanguageModel` 脚本化：工具调用→结果→最终回复）
- [x] UI 工具卡片渲染（含长输出折叠展开）

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/03-core-tools`，已合并 integration tip 含工单 07）

1. **六件工具真实临时目录行为测试** ✅ `packages/agent-core/tests/tools/` 共 64 用例（read/write 12、apply_patch 10、glob+grep 13、terminal 9、workspace 边界 8、builtin 聚合 3、registry 3、路径转换 6），全部在 `mkdtempSync` 真实目录上断言文件系统实际变化，不 mock fs。
2. **apply_patch 失配拒绝 + 可读原因** ✅ 类 Codex 补丁格式（Begin/End + Update/Add/Delete File + @@ 分块；行首空格上下文、`-`/`+` 变更）。上下文与删除行须精确匹配（含空白）；失配输出三要素：期望内容开头（前 3 行）、文件中相近行（两级前缀探测，能定位「开头相同行尾不同」）、read_file 重试指引——agent-core 测试断言模型可据此自愈。多文件补丁全部试算成功才写盘（原子拒绝）；纯新增行无锚点、Add 已存在、Delete 不存在、格式非法均中文报错。
3. **工作区边界** ✅ `resolveInWorkspace`：realpath 归一 + 对不存在路径的最近祖先 realpath 回拼（junction 链接目录逃逸在读/写/深层新路径三路全被拦截）；`path.relative` 判界（win32 大小写不敏感）；`..` 回绕与工作区外绝对路径被拒；指向工作区内的合法链接放行。
4. **Git Bash 执行 POSIX 命令** ✅ 默认 `bash.exe -c`（常见安装路径探测 + `CODEXLIKE_GIT_BASH_PATH` 覆盖 + 非 Windows 直接 `/bin/bash`）；测试实测 `ls *.txt | sort && echo done`、`printenv`、`pwd` 等。PowerShell/cmd 经 `CODEXLIKE_SHELL` 环境变量切换（设置页 UI 留待后续工单），PowerShell 路径有实测。Windows 反斜杠绝对路径在工具层转 POSIX（`C:\x` → `/c/x`）后交给 bash。
5. **截断与标记** ✅ read_file：默认 2000 行（模型显式 offset/limit 是分段读取不算截断，limit 被上限压低才标记）；glob 200 条、grep 100 处（单行 500 字符截尾）；终端合并输出 30000 字符（stdout + `[stderr]` 分节 + 非 0 退出码标记）。标记统一 `[已截断：…原始量/显示量…]` 格式。
6. **多轮工具循环** ✅ 会话循环为**手动工具循环**（streamText 不带 execute，tool-call part 由生成器内执行）：事件顺序天然正确（tool-call → 执行 → tool-result 全在生成器体内）、审批插点（工单 04）与落库可控。MockLanguageModelV4 脚本化 5 用例：完整往返（事件序列 + 文件落盘 + `doStreamCalls` 断言结果回填 + tool_calls 表）、read_file→apply_patch 多轮串接、工具失败 isError 回填后继续、未注册工具名返回可读错误继续、无 tools 会话保持 02 纯对话行为。轮次上限 16（防失控）。
7. **UI 工具卡片** ✅ `ToolCallCard`（工具名徽标 + 每工具参数摘要 + 运行中/完成/失败态 + 点击展开完整参数与输出）；`session-view` 归并 tool-call/tool-result 事件（迟到 result 忽略）；消息流时间线（transcript）重启恢复工具卡片。E2E 端到端实测：mock 首轮返回 tool_call → 卡片出现 → 展开见「已写入 e2e.txt」→ 文件真实写盘 → 重启后卡片恢复。

### 关键实现事实（后续工单建立在这些接口上）

- **工具注册表接口（工单 10/11/12 的挂载点）**：`ToolDefinition = { name, description, parameters(JSON Schema object), permission: 'readonly'|'write'|'command', execute(args, context) }`；执行上下文携带 `workspacePath` + `signal`，因此工具实例无状态、全部会话共享（desktop main 一次 `createBuiltinTools({ env, shell })`）。`createToolRegistry` / `runTool`（异常→isError 包装）在 `@codexlike/agent-core/node` 出口；`defineTool` 保证 execute 永不抛出。
- **SessionEvent 新增** `tool-call`（执行前，UI 卡片 running）/ `tool-result`（完成，记录同时落库）；`ToolCallRecord` 为事件/持久化/UI 共用形状。
- **持久化**：`tool_calls` 表（id=toolCallId、arguments JSON 串、output、is_error）+ `SessionPersistence.insertToolCall/listToolCalls`；`SessionManager.transcript(sessionId)` 按 createdAt 稳定合并消息与工具卡片（IPC `sessions:messages` 已升级返回 `TranscriptItem[]`）。
- **终端工具**：env 白名单 21 项（PATH/HOME/LANG/TZ/代理等，大小写不敏感）不透传全部环境；超时默认 30s（timeoutMs 可调、上限 120s），Windows 用 `taskkill /T /F` 杀进程树；支持 AbortSignal 打断。
- **agent-session 融合（合并 07）**：工具循环内 streamText 带 `system`（AGENTS.md 注入）与 mentions 组装的用户上下文，两侧功能正交共存。

### 踩坑记录（对后续工单有用）

- **ai@7 `result.response` 是 Promise**：`(await result.response).messages` 才是本轮消息（tool-call parts 所在）；直接 `.messages` 得 undefined，运行时炸 TypeError 后被 error 路径吞成「模型请求失败」，难以定位。
- **ToolResultPart 无 `isError` 字段、output 不收裸 string**：回填用 `output: { type: 'text', value }`；失败语义写进文本前缀（工具层统一「工具 X 执行失败：…」）。
- **v4 mock 的 tool-call stream part**：`input` 字段是 **JSON 字符串**（非对象）；finishReason `{ unified: 'tool-calls' }` 后 SDK 不自动执行（我们的 tool 定义不带 execute），循环由自己驱动。
- **provider 层 mock 与 SDK 的 OpenAI 适配不同**：agent-core 测试用 `MockLanguageModelV4`（直接 v4 part）；E2E 用 OpenAI 兼容 SSE mock 时 tool_call 走 `choices[0].delta.tool_calls[{index,id,type,function:{name,arguments}}]` + `finish_reason: 'tool_calls'`，两者都实测可用。
- **TS 联合判别**：UI 的 `UiItem = UiMessage | UiToolCall` 需要 UiMessage 声明 `kind?: undefined` 才能用 `item.kind === 'tool-call'` narrow。
- **pnpm test:e2e 管道缓冲**：`pnpm test:e2e | tail` 在长跑时 0 输出像卡死（root build 慢 + tail 缓冲）；直接 `node e2e/smoke.mjs` 可看实时进度。
