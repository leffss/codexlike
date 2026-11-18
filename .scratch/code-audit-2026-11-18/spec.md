# Spec：全量审计问题修复

Status: done

原 F01–F26 及 C01/C02 修复核销见 FIXES.md；测试中新发现的 Electron 首次密钥耐久性问题单独列于 issues/08-electron-first-key-durability.md，明确未修，不包含在本规格完成结论中。

## 目标与基线

用户要求修复 `REPORT.md` 全部问题；批准实施计划覆盖 F01–F26，并核验 C01/C02 后按证据修复。基线 `cbc87fff9f879e27e01b5fa4c5c8cb2158cc2cd5`，修复分支 `fix/code-audit-2026-11-18`。原始报告为问题/复现证据权威，不覆写它。

## 不变量

- 不修改用户原有 LICENSE、.zcode/plans、.zcode/session-to-task-notes；不提交、不推送。
- 不读取真实 .codexlike 数据或模型凭据；不发外部模型请求、不下载 Chromium。
- 依既有权限、工作区、主/子代理、任务与项目语义修复，不做额外架构重写。
- 无需数据库迁移；旧历史可读。C02 如确认，新增调用区分宿主 ID 与 provider 协议 ID。
- E2E 使用临时业务目录、用户数据和本地假模型。允许临时 Electron 窗口，不执行真实鼠标拖动、系统剪贴板修改或真实外部程序。

## 行为验收

逐项完整原因和定位见 REPORT.md。本规格规定修复后的行为：

- F01：停止排队准备中的任务后，不发送模型请求；首条历史至多一次；后续 FIFO 正常。
- F02/F03：ESM/CJS Chromium CLI 均可定位；dev/production 均 external Playwright，真实构建产物入口可加载；冷缓存到达合法 spawn 参数而非 import.meta 错误。
- F04：纯计时与无关父更新不重新解析未变历史；折叠内容按需解析；流式渲染短节流但终态立即完整，状态事件不节流。
- F05/F06/F07：解冻补跑队首；已接受 queued start 的 requestId 幂等；Compact 满员明确拒绝，不越过全局并发上限。
- F08：同一补丁重复真实目标整批拒绝且零修改，包含别名。
- F09：从队列编辑离开至新建/其他任务/卸载均不丢原草稿。
- F10/F11：JSON 部分写/替换失败保留旧配置；Profile 并发操作不覆盖已成功删除或新增。
- F12：退出确认/错误必须在可见聚焦窗口，不改变关闭到托盘的正常行为。
- F13/F14：每 server/任务共享创建中 Promise；断开/关闭让迟到连接或页面被回收，不能复活或丢失引用。
- F15：cmd 带空格/引号参数正确，Bash/PowerShell 不回归。
- F16：read_file 默认 2000 行、128 KiB 最终输出、8 MiB 单次扫描、64 KiB 分块；达到请求范围即停；超预算给明确截断/错误并保持 UTF-8 边界。
- F17：mentions 在读取时限制既有 128 KiB，不全量读大文件。
- F18：每个 provider tool call 恰好一个 tool result（含 invalid/未知工具），主/子路径一致。
- F19：已结算 interaction 的后置状态/通知失败不使 waiter 失联；可以终止并开始新发送。
- F20：子代理每轮成功/中断/流错误都恰好一次保存已输出正文与思考。
- F21：编辑 Profile 其它字段保留上下文窗口，主动清空确实清空。
- F22：设置加载失败可见错误与重试，不自动用默认值覆写配置。
- F23：同路径 diff 在任务结束/刷新/提交后能读取新版本。
- F24/F25：compact 后仍可检视未匹配子代理；interrupted 不被算运行中，不抑制主正文操作。
- F26：子代理工具完整参数/结果可按需展开，长输出默认收起。
- C01：队列操作迟到回包/错误不更新已经切换的任务；用 taskId/代次/sequence 保护。
- C02：先用公开 Task/持久化验证 ID 重用；确认后新调用使用独立宿主 ID，模型协议配对保留原 ID，不迁移历史。

## 已批准测试接缝

- 公开任务 IPC + 临时真 SQLite + 本地 SSE：调度/幂等/停止/恢复。
- AgentTask/interaction API + SDK/fetch 边界：协议、结算、部分输出持久化、ID。
- Tool.execute/manager API + 临时文件/stdio：补丁、读取预算、生命周期和真实 Windows cmd。
- Store API + 文件系统/加密故障边界：原子写和并发。
- 真实 React 组件 + 现有 jsdom/testing-library：导航、设置、diff、恢复和解析工作量。
- 实际构建配置/产物：入口加载及冷缓存安装参数，禁止真实下载。

每个实现组按 red→green 垂直切片；可控时钟/外部 IO 替身只在边界，不测试私有方法。性能按可观察工作量/预算验收，墙钟数字仅用于对照。

## 分工与集成

见 notes.md 及 issues/01–07。每个实现者仅修改自身文件，主代理独占 main.ts、e2e 公共入口和集成接线。跨组要求写到下游票 Comments，不直接修改他人文件。不得并发构建 dist；Core 容器先完成后主代理统一 build，再允许 desktop/UI 跑 exec vitest。

## 最终验证

定向红绿记录 → 核心 build → 全仓 typecheck/lint/check:adr/check:e2e-locators/test/build → 相关隔离 E2E → 独立 Standards/Spec 复审 → 核销清单。检查命令直接取退出码，不接 tail 管道。任何失败/跳过如实记录。
