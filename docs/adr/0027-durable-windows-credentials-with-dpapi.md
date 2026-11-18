# Windows 凭据直接使用 CurrentUser DPAPI，兼容读取旧 Electron 密文

Electron 45 的 safeStorage 在 Windows 依赖 Local State 中延迟提交的应用密钥：全新目录首次保存凭据成功后立即强杀，业务密文存在但下次可能无法解密；现有公共 API 没有可 await 的 Local State 持久化屏障。Windows 新写凭据因此直接交给系统 DPAPI 的 `CurrentUser` 作用域保护，移除对 Electron 应用密钥的依赖；非 Windows 保持 Electron 路径。Profile、搜索源与 MCP 共用一个 `SafeStorageLike` Adapter，系统实现留在 desktop，不进入 Agent Core/UI。

## 格式与兼容

现有 JSON/base64 字段不变，新 Buffer 使用应用自有 family/provider/version envelope。新 family 的截断、未知版本或解密失败必须明确拒绝，不能再尝试旧解密器；旧无标记密文只经 Electron 解密且读取不重写，不进行批量自动迁移。用户显式保存时才写新格式。已经丢失旧密钥的密文不能由新方案恢复，保留原文件并显示错误，不能返回空值覆盖它。

这是单向兼容：新版本可读可解密的旧格式，旧版本不能读新格式；降级前须备份配置，不能把新文件交给旧程序当作透明兼容数据。

## 系统桥接与限制

不引入需要 Electron ABI 重编译的 npm 原生依赖；通过系统 Windows PowerShell 5.1 的绝对路径运行固定可信代码，调用 .NET `ProtectedData`（原生 DPAPI 包装）。秘密只经有界 stdin/stdout，不进入 argv、环境变量、日志或临时脚本。进程隐藏、无 shell、无 profile，不更改 ExecutionPolicy；超时、限量协议、并发和队列预算由 Adapter 收口。

PowerShell/DPAPI 被系统策略禁止时拒绝保存并保留旧值，不回退明文、LocalMachine 或 Electron 新写入。CurrentUser 仍依赖当前 Windows 用户 profile，通常限同一用户及机器，不防同用户恶意进程。

## 完成语义与性能

DPAPI 返回密文且应用既有原子 JSON 写入完成后才响应保存成功；要求应用进程随后立即强杀仍能跨进程读取，不承诺整机断电或磁盘硬件故障零丢失。不得以预热正常退出、固定 sleep、弃用同步 safeStorage 或猜写 Local State 代替根因修复。

共享 Adapter 采用有界成功解密缓存和同密文在途去重，限制冷启动系统进程并发；失败不缓存、加密结果不缓存。真实跨进程回归使用全新用户目录、假凭据，在收到保存完成信号后立即强杀，不允许缓存或同进程重建掩盖问题。

## 依据

- [Electron v45.2.3 safeStorage](https://raw.githubusercontent.com/electron/electron/v45.2.3/docs/api/safe-storage.md)
- [Electron v45.2.3 browser process：Local State provider 与退出提交](https://raw.githubusercontent.com/electron/electron/v45.2.3/shell/browser/browser_process_impl.cc)
- [微软 ProtectedData：DPAPI Protect/Unprotect 包装](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata?view=netframework-4.8.1)
- [微软 DataProtectionScope.CurrentUser](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope?view=netframework-4.8.1)
