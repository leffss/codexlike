# 08: 完成退出确认与重启恢复

**What to build:** 用户真正退出应用时若有执行或待处理交互先得到提示；取消退出则工作继续，确认退出则任务中断。重启恢复项目、会话、历史、草稿、阅读位置和设置，不自动续跑或重放任何工具。

**Blocked by:** 02 — 切换会话时完整保留执行现场；03 — 持久保存草稿、阅读位置与会话设置。

**Status:** completed

**Spec:** [会话工作台重构规格](../spec.md)

## Acceptance criteria

- [x] 真正退出应用前检测所有项目及独立会话的未完成执行和待回应请求，不只检查当前选中会话。
- [x] 存在未完成工作时先提示；用户取消退出后应用保留，任务和等待继续，不能在确认前先取消任务。
- [x] 用户确认退出后停止主执行及所属子代理，取消未完成用户交互，并保存中断状态及已完成历史。
- [x] 已准备的普通输入、新建草稿、问答草稿、阅读位置和会话偏好在受控退出前完成持久化；异步保存不能因为窗口销毁而静默丢失。
- [x] 重新启动同一数据目录后恢复项目、独立会话、项目会话和既有历史，以及票 03 的持久工作现场。
- [x] 上次未完成执行显示为已中断，不错误恢复为仍在运行或可继续等待的实时任务；用户可通过明确的后续发送继续处理。
- [x] 重启本身不触发模型请求、不执行工具、不重放旧命令，也不把已完成工具当作待重试任务。
- [x] 旧审批和问答保留历史及可用草稿信息，但失效请求不可提交为有效执行响应；不从旧审批形成永久授权。
- [x] 进程异常结束后残留的执行中或等待记录，在下次启动也被归一为中断，不假装恢复执行检查点。
- [x] 不同退出入口遵循同一确认与中断流程；不因后台会话、折叠项目或搜索页面而漏掉确认。
- [x] 应用不引入真正退出后的后台常驻机制，操作系统或应用重开不能自动启动未完成任务。

## Verification

- [x] 关闭并重新打开真实 SQLite 文件，验证中断状态、草稿与偏好；不能仅复用内存 store。
- [x] 真实 Electron E2E 启动慢速执行与等待交互，分别验证取消退出、确认退出，以及使用同一数据目录的新进程启动。
- [x] 本地模型服务记录请求计数，临时目录记录工具副作用，证明重启后既没有自动模型请求也没有工具重放。
- [x] 覆盖独立会话与项目会话并行、后台等待、子代理联动及异常终止后重新打开。
- [x] 用真实点击和滚动验证恢复阅读位置；静态渲染或 renderer reload 不能替代本票的进程重启测试。

## Scope boundary

本票只恢复持久工作现场，不恢复未完成执行上下文，不为强制终止时尚未写入的瞬时内容作不可能保证。所有已确认保存的历史与状态必须可靠读取并正确表示。

## 交付记录（2026-11-11）

仅在 `ai-agent-wt-session-workbench-08` / `feat/session-workbench-08` 实施，起点 `4085418`；先核 status/log/merge-base，依赖和产物均在本工作树。交付前合入独立复验后的票07稳定 `f042021`（包含01–07），保留 `sessions.setProject` / `projects.remove`、live/search/sharing、首次发送项目复查与requestId墓碑、workbench.remove墓碑及Compact唯一executions占位。未改其他票或索引。

### 公开接口与行为

- 新增独立 `desktop/src/lifecycle/application-exit.ts` 协调器与 `exit-ipc.ts` Electron接线；窗口close、应用before-quit共用流程。`application.exitState/onExitState/answerExit/flushed` 是带退出尝试id的类型化握手，过期确认/保存应答不能完成新尝试，只有主窗口可回应。main/preload/App只最小接线，不搬动工作台页。
- 执行宿主返回退出运行端口，活动集合覆盖所有会话、待回应请求、首次发送准备、异步send、Compact与后台主/子代理，复用原executions/interrupts。提示期间阻止新start/send/compact/交互响应；已接收且正在异步准备的意图暂停，取消退出后恢复，而非提前取消。确认且保存成功后才拒绝尚未启动意图、abort全部执行并等待主/子执行清理和历史落库。
- 全局 `ApplicationExit` 覆盖工作台、搜索和设置页；先同步设置inert冻结编辑，再await票03原 `WorkspaceState.flush()`。失败显示错误、恢复编辑、保留运行与等待，不关闭窗口。仍沿唯一workbench revision/requestId通道，无第二存储。
- 窗口销毁后才在will-quit关闭SQLite，避免终态刷新IPC撞已finalize statement。MCP/浏览器收尾兜底仅在保存及主/子执行排空以后启用，不在确认前或flush失败时强退。
- Core Compact接受可选AbortSignal，与send共用宿主执行占位；生成期间持久标记活动，取消保留旧历史并记录中断。重启归一残留状态及pending交互，复用既有aborted消息记录与live activity恢复「已中断」，二次重开幂等。旧交互只读，问答草稿可查看而不可提交，不恢复授权或执行检查点；运行期思考仍不扩大落盘。

### 红—绿与实际验证

所有检查命令直接取得退出码，无tail管道、无共享dist、无全局加超时或绕hook。

- 宿主 `pnpm --filter @codexlike/desktop test tests/sessions/exit-recovery.test.ts` 依次真实红灯：缺退出模块；重开outcome为null；Compact跳过确认进入flushing；退出提示提前拒绝准备中的start。逐片实现后6测试通过。覆盖项目慢任务+独立审批、取消继续、flush前不停止、失败和旧回执、迟到启动竞态、Compact取消保留历史、真实文件SQLite关闭重开与异常残留幂等恢复。
- `exit-recovery` + `workbench-ipc` 整合31测试通过，保留07归属/移除/首次发送/Compact原子保护。全量初测仅旧交互恢复用例断言“仍只有1条消息”与新增中断标记冲突；调整为保留原消息且追加aborted记录，原零模型、pending取消及拒绝旧响应断言保留。
- `pnpm typecheck`、`pnpm build` 通过；整合全量 `pnpm test` 初次638通过（Core416/Desktop120/UI102），随后增加准备阶段取消退出用例，最终提交钩子再次运行完整检查，最终数量以提交结果为准。既有Windows符号链接EPERM分支不声称通过；构建仍有既有CJS/import.meta、第三方PURE及包体积警告。
- 新 `pnpm --filter @codexlike/desktop test:e2e:exit` 已纳入 `test:e2e:all`。真实Electron首先复现关闭窗口立即销毁、无确认的红灯；接线后完整通过。3次真实进程启动，真实点击新入口/发送/审批等待/问答草稿/退出、真实鼠标滚动及同目录重开；后台项目折叠及搜索中关闭仍提示；取消后模型继续增量且子代理连接未断，确认后主/子代理中断。
- 退出E2E本地模型请求计数+真实terminal追加文件，证明受控退出和Windows `taskkill /PID <测试pid> /T /F` 强制终止后重开都无请求、无工具重放。旧问答/审批经公开IPC均拒绝，旧always不形成永久授权；只有显式后续发送才产生新模型请求。持久的普通/项目新建/独立新建/问答草稿、思考设置、项目与独立历史及实际阅读位置均恢复。
- 退出E2E在真实workbench IPC边界注入一次写失败和延迟应答（仍由真实SQLite写入）：保存失败显示错误且任务不停止；延迟应答时编辑已inert、窗口保留、子代理继续，释放后才退出；最后输入重开完整。测试早期清理只杀调试包装进程导致残留Electron文件锁，已改异常场景为本测试进程树强杀、失败清理走app.exit；不更改权限。
- 整合后 `test:e2e:membership`、`test:e2e:persistence`、`test:e2e:search`、`test:e2e:live-sessions`、`test:e2e:sidebar`、`test:e2e:worktree`、`CODEXLIKE_E2E_INTERACTION_CASE=queue test:e2e:interactions` 均通过。首次串行组合membership在首个settings-open前出现一次page closed，未改代码/超时，独立重跑该项及后续组合通过，保留此失败记录。
- 未运行完整 `test:e2e:all`、dist/packaged；旧create-session-confirm前置适配由09统一，未删除旧有效断言。未覆盖操作系统关机事件或renderer崩溃后无法应答flush的恢复UI，不对硬杀前尚未落盘瞬态提供保证；已落库状态在异常重启场景验证。
