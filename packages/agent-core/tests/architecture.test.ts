import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ADR-0002 守卫：agent-core 不依赖 Electron
function collectTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? collectTsFiles(full)
      : full.endsWith(".ts")
        ? [full]
        : [];
  });
}

describe("架构守卫（ADR-0002：agent-core 零 Electron 依赖）", () => {
  it("src 内不出现 electron 的 import/require", () => {
    const srcDir = join(import.meta.dirname, "..", "src");
    const offenders = collectTsFiles(srcDir).filter((f) =>
      /from\s+['"]electron|require\(\s*['"]electron/.test(
        readFileSync(f, "utf8")
      )
    );
    expect(offenders).toEqual([]);
  });
});
