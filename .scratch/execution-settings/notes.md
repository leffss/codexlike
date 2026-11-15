# 执行设置：探索事实沉淀

多票实现的共享探索事实（各实现票开工前先读本文件与 spec.md，避免重复探索）。

## 现有设置体系（可复制的三条 resolver 链路）

- 存储形态：自研 JSON 读写（通用工具在 `packages/desktop/src/storage/json-file.ts`），每设置一份文件落 `~/.codexlike/`（`CODEXLIKE_HOME` 可隔离）；损坏按 fallback 处理。任务数据用 SQLite，与设置无关。
- 链路模式：渲染层设置页 → IPC get/set（频道定义在 `packages/desktop/src/shared/ipc.ts`，preload 暴露在 `packages/desktop/src/preload.ts`）→ 主进程 handler + 内存缓存 → 以逐次解析的取值函数注入 agent-core。
- 先例链路 1（子代理并发，最直接的参照）：`subagent-settings-store.ts`（min/max 校验 1–8、默认 3）→ `main.ts` 的 `createTaskManager({ subagents: { settings: () => ..., resolveProfile } })` → `agent-core/src/task/subagent.ts` 的 `SubagentsConfig.settings()`，消费点在并发处逐次读。
- 先例链路 2（终端 shell）：`terminal-settings-store.ts`（设置项 > `CODEXLIKE_SHELL` env > git-bash 三级合并）→ `createBuiltinTools({ shell: () => ... })` → 工具内部 options 消费（`tools/terminal.ts` 的 options 缺省值模式）。
- 先例链路 3（搜索源）：`refreshSearchSource` → `webSearch: { searchSource: () => ... }`。
- 设置页分区结构：`packages/ui/src/pages/SettingsPage.tsx`（Provider / 外观 / 终端 / 子代理 / 搜索 / MCP 六分区），MCP 独立组件。

## 六个参数的现状（定义、消费、测试）

| 参数 | 定义位置 | 消费点 | 相关测试 |
|---|---|---|---|
| 主任务工具轮次上限 200 | `agent-core/src/task/agent-task.ts:184`（模块级 const，未导出） | 主循环超限即停止执行剩余工具调用（:652）+ 落库中文 error 提示（:660，固定数字文案） | `tests/task/agent-task-tools.test.ts:387,414`（满 200 轮 + 提示文案，行为级断言） |
| 子代理工具轮次上限 200 | `agent-core/src/task/subagent.ts:63`（未导出） | 超限置 capped（:436）+ 报告末尾截断标记（:521，固定数字文案） | `tests/task/subagents.test.ts:639,656,677` |
| 压缩保留轮数 3 | `agent-task.ts:233`（已导出 `COMPACT_KEEP_ROUNDS`） | /compact 后保留最近几轮原始对话 | — |
| 上下文告警阈值 0.8 | `agent-core/src/context/context-warning.ts:12`（`CONTEXT_WARNING_THRESHOLD_RATIO`）；缺省窗口 128k 在 :9 | 上下文用量告警判断 | — |
| 命令超时 30s | `agent-core/src/tools/terminal.ts:177-179`（DEFAULT_TIMEOUT_MS 30s / 最大 120s / 输出截断 30000 字符，已是 options 形态，desktop 未覆写） | 终端工具执行 | — |
| （同上）最大 120s | 同上 | 同上 | — |

- 注入缝隙现状：`CreateAgentTaskOptions`（`agent-task.ts:82-125`）与 `SubagentsConfig`（`subagent.ts:76-95`）均无上限字段，需按 resolver 范式扩展。
- pnpm workspace 链接：desktop/ui 的 node_modules 里是同一份 agent-core 源码，无需单独改。

## 回归与术语注意

- 现有测试是行为级断言且依赖 200 数字：默认值不变是硬约束，改默认值必须同步测试（本 spec 不改默认值）。
- GLOSSARY「轮次（Turn）」= 呈现层分组；「工具轮次（Tool Round）」= 循环往返。设置文案与测试描述用「工具轮次」，不用「回合」。
- 子代理撞限语义：截断标记让主模型知道未完成（不伪造完成）；主任务撞限：error 落库、用户可见、不进模型上下文、可发消息继续（ADR 0016）。
- 撞限文案动态化仅替换固定数字，文本结构不变。
