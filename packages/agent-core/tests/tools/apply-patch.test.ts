import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApplyPatchTool } from "../../src/tools/apply-patch";
import type { ToolExecutionContext } from "../../src/tools/types";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "codexlike-ws-"));
}

function context(workspacePath: string): ToolExecutionContext {
  return {
    workspacePath,
    taskId: "unit-test-task",
    approvalMode: "assist",
  };
}

const tool = createApplyPatchTool();

describe("apply_patch 工具", () => {
  it("上下文行精确匹配：修改成功且文件真实落盘", async () => {
    const workspace = makeWorkspace();
    writeFileSync(
      join(workspace, "calc.ts"),
      "export function add(a: number, b: number) {\n  return a + b;\n}\n",
      "utf8"
    );

    const patch = [
      "*** Begin Patch",
      "*** Update File: calc.ts",
      " export function add(a: number, b: number) {",
      "-  return a + b;",
      "+  return a + b + 0;",
      " }",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(false);
    expect(result.output).toContain("calc.ts");
    expect(readFileSync(join(workspace, "calc.ts"), "utf8")).toBe(
      "export function add(a: number, b: number) {\n  return a + b + 0;\n}\n"
    );
  });

  it("上下文失配：拒绝应用，错误含期望行、文件实际相近行与重试提示，文件保持原样", async () => {
    const workspace = makeWorkspace();
    const original = 'def greet():\n    print("hello world")\n';
    writeFileSync(join(workspace, "hello.py"), original, "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.py",
      " def greet():",
      '-    print("hello")',
      '+    print("hi")',
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(true);
    // 可读原因：期望内容 + 实际相近行 + 重试指引（模型可据此自我纠正）
    expect(result.output).toContain("hello.py");
    expect(result.output).toContain('print("hello")');
    expect(result.output).toContain('print("hello world")');
    expect(result.output).toContain("read_file");
    // 文件未被改动（拒绝是原子的）
    expect(readFileSync(join(workspace, "hello.py"), "utf8")).toBe(original);
  });

  it("纯新增行没有上下文/删除行：拒绝（无法定位）", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "a.txt"), "one\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "+two",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("上下文");
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("one\n");
  });

  it("同一文件多个补丁块按顺序应用", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "list.txt"), "a\nb\nc\nd\ne\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: list.txt",
      "@@",
      " a",
      "-b",
      "+B",
      "@@",
      " d",
      "-e",
      "+E",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(false);
    expect(readFileSync(join(workspace, "list.txt"), "utf8")).toBe(
      "a\nB\nc\nd\nE\n"
    );
  });

  it("Add File：新建文件（含父目录）；目标已存在则拒绝", async () => {
    const workspace = makeWorkspace();
    const patch = [
      "*** Begin Patch",
      "*** Add File: docs/new.md",
      "+# 标题",
      "+正文",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(false);
    expect(readFileSync(join(workspace, "docs", "new.md"), "utf8")).toBe(
      "# 标题\n正文\n"
    );

    const again = await tool.execute({ patch }, context(workspace));
    expect(again.isError).toBe(true);
    expect(again.output).toContain("已存在");
  });

  it("Delete File：删除成功；不存在拒绝", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "old.txt"), "x", "utf8");

    const del = await tool.execute(
      { patch: "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch" },
      context(workspace)
    );
    expect(del.isError).toBe(false);
    expect(existsSync(join(workspace, "old.txt"))).toBe(false);

    const missing = await tool.execute(
      { patch: "*** Begin Patch\n*** Delete File: ghost.txt\n*** End Patch" },
      context(workspace)
    );
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("不存在");
  });

  it("多文件补丁：任一文件失配则整体不应用（原子性）", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "a.txt"), "aaa\n", "utf8");
    writeFileSync(join(workspace, "b.txt"), "bbb\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      " aaa",
      "-bbb",
      "+ccc",
      "*** Update File: b.txt",
      " bbb",
      "-zzz",
      "+yyy",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(true);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("aaa\n");
    expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("bbb\n");
  });

  it("格式非法（缺 Begin/End、段外杂行）拒绝并说明原因", async () => {
    const workspace = makeWorkspace();
    const noBegin = await tool.execute(
      { patch: "*** Update File: a.txt\n-x\n+y" },
      context(workspace)
    );
    expect(noBegin.isError).toBe(true);
    expect(noBegin.output).toContain("Begin Patch");

    const junk = await tool.execute(
      { patch: "*** Begin Patch\n随便一行\n*** End Patch" },
      context(workspace)
    );
    expect(junk.isError).toBe(true);
  });

  it("工作区外的文件操作被拒", async () => {
    const workspace = makeWorkspace();
    const patch = [
      "*** Begin Patch",
      "*** Add File: ../escape.txt",
      "+x",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("路径越界");
  });

  it("修改不存在的文件：提示先确认文件与上下文", async () => {
    const workspace = makeWorkspace();
    const patch = [
      "*** Begin Patch",
      "*** Update File: nope.txt",
      " context",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute({ patch }, context(workspace));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("nope.txt");
  });
});
