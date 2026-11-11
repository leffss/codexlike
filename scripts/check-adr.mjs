// ADR 一致性检查：① docs/adr/ 编号无重复；② 全仓「ADR NNNN / ADR-NNNN」引用均有落盘文件。
// 起因（2026-11-11 双向踩）：ADR 0004 被代码与测试十余处引用却从未落盘；
// 新 ADR 按目录现状编号又与幽灵引用撞号。退出码非零即失败，供 pre-commit 使用。
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const adrDir = "docs/adr";
const files = readdirSync(adrDir).filter((name) => /^\d{4}-.*\.md$/.test(name));
const numbers = files.map((name) => Number(name.slice(0, 4)));

const duplicates = [
  ...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i)),
];
if (duplicates.length > 0) {
  console.error(`[check-adr] 编号重复：${duplicates.join(", ")}`);
  process.exit(1);
}
const existing = new Set(numbers.map((n) => String(n).padStart(4, "0")));

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((path) => /\.(ts|tsx|mjs|js|md)$/.test(path));

const missing = new Map(); // 引用编号 -> [文件]
const pattern = /\bADR[- ]?(\d{4})\b/g;
for (const path of tracked) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    continue; // 已删除但仍在 index 等罕见情况，交给后续命令报错
  }
  for (const match of content.matchAll(pattern)) {
    if (!existing.has(match[1]) && !missing.get(match[1])?.includes(path)) {
      const refs = missing.get(match[1]) ?? [];
      refs.push(path);
      missing.set(match[1], refs);
    }
  }
}

if (missing.size > 0) {
  const lines = [...missing.entries()].map(
    ([num, paths]) =>
      `[check-adr] ADR ${num} 被引用但 docs/adr/ 无此文件：${paths.slice(0, 3).join("、")}${paths.length > 3 ? " 等" : ""}`
  );
  console.error(lines.join("\n"));
  process.exit(1);
}
console.log(`[check-adr] OK：编号 ${existing.size} 篇无重复，全部引用有落盘`);
