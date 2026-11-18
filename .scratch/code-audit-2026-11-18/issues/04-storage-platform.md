# 04：配置原子性、托盘退出与引用读取预算

Status: done
Integration: READY_FOR_BUILD
Blocked by: none

先读 ../spec.md、../notes.md；依据 ../REPORT.md F10/F11/F12/F17。用户已批准测试接缝。

## 所有权

desktop/storage/json-file.ts、profiles/profile-store.ts、lifecycle/exit-ipc.ts、tasks/mentions.ts及对应tests。不要改main.ts、task-ipc、task-queue、core或UI。

## 验收

- [x] F10部分写/替换失败保旧JSON，同目录临时文件安全清理；Windows可替换已有目标；不得先删旧目标。真实临时文件覆盖部分写 ENOSPC、替换 EPERM、重试成功和临时路径 EEXIST；Profile/Search/MCP 重开公开读接口验证旧值。损坏文件读取仍抛错，不新增默认覆盖行为。
- [x] F11异步加密后提交重读/串行化，无已删除配置复活、并发create/update丢数据。create/update 在加密后的无 await 同步段重读；覆盖 update/remove、目标自身删除、create/create、不同 Profile update/update、create 与 remove/update、update 与 create。
- [x] F12确认/错误需要显示恢复聚焦隐藏窗口，保持托盘正常行为。confirming/error 调用宿主 showMainWindow，真实退出+托盘控制器覆盖隐藏、最小化、静默启动最大化恢复、取消再驻留、保存/收尾错误及无工作静默退出；Electron 窗口为系统边界替身。
- [x] F17实际读取受128KiB+必要探测约束，UTF8边界、路径限制不变。句柄层最多 131073 字节、Buffer 同预算；覆盖空文件、恰好预算、2/3/4 字节字符、合法替换符、短读、异常关闭句柄、绝对路径/目录/.. 与真实 junction 越界。
- [x] 故障注入及真实临时文件red→green，通过store公开读接口验旧值。详见 Comments；未将环境权限跳过伪报通过。

## Comments

- F12 接线要求（主代理独占 main）：`registerApplicationExit` 已新增可选 `showMainWindow(): void`；在 `main.ts` 的 `registerApplicationExit({ ... })`、`minimizeToTray` 同级加入 `showMainWindow: () => trayResidency?.showMainWindow(),`。确认及错误态使用此回调；复用托盘的 restore/show/focus 和静默启动 pendingMaximize，不能另写仅 show 的绕路。04 不修改 main。
- 主代理已确认完成上述 main 接线，并在 exit-recovery E2E 去掉退出前主动 show/focus，加入隐藏后直接 quit 的 visible/notMinimized/focused 断言；整体构建及 E2E 验证仍待主代理执行。
- exec vitest定向，不自动build；主代理统一重建Core。
- 不提交；完成报告READY_FOR_BUILD。

### 实现与红绿记录（2026-11-18）

接缝沿用已批准的 Store 公开 API + 文件系统/加密边界、真实临时文件、退出模块系统边界；未询问/重新规划。

下列命令前缀均为 `pnpm --dir 'C:/Users/leffss/Desktop/ai-agent/packages/desktop' exec vitest run`，直接取退出码，无 build/test script 或管道。

| 切片          | RED（退出 1）                                                                                                                                              | GREEN（退出 0）                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| F10 部分写    | `tests/storage/json-file.test.ts`：3 failed / 4 passed，Profile/Search/MCP 在真实写入 16 字节后 ENOSPC，重读抛 `SyntaxError: Unexpected end of JSON input` | 原子写后 7/7；补替换/清理/损坏读取保护后 12/12                                     |
| F11 更新/删除 | `tests/profiles/profile-store.test.ts`：1 failed / 7 passed，B 已删除后随 A 旧快照复活                                                                     | 提交重读后 8/8                                                                     |
| F11 并发创建  | 同上：1 failed / 8 passed，快创建的 Profile 被慢加密旧快照覆盖                                                                                             | create 提交重读后 9/9；补并发组合后 13/13；与 F10 合跑 25/25                       |
| F12 确认      | `tests/lifecycle/close-to-tray.test.ts`：1 failed / 4 passed，confirming 时 `visible=false`                                                                | 回调接入后与 `tests/lifecycle/exit-flush.test.ts` 合跑 9/9                         |
| F12 错误      | `tests/lifecycle/close-to-tray.test.ts`：1 failed / 5 passed，保存失败时 `visible=false`                                                                   | error 同样回调后合跑 10/10；补最小化/静默启动/收尾错误并合跑 tray-residency，23/23 |
| F17 IO预算    | `tests/tasks/mentions.test.ts -t '大文件实际读取'`：1 failed，实际 2097152 字节超过 131073                                                                 | 句柄限定读取后通过；最终 mentions 17 passed / 1 skipped                            |
| F17 UTF8边界  | `tests/tasks/mentions.test.ts -t '截断处保留完整'`：1 failed，旧替换符裁尾正则把正文原有 U+FFFD 一起丢掉                                                   | StringDecoder 流式截断后，与预算切片合跑 2 passed（其余按 -t 未选）                |

测试夹具纠正不计产品 RED：F12 初次命令因测试 `as` 换行触发 `Expected ";" but found "{"`、0 tests，修正后才获得上表行为失败；F17 初次 IO 统计把 readFileSync 内部 readSync 重复相加，纠正后以 2097152 字节重新取得 RED，再修改生产代码。

最终定向命令（格式化之后）为

```bash
pnpm --dir 'C:/Users/leffss/Desktop/ai-agent/packages/desktop' exec vitest run tests/storage/json-file.test.ts tests/profiles/profile-store.test.ts tests/lifecycle/close-to-tray.test.ts tests/lifecycle/exit-flush.test.ts tests/tray/tray-residency.test.ts tests/tasks/mentions.test.ts tests/mcp/mcp-store.test.ts tests/search/search-settings-store.test.ts tests/subagents/subagent-settings-store.test.ts tests/theme/theme-settings-store.test.ts tests/terminal/terminal-settings-store.test.ts tests/execution/agent-settings-store.test.ts tests/openers/opener-settings-store.test.ts tests/tray/tray-settings-store.test.ts
```

结果：退出 0，14 files passed，129 tests passed / 1 skipped（共 130）。唯一 skipped 是 Windows 文件 symlink 创建 `EPERM`；已从提前 return 改为 `context.skip`，不再假绿。目录 junction 的真实越界分支成功验证。格式化仅显式指定本票 8 个代码文件，退出 0。

主代理后续消息确认 test-data + tray 集成 22 绿、desktop tsc 绿（由主代理执行，本票未自行跑）；全仓检查、build、真实 Electron 退出 E2E、独立复审仍由主代理后续执行。本票未运行 build、全测、install、git 操作，也未访问真实用户配置、凭据或外网。无需等待新 Core dist 即可完成上述定向测试。

### 本票修改文件（绝对路径）

- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/storage/json-file.ts`
- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/profiles/profile-store.ts`
- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/lifecycle/exit-ipc.ts`
- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/src/tasks/mentions.ts`
- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/tests/storage/json-file.test.ts`
- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/tests/profiles/profile-store.test.ts`
- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/tests/lifecycle/close-to-tray.test.ts`
- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/tests/tasks/mentions.test.ts`
- `C:/Users/leffss/Desktop/ai-agent/.scratch/code-audit-2026-11-18/issues/04-storage-platform.md`

`main.ts` 与 E2E 改动由主代理完成，不计入本票文件所有权。READY_FOR_BUILD。
