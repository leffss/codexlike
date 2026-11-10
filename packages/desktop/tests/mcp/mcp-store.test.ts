import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMcpStore } from '../../src/mcp/mcp-store';

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

const fakeInput = {
  name: 'fake-server',
  command: 'node',
  args: ['server.js', '--stdio'],
  env: { FAKE_TOKEN: 'secret-token-123' },
};

let tempDir: string;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'codexlike-mcp-store-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('mcp store（server 配置 + 工具启停，env 值加密落盘）', () => {
  it('createServer 后 list 返回明文 env，数据文件中检索不到明文值', async () => {
    const dir = makeTempDir();
    const store = createMcpStore({ dir, safeStorage: fakeSafeStorage });

    const created = await store.createServer(fakeInput);

    expect(created).toMatchObject({
      name: 'fake-server',
      command: 'node',
      args: ['server.js', '--stdio'],
      env: { FAKE_TOKEN: 'secret-token-123' },
    });
    expect(created.id).not.toBe('');

    const snapshot = await store.snapshot();
    expect(snapshot.servers).toHaveLength(1);

    const raw = readFileSync(join(dir, 'mcp-servers.json'), 'utf8');
    expect(raw).not.toContain('secret-token-123');
    expect(raw).toContain('encryptedEnv');
  });

  it('空 env 的 server 无需加密也可保存（safeStorage 不可用仅拒绝含 env 的保存）', async () => {
    const dir = makeTempDir();
    const unavailable = {
      ...fakeSafeStorage,
      isEncryptionAvailable: async () => false,
    };
    const store = createMcpStore({ dir, safeStorage: unavailable });

    const created = await store.createServer({
      name: 'plain',
      command: 'node',
      args: [],
      env: {},
    });
    expect(created.name).toBe('plain');

    await expect(
      store.createServer(fakeInput),
    ).rejects.toThrow(/safeStorage|加密/);
  });

  it('removeServer 删除配置；工具启停持久化且重启（新 store 实例）恢复', async () => {
    const dir = makeTempDir();
    const store = createMcpStore({ dir, safeStorage: fakeSafeStorage });
    const first = await store.createServer(fakeInput);
    const second = await store.createServer({
      name: 'another',
      command: 'node',
      args: [],
      env: {},
    });

    await store.setToolEnabled('mcp_fake_server_echo', false);
    await store.setToolEnabled('mcp_another_greet', false);
    await store.setToolEnabled('mcp_another_greet', true); // 再启用 = 从禁用表移除

    expect((await store.removeServer(second.id)).status).toBe('removed');

    // 同目录新建 store = 等价重启
    const reopened = createMcpStore({ dir, safeStorage: fakeSafeStorage });
    const snapshot = await reopened.snapshot();
    expect(snapshot.servers.map((server) => server.name)).toEqual(['fake-server']);
    expect(snapshot.disabledTools).toEqual(['mcp_fake_server_echo']);
  });

  it('输入校验：name/command 必填，args/env 形状不对时报中文错误', async () => {
    const dir = makeTempDir();
    const store = createMcpStore({ dir, safeStorage: fakeSafeStorage });

    await expect(
      store.createServer({ name: '', command: 'node', args: [], env: {} }),
    ).rejects.toThrow('名称');
    await expect(
      store.createServer({ name: 'x', command: '', args: [], env: {} }),
    ).rejects.toThrow('命令');
    await expect(
      // @ts-expect-error 故意传非法形状
      store.createServer({ name: 'x', command: 'node', args: 'not-array', env: {} }),
    ).rejects.toThrow();
  });

  it('removeServer 不存在的 id 返回 not-found', async () => {
    const dir = makeTempDir();
    const store = createMcpStore({ dir, safeStorage: fakeSafeStorage });
    expect((await store.removeServer('nope')).status).toBe('not-found');
  });

  it('空目录首启：文件不存在时 snapshot 返回空配置', async () => {
    const dir = makeTempDir();
    const store = createMcpStore({ dir, safeStorage: fakeSafeStorage });
    const snapshot = await store.snapshot();
    expect(snapshot.servers).toEqual([]);
    expect(snapshot.disabledTools).toEqual([]);
    expect(existsSync(join(dir, 'mcp-servers.json'))).toBe(false);
  });
});
