/**
 * 任务标题 → `<类型>/<slug>` 分支名（spec「git 集成」）。
 * 纯字符串函数（浏览器安全，主出口导出）：UI 可预览分支名，主进程用它创建分支。
 * 约束（用户验收）：
 * - 不含中文：非 ASCII 无法安全进分支名（无音译），标题里的中文等非
 *   字母数字字符统一成组替换为单个连字符，剥完为空回退 `task`；
 * - 类型前缀启发：标题命中 bug/缺陷/故障 → `bug/`，命中 fix/修/错误/
 *   纠正/改正 → `fix/`，其余（含新增/重构/优化等一切未识别意图）→
 *   `feature/`；
 * - 整体 ≤50 字符（含前缀与斜杠，slug 上限随前缀长度浮动）。
 * git ref 名约束（git-check-ref-format）由「只保留 ASCII 字母数字与
 * 连字符」天然满足：空格、`~^:?*[\`、控制字符、`..`、`@{`、`_` 等都被
 * 替换掉，首尾连字符再清理。
 */

/** 分支名总长上限（含类型前缀与斜杠） */
const MAX_BRANCH_LENGTH = 50;

/** 标题命中即判 bug 类的关键词（优先于 fix 判定） */
const BUG_KEYWORDS = /bug|缺陷|故障/i;
/** 标题命中即判 fix 类的关键词 */
const FIX_KEYWORDS = /fix|修|错误|纠正|改正/i;

/** 标题 → 类型前缀（bug/fix/feature） */
function branchPrefix(taskTitle: string): "feature" | "fix" | "bug" {
  if (BUG_KEYWORDS.test(taskTitle)) return "bug";
  if (FIX_KEYWORDS.test(taskTitle)) return "fix";
  return "feature";
}

export function taskBranchName(taskTitle: string): string {
  const prefix = branchPrefix(taskTitle);
  // 非 ASCII 字母数字（中文、空格、标点、非法字符）成组替换为单个连字符，
  // 并统一小写（分支名惯例）
  let slug = taskTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[/.-]+|[/.-]+$/g, "")
    .slice(0, MAX_BRANCH_LENGTH - prefix.length - 1)
    // 截断可能切在连字符上，再清一次尾部
    .replace(/[/.-]+$/g, "");
  if (slug === "") {
    slug = "task";
  }
  return `${prefix}/${slug}`;
}
