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
- **node-pty ABI 策略（02 票定案）**：官方 node-pty 1.1.0 自带 prebuilds，实测兼容本机 Electron——**默认免 electron-rebuild**；`rebuild:native`（@electron/rebuild devDep）仅当 prebuild 不覆盖平台/版本时兜底（需 VS Build Tools，本机未装未实跑）。真件加载边界：**只在 Electron 运行时加载**——适配器 `node-pty-port.ts` 是 desktop 唯一 node-pty 触点、无静态 import（源码形状单测守住），运行时 createRequire 动态解析；esbuild external + dist vendor 拷贝 + extraResources 下发三重保险；vitest 单测一律注入 fake，真件行为验证入口 `pnpm --filter @codexlike/desktop run smoke:pty`（可随时复跑）与 e2e。agent-core 保持零原生依赖（PtyPort 端口隔离）。
- pnpm 12 的构建脚本白名单在 pnpm-workspace.yaml `allowBuilds`（node-pty 已放行）；新引入带安装脚本的依赖走这里。
- e2e：`packages/desktop/e2e/*.mjs`，开发目录模式加载 desktop 自身 `dist/main.cjs`——主进程源码改动后不重建会让 e2e 验证旧代码（`launchTarget` 有 mtime 守卫）。改 e2e 交互面合入前实跑。终端 e2e 断言走 xterm 可访问性/文本层，不碰 canvas 像素。
- 检查命令直接跑取退出码，不接 `| tail` 管道。
- pnpm workspace：新 worktree 先 `pnpm install --frozen-lockfile`；node-pty 加入后 lockfile 变化，所有 worktree 需重装。
- **worktree 首次 pre-commit 坑（01 票实测）**：`pnpm install` 不构建包产物，直接提交时 desktop build 报 `Could not resolve "@codexlike/agent-core/node"`——先跑一次 `pnpm --filter @codexlike/agent-core run build` 再提交。
- pre-commit 钩子全量跑三包测试（约 2-3 分钟），属既有行为。

## 8. 决策文档

- ADR 0033（本特性决策权威）：`docs/adr/0033-terminal-sessions.md`——取舍节列出全部被拒备选（纯用户终端 / 宿主级组织 / 共存亡 / 消息流内嵌 / 无 TTY / 会话级授权 / 替代前台工具 / 尾部读取 / 全量落库 / spawn cwd）。实现票不得顺手推翻。
- GLOSSARY 词条：「终端会话」「内嵌终端」（与工作区打开器的「终端」严格区分——后者指打开系统终端窗口的外部程序）。
- 相关既有 ADR：0020/0032（rail 收纳与拆页导航）、0021（记录落库纪律）、0004（工作区边界——spawn cwd 被拒的依据）、0018（RailPanel）。

## 9. 本特性已落地符号（随票合入更新）

- **票 01（集成 `fd6072e`）**：`agent-core/src/terminal/`——`pty-port.ts`（`PtyPort` / `PtyProcess` / `PtySpawnRequest` / `PtyExitEvent` / `PtySize`）、`types.ts`（`TerminalSessionRecord` / `TerminalSpawnRequest` / 域常量：上限 5、1MiB、快照 64KB、killAll 超时）、`manager.ts`（`createTerminalSessionManager`：spawn / write / resize / read(waitMs) / kill / killAll / session / sessionsFor / discard / onEvent(terminal-started|exited) / onSessionData / bufferedOutput）。单测 `tests/terminal/terminal-session-manager.test.ts`（32 用例）。导出：根出口 type-only（index.ts），实现与常量走 `/node`（node.ts）。
- **票 02（集成 `2c1fed8`）**：desktop `src/terminal/node-pty-port.ts`（`createNodePtyPort` 无参工厂；可选注入面 nodePty / platform / spawnImpl / fileExists / gitBashPath）；单测 `tests/terminal/node-pty-port.test.ts`（23 用例，含「源码无静态 import」形状守卫）；冒烟 `scripts/pty-smoke.mjs`（`smoke:pty` script）；构建链接入：`scripts/build-options.mjs`（external += node-pty）、`scripts/dist.mjs`（vendor 拷贝）、`electron-builder.template.yml`（extraResources）、`pnpm-workspace.yaml`（allowBuilds）。
- **票 03（集成 `d048e08`）**：desktop `src/terminal/terminal-session-ipc.ts`（IPC `terminals` 命名空间注册：create/write/resize/kill/subscribe/unsubscribe/session/list-for + `terminals:session-data` 字节流专用通道）、`session-env.ts`（env 白名单，与 agent-core ENV_ALLOWLIST 同款双处维护待整合）、main.ts whenReady 装配区 `terminalSessions` 单例（browserManager 之后）、preload.ts terminals 命名空间、shared/ipc.ts IPC.terminals、task-ipc.ts `pushTaskEvent`（事件桥接，延续水位+全窗口）、live-tasks.ts `TERMINAL_EVENT_TYPES`（stopped 过滤 + terminalAt 守卫）、agent-core task/types.ts terminal-started/exited 变体、ui task-view.ts no-op case（04 票替换为真实归并）+ dev/browser-stub.ts terminals stub。测试：terminal-session-ipc / terminal-events-live-tasks / terminal-preload 三文件 8 用例。
- **票 05（集成 `0792c15`）**：agent-core `src/tools/terminal-sessions.ts`（`createTerminalSessionTools`：spawn_terminal/terminal_write/terminal_read/terminal_kill；`command` 字段命名接 commandOfToolInput 零改动审批；wait 按 250ms 分片可中断）；`tools/builtin.ts` `terminalSessions` 可选注入面；`tools/terminal.ts` 仅 `filterEnv` 加 export；node.ts 导出。测试：tests/tools/terminal-sessions.test.ts（27）+ tests/terminal/terminal-sessions-task.test.ts（8，mock model 任务循环，fake pty 时序锚点手法）。desktop main.ts 接线（单例传入 createBuiltinTools）。**ADR 0033 已澄清**：read「任意会话」= 本任务内任意来源/状态，跨任务拒绝。
- **票 04（集成 `b7797ba`）**：ui `components/TerminalRailPanel.tsx`（RailPanelBody 拆页导航，**外部 focus 入口待 06 票加 focus prop**）、`components/TerminalSessionView.tsx`（xterm.js 6.0 UMD **动态 import、顶层零运行时依赖**——触碰相关文件沿用此形态）、`lib/terminal-status.ts`（口径单一来源）、`lib/terminal-theme.ts`（语义 token→xterm palette，MutationObserver 随主题翻转）、`lib/use-terminal-sessions.ts`（list-for 初始 + terminal-* 增量 + 切任务重建）；RailPanel 第四 tab、MessageStream terminal 段渲染 null（06 票换标记行）、task-view.ts TerminalSegment 真实归并（幂等 upsert/终态不可回退守卫）。测试：terminal-status(13)/terminal-theme(4)/terminal-rail-ui(9)/terminal-rail-switch(19)/task-view(+5)。xterm 依赖 @xterm/xterm 6.0.0 + @xterm/addon-fit 0.11.0。e2e 断言 testid：rail-tab-terminals / terminals-panel / terminals-panel-body / terminal-rail-detail-header(-back/-title/-kill) / terminal-xterm-host。
- **票 07（集成 `83c9bf6`）**：desktop `src/terminal/terminal-lifecycle.ts`（settleTerminalSessionsOnStartup 等收尾函数）；application-exit.ts ExitState.terminalSessions + terminalSessionCount；exit-ipc.ts 透传；task-ipc.ts archive handler **async 化**（先杀等 exit 再写归档，拒绝变 rejection）；main.ts 四处接线（releaseResources 内 killAll 处留【08 票衔接挂点】注释锚、whenReady 启动收尾区 settleTerminalSessionsOnStartup 调用处同款锚）；ui ApplicationExit.tsx confirming 终端提示行（`exit-terminal-note`）+ ArchiveTerminalDialog.tsx（`archive-terminal-dialog`/-cancel/-confirm）。测试：terminal-interrupt / terminal-lifecycle / exit-terminal-barrier / exit-terminal-tray / archive-terminal / terminal-lifecycle-ui 六文件 +39 用例。**已知 flaky**：sidebar-archive e2e（基线 4 跑 1 败，lastUsedAt 并列排序时序敏感）。**积压**：项目移除路径的孤儿会话收尾提示（aliveSessionCount 只数现存任务归属）。
