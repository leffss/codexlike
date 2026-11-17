import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { createSqliteInputQueueStore } from "../../src/tasks/input-queue-store";
import { createSqliteTaskQueueStore } from "../../src/tasks/task-queue-store";
import type { QueuedTaskStart } from "../../src/tasks/task-queue";

/**
 * 任务排队 SQLite 持久化（任务并发上限票 05 / ADR 0022）：沿输入队列
 * 存储先例（ADR 0013）——与任务消息同一个库文件的独立连接、有序语义、
 * 重开恢复。只测外部可见的 list/append/remove/close 契约。
 */
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function tempDbPath(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  // 父目录刻意不存在：store 必须自建目录（CODING_STANDARDS 数据目录自建）
  return join(root, "nested", "task-workbench.db");
}

const ENTRY: Omit<QueuedTaskStart, "position"> = {
  taskId: "task-a",
  text: "首个请求",
  mentionPaths: ["docs/a.md", "docs/b.md"],
  providerProfileId: "profile-1",
  model: null,
  thinkingEffort: "low",
  approvalMode: "assist",
  createdAt: "2026-11-16T00:00:00.000Z",
};

it("append 分配递增 position，list 按升序返回完整快照", () => {
  const store = createSqliteTaskQueueStore(tempDbPath("task-queue-store-"));
  cleanup.push(() => store.close());
  const first = store.append({ ...ENTRY });
  const second = store.append({ ...ENTRY, taskId: "task-b", text: "第二条" });

  expect(first.position).toBe(0);
  expect(second.position).toBe(1);
  expect(store.list()).toEqual([
    { ...ENTRY, position: 0 },
    { ...ENTRY, taskId: "task-b", text: "第二条", position: 1 },
  ]);
});

it("remove 出队幂等；出队后追加 position 不回退", () => {
  const store = createSqliteTaskQueueStore(tempDbPath("task-queue-store-"));
  cleanup.push(() => store.close());
  store.append({ ...ENTRY });
  store.append({ ...ENTRY, taskId: "task-b" });

  expect(store.remove("task-a")).toBe(true);
  expect(store.remove("task-a")).toBe(false);
  expect(store.list().map((item) => item.taskId)).toEqual(["task-b"]);
  // position 单调递增：新条目排在既有之后（严格 FIFO 不因出队错位）
  const third = store.append({ ...ENTRY, taskId: "task-c" });
  expect(third.position).toBeGreaterThan(1);
});

it("close 后重开同一库：排队条目与顺序原样恢复（跨重启不丢）", () => {
  const dbPath = tempDbPath("task-queue-store-reopen-");
  const first = createSqliteTaskQueueStore(dbPath);
  first.append({ ...ENTRY });
  first.append({ ...ENTRY, taskId: "task-b" });
  first.remove("task-a");
  first.append({ ...ENTRY, taskId: "task-c" });
  first.close();

  const reopened = createSqliteTaskQueueStore(dbPath);
  cleanup.push(() => reopened.close());
  expect(reopened.list()).toEqual([
    { ...ENTRY, taskId: "task-b", position: 1 },
    { ...ENTRY, taskId: "task-c", position: 2 },
  ]);
});

it("存量库（无排队表）打开即建空表：list 返回空、无迁移报错，写入照常", () => {
  const dbPath = tempDbPath("task-queue-store-legacy-");
  // 票 05 之前的真实存量库：已有任务与输入队列表、没有 task_queue 表
  const legacyQueue = createSqliteInputQueueStore(dbPath);
  legacyQueue.append("legacy-task", {
    id: "legacy-message",
    text: "存量输入队列条目",
    mentionPaths: [],
    providerProfileId: "profile-1",
    model: null,
    thinkingEffort: "auto",
    approvalMode: "ask",
    createdAt: "2026-11-15T00:00:00.000Z",
  });
  legacyQueue.close();

  const store = createSqliteTaskQueueStore(dbPath);
  cleanup.push(() => store.close());
  expect(store.list()).toEqual([]);
  store.append({ ...ENTRY });
  expect(store.list()).toHaveLength(1);
  // 共库不串表：输入队列条目不受影响
  const reopenedQueue = createSqliteInputQueueStore(dbPath);
  cleanup.push(() => reopenedQueue.close());
  expect(reopenedQueue.list("legacy-task")).toHaveLength(1);
});

it("损坏的 mention_paths JSON 视作无引用，不阻塞队列恢复", () => {
  const dbPath = tempDbPath("task-queue-store-corrupt-");
  const first = createSqliteTaskQueueStore(dbPath);
  first.append({ ...ENTRY });
  first.close();
  // 直写损坏数据（绕过接口模拟落盘损坏），重开读取侧不得抛错
  const raw = new DatabaseSync(dbPath);
  raw.exec(
    "UPDATE task_queue SET mention_paths = 'not-json' WHERE task_id = 'task-a'"
  );
  raw.close();

  const reopened = createSqliteTaskQueueStore(dbPath);
  cleanup.push(() => reopened.close());
  const entry = reopened.list()[0]!;
  expect(entry.taskId).toBe("task-a");
  expect(entry.mentionPaths).toEqual([]);
});
