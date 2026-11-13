/**
 * 任务名 → `codexlike/<任务名>` 分支名（spec「git 集成」）。
 * 纯字符串函数（浏览器安全，主出口导出）：UI 可预览分支名，主进程用它创建分支。
 * git ref 名约束（git-check-ref-format）：不允许空格与 `~^:?*[\`、控制字符、
 * `..`、`@{`、首尾 `/.`、结尾 `.lock`。
 */

/** 分支名中 slug 部分的长度上限 */
const MAX_SLUG_LENGTH = 48;

/** 任务名中 git 分支不允许的字符（含空格与常见全角空格） */
const ILLEGAL_CHARS = /[\s~^:?*[\]\\]/g;

export function codexlikeBranchName(sessionTitle: string): string {
  let slug = sessionTitle
    .replace(ILLEGAL_CHARS, "-")
    .replace(/\.\./g, "-") // git 不允许 ..
    .replace(/@{/g, "-") // git 不允许 @{
    .replace(/\/{2,}/g, "/") // git 不允许连续 /
    .replace(/-{2,}/g, "-") // 压缩重复连字符
    .slice(0, MAX_SLUG_LENGTH)
    // 去掉首尾 git 不允许的字符（/ 与 .）与首尾连字符（替换产物，观感更干净）
    .replace(/^[/.-]+|[/.-]+$/g, "");
  if (slug.endsWith(".lock")) {
    slug = slug.slice(0, -".lock".length);
  }
  if (slug === "") {
    slug = "session";
  }
  return `codexlike/${slug}`;
}
