# Notes：终端会话——探索事实与指针

调研于 2026-11-21（grilling/spec 同轮）。定位写符号名配 grep 提示，不写行号（行号随票合入漂移）。各实现票开工前通读本文件，避免重复探索。

## 1. 现有命令执行的形状（被 spec 共存保留，不改）

- 工具名 `run_terminal_command`，工厂 `createTerminalTool`，类型 `TerminalShell = "git-bash" | "powershell" | "cmd"`——全在 `packages/agent-core/src/tools/terminal.ts`（grep `createTerminalTool`）。纯前台同步：spawn 后 stdout/stderr 收进内存字符串，`child.on("close")` 一次性 resolve；输出上限 `maxOutputLength = 30_000`；超时 `killTree` 强杀。
- **`killTree`（同文件）是现成的 Windows 进程树终止实现**（taskkill /T /F）——终端 kill 注册表可参考，但 node-pty 的 kill 路径不同，需单独验证子进程树覆盖。
- `buildSpawnPlan` / `filterEnv`（env 白名单）在同文件，可复用。
- 工具组装点：`createBuiltinTools`（`packages/agent-core/src/tools/builtin.ts`）。
- 宿主注入 env/shell/超时：desktop `src/main.ts` 工具装配区（grep `createTerminalTool`）；设置存储 `packages/desktop/src/terminal/terminal-settings-store.ts`（`TerminalSettings`：shell + commandTimeoutSeconds + maxCommandTimeoutSeconds）；IPC 先例 `terminal-settings-ipc.ts`；UI 校验 `packages/ui/src/lib/terminal-settings.ts`。
- 中断现状：`InterruptRegistry`（`packages/desktop/src/tasks/interrupt-registry.ts`，Map by taskId）→ IPC `tasks:interrupt` → abort 信号贯穿 streamText 与工具子进程树。**没有任何 per-entity kill**——终端按 sessionId 的新注册表是全新缺口，形态仿此文件。

## 2. 子代理——整套可照搬的「实体模式」先例

核心全在 `packages/agent-core/src/task/subagent.ts`（grep `createSubagentOrchestrator`）：

- **立即返回占位 + 内存 Map 注册**：`spawn_subagent` 工具 execute 即返回、entry 入 Map、骨架行落库、发 queued 事件。
- **宿主端口**：`SubagentHostPort` + `SubagentsConfig`——agent-core 定义接口、desktop 装配注入的装配范式（main.ts 装配区 grep `SubagentsConfig`）。终端四工具 + PtyPort 照此。
- **审批门**：`gateAndRun`（复用主任务 `decideApproval` + 交互通道）——terminal spawn/write 的逐次审批照此。
- **并发上限 FIFO**：`DEFAULT_SUBAGENT_MAX_CONCURRENT`、`startQueued`——终端上限 5 的拒绝/排队逻辑可对照（终端拒绝即可，不排队）。
- **不是真后台**：主任务轮末 `orchestrator.wait()` 阻塞（agent-task.ts 接入点 grep `deferredDelegations` / `wait()`）——**终端绝不能挂这里**；接入点只借鉴工具表合并方式。
- 持久化三表模式：`packages/agent-core/src/task/persistence.ts`（`subagents` / `subagent_messages` / `subagent_tool_calls`；`insertSubagent` / `updateSubagent` 动态列 patch）。终端的 `terminal_sessions` 单表照「骨架行 + 状态推进」写法，`CREATE TABLE IF NOT EXISTS` 无迁移。
- 类型与事件：`packages/agent-core/src/task/types.ts`（`SubagentStatus` / `SubagentRecord`；TaskEvent 联合类型里 `subagent-*` 事件段）——`terminal-*` 事件加在同一段。
- 恢复快照：`TaskManager.subagents(taskId)`（`agent-core/src/task/manager.ts`）一次读出归组，desktop `live-tasks.ts` view 载荷并行字段下发（grep `subagents`）。

## 3. 宿主级常驻管理器先例

- **browser-manager 在 agent-core**：`packages/agent-core/src/browser/`（grep `browserManager` / `BrowserManager`），含生命周期管理（spawn / idle / dispose）。`TerminalSessionManager` 的结构先例 + 测试先例：
  - `packages/agent-core/tests/browser/browser-manager-lifecycle.test.ts`
  - `packages/agent-core/tests/browser/browser-tools.test.ts`（工具走 fake 依赖的测试结构——PtyPort fake 照此）
- desktop 宿主级装配先例：main.ts 的 mcpService / browserManager 装配区。

## 4. 事件通道（渲染端链路）

链路：agent-core TaskEvent → desktop `src/tasks/live-tasks.ts` `accept`（**水位/活动态管理；stopped 过滤有事件类型白名单——terminal 事件必须加进白名单**，grep 白名单数组）→ `task-ipc.ts` emit（`IPC.taskEvents`）→ preload `onTaskEvent` → `WorkspacePage.tsx` 订阅 → `packages/ui/src/lib/task-view.ts` `applyTaskEvent` 归并进消息段流。

- ui 数据模型先例：`task-view.ts` 的 `SubagentSegment` / `appendSubagentTurnDelta` / `subagentFromSnapshot`——终端段类型与快照重建照此。
- 测试先例：`packages/ui/tests/task-view.test.ts`（事件归并）。

## 5. 右栏 rail（UI 落点）

- `packages/ui/src/components/RailPanel.tsx`：三 tab 容器 + tab 徽章（运行中+排队计数）+ focus 信号（`setSubagentFocus` → 自动切 tab）。加第四 tab 照此结构。
- `packages/ui/src/components/SubagentRailPanel.tsx`：ADR 0032 拆页导航完整实现——`SubagentRailPanelBody`（状态分组列表页：组头 accent 竖条 + 计数章 + 富行两行式）与 `SubagentDetail`（顶栏返回 + 状态点 + 已用时定格 + ‹ › 翻页 + 滚动跟随）；`StatusDot` / `Elapsed` 小件可复用。**终端列表页/详情页照此结构另写组件，不做参数化抽象**（两处状态语义不同：agent 轮次 vs PTY 输出，强行参数化会泄漏）。
- 状态口径单一来源先例：`packages/ui/src/lib/subagent-status.ts`——终端建同款 `terminal-status.ts`。
- 消息流标记行直跳：`SubagentStreamMarker.tsx` + WorkspacePage focus 装配——terminal 工具卡点击直跳照此。
- SSR 测试先例：`packages/ui/tests/subagent-rail-ui.test.tsx`（列表页 SSR）/ `subagent-rail-switch.test.tsx`（拆页交互）/ `subagent-view.test.ts`。**xterm.js 交互区是 canvas，SSR 只测列表页与详情壳**。
- 主题：语义 token（ADR 0006/0028，`packages/ui/src` grep theme/tokens）——xterm 主题对接 token。

## 6. 生命周期挂点

- 退出屏障：desktop lifecycle（grep `exit-flush` / `ExitBarrier`），测试先例 `packages/desktop/tests/lifecycle/exit-flush.test.ts` 与 `close-to-tray.test.ts`——终端检查项加进屏障流程；托盘驻留（关主窗口不触发屏障）语义已在 close-to-tray。
- 任务归档：grep `archive`（task-ipc / manager）——归档时存活会话提示后关闭的挂点。
- 重启收尾：启动时把残留 running 标记 interrupted 的收尾逻辑（grep `interrupted` 收尾）——终端对应动作是「快照已退出会话 + 清空注册表」（重启后不恢复）。

## 7. 构建与测试纪律（AGENTS.md 既有 + 本特性新增）

- desktop/ui 的 `test` / `typecheck` script 已前置 agent-core build——agent-core 改源码后直接跑会假红（旧 dist）。
- **新增：node-pty 原生模块需 electron-rebuild**——desktop 构建链要补该步骤；agent-core 不得依赖 node-pty（PtyPort 端口隔离，fake 驱动单测）。
- e2e：`packages/desktop/e2e/*.mjs`，开发目录模式加载 desktop 自身 `dist/main.cjs`——主进程源码改动后不重建会让 e2e 验证旧代码（`launchTarget` 有 mtime 守卫）。改 e2e 交互面合入前实跑。终端 e2e 断言走 xterm 可访问性/文本层，不碰 canvas 像素。
- 检查命令直接跑取退出码，不接 `| tail` 管道。
- pnpm workspace：新 worktree 先 `pnpm install --frozen-lockfile`；node-pty 加入后 lockfile 变化，所有 worktree 需重装。

## 8. 决策文档

- ADR 0033（本特性决策权威）：`docs/adr/0033-terminal-sessions.md`——取舍节列出全部被拒备选（纯用户终端 / 宿主级组织 / 共存亡 / 消息流内嵌 / 无 TTY / 会话级授权 / 替代前台工具 / 尾部读取 / 全量落库 / spawn cwd）。实现票不得顺手推翻。
- GLOSSARY 词条：「终端会话」「内嵌终端」（与工作区打开器的「终端」严格区分——后者指打开系统终端窗口的外部程序）。
- 相关既有 ADR：0020/0032（rail 收纳与拆页导航）、0021（记录落库纪律）、0004（工作区边界——spawn cwd 被拒的依据）、0018（RailPanel）。
