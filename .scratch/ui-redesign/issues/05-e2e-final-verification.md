# 05: e2e 全量链终验 + 收尾

**What to build:** 01–04 全部落地后的整体验收：全量 e2e 链（链内 33 场景）跑绿，链外场景（packaged + 输入队列 4）通过，packaged 冷启动断言更新为新布局；README e2e 场景表与脚本登记同步；原型分支指针记入票档。

**Blocked by:** 01, 02, 03, 04

**Status:** done

- [x] test:e2e:all 全量链（33 场景）全绿
- [x] 链外场景（packaged + 输入队列 4）通过；packaged 冷启动断言反映新布局
- [x] README e2e 场景表与 desktop/root 脚本登记同步
- [x] 原型分支指针（prototype/ui-redesign）与定稿结论记入本票 Comments
- [x] 定位器检查与 ADR 检查脚本全部通过

## Comments

### 终验（ui-redesign-t05，2026-11-14，提交 5fca2b3）

**全链结果（均直接运行取退出码）**

- `pnpm test:e2e:all`（链内 33 场景，先 build 再按链序）：首轮在场景 15 membership 暴露一处编排冲突（见修复清单），修复后重跑全链 **33 场景全绿（exit 0，无任何失败标记）**。
- 链外：`packaged`（pnpm dist 后）+ input-queue / input-queue-items / input-queue-pause / input-queue-composer / input-queue-restart **6 场景全绿（exit 0）**。链外输入队列实为 5 个（票04 曾加 restart），票面「4 个」以实际登记为准，全部跑过。
- `node scripts/check-e2e-locators.mjs`（35 场景文件）、`pnpm check:adr`、`pnpm lint`、prettier --check（改动文件）全过（exit 0）；commit 时 pre-commit 钩子全套（prettier / check:adr / check-e2e-locators / typecheck / 全仓 vitest）亦过。

**修复清单（1 项，测试编排问题，非产品缺陷）**

- **membership.mjs（场景 15）**：搜索面板打开时悬浮操作 `project-remove` 不可命中，稳定复现（非 flaky）。根因：票01 将 TaskSearch 迁入标题栏左区后，384px 搜索浮层（实测 x 253–637、y 45–236，z-20）恰好盖住左栏顶部 project-header 右端悬浮操作区（`project-remove` x 255–275、y 134–154），`elementFromPoint` 命中面板（一次性探针取证后删除）；旧布局面板锚在中列任务头行、不盖侧栏，故此冲突首次在全链暴露。判定：下拉浮层覆盖下层内容是标准交互（关面板即可操作），非产品缺陷，不改产品代码。修复编排：移除项目前先收起面板；移除后重开搜索（query 跨开合保留、`open` 变化自动重查）以状态行「没有匹配的任务」验证结果随项目移除消失——结果列表由实时状态派生，产品语义与原「面板开着时结果即时消失」断言一致。

**packaged.mjs 冷启动断言变更（原冒烟链保留，全部为追加）**

- 票01 标题栏任务上下文：草稿态标题栏回退品牌展示（`task-title` / `workspace-badge` 不渲染），`task-search-toggle` 落在 `window-titlebar` 内（搜索随迁标题栏）。
- 票01 无 workspace-info：`workspace-path` 全页唯一且只在 `draft-workspace-info` 就地收纳行内（正式任务态常驻行保持取消的负断言）。
- 票02 新 toast：`toast-region` 冷启动不渲染（提示条内存态、无残留）。
- 票03 抽屉：草稿态两面板开关禁用（无面板入口）、抽屉 tab 头不渲染。
- 保留原断言：窗口出现、数据目录自建、SQLite 落盘、侧栏入口、独立草稿默认工作区、无空历史、approval 默认 ask、无 tasks 目录、无旧库。

**登记核对（本 feature 未新增场景名）**

- 三处登记一致：desktop `package.json` 脚本 + `test:e2e:all` 链序 33 项 + README 链内表 33 行逐一对应；链外 6 场景两处 package.json 均有同名脚本。
- 补记一处遗漏：README 链外表缺 `input-queue-restart` 行（票04 引入场景时两处 package.json 已登记、漏更 README），已补；`packaged` 行断言要点随新布局更新。
- launch-state 场景⑦（票04 存储越界恢复值夹紧）确认已在三处登记（链内 #26）。

**原型定稿结论**

- 原型 primary source：分支 `prototype/ui-redesign`（abf070e），胜者变体 D（`packages/ui/src/prototype/variants/variant-d.tsx`：标题栏 + overlay 抽屉 + toast 骨架与观感参数）已由票01–04 重写进真实代码（TitlebarTaskContext / ToastHost / PanelsDrawer / composer 卡 / QueueBar 次级面），原型仅作 throwaway 参照、未搬静态样例；本票按其定稿形态完成全量 e2e 验收，feature 到此收尾。
