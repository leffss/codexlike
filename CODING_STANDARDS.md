# 编码标准

供 code-review 的 Standards 轴执行。

## E2E 定位器

E2E（`packages/desktop/e2e/*.mjs`）中的元素定位一律二选一：

- 优先 `getByTestId('[data-testid]')`（组件已大量标注）；
- 同页可能重复的按钮/label（如设置页多个「保存」、含「模型」子串的多个 label），先 `locator('form')` 限定所在表单再定位。

裸 `getByRole('button', { name })` 与 `getByLabel('子串')` 在 Playwright strict mode 下的多命中是本仓库已发生四次的回归来源。

## 数据目录自建

落盘到用户数据目录（`dataDir()` / 会话 workspace / 临时目录）的组件，打开或写文件前自己 `mkdirSync(dirname(path), { recursive: true })`，不假设调用方已建目录（先例：`json-file.ts`、`write-file.ts`、`apply-patch.ts`、`worktree-service.ts`）。

测试必须覆盖「父目录不存在」分支：E2E 以 `mkdtempSync` 预建 `CODEXLIKE_HOME` 的习惯会掩盖该分支——2026-11-11 打包黑屏事故中 `createSqliteSessionStore` 未建 `~/.codexlike`，11 条 E2E 全绿仍黑屏，靠 `test:e2e:packaged` 冷启动冒烟兜底。
