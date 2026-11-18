import {
  mkdtempSync,
  fstatSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { readMentionAttachments } from "../../src/tasks/mentions";

// 只观察真实文件读取的工作量，不替换文件正文或公开引用接口。
vi.mock("node:fs", { spy: true });

function observeReadBytes() {
  const fileReads = vi.mocked(readFileSync);
  const handleReads = vi.mocked(readSync);
  fileReads.mockClear();
  handleReads.mockClear();
  return () => {
    const wholeBytes = fileReads.mock.results.reduce((sum, result) => {
      if (result.type !== "return") return sum;
      return (
        sum +
        (typeof result.value === "string"
          ? Buffer.byteLength(result.value)
          : result.value.byteLength)
      );
    }, 0);
    const handleBytes = handleReads.mock.results.reduce(
      (sum, result) => sum + (result.type === "return" ? result.value : 0),
      0
    );
    // readFileSync 自身可能转调 readSync，同一份正文不能重复计入读取量。
    return Math.max(wholeBytes, handleBytes);
  };
}

/** 工单 07：@引用 文件读取（主进程侧，路径限制在工作区内） */
const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "codexlike-mention-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.mocked(readSync).mockReset();
});

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readMentionAttachments（@引用 文件读取）", () => {
  it("读取工作区内相对路径的文件内容，保持传入顺序", () => {
    const ws = workspace();
    writeFileSync(join(ws, "a.ts"), "export const a = 1;");
    mkdirSync(join(ws, "docs"));
    writeFileSync(join(ws, "docs", "说明.md"), "# 说明");

    expect(readMentionAttachments(ws, ["docs/说明.md", "a.ts"])).toEqual([
      { path: "docs/说明.md", content: "# 说明" },
      { path: "a.ts", content: "export const a = 1;" },
    ]);
  });

  it("Windows 反斜杠分隔的路径同样可读（@token 原样文本）", () => {
    const ws = workspace();
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "b.ts"), "b");

    expect(readMentionAttachments(ws, ["src\\b.ts"])).toEqual([
      { path: "src\\b.ts", content: "b" },
    ]);
  });

  it(".. 逃逸工作区的路径拒绝并给出中文错误", () => {
    const ws = workspace();
    expect(() => readMentionAttachments(ws, ["../outside.txt"])).toThrow(
      /工作区外|不允许/
    );
    expect(() => readMentionAttachments(ws, ["a/../../escape.txt"])).toThrow(
      /工作区外|不允许/
    );
  });

  it("符号链接逃逸工作区同样拒绝（realpath 校验）", (context) => {
    const ws = workspace();
    const outside = mkdtempSync(join(tmpdir(), "codexlike-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.txt"), "秘密");
    try {
      symlinkSync(join(outside, "secret.txt"), join(ws, "link.txt"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      // 权限限制明确记为 skipped，不能提前 return 伪装成已验证。
      context.skip("Windows 文件 symlink 需要开发者模式或管理员权限");
    }

    expect(() => readMentionAttachments(ws, ["link.txt"])).toThrow(
      /工作区外|不允许/
    );
  });

  it("目录 junction 逃逸同样拒绝且不读取工作区外正文", () => {
    const ws = workspace();
    const outside = workspace();
    writeFileSync(join(outside, "secret.txt"), "外部内容");
    symlinkSync(outside, join(ws, "external"), "junction");
    const bytesRead = observeReadBytes();

    expect(() => readMentionAttachments(ws, ["external/secret.txt"])).toThrow(
      /工作区外/
    );
    expect(bytesRead()).toBe(0);
  });

  it("绝对路径和目录都拒绝，不改变引用路径限制", () => {
    const ws = workspace();
    writeFileSync(join(ws, "file.txt"), "内容");
    mkdirSync(join(ws, "folder"));
    expect(() => readMentionAttachments(ws, [resolve(ws, "file.txt")])).toThrow(
      /绝对路径/
    );
    expect(() => readMentionAttachments(ws, ["folder"])).toThrow(/不是文件/);
  });

  it("文件不存在给出中文错误（引用后文件被删）", () => {
    const ws = workspace();
    expect(() => readMentionAttachments(ws, ["gone.txt"])).toThrow(/不存在/);
  });

  it("大文件实际读取至多 128 KiB 加一个探测字节，不随文件大小增长", () => {
    const ws = workspace();
    writeFileSync(join(ws, "large.log"), Buffer.alloc(2 * 1024 * 1024, "x"));
    const bytesRead = observeReadBytes();

    const [attachment] = readMentionAttachments(ws, ["large.log"]);

    expect(attachment?.content).toBe(
      `${"x".repeat(131_072)}\n\n（文件超过 128 KiB，内容已截断）`
    );
    expect(bytesRead()).toBeGreaterThanOrEqual(131_072);
    expect(bytesRead()).toBeLessThanOrEqual(131_073);
    for (const [, buffer] of vi.mocked(readSync).mock.calls) {
      expect(buffer.byteLength).toBeLessThanOrEqual(131_073);
    }
  });

  it("截断处保留完整 UTF8 字符，包括正文原有的替换符", () => {
    const ws = workspace();
    const prefix = `${"x".repeat(131_067)}�`;
    writeFileSync(join(ws, "utf8.txt"), `${prefix}中后续正文`);

    const [attachment] = readMentionAttachments(ws, ["utf8.txt"]);

    expect(attachment?.content).toBe(
      `${prefix}\n\n（文件超过 128 KiB，内容已截断）`
    );
  });

  it.each([0, 131_071, 131_072])(
    "大小 %i 字节未超预算，正文完整且不标记截断",
    (size) => {
      const ws = workspace();
      const content = "x".repeat(size);
      writeFileSync(join(ws, "boundary.txt"), content);
      const bytesRead = observeReadBytes();

      expect(readMentionAttachments(ws, ["boundary.txt"])).toEqual([
        { path: "boundary.txt", content },
      ]);
      expect(bytesRead()).toBe(size);
    }
  );

  it.each([
    ["é", 131_071],
    ["中", 131_070],
    ["𠮷", 131_069],
  ] as const)("截断不返回半个 UTF8 字符 %s", (character, prefixBytes) => {
    const ws = workspace();
    const prefix = "x".repeat(prefixBytes);
    writeFileSync(join(ws, "multibyte.txt"), `${prefix}${character}剩余`);
    const bytesRead = observeReadBytes();

    const [attachment] = readMentionAttachments(ws, ["multibyte.txt"]);

    expect(attachment?.content).toBe(
      `${prefix}\n\n（文件超过 128 KiB，内容已截断）`
    );
    expect(bytesRead()).toBeLessThanOrEqual(131_073);
  });

  it("短读会继续补齐预算而不是误报 EOF", async () => {
    const ws = workspace();
    writeFileSync(join(ws, "short-read.txt"), Buffer.alloc(200_000, "s"));
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    function shortRead(
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offsetOrOptions?: number | import("node:fs").ReadOptions,
      length?: number,
      position?: import("node:fs").ReadPosition | null
    ) {
      const options =
        typeof offsetOrOptions === "number"
          ? { offset: offsetOrOptions, length, position }
          : offsetOrOptions;
      const offset = options?.offset ?? 0;
      return fs.readSync(
        fd,
        buffer,
        offset,
        Math.min(options?.length ?? buffer.byteLength - offset, 4096),
        options?.position ?? null
      );
    }
    vi.mocked(readSync).mockImplementation(shortRead);
    const bytesRead = observeReadBytes();

    const [attachment] = readMentionAttachments(ws, ["short-read.txt"]);

    expect(attachment?.content).toBe(
      `${"s".repeat(131_072)}\n\n（文件超过 128 KiB，内容已截断）`
    );
    expect(bytesRead()).toBe(131_073);
  });

  it("读取失败后关闭句柄并允许下一次重新引用", () => {
    const ws = workspace();
    writeFileSync(join(ws, "retry.txt"), "可重读");
    let failedFd: number | undefined;
    vi.mocked(readSync).mockImplementationOnce((fd) => {
      failedFd = fd;
      throw new Error("EIO: 读取失败");
    });

    expect(() => readMentionAttachments(ws, ["retry.txt"])).toThrow("EIO");
    expect(() => fstatSync(failedFd!)).toThrow(/EBADF/);
    expect(readMentionAttachments(ws, ["retry.txt"])).toEqual([
      { path: "retry.txt", content: "可重读" },
    ]);
  });

  it("超过 128 KiB 的文件内容截断并附中文注明", () => {
    const ws = workspace();
    writeFileSync(join(ws, "big.txt"), "x".repeat(200 * 1024));
    const [attachment] = readMentionAttachments(ws, ["big.txt"]);
    expect(attachment?.content.length).toBeLessThan(200 * 1024);
    expect(attachment?.content).toContain("截断");
    expect(attachment?.content.startsWith("x")).toBe(true);
  });
});
