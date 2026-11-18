import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReadFileTool, splitLines } from "../../src/tools/read-file";

// 文件仍实际打开、读取和关闭；只在文件系统边界计量实际 IO 与注入读失败/中断。
const io = vi.hoisted(() => ({
  bytes: 0,
  requests: [] as number[],
  opened: 0,
  closed: 0,
  failRead: false,
  afterRead: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const content = actual.readFileSync(...args);
      io.bytes +=
        typeof content === "string"
          ? Buffer.byteLength(content)
          : content.byteLength;
      io.requests.push(
        typeof content === "string"
          ? Buffer.byteLength(content)
          : content.byteLength
      );
      return content;
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      io.opened += 1;
      const read = handle.read.bind(handle);
      handle.read = (async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number
      ) => {
        io.requests.push(length);
        if (io.failRead) throw new Error("injected read failure");
        const result = await read(buffer, offset, length, position);
        io.bytes += result.bytesRead;
        io.afterRead?.();
        return result;
      }) as typeof handle.read;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        io.closed += 1;
      };
      return handle;
    },
  };
});

describe("read_file 读取与结果预算（真实文件）", () => {
  let workspace: string;
  const tool = createReadFileTool();
  const context = () => ({
    workspacePath: workspace,
    taskId: "read-budget",
    approvalMode: "assist" as const,
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "codexlike-read-budget-"));
    io.bytes = 0;
    io.requests = [];
    io.opened = 0;
    io.closed = 0;
    io.failRead = false;
    io.afterRead = undefined;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("请求大文件首行只读取首个 64 KiB 块，达到请求范围立即停止并关闭句柄", async () => {
    writeFileSync(
      join(workspace, "many.txt"),
      "first\n" + "later\n".repeat(400_000)
    );

    const result = await tool.execute(
      { path: "many.txt", limit: 1 },
      context()
    );

    expect(result).toEqual({ output: "1\tfirst\n", isError: false });
    expect(io.bytes).toBeGreaterThan(0);
    expect(io.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(io.requests.every((bytes) => bytes <= 64 * 1024)).toBe(true);
    expect(io.opened).toBe(1);
    expect(io.closed).toBe(1);
  });

  it("远处 offset 最多扫描 8 MiB，每块最多 64 KiB，明确拒绝未到达的范围", async () => {
    writeFileSync(
      join(workspace, "skip.txt"),
      "x".repeat(9 * 1024 * 1024) + "\nlast\n"
    );

    const result = await tool.execute(
      { path: "skip.txt", offset: 2, limit: 1 },
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("8 MiB");
    expect(io.bytes).toBe(8 * 1024 * 1024);
    expect(io.requests.every((bytes) => bytes <= 64 * 1024)).toBe(true);
    expect(io.closed).toBe(io.opened);
  });

  it.each(["before", "during"] as const)(
    "%s abort 停止扫描，已打开句柄必定关闭",
    async (when) => {
      writeFileSync(join(workspace, "abort.txt"), "skip\n".repeat(400_000));
      const controller = new AbortController();
      if (when === "before") controller.abort();
      else io.afterRead = () => controller.abort();

      const result = await tool.execute(
        { path: "abort.txt", offset: 300_000, limit: 1 },
        { ...context(), signal: controller.signal }
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("中断");
      expect(io.bytes).toBeLessThanOrEqual(when === "before" ? 0 : 64 * 1024);
      expect(io.opened).toBe(when === "before" ? 0 : 1);
      expect(io.closed).toBe(io.opened);
    }
  );

  it("读取错误和二进制拒绝也关闭真实文件句柄", async () => {
    writeFileSync(join(workspace, "error.txt"), "text");
    io.failRead = true;
    const error = await tool.execute({ path: "error.txt" }, context());
    expect(error.isError).toBe(true);
    expect(error.output).toContain("injected read failure");
    expect(io.closed).toBe(1);
    io.failRead = false;
    writeFileSync(join(workspace, "binary.txt"), Buffer.from([97, 0, 98]));
    const binary = await tool.execute({ path: "binary.txt" }, context());
    expect(binary.isError).toBe(true);
    expect(binary.output).toContain("二进制");
    expect(io.closed).toBe(2);
  });

  it("默认及超额 limit 均最多 2000 行，提示计入输出且不为了总行数继续读", async () => {
    writeFileSync(join(workspace, "default.txt"), "row\n".repeat(400_000));
    for (const args of [
      { path: "default.txt" },
      { path: "default.txt", limit: 50_000 },
    ]) {
      io.bytes = 0;
      const result = await tool.execute(args, context());
      expect(result.isError).toBe(false);
      expect(result.output).toContain("2000\trow\n");
      expect(result.output).not.toContain("2001\t");
      expect(result.output).toContain("已截断");
      expect(result.output).not.toContain("文件共");
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(128 * 1024);
      expect(io.bytes).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it("UTF-8 多字节字符与 CRLF 跨块，末行和 splitLines 保持兼容", async () => {
    const first = "a".repeat(64 * 1024 - 2) + "汉🙂";
    writeFileSync(join(workspace, "utf8.txt"), `${first}\r\n第二行\r\n尾行\r`);
    const result = await tool.execute({ path: "utf8.txt" }, context());
    expect(result).toEqual({
      output: `1\t${first}\n2\t第二行\n3\t尾行\n`,
      isError: false,
    });
    expect(io.requests.every((bytes) => bytes <= 64 * 1024)).toBe(true);
    expect(io.closed).toBe(1);
    expect(splitLines("a\r\n\r\nb\r")).toEqual(["a", "", "b"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("\n")).toEqual([""]);
  });

  it.each(["", "\n", "a\n", "a\n\n", "a\r\nb\r", "\uFEFF正文"])(
    "空文件/空行/末尾换行/BOM 输出兼容：%j",
    async (text) => {
      writeFileSync(join(workspace, "small.txt"), text);
      const result = await tool.execute({ path: "small.txt" }, context());
      const expected = new Map([
        ["", "small.txt 为空文件"],
        ["\n", "1\t\n"],
        ["a\n", "1\ta\n"],
        ["a\n\n", "1\ta\n2\t\n"],
        ["a\r\nb\r", "1\ta\n2\tb\n"],
        ["\uFEFF正文", "1\t\uFEFF正文\n"],
      ]);
      expect(result).toEqual({ output: expected.get(text), isError: false });
      expect(io.closed).toBe(1);
    }
  );

  it("超过实际行数的 offset 不误报截断，零 limit 明确拒绝而不读文件", async () => {
    writeFileSync(join(workspace, "small.txt"), "a\nb\n");
    const pastEnd = await tool.execute(
      { path: "small.txt", offset: 20 },
      context()
    );
    expect(pastEnd).toEqual({ output: "", isError: false });
    io.bytes = 0;
    const zero = await tool.execute({ path: "small.txt", limit: 0 }, context());
    expect(zero.isError).toBe(true);
    expect(zero.output).toContain("limit");
    expect(io.bytes).toBe(0);
  });

  it("失败提示也受最终 128 KiB 预算限制", async () => {
    const result = await tool.execute({ path: "汉".repeat(50_000) }, context());
    expect(result.isError).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(128 * 1024);
    expect(result.output).toContain("已截断");
    expect(result.output).not.toContain("�");
  });

  it("2 MiB 单行的最终输出含截断提示仍不超过 128 KiB，UTF-8 字符不被切坏", async () => {
    writeFileSync(join(workspace, "long.txt"), "汉字🙂".repeat(210_000));

    const result = await tool.execute(
      { path: "long.txt", limit: 1 },
      context()
    );

    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(128 * 1024);
    expect(result.output).toContain("已截断");
    expect(result.output).not.toContain("�");
    expect(result.output.startsWith("1\t汉字🙂")).toBe(true);
  });
});
