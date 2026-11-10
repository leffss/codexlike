# Agent Core 与 Electron 解耦

Agent 运行时（对话循环、工具执行、审批状态机、会话持久化接口）做成独立的纯 TypeScript 模块 `agent-core`，不 `import` 任何 Electron API；Electron 主进程只是它的宿主，通过类型化 IPC 把事件流桥接到渲染进程。代价是多一层宿主接口的边界维护，换来的是 agent 核心可以脱离 Electron 单测、将 CLI/web 等其他宿主形态无需重写核心。
