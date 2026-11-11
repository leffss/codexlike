# 编码标准

供 code-review 的 Standards 轴执行。

## E2E 定位器

E2E（`packages/desktop/e2e/*.mjs`）中的元素定位一律二选一：

- 优先 `getByTestId('[data-testid]')`（组件已大量标注）；
- 同页可能重复的按钮/label（如设置页多个「保存」、含「模型」子串的多个 label），先 `locator('form')` 限定所在表单再定位。

裸 `getByRole('button', { name })` 与 `getByLabel('子串')` 在 Playwright strict mode 下的多命中是本仓库已发生四次的回归来源。
