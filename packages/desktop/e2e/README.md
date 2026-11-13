# E2E 场景索引

本目录是 CodexLike 的真实应用 E2E：启动真实 Electron 生产产物（隔离数据目录 + 本地 OpenAI 兼容 mock SSE server），只通过用户界面、公开 IPC 与外部请求断言，不读取数据库或组件内部状态。

## 运行方式

- 全量链：根目录 `pnpm test:e2e:all`（先 `pnpm build`，再按下表顺序依次跑 31 个场景，任一失败即停）。
- 单跑：根目录 `pnpm test:e2e:<场景名>`（同样先 build）。场景名列与下表一一对应。
- 链外：`pnpm test:e2e:packaged` 需要 `CODEXLIKE_PACKAGED_EXE` 指向打包产物 exe（冷启动冒烟，不进 all 链）。
- 定位器规范：场景文件受 `pnpm check:e2e-locators`（pre-commit）约束，见 CODING_STANDARDS.md「E2E 定位器」。

## 场景索引（31 个，按 test:e2e:all 链序）

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
| 30  | window             | `window-controls.mjs`      | 自绘标题栏：菜单移除、原生最小化/最大化/还原、状态同步、设置/窄窗/主题及关闭保存                                             |
| 31  | external-links     | `external-links.mjs`       | assistant Markdown HTTP 链接真实点击：系统打开一次、主窗口 URL/标题栏/消息/草稿保留、无额外窗口及正常退出                    |

链外（不进 test:e2e:all）：

| 场景名   | 文件           | 一行断言要点                                                                                |
| -------- | -------------- | ------------------------------------------------------------------------------------------- |
| packaged | `packaged.mjs` | 打包冷启动冒烟：数据目录不存在的干净状态下窗口出现且目录自建（2026-11-11 打包黑屏事故兜底） |

共享工具（非场景）：`helpers.mjs`（断言/启动/mock 骨架/退出清理）、`launch-target.mjs`（Electron 启动目标）。

## external-links 测试边界

- 单跑 `pnpm test:e2e:external-links`；已有最新构建时可运行 `pnpm --filter @codexlike/desktop run test:e2e:external-links`。原始 HTTP 正文场景已在修复前记录导航覆盖/关闭超时的红测试，并在产品修复后验证转绿。
- 复用 `launchApp()` 与 `startMockProvider()`，在隔离数据目录中通过公开 Provider Profile 配置和真实发送获得 assistant Markdown HTTP 链接；本地目标页由同一 mock server 提供，不依赖互联网。
- 仅替换 OS 边界：`shell.openExternal` 记录调用并支持 reject，防止启动系统浏览器；`dialog.showMessageBox` 记录提示参数并立即返回，避免原生弹窗阻塞。不注入导航防护、不替换产品处理器、不模拟点击回调。原 assistant 链接 DOM 不变；额外创建 React 根节点之外的原生 DOM fixture 并真实点击，专门验证绕过 Markdown 呈现层的宿主防护。真实点击之后记录主窗口 ID/URL/标题、主 frame 导航、Electron 窗口列表、目标页请求、系统打开次数及提示参数。
- 工作台断言涵盖自绘标题栏/关闭入口、原消息、可编辑输入框与未发送草稿；工作台仍在时再验证编辑及设置往返。先汇总失败，再独立验证正常退出，避免 URL 断言短路而漏掉关闭挂起。
- 正常退出必须在 15 秒内观察到子进程 `exit(0, null)`。标题栏消失时额外尝试原生 `BrowserWindow.close()`，不绕过原有保存屏障；超时是失败。`finally` 中 `closeApp()` 的退出重试/强杀仅用于清理，不计为正常关闭成功。
- 宿主边界场景：原生 `_self` HTTP 链接、`target=_blank` HTTPS 弹出（与 `window.open` 汇入同一 `setWindowOpenHandler`；被拒的 `window.open` 会让 Playwright 渲染进程调用停在等待导航，故由单元测试直接覆盖 handler 的该形态）、同窗口及新窗口 `file:`、新窗口 `data:`/`javascript:`/未知协议、`openExternal` reject 后的一次 warning 提示；每项检查 URL、单窗口、工作台及草稿保留，拒绝路径在 500ms 观察窗口内验证零外部调用。被产品取消的主 frame 导航会让 Playwright 的等待型 locator 调用（含 boundingBox/locator.evaluate）永久停在 waiting for navigation to finish，故边界夹具的点击用实际命中点的真实鼠标输入，点击后的工作台、点击计数与清理断言全部经 evaluate 直读 DOM，不经 locator 等待；弹出场景（`target=_blank` + `rel=noopener noreferrer`，与 `window.open` 汇入同一 `setWindowOpenHandler`）不取消主 frame 导航，不受此影响。所有场景结束后独立验证真实关闭。
- 尚未覆盖：真实 TLS 网络、Markdown HTTPS/裸 URL、compact/子代理报告、同窗口 `javascript:`/`data:`、自动重定向、子 frame、开发服务器/打包 exe 入口、真实系统浏览器及原生提示窗口外观、提示自身 reject。当前用例不冒充上述覆盖。

## 新增场景的维护要求

新增一个 E2E 场景时必须同步三处：

1. `packages/desktop/package.json`：加 `test:e2e:<name>` script，并把 `node e2e/<file>.mjs` 追加到 `test:e2e:all` 链；
2. 根 `package.json`：加同名 `test:e2e:<name>`（`pnpm build && pnpm --filter @codexlike/desktop run test:e2e:<name>`）；
3. 本表：按链序插入一行，写清一行断言要点。

定位一律遵守 CODING_STANDARDS.md「E2E 定位器」（testid / 容器限定，内容断言显式处理多命中），`pnpm check:e2e-locators` 会拦截根级裸定位。
