import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { basename } from 'node:path';

import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderProfile } from '../../src/provider/provider-profile';
import { createSqliteSessionStore } from '../../src/session/persistence';
import { createSessionManager } from '../../src/session/manager';

const profile: ProviderProfile = {
  id: 'profile-1',
  name: 'GLM',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-test',
  model: 'glm-4.7',
};

function okModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 'text-1' });
          controller.enqueue({ type: 'text-delta', id: 'text-1', delta: '好的' });
          controller.enqueue({ type: 'text-end', id: 'text-1' });
          controller.enqueue({
            type: 'finish',
            usage: {
              inputTokens: {
                total: 1,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: 1,
                text: undefined,
                reasoning: undefined,
              },
            },
            finishReason: { unified: 'stop' as const, raw: 'stop' },
          });
          controller.close();
        },
      }),
    }),
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createSessionManager（会话创建 / 列表 / 恢复）', () => {
  it('create 落库并默认以工作区目录名作为标题；list 按 updatedAt 倒序', async () => {
    const persistence = createSqliteSessionStore(':memory:');
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    const session = manager.create({ workspacePath: 'C:\\work\\demo' });
    // 消费完整事件流（等价一次消息往返完成）
    for await (const _event of session.sendMessage({ text: '你好', profile })) {
      // 只驱动流走完
    }

    expect(session.id).not.toBe('');
    const records = manager.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.title).toBe(basename('C:\\work\\demo') || 'demo');
    expect(records[0]?.status).toBe('idle');
    persistence.close();
  });

  it('get 惰性恢复既有会话：历史完整接续（等价应用重启后继续对话）', async () => {
    const dbPath = join(
      (() => {
        const dir = mkdtempSync(join(tmpdir(), 'codexlike-mgr-'));
        tempDirs.push(dir);
        return dir;
      })(),
      'codexlike.db',
    );

    const model = okModel();
    const persistence1 = createSqliteSessionStore(dbPath);
    const first = createSessionManager({
      persistence: persistence1,
      languageModelFor: () => model,
    });
    const session = first.create({ workspacePath: 'C:\\work\\demo' });
    for await (const _event of session.sendMessage({ text: '第一问', profile })) {
      // 消费完整流
    }
    expect(first.messages(session.id).map((m) => m.content)).toContain('第一问');

    // 等价重启：同一库文件上的新 manager
    const persistence2 = createSqliteSessionStore(dbPath);
    const second = createSessionManager({
      persistence: persistence2,
      languageModelFor: () => model,
    });
    const listed = second.list();
    expect(listed).toHaveLength(1);
    expect(second.messages(listed[0]!.id).map((m) => m.content)).toContain('第一问');

    const restored = second.get(listed[0]!.id);
    expect(restored).not.toBeNull();
    for await (const _event of restored!.sendMessage({ text: '第二问', profile })) {
      // 消费完整流
    }
    // 恢复后继续的对话包含重启前的历史
    const contents = second.messages(listed[0]!.id).map((m) => m.content);
    expect(contents).toContain('第一问');
    expect(contents).toContain('第二问');
    persistence1.close();
    persistence2.close();
  });

  it('恢复时把异常残留的 streaming 状态重置为 idle', () => {
    const persistence = createSqliteSessionStore(':memory:');
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const session = manager.create({ workspacePath: 'C:\\work\\demo' });
    // 模拟应用在流式中途被杀：库里残留 streaming
    persistence.updateSession(session.id, { status: 'streaming' });
    expect(persistence.listSessions().at(0)?.status).toBe('streaming');

    // get 惰性恢复：用全新 manager 绕过缓存，读取残留记录并重置为 idle 落库
    const manager2 = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const restored = manager2.get(session.id);
    expect(restored).not.toBeNull();
    expect(persistence.listSessions().at(0)?.status).toBe('idle');
    persistence.close();
  });

  it('get 不存在的会话返回 null；create 后 get 返回同一实例（缓存）', () => {
    const persistence = createSqliteSessionStore(':memory:');
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    expect(manager.get('nope')).toBeNull();

    const session = manager.create({ workspacePath: 'C:\\work\\demo' });
    expect(manager.get(session.id)).toBe(session);
    persistence.close();
  });
});
