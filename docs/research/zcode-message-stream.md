# ZCode 聊天消息流显示 — 源码调研报告

> 调研对象:[zai-org/ZCode](https://github.com/zai-org/ZCode)(Z.ai 的 coding agent 工作台,Apache-2.0)
> 调研日期:2026-11-12,基于 `main` 分支当时代码
> 目的:为本项目(React + Tailwind Web UI)的消息流重构提取**可迁移的设计思想**。不照抄代码。
>
> **关于目录位置的说明**:本仓库 `docs/` 下原有 `adr/`(决策记录)与 `agents/`(agent 工作约定)两个目录,没有现成的调研笔记目录,故新建 `docs/research/` 存放本报告。
>
> **重要前提(纠正一个预期偏差)**:ZCode 不只是终端 TUI。它是一个 pnpm monorepo,同时包含:
>
> - **Web/桌面 UI**:`packages/ui`(React + Tailwind + Zustand 共享组件)、`packages/web`、`packages/desktop`(Electron)——聊天界面核心在 `packages/ui/src/v4/`(内部代号 V4 timeline);
> - **TUI**:`apps/zcode-cli/packages/tui`(基于 OpenTUI/Ink fork 的 React 终端 UI);
> - **协议层**:`packages/shared/src/zcode-protocol-v4/`(Web/TUI 共享的消息行协议)。
>
> 因此本报告以 **Web V4 timeline 为主线**(与我们的技术栈同构,可直接参考),TUI 作为对照(标注哪些机制是 TUI 特有)。
>
> 标注约定:**【源码】**= 在源码/文档中直接看到的事实,附链接与行号;**【推断】**= 我的分析判断。

---

## 问题 1:滚动 / 跟随策略

### 1.1 核心:显式的 FOLLOWING / DETACHED 状态机,而不是瞬时几何判断

ZCode 为消息流滚动维护一个**显式吸底状态机**,有专门的设计文档与纯函数模块:

- 设计文档 [`docs/ui/chat-scroll-bottom-pinning.md`](https://github.com/zai-org/ZCode/blob/main/docs/ui/chat-scroll-bottom-pinning.md):

  > 【源码】"`isPinnedToBottom=true` 表示当前视口吸附在消息底部,流式输出、thinking shimmer 和消息布局变化时自动跟随到底部。`isPinnedToBottom=false` 表示用户已经离开底部,流式输出不得覆盖用户当前阅读位置。"(第 8-9 行)
  > "FOLLOWING / DETACHED 表达**用户滚动意图**,不是每次读取 `scrollHeight - clientHeight - scrollTop` 得到的瞬时几何结果。"(第 25-26 行)

- 纯函数实现 [`packages/ui/src/v4/timelineScrollAnchor.ts`](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/timelineScrollAnchor.ts)(无 DOM/React 依赖,可单测):
  - 【源码】`BOTTOM_ANCHOR_EPSILON_PX = 48`(第 13 行):距底 ≤48px 视为"在底部",容差覆盖亚像素滚动与末行 padding;
  - 【源码】`resolveFollowingAfterScroll({ following, metrics, source })`(第 57-65 行):**只有 `source === "user"` 的 scroll 事件才能改变跟随态**;`programmatic` / `layout` 来源的滚动只更新几何账目、不动状态机;
  - 【源码】`anchorActionAfterContentChange(following)`(第 71-76 行):内容变化(新行/流式 delta/测高修正)后,跟随中 → `stickToBottom`,已解除 → `hold`(绝不拉回);
  - 【源码】`shouldShowBackToBottom(following, rowCount)`(第 200-205 行):"回到底部"按钮仅在 `!following && rowCount > 0` 时显示;
  - 【源码】`initialFollowing()` 恒为 `true`(第 208-210 行):打开会话默认定位最新消息。

### 1.2 如何区分"用户在翻历史"和"应该跟随底部"

三个层次的手段:

1. **输入意图识别先于 scroll 事件**。【源码】`timelineWheelScrollIntent(deltaY)`、`timelineTouchScrollIntent(prevY, nextY)`、`timelineKeyboardScrollIntent({key, shiftKey, editableTarget})`(timelineScrollAnchor.ts 第 109-152 行)把 wheel/touch/键盘输入翻译成 `awayFromBottom | towardBottom | none` 方向意图。键盘规则里 `ArrowUp/PageUp/Home` = 向上,`Shift+Space` = 向上、`Space` = 向下,且输入控件内的按键不算(第 128-152 行)。

2. **scroll 事件竞争对账**(这是他们踩过坑的重点)。【源码】`reconcileFollowingForContentAnchor()`(timelineScrollAnchor.ts 第 169-197 行)的注释直接写明动机:

   > "scroll 事件在滚动发生后的下一渲染帧才派发:用户上滚(wheel)之后、事件派发之前,若恰好落进一个 totalSize/rowCount 变化的 React commit(流式 delta、ResizeObserver 测高修正),贴底 effect 会拿着**过期的 following=true** 把 scrollTop 拽回底部,且回弹落点让随后的 scroll 事件把跟随判回 true——用户的上滚被整体吞掉。"

   对账规则(第 164-167 行注释):明确向上滚动 → 立即解除跟随(同帧 terminal/layout commit 也必须让位);没有用户输入 → 保持 following(virtualizer/折叠导致的 scrollTop 回退不算上滚);方向未知 → 落点在底则恢复,明显回退则解除。

3. **接线在 `ConversationTimeline.tsx`**。【源码】[`packages/ui/src/v4/ConversationTimeline.tsx`](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/ConversationTimeline.tsx) 第 587 行 `const followingRef = useRef(initialFollowing())`;第 950 行 `commitFollowing`;第 1352-1363 行 ResizeObserver 回调内先 `reconcileFollowingForContentAnchor` 再决定是否吸底;第 1440-1449 行 scroll handler 用 `resolveFollowingAfterScroll` 裁决。文档总结的优先级表(chat-scroll-bottom-pinning.md 第 43-53 行):

   | 事件来源                                        | FOLLOWING 时          | DETACHED 时                  |
   | ----------------------------------------------- | --------------------- | ---------------------------- |
   | wheel/touch/键盘/滚动条向上离底                 | 立即转 DETACHED       | 保持 DETACHED                |
   | 用户滚回底部附近                                | 保持 FOLLOWING        | 转 FOLLOWING                 |
   | 点击"回到底部"或提交新 prompt                   | 保持 FOLLOWING 并贴底 | 转 FOLLOWING 并贴底          |
   | live delta、terminal 折叠、virtualizer 测高补偿 | 保持 FOLLOWING 并贴底 | 保持 DETACHED,**不夺滚动权** |
   | 查找、轮次导航、fork 锚点定位                   | 先转 DETACHED 再定位  | 保持 DETACHED                |

### 1.3 触发条件与实现细节

- 【源码】贴底动作用**直接赋值**而非 smooth scroll:`scrollRef.current.scrollTop = scrollHeight - clientHeight`,"避免流式输出期间连续 smooth scroll 造成抖动"(chat-scroll-bottom-pinning.md 第 58 行)。
- 【源码】"提交需要定位到最新消息的 prompt 时,使用 instant `scrollTop` 写入并立即进入吸底状态;同一处理内必须同步提交当前 session 的吸底记忆……确保紧接着切换 session 仍按'吸底'恢复"(同上第 59 行)。即**用户新发言 = 强制回底**,这是重要的交互规则。
- 【源码】resize(宽度变化)时的特殊处理:宽屏下文字重排会让多条消息分批重测高度。跟随态走"绘制前批处理:读行高 → 更新 virtualizer 缓存 → 同步提交 React 占位 → 再确认跟随权 → 吸底";离底态则暂停逐行滚动补偿防止抖动,且"resize 中上滚、搜索或会话切换不能被后续测高抢回滚动权"([`docs/ui/chat-virtual-scroll.md`](https://github.com/zai-org/ZCode/blob/main/docs/ui/chat-virtual-scroll.md) 第 20-34 行);对应纯函数 `shouldAdjustVirtualizerForItemSizeChange`(timelineScrollAnchor.ts 第 82-97 行,`contentWidthChanging` 时抑制补偿)。
- 【源码】terminal(轮次结束)切换的成批布局变化(running live tail 迁入虚拟历史 + 自动折叠 + 测高)如果发生在 FOLLOWING,继续贴底;发生在 DETACHED,保持阅读位置;与用户同帧上滚竞争时用户赢(chat-scroll-bottom-pinning.md 第 36-37 行、第 70 行)。
- 【源码】滚动条出现/消失不引起横向跳动:滚动容器加 `[scrollbar-gutter:stable_both-edges]`(ConversationTimeline.tsx 第 2038 行)。
- 【源码】禁用浏览器原生 scroll anchoring:`style={{ overflowAnchor: "none" }}`(ConversationTimeline.tsx 第 2068 行),因为虚拟列表自管 prepend/吸底/记忆锚点,原生锚点会干扰(注释:Chrome 会把 sticky composer 选作 scroll anchor 覆盖恢复值)。

### 1.4 跨会话滚动记忆(LRU)

【源码】[`packages/ui/src/lib/chatSessionScrollMemory.ts`](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/lib/chatSessionScrollMemory.ts):

- 状态只有 `{ scrollTop, scrollHeight, clientHeight, wasPinnedToBottom, updatedAt }`(第 1-7 行);
- 键 = `workspace::pane:<paneId>::session:<sessionId>`(第 38-66 行),按 workspace/pane/session 三级隔离;
- 最多 200 项 LRU(第 9、27-36 行),只活在当前 renderer 进程,不写 localStorage(文档第 65 行);
- 恢复规则:记忆里 `wasPinnedToBottom=true` → 切回时滚到**当前**最新底部并继续吸底(旧 scrollTop 作废);否则恢复保存的像素位置并按当前高度夹紧(`resolveChatSessionScrollRestoreTop`,第 139-145 行);无记忆 → 滚到底并吸底(文档第 33 行)。

### 1.5 历史向上分页(prepend 锚定)

【源码】timelineScrollAnchor.ts 第 212-306 行:

- `prependScrollAdjustment`:向上前插历史行时,`scrollTop' = scrollTop + (nextTotalSize - prevTotalSize)`,即锚定用户正在读的行不跳动;仅当"首行 rowId 变小"(真前插)才平移(第 267-276 行);
- 触发阈值 `LOAD_OLDER_TRIGGER_PX = 64`(距顶 64px 拉取更早一窗,第 279 行),并**提前两个视口预取**(`LOAD_OLDER_PREFETCH_VIEWPORTS = 2`,第 282 行);
- 前提注释(第 218-220 行):既有 render unit key 稳定(`getItemKey = turnId`)且同帧无其他测量修正。

### 1.6 TUI 侧对照(OpenTUI / Ink)

TUI 不是自研状态机,分两层:

- 【源码】组件层:transcript 容器是 OpenTUI 的 `scrollbox`,直接开 `stickyScroll: true, stickyStart: "bottom"` 和 `viewportCulling: true`(视口裁剪,等价虚拟化)([`apps/zcode-cli/packages/tui/src/app-transcript-components.tsx`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/tui/src/app-transcript-components.tsx) 第 43-49 行)。**【推断】**sticky 语义由 UI 框架内置:内容增长时若视口已在底部则跟随,用户上滚则解除——Web 端那套 FOLLOWING/DETACHED 竞争问题在这里被框架吸收了一部分。
- 【源码】策略层文档 [`apps/zcode-cli/docs/design/v2/tui-mouse-scrollback.md`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/design/v2/tui-mouse-scrollback.md) 第 94-100 行给出了 TUI 自己的等价规则:

  > "`scrollOffset` never drops below `0`. …… **New prompts reset `scrollOffset` to `0`.** Live events keep following the newest output **only when `scrollOffset` is already `0`**; otherwise the user remains in scrollback."

  即 TUI 用"`scrollOffset === 0` ⇔ 跟随"的单变量编码,与 Web 的 FOLLOWING/DETACHED 同构,只是没有 48px epsilon(终端行粒度,0 行即贴底)。

### 对我们 Web UI 的可迁移启示

1. **把"是否跟随"建成显式状态(ref),而不是每帧算 `scrollHeight - clientHeight - scrollTop`**。用 epsilon(他们取 48px)判定"在底部附近"。
2. **只有真实用户输入(wheel/touch/键盘方向)可以改变跟随态**;程序化贴底、布局变化、测高补偿产生的 scroll 一律不动状态机。这是"用户翻历史不被流式内容拽走"的根本保证。
3. **警惕 scroll 事件滞后一帧与 React commit 的竞争**:在执行贴底 effect 前先对账"最近一次用户滚动方向"(可以在 wheel/touch 捕获阶段先登记意图),方向向上则同帧让位。
4. **提交新 prompt = 强制回底并立即进入吸底**;查找/跳转类定位 = 先退出吸底再定位,避免下次流式更新把定位结果拉回底部。
5. 贴底用**直接 `scrollTop` 赋值**,不要 smooth;容器加 `scrollbar-gutter: stable` 防横向跳动;虚拟列表下显式 `overflow-anchor: none`。
6. "回到底部"浮出按钮的可见性 = `!following && rowCount > 0`,不依赖 overflow 判断。
7. 若做虚拟滚动 + 向上加载历史,必须做 prepend 锚定(`scrollTop += 前插增量`),且 row key 要稳定。
8. TUI 特有、不必照搬:`scrollbox` 的框架级 sticky(`stickyScroll/stickyStart`)是 OpenTUI 组件能力;`scrollOffset` 以"渲染行数"为单位的编码也依赖终端行模型。Web 上用像素距离 + epsilon 更自然。

---

## 问题 2:消息块时序数据模型

### 2.1 协议层:按事件时序的**扁平行列表**,turn 是标签不是容器

这是整个设计里最值得借鉴的一点。协议定义在 [`packages/shared/src/zcode-protocol-v4/rows.ts`](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol-v4/rows.ts),文件头注释(第 3-5 行)直接给出三条结构性规则:

> 【源码】"三条结构性规则:**row 自包含(渲染任一行不需看别的行);结构变化换整行(row.upserted),文本增长用 append(row.delta);turn 是 row 上的标签,不是容器**。"

具体结构:

- 每行都有 `rowBaseFields`:`rowId`(session 内单调、永不复用)、`turnId`(轮次标签)、`createdAt`/`createdAtSeq`、可选 `actions`(canFork/canEdit/canRetry 等)(第 16-37 行)。
- **九种行类型**(discriminated union on `kind`,第 455-465 行):
  | kind                                                          | 内容                                                                                      | 状态字段                                                                 |
  | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
  | `turnHeader`                                                  | 轮次头:origin/executionKind/**state**/activeMs/fileChanges/workSegments(第 68-116 行)     | `state: running/completedSuccess/completedInterrupted/failed`            |
  | `userInput`                                                   | 用户输入文本 + attachments + origin(第 119-172 行)                                        | —                                                                        |
  | `assistantText`                                               | 正文文本(第 178-188 行)                                                                   | `state: streaming/complete/interrupted/failed`                           |
  | `reasoning`                                                   | thinking 文本 + durationMs(第 190-199 行)                                                 | `state: streaming/complete/interrupted`                                  |
  | `toolCall`                                                    | 工具名 + inputText/input/output/display/progress(第 213-242 行)                           | `status: inputStreaming/pendingApproval/running/success/error/cancelled` |
  | `artifact` / `subagent` / `hookInvocation` / `timelineMarker` | 产物卡 / 子代理行 / hook 行 / 时间线标记(compact、modelChange、forkNotice…,第 355-449 行) | 各自状态                                                                 |
- **thinking、正文、工具调用是三种平级行**,按 `rowId`/`createdAtSeq` 全序排列,穿插顺序天然保真。关联靠共享 `assistantResponseId`("同一模型 response 的思考、正文与工具共享此 ID",第 182、194、217 行),**不靠嵌套**。
- 【源码】`timelineMarker` 还有"泳道"字段 `lane: assistantWork | turnTailBoundary | lightBoundary`(第 434-439 行):compact 进折叠组、goalVerify 留轮尾、modelChange 是轮顶轻边界——"落位语义由 CLI 投影裁决,UI 只按 lane 装配、不得按 marker type 自行推断"(第 428-433 行注释)。
- 【源码】前向兼容降级:消费端可合成 `UnreadableConversationRow` 占位行(kind: "unreadable",只保留 rowId/turnId/createdAt/createdAtSeq),"一行读不懂"不能让整帧被拒、整个会话打不开(第 468-495 行注释,含真实事故编号)。

**【推断】**这正好反衬我们的问题 2:如果数据模型把 thinking/正文/工具"归类合并"成 `{text, thinking, toolCalls[]}` 之类的字段桶,时序交错就永久丢失了。ZCode 的答案是:**时序即结构**(扁平 row 流 + 全序 id),**语义即标签**(turnId/productTurnId/assistantResponseId/lane),归类只是渲染时的视图。

### 2.2 更新机制:四种 delta 操作,封闭集合

【源码】[`packages/shared/src/zcode-protocol-v4/delta.ts`](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol-v4/delta.ts) 第 108-121 行 + 头注释(第 2-4 行):

> "没有 `row.inserted`(中间插入)、没有 `row.moved`、没有字段级 JSON patch——凡此模型表达不了的结构变化,服务端一律发 snapshot resync,**刻意压缩客户端错误面**。"

四种操作:`row.appended`(尾部追加,占 99%)、`row.upserted`(按 rowId 整行替换,状态机迁移)、`row.removed`(删 `fromRowId` 起所有行,用于 edit/retry 分支)、`row.delta`(流式文本追加:`{rowId, path: "text"|"inputText"|"output.text"|"summaryText", append: string}`)。流式文本只允许 append 到 `streaming` 态的行(rows.ts 第 175 行注释:追加只能进 `state="streaming"` 的行,普通新 response 必然新 rowId)。

【源码】性能相关:rows.ts 第 540-548 行定义 `ConversationRowsPartition { history, tail }`——"冻结历史 + 尾轮分区":流式 delta 只改尾轮,`history` 数组引用不变,消费方按引用缓存,使**每帧派生成本与历史长度无关**(机制详见 [`docs/ui/chat-virtual-scroll.md`](https://github.com/zai-org/ZCode/blob/main/docs/ui/chat-virtual-scroll.md) 第 100-120 行,分区用 `WeakMap` 以 rows 数组身份为键的纯派生缓存,不是第二份状态)。

### 2.3 持久化层的 parts 模型(与协议行的关系)

TUI 及共享层还有一层更接近模型的 `parts` 表示,同样是**时序数组**:

- 【源码】[`packages/shared/src/assistant-message-parts.ts`](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/assistant-message-parts.ts) 第 1-13 行:
  ```ts
  export type ZCodeAssistantMessagePart =
    | { type: "content"; content: string }
    | { type: "thought"; content: string }
    | { type: "tool-call"; toolId: string };
  ```
  `appendAssistantMessagePart`(第 15-40 行)只合并**相邻同类型**的 content/thought("连续文本 chunk 必须合并成同一个 part,否则第三方会按 token 边界误判最新正文"),不同类型交替即形成时序序列。
- 【源码】TUI 流式投影同构:[`apps/zcode-cli/packages/tui/src/app-transcript-stream.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/tui/src/app-transcript-stream.ts) 的 `appendTextPart`/`appendThoughtPart`(第 105-158 行)——text delta 追加到最后一个 `streamProjected` 的 text part,thought delta 追加到最后一个 `thinking` 态的 thought part,否则新起 part;thought 有 `status: "thinking" | "thought"` 两态(第 4-5 行)。

**【推断】**持久化(transcript)里是"一条 assistant 消息带时序 parts",线上协议(wire)里是"每种 part 展开为独立 row"——两层模型语义一致,展开/合并是纯映射,不存在"归类导致丢时序"的环节。

### 2.4 渲染层:按行分发的 switch + 轮次聚合的 render unit

两层结构:

**第一层:单行渲染**。【源码】[`packages/ui/src/v4/ConversationRowView.tsx`](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/ConversationRowView.tsx) 第 2005-2080 行,`ConversationRowViewImpl` 就是一个按 `row.kind` 的 switch:`userInput → UserInputRowView`、`assistantText → AssistantTextRowView`、`reasoning → ReasoningRowView`(带可见性开关:关闭"显示思考过程"只隐藏每轮后续 reasoning,首条保留,第 2051-2056 行)、`toolCall → ToolCallRowView`、`turnHeader → TurnHeaderRowView`(渲染为分隔线 `border-b`,第 1723-1732 行)、`timelineMarker → TimelineMarkerRowView`、`unreadable → UnreadableRowView`。所有行共享薄壳 `RowShell`(只带 `data-row-id`,第 141-159 行)。

**第二层:轮次聚合**(虚拟滚动单位)。【源码】[`packages/ui/src/v4/conversationTurnRenderUnits.ts`](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/conversationTurnRenderUnits.ts):

- 按 `turnId` 把 rows 聚成 `ConversationTurnRenderUnit`,"每个虚拟 row 对应一轮 user + assistant/tool 输出,避免 retry、fork、文件变更摘要和当前轮 loading 被拆散"(chat-virtual-scroll.md 第 14 行);
- 虚拟列表 key = `turnId`(第 334-345 行注释:cold snapshot 补页后 rowId 会变,key 必须只依赖协议稳定的 turnId,否则丢测高缓存和视口锚点);
- `resolveTurnRunning`(第 172-193 行):**turnHeader.state 是权威轮次边界**,"已终态主轮不能被同轮仍在运行的 background tool/subagent 行重新推成 running";
- 轮内再切视觉区:`leadingBoundaryRows`(轮顶轻边界)/ `flowRows`(工作流)/ `assistantTailRows`(轮尾边界)/ `browserTurnEndRows`(第 225-250 行)。

**第三层:工作段(workSegments)与"已工作"折叠**。【源码】[`packages/ui/src/v4/conversationTurnWorkSegments.ts`](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/conversationTurnWorkSegments.ts):

- 每段找到 `visibleAssistantTextRow`(= 产品最终正文行:带 `actions.canFork/canRetry` 的 assistantText,或段末 assistantText,第 179-190 行);
- 第 192-200 行是折叠的核心切分:
  ```ts
  const segmentHistoryRows = (
    visibleAssistantIndex < 0
      ? segmentFlowRows                       // 没有最终正文 → 全部进折叠区
      : segmentFlowRows.slice(0, visibleAssistantIndex)  // 最终正文【之前】的所有行(thinking/工具/中间正文)→ "已工作"折叠区
  ).filter((row) => !isPluginUiPinnedToolRow(row, ...));  // 插件钉住的卡片留在折叠区外
  const segmentFollowingRows =
    visibleAssistantIndex < 0 ? [] : segmentFlowRows.slice(visibleAssistantIndex + 1);  // 最终正文【之后】的行跟随显示
  ```
- 折叠默认开合规则(第 240-246 行):`assistantHistoryDefaultOpen = forceOpenHistory(中断/失败强制展开) || (isLastTurn && running 运行中展开) || (单段 && 无最终正文 && 有过程行)`;正常完成的轮默认收起,摘要行显示"已工作 / 已工作 N 秒"(ConversationTurnGroup.tsx 第 576-577 行 `chat.history.workedFor`);
- guide(中途追答)按 CLI 下发的 `workSegments` 切段(第 89-116 行),每段独立折叠/计时。

### 2.5 折叠/展开状态在数据层还是渲染层?

**渲染层,且刻意不进数据层**:

- 【源码】工具卡:[`packages/ui/src/ToolCallBlocks/ToolLayout.tsx`](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/ToolCallBlocks/ToolLayout.tsx) 第 17 行模块级 `const toolLayoutOpenState = new Map<string, boolean>()`(按 toolId/persistOpenKey 存 renderer 内存),配套:
  - `renderContent` 懒渲染:折叠时不构造详情 DOM("工具详情只在展开或强制展开时构造,避免闭合工具提前挂载大量 markdown、diff 和子工具 DOM",chat-virtual-scroll.md 第 89 行);
  - `autoOpen`:edit/read 这类工具完成后一次性自动展开一次,之后仍可手动关(第 155-167 行);
  - `autoCollapseOnComplete`:子代理卡在 running→completed 边沿自动收起一次(第 169-180 行);
  - 收起时 300ms 延迟卸载 children,配合 Radix Collapsible 高度动画测量(第 20、182-211 行);
  - 虚拟滚动卸载再挂载不丢展开状态("展开状态按 message/tool key 保存在 renderer 内存中",chat-virtual-scroll.md 第 90 行)。
- 【源码】thinking 块:`Reasoning` 折叠组件,"streaming/complete 都默认收起,只保留运行态文案,用户可手动展开;autoCollapseKey 保证状态边界不会覆盖已经发生过的用户交互"(ConversationRowView.tsx 第 1695-1711 行)。
- 【源码】轮级"已工作"区:`historyOpen` 是 `ConversationTurnGroup` 里的 React `useState`,初值取 `unit.assistantHistoryDefaultOpen`(ConversationTurnGroup.tsx 第 1039-1044 行)。
- 【源码】TUI 同样在渲染层:thought 折叠是组件内 `React.useState(false)`,点击 `+/-` marker 切换([app-thought-components.tsx](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/tui/src/app-thought-components.tsx) 第 23-29、44 行)。

**关键设计判断【推断】**:数据层只携带"可折叠的事实"(行类型、状态、workStatus、durationMs),开合是纯 UI 态——这样同一份数据可以同时支撑"运行中展开、完成后折叠、异常强制展开"三种呈现策略,而无需改协议。

### 对我们 Web UI 的可迁移启示

1. **数据模型改成扁平时序事件流**:每个 thinking 段、正文段、工具调用(含其状态流转)都是独立条目,带全局单调序号 + 轮次标签。绝不要在数据层按类型归桶合并——"时序交错保真"是数据模型的职责,不是渲染层拼得回来的。
2. **关联用共享 id**(如 `assistantResponseId`),不用嵌套容器;`turn` 是 row 上的标签。这让"同一轮里 thinking→tool→thinking→正文"天然可渲染,也让 retry/fork/编辑分支可以用"从某 rowId 起截断"表达。
3. **流式更新只允许 append 到流态行,状态迁移用整行替换**;表达不了的结构变化直接整体重放(snapshot),不要发明字段级 patch——小操作集 = 小错误面。
4. **渲染时做三层:view(row switch)→ turn 聚合(虚拟化单位)→ 工作段切分(最终正文前 = 折叠区,后 = 跟随区)**。"最终正文之前的所有过程进'已工作 N 秒'折叠,正文之后的跟随显示"这个切分规则简单且效果好,直接可借鉴。
5. **折叠/展开状态放渲染层内存(Map by key),随虚拟滚动卸载重挂不丢**;数据层只带 `workStatus/durationMs/isRunning` 这类事实。
6. 长会话性能:用"冻结历史 + 尾轮"分区(流式帧只重算尾轮,history 按引用缓存),流式渲染成本与历史长度无关。
7. 轮次边界要有权威行(`turnHeader.state`),UI 不得从行内容反推"这轮是否结束"。

---

## 问题 3:宽度与布局策略

### 3.1 内容列宽度:容器查询分级,而不是固定 max-w

【源码】宽度策略集中在 [`packages/ui/src/v4/conversationLayout.ts`](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/conversationLayout.ts) 第 3-8 行:

```ts
export const CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME = "max-w-2xl";
export const CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl";
export const CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME = /* 同上 */;
```

要点:

- **空态(草稿/问候语)窄**:max-w-2xl,居中(`getConversationContentWidthClassName` 第 22-31 行:空态返回 2xl 档,有内容统一走宽档);
- **有内容时分三档**:窄容器全宽 → 容器 ≥864px 时收窄为 `calc(100% - 6rem)` 且上限 max-w-4xl → 容器 ≥1280px 时再收窄为 `calc(100% - 24rem)` 且上限提到 max-w-6xl;
- 断点用的是 **Tailwind 容器查询**(`@min-[864px]/conversation:`),以**会话容器**而非浏览器视口为基准——注释(第 40-43 行):"宽布局统一使用 1280px,避免面板状态变化时触发不同断点造成内容列跳变"。侧栏开合、分栏变化都不会引起内容列宽度跳变;
- 右侧状态面板 inline 展开时内容列整体 `-translate-x-42` 平移让位(`CONVERSATION_STATUS_PANEL_WIDE_OFFSET_CLASS_NAME`,第 13-15 行)。

【源码】接线:ConversationTimeline.tsx 第 2095-2116 行,消息历史列、活动轮(live tail)、header slot、composer dock 全部统一 `relative mx-auto w-full shrink-0` + `contentWidthClassName`——**同一内容列宽度类贯穿消息、头部与输入区**,保证对齐。注释(第 2109-2110 行)还说明"不对尺寸或偏移做动画"(宽度过渡会反复触发消息测高)。

### 3.2 单条消息的宽度与边距

- 【源码】assistant 正文:`AssistantTextRowView` 的容器是 `w-full text-ui-base`(ConversationRowView.tsx 第 1613 行)——正文占满内容列,不额外限宽;正文内代码块/表格各自内部横向滚动(滚动容器 `overflow-x-hidden`,注释:"宽内容会把整条 Conversation 撑出横向滚动;表格和代码块应由各自内部容器滚动",ConversationTimeline.tsx 第 2036-2038 行)。
- 【源码】用户输入是**右对齐气泡**:`max-w-xl flex-col items-end`(ConversationRowView.tsx 第 1151 行),附件行也 `max-w-40`/`max-w-full` 限宽(第 926、949 行)——即"用户输入有气泡+限宽,assistant 正文全宽"的不对称布局。
- 【源码】内容左右 inset 用 CSS 变量下发:`[--markdown-table-layout-left-inset:16px]`(桌面 16px、手机 8px,ConversationTimeline.tsx 第 2038 行);轮导航 rail 存在时左 inset 提到 48px(第 2048-2049 行)。

### 3.3 thinking / 工具卡 / 正文的视觉层级

Web 端靠"组件形态 + 色阶"区分,基本不靠缩进:

- 【源码】**thinking(reasoning 行)**:`Reasoning` 折叠组件,收起时只有一行触发器(运行态文案 + 时长),`text-foreground-subtle` 级别的次要色;用户点击展开才显示内容(ConversationRowView.tsx 第 1688-1721 行)。
- 【源码】**工具卡**:`ToolLayout`(外层 Collapsible)+ `ToolSummaryRow`(摘要行)两件套。摘要行是单行 flex:`icon + kindLabel(类别词,次要色/运行态扫光动画) + primaryText(动作正文) + secondaryText + diffCount + statusNode(状态词,失败态可 hover 出 tooltip 看错误详情并复制)` + 悬停浮现的展开 chevron(ToolLayout.tsx 第 305-345 行;ToolSummaryRow.tsx 第 212-247 行)。运行中的类别词用 `animated-gradient-text` 扫光表达,图标保持静态("旋转 loading 图标会让动画长期占用渲染资源",ToolLayout.tsx 第 138-140 行注释)。展开后的详情区 `pt-2` 与摘要行分隔(第 22、351 行),错误信息用 `palette.danger` 同级的失败色系。
- 【源码】**正文**:markdown 全宽渲染(Streamdown 的 static/streaming 双模式:完成态走 static 避免重挂载触发更新循环,chat-virtual-scroll.md 第 95 行),完成态悬停浮现动作行(复制/反馈/fork,"action 只在轮尾段",ConversationRowView.tsx 第 1661-1683 行)。
- 【源码】**轮次边界**:turnHeader 渲染为一条底部分隔线(`border-b`,ConversationRowView.tsx 第 1727 行);timelineMarker 渲染为分隔线组件;每轮之间的间距由 TurnGroup 的容器 gap 控制(`[&>*+*:not(...)]:mt-5`,ConversationTurnGroup.tsx 第 1139 行)。
- 【源码】连续同类工具自动分组:`ConsecutiveSummaryGroup`(ToolSummaryRow.tsx 第 261 行起)把连续工具折叠成"N 个同类"统计组头,组内展开仍由原始行 renderer 提供("分组只持有展开状态;完整摘要继续由原始行 renderer 提供,避免复制工具文案和状态规则")。

**TUI 对照(终端特有)**:

- 【源码】布局靠**缩进字符**而非色块工具卡:工具标题行与 assistant 正文对齐,子明细行缩进 2 空格(`TOOL_DETAIL_INDENT = "  "`),输出行缩进 4 空格(`TOOL_OUTPUT_LINE_INDENT = "    "`),输出最多显示 8 行后 `[truncated N lines]`(`MAX_OUTPUT_LINES = 8`)([app-tool-components.tsx](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/tui/src/app-tool-components.tsx) 第 8-11、29、62-77、125-133 行);
- 【源码】状态用颜色编码:`completed→success 色 / failed→danger / running→accent`,有自定义标题时标题用 muted 色、无标题时用状态色(第 40、107-112 行);
- 【源码】消息行布局:用户消息带背景色块 + 上下各 1 行 padding("only user prompts carry row chrome; speaker labels were visually noisy"——speaker 标签被认为视觉噪音被移除,app-transcript-components.tsx 第 113 行注释),assistant 行无 chrome 直接铺文字;宽度 `width: "100%"` 由终端宽决定,传 `terminalWidth` 给 diff 视图选择排版(`diffViewForWidth(terminalWidth)`,app-tool-components.tsx 第 94 行);
- 【源码】thinking 折叠用 ASCII 树形 marker:`+ Thinking…` / `- Thought for Ns`,thinking 中用 accent 色、完成用 muted 色(app-thought-components.tsx 第 44-64 行)。

### 对我们 Web UI 的可迁移启示

1. **抛弃 `max-w-3xl` 一刀切**,改成分级响应:`空态窄(2xl)` → `常态上限 4xl` → `宽屏上限 6xl`,并且用**容器查询**而非视口查询,这样侧栏/分栏开合不会让消息列跳宽。宽屏时内容仍留白(负 margin 收窄),不是无限拉满。
2. **消息、头部、输入区共用同一个内容列宽度类**,保证左缘/右缘对齐;宽度变化不做过渡动画(会引发连锁测高)。
3. **用户输入与 assistant 正文不对称**:用户消息限宽右对齐气泡,assistant 正文全宽——层级靠"谁有气泡"区分,而非统一卡片。
4. **视觉层级用"信息密度阶梯"表达**:thinking = 可折叠次要行;工具 = 单行摘要(图标+类别词+动作+状态)+ 懒挂载详情;正文 = 全宽 markdown + 悬停动作。三者不靠缩进区分(Web 上缩进层级多了会压缩正文宽度),靠折叠形态与色阶。
5. 表格/代码块横向滚动内聚在各自容器内,滚动容器自身 `overflow-x-hidden`,防宽内容撑破布局。
6. 连续同类工具做统计分组("Read × 5"),是控制噪声的廉价手段。
7. TUI 的字符缩进(`  `/`    `)、8 行输出截断、ASCII `+/-` 折叠 marker、状态色枚举是终端媒介的产物,Web 不必也不应照搬;但"工具标题与正文左对齐、子内容缩进"的信息层级思想在 Web 详情区内依然适用。

---

## 加分项记录

### A. 一轮 assistant 回复的边界如何呈现(消息分组)

- 【源码】轮 = 一个 `ConversationTurnRenderUnit`(虚拟滚动单位),由 `turnHeader` 行 + 该 turnId 的所有行构成;"每个虚拟 row 对应一轮 user + assistant/tool 输出,避免 retry、fork、文件变更摘要和当前轮 loading 被拆散"(chat-virtual-scroll.md 第 14 行)。
- 【源码】轮的呈现三段式:`用户输入气泡 → [已工作 N 秒 折叠区(过程)] → 最终正文 → (轮尾 marker)`,完成轮的过程区默认收起、摘要行显示工时;`turnHeader` 在行视图里就是一条底部分隔线。
- 【源码】运行中的轮不折叠(`resolveTurnRunning` 以 `turnHeader.state === "running"` 为权威);guide 中途追答按 CLI `workSegments` 每段独立折叠计时,"哪几条 guide 是同一次取出,只有 CLI 知道"(conversationTurnWorkSegments.ts 第 93-96 行注释)。
- 【源码】`ConversationRowsPartition` 保证 tail(尾轮)可能包含多轮("旧轮追加了行"),消费方不能假设 tail 只有一轮(rows.ts 第 543-546 行)。

### B. 错误 / 中断状态的消息显示

- 【源码】行级状态枚举里显式有中断/失败:`assistantText.state: interrupted/failed`、`reasoning.state: interrupted`、`toolCall.status: error/cancelled`、`turnHeader.state: completedInterrupted/failed`(rows.ts 第 90、184、196、220 行)。
- 【源码】**异常终态强制展开过程区**:`shouldForceOpenAbnormalHistory`(conversationTurnRenderUnits.ts 第 195-203 行)——"旧展开规则只看 running 和最终正文,异常终态一旦保留 partial assistant text 就会被当作正常完成而收起,**隐藏中断/失败上下文**。终态必须以 header 为权威"(第 257-260 行注释)。
- 【源码】工具失败不强制展开卡片,错误详情挂到状态词的 tooltip 上,可 hover 查看 + 一键复制(ToolLayout.tsx 第 244-253 行注释及实现)。
- 【源码】流式期间"被中断"也强制展开历史区("流式输出、被中断和 settling 状态仍会强制展开历史区,保证正在发生的内容不会被隐藏",chat-virtual-scroll.md 第 91 行)。
- 【源码】TUI 的 compact(上下文压缩)时间线行内嵌重试提示:`/compact failed | retry(/compact)`,失败用 warning 色([app-transcript-components.tsx](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/tui/src/app-transcript-components.tsx) 第 200-230 行)。

### C. 历史会话恢复时 thinking 是否保留

**保留**:

- 【源码】持久化消息模型含 thought:`ZCodePersistedMessage` 合并时显式保留 `thought: (first.thought ?? "") + (next.thought ?? "")`([zcodePersistedMessageMerge.ts](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcodePersistedMessageMerge.ts) 第 63-66 行);该文件头注释(第 3-6 行)还揭示了持久化粒度:"ZCode runtime 把同一个 user turn 里**每一轮 LLM 调用**落成独立的 assistant 消息……这里把映射后相邻的 assistant 合并回一条,恢复'一个 turn 一条 assistant'的不变式"。
- 【源码】reasoning 是 wire 协议的一等行(kind: "reasoning",带 durationMs),冷恢复 snapshot 的 rows.window 自然包含;UI 侧恢复后默认收起、首条保留的可见性规则也适用于恢复场景(ConversationRowView.tsx 第 2051-2056 行)。
- 【源码】恢复后 UI 呈现为收起的"Thought for Ns"(`durationMs` 换算,ConversationRowView.tsx 第 1700-1701 行)。
- 【源码】投影政策五分类 [`conversation-message-projection-policy.ts`](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/conversation-message-projection-policy.ts)(第 1-6 行):`realUserInput / visibleAssistant / providerContextOnly / timelineOnly / hiddenSynthetic`——持久化 transcript 恢复时按语义决定进时间线、只进模型上下文还是隐藏,而非按消息形状猜。

### D. 其他值得记录的工程细节

- 【源码】虚拟滚动用 `@tanstack/react-virtual`,以 turn 为单位,动态高度 `measureElement` 回写,overscan 限两轮滚动缓冲(ConversationTimeline.tsx 第 20、875-882 行);
- 【源码】流式投递分档:`continuous`(桌面,30ms flush 窗口,text/inputText/output.text/summaryText 全流式)与 `replayable`(手机/远程,150ms 窗口,只流式 text)(core.ts 第 35-60 行);
- 【源码】snapshot 尾窗 60 行(`snapshotTailWindowRows: 60`,core.ts 第 76 行),更早历史按 `rows/range` 分页补;
- 【源码】`GenUiMessageResponse`(Streamdown 封装)完成态走 static 模式,只有真实流式走 streaming 路径,避免虚拟滚动重挂载完成态消息触发内部更新循环(chat-virtual-scroll.md 第 95 行)。

---

## 源码链接清单

### 设计文档

| 文件                                                                                                                                                      | 内容                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [docs/ui/chat-scroll-bottom-pinning.md](https://github.com/zai-org/ZCode/blob/main/docs/ui/chat-scroll-bottom-pinning.md)                                 | 吸底状态机总纲(行为、事件优先级表、实现边界)            |
| [docs/ui/chat-virtual-scroll.md](https://github.com/zai-org/ZCode/blob/main/docs/ui/chat-virtual-scroll.md)                                               | 虚拟滚动、resize 批处理、懒渲染、冻结历史+尾轮分区      |
| [apps/zcode-cli/docs/design/v2/tui-mouse-scrollback.md](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/design/v2/tui-mouse-scrollback.md) | TUI 滚动契约(scrollOffset 语义、wheel/PageUp、粘滞规则) |

### Web UI(packages/ui)

| 文件                                                                                                                                                | 关键位置                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [packages/ui/src/v4/timelineScrollAnchor.ts](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/timelineScrollAnchor.ts)                 | 全部滚动纯函数:epsilon=48(:13)、意图识别(:109-152)、竞争对账(:169-197)、prepend 锚定(:212-306)             |
| [packages/ui/src/v4/ConversationTimeline.tsx](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/ConversationTimeline.tsx)               | followingRef(:587)、滚动容器类名(:2033-2050)、内容列(:2095-2182)、virtualizer(:875-882)                    |
| [packages/ui/src/lib/chatSessionScrollMemory.ts](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/lib/chatSessionScrollMemory.ts)         | 跨会话滚动记忆(LRU 200)                                                                                    |
| [packages/ui/src/v4/conversationLayout.ts](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/conversationLayout.ts)                     | 内容列宽度常量与容器查询断点(:3-8)                                                                         |
| [packages/ui/src/v4/ConversationRowView.tsx](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/ConversationRowView.tsx)                 | row.kind switch(:2023-2080)、AssistantTextRowView(:1517)、ReasoningRowView(:1688)、UserInputRowView(:1302) |
| [packages/ui/src/v4/conversationTurnRenderUnits.ts](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/conversationTurnRenderUnits.ts)   | rows→turn 聚合、运行态裁决(:172-193)、异常强制展开(:195-203)                                               |
| [packages/ui/src/v4/conversationTurnWorkSegments.ts](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/conversationTurnWorkSegments.ts) | history/following 切分(:192-200)、折叠默认开合(:240-246)                                                   |
| [packages/ui/src/ToolCallBlocks/ToolLayout.tsx](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/ToolCallBlocks/ToolLayout.tsx)           | 工具卡折叠(内存 Map :17、autoOpen/autoCollapse :155-180、懒渲染 renderContent)                             |
| [packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx)   | 工具摘要行与连续同类分组(:261 起)                                                                          |
| [packages/ui/src/v4/useConversationProjection.ts](https://github.com/zai-org/ZCode/blob/main/packages/ui/src/v4/useConversationProjection.ts)       | per-session store 订阅(useSyncExternalStore)                                                               |

### 协议与共享层(packages/shared)

| 文件                                                                                                                                                                      | 关键位置                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [packages/shared/src/zcode-protocol-v4/rows.ts](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol-v4/rows.ts)                                 | 三条结构规则(:3-5)、九种行(:455-466)、unreadable(:468-495)、分区(:540-548) |
| [packages/shared/src/zcode-protocol-v4/delta.ts](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol-v4/delta.ts)                               | 四种 delta 操作(:108-121)、封闭集合哲学(:2-9)                              |
| [packages/shared/src/zcode-protocol-v4/core.ts](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol-v4/core.ts)                                 | 投递分档(:35-60)、尾窗 60 行(:76)                                          |
| [packages/shared/src/assistant-message-parts.ts](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/assistant-message-parts.ts)                               | content/thought/tool-call 时序 parts 与相邻合并                            |
| [packages/shared/src/zcodePersistedMessageMerge.ts](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcodePersistedMessageMerge.ts)                         | 持久化 assistant 合并(thought 保留 :63-66)                                 |
| [packages/shared/src/conversation-message-projection-policy.ts](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/conversation-message-projection-policy.ts) | 恢复投影五分类                                                             |

### TUI(apps/zcode-cli)

| 文件                                                                                                                                                                      | 关键位置                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [apps/zcode-cli/packages/tui/src/app-transcript-components.tsx](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/tui/src/app-transcript-components.tsx) | scrollbox stickyScroll(:43-49)、MessageRow parts 按序渲染(:119-185) |
| [apps/zcode-cli/packages/tui/src/app-transcript-stream.ts](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/tui/src/app-transcript-stream.ts)           | 流式 text/thought part 追加(:105-158)                               |
| [apps/zcode-cli/packages/tui/src/app-thought-components.tsx](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/tui/src/app-thought-components.tsx)       | thinking 折叠(+/- marker,默认收起)                                  |
| [apps/zcode-cli/packages/tui/src/app-tool-components.tsx](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/tui/src/app-tool-components.tsx)             | 工具行缩进/8 行截断/状态色(:8-11、107-112、125-133)                 |

---

## 附:三问一句话总结(供快速决策参考)

1. **滚动**:显式 FOLLOWING/DETACHED 状态机 + 48px epsilon;只有真实用户输入能改变跟随态;贴底用 instant scrollTop;提交新 prompt 强制回底;resize/终态折叠期间先对账用户意图再吸底。TUI 端等价物是 `scrollOffset===0 ⇔ 跟随` + scrollbox 框架 sticky。
2. **数据模型**:九种扁平行按全序排列,turn 是行上标签不是容器;thinking/正文/工具各为一等行,靠 `assistantResponseId` 关联;更新只有 append/upsert/remove/append-delta 四种;轮内"最终正文之前=已工作折叠区、之后=跟随区"在渲染层切分;折叠开合是渲染层内存态。
3. **宽度**:内容列容器查询三档(全宽 → ≥864px 收窄 max-w-4xl → ≥1280px max-w-6xl),空态 max-w-2xl;消息/头部/输入共用同一宽度类;用户气泡限宽右对齐、assistant 正文全宽;视觉层级靠折叠形态与色阶而非缩进。
