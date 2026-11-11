# 14: 打包发行 + 验收走查

**What to build:** 用 electron-builder 产出 Windows NSIS 安装包与便携版 zip，本机全新安装可运行；应用图标与窗口标题为 CodexLike；README 写明构建、打包、Provider 配置与数据目录。最后逐条走查 spec 的 9 条验收场景（走查结果记录到本工单 comments），全部通过即 v1.0 完成。

9 条验收场景清单见 `.scratch/codexlike-v1/spec.md`「验收标准」节。

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13（全部前置工单）

**Status:** done

- [x] electron-builder 产出 NSIS 安装包与便携 zip
- [x] 全新安装（非开发机路径）启动、配置、会话全流程可用
- [x] 应用图标与窗口标题 CodexLike
- [x] README：构建/打包/配置/数据目录说明
- [x] spec 9 条验收场景逐条走查通过并记录结果

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/14-packaging-and-acceptance`，基线 81412a4）

1. **electron-builder 产出 NSIS 安装包与便携 zip** ✅ `pnpm dist`（= 全仓 build + desktop `predist` 组装 + electron-builder 26.18）产出 `packages/desktop/release/`：`CodexLike-Setup-1.0.0.exe`（122 MB，NSIS 向导式安装、可选目录、快捷方式 + 卸载器）、`CodexLike-1.0.0-portable.zip`（153 MB，解压即用）。asar 内容极简（main.cjs 2.6 MB 单文件 + preload + package.json）；ui 静态产物（15 MB）与 playwright-core（14 MB，工单 11 external 化）放 `resources/` 的 extraResources。
2. **全新安装（非开发路径）启动、配置、会话全流程可用** ✅ NSIS 静默安装（`/S /D=`）到 `C:\Users\leffss\Desktop\codexlike-acceptance\nsis-install\` + 便携 zip 解压到 `...\portable\`（均在开发仓库之外）；两种形态分别以全新临时数据目录（`CODEXLIKE_HOME` 隔离）跑 smoke E2E 全链路：设置页建 Profile（safeStorage 加密）→ 建会话 → 消息往返（write_file 真实落盘 + 流式 markdown）→ web_search（mock 端点）→ **真实重启恢复**，全部通过。**模型交互用本地 mock OpenAI 兼容端点验证（E2E 基建既有 mock SSE server），真实端点待用户配置**——与前置工单口径一致。
3. **应用图标与窗口标题 CodexLike** ✅ 图标纯 Node 自绘（`scripts/make-icon.mjs`：深色圆角方块 + 青色 `>` + 绿色 `_` 终端提示符，逐像素 SDF 绘制 + 双线性缩放 16–256 多尺寸 PNG-in-ICO，零第三方素材依赖）；窗口标题 `CodexLike`（BrowserWindow title，02 已有）；exe/安装器/快捷方式名 CodexLike。图标经视觉复核（形状/圆角/颜色清晰无缺陷）。
4. **README：构建/打包/配置/数据目录说明** ✅ 仓库根 `README.md`（中文）：项目简介与功能一览、环境要求、两种产物的安装说明（含未签名 SmartScreen 提示）、首次使用（Provider Profile / Tavily 可选 / 子代理 / MCP）、数据目录 `~/.codexlike/` 完整树形说明（含「删目录即清空」）、开发（install/dev/typecheck/test/test:e2e/build）、打包（pnpm dist 流程与镜像 env）、打包产物 E2E 走查入口。
5. **spec 9 条验收场景逐条走查** ✅ 见下节，全部基于**打包产物**（NSIS 安装版为主）执行通过。

### 9 条验收场景走查明细（全部指向打包产物 exe，mock 模型端点）

E2E 基建新增 `CODEXLIKE_PACKAGED_EXE` 环境变量（`e2e/launch-target.mjs` 公共模块）：设为安装版/便携版 exe 时全部 11 条 E2E 切换为打包产物执行（exe 自身即应用，无需 args）；不设则维持开发目录模式，向后兼容。

| # | 场景 | 走查方式（脚本 → 断言要点） | 结果 |
| --- | --- | --- | --- |
| 1 | 全新安装 → 配置 Profile → 开始会话 | smoke：NSIS 安装版 + 便携版**双形态**、全新数据目录：设置页建 Profile（加密落盘）→ 建会话 → 消息往返 | ✅ 双形态均过 |
| 2 | 修 bug 全流程 | **acceptance（本工单新增）**：read_file → grep → apply_patch（真实补丁修复 calc.js off-by-one）→ run_terminal_command（suggest 审批卡 → 批准 → `node calc.js` 输出 15）→ 改动面板「修改」徽标 + Monaco 双栏 diff → 一键 commit（模型生成消息，git log 验证） | ✅ |
| 3 | 重启恢复续聊 | smoke 第二次启动：会话列表、消息历史、工具卡片完整恢复 | ✅ |
| 4 | /compact | compact：压缩请求体只携带被压缩轮次、摘要卡片、压缩后上下文、重启恢复 | ✅ |
| 5 | worktree 双会话并行 | **acceptance 场景 5**：同仓库会话 A（本目录直跑）+ 会话 B（worktree 模式）各写文件：a 落主仓库、b 落 `worktrees/` 副本、互不泄漏、主仓库 status 不串；另 worktree 全链路（`.worktreeinclude` 复制/非 git 报错/重启恢复）走 worktree 脚本 | ✅ |
| 6 | web_search + 浏览器 | smoke（web_search：key 配置 → 工具 → 卡片）+ browser（navigate/type/click/read/screenshot：**打包态 playwright-core 从 resources/node_modules 解析 + 真实 Chromium 启动**、截图落盘 + 内嵌渲染 + 降级回填） | ✅ |
| 7 | MCP server | mcp：设置页添加 stdio server（fake，系统 node 子进程）→ 连接 + 工具发现 → suggest 审批（`mcp_fake_echo`）→ 调用回填 → 重启自动重连 | ✅ |
| 8 | subagent 委派 | subagents：主/子两级 mock 分流（独立上下文断言）→ 嵌套卡片进度 → 报告回流主会话 → 重启恢复嵌套卡片 | ✅ |
| 9 | 审批三档 + readonly 拦截 | approvals：suggest 三键审批卡（data-approval-command 断言）→ always 记忆（真实重启后不询问）→ readonly 写入被拦（文件不落盘、拒绝原因回填模型）→ /status 三档文案 | ✅ |

### 关键实现事实

- **打包管线**（three-stage）：`packages/desktop/scripts/dist.mjs`（predist）校验三包构建产物 → 组装 `.dist-vendor/` 独立 projectDir（app-dist/ + ui-dist/ + node_modules/playwright-core 实体拷贝 dereference + build/icon.ico + 无 dependencies 的 package.json + 注入 electronVersion 的 electron-builder.yml）→ `electron-builder --win --projectDir .dist-vendor`。产物在 `packages/desktop/release/`。
- **为何独立 projectDir**：主进程是 esbuild 单文件（业务依赖全 bundle，仅 external `electron` + `playwright-core`），运行时零业务 node_modules；独立目录的 package.json 无 dependencies，electron-builder 不做任何依赖收集（pnpm workspace 的 `workspace:*` 收集不可控且拖入 40 MB 冗余）。`@codexlike/agent-core` 因此从 desktop 的 dependencies 移到 devDependencies（类型解析与 vitest 走链接，行为不变；运行时靠 bundle）。
- **resources 布局**：ui 静态产物 → `resources/ui-dist`（main.ts 按 `app.isPackaged` 分支 `loadFile(process.resourcesPath/ui-dist/index.html)`，Monaco worker 等 file:// 直读）；playwright-core → `resources/node_modules/playwright-core`（Node 模块解析从 `app.asar/dist` 逐级向上、出 asar 后命中；chromium 安装器 spawn `cli.js` 要求真实文件路径，asar 内不可 spawn）。browser E2E 实证该解析链在打包态可用。
- **图标生成**：`scripts/make-icon.mjs` 纯 Node 自绘（zlib deflate 手写 PNG 编码 + PNG-in-ICO 容器，16/24/32/48/64/128/256 多尺寸双线性缩放），`pnpm --filter @codexlike/desktop run icon` 可重新生成。
- **E2E 打包产物钩子**：`e2e/launch-target.mjs` 导出 `launchTarget(env)`（+ `DESKTOP_DIR`/`ELECTRON_BIN` 兼容导出）；11 条 E2E 脚本统一替换 launch 调用（单行/多行两种形态各批量改造），`CODEXLIKE_PACKAGED_EXE` 一键切换。
- **版本**：四包 0.1.0 → 1.0.0（v1.0 收口）。

### 设计决策与偏离说明

- **zip 无独立 artifactName 节**：electron-builder 26 的 `win.target` 数组项只接受 `target`/`arch`（schema `additionalProperties: false`），不支持每 target 的 artifactName；改用顶层 `artifactName`（作用于 zip）+ `nsis.artifactName`（覆盖为 Setup 命名）。
- **`electronVersion` 显式注入**：vendor 目录无 node_modules，electron-builder 无法探测 electron 版本；dist.mjs 从本机安装的 electron（45.2.3）读版本替换模板占位符，升级 electron 无需改配置。
- **MCP/终端命令依赖系统运行时**：打包产物不内嵌 node；MCP server 命令与 `node xxx.js` 类终端命令依赖用户机器的 Node.js（README 环境要求注明）。验收场景 7 的 fake server 由系统 node 运行，实测可用。
- **无代码签名**：SmartScreen 首次运行提示属预期，README 说明（「更多信息 → 仍要运行」）。
- **场景 5 的「并行」语义**：E2E 走查为串行双会话（隔离性断言：文件各落其所、互不泄漏）；**同时运行**的并发行为由 agent-core 集成测试 `tests/worktree/parallel-sessions.test.ts` 覆盖（工单 09），两者合计覆盖场景全语义。

### 踩坑记录（打包相关）

- **改 main.ts 后必须重建再打包**：electron-builder 消费的是 `dist/main.cjs`，首次打包用了旧产物导致 `isPackaged` 分支缺失（报 `resources/ui/dist/index.html ERR_FILE_NOT_FOUND`，路径形态即旧分支特征）。
- **PNG 逐行 filter 的 stride 是 `size*4 + 1`**（filter byte + RGBA），不是 `(size+1)*4`——写错时 PNG 头合法但像素区越界，常见解码器直接拒载。
- **`new URL('.', import.meta.url)` 已带尾分隔符**，再套 `dirname` 会退一级目录（本脚本首版图标生成到了包外）。
- **electron-builder 26 CLI 逗号 target 语法已废**（`--win nsis,zip` 报 Unknown target: nsis,zip）：target 写配置文件、CLI 只传 `--win`。
- **pnpm 12 构建许可**：electron-builder 传递依赖 `electron-winstaller` 的 postinstall 也需在 `pnpm-workspace.yaml` 的 `allowBuilds` 放行（01 号坑的新增项）。
- **extraResources 拷贝 pnpm symlink**：直接以 `node_modules/playwright-core` 为 from 有 symlink 风险，dist.mjs 预先 `cpSync({ dereference: true })` 成实体目录再引用。
- **NSIS 静默安装验证**：`Setup.exe /S /D=<绝对路径>`（/D 必须最后、不带引号、路径不带末尾反斜杠），安装与卸载器生成即验证完成；安装向导 UI 本身无自动化的必要。

### 已知问题（不修，留给 code-review）

- **`app.close()` 偶发不退**（工单 11 实证的既有问题）：功能断言全部通过后 Electron 45 进程偶发挂起，全部 E2E 的 `closeApp` 已有 10 秒强杀兜底（`app.process().kill()`），对走查结论无影响。根因未查，建议后续在 code-review 或 v1.x 排查（怀疑与 will-quit 的异步收尾相关）。

### 测试与验证

- `pnpm typecheck` 三包 0 错误；`pnpm test`：agent-core 283 + desktop 52 + ui 51 = **386 用例全绿**（本工单无新增单测——打包配置以可验证产物为准，符合工单「不强求单测覆盖构建脚本」约定）。
- E2E **11 条全部通过**（10 条既有 + 本工单新增 acceptance）：开发目录模式全部回归 + **NSIS 安装版跑通全部 11 条**（smoke/approvals/changes/compact/worktree/browser/mcp/subagents/commands/acceptance）+ 便携版 smoke；acceptance 另在开发模式先行验证（场景 2 首版漏了「生成提交消息」步骤致空消息提交被拒，按 changes.mjs 同流程补齐后双模式均过）。
- 产物体积：Setup 122 MB / portable zip 153 MB（Electron 45 运行时 ~210 MB 未压缩为主体；Monaco chunk 4 MB 属预期，工单说明）。

