import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryInputQueueStore,
  createTaskInputQueues,
  type InputQueueStore,
  type QueuedMessage,
} from "../../src/tasks/input-queue";
import { createSqliteInputQueueStore } from "../../src/tasks/input-queue-store";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const input = {
  text: "第一条",
  mentionPaths: ["docs/a.md"],
  providerProfileId: "profile-1",
  thinkingEffort: "low" as const,
  approvalMode: "ask" as const,
};

function harness(
  kind: "memory" | "sqlite",
  overrides?: {
    /** 自定义发送假件：返回的 promise 决定「发出」何时完成（窗口期条目锁定）。 */
    dispatch?: (
      sessionId: string,
      entry: QueuedMessage,
      onSettled: () => void
    ) => Promise<void>;
  }
) {
  const root = mkdtempSync(join(tmpdir(), "input-queue-items-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "nested", "session-workbench.db");
  const store: InputQueueStore =
    kind === "sqlite"
      ? createSqliteInputQueueStore(dbPath)
      : createMemoryInputQueueStore();
  cleanup.push(() => store.close());
  let busy = true;
  const dispatched: QueuedMessage[] = [];
  const changes: {
    reason: string;
    queue: QueuedMessage[];
    sendingId: string | null;
  }[] = [];
  const queues = createTaskInputQueues({
    store,
    isBusy: () => busy,
    dispatch: async (sessionId, entry, settled) => {
      dispatched.push(entry);
      if (overrides?.dispatch)
        await overrides.dispatch(sessionId, entry, settled);
      else settled();
    },
    onChange: (_sessionId, reason, queue, _paused, sendingId) =>
      changes.push({ reason, queue: [...queue], sendingId: sendingId ?? null }),
  });
  return {
    queues,
    dispatched,
    changes,
    idle() {
      busy = false;
      queues.onIdle("s1");
    },
    /** 读「重开后的存储」视角：另开连接取快照即关，不打断协调器持有的连接。 */
    persisted() {
      if (kind !== "sqlite") return store.list("s1");
      const reopened = createSqliteInputQueueStore(dbPath);
      try {
        return reopened.list("s1");
      } finally {
        reopened.close();
      }
    },
  };
}

describe.each(["memory", "sqlite"] as const)("队列条目操作（%s）", (kind) => {
  it("删除立即作废：只删除本任务指定条目，后续不消费且重开存储不恢复", async () => {
    const app = harness(kind);
    const first = app.queues.enqueue("s1", input);
    app.queues.enqueue("s1", { ...input, text: "保留第二条" });
    const other = app.queues.enqueue("s2", { ...input, text: "其他任务" });
    expect(() => app.queues.remove("s1", other.id)).toThrow(/不存在|已发出/);
    app.queues.remove("s1", first.id);
    expect(app.queues.snapshot("s1").map((item) => item.text)).toEqual([
      "保留第二条",
    ]);
    expect(app.changes.at(-1)).toMatchObject({
      reason: "remove",
      queue: [{ text: "保留第二条" }],
    });
    app.idle();
    await vi.waitFor(() =>
      expect(app.dispatched.map((item) => item.text)).toEqual(["保留第二条"])
    );
    await vi.waitFor(() => expect(app.queues.snapshot("s1")).toEqual([]));
    expect(app.queues.snapshot("s2")).toEqual([other]);
    expect(app.persisted()).toEqual([]);
  });

  it("原地编辑不变序：更新内容与@引用，position 与参数快照不动，推送 update 事件并持久化", async () => {
    const app = harness(kind);
    const first = app.queues.enqueue("s1", input);
    app.queues.enqueue("s1", { ...input, text: "第二条" });
    const updated = app.queues.update(
      "s1",
      first.id,
      { text: "第一条（修订）", mentionPaths: ["docs/b.md"] },
      input.text
    );
    expect(updated).toMatchObject({
      id: first.id,
      position: first.position,
      text: "第一条（修订）",
      mentionPaths: ["docs/b.md"],
      providerProfileId: "profile-1",
      thinkingEffort: "low",
      approvalMode: "ask",
    });
    const snapshot = app.queues.snapshot("s1");
    expect(snapshot.map((item) => item.text)).toEqual([
      "第一条（修订）",
      "第二条",
    ]);
    expect(snapshot[0]!.position).toBe(first.position);
    expect(app.changes.at(-1)).toMatchObject({ reason: "update" });
    const persisted = app.persisted();
    expect(persisted.map((item) => item.text)).toEqual([
      "第一条（修订）",
      "第二条",
    ]);
    expect(persisted[0]).toMatchObject({
      id: first.id,
      mentionPaths: ["docs/b.md"],
    });
  });

  it("编辑校验：原文不一致（他窗口先改）或条目不存在/跨任务时拒绝，原文保持", () => {
    const app = harness(kind);
    const first = app.queues.enqueue("s1", input);
    expect(() =>
      app.queues.update(
        "s1",
        first.id,
        { text: "偷换", mentionPaths: [] },
        "过期的原文"
      )
    ).toThrow(/其他窗口|不一致|修改/);
    expect(() =>
      app.queues.update("s1", "missing", { text: "x", mentionPaths: [] }, "x")
    ).toThrow(/不存在/);
    expect(() =>
      app.queues.update(
        "s2",
        first.id,
        { text: "跨任务改写", mentionPaths: [] },
        input.text
      )
    ).toThrow(/不存在/);
    expect(app.queues.snapshot("s1")).toEqual([first]);
  });

  it("正在发出的条目锁定：编辑/删除/包含它的重排被拒，其余条目仍可操作；发送完成后解锁推进", async () => {
    let releaseFirst: (() => void) | null = null;
    const app = harness(kind, {
      dispatch: (_sessionId, entry, onSettled) => {
        if (entry.text === input.text) {
          // 首条发送挂起：制造确定性的「正在发出」窗口，释放时先完成发送再结束本轮
          return new Promise<void>((resolve) => {
            releaseFirst = () => {
              resolve();
              onSettled();
            };
          });
        }
        onSettled();
        return Promise.resolve();
      },
    });
    const first = app.queues.enqueue("s1", input);
    const second = app.queues.enqueue("s1", { ...input, text: "第二条" });
    const third = app.queues.enqueue("s1", { ...input, text: "第三条" });
    app.idle();
    await vi.waitFor(() => expect(app.dispatched).toHaveLength(1));
    // 队首已取出发送：同步锁定可见，其余条目仍排队
    expect(app.queues.sendingItem("s1")).toBe(first.id);
    expect(app.changes).toContainEqual(
      expect.objectContaining({ reason: "sending", sendingId: first.id })
    );
    expect(() =>
      app.queues.update(
        "s1",
        first.id,
        { text: "迟到修改", mentionPaths: [] },
        input.text
      )
    ).toThrow(/正在发出/);
    expect(() => app.queues.remove("s1", first.id)).toThrow(/正在发出/);
    expect(() =>
      app.queues.reorder("s1", [second.id, first.id, third.id])
    ).toThrow(/正在发出/);
    // 其余条目不受影响：可编辑、可在非发出子集内重排
    app.queues.update(
      "s1",
      second.id,
      { text: "第二条（改）", mentionPaths: [] },
      "第二条"
    );
    app.queues.reorder("s1", [third.id, second.id]);
    expect(app.queues.snapshot("s1").map((item) => item.id)).toEqual([
      first.id,
      third.id,
      second.id,
    ]);
    // 发送完成：条目出队解锁，消费按重排后的顺序继续
    expect(releaseFirst).not.toBeNull();
    releaseFirst!();
    await vi.waitFor(() =>
      expect(app.dispatched.map((item) => item.text)).toEqual([
        input.text,
        "第三条",
        "第二条（改）",
      ])
    );
    await vi.waitFor(() => expect(app.queues.snapshot("s1")).toEqual([]));
    expect(app.queues.sendingItem("s1")).toBeNull();
  });

  it("重排改变消费顺序并持久化；清单与队列不一致（缺项/多余/未知/重复）拒绝且顺序不变", async () => {
    const app = harness(kind);
    const first = app.queues.enqueue("s1", input);
    const second = app.queues.enqueue("s1", { ...input, text: "第二条" });
    app.queues.reorder("s1", [second.id, first.id]);
    expect(app.queues.snapshot("s1").map((item) => item.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(app.changes.at(-1)).toMatchObject({ reason: "reorder" });
    expect(app.persisted().map((item) => item.id)).toEqual([
      second.id,
      first.id,
    ]);
    const before = app.queues.snapshot("s1").map((item) => item.id);
    expect(() => app.queues.reorder("s1", [first.id])).toThrow(/不一致|重复/);
    expect(() =>
      app.queues.reorder("s1", [second.id, first.id, "missing"])
    ).toThrow(/不一致|重复/);
    expect(() =>
      app.queues.reorder("s1", [first.id, first.id, second.id])
    ).toThrow(/不一致|重复/);
    expect(app.queues.snapshot("s1").map((item) => item.id)).toEqual(before);
    app.idle();
    await vi.waitFor(() =>
      expect(app.dispatched.map((item) => item.text)).toEqual([
        "第二条",
        input.text,
      ])
    );
    await vi.waitFor(() => expect(app.queues.snapshot("s1")).toEqual([]));
  });
});
