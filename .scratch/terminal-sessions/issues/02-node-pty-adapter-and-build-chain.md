# 02: node-pty 适配器 + Electron 构建链

**What to build:** desktop 用 node-pty（Windows 走 conpty）实现 01 票定义的 PtyPort：真 TTY spawn、write、resize、onData/onExit 透传、kill 覆盖 Windows 子进程树（参考现有 killTree 的 taskkill /T /F 思路并单独验证）；electron-rebuild 进入 desktop 构建链。**本票同时定案 ABI 策略**：vitest 跑在 node ABI、Electron 主进程跑在 Electron ABI，适配器真件只在 Electron/e2e 环境加载——适配器自身的逻辑单测用依赖注入，不在 node 单测里 require 真件。这是全特性风险最高的一张票（原生模块 + ABI + 打包），先排掉。决策权威：ADR 0033；文件指针见 notes.md §1/§7。

**Blocked by:** 01。

**Status:** done

- [x] node-pty 变体与版本选定并进 pnpm-lock；pnpm install 后 worktree 可复现安装
- [x] desktop PtyPort 适配器实现：spawn（含 cwd/env/shell 参数透传）、write、resize、onData/onExit、kill（子进程树确实死透，验证方式写进票面 Comments）
- [x] electron-rebuild 进构建链；Electron 主进程可 require 适配器并跑通一次真 pty（echo / 交互程序冒烟）——策略修订为 **prebuild 优先默认免 rebuild**（node-pty 1.1.0 自带 prebuilds 实测兼容本机 Electron），`rebuild:native`（@electron/rebuild）保留为兜底 script；本机无 VS Build Tools 未实跑兜底，准入条件已记录
- [x] ABI 策略落 notes.md：适配器真件的加载边界（Electron/e2e）、node 单测的替代验证方式（编排者已落 §7）
- [x] desktop build / typecheck 绿

## Comments

- 【01 票衔接】PtyPort 形状已定稿（集成 `fd6072e`，接口在 `agent-core/src/terminal/pty-port.ts`）：spawn **同步**返回 PtyProcess；shell 不可用 throw；**kill 后必须触发 onExit**（管理器终态/快照由 exit 事件驱动，killAll 兜底超时只是防挂死）；子进程树覆盖（taskkill /T /F 思路）是适配器责任且需单独验证。实现并经 desktop 依赖注入 `createTerminalSessionManager({ port })`。
- 【01 票衔接】`initialCommand` 如何让 shell 执行且保持交互提示符由适配器决定（bash `-c` / powershell `-Command` 等自行选型）。
- 【ABI 红线】vitest 跑 node ABI、Electron 主进程跑 Electron ABI：**适配器真件（node-pty）不得被单测静态加载**——适配器做成依赖注入 + 真件动态加载，逻辑单测用注入 fake；真件验证归 Electron 冒烟与后续 e2e。策略定案后由编排者落 notes.md（票面「ABI 策略落 notes.md」验收项由编排者代勾）。
- 【工程】引入 node-pty 后 `pnpm install --frozen-lockfile` 会失败（lockfile 未含新依赖）：先 `pnpm add`（或编辑 package.json 后 `pnpm install`）更新 lockfile，再提交 package.json + pnpm-lock.yaml；electron-rebuild 选型（@electron/rebuild devDep + script 或等价方案）一并落构建链。
- 【worktree 坑，01 票实测】worktree 首次 pre-commit 前先 `pnpm --filter @codexlike/agent-core run build`——install 不构建包产物，否则 desktop build 报 Could not resolve "@codexlike/agent-core/node"（notes.md §7 已记）。
- 落地：票分支 ts-02-node-pty-adapter commit `9ef1391`，集成合入 `2c1fed8`。10 文件 +1067/−42；适配器单测 23 用例绿，desktop 532 全量绿，pre-commit 三包全绿，build/typecheck 0 错，Electron 真件冒烟 6/6（两次复跑一致）。
- 选型：官方 node-pty 1.1.0（自带多平台 prebuilds，pnpm 12 经 pnpm-workspace.yaml `allowBuilds` 放行安装脚本），未换 prebuilt 变体。适配器 `node-pty-port.ts` 为 desktop 唯一 node-pty 触点：无静态 import（源码形状单测守住），运行时 `createRequire` 动态解析；esbuild external（build-options.mjs）+ dist vendor 拷贝（dist.mjs，dereference pnpm symlink 保住 prebuilds）+ electron-builder extraResources 下发；node-pty 留 dependencies、@electron/rebuild 为 devDep 兜底。
- kill 树证据：git-bash 会话内后台 `ping -n 300`（conpty 宿主→bash→ping 三层），kill 后 onExit 到达（0xC000013A），1200ms 后 tasklist 精确查询子进程已消亡（两次 pid 结论一致）。kill 顺序：win32 先 `taskkill /pid <pty.pid> /T /F` 再 `pty.kill()`，幂等，迟到真实 exit 不重复转发。
- initialCommand 方案：spawn 后立即 `pty.write(initialCommand + "\r")`（conpty 对早到输入有缓冲），三 shell 一条路径无引号转义层且保持交互提示符；git-bash 定位复用现有解析链（显式配置 > CODEXLIKE_GIT_BASH_PATH > 候选）+ `--login -i`。
- 冒烟复跑口令：`pnpm --filter @codexlike/desktop run smoke:pty`（SMOKE-SUMMARY: 6/6 passed）。
- 未决/已知：electron-rebuild 兜底未本机实跑（无 VS Build Tools，exit 127）——默认 prebuild 路径已实证，未来 Electron 升级 prebuild 不兼容时需先装 VS Build Tools；node-pty 1.1.0 Windows 不支持 `encoding` 选项（默认 utf8 正合契约）；冒烟 stderr 有 conpty agent `AttachConsole failed` 已知噪音，不影响功能。

## Comments

- 【01 票衔接】PtyPort 形状已定稿（集成 `fd6072e`，接口在 `agent-core/src/terminal/pty-port.ts`）：spawn **同步**返回 PtyProcess；shell 不可用 throw；**kill 后必须触发 onExit**（管理器终态/快照由 exit 事件驱动，killAll 兜底超时只是防挂死）；子进程树覆盖（taskkill /T /F 思路）是适配器责任且需单独验证。实现并经 desktop 依赖注入 `createTerminalSessionManager({ port })`。
- 【01 票衔接】`initialCommand` 如何让 shell 执行且保持交互提示符由适配器决定（bash `-c` / powershell `-Command` 等自行选型）。
- 【ABI 红线】vitest 跑 node ABI、Electron 主进程跑 Electron ABI：**适配器真件（node-pty）不得被单测静态加载**——适配器做成依赖注入 + 真件动态加载，逻辑单测用注入 fake；真件验证归 Electron 冒烟与后续 e2e。策略定案后由编排者落 notes.md（票面「ABI 策略落 notes.md」验收项由编排者代勾）。
- 【工程】引入 node-pty 后 `pnpm install --frozen-lockfile` 会失败（lockfile 未含新依赖）：先 `pnpm add`（或编辑 package.json 后 `pnpm install`）更新 lockfile，再提交 package.json + pnpm-lock.yaml；electron-rebuild 选型（@electron/rebuild devDep + script 或等价方案）一并落构建链。
- 【worktree 坑，01 票实测】worktree 首次 pre-commit 前先 `pnpm --filter @codexlike/agent-core run build`——install 不构建包产物，否则 desktop build 报 Could not resolve "@codexlike/agent-core/node"（notes.md §7 已记）。
