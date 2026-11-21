# 03: desktop 终端会话服务 + IPC + preload 通道

**What to build:** 主进程侧把 01 的管理器与 02 的适配器装配成宿主级常驻服务（browser-manager 装配先例）：会话创建（cwd 一律任务工作区、shell 跟随执行设置，**不提供任意 cwd 参数**——ADR 0004 工作区边界）、输入、resize、kill；按 sessionId 的 kill 注册表（形态仿 interrupt-registry）。IPC 三段式对齐 tasks 现有模式：生命周期事件并入 TaskEvent 通道（live-tasks 事件白名单加入 terminal 类），**PTY 字节流走专用 IPC 通道直写渲染端，不进 React 状态**（spec 已补此决定）。preload 暴露终端 API。本票用户还看不见 UI，但主进程能力完整、dev 模式可手测。文件指针见 notes.md §1/§4/§6。

**Blocked by:** 01, 02。

**Status:** ready-for-agent

- [ ] 管理器宿主级单例装配；创建会话强制 cwd = 任务工作区、shell 跟随执行设置
- [ ] 按 sessionId kill 注册表；kill 后进程树终止、资源清理
- [ ] IPC + preload：创建/输入/resize/kill/字节流订阅/生命周期事件，字节流与 TaskEvent 分离
- [ ] `terminal-*` 生命周期事件并入 TaskEvent 通道，live-tasks stopped 过滤白名单加入 terminal 类
- [ ] desktop 单测（fake pty 注入驱动服务层）+ typecheck 绿
- [ ] dev 模式手测：从主进程侧可创建会话、收字节流、kill（验证手段写进票面 Comments）

## Comments

- 【01 票衔接】IPC 双通道数据源已定（集成 `fd6072e`）：实时字节流 `manager.onSessionData`（只转发订阅后的输出）；详情页初始回放 `manager.bufferedOutput`（**不推水位**，不会破坏 05 票工具 read 的水位语义）。订阅时序：收到 `terminal-started` 后立即订阅字节流即不丢数据。
- 【01 票衔接】生命周期事件源 `manager.onEvent`（terminal-started / terminal-exited，携带 record 副本）→ 转 `terminal-*` TaskEvent；**live-tasks 的 stopped 过滤白名单记得加 terminal 类**（notes.md §4）。
- 【01 票衔接】resize 对已退出会话静默忽略，渲染端无需防御；spawn/kill 走判别 union（`{ok:true}` / `{ok:false, reason}`），reason 是可直接展示的中文。
- 【未决】read 并发 wait 同会话共享水位（先唤醒者取走全部增量）——正常调用方不并发 wait；若 IPC 层出现并发场景需回 01 票再议。
- 【类型】`@codexlike/agent-core` 根出口 type-only（TerminalSessionRecord 等），实现经 `/node` 出口（createTerminalSessionManager 等）。
- 【02 票衔接】装配极简：`createTerminalSessionManager({ port: createNodePtyPort() })`——适配器工厂**无参**（真件动态加载）；需自定义 Git Bash 路径才传 `gitBashPath`。kill 注册表设计注解：**管理器本身就是按 sessionId 的会话注册表**（含状态机与 kill），勿再建平行 Map 造成双登记漂移——票面「kill 注册表」验收按「经 manager.kill 的会话级终止可用且进程树死透」满足，并在票面 Comments 记录该设计依据（interrupt-registry 形态的类比已由管理器承载）。
- 【02 票衔接】manager 装配后 `dist/main.cjs` 引用 node-pty → dev 目录模式与 dev e2e 依赖 node-pty 已安装（prebuild 兼容本机 Electron，`pnpm install --frozen-lockfile` 即可，allowBuilds 已放行）；打包模式 vendor 拷贝已就位。真件行为可随时 `pnpm --filter @codexlike/desktop run smoke:pty` 复验。
- 【验证途径】票面「dev 模式手测」验收：实现者用 desktop IPC 层集成测试（tests/tasks/task-ipc.test.ts 同款「真实 Electron 构建产物、无应用启动」基建）驱动创建/字节流/kill 全链路作为证据；GUI 手测延至 04/09。
