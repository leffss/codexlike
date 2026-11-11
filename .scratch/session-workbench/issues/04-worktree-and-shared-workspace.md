# 04: 接入延迟创建的 Worktree 与共享目录提示

**What to build:** 项目内新会话默认直接在项目目录工作，用户可在首次发送前选择 Worktree，发送时才创建独立目录和分支。同目录本地会话可以并行，但明确提示共享文件；Worktree 来源长期保留且不按数量自动清理。

**Blocked by:** 01 — 建立项目与独立会话的新建闭环。

**Status:** completed

**Spec:** [会话工作台重构规格](../spec.md)

## Acceptance criteria

- [x] 项目新会话草稿默认本地模式，在输入区提供明确的 Worktree 选择，不强制弹出模式选择对话框。
- [x] 首次发送前只调整草稿，不创建 Worktree、分支或正式会话；发送后才建立所需资源并开始任务。
- [x] Worktree 创建走票 01 的统一首次发送契约，正式会话明确归属来源项目，实际工作区指向隔离目录。
- [x] 来源目录信息独立保存，不依赖侧栏派生分组或可被清理的临时记录；支持后续会话移出项目后仍识别来源。
- [x] Worktree 使用独立目录及分支，文件和终端操作使用正确工作区；界面显示本地或 Worktree 及实际目录。
- [x] 非 Git 项目本地模式正常可用；无法创建 Worktree 时给出清晰反馈，保留草稿且不留下虚假成功会话。
- [x] 连续发送与失败重试不会重复创建 Worktree 或正式会话；对失败资源的处理仅限本次可证明新建且安全清理的资源，不删除用户已有目录或成果。
- [x] 独立会话入口不直接提供 Worktree 创建；首次执行开始后不能通过模式选择更换现有会话工作区。
- [x] 已有其他本地会话在同一目录执行时给出共享文件风险提示，允许用户继续，不设置一刀切的项目执行锁。
- [x] 共享目录判断基于实际工作区而非仅项目名称或项目归属，避免同目录独立会话被忽略；不同 Worktree 不误报为同一执行目录。
- [x] 删除按数量自动清理 Worktree 的行为及触发入口，新建更多会话不会自动删除较早的副本或分支成果。
- [x] 已有显式清理能力如需保留，仍与会话整理分离；本票不新增完整磁盘清理产品，不把归档或项目移除连接到磁盘清理。

## Verification

- [x] 使用真实临时 Git 仓库验证目录与分支隔离、首次发送前无副本、发送后正确工作区及持久来源。
- [x] 验证非 Git 失败、创建中途失败、重复发送与重试，不产生重复或空会话，不删用户目录。
- [x] 覆盖旧数量阈值以上的新建场景，断言早期 Worktree 文件仍存在且未触发自动清理。
- [x] 真实 Electron E2E 完成模式选择、首次发送、共享目录提示与失败反馈。
- [x] 保留 Worktree 文件复制边界和独立运行测试；移除与新设计冲突的自动删除旧断言。

## Scope boundary

本票提供可验证的 Worktree 创建与来源事实；归属移动和项目移除由票 07 使用这些事实实现。不要为等待票 07 而推迟本票创建闭环。

## 交付记录（2026-11-11）

实施工作树 `C:/Users/leffss/Desktop/ai-agent-wt-session-workbench-04`，分支 `feat/session-workbench-04`。开始时 status 干净，HEAD / merge-base / 集成 tip 均为 `da9cb26`；提交前合入最新集成 `2074525` 并完成下面验证。没有恢复启动或归档的磁盘清理，没有修改其他票与索引。

### 实现与票 07 接口指针

- 唯一首次发送入口仍为 `sessions.start(StartSessionInput)`。项目草稿默认 `local`，输入区 `WorkspaceModeControl` 提供 `worktree`；首次发送才创建副本及 `codexlike/<sessionId>` 分支。独立入口的 Worktree 请求在宿主拒绝，正式会话不提供模式切换。
- `packages/desktop/src/sessions/worktree-flow.ts` 的 `prepareSessionWorkspace` 仅准备工作区事实，不再提供旧 `createSessionWithMode` 正式会话旁路。`SessionRecord.projectId` 保持显式归属；`workspacePath` 为固定实际目录；`workspaceMode` 与 `workspaceOriginPath` 随 SQLite 持久保存，来源不由项目分组派生。票 07 调整归属时保留这三个字段。
- `packages/desktop/src/sessions/workspace-sharing.ts` 导出 `canonicalWorkspacePath(path)`（绝对路径、真实目录存在检查）及 `sameWorkspaceDirectory(left, right)`（真实路径 + `path.relative`，遵循平台路径语义；缺失目录返回 false）。票 07 可复用相同目录事实，Worktree 移回项目应比较 `workspaceOriginPath`，而非执行副本路径或名称前缀。
- `sessions.workspaceSharing(target)` 是只读 IPC。输入为 `{ sessionId }`，或草稿 `{ projectId, workspacePath?, workspaceMode? }`，返回 `{ workspacePath: string | null, runningSessions: { id, title }[] }`；专用新目录与未创建 Worktree 返回空列表。运行事实复用票 05 `session-management.ts` 的 `management.execution`，包含等待回应，排除当前会话，不按项目归属过滤。共享提示不充当锁或授权规则。
- Core `createWorktreeService().createForSession` 返回本次资源的 `rollback()` 闭包，未开始历史时宿主才尝试撤销。排他目录认领、初始提交检查、来源与目标复制路径边界、Git 元数据拒绝、内容指纹与分支初始提交检查限制回收范围。已有目录/分支、创建期间 hook 成果、后续新增或改写内容不能当作失败垃圾删除；不可证明安全时保留文件与分支并在错误中返回保留目录位置。正常失败释放 requestId，重试不残留空会话。
- 删除 Core `cleanup`、数量阈值常量及类型，替换旧 LRU 删除断言。没有新增磁盘清理产品；归档只管理记录。新增超过旧阈值 17 份真实副本的测试保留最早未提交文件和分支，既有并行文件隔离测试原样保留。

### 实际验证

所有命令在本票独立工作树安装依赖后执行，构建产物不与其他工作树共享；命令直接取退出码，未用截断管道。

- 真实红—绿：宿主 Worktree 首次发送先因只允许 local 失败；首次消息启动失败先遗留副本；复制中途失败先遗留目录；旧数量 cleanup API、sessionId 路径逃逸、空 Git 无 HEAD 遗留、hook 成果误回收、保留资源缺明确反馈分别先红后绿。共享目录宿主测试先因缺 IPC 红灯；真实 Electron 测试先因缺草稿模式控件红灯。
- `pnpm typecheck`：通过（合入 `2074525` 后）。
- `pnpm test`：77 个文件、602 项通过（Core 415、Desktop 92、UI 95；合入 `2074525` 后）。包含真实 Git / 文件 SQLite 重开、重复发送、首次发送失败重试、非 Git 本地与 Worktree 失败、目录创建失败、归档保留文件、junction 同目录识别与不同前缀/副本不误报。
- `pnpm build`：通过；保留仓库既有 CJS/import.meta、第三方 PURE 注释与 bundle 体积警告。
- `pnpm --filter @codexlike/desktop test:e2e:worktree`：通过（合入 `2074525` 后）。真实 Electron/preload/IPC/React/SQLite、两个进程启动；模式默认/选择、发送前零资源、双击单副本、`.worktreeinclude`、真实 `write_file` 与 `run_terminal_command` 隔离、固定目录、来源展示、同目录独立等待会话共享提示、继续并行、非 Git 失败留草稿后本地重试。
- `pnpm --filter @codexlike/desktop test:e2e:sidebar`：通过（合入 `2074525` 后），保留票 05 置顶/折叠/归档查看恢复/等待保护行为。
- `pnpm --filter @codexlike/desktop test:e2e:projects`：通过（合入票 05 前的本票版本）。未将其记作最终集成版本重跑。
- **未执行** `test:e2e:all`、`dist`、`test:e2e:packaged`，留票 09 汇合发布验收。票 07 的归属移动与项目移除尚未实现，本票只交付来源与安全目录事实；不以本票测试声称这些未来操作已通过。
