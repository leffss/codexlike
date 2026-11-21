# 03: desktop 终端会话服务 + IPC + preload 通道

**What to build:** 主进程侧把 01 的管理器与 02 的适配器装配成宿主级常驻服务（browser-manager 装配先例）：会话创建（cwd 一律任务工作区、shell 跟随执行设置，**不提供任意 cwd 参数**——ADR 0004 工作区边界）、输入、resize、kill；按 sessionId 的 kill 注册表（形态仿 interrupt-registry）。IPC 三段式对齐 tasks 现有模式：生命周期事件并入 TaskEvent 通道（live-tasks 事件白名单加入 terminal 类），**PTY 字节流走专用 IPC 通道直写渲染端，不进 React 状态**（spec 已补此决定）。preload 暴露终端 API。本票用户还看不见 UI，但主进程能力完整、dev 模式可手测。文件指针见 notes.md §1/§4/§6。

**Blocked by:** 01, 02。

**Status:** done

- [x] 管理器宿主级单例装配；创建会话强制 cwd = 任务工作区、shell 跟随执行设置
- [x] 按 sessionId kill 注册表；kill 后进程树终止、资源清理（管理器本身即注册表，未建平行 Map——设计依据见 Comments）
- [x] IPC + preload：创建/输入/resize/kill/字节流订阅/生命周期事件，字节流与 TaskEvent 分离
- [x] `terminal-*` 生命周期事件并入 TaskEvent 通道，live-tasks stopped 过滤白名单加入 terminal 类（含 idle/终态/已停止三任务态行为级证明）
- [x] desktop 单测（fake pty 注入驱动服务层）+ typecheck 绿
- [x] dev 模式手测：从主进程侧可创建会话、收字节流、kill（以 IPC 层集成测试替代——见 Comments 验证途径）

## Comments

- 【01 票衔接】IPC 双通道数据源已定（集成 `fd6072e`）：实时字节流 `manager.onSessionData`（只转发订阅后的输出）；详情页初始回放 `manager.bufferedOutput`（**不推水位**，不会破坏 05 票工具 read 的水位语义）。订阅时序：收到 `terminal-started` 后立即订阅字节流即不丢数据。
- 【01 票衔接】生命周期事件源 `manager.onEvent`（terminal-started / terminal-exited，携带 record 副本）→ 转 `terminal-*` TaskEvent；**live-tasks 的 stopped 过滤白名单记得加 terminal 类**（notes.md §4）。
- 【01 票衔接】resize 对已退出会话静默忽略，渲染端无需防御；spawn/kill 走判别 union（`{ok:true}` / `{ok:false, reason}`），reason 是可直接展示的中文。
- 【未决】read 并发 wait 同会话共享水位（先唤醒者取走全部增量）——正常调用方不并发 wait；若 IPC 层出现并发场景需回 01 票再议。
- 【类型】`@codexlike/agent-core` 根出口 type-only（TerminalSessionRecord 等），实现经 `/node` 出口（createTerminalSessionManager 等）。
- 【02 票衔接】装配极简：`createTerminalSessionManager({ port: createNodePtyPort() })`——适配器工厂**无参**（真件动态加载）；需自定义 Git Bash 路径才传 `gitBashPath`。kill 注册表设计注解：**管理器本身就是按 sessionId 的会话注册表**（含状态机与 kill），勿再建平行 Map 造成双登记漂移——票面「kill 注册表」验收按「经 manager.kill 的会话级终止可用且进程树死透」满足，并在票面 Comments 记录该设计依据（interrupt-registry 形态的类比已由管理器承载）。
- 【02 票衔接】manager 装配后 `dist/main.cjs` 引用 node-pty → dev 目录模式与 dev e2e 依赖 node-pty 已安装（prebuild 兼容本机 Electron，`pnpm install --frozen-lockfile` 即可，allowBuilds 已放行）；打包模式 vendor 拷贝已就位。真件行为可随时 `pnpm --filter @codexlike/desktop run smoke:pty` 复验。
- 【验证途径】票面「dev 模式手测」验收：实现者用 desktop IPC 层集成测试（tests/tasks/task-ipc.test.ts 同款「真实 Electron 构建产物、无应用启动」基建）驱动创建/字节流/kill 全链路作为证据；GUI 手测延至 04/09。
- 落地：票分支 ts-03-desktop-session-service commit `d137ac2`，集成合入 `d048e08`。14 文件 +1318/−4；desktop 540 / ui 624 / agent-core 625 全绿，typecheck 0 错，pre-commit 全链过。
- **IPC 面与 preload API**（通道 `IPC.terminals`，渲染端 `window.codexlike.terminals`）：create `{taskId, initialCommand?}` → 判别 union（中文 reason；任务不存在抛中文异常）/ write / resize（已退出静默）/ kill（用户 kill 不弹确认）/ **subscribe** `{sessionId}` → `{ok:true, sessionId, record, buffered}`（三合一：回放 buffered + 建实时转发 + 返回 record 快照；重复订阅幂等，主进程按 sessionId 单订阅防 xterm 收重复字节）/ unsubscribe（幂等）/ session / list-for `{taskId}` → record[]（含已退出）；`terminals:session-data` 主→渲染专用字节流通道，绝不进 React 状态。生命周期事件不在本命名空间，走 `onTaskEvent` 信封。
- _*terminal-* 事件变体_*：`terminal-started` / `terminal-exited`（record 为事件时刻完整副本，exited 含 exitCode/snapshot），类型在 agent-core task/types.ts；live-tasks 白名单两处（stopped 过滤 + terminalAt>0 守卫）已行为级验证（空闲/终态/已停止三任务态均下发）；桥接点 task-ipc.ts `pushTaskEvent`（延续水位 + 全窗口下发），main.ts 挂 manager.onEvent。
- 偏差说明（3 处 ui 最小增量，契约/编译所迫非 UI 功能）：task-view.ts terminal-* no-op case（穷尽性）、dev/browser-stub.ts terminals 命名空间 stub（契约测试）、browser-stub.test.ts METHOD_ALIASES——**04 票接线时把 no-op case 替换为真实归并**。
- 未决：任务被移除后其存活会话的 terminal-exited 事件无现场可挂、静默丢弃（若 07 归档流程先杀会话，此口自然闭合）；env 白名单 desktop 侧独立维护（session-env.ts，名单与 agent-core ENV_ALLOWLIST 同款），统一单一来源留整合票。
