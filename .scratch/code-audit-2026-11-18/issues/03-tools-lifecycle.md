# 03：工具文件正确性、预算与连接生命周期

Status: done
Integration: 已通过最终三包build/全仓test，悬空链接补漏经原reviewer确认关闭；详见../INTEGRATION.md
Blocked by: none

先读 ../spec.md、../notes.md；依据 ../REPORT.md F08/F13/F14/F15/F16。用户已批准测试接缝。

## 所有权

core/src/tools/{apply-patch,terminal,read-file}.ts及必要独立helper，core/src/mcp/manager.ts、browser/manager.ts，各自tests。不得改chromium.ts、task循环、desktop mentions。

## 验收

- [x] F08真实目标重复(含full-access符号链接身份/Windows别名)整批拒绝、零写。
- [x] F13 MCP共享pending连接/代次，关闭和断开不复活，真实fake stdio全回收。
- [x] F14同task共享pending context/page，失败/close/reset期间无泄漏，close后仍可重开(既有契约)。
- [x] F15仅cmd专用参数策略，带空格路径/程序与引号/元字符正确，Bash/PowerShell不变。
- [x] F16默认2000行、输出128KiB(含提示)、扫描8MiB、块64KiB，提前停/UTF8/abort/句柄finally，保留splitLines兼容出口。
- [x] 每项red→green，预算验收按真实读量，运行资源清理无残留。

## Comments

- resolvePath full-access只字面resolve，去重需要真实身份但不能放宽/改变权限。
- core测试直接exec vitest；不运行build/全套测试。
- read_file与mentions不跨包深导入，可复用既有算法模式，勿改public入口造成并行冲突。
- 不提交，完成报告READY_FOR_BUILD。
- 2026-11-18 实现者已冻结生产源码并向主代理发送可统一 build 通知。未运行 build/install/全套 test/stage/commit，未修改 chromium、主循环、desktop 或公共导出。
- 15:37 F08 复审漏项已补修并重新冻结，已发送 READY_FOR_REBUILD：仅 apply-patch.ts、apply-patch.test.ts 和本票发生补充修改；其它 03 生产文件保持冻结。
- read_file 达到范围即停，不再为了旧提示中的“文件共 N 行”扫描整个文件；提示改为实际显示范围和继续读取指引。splitLines 原实现及出口保留。扫描预算超限返回 isError=true；输出预算截断返回可用前缀并明确标记，提示和错误自身也计入 128 KiB。
- MCP 主动 disconnect/close 清空工具并失效旧工具代次；崩溃仍保留工具以惰性重连；显式 connect 可重新打开。browser close/closeTask 后可重新打开，reset/pageFor 共享创建中的页面。
- 旧 browser-manager.test.ts / browser-tools.test.ts 使用默认 installer，冷缓存会下载；本组未运行它们。新增 lifecycle 测试 mock Playwright 外部边界，installer.isReady=true、install 抛错，绝不启动真实浏览器。主代理已确认本机 Chromium 缓存存在，最终真实浏览器回归由主代理统一执行。

## Red → Green 证据（2026-11-18）

以下 `V` 为实际命令前缀 `pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/agent-core exec vitest run`。所有命令直接取退出码，无管道。

| 条目 | Red（退出码 1）                                                                                                                                                                                                                                                            | Green（退出码 0）                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F08  | `V tests/tools/apply-patch.test.ts -t '重复目标'`：1 fail，isError=false；随后 `-t 'full-access\|hard link\|Windows'`：4 fail，真实别名未拒绝                                                                                                                              | `V tests/tools/apply-patch.test.ts`：15/15 pass。真实 junction（不吞 EPERM）、hard link、未创建后缀、Windows 大小写/斜杠、Update/Delete/Add、其它文件零写                                                          |
| F13  | `V tests/mcp/mcp-manager.test.ts -t '崩溃后并发'`：1 fail，三个不同 PID；`-t '并发显式'`：1 fail，启动三个 PID；`-t '进行中生效\|缓存的工具'`：5 fail，迟到 connected/旧工具复活                                                                                           | `V tests/mcp/mcp-manager.test.ts`：22/22 pass。真实 SDK + stdio fixture，在 tools/list 门控期间 disconnect/close/remove，验证全部记录 PID 已退出及显式重开                                                         |
| F14  | `V tests/browser/browser-manager-lifecycle.test.ts` 首轮1 fail；`-t 'newPage\|外部关闭'`：2 fail；`-t '创建中\|launch 进行中'`：3 fail；`-t 'resetPage'`：2 fail                                                                                                           | 同文件 8/8 pass。同任务共享页面；newPage失败关闭context；外部关页复用context；创建/启动/重置期间关闭不复活且可重新打开                                                                                             |
| F15  | `V tests/tools/terminal.test.ts -t '真实 Windows cmd'`：2 fail，带空格文件/可执行程序及引号命令 isError=true                                                                                                                                                               | `V tests/tools/terminal.test.ts`：17/17 pass，包含真实 cmd 两例、Git Bash、PowerShell、超时、中断。cmd 专用外层引号 + windowsVerbatimArguments；未改变其它 shell 参数策略                                          |
| F16  | `V tests/tools/read-file-budget.test.ts`：单行输出 2,100,003 > 131,072；`-t '首行\|远处 offset'`：2 fail（首行实际读取 2,400,006 > 65,536、扫描无界）；`-t 'abort\|读取错误'`：2 fail（忽略 abort）；`-t '零 limit\|失败提示'`：2 fail（零limit读取、错误输出150,050字节） | `V tests/tools/read-file-budget.test.ts tests/tools/read-write-file.test.ts`：28/28 pass。默认2000行、实际64KiB块/8MiB扫描、最终128KiB含提示/错误、长行/UTF8跨块/CRLF/BOM/空行/末行、abort前/中及IO错误finally清理 |

### F08 复审漏项：悬空符号链接（15:37 补修）

- 当前源码复核：full-access 中 `realpathSync(alias.txt)` 对悬空 file symlink 返回 ENOENT，旧逻辑按字面祖先拼回，将 `alias.txt` 和不存在的 `real.txt` 算成不同目标。真实 dangling junction 的后缀路径也可能通过预检，至写入阶段才失败而留下前面的文件。
- 最小修复：仅在 `targetIdentity` 的 ENOENT 分支用 `lstatSync(anchor, { throwIfNoEntry: false })` 识别链接；如是无法解析的符号链接则立即拒绝整批，不尝试解析/支持悬空目标。普通缺失路径及可达链接保留既有语义。
- **Red**：15:36:57，`V tests/tools/apply-patch.test.ts -t '悬空'`，退出码 1，2 fail / 15 filter-skipped。file-symlink FS 边界夹具返回成功，`real.txt` 被创建且 `keep.txt` 被修改；真实 dangling junction 的路径返回 ENOENT 之前已写 `untouched.txt`，零写断言失败。
- **Green**：15:37:26，`V tests/tools/apply-patch.test.ts`，退出码 0，**17/17 pass，无跳过**。两种悬空链接均在任何写入前拒绝；将真实 junction 的目标目录建好后再次经 Tool.execute 新建文件成功，验证可达链接仍可用。临时目录由 afterEach 回收。
- **测试限制**：本机不申请 file symlink 创建权限，file-symlink 用例是 `node:fs` 外部边界夹具（realpath/exists/write 跟随同一真实临时目标，lstat 元数据来自真实 dangling junction）。不将其声称为真实 Windows file-symlink 实跑；另一个用例完整使用真实 junction，未吞 EPERM，测试未跳过。
- 此轮只运行补丁定向 Vitest、两文件 Prettier 和 diff --check；未 build/全仓检查。冻结后已立即通知主代理重 build Core。

### 最终定向汇总（补修前）

```bash
pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/agent-core exec vitest run tests/tools/apply-patch.test.ts tests/tools/read-write-file.test.ts tests/tools/read-file-budget.test.ts tests/tools/terminal.test.ts tests/mcp/mcp-manager.test.ts tests/browser/browser-manager-lifecycle.test.ts
```

- 14:54:23 开始，退出码 **0**：**6 files / 90 tests passed**，无跳过。
- 前一轮汇总 85 pass / 5 fail，均为新增 terminal 测试 afterEach 同步删除临时 cwd 时 EPERM（命令断言已通过，异步 taskkill 尚未释放目录）；改测试清理为异步 rm 重试后完整重跑绿。该轮五个临时目录已按精确目录逐个清理，未按进程名称批量终止。
- stdio 夹具 PID 记录仅存本测试临时目录；红测清理只终止该目录记录且仍存活的 PID，轮询确认已退出再移除目录。绿测在清理兜底之前断言全部 PID 已回收。
- 定向 Prettier 已执行；定向 ESLint 退出码 0、0 error；6 个 `.test.ts` 因仓库 ESLint 范围未包含测试而给 ignored warning，不宣称测试 lint 已覆盖。
- 全仓 typecheck/build/test、真实浏览器集成和 E2E 本组未跑，留主代理统一验证。

## 本会话文件清单

工作区根绝对路径 `C:/Users/leffss/Desktop/ai-agent`；仅下列 12 个代码/测试文件及本票：

1. `packages/agent-core/src/tools/apply-patch.ts`
2. `packages/agent-core/src/tools/read-file.ts`
3. `packages/agent-core/src/tools/terminal.ts`
4. `packages/agent-core/src/mcp/manager.ts`
5. `packages/agent-core/src/browser/manager.ts`
6. `packages/agent-core/tests/tools/apply-patch.test.ts`
7. `packages/agent-core/tests/tools/read-write-file.test.ts`
8. `packages/agent-core/tests/tools/read-file-budget.test.ts`（新增，实际 IO 计量边界）
9. `packages/agent-core/tests/tools/terminal.test.ts`
10. `packages/agent-core/tests/mcp/mcp-manager.test.ts`
11. `packages/agent-core/tests/mcp/fixtures/fake-mcp-server.mjs`
12. `packages/agent-core/tests/browser/browser-manager-lifecycle.test.ts`（新增，Playwright 边界 fake）
13. `.scratch/code-audit-2026-11-18/issues/03-tools-lifecycle.md`
