# 02: 提示条 toast 化

**What to build:** 原消息流上方的五类常驻横条（工作现场保存失败、已保存模型配置不可用、上下文用量告警、工作区共享提示、自动批准状态）改为右下角 toast 浮出——多条堆叠、可手动关闭，完全不占布局行。toast 为渲染层内存态，不持久化。相关 testid 与 e2e 场景同票联动。

**Blocked by:** 01

**Status:** done

**Status:** ready-for-agent

- [x] 五类提示全部迁为右下角 toast，消息流上方不再渲染任何常驻横条
- [x] 多条提示同时出现时堆叠展示，一条不漏
- [x] 每条 toast 可手动关闭
- [x] toast 为渲染层内存态，重启后无残留（不持久化）
- [x] 相关 testid/e2e 联动更新且通过（链内相关场景）
- [x] 定位器检查脚本通过

## Comments

### 2026-11-14 实现（分支 ui-redesign-t02，基于 a384828）

**改了什么**

- 新增 `packages/ui/src/lib/toast-state.ts`：toast 管理器（`createToastManager`），workspace-state.ts 同款 observable 工厂风格（`subscribe`/`version` + Map 保序快照）。语义：`show` 幂等 upsert（同 testId 更新不重复堆叠）、`dismiss` 手动关闭（记内容指纹，状态持续期间同内容不复活）、`retract` 状态消失撤除（清除 dismissed 记录，状态重现须重新提示）。内存态、不持久化。
- 新增 `packages/ui/src/components/ToastHost.tsx`：右下角浮层（原型变体 D 参数：`fixed bottom-20 right-6 z-30`、`max-w-sm`、圆点 + 关闭按钮），外观全走现有语义 token（warn/danger/info 三档，error→role=alert、其余 role=status），每条带 `<id>-close` 关闭按钮。原横条 testid 落在 toast 条目上（`workbench-save-error` / `unavailable-profile` / `context-warning` / `workspace-sharing-notice` / `task-auto-approve`），共享提示的 warning/error 子 testid 经 contentTestId 沿用，e2e 嵌套定位不变。
- 新增 `packages/ui/src/lib/workspace-sharing.ts`：`useWorkspaceSharing(target)` hook，原 WorkspaceSharingNotice 的订阅逻辑迁入（target 为 null 不检查）；`WorkspaceModeControl.tsx` 中该组件删除。
- `WorkspacePage.tsx`：五类横条 JSX 全部删除（消息流上方不再渲染任何常驻横条，中列直接从标题栏下开始），改为五个状态同步 effect（状态在→toast 在、状态消失→retract）+ 根部渲染 ToastHost；`refreshContextWarning` 直接推 toast；自动批准 toast 带撤销按钮（detail/取消中…/失败 alert 全保留，onAction 读 ref 防切换任务后撤错）。
- 删除 `TaskAutoApproveStatus.tsx` 及其组件测试（外部行为并入 ToastHost 测试）。
- `packages/desktop/e2e/worktree.mjs`：四处断言措辞从「底部提示容器」更新为 toast，断言本身无需改（状态驱动存活，detached/waitFor 语义不变）。

**测试与结果（均为直接运行取退出码）**

- vitest（ui 包全量）：32 文件 299 测试全绿；新增 `tests/toast-state.test.ts`（8 用例：堆叠保序/幂等更新/内存态/dismiss 不复活/内容变化复活/retract 重现/retract 清 dismissed/subscribe-version）与 `tests/toast-host-ui.test.tsx`（6 用例：空不渲染/堆叠+role/关闭透传/kind 语义 token/contentTestId/操作与说明段），先红后绿。
- typecheck（ui 包）：通过。
- eslint（全仓库）：0 问题。
- e2e 单场景：`pnpm test:e2e:worktree`、`pnpm test:e2e:interactions`（含 auto-approve 子场景）、`pnpm test:e2e:width`、`pnpm --filter @codexlike/desktop run test:e2e`（smoke 冒烟）全部退出码 0。
- `node scripts/check-e2e-locators.mjs`：OK（35 场景无根级裸定位）。

**遗留风险**

- 全量 e2e 链（33 链内 + 链外）未跑，留给票 05 终验；本票只跑了相关场景。
- toast 手动关闭后在同一状态持续期内不复活（同内容）；若产品期望「状态仍在时关闭后仍要以更弱形式可见」，需另立票讨论。

### 2026-11-14 merge ui-redesign（票03 已入集成）

集成分支 tip e1d0d4f（票03 overlay 抽屉）并入本分支：WorkspacePage.tsx 一处冲突
（票03 在 MessageStream 外包 overlay 定位容器且基于票01 保留了五类横条），合并结果
为「票03 容器结构 + 票02 横条删除」，merge commit 3a0e0df（pre-commit 钩子全过）。
merge 后重跑：ui 包 vitest 33 文件 304 用例全绿、typecheck 通过、e2e
worktree / interactions / width 退出码 0。
