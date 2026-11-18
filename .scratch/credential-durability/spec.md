# 凭据首次保存的进程崩溃耐久性

Status: ready-for-agent
Baseline: f3e674f

用户已批准方案：修复票 `.scratch/code-audit-2026-11-18/issues/08-electron-first-key-durability.md`，成功保存后立即强杀下一进程仍可解密。不预热、不sleep、不写明文、不读写Electron私有Local State、不削弱原launch-state-target场景⑥。保留用户LICENSE/.zcode内容。

## 行为要求

1. Windows新写凭据直接DPAPI CurrentUser，不依赖Electron应用密钥；通过系统PowerShell绝对路径和固定脚本桥接，秘密仅经有界stdin/stdout，不在argv/env/日志/磁盘脚本中。
2. 同一SafeStorageLike adapter实例供Profile/Search/MCP共享；模块顶层不spawn。非Windows保留Electron既有行为。
3. 新Buffer加明确provider/version envelope，外层base64及现有JSON/IPC/schema不变。未知/损坏的新标记fail closed，不fallback；无标记legacy由Electron解密。
4. 不自动迁移；用户显式保存才写新格式。旧版无法读新密文需文档告知。旧已丢密钥不可恢复，错误可见且原数据不被默认值覆盖。
5. 子进程超时、协议超限、stderr/退出错误均脱敏失败并回收。系统策略阻止则报不可用，绝不修改策略/明文降级。
6. 有界成功decrypt缓存(128条/1MiB建议)、inflight去重和最多2个并发runner；失败不缓存、不缓存encrypt结果，排队有上限。不得让热路径每次发送起大量进程。
7. Search/MCP旧密文失败不阻止建窗；设置仍可见读取错误并禁止默认值覆盖，MCP不继续用旧缓存工具。
8. 无网络/真实凭据测试。真实Windows跨进程及真实Electron新目录保存→立即taskkill→重启decrypt是核心验收。移除subagent-interrupted预热，原launch-state-target不加预热/延时。

## 批准seams

- SafeStorageLike公开interface：envelope/legacy/failure/cache/concurrency，注入仅系统ByteProtector与legacy边界。
- 三个真实stores+临时文件：混合旧新、无明文、失败保旧、并发不丢。
- Windows真实DPAPI+独立进程：当前用户新密文可重读。
- 最终Electron产物+全新userData/sessionData：保存确认后立即强杀，只按本次PID清理，不先正常quit。
- 打包产物：不依赖cwd/ASAR内脚本。

每个切片red→green，最终全仓types/lint/test/build、专项E2E、独立review。用户已授权完成后提交合并main、重新打包、正常pre-push/push，不绕过hook。

## Ownership

A：新增desktop/src/storage/{credential-storage,windows-dpapi}.ts与对应tests（可同目录私有helper）。输出`createCredentialStorage({ legacy: SafeStorageLike, platform?: NodeJS.Platform, ...测试系统边界注入 }) : SafeStorageLike`；生产默认使用Windows DPAPI，非Windowslegacy。保持type从profiles/profile-store引用，不改stores/main/UI/public包依赖。
B：desktop/profiles/profile-store.ts、search/search-settings-store.ts、mcp/{mcp-store,mcp-service}.ts及对应tests，必要ui/McpSettingsSection和测试；共享adapter接口由A定义。改读失败保旧/可见错误，不改main、新adapter/e2e。
主代理：main.ts共享实例/启动catch、package scripts、E2E新场景和旧场景恢复、ADR/README、跨组集成。禁止子代理stage/commit/build共享dist；定向exec vitest可运行。
