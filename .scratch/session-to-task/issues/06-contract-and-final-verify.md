# 06: contract 收尾与终验

术语依据换词后的 `GLOSSARY.md`；上游票 02–05 全部完成后本票解锁（expand–contract 的 contract 阶段）。

**What to build:** 删干净所有兼容层与旧名残留——agent-core 旧名导出、desktop 旧 channel 双注册；全仓残留 session 词汇清扫，全链终验绿。

**Blocked by:** 02, 03, 04, 05

**Status:** done

- [x] 删除 agent-core 公共导出的旧名 re-export 别名
- [x] 删除 desktop IPC 旧 channel 双注册兼容层
- [x] 全仓 grep 清扫：`session`/`Session`/`sessionId` 标识符仅存于允许处（GLOSSARY 避免词列表、ADR 历史记录、git 历史），残留清单逐项确认或清除
- [x] 子代理 `task` 参数与事件字段确认仍为原名（撞名决策未被误伤）
- [x] 终验全绿（直接退出码）：三包 vitest、lint、typecheck、`check:adr`、`check:e2e-locators`、e2e 全量链、dist
- [x] `.scratch/session-to-task/` 系列票状态收口

## Comments

**实现记录（contract 阶段，2026-11-14，分支 `session-to-task-06`，基点 985e166）：**

- 提交序列（每提交点 pre-commit 全链：lint / check:adr / check:e2e-locators / lint-staged / typecheck / test）：
  - `fea3e30` + `8e3d6d7` 深层 record 字段与数据值定稿 + 局部词汇清零（83 文件，tdd 切片：scope 值与 branch-name 回退先红后绿，字段重命名以 typecheck 为红绿安全网）：
    - agent-core 深层 record 字段 `sessionId`→`taskId`：`InteractionRequestBase` / `ToolExecutionContext` / `ToolCallRecord` / `ApprovalDecisionRecord` / `StoredMessage` / `CompactRecord` / `ApprovalRequest`（DB JSON 耦合，新库从零无兼容包袱）；三包 + e2e 消费侧与测试 fixture 联动
    - 审批授权 scope 数据值 `"session"`→`"task"`：`InteractionResponse` 类型、controller/questions 判定与报错文案、persistence mock、ui InteractionPanel/History 联动
    - branch-name：形参 `sessionTitle`→`taskTitle`、空 slug 回退 `"session"`→`"task"`（分支 `codexlike/task`）
    - 局部词汇清零：`makeSession`/`makeSubagentSession`/`makeSubagentThinkingSession`/`runSession`/`createSessionWithMode`/`findSession`/`assertQueueSession`/`sessionKey`、e2e `currentSessionId`/`firstActiveSessionId`/`assertCurrentSession`/`assertNoOpenSession`/`assertIdleNewTaskEntry`/`createSession`/`selectSession`/`sessionA`/`projectSession` 等；`"session-` ID 占位与 `existing-session.png` fixture 更名
  - `b24534d` desktop 兼容层删除（20 文件）：
    - `task-ipc.ts`：`dualHandle` 删除，33 个 `tasks:*` channel 改 `ipcMain.handle` 单注册；`emit`/`acceptQueue` 停发 `session:events`
    - `preload.ts`：删 `sessions` 命名空间（`taskApi(IPC.sessions)`）与 `onSessionEvent`
    - `shared/ipc.ts`：删 `IPC.sessions` 常量集（33 channel）、`IPC.sessionEvents`、类型反向别名（`SessionEventEnvelope`/`SessionActivity`/`SessionListItem`/`SessionView`/`StartSessionInput`/`SessionExecutionState`/`SessionStatusInfo`）、`CodexLikeApi.sessions` 成员与 `onSessionEvent` 方法
    - 守护测试改造为「旧名不存在」负向断言（先红后绿）：`channel-aliases.test.ts` 改名 `legacy-session-channels-absent.test.ts`（断言 `IPC` 无 `sessions`/`sessionEvents` 键、注册表无 `sessions:*`/`session:events`、`tasks:*` 正常可用）；`preload-task-namespace.test.ts` 断言 api 无 `sessions`/`onSessionEvent`、`onTaskEvent` 订阅唯一事件流；`live-task-ipc.test.ts` 删双通道序列一致断言；approval-preload/resources-ipc 切 `api.tasks`/`IPC.tasks`
    - e2e 34 处 `window.codexlike.sessions.*`→`tasks.*`、`onSessionEvent`→`onTaskEvent`（12 文件）
  - `7029f01` agent-core 入口旧名别名删除 18 项：`index.ts` 7 类型别名 + `node.ts` 11 类型/工厂别名；desktop `search-ipc.test.ts` `SessionSearchResult`→`TaskSearchResult` 联动
  - `bcfe39a` e2e 场景文件与脚本名：`session-search.mjs`→`task-search.mjs`、`live-sessions.mjs`→`live-tasks.mjs`（git mv）；根/desktop `package.json` `test:e2e:live-sessions`→`test:e2e:live-tasks`、`test:e2e:search` 指向与 `test:e2e:all` 串联引用联动；`live-tasks.mjs` console tag「[e2e] live tasks」；e2e README 场景表第 16/23 行同步
  - 同提交文档清扫：README 数据目录段修正（`task-workbench.db`、`tasks/` 目录）与全文「会话」文案清零、182 行历史工单目录路径保留并注明缘由；`docs/testing/subagent-delegation.md` 过时路径修复（`src/session/`→`src/task/`、`agent-session`→`agent-task`）
  - `0bd62fb` 全仓清扫收尾：desktop 测试自建临时库文件名 `session-workbench.db`→`task-workbench.db`（16 处，自建文件与 main 常量无耦合）、CODING_STANDARDS 现行规范用词「会话 workspace」→「任务 workspace」

- **全仓 grep 残留清单（`session`/`Session`/`sessionId`/「会话」，逐项允许理由）：**

  代码与测试：
  1. `desktop/src/main.ts:99-100,416`——注释「旧 `session-workbench.db` 不读取、不迁移、不删除」：ADR 0014 旧库文件处置行为说明，旧文件名是磁盘历史实体，必须原样引用
  2. `desktop/src/tasks/screenshots.ts:2`——注释「session→task 改名随票 03 换目录」：目录约定变更缘由说明（对应 ADR 0014）
  3. `desktop/e2e/packaged.mjs:2`——注释「当日事故：`createSqliteSessionStore` 不建父目录」：2026-11-11 历史事故记录，函数名为事故当时名称
  4. `desktop/tests/tasks/preload-task-namespace.test.ts`、`legacy-session-channels-absent.test.ts`——「旧名不存在」负向断言语义本身须引用旧名字符串（`"sessions"`/`"onSessionEvent"`/`"sessions:*"`/`"session:events"`）及「会话→任务改名」缘由注释

  文档：5. `GLOSSARY.md`——「任务（Task）」词条 _Avoid_ 列表（session、会话、chat、conversation）与「子代理」词条撞名决策说明：避免词列表是术语规范组成部分6. `docs/adr/*`（0010/0012 标题、0014 全文等）——历史决策记录不改写 7. `docs/research/zcode-message-stream.md`——外部上游调研笔记，记录外部事实8. `README.md:182`——`.scratch/session-workbench/` 磁盘历史工单目录真实路径与「会话→任务改名系列票」描述9. `CODING_STANDARDS.md:21`——2026-11-11 历史事故记录引用（`createSqliteSessionStore`）

  git 历史：改名前提交天然含旧名，不在清理范围。

- **子代理撞名确认（ADR 0014）：** `spawn_subagent` 的 `task` 参数（`subagent.ts` `required: ["task"]`）、`InteractionSource` 子代理变体 `task: string`、`TaskEvent` 的 `subagent-queued`/`subagent-start`/`subagent-report` 变体 `task` 字段全部保持原名（委派说明语义），未被本票改名波及；同文件 `taskId`（任务标识）与 `task`（委派说明）并存且语义分明。

- **终验（直接退出码，全部 0）：** `pnpm check:adr`（14 篇无重复）、`pnpm check:e2e-locators`（35 场景文件）、`pnpm lint`、`pnpm typecheck`（三包）、`pnpm test`（agent-core 434 / desktop 265 / ui 280）、`pnpm test:e2e:all`（33 场景含 build）、input-queue 五件套（`input-queue`/`-items`/`-pause`/`-composer`/`-restart`，desktop 直连）、`pnpm dist`、`pnpm test:e2e:packaged`。
