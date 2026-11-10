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

  it('审批模式随会话落库：insert 读回一致，updateSession 补丁生效', () => {
    const store = createSqliteSessionStore(':memory:');
    store.insertSession(sessionRecord({ approvalMode: 'readonly' }));
    expect(store.listSessions()[0]?.approvalMode).toBe('readonly');

    store.updateSession('session-1', { approvalMode: 'full', updatedAt: '2026-11-10T08:30:00.000Z' });
    expect(store.listSessions()[0]?.approvalMode).toBe('full');
  });

  it('「总是允许」记忆入库：幂等（同词不重复）、按会话隔离、重开库完整恢复', () => {
    const dbPath = tempDbPath();
    const first = createSqliteSessionStore(dbPath);
    first.insertSession(sessionRecord({ id: 'session-a' }));
    first.insertSession(sessionRecord({ id: 'session-b', createdAt: '2026-11-10T09:00:00.000Z', updatedAt: '2026-11-10T09:00:00.000Z' }));

    first.insertApproval('session-a', 'git');
    first.insertApproval('session-a', 'git'); // 幂等：同词重复写入不重复
    first.insertApproval('session-a', 'pnpm');
    first.insertApproval('session-b', 'npm');

    expect(first.listApprovals('session-a')).toEqual(['git', 'pnpm']);
    expect(first.listApprovals('session-b')).toEqual(['npm']);
    expect(first.listApprovals('nope')).toEqual([]);
    first.close();

    // 等价应用重启：记忆完整恢复（审批恢复后仍生效的数据来源）
    const reopened = createSqliteSessionStore(dbPath);
    expect(reopened.listApprovals('session-a')).toEqual(['git', 'pnpm']);
    reopened.close();
  });

  it('旧库迁移：工单 03 时代 schema（无 approval_mode / approvals 表）打开后自动补齐', () => {
    const dbPath = tempDbPath();
    // 手工建 03 时代的旧 schema 并写入一行旧会话
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        provider_profile_id TEXT,
        model TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions VALUES ('legacy-1', '旧会话', 'C:\\work\\old', NULL, NULL, 'idle', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    `);
    raw.close();

    // 打开旧库：迁移幂等补列（approval_mode 默认 suggest）+ approvals 表可用
    const store = createSqliteSessionStore(dbPath);
    const record = store.listSessions()[0]!;
    expect(record.id).toBe('legacy-1');
    expect(record.approvalMode).toBe('suggest');
    store.insertApproval('legacy-1', 'git');
    expect(store.listApprovals('legacy-1')).toEqual(['git']);
    store.updateSession('legacy-1', { approvalMode: 'full', updatedAt: '2026-11-02T00:00:00.000Z' });
    expect(store.listSessions()[0]?.approvalMode).toBe('full');
    store.close();
  });
});
