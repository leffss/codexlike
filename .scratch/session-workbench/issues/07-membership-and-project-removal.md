# 07: 安全调整归属与移除项目

**What to build:** 用户可以在目录约束允许时把会话移入或移出项目，也可确认移除项目及其所属会话记录；这些整理只影响应用中的管理关系，不移动文件、不改变分支、不重写历史或删除磁盘成果。

**Blocked by:** 04 — 接入延迟创建的 Worktree 与共享目录提示；05 — 完成侧栏整理与归档恢复。

**Status:** completed

**Spec:** [会话工作台重构规格](../spec.md)

## Acceptance criteria

- [x] 非执行中且无待回应请求的独立会话可移入工作区匹配的项目；不同目录的会话不能随意归入目标项目。
- [x] 项目会话可移出成为独立会话，工作区、分支、历史和已有会话偏好保持不变；侧栏立即反映新归属。
- [x] 目录匹配采用实际文件系统路径语义，不通过项目名称、字符串前缀或展示文本判断。
- [x] Worktree 会话移出后仍保留来源目录信息，只能移回来源项目，不能把实际 Worktree 目录当成新项目自动创建。
- [x] 项目移除前明确说明影响的是项目及其所属会话记录，并说明磁盘文件保留；取消确认无副作用。
- [x] 确认移除按显式项目归属处理包含归档在内的所属会话；删除或清理相关应用内索引和项目草稿，避免导航或搜索悬挂记录，但不按目录连带处理其他会话。
- [x] 使用相同目录的独立会话，以及已经移出项目的 Worktree 会话，不能因原项目被移除而被误删记录。
- [x] 项目目录、用户文件、托管 Worktree 目录及已有成果均保留；不调用按数量自动清理或其他隐式磁盘删除。
- [x] 任一所属会话正在执行或等待用户回应时，不允许直接移除项目；运行或等待中的会话也不能调整归属，必须先明确停止。
- [x] 宿主在实际修改归属或移除时重新检查活动状态，和执行启动形成一致性保护；UI 上按钮禁用不是唯一防线。
- [x] 整理失败有明确反馈，不能出现界面宣称成功而记录只改了一部分，或移除后仍可向已移除会话启动新执行。
- [x] 在当前会话被移出或其项目被移除后，主区与侧栏选择保持一致，不保留指向已移除记录的可发送入口。
- [x] 如票 06 搜索或票 03 偏好已接入，整理遵守其公开契约且不破坏数据；本票不因此添加它们为阻塞依赖，相关组合由票 09 汇合验证。

## Verification

- [x] 使用真实 SQLite 和临时目录验证本地会话移入、移出、目录不匹配拒绝以及 Worktree 来源限制。
- [x] 创建项目会话、归档会话、同目录独立会话、已移出的 Worktree 会话，移除项目后断言影响集合准确，所有磁盘标记文件仍存在。
- [x] 用可控执行启动和用户交互等待验证整理竞态、运行中拒绝、确认取消与失败一致性。
- [x] 真实 Electron E2E 完成移入、移出、移除取消和确认，验证提示、侧栏及主区结果；不读取组件私有状态代替操作。

## Scope boundary

不支持用归属调整搬运工作区，不实现跨项目任意拖放，不引入永久删除单条会话或磁盘清理工具。项目移除是已确认的应用记录移除，不是删除目录。

## 交付记录（2026-11-11）

工作树 `C:/Users/leffss/Desktop/ai-agent-wt-session-workbench-07`，分支 `feat/session-workbench-07`。开始核实 status 干净、HEAD / merge-base 为 `91f4219`；独立安装依赖、不共享 dist。收到稳定指针后合入 `40854186b73d6ecd4c48d704a024158509113f2c`（含03/06），兼容解决五处文本冲突并执行以下组合验证。没有修改其他票或索引，没有 push、main 操作或跳过 hooks。

### 公开契约与实现

- `packages/desktop/src/sessions/session-membership.ts` 独立承载归属/项目移除规则；复用04 `sameWorkspaceDirectory` 的真实路径语义和05同一 `management.assertInactive`。同步检查所有显式所属会话后立即写入，无第二运行锁，也没有检查与写入之间的 await。
- 新增类型化 IPC / preload `sessions.setProject(sessionId, projectId | null)`、`projects.remove(projectId, confirmed)`。前者只更新 `projectId`，保留工作区、来源、分支、历史、置顶、最近使用与偏好；后者 false 返回 null 无副作用，true 返回 `ProjectRemoval { projectId, sessionIds }`。不同目录拒绝，Worktree 比较来源而非实际副本目录；移除后重新添加同一来源目录可再次移回。
- Core `SessionManager.setProject` 同步刷新缓存 record；`removeProject` 委托 SQLite 单事务删除项目及显式所属会话和关联消息/工具/交互/compact/approval 记录，成功后清 Core 缓存。按03公开 `workbenchKey` 精确删除项目新建草稿及所属会话工作现场，不触及独立新建入口或同目录独立会话。06搜索实时查询 SQLite，无额外索引缓存需要删除。
- 删除事务保存已成功 `creationRequestId` 的最小墓碑，阻止旧首次发送意图跨进程重开后重建已移除会话；pending start 返回前重查记录，02宿主现场 `forget` 精确清除删除集合。首次发送等待03草稿消费期间发生移除时明确报错，墓碑还防止“历史已删所以为空”被误判为04创建失败而回滚成功 Worktree。真实文件永不因项目移除删除。
- 异步工作区准备后复查项目存在；正常 send 在异步 profile 读取后仍用05 `assertCanExecute`。compact 同样登记现有 `executions`，避免异步摘要写入期间被移除；08可在此同一占位扩展 AbortSignal 与退出排空，未新增另一套锁。
- UI `MembershipDialogs` 提供移入/移出与项目移除确认，明确包含归档、记录不可撤销及磁盘保留；失败留在确认框显示原因。确认移除后同步断开已删除主区/草稿与加载代数，再导航到幸存会话或独立草稿。移动不重新加载当前现场、不触发 markUsed；02 view/sequence、04模式控件、05主动查看语义保持。
- UI `workspaceState.removeProject(projectId, sessionIds)` 清理明确集合；03 `createPersistentWorkbench.remove(target)` 清目标缓存/排队写/错误并忽略迟到响应，删除目标不阻塞幸存会话或08的 flush。`SessionSearch.recordsRevision` 在归属变动/删除后淘汰旧查询并重查，搜索打开时不会留可点击的悬挂结果。

### 实际红绿与验证

- 真实红—绿：缺 `sessions:set-project` → 本地移入/移出持久；缺 `projects:remove` → 显式集合删除与 requestId 墓碑；异步 Worktree 准备后项目缺失 → 清晰拒绝；compact 执行未占位 → 共用05执行保护；真实 Electron 缺移入入口 → UI闭环。
- 合入03/06后追加真实红—绿：删除后 `workbench_state` 残留 → 同事务精确清理；首次发送成功但03消费未返回时删除导致 resolved undefined → 明确拒绝并保留 Worktree；UI迟到持久失败污染全局flush → 删除目标墓碑隔离；打开的搜索仍显示删除结果 → 记录 revision 重查。
- `pnpm typecheck`：通过（合入4085418后最终代码）。`pnpm build`：通过；最后小宿主接线后再执行 desktop build，通过。保留既有 CJS/import.meta、第三方 PURE 注释与大 bundle 警告。
- `pnpm --filter @codexlike/desktop exec vitest run tests/sessions`：11文件 / 69项通过；其中 `workbench-ipc.test.ts` 25项，含本票11个新增宿主切片、真实文件SQLite重开、临时Git/junction、所属与已移出Worktree文件/分支保留、运行/等待/启动占位/发送准备竞态、03默认读取迟到与旧write拒绝、06搜索一致性、注入SQLite事务失败整体回滚。
- `pnpm --filter @codexlike/agent-core exec vitest run tests/session/sqlite-store.test.ts tests/session/session-manager.test.ts tests/session/manager-commands.test.ts`：3文件 / 35项通过。`pnpm --filter @codexlike/ui test`：15文件 / 102项通过，含删除目标迟到持久响应与幸存输入隔离。
- `pnpm --filter @codexlike/desktop test:e2e:membership`：通过。真实 Electron/preload/IPC/React/SQLite，用户点击移入/移出、草稿保持、取消与确认、等待期间拒绝、包含归档删除、搜索打开时清除结果、主区导航、真正进程重开、幸存会话继续发送、当前项目仅草稿时移除及重新添加后无旧草稿。只替换外部模型、目录选择使用既有临时测试钩子。
- 合入4085418后 `test:e2e:persistence`、`test:e2e:search`、`test:e2e:sidebar`、`test:e2e:live-sessions`、`test:e2e:worktree` 均通过；最后三个及membership使用最终宿主构建再次执行。所有检查直接取退出码，不接截断管道。

### 未测与已知边界

- 正常提交 hooks 实际执行 `check:adr`、Prettier、`pnpm typecheck` 和全量 `pnpm test`，均通过；全量为80文件 / 633项（Core416、Desktop115、UI102）。未跳过 hooks。未执行 `test:e2e:all`、`dist`、打包冷启动；留票09汇合发布验收。
- 尝试既有 `test:e2e:compact` 在旧 `create-session-confirm` 创建入口超时，尚未进入压缩验证，不记为通过；已告知协调者由09适配01新建入口。本票宿主真实HTTP摘要及共享占位测试通过，compact中断/退出排空由08实施。
- desktop既有 `mentions.test.ts` 文件符号链接测试在本机因 `EPERM` 内部打印跳过（runner统计为通过），不声称该分支实测；本票目录 junction 路径语义测试实际执行通过。没有改权限或绕过限制。
- 所有文件删除仅发生在测试创建的临时环境清理或04既有安全创建失败回滚；项目移除业务没有磁盘删除入口。
