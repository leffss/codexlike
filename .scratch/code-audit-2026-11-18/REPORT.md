# 全量代码审计：Bug 与性能问题

- 日期：2026-11-18
- 审计基线：`main / cbc87fff9f879e27e01b5fa4c5c8cb2158cc2cd5`
- 环境：Windows x64、Node `v24.16.0`、pnpm `12.18.0`
- 方法：7 个独立分区审阅关键实现、设计约束与测试，主审复核调用链，并对候选做隔离动态验证。不是仅审最近提交，也不是只运行静态检查。
- 变更边界：未修改业务代码、未提交；运行检查刷新了忽略的构建产物。本报告为本轮新增文件，原有 `LICENSE`、`.zcode/plans/`、`.zcode/session-to-task-notes/` 改动未触碰。

## 结论

收录 **26 条有代码及隔离复现证据的问题：P1 × 4，P2 × 22**。另有 2 个保留候选，没有计入确认问题。

这里的“已确认”指代码行为和触发条件已被复现；不表示所有问题均在真实 Electron GUI、真实模型服务或自然磁盘故障下重现。各条均注明替身与验证边界。没有发现足够证据支持 P0 级结论，也不能据此保证没有其他缺陷。

- **优先处理**：取消后任务仍启动、冷缓存浏览器首装失败、开发入口无法加载、长历史反复全量 Markdown 解析。
- **第二批**：排队幂等与退出恢复、补丁静默丢修改、草稿丢失、配置并发/故障保护、MCP/浏览器资源竞态。
- **第三批**：协议错误恢复、子代理记录与展示、设置页错误反馈、diff 新鲜度及其他边界。

### 已执行检查

| 检查                      | 结果                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `pnpm typecheck`          | 通过，退出码 0                                                              |
| `pnpm test`               | 152 个文件、1,404 个测试报告通过：core 520、desktop 394、ui 490             |
| `pnpm lint`               | 退出码 0；0 errors，6 条 Fast Refresh warning                               |
| `pnpm check:adr`          | 通过，26 篇 ADR 编号/引用检查                                               |
| `pnpm check:e2e-locators` | 通过；44 个场景文件，另豁免 6 个                                            |
| `pnpm build`              | 通过；包含与 F02 对应的 `empty-import-meta` 警告，以及 Vite 大 chunk 等警告 |
| 本轮隔离复现              | 下述 26 条有对应复现；其中部分由主审独立复跑，见证据索引                    |

**测试通过不等于相关边界已覆盖**：desktop `mentions.test.ts` 中的文件 symlink 逃逸用例因 `EPERM` 提前返回，测试框架仍报告通过。该分支不能计为本机验证成功。

**没有运行**全量 Electron E2E、NSIS 安装/卸载、真实模型付费请求、真实 Chromium 下载、真实系统关机。E2E 中存在真实鼠标/剪贴板操作、未完全隔离的 Electron userData/localStorage 和可能的浏览器下载，因此本轮未把它当作零副作用后台套件直接执行。

## 问题索引

| ID  | 级别 | 问题                                       | 类型          |
| --- | ---- | ------------------------------------------ | ------------- |
| F01 | P1   | 已停止的排队任务仍启动，首条消息重复落库   | 取消/并发     |
| F02 | P1   | CJS 产物中 Chromium 首次安装失败           | 发行/功能阻断 |
| F03 | P1   | 开发构建内联 Playwright，入口加载失败      | 开发入口      |
| F04 | P1   | 每次更新重新解析全部历史 Markdown          | 性能          |
| F05 | P2   | 取消退出后任务排队不再推进                 | 调度          |
| F06 | P2   | 重试已排队的首次发送产生孤儿队首           | 幂等/持久化   |
| F07 | P2   | Compact 绕过全局任务并发上限               | 准入控制      |
| F08 | P2   | 重复目标补丁静默覆盖前段修改               | 文件正确性    |
| F09 | P2   | 队列编辑绕行新建任务后丢原草稿             | 用户数据      |
| F10 | P2   | JSON 部分写入失败破坏上一份有效配置        | 故障恢复      |
| F11 | P2   | 异步加密期间的 Profile 修改覆盖并发删除    | 配置一致性    |
| F12 | P2   | 托盘退出确认留在隐藏窗口内                 | 生命周期/UI   |
| F13 | P2   | MCP 并发重连多开 server，关闭不完整        | 资源/并发     |
| F14 | P2   | 同任务并发首次获取浏览器页创建多个 context | 资源/状态     |
| F15 | P2   | Windows cmd 分支损坏带引号的命令           | 平台执行      |
| F16 | P2   | `read_file` 无实际读取/长行结果预算        | 性能/上下文   |
| F17 | P2   | `@引用` 先同步全量读取再做 128 KiB 截断    | 性能          |
| F18 | P2   | SDK 与 Core 重复回填未知工具的结果         | 模型协议      |
| F19 | P2   | 交互结算后状态写失败，waiter 永久失联      | 故障恢复      |
| F20 | P2   | 子代理流失败丢失当前轮已展示过程           | 持久化        |
| F21 | P2   | 编辑 Profile 清除自定义上下文窗口          | 设置丢失      |
| F22 | P2   | 设置初读失败，错误提示也被隐藏             | 错误反馈      |
| F23 | P2   | 刷新改动列表不刷新已选文件 diff            | 检视正确性    |
| F24 | P2   | Compact 后部分子代理从右栏消失             | 恢复/展示     |
| F25 | P2   | interrupted 子代理被当作运行中             | 状态展示      |
| F26 | P2   | 子代理工具结果与完整参数无法回看           | 规格遗漏      |

## P1：优先修复

### F01 — 已停止的排队任务仍启动，首条消息重复落库

**定位**：[task-ipc.ts:921–927](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/tasks/task-ipc.ts#L921)，辅助 [task-queue.ts:94–108](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/tasks/task-queue.ts#L94)、[task-ipc.ts:692–760](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/tasks/task-ipc.ts#L692)。

- **触发**：空出名额后队首已经进入启动准备，正在等待 `profiles.list()`，用户此时点停止。
- **原因**：停止删除排队项，但尚未建立执行期 AbortController，无法取消在途 `start(head)`。凭据返回后仅检查退出/名额等，没有再次检查这次排队意图是否仍有效。
- **影响**：UI 已出队，任务却继续请求模型；首条消息还被补记和正常发送各写一次。后续工具仍可能产生副作用，但本轮未执行有副作用工具。
- **证据**：真实任务 IPC + 临时 SQLite + 本地 SSE，停止返回 `true` 后仍有 `runningAfterCancel=true`，用户消息为 `["cancel-me", "cancel-me"]`。主审独立复跑一致。
- **修复**：对准备阶段也建立可撤销的意图代次/取消通道；在最终占位前同步复查该意图。不能只检查任务是否存在。
- **回归**：闸门暂停队首凭据读取，停止后放行；断言没有模型请求、首条只记一次、后续队首可继续。

### F02 — CJS 产物中 Chromium 首次安装失败

**定位**：[chromium.ts:136–140](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/browser/chromium.ts#L136)，构建原因 [build.mjs:9–13](C:/Users/leffss/Desktop/ai-agent/packages/desktop/scripts/build.mjs#L9)。

- **触发**：生产构建/发行包运行在尚无匹配 Chromium 缓存的环境，第一次调用浏览器工具。
- **原因**：`createRequire(import.meta.url)` 进入 CJS 后变成对空 `import_meta` 对象取 `url`；`cliPath()` 先于 spawn 抛错。发行组装直接拷贝此产物，没有 fallback。
- **影响**：下载器无法启动，重试也无效；已有缓存的环境绕过此分支，容易漏测。
- **证据**：执行当前实际 `dist/main.cjs` 的安装器段，冷缓存连续两次得到 `ERR_INVALID_ARG_VALUE ... Received undefined`，`spawnCalls=0`；热缓存控制组通过。主审独立复跑一致。没有真实下载。
- **修复**：让 CJS 运行时具备正确模块定位，或由宿主注入 CLI 路径；兼顾 Core 原有 ESM 路径。
- **回归**：对最终 CJS 产物用空缓存截获 spawn，断言可解析到实际 `playwright-core/cli.js`；不能只测 TS/ESM 源码安装器。

### F03 — 开发构建内联 Playwright，标准开发入口加载失败

**定位**：[dev.mjs:16](C:/Users/leffss/Desktop/ai-agent/packages/desktop/scripts/dev.mjs#L16)。

- **触发**：标准 `pnpm dev`，依赖与 Vite 已就绪。
- **原因**：dev 只 external `electron`，与生产配置不一致。内联 `playwright-core` 后，其依赖 `__dirname` 的包资源定位误指向 desktop，顶层 registry 尝试加载不存在的 `packages/desktop/browsers.json`。
- **影响**：主进程入口初始化失败，无法进入应用窗口。
- **证据**：读取真实 dev shared 配置和 `src/main.ts`，esbuild `write:false` 得到实际内存 bundle；隔离加载后为 `MODULE_NOT_FOUND ... packages/desktop/browsers.json`。主审独立复跑一致，未启动真实 Electron。初版复现沙箱缺少 Web globals 曾导致脚本自身失败，补齐后才得到这里记录的产品故障；未将初版错误作为产品证据。
- **修复**：开发与生产构建共享依赖边界，至少将 `playwright-core` 加入 dev external。
- **回归**：独立测试开发 bundle 的顶层加载，而不只通过生产构建跑 E2E。

### F04 — 每个增量、计时 tick 都重新解析全部历史 Markdown

**定位**：[MessageStream.tsx:849–855](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/MessageStream.tsx#L849)，折叠过程正文 [757–763](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/MessageStream.tsx#L757)，计时入口 [227](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/MessageStream.tsx#L227)，全量子树 [321–330](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/MessageStream.tsx#L321)。

- **触发**：已有大量含代码块的历史，当前回复输出或每秒计时更新；内容未变的父组件更新也能触发。
- **原因**：MessageStream 更新沿完整轮次/消息子树再次执行 ReactMarkdown、GFM 和语法高亮，未变历史与关闭的 `<details>` 内容仍被解析。活动段也每次解析完整累计正文。
- **证据**：真实组件 jsdom 更新中，5/100 条历史（各 1,355 字符、24 行 TS 代码）每个 tick、父更新、delta 分别触发 6/101 次 Markdown 调用，其中 5/100 次处理未变历史。5 条已折叠过程正文同样全部重解析。
- **生产解析补测**：主审重跑 `NODE_ENV=production` 的相同同步解析路径，6 次调用中位 **43.22 ms**，101 次调用中位 **695.15 ms**，后者处理 135,504 字符。不同轮测量约 0.70–0.73 秒。此数据**不是 Electron 帧率或整页耗时**，不含浏览器布局；确定性结论是重复工作量及主线程同步解析成本。
- **活动段增长**：70 字符增量执行 80/160 次，累计解析 226,800/901,600 字符，等于 `70 × N(N+1)/2`。仅证明累计输入扫描量为二次增长，不宣称实际墙钟耗时严格平方。
- **修复**：隔离计时更新；按稳定段身份和内容缓存历史 Markdown 叶节点/解析结果；活动段节流及复用已完成块。历史分页/虚拟滚动可后续评估，但本条不是泛泛要求“加 memo/虚拟化”。
- **回归**：一个增量不解析其他历史；纯计时/无关父更新不解析正文；折叠内容按需渲染。增加固定数据集性能基线。

## P2：调度与用户数据

### F05 — 取消退出后，已有空位的任务排队不再推进

**定位**：[task-ipc.ts:1401–1407](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/tasks/task-ipc.ts#L1401)。

退出确认期间唯一运行任务自然结束，结束回调尝试 pump 却被 `exiting` 闸门拒绝。取消退出的 `thaw()` 只唤醒输入队列，没有再次推进任务排队。

- **证据**：真实 IPC/SQLite 复现取消退出后 `runningCount=0`、队首仍 queued、没有新模型请求；额外手动 pump 立即恢复，主审复跑一致。
- **修复/回归**：thaw 同时恢复两个队列，并防止防重入吞掉推进请求；覆盖取消退出及 flush 失败回退时最后一个运行任务已经结束的场景。

### F06 — 重试已排队的首次发送产生孤儿队首，阻塞整个 FIFO

**定位**：[task-ipc.ts:439](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/tasks/task-ipc.ts#L439)、[470](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/tasks/task-ipc.ts#L470)。

并发已满时，已接受的 `tasks.start(requestId=X)` 只是排队，首条尚不在 messages 中。同 requestId 重试被当成“未成功启动”，删除旧任务并新建；旧 task_queue 行未级联清理。pump 对不存在的旧队首持续失败且保留 FIFO，后面的任务永远无法推进。

- **证据**：真实 SQLite 重复公开 IPC，返回两个不同 ID，旧任务不存在却仍占队首；运行数为 0，多次 pump 仍不发新请求。主审独立复跑一致。
- **可达性限定**：不声称正常 UI 自动重试。实际异常入口是 [WorkspacePage.tsx:895–905](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/pages/WorkspacePage.tsx#L895) start 成功后，`completeNewDraft` 读取失败而提示手动重试；[workspace-state.ts:248–263](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/lib/workspace-state.ts#L248) 尚未换掉 requestId。该 UI 异常路径只做调用链核对，动态复现直接调用 IPC。
- **修复/回归**：把已持久化排队意图纳入幂等成功凭证，返回原任务、保留位置；覆盖满员下重复请求、库重开后重试及后置草稿读取失败。

### F07 — Compact 绕过任务并发上限

**定位**：[task-ipc.ts:1188–1193](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/tasks/task-ipc.ts#L1188)。

压缩路径直接 `beginExecution()`，未经过普通发送的应用级名额准入。它又被计入执行数，形成“计数但不受准入限制”的不一致。

- **证据**：上限设为 1，一个任务运行时，对另一个有 4 轮历史的任务压缩，立即产生第二个模型请求，`runningCount=2`；主审复跑一致。
- **修复/回归**：统一所有执行入口的名额检查；满员明确拒绝或设计压缩操作队列，不能把压缩假装成普通消息。覆盖结束/失败/中断后的释放。

### F08 — 一个补丁重复命中同一文件，前段修改被静默覆盖

**定位**：[apply-patch.ts:130–145](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/tools/apply-patch.ts#L130)。

每段均读磁盘原文试算，最后顺序写回。第一段修改 `duplicate.txt` 的第一行，第二段通过 `./duplicate.txt` 修改第二行，后者基于旧文件覆盖前者。

- **证据**：原文 `one\ntwo\n`，期望 `ONE\nTWO\n`，实际 `one\nTWO\n`，仍返回 `isError:false` 和“2 个文件”。独立临时文件复现。
- **限定**：工具描述要求每文件一段，但实现对不合约输入既不拒绝也不安全合并；问题是静默成功及丢修改，不是必须支持重复段。
- **修复/回归**：按规范化真实目标去重并整批拒绝，或维护逐文件内存工作副本。覆盖 `./`、Windows 大小写和 Update/Delete/Add 混合。

### F09 — 队列编辑绕行新建任务后，原输入草稿丢失

**定位**：[WorkspacePage.tsx:531–535](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/pages/WorkspacePage.tsx#L531)，相关 [822–844](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/pages/WorkspacePage.tsx#L822)。

A 输入框已有未发送草稿，取回队列消息编辑后点击“新建任务”，再回 A。进入新建没有恢复 `savedDraft`；回到同一个 A 时又因 `editing.taskId === id` 跳过恢复，却清掉编辑状态。

- **证据**：真实 WorkspacePage/侧栏/composer 的 jsdom 点击路径，持久 workbench 只剩队列文字，原草稿和取消入口均消失；A→B→A 对照正常。
- **修复/回归**：统一离开编辑目标的恢复逻辑，涵盖任务、新建、卸载；同时断言内存及落盘草稿。

### F10 — JSON 写入中失败会毁掉上一份有效配置

**定位**：[json-file.ts:34–36](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/storage/json-file.ts#L34)。

默认 `writeFileSync` 原地以 `w` 截断。打开成功后发生部分写入失败，原配置已无法恢复；Profile/Search/MCP 读侧不能解析残缺 JSON。Search/MCP 在 [main.ts:480](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/main.ts#L480)、[551](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/main.ts#L551) 被建窗前 await，可进一步阻断启动。

- **证据**：真实临时文件打开截断、写 16 字节后注入 ENOSPC；三种配置随后的真实读取/startup 均 SyntaxError。没有填满磁盘、没有真实 Electron 黑屏实验。
- **严重程度说明**：按条件性故障恢复缺陷记 P2，而非声称正常保存必损坏。触发要求打开后写失败，打开前 EACCES 不等价。
- **修复/回归**：同目录临时文件完整写入后替换，失败保留旧值，设计损坏隔离/恢复提示。注入部分写和替换失败，断言旧配置可重读。

### F11 — Profile 异步加密期间，并发删除可被旧快照覆盖

**定位**：[profile-store.ts:132–140](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/profiles/profile-store.ts#L132)，创建同构 [124–126](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/profiles/profile-store.ts#L124)。

读取整个配置文件后 await 加密，再按旧快照写回。等待期间成功删除 B，保存 A 完成后 B 被恢复。生产适配确实使用异步加密，见 [main.ts:104](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/main.ts#L104)；编辑 A 时其它卡片删除按钮仍可点击。

- **证据**：真实 store + 加密闸门，删除 B 成功并可确认不存在，放行 A 后 B 再次出现。
- **修复/回归**：串行化读改写或加密后在同步提交段重读并合并/CAS。覆盖 update/remove、create/create、不同 Profile 同时更新。

### F12 — 托盘退出时，确认框仍在隐藏窗口内

**定位**：[exit-ipc.ts:35–40](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/lifecycle/exit-ipc.ts#L35)，装配 [main.ts:767](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/main.ts#L767)。

有未完成任务，X 隐藏到托盘后点“退出”，只触发 app.quit 和状态广播，没有 show/restore/focus。状态进入 confirming、运行入口冻结，但用户看不到确认；再次退出不推进。

- **证据**：真实托盘/退出模块配合 Electron 假窗口，`visible=false`、show/focus 均 0、`frozen=true`，显式托盘打开可恢复确认。
- **限定**：不是永久死锁；未做原生 Windows 托盘点击实验。
- **修复/回归**：需要用户回答时显示并聚焦主窗口，覆盖隐藏/最小化/静默启动下退出和取消。

## P2：工具、资源与性能

### F13 — MCP 并发重连多开 server，关闭不能完整回收

**定位**：[mcp/manager.ts:221–228](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/mcp/manager.ts#L221)，关闭 [319–329](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/mcp/manager.ts#L319)。

断线后多个消费者同时检查到 `connection === null`，各自 establish；最后发布者覆盖其他连接引用。生产主任务和子代理共享同一 MCP manager。连接中的 disconnect/close 也不能阻止迟到连接重新变 connected。

- **证据**：真实本地 stdio 假服务崩溃后三并发得到 3 个不同 server PID；manager.close 后 2 个仍存活。审计脚本已按记录 PID 清理并确认没有残留。
- **影响**：资源泄漏及有状态服务的状态分叉，不仅是启动次数多。
- **修复/回归**：按 server 共享在途连接 Promise，加生命周期代次并收尾迟到连接；覆盖崩溃后并发、连接中关闭/删除及所有进程回收。

### F14 — 同任务并发首次获取页面会创建多个 BrowserContext

**定位**：[browser/manager.ts:95–102](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/browser/manager.ts#L95)。

同任务多个 pageFor 在异步 newContext/newPage 前都查不到 Map 项，最后互相覆盖。后续只拿到最后一页，closeTask 也只关闭最后一个 context。同任务子代理沿用主 taskId，故并发可达；本条不否定既定共享页面设计。

- **证据**：真实 manager + Playwright 异步边界替身，3 并发分别返回 context 1/2/3，随后只复用并关闭 3，1/2 未关闭。没有启动真实浏览器。
- **修复/回归**：按 taskId 共享创建 Promise，关闭时收尾在途创建；同任务并发必须返回同一 Page，失败不能泄漏已建 context。

### F15 — Windows cmd 分支损坏带引号命令

**定位**：[terminal.ts:267–271](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/tools/terminal.ts#L267)，参数构造 [146–153](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/tools/terminal.ts#L146)。

Node 默认参数转义直接用于 `cmd.exe /d /s /c`，与 cmd 命令字符串解析不匹配。

- **证据**：Windows 真机临时文件，工具执行 `type "含空格绝对路径"` 失败；相同 spawn 参数 `windowsVerbatimArguments:false` 退出 1，`true` 退出 0 并读到 `space-path-ok`；Bash 读同文件成功。
- **修复/回归**：单独设计 cmd 的命令字符串封装/Windows verbatim 策略，不同时改变 Bash/PowerShell。覆盖带空格路径、带引号参数、元字符和带空格可执行路径。

### F16 — read_file 行数限制不能约束读取成本或长行输出

**定位**：[read-file.ts:70–90](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/tools/read-file.ts#L70)。

即便只读一行，仍同步读整个文件、解码并拆分所有行；单行没有字节上限。压缩 JS、单行 JSON 等常见输入可穿透行数预算，把多 MiB 结果带入持久化和模型请求。

- **证据**：2 MiB 单行文件，`offset:1, limit:1` 返回 2,097,155 字节，`isError:false`，没有截断标记。没有进行 OOM/崩溃压力实验。
- **修复/回归**：限制实际读取和最终结果字节数，分块扫描、长行截断或明确拒绝；测试单行大文件、多行首行、UTF-8 边界。

### F17 — @引用先同步读取完整文件，再做 128 KiB 截断

**定位**：[mentions.ts:41–45](C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/tasks/mentions.ts#L41)。

限制只作用于返回文本，不限制主进程同步 IO 与 Buffer 分配。

- **证据**：128 MiB 人工日志每次实际读取 134,217,728 字节，Buffer 增量 128 MiB；三次同步耗时 79.14/83.48/83.12 ms，零延迟 timer 同样被延后约 79–84 ms，返回却仅约 128 KiB。绝对耗时与缓存/机器有关，全读及全量分配确定。
- **修复/回归**：只读预算范围加少量探测字节，在句柄层限制读取；断言读取字节和内存预算，而非仅检查最终字符串截断。

## P2：模型协议与交互恢复

### F18 — 未知工具的错误结果被 SDK 与 Core 各回填一次

**定位**：[agent-task.ts:713–714](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/task/agent-task.ts#L713)，手工结果 [838–845](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/task/agent-task.ts#L838)；子代理同构 [subagent.ts:572](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/task/subagent.ts#L572)。

SDK 对未知工具自动生成 tool-error，response.messages 已包含对应 tool 结果；Core 全量加入后，又手动加入“工具未注册”结果。

- **证据**：真实 provider/SDK + fetch 替身捕获下一请求，唯一 `unknown-call` 对应两条 tool 消息。严格端点替身返回 400，回合终止；重复请求体是真实生成，400 为模拟校验，并非真实服务观测。
- **修复/回归**：统一每个调用的结果所有权，识别 SDK 已结算/invalid 调用，保证恰好一个 tool-result。主/子路径覆盖未知工具和非法参数。

### F19 — 交互已结算后状态写入失败，waiter 永久失联

**定位**：[interaction/controller.ts:37–46](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/interaction/controller.ts#L37)，宿主状态写 [agent-task.ts:351–358](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/task/agent-task.ts#L351)。

settleInteraction 成功后先删除 waiter 并卸载 abort，再调用可能写库失败的 waiting 回调；此处抛错就永远不会 resolve。原执行持续等待，但 pending 已空，停止和 cancel 都找不到 waiter，busy 无法释放。

- **证据**：真实 AgentTask 交互流程 + 注入一次状态写失败：interaction 已 resolved、pending=0、工具未执行，abort/cancel 后仍不完成，后续发送报“上一条消息仍在回复中”。没有制造真实 SQLite 故障，故障发生频率未知。
- **修复/回归**：结算与必要状态原子更新，或保证结算成功后通知/辅助写入失败不能阻止唤醒。覆盖单次批准、拒绝及问答，不只覆盖批量授权。

### F20 — 子代理流失败时，当前轮已展示的正文/思考没有落库

**定位**：[subagent.ts:550–560](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/task/subagent.ts#L550)，异常收尾 [644–652](C:/Users/leffss/Desktop/ai-agent/packages/agent-core/src/task/subagent.ts#L644)。

error part 抛出跳过正常循环后的 flushRound，catch 只设置失败报告。用户已看到的部分过程在恢复后消失。

- **证据**：真实 SDK + mock 流依次输出 reasoning、text、error；两种增量均发出，失败报告存在，但 subagent message 记录为 0。正常 abort-part 测试不能覆盖此异常分支。
- **修复/回归**：所有生成轮终态恰好一次 flush，清空/标记已写缓冲避免重复；覆盖仅思考、思考+正文后的流异常，保持失败报告语义。

## P2：设置、检视与恢复展示

### F21 — 编辑 Profile 的其他字段会清除自定义上下文窗口

**定位**：[SettingsPage.tsx:94–99](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/pages/SettingsPage.tsx#L94)。

表单 initial 漏传 contextWindowTokens，输入初值为空，提交不带字段；Profile store 全量替换记录使旧值消失，告警回退默认 128k。

- **证据**：真实 SettingsPage/jsdom，预置 64000，仅改名称保存，update payload 缺字段；持久清除由实际 store 替换逻辑核对。
- **修复/回归**：完整传入初值，同时区分保留与用户主动清空；覆盖仅改名称/API Key/模型列表。

### F22 — 设置初次加载失败时，错误也被 loaded 门控隐藏

**定位**：[SettingsPage.tsx:559–560](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/pages/SettingsPage.tsx#L559)，catch [494–497](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/pages/SettingsPage.tsx#L494)。

get 拒绝后写入 message，但 loaded 仍 false；错误所在的整个设置体不渲染，用户只见标题，没有错误/重试。终端、子代理、MCP 超时分区有同构模式。非 ENOENT 的文件读取错误是实际可达来源。

- **证据**：真实 SettingsPage + IPC 拒绝替身，设置表体和错误文本都不存在。
- **修复/回归**：把加载状态、错误、重试放在成功门控之外；测试失败→重试成功，禁止用默认值自动覆盖无法读取的配置。

### F23 — 刷新改动列表后，已选文件仍显示旧 diff

**定位**：[RailPanel.tsx:549](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/RailPanel.tsx#L549)，key [401–405](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/RailPanel.tsx#L401)。

DiffView 只依赖 taskId/path/oldPath，刷新代次不传入。文件内容变了，但路径没变，重新选同一文件也不重拉。

- **证据**：真实 RailPanel/useGitStatus/DiffView，Monaco 仅替换显示边界；revision、刷新、重选后 status 请求 1→3，diff 仍 1 且显示 VERSION_ONE，切 tab 后才变 VERSION_TWO。主审独立复跑一致。
- **修复/回归**：向 diff 传递刷新代次，提交/刷新后验证选中项仍有效；断言相同路径的新内容，而不只测列表。

### F24 — Compact 后被裁轮次的子代理从右栏消失

**定位**：[task-view.ts:1015–1020](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/lib/task-view.ts#L1015)。

mergeSubagentsAfterCompact 仅遍历重建消息流并补仍有 spawn 行的富段，丢掉被裁轮次和无 spawn 行的 interrupted 子代理。右栏取自当前消息段，直到重新打开任务才恢复。

- **证据**：实际恢复/merge 纯函数链，子代理数量 1→0，重新带持久快照恢复后 0→1；主审复跑一致。
- **规格**：[subagent-records/spec.md:37](C:/Users/leffss/Desktop/ai-agent/.scratch/subagent-records/spec.md#L37) 明确 compact 替换历史时保留并行子代理数据。
- **修复/回归**：子代理检视数据独立于消息裁剪，或保留未匹配记录；覆盖旧轮 completed 和无 spawn 的 interrupted，压缩前后及重开等价。

### F25 — interrupted 子代理被当作运行中，隐藏主正文操作栏

**定位**：[turn-view.ts:32](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/lib/turn-view.ts#L32)。

`state !== "done"` 包括 interrupted 终态，轮次 running 恒 true，即使宿主 idle；复制、导出等最终正文操作被 `!turn.running` 隐藏。

- **证据**：真实 initialTranscript 恢复 interrupted 快照，再 groupTurns 与 MessageStream SSR，hostRunning=false 而 turn.running=true，actions 缺失；去掉中断段控制组存在。主审复跑一致。
- **修复/回归**：正向枚举 queued/running 或共用终态判据；测试恢复快照→轮次→操作栏，而不只测状态徽章。

### F26 — 子代理工具清单无法回看完整参数与输出

**定位**：[SubagentRailPanel.tsx:519–523](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/components/SubagentRailPanel.tsx#L519)。

模型与持久层已有 arguments/output，但 ToolsDetails 只渲染摘要及“完成/失败”，没有完整详情；导出也不含工具输出，不能替代检视入口。

- **证据**：恢复数据包含唯一错误串和 cwd 参数，段模型完整，真实 SSR/导出均没有对应文本；主审复跑一致。
- **规格**：[subagent-records/spec.md:17](C:/Users/leffss/Desktop/ai-agent/.scratch/subagent-records/spec.md#L17) 要求完整回看名称、参数、结果、成败，不是新增功能建议。
- **修复/回归**：增加按需展开的安全文本详情，复用主工具卡；覆盖长输出、失败及中断恢复，默认收起但展开可读。

## 保留候选：不计入 26 条

### C01 — 队列操作迟到回包可能覆盖其他任务的队列 UI

[WorkspacePage.tsx:979–983](C:/Users/leffss/Desktop/ai-agent/packages/ui/src/pages/WorkspacePage.tsx#L979) 不校验当前 taskId/代次，直接 setQueueState。真实组件配合可控延迟 IPC 替身能把 A 回包写到 B loading 阶段，且队列按钮仍可操作。但宿主对应 handler 同步返回，本轮没有验证真实 Electron 消息调度足以形成同样时序，故不与确认项等权。

建议在真实 IPC 下增加可控调度实验；实现上可用 taskId/generation/sequence 守卫，与已有 saveQueueEdit 路径保持一致。

### C02 — 复用模型 tool-call ID 时子代理旧报告回填

Core 隔离编排器中两次委派复用 call ID，报告分别为 report-1/report-2，resultFor 却返回最早 report-1，且 done entries 长期保留。但生产还叠加工具记录全局主键约束，需要将 provider ID 作用域、持久化键和编排器生命周期联合验证。本轮不单独计作已确认生产缺陷，也不对特定外部 provider 的 ID 行为作未验证断言。

## 已知延期/验证债务：不是新发现的 bug

- [执行参数候选票](C:/Users/leffss/Desktop/ai-agent/.scratch/execution-settings/issues/06-candidate-params-inventory.md)：仍为 needs-triage；浏览器/search 参数候选不是已确认缺陷，其中 MCP 项已标完成。
- [消息流设计](C:/Users/leffss/Desktop/ai-agent/docs/adr/0011-message-stream-timeline-model-and-reasoning-persistence.md)：历史分页/虚拟滚动明确延期。F04 单独给出了重复解析实证，没有把延期本身当 bug。
- [跨项目搜索票](C:/Users/leffss/Desktop/ai-agent/.scratch/session-workbench/issues/06-cross-project-search.md)：子串扫描、无 FTS/分页；本轮未测大历史 SQLite 容量曲线，不能断言具体性能阈值。
- [子代理验证文档](C:/Users/leffss/Desktop/ai-agent/docs/testing/subagent-delegation.md)：真实模型委派质量、费用及并行收益仍待测，需额外确认费用和外发范围。
- [验收票](C:/Users/leffss/Desktop/ai-agent/.scratch/session-workbench/issues/09-entry-consistency-and-release-verification.md)：OS 关机、renderer 崩溃无法 flush、签名/安装卸载等验证边界仍存在。

## 覆盖范围与局限

结构探索统计：三个 src 共 182 文件、36,554 行（含空行注释）；本轮按 subsystem 检查关键行为和跨层调用，**不声称逐行证明全部 36,554 行无误**。

1. Core：主循环、provider/stream/retry、交互等待、子代理并发、compact/上下文。
2. 工具：文件/路径/patch/terminal/扫描、资源快照/skills、browser、MCP。
3. 宿主：任务 IPC、输入与任务排队、停止/退出/恢复、创建幂等。
4. 存储/平台：node:sqlite、JSON、安全存储、项目/Worktree/git、mentions、托盘/窗口/openers。
5. UI 状态：工作台目标、composer/队列编辑、设置、侧栏/搜索、交互。
6. UI 呈现：消息/轮次/Markdown、子代理、工作计划、滚动、diff。
7. 构建边界：dev/build/dist、main 总装配、preload/shared IPC、导航政策。

没有把既定 full-access/assist 语义、任务归档保留磁盘、同任务共享浏览器、旧记录不迁移、Windows-only 等产品选择当作 bug。观察器/常规定时器/Monaco 清理、工具重试是否重放副作用等疑点经核对未形成足够证据，未凑入问题数量。

当前 desktop `test:e2e:all` 是 39 个顺序场景入口，并不包含全部专项：packaged、export、5 个 input-queue 专项和 task-queue-restart 不在其中。文档里的旧场景总数不能替代实际 package script。本轮没有实跑该套件，不对其当前通过率下结论。

## 复现材料索引

下列脚本均在本次独立系统 temp 目录；后续系统清理可能删除。它们是诊断材料，**退出 0 表示缺陷按预期被捕获及控制组通过，不是修复后测试通过**。运行前应阅读脚本；没有访问真实用户 .codexlike 配置或真实模型凭据。部分脚本会创建临时文件/本地 stdio 进程，按各自清理逻辑处理。

| 范围            | 材料                                                                                                                                                                                                               | 主审独立复跑                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| F01/F05/F06/F07 | [repro.mjs](C:/Users/leffss/AppData/Local/Temp/desktop-task-audit-griEeY/repro.mjs)，参数 `cancel` / `thaw` / `retry` / `compact` / `all`                                                                          | 4 项均复跑                           |
| F02/F03         | [repro-packaging.mjs](C:/Users/leffss/AppData/Local/Temp/codexlike-audit-packaging-YSN6mx/repro-packaging.mjs)，仓库路径及 `all`                                                                                   | 均复跑                               |
| F04/F23–F26     | [repro.mjs](C:/Users/leffss/AppData/Local/Temp/ai-agent-ui-audit-cbc87ff-D8vAQn/repro.mjs)、[production-markdown.mjs](C:/Users/leffss/AppData/Local/Temp/ai-agent-ui-audit-cbc87ff-D8vAQn/production-markdown.mjs) | 均复跑                               |
| F08/F13–F16     | [工具复现目录](C:/Users/leffss/AppData/Local/Temp/ai-agent-tools-audit-2rHwmy/scripts/)：files-audit、mcp-audit、browser-cmd-audit、load-dist、fake-mcp                                                            | 分区审计实跑，主审复核源码/脚本/结果 |
| F09/F21/F22/C01 | [audit.cjs](C:/Users/leffss/AppData/Local/Temp/ai-agent-ui-audit-cbc87ff-vNWCYZ/audit.cjs)                                                                                                                         | 分区审计实跑，主审复核调用链         |
| F10–F12/F17     | [reproduce.cjs](C:/Users/leffss/AppData/Local/Temp/ai-agent-audit-cbc87ff-wU20AZ/scripts/reproduce.cjs)、同目录 source-loader.cjs                                                                                  | 分区审计实跑，主审复核源码/脚本/结果 |
| F18–F20/C02     | [reproduce.mjs](C:/Users/leffss/AppData/Local/Temp/zcode-core-audit-gCqVAV/reproduce.mjs)、同目录 resolve-dist.mjs 和 reproduce.stdout.txt                                                                         | 分区审计实跑，主审复核源码/结果      |

代表性命令（Git Bash）：

```bash
node C:/Users/leffss/AppData/Local/Temp/desktop-task-audit-griEeY/repro.mjs all
node C:/Users/leffss/AppData/Local/Temp/codexlike-audit-packaging-YSN6mx/repro-packaging.mjs C:/Users/leffss/Desktop/ai-agent all
node C:/Users/leffss/AppData/Local/Temp/ai-agent-ui-audit-cbc87ff-D8vAQn/repro.mjs
NODE_ENV=production node C:/Users/leffss/AppData/Local/Temp/ai-agent-ui-audit-cbc87ff-D8vAQn/production-markdown.mjs
node --experimental-loader file:///C:/Users/leffss/AppData/Local/Temp/zcode-core-audit-gCqVAV/resolve-dist.mjs C:/Users/leffss/AppData/Local/Temp/zcode-core-audit-gCqVAV/reproduce.mjs
```

## 建议实施顺序

1. **取消与入口阻断**：F01、F02、F03，各自先补精准失败回归。
2. **长任务性能**：F04、F16、F17；先减少确定的重复解析/越界读取工作，再谈大范围重构或虚拟化。
3. **调度/数据一致性**：F05–F11，连同输入队列、任务队列、真实 SQLite 重开测试验证。
4. **资源生命周期/平台执行**：F12–F15，补真实多消费者、关闭中创建和 Windows shell 场景。
5. **协议、恢复与检视**：F18–F26，补跨层恢复链与实际用户操作断言。

实施时应分小票、先回归后修复；本次仅报告，没有默认授权直接修复、创建提交或发布外部内容。
