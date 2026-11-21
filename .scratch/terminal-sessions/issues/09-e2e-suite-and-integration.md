# 09: e2e 场景套件 + 全量集成验证

**What to build:** 终端特性的 e2e 收口与全仓集成验证。新增终端 e2e 场景（真 node-pty）：新建会话 → 手敲命令输出可见 → agent 侧 spawn / read / write（含审批弹窗路径）→ kill → 重启后快照回看 → 退出屏障提示 → 托盘驻留语义。断言走 xterm 可访问性/文本层，不依赖 canvas 像素。跑全仓 test / typecheck / 实跑全部终端相关 e2e 收口，更新 notes.md 中已漂移的指针。文件指针见 notes.md §7。

**Blocked by:** 05, 06, 07, 08。

**Status:** done

- [x] 终端 e2e 场景文件落地并全绿（真 pty、覆盖上述全部路径）
- [x] 既有 e2e 场景回归（rail 结构变化影响的场景：rail 相关 + focus 相关）
- [x] 全仓 test / typecheck 绿（desktop 与 ui，含 agent-core build 前置）
- [x] notes.md 指针校准（本票链合入后的符号漂移修正）
- [x] 票面 Comments 记录最终基线（用例数、场景清单）

## Comments

- 【02 票衔接】dev 目录模式 e2e 前置 `pnpm --filter @codexlike/desktop run build`（mtime 守卫会拦旧产物）；node-pty prebuild 兼容本机 Electron，worktree `pnpm install --frozen-lockfile` 即可（allowBuilds 已放行 node-pty 安装脚本）。打包模式 ABI/vendor 已被 dist.mjs + extraResources 覆盖，冷启动可用 `smoke:pty` 复验。
- 【02 票衔接】终端 e2e 的输入注入走渲染端 xterm → IPC write 链路，**不直碰 node-pty**；kill 后子进程树死透如需断言，参照冒烟的 tasklist 精确查询法（票02 Comments）。
- 【既有基线】02 落地后 desktop 532 用例 / 1 skipped；ui 623；agent-core 625——回归对照用。已知既有损坏：subagent-interrupted e2e 在 main HEAD 即失败（与终端无关，勿在本票链顺手修，单独诊断）。
- 【03 票衔接】desktop build 已实跑、dist/main.cjs 可加载 node-pty（external 路径不变）；e2e 断言可用的通道清单与 preload API 见 03 票 Comments（`window.codexlike.terminals` + `onTaskEvent` 信封的 terminal-started/exited）；事件三任务态（idle/终态/stopped）下发行为已被单测覆盖，e2e 聚焦 GUI 链路。
- 【05 票衔接】agent 侧 e2e 时序手法：复用 `tests/terminal/terminal-sessions-task.test.ts` 的 fake pty 时序锚点（doStream 调用序号注入输出/exit）——**setInterval 竞速会静默输给任务循环，不要用**（05 票踩坑）。read 边界口径：任意会话=本任务内任意来源/状态（跨任务拒绝，ADR 0033 已澄清），e2e 断言按此口径。四工具参数/返回形状见 05 票 Comments。
- 【04 票衔接】e2e 断言入口 testid 清单：`rail-tab-terminals` / `terminals-panel` / `terminals-panel-body` / `terminal-rail-detail-header`（含 back/title/kill）/ `terminal-xterm-host`（xterm 可访问性/文本层断言挂这里）；rail 系 e2e（changes/subagents/subagent-recovery-review/width-tiers）已回归通过可作对照基线；subagent-interrupted 为既有损坏（main HEAD 即失败），本票链不修不背。
- 【07 票衔接】生命周期断言面：退出确认卡终端行 `exit-terminal-note`（「N 个终端会话将关闭。」仅 N>0 渲染）；归档确认卡 `archive-terminal-dialog` / `archive-terminal-cancel` / `archive-terminal-confirm`（取消不发起 archive IPC；确认后宿主先杀等 exit 再写归档）；`tasks:archive` 已 async。**既有 flaky**：sidebar-archive 基线 4 跑 1 败（lastUsedAt 并列排序时序敏感）——收口时失败重跑或单独诊断，不计本票链回归。
- 【08 票衔接】重启恢复断言路径：重启后内存注册表空 → `tasks:view` 并行字段 `view.terminals` 下发已退出记录（含 snapshot）→ rail「已退出」组恢复（mergeTerminalRecords，live 优先）→ 点开详情走 subscribe 恢复兜底（快照作 buffered 回放，崩溃残留行回放空缓冲）；归档任务重启后已退出组照常恢复。**hook 扩展纪律**：useTerminalSessions 参数靠内容键守卫（sessionId:status:exitedAt），勿以引用进 effect 依赖（曾 OOM 假红）。**flaky 治理清单**：sidebar-archive（07 票）+ search-ipc 单测一例负载敏感超时（08 票）——均非终端路径引入，失败重跑或单独诊断，不计本票链回归。
- 【06 票衔接】标记行与直跳断言面：`terminal-stream-marker`（li）/ `terminal-stream-marker-toggle`（button，`data-terminal-state`）；focus 直跳 = 切 `rail-tab-terminals` + 落 `terminal-rail-detail-header`（「不落列表页」锚：`terminal-rail-back` 存在 + `terminal-rail-item` 不渲染）；工具卡摘要形状见 06 票 Comments。**TerminalFocus 字段名 {sessionId, seq} 与 SubagentFocus {id, seq} 不同**。e2e 造数据会话 name 必须唯一。
- 【06 票补充既有红】message-order（「两段思考应交错独立存在」只到一段）与 subagent-interrupted（「已中断」activity 等待超时）经 stash 基线对照确认本机基线即红——与 flaky 清单并列：失败重跑或单独诊断，不计本票链回归。另有钩子三包并行负载时序敏感记录（08 关单提交两轮倒在 desktop workbench-ipc / agent-core fake-pty 各一例，三包单独复跑全绿，见 d1a043c 提交说明）。
- 【落地】分支 ts-09-e2e-suite（worktree wt-terminal-09）。变更：新增 e2e 场景 terminal-sessions.mjs / terminal-restart-recovery.mjs + 共享小工具 terminal-helpers.mjs（scripts `test:e2e:terminal` / `test:e2e:terminal-restart`，desktop+root 注册并入 all 链尾）；**两处产品缺陷最小修复**（见下）；ui live-task 回归用例 +1；notes.md §7/§9 校准。agent-core 670 / desktop 571+1skip / ui 692 全绿（单轮全过），typecheck 0 错，node-pty 冒烟 6/6。
- **产品缺陷修复 ①（ui lib/live-task.ts）**：receiveLiveEvent 空闲任务丢弃 terminal-* 事件——宿主侧 live-tasks 三关口（空闲/终态/stopped）都显式放行终端事件（03 票注释「任务级状态快照事件」），渲染端第四关却按执行增量拦掉：用户手开会话的消息流标记行不出现（rail 直连 onTaskEvent 不经此闸门，两处呈现分裂）、空闲期 kill 后标记行停留 running。修复与 queue-changed 同口径放行（按水位接续，宿主桥 pushTaskEvent 经 ensureExecution 挂当前现场 executionId 必匹配），live-task.test.ts 补「空闲接续 + kill 推进 + 乱序 started 不回退」用例。
- **产品缺陷修复 ②（desktop main.ts 装配）**：terminalSessions 工具选项漏传 `env`（05 票装配遗漏，顶层 env: process.env 只给了 run_terminal_command）——agent spawn_terminal 拿到**空环境块**，node-pty 对空 env 的 CreateProcessW 间歇性报「Cannot create process, error code: 87」（ERROR_INVALID_PARAMETER），且侥幸成功时子进程也无 PATH。e2e 临时诊断（spawn 失败打印请求现场，envKeys:[] 定案，已还原）。修复：装配点补 `env: process.env`。
- **e2e 新场景结果**：terminal-sessions（用户侧主链路：rail 第四 tab 初始态/＋新建会话/xterm 手敲命令输出可见/kill 不弹确认→原位只读回看→「已退出」组；agent 侧链路：spawn 审批卡显示命令原文→标记行动词摘要→点击直跳详情页（不落列表页：back 存在 + rail-item 不渲染 + aria-selected 自动切）→terminal_read 增量含初始命令输出（wait 阶段同 call 前缀重试——shell 启动真实耗时下早读只有 conpty 转义序列，即真实模型「读到再继续」行为）→read 用户侧已退出会话（read 边界=本任务内任意来源/状态）→kill 审批卡→exited 推进；四工具结果回填请求体验证）4 连跑绿；terminal-restart-recovery（退出屏障 exit-terminal-note「1 个终端会话将关闭。」取消→会话存活/确认→进程正常退出快照落库→重启「已退出」组从库恢复→只读回看快照输出可见→全程零模型请求（重放对照）→归档确认卡：文案断言 + Escape 取消不归档会话存活 + 确认先杀后归档落账）复跑绿。
- **断言手法（notes §7 已记）**：xterm 6.0 默认 DOM renderer，输出文本在 DOM——`.xterm-rows > div` 行节点 textContent 精确匹配（输出值经 $((算术)) 不出现在键入原文，区分回显行与输出行）；输入注入走键盘事件→xterm onData→IPC write，不直碰 pty；会话内命令需先聚焦 `.xterm-helper-textarea`（右栏重渲染会吞点击焦点，兜底 evaluate focus）。
- **既有场景回归（42 场景全量，证据 /tmp 日志 + stash 基线对照）**：all 链跑到 mcp 停（链语义首败即停），其余逐个补跑全覆盖。绿 35 场景：credential-durability/smoke/acceptance/commands/browser/approvals/interactions/changes/interrupt/compact/worktree/subagents/sidebar-task-preview/membership/theme/skills/thinking/subagent-thinking/process-segments/work-plan/live-tasks/exit-recovery/launch-state/launch-state-target/entry-consistency/width-tiers(首轮红重跑绿——负载敏感)/reasoning-recovery/subagent-recovery-review/subagent-legacy-record/subagent-work-plan/scroll-following/external-links/workspace-opener/terminal-sessions/terminal-restart-recovery。红 7 场景全部 stash 基线（干净 tip 30a754e）复跑同样红=既有红非本票引入：message-order、subagent-interrupted（票面既有基线红，复现）；mcp（uncheck 点击后状态回弹，「逐工具启停开关真实切换」步，本机基线即红，需单独诊断）；projects-sidebar（「项目草稿切换不丢」untilDraft 超时）、task-search（「项目折叠隐藏日常列表」）、persistent-workbench（waitForFunction 30s 超时）、window-controls（原生拖拽断言，CODING_STANDARDS 已注明前景遮挡敏感）、sidebar-archive（07 票已记 flaky，本机连续 3 跑 3 败比票面记录恶化，一并交 flaky 治理）。
- **遗留观察（不在本票修，交编排者裁决）**：①重启后进程内 name 计数器重置，新会话与恢复行可同名「git-bash · 1」（cosmetic；e2e 已按 data-terminal-state 过滤规避，重命名/跨重启续号留后续票）；②mcp/projects-sidebar/task-search/persistent-workbench/window-controls/sidebar-archive 六场景本机基线红超出票面已知清单（08 票 flaky 治理清单建议扩充），其中 mcp 失败点为设置页工具开关状态回弹、window-controls 为原生拖拽前景遮挡，均与终端无涉；③agent spawn 空 env 已修，但 node-pty 对空 env 报 87 的健壮性本身未加固（现网路径 env 恒非空，留观）。
