# 09: 统一所有入口并完成整体验收

**What to build:** 新会话工作台各功能组合后保持一致：按钮、快捷入口和斜杠命令走同一管理规则，旧的目录派生和全局状态路径退出使用，完整桌面体验通过构建、类型、测试与打包冷启动验收。

**Blocked by:** 02 — 切换会话时完整保留执行现场；03 — 持久保存草稿、阅读位置与会话设置；04 — 接入延迟创建的 Worktree 与共享目录提示；05 — 完成侧栏整理与归档恢复；06 — 加入跨项目会话搜索；07 — 安全调整归属与移除项目；08 — 完成退出确认与重启恢复。

**Status:** completed

**Spec:** [会话工作台重构规格](../spec.md)

## Acceptance criteria

- [x] 全局新建、项目旁新建、会话内快捷入口及 `/new` 遵循相同上下文规则：独立入口无项目归属，项目入口保留显式项目归属，不从 Worktree 执行路径派生新项目。
- [x] 归档、恢复、重命名及已有相应斜杠命令共享管理规则，导航结果一致；不得绕过活动状态或文件保护检查。
- [x] 验证项目和独立会话在新建、切换、搜索、归档、移动及重启的组合场景下仍归属正确，草稿和设置不串用。
- [x] Worktree 会话移出后可搜索与归档，重启仍保留来源，符合条件可移回；移除来源项目不误删已独立的记录或任何 Worktree 文件。
- [x] 搜索结果在重命名、归属变更、归档恢复、项目移除后反映真实记录，不残留可发送到已移除会话的入口。
- [x] 后台输出不使排序跳动、覆盖输入、打断阅读或取消用户交互；切回现场完整，不依赖最终消息补全。
- [x] 所有会话管理入口使用新模型，移除不再有调用者的目录派生分组、旧全局偏好及自动数量清理路径；清理范围限于本重构相关代码。
- [x] 保留执行审批、对话内交互问答、子代理、文件和终端边界、模型协议、主题以及消息级资源等既有有效能力。
- [x] 替换与新语义冲突的旧测试，不能为绿色结果删除仍然有效的安全断言；旧数据迁移不再作为验收要求。
- [x] 真实界面检查常驻侧栏和单主区的完整路径，包括长标题、空项目、无结果、归档列表及当前会话被移除；不要求新增标签页、分屏或分类功能。
- [x] 打包后的冷启动可以在应用数据父目录尚不存在时创建新数据环境并正常打开；不依赖开发态目录残留。
- [x] 更新面向使用者和维护者的相关文档，说明项目与独立会话、新建、归档、退出及不兼容旧数据的边界；将尚未实施的设计说明更新为实际交付状态。
- [x] 测试和构建检查直接取得退出码，不接截断管道；分别报告实际通过、失败和未执行项，不把文档检查或静态渲染冒充完整 E2E。
- [x] 不在本票擅自清理真实用户数据、提交或推送 Git、发布外部服务；这些操作仍按各自授权执行。

## Verification

- [x] `pnpm build`、`pnpm typecheck`、`pnpm test` 实际执行并记录结果；干净环境先构建，避免 desktop/UI 读取陈旧 Core 产物。
- [x] `pnpm test:e2e:all` 实际执行，并将本重构新增 E2E 接入可运行的检查入口，确保完整套件覆盖新行为。
- [x] 核对审批、子代理、用户交互、Worktree、命令等专项仍在验证范围，避免只跑基础冒烟。
- [x] `pnpm dist` 后执行 `pnpm test:e2e:packaged`，验证真实产物与冷启动；完整 E2E 不等价于已验证打包产物。
- [x] 按规格用户故事和票 01–08 验收项做覆盖映射，识别跨票遗漏并补齐必要回归；每张前置票自己的测试不能拖到本票才开始写。
- [x] 完成交付差异审查，确认未引入无关架构替换、权限回退或文件删除路径；清楚列出仍受环境限制而未验证的行为。

## Scope boundary

本票是整合、入口一致性和交付验收，不是把缺失的核心功能集中到最后完成。此前各票须先交付自己可独立展示或验证的纵向行为。

## 实施记录与覆盖映射

工作树 `C:/Users/leffss/Desktop/ai-agent-wt-session-workbench-09`，分支 `feat/session-workbench-09`。开始核对 status/log/merge-base，基线为 `5fc8261`（01–08）；依赖独立安装，产物不共享。用户本次明确授权正常本地提交，不 push、不修改 main、不绕 hooks。

### 已验证的红—绿切片

- UI 命令分发测试先以草稿 `/new` 返回 needs-session 红灯，改为按当前管理归属选择草稿后 17 项绿。
- `entry-consistency.mjs` 真实 Electron 先因缺会话内快捷入口红灯，接入同一个 `startCreateSession` 后绿；独立/项目/Worktree 均不恢复旧空会话创建。
- 展开的搜索在重命名后仍保留旧标题、归档后仍保留可点结果分别真实红灯；按钮与 `/rename` 共用处理，归档/恢复刷新记录 revision 后绿。
- 旧 acceptance 专项真实复现 `create-session-confirm` 30 秒超时；迁移共同 `prepareDraft` 及各脚本必要前提，仍由首次发送创建，权限从 ask 开始且按场景显式切 assist。不删除审批/权限/资源/子代理/Compact/思考/主题有效断言。
- 完整 E2E 初轮在 changes 冷启动将尚未恢复的侧栏计数误判为新增记录；改为公开宿主列表计数后专项绿。第二轮原 interactions 窄窗断言发现新顶栏使面板底部超出 700px 窗口约 8px，允许交互面板随可用空间收缩，原 light/dark 窄窗和滚动断言绿，未增加超时。
- 全局按钮原可见文案仍为“新建会话”，真实入口 E2E 明确独立语义断言红；改为“新建独立会话”并更新空状态说明后绿，最后重新打包保证产物一致。
- 末轮额外复验误与本工作树 `dist` 的 UI 清空重建重叠，acceptance 的 Monaco 动态资源出现 `net::ERR_FILE_NOT_FOUND`，30秒等待失败；日志定位为测试编排导致资源暂时缺失，不修改产品、不增超时，待 UI 构建结束再串行复验。此前完整24专项已独立通过，该次失败不计为通过。
- 共用 `closeApp` 走真正 quit、确认和保存屏障，必要时仅清理自己启动的 PID 进程树；不全局结束其他 Electron。旧无调用 `NewSessionDialog` 删除；目录派生、全局偏好和数量 cleanup 已由前置票退出业务路径。

### 实际运行的检查

命令均在本票工作树执行，使用 `pnpm --dir C:/Users/leffss/Desktop/ai-agent-wt-session-workbench-09 ...` 或该工作树脚本绝对路径，直接获取退出码。基线先独立 `pnpm install --frozen-lockfile`、`pnpm build`；功能提交为 `a9ef0b4`，正常 hooks 完整执行 `check:adr`、lint-staged、typecheck、test，未绕过。

| 命令                                                                            | 已取得结果                                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm build`                                                                    | 退出0，三包实际构建；后续全套与dist还会先重建                                                                |
| `pnpm typecheck`                                                                | 退出0；最终代码与正常提交钩子均通过                                                                          |
| `pnpm test`                                                                     | 退出0，81文件 / runner报告640项通过：Core 416、Desktop 121、UI 103；包含下文明确的Windows文件symlink内部跳过 |
| `pnpm test:e2e:all`                                                             | 退出0，完整24专项脚本；interactions含questions/queue/cancel三组，无删除测试或全局增超时                      |
| `pnpm --filter @codexlike/desktop run test:e2e:entries`（亦以node绝对路径执行） | 退出0；新增真实跨票组合，最后明确独立入口文案再次红绿复验                                                    |
| `pnpm --filter @codexlike/desktop run test:e2e:commands`                        | 退出0；最终引用消息等待只认可本次回复，不由旧气泡满足                                                        |
| `pnpm dist`                                                                     | 退出0，Windows NSIS / portable zip / win-unpacked实际产出；末次文案修正后按已提交 `a9ef0b4` 再次重打包退出0  |
| `pnpm test:e2e:packaged`                                                        | 退出0，真实win-unpacked产物；未预建嵌套父目录、新库、React侧栏、独立草稿、ask默认、发送前零工作区均检查      |

构建保留既有 CJS `import.meta`、第三方 `@__PURE__` 注释和大 chunk 警告；electron-builder 报无代码签名证书、依赖收集退回手动遍历（主进程业务已打包、Playwright经extraResources）。E2E个别退出时 Chromium 打印 GPU `WaitForGetOffsetInRange` / debugger disconnect 信息，不等于用例失败。故意注入的非Git错误、活动整理拒绝、缺失技能、迟到搜索错误、401模型失败、磁盘写失败均由对应断言验证。

发行产物均在本工作树 `packages/desktop/release/`：`CodexLike-Setup-1.0.0.exe`、`CodexLike-1.0.0-portable.zip`、`win-unpacked/CodexLike.exe`。未运行安装/卸载向导，不将冷启动冒烟说成安装器验收。

### 用户故事 → 验收测试

以下宿主测试位于 `packages/desktop/tests/sessions/`，E2E 位于 `packages/desktop/e2e/`；真实 Core/SQLite/Git 及 UI 操作各自覆盖，不以纯函数或静态渲染冒充界面验收。

| 规格故事                                       | 前置票   | 主要已有/新增测试与观察                                                                                                                                                                                           |
| ---------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–7 项目、空项目、非Git、独立归属              | 01       | `workbench-ipc.test.ts`、`projects-sidebar.mjs`：真实SQLite重开、同目录独立不归项目；旧库/旧Worktree保留                                                                                                          |
| 8–16 草稿、首次发送、命名、去重失败、固定目录  | 01/03    | `workbench-ipc.test.ts`、`projects-sidebar.mjs`、`persistent-workbench.mjs`：双击、失败重试、目录延迟建立；`entry-consistency.mjs`：按钮/命令/快捷入口                                                            |
| 17–21 本地/Worktree、延迟与共享提示            | 04       | `worktree-flow.test.ts`、`worktree.mjs`、Core `worktree-service.test.ts`：真实分支/文件/终端隔离及非Git失败重试                                                                                                   |
| 22–26 并行、完整后台现场、等待/未读/失败/中断  | 02       | `live-session-ipc.test.ts`、`live-sessions.mjs`、`interactions.mjs`：模型未结束时A→B→A及主/子代理FIFO，不靠最终补全                                                                                               |
| 27–32 输入/问答/阅读/设置持久与执行快照        | 03       | `workbench-ipc.test.ts`、`persistent-workbench.mjs`、`thinking.mjs`、`subagent-thinking.mjs`、Core approval/subagents：真实进程重开，旧请求不可授权                                                               |
| 33–35 折叠、置顶、最近使用、不因输出跳动       | 05       | `workbench-ipc.test.ts`、`sidebar-archive.mjs`：后台SSE不改顺序，置顶/折叠/用户主动导航重开保持                                                                                                                   |
| 36–39 跨项目标题正文、归档开关/查看恢复/留文件 | 05/06    | `search-ipc.test.ts`、`session-search.mjs`、`sidebar-archive.mjs`；`entry-consistency.mjs`：展开搜索期间重命名/归档/恢复实时一致                                                                                  |
| 40–44 归属、来源、项目移除确认与文件保护       | 07       | `workbench-ipc.test.ts`、`membership.mjs`；`entry-consistency.mjs`：Worktree移出→搜索归档→进程重开→移回→再移出→删除来源项目，记录/副本/草稿设置完整                                                               |
| 45–46 活动保护、不按数量删Worktree             | 04/05/07 | `workbench-ipc.test.ts`、`worktree-flow.test.ts`、Core `worktree-service.test.ts`：宿主启动竞态/等待/Compact保护，超过旧阈值17副本保留                                                                            |
| 47–49 退出取消、flush、异常重启中断不重放      | 08       | `exit-recovery.test.ts`、`exit-recovery.mjs`：真实3次进程、SSE闸门、文件追加副作用、写失败/迟到flush，零自动模型请求                                                                                              |
| 50 所有入口一致及跨票组合                      | 09       | `commands.mjs`、`sidebar-archive.mjs`、`entry-consistency.mjs`：全局/项目/会话快捷/草稿与正式会话/new/rename/archive；搜索结果移除后无悬挂发送目标，长标题/无结果/空项目/归档列表                                 |
| 既有安全、资源与发布                           | 全部     | `smoke`、`acceptance`、`approvals`、`interactions`、`changes`、`interrupt`、`compact`、`browser`、`mcp`、`subagents`、`skills`、`thinking`、`subagent-thinking`、`theme`；`packaged.mjs` 单独验证未预建数据父目录 |

### 未测边界与环境限制

- Windows `mentions.test.ts` 文件符号链接用例因 `EPERM` 在既有分支内提前跳过，runner 会统计通过，不代表该权限分支实测。目录 junction 相关测试仍实际运行；没有变更系统权限。
- 未测试操作系统关机事件、renderer 崩溃导致无法应答保存屏障的恢复UI；硬杀前未落盘瞬态不保证恢复。已落库异常重启及零工具重放由 exit E2E 覆盖。
- 未做超大历史性能压力、非ASCII完整大小写折叠、安装向导/卸载器手动走查或代码签名；SQL 子串搜索与未签名 Windows 发行边界不变。
- 实现者的差异核对与测试不是独立代码审查；主协调者将在集成后另行 code-review。规格用户故事和验收原文未删减。

## 审查修复追踪（2026-11-12）

独立审查 Standards 轴指出本票新增 E2E 的 Profile 按钮使用 section+heading+getByRole 定位、退出/归属弹窗遮罩硬编码 `bg-black/40`。已为真实按钮添加 `profile-create` testid 并统一 22 个脚本定位；遮罩改语义 token `bg-overlay` 并以真实计算色值断言。Spec 轴 P1/P2 修复与本分支最终完整检查表见 [review-fixes.md](../review-fixes.md)。
