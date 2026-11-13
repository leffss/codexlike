# 01: 词汇基线：GLOSSARY 换词与改名 ADR

术语依据 `GLOSSARY.md`；本票产出后续 02–06 票的词汇与决策依据。

**What to build:** 把「会话（Session）」正式更名为「任务（Task）」写进领域语言：GLOSSARY 主词条与全部派生词条换词、Avoid 词反转；新 ADR 记录本次改名的三项决策（全面改名含 DB、弃旧库不迁移、子代理 task 撞名保留）。后续代码票一律以换词后的 GLOSSARY 为准。

**Blocked by:** None (can start immediately)

**Status:** completed

- [x] GLOSSARY「会话（Session）」词条更名为「任务（Task）」，定义内容随词更新；_Avoid_ 反转：`task` 移出，`session`、`会话`、chat、conversation 进入
- [x] 派生词条同步换词：独立会话→独立任务、会话自动批准→任务自动批准；用户交互、执行审批、审批模式、输入队列、排队消息、队列暂停、消息流、工作台目标、启动现场、托管 Worktree、斜杠命令、思考档位、Compact 等词条正文中的「会话」全部改为「任务」，对应英文 Session→Task
- [x] 子代理词条：记录 `spawn_subagent` 的 `task` 参数与子代理事件的 `task` 字段**保留原名**（内部委派说明，用户不可见），中文表述改用「委派说明」避开一词两义；_Avoid_「子任务」保留并补充理由（「任务」已是会话的正式名）
- [x] 新 ADR：动机（对标 Codex 的 Tasks）、范围（文案/标识符/IPC/DB 全改）、DB 弃旧库不迁移（沿 ADR 0010 惯例）、撞名处理三项决策与理由
- [x] `check:adr` 通过
