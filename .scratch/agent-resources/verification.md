# 规范与技能验证记录

## 已完成

- 资源接口、每轮会话、子代理与输入框按公开接口进行分片红→绿测试。
- `pnpm test:e2e:commands`：通过。验证真实请求中的全局/项目 AGENTS、@引用、/status、/rename、/model、/new、/archive 及恢复。
- `pnpm test:e2e:skills`：通过。真实 Electron + 隔离目录 + 本地 mock HTTP：双目录覆盖、索引不携带未加载正文、显式多技能、下一轮清理、自主加载及附属资源、子代理隔离、文件更新、未知技能阻止发送、重启不激活。
- 在现有构建上追加 Tab/鼠标选择不发送、来源展示断言，`pnpm --filter @codexlike/desktop run test:e2e:skills`：通过。
- 宿主 IPC/status 定向测试：运行快照不会被磁盘预览替换，元数据接口不返回正文；3 + 8 项通过。
- session/MCP 回归：14 文件、127 项通过；包括审批、中断、动态 MCP 工具与技能共存。
- 稳定版本 `pnpm typecheck && pnpm test && pnpm check:adr`：退出码 0；Core 43 文件/342 项，Desktop 15 文件/76 项，UI 11 文件/70 项，共 488 项。ADR 当前 7 篇编号无重复，引用均有落盘。
- 新资源上下文专项：4 文件/35 项通过，包含真实 Windows junction 越界/改向/循环、预算、变更检测与事务加载。

- 稳定版本 `pnpm test:e2e:all`：退出码 0，完整 14 条脚本通过，含 smoke/acceptance/commands/browser/approvals/changes/interrupt/compact/worktree/mcp/subagents/projects/theme/skills。

## 最终复验

- 审查修复后 `pnpm typecheck && pnpm test && pnpm check:adr` 退出码 0：Core 350、Desktop 76、UI 72，共 **498 项**。
- 最终构建后 skills + commands 两个 Electron 专项退出码 0；新增真实验收包括子代理加载后停在审批时面板自动更新、`/status` 最近轮摘要、单独/多行缩进代码变量不触发技能、Enter/Tab/鼠标仅插入不发送。
- Standards 与 Spec 轴均已定点独立复核，剩余 findings 均为 0。
- 完整 14 条 Electron E2E 在审查修复前稳定版全部通过；审查修复后重跑完整单测与受影响的 skills/commands 两专项，未再次运行整套 14 条脚本。

## 审查修复

- Standards：E2E 按钮改为 scoped locator；发现与引用解析复用 `isSkillName`，禁止无字母金额式名称形成不可调用候选。
- Spec：frontmatter 读取在结束分隔行停止（LF/CRLF 真实读取量回归）；缩进代码中的 shell 变量不触发技能，发送链路保留语义缩进；`/status` 增加独立 last 摘要且不计入当前用量；子代理工具结果触发当前资源面板刷新。
- Spec 定点独立复核：以上 4 项全部关闭，剩余 0。

## 中途失败与说明

- 首次全仓检查及全套 E2E 在编译阶段遇到实现收尾的中间态：`agents-md.ts:74 Cannot find name 'readFileSync'`，退出码 1，后续测试未执行；修复后稳定版本已重新通过。
- 新增审批中面板 E2E 的 `/执行者/` 定位器同时命中标题和记录，strict-mode 报错；收紧为 `/^执行者 /` 后真实验收通过。
- 旧有 @引用文件 symlink 测试因 Windows `EPERM` 跳过实际建链分支；本次资源测试使用 junction，真实逃逸/重定向检查执行通过。
- 新增未知技能 E2E 会刻意触发 `技能不可用：does-not-exist` 主进程日志；用请求数量不增加和 UI 错误反馈确认拒绝行为，不是通过结果中被忽略的异常。
- 本记录对应功能提交前的验收；用户后续要求将本功能合并到本地 main，不推送远端。本会话前已有主题/侧栏等修改，验证运行在合并后的工作树上；不将这些改动归为本功能。
