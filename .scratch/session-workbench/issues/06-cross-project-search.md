# 06: 加入跨项目会话搜索

**What to build:** 用户从统一搜索入口按标题和消息正文查找独立会话及项目会话，可选择纳入归档记录，并从结果进入正确会话，不受侧栏折叠或当前项目限制。

**Blocked by:** 05 — 完成侧栏整理与归档恢复。

**Status:** completed

**Spec:** [会话工作台重构规格](../spec.md)

## Acceptance criteria

- [x] 搜索同时覆盖所有项目会话和独立会话，不依赖当前选中项目或当前 renderer 已加载的历史。
- [x] 标题与消息正文均可检索；仅标题匹配或仅正文匹配的会话都能被找到，不把“搜索”实现成当前侧栏名称过滤。
- [x] 默认结果与归档选项一致；用户可明确开启或关闭归档记录搜索，结果同步更新。
- [x] 结果可区分项目归属、独立会话和归档状态，不将同目录会话误认为同一项目。
- [x] 从结果打开对应会话时定位到正确历史，归档会话可查看及恢复；打开搜索结果不会自动停止后台执行。
- [x] 重命名、归档、恢复和新消息持久化后，后续查询反映实际内容；不要求尚未完成的流式片段实时全文索引。
- [x] 快速输入与异步查询不会让旧查询结果覆盖新查询，清空查询或无匹配时状态明确。
- [x] 搜索仅查询会话数据，不将 provider 密钥、应用私有配置或磁盘目录内容纳入正文搜索。
- [x] 查询接口和 UI 都可处理空输入和正常特殊字符，不拼接不安全的查询表达式。

## Verification

- [x] 用真实 SQLite 建立项目会话、独立会话及归档会话，分别以标题和消息正文验证结果与归档过滤。
- [x] 重开数据库后仍能搜索持久历史，证明不是仅检索 renderer 内存。
- [x] 真实 Electron E2E 从跨项目搜索打开正确会话并查看归档结果；验证项目折叠不影响搜索覆盖。
- [x] 覆盖快速查询切换、无结果以及归档或重命名后的再次查询。

## Scope boundary

本票只交付既定的会话检索，不增加标签、文件夹、复杂检索语言、跨磁盘全文索引或搜索式自动归类。

## 行为更正（2026-11-12）

下方交付记录的主动查看 `markUsed` 与“最近使用登记”是历史行为。当前搜索选中统一调用 `openSession(id)`，仅恢复现场与 `markViewed`，不更新 `lastUsedAt` 或改变最近使用排序；最近使用由创建/发送更新。归档搜索结果仍可查看，恢复入口改为侧栏会话菜单，不再依赖顶部按钮。`session-search.mjs` 回归检查搜索打开前后时间与列表顺序保持不变。

## 交付记录（2026-11-11）

分支 `feat/session-workbench-06`，独立工作树安装依赖、构建并运行测试，不共享其他工作树产物。开始时核实干净工作树和 `2074525` 基线；提交前核实并执行 `git merge feat/session-workbench` 合至稳定 `91f4219`（01/02/04/05）。本票未改其他票或 README 索引；最终 hash 随交付消息提供。

### 公开接口与实现边界

- `window.codexlike.sessions.search(query, includeArchived?)` / IPC `sessions:search` 返回 `SessionSearchResult[]`：`{ id, title, projectId, projectName, archivedAt }`。缺省 `includeArchived=false`；非字符串查询或非布尔开关拒绝，空白查询返回空数组。去掉查询首尾空白，中文和特殊字符按字面子串匹配；ASCII 字母不区分大小写，不解释 SQL、通配符或复杂检索语言。
- Core `SessionManager.search` → `SessionPersistence.searchSessions` → 独立 `session/search.ts`。每次查询直接使用 SQLite 参数绑定、`instr`、`EXISTS messages` 和 `LEFT JOIN projects`；同一会话多个匹配只返回一次，按置顶与最近使用稳定排序，不以 renderer 已加载的历史过滤。只检索 `sessions.title` 与 `messages.content`，不会查询 provider 配置、模型字段、工具参数、资源配置或磁盘文件；项目名称只用于显示显式归属，不参与匹配。
- 没有搜索索引或跨查询缓存。重命名、归档、恢复、新消息以及后续票07归属/移除的持久修改会在下一次查询中直接反映；不索引尚未落盘的流式片段。独立会话不按目录推导项目。
- 独立 `SessionSearch.tsx` 提供统一入口、正文/标题输入、归档开关、结果归属及归档标记、空输入/无结果/错误状态与重新查询。打开、输入变化、归档变化和手动重新查询都重新读取宿主；effect 清理让旧请求成功与失败均失效，关闭或清空后不回填。
- `WorkspacePage.tsx` 仅增加 import 与组件两行，选中调用 `openSession(id, true)`。合入时保留02完整 `view` / `markViewed`、05主动用户 `markUsed` 和04 `workspaceSharing`；不另造打开/恢复/停止路径。归档搜索结果复用05主区查看与恢复，打开其他会话不停止后台任务。

### 实际红绿记录

1. 宿主公开 IPC + 真实 Core、文件 SQLite、本地 HTTP/SSE：首测因缺 `sessions:search` 红；接入真实 SQL 后，两个项目、同目录独立会话、仅标题/仅用户正文/助手正文以及关闭重开数据库绿。
2. 归档默认排除红（返回了归档会话）；加入参数化归档过滤后绿，并验证重命名旧词消失、恢复重新出现和后续消息立即可查。
3. 空查询红（返回全库）；空白规范化后绿。保留正常引号、`' OR 1=1 --`、`%_`、反斜杠、方括号、ASCII 大小写、非法输入、provider 密钥/名称/模型及磁盘正文排除测试。
4. 真实 Electron 首测因缺搜索入口红；UI接入后，折叠项目与独立结果、正文打开、最近使用登记、归档开关/查看/恢复、重命名特殊字符、无结果/清空、真实进程重开、后台运行不被停止绿。初次运行测试夹具重复结束SSE导致 `ERR_STREAM_WRITE_AFTER_END`，修复夹具幂等收尾后通过，未把该次退出码1算通过。
5. 在真实 Electron IPC应答边界加可控闸门（仍使用真实 SQL 查询，不伪造返回），稳定复现“旧查询迟到覆盖新查询”红；加入请求失效清理后绿。同时验证清空后迟到成功不回填，迟到失败不污染新结果。测试日志里的“迟到查询错误”是故意注入的断言场景。

### 实际验证命令

以下命令均在本票工作树直接取退出码，无截断管道；全部通过。`pnpm build` 输出仅重定向日志，未使用其他工作树 dist。

- `pnpm install --frozen-lockfile`。
- `pnpm typecheck`、`pnpm build`（保留既有 CJS/import.meta、第三方 PURE 注释与包体积警告）。
- `pnpm --filter @codexlike/desktop test tests/sessions/search-ipc.test.ts tests/sessions/workbench-ipc.test.ts tests/sessions/live-session-ipc.test.ts tests/sessions/worktree-flow.test.ts tests/sessions/interactions-ipc.test.ts tests/sessions/resources-ipc.test.ts`：6 文件、29 例通过，本票搜索3例。
- `pnpm --filter @codexlike/agent-core test tests/session/sqlite-store.test.ts tests/session/session-manager.test.ts tests/session/manager-commands.test.ts tests/session/resume-equivalence.test.ts tests/architecture.test.ts`：5 文件、37 例通过。
- `pnpm --filter @codexlike/ui test`：15 文件、98 例通过。
- 合入 `91f4219` 并重新构建后顺序运行 `pnpm --filter @codexlike/desktop test:e2e:search`、`test:e2e:live-sessions`、`test:e2e:sidebar`、`test:e2e:worktree`：全部通过。搜索含两次真实应用进程启动；其余专项的故意模型失败、归档保护、非Git失败日志均为预期覆盖。
- 首次正常提交 hooks 实际运行 `pnpm check:adr`、`pnpm lint-staged`、`pnpm typecheck`、`pnpm test` 全部通过；全测试80文件、613例（Core415、Desktop100、UI98），没有绕过 hooks。补记验证记录的 amend 曾在04既有 `worktree-service.test.ts` 的“复制中途失败撤销…同id重试”遇默认5000ms超时，退出码1未计通过；未改04实现/测试，单独运行 `pnpm --filter @codexlike/agent-core test tests/worktree/worktree-service.test.ts` 10例通过（该用例1839ms），再正常运行提交hooks。
- 新增 root / desktop `test:e2e:search`，并纳入 desktop `test:e2e:all`，保留02运行现场脚本。

### 未测边界

未运行全量 `test:e2e:all`、`dist`、打包冷启动及性能/超大历史压力测试，留票09汇合。首版采用实时 SQL 子串扫描，无 FTS/分页或模糊相关性排名；非ASCII大小写折叠遵循SQLite内置 `lower` 能力。03跨重启草稿偏好、07归属移除与08退出保护未在本票实现或声称验收；查询代码本身不缓存归属和删除状态。
