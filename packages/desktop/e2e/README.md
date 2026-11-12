# E2E 场景索引

本目录是 CodexLike 的真实应用 E2E：启动真实 Electron 生产产物（隔离数据目录 + 本地 OpenAI 兼容 mock SSE server），只通过用户界面、公开 IPC 与外部请求断言，不读取数据库或组件内部状态。

## 运行方式

- 全量链：根目录 `pnpm test:e2e:all`（先 `pnpm build`，再按下表顺序依次跑 29 个场景，任一失败即停）。
- 单跑：根目录 `pnpm test:e2e:<场景名>`（同样先 build）。场景名列与下表一一对应。
- 链外：`pnpm test:e2e:packaged` 需要 `CODEXLIKE_PACKAGED_EXE` 指向打包产物 exe（冷启动冒烟，不进 all 链）。
- 定位器规范：场景文件受 `pnpm check:e2e-locators`（pre-commit）约束，见 CODING_STANDARDS.md「E2E 定位器」。

## 场景索引（29 个，按 test:e2e:all 链序）

| #   | 场景名             | 文件                       | 一行断言要点                                                                                                                 |
| --- | ------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | smoke              | `smoke.mjs`                | 最小全链路：建 Profile → 消息往返（write_file 真实执行 + 流式 markdown）→ 工具卡可展开 → 重启后会话/消息/卡片恢复            |
| 2   | acceptance         | `acceptance.mjs`           | spec 验收串接：修 bug 全流程（read_file→grep→apply_patch→审批→commit）+ worktree 双会话并行落盘互不干扰                      |
| 3   | commands           | `commands.mjs`             | 斜杠命令 + @引用 + AGENTS.md 注入：/status、/rename、/model、/new、/archive 逐一验证，请求体含规范与被引用文件               |
| 4   | browser            | `browser.mjs`              | 浏览器工具链路：navigate 打开 fixture 页 → screenshot 真实落盘 → 卡片内嵌图片回填，tool result 文本降级                      |
| 5   | approvals          | `approvals.mjs`            | 执行审批：assist 自动放行/危险命令询问、full-access 风险确认与越界写、重启档位恢复、ask 拒绝                                 |
| 6   | interactions       | `interactions.mjs`         | 统一用户交互（questions/queue/cancel）走 InteractionPanel，历史只读                                                          |
| 7   | changes            | `changes.mjs`              | git 集成全链路：write_file 真实变更 → 改动面板 → Monaco diff → 建分支 → 生成提交消息 → 一键提交落库；非 git 工作区降级不报错 |
| 8   | interrupt          | `interrupt.mjs`            | 会话打断：流式中停止立即中断、中断后可继续、工具执行中停止杀子进程、中断标记跨重启恢复                                       |
| 9   | compact            | `compact.mjs`              | /compact 压缩：摘要卡片折叠可见、只剩最近 3 轮、后续请求体含摘要、重启摘要仍可见                                             |
| 10  | worktree           | `worktree.mjs`             | ADR 0010：首次发送 Worktree、共享目录提示、失败重试与进程重开                                                                |
| 11  | mcp                | `mcp.mjs`                  | MCP 全链路：设置页添加 stdio server → 连接 + 工具发现 → 启停 → 审批后 stdio 真实往返 → 重启自动重连                          |
| 12  | subagents          | `subagents.mjs`            | 子代理委派：嵌套卡片运行→完成、子代理独立上下文（含 task 不含主会话原文）、无 spawn_subagent 防递归、报告回流、重启恢复      |
| 13  | projects           | `projects-sidebar.mjs`     | ADR 0010：项目侧栏布局、分组入口与首次发送纵向验收                                                                           |
| 14  | sidebar            | `sidebar-archive.mjs`      | 侧栏布局、右键菜单、稳定排序、归档与进程重开                                                                                 |
| 15  | membership         | `membership.mjs`           | 会话归属与移除确认（仅临时目录 + 模型替身）                                                                                  |
| 16  | search             | `session-search.mjs`       | 会话搜索与历史导航（真实 SQLite）                                                                                            |
| 17  | theme              | `theme.mjs`                | ADR 0007：light/dark 切换即时生效 + 偏好落盘重启保持                                                                         |
| 18  | skills             | `skills.mjs`               | 规范与技能：真实界面 + mock HTTP 请求验证技能菜单/引用链路，非仅菜单检查                                                     |
| 19  | thinking           | `thinking.mjs`             | 思考档位贯通：五档请求 JSON 契约、reasoning 折叠与正文隔离、运行中切档只影响下一条                                           |
| 20  | subagent-thinking  | `subagent-thinking.mjs`    | 子代理思考快照继承：主/子请求都带档位、切档不影响已触发任务、思考不回传、SubagentCard 折叠展示                               |
| 21  | message-order      | `message-order.mjs`        | 时序保真：思考/正文/工具交错回复按事件序排列（严格 testid 序列），折叠交互不变、重启恢复形状                                 |
| 22  | worked-history     | `worked-history.mjs`       | 已工作折叠区与轮次分组：过程段整体收起、展开回看完整、连续同类工具统计分组、中断轮强制展开                                   |
| 23  | live-sessions      | `live-sessions.mjs`        | 后台会话状态（SSE 闸门替身）：侧栏实时状态流转                                                                               |
| 24  | persistence        | `persistent-workbench.mjs` | 草稿、设置、滚动位置与空闲进程重启恢复                                                                                       |
| 25  | exit               | `exit-recovery.mjs`        | 真实进程退出/重开：模型计数与文件追加副作用独立证明不重放                                                                    |
| 26  | entries            | `entry-consistency.mjs`    | 入口一致性：全局/项目新建入口语义不混淆，跨票组合操作                                                                        |
| 27  | width              | `width-tiers.mjs`          | 容器分档宽度：会话容器（非视口）三档分宽、内容列对齐、用户消息限宽右对齐、宽表格/代码块内聚滚动                              |
| 28  | reasoning-recovery | `reasoning-recovery.mjs`   | reasoning 落库与恢复（ADR 0011）：思考随终态落 SQLite，重启可回看，切走切回不重复不丢失，旧会话无空思考块                    |
| 29  | scroll             | `scroll-following.mjs`     | 滚动跟随状态机：流式贴底、上翻脱离不夺滚动权、回到最新恢复跟随、阅读位置记忆含贴底与否                                       |

链外（不进 test:e2e:all）：

| 场景名   | 文件           | 一行断言要点                                                                                |
| -------- | -------------- | ------------------------------------------------------------------------------------------- |
| packaged | `packaged.mjs` | 打包冷启动冒烟：数据目录不存在的干净状态下窗口出现且目录自建（2026-11-11 打包黑屏事故兜底） |

共享工具（非场景）：`helpers.mjs`（断言/启动/mock 骨架/退出清理）、`launch-target.mjs`（Electron 启动目标）。

## 新增场景的维护要求

新增一个 E2E 场景时必须同步三处：

1. `packages/desktop/package.json`：加 `test:e2e:<name>` script，并把 `node e2e/<file>.mjs` 追加到 `test:e2e:all` 链；
2. 根 `package.json`：加同名 `test:e2e:<name>`（`pnpm build && pnpm --filter @codexlike/desktop run test:e2e:<name>`）；
3. 本表：按链序插入一行，写清一行断言要点。

定位一律遵守 CODING_STANDARDS.md「E2E 定位器」（testid / 容器限定，内容断言显式处理多命中），`pnpm check:e2e-locators` 会拦截根级裸定位。
