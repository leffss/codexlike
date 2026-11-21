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
