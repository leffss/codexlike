---
status: accepted
---

# 「会话」全面更名为「任务」

对标 Codex 的 Tasks：这个实体承载的是用户交给 agent 的一项工作及其完整执行过程，「会话」暗示一段聊天记录，既低估了它的目标属性，也与同类产品的通用叫法不一致。自本次重构起，原「会话（Session）」在领域语言中正式更名为「任务（Task）」：GLOSSARY 已完成换词，票 02–06 的实现与验收一律以换词后的词汇为准。

## 范围：全面改名，不留双轨

- 用户可见文案：界面标题、按钮、提示、斜杠命令说明等全部「会话」→「任务」。
- 代码标识符：类型（`SessionRecord` 等）、模块（`session/*` 等）、组件（`SessionSidebar` 等）、`data-testid`（`new-session` 等）一并换名，全仓 `session` 标识符近两千处。
- IPC channel：`sessions:*` 命名空间与 `session:events` 事件流改为 `tasks:*` / `task:events`，`desktop/src/shared/ipc.ts` 作为类型与 channel 的单一来源同步换名。
- DB 表与磁盘目录：`sessions` 表、各表 `session_id` 外键列、`~/.codexlike/sessions/` 截图目录等随标识符一并换名。

拒绝「外改内不改」（用户文案换词、代码保留 session）：那意味着长期维护两套词汇的心智翻译，每个新文件都要做一次术语对齐，且无法靠 grep 保证一致。

## 数据库：弃旧库，不迁移

沿用 ADR 0010 弃用 `codexlike.db` 的惯例：本次改名启用新的库文件名，旧 `session-workbench.db` 不读取、不迁移、不删除，已有会话数据随旧库文件弃置。表与列整体换名后 schema 等于重建，为一次性改名维护 sessions→tasks 迁移脚本不值得；不删旧库文件，保留用户自行回退版本找回数据的可能。

## 撞名处理：subagent 的 `task` 保留原名

`spawn_subagent` 工具的 `task` 参数、子代理事件载荷的 `task` 字段（含交互来源标签）**保留原名**，不改成 `assignment` 之类的替代词：它是主任务交给子代理的委派说明，属于内部协议标识、不出现在用户可见文案中，改名的沟通收益为零，而工具参数与事件协议的改动成本是实打实的。配套约定：

- 这些 `task` 的中文表述一律用「委派说明」，不译作「子代理任务」，避免与作为原「会话」正式名的「任务」一词两义。
- 「子任务」在 GLOSSARY 中仍为避免词，理由补充为：「任务」已是原「会话」的正式名，子代理侧的 `task` 用「委派说明」指称。

## 后果

- 词汇基线由本 ADR 与换词后的 GLOSSARY 共同构成；票 02–06 逐层落地（agent-core、desktop、UI、文案联动、终验），E2E 断言的中文文案与 `data-testid` 随票同批更新。
- 架构决策不变：Agent Core 与 Electron 解耦（ADR 0002）、node:sqlite（ADR 0003）继续有效，本次只换词汇，不换结构。
