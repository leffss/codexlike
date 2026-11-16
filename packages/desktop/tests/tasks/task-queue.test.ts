import { describe, expect, it, vi } from "vitest";

import {
  createMemoryTaskQueueStore,
  createTaskQueueCoordinator,
  type QueuedTaskStart,
  type TaskQueueStore,
} from "../../src/tasks/task-queue";

/**
 * 任务排队协调器（任务并发上限票 02，ADR 0022）：desktop 主进程的应用级
 * 任务首条执行排队。执行中的任务数达到上限时，新执行开始改为入队；
 * 名额释放（执行结束，含等待用户交互期间不释放）后按 FIFO 自动开跑。
 * 依赖全部注入（store / 上限 resolver / 执行中判定 / 开跑回调 / 变更通知），
 * 只测外部可见的状态转移。
 * 占坑口径注：执行中判定（executingTaskIds）由装配层给出——含等待审批/
 * 问答的任务（waiting-user 不释放名额，ADR 0022），协调器只数个数。
 */

/** 内存 store 假件：按接口语义模拟持久化存储（票 05 换真实实现） */
function createMemoryStore(): TaskQueueStore {
  return createMemoryTaskQueueStore();
}

function harness(overrides?: {
  limit?: () => number;
  start?: (entry: QueuedTaskStart) => Promise<void>;
  store?: TaskQueueStore;
}) {
  const store = overrides?.store ?? createMemoryStore();
  const started: QueuedTaskStart[] = [];
  const changes: {
    taskId: string;
    reason: string;
    queue: QueuedTaskStart[];
  }[] = [];
  // 执行中集合占坑契约（真实装配语义）：开跑 resolve 时任务已计入执行中
  // （beginExecution 同步占坑）；启动失败回滚（end() 释放名额）。
  const executing = new Set<string>();
  let limit = overrides?.limit ?? (() => 2);
  const queue = createTaskQueueCoordinator({
    store,
    limit: () => limit(),
    executingTaskIds: () => [...executing],
    start: async (entry) => {
      started.push(entry);
      executing.add(entry.taskId);
      try {
        if (overrides?.start) await overrides.start(entry);
      } catch (error) {
        executing.delete(entry.taskId);
        throw error;
      }
    },
    onChange: (taskId, reason, queue) =>
      changes.push({ taskId, reason, queue: [...queue] }),
  });
  return {
    store,
    queue,
    started,
    changes,
    setLimit(next: () => number) {
      limit = next;
    },
    setExecuting(ids: string[]) {
      executing.clear();
      for (const id of ids) executing.add(id);
    },
  };
}

const START_INPUT = {
  text: "首个请求",
  mentionPaths: ["docs/a.md"],
  providerProfileId: "profile-1",
  thinkingEffort: "low" as const,
  approvalMode: "assist" as const,
};

describe("createTaskQueueCoordinator（满员入队与 FIFO 自动开跑）", () => {
  it("有空位时 gate 放行：不入队、不产生变更，调用方继续执行", () => {
    const app = harness();
    app.setExecuting(["task-a"]);

    expect(app.queue.gate("task-b", START_INPUT)).toBe("start");
    expect(app.queue.snapshot()).toEqual([]);
    expect(app.started).toHaveLength(0);
    expect(app.changes).toHaveLength(0);
  });

  it("满员时 gate 入队：完整保存发送参数快照，不触发开跑，推进入队通知", () => {
    const app = harness();
    app.setExecuting(["task-a", "task-b"]);

    expect(app.queue.gate("task-c", START_INPUT)).toBe("queued");
    // 快照字段随条目保存（开跑按快照发出）
    const entry = app.queue.snapshot()[0]!;
    expect(entry).toMatchObject({ taskId: "task-c", ...START_INPUT });
    expect(entry.createdAt).not.toBe("");
    expect(entry.position).toBe(0);
    // 未开跑：start 回调未被调用
    expect(app.started).toHaveLength(0);
    expect(app.changes).toHaveLength(1);
    expect(app.changes[0]).toMatchObject({
      taskId: "task-c",
      reason: "enqueue",
    });
    expect(app.changes[0]!.queue.map((item) => item.taskId)).toEqual([
      "task-c",
    ]);
  });

  it("入队顺序即开跑顺序：position 按入队递增", () => {
    const app = harness();
    app.setExecuting(["task-a", "task-b"]);
    app.queue.gate("task-c", START_INPUT);
    app.queue.gate("task-d", START_INPUT);

    expect(app.queue.snapshot().map((item) => item.taskId)).toEqual([
      "task-c",
      "task-d",
    ]);
    expect(app.queue.snapshot()[0]!.position).toBeLessThan(
      app.queue.snapshot()[1]!.position
    );
  });

  it("已在排队的任务再 gate：幂等返回 queued，不重复入队、不覆盖快照", () => {
    const app = harness();
    app.setExecuting(["task-a", "task-b"]);
    app.queue.gate("task-c", { ...START_INPUT, text: "第一条" });

    expect(app.queue.gate("task-c", { ...START_INPUT, text: "迟到重发" })).toBe(
      "queued"
    );
    expect(app.queue.snapshot()).toHaveLength(1);
    expect(app.queue.snapshot()[0]!.text).toBe("第一条");
    // 幂等重入不产生第二次入队通知
    expect(app.changes).toHaveLength(1);
  });

  it("名额释放 pump：严格 FIFO 开跑队首，一个名额只开跑一个", async () => {
    const app = harness();
    app.setExecuting(["task-a", "task-b"]);
    app.queue.gate("task-c", START_INPUT);
    app.queue.gate("task-d", START_INPUT);
    app.queue.gate("task-e", START_INPUT);

    // 一个执行结束（task-b 的轮次落定）：释放一个名额
    app.setExecuting(["task-a"]);
    await app.queue.pump();

    expect(app.started.map((entry) => entry.taskId)).toEqual(["task-c"]);
    // 队首已从持久层移除，其余仍在排队
    expect(app.queue.snapshot().map((item) => item.taskId)).toEqual([
      "task-d",
      "task-e",
    ]);
    expect(app.changes.at(-1)).toMatchObject({
      taskId: "task-c",
      reason: "dequeue",
    });
  });

  it("连续释放名额：逐个开跑直到清空队列，此后 pump 无事可做", async () => {
    const app = harness();
    app.setExecuting(["task-a", "task-b"]);
    app.queue.gate("task-c", START_INPUT);
    app.queue.gate("task-d", START_INPUT);

    app.setExecuting(["task-a"]);
    await app.queue.pump();
    app.setExecuting([]);
    await app.queue.pump();

    expect(app.started.map((entry) => entry.taskId)).toEqual([
      "task-c",
      "task-d",
    ]);
    expect(app.queue.snapshot()).toEqual([]);
    // 队列清空后再次触发：不再开跑、不再通知
    const changesBefore = app.changes.length;
    await app.queue.pump();
    expect(app.changes).toHaveLength(changesBefore);
  });

  it("pump 一次推进到名额上限：空位连开到满，余下仍排队", async () => {
    const app = harness();
    // 执行中超过当前上限（此前上限更大时启动、调小后自然降下中）
    app.setExecuting(["task-a", "task-b", "task-c"]);
    app.queue.gate("task-d", START_INPUT);
    app.queue.gate("task-e", START_INPUT);
    app.queue.gate("task-f", START_INPUT);

    // 名额全部空出：上限 2 内连开两个（开跑即占坑），第三个等待
    app.setExecuting([]);
    await app.queue.pump();

    expect(app.started.map((entry) => entry.taskId)).toEqual([
      "task-d",
      "task-e",
    ]);
    expect(app.queue.snapshot().map((item) => item.taskId)).toEqual(["task-f"]);
  });

  it("等待用户交互的任务占名额：执行中含 waiting-user 时 gate 满员入队", () => {
    const app = harness();
    // 口径注：waiting-user 任务的「执行中」由装配层判定给出（ADR 0022
    // 占坑含等待用户）——协调器只认 executingTaskIds 的个数
    app.setExecuting(["task-a", "task-b"]);

    expect(app.queue.gate("task-c", START_INPUT)).toBe("queued");
    expect(app.queue.isQueued("task-c")).toBe(true);
    expect(app.started).toHaveLength(0);
  });

  it("开跑失败：条目保留在队列（不丢也不跳过），下一触发点重试成功", async () => {
    let failFirst = true;
    const app = harness({
      start: (entry) =>
        entry.taskId === "task-c" && failFirst
          ? Promise.reject(new Error("Profile 已删除"))
          : Promise.resolve(),
    });
    app.setExecuting(["task-a", "task-b"]);
    app.queue.gate("task-c", START_INPUT);
    app.queue.gate("task-d", START_INPUT);

    app.setExecuting(["task-a"]);
    await app.queue.pump();
    // 队首开跑失败：条目保留、第二个不被连带开跑（FIFO 不跳过）
    expect(app.started.map((entry) => entry.taskId)).toEqual(["task-c"]);
    expect(app.queue.snapshot().map((item) => item.taskId)).toEqual([
      "task-c",
      "task-d",
    ]);

    // 下一触发点重试队首：成功后占坑（名额随之用尽），第二个继续等待
    failFirst = false;
    await app.queue.pump();
    expect(app.started.map((entry) => entry.taskId)).toEqual([
      "task-c",
      "task-c",
    ]);
    expect(app.queue.snapshot().map((item) => item.taskId)).toEqual(["task-d"]);
  });

  it("pump 中 remove 落库失败（存储故障）：开跑不重复、错误上抛不吞", async () => {
    // remove 对队首抛错模拟存储故障（如 SQLite 写锁）：与开跑失败不同，
    // 此时消息已进入任务（start 成功）——吞错会让「开跑成功才出队落库」
    // 的意图静默失效，条目残留待下轮重复开跑同一首条。
    const base = createMemoryStore();
    const store: TaskQueueStore = {
      ...base,
      remove(taskId: string) {
        if (taskId === "task-c") throw new Error("db locked");
        return base.remove(taskId);
      },
    };
    const app = harness({ store });
    app.setExecuting(["task-a", "task-b"]);
    app.queue.gate("task-c", START_INPUT);
    app.queue.gate("task-d", START_INPUT);

    // 释放一个名额：pump 开跑队首，出队落库时撞上存储故障
    app.setExecuting(["task-a"]);

    await expect(app.queue.pump()).rejects.toThrow("db locked");
    // 队首只开跑一次（不因吞错继续循环重复 start）；后续条目不被连带开跑
    expect(app.started.map((entry) => entry.taskId)).toEqual(["task-c"]);
    // 条目仍在快照里（存储故障不被静默清掉），错误可见后由调用方处置
    expect(app.queue.snapshot().map((entry) => entry.taskId)).toEqual([
      "task-c",
      "task-d",
    ]);
  });

  it("remove 出队：条目消失并推送通知，pump 跳过被移除任务", async () => {
    const app = harness();
    app.setExecuting(["task-a", "task-b"]);
    app.queue.gate("task-c", START_INPUT);
    app.queue.gate("task-d", START_INPUT);

    expect(app.queue.remove("task-c")).toBe(true);
    expect(app.changes.at(-1)).toMatchObject({
      taskId: "task-c",
      reason: "remove",
    });
    // 不在队列的任务 remove：幂等 false、不通知
    const changesBefore = app.changes.length;
    expect(app.queue.remove("task-c")).toBe(false);
    expect(app.changes).toHaveLength(changesBefore);

    app.setExecuting(["task-a"]);
    await app.queue.pump();
    expect(app.started.map((entry) => entry.taskId)).toEqual(["task-d"]);
    expect(app.queue.snapshot()).toEqual([]);
  });
});

describe("设置生效语义（调大立即补跑、调小只拦新）", () => {
  it("调大上限（2→4）：pump 立即补跑排队任务到新上限", async () => {
    const app = harness();
    app.setExecuting(["task-a", "task-b"]);
    app.queue.gate("task-c", START_INPUT);
    app.queue.gate("task-d", START_INPUT);

    // 调大后设置保存回调触发 pump（装配层接线）：两名额空出，立即补位
    app.setLimit(() => 4);
    await app.queue.pump();

    expect(app.started.map((entry) => entry.taskId)).toEqual([
      "task-c",
      "task-d",
    ]);
    expect(app.queue.snapshot()).toEqual([]);
  });

  it("调小上限（4→2）：执行中不被中断（协调器不动执行），新任务继续排队", async () => {
    const app = harness();
    app.setLimit(() => 4);
    // 四个任务执行中（含等待用户的口径同前）
    const running = ["task-a", "task-b", "task-c", "task-d"];
    app.setExecuting([...running]);

    // 调小：只影响 gate 判定，不打断在执行的
    app.setLimit(() => 2);
    expect(app.queue.gate("task-e", START_INPUT)).toBe("queued");
    expect(app.queue.gate("task-f", START_INPUT)).toBe("queued");
    // 执行中的四个自然降下之前，任何触发点都不开跑排队任务
    app.setExecuting(["task-a", "task-b", "task-c"]);
    await app.queue.pump();
    expect(app.started).toHaveLength(0);
    // 自然降下两个后：新上限内开跑一个
    app.setExecuting(["task-a"]);
    await app.queue.pump();
    expect(app.started.map((entry) => entry.taskId)).toEqual(["task-e"]);
  });
});

describe("内存 store（票 02 持久化假件，票 05 换真实实现）", () => {
  it("按 position 升序列出、remove 后追加不回退", () => {
    const store = createMemoryTaskQueueStore();
    const first = store.append({
      taskId: "task-a",
      text: "一",
      mentionPaths: [],
      providerProfileId: "p",
      thinkingEffort: "auto",
      approvalMode: "ask",
      createdAt: "t1",
    });
    store.append({
      taskId: "task-b",
      text: "二",
      mentionPaths: [],
      providerProfileId: "p",
      thinkingEffort: "auto",
      approvalMode: "ask",
      createdAt: "t2",
    });
    expect(first.position).toBe(0);
    expect(store.list().map((item) => item.taskId)).toEqual([
      "task-a",
      "task-b",
    ]);
    expect(store.remove("task-a")).toBe(true);
    expect(store.remove("task-a")).toBe(false);
    const third = store.append({
      taskId: "task-c",
      text: "三",
      mentionPaths: [],
      providerProfileId: "p",
      thinkingEffort: "auto",
      approvalMode: "ask",
      createdAt: "t3",
    });
    expect(third.position).toBeGreaterThan(first.position);
    store.close();
  });
});
