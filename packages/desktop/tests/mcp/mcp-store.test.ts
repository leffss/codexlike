import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMcpStore } from "../../src/mcp/mcp-store";
import { createCredentialStorage } from "../../src/storage/credential-storage";

/** 测试用安全存储替身：base64 可逆变换，保证明文不直接落盘 */
const fakeSafeStorage = {
  isEncryptionAvailable: async () => true,
  encryptString: async (plainText: string) =>
    Buffer.from(`enc:${Buffer.from(plainText, "utf8").toString("base64")}`),
  decryptString: async (encrypted: Buffer) => {
    const text = encrypted.toString("utf8");
    if (!text.startsWith("enc:")) {
      throw new Error("decryptString 收到未加密数据");
    }
    return Buffer.from(text.slice(4), "base64").toString("utf8");
  },
};

const fakeInput = {
  name: "fake-server",
  command: "node",
  args: ["server.js", "--stdio"],
  env: { FAKE_TOKEN: "secret-token-123" },
};

let tempDir: string;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "codexlike-mcp-store-"));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("mcp store（server 配置 + 工具启停，env 值加密落盘）", () => {
  it("createServer 后 list 返回明文 env，数据文件中检索不到明文值", async () => {
    const dir = makeTempDir();
    const store = createMcpStore({ dir, safeStorage: fakeSafeStorage });

    const created = await store.createServer(fakeInput);

    expect(created).toMatchObject({
      name: "fake-server",
      command: "node",
      args: ["server.js", "--stdio"],
      env: { FAKE_TOKEN: "secret-token-123" },
    });
    expect(created.id).not.toBe("");

    const snapshot = await store.snapshot();
    expect(snapshot.servers).toHaveLength(1);

    const raw = readFileSync(join(dir, "mcp-servers.json"), "utf8");
    expect(raw).not.toContain("secret-token-123");
    expect(raw).toContain("encryptedEnv");
  });

  it("空 env 的 server 无需加密也可保存（safeStorage 不可用仅拒绝含 env 的保存）", async () => {
    const dir = makeTempDir();
    const unavailable = {
      ...fakeSafeStorage,
      isEncryptionAvailable: async () => false,
    };
    const store = createMcpStore({ dir, safeStorage: unavailable });

    const created = await store.createServer({
      name: "plain",
      command: "node",
      args: [],
      env: {},
    });
    expect(created.name).toBe("plain");

    await expect(store.createServer(fakeInput)).rejects.toThrow(
      /safeStorage|加密/
    );
  });

  it("removeServer 删除配置；工具启停持久化且重启（新 store 实例）恢复", async () => {
    const dir = makeTempDir();
    const store = createMcpStore({ dir, safeStorage: fakeSafeStorage });
    const first = await store.createServer(fakeInput);
    const second = await store.createServer({
      name: "another",
      command: "node",
      args: [],
      env: {},
    });

    await store.setToolEnabled("mcp_fake_server_echo", false);
    await store.setToolEnabled("mcp_another_greet", false);
    await store.setToolEnabled("mcp_another_greet", true); // 再启用 = 从禁用表移除

    expect((await store.removeServer(second.id)).status).toBe("removed");

    // 同目录新建 store = 等价重启
    const reopened = createMcpStore({ dir, safeStorage: fakeSafeStorage });
    const snapshot = await reopened.snapshot();
    expect(snapshot.servers.map((server) => server.name)).toEqual([
      "fake-server",
    ]);
    expect(snapshot.disabledTools).toEqual(["mcp_fake_server_echo"]);
  });

  it("新增 server 等待解密期间的删除与禁用，提交后不会被旧快照覆盖", async () => {
    const dir = makeTempDir();
    const original = createMcpStore({ dir, safeStorage: fakeSafeStorage });
    const removed = await original.createServer(fakeInput);
    const kept = await original.createServer({ ...fakeInput, name: "kept" });
    let entered!: () => void;
    let resume!: () => void;
    const decrypting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const store = createMcpStore({
      dir,
      safeStorage: {
        ...fakeSafeStorage,
        decryptString: async (encrypted: Buffer) => {
          const plain = await fakeSafeStorage.decryptString(encrypted);
          if (plain === "new-env-await-decrypt") {
            entered();
            await released;
          }
          return plain;
        },
      },
    });
    const creating = store.createServer({
      ...fakeInput,
      name: "new",
      env: { TOKEN: "new-env-await-decrypt" },
    });
    await decrypting;
    try {
      expect(await store.removeServer(removed.id)).toEqual({
        status: "removed",
      });
      await store.setToolEnabled("mcp_kept_echo", false);
      expect(await original.snapshot()).toEqual({
        servers: [kept],
        disabledTools: ["mcp_kept_echo"],
      });
    } finally {
      resume();
    }
    const created = await creating;

    expect(
      await createMcpStore({ dir, safeStorage: fakeSafeStorage }).snapshot()
    ).toEqual({
      servers: [kept, created],
      disabledTools: ["mcp_kept_echo"],
    });
  });

  it.each(["encryptString", "decryptString"] as const)(
    "新增 server 的凭据 %s 失败时拒绝保存，原配置与工具开关保持不变",
    async (method) => {
      const dir = makeTempDir();
      const original = createMcpStore({ dir, safeStorage: fakeSafeStorage });
      const saved = await original.createServer(fakeInput);
      await original.setToolEnabled("mcp_fake_server_echo", false);
      const path = join(dir, "mcp-servers.json");
      const before = readFileSync(path, "utf8");
      const failing = createMcpStore({
        dir,
        safeStorage: {
          ...fakeSafeStorage,
          [method]: async () => {
            throw new Error("凭据处理失败，请重试");
          },
        },
      });

      await expect(
        failing.createServer({ ...fakeInput, name: "new" })
      ).rejects.toThrow("凭据处理失败");
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(await original.snapshot()).toEqual({
        servers: [saved],
        disabledTools: ["mcp_fake_server_echo"],
      });
    }
  );

  it("新 adapter 混读旧新 env 不迁移，旧凭据解密失败保留原文件，恢复后可重试 snapshot", async () => {
    const dir = makeTempDir();
    const legacy = createMcpStore({ dir, safeStorage: fakeSafeStorage });
    const old = await legacy.createServer(fakeInput);
    await legacy.setToolEnabled("mcp_fake_server_echo", false);
    const path = join(dir, "mcp-servers.json");
    const before = readFileSync(path, "utf8");
    let legacyReadable = true;
    const makeStorage = () =>
      createCredentialStorage({
        platform: "win32",
        legacy: {
          ...fakeSafeStorage,
          decryptString: async (encrypted: Buffer) => {
            if (!legacyReadable)
              throw new Error("不可展示的原始错误 mcp-legacy-secret");
            return fakeSafeStorage.decryptString(encrypted);
          },
        },
        protector: {
          protect: async (plain: Buffer) => Buffer.from(plain).reverse(),
          unprotect: async (encrypted: Buffer) =>
            Buffer.from(encrypted).reverse(),
        },
      });
    const store = createMcpStore({ dir, safeStorage: makeStorage() });
    expect(await store.snapshot()).toEqual({
      servers: [old],
      disabledTools: ["mcp_fake_server_echo"],
    });
    expect(readFileSync(path, "utf8")).toBe(before);
    const fresh = await store.createServer({
      ...fakeInput,
      name: "new",
      env: { TOKEN: "mcp-fresh" },
    });
    const mixed = readFileSync(path, "utf8");
    expect(mixed).not.toContain("secret-token-123");
    expect(mixed).not.toContain("mcp-fresh");
    expect(JSON.parse(mixed).servers[0]).toEqual(JSON.parse(before).servers[0]);
    expect(
      await createMcpStore({ dir, safeStorage: makeStorage() }).snapshot()
    ).toEqual({
      servers: [old, fresh],
      disabledTools: ["mcp_fake_server_echo"],
    });
    expect(readFileSync(path, "utf8")).toBe(mixed);

    legacyReadable = false;
    const failed = createMcpStore({ dir, safeStorage: makeStorage() });
    await expect(failed.snapshot()).rejects.toThrow(
      /^系统凭据加密存储不可用或数据损坏，已拒绝处理凭据$/
    );
    expect(readFileSync(path, "utf8")).toBe(mixed);
    legacyReadable = true;
    expect(await failed.snapshot()).toEqual({
      servers: [old, fresh],
      disabledTools: ["mcp_fake_server_echo"],
    });
    expect(readFileSync(path, "utf8")).toBe(mixed);
  });

  it("输入校验：name/command 必填，args/env 形状不对时报中文错误", async () => {
    const dir = makeTempDir();
    const store = createMcpStore({ dir, safeStorage: fakeSafeStorage });

    await expect(
      store.createServer({ name: "", command: "node", args: [], env: {} })
    ).rejects.toThrow("名称");
    await expect(
      store.createServer({ name: "x", command: "", args: [], env: {} })
    ).rejects.toThrow("命令");
    await expect(
      store.createServer({
        name: "x",
        command: "node",
        // @ts-expect-error 故意传非法形状
        args: "not-array",
        env: {},
      })
    ).rejects.toThrow();
  });

  it("removeServer 不存在的 id 返回 not-found", async () => {
    const dir = makeTempDir();
    const store = createMcpStore({ dir, safeStorage: fakeSafeStorage });
    expect((await store.removeServer("nope")).status).toBe("not-found");
  });

  it("空目录首启：文件不存在时 snapshot 返回空配置", async () => {
    const dir = makeTempDir();
    const store = createMcpStore({ dir, safeStorage: fakeSafeStorage });
    const snapshot = await store.snapshot();
    expect(snapshot.servers).toEqual([]);
    expect(snapshot.disabledTools).toEqual([]);
    expect(existsSync(join(dir, "mcp-servers.json"))).toBe(false);
  });
});
