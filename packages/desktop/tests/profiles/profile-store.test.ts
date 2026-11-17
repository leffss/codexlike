import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderProfileInput } from "@codexlike/agent-core";

import { createProfileStore } from "../../src/profiles/profile-store";

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
