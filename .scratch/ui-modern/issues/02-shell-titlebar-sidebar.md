# 02: 工作台外壳——标题栏 / 侧栏 / 窗口控制

**What to build:** 工作台 chrome 换 D 语言：标题栏去底色底边融入画布、按钮统一浅淡无边框；侧栏透明无色块、任务行 hover 浮现暖灰圆角底、当前任务用暖灰底+字重（非彩色胶囊）；项目分组、worktree/本地徽章、排队/运行/等待/未读徽章在暖色体系下一眼可辨；窗口控制按钮 hover 统一。

**Blocked by:** 01（token 基座）

**Status:** done

- [x] 标题栏（window-titlebar）融入画布：去底边框，任务上下文行/主题切换/设置/窗口控制统一浅淡样式
- [x] 侧栏透明底：任务行 hover 暖灰圆角底、选中态暖灰底+字重，重命名输入白底深描边
- [x] 全部徽章（worktree/排队/运行/等待用户/未读/项目计数）暖色下语义可辨
- [x] 分组折叠/右键菜单入口/任务搜索入口/归档区行为不变（只动样式）
- [x] ui 单测全绿
- [x] e2e 实跑绿：projects-sidebar / sidebar-archive / task-search / theme
- [x] dev 双主题走查截图留证

## Comments

**2026-11-19 实施记录（票02）**

改动（全部 className/注释级，零行为变化；原型 variant-d.css 第 1、2 节折回组件 Tailwind 类）：

1. `App.tsx` Header：标题栏去 `border-b border-line`、`bg-surface`→`bg-canvas`（融入画布）；主题切换/设置/返回按钮 `rounded`→`rounded-md`（6px 行·小钮圆角体系）。
2. `TitlebarTaskContext.tsx`：工作区徽章/打开器主·分裂钮去边框去底色（transparent+`hover:bg-hover`）；右栏开关展开态 `border-accent text-accent`→`bg-surface-muted font-semibold text-fg`（票 01 衔接注意 #2 的激活语汇：暖灰底+字重，非彩色描边）。
3. `WindowControls.tsx`：三枚按钮 `rounded-md`；**关闭钮 hover 由 `bg-danger-solid` 改 `hover:bg-hover`（与其他两枚及全部标题栏按钮统一暖灰，票面「窗口控制按钮 hover 统一」取严格解释——若 08 收尾觉得丢失「关闭=危险」暗示可回退，此为单点取舍）**。
4. `TaskSidebar.tsx`：aside 去 `border-r border-line`、`bg-surface-muted`→`bg-canvas`（透明融入）；当前任务行加 `font-medium`（bg-selected 已是暖灰 token）；任务行/组头按钮 `py-1.5`→`py-[7px]`（行高 32→34px，原型定案 ~34px，sidebar-archive e2e 的 `rowHeight<=34` 断言恰压线过）；重命名输入 `border-accent bg-code-bg`→`border-[1.5px] border-accent/55 bg-canvas`（浅色白底+黑 55% 描边=原型 rgba(47,52,55,0.55)；深色自动翻为主底+亮白 55% 描边，暖灰逻辑，产物 color-mix 已验证）。
5. `TaskActivityBadge.tsx`：仅注释更新（「accent 蓝」→「accent 主张色」——票 01 后 accent=黑/白主张，运行中转圈与消息流 generating-spinner 同源 var(--accent)，全局一致自动成立）。徽章色全部随票 01 token 暖化，无需改类。
6. `TaskSearch.tsx`：入口按钮 `rounded-md`（浮层本体归票 06 未动）。
7. `tests/titlebar-task-context.test.tsx`：基线遗留 className 断言迁移（`border-accent text-accent`→`bg-surface-muted font-semibold`，意图不变：展开态持久高亮 vs hover 类区分）——断言意图保留非新增。

验证（直接取退出码）：

- ui 单测 562 全绿（exit 0）；typecheck 0；build 0；build 产物含 color-mix 描边/`padding-block:7px`/`bg-surface-muted` 新规则。
- e2e 实跑：projects-sidebar 0 / task-search 0 / theme 0 / sidebar-archive **首跑 1 次「取消置顶恢复最近发送顺序」断言失败（点击后立即读 DOM 顺序的时序型），复跑两次全绿（exit 0）**——判定环境 flake 非本票所致（该断言读纯 DOM 顺序，与样式无关）。
- dev 双主题走查（vite 5176，IAB 实测）：computedStyle 逐项核验双主题全过——标题栏/侧栏 bg=canvas 且无边框线、当前行浅 rgba(55,53,47,0.09)/深 rgba(237,233,223,0.1)+字重 500+行高 34px、真实鼠标 hover 深色行出 rgba(237,233,223,0.06)、重命名输入浅白底黑 55%/深主底白 55% 描边 6px 圆角、worktree 紫/等待暖黄/运行黑·白主张徽章双主题可辨。截图 `.scratch/ui-modern/screenshots/02/light-workbench.png` / `dark-workbench.png`。**注意：AI 目视工具（analyze_image）对截图 CDN 签名 URL 持续 400 解析失败，本票走查以 computedStyle 硬证据为准（票 01 有 AI 目视误判教训，此路径更可靠）。**

给下游（08 收尾/其他票）的注意：

1. `WorkspaceBadgePopover`（workspace-popover）与 `workspace-opener-menu` 两个弹层本体未列入票 06 清单（06 只有 ModelThinkingSelect/ComposerSelect/TaskContextMenu/FullAccessConfirm/Membership/ToastHost/ApplicationExit/TaskSearch 浮层），本票按边界未动其 `border-line bg-surface shadow-xl` 旧语汇——**08 收尾请补：改弹层纪律（白卡+发丝线+`shadow-popover`），或 06 顺手带上**。
2. 关闭钮 hover 统一暖灰的取舍（见上 3），08 实机走查时可复核。
3. sidebar-archive e2e 的 `rowHeight<=34` 断言现恰压 34px：后续票若再增侧栏行内边距会红，注意留余量。

## Comments
