import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { listWorkspaceFiles } from "../../src/tasks/workspace-files";

/** 工单 07：@引用 菜单的工作区文件枚举 */
const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "codexlike-files-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("listWorkspaceFiles（@引用 候选枚举）", () => {
  it("递归返回相对路径（POSIX 分隔符），按路径排序", () => {
    const ws = workspace();
    writeFileSync(join(ws, "README.md"), "r");
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "app.ts"), "a");
    mkdirSync(join(ws, "docs"), { recursive: true });
    writeFileSync(join(ws, "docs", "指南.md"), "g");

    expect(listWorkspaceFiles(ws)).toEqual([
      "README.md",
      "docs/指南.md",
      "src/app.ts",
    ]);
  });

  it("跳过 node_modules / .git / dist 等目录", () => {
    const ws = workspace();
    writeFileSync(join(ws, "keep.txt"), "k");
    mkdirSync(join(ws, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(ws, "node_modules", "pkg", "i.js"), "i");
    mkdirSync(join(ws, ".git"));
    writeFileSync(join(ws, ".git", "config"), "c");
    mkdirSync(join(ws, "dist"));
    writeFileSync(join(ws, "dist", "out.js"), "o");

    expect(listWorkspaceFiles(ws)).toEqual(["keep.txt"]);
  });

  it("条数超过上限（2000）时截断，不无限枚举大仓库", () => {
    const ws = workspace();
    for (let i = 0; i < 2100; i += 1) {
      writeFileSync(join(ws, `f${String(i).padStart(5, "0")}.txt`), "");
    }
    const files = listWorkspaceFiles(ws);
    expect(files.length).toBe(2000);
  });

  it("不存在的工作区目录返回空数组", () => {
    expect(listWorkspaceFiles(join(workspace(), "not-exist"))).toEqual([]);
  });
});
