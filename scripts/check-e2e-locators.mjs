// E2E 定位器检查（CODING_STANDARDS.md「E2E 定位器」）：交互控件禁止根级裸
// getByRole（strict mode 多命中点错元素是本仓库已发生四次的回归来源）；
// 内容断言 getByText 必须显式处理多命中（first/nth/exact/count 四者其一）。
// 链式容器限定（form.getByRole / card.getByText）与 filter({ has: ... }) 参数位
// 的容器识别不在此列。退出码非零即失败，供 pre-commit 使用。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const e2eDir = join("packages", "desktop", "e2e");

// 豁免清单（文件级）：
// - helpers.mjs / launch-target.mjs：共享工具，无场景内元素定位；
// - projects-sidebar / interactions / exit-recovery / sidebar-archive：
//   正在另一分支治理 flaky，定位器收口交由该分支，避免两分支改动碰撞。
const EXEMPT_FILES = new Set([
  "helpers.mjs",
  "launch-target.mjs",
  "projects-sidebar.mjs",
  "interactions.mjs",
  "exit-recovery.mjs",
  "sidebar-archive.mjs",
]);

const violations = [];
const files = readdirSync(e2eDir).filter(
  (name) => name.endsWith(".mjs") && !EXEMPT_FILES.has(name)
);

for (const name of files) {
  const source = readFileSync(join(e2eDir, name), "utf8");
  // 根级定位：直接挂在 window / page 根 locator 上的 getByRole / getByText。
  // 链式（form.getByRole）前缀是别的变量名，天然不匹配。
  const rootPattern = /\b(window|page)\s*\.\s*(getByRole|getByText)\s*\(/g;
  for (const match of source.matchAll(rootPattern)) {
    const index = match.index;
    const line = source.slice(0, index).split("\n").length;
    const before = source.slice(Math.max(0, index - 40), index);
    // 容器识别例外：filter({ has: / hasNot: }) 参数位的定位（不点击、不多命中点击）
    if (/\bhas(?:Not)?:\s*$/.test(before)) continue;
    // 语句余部（到分号；跨行拼接），用于识别多命中显式处理
    const rest = source.slice(index, index + 500).split(";")[0];
    if (match[2] === "getByText") {
      if (/\.first\s*\(|\.nth\s*\(|exact:\s*true|\.count\s*\(/.test(rest))
        continue;
    }
    const snippet = rest.split("\n")[0].trim().slice(0, 60);
    violations.push(
      `[check-e2e-locators] ${name}:${line} 根级 ${match[2]} 裸定位：${snippet}`
    );
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  console.error(
    "[check-e2e-locators] 交互控件改 getByTestId 或容器限定；内容断言 getByText 需 first/nth/exact/count 之一（见 CODING_STANDARDS.md）"
  );
  process.exit(1);
}
console.log(
  `[check-e2e-locators] OK：${files.length} 个场景文件（另豁免 ${EXEMPT_FILES.size} 个）无根级裸定位`
);
