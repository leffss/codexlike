# 04: 窗口底线 + 现代化视觉统一

**What to build:** 主进程窗口配置补 minWidth/minHeight（此前无底线）；在 01–03 完成的新布局上按定稿变体 D 做视觉统一走查——密度、圆角、留白、层次在语义 token 体系内微调（不推翻主题架构、不引入组件库），1280×800 默认窗口下各区域不挤压、不换行错位，浅色/深色双主题核对。

**Blocked by:** 02, 03

**Status:** done

**Status:** ready-for-agent

- [x] BrowserWindow 设 minWidth/minHeight，小于底线的尺寸被阻止（存储的越界恢复值被夹紧）
- [x] 1280×800 默认窗口下 D 布局各区域不挤压、不换行错位
- [x] 密度/圆角/留白按 D 变体统一（token 体系内微调），light/dark 双主题核对
- [x] theme 场景通过，无回归

## Comments

### 实现（ui-redesign-t04，2026-11-14）

**A. 窗口底线**

- min 取值 **1000×600**（`packages/desktop/src/launch-state/display-geometry.ts` 的 `MIN_WINDOW_SIZE`，唯一来源），取值理由：
  - **宽度 1000**：标题栏左右区不可压缩内容的容纳度——左区（CodexLike › 任务名 + 「项目 · 本地/Worktree」徽章 + 搜索任务开关）约 340px，右区 nav（两面板开关 + 主题 + 设置 + 窗口控制）约 342px，加 `px-4`×2 与 gap 约 740px 绝对底线，任务名还有 `max-w-80` 截断与 `task-title ≥ 40px`（width-tiers 断言）的余量；中列容器 = 1000 − 288（左栏 w-72）= 712px，composer 卡 728px 容得下底部工具栏一行（约 560px 需求）不换行；抽屉 60% 上限下 427px 可用。与既有窄窗基线（task-search / sidebar-archive 的 1000）一致。
  - **高度 600**：标题栏约 44px + composer 区约 116px（min-h-11 输入行 + 工具栏 + py-3）+ 消息流最小可读约 400px + 余量；草稿收纳行出现时消息流约 360px 仍可读。
- 接线（`packages/desktop/src/main.ts`）：`BrowserWindow` 构造项补 `minWidth`/`minHeight` = `MIN_WINDOW_SIZE`；启动现场恢复 `resolveLaunchBounds` 缺省 `minSize` 即同一常量——**恢复路径显式夹紧**，不依赖 Electron 运行时行为（实测 Electron 45 对程序化 `setContentSize`/`setSize`/`setBounds` 也会按 minWidth/minHeight 夹紧，作为用户拖拽侧的运行时兜底）。
- TDD：`tests/launch-state/display-geometry.test.ts` 新增 2 例（默认 minSize 把 400×200 恢复值夹到字面量 1000×600、`MIN_WINDOW_SIZE` 与窗口底线同值），先红（clamp 到 400×300）后绿。
- e2e `launch-state.mjs`：新增场景 **⑦ 存储越界恢复值夹紧**（预写 400×200 现场 → 恢复为 1000×600 位置保留；再程序化 `setContentSize(400,200)` 断言 getContentSize ≥ 底线）；场景②③④⑤ 预写尺寸从 900×640 / 960×600 提到底线之上（1080×640 / 1024×640），位置恢复语义不变；README 表 26 行同步。
- **压线余量实测**：minWidth 边界上 `setContentSize(1000)` 因夹紧 + DPI 取整实际 content 为 1001~1002（±2 容差被吃满），故既有场景中压线的精确断言基线统一抬到线外：
  - `width-tiers.mjs`：窄档 1000 → **1060**（保持 <1088 使抽屉仍命中 60% 上限语义；场景5 / 抽屉循环 / 档位循环三处 + 注释）；
  - `task-search.mjs`（1000 → 1100）、`sidebar-archive.mjs`（setSize 1000 → 1100）；
  - `window-controls.mjs`（640×640 → 1100×640）、`message-order.mjs`（900×720 → 1100×720）、`thinking.mjs`（640×500 → 1100×640）、`interactions.mjs`（640×700 → 1100×700）——四处「窄窗鲁棒性」语义在底线之上继续成立，均有票04 注释。
  - 未动：`width-tiers` 的 1280×600（无数值断言）、`sidebar-archive` 的 `setSize(width-20)`（原尺寸远大于底线）。

**B. 视觉统一走查（对照原型变体 D + sample-content.tsx，1280×800，light/dark）**

逐面核对结果（截图走查，throwaway 脚本真实运行取证，10 张）：

1. **标题栏任务上下文**（`Header` + `TitlebarTaskContext`）：`px-4 py-2`、品牌 `text-sm font-semibold`、`›` 分隔、任务名截断、徽章 chip（`rounded border border-line bg-surface px-2 py-0.5 text-xs` + hover accent）、面板开关/主题/设置/窗口控制 nav `gap-1`——与 D 逐类一致，**无偏差**；无任务回退品牌展示（D 原型无此形态，沿用票01 语义）。
2. **ToastHost**：`rounded-lg` + 三档语义边框/底色/文字 + 状态圆点 + `shadow-lg` + `max-w-sm` + 右下 `bottom-20 right-6` 堆叠 `gap-2`——与 D 逐类一致，**无偏差**；error toast 在 light/dark 下实测（截图 09/10）。
3. **PanelsDrawer**：`w-[30rem] max-w-[60%]`、`shadow-2xl`、tab 头 active `border-b-2 border-accent font-medium text-fg` 下划线态、非 active muted、`w-9` × 关闭、标题栏开关高亮同步——与 D 逐类一致，**无偏差**；两 tab × 双主题实测（04/05/07/08）。
4. **composer 区**：卡 `rounded-2xl border bg-surface shadow-lg focus-within:border-fg-muted`、textarea `px-4 pt-3 pb-1 min-h-11`、工具栏 `px-3 pb-2.5`、圆形实心发送/停止按钮、菜单 `rounded-xl shadow-xl`——与 D 逐类一致，**无偏差**。
5. **QueueBar（唯一偏差，已收敛）**：原 `rounded-xl bg-surface` 与 D 队列条（`rounded-lg` + `bg-surface-muted` 次级面）不符 → 改为 `rounded-lg bg-surface-muted`，与 composer 卡主面形成层次对比（截图 03）；交互结构不动。
6. 双主题：token 整体翻转，深色下标题栏/抽屉/toast/composer/队列条无对比度异常、无残浅色块；1280×800 下各区域无挤压、无换行错位。

**测试与运行结果（均直接运行取退出码）**

- 单测：`pnpm test` 全仓 1005 例（agent-core 434 + desktop 267 + ui 304）全过（exit 0）；`pnpm typecheck`、`pnpm lint`、`pnpm check:adr`、`node scripts/check-e2e-locators.mjs`（35 场景文件无根级裸定位）全过（exit 0）；改动文件 `pnpm prettier --check` 过。
- e2e（`pnpm build` 后逐个跑，全过，exit 0）：launch-state（含新场景⑦）、theme、width-tiers（重基线）、window-controls（重基线）、interactions / message-order / thinking（重基线）、task-search、sidebar-archive、input-queue / input-queue-items / input-queue-pause / input-queue-composer / input-queue-restart（QueueBar 改动面）、worktree（toast 联动面）。
- 未跑全链（票 05 终验）。

**遗留风险**

- minWidth 边界（1000）附近程序化 resize 有 ±2px 的 DPI 取整波动——已把所有精确断言移到线外；后续新增场景避免用 1000/600 作断言基线。
- 抽屉内两面板底色不同（resources surface-muted / changes surface）为面板本体既有语义（票03 零改动约定），走查确认双主题可读，未强行统一。
