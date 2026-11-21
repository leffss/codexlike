# 09: e2e 场景套件 + 全量集成验证

**What to build:** 终端特性的 e2e 收口与全仓集成验证。新增终端 e2e 场景（真 node-pty）：新建会话 → 手敲命令输出可见 → agent 侧 spawn / read / write（含审批弹窗路径）→ kill → 重启后快照回看 → 退出屏障提示 → 托盘驻留语义。断言走 xterm 可访问性/文本层，不依赖 canvas 像素。跑全仓 test / typecheck / 实跑全部终端相关 e2e 收口，更新 notes.md 中已漂移的指针。文件指针见 notes.md §7。

**Blocked by:** 05, 06, 07, 08。

**Status:** ready-for-agent

- [ ] 终端 e2e 场景文件落地并全绿（真 pty、覆盖上述全部路径）
- [ ] 既有 e2e 场景回归（rail 结构变化影响的场景：rail 相关 + focus 相关）
- [ ] 全仓 test / typecheck 绿（desktop 与 ui，含 agent-core build 前置）
- [ ] notes.md 指针校准（本票链合入后的符号漂移修正）
- [ ] 票面 Comments 记录最终基线（用例数、场景清单）
