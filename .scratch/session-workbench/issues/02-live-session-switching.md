# 02: 切换会话时完整保留执行现场

**What to build:** 用户在多个并行会话之间切换时，后台任务与等待继续；切回仍在运行的会话立即看到完整正文、工具记录和待处理交互。侧栏能区分执行、等待、完成未查看、失败和中断，不依赖当前打开的页面维持运行信息。

**Blocked by:** 01 — 建立项目与独立会话的新建闭环。

**Status:** completed

**Spec:** [会话工作台重构规格](../spec.md)

## Acceptance criteria

- [x] 当前查看的会话与正在执行的会话分离，项目会话和独立会话均可并行；切换项目或会话不停止执行或取消等待。
- [x] 完整运行现场可经统一公开接口重新取得，不只保存在当前 renderer 页面或只依赖轮末落库历史。
- [x] 模型尚未完成时 A→B→A，A 已生成正文立即完整显示，后续增量继续接上；不等待最终完成事件补全。
- [x] 切换前后工具开始、输入、输出和终态完整；错过工具开始事件也不导致工具结果永久丢卡。
- [x] 取得初始现场与接入后续事件之间不漏事件、不重复消息或工具卡片；会话与执行标识防止旧执行迟到事件污染新执行。
- [x] 后台审批、交互问答及子代理所属请求保持在正确会话；用户响应只影响对应请求，不因切换而错误回答或恢复别的会话。
- [x] 侧栏明确显示执行中、等待用户处理、完成未查看、失败和中断；查看状态与执行状态分离，查看不会改变任务运行结果。
- [x] 停止任务仍是显式操作；停止后的事件不能把已停止会话恢复为运行中或追加到别的会话。
- [x] 后台逐条输出不成为最近使用排序的输入，不使列表反复跳动；票 05 的排序沿用此规则。
- [x] 不增加未经确认的全局并发禁止规则，不改变既有子代理并发与授权限制。
- [x] 不以运行现场完整为由扩大历史持久化范围；现有运行期思考内容的落盘策略保持。

## Verification

- [x] 用可控模型和事件闸门在生成未结束时进行切换，断言正文增量和工具记录在中途即可取得；不能只检查最终正文。
- [x] 覆盖初始现场与增量接续、错过工具开始但收到结果、停止后迟到事件以及两个会话交错输出。
- [x] 真实 Electron E2E 操作 A→B→A，检查正文、工具卡、等待用户交互及侧栏状态；同时验证独立会话和项目会话组合。
- [x] 回归跨会话审批隔离、问答队列和主任务停止联动，保留现有有效权限与子代理测试。

## Scope boundary

本票保证当前应用生命周期内的运行现场完整；持久草稿与偏好由票 03 完成，退出中断和真实重启由票 08 完成。不加入退出后的常驻执行或自动续跑。

## 交付记录（2026-11-11）

- 分支 `feat/session-workbench-02`；专属工作树基线 `da9cb26`。提交前 `git merge feat/session-workbench`（tip `da9cb26`）返回 `Already up to date`；最终提交 hash 由交付消息给出。
- `sessions.view(id)` 原子返回 `{ sessionId, executionId, sequence, history, events, pendingInteractions, activity }`：`history` 固定为当前执行起点，`events` 是宿主内存保存的该执行完整日志。沿用原 `sessions.start/send` 和 executionId，不另建首次发送入口。先订阅、再读取现场，仅应用大于快照 sequence 的信封；水位跨执行递增，旧执行/其他会话/重复/终态后的事件被隔离。启动前失败恢复前一现场与水位，compact 后刷新历史底座。
- `SessionEventEnvelope` 新增 `sequence`、`activity`；`sessions.list()` 返回 `SessionListItem`（原记录附可选 `activity`）。activity 将 running/waitingForUser 与 outcome（completed/failed/interrupted）、unread 分开；`sessions.markViewed(id, sequence)` 仅确认看见的水位，不消费更晚完成提醒，不改 updatedAt/lastUsedAt，也不调用票05的 markUsed。后台正文不刷新列表或写最近使用；置顶/最近使用排序仍由票05负责。
- 运行日志与思考仅驻内存、限定最后一次执行，不扩大 SQLite 历史范围。切出会话、草稿或设置不停止执行。停止仍走原中断通道，停止后只收清理终态；工具结果可补齐错过开始的普通/子代理卡片。审批、问答和子代理请求仍由 Core 按 sessionId/requestId 校验。
- 热点仅局部接入，逻辑分别提取到 `desktop/src/sessions/live-sessions.ts`、`ui/src/lib/live-session.ts` 与 `SessionActivityBadge.tsx`；未修改 workspace-state、Core schema、其他票或全局任务索引。

### 红—绿与实际验证

所有命令在本工作树运行，依赖独立安装、产物本树构建，直接取退出码。

- `pnpm --filter @codexlike/desktop test tests/sessions/live-session-ipc.test.ts`：依次以缺少 view、缺少 mark-viewed、停止仍 running、启动失败清空水位失败，再逐片实现变绿；最终 5 测试通过。真实 Core、文件 SQLite、HTTP/SSE 闸门覆盖双会话交错、快照与实际推送信封接续、工具等待/停止、旧水位已读、失败重试、思考不入历史。
- `pnpm --filter @codexlike/ui test tests/session-view.test.ts tests/live-session.test.ts`：工具结果丢卡、缺少信封接续模块、停止清理中切回无法收敛先红后绿。替换与新规格冲突的「未知 tool-result 永久丢卡」旧断言；旧执行由信封边界隔离。
- `pnpm --filter @codexlike/desktop test tests/sessions/live-session-ipc.test.ts tests/sessions/interactions-ipc.test.ts tests/sessions/workbench-ipc.test.ts tests/sessions/resources-ipc.test.ts tests/sessions/interrupt-registry.test.ts`：5 文件 20 测试通过。
- `pnpm --filter @codexlike/ui test`：15 文件 98 测试通过。
- `pnpm --filter @codexlike/agent-core test tests/session/interactions.test.ts tests/session/subagents.test.ts tests/session/agent-session-approval.test.ts tests/session/approval.test.ts tests/session/subagent-thinking.test.ts`：5 文件 62 测试通过。
- `pnpm typecheck`、`pnpm build`：通过。构建保留既有 import.meta/CJS、第三方 PURE 注释和包体积警告。
- `pnpm --filter @codexlike/desktop test:e2e:live-sessions`：先真实复现未完成 A→B→A 缺正文的红测，接入后通过。真实点击项目A/独立B切换、后台正文与工具起止/输出、审批和问答、错会话响应拒绝、完成未查看、失败、中断。新增脚本已纳入 desktop 的 test:e2e:all，但本票未运行全集。
- `CODEXLIKE_E2E_INTERACTION_CASE=queue pnpm --filter @codexlike/desktop test:e2e:interactions`：通过。只适配 queue 首次发送前置，并验证切出/切回恢复两张子代理卡与主/子代理三项 FIFO 问答审批、正确响应和报告回流。
- `pnpm --filter @codexlike/desktop test:e2e:projects`：通过，首次发送及显式归属必要回归。
- **未验边界**：未运行 `pnpm dist`、打包冷启动、全量 E2E 或 interactions 的 questions/cancel 场景；后两场景旧新建前置仍由相应后续票适配。跨重启执行终态归08，草稿/偏好持久化归03，侧栏完整排序归05；本票不声称这些票已完成。
