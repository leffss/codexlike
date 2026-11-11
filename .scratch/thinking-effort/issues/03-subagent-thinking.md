# 03: 子代理快照继承与折叠展示全链路

**What to build:** 子代理自动使用触发它的主会话消息的思考档位，并在各自 SubagentCard 中独立流式展示可折叠思考内容。覆盖完整委派路径，包括独立模型、排队、并发与终止。

**Blocked by:** [02: 主会话思考档位与折叠展示全链路](02-main-session-thinking.md)。02 提供真实用户选择、发送快照与已验收的主会话展示路径；01 的 provider 能力由该依赖传递保证。

**Status:** ready-for-agent

## Parent

[思考档位 spec](../spec.md) 是完整契约；实施前阅读子代理快照、生效边界及事件展示要求。

## Acceptance criteria

- [ ] 子代理捕获触发它的主会话消息的档位快照，所有模型/工具轮次保持不变；不增加子代理独立档位设置，不实时读取 UI 当前值。
- [ ] 使用独立 Provider Profile 和回退主模型两条路径都继承同一档位；不改变现有子代理模型选择规则。
- [ ] 排队任务在触发时就确定档位，不在出队时读取新值；运行中主会话切档不会改变已有子代理或排队任务的请求。
- [ ] 五档最终请求字段符合 spec，特别验证 `auto` 省略控制字段、`off` 不带 effort；独立 Profile 不触发静默档位映射或降级。
- [ ] reasoning 事件穿过子代理事件链与 IPC，在所属 SubagentCard 内流式展示、独立展开/收起；主会话及并发子代理之间内容不串流。
- [ ] 思考不混入子代理最终报告或主会话 assistant 正文；无 reasoning 时原有卡片与报告路径保持正常。
- [ ] 正常完成、失败、子代理中断及主会话联动取消均正确结束思考显示；只有思考尚无正文时也能终止，不遗留加载状态。
- [ ] 思考只供运行期展示，不写入持久化消息、不在历史恢复时重建、不回传历史，不启用 Preserved Thinking。
- [ ] 复用子代理公开入口测试验证独立 Profile、回退、排队、并发隔离、报告回流及快照语义，并覆盖 UI 事件归并。
- [ ] Desktop E2E 实际触发子代理，断言主/子请求 body、独立 Profile 使用、运行中改档不影响已触发任务，以及 SubagentCard 思考流与折叠交互。
- [ ] 执行全量单测和项目全套 E2E，回归主会话、工具调用、审批、取消、compact 与 commit 草稿；从当前 scripts 获取命令，直接记录退出码。失败或环境阻塞如实报告。

## Testing notes

复用现有主/子模型分离注入、事件收集器、排队控制及 desktop 子代理 E2E 的本地 mock provider。使用受控屏障或明确事件推进验证排队和并发快照，避免用不稳定的固定延迟充当顺序保证。最终报告区分客户端请求契约验证与真实服务端支持验证。

## Comments

### 2026-11-11 implementer 验收证据（feat/thinking-effort-03）

**实现**（commit 于本分支，基于 a32b80b）：

- `packages/agent-core/src/tools/types.ts`：`ToolExecutionContext.thinkingEffort?`——档位随既有 profile 通道由主会话工具执行入口转发（agent-session.ts 两处 runTool 上下文均带发送时快照）。
- `packages/agent-core/src/session/subagent.ts`：委派 `execute` **入队时**捕获 `context.thinkingEffort ?? "auto"` 存入 `SubagentEntry.thinkingEffort`；`runSubagent` 全部模型轮次 `modelFor(profile, { thinkingEffort: entry.thinkingEffort })` 复用快照；`SubagentsConfig.languageModelFor` 签名对齐主会话工厂 `(profile, options)`；fullStream 新增 `reasoning-delta` → emit `subagent-reasoning`。
- `packages/agent-core/src/session/types.ts`：新事件 `subagent-reasoning { subagentId, delta }`（穿过既有 emit/buffer/pump 与通用 IPC envelope，desktop 无需改动）。
- UI：`UiSubagent.reasoning` + `applySessionEvent` 归并（按 subagentId 累积）；`SubagentCard` 流式折叠思考块（`subagent-thinking-block` / `-toggle` / `-content` / 运行中 `-indicator`，默认收起，完成态保留可回看，历史恢复不重建）。
- E2E：新增 `packages/desktop/e2e/subagent-thinking.mjs`（双 Profile 按 model 分流 mock：独立 Profile 使用、主/子 body 档位字段、运行中切 off 不影响已触发子代理且下一条消息生效、子代理思考不回传第二轮请求、SubagentCard 折叠交互与报告互不混入）；挂进 desktop `test:e2e:all` 与 root `test:e2e:subagent-thinking`。

**单测**（`packages/agent-core/tests/session/subagent-thinking.test.ts`，9 用例；UI `subagent-view.test.ts` +4 用例）：

- 独立 Profile 与 null 回退主模型两条路径均继承触发消息档位（工厂记录 (profile, options) 断言）。
- 并发上限 1 下第二个委派出队启动仍用快照；未传档位等价 auto；排队/运行/工具轮次全部轮次同档。
- `subagent-reasoning` 带正确 subagentId、与主会话 `assistant-reasoning` 及并发子代理互不串流；思考不进报告/正文/落库（messages+toolCalls JSON 断言）。
- 真实工厂 + fetch 替身全链路：子代理第一轮 reasoning_content + tool_call → 第二轮请求 body 不含思考、不含 reasoning_content 字段、含工具结果（钉住 provider transformParams 剥离不回传）；子代理请求 body 为 `thinking.type=enabled` + `reasoning_effort=high`。
- 主会话中断联动取消：只有思考尚无正文的子代理正确终止，已流出 reasoning 保留，`subagent-report` ok=false 收敛，`assistant-aborted` 收尾。
- UI 归并：增量累积到所属卡片、report 后 reasoning 保留且与报告分离、未知 subagentId 忽略、历史加载不重建。

**验证退出码**（工作树 C:/Users/leffss/Desktop/ai-agent-thinking-03）：

- `pnpm test` → 0（desktop 43 + agent-core 13 + ui 9 测试文件全绿）
- `pnpm typecheck` → 0
- `pnpm test:e2e:all` → 0（14 个场景含既有回归与新增 subagent-thinking；日志尾部 "database is not open" 为 closeApp 后收尾噪音，既有 thinking.mjs 亦出现且断言全过）

**限制说明**：mock provider 验证的是客户端请求契约（客户端确实发送 spec 规定字段并消费 reasoning_content SSE），不宣称真实远端服务端支持全部五档；五档 `auto`/`off` 的子代理 body 字段由 01/02 票的工厂表驱动测试与 E2E 覆盖，本票 E2E 覆盖 high（enabled+effort）与下一条消息 off（disabled、无 effort）。
