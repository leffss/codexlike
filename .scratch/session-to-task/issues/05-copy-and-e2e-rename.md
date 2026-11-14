# 05: 用户文案与 e2e 联动全量绿

术语依据换词后的 `GLOSSARY.md`；上游票 04 已就位（UI 结构已切新名，文案/testid 仍是旧值）。

**What to build:** 所有用户可见的「会话」文案换为「任务」，data-testid 值与 e2e 断言/场景表联动更名，全量 e2e 链跑绿——用户在界面上看到的最后一个「会话」字样消失。

**Blocked by:** 04

**Status:** done

- [x] UI 用户可见文案全换：侧栏（新建/暂无/置顶/aria 标签）、搜索弹层、右键菜单、工作台页（新建入口、未选择态等）、队列条、自动批准提示等
- [x] agent-core 斜杠命令描述换词（`/new` `/rename` `/archive` `/status` 的中文说明）
- [x] 20 个 session 系 data-testid 值换为 task 系；`check:e2e-locators` 联动通过
- [x] 41 个 e2e 场景中依赖中文文案断言与 testid 的全部联动改；场景表（若登记）同步
- [x] 独立任务工作区磁盘目录 sessions/<id>/workspace 换为 task 系路径（自票 03 移交；e2e projects-sidebar/packaged 的断言耦合联动改）
- [x] 全量 e2e 链按根 package.json 的全量链跑绿（直接退出码，不接管道）
- [x] 全仓用户可见层面不再出现「会话」字样：grep 验证，代码注释、避免词列表与 ADR 除外

## Comments

**实现记录（2026-11-14，分支 `session-to-task-05`，基点 af37ba8）：**

- 提交序列（每提交点 pre-commit 全链：lint / check:adr / check:e2e-locators / lint-staged / typecheck / test）：
  - `0f8892b` agent-core 斜杠命令与运行时/prompt 文案换词（/new /rename /archive /status 描述、manager/worktree-service/agent-task 异常文案、子代理 system prompt「主会话」→「主任务」+ 委派说明措辞、compact/提交消息/browser 工具描述、stored-message 引导语；tests 注释与 mock 联动；docs/testing 措辞同步）
  - `36819b5` UI 用户文案换词 + 22 个 session 系 testid 与 `data-session-id`/`data-session-select` DOM 属性更名 task 系（20 静态 + `session-item`/`archived-session-item` 动态 2 个；aria id `session-approval-warning`→`task-approval-warning`）；ui 单测断言联动
  - `f05ee3a` 独立任务专用目录 `<dataDir>/sessions/<id>/workspace` → `tasks/<id>/workspace`（task-ipc 分配与失败回滚 rmdir；workbench-ipc 单测断言联动）
  - `8d44861` e2e 全量联动：testid 引用、中文文案断言（含 mock 场景文本自洽）、projects-sidebar/packaged 目录断言、helpers（sessionMenu→taskMenu、projectAction/prepareDraft 入口）、README 场景表描述（文件名不动，归票 06）
  - 既有失败与回归修复（见下）：`0a3bb45` `d152142` `b883ce3` `7a1ea21` `54d6f43` `1aea878`

- **本票引入回归 2 起（均已修复）**：kebab 批量更名漏掉驼峰形态 `dataset.sessionId` 3 处（TaskSidebar 菜单焦点恢复 2、MembershipDialogs 目标定位 1，致 Escape 焦点不归位——`d152142`）；批量文件发现步骤漏掉 window-controls/external-links 两文件的 `new-session` testid 4 处（`54d6f43`）。

- **基线（af37ba8）即失败的既有问题 4 起（挂临时 worktree 逐一验证非本票回归后修复）**：worktree 布局断言未随 7efd7f4「输入卡片左右外扩 8px」同步（`0a3bb45`）；sidebar-archive 两处布局断言未随票 04 97851e7「无竖线缩进导轨 ml-7」同步（`b883ce3`）；message-order 剪贴板断言未兼容 Windows Chromium \n→\r\n 规范化（`7a1ea21`）；packaged 落盘断言未随 ADR 0014 新库文件名 task-workbench.db 同步（`1aea878`，票 04 遗留）。

- **验证（直接退出码）**：三包 vitest（agent-core 434、desktop 265、ui 280）+ lint + typecheck + build + check:adr + check:e2e-locators 全绿；`pnpm test:e2e:all`（build + 33 场景脚本串联）退出码 0，补充链 input-queue 五件套 + packaged（先 pnpm dist）各退出码 0——41 个场景文件全部绿。

- **grep 验证**：`packages/{agent-core,desktop,ui}/src` 无「会话」残留（desktop 仅剩 ipc.ts 兼容层「会话→任务改名」历史注释，票面豁免）；ui/agent-core/desktop 测试与 e2e 无「会话」；docs/adr 与 GLOSSARY 避免词列表豁免；docs/research 为 ZCode 上游调研笔记（外部事实，不改）。

**归票 06 残留确认清单（session 系，非用户可见层面）：**

- e2e 兼容层调用：`window.codexlike.sessions.*`（helpers/exit-recovery/interactions/persistent-workbench/launch-state-target/compact/input-queue-restart/sidebar-archive 等，走 preload 旧命名空间，功能正常）
- e2e 场景文件名：`session-search.mjs`、`live-sessions.mjs` + 根 package.json 对应 test script 名（本票明确不动）
- e2e 局部标识符：`currentSessionId`/`firstActiveSessionId`/`assertIdleNewSessionEntry`/`sessionIdByTitle`/`assertCurrentSession`/`sessionA` 等局部函数与变量名
- 深层 record 字段 `sessionId`（agent-core `InteractionRequest`/`ToolCallRecord` 等 + ui 消费侧 `call.sessionId`、测试 fixture）
- 交互 scope 数据值 `scope: "session"`（InteractionRecord，DB 持久化耦合）
- 行为值：branch-name 空 slug 回退 `codexlike/session`（防御分支，用户可见分支名）；DB 库文件名 `task-workbench.db` 已定稿但 packaged 曾断言的旧名 `session-workbench.db` 已在本票修复断言侧
- 兼容层本体：channel 双注册、preload 旧命名空间、ipc.ts 类型反向别名（票 06 计划删除）
