import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { createSqliteSessionStore } from '../../src/session/persistence';
import type { SessionRecord, StoredMessage } from '../../src/session/types';

/** 最小合法会话记录（固定时间戳避免测试不稳定） */
function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    title: 'demo',
    workspacePath: 'C:\\work\\demo',
    providerProfileId: null,
    model: null,
    status: 'idle',
    approvalMode: 'suggest',
    archivedAt: null,
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T08:00:00.000Z',
    ...overrides,
  };
}

/** 最小合法消息记录 */
function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    role: 'user',
    content: '你好',
    createdAt: '2026-11-10T08:00:01.000Z',
    ...overrides,
  };
}

const tempDirs: string[] = [];

/** 每个用例独立的临时目录（文件库路径） */
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codexlike-store-'));
  tempDirs.push(dir);
  return join(dir, 'codexlike.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createSqliteSessionStore（SQLite 会话持久化）', () => {
  it('插入的会话与消息可原样读回（内存库）', () => {
    const store = createSqliteSessionStore(':memory:');

    store.insertSession(sessionRecord());
    store.insertMessage(message());
    store.insertMessage(
      message({
        id: 'message-2',
        role: 'assistant',
        content: '你好，有什么可以帮你？',
        createdAt: '2026-11-10T08:00:02.000Z',
      }),
    );

    expect(store.listSessions()).toEqual([sessionRecord()]);
    expect(store.listMessages('session-1')).toEqual([
      message(),
      message({
        id: 'message-2',
        role: 'assistant',
        content: '你好，有什么可以帮你？',
        createdAt: '2026-11-10T08:00:02.000Z',
      }),
    ]);
  });

  it('同一路径重开 store（等价应用重启）数据完整恢复', () => {
    const dbPath = tempDbPath();

    const first = createSqliteSessionStore(dbPath);
    first.insertSession(
      sessionRecord({ id: 'session-a', title: '项目A' }),
    );
    first.insertSession(
      sessionRecord({
        id: 'session-b',
        title: '项目B',
        createdAt: '2026-11-10T09:00:00.000Z',
        updatedAt: '2026-11-10T09:00:00.000Z',
      }),
    );
    first.insertMessage(message({ sessionId: 'session-b' }));
    first.close();

    const reopened = createSqliteSessionStore(dbPath);
    // updatedAt 倒序：session-b（09:00）比 session-a（08:00）新
    const ids = reopened.listSessions().map((s) => s.id);
    expect(ids).toEqual(['session-b', 'session-a']);
    expect(reopened.listMessages('session-b')).toHaveLength(1);
    reopened.close();
  });

  it('listSessions 按更新时间倒序（最近使用的排最前）', () => {
    const store = createSqliteSessionStore(':memory:');
    store.insertSession(sessionRecord({ id: 'old', updatedAt: '2026-11-10T08:00:00.000Z' }));
    store.insertSession(
      sessionRecord({
        id: 'new',
        createdAt: '2026-11-10T09:00:00.000Z',
        updatedAt: '2026-11-10T09:00:00.000Z',
      }),
    );

    store.updateSession('old', {
      status: 'streaming',
      updatedAt: '2026-11-10T10:00:00.000Z',
    });

    expect(store.listSessions().map((s) => s.id)).toEqual(['old', 'new']);
    expect(store.listSessions()[0]?.status).toBe('streaming');
  });

  it('未写入过的会话消息查询返回空数组', () => {
    const store = createSqliteSessionStore(':memory:');
    expect(store.listMessages('nope')).toEqual([]);
  });

  it('消息的 @引用 与中断标记原样往返（快照恢复的数据来源）', () => {
    const dbPath = tempDbPath();
    const store = createSqliteSessionStore(dbPath);
    store.insertSession(sessionRecord());
    store.insertMessage(
      message({
        mentions: [{ path: 'material.txt', content: '被引用的文件内容' }],
      }),
    );
    store.insertMessage(
      message({
        id: 'message-2',
        role: 'assistant',
        content: '部分回复',
        aborted: true,
        createdAt: '2026-11-10T08:00:02.000Z',
      }),
    );
    store.close();

    const reopened = createSqliteSessionStore(dbPath);
    const restored = reopened.listMessages('session-1');
    expect(restored[0]?.mentions).toEqual([
      { path: 'material.txt', content: '被引用的文件内容' },
    ]);
    expect(restored[0]?.aborted).toBeUndefined();
    expect(restored[1]?.aborted).toBe(true);
    expect(restored[1]?.mentions).toBeUndefined();
    reopened.close();
  });

  it('工单 03 时代的旧库（messages 无 mentions/aborted 列）打开时幂等迁移，旧数据可读', async () => {
    const dbPath = tempDbPath();
    // 手工建工单 03 时代的旧 schema（messages 无 mentions / aborted 列，07 踩坑样例）
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_path TEXT NOT NULL,
      provider_profile_id TEXT, model TEXT, status TEXT NOT NULL, archived_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.prepare(
      'INSERT INTO sessions (id, title, workspace_path, provider_profile_id, model, status, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('session-1', 'demo', 'C:\\work\\demo', null, null, 'idle', null,
      '2026-11-10T08:00:00.000Z', '2026-11-10T08:00:00.000Z');
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('legacy-1', 'session-1', 'user', '旧消息', '2026-11-10T08:00:01.000Z');
    db.close();

    const migrated = createSqliteSessionStore(dbPath);
    const messages = migrated.listMessages('session-1');
    expect(messages).toEqual([
      {
        id: 'legacy-1',
        sessionId: 'session-1',
        role: 'user',
        content: '旧消息',
        createdAt: '2026-11-10T08:00:01.000Z',
      },
    ]);
    // 迁移后可继续按新 schema 写入
    migrated.insertMessage(
      message({ id: 'new-1', createdAt: '2026-11-10T08:00:02.000Z' }),
    );
    expect(migrated.listMessages('session-1')).toHaveLength(2);
    migrated.close();
  });
});

describe('SessionPersistence compact 落库（工单 08）', () => {
  it('replaceHistory 单事务替换消息历史并追加 compact 记录；重开库完整恢复', () => {
    const dbPath = tempDbPath();
    const store = createSqliteSessionStore(dbPath);
    store.insertSession(sessionRecord());
    store.insertMessage(message({ id: 'm1', content: '旧问题1' }));
    store.insertMessage(message({ id: 'm2', role: 'assistant', content: '旧回复1', createdAt: '2026-11-10T08:00:02.000Z' }));
    store.insertMessage(message({ id: 'm3', content: '旧问题2', createdAt: '2026-11-10T08:00:03.000Z' }));

    store.replaceHistory(
      'session-1',
      [
        message({ id: 'summary-1', role: 'compact-summary', content: '摘要', createdAt: '2026-11-10T09:00:00.000Z' }),
        message({ id: 'kept-1', content: '旧问题2', createdAt: '2026-11-10T09:00:01.000Z' }),
      ],
      {
        id: 'compact-1',
        sessionId: 'session-1',
        summary: '摘要',
        messagesCompacted: 2,
        createdAt: '2026-11-10T09:00:02.000Z',
      },
    );
    store.close();

    const reopened = createSqliteSessionStore(dbPath);
    expect(reopened.listMessages('session-1').map((m) => [m.id, m.role])).toEqual([
      ['summary-1', 'compact-summary'],
      ['kept-1', 'user'],
    ]);
    expect(reopened.listCompacts('session-1')).toEqual([
      {
        id: 'compact-1',
        sessionId: 'session-1',
        summary: '摘要',
        messagesCompacted: 2,
        createdAt: '2026-11-10T09:00:02.000Z',
      },
    ]);
    reopened.close();
  });

  it('listCompacts 按时间正序（多次压缩累积，末条为当前生效摘要）', () => {
    const store = createSqliteSessionStore(':memory:');
    store.insertSession(sessionRecord());
    const compact = (id: string, at: string) =>
      store.replaceHistory(
        'session-1',
        [message({ id: `s-${id}`, role: 'compact-summary', content: `摘要${id}`, createdAt: at })],
        {
          id,
          sessionId: 'session-1',
          summary: `摘要${id}`,
          messagesCompacted: 2,
          createdAt: at,
        },
      );
    compact('c-2', '2026-11-10T09:00:00.000Z');
    compact('c-1', '2026-11-10T08:00:00.000Z');

    expect(store.listCompacts('session-1').map((c) => c.id)).toEqual(['c-1', 'c-2']);
    expect(store.listCompacts('nope')).toEqual([]);
    store.close();
  });

  it('工单 02/07 时代的旧库（无 compact_records 表）打开时自动建表，旧数据不受影响', () => {
    const dbPath = tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_path TEXT NOT NULL,
        provider_profile_id TEXT, model TEXT, status TEXT NOT NULL, archived_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO sessions VALUES ('session-1', 'demo', 'C:\\work', NULL, NULL, 'idle', NULL, '2026-11-10T08:00:00.000Z', '2026-11-10T08:00:00.000Z');
      INSERT INTO messages VALUES ('m1', 'session-1', 'user', '旧消息', '2026-11-10T08:00:01.000Z');
    `);
    db.close();

    const store = createSqliteSessionStore(dbPath);
    expect(store.listMessages('session-1')).toHaveLength(1);
    expect(store.listCompacts('session-1')).toEqual([]);
    store.close();
  });
});
