# 07：消息渲染性能与子代理/diff检视

Status: done
Integration: 最终全仓检查、相关消息/子代理/diff/滚动E2E及复审整改通过；详见../INTEGRATION.md
Blocked by: none

先读 ../spec.md、../notes.md；依据 ../REPORT.md F04/F23/F24/F25/F26。用户批准TDD接缝、短显示节流和性能工作量验收。

## 所有权

ui/components/{MessageStream,RailPanel,SubagentRailPanel,ToolCallCard}.tsx、lib/{task-view,turn-view,live-task,subagent-status,markdown}与独立小hooks/叶组件及专用tests。不得改WorkspacePage/SettingsPage；必须跨接线时票Comments告主代理。

## 验收

- [x] F04独立计时，memo Markdown叶按primitive content，固定plugins；未变历史解析0，关闭详情按需渲染；活动正文50–100ms短节流终态立即，切换清timer，延迟commit仍正确跟随。
- [x] F23成功status刷新版本传diff，选中同路径刷新新内容，选中已消失清空，迟到status守卫。
- [x] F24compact不丢旧轮/无spawn interrupted记录，连续compact不重复，marker/选中/轮次不乱。
- [x] F25复用isTerminalSubagentState，恢复interrupted主正文操作可见，queued/running仍活动。
- [x] F26按需展开完整参数/output、错误和长尾可读，安全文本不HTML，勿错误使用主工具截图接口。
- [x] 真实jsdom更新计数回归+恢复纯函数/SSR；记red/green与固定benchmark，不用CI毫秒阈值。

## 红绿记录（2026-11-18）

所有 Vitest 使用 `pnpm --dir C:/Users/leffss/Desktop/ai-agent/packages/ui exec vitest run ...`；未运行 build、install、全套 test、浏览器或 git 提交。

| 项目/切片              | Red（exit 1）                                                                                       | Green（exit 0）                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| F04 计时/无关更新/增量 | `tests/message-rendering-ui.test.tsx`：5/100 历史各触发 6/101 次解析，2 failed                      | 同文件最初 2 passed；独立计时 + primitive content memo + 固定 plugins                                         |
| F04 主流 lazy          | 同文件 `-t '关闭的过程'`：关闭详情仍解析 7 块                                                       | 同过滤 1 passed；仅最终正文解析，点击展开再挂载过程/思考/compact                                              |
| F04 trailing throttle  | 同文件 `-t '活动正文'`：40ms 已解析 4 次，预期 0                                                    | 同过滤 1 passed；75ms 尾随刷新，持续输出不 debounce，状态即时，终稿当帧完整                                   |
| F04 晚 commit 跟随     | 同文件 `-t '尾随内容'`：高度变化后 scrollTop 仍 220                                                 | 同过滤 1 passed；局部 commit 通知遵守 following/detached 与用户上翻优先                                       |
| F04 切换/卸载          | 同文件 `-t '切任务即'`：乙任务显示甲首段                                                            | 同过滤 1 passed；任务 key 重挂显示叶，旧 timer 清理，卸载 timer 归零                                          |
| F04 子代理 lazy/memo   | 同文件 `-t '子代理关闭'`：关闭正文仍在 DOM                                                          | 同过滤 1 passed；子代理过程按需挂载，稳定报告零重解析                                                         |
| F23 刷新入口           | `tests/rail-diff-refresh-ui.test.tsx`：revision 后仍 VERSION_ONE                                    | 同文件 1 passed；结束 revision/手动刷新/提交均更新同路径 diff                                                 |
| F23 消失文件           | 同文件 `-t '选中文件消失'`：仍有旧 changes-diff-path                                                | 同过滤 1 passed；成功快照当帧对账，移除过期检视                                                               |
| F23 乱序               | 同文件 `-t '旧 status'`：旧 success/error 覆盖新任务/新 revision，2 failed                          | 完整同文件 4 passed；请求代次、任务归属、卸载守卫                                                             |
| F24 身份               | `tests/live-task.test.ts -t '子代理恢复'`：restore-delegate-1 替换 sa-1                             | 同过滤 1 passed；保留骨架 id。旧测试未先 compact-start，事件曾被丢弃而假绿，本次修正真实入口                  |
| F24 裁剪与时序         | 同文件 `-t '连续 compact'`：旧子代理变 []                                                           | `-t 'compact\|子代理恢复'` 2 passed；按存活后继/时间锚点插回，含无 spawn interrupted，连续无重复，最新轮仍 u2 |
| F25 interrupted        | `tests/message-actions-ui.test.tsx -t '子代理：'`：interrupted turn.running=true，1 failed/2 passed | 同过滤 3 passed；复用 isTerminalSubagentState，恢复→分组→SSR 复制/导出可见                                    |
| F26 完整工具详情       | `tests/subagent-rail-switch.test.tsx -t '两级按需'`：缺展开入口                                     | 完整同文件 4 passed；恢复 interrupted，完整 JSON/1000 行长输出尾部可读，HTML 仅文本，未调用主工具截图 API     |

### 固定解析工作量对照

真实 React/jsdom + ReactMarkdown/GFM/highlight 继续执行，只在已批准的 Markdown 库边界记录调用。每条历史 1,355 字符、24 行 TS；活动段起始 2 字符、更新后 5 字符。无 CI 墙钟阈值。

| 数据集/更新                                     | 修复前调用 | 修复后调用 | 未变历史解析字符（前→后） |
| ----------------------------------------------- | ---------: | ---------: | ------------------------: |
| 5 条历史，1s tick                               |          6 |          0 |                 6,775 → 0 |
| 5 条历史，无关父更新                            |          6 |          0 |                 6,775 → 0 |
| 5 条历史，单 delta                              |          6 |          1 |                 6,775 → 0 |
| 100 条历史，1s tick                             |        101 |          0 |               135,500 → 0 |
| 100 条历史，无关父更新                          |        101 |          0 |               135,500 → 0 |
| 100 条历史，单 delta                            |        101 |          1 |               135,500 → 0 |
| 5 个关闭过程正文 + compact + 最终正文，首次挂载 |          7 |          1 |        关闭过程 6,775 → 0 |

最终基准输出两档均 `{ tick: 0, parent: 0, delta: 1, unchanged: 0 }`。75ms 显示节流测试在持续 10ms 增量下验证 40ms 尚未解析、100ms 已有最新展示，200ms 共 2–4 次解析，随后终稿无需等 timer；状态段每次增量均即时可见。事件/reducer/IPC 未节流。

### 最终定向验证

2026-11-18 15:01 冻结版本，exit 0，15 files / 217 tests passed，无跳过：

```bash
pnpm --dir C:/Users/leffss/Desktop/ai-agent/packages/ui exec vitest run tests/message-rendering-ui.test.tsx tests/rail-diff-refresh-ui.test.tsx tests/live-task.test.ts tests/subagent-view.test.ts tests/turn-view.test.ts tests/task-view.test.ts tests/markdown-links-ui.test.tsx tests/thinking-block-ui.test.tsx tests/segment-durations-ui.test.tsx tests/message-actions-ui.test.tsx tests/subagent-rail-switch.test.tsx tests/subagent-rail-ui.test.tsx tests/rail-panel-ui.test.tsx tests/tool-view.test.ts tests/scroll-follow.test.ts
```

- 本票 9 个生产文件定向 ESLint exit 0，0 error / 6 Fast Refresh warning；其中 markdown.tsx 的 context/配置混合导出 2 条为新增，未另拆无关模块。
- `pnpm --dir C:/Users/leffss/Desktop/ai-agent/packages/ui exec tsc --noEmit -p tsconfig.json` 当时 exit 2，仅 06 的 `tests/settings-page-ui.test.tsx:68/77/200/203/204/216` `ByRoleOptions.exact` 错误；本票无 TS 报错，已通知主代理，不越权修改。
- 全仓检查、正式 build 和相关隔离 E2E：pending 主代理集成验证，本票未宣称已跑。

### 文件清单

生产（9）：

- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/MessageStream.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/RailPanel.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/SubagentRailPanel.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/ToolCallCard.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/ToolDetailsBody.tsx`（新增，共享安全参数/结果 body）
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/lib/markdown.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/lib/use-throttled-text.ts`（新增，显示专用 hook）
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/lib/task-view.ts`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/src/lib/turn-view.ts`

测试（8）：

- `C:/Users/leffss/Desktop/ai-agent/packages/ui/tests/message-rendering-ui.test.tsx`（新增）
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/tests/rail-diff-refresh-ui.test.tsx`（新增）
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/tests/live-task.test.ts`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/tests/message-actions-ui.test.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/tests/subagent-rail-switch.test.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/tests/subagent-rail-ui.test.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/tests/thinking-block-ui.test.tsx`
- `C:/Users/leffss/Desktop/ai-agent/packages/ui/tests/markdown-links-ui.test.tsx`

本票票面（1）：`C:/Users/leffss/Desktop/ai-agent/.scratch/code-audit-2026-11-18/issues/07-message-rendering.md`。

## Comments

- 默认F24在merge保留未匹配记录，不盲append旧turn到末尾破坏lastTurnRunning；若需要轻量LiveTask.subagents并行视图集合(非全局store)，先将精确接口/理由给主代理，获得协调后模型由你改、Workspace由06接。
- 主工具可抽安全详情body但不要伪造MessageSegment复用整卡。
- lazy详情会要求旧SSR/e2e先展开才断言全文，列出测试变更/对应testid让主代理改e2e。
- 不运行全仓build/test或浏览器；exec vitest定向，不提交。
- 主代理已扩展 e2e/changes.mjs：保持文件选中，重写同路径后点刷新并断言Monaco显示新内容。请给 RailPanel 刷新按钮添加 `data-testid="changes-refresh"`（现仅title），本票所有者负责UI，主代理不改该组件。
- 主代理已按约定的两级 testid 更新 subagent-recovery/interrupted/work-plan 场景；正常重启回看新增完整工具参数/output断言，并追加3轮续聊→compact裁首轮→右栏报告和已展开工具结果仍在场（不重开任务）。这是F24/F26真实集成验收，注意merge保持同一subagent身份及选中详情开合。
- 最终 F24 只改 `mergeSubagentsAfterCompact`：匹配段保留骨架 id、未匹配段按存活后继/时间锚点插回，不恢复被裁主消息，不追加旧轮到最新轮之后。没有新增 LiveTask.subagents/global store/IPC/schema，无需 06 接 Workspace。
- F23 已实现稳定按钮 `changes-refresh`。F26 已实现 `subagent-tools`（外层 details）→ `subagent-tools-toggle`（summary）→ `subagent-tool-details[data-tool-id]`（单条 details）→ `subagent-tool-toggle`（summary）→ `subagent-tool-arguments` / `subagent-tool-output`（pre）。两级均默认关闭、关闭不挂载内部内容；原 `tool-call-output` 保持不变。子工具 body 无截图读取接口。
- lazy 详情是有意契约变更：所有 `textContent` 全文断言必须先确认 details 的 `open`，关闭时点击对应 summary 后再读。`thinking-content` → `thinking-toggle`；`process-text-content` → `process-text-toggle`；`subagent-thinking-content` / `subagent-thinking-round-N` → `subagent-thinking-toggle`；`subagent-body-content` / `subagent-body-round-N` → `subagent-body-toggle`；压缩摘要新增 `compact-summary-toggle` / `compact-summary-content`（外层 `message-compact-summary` 不变）；工具清单先点 `subagent-tools-toggle`，单条参数/output再点 `subagent-tool-toggle`。已展开时不要无条件再点（会收起）。
- 原 E2E 内容定位命中清单（位于 `C:/Users/leffss/Desktop/ai-agent/packages/desktop/e2e/`，由主代理独占改动）：`message-order.mjs`、`thinking.mjs`、`reasoning-recovery.mjs`、`process-segments.mjs`、`subagent-thinking.mjs`、`subagents.mjs`、`subagent-interrupted.mjs`、`subagent-legacy-record.mjs`、`subagent-recovery-review.mjs`、`subagent-work-plan.mjs`、`compact.mjs`；`persistent-workbench.mjs` 仅匹配摘要卡外壳则不需要展开。特别是收起态全文读取/重启恢复读取会受影响；安全场景按已批准范围执行，不运行真剪贴板/鼠标输入场景。
- 已同步旧 SSR：thinking-block 收起态不含正文 + 显式展开记忆读全文；markdown-links 的 compact 入口预置展开；subagent-rail 的完整逐轮与工具摘要断言预置对应展开记忆。新 jsdom 测试验证真实点击路径，不以 SSR 记忆替代交互验证。
- READY_FOR_BUILD 已通知主代理；生产冻结后仅补本票记录。
