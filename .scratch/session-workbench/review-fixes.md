# 独立审查修复记录（fix/session-workbench-review）

**Status:** completed

审查输入：两位审查代理对 `feat/session-workbench` tip `65b52ba` 的 Spec 轴与 Standards 轴发现。本分支为唯一 fresh 修复代理工作树 `ai-agent-wt-session-workbench-review`，基于同一 tip；只修下列确认发现，不改原 [spec](spec.md) 与 [任务索引](issues/README.md) 的验收语义。全部改动见本文件末尾的映射与最终检查。

## 两轴发现与修复

### 1. P1（Spec）Compact 后残留问答草稿阻断所有保存/发送/退出

- **发现**：问答输入 → 取消（interrupt）→ 继续多轮 → `/compact` 裁掉问答所在轮次后，宿主 `workbench.write` 按“当前 transcript 中的 interaction”校验草稿归属；被压缩轮次的请求已不在 transcript，旧草稿随每次保存重发，永远命中“问答草稿与会话请求不匹配”，flush 屏障失败导致无法保存、发送或正常退出。规格承诺历史问答草稿只读保留（用户故事 27、ADR 0009）。
- **红**：`workbench-ipc.test.ts`「Compact裁去问答所在轮次后仍能保存只读草稿与新输入…」真实 Core + SQLite 复现 `Error: 问答草稿与会话请求不匹配`（workbench-ipc.ts:123 原实现）。
- **修复**：
  - `SessionManager` 新增只读 `interactions(sessionId)`（`manager.ts`），宿主草稿归属校验改用**同会话持久交互记录**而非当前 transcript——交互记录不随上下文压缩删除（ADR 0009：持久化等待记录用于显示和审计）。
  - `manager.transcript()` 对“已取消且仍有未提交草稿”的历史问答保留只读展示：压缩只裁模型上下文，不裁规格承诺的草稿可见性。
- **绿**（`workbench-ipc.test.ts`）：Compact 裁掉问答轮次后保存成功；SQLite 重开只读草稿仍在、`respond-interaction` 返回 false 不复活授权；另一会话引用同请求 ID 或伪造 ID 仍拒绝“问答草稿与会话请求不匹配”；压缩后新输入真实发送。
- **真实 Electron 回归**（`persistent-workbench.mjs` 扩展）：问答草稿 → 停止 → 4 轮 → `/compact` → 只读草稿仍可见 → 编辑新输入 → 经**保存屏障正常退出**（不靠测试强杀兜底）→ 重启恢复草稿并显式发送成功，模型请求数精确为 9（无重放）。

### 2. P1（Spec）start 已执行但消费草稿失败，重试静默吞新任务

- **发现**：`sessions.start` 先执行 `send`（首条消息已被模型接受），随后 `workbench.started` 内再 `await profiles.list()`（safeStorage 解密读取，可能失败）。该失败使 start 报错但任务已执行；重试走“已有 creationRequestId 且有消息 → 返回旧会话”路径，**不补偿消费**，草稿 requestId 永不轮换——用户在草稿里输入新文本重试，永远拿回旧会话且新文本不执行。
- **红**：
  - 「首条消息接受后不再解密默认配置…」：safeStorage `decryptString` 第 3 次调用注入失败，原实现真实抛 `injected keychain unavailable after start`（workbench-ipc.ts:211 原调用栈）。
  - 「首条已执行但草稿落盘失败，重启重试补偿消费而不重放…」：SQLite trigger 注入 `workbench_state` UPDATE 失败，重启重试后草稿 requestId 未轮换（`expected '…' not to be '…'`）。
  - 「补偿已接受意图不能清空失败后编辑的新文本…」：首轮修复后补红——补偿无条件清空草稿文本，失败后编辑的新输入被吞（`expected '' to be '失败后准备的不同任务'`）。
- **修复**：
  - **移除 post-start 不必要故障点**：`workbench.started` 不再解密配置，改为同步方法，默认模型沿用 start 开头已解析的 `available[0]?.id`。
  - **可补偿消费**：重试命中“已执行意图”时，若草稿 requestId 仍等于该意图则同步补偿消费（轮换 requestId、重置为默认 ask/auto/首 Profile），**绝不重发首条**；补偿登记进 `starts` 去重映射，与并发重试共享同一 Promise。
  - **不清空用户新文本**：补偿时以首条已接受消息文本为凭证，若草稿文本已不同于凭证（用户失败后编辑），只轮换 requestId 保留新文本作为可发送的新意图。
- **绿**（`workbench-ipc.test.ts`）：解密第 3 次起失败不影响已接受意图；重启重试补偿消费且模型请求体序列恰为 `[首个意图, 全新任务]`；失败后编辑的新文本保留并作为新意图真实执行；原有“首次发送成功后的03草稿消费仍在等待时移除项目”场景改为经补偿路径复验（移除等待期间不复活、不回滚磁盘）。

### 3. P2（Spec）Compact 公开运行现场分叉

- **发现**：Compact 只登记 `executions`/`interrupts`，不进入 `liveSessions`。`sessions.execution` 显示 running 而 `sessions.view`/`list` 为旧 completed；WorkspacePage 切换会话清掉 `compacting` 且停止入口依赖 `view.activity.running`，导致挂起 Compact 切走再切回后停止按钮丢失、后台完成不更新界面。
- **红**：
  - `workbench-ipc.test.ts`「压缩执行也复用宿主占位…」扩展断言：挂起 Compact 时 `view.activity` 为 `{ running: false, outcome: 'completed' }`（旧 completed），与 execution 的 running 分叉。
  - `ui/tests/live-session.test.ts`「Compact启动和终态按水位接续…」：原 `receiveLiveEvent` 把 `compact-start` 当旧执行事件丢弃（`expected 'e1' to be 'compact-1'`）。
- **修复**（共用生命周期，不引过度抽象）：
  - `session-ipc.ts` 提取模块内 `beginExecution(sessionId)`：统一占位检查（`assertCanExecute`）、`executions` 登记、`liveSessions.begin` 现场 起点、`interrupts.begin` 停止通道与对称 `end()` 清理；`send` 与 `compact` 共用，消除两份重复形状。
  - 新增统一序号事件 `compact-start` / `compact-finished`（`SessionEventEnvelope.event` 联合扩展）；`compact-finished` 携带权威 `history`，`liveSessions.accept` 在同一终态信封内落定 outcome（completed/failed/interrupted，停止后改判 interrupted）、重置现场历史并清空增量——切换中的客户端按水位接续，无需另一次有竞态的 view 重查（原 `invalidate` 方案删除）。`SessionActivity` 增加 `operation?: 'compact'` 仅活动期间存在。
  - UI `live-session.ts`：`compact-start` 为新执行起点，`compact-finished` 原子替换条目并按单调水位防重防旧执行污染；`WorkspacePage` 由统一现场恢复 `compacting`（切换回来仍显示停止入口），移除 IPC 回包后的 view 重拉（历史与状态由同序号事件更新），`compact-finished` 时 reconcile 交互并刷新资源/告警/侧栏。
- **绿**：
  - 宿主：挂起 Compact 时 list/view/execution 三者一致 `running:true, operation:'compact'`，`view.executionId` 为新执行、`sequence` 单调递增、events 恰为 `['compact-start']`；整理保护照旧拒绝。
  - UI 纯逻辑：start/finished 按水位接续、重复与旧执行事件不污染、快照+缓冲交错等价。
  - 真实 Electron（`compact.mjs` 扩展）：挂起 Compact → A→B→A 切换后压缩指示与停止入口仍在 → `composer-stop` 停止（历史 4 轮原样、无摘要卡片）→ 再次挂起 Compact 切 B→A → 后台完成自动更新为摘要卡片 → 挂起时退出：取消保留执行、确认后等待排空正常退出、重启零重放且原摘要历史未被中断的第二次 Compact 改写。

### 4. P3（Standards）`bg-black/40` 违反 ADR 0006

- **红**：新增 `assertSemanticOverlay`（`helpers.mjs`）在真实渲染中比较弹窗父层背景色与 `var(--overlay)` 计算值，`membership.mjs` 首跑失败：`{"actual":"oklab(0 0 0 / 0.4)","expected":"rgba(0, 0, 0, 0.55)"}`。
- **修复**：`ApplicationExit.tsx` 与 `MembershipDialogs.tsx` 两处（共三个弹窗）改用已有语义 token `bg-overlay`（styles.css `--color-overlay`，两主题各一份）。
- **绿**：`test:e2e:membership`（归属 + 项目移除两个弹窗）与 `test:e2e:exit`（退出确认弹窗）真实计算色值断言通过。

### 5. P3（Standards）新 E2E Profile 按钮使用 section+heading 再 getByRole

- **红**：`entry-consistency.mjs` 改为 `getByTestId("profile-create")` 后首跑 `locator.click: Timeout`（按钮无稳定 testid）。
- **修复**：`SettingsPage.tsx` 真实“+ 新建 Profile”按钮添加 `data-testid="profile-create"`；全部 22 个引用该按钮的 E2E（acceptance/approvals/browser/changes/commands/compact/interactions/interrupt/live-sessions/mcp/membership/persistent-workbench/projects-sidebar/session-search/sidebar-archive/skills/smoke/subagent-thinking/subagents/thinking/worktree 及 entry-consistency）统一改用 testid 定位，删去 section+heading 过滤样板；表单内其余定位（`getByLabel`/form 限定保存按钮）按 CODING_STANDARDS 保留，原断言未删。

## 既有断言适配（非删除）

- `workbench-ipc.test.ts`「首次发送成功后的03草稿消费仍在等待时移除项目…」：因 start 流程消费时机改变，改为经真实 SQLite trigger 制造消费失败后重试，仍验证移除等待期间旧 requestId 不返回删除记录、不回滚 Worktree 磁盘；标题更新注明“补偿草稿消费”。
- `liveSessions.invalidate` 无调用者后删除（compact 统一走终态信封）。

## 测试与检查（实际运行，串行取退出码，无截断管道）

| 命令                     | 结果                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `pnpm build`             | 退出 0（三包；保留既有 import.meta/@**PURE**/大 chunk 警告）                                        |
| `pnpm typecheck`         | 退出 0                                                                                              |
| `pnpm test`              | 退出 0：Core 416、Desktop 125（+4 新增）、UI 104（+1 新增），共 645                                 |
| `pnpm test:e2e:all`      | 退出 0（2026-11-12，完整 24 专项串行；含本文件新增的 compact/persistence/membership/exit 扩展场景） |
| `pnpm dist`              | 退出 0（Windows NSIS / portable zip / win-unpacked 实际重建；无代码签名证书警告沿旧）               |
| `pnpm test:e2e:packaged` | 退出 0（真实 win-unpacked 产物冷启动：父目录自建、新库落盘、侧栏与独立草稿/ask 默认）               |

各问题红绿过程命令与输出摘录见上文对应小节；E2E 与打包的完整日志存于 `C:/Users/leffss/AppData/Local/Temp/review-final-*.log`。

## 已知限制与环境边界

- Windows 文件符号链接 `mentions.test.ts` 用例仍命中既有 EPERM 内部跳过分支（runner 计通过，不代表该权限分支实测）；目录 junction 测试实际运行。未变更系统权限。
- `prettier --check` 对基线中未由本分支修改的 `mentions.ts`/`screenshots.ts`/`workspace-files.ts` 仍报格式差异，属基线遗留，本分支未触碰。
- Compact 终态信封的 `history` 为宿主在终态时点的 transcript 快照；renderer 若在信封与下一次 view 之间发生极窄窗口的外部改写（如另一进程直接改库），以 view 重开为准，不做跨进程库锁。
- 安装向导/卸载器手动走查、代码签名、超大历史性能压力不在本次范围（沿票 09 边界）。

## 产物

- Windows 发行产物：`packages/desktop/release/`（`CodexLike-Setup-1.0.0.exe`、`CodexLike-1.0.0-portable.zip`、`win-unpacked/CodexLike.exe`），由本次 `pnpm dist` 重建，冷启动经 `test:e2e:packaged` 验证。

## 票内追踪

- 票 02（运行现场）：Compact 生命周期并入统一序号现场（本文件 §3）。
- 票 03（持久草稿）：草稿消费失败补偿与压缩后草稿校验（本文件 §1、§2）。
- 票 09（入口一致性与发布验证）：Profile 定位与遮罩 token 标准（本文件 §4、§5）；最终检查表即本文件。
