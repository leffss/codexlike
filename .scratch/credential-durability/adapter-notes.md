# A：凭据 adapter 下游说明

生产入口已冻结（2026-11-18）；主代理可统一 build/e2e。A 不运行共享 dist build，不 stage/commit。

```ts
// packages/desktop/src/storage/credential-storage.ts
interface CredentialStorageOptions {
  legacy: SafeStorageLike; // 从 profiles/profile-store 导入既有类型
  platform?: NodeJS.Platform; // 缺省 process.platform
  protector?: ByteProtector; // 仅系统边界测试注入；生产不传
}
createCredentialStorage(options: CredentialStorageOptions): SafeStorageLike;

// packages/desktop/src/storage/windows-dpapi.ts
interface ByteProtector {
  protect(plain: Buffer): Promise<Buffer>;
  unprotect(encrypted: Buffer): Promise<Buffer>;
}
```

- main 在 ready 后创建一次 `createCredentialStorage({ legacy: asSafeStorageLike() })`，供三个 store 共享。构造与 import 不 spawn；无需 dispose/worker/新增依赖。
- Windows 新写 DPAPI CurrentUser；新 Buffer 是 `89 43 4c 43 52 45 44 53` family + version `01` + provider `01` + uint32 LE payload 长度 + payload。坏头/未知版本/provider/空 payload/坏 UTF-8 拒绝；外层 base64/JSON 不变。无新头每次实际 Electron 解密，不缓存、不自动迁移；非 Windows 普通 legacy 保持原行为，自有 envelope 明确拒绝。
- Windows availability 实测 DPAPI protect/unprotect，失败返回 false（可重试）；成功 probe 去重缓存。实际操作出错抛 `系统凭据加密存储不可用或数据损坏，已拒绝处理凭据`，无 raw cause/stdout/stderr。
- 每实例 DPAPI 并发 2、等待 32；每个子进程 10s timeout，kill 后保留 1s 回收宽限。宽限内 close 正常释放；仍无 close（含 kill 返回 false/抛错/返回 true 却未退出）时，先永久锁死 protector 实例再脱敏拒绝，排队/新操作直接失败，不再 spawn，不把逻辑请求结算视为物理进程已退出。该实例直到重建/应用重启才恢复，迟到 close 不解锁、不重复收尾。成功 decrypt LRU 至多 128 条/1MiB（UTF-16 字符串及 SHA-256 digest 计费）、inflight 去重；encrypt/失败/legacy 不缓存。
- 明文 UTF-8 上限 1MiB，DPAPI payload 上限 1MiB+16KiB，envelope 另加 14 bytes。stdout 累计预算 + canonical base64 校验；stdin 只写对应有界 base64。
- 仅绝对 `<drive>:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`，realpath 必须同位置；不扫 PATH。固定 EncodedCommand、NoProfile/NonInteractive、shell=false、windowsHide=true；最小环境仅 SystemRoot/WINDIR/PATH(系统 System32)，不修改执行策略。非标准 Windows 目录、缺系统 PowerShell 5.1、策略禁用均 fail closed，不作备用 runner。
- 最终 44 条测试通过（19 adapter + 25 runner；新增 kill false/throw/true 后永无 close 的有界失败回归），包含本机真实 DPAPI 独立进程 Unicode/空串/BOM+NUL 与 tamper、spawn 同步/异步失败、stderr/管道错误、成功与失败 close 清理、probe mismatch；定向 `exec vitest`、`tsc --noEmit`、源码 eslint 均通过。红绿逐切片命令均为 `pnpm --dir C:/Users/leffss/Desktop/ai-agent/packages/desktop exec vitest run tests/storage/<credential-storage|windows-dpapi>.test.ts -t '<切片名>'`（退出码 1→0）。全量定向命令不含 build。
- 真实 Electron legacy 与首次保存→立即强杀→重启由主代理新增 E2E 负责；旧版无法读新格式、旧密钥已丢无法恢复的说明由主代理 ADR/README 负责。
