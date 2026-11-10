/**
 * 菜单模糊匹配（纯函数，浏览器安全）。
 * 命令菜单（`/re` → rename）与 @引用文件菜单共用：
 * - 子序列匹配（query 字符按顺序出现即命中），大小写不敏感；
 * - 连续命中段更长的候选排在前面（输入 `md` 时 `x.md` 优先于 `README.md`）；
 * - 同分保持原序（稳定排序），空 query 返回全部。
 */

/** 返回最长连续命中段长度；query 非子序列时返回 null */
function matchScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let run = 0;
  let best = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      qi += 1;
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return qi === q.length ? best : null;
}

export function fuzzyMatch<T>(
  query: string,
  items: readonly T[],
  textOf: (item: T) => string = (item) => String(item),
): T[] {
  if (query === '') {
    return [...items];
  }
  return items
    .map((item, index) => ({
      item,
      index,
      score: matchScore(query, textOf(item)),
    }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
