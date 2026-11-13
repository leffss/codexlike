# 03: desktop 主进程与 IPC 契约改名（expand）

术语依据换词后的 `GLOSSARY.md`；上游票 02 已就位（agent-core 新名 + 旧名别名）。

**What to build:** 主进程会话模块目录与文件、IPC 契约全部 channel 与载荷类型、preload 转发整体更名为 task 系；旧 channel 名做双注册兼容，让 UI 与 e2e 在不改的情况下保持全绿。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 主进程会话模块目录（desktop 内 sessions 系目录）及 14 个模块文件更名为 task 系（IPC 注册、会话管理、live 执行现场、归属、worktree 流程、输入队列等）
- [ ] IPC 契约全改：33 个 `sessions:*` channel → `tasks:*`；`SessionEventEnvelope`/`SessionListItem`/`StartSessionInput` 等载荷类型同步更名；主→渲染事件流 channel 同步
- [ ] preload 转发表同步更名；渲染层全局类型声明同步更新
- [ ] 旧 channel 字符串**双注册兼容**：同一 handler 同时挂新旧两个 channel 名，现有 UI 调用与 e2e 不改仍绿（票 06 收尾删除）
- [ ] 主进程抛给用户的中文异常文案换词（「原会话已移除」等「会话」→「任务」）
- [ ] desktop 全部测试改绿（含输入队列系 5 个、live 事件、搜索、恢复等 19 个会话系测试文件）
