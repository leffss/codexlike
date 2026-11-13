import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertReorderableList,
  type InputQueueStore,
  type QueuedMessage,
} from "./input-queue";

/**
 * 输入队列的 SQLite 持久化（票 01 / ADR 0013）：排队消息按会话存到
 * 与会话消息同一个库文件（task-workbench.db）。agent-core 不感知队列，
 * 这里以独立连接开同一 db 建表（CREATE TABLE IF NOT EXISTS）；
 * 主进程单线程同步写，与 agent-core 连接不会并发争用。
 */
const QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS input_queue (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  mention_paths TEXT,
  provider_profile_id TEXT NOT NULL,
  thinking_effort TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_input_queue_task_position
  ON input_queue(task_id, position);
CREATE TABLE IF NOT EXISTS input_queue_state (
  task_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL
);
`;

interface QueueRow {
  id: string;
  task_id: string;
  position: number;
  text: string;
  mention_paths: string | null;
  provider_profile_id: string;
  thinking_effort: string;
  approval_mode: string;
  created_at: string;
}

function toQueuedMessage(row: QueueRow): QueuedMessage {
  let mentionPaths: string[] = [];
  if (row.mention_paths !== null && row.mention_paths !== "") {
    try {
      const parsed: unknown = JSON.parse(row.mention_paths);
      if (Array.isArray(parsed)) mentionPaths = parsed.map(String);
    } catch {
      // 损坏的引用列表视作无引用，不阻塞队列恢复
    }
  }
  return {
    id: row.id,
    sessionId: row.task_id,
    position: Number(row.position),
    text: row.text,
    mentionPaths,
    providerProfileId: row.provider_profile_id,
    thinkingEffort: row.thinking_effort as QueuedMessage["thinkingEffort"],
    approvalMode: row.approval_mode as QueuedMessage["approvalMode"],
    createdAt: row.created_at,
  };
}

export function createSqliteInputQueueStore(dbPath: string): InputQueueStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(QUEUE_SCHEMA);
  const appendStmt = db.prepare(
    "INSERT INTO input_queue (id, task_id, position, text, mention_paths, provider_profile_id, thinking_effort, approval_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const listStmt = db.prepare(
    "SELECT * FROM input_queue WHERE task_id = ? ORDER BY position, rowid"
  );
  const nextPositionStmt = db.prepare(
    "SELECT COALESCE(MAX(position) + 1, 0) AS next FROM input_queue WHERE task_id = ?"
  );
  const removeStmt = db.prepare(
    "DELETE FROM input_queue WHERE task_id = ? AND id = ?"
  );
  const updateStmt = db.prepare(
    "UPDATE input_queue SET text = ?, mention_paths = ? WHERE task_id = ? AND id = ?"
  );
  const reorderStmt = db.prepare(
    "UPDATE input_queue SET position = ? WHERE task_id = ? AND id = ?"
  );
  const clearStmt = db.prepare("DELETE FROM input_queue WHERE task_id = ?");
  const pausedStmt = db.prepare(
    "SELECT paused FROM input_queue_state WHERE task_id = ?"
  );
  const pauseStmt = db.prepare(
    "INSERT INTO input_queue_state (task_id, paused) VALUES (?, 1) ON CONFLICT(task_id) DO UPDATE SET paused = 1"
  );
  const unpauseStmt = db.prepare(
    "DELETE FROM input_queue_state WHERE task_id = ?"
  );

  function list(sessionId: string): QueuedMessage[] {
    return (listStmt.all(sessionId) as unknown as QueueRow[]).map(
      toQueuedMessage
    );
  }

  return {
    list(sessionId) {
      return list(sessionId);
    },
    append(sessionId, entry) {
      const position = Number(
        (nextPositionStmt.get(sessionId) as { next: number }).next
      );
      appendStmt.run(
        entry.id,
        sessionId,
        position,
        entry.text,
        JSON.stringify(entry.mentionPaths),
        entry.providerProfileId,
        entry.thinkingEffort,
        entry.approvalMode,
        entry.createdAt
      );
      return { ...entry, sessionId, position };
    },
    remove(sessionId, id) {
      return removeStmt.run(sessionId, id).changes > 0;
    },
    update(sessionId, id, patch) {
      const changes = updateStmt.run(
        patch.text,
        JSON.stringify(patch.mentionPaths),
        sessionId,
        id
      ).changes;
      if (changes === 0) return null;
      return list(sessionId).find((entry) => entry.id === id) ?? null;
    },
    reorder(sessionId, orderedIds) {
      const current = list(sessionId);
      // 无重复/未知校验走共享函数（review 重构）；完整性由协调器权威把关
      assertReorderableList(current, orderedIds);
      const idSet = new Set(orderedIds);
      const members = current.filter((entry) => idSet.has(entry.id));
      // 子集占用的 position 集合内重新分配；整体一个事务，中断不产生半套顺序
      const positions = members
        .map((entry) => entry.position)
        .sort((a, b) => a - b);
      db.exec("BEGIN");
      try {
        orderedIds.forEach((id, index) => {
          reorderStmt.run(positions[index]!, sessionId, id);
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    clear(sessionId) {
      clearStmt.run(sessionId);
    },
    isPaused(sessionId) {
      const row = pausedStmt.get(sessionId) as { paused: number } | undefined;
      return row?.paused === 1;
    },
    setPaused(sessionId, paused) {
      if (paused) pauseStmt.run(sessionId);
      else unpauseStmt.run(sessionId);
    },
    close() {
      db.close();
    },
  };
}
