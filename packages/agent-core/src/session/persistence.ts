import { DatabaseSync } from 'node:sqlite';

import type { ToolCallRecord } from '../tools/types';
import type { SessionRecord, StoredMessage } from './types';

/**
 * 会话持久化接口（spec「会话与持久化」节）。
 * 以接口注入：生产环境用 SQLite 文件库（`~/.codexlike/`），
 * 测试可换内存库或内存实现（ADR-0002：agent-core 可用 Node 内置 API，不依赖 Electron）。
 *
 * 前瞻：审批决定、compact 记录在后续工单各自建表，届时在此接口上扩展方法。
 */
export interface SessionPersistence {
  insertSession(record: SessionRecord): void;
  /** 只更新给定字段；目标不存在时静默忽略（写入方持有内存态，读路径不经过这里） */
  updateSession(
    id: string,
    patch: Partial<Omit<SessionRecord, 'id' | 'createdAt'>>,
  ): void;
  insertMessage(message: StoredMessage): void;
  /** 全部会话，按 updatedAt 倒序（最近使用的排最前） */
  listSessions(): SessionRecord[];
  /** 指定会话的全部消息，按写入顺序；未知会话返回空数组 */
  listMessages(sessionId: string): StoredMessage[];
  /** 工具调用记录（一次调用完成时写入一条完整记录） */
  insertToolCall(call: ToolCallRecord): void;
  /** 指定会话的工具调用记录，按写入顺序 */
  listToolCalls(sessionId: string): ToolCallRecord[];
  /** 释放数据库句柄（宿主退出前调用；Windows 上未关闭会锁住库文件） */
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  provider_profile_id TEXT,
  model TEXT,
  status TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  mentions TEXT,
  aborted INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages(session_id, created_at);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  arguments TEXT NOT NULL,
  output TEXT NOT NULL,
  is_error INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session_created
  ON tool_calls(session_id, created_at);
`;

interface SessionRow {
  id: string;
  title: string;
  workspace_path: string;
  provider_profile_id: string | null;
  model: string | null;
  status: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  mentions: string | null;
  aborted: number | null;
}

interface ToolCallRow {
  id: string;
  session_id: string;
  tool_name: string;
  arguments: string;
  output: string;
  is_error: number;
  created_at: string;
}

/**
 * 基于 node:sqlite（Node 22.13+ / Electron 45 内置，无原生编译依赖）的会话存储。
 * 单条语句写入即单个事务（SQLite 语义），断电安全。
 * 测试传 `:memory:` 得到内存库。
 */
export function createSqliteSessionStore(dbPath: string): SessionPersistence {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // 旧库迁移：工单 02 时代的 sessions 表没有 archived_at（工单 07 /archive 需要）
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN archived_at TEXT');
  } catch {
    // 列已存在（新库或已迁移）
  }
  // 旧库迁移：工单 03 时代的 messages 表没有 mentions / aborted（工单 06 恢复等价性需要）
  try {
    db.exec('ALTER TABLE messages ADD COLUMN mentions TEXT');
  } catch {
    // 列已存在
  }
  try {
    db.exec('ALTER TABLE messages ADD COLUMN aborted INTEGER');
  } catch {
    // 列已存在
  }

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, title, workspace_path, provider_profile_id, model, status, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const updateSessionStmt = db.prepare(
    'UPDATE sessions SET title = ?, workspace_path = ?, provider_profile_id = ?, model = ?, status = ?, archived_at = ?, updated_at = ? WHERE id = ?',
  );
  const insertMessageStmt = db.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at, mentions, aborted) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const listSessionsStmt = db.prepare(
    'SELECT * FROM sessions ORDER BY updated_at DESC, rowid DESC',
  );
  const listMessagesStmt = db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid',
  );
  const insertToolCallStmt = db.prepare(
    'INSERT INTO tool_calls (id, session_id, tool_name, arguments, output, is_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const listToolCallsStmt = db.prepare(
    'SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at, rowid',
  );

  function toRecord(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      title: row.title,
      workspacePath: row.workspace_path,
      providerProfileId: row.provider_profile_id,
      model: row.model,
      status: row.status as SessionRecord['status'],
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return {
    insertSession(record) {
      insertSession.run(
        record.id,
        record.title,
        record.workspacePath,
        record.providerProfileId,
        record.model,
        record.status,
        record.archivedAt,
        record.createdAt,
        record.updatedAt,
      );
    },

    updateSession(id, patch) {
      const current = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
        | SessionRow
        | undefined;
      if (current === undefined) {
        return;
      }
      const next = { ...toRecord(current), ...patch };
      updateSessionStmt.run(
        next.title,
        next.workspacePath,
        next.providerProfileId,
        next.model,
        next.status,
        next.archivedAt,
        next.updatedAt,
        id,
      );
    },

    insertMessage(message) {
      insertMessageStmt.run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.createdAt,
        message.mentions === undefined || message.mentions.length === 0
          ? null
          : JSON.stringify(message.mentions),
        message.aborted === true ? 1 : 0,
      );
    },

    listSessions() {
      return (listSessionsStmt.all() as unknown as SessionRow[]).map(toRecord);
    },

    listMessages(sessionId) {
      return (listMessagesStmt.all(sessionId) as unknown as MessageRow[]).map(
        (row) => {
          const message: StoredMessage = {
            id: row.id,
            sessionId: row.session_id,
            role: row.role as StoredMessage['role'],
            content: row.content,
            createdAt: row.created_at,
          };
          // mentions JSON 反序列化：损坏数据视作无引用（不阻塞恢复）
          if (row.mentions !== null && row.mentions !== '') {
            try {
              const parsed = JSON.parse(row.mentions) as unknown;
              if (Array.isArray(parsed)) {
                message.mentions = parsed as StoredMessage['mentions'];
              }
            } catch {
              // 忽略损坏的 mentions 列
            }
          }
          if (row.aborted === 1) {
            message.aborted = true;
          }
          return message;
        },
      );
    },

    insertToolCall(call) {
      insertToolCallStmt.run(
        call.id,
        call.sessionId,
        call.toolName,
        call.arguments,
        call.output,
        call.isError ? 1 : 0,
        call.createdAt,
      );
    },

    listToolCalls(sessionId) {
      return (listToolCallsStmt.all(sessionId) as unknown as ToolCallRow[]).map(
        (row) => ({
          id: row.id,
          sessionId: row.session_id,
          toolName: row.tool_name,
          arguments: row.arguments,
          output: row.output,
          isError: row.is_error === 1,
          createdAt: row.created_at,
        }),
      );
    },

    close() {
      db.close();
    },
  };
}
