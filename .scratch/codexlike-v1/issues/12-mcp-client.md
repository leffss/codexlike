# 12: MCP 客户端（stdio）

**What to build:** 设置页可添加 stdio MCP server（命令、参数、环境变量），应用连接并列出其提供的工具；MCP 工具适配进统一工具注册表、在设置页可逐工具启停；会话中模型可调用启用的 MCP 工具，调用同样过审批模式（`suggest` 下弹审批卡片）。server 进程崩溃/启动失败/调用超时不拖垮会话，错误作为工具结果返回模型。基于 `@modelcontextprotocol/sdk`。

遵循 `GLOSSARY.md`（术语：MCP、工具注册表）；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 04 (审批模式三档 + 审批卡片)

**Status:** done

- [x] 设置页：添加/删除 MCP server 配置，连接状态可见
- [x] server 工具发现并入注册表；逐工具启停对会话生效
- [x] `suggest` 模式下 MCP 工具调用弹审批卡片
- [x] server 崩溃/超时的错误处理：会话存活、错误可读
- [x] 进程内 fake MCP server 集成测试：发现→调用→结果回填

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/12-mcp-client`，基线 3f8eaf5；期间合并 integration tip 8366efa 即工单 05）

1. **设置页：添加/删除 server 配置，连接状态可见** ✅ `McpSettingsSection`（设置页第三区）：添加表单（名称/命令/参数每行一个/环境变量 KEY=VALUE 每行一个，`mcp-form.ts` 纯函数解析与中文校验）；server 卡片含状态徽标（已连接/连接中/连接失败/未连接四态配色）、中文错误信息、重连与删除按钮。配置落 `~/.codexlike/mcp-servers.json`，**env 值逐个 safeStorage 加密**（desktop 单测断言磁盘无明文；safeStorage 不可用时拒绝保存含 env 的 server，空 env 不受影响）。E2E 实测：设置页添加 node + fake server → 「已连接」+ 工具列表可见 → 重启应用后 startup 自动重连仍「已连接」。
2. **工具发现并入注册表；逐工具启停对会话生效** ✅ 连接 = spawn stdio 子进程 → initialize 握手 → tools/list；发现结果适配 `ToolDefinition`（03 的统一接口）入会话工具表，名称 `mcp_<server>_<tool>`（server 名与工具名归一化：小写、非法字符转下划线），跨 server 撞名后发现的跳过、与内置工具撞名内置优先（desktop sessionTools 合并）。**启停对会话生效的关键改动**：`CreateAgentSessionOptions.tools` 支持工厂函数 `() => ToolDefinition[]`，每条消息发送时逐次解析——设置页开关/断线重连/新增 server 对后续消息即时生效，无需重建会话（agent-core 单测「启停即时生效」：第二条消息再调被禁用工具得到「未注册」可读错误）。数组形式行为不变，向后兼容。
3. **suggest 下 MCP 工具调用弹审批卡片** ✅ MCP 工具 `permission: 'command'`（spec：server 端行为不可知，保守按命令级）——04 的审批链路直接生效：suggest 弹卡（工具参数无 command 字段时以工具名兜底，`always` 按工具名记忆，均为 04 预留语义）；readonly 真实拦截（isError + 拒绝原因回填，server 未被调用）；full 直接执行。agent-core 单测三档各一 + E2E 实测审批卡（`data-approval-command=mcp_fake_echo`）→ 批准 → 执行 → 结果回填。
4. **崩溃/超时/启动失败的错误处理：会话存活、错误可读** ✅ 全部错误在工具层转 `isError` 中文结果回填模型，不抛进会话循环：崩溃（server 进程退出 → 调用返回「MCP 工具 X 调用失败：…」；**惰性自动重连**——断线保留最后已知工具列表，下一次调用自动重建连接，单测断言崩溃后再调 echo 成功）；调用超时（默认 30s，`client.callTool` 的 timeout，中文「调用超时（30 秒）」）；连接失败（ENOENT/启动即退出 → `failed` 状态 + 中文原因含命令名，不抛出、不拖垮其它 server 与 startup）。单测断言各场景会话均正常走到 `assistant-done`、无 error 事件。
5. **进程内 fake MCP server 集成测试：发现→调用→结果回填** ✅ `tests/mcp/fixtures/fake-mcp-server.mjs`（SDK server 端 + StdioServerTransport，node 子进程真实 stdio 往返；注册 echo / slow_echo / crash 三个工具，`die-immediately` 模式测启动失败）。覆盖 22 个 agent-core 用例（mcp-manager 10：发现/前缀/schema 透传/调用往返/名称归一化/启停逐次解析/撞名/崩溃重连/超时/启动失败/主动断开；mcp-session 6：suggest 审批→批准→结果回填下一轮 prompt、always 记忆、readonly 拦截、崩溃存活、超时存活、启停即时生效）+ desktop 12 用例（store 6：加密/校验/重启恢复；service 6：startup 自动连接/启停/删除/失败隔离/重连/内置优先合并）+ E2E 全链路。

### 关键实现事实（后续工单建立在这些接口上）

- **agent-core `./node` 出口新增**：`createMcpManager` / `McpManager` / `MCP_DEFAULT_CALL_TIMEOUT_MS`（30s）/ `MCP_DEFAULT_CONNECT_TIMEOUT_MS`（15s）；主出口新增 type-only 的 `McpServerConfig` / `McpServerStatus` / `McpDiscoveredTool` / `McpServerState`。McpManager 的 `servers()` / `disabledTools()` 是**同步逐次解析函数**——desktop 装配传内存缓存，写操作后从 store 重载。
- **重连策略（二选一中的选择）**：**惰性自动重连**。崩溃/断线不主动重连，保留最后已知工具列表（会话工具列表稳定），下一次工具调用时自动重建；另有设置页「重连」按钮（`mcp:reconnect`）作显式入口。主动 `disconnect`（删除 server）则清空工具列表——与崩溃语义区分。
- **tools 工厂**：`CreateAgentSessionOptions.tools` / `CreateSessionManagerOptions.tools` 均为 `ToolDefinition[] | (() => ToolDefinition[])`；解析点在 `sendMessage` 内（每条消息一次），`toModelTools` 随之逐消息构建。**工单 13（subagents）扩展 agent-session 时请保持此语义**（子代理工具集同样可传工厂）。
- **MCP 工具的描述前缀**：`【MCP:<server 名>】<原 description>`，模型可辨识来源；空 description 回退为「MCP server「X」提供的工具 Y」。
- **IPC 新增**（`mcp:*` 五通道）：`overview`（配置+状态+工具含启停）/ `addServer` / `removeServer` / `reconnect` / `setToolEnabled`；`@codexlike/desktop/ipc` 再导出 `McpServerView` / `McpServerInput` 供 ui 使用。
- **desktop 装配**：`main.ts` 会话工具改工厂 `tools: () => mcpService.sessionTools(builtinTools)`；`will-quit` 时 `mcpService.shutdown()` 断开全部子进程。
- **SDK 要点**：`StdioClientTransport` 的 env 需在 `getDefaultEnvironment()`（PATH 等白名单）之上合并用户 env，否则 Windows 上 spawn 找不到可执行文件；`client.connect/listTools/callTool` 均支持 `timeout` 选项；`CallToolResult.content` 只取 text part 拼接，非文本内容给出中文占位。
- **E2E**：`e2e/mcp.mjs`（`pnpm --filter @codexlike/desktop run test:e2e:mcp`）——fixture 复用 agent-core 的 fake server（跨包相对路径引用，纯 .mjs 不参与构建）。

### 设计决策与偏离说明

- **MCP 工具一律 `permission: 'command'`**（含 server 端只读工具）：客户端无法可靠判定远端工具的副作用，统一按最高警惕级别走审批；readonly/suggest/full 三档语义与终端命令一致。
- **工具命名归一化**：server 名与工具名都归一化为 `[a-z0-9_]+`（`My Server.v2` → `my_server_v2`），保证模型可见名与审批记忆 key（命令首词）稳定。
- **env 加密但命令/参数明文**：env 常含 API key（凭据性质，与 01 的 apiKey 同口径加密）；命令与参数是配置语义，明文可读便于排查。
- **工具摘要**：`tool-summary` 为 `mcp_` 前缀加专用摘要（text/query/command/path 类字段优先取值），卡片折叠态显示 `MCP mcp_fake_echo：你好`。

### 踩坑记录（对后续工单有用）

- **SDK 返回类型带 index signature**（`{ [x: string]: unknown; content: … }`），直接写结构化参数类型在 exactOptionalPropertyTypes 下不相容——`contentToOutput(raw: unknown)` 内部窄化一次收口，别与 SDK 泛型缠斗。
- **断线与主动断开必须区分**：transport.onclose（崩溃）保留工具列表支撑惰性重连；`disconnect()`（用户删除）清空。两者共用一个 Entry 簿记（connection + tools + status + error）。
- **审批等待中的 MCP 工具**：04 的 `commandOfToolInput` 会取 MCP 工具参数里的 `command` 字段（若有）作审批展示与记忆 key——这是期望行为（如 server 提供执行命令类工具时按命令首词记忆），无 command 字段回退工具名。
- **desktop 测试复用 agent-core fixture**：`join(__dirname, '..','..','..','agent-core','tests','mcp','fixtures',...)`——E2E 同款相对路径；fixture 不 import desktop 任何代码，无循环。
- **重申旧坑**：`pnpm typecheck 2>&1 | tail` 管道吞退出码（本轮又踩一次，`cmd | tail` 后必须 `${PIPESTATUS[0]}`）；desktop 测试走 agent-core dist，改完必须先 build。

### 测试与验证

- `pnpm typecheck` 三包 0 错误；`pnpm test`：agent-core 238 + desktop 41 + ui 46 = **325 用例全绿**（合并 05 后；本工单新增 40：agent-core 22 + desktop 12 + ui 6）。
- E2E 七条全过：smoke / commands / approvals / compact / changes / interrupt（05/06 合并带入，回归）/ **mcp（本工单新增）**。
- 提交：4fa815d（依赖）→ a1ca163（McpManager）→ 80845b4（tools 工厂 + 会话链路）→ 7adc529（desktop 装配）→ c6920b1（ui 设置页）→ 85aad5c（E2E）→ 7ba6b39（合并 integration tip 8366efa）。
