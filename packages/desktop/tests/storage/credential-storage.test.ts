import { describe, expect, it } from "vitest";

import type { SafeStorageLike } from "../../src/profiles/profile-store";
import { createCredentialStorage } from "../../src/storage/credential-storage";

const unavailableLegacy: SafeStorageLike = {
  isEncryptionAvailable: async () => false,
  encryptString: async () => {
    throw new Error("不应使用 Electron 加密测试凭据");
  },
  decryptString: async () => {
    throw new Error("不应使用 Electron 解密测试凭据");
  },
};

describe("credential storage（统一凭据存储边界）", () => {
  it("Windows 新密文带独立 family、version、provider 与长度，解密仅向 DPAPI 传 payload", async () => {
    const storage = createCredentialStorage({
      legacy: unavailableLegacy,
      platform: "win32",
      protector: {
        protect: async () => Buffer.from([9, 8, 7]),
        unprotect: async (payload) => {
          expect(payload).toEqual(Buffer.from([9, 8, 7]));
          return Buffer.from("测试 key");
        },
      },
    });

    const encrypted = await storage.encryptString("测试 key");
    expect(encrypted.toString("hex")).toBe(
      "89434c4352454453010103000000090807"
    );
    await expect(storage.decryptString(encrypted)).resolves.toBe("测试 key");
  });
  it("Windows 无新头的 legacy 密文交给 Electron，不猜测其 tag 白名单", async () => {
    const legacyInputs = [
      Buffer.from("v10-旧 Electron 密文"),
      Buffer.from("v20-另一版 Electron 密文"),
      Buffer.from("未来 Electron tag"),
      Buffer.from([1, 0, 0, 0, 7, 6, 5]),
    ];
    const storage = createCredentialStorage({
      legacy: {
        ...unavailableLegacy,
        decryptString: async (encrypted) => {
          expect(legacyInputs).toContainEqual(encrypted);
          return "legacy-key";
        },
      },
      platform: "win32",
      protector: {
        protect: async () => {
          throw new Error("DPAPI 不应加密 legacy");
        },
        unprotect: async () => {
          throw new Error("DPAPI 不应解密 legacy");
        },
      },
    });
    for (const input of legacyInputs) {
      await expect(storage.decryptString(input)).resolves.toBe("legacy-key");
    }
  });

  it("未知、截断或损坏的新头严格拒绝，不向 legacy 或 DPAPI 试探", async () => {
    const valid = Buffer.from("89434c4352454453010103000000090807", "hex");
    const malformed = [
      Buffer.alloc(0),
      ...Array.from({ length: 14 }, (_, index) => valid.subarray(0, index + 1)),
      ...Array.from({ length: 8 }, (_, index) => {
        const broken = Buffer.from(valid);
        broken[index] = broken[index]! ^ 1;
        return broken;
      }),
      Buffer.from("89434c4352454453020103000000090807", "hex"),
      Buffer.from("89434c4352454453010203000000090807", "hex"),
      Buffer.from("89434c4352454453010104000000090807", "hex"),
      Buffer.concat([valid, Buffer.from([0])]),
    ];
    let attempts = 0;
    const storage = createCredentialStorage({
      platform: "win32",
      legacy: {
        ...unavailableLegacy,
        decryptString: async () => {
          attempts++;
          return "不应降级";
        },
      },
      protector: {
        protect: async () => Buffer.from([1]),
        unprotect: async () => {
          attempts++;
          return Buffer.from("不应试探");
        },
      },
    });
    for (const input of malformed) {
      await expect(storage.decryptString(input)).rejects.toThrow(
        "系统凭据加密存储不可用或数据损坏"
      );
    }
    expect(attempts).toBe(0);
  });

  it.each(["linux", "darwin"] as const)(
    "%s 保留 Electron 的 availability 与读写，不启用 DPAPI",
    async (platform) => {
      const ciphertext = Buffer.from("平台密文");
      const legacy: SafeStorageLike = {
        isEncryptionAvailable: async () => false,
        encryptString: async (plain) => {
          expect(plain).toBe("");
          return ciphertext;
        },
        decryptString: async (input) => {
          expect(input).toBe(ciphertext);
          return "";
        },
      };
      const storage = createCredentialStorage({
        platform,
        legacy,
        protector: {
          protect: async () => {
            throw new Error("非 Windows 不使用 DPAPI");
          },
          unprotect: async () => {
            throw new Error("非 Windows 不使用 DPAPI");
          },
        },
      });
      await expect(storage.isEncryptionAvailable()).resolves.toBe(false);
      await expect(storage.encryptString("")).resolves.toBe(ciphertext);
      await expect(storage.decryptString(ciphertext)).resolves.toBe("");
    }
  );

  it.each(["linux", "darwin"] as const)(
    "%s 拒绝新 Windows envelope，而不是送 Electron 降级解密",
    async (platform) => {
      let legacyReads = 0;
      const storage = createCredentialStorage({
        platform,
        legacy: {
          ...unavailableLegacy,
          decryptString: async () => {
            legacyReads++;
            return "不应降级";
          },
        },
      });
      for (const hex of [
        "89434c4352454453010103000000090807",
        "89",
        "88434c4352454453010103000000090807",
      ]) {
        await expect(
          storage.decryptString(Buffer.from(hex, "hex"))
        ).rejects.toThrow("系统凭据加密存储不可用或数据损坏");
      }
      expect(legacyReads).toBe(0);
    }
  );

  it("Windows availability 实测 DPAPI 往返，失败可重试且成功 probe 去重缓存", async () => {
    let blocked = true;
    let protects = 0;
    let unprotects = 0;
    const storage = createCredentialStorage({
      legacy: unavailableLegacy,
      platform: "win32",
      protector: {
        protect: async (bytes) => {
          protects++;
          if (blocked) throw new Error("原始异常可能含测试-secret");
          return Buffer.from(bytes);
        },
        unprotect: async (bytes) => {
          unprotects++;
          return Buffer.from(bytes);
        },
      },
    });
    expect(protects).toBe(0);
    await expect(storage.isEncryptionAvailable()).resolves.toBe(false);
    blocked = false;
    await expect(
      Promise.all(
        Array.from({ length: 8 }, () => storage.isEncryptionAvailable())
      )
    ).resolves.toEqual(Array(8).fill(true));
    await expect(storage.isEncryptionAvailable()).resolves.toBe(true);
    expect(protects).toBe(2);
    expect(unprotects).toBe(1);
  });

  it("availability 不接受往返内容不一致，也不受 Electron 可用性影响", async () => {
    let attempts = 0;
    const storage = createCredentialStorage({
      platform: "win32",
      legacy: { ...unavailableLegacy, isEncryptionAvailable: async () => true },
      protector: {
        protect: async () => {
          attempts++;
          return Buffer.from([1]);
        },
        unprotect: async () => Buffer.from("不匹配的测试响应"),
      },
    });
    await expect(storage.isEncryptionAvailable()).resolves.toBe(false);
    await expect(storage.isEncryptionAvailable()).resolves.toBe(false);
    expect(attempts).toBe(2);
  });

  it("加解密失败仅抛统一中文错误，不透传 raw error 或 cause，也不降级", async () => {
    const raw = new Error("测试-secret stdout stderr", {
      cause: new Error("测试-secret"),
    });
    const fail = async (): Promise<never> => {
      throw raw;
    };
    const storage = createCredentialStorage({
      legacy: { ...unavailableLegacy, decryptString: fail },
      platform: "win32",
      protector: { protect: fail, unprotect: fail },
    });
    for (const action of [
      () => storage.encryptString("测试-secret"),
      () =>
        storage.decryptString(
          Buffer.from("89434c4352454453010103000000090807", "hex")
        ),
      () => storage.decryptString(Buffer.from("legacy")),
    ]) {
      try {
        await action();
        expect.fail("应拒绝失败的凭据操作");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toHaveProperty(
          "message",
          "系统凭据加密存储不可用或数据损坏，已拒绝处理凭据"
        );
        expect(error).not.toHaveProperty("cause");
        expect(String(error)).not.toContain("测试-secret");
      }
    }
  });

  it("同一密文并发 decrypt 去重且成功后缓存，encrypt 不复用结果，失败允许重试", async () => {
    let protects = 0;
    let unprotects = 0;
    let blocked = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage = createCredentialStorage({
      legacy: unavailableLegacy,
      platform: "win32",
      protector: {
        protect: async () => {
          protects++;
          return Buffer.from([9, 8, 7]);
        },
        unprotect: async () => {
          unprotects++;
          await gate;
          if (blocked) throw new Error("测试解密失败");
          return Buffer.from("");
        },
      },
    });
    const cipher = await storage.encryptString("");
    await storage.encryptString("");
    expect(protects).toBe(2);
    const pending = Array.from({ length: 12 }, () =>
      storage.decryptString(Buffer.from(cipher))
    );
    const settled = Promise.allSettled(pending);
    release();
    expect(
      (await settled).every((result) => result.status === "rejected")
    ).toBe(true);
    expect(unprotects).toBe(1);
    blocked = false;
    await expect(storage.decryptString(cipher)).resolves.toBe("");
    await expect(storage.decryptString(cipher)).resolves.toBe("");
    expect(unprotects).toBe(2);
  });

  it("legacy 每次实际调用 Electron，不用成功缓存遮蔽后续解密失败", async () => {
    let reads = 0;
    const storage = createCredentialStorage({
      platform: "win32",
      legacy: {
        ...unavailableLegacy,
        decryptString: async () => {
          reads++;
          if (reads > 1) throw new Error("legacy 测试密钥已不可用");
          return "legacy-fake";
        },
      },
    });
    await expect(
      storage.decryptString(Buffer.from("legacy-cipher"))
    ).resolves.toBe("legacy-fake");
    await expect(
      storage.decryptString(Buffer.from("legacy-cipher"))
    ).rejects.toThrow("系统凭据");
    expect(reads).toBe(2);
  });

  it("成功 decrypt 缓存至多 128 条，最近读取保留、最旧条目淘汰", async () => {
    let reads = 0;
    const storage = createCredentialStorage({
      platform: "win32",
      legacy: unavailableLegacy,
      protector: {
        protect: async (bytes) => Buffer.from(bytes),
        unprotect: async (bytes) => {
          reads++;
          return Buffer.from(bytes);
        },
      },
    });
    const ciphers: Buffer[] = [];
    for (let index = 0; index < 129; index++) {
      ciphers.push(await storage.encryptString(`fake-${index}`));
    }
    for (const cipher of ciphers.slice(0, 128))
      await storage.decryptString(cipher);
    await storage.decryptString(ciphers[0]!);
    await storage.decryptString(ciphers[128]!);
    expect(reads).toBe(129);
    await storage.decryptString(ciphers[0]!);
    expect(reads).toBe(129);
    await storage.decryptString(ciphers[1]!);
    expect(reads).toBe(130);
  });

  it("成功缓存以 UTF-16 字符串及 digest 计入 1MiB 预算，超预算条目不留存", async () => {
    let reads = 0;
    const storage = createCredentialStorage({
      platform: "win32",
      legacy: unavailableLegacy,
      protector: {
        protect: async (bytes) => Buffer.from(bytes),
        unprotect: async (bytes) => {
          reads++;
          return Buffer.from(
            bytes.toString() === "large"
              ? "a".repeat(600_000)
              : "界".repeat(200_000)
          );
        },
      },
    });
    const a = await storage.encryptString("a");
    const b = await storage.encryptString("b");
    const c = await storage.encryptString("c");
    const large = await storage.encryptString("large");
    await storage.decryptString(a);
    await storage.decryptString(b);
    await storage.decryptString(c);
    await storage.decryptString(b);
    expect(reads).toBe(3);
    await storage.decryptString(a);
    expect(reads).toBe(4);
    await storage.decryptString(large);
    await storage.decryptString(large);
    expect(reads).toBe(6);
  });

  it("系统保护边界最多并发 2 个、排队 32 个，溢出拒绝且完成后可继续", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let running = 0;
    let peak = 0;
    const storage = createCredentialStorage({
      platform: "win32",
      legacy: unavailableLegacy,
      protector: {
        protect: async () => {
          running++;
          peak = Math.max(peak, running);
          await gate;
          running--;
          return Buffer.from([1]);
        },
        unprotect: async () => Buffer.from(""),
      },
    });
    const pending = Array.from({ length: 35 }, (_, index) =>
      storage.encryptString(`fake-${index}`)
    );
    const results = Promise.allSettled(pending);
    try {
      await Promise.resolve();
      expect(running).toBe(2);
      expect(peak).toBe(2);
    } finally {
      release();
    }
    const settled = await results;
    expect(
      settled.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "fulfilled")
    ).toHaveLength(34);
    expect(peak).toBe(2);
    await expect(storage.encryptString("后续假凭据")).resolves.toBeInstanceOf(
      Buffer
    );
  });

  it("Windows 字节边界拒绝超限、空密文 payload 与无效 UTF-8，不返回替换字符", async () => {
    let encryptCalls = 0;
    let decryptCalls = 0;
    let output = Buffer.from([0xc3, 0x28]);
    const storage = createCredentialStorage({
      platform: "win32",
      legacy: unavailableLegacy,
      protector: {
        protect: async () => {
          encryptCalls++;
          return output;
        },
        unprotect: async () => {
          decryptCalls++;
          return output;
        },
      },
    });
    await expect(
      storage.encryptString("a".repeat(1024 * 1024 + 1))
    ).rejects.toThrow("系统凭据");
    expect(encryptCalls).toBe(0);
    await expect(
      storage.decryptString(Buffer.alloc(1024 * 1024 + 16 * 1024 + 15))
    ).rejects.toThrow("系统凭据");
    expect(decryptCalls).toBe(0);
    await expect(
      storage.decryptString(
        Buffer.from("89434c4352454453010103000000090807", "hex")
      )
    ).rejects.toThrow("系统凭据");
    output = Buffer.alloc(0);
    await expect(storage.encryptString("")).rejects.toThrow("系统凭据");
    output = Buffer.alloc(1024 * 1024 + 16 * 1024 + 1);
    await expect(storage.encryptString("fake")).rejects.toThrow("系统凭据");
  });

  it
    .skipIf(process.platform !== "win32")
    .each(["仅测试-sk-中文-é-𠮷", "", "\uFEFF含 BOM 与 NUL\u0000的假凭据"])(
    "真实 DPAPI：加密进程退出后另一进程还原假凭据 %j，篡改则拒绝",
    async (plain) => {
      const writer = createCredentialStorage({ legacy: unavailableLegacy });
      const encrypted = await writer.encryptString(plain);
      const reader = createCredentialStorage({ legacy: unavailableLegacy });
      if (plain.length > 0)
        expect(encrypted.includes(Buffer.from(plain))).toBe(false);
      await expect(reader.decryptString(encrypted)).resolves.toBe(plain);
      const tampered = Buffer.from(encrypted);
      tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
      await expect(reader.decryptString(tampered)).rejects.toThrow("系统凭据");
    },
    20_000
  );
});
