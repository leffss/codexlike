import {
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpStore } from "../../src/mcp/mcp-store";
import { createProfileStore } from "../../src/profiles/profile-store";
import { createSearchSettingsStore } from "../../src/search/search-settings-store";
import { readJsonFile, writeJsonFile } from "../../src/storage/json-file";

// 只在系统文件边界注入故障；数据落真实临时文件，读回走 store 公开接口。
vi.mock("node:fs", { spy: true });

const safeStorage = {
  isEncryptionAvailable: async () => true,
  encryptString: async (plain: string) => Buffer.from(plain),
  decryptString: async (encrypted: Buffer) => encrypted.toString("utf8"),
};

function settingsFixture(kind: "Profile" | "Search" | "MCP", dir: string) {
  const options = { dir, safeStorage };
  if (kind === "Profile") {
    const store = createProfileStore(options);
    return {
      fileName: "provider-profiles.json",
      save: (name: string) =>
        store.create({
          name,
          baseURL: "https://example.test/v1",
          models: ["model"],
          apiKey: name,
        }),
      read: () => createProfileStore(options).list(),
    };
  }
  if (kind === "Search") {
    const store = createSearchSettingsStore(options);
    return {
      fileName: "search-settings.json",
      save: (apiKey: string) => store.set({ apiKey }),
      read: () => createSearchSettingsStore(options).get(),
    };
  }
  const store = createMcpStore(options);
  return {
    fileName: "mcp-servers.json",
    save: (name: string) =>
      store.createServer({
        name,
        command: "node",
        args: [],
        env: { TOKEN: name },
      }),
    read: () => createMcpStore(options).snapshot(),
  };
}

/**
 * 四个 JSON 设置存储共享的读写（code review 修复 4 抽取）：
 * ENOENT → fallback、损坏 JSON 默认抛错（corruptAsFallback 可容错）、写侧建目录 + 2 空格缩进。
 */
let tempDir: string;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "codexlike-json-file-"));
  return tempDir;
}

afterEach(() => {
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(renameSync).mockReset();
  vi.mocked(openSync).mockReset();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("readJsonFile", () => {
  it("文件不存在（ENOENT）返回 fallback，不抛错", () => {
    const dir = makeTempDir();
    expect(readJsonFile(join(dir, "absent.json"), { a: 1 })).toEqual({ a: 1 });
  });

  it("正常 JSON 原样解析", () => {
    const dir = makeTempDir();
    const path = join(dir, "data.json");
    writeFileSync(path, '{"b":2}', "utf8");
    expect(readJsonFile<{ b: number }>(path, { b: 0 })).toEqual({ b: 2 });
  });

  it("损坏 JSON 默认抛错；corruptAsFallback 时返回 fallback", () => {
    const dir = makeTempDir();
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{oops", "utf8");
    expect(() => readJsonFile(path, { a: 1 })).toThrow();
    expect(readJsonFile(path, { a: 1 }, { corruptAsFallback: true })).toEqual({
      a: 1,
    });
  });
});

describe("writeJsonFile", () => {
  it.each(["Profile", "Search", "MCP"] as const)(
    "%s 部分写入失败后，重开 store 仍可读旧值且没有临时文件残留",
    async (kind) => {
      const dir = makeTempDir();
      const fixture = settingsFixture(kind, dir);
      await fixture.save("原配置");
      const before = await fixture.read();
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      const full = Object.assign(new Error("ENOSPC: 部分写入失败"), {
        code: "ENOSPC",
      });
      vi.mocked(writeFileSync).mockImplementationOnce((path, data, options) => {
        // 确保故障确实在打开并写入 16 字节后，而不是打开前拒绝。
        const bytes = Buffer.from(String(data)).subarray(0, 16);
        fs.writeFileSync(path, bytes, options);
        throw full;
      });

      await expect(fixture.save("新配置")).rejects.toBe(full);
      expect(await fixture.read()).toEqual(before);
      expect(readdirSync(dir)).toEqual([fixture.fileName]);
    }
  );

  it.each(["Profile", "Search", "MCP"] as const)(
    "%s 替换失败时保留旧目标，清理同目录临时文件后可以重试",
    async (kind) => {
      const dir = makeTempDir();
      const fixture = settingsFixture(kind, dir);
      await fixture.save("原配置");
      const before = await fixture.read();
      const denied = Object.assign(new Error("EPERM: 替换失败"), {
        code: "EPERM",
      });
      vi.mocked(renameSync).mockImplementationOnce((source, target) => {
        expect(dirname(String(source))).toBe(dir);
        expect(String(target)).toBe(join(dir, fixture.fileName));
        // 替换调用之前旧目标必须仍在，不能用删除旧目标规避 Windows 替换失败。
        expect(() => readJsonFile(String(target), null)).not.toThrow();
        expect(readJsonFile(String(target), null)).not.toBeNull();
        throw denied;
      });

      await expect(fixture.save("新配置")).rejects.toBe(denied);
      expect(await fixture.read()).toEqual(before);
      expect(readdirSync(dir)).toEqual([fixture.fileName]);
      await fixture.save("重试配置");
      expect(await fixture.read()).not.toEqual(before);
      expect(readdirSync(dir)).toEqual([fixture.fileName]);
    }
  );

  it("临时路径排他创建失败不清理未取得所有权的文件，旧配置仍可读", async () => {
    const dir = makeTempDir();
    const fixture = settingsFixture("Profile", dir);
    await fixture.save("原配置");
    const before = await fixture.read();
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const collision = Object.assign(new Error("EEXIST: 临时路径已存在"), {
      code: "EEXIST",
    });
    let occupied: string | undefined;
    vi.mocked(openSync).mockImplementationOnce((path) => {
      occupied = String(path);
      fs.writeFileSync(path, "另一写入者的文件");
      throw collision;
    });

    await expect(fixture.save("新配置")).rejects.toBe(collision);
    expect(await fixture.read()).toEqual(before);
    expect(readFileSync(occupied!, "utf8")).toBe("另一写入者的文件");
  });

  it("损坏配置经 store 读取仍拒绝，不写入默认设置也不隔离删除原文件", async () => {
    const dir = makeTempDir();
    for (const kind of ["Profile", "Search", "MCP"] as const) {
      const fixture = settingsFixture(kind, dir);
      const path = join(dir, fixture.fileName);
      writeFileSync(path, "{损坏内容");
      await expect(fixture.read()).rejects.toThrow(SyntaxError);
      expect(readFileSync(path, "utf8")).toBe("{损坏内容");
    }
  });

  it("目录不存在时自动创建，落盘为 2 空格缩进的 JSON", () => {
    const dir = makeTempDir();
    const path = join(dir, "nested", "deeper", "data.json");
    writeJsonFile(path, { name: "值" });
    expect(readJsonFile<{ name?: string }>(path, {})).toEqual({ name: "值" });
    expect(readFileSync(path, "utf8")).toBe('{\n  "name": "值"\n}');
  });
});
