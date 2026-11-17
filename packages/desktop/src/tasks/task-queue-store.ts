import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { QueuedTaskStart, TaskQueueStore } from "./task-queue";

/**
 * 任务排队的 SQLite 持久化（任务并发上限票 05 / ADR 0022）：沿输入队列
 * 存储先例（ADR 0013）——排队任务的全局首条执行快照存到与任务消息同一
 * 个库文件（task-workbench.db）的独立连接。全局单队列、排队中每任务至
 * 多一条（闸门幂等），task_id 即主键；顺序以 position 单调递增保证严格
 * FIFO，与 input_queue 的有序语义同构（出队后新条目不回退）。
 * 存量库无 task_queue 表：CREATE TABLE IF NOT EXISTS 建空表，读取侧
 * 天然兼容（无迁移报错）。
 */
const TASK_QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_queue (
  task_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  mention_paths TEXT,
  provider_profile_id TEXT NOT NULL,
  model TEXT,
  thinking_effort TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

interface TaskQueueRow {
  task_id: string;
  position: number;
  text: string;
  mention_paths: string | null;
  provider_profile_id: string;
  model: string | null;
  thinking_effort: string;
  approval_mode: string;
  created_at: string;
}

function toQueuedTaskStart(row: TaskQueueRow): QueuedTaskStart {
  let mentionPaths: string[] = [];
  if (row.mention_paths !== null && row.mention_paths !== "") {
    try {
      const parsed: unknown = JSON.parse(row.mention_paths);
      if (Array.isArray(parsed)) mentionPaths = parsed.map(String);
    } catch {
      // 损坏的引用列表视作无引用，不阻塞队列恢复（与输入队列同构）
    }
  }
  return {
    taskId: row.task_id,
    position: Number(row.position),
    text: row.text,
    mentionPaths,
    providerProfileId: row.provider_profile_id,
    // 存量行无 model 列值（票 02 前入队）：NULL 读回 null = 未显式选模型
    model: row.model,
    thinkingEffort: row.thinking_effort as QueuedTaskStart["thinkingEffort"],
    approvalMode: row.approval_mode as QueuedTaskStart["approvalMode"],
    createdAt: row.created_at,
  };
}

export function createSqliteTaskQueueStore(dbPath: string): TaskQueueStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(TASK_QUEUE_SCHEMA);
  // 存量库升级（票 02）：补 model 列；已存在（新库或已升级）时忽略重复列错误
  try {
    db.exec("ALTER TABLE task_queue ADD COLUMN model TEXT");
  } catch {
    // 列已存在
  }
  const listStmt = db.prepare(
    "SELECT * FROM task_queue ORDER BY position, rowid"
  );
  const appendStmt = db.prepare(
    "INSERT INTO task_queue (task_id, position, text, mention_paths, provider_profile_id, model, thinking_effort, approval_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const nextPositionStmt = db.prepare(
    "SELECT COALESCE(MAX(position) + 1, 0) AS next FROM task_queue"
  );
  const removeStmt = db.prepare("DELETE FROM task_queue WHERE task_id = ?");

  return {
    list() {
      return (listStmt.all() as unknown as TaskQueueRow[]).map(
        toQueuedTaskStart
      );
    },
    append(entry) {
      const position = Number(
        (nextPositionStmt.get() as { next: number }).next
      );
      appendStmt.run(
        entry.taskId,
        position,
        entry.text,
        JSON.stringify(entry.mentionPaths),
        entry.providerProfileId,
        entry.model,
        entry.thinkingEffort,
        entry.approvalMode,
        entry.createdAt
      );
      return { ...entry, position };
    },
    remove(taskId) {
      return removeStmt.run(taskId).changes > 0;
    },
    close() {
      db.close();
    },
  };
}
