# 05: 完成侧栏整理与归档恢复

**What to build:** 用户通过可折叠项目、独立会话分区、会话置顶和最近使用顺序整理工作台；会话可以归档、查看及恢复，运行或等待回应时先停止。后台输出不使列表跳动，不同入口遵循相同整理规则。

**Blocked by:** 01 — 建立项目与独立会话的新建闭环。

**Status:** completed

**Spec:** [会话工作台重构规格](../spec.md)

## Acceptance criteria

- [x] 常驻侧栏分别显示独立会话和各项目会话，主区同一时刻查看一个会话，不引入标签页或分屏。
- [x] 项目可折叠，独立和项目会话均可置顶；整理状态保存后重开仍可恢复，不改变项目归属或工作区。
- [x] 非置顶会话按用户最近使用排序，后台正文增量、工具事件或其他刷新不驱动列表反复重排。
- [x] 新建、重命名、归档、恢复后的列表一致反映持久数据，不依靠旧的目录聚合键。
- [x] 归档仅从日常列表隐藏，历史和 Worktree 保留；提供可发现的归档查看与恢复入口，不依赖尚未完成的搜索票。
- [x] 恢复后回到其原显式归属的分区；原本独立的会话不会因目录匹配被自动塞入项目。
- [x] 无论从侧栏、会话内操作或现有斜杠命令归档，当前选中会话和主区处理一致，不出现一处留在归档会话、一处跳走的冲突。
- [x] 执行中或等待用户回应的会话不能直接归档，提示先停止；取消或拒绝操作不会中断任务或更改记录。
- [x] 宿主实际执行归档时复查活动状态，避免列表状态过时导致正在运行的会话被归档。使用票 01 的活动状态契约，不依赖票 02 的展示实现。
- [x] 归档和恢复不删除文件、不调用 Worktree 自动清理，不新增永久删除单条会话。
- [x] 界面整理操作与用户交互入口兼容，不让项目折叠或会话置顶取消待处理请求。

## Verification

- [x] 真实 SQLite 与公开接口验证置顶、归档、恢复、归属保留、重开后的状态及活动时拒绝整理。
- [x] 用可控后台输出验证最近使用排序稳定；不把记录更新时间误当成用户最近使用时间。
- [x] 真实 Electron E2E 操作折叠、置顶、归档查看与恢复，并核对当前主区与侧栏入口的一致性。
- [x] 以临时文件标记验证归档后项目目录和 Worktree 文件不变；项目移除的文件保护由票 07 验证。

## Scope boundary

不依赖票 02 的完整运行现场，只复用票 01 已存在的活动判断；跨项目搜索由票 06 接入本票的归档契约。

## 行为更正（2026-11-12）

下方交付记录保留当时实现与验证历史，不再代表当前查看行为。最近使用时间仅在创建/发送时更新；侧栏、搜索、归档历史及自动恢复的查看均不调用 `markUsed`、不改变排序，`markViewed` 仍只确认已读水位。`openSession` 不再区分主动与自动打开。顶部新建、归属调整及归档/恢复按钮已移除，整理操作由侧栏提供，`/archive` 保留。

## 交付记录（2026-11-11）

分支 `feat/session-workbench-05`，独立工作树安装依赖与构建，未共享其他工作树产物。起始及提交前核实集成分支 `feat/session-workbench` tip 为 `da9cb26`，执行 `git merge feat/session-workbench` 返回 `Already up to date`；最终提交 hash 随代理交付报告提供。

### 给票 06 / 07 的公开接口

- `ProjectRecord.collapsed`、`SessionRecord.pinned` / `lastUsedAt` 随 SQLite 保存。类型允许缺省用于既有调用方，实际宿主读回分别为 `false` / `false` / 初始 `createdAt`。`updatedAt` 仍记录后台更新，但不再参与列表排序。
- 类型化 IPC / preload 新增 `projects.setCollapsed(projectId, boolean)`、`sessions.setPinned(sessionId, boolean)`、`sessions.markUsed(sessionId)`，未知记录返回 `null`，非法参数抛中文错误。`sessions.list()` 仍返回包括归档在内的全部记录，顺序为置顶优先、最近使用倒序、创建时间及 id 稳定破同值；侧栏仅按显式 `projectId` 分区。
- `markUsed` 只在用户主动查看时调用；宿主接受发送首条事件后自动登记使用时间。后台事件、列表刷新、重命名、归档恢复、置顶及自动重启恢复均不改使用时间。UI `openSession(id, true)` 为主动查看入口；默认 `false` 用于自动打开/归档后自动导航。06 搜索选中结果应走主动查看入口；02 的 `markViewed` 不应连带更新最近使用。
- `packages/desktop/src/sessions/session-management.ts` 导出 `createSessionManagement(manager, executions)`，同实例公开 `execution(sessionId)`、`assertInactive(sessionId)`、`assertCanExecute(sessionId)`、`archive(sessionId, archived)`。`execution` 保留01权威契约，综合宿主 execution 占位、记录状态、待处理交互。07 请复用 `session-ipc.ts` 中 `management.assertInactive`，并在同步检查后立即进行同步管理写入，二者之间不能 `await`；项目移除需先检查所有所属会话再写入。
- `assertInactive` 拒绝执行中/等待回应，错误要求先停止；拒绝不停止、不消费交互、不关闭浏览器、不写归档。`archive` 同步复查后才写入，成功归档后宿主仍释放浏览器 context，但从不清理目录或 Worktree。`assertCanExecute` 放在异步 Profile 读取完成后、执行占位前，拒绝已归档/已移除记录，封闭归档抢先于发送准备完成的竞态。
- 三个归档入口统一走 `archiveSession`：归档当前会话后打开排序后的首个未归档会话，没有则进入独立草稿；归档非当前会话不改变主区。异步返回会校验导航代数，不抢走用户刚切换的会话。归档历史可直接点击查看并恢复；归档不能发送，恢复后仍在原显式归属和固定工作区。

### 实际红绿与验证

- 宿主公开 IPC + 真实 Core、文件 SQLite、临时目录、可控本地 SSE：先出现“等待交互归档未抛错”红测，接入同步管理保护后绿；异步 Profile 查询闸门复现“已归档仍能发送”红测，启动前重查后绿；缺 `sessions:mark-used` 红测及发送不更新最近使用红测，逐切片实现后绿。
- `workbench-ipc.test.ts` 最终 **10 个通过**：含运行中拒绝、等待拒绝、Core 尚 idle 但宿主已占位的重入检查、归档先赢竞态、发送登记使用时间、后台增量/完成不重排、置顶折叠归档重开、同目录独立归属不变、真实 Git Worktree 的来源/分支/未提交成果保留。Worktree 夹具通过 Core 公共创建接口建立，不依赖04首次发送接线。
- 真实 Electron `test:e2e:sidebar` 先因缺置顶入口红测；实现后发现悬浮按钮遮挡会话点击，改为独立操作行。最终通过两次应用进程启动、折叠/置顶持久化、取消置顶与主动查看排序、归档查看/恢复、侧栏/主区按钮/`/archive` 导航一致、同目录独立会话不自动入项目、文件保留，以及等待问答中置顶/折叠不取消请求、归档被拒绝后仍能正常回答完成。
- 提交前合并集成 tip 后实际执行 `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm --filter @codexlike/desktop test:e2e:sidebar` 均通过。全测试 **77 文件 / 601 用例**（Core 416、Desktop 90、UI 95）。构建保留既有 CJS/import.meta、第三方 PURE 注释与大块警告。
- 额外回归已通过 `test:e2e:projects`、`test:e2e`（smoke）、`test:e2e:theme`；交互与资源 IPC 共6例亦通过。新增 `test:e2e:sidebar` 脚本并纳入 desktop 的 `test:e2e:all`。
- 未执行 `test:e2e:all`、全量 `dist`、打包冷启动以及其余专项 E2E，留票09汇合验收；未实现06搜索或07移动/删除，未更改其他票及 README 索引。02运行现场与03偏好语义由各票交付，05只使用01活动契约。
