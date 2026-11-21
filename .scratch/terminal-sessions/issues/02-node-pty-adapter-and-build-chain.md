# 02: node-pty 适配器 + Electron 构建链

**What to build:** desktop 用 node-pty（Windows 走 conpty）实现 01 票定义的 PtyPort：真 TTY spawn、write、resize、onData/onExit 透传、kill 覆盖 Windows 子进程树（参考现有 killTree 的 taskkill /T /F 思路并单独验证）；electron-rebuild 进入 desktop 构建链。**本票同时定案 ABI 策略**：vitest 跑在 node ABI、Electron 主进程跑在 Electron ABI，适配器真件只在 Electron/e2e 环境加载——适配器自身的逻辑单测用依赖注入，不在 node 单测里 require 真件。这是全特性风险最高的一张票（原生模块 + ABI + 打包），先排掉。决策权威：ADR 0033；文件指针见 notes.md §1/§7。

**Blocked by:** 01。

**Status:** ready-for-agent

- [ ] node-pty 变体与版本选定并进 pnpm-lock；pnpm install 后 worktree 可复现安装
- [ ] desktop PtyPort 适配器实现：spawn（含 cwd/env/shell 参数透传）、write、resize、onData/onExit、kill（子进程树确实死透，验证方式写进票面 Comments）
- [ ] electron-rebuild 进构建链；Electron 主进程可 require 适配器并跑通一次真 pty（echo / 交互程序冒烟）
- [ ] ABI 策略落 notes.md：适配器真件的加载边界（Electron/e2e）、node 单测的替代验证方式
- [ ] desktop build / typecheck 绿
