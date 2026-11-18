# 共享实现笔记

## 已知事实，不重复宽泛探索

- 基线 cbc87ff，Node v24.16.0 / pnpm12.18.0，三个包 agent-core/desktop/ui。
- 审计报告 REPORT.md 已提供最小因果和隔离复现材料。先读自身分组部分，不重做审计。
- 根 AGENTS.md、CODING_STANDARDS.md、GLOSSARY.md 与相关 ADR 生效，无包级补充规范。
- 既有全仓基线：152测试文件/1404测试通过；lint 6条Fast Refresh warning；build曾有empty-import-meta。符号链接测试有EPERM内部返回，勿称验证成功。
- 本轮测试接缝经用户批准，见 spec.md。不要再向用户询问 seam；逐个缺陷 red→green。

## 文件所有权

1. 01任务调度：desktop/src/tasks/task-queue.ts、task-ipc.ts（排除 mentions）、对应 task/exit/workbench 测试。不得改 main.ts、stores、UI。
2. 02构建：desktop/scripts/build.mjs、dev.mjs、新增共享构建配置、core/browser/chromium.ts、chromium-installer 测试、desktop 新构建加载测试。不得改 browser/manager.ts。
3. 03工具：core/tools/{apply-patch,read-file,terminal}.ts、必要的独立读文件辅助、core/mcp/manager.ts、core/browser/manager.ts 及对应测试。不得改 chromium.ts、主循环、desktop mentions。
4. 04存储平台：desktop/storage/json-file.ts、profiles/profile-store.ts、lifecycle/exit-ipc.ts、tasks/mentions.ts、对应tests。main接线以票Comments交主代理。
5. 05核心协议：core/task/{agent-task,subagent}.ts、interaction/controller.ts、必要私有helper和对应 task/provider/interaction测试。不得改工具和持久schema；C02双ID需兼容旧记录。
6. 06工作台设置：ui/pages/{WorkspacePage,SettingsPage}.tsx、ProviderProfileForm、McpSettingsSection、workspace-state/persistent-workbench 与这些专用tests。不要改MessageStream/Rail/task-view/live-task。
7. 07消息渲染：ui/MessageStream/RailPanel/SubagentRailPanel/ToolCallCard、lib/{task-view,turn-view,live-task,subagent-status,markdown}及小hook/叶组件和这些专用tests。不要改WorkspacePage/SettingsPage。

主代理：main.ts、e2e/helpers/launch-target等公共入口、根测试脚本若确需、各组跨层接线、最终报告与复审。不要修改他人文件或git stage/commit。多人共享工作区，不运行git restore/reset/clean。

## 构建/测试协调

- 当前 dist 是审计期已构建的 cbc87ff，Core源码变后必须由主代理统一重建。
- Core实现者可直接 `pnpm --filter @codexlike/agent-core exec vitest run <文件>`；不要调用全仓build/test。
- desktop/UI可先写测试并验证旧dist下红（不依赖Core变更的自身行为），绿测前若需最新Core，请报告等主代理统一build；使用exec vitest避免test script自动build并发。
- 各组完成写代码后报告 READY_FOR_BUILD，主代理集中build；如尚依赖其他组中间态，保留说明，不为过测试改他人文件。
- 不新建worktree以免每组安装开销；所有者互斥同branch，tests显式文件。
- 检查命令直接执行取exit code，不管道。Bash不可用cat/head/tail/sed/awk，读文件用Read。

## 复用接缝

- Queue `createTaskQueueCoordinator` 的start与remove；IPC `deliverMessage/beginExecution/thaw`。需要取消准备意图而非只删除row。
- `resolvePath` 已具工作区/realpath策略；patch重复检测不能放宽权限。
- `defineTool` 将execute异常变isError，可沿用。
- IO预算/UTF8模式见core/context/resource-files与agents-md；不要为了复用导出无关资源快照接口。
- `generateId` / subagent port.generateId 是现成宿主ID；provider ID与宿主ID只在内部映射，协议消息保留原值。
- UI `useTickingNow`、`useCollapseState`、`markdownComponents`、主工具卡可复用。不要memo每次新建的TurnView期望性能生效。
- UI已依赖jsdom/@testing-library/react；新交互测试用文件首行vitest jsdom环境，无需新依赖。
- ProviderProfileForm补initial后，提交仍需显式剔除旧contextWindowTokens，避免用户清空字段又被...input带回。
- Compact本轮保留未匹配旧子代理段即可，不引入新store/IPCschema；注意去重、稳定身份和时间线语义。

## E2E边界

现有CODEXLIKE_HOME只隔离业务库，Electron userData/localStorage尚未隔离。主代理负责补测试启动隔离后再跑相关场景。禁跑window-controls真实鼠标、message-order/process-segments真实剪贴板、browser冷缓存下载、外部模型。其它场景使用local mock；仍需逐文件核对退出/清理。main.ts与共有helpers由主代理独占。

## 完成报告

每组更新自己的票：Status、逐项checkbox、失败命令/关键错误、通过命令与数量、文件清单、跨组接线/下游注意事项（写到票Comments）。不可用“全部通过”代替实际退出码/已跑范围。未经运行的项目明确pending。
