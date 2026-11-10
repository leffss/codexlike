import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderProfileInput } from '@codexlike/agent-core';

import { createProfileStore } from '../../src/profiles/profile-store';

/** 测试用安全存储替身：base64 可逆变换，保证明文不直接落盘 */
const fakeSafeStorage = {
  isEncryptionAvailable: async () => true,
  encryptString: async (plainText: string) =>
    Buffer.from(`enc:${Buffer.from(plainText, 'utf8').toString('base64')}`),
  decryptString: async (encrypted: Buffer) => {
    const text = encrypted.toString('utf8');
    if (!text.startsWith('enc:')) {
      throw new Error('decryptString 收到未加密数据');
    }
    return Buffer.from(text.slice(4), 'base64').toString('utf8');
  },
};

const validInput: ProviderProfileInput = {
  name: 'GLM',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-plaintext-secret',
  model: 'glm-4.7',
};

let tempDir: string;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'codexlike-profile-store-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('profile store（safeStorage 加密落盘）', () => {
  it('create 后 list() 返回明文 apiKey，且数据文件中检索不到明文 key', async () => {
    const dir = makeTempDir();
    const store = createProfileStore({ dir, safeStorage: fakeSafeStorage });

    const created = await store.create(validInput);

    expect(created.name).toBe('GLM');
    expect(created.apiKey).toBe('sk-plaintext-secret');
    expect(await store.list()).toEqual([created]);

    const raw = readFileSync(join(dir, 'provider-profiles.json'), 'utf8');
    expect(raw).not.toContain('sk-plaintext-secret');
    expect(raw).toContain('encryptedApiKey'); // 落盘的是加密形态字段
  });

  it('update 修改字段并保持加密落盘；remove 删除后 list 不再包含', async () => {
    const dir = makeTempDir();
    const store = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    const created = await store.create(validInput);
    await store.create({
      ...validInput,
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-another',
      model: 'deepseek-chat',
    });

    const updated = await store.update(created.id, {
      ...validInput,
      name: 'GLM 2',
      model: 'glm-5',
    });

    expect(updated?.name).toBe('GLM 2');
    expect(updated?.model).toBe('glm-5');
    expect((await store.list()).map((p) => p.name)).toEqual(['GLM 2', 'DeepSeek']);
    expect(readFileSync(join(dir, 'provider-profiles.json'), 'utf8')).not.toContain(
      'sk-plaintext-secret',
    );

    expect(await store.remove(created.id)).toBe(true);
    expect((await store.list()).map((p) => p.name)).toEqual(['DeepSeek']);
    expect(await store.remove(created.id)).toBe(false);
  });

  it('重新打开存储（模拟应用重启）后全部 Profile 完整恢复', async () => {
    const dir = makeTempDir();
    const first = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    const glm = await first.create(validInput);
    const deepseek = await first.create({
      ...validInput,
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-another',
      model: 'deepseek-chat',
    });

    // 同目录新建 store，等价于重启应用后重新装配
    const reopened = createProfileStore({ dir, safeStorage: fakeSafeStorage });

    expect(await reopened.list()).toEqual([glm, deepseek]);
  });

  it('safeStorage 不可用时 create/update 抛错，绝不写明文 key', async () => {
    const dir = makeTempDir();
    const store = createProfileStore({
      dir,
      safeStorage: { ...fakeSafeStorage, isEncryptionAvailable: async () => false },
    });

    await expect(store.create(validInput)).rejects.toThrow(/safeStorage/);

    // 即使先有合法数据，不可用时 update 也应拒绝
    const ok = createProfileStore({ dir, safeStorage: fakeSafeStorage });
    const created = await ok.create(validInput);
    await expect(
      store.update(created.id, { ...validInput, name: 'X' }),
    ).rejects.toThrow(/safeStorage/);
    expect(readFileSync(join(dir, 'provider-profiles.json'), 'utf8')).not.toContain(
      'sk-plaintext-secret',
    );
  });
});
