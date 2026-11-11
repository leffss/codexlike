# 13: subagents

**What to build:** agent 获得 `spawn_subagent(task)` 工具：把调研/大范围搜索类任务委派给子代理——独立上下文、完整工具集但不含 `spawn_subagent`（防递归）、使用设置页配置的全局子代理模型（默认同主模型）、单会话并发上限 3（超出的委派排队，UI 可见）。子代理运行时消息流中显示嵌套卡片（当前活动工具、已用时），完成后报告以文本回流主会话上下文。设置页增加子代理模型与并发上限配置。

遵循 `GLOSSARY.md`（术语：子代理）；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 04 (审批模式三档 + 审批卡片)

**Status:** done

- [x] `spawn_subagent` 可用：子代理独立完成任务并返回报告
- [x] 子代理工具集无 `spawn_subagent`（防递归有测试）
- [x] 并发上限 3：第 4 个委派排队而非并行（有测试）
- [x] 设置页可配子代理模型与并发上限，对后续会话生效
- [x] 嵌套卡片显示进度与最终报告
- [x] 子代理工具调用同样过当前审批模式（readonly 下子代理同样只读）

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/13-subagents`，基线 3f8eaf5；期间合并 integration tip 77d6adb 即工单 12/05/06）

1. **`spawn_subagent` 可用：子代理独立完成并返回报告** ✅ 单测「委派调研任务」：主模型一轮 spawn → 子模型（独立 MockLanguageModelV4）一次 doStream 出报告 → 报告作为 spawn_subagent 的工具结果回流（tool-result 事件 + tool_calls 落库 + 主模型第二轮 prompt 含报告）。独立上下文断言：子代理 prompt 含任务描述、不含主会话消息原文。E2E 真实链路：mock server 按 system 标记分流主/子两级，断言子代理请求体（独立上下文）与主模型第二轮请求体（含报告标记）。
2. **防递归有测试** ✅ 双角度：`subagents.test.ts` 断言子模型 doStream 调用的工具表不含 `spawn_subagent`（含 `read_file` 对照）+ 行为断言（子模型尝试再委派 → 「未注册（子代理不能再委派子代理）」isError 回填后子代理继续到报告）。编排器侧对工具集再 filter 一次（双保险）。E2E 按 `"name":"spawn_subagent"` 精确断言真实请求体的 tools 数组。
3. **并发上限 3：第 4 个委派排队（FIFO）** ✅ 单测「并发上限 3」：受控挂起子模型（ReadableStream start 内 await gate，并发数 = 模型调用数）——主模型一轮 4 个委派，前 3 个并发（3 次 doStream）、第 4 个 `subagent-queued` 排队（0 报告）；释放第 0 个后第 4 个占位开跑（第 4 次调用）；全部释放后 4 份报告按委派编号一一回流，主模型第二轮收到全部报告。上限经 `SubagentsConfig.settings()` 逐次解析（设置页改动对下一次委派生效）。
4. **设置页可配子代理模型与并发上限** ✅ 设置页「子代理」区：模型下拉（含「同主模型」默认项，Profile 引用不存在时边界校验中文报错）+ 并发上限 number input（1-8 校验）。`~/.codexlike/subagent-settings.json` 明文 JSON（Profile 引用 + 数字，无敏感凭据；损坏文件回默认值，越界历史值读取时收敛）。desktop 单测 6 例（默认值/往返/清除/校验/损坏/越界收敛）。main.ts 内存缓存注入 `SubagentsConfig`——保存后无需重启对下一次委派即时生效（E2E 实测保存路径）。「同主模型」= null 回退本次 sendMessage 的 Profile（经 `ToolExecutionContext.profile` 传递）。
5. **嵌套卡片显示进度与最终报告** ✅ `SubagentCard`（testid `subagent-card`/`subagent-status`/`subagent-elapsed`/`subagent-report`）：排队态（「并发上限已满」提示）、运行态（当前活动工具名+参数摘要、已用时 mm:ss 每秒刷新、脉动指示、已执行工具计数）、完成态（报告 markdown 可展开——报告到达自动展开；子代理工具调用列表折叠可查）。事件归并 `applySessionEvent` 新增 subagent-queued/start/tool/report 四事件（ui 单测 4 例）；spawn_subagent 的普通 tool-call 事件不建工具卡片（嵌套卡片代替）、tool-result 按 toolCallId 回填嵌套卡片。重启恢复：落库的 spawn 调用记录（arguments=task，output=报告）渲染为完成态嵌套卡片（`initialTranscript`，E2E 重启断言）。
6. **子代理工具调用同样过当前审批模式** ✅ 复用 04 的 `decideApproval` 状态机 + 会话审批链路：readonly 单测——子代理 `write_file` 被真实拦截（`subagent-tool` 结果含 readonly 拒绝文案、文件不落盘、拒绝原因进子代理报告回流）；suggest 单测——子代理 `run_terminal_command` 经 `approval-request` 事件（带 `subagentId` 标注来源）暂停等待，`respondApproval` 按 requestId 路由到子代理 waiter，always 决定记忆命令首词随会话入库（`approvals` 表，主会话/子代理共享记忆与恢复）；full 全放行（矩阵复用）。审批模式实时读取（切换对子代理下一次工具调用立即生效）。

### 关键实现事实（后续工单建立在这些接口上）

- **执行模型（与 spec「运行中主会话可继续」的落地语义）**：`spawn_subagent` 的 execute 立即返回（接受委派），子代理后台运行；主会话工具循环在本轮全部工具派发完、即将回填工具结果前，经 `orchestrator.pump()` 等待本轮全部子代理结束（期间实时转发进度事件），真实报告作为**延迟 tool-result** 落库并回填。效果：同一轮内多个委派（+其它工具）真并行，主会话的下一轮生成收到全部报告——上下文结构保持标准 tool-call/tool-result 配对，无需异步注入。
- **agent-core 出口**：`./node` 新增 `createSubagentOrchestrator`（一般不直接用）+ `SUBAGENT_TOOL_NAME` / `DEFAULT_SUBAGENT_MAX_CONCURRENT` + 类型 `SubagentsConfig` / `SubagentRuntimeSettings` / `SubagentHostPort` / `SubagentOrchestrator`。`CreateAgentSessionOptions.subagents?: SubagentsConfig` 传入即向工具表追加 spawn_subagent。`SubagentsConfig.tools` 支持 `ToolDefinition[] | (() => ToolDefinition[])`（与工单 12 的工厂语义一致——子代理完整工具集含启用的 MCP 工具）。
- **审批 waiter 表**：`AgentSession` 内审批等待由单槽改 `Map<requestId, waiter>`（主会话与多个子代理可并行等待）；`respondApproval` 先删后 resolve（重复响应幂等 false）。新增 `pendingApprovals: ApprovalRequest[]`（IPC `sessions:pending-approvals`，UI 切回会话恢复多张审批卡片），`pendingApproval` 保留为单值兼容视图。`ApprovalRequest` 新增可选 `subagentId`。
- **SessionEvent 新增**：`subagent-queued` / `subagent-start` / `subagent-tool`（phase: call|result）/ `subagent-report`（含 ok 标记）；子代理的命令审批复用标准 `approval-request`/`approval-resolved`（subagentId 区分）。
- **持久化**：子代理内部工具调用不落库（进度仅事件流实时可见）；最终报告随 spawn_subagent 的 `tool_calls` 记录的 output 持久化（重启恢复嵌套卡片的数据源）。无新表。
- **IPC 新增**：`subagent-settings:get/set`（set 边界校验 Profile 引用存在性与并发 1-8）、`sessions:pending-approvals`。preload/ui 同步。
- **中断贯穿**：主会话 sendMessage 的 AbortSignal 贯穿子代理运行（模型流 + 工具执行 + 审批等待视为拒绝）；轮末 pump 保证中断时子代理收尾（部分文本保留为报告，无产出则 isError + 中文原因）后才收束主会话。**06 的 InterruptRegistry 已在本次合并的基线中**（e2e:interrupt 全过），无需接口预留。

### 设计决策与偏离说明

- **子代理工具审批门与主会话同构而非共享实现**：两处审批等待的事件出口不同（主会话生成器内 yield vs 子代理经编排器事件缓冲 pushEvent），强行抽公共函数需要把 yield 抽象成回调束，得不偿失；两处都复用 `decideApproval` 纯函数 + `registerApprovalWait` 等待注册，语义矩阵一致（有 readonly/suggest/always 测试双向覆盖）。
- **spawn_subagent 的 permission 为 readonly**：委派本身是元操作，readonly 下放行调研委派（子代理内部工具仍受审批模式约束，AC 6 的语义）。
- **子代理系统提示为固定模板**（不注入 AGENTS.md、不含主会话 system）：spec 的「独立上下文（系统提示 + 任务描述）」直译；子代理与主会话工作区相同。
- **并发上限范围 1-8**：工单只说默认 3 可配；不设上限会允许模型一句回 16 个 spawn 打爆 API（轮次上限内工具调用无个数限制），8 是保守上限，存储层与 IPC 边界双重校验。
- **设置存储明文 JSON**（不走 safeStorage）：内容为 Profile id 引用与数字，无凭据，加密无增益（与 01 的 apiKey 加密、10 的 Tavily key 加密区分）。

### 踩坑记录（对后续工单有用）

- **审批 waiter 必须在 yield 事件之前注册**（04 的坑在新结构下重演了一次）：重构审批块时若先 `yield approval-request` 再 `registerApprovalWait`，生成器挂起在 yield 期间外部 respondApproval 找不到 waiter——决定永久丢失。正确时序：同步注册（返回 promise）→ yield 事件 → await promise。
- **`respondApproval` 先 delete 再 resolve**：resolve 的清理（`promise.finally`）在微任务后执行，同步连续两次 respondApproval 会命中同一个 waiter 返回两次 true；删除移到 respondApproval 内同步做。
- **MockLanguageModelV4 不响应 abortSignal**：真实 provider 的流会随 signal 终止，mock 的 ReadableStream 不会——测中断传导要在 mock 的 start 里监听 `options.abortSignal` 并 `controller.error(new DOMException('Aborted', 'AbortError'))`。
- **try 块内声明的 `let` 在 catch 里不可见**：`aborted` 标记最初声明在 try 内、catch 引用 → ReferenceError 被吞成「子代理永不 settle」，表现为测试 5 秒超时挂起而非报错——这类「等待不结束」的失败先查变量作用域与未处理 rejection。
- **E2E mock 主/子分流要看全量历史**：主模型第二轮请求含第一轮全部原文，分流条件必须「报告标记优先于委派指令」判断，否则第二轮再次命中 spawn 分支造成连环委派（strict mode 双卡片即症状）。
- **设置页 label 子串歧义再现**（10 号工单预告）：子代理区「子代理模型」label 含「模型」子串，`getByLabel('模型')` 在全部 7 条既有 E2E 上 strict mode 命中 2 元素——统一修法 `window.locator('form').getByLabel(...)`（本次连 12 带来的 changes/interrupt/mcp 三条一并修正）。
- **E2E 断言工具表用 `"name":"spawn_subagent"` 精确匹配**：子代理 system 提示文本本身含「spawn_subagent」字样（防递归说明），裸 `includes('spawn_subagent')` 会误伤。

### 测试与验证

- `pnpm typecheck` 三包 0 错误；`pnpm test`：agent-core 245 + desktop 47 + ui 50 = **342 用例全绿**（本工单新增 agent-core 7 + desktop 6 + ui 4 + E2E 一条；其余为合并 12/05/06 带入）。
- E2E 全部 8 条通过：smoke（02/03/10）、commands（07）、approvals（04）、changes（05）、interrupt（06）、compact（08）、mcp（12）、**subagents（13，本工单新增 `test:e2e:subagents`）**。

### 并行合并（merge integration/codexlike-v1 tip 77d6adb：工单 12 MCP + 05 changes + 06 interrupt）

- 集成分支在实现后期前进（12/05/06 三个工单），已合并并确认全绿。冲突面：`tools` 类型取 12 的工厂形式（MCP 启停逐次解析），spawn_subagent 改在 sendMessage 的工具解析点加入；`SubagentsConfig.tools` 同步支持工厂——子代理完整工具集 = 内置 + 启用的 MCP 工具（编排器仍剔除 spawn_subagent）。ipc/preload/SettingsPage/main.ts 两组装配并存。12 带入的三条 E2E 的 label 歧义同款修复（见踩坑）。
