# goal-mode 探索事实（notes）

> 供各实现票以指针复用，避免重复探索。定位一律写符号名配验证性 grep 提示——行号随合入漂移。来源：2026-11-23 会话探索子代理报告 + 双参照物调研（Codex Goal mode / ZCode goal 源码）。规格见同目录 `spec.md`。

## agent-core（纯 TS 运行时，零 Electron 依赖）

- 主循环：`createAgentTask()` 的 `sendMessage` 内 `while (true)` 工具循环——streamText → 收集 toolCalls → 逐个过审批门执行 → 结果回填进下一轮；回合结束（正常/出错/中断）在 finally 回 idle（grep：`sendMessage`、agent-task）。
- 任务状态：`TaskStatus = "idle" | "streaming" | "waiting-user" | "waiting-approval"`（grep：`TaskStatus`）。goal 是任务上的新实体，不改这四值。
- TaskManager：`create` 落库、重启恢复时残留 streaming/waiting-approval 重置为 idle（grep：manager 内对 streaming 的重置逻辑）。
- 审批：三档 approval（ask/assist/full-access）+ `isRiskyCommand`（grep：`approval`）。goal 正交不改权限。
- 执行设置：`toolRoundsLimit` 默认 200（10-1000）（grep：`toolRoundsLimit`、execution-settings）；模型重试 `DEFAULT_MODEL_MAX_RETRIES`。
- 计划：`update_plan` 工具全量替换语义 + `PLAN_USAGE_POLICY`「计划未全部完成前持续执行」提示词条款（grep：`PLAN_USAGE_POLICY`）——goal 是回合间机制，与该条款并存。
- 子代理：`spawn_subagent` 委派、子代理 `while (!settled)` 循环与轮次上限先例（grep：`subagent`）；子代理 token 已计入任务用量口径。
- 用户交互：interaction controller 的 waiting 回调（审批请求 / 问答），`cancelInteractions`（grep：`interaction`）。
- provider 层：OpenAI 兼容协议 streamText（grep：`streamText`、provider）——完成判定的模型调用从这里走。

## desktop（Electron 宿主：goal 编排器落位层）

- 输入队列：`input-queue` 的 `pump`（发一条→等回合结束→发下一条）+ `onIdle` 触发消费（grep：`pump`、`onIdle`）——**goal 编排器（idle 边界续跑）的落位先例**：跨回合编排住 desktop，互锁点就在 pump 的守卫条件。
- 任务排队：`task-queue` 全局 FIFO + 任务并发上限（1-8 默认 3）（grep：`task-queue`）。goal 激活任务占席照旧，无特判。
- 运行任务表：`live-tasks`（事件放行口径，grep：`live-tasks`）。
- 类型化 IPC：shared/ipc + task-ipc（`tasks.start` / `tasks.send` / `tasks:interrupt` 等，grep：`tasks:interrupt`）；中断注册 `interrupt-registry`（Stop=暂停 的接线点）。
- 重启恢复链路：残留态重置 + 冷启动自动恢复打开任务（`openTask` 的 `countAsViewed` 先例，720949b；grep：`countAsViewed`）——goal「重启恢复为暂停态」挂进同一条恢复链路。
- 子代理全程落库先例：ADR 0021（subagents 目录）——goal 状态与逐轮验证记录的持久化同构参考。
- 本地命令反馈：斜杠命令的即时提示通道（toast / 驻留消息流，GLOSSARY「本地命令反馈」词条）——`/goal` 成功/失败反馈与「/compact 请先暂停」提示走这里。

## ui（React + Tailwind，全中文界面）

- WorkspacePage：`send()` / `stop()`（`tasks.interrupt`）/ `selectApprovalMode` / `openTask`；主区自上而下 MessageStream → ProcessPillsBar →（自动批准提示卡）→ InteractionPanel / MessageComposer——**目标进度行的挂载位在 ProcessPillsBar 与输入区之间**。
- 标记行先例：`PlanMarkerRow`（update_plan 单行极简标记行）——goal 判定标记行（第 N 次迭代·结论）同族形态。
- 过程胶囊条：`ProcessPillsBar`（ADR 0034）——**不动**，不加第四胶囊。
- 斜杠命令解析先例：`/new` `/compact` `/model` `/status` `/rename` `/archive`（grep：slash 命令解析处）。
- e2e testid 惯例：`data-testid`（`process-pill-popover-*-state` 先例）。

## e2e 纪律（AGENTS.md，勿踩）

- 检查命令不接 `| tail` 类管道（吞退出码假绿）；desktop/ui 测试加载 agent-core **构建产物 dist**——agent-core 源码改动后未重建会报 not a function 假红。
- 开发目录模式 e2e 加载 desktop 自身 `dist/main.cjs`，主进程源码改动后未重建会**无报错验证旧代码**（launchTarget 有 mtime 新鲜度检查）。
- 改 e2e 交互面（进度行/标记行等场景点得到的 UI）合入前实跑相关场景——单测全绿不代表 e2e 可用（335acb1 教训）。
- stub/fake 机制先例：terminal fake 模式（`terminal-rail-switch` 场景、`useTerminalSessions` fake）；强杀重启场景先例：subagent-interrupted（720949b 工单 05）。

## 文档与领域语言

- GLOSSARY：「目标（Goal）」「目标模式（Goal Mode）」「完成判定（Goal Verification）」三词条已落（与「工作台目标（Workbench Target）」撞词靠全称区分）。
- ADR 0035（goal-mode）已落，`pnpm check:adr` 通过；实现与用户文案一律用 GLOSSARY 词汇。
- README 功能清单提及审批模式处（README 特性列表），收口票补 goal 模式条目。
