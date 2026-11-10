import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createSearchSettingsStore } from '../../src/search/search-settings-store';

/** 测试用安全存储替身：base64 可逆变换，保证明文不直接落盘（与 profile-store 测试同款） */
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

const unavailableSafeStorage = {
  ...fakeSafeStorage,
  isEncryptionAvailable: async () => false,
};

let tempDir: string;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'codexlike-search-settings-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('SearchSettingsStore', () => {
  it('未配置（无文件）：get 返回空 apiKey，视为未配置搜索源', async () => {
    const store = createSearchSettingsStore({
      dir: makeTempDir(),
      safeStorage: fakeSafeStorage,
    });
    expect(await store.get()).toEqual({ provider: 'tavily', apiKey: '' });
  });

  it('保存 key：加密落盘无明文，get 解密返回', async () => {
    const dir = makeTempDir();
    const store = createSearchSettingsStore({ dir, safeStorage: fakeSafeStorage });

    await store.set({ apiKey: 'tvly-plaintext-secret' });

    const settings = await store.get();
    expect(settings).toEqual({ provider: 'tavily', apiKey: 'tvly-plaintext-secret' });

    const raw = readFileSync(join(dir, 'search-settings.json'), 'utf8');
    expect(raw).not.toContain('tvly-plaintext-secret');
    // 落盘只有 base64 的 encryptedApiKey，无明文字段
    expect(JSON.parse(raw)).toEqual({
      provider: 'tavily',
      encryptedApiKey: expect.not.stringContaining('tvly-plaintext-secret'),
    });
  });

  it('set 空字符串清除配置：get 回到未配置态，落盘文件同步清理', async () => {
    const dir = makeTempDir();
    const store = createSearchSettingsStore({ dir, safeStorage: fakeSafeStorage });
    await store.set({ apiKey: 'tvly-x' });

    await store.set({ apiKey: '' });

    expect(await store.get()).toEqual({ provider: 'tavily', apiKey: '' });
    // 清除后文件不存在或不含加密 key（下次启动 get 仍为未配置）
    const store2 = createSearchSettingsStore({ dir, safeStorage: fakeSafeStorage });
    expect(await store2.get()).toEqual({ provider: 'tavily', apiKey: '' });
  });

  it('同目录重建等价重启：配置完整恢复', async () => {
    const dir = makeTempDir();
    const first = createSearchSettingsStore({ dir, safeStorage: fakeSafeStorage });
    await first.set({ apiKey: 'tvly-keep-me' });

    const second = createSearchSettingsStore({ dir, safeStorage: fakeSafeStorage });
    expect(await second.get()).toEqual({ provider: 'tavily', apiKey: 'tvly-keep-me' });
  });

  it('safeStorage 不可用：拒绝保存（不落明文），get 保持未配置', async () => {
    const dir = makeTempDir();
    const store = createSearchSettingsStore({
      dir,
      safeStorage: unavailableSafeStorage,
    });
    await expect(store.set({ apiKey: 'tvly-x' })).rejects.toThrow('safeStorage');
    expect(existsSync(join(dir, 'search-settings.json'))).toBe(false);
    expect(await store.get()).toEqual({ provider: 'tavily', apiKey: '' });
  });
});
