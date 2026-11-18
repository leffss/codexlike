# 01：任务调度与幂等修复

Status: done
Blocked by: none

先读 ../spec.md、../notes.md；问题依据 ../REPORT.md F01/F05/F06/F07。用户已批准测试接缝与实施。

## 所有权

仅 desktop/src/tasks/task-queue.ts、task-ipc.ts，必要同目录调度helper，以及相关task queue/workbench/exit测试。不得改stores、main.ts、lifecycle/exit-ipc.ts或UI。

## 验收

- [x] F01 准备阶段取消传播，停止后不请求模型、首条仅一次、后继正常。
- [x] F05 thaw补pump且重入不漏唤醒。
- [x] F06 queued start请求幂等，真实重开无孤儿队首。
- [x] F07 Compact满员明确拒绝、执行计数不超上限。
- [x] 每项先红后绿，记录命令及结果。

## 测试线索

task-queue-ipc.test setup有SQLite+SSE/holdReply；workbench-ipc有profiles.list延迟闸门及消费失败重开；task-queue-restart有3生产store真实重开；exit-recovery有真实退出状态机及compact四轮历史；task-queue.test有协调器harness。temp原审计脚本在REPORT末尾。

## Comments

- exec vitest定向测试不自动build；Core变更需主代理统一build后再绿测。
- 不提交，完成后报告READY_FOR_BUILD和需下游集成的信息。

### 2026-11-18 实施完成：READY_FOR_BUILD

- F01：协调器为每次排队准备建立 AbortSignal；remove 撤销在途意图，IPC 在最终同步占位前复查；取消后的旧完成不得删除同任务后来入队的新意图。排队准备纳入退出排空，不访问真实用户配置。
- F05：thaw 重泵任务排队与输入队列；pump 合并准备期间的重入唤醒。排队启动失败回滚不把自身释放名额当成新唤醒，避免反复失败自重试；外部唤醒仍会重试保留队首。
- F06：持久排队与已发首条均作为 requestId 的成功凭证；草稿消费失败保留已接受任务及原 FIFO 位置，重开补偿从排队快照取 acceptedText，保留后来编辑的新草稿。覆盖成功 start 后后置 workbench:read 失败再重试。
- F07：beginExecution 同步检查全局上限，Compact 满员明确拒绝（不假装普通消息排队）；完成/失败/中断均释放名额并自动推进后继。

### 实际红→绿记录

所有命令均直接执行取退出码，未运行 test script、build 或依赖安装；以下统一前缀为 `pnpm --dir C:/Users/leffss/Desktop/ai-agent/packages/desktop exec vitest run`。

| 问题/切片          | 命令参数                                                     | 红（退出码 1）                                                                                                                  | 绿（退出码 0）                                                    |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| F01 停止准备中队首 | `tests/tasks/task-queue-ipc.test.ts -t F01`                  | 1 failed：停止后 `hasRequest("准备中被停止")` 为 true，期望 false                                                               | 1 passed；无请求、首条仅一次、后继执行                            |
| F05 解冻补跑       | `tests/tasks/exit-recovery.test.ts -t F05`                   | 2 failed：取消退出/保存失败后 requests 仍 1，期望 2                                                                             | 2 passed                                                          |
| F05 重入唤醒       | `tests/tasks/task-queue.test.ts -t F05`                      | 1 failed：解冻唤醒后队首仍 queued                                                                                               | 同时跑 queue/exit 两文件 `-t F05`：3 passed                       |
| F06 重复与重开     | `tests/tasks/task-queue-restart.test.ts -t F06`              | 1 failed：同 requestId 返回不同任务 ID                                                                                          | 初次 1 passed；后续追加补偿后 2 passed                            |
| F06 草稿消费故障   | `tests/tasks/task-queue-restart.test.ts -t 'F06 排队已接受'` | 1 failed：已接受排队任务被删除，accepted 为 undefined                                                                           | 上行 `-t F06` 两条均通过；真 SQLite 三生产连接关闭再开            |
| F07 Compact 满员   | `tests/tasks/task-queue-ipc.test.ts -t F07`                  | 1 failed：收到压缩请求而无拒绝错误（rejection undefined）                                                                       | 主回归 1 passed；补终态释放后 4 passed                            |
| F05 回滚不得自重试 | `tests/tasks/task-queue-ipc.test.ts -t 'F05 排队启动失败'`   | 1 failed：解密发生 4 次而不是 1；测试边界的第 4 次故障截住重试；红轮清理曾附带 finalized 日志，随后清理改为 freeze+stopAndDrain | `tests/tasks/task-queue-ipc.test.ts -t F05`：1 passed，无清理错误 |

额外行为保护：协调器公开 API 覆盖旧准备取消后同任务重新排队，旧完成不删除新意图且后继 FIFO 正常（已绿）；未把补充保护测试声称为独立缺陷红回归。

### 最终定向检查

- `pnpm --dir C:/Users/leffss/Desktop/ai-agent/packages/desktop exec vitest run tests/tasks/task-queue.test.ts tests/tasks/task-queue-ipc.test.ts tests/tasks/task-queue-restart.test.ts tests/tasks/exit-recovery.test.ts tests/tasks/queued-interactions-ipc.test.ts tests/tasks/input-queue-ipc.test.ts tests/tasks/input-queue-restart.test.ts` → 退出码 0，7 文件 / 56 测试通过。
- `pnpm --dir C:/Users/leffss/Desktop/ai-agent/packages/desktop exec tsc --noEmit -p C:/Users/leffss/Desktop/ai-agent/packages/desktop/tsconfig.json` → 退出码 0（没有自动 build）。
- `pnpm --dir C:/Users/leffss/Desktop/ai-agent exec prettier --check` 加下列六个代码文件的绝对路径 → 退出码 0。
- `pnpm --dir C:/Users/leffss/Desktop/ai-agent exec eslint` 加同六文件绝对路径 → 退出码 0，生产两文件无错误；四个 tests 文件因现有配置无匹配被忽略，4 条 warning，不能算测试文件 lint 已覆盖。
- `git -C C:/Users/leffss/Desktop/ai-agent diff --check --` 加同六文件 → 退出码 0。

### 文件清单与下游接线

仅本票改动（均位于 `C:/Users/leffss/Desktop/ai-agent/`）：

- `packages/desktop/src/tasks/task-ipc.ts`
- `packages/desktop/src/tasks/task-queue.ts`
- `packages/desktop/tests/tasks/task-queue-ipc.test.ts`
- `packages/desktop/tests/tasks/task-queue.test.ts`
- `packages/desktop/tests/tasks/task-queue-restart.test.ts`
- `packages/desktop/tests/tasks/exit-recovery.test.ts`
- `.scratch/code-audit-2026-11-18/issues/01-task-scheduling.md`

无需 main.ts 新接线或数据库迁移；协调器 start 的新增第二参数 AbortSignal 已在 task-ipc 内接通，公开 runtime 接口保持不变。没有改 stores、UI、main.ts、exit-ipc.ts；没有 git stage/commit/reset/revert。真实用户数据、外部模型、浏览器均未触碰。

主代理待统一 Core build 后复跑上述定向范围，并做全仓检查及隔离 E2E（建议原 task-queue-restart / input-queue / exit 场景）；本票未 build、未运行完整测试、未运行 E2E，当前通过结果基于主代理统一构建前既有 Core dist。

### 2026-11-18 05 核心协议组下游衔接

- C02 已确认并修复：新 `ToolCallRecord.id`、交互 `request.toolCallId`、工具执行上下文 `toolCallId`、`subagent-start.toolCallId` 使用宿主调用实例 ID，不再等于模型原始 provider call ID；主/子工具均如此。事件与存储/审批应按同一实际 host ID 关联，不应把随机 ID 硬编码。
- SDK 的 assistant tool-call/tool-result 消息仍保留原 provider ID，双 ID 映射仅限当前生成轮调用实例；延迟委派同时保留 host 索引与 provider 回填 ID。旧记录不迁移，历史读取不变。
- desktop/UI/E2E 若存在“provider 固定 ID 就是宿主记录 ID”的旧测试断言，请按事件/record 真实 host ID 更新，不要修改 Core 映射以迎合旧断言。主代理统一 build 后处理跨组回归；05 未改 desktop/UI 代码。
