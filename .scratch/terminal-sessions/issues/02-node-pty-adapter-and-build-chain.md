# 02: node-pty 适配器 + Electron 构建链

**What to build:** desktop 用 node-pty（Windows 走 conpty）实现 01 票定义的 PtyPort：真 TTY spawn、write、resize、onData/onExit 透传、kill 覆盖 Windows 子进程树（参考现有 killTree 的 taskkill /T /F 思路并单独验证）；electron-rebuild 进入 desktop 构建链。**本票同时定案 ABI 策略**：vitest 跑在 node ABI、Electron 主进程跑在 Electron ABI，适配器真件只在 Electron/e2e 环境加载——适配器自身的逻辑单测用依赖注入，不在 node 单测里 require 真件。这是全特性风险最高的一张票（原生模块 + ABI + 打包），先排掉。决策权威：ADR 0033；文件指针见 notes.md §1/§7。

**Blocked by:** 01。

**Status:** ready-for-agent

- [ ] node-pty 变体与版本选定并进 pnpm-lock；pnpm install 后 worktree 可复现安装
- [ ] desktop PtyPort 适配器实现：spawn（含 cwd/env/shell 参数透传）、write、resize、onData/onExit、kill（子进程树确实死透，验证方式写进票面 Comments）
- [ ] electron-rebuild 进构建链；Electron 主进程可 require 适配器并跑通一次真 pty（echo / 交互程序冒烟）
- [ ] ABI 策略落 notes.md：适配器真件的加载边界（Electron/e2e）、node 单测的替代验证方式
- [ ] desktop build / typecheck 绿

## Comments

- 【01 票衔接】PtyPort 形状已定稿（集成 `fd6072e`，接口在 `agent-core/src/terminal/pty-port.ts`）：spawn **同步**返回 PtyProcess；shell 不可用 throw；**kill 后必须触发 onExit**（管理器终态/快照由 exit 事件驱动，killAll 兜底超时只是防挂死）；子进程树覆盖（taskkill /T /F 思路）是适配器责任且需单独验证。实现并经 desktop 依赖注入 `createTerminalSessionManager({ port })`。
- 【01 票衔接】`initialCommand` 如何让 shell 执行且保持交互提示符由适配器决定（bash `-c` / powershell `-Command` 等自行选型）。
- 【ABI 红线】vitest 跑 node ABI、Electron 主进程跑 Electron ABI：**适配器真件（node-pty）不得被单测静态加载**——适配器做成依赖注入 + 真件动态加载，逻辑单测用注入 fake；真件验证归 Electron 冒烟与后续 e2e。策略定案后由编排者落 notes.md（票面「ABI 策略落 notes.md」验收项由编排者代勾）。
- 【工程】引入 node-pty 后 `pnpm install --frozen-lockfile` 会失败（lockfile 未含新依赖）：先 `pnpm add`（或编辑 package.json 后 `pnpm install`）更新 lockfile，再提交 package.json + pnpm-lock.yaml；electron-rebuild 选型（@electron/rebuild devDep + script 或等价方案）一并落构建链。
- 【worktree 坑，01 票实测】worktree 首次 pre-commit 前先 `pnpm --filter @codexlike/agent-core run build`——install 不构建包产物，否则 desktop build 报 Could not resolve "@codexlike/agent-core/node"（notes.md §7 已记）。
