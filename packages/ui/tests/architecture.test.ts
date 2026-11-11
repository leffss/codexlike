import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ADR-0003 守卫：ui（浏览器环境）不引入 agent-core 的 ./node 出口
function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? collectSourceFiles(full)
      : /\.(ts|tsx)$/.test(full)
        ? [full]
        : [];
  });
}

describe("架构守卫（ADR-0003：ui 不引入 agent-core 的 ./node 出口）", () => {
  it("src 内不出现 @codexlike/agent-core/node 的 import", () => {
    const srcDir = join(import.meta.dirname, "..", "src");
    const offenders = collectSourceFiles(srcDir).filter((f) =>
      /@codexlike\/agent-core\/node/.test(readFileSync(f, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
