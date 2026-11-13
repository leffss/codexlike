import { describe, expect, it, vi } from "vitest";

import type {
  InputQueueStore,
  QueuedMessage,
} from "../../src/tasks/input-queue";
import { createTaskInputQueues } from "../../src/tasks/input-queue";

/**
 * 输入队列（票 01，ADR 0013）：desktop 主进程任务层的队列协调器。
 * 每任务一个队列：忙时入队（含参数快照）、空闲后逐条自动消费。
 * 依赖全部注入（store / 忙判定 / 发送 / 变更通知），只测外部可见的状态转移。
 */

/** 内存 store 假件：按接口语义模拟 SQLite 存储 */
function createMemoryStore(): InputQueueStore {
  const rows = new Map<string, QueuedMessage[]>();
  const paused = new Set<string>();
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
    update(sessionId, id, patch) {
      const current = rows.get(sessionId) ?? [];
      const index = current.findIndex((item) => item.id === id);
      if (index === -1) return null;
      const saved = { ...current[index]!, ...patch };
      current[index] = saved;
      return saved;
    },
    reorder(sessionId, orderedIds) {
      const current = list(sessionId);
      const idSet = new Set(orderedIds);
      if (idSet.size !== orderedIds.length)
        throw new Error("重排：条目清单有重复");
      const members = current.filter((item) => idSet.has(item.id));
      if (members.length !== orderedIds.length)
        throw new Error("重排：条目清单与队列不一致");
      const positions = members
        .map((item) => item.position)
        .sort((a, b) => a - b);
      const byId = new Map(members.map((item) => [item.id, item]));
      orderedIds.forEach((id, index) => {
        byId.get(id)!.position = positions[index]!;
      });
    },
    isPaused: (sessionId) => paused.has(sessionId),
    setPaused(sessionId, value) {
      if (value) paused.add(sessionId);
      else paused.delete(sessionId);
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
    paused: boolean;
  }[] = [];
  let busy = overrides?.isBusy ?? (() => false);
  const queues = createTaskInputQueues({
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
    onChange: (sessionId, reason, queue, paused) =>
      changes.push({ sessionId, reason, queue: [...queue], paused }),
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

describe("createTaskInputQueues（忙时入队与逐条自动消费）", () => {
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

  it("入队时任务已空闲：立即从队首消费，成功后从队列移除并推送出队事件", async () => {
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
    // 票 03：取出即「正在发出」事件（带锁定 id）→ 出队（inflight 视图）
    // → 本轮结束移出视图；顺序保持
    expect(app.changes.map((item) => item.reason)).toEqual([
      "enqueue",
      "sending",
      "dequeue",
      "sending",
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
    // 第一条「回复进行中」：第二条不得发出；第一条已从持久层移除，
    // 以「正在发出」（inflight 视图置顶 + 锁定 id）保留在队列视图中
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.dispatched).toHaveLength(1);
    expect(app.queues.snapshot("session-1").map((item) => item.text)).toEqual([
      "第一条",
      "第二条",
    ]);
    expect(app.queues.sendingItem("session-1")).toBeDefined();

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
      dispatch: (sessionId, entry, onSettled) => {
        if (entry.text === "第一条" && failFirst)
          return Promise.reject(new Error("Profile 已删除"));
        onSettled();
        return Promise.resolve();
      },
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

  it("每任务队列独立：A 任务排队不影响 B 任务消费", async () => {
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

describe("队列暂停状态机（票 02：停止保留队列、恢复/清空与插话自动恢复）", () => {
  it("暂停门控：暂停时消费循环不取队首（onIdle 与入队触发都不消费）", async () => {
    const app = harness({ isBusy: () => true });
    app.queues.enqueue("session-1", INPUT);
    // 停止路径：队列非空 → 置暂停（队列原样保留）
    app.queues.pause("session-1");
    expect(app.queues.isPaused("session-1")).toBe(true);

    // 任务空闲后触发消费：暂停门控——不取队首
    app.setBusy(() => false);
    app.queues.onIdle("session-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.dispatched).toHaveLength(0);
    expect(app.queues.snapshot("session-1")).toHaveLength(1);

    // 暂停期间再入队：同样不消费
    app.queues.enqueue("session-1", { ...INPUT, text: "第二条" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.dispatched).toHaveLength(0);
    expect(app.queues.snapshot("session-1").map((item) => item.text)).toEqual([
      "接着做第二步",
      "第二条",
    ]);
    // 置暂停推送变更事件；暂停期间的入队事件同样携带暂停态
    expect(app.changes).toHaveLength(3);
    expect(app.changes[1]).toMatchObject({
      sessionId: "session-1",
      reason: "pause",
      paused: true,
    });
    expect(app.changes[2]).toMatchObject({ reason: "enqueue", paused: true });
  });

  it("手动恢复：清暂停标志并立即从队首继续逐条消费", async () => {
    const app = harness({ isBusy: () => true });
    app.queues.enqueue("session-1", { ...INPUT, text: "第一条" });
    app.queues.enqueue("session-1", { ...INPUT, text: "第二条" });
    app.queues.pause("session-1");

    app.setBusy(() => false);
    app.queues.resume("session-1");
    expect(app.queues.isPaused("session-1")).toBe(false);
    // 立即触发消费：从队首逐条发出直至清空
    await vi.waitFor(() =>
      expect(app.dispatched.map((item) => item.entry.text)).toEqual([
        "第一条",
        "第二条",
      ])
    );
    await vi.waitFor(() =>
      expect(app.queues.snapshot("session-1")).toEqual([])
    );
    expect(app.changes.find((item) => item.reason === "resume")).toMatchObject({
      paused: false,
    });
  });

  it("空队列置暂停是无操作（停止空闲/无排队任务不产生暂停残留）", () => {
    const app = harness();
    app.queues.pause("session-1");
    expect(app.queues.isPaused("session-1")).toBe(false);
    expect(app.changes).toHaveLength(0);
  });

  it("插话完成自动恢复：暂停期间直发消息回复结束 → 清暂停标志并继续消费", async () => {
    const app = harness({ isBusy: () => true });
    app.queues.enqueue("session-1", { ...INPUT, text: "排队消息" });
    app.queues.pause("session-1");
    app.setBusy(() => false);
    // 暂停期间直发新消息（插话）：任务空闲走现有直发路径，
    // 由装配层在执行开始时登记（beginInterjection）
    app.queues.beginInterjection("session-1");
    expect(app.queues.isPaused("session-1")).toBe(true);

    // 插话的回复结束（onIdle）：自动清暂停标志并恢复队列消费
    app.queues.onIdle("session-1");
    expect(app.queues.isPaused("session-1")).toBe(false);
    await vi.waitFor(() =>
      expect(app.dispatched.map((item) => item.entry.text)).toEqual([
        "排队消息",
      ])
    );
    await vi.waitFor(() =>
      expect(app.queues.snapshot("session-1")).toEqual([])
    );
    expect(app.changes.find((item) => item.reason === "resume")).toMatchObject({
      paused: false,
    });
  });

  it("无插话的 onIdle 不解除暂停（中断后的空闲仍保持暂停）", async () => {
    const app = harness({ isBusy: () => true });
    app.queues.enqueue("session-1", INPUT);
    app.queues.pause("session-1");
    app.setBusy(() => false);
    // 中断后流结束的 onIdle（无插话登记）：暂停保持
    app.queues.onIdle("session-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.queues.isPaused("session-1")).toBe(true);
    expect(app.dispatched).toHaveLength(0);
  });

  it("清空：全部排队消息作废删除、暂停标志清除、清空后不再消费", async () => {
    const app = harness({ isBusy: () => true });
    app.queues.enqueue("session-1", { ...INPUT, text: "第一条" });
    app.queues.enqueue("session-1", { ...INPUT, text: "第二条" });
    app.queues.pause("session-1");
    app.setBusy(() => false);

    app.queues.clearQueue("session-1");
    expect(app.queues.snapshot("session-1")).toEqual([]);
    expect(app.queues.isPaused("session-1")).toBe(false);
    expect(app.changes.find((item) => item.reason === "clear")).toMatchObject({
      queue: [],
      paused: false,
    });

    // 清空后任何触发点都不再消费
    app.queues.onIdle("session-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.dispatched).toHaveLength(0);
  });
});

describe("createSqliteInputQueueStore（队列持久化，与任务消息同库）", () => {
  it("存取往返：重开数据库后队列内容与顺序一致；移除/清空生效", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "input-queue-sqlite-"));
    try {
      const dbPath = join(root, "session-workbench.db");
      // 同库先由任务存储建表（生产布局：同一 db 文件）
      const { createSqliteInputQueueStore } =
        await import("../../src/tasks/input-queue-store");
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
      // 任务隔离 & 移除
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

  it("暂停标志持久化往返：置暂停重开库保持暂停，清除后不再暂停", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "input-queue-pause-"));
    try {
      const { createSqliteInputQueueStore } =
        await import("../../src/tasks/input-queue-store");
      const dbPath = join(root, "session-workbench.db");
      const store = createSqliteInputQueueStore(dbPath);
      // 未记录的任务默认不暂停
      expect(store.isPaused("session-1")).toBe(false);
      store.setPaused("session-1", true);
      store.close();

      // 重启后保持暂停（票 02：标志随队列存储持久化）
      const reopened = createSqliteInputQueueStore(dbPath);
      expect(reopened.isPaused("session-1")).toBe(true);
      expect(reopened.isPaused("session-2")).toBe(false);
      // 任务隔离：清除只影响目标任务
      reopened.setPaused("session-1", false);
      reopened.setPaused("session-2", true);
      expect(reopened.isPaused("session-1")).toBe(false);
      expect(reopened.isPaused("session-2")).toBe(true);
      reopened.close();

      // 再次重开：清除/置位都已落盘
      const third = createSqliteInputQueueStore(dbPath);
      expect(third.isPaused("session-1")).toBe(false);
      expect(third.isPaused("session-2")).toBe(true);
      third.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
