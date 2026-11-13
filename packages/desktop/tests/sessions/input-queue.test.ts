import { describe, expect, it, vi } from "vitest";

import type {
  InputQueueStore,
  QueuedMessage,
} from "../../src/sessions/input-queue";
import { createSessionInputQueues } from "../../src/sessions/input-queue";

/**
 * 输入队列（票 01，ADR 0013）：desktop 主进程会话层的队列协调器。
 * 每会话一个队列：忙时入队（含参数快照）、空闲后逐条自动消费。
 * 依赖全部注入（store / 忙判定 / 发送 / 变更通知），只测外部可见的状态转移。
 */

/** 内存 store 假件：按接口语义模拟 SQLite 存储 */
function createMemoryStore(): InputQueueStore {
  const rows = new Map<string, QueuedMessage[]>();
  function list(sessionId: string) {
    return [...(rows.get(sessionId) ?? [])].sort(
      (a, b) => a.position - b.position
    );
  }
  return {
    list,
    append(sessionId, entry) {
      const current = rows.get(sessionId) ?? [];
      const position = current.reduce(
        (max, item) => Math.max(max, item.position + 1),
        0
      );
      const saved = { ...entry, sessionId, position };
      current.push(saved);
      rows.set(sessionId, current);
      return saved;
    },
    remove(sessionId, id) {
      const current = rows.get(sessionId) ?? [];
      const index = current.findIndex((item) => item.id === id);
      if (index === -1) return false;
      current.splice(index, 1);
      return true;
    },
    clear(sessionId) {
      rows.delete(sessionId);
    },
    close() {},
  };
}

function harness(overrides?: {
  isBusy?: (sessionId: string) => boolean;
  dispatch?: (
    sessionId: string,
    entry: QueuedMessage,
    onSettled: () => void
  ) => Promise<void>;
}) {
  const store = createMemoryStore();
  const dispatched: { sessionId: string; entry: QueuedMessage }[] = [];
  const changes: {
    sessionId: string;
    reason: string;
    queue: QueuedMessage[];
  }[] = [];
  let busy = overrides?.isBusy ?? (() => false);
  const queues = createSessionInputQueues({
    store,
    isBusy: (sessionId) => busy(sessionId),
    dispatch: async (sessionId, entry, onSettled) => {
      dispatched.push({ sessionId, entry });
      if (overrides?.dispatch) {
        // 自定义假件：onSettled 的调用时机由假件全权控制
        await overrides.dispatch(sessionId, entry, onSettled);
      } else {
        // 默认假件：发送即时完成并立刻结束本轮回复
        onSettled();
      }
    },
    onChange: (sessionId, reason, queue) =>
      changes.push({ sessionId, reason, queue: [...queue] }),
  });
  return {
    store,
    queues,
    dispatched,
    changes,
    setBusy(next: (sessionId: string) => boolean) {
      busy = next;
    },
  };
}

const INPUT = {
  text: "接着做第二步",
  mentionPaths: ["docs/a.md"],
  providerProfileId: "profile-1",
  thinkingEffort: "low" as const,
  approvalMode: "assist" as const,
};

describe("createSessionInputQueues（忙时入队与逐条自动消费）", () => {
  it("忙时入队：完整保存参数快照，不触发消费，推送入队事件", () => {
    const app = harness({ isBusy: () => true });
    const entry = app.queues.enqueue("session-1", INPUT);

    // 快照字段随消息保存（spec「持久化形状」）
    expect(entry).toMatchObject(INPUT);
    expect(entry.id).not.toBe("");
    expect(entry.createdAt).not.toBe("");
    // 忙：不消费、不出队事件
    expect(app.dispatched).toHaveLength(0);
    expect(app.queues.snapshot("session-1")).toHaveLength(1);
    expect(app.changes).toHaveLength(1);
    expect(app.changes[0]).toMatchObject({
      sessionId: "session-1",
      reason: "enqueue",
    });
  });

  it("入队顺序即消费顺序：position 按入队递增", () => {
    const app = harness({ isBusy: () => true });
    const first = app.queues.enqueue("session-1", { ...INPUT, text: "第一条" });
    const second = app.queues.enqueue("session-1", {
      ...INPUT,
      text: "第二条",
    });

    expect(first.position).toBeLessThan(second.position);
    expect(app.queues.snapshot("session-1").map((item) => item.text)).toEqual([
      "第一条",
      "第二条",
    ]);
  });

  it("入队时会话已空闲：立即从队首消费，成功后从队列移除并推送出队事件", async () => {
    const app = harness();
    app.queues.enqueue("session-1", { ...INPUT, text: "空闲入队" });

    await vi.waitFor(() =>
      expect(app.dispatched.map((item) => item.entry.text)).toEqual([
        "空闲入队",
      ])
    );
    // 消费成功：条目从队列与持久层移除
    await vi.waitFor(() =>
      expect(app.queues.snapshot("session-1")).toEqual([])
    );
    expect(app.store.list("session-1")).toEqual([]);
    expect(app.changes.map((item) => item.reason)).toEqual([
      "enqueue",
      "dequeue",
    ]);
  });

  it("逐条消费时序：第一条回复完成前不发下一条，完成后才取队首", async () => {
    // onSettled 由测试控制：模拟「第一条回复进行中」（容器规避类型收窄）
    const releases: (() => void)[] = [];
    const app = harness({
      isBusy: () => true,
      dispatch: (sessionId, entry, onSettled) => {
        if (entry.text === "第一条") {
          releases.push(onSettled);
        } else {
          onSettled();
        }
        return Promise.resolve();
      },
    });
    app.queues.enqueue("session-1", { ...INPUT, text: "第一条" });
    app.queues.enqueue("session-1", { ...INPUT, text: "第二条" });

    // 忙时入队两条都不消费；第一条回复结束（onIdle + 空闲）后取队首
    app.setBusy(() => false);
    app.queues.onIdle("session-1");
    await vi.waitFor(() =>
      expect(app.dispatched.map((item) => item.entry.text)).toEqual(["第一条"])
    );
    // 第一条「回复进行中」：第二条不得发出；第一条已发出（移除）
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.dispatched).toHaveLength(1);
    expect(app.queues.snapshot("session-1").map((item) => item.text)).toEqual([
      "第二条",
    ]);

    // 第一条回复完成：第二条随后发出、队列清空
    await vi.waitFor(() => expect(releases.length).toBe(1));
    releases[0]!();
    await vi.waitFor(() =>
      expect(app.dispatched.map((item) => item.entry.text)).toEqual([
        "第一条",
        "第二条",
      ])
    );
    await vi.waitFor(() =>
      expect(app.queues.snapshot("session-1")).toEqual([])
    );
  });

  it("消费启动失败：条目保留在队列，不丢也不跳过", async () => {
    let failFirst = true;
    const app = harness({
      isBusy: () => true,
      dispatch: (sessionId, entry) =>
        entry.text === "第一条" && failFirst
          ? Promise.reject(new Error("Profile 已删除"))
          : Promise.resolve(),
    });
    app.queues.enqueue("session-1", { ...INPUT, text: "第一条" });
    app.setBusy(() => false);
    app.queues.onIdle("session-1");

    await vi.waitFor(() => expect(app.dispatched).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 失败：条目保留、第二条没有被连带消费
    expect(app.queues.snapshot("session-1").map((item) => item.text)).toEqual([
      "第一条",
    ]);
    expect(app.dispatched).toHaveLength(1);

    // 下一个触发点（再次 onIdle）重试队首，成功后队列清空
    failFirst = false;
    app.queues.onIdle("session-1");
    await vi.waitFor(() =>
      expect(app.queues.snapshot("session-1")).toEqual([])
    );
  });

  it("每会话队列独立：A 会话排队不影响 B 会话消费", async () => {
    const app = harness();
    app.queues.enqueue("session-a", { ...INPUT, text: "A 的排队" });
    app.queues.enqueue("session-b", { ...INPUT, text: "B 的排队" });

    await vi.waitFor(() =>
      expect(app.dispatched.map((item) => item.sessionId)).toEqual([
        "session-a",
        "session-b",
      ])
    );
    await vi.waitFor(() => {
      expect(app.queues.snapshot("session-a")).toEqual([]);
      expect(app.queues.snapshot("session-b")).toEqual([]);
    });
  });
});

describe("createSqliteInputQueueStore（队列持久化，与会话消息同库）", () => {
  it("存取往返：重开数据库后队列内容与顺序一致；移除/清空生效", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "input-queue-sqlite-"));
    try {
      const dbPath = join(root, "session-workbench.db");
      // 同库先由会话存储建表（生产布局：同一 db 文件）
      const { createSqliteInputQueueStore } =
        await import("../../src/sessions/input-queue-store");
      const store = createSqliteInputQueueStore(dbPath);
      const first = store.append("session-1", {
        ...INPUT,
        id: "q-1",
        createdAt: "2026-11-13T00:00:00.000Z",
      });
      store.append("session-1", {
        ...INPUT,
        text: "第二条",
        id: "q-2",
        createdAt: "2026-11-13T00:00:01.000Z",
      });
      store.append("session-2", { ...INPUT, id: "q-3", createdAt: "t" });
      expect(first.position).toBe(0);

      store.close();
      // 重开同一库：往返一致（顺序 + 快照字段）
      const reopened = createSqliteInputQueueStore(dbPath);
      const restored = reopened.list("session-1");
      expect(restored.map((item) => item.text)).toEqual([
        "接着做第二步",
        "第二条",
      ]);
      expect(restored[0]).toMatchObject({
        id: "q-1",
        sessionId: "session-1",
        position: 0,
        mentionPaths: ["docs/a.md"],
        providerProfileId: "profile-1",
        thinkingEffort: "low",
        approvalMode: "assist",
        createdAt: "2026-11-13T00:00:00.000Z",
      });
      // 会话隔离 & 移除
      expect(reopened.list("session-2")).toHaveLength(1);
      expect(reopened.remove("session-1", "q-1")).toBe(true);
      expect(reopened.remove("session-1", "q-1")).toBe(false);
      expect(reopened.list("session-1").map((item) => item.id)).toEqual([
        "q-2",
      ]);
      // 移除后追加：position 不回退
      const fourth = reopened.append("session-1", {
        ...INPUT,
        id: "q-4",
        createdAt: "t4",
      });
      expect(fourth.position).toBeGreaterThan(restored[1]!.position);
      reopened.clear("session-1");
      expect(reopened.list("session-1")).toEqual([]);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
