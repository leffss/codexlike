import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderProfileInput } from "@codexlike/agent-core";

import { createProfileStore } from "../../src/profiles/profile-store";
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

function pauseEncryptionFor(apiKey: string) {
  let entered!: () => void;
  let resume!: () => void;
  const encrypting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return {
    encrypting,
    resume,
    safeStorage: {
      ...fakeSafeStorage,
      encryptString: async (plain: string) => {
        if (plain === apiKey) {
          entered();
          await released;
        }
        return fakeSafeStorage.encryptString(plain);
      },
    },
  };
}

const validInput: ProviderProfileInput = {
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-plaintext-secret",
  models: ["glm-4.7"],
};

let tempDir: string;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "codexlike-profile-store-"));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("profile store（safeStorage 加密落盘）", () => {
  it("create 后 list() 返回明文 apiKey，且数据文件中检索不到明文 key", async () => {
    const dir = makeTempDir();
    const store = createProfileStore({ dir, safeStorage: fakeSafeStorage });

    const created = await store.create(validInput);

    expect(created.name).toBe("GLM");
    expect(created.apiKey).toBe("sk-plaintext-secret");
    expect(await store.list()).toEqual([created]);

    const raw = readFileSync(join(dir, "provider-profiles.json"), "utf8");
    expect(raw).not.toContain("sk-plaintext-secret");
    expect(raw).toContain("encryptedApiKey"); // 落盘的是加密形态字段
  });

  it("update 修改字段并保持加密落盘；remove 删除后 list 不再包含", async () => {
    const dir = makeTempDir();
    const store = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    const created = await store.create(validInput);
    await store.create({
      ...validInput,
      name: "DeepSeek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-another",
      models: ["deepseek-chat"],
    });

    const updated = await store.update(created.id, {
      ...validInput,
      name: "GLM 2",
      models: ["glm-5"],
    });

    expect(updated?.name).toBe("GLM 2");
    expect(updated?.models).toEqual(["glm-5"]);
    expect((await store.list()).map((p) => p.name)).toEqual([
      "GLM 2",
      "DeepSeek",
    ]);
    expect(
      readFileSync(join(dir, "provider-profiles.json"), "utf8")
    ).not.toContain("sk-plaintext-secret");

    expect(await store.remove(created.id)).toBe(true);
    expect((await store.list()).map((p) => p.name)).toEqual(["DeepSeek"]);
    expect(await store.remove(created.id)).toBe(false);
  });

  it("重新打开存储（模拟应用重启）后全部 Profile 完整恢复", async () => {
    const dir = makeTempDir();
    const first = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    const glm = await first.create(validInput);
    const deepseek = await first.create({
      ...validInput,
      name: "DeepSeek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-another",
      models: ["deepseek-chat"],
    });

    // 同目录新建 store，等价于重启应用后重新装配
    const reopened = createProfileStore({ dir, safeStorage: fakeSafeStorage });

    expect(await reopened.list()).toEqual([glm, deepseek]);
  });

  it("旧格式文件（单 model 字段）读取时升级为单元素模型列表，apiKey 解密链路不变", async () => {
    const dir = makeTempDir();
    const encryptedApiKey = (
      await fakeSafeStorage.encryptString("sk-legacy")
    ).toString("base64");
    writeFileSync(
      join(dir, "provider-profiles.json"),
      JSON.stringify({
        profiles: [
          {
            id: "legacy-1",
            name: "GLM 旧格式",
            baseURL: "https://open.bigmodel.cn/api/paas/v4",
            model: "glm-4.6",
            encryptedApiKey,
          },
        ],
      }),
      "utf8"
    );

    const store = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    const profiles = await store.list();

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.id).toBe("legacy-1");
    expect(profiles[0]?.models).toEqual(["glm-4.6"]);
    expect(profiles[0]?.apiKey).toBe("sk-legacy");
  });

  it("旧格式 Profile 下次保存写新格式（models 数组），文件中不再有单 model 字段", async () => {
    const dir = makeTempDir();
    const encryptedApiKey = (
      await fakeSafeStorage.encryptString("sk-legacy")
    ).toString("base64");
    writeFileSync(
      join(dir, "provider-profiles.json"),
      JSON.stringify({
        profiles: [
          {
            id: "legacy-1",
            name: "GLM 旧格式",
            baseURL: "https://open.bigmodel.cn/api/paas/v4",
            model: "glm-4.6",
            encryptedApiKey,
          },
        ],
      }),
      "utf8"
    );

    const store = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    const updated = await store.update("legacy-1", {
      name: "GLM 升级后",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "sk-new",
      models: ["glm-4.7", "glm-4.6"],
    });

    expect(updated?.models).toEqual(["glm-4.7", "glm-4.6"]);
    const raw = JSON.parse(
      readFileSync(join(dir, "provider-profiles.json"), "utf8")
    );
    expect(raw.profiles[0].models).toEqual(["glm-4.7", "glm-4.6"]);
    expect(raw.profiles[0]).not.toHaveProperty("model");
  });

  it("上下文窗口（可选，告警阈值用）：配置后随 Profile 持久化恢复，未配置保持 undefined", async () => {
    const dir = makeTempDir();
    const first = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    const withWindow = await first.create({
      ...validInput,
      contextWindowTokens: 200_000,
    });
    const withoutWindow = await first.create({
      ...validInput,
      name: "Ollama 本地",
    });

    expect(withWindow.contextWindowTokens).toBe(200_000);
    expect(withoutWindow.contextWindowTokens).toBeUndefined();

    const reopened = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    const restored = await reopened.list();
    expect(
      restored.find((p) => p.id === withWindow.id)?.contextWindowTokens
    ).toBe(200_000);
    expect(
      restored.find((p) => p.id === withoutWindow.id)?.contextWindowTokens
    ).toBeUndefined();
  });

  it("更新 A 等待加密期间删除 B，提交后 B 仍不存在", async () => {
    const dir = makeTempDir();
    const gate = pauseEncryptionFor("sk-update-a");
    const store = createProfileStore({ dir, safeStorage: gate.safeStorage });
    const a = await store.create({ ...validInput, name: "A" });
    const b = await store.create({ ...validInput, name: "B" });
    const updating = store.update(a.id, {
      ...validInput,
      name: "A 已更新",
      apiKey: "sk-update-a",
    });
    await gate.encrypting;
    try {
      expect(await store.remove(b.id)).toBe(true);
      expect(await store.list()).toEqual([a]);
    } finally {
      gate.resume();
    }

    const updated = await updating;
    const reopened = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    expect(await reopened.list()).toEqual([updated]);
  });

  it("并发创建的加密乱序完成后，两份 Provider Profile 均可重读", async () => {
    const dir = makeTempDir();
    const gate = pauseEncryptionFor("sk-slow-create");
    const store = createProfileStore({ dir, safeStorage: gate.safeStorage });
    const creating = store.create({
      ...validInput,
      name: "慢创建",
      apiKey: "sk-slow-create",
    });
    await gate.encrypting;
    let fast;
    try {
      fast = await store.create({ ...validInput, name: "快创建" });
    } finally {
      gate.resume();
    }
    const slow = await creating;

    expect(
      await createProfileStore({ dir, safeStorage: fakeSafeStorage }).list()
    ).toEqual([fast, slow]);
  });

  it("更新目标在加密期间被删除则返回 null，不复活目标", async () => {
    const dir = makeTempDir();
    const gate = pauseEncryptionFor("sk-deleted");
    const store = createProfileStore({ dir, safeStorage: gate.safeStorage });
    const target = await store.create(validInput);
    const updating = store.update(target.id, {
      ...validInput,
      apiKey: "sk-deleted",
    });
    await gate.encrypting;
    try {
      expect(await store.remove(target.id)).toBe(true);
    } finally {
      gate.resume();
    }

    expect(await updating).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("不同 Profile 并发更新不会回滚先提交的字段", async () => {
    const dir = makeTempDir();
    const gate = pauseEncryptionFor("sk-slow-update");
    const store = createProfileStore({ dir, safeStorage: gate.safeStorage });
    const a = await store.create({ ...validInput, name: "A" });
    const b = await store.create({ ...validInput, name: "B" });
    const updating = store.update(a.id, {
      ...validInput,
      name: "A 已更新",
      apiKey: "sk-slow-update",
    });
    await gate.encrypting;
    let updatedB;
    try {
      updatedB = await store.update(b.id, { ...validInput, name: "B 已更新" });
    } finally {
      gate.resume();
    }
    const updatedA = await updating;

    expect(await store.list()).toEqual([updatedA, updatedB]);
  });

  it("创建等待加密期间的删除和更新都保留在最终配置", async () => {
    const dir = makeTempDir();
    const gate = pauseEncryptionFor("sk-new-profile");
    const store = createProfileStore({ dir, safeStorage: gate.safeStorage });
    const a = await store.create({ ...validInput, name: "A" });
    const b = await store.create({ ...validInput, name: "B" });
    const creating = store.create({
      ...validInput,
      name: "C",
      apiKey: "sk-new-profile",
    });
    await gate.encrypting;
    let updatedB;
    try {
      expect(await store.remove(a.id)).toBe(true);
      updatedB = await store.update(b.id, { ...validInput, name: "B 已更新" });
    } finally {
      gate.resume();
    }
    const c = await creating;

    expect(await store.list()).toEqual([updatedB, c]);
  });

  it("更新等待加密期间新增的 Profile 不会被覆盖", async () => {
    const dir = makeTempDir();
    const gate = pauseEncryptionFor("sk-updating");
    const store = createProfileStore({ dir, safeStorage: gate.safeStorage });
    const a = await store.create(validInput);
    const updating = store.update(a.id, {
      ...validInput,
      name: "更新完成",
      apiKey: "sk-updating",
    });
    await gate.encrypting;
    let created;
    try {
      created = await store.create({ ...validInput, name: "新增配置" });
    } finally {
      gate.resume();
    }

    const updated = await updating;
    expect(await store.list()).toEqual([updated, created]);
  });

  it.each([
    { operation: "create", method: "encryptString" },
    { operation: "create", method: "decryptString" },
    { operation: "update", method: "encryptString" },
    { operation: "update", method: "decryptString" },
  ] as const)(
    "$operation 的凭据 $method 失败时拒绝保存，原 Profile 文件及可读值保持不变",
    async ({ operation, method }) => {
      const dir = makeTempDir();
      const original = createProfileStore({
        dir,
        safeStorage: fakeSafeStorage,
      });
      const saved = await original.create(validInput);
      const path = join(dir, "provider-profiles.json");
      const before = readFileSync(path, "utf8");
      const failing = createProfileStore({
        dir,
        safeStorage: {
          ...fakeSafeStorage,
          [method]: async () => {
            throw new Error("凭据处理失败，请重试");
          },
        },
      });
      const input = { ...validInput, apiKey: "sk-replacement", name: "新配置" };

      await expect(
        operation === "create"
          ? failing.create(input)
          : failing.update(saved.id, input)
      ).rejects.toThrow("凭据处理失败");
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(await original.list()).toEqual([saved]);
    }
  );

  it("新 adapter 混读旧新密文不迁移，旧 key 丢失时保留文件且仅显式更新替换该项", async () => {
    const dir = makeTempDir();
    const legacy = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    const old = await legacy.create(validInput);
    const path = join(dir, "provider-profiles.json");
    const original = readFileSync(path, "utf8");
    let legacyReadable = true;
    const makeStorage = () =>
      createCredentialStorage({
        platform: "win32",
        legacy: {
          ...fakeSafeStorage,
          decryptString: async (encrypted: Buffer) => {
            if (!legacyReadable)
              throw new Error("不可展示的原始错误 sk-legacy-secret");
            return fakeSafeStorage.decryptString(encrypted);
          },
        },
        protector: {
          protect: async (plain: Buffer) => Buffer.from(plain).reverse(),
          unprotect: async (encrypted: Buffer) =>
            Buffer.from(encrypted).reverse(),
        },
      });
    const store = createProfileStore({ dir, safeStorage: makeStorage() });
    expect(await store.list()).toEqual([old]);
    expect(readFileSync(path, "utf8")).toBe(original);
    const fresh = await store.create({
      ...validInput,
      name: "新凭据",
      apiKey: "sk-fresh",
    });
    const mixed = readFileSync(path, "utf8");
    expect(mixed).not.toContain(validInput.apiKey);
    expect(mixed).not.toContain("sk-fresh");
    expect(JSON.parse(mixed).profiles[0]).toEqual(
      JSON.parse(original).profiles[0]
    );
    const reopened = createProfileStore({ dir, safeStorage: makeStorage() });
    expect(await reopened.list()).toEqual([old, fresh]);
    expect(readFileSync(path, "utf8")).toBe(mixed);

    legacyReadable = false;
    // 新实例模拟重启，不能借成功解密缓存掩盖旧 Electron key 丢失。
    const failed = createProfileStore({ dir, safeStorage: makeStorage() });
    await expect(failed.list()).rejects.toThrow(
      /^系统凭据加密存储不可用或数据损坏，已拒绝处理凭据$/
    );
    expect(readFileSync(path, "utf8")).toBe(mixed);
    const replacement = await failed.update(old.id, {
      ...validInput,
      apiKey: "sk-replacement",
    });
    expect(
      await createProfileStore({ dir, safeStorage: makeStorage() }).list()
    ).toEqual([replacement, fresh]);
    expect(JSON.parse(readFileSync(path, "utf8")).profiles[1]).toEqual(
      JSON.parse(mixed).profiles[1]
    );
  });

  it("safeStorage 不可用时 create/update 抛错，绝不写明文 key", async () => {
    const dir = makeTempDir();
    const store = createProfileStore({
      dir,
      safeStorage: {
        ...fakeSafeStorage,
        isEncryptionAvailable: async () => false,
      },
    });

    await expect(store.create(validInput)).rejects.toThrow(/safeStorage/);

    // 即使先有合法数据，不可用时 update 也应拒绝
    const ok = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    const created = await ok.create(validInput);
    await expect(
      store.update(created.id, { ...validInput, name: "X" })
    ).rejects.toThrow(/safeStorage/);
    expect(
      readFileSync(join(dir, "provider-profiles.json"), "utf8")
    ).not.toContain("sk-plaintext-secret");
  });
});
