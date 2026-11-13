# 02: agent-core 领域改名与新库文件（expand）

术语依据换词后的 `GLOSSARY.md`；决策见票 01 产出的 ADR。

**What to build:** agent-core 包内「会话」领域模型整体更名为「任务」：领域模块目录与文件名、公共类型与接口、事件类型、SQLite 表结构与库文件名、磁盘目录约定全部换为 task 系；对外公共导出暂留旧名别名，让 desktop 的既有引用不破。旧库文件不读不删，从零建新库（已有会话数据弃置，用户已确认）。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 会话领域模块目录（agent-core 内 session 系目录）及 14 个模块文件更名为 task 系
- [ ] 公共类型与接口全改：`SessionRecord`→`TaskRecord`、`SessionManager`→`TaskManager`、`SessionEvent`→`TaskEvent`、`SessionStatus` 等；子代理事件载荷字段 `task` 与 `spawn_subagent` 的 `task` 参数**不动**
- [ ] SCHEMA 全改：`sessions` 表→`tasks`，各表 `session_id` 外键列同步更名；增量迁移逻辑按新表名重写
- [ ] 新库文件名启用（不复用旧库文件名）；检测到旧库文件存在时不读、不删、不迁移，直接使用新库
- [ ] 磁盘 `sessions/<id>/` 截图子目录约定同步换为 task 系；worktrees 目录用 id 本身做键，不动
- [ ] 公共导出（包入口的 index/node 出口）暂留旧名 re-export 别名，desktop 现有 import 不改也能通过 typecheck
- [ ] agent-core 全部测试改绿（含 sqlite-store 对 schema/迁移的断言、resume 等价、子代理、思考档位等 15 个会话系测试文件）；architecture 守卫通过
