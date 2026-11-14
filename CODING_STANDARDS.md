# 编码标准

供 code-review 的 Standards 轴执行。

## E2E 定位器

E2E（`packages/desktop/e2e/*.mjs`）中的元素定位按用途收口（`pnpm check:e2e-locators` 拦截，pre-commit 运行）：

- **交互控件**（按钮/输入/链接，用于 click/fill/hover）：优先 `getByTestId('[data-testid]')`（组件已大量标注，如顶栏 `settings-open` / `settings-back`）；同页可能重复的控件（如设置页多个「保存」、含「模型」子串的多个 label），先 `locator('form')` / 容器限定再定位。**禁止根级裸 `getByRole('button', { name })`**——Playwright strict mode 下的多命中是本仓库已发生四次的回归来源。
- **内容断言**（消息正文/状态文本，用于 waitFor/断言，不用于交互）：允许根级 `getByText`，但必须显式处理多命中——`.first()` / `.nth()` / `{ exact: true }` / `.count()` 判定四者其一（多命中未处理会在 strict mode 直接报错暴露，加了其一则是显式选择）。
- **容器识别例外**：`locator('section').filter({ has: getByRole('heading', { name, exact: true }) })` 形式允许——heading 是文档语义结构（h2/h3 天然 aria 可达），exact 防子串，且 filter 参数不参与点击，不存在 strict mode 点错元素的风险。

链式限定（`form.getByRole` / `card.getByText`，定位挂在容器上）不受限；「根级」指直接挂在 `window` 根 locator 上。

豁免清单（见 `scripts/check-e2e-locators.mjs`）：`helpers.mjs` / `launch-target.mjs`（共享工具，无场景定位）；`projects-sidebar` / `interactions` / `exit-recovery` / `sidebar-archive`（flaky 治理分支收口，避免两分支碰撞）。新场景不得进豁免。

## 数据目录自建

落盘到用户数据目录（`dataDir()` / 任务 workspace / 临时目录）的组件，打开或写文件前自己 `mkdirSync(dirname(path), { recursive: true })`，不假设调用方已建目录（先例：`json-file.ts`、`write-file.ts`、`apply-patch.ts`、`worktree-service.ts`）。

测试必须覆盖「父目录不存在」分支：E2E 以 `mkdtempSync` 预建 `CODEXLIKE_HOME` 的习惯会掩盖该分支——2026-11-11 打包黑屏事故中 `createSqliteSessionStore` 未建 `~/.codexlike`，11 条 E2E 全绿仍黑屏，靠 `test:e2e:packaged` 冷启动冒烟兜底。

## 拆分提交（partial-staged）

同一文件混两批改动、只提交其中一批时，lint-staged 在「恢复未暂存改动」一步失败并整体 revert——工具边界，不是格式问题。流程：对 staged 内容先跑 `prettier --check` 确认格式，再 `git commit --no-verify`；能整文件提交就拆开两批先后提交，避免 partial-staged（2026-11-11 项目侧栏拆分提交踩此坑）。
