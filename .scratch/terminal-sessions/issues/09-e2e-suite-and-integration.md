# 09: e2e 场景套件 + 全量集成验证

**What to build:** 终端特性的 e2e 收口与全仓集成验证。新增终端 e2e 场景（真 node-pty）：新建会话 → 手敲命令输出可见 → agent 侧 spawn / read / write（含审批弹窗路径）→ kill → 重启后快照回看 → 退出屏障提示 → 托盘驻留语义。断言走 xterm 可访问性/文本层，不依赖 canvas 像素。跑全仓 test / typecheck / 实跑全部终端相关 e2e 收口，更新 notes.md 中已漂移的指针。文件指针见 notes.md §7。

**Blocked by:** 05, 06, 07, 08。

**Status:** ready-for-agent

- [ ] 终端 e2e 场景文件落地并全绿（真 pty、覆盖上述全部路径）
- [ ] 既有 e2e 场景回归（rail 结构变化影响的场景：rail 相关 + focus 相关）
- [ ] 全仓 test / typecheck 绿（desktop 与 ui，含 agent-core build 前置）
- [ ] notes.md 指针校准（本票链合入后的符号漂移修正）
- [ ] 票面 Comments 记录最终基线（用例数、场景清单）

## Comments

- 【02 票衔接】dev 目录模式 e2e 前置 `pnpm --filter @codexlike/desktop run build`（mtime 守卫会拦旧产物）；node-pty prebuild 兼容本机 Electron，worktree `pnpm install --frozen-lockfile` 即可（allowBuilds 已放行 node-pty 安装脚本）。打包模式 ABI/vendor 已被 dist.mjs + extraResources 覆盖，冷启动可用 `smoke:pty` 复验。
- 【02 票衔接】终端 e2e 的输入注入走渲染端 xterm → IPC write 链路，**不直碰 node-pty**；kill 后子进程树死透如需断言，参照冒烟的 tasklist 精确查询法（票02 Comments）。
- 【既有基线】02 落地后 desktop 532 用例 / 1 skipped；ui 623；agent-core 625——回归对照用。已知既有损坏：subagent-interrupted e2e 在 main HEAD 即失败（与终端无关，勿在本票链顺手修，单独诊断）。
- 【03 票衔接】desktop build 已实跑、dist/main.cjs 可加载 node-pty（external 路径不变）；e2e 断言可用的通道清单与 preload API 见 03 票 Comments（`window.codexlike.terminals` + `onTaskEvent` 信封的 terminal-started/exited）；事件三任务态（idle/终态/stopped）下发行为已被单测覆盖，e2e 聚焦 GUI 链路。
