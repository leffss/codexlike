# 05：模型工具协议、交互结算和子代理过程

Status: done
Blocked by: none

先读 ../spec.md、../notes.md；依据 ../REPORT.md F18/F19/F20/C02。用户已批准测试接缝。

## 所有权

core/task/{agent-task,subagent}.ts、interaction/controller.ts、必要私有helper及对应task/provider/interaction测试；可同步tools/types.ts的ID语义注释。不改工具实现、存储schema、desktop、UI。

## 验收

- [x] F18真实SDK/fetch请求中unknown/invalid调用恰好一个result，非法调用不执行；主/子一致。
- [x] F19settle失败保waiter；成功后辅助写/通知异常仍保证唤醒全部已结算waiter，无busy悬挂。
- [x] F20每流轮success/abort/error/iterator throw恰好一次flush，部分思考/正文可恢复，工具阶段异常不重复写上一轮。
- [x] C02用真实Task/SQLite重现ID重用，再区分hostCallId/providerCallId：宿主记录/交互/工具/委派用host，协议原ID；不迁移库。
- [x] 延迟委派返回使用host索引+provider回填，结果消费后可释放done entry而不破坏调用契约。
- [x] red→green，旧恢复/审批/工具图片关联测试不回归。

## Comments

- generateId/port.generateId可复用；映射限定当前生成轮调用实例，不建跨生命周期providerId表。
- deferredDelegations必须额外存provider ID，不能继续base.id兼做两用途。
- 主代理将统一build，单组只能exec vitest定向；不提交。

### 2026-11-18 实施完成：READY_FOR_BUILD

已读 spec/notes/REPORT、根规范、GLOSSARY 及交互/记录相关 ADR，调用 tdd，沿已批准 AgentTask/interaction API + 真实 SDK/fetch + 临时 SQLite seam 实施。生产文件已于本轮 14:42 前冻结并告知主代理，可统一 build；未运行 build、全仓 tests、install、E2E 或 commit，未改 schema、工具实现、desktop/UI。

#### 修复行为

- C02：先用公开 AgentTask + 文件型临时 SQLite 确认跨轮复用 provider ID 导致 `UNIQUE constraint failed: tool_calls.id`，并确认并行子代理同 ID 导致报告失败。现在每个调用实例用 generateId/port.generateId 生成 hostCallId，记录/事件/审批/ToolExecutionContext/委派索引使用 host；SDK assistant 和 tool-result 继续用 providerCallId。映射只在当前轮数组，不建跨生命周期 providerId 表；旧记录不迁移。deferredDelegations 显式携带 providerCallId；resultFor 保持非消费式读取，成功持久化与回填后调用 releaseResult 释放 done entry。
- F18：工具结果统一由宿主拥有，SDK response 只回填 assistant 消息，避免 SDK 自动 tool-error 与宿主结果重复；保留 invalid/error 标志，非法调用不进入审批也不执行。主/子相同，unknown 的可读错误语义保留。
- F19：settleInteraction 成功后用 finally 唤醒；false/throw 不删除 waiter。批量授权提交后任意辅助通知失败也唤醒全部已结算 waiter。取消遍历不会因首条异常遗漏其他请求，AgentTask 停止和最终清理用 finally 保证 signal 中断与 busy 释放；故障仍向原调用方抛出，不静默吞掉。
- F20：每次流消费只在自身 finally 调一次 flushRound，success/abort/error part/iterator throw 共用终态；工具阶段在其后执行，异常不会重刷上一轮。部分正文/思考保存在原表，可关库重开恢复；无内容仍不生成空行。

#### 实际 red → green 证据

命令统一前缀：`pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/agent-core exec vitest run`。所有检查直接取退出码，未管道。

| 切片                              | 参数                                                               | 红（exit 1）                                                          | 绿（exit 0）                                                                       |
| --------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| C02 公开 Task/SQLite 委派 ID 重用 | `tests/task/subagents.test.ts -t 'C02：跨生成轮'`                  | 1 failed；error 含 `UNIQUE constraint failed: tool_calls.id`          | 1 passed；report-1/report-2 分别入库与协议回填，关库重开保留                       |
| C02 并行子代理跨轮 ID 重用        | `tests/task/subagents.test.ts -t 'C02：并行子代理'`                | 1 failed；两份报告 ok 均 false                                        | `-t 'C02：'` 共 2 passed；四个调用宿主 ID 唯一，审批/context/记录一致，协议保原 ID |
| F18 unknown 重复结果              | `tests/task/agent-task-tools.test.ts -t 'F18：未知工具'`           | 2 failed；真实下一 HTTP 请求同 call ID 结果为 2，期望 1               | 2 passed，主/子各一                                                                |
| F18 invalid 误执行                | `tests/task/agent-task-tools.test.ts -t 'F18：非法调用'`           | 2 failed；执行列表含原始坏 JSON `{"broken":`                          | `-t 'F18：'` 共 4 passed；混合法调用仅合法项获审批/执行，各一结果                  |
| F19 单次结算状态写失败            | `tests/task/interactions.test.ts -t 'F19：.*结算后任务状态写失败'` | 3 failed；批准/拒绝/问答已 resolved 但没有 assistant-done             | 3 passed；可停止并再次发送                                                         |
| F19 批量结算后通知失败            | `tests/task/interactions.test.ts -t 'F19：批量授权'`               | 3 failed；autoApproved/waiting/emit 任一点抛错后两个 waiter 均未唤醒  | 3 passed                                                                           |
| F19 return 清理 busy              | `tests/task/interactions.test.ts -t 'F19：关闭迭代器'`             | 1 failed；下一发送报“上一条消息仍在回复中”                            | 1 passed                                                                           |
| F19 并行取消后通知失败            | `tests/task/interactions.test.ts -t 'F19：停止时首个'`             | 1 failed；首条取消后另一个 waiter 仍 pending                          | 1 passed；主/子不再请求模型且可再次发送                                            |
| F20 异常流部分输出                | `tests/task/subagents.test.ts -t 'F20：'`                          | 4 failed；error part/iterator throw × 纯思考/正文+思考均 0 行，期望 1 | 4 passed；关库重开同构恢复                                                         |

补充保护（不冒称独立缺陷红测）：settleInteraction false/throw 保 waiter 与 abort 通道、answered/emit 失败返回已保存问答 4 条；工具阶段保存异常不重复 flush 1 条。现有正常轮、abort 轮、纯工具轮、旧历史恢复、图片回填与审批测试一并覆盖。

中间定向回归曾有 3 条旧 providerId 假设失败（6 文件 89 passed/3 failed），已改为通过事件、持久记录及审批实际 host ID 关联；未硬编码宿主随机 ID。主代理转告的三处测试 union 类型收窄已修正。

#### 最终验证

- `pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/agent-core exec vitest run tests/task/subagents.test.ts tests/task/agent-task-tools.test.ts tests/task/agent-task-approval.test.ts tests/task/agent-task-images.test.ts tests/task/interactions.test.ts tests/task/resume-equivalence.test.ts tests/task/subagent-thinking.test.ts tests/task/agent-task.test.ts tests/task/agent-task-tool-rounds.test.ts tests/task/task-context.test.ts tests/task/compact.test.ts tests/provider/language-model.test.ts` → **exit 0，12 文件 / 185 测试通过**。
- `pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/agent-core exec tsc --noEmit -p tsconfig.json` → **exit 0**，无构建产物。
- `pnpm --dir C:/Users/leffss/Desktop/ai-agent exec eslint packages/agent-core/src/task/agent-task.ts packages/agent-core/src/task/subagent.ts packages/agent-core/src/interaction/controller.ts packages/agent-core/src/tools/types.ts` → **exit 0**。
- 本票 9 个代码文件已定向 prettier --write，exit 0；同路径 `git diff --check` → **exit 0**。
- SDK stderr 的模拟流错误/API 401 均来自故障回归输入，不是外部模型请求。真实外部模型/真实用户数据未访问。
- 全仓 build/test、desktop/UI 回归与 E2E **pending，由主代理统一验证**。

#### 文件清单

根目录均为 `C:/Users/leffss/Desktop/ai-agent/`：

- `packages/agent-core/src/task/agent-task.ts`
- `packages/agent-core/src/task/subagent.ts`
- `packages/agent-core/src/interaction/controller.ts`
- `packages/agent-core/src/tools/types.ts`（仅 ID 语义注释）
- `packages/agent-core/tests/task/agent-task-tools.test.ts`
- `packages/agent-core/tests/task/agent-task-approval.test.ts`
- `packages/agent-core/tests/task/agent-task-images.test.ts`
- `packages/agent-core/tests/task/interactions.test.ts`
- `packages/agent-core/tests/task/subagents.test.ts`
- `.scratch/code-audit-2026-11-18/issues/05-core-protocol.md`（本票状态/证据）
- `.scratch/code-audit-2026-11-18/issues/01-task-scheduling.md`（仅追加下游 Comments）

#### 下游衔接

按主代理要求，双 ID 契约已追加到 01 票 Comments：desktop/UI/E2E 如依赖 provider 固定 ID 等于宿主记录 ID，应改为按事件/record 实际 host ID 关联；SDK 协议原 ID 不变，不应反改 Core 映射以迎合旧断言。无需新接线或数据库迁移。

### 2026-11-18 独立复审 R1/R2 收口：READY_FOR_BUILD / REBUILD_REQUIRED

仅按主代理交回的两项补修，没有扩展候选探索；生产再次修改，先前 build 不覆盖本节版本，已明确通知主代理统一重新 build 与相关 E2E 重验。本组仍未运行 build/全仓 tests/install/commit。

- **R1**：源码确认一次性 AbortSignal listener 直接 cancel，settle 抛错会遗失唤醒机会，waiting 抛错即使 finally 已 resolve 仍成为 EventTarget uncaught。改为监听内部捕获异常/结算 false，受控返回 `cancelled` 且 `response:null` 的运行时结果，不授予权限；持久化失败记录保留给任务 finally/重启补结算。普通 respond 保存失败仍保留 waiter 等重试，已 aborted 的 waiter 拒绝任何迟到响应（含 scope:task）。测试只 abort 一次，不撤故障、不调用第二次 cancel；覆盖无 uncaught、无工具执行、流结束、busy 释放与后续发送。
- **R2**：源码确认 flush 失败被已 aborted signal 的 isAbortLike 吞成普通中断。finally 现在只捕获并保留原存储错误，外层优先报告“子代理过程保存失败”，终态 failed、报告 ok:false、委派结果 isError:true；不重试 flush，不重复上一轮。测试首轮成功保存，次轮 reasoning+text 后 abort 并单次注入 insertSubagentMessage 失败，验证只保留一份旧轮及真实失败终态。

#### 追加红绿记录

统一前缀仍为 `pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/agent-core exec vitest run`。

| 参数                                        | 红（exit 1）                                                                        | 绿（exit 0）                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `tests/task/interactions.test.ts -t 'R1：'` | 2 failed + 2 uncaught；settle 场景流不结束，waiting 场景捕获 EventTarget 未处理异常 | 2 passed，无 unhandled errors                                                         |
| 同上，补迟到任务授权断言                    | 1 failed/1 passed；abort 后 settle 失败遗留 waiter 仍接受 scope:task                | `-t 'R1：\|F19：settleInteraction'` 4 passed，普通 respond 失败可重试且终止后不能授权 |
| `tests/task/subagents.test.ts -t 'R2：'`    | 1 failed；ok:true、报告为“旧轮正文中断轮正文”，掩盖保存失败                         | `-t 'R2：\|F20：'` 6 passed                                                           |

中间静态检查发现 R2 finally 内显式 throw 触发 `no-unsafe-finally`（exit 1）；已调整为 finally 捕获原存储错误、外层处理，无新增行为范围。

最终冻结版本检查：

- `pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/agent-core exec vitest run tests/task/interactions.test.ts tests/task/subagents.test.ts tests/task/agent-task-approval.test.ts tests/task/subagent-thinking.test.ts` → **exit 0，4 文件 / 102 测试通过**，无 unhandled errors。
- Core `exec tsc --noEmit -p tsconfig.json`、两生产文件 `exec eslint`、本节四文件 `git diff --check` → **exit 0**；定向 prettier 已执行。
- 本节修改文件：`packages/agent-core/src/interaction/controller.ts`、`packages/agent-core/src/task/subagent.ts`、`packages/agent-core/tests/task/interactions.test.ts`、`packages/agent-core/tests/task/subagents.test.ts`，以及本票证据。没有修改 agent-task、工具实现或其他组文件。
- 当前生产已重新冻结；主代理需要基于本节最新版本重新 build，不将旧版本 UI E2E 视为本节验证。
