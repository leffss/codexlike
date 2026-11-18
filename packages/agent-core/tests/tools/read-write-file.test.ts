import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createReadFileTool } from "../../src/tools/read-file";
import { createWriteFileTool } from "../../src/tools/write-file";
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

describe("read_file 工具", () => {
  const tool = createReadFileTool();

  it("按「行号\\t内容」输出整个文件", async () => {
    const workspace = makeWorkspace();
    writeFileSync(
      join(workspace, "hello.txt"),
      "第一行\n第二行\n第三行\n",
      "utf8"
    );

    const result = await tool.execute(
      { path: "hello.txt" },
      context(workspace)
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe("1\t第一行\n2\t第二行\n3\t第三行\n");
  });

  it("offset/limit 分段读取（1 起始行号）", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "lines.txt"), "a\nb\nc\nd\ne\n", "utf8");

    const result = await tool.execute(
      { path: "lines.txt", offset: 2, limit: 2 },
      context(workspace)
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe("2\tb\n3\tc\n");
  });

  it("超出默认行数上限被截断并带标记", async () => {
    const small = createReadFileTool({ maxLines: 3 });
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "big.txt"), "1\n2\n3\n4\n5\n6\n7\n", "utf8");

    const result = await small.execute({ path: "big.txt" }, context(workspace));
    expect(result.isError).toBe(false);
    expect(result.output).toContain("1\t1\n");
    expect(result.output).toContain("3\t3\n");
    expect(result.output).not.toContain("4\t4");
    expect(result.output).toContain("[已截断：达到行数上限，当前显示第 1-3 行");
    expect(result.output).not.toContain("文件共");
  });

  it("offset 起点的截断标记区间正确", async () => {
    const small = createReadFileTool({ maxLines: 2 });
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "big.txt"), "1\n2\n3\n4\n5\n", "utf8");

    const result = await small.execute(
      { path: "big.txt", offset: 2 },
      context(workspace)
    );
    expect(result.output).toContain("[已截断：达到行数上限，当前显示第 2-3 行");
  });

  it("文件不存在返回可读错误（模型可据此改用其它工具）", async () => {
    const workspace = makeWorkspace();
    const result = await tool.execute({ path: "nope.txt" }, context(workspace));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("nope.txt");
    expect(result.output).toContain("不存在");
  });

  it("工作区外路径被拒（边界错误同样以 isError 返回）", async () => {
    const workspace = makeWorkspace();
    const result = await tool.execute(
      { path: "../secrets.txt" },
      context(workspace)
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("路径越界");
  });

  it("二进制文件（含 NUL 字节）拒绝读取", async () => {
    const workspace = makeWorkspace();
    writeFileSync(
      join(workspace, "blob.bin"),
      Buffer.from([0x4d, 0x5a, 0x00, 0x01])
    );

    const result = await tool.execute({ path: "blob.bin" }, context(workspace));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("二进制");
  });

  it("读取目录报错而不是崩溃", async () => {
    const workspace = makeWorkspace();
    mkdirSync(join(workspace, "pkg"));
    const result = await tool.execute({ path: "pkg" }, context(workspace));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("目录");
  });
});

describe("write_file 工具", () => {
  const tool = createWriteFileTool();

  it("写入新文件（自动创建父目录）并报告字节数", async () => {
    const workspace = makeWorkspace();
    const result = await tool.execute(
      { path: "src/lib/util.ts", content: "export const pi = 3.14;\n" },
      context(workspace)
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("src/lib/util.ts");
    // 真实文件系统断言：内容落盘
    const written = await import("node:fs").then((fs) =>
      fs.readFileSync(join(workspace, "src", "lib", "util.ts"), "utf8")
    );
    expect(written).toBe("export const pi = 3.14;\n");
  });

  it("覆盖已有文件", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "note.md"), "旧内容", "utf8");

    const result = await tool.execute(
      { path: "note.md", content: "新内容" },
      context(workspace)
    );
    expect(result.isError).toBe(false);
    const fs = await import("node:fs");
    expect(fs.readFileSync(join(workspace, "note.md"), "utf8")).toBe("新内容");
  });

  it("工作区外写入被拒，原文件不受影响", async () => {
    const workspace = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), "codexlike-out-"));
    writeFileSync(join(outside, "keep.txt"), "保留", "utf8");

    const result = await tool.execute(
      { path: join(outside, "keep.txt"), content: "篡改" },
      context(workspace)
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("路径越界");
    const fs = await import("node:fs");
    expect(fs.readFileSync(join(outside, "keep.txt"), "utf8")).toBe("保留");
  });

  it("参数缺失/类型不对返回可读错误", async () => {
    const workspace = makeWorkspace();
    const missing = await tool.execute({ path: "a.txt" }, context(workspace));
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("content");

    const badType = await tool.execute(
      { path: 42, content: "x" },
      context(workspace)
    );
    expect(badType.isError).toBe(true);
    expect(badType.output).toContain("path");
  });
});
