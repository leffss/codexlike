# 04: 已工作折叠区与轮次分组

**What to build:** 渲染层按轮次聚合呈现(细分隔线+轮间距,不加 agent 名头/头像),轮内以最终正文为界切分:之前的过程消息段(思考、工具卡、中间正文)在轮次完成后整体收进"已工作 N 秒"折叠区,之后的消息段跟随显示;运行中的轮与中断、失败的轮强制展开。折叠开合为渲染层内存态,滚动或切换不丢。工具调用卡摘要增强:类别+动作摘要+状态标识+耗时,失败详情可查,连续同类工具统计分组,子代理卡完成自动收起一次。完成后长会话历史收起只剩各轮最终正文,过程可随时展开回看。[规格](../spec.md)已工作折叠区、工具调用卡、时序保真第 16 条用户故事;切分规则见 [ADR 0011](../../../../docs/adr/0011-message-stream-timeline-model-and-reasoning-persistence.md)。

**Blocked by:** 01(消息段模型与轮次标签);与 03 逻辑独立,可并行实施。

**Status:** ready-for-agent

- [x] 轮次分组呈现:细分隔线+轮间距,无 agent 名头/头像
- [x] 轮次完成后,最终正文之前的过程段整体收进"已工作 N 秒"折叠区,摘要行显示工时;最终正文之后的消息段跟随显示
- [x] 无最终正文的轮次,全部过程段进折叠区
- [x] 运行中的轮强制展开过程(流式实时可见);中断、失败终态强制展开
- [x] 折叠开合为渲染层内存态:滚动、切换会话、虚拟重挂载不丢用户手动开合
- [x] 工具卡折叠摘要 = 类别词+动作摘要+状态标识+耗时;失败详情在状态位可查
- [x] 连续同类工具自动统计分组(组头计数,展开仍由原卡片渲染);子代理卡运行→完成边沿自动收起一次
- [x] 新增 e2e 场景:完成后收起/展开回看/中断强制展开/连续同类分组
- [x] 现有 e2e 场景全绿(thinking 折叠交互、工具卡展开断言随新结构适配但不削弱)

## Comments

**提交**：`0c6b9f9` feat(message-stream): 轮次分组呈现与「已工作」折叠区（票 04）；`1d103f5` merge: 融合票 04 轮次折叠与票 02/03（reasoning 落库 + 滚动跟随，冲突按票语义融合后复跑全部检查）。

**命令与退出码**（合并集成分支后最终态）：

- `pnpm typecheck` → 0
- `pnpm test` → 0（单测 157 项，含新增 turn-view 20 项与 session-view 打点 3 项）
- `pnpm build` → 0
- `pnpm test:e2e:all` → 0（29 场景全绿：现有 26 + 本票新增 worked-history + 票 02 reasoning-recovery + 票 03 scroll-following）

**实现要点**：

- 切分逻辑纯函数 `packages/ui/src/lib/turn-view.ts`（groupTurns/groupConsecutiveTools/formatWorkDuration，TDD 先红后绿）：按 turnId 连续聚簇，轮内最后一段正文为界切 history/following；运行中（段级标记 OR 宿主 streaming）/中断正文/错误段 → historyDefaultOpen=true。
- 折叠开合渲染层内存态 `packages/ui/src/lib/collapse-memory.ts`：open = 记忆值 ?? 默认值的派生态，轮完成自动收起只作用于未手动操作过的键。
- 数据层仅加展示事实：SegmentBase.at（恢复取落库 createdAt）、ToolCallSegment.startedAt/endedAt（运行期 call/result 打点），封闭更新集不变。
- MessageStream 渲染三层（单段分派 → TurnGroupItem → WorkedHistory + 工具统计分组 ToolSequenceView）；ToolCallCard 摘要行加耗时与失败 title；SubagentCard 完成自动收起一次。

**偏差与设计决定**（不降低验收，记录口径）：

1. 「强制展开」实现为默认展开 + 可手动收起（记忆不覆盖，与 ZCode 同构）：运行中/中断/失败轮默认展开保证流式实时可见与回看，用户主动收起被尊重。
2. 交互/错误/状态/compact-summary 段**穿透**折叠区（GLOSSARY 已工作折叠区枚举为思考/工具调用/中间正文）：审批记录等用户可见节点按相对顺序显示在折叠区之后，pending 交互不被藏进过程区。
3. 工具回填后、下一段事件前的间隙段级 running 标记全静止，补宿主 streaming 态（WorkspacePage → MessageStream → groupTurns lastTurnRunning）把最后一轮视为运行中，消除闪收（browser.mjs 场景抓到该缺口）。
4. 现有场景适配方式统一为「等轮完成 → expandWorkedHistory 幂等展开 → 原断言」或「mock 请求计数为时机信号」，断言不削弱（thinking 折叠交互、工具卡展开、<4px 阅读位置等全部保留）；helpers.mjs 新增 expandWorkedHistory（容忍完成边沿竞态）。
5. 已知偶发（与票 04 无关，重跑即过，基线亦有）：interactions 端口偶撞 bad port、exit-recovery 写失败注入竞态、worktree 侧栏 hover 竞态。
