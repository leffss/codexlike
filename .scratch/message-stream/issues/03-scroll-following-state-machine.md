# 03: 滚动跟随状态机

**What to build:** 新建无 DOM 依赖的跟随纯函数模块(FOLLOWING/DETACHED 状态机、输入意图识别、scroll 事件滞后一帧的竞争对账、阅读位置恢复计算),接入消息流:贴近底部自动跟随最新内容,用户上翻立即脱离且不被流式输出拉回,提供"回到最新"入口,发送新消息强制回底。完成后流式输出期间页面自动跟随、翻历史不被打扰——"不能自动跟随滚动"的修复。滚动竞争逻辑(用户上滚与流式内容更新同帧)以纯函数单测确定性重放。[规格](../spec.md)滚动跟随与阅读位置记忆组用户故事;机制参考 [ZCode 调研报告](../../../../docs/research/zcode-message-stream.md)第一节。

**Blocked by:** 01(在重构后的消息段渲染结构上接线)。

**Status:** ready-for-agent

- [x] 跟随纯函数模块无 DOM/React 依赖,单测覆盖:状态机裁决、滚轮/触摸/方向键意图识别、竞争对账(最近用户向上意图同帧让位)、阅读位置恢复计算
- [x] 距底 ≤48px 判定贴底;贴底时流式增量、工具卡更新、折叠变化自动跟随
- [x] 只有真实用户输入改变跟随态:程序化贴底与布局测高产生的滚动不动状态机
- [x] 用户上翻立即脱离跟随;脱离期间任何内容更新不夺滚动权
- [x] "回到最新"入口可见性 = 脱离跟随且有消息;点击或滚回底部附近恢复跟随
- [x] 发送新消息强制回底并进入跟随
- [ ] 贴底用即时 scrollTop 赋值(非 smooth);滚动容器 scrollbar-gutter 稳定、禁用原生 scroll anchoring（部分达成：即时赋值与禁用原生 scroll anchoring 已实现；scrollbar-gutter:stable 与票 05 断言冲突未启用，见 Comments 偏差 1）
- [x] 阅读位置记忆包含"离开时是否贴底":贴底记忆恢复到当前最新并跟随,否则恢复像素位置;现有跨会话/重启 <4px 精度断言不回归
- [x] 新增 e2e 场景:跟随→上翻脱离→回到最新→恢复跟随

## Comments

**实施记录（2026-11-12，分支 feat/message-stream-03）**

- 提交：`0762b26` feat(message-stream): 消息流滚动跟随状态机；`f6b31c2` merge: 并入集成分支最新 tip（含票 02 reasoning 落库，package.json 两处 scripts 冲突按票语义融合：reasoning-recovery 与 scroll-following 并存入 test:e2e:all）。
- 落地：新纯函数模块 `packages/ui/src/lib/scroll-follow.ts`（无 DOM/React 依赖：`BOTTOM_SNAP_EPSILON_PX=48`、`followModeAfterScroll` 裁决、`wheelVerticalIntent`/`touchVerticalIntent`/`keyVerticalIntent` 意图识别、`anchorDecisionAfterContentChange`、`backToLatestVisible`、`readingSpotOnLeave`/`restoreReadingPlan` 恢复计算），vitest 22 例（`packages/ui/tests/scroll-follow.test.ts`，竞争场景纯输入重放）。接线：`MessageStream.tsx`（FOLLOWING/DETACHED ref + 渲染镜像、wheel/touch/keydown 捕获登记意图 + 500ms TTL、程序化贴底值匹配回执 + TTL、内容变化贴底/保持、贴底 effect 前向上意图同帧让位、`back-to-latest` 按钮、`overflowAnchor:"none"`）；`WorkspacePage.tsx` followSignal（发送新 prompt 强制回底）；`ReadingPosition` 扩展 `atBottom?`（agent-core + workbench-ipc 校验透传，旧数据无字段按像素恢复兼容）。新 e2e `scroll-following.mjs`（5 组场景：流式跟随、上翻脱离不夺滚动权、回到最新、发送强制回底、贴底/像素双路记忆），注册 `test:e2e:scroll` 并接入 `test:e2e:all`。
- 命令与退出码：`pnpm -r run test` → 0（46+20+16 文件 / 671 tests）；`pnpm run typecheck` → 0；`pnpm test:e2e:all` → 0（26 场景，含新增 scroll-following；期间一次 acceptance 侧栏 hover flake「project-session-count 拦截点击」单独复跑通过，与本票无关）。融合后复验：`pnpm run typecheck` → 0、`pnpm -r run test` → 0、scroll-following + message-order + reasoning-recovery + exit-recovery → 0。
- 偏差 1（验收项 7 部分达成，未勾）：`scrollbar-gutter:stable` 未启用。常驻滚动条槽（Windows 15.2px）使消息列比头部/输入区恒窄一个滚动条宽度，与票 05 width-tiers 的两组断言直接冲突：场景 3 三处左右缘对齐（±1）与场景 5 基础档绝对宽度「容器-32px」（±2）无法同时成立；测槽宽发 CSS 变量同步头部/输入区可救对齐断言但救不了基础档绝对基准。为守住硬约束（现有 e2e 全绿）选择不启用，`MessageStream.tsx` 内留注释。溢出阈值跨越时 15.2px 的单向跳变与旧布局一致，留待规格层仲裁（放宽 width-tiers 基准或 overlay 滚动条方案）。
- 偏差 2：无其他偏差。<4px 阅读位置断言（exit-recovery、persistent-workbench）全绿未回归。

**协调者裁决（2026-11-12，提交于集成分支）**

接受偏差 1：不启用 `scrollbar-gutter:stable`，验收项 7 按「即时 scrollTop 赋值 + 禁用原生 scroll anchoring 达成，gutter 豁免」关闭。理由：

1. 消息流/头部/输入区三处对齐与分档宽度是**每屏常态属性**；滚动条槽 15.2px 的横向跳变只在溢出阈值跨越时发生一次（单向、与旧布局行为一致），常态属性优先。
2. CSS 变量同步头部/输入区可救回对齐断言，但需三容器联动测槽宽，复杂度与收益不成比例。
3. overlay 滚动条（自定义细滚动条）作为后续可选优化记录在案，不阻塞本特性；若未来用户反馈跳动可感知，再按此路实施并同步放宽 width-tiers 基准断言。

票 06 集成验收按本裁决核对；spec 滚动条的「scrollbar-gutter 稳定」表述以本豁免记录为准。
