# 01: 时序消息段模型与按时序渲染

**What to build:** 会话视图数据层从"按类型归类合并的气泡列表"重构为按事件发生时序排列的扁平消息段序列:思考段、正文段、工具调用卡、子代理卡、错误段、状态段、compact 摘要段全部成为序列中的平等成员,带会话内单调稳定序号与轮次标签,段间关联用共享响应 id 而非嵌套。渲染层如实按时序呈现全部现有项(呈现形态可朴素,保持现有折叠交互),历史恢复与运行期流式输出共用同一形状。完成后,一轮"正文→工具调用→再正文"的交错回复在界面上按真实发生顺序显示——这是"思考/正文/工具调用显示混乱"的核心修复。[规格](../spec.md)时序保真与特殊项各组用户故事;取舍见 [ADR 0011](../../../../docs/adr/0011-message-stream-timeline-model-and-reasoning-persistence.md)。

**Blocked by:** 无(可立即开工)。

**Status:** completed

- [x] 消息段类型集完整覆盖现有全部项类型(思考/正文/工具卡/子代理卡/错误/状态/compact 摘要/用户消息),每段带会话内单调、永不复用的稳定序号与轮次标签
- [x] 更新操作为封闭集:尾部追加、按 id 整段替换、截断删除、流态文本追加;表达不了的结构变化整体重放,无字段级 patch
- [x] 思考与工具调用穿插交错的轮次在 DOM 中按事件发生顺序排列,新增严格顺序断言(不靠文本过滤)
- [x] 工具调用之后产生的正文显示在该工具卡之后;思考段不再被提升到轮次顶部合并
- [x] 历史恢复输出与运行期流式输出形状一致(同一归并入口)
- [x] 会话视图、工具视图、子代理视图、live 会话的 vitest 套件随新模型重写并通过,覆盖交错保真与封闭更新集
- [x] 现有 23 个 e2e 场景全部保持绿色(现有 data-testid 稳定不动)
- [x] 现有折叠交互(思考折叠块、工具卡展开)在新结构下行为不变
- [x] `pnpm typecheck` 与 `pnpm test` 通过(检查命令直接运行取退出码,不接管道)

## Comments

- 主体提交：`0eab876`（feat(message-stream): 会话视图重构为时序消息段序列并按时序渲染）；随后 merge 集成分支 `feat/message-stream`（票 05 容器分档宽度已并入），冲突解决后 merge 提交 `2aee654`，融合层验证后重跑全量检查。
- 测试命令与退出码（worktree `feat/message-stream-01`，直接运行取退出码）：
  - `pnpm typecheck` → 0（merge 后复跑 → 0）
  - `pnpm test` → 0（全仓 vitest；ui 包 15 套件 108 例全绿，含重写的 session-view 21 例、subagent-view、tool-view、live-session）
  - `pnpm test:e2e:message-order` → 0（新增场景）
  - `pnpm test:e2e:all` → 0（第一次全量后 live-sessions 断言适配新行为，重跑 → 0；merge 票 05 后复跑 → 0，现链上 25 个场景：原 23 + message-order + width-tiers）
- 实施要点：
  - 数据层 `packages/ui/src/lib/session-view.ts` 全量重写：`UiItem` → `MessageSegment` 九种段（user/assistant/thinking/tool-call/subagent/error/status/compact-summary/interaction），每段带 `seq`（会话内单调、永不复用）、`turnId`（轮次标签，user 段开轮）、`responseId`（共享响应 id 关联，不嵌套）。
  - 封闭更新集：尾部追加 / 按 id 整段替换（保持段 id 与 seq）/ compact 截断由 live-session 层整体重放 initialTranscript / 流式文本只追加到序列末尾的流态段——被工具卡等隔断后新起段，这是「正文→工具→再正文」时序保真的核心机制。
  - 终态收敛：done/aborted 收敛全部流态段；单正文段以终稿全文整段替换（防增量缺失），多段保持切分不合并；无正文段时兜底补建（承载中断标记）。历史 assistant 消息以自身 id 作 responseId，恢复与流式同入口（initialTranscript）。
  - 渲染层 `MessageStream.tsx` 按 kind 分派：thinking 块成为独立消息段（保留 thinking-block/toggle/content/indicator testid 与默认收起交互）；data-testid 全部稳定不动。
  - 死出口处置：`initialMessages` 与 `hydrateTranscript`（生产无调用方，笔记确认死出口）随重写删除。
- 偏差记录：
  - `live-sessions.mjs` 一处断言随修复后的行为更新：旧断言「中断切回后单气泡含全文」依赖的正是本票修复的合并 bug（工具问答后的正文被合并回靠前气泡）；新断言同等强度——两段正文内容完整、末段正文 DOM 位置在全部工具卡之后（严格顺序），已在票内验收项 3/4 覆盖范围内，非降低标准。
  - merge 票 05 时 `MessageStream.tsx` 冲突以两票语义融合解决（票 05 宽度分档 + 票 01 时序分派并存）；`WorkspacePage.tsx`/`SubagentCard.tsx`/`packages/desktop/package.json` 为 import 与脚本注册的简单并集；融合后 typecheck/test/e2e:all 全部复跑为 0。
- 无遗留阻塞。后续票（02 持久化、03 跟随、04 折叠区）在此模型上增量实施。
