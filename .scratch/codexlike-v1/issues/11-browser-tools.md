# 11: Playwright 浏览器工具组

**What to build:** agent 获得五件浏览器工具：`browser_navigate`（打开 URL）、`browser_click`（选择器点击）、`browser_type`（输入框填写）、`browser_screenshot`（整页截图）、`browser_read`（提取正文文本）。基于 Playwright headless Chromium，首次使用时自动下载（有进度与失败提示）。`browser_read` 输出截断上限；截图保存为文件并在卡片展示，端点支持多模态时附给模型，否则降级为路径+说明。浏览器实例会话级复用（同一会话共享 Cookie/状态），会话结束关闭。

遵循 `GLOSSARY.md`；完整需求见 `.scratch/codexlike-v1/spec.md`。

**Blocked by:** 03 (六件核心工具 + 工具卡片)

**Status:** done

- [x] 五件工具齐全，共享同一会话级浏览器实例
- [x] 首次使用自动下载 Chromium，失败有中文提示与重试
- [x] `browser_read` 返回提取正文（截断有标记）
- [x] 截图卡片展示；多模态附图 / 降级两种路径都可工作
- [x] 导航失败/超时返回明确错误，会话不崩
- [x] 本地 HTML fixture 上的工具行为测试（navigate→type→click→read→screenshot 全链）

## Comments

### AC 逐条核对（2026-11-11，分支 `feature/11-browser-tools`，两次合并集成分支：04/08/10 与 05/09/12/13）

1. **五件工具齐全，共享同一会话级浏览器实例** ✅ `createBrowserTools({ manager })` 返回五件（`browser_navigate`/`browser_click`/`browser_type`/`browser_screenshot`/`browser_read`，权限划分：navigate/screenshot/read=readonly、click/type=command）；`BrowserSessionManager`（`src/browser/manager.ts`）全进程共享一个 headless Chromium、每会话独立 BrowserContext（Cookie/localStorage 互不串扰），`pageFor(sessionId)` 会话内复用同一页面。`ToolExecutionContext` 扩展 `sessionId` + `toolCallId`（会话循环逐调用注入；子代理与主会话共享同一 sessionId 的 context）。测试：真实 Chromium 上同会话同一 Page、两会话 Cookie 隔离、closeSession 后页面关闭且新页面无旧 Cookie。
2. **首次使用自动下载 Chromium，失败有中文提示与重试** ✅ `ChromiumInstaller` 接口 + `ensureChromiumReady`：默认实现 spawn `playwright-core` CLI（`cli.js install chromium --no-progress`；Electron 宿主下 `ELECTRON_RUN_AS_NODE=1` 以 node 模式跑自身）；`PLAYWRIGHT_DOWNLOAD_HOST` 未显式设置时默认 `https://npmmirror.com/mirrors/playwright/` 镜像，stdout/stderr 逐行进度（工具首次调用时进度行随导航结果返回模型、主进程日志同步可见）。下载失败抛中文错误（含「稍后再次调用会自动重试」与镜像设置指引），下次调用重新尝试；安装器全部可注入（9 用例不真下载）。manager 在 `launch()` 前 ensure，并发调用共享同一次启动，launch 失败清任务句柄可重试。
3. **`browser_read` 返回提取正文（截断有标记）** ✅ `document.body.innerText` 提取（字符串表达式形式，不依赖 tsconfig DOM lib），头部带标题+地址两行，正文上限 30000 字符，标记 `[已截断：正文共 X 字符，已显示前 30000 字符]`（与 read_file/终端输出同款格式）。测试：1200 段长文 fixture 断言截断标记与总长上限。
4. **截图卡片展示；多模态附图 / 降级两种路径都可工作** ✅ 截图保存 `<数据目录>/sessions/<会话id>/screenshots/<toolCallId>.png`（约定路径，重启后卡片仍可读回）；`ToolResult.images`（mediaType+base64）→ 会话循环组装 ai@7 的 `output: { type: 'content', value: [text, file(image)] }`（OpenAI 兼容端点转 image_url data URL）——`attachToolImages` 开关（`CreateAgentSessionOptions`/`SessionManagerOptions` 透传，desktop 装配层 `CODEXLIKE_ATTACH_TOOL_IMAGES=1` 开启，默认关走降级）。两条路径均有测试：agent-core 断言 doStream prompt 的 tool-result part 为 content 块（text+file base64）或纯文本；E2E 断言默认降级（第三轮请求体含工具结果文本、不含 image_url）。UI：`ToolCallCard` 展开时对 browser_screenshot 经 `sessions:tool-image` IPC 按需拉 dataURL 渲染 `<img>`（E2E 实测内嵌图片元素出现）。
5. **导航失败/超时返回明确错误，会话不崩** ✅ 仅 http/https（file://、javascript:、裸文本中文拒绝）；导航超时 30s 中文提示；`net::ERR_*` 保留原始错误码。**踩坑修复**：goto 失败后页面停在 `chrome-error://` 且挂起任务会打断下一次导航——失败路径 `manager.resetPage()`（同 context 换新页，Cookie 保留）复位，后续导航实测可用。click/type 选择器 10s 未命中返回「找不到元素 + 用 browser_read 查看页面结构」指引；read/screenshot 未导航会话返回「先 browser_navigate」引导。
6. **本地 HTML fixture 全链测试** ✅ `tests/browser/fixture-server.ts`（随机端口 http 服务：表单页/1200 段长文页/Set-Cookie 页）+ 真实 Chromium：navigate→type→click→read（断言交互后正文含「已提交：<输入值>」）→screenshot（PNG 魔数+落盘+images 附件）全链，加 Cookie 隔离、失败路径、截断、会话隔离共 8 用例。

### 关键实现事实（后续工单建立在这些接口上）

- **agent-core `./node` 新出口**：`createBrowserSessionManager`/`createBrowserTools`/`createCliChromiumInstaller`/`ensureChromiumReady`/`BROWSER_READ_MAX_CHARS` 及类型。`playwright-core@^1.65` 进 agent-core dependencies（esbuild 打包 desktop 主进程时 **external 化**——其内部动态 require 打进单文件不可靠）。
- **ToolExecutionContext 新增 `sessionId`（必填）+ `toolCallId`（可选）**：会话级资源按 sessionId 隔离；13 号合并时子代理执行链同样带 sessionId（与主会话共享浏览器 context）。既有各工具测试的 context 工厂已同步。
- **ToolResult 新增 `images?: ToolResultImage[]`**：截图附图只进模型回填（content 块），**不进** ToolCallRecord/事件流/落库（避免几 MB base64 过 IPC 与 SQLite）；UI 按约定路径经 IPC 按需读回。
- **desktop**：`sessions:tool-image` IPC（sessionId+toolCallId → dataURL，toolCallId 字符白名单防路径注入）；会话归档时 `closeSession`（浏览器 context 释放）；will-quit 尽力收尾（persistence + mcpService + browserManager，**不 preventDefault**——阻塞式收尾在 Electron 45 上进程不退）。
- **Chromium 就绪判定**：`existsSync(chromium.executablePath())`；本机 ms-playwright 缓存（chromium-1254）直接命中，无需下载。

### 踩坑记录（对后续工单有用）

- **goto 失败后的 chrome-error 页会打断下一次导航**（连 `waitUntil: 'commit'` 的 about:blank 复位也被 interrupted）：可靠复位 = 同 context 整页换新（`resetPage`），Cookie 不丢。
- **ai@7 多模态 tool result**：`ToolResultOutput` 支持 `{ type: 'content', value: [{type:'text'|'file', data:{type:'data',data:base64}, mediaType}] }`，@ai-sdk/openai 自动转 image_url data URL（`dist/index.js` 1260 行附近实测）。
- **playwright-core 1.65 的程序化安装**：`lib/server/registry` 已 bundle 化不可用；可行路径是 spawn `playwright-core/cli.js install chromium`（exports 白名单不含 cli.js，经 `require.resolve('playwright-core/package.json')` 取 dirname 定位）。
- **Electron 45 will-quit 的 preventDefault + 二次 quit 会让进程挂起**：收尾一律尽力而为（fire-and-forget），且 E2E 的 `app.close()` 偶发不退（功能断言已过后进程挂着，集成分支在 10 号合并后即存在）——全部 10 条 e2e 加 `closeApp`（10 秒后 `app.process().kill()` 强杀兜底）。
- **page.evaluate 的 DOM 类型**：agent-core tsconfig 无 DOM lib，浏览器内执行的表达式用字符串形式 `page.evaluate<string>('document.cookie')` 绕开。
- **并行合并节奏**：本工单期间集成分支两次前移（04/08/10、05/09/12/13）。E2E 脚本的设置页定位要在表单内（`window.locator('form').getByLabel(...)`——13 号加了子代理「模型」select、10 号加了搜索源「保存」按钮，全局定位 strict violation）；新建会话流程 09 号后多了确认对话框（`create-session-confirm`）。**merge 后必须全仓 build 再跑 E2E**（旧 dist 会让 UI 断言莫名超时）。

### 测试与验证

- `pnpm typecheck` 三包全过；`pnpm test`：agent-core 283 + desktop 52 + ui 51 = 386 用例全绿（本工单新增 23：安装器 9、manager 4、工具 8、附图 2；并行工单用例随合并纳入）。
- E2E 10 条全部通过：smoke、commands、approvals、compact、changes、interrupt、mcp、subagents、worktree、**browser（本工单新增：Electron 主进程内真实 navigate/screenshot，截图落盘+卡片内嵌图片+降级回填断言）**。

### `app.close()` 偶发不退——调查结论与主进程兜底（code review 修复 7，2026-11-11 补记）

- **现象**：全部功能断言通过后，Playwright `_electron` 的 `app.close()` 偶发不 resolve（进程挂着），集成分支 10 号合并后即存在，非浏览器工单引入；E2E 以 `closeApp`（10 秒后 `app.process().kill()` 强杀）兜底。
- **排查**：
  1. 主进程 will-quit 收尾**没有** `preventDefault`（早期版本有过 preventDefault + 二次 quit，那才是确定的挂起路径，已改掉）；收尾全部尽力而为（`persistence.close()` 同步 + `mcpService.shutdown()` / `browserManager.close()` fire-and-forget），JS 层没有能阻塞 quit 序列的代码。
  2. `mcpService`（stdio 子进程）与 `browserManager`（Playwright Chromium 子进程）的子进程句柄不阻止 Electron 在 quit 后退出；挂起发生在 Electron/Chromium 自身的退出收尾（疑因：窗口销毁与 WebContents teardown 竞态、GPU/utility 子进程收尾——Electron 45 Windows 上偶发，非本仓代码可控，无法确定性复现）。
- **处置**（可靠的强制退出兜底进主进程而非仅 E2E）：main.ts 的 will-quit 里追加 `setTimeout(() => app.exit(0), 2_000).unref()`——正常退出在毫秒级完成、进程先于定时器结束（unref 也不保活）；一旦收尾挂起，2 秒后 `app.exit(0)` 强制退出（`app.exit` 不再触发 will-quit，无递归风险）。E2E 侧 `closeApp` 的 10 秒强杀保留作第二道保险。
- **验证**：修复后 11 条 E2E 全部实跑通过（见 spec.md「Code Review 修复记录」）。
