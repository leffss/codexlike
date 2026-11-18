# 02：开发构建与 Chromium 首次安装

Status: done
Integration: 已通过最终三包build/全仓test及独立复审；详见../INTEGRATION.md
Blocked by: none

先读 ../spec.md、../notes.md；依据 ../REPORT.md F02/F03。用户已批准测试接缝。

## 所有权

desktop/scripts/build.mjs、dev.mjs、新共享构建配置；core/src/browser/chromium.ts、core/tests/browser/chromium-installer.test.ts；新增独立desktop构建加载测试。不得改browser/manager.ts、main.ts或现有e2e公共入口。

## 验收

- [x] F02 TS/ESM与最终CJS产物冷缓存均解析合法CLI，spawn可达，禁止实际下载。已验证真实 dev/prod 配置的内存 CJS；磁盘发布产物待主代理统一 build。
- [x] F03 dev与prod保留Playwright包边界，真实开发配置内存产物入口可加载。main/preload 四个入口均通过。
- [x] 最终构建不再出现未解决的empty-import-meta警告，不能仅隐藏warning。真实 dev/prod 内存构建均断言 warnings=[]；主代理已统一Core build后运行 `pnpm --filter @codexlike/desktop run build` exit0，磁盘main/preload产物均无empty-import-meta。
- [x] red→green记录与无需网络的回归测试。

## Comments

- 可esbuild write:false作真实配置回归，不更新共享dist；主代理统一build。
- 考虑CJS __filename与ESM import.meta.url兼容或构建注入，不依赖cwd/硬编码node_modules。
- 不提交；完成报告READY_FOR_BUILD。

### 实现与边界（2026-11-18）

- `scripts/build-options.mjs` 成为 dev/prod 唯一共享的 bundle/platform/target/format/external 配置，仍保留各自 sourcemap 开关。
- F03：双方均 external `electron` 与 `playwright-core`，不破坏 Playwright 包内 `__dirname`、动态 require 与资源定位。
- F02：共享配置把 `import.meta.url` 替换为 banner 在运行时根据 `__filename` 经 `pathToFileURL` 构造的 URL。没有使用构建机路径、cwd、硬编码 node_modules，也没有 logOverride 或关闭 warning。Core 的原生 ESM `createRequire(import.meta.url)` 不变，故无需修改 chromium.ts。
- 新测试实际执行 dev/build 脚本并在 esbuild/wait-on/child_process 边界截获参数、禁止启动；随后真实 esbuild `write:false` 编译。入口加载停在 Electron `app.whenReady`，禁止运行时文件写入/外部程序/网络，缓存仅使用测试自建临时目录并清理。
- CJS 安装用例以真实主入口加公开 Core 安装器导出作为内存测试入口，走正常 `@codexlike/agent-core/node` exports/dist，不截取产物函数、不 mock 内部业务模块。CLI 根据实际已安装包的 bin 契约和真实文件存在性验收；覆盖失败重试、Electron node 模式和热缓存。

### red → green 记录

工作目录无要求，以下为实际运行命令（没有 test script 前置 build，也没有输出管道）。

1. F03 red：`pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/desktop exec vitest run tests/build-loading.test.ts`，exit 1，1 failed。错误 `Cannot find module 'C:\\Users\\leffss\\Desktop\\ai-agent\\packages\\desktop\\browsers.json'`，来自真实 dev 内存主入口。
2. F03 green：引入共享构建配置后运行同命令，exit 0，1 passed。
3. F02 red：增加公开安装器的生产 CJS 冷缓存用例后运行同命令，exit 1，1 passed / 1 failed。失败为 `ERR_INVALID_ARG_VALUE ... Received undefined`，安装器未到达 spawn。
4. F02 green：增加运行时模块 URL 构建注入后运行同命令，exit 0，2 passed。
5. 扩展 dev/prod、main/preload、metafile 包边界、warnings=[]、失败重试后，最终同命令 exit 0，4 passed（14:26 最后一轮）。最终测试没有临时的 Core 源码映射插件，使用正常包出口。
6. `pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/agent-core exec vitest run tests/browser/chromium-installer.test.ts`，exit 0，10 passed；TS/ESM 冷缓存是真实 API 控制用例，不宣称此前 ESM 存在缺陷。
7. `pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/desktop exec tsc --noEmit -p tsconfig.json`，exit 0。
8. `pnpm --dir C:/Users/leffss/Desktop/ai-agent exec prettier --check packages/desktop/scripts/build-options.mjs packages/desktop/scripts/build.mjs packages/desktop/scripts/dev.mjs packages/desktop/tests/build-loading.test.ts packages/agent-core/tests/browser/chromium-installer.test.ts`，exit 0。
9. `pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/agent-core exec tsc --noEmit -p tsconfig.json`，exit 1；仅报其它组并行修改的 `tests/task/subagents.test.ts`：435 `toolCallId` union 未收窄、2085/2598 `TaskEvent.call` 未收窄。已通知主代理，不越权修改。

### 文件清单

- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/scripts/build-options.mjs`（新共享配置）
- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/scripts/build.mjs`
- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/scripts/dev.mjs`
- `C:/Users/leffss/Desktop/ai-agent/packages/desktop/tests/build-loading.test.ts`（新独立构建加载测试）
- `C:/Users/leffss/Desktop/ai-agent/packages/agent-core/tests/browser/chromium-installer.test.ts`
- `C:/Users/leffss/Desktop/ai-agent/packages/agent-core/tests/browser/isolated-playwright.ts`（review 后新增的 test-only 同步真实 SDK 加载边界）
- 本票；未修改 chromium.ts、browser/manager.ts、main.ts、e2e 公共入口。

### 下游集成事项

- READY_FOR_BUILD。未运行 pnpm build，未写共享 dist，未改 git stage/commit/branch。主代理统一重建 Core/desktop 后请复跑上面的两个定向测试，并确认最终 build 不再有 empty-import-meta；第三项 checkbox 特意留待该步骤核销。
- Core 全包 typecheck 的三个其它组错误已在 14:57 本组重跑时消失，当前 desktop/Core 两包 typecheck 均 exit 0。此前失败记录仍保留于上文，不修改其它组代码。
- 不需要 main.ts/manager.ts 新接线；最新 main 的 configureTestDataPaths 默认无测试环境变量分支已由构建入口回归覆盖。
- 未启动真实 Electron/生产用户应用、未真实下载 Chromium、未访问外部网络或模型、未读取真实用户数据。真实 NSIS/安装包和浏览器实际下载不在本票已执行范围。

### Review 回合：真实 Playwright SDK 首次加载的宿主环境隔离

- 确认 review 候选成立：VM 的 `nativeRequire("playwright-core")` 会在 VM 外真实加载 Playwright，内部 DebugLogger 在非空 `process.env.DEBUG_FILE` 下 `fs.createWriteStream` 默认截断；此前的 VM 假 env/fs 无法保护这一真实依赖边界。
- 实证只用新建临时 sentinel 和显式合成的子进程环境；从未读取真实宿主 `DEBUG_FILE` 的值或文件。首次独立进程执行真实 dev 测试 exit 0，但 sentinel 正文变空；消除了先加载 SDK 缓存后再设 env 的假绿。
- 最小修复仅在 tests：新增共享 `isolated-playwright.ts`，在同步 require 期间将真实 `process.env` 替换为测试目录白名单，finally 恢复原对象引用，无 await、无展开/读取宿主敏感变量。desktop 的 VM 外 SDK 加载使用它；Core 安装器测试通过先于源码导入的 `vi.mock` 工厂调用同 helper，返回真实 SDK，不 mock 内部业务。
- 常规回归不是嵌套 Vitest：`build-loading.test.ts` 用 `esbuild write:false` 生成轻量 probe，在全新 `node -e` 进程加载同 helper，断言 sentinel 原样、SDK executablePath 位于测试 `browsers` 目录、原 env 对象已恢复。每次冷启动，约 0.6 秒。
- red 命令：`pnpm --dir C:/Users/leffss/Desktop/ai-agent --filter @codexlike/desktop exec vitest run tests/build-loading.test.ts -t '首次加载真实 Playwright'`，14:53 exit 1，1 failed / 4 skipped，`expected '' to be '哨兵内容必须保留，不能被 Playwright 日志流截断'`。
- green：同命令 14:54 exit 0，1 passed / 4 skipped。
- 最终定向：desktop `exec vitest run tests/build-loading.test.ts` exit 0 **5 passed**；Core `exec vitest run tests/browser/chromium-installer.test.ts` exit 0 **10 passed**；两包 `exec tsc --noEmit -p tsconfig.json` 均 exit 0（14:57）。
- 另外以一次性 Node 内联 harness 新起两个独立进程，用显式合成 DEBUG_FILE=临时 sentinel 跑完整真实测试文件，desktop 5/5、Core 10/10 exit 0，两个外层 sentinel 均 unchanged（14:58）。这一步验证测试文件的实际接线，而不是只验证 helper；未加入常规套件以避免每轮嵌套 Vitest。
- 本回合不改 production、不碰 E2E/构建共享 dist；仍为 READY_FOR_BUILD。
