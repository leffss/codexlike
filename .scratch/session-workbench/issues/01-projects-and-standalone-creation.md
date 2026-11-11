# 01: 建立项目与独立会话的新建闭环

**What to build:** 用户可以添加并保留空项目，在项目内或全局独立入口准备新会话草稿，首次发送才生成正式会话并执行。独立会话默认使用专用持久目录，也可指定目录；项目归属与实际工作区分离。该票贯穿持久化、宿主公开接口、侧栏、输入区和测试，形成后续任务可复用的新模型与创建契约。

**Blocked by:** None (can start immediately).

**Status:** completed

**Spec:** [会话工作台重构规格](../spec.md)

## Acceptance criteria

- [x] 项目是独立持久实体，添加本机目录后即显示；没有会话也保留，重新打开后仍存在。普通非 Git 目录可用。
- [x] 会话项目归属可空；独立会话单列分区，不创建虚假的默认项目，不根据目录自动加入项目。
- [x] 全局新建进入独立会话草稿；项目旁新建进入该项目草稿，项目内不重复要求选择目录。
- [x] 每个项目及独立入口各有一份新会话草稿；切换查看已有会话不丢失当前进程中的输入。跨重启持久化由票 03 完成。
- [x] 首次发送前不创建正式会话或专用目录，不产生空历史；首次发送完成创建后调用正常执行路径，首条消息与会话对应。
- [x] 独立会话默认在首次发送时分配应用管理的专用持久目录；首次发送前可以改选已有目录，选目录不创建项目。
- [x] 项目内默认直接使用项目目录；本票交付本地模式，Worktree 延迟创建在票 04 接入同一首次发送契约。
- [x] 界面明确展示实际工作区；首次执行开始后不允许更换该会话工作区。
- [x] 会话自动命名并可手动重命名，独立与项目会话一致；标题更改持久保存。
- [x] 首次发送有去重和一致性保护，连续触发不会生成重复会话或重复执行首条消息。
- [x] 创建目录或建立会话失败时给出可理解的错误，保留可重试草稿，不把失败显示为成功或留下额外空会话；不清理用户已有目录和成果。
- [x] 建立后续共用的稳定会话标识、可空项目归属、工作区与来源字段、执行中及等待用户状态契约。后续票不需要用路径重新推导归属或用当前页面判断执行状态。
- [x] 初始新会话使用应用默认模型和思考档位、审批模式 `ask`，不从其他会话复制完全访问权限。
- [x] 新会话管理模型不兼容旧管理数据；明确初始化或数据隔离方式，不要求迁移，也不自动删除旧文件、用户代码或 Worktree。
- [x] 不把本票变成全仓机械重写：保留 SQLite、类型化 IPC、Core 与 Electron 解耦以及无关既有能力，完成从创建到执行的可用切片。

## Verification

- [x] 通过宿主公开接口与真实 SQLite、临时目录验证空项目、可空归属、首次发送、路径约束、失败重试和重复触发；断言外部行为而非私有存储结构。
- [x] 真实 Electron E2E 完成添加空项目、项目内首次发送、独立首次发送、切换两类会话；模型使用本地可控服务。
- [x] 用一个与项目目录相同但无项目归属的独立会话证明不会被自动分组。
- [x] 交付说明记录新接口的输入、失败语义和执行保护信息，供票 02–05 共用；不凭空新增多个等价管理入口。

## Scope boundary

Worktree、完整运行现场、跨重启草稿与设置、整理搜索和退出流程由后续票完成；本票必须提供可工作的本地创建与发送闭环，而不是仅交付 schema 或空界面。

## 交付记录（2026-11-11）

实施分支 `feat/session-workbench-01`；提交前已执行 `git merge feat/session-workbench`，集成 tip `908464c`，结果 `Already up to date`。实现与本记录随 `feat(session-workbench): 建立项目与独立会话首次发送闭环` 提交；最终 hash 由代理交付消息给出。

### 后续票共用接口与约束

- `packages/desktop/src/shared/ipc.ts` / `preload.ts`：`projects.list()`、`projects.add(absolutePath)` 返回 `ProjectRecord { id, name, workspacePath, createdAt }`。目录经宿主真实路径规范化、检查存在且为目录，非 Git 可用；同规范目录重复添加返回原项目。
- 唯一公开首次创建入口为 `sessions.start(StartSessionInput)`：`requestId`、`projectId: string | null`、`text` 必填；`workspacePath?` 仅独立入口可指定；`workspaceMode?` 本票只接受 `local`；其余为 `providerProfileId?`、`thinkingEffort?`、`approvalMode?`、`mentionPaths?`。成功返回 `SessionRecord`，并已通过正常 `send` 路径接受首条消息。默认模型为现有 Profile 列表首项，思考 `auto`、权限 `ask`，不会复制当前会话完全访问权限。废除旧 renderer `sessions.create`，避免留下空会话的等价旁路。
- 同一个草稿意图沿用同一 `requestId`。宿主同步登记进行中的 Promise；成功后 SQLite 保存 `creationRequestId`，同 key 并发/重复/重开后提交只返回原会话、不重放消息。成功 key 不可用于另一个新意图；新草稿须产生新 key。失败抛出中文错误，释放 key；无用户消息的记录撤销，草稿原文保留可重试。仅以非递归 `rmdir` 撤销本次专用空目录；用户目录和非空成果不删除。模型在首条消息已接受后失败属于正常会话错误，不回滚历史。
- `SessionRecord.projectId` 必填可空；`id` 稳定；`workspacePath` 是固定执行目录；`workspaceMode`、`workspaceOriginPath` 独立于归属保留。UI 只按 `projectId` 分区，不能再用路径推导归属。
- `sessions.execution(id)` 返回 `{ sessionId, executionId, running, waitingForUser, pendingInteractionIds }`；未知会话返回 `null`。`session-ipc.ts` 内 `executions` 在发送启动前同步占位，等待回应仍为执行中；第二次发送不得覆盖原中断通道，结束按 executionId 条件释放。`SessionEventEnvelope` 带相同 `executionId`，后续 02 可用它隔离旧执行事件。后续整理操作必须在宿主操作点复查该状态（不是仅靠 UI 或读取后异步等待）；本票未实现整理规则或完整运行现场。
- `packages/ui/src/lib/workspace-state.ts` 的 `newDraft/editNewDraft/completeNewDraft` 按项目/独立入口各保存一份进程内草稿和提交状态；`WorkspacePage.tsx` 的 `startCreateSession/sendFirst` 负责选择草稿与首次发送。03 可扩展持久化，不应另创第一次发送入口。
- 数据初始化改为 `<dataDir>/session-workbench.db`，不读取/迁移/覆盖旧 `codexlike.db`。为避免新库把旧 Worktree 视为孤儿，已取消 `main.ts` 启动及 `session-ipc.ts` 归档的自动 cleanup 调用；旧 Worktree 和用户目录保持原样。04 仍需接入 `start` 的 workspaceMode 分支及草稿模式 UI，复用 `worktree-flow.ts`/Core Worktree 服务并完成延迟创建/来源/共享提示；Core 旧 cleanup API 本票未重做。
- 并行冲突热点：02/03/04 都会触及 `session-ipc.ts`、`shared/ipc.ts`、`WorkspacePage.tsx`、`workspace-state.ts`；05 主要为 `SessionSidebar.tsx`/`project-groups.ts`。合入时沿用本票公开类型和首次发送契约，避免各自重建管理入口。

### 实际验证

所有命令在独立 worktree 运行，直接取退出码（长日志仅重定向文件，无截断管道）。

- 红—绿记录：`pnpm --filter @codexlike/desktop test tests/sessions/workbench-ipc.test.ts` 依次因缺 `projects:add`、缺 `sessions:start`、失败残留空专用目录而失败，逐切片实现后通过；最终 5 个测试通过，覆盖真实文件 SQLite 重开、去重、目录/首条消息启动失败重试、目录保留、非法参数及等待执行/停止保护。
- `pnpm typecheck`：通过。
- `pnpm test`：77 文件、596 测试通过（Core 416、Desktop 85、UI 95）。
- `pnpm build`：通过（保留既有打包体积、第三方 PURE 注释及 CJS/import.meta 警告）。
- `pnpm --filter @codexlike/desktop test:e2e:projects`：通过。真实 Electron 三次进程启动，空项目、两类草稿、首次发送、双击、失败保留输入重试、同目录独立归属、重命名/目录重开恢复；旧库原样保留与 17 个旧 Worktree 成果不自动清理也通过。
- `pnpm --filter @codexlike/desktop test:e2e`：通过。已将 smoke 创建前置步骤适配为独立草稿/选目录/显式 assist，保留真实 write_file、web_search、Markdown 和历史恢复验证。
- `pnpm --filter @codexlike/desktop test:e2e:theme`：通过。
- `pnpm dist`、`pnpm test:e2e:packaged`：通过，独立工作树 Windows 产物冷启动，未预建的嵌套数据目录及新 SQLite 文件自动建立。
- **未执行** `pnpm test:e2e:all` 及其余专项 Electron 脚本；旧脚本仍依赖 `create-session-confirm`/创建后立即出现空会话，需随 02–09 相应纵向切片适配（尤其 04 Worktree）。未声称全量 E2E 通过。完整后台增量恢复、跨重启草稿/偏好、整理/退出保护仍归后续票验收。
