# 02: reasoning 落库与恢复

**What to build:** 主会话与子代理的思考过程随终态消息落 SQLite(新增列及迁移,沿用现有 migration 通道),恢复路径把思考重建为消息段,与运行期内存事件重放衔接。完成后重启应用、切回会话都能展开回看历史轮次的思考过程;旧会话(无思考数据)正常打开,对应消息段自然缺失。落库仅为展示,不改变"思考不回传 provider 上下文"的现行行为。[规格](../spec.md)思考过程持久化组用户故事;取舍见 [ADR 0011](../../../../docs/adr/0011-message-stream-timeline-model-and-reasoning-persistence.md)。

**Blocked by:** 01(恢复路径输出消息段形状)。

**Status:** ready-for-agent

- [x] SQLite migration 编号顺延,主会话与子代理的思考文本随终态消息落库
- [x] 重启应用后历史轮次的思考段可展开回看(e2e 场景断言)
- [x] 子代理卡内思考折叠块重启后不空白(e2e 场景断言)
- [x] 运行期内存事件重放与落盘恢复衔接:切走再切回运行中会话,思考不重复、不丢失
- [x] 旧会话(无思考列数据)打开不报错、不产生空块(e2e 场景断言)
- [x] 单测断言反转:历史加载重建思考段(替代现行"历史加载不制造思考块"断言)
- [x] 思考不回传 provider 上下文的行为保持不变(现有契约测试不回归)
- [x] 现有 e2e 场景全绿,新增场景随本票入库

## Comments

**实施提交**: `eb4a72d`（分支 `feat/message-stream-02`，单笔提交；merge `feat/message-stream` 时集成分支 tip 仍为本分支基线 42d4809，Already up to date）。

**实现要点**:

- SQLite：`messages`/`tool_calls` 各增 `reasoning TEXT` 列，沿用现有 PRAGMA table_info 幂等迁移通道（该通道无数字编号，"编号顺延"落实为顺延追加迁移块）；`StoredMessage`/`ToolCallRecord`/`ToolResult` 增可选 `reasoning` 字段。
- 主会话：`assistant-reasoning` 增量分离累积，随终态 assistant 消息落库（中断终态同样携带；error 终态不落思考——error 消息非 assistant 消息，与正文丢弃语义一致）。
- 子代理：思考随 `entry.reasoning` 累积，经 `resultFor` 与最终报告一并回流 spawn_subagent 延迟 tool-result 落库；回填模型的仍只有 output。
- 恢复：`initialTranscript` 把落盘思考重建为思考段（id `thinking-<messageId>-1`，与流式 segmentId 同构，先于正文段）；`subagentFromToolRecord` 重建卡内思考；compact 重写历史复用 `insertMessage`，保留轮次的思考随重写保真。
- 契约保持：`composeStoredMessageContent` 不读 reasoning、provider 层剥离回传逻辑未动，"思考不回传 provider 上下文"的单测（thinking.test.ts"思考不进入后续请求上下文"、"第二轮请求 body 不回传思考"）原样通过。

**检查命令与退出码**:

| 命令                                                      | 退出码                  |
| --------------------------------------------------------- | ----------------------- |
| `pnpm typecheck`                                          | 0                       |
| `pnpm test`（agent-core 418 / desktop 125 / ui 112 全绿） | 0                       |
| `pnpm test:e2e:all`（26 场景含新增 reasoning-recovery）   | 0                       |
| `git merge feat/message-stream`                           | 0（Already up to date） |

**断言反转清单**（原"思考不落库"类断言）:

- agent-core `thinking.test.ts`："思考不写入 StoredMessage" → "思考随终态消息写入 StoredMessage.reasoning，content 仍只含正文"；中断终态断言带 reasoning；真实工厂测试断言 reasoning 字段含跨工具轮思考全文。
- agent-core `subagent-thinking.test.ts`："思考不落库" → "思考随 spawn_subagent 记录落库，报告与思考分离"。
- desktop `live-session-ipc.test.ts`：中断终态后断言 aborted 消息带 reasoning、content 不含。
- e2e `message-order.mjs`：重启恢复序列加入 thinking-block（原注释"票 02 才落库 reasoning"兑现）。

**偏差与说明**:

- 迁移通道无编号体系，按 question_answers 先例以 PRAGMA 检查 + ALTER 顺延实现。
- 全量 `pnpm test:e2e:all` 首次运行时 `projects-sidebar.mjs` 出现一次"无法创建独立会话专用目录"环境性失败（与本题改动无关，该场景自身先通过后失败再单跑通过）；重跑全量一次通过（退出码 0），日志含全部 26 场景通过标记。
- 旧断言"历史加载不制造思考块"在票 01 重写 `session-view.test.ts` 时已被移除，本票以新测试"历史加载重建思考段"+"旧会话不产生空思考段"落地反转语义。
