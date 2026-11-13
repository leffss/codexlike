import { expect, it } from "vitest";
import type { TaskEventEnvelope, TaskView } from "@codexlike/desktop/ipc";
import { applyTaskEvent } from "../src/lib/task-view";
import { hydrateLiveTask, receiveLiveEvent } from "../src/lib/live-task";

const activity = {
  running: true,
  waitingForUser: false,
  outcome: null,
  unread: false,
};
function delta(
  sequence: number,
  text: string,
  executionId = "e1"
): TaskEventEnvelope {
  return {
    taskId: "a",
    executionId,
    sequence,
    activity,
    event: { type: "assistant-delta", messageId: "m1", delta: text },
  };
}
const snapshot: TaskView = {
  taskId: "a",
  executionId: "e1",
  sequence: 2,
  history: [],
  events: [delta(1, "第一段"), delta(2, "第二段")],
  pendingInteractions: [],
  activity,
};
it("终态完成时刻由消息提供，快照重放、错过增量与重启恢复保持一致", () => {
  const message = {
    id: "m1",
    sessionId: "a",
    role: "assistant" as const,
    content: "最终正文",
    createdAt: "2026-11-11T08:00:09.000Z",
  };
  const terminal: TaskEventEnvelope = {
    ...delta(3, ""),
    event: { type: "assistant-done", message },
    activity: { ...activity, running: false, outcome: "completed" },
  };
  const live = receiveLiveEvent(hydrateLiveTask(snapshot), terminal);
  const replayed = hydrateLiveTask({
    ...snapshot,
    events: [...snapshot.events, terminal],
    sequence: 3,
    activity: terminal.activity,
  });
  const missed = hydrateLiveTask({
    ...snapshot,
    events: [terminal],
    sequence: 3,
    activity: terminal.activity,
  });
  const restarted = hydrateLiveTask({
    ...snapshot,
    executionId: null,
    sequence: 0,
    events: [],
    history: [{ kind: "message", message }],
    activity: terminal.activity,
  });
  for (const state of [live, replayed, missed, restarted]) {
    expect(state.items).toMatchObject([
      { content: "最终正文", completedAt: Date.UTC(2026, 10, 11, 8, 0, 9) },
    ]);
  }
});

it("任务授权由快照恢复并随事件更新，不因等待、停止或旧任务事件清除", () => {
  let state = hydrateLiveTask({ ...snapshot, autoApprove: true });
  expect(state.autoApprove).toBe(true);
  const revoke: TaskEventEnvelope = {
    ...delta(3, ""),
    event: {
      type: "task-auto-approve-changed",
      taskId: "a",
      autoApprove: false,
    },
  };
  expect(receiveLiveEvent(state, { ...revoke, taskId: "b" }).autoApprove).toBe(
    true
  );
  state = receiveLiveEvent(state, revoke);
  expect(state.autoApprove).toBe(false);
  expect(
    receiveLiveEvent(state, {
      ...revoke,
      event: {
        type: "task-auto-approve-changed",
        taskId: "a",
        autoApprove: true,
      },
    }).autoApprove
  ).toBe(false);
  const restored = hydrateLiveTask({
    ...snapshot,
    autoApprove: true,
    activity: { ...activity, running: false, outcome: "interrupted" },
  });
  expect(restored.autoApprove).toBe(true);
  expect(receiveLiveEvent(restored, revoke).autoApprove).toBe(false);
});
it("Compact启动和终态按水位接续并原子替换历史，切换快照与旧执行事件不重复不污染", () => {
  const start: TaskEventEnvelope = {
    ...delta(3, "", "compact-1"),
    event: { type: "compact-start" },
    activity: { ...activity, operation: "compact" },
  };
  const finished: TaskEventEnvelope = {
    ...delta(4, "", "compact-1"),
    activity: {
      ...activity,
      running: false,
      outcome: "completed",
      unread: true,
    },
    event: {
      type: "compact-finished",
      outcome: "completed",
      history: [
        {
          kind: "message",
          message: {
            id: "summary",
            sessionId: "a",
            role: "compact-summary",
            content: "权威摘要",
            createdAt: "2026-11-11T09:00:00Z",
          },
        },
      ],
    },
  };
  const running = receiveLiveEvent(hydrateLiveTask(snapshot), start);
  expect(running.executionId).toBe("compact-1");
  expect(running.activity.operation).toBe("compact");
  const done = receiveLiveEvent(running, finished);
  expect(done.items).toMatchObject([{ id: "summary", content: "权威摘要" }]);
  expect(done.activity.running).toBe(false);
  expect(receiveLiveEvent(done, finished)).toEqual(done);
  expect(
    receiveLiveEvent(done, {
      ...finished,
      sequence: 5,
      executionId: "old-compact",
    })
  ).toEqual(done);
  expect(receiveLiveEvent(done, delta(6, "旧正文"))).toEqual(done);
  const switched = hydrateLiveTask(
    {
      ...snapshot,
      executionId: "compact-1",
      sequence: 3,
      events: [start],
      activity: start.activity,
    },
    [finished]
  );
  expect(switched).toEqual(done);
});

it("在停止清理期间切回仍接收中断终态，不能残留流式标记", () => {
  const stopped = hydrateLiveTask({
    ...snapshot,
    activity: { ...activity, running: false, outcome: "interrupted" },
  });
  const closed = receiveLiveEvent(stopped, {
    ...delta(3, ""),
    event: {
      type: "assistant-aborted",
      message: {
        id: "m1",
        sessionId: "a",
        role: "assistant",
        content: "第一段第二段",
        aborted: true,
        createdAt: "2026-11-11T08:00:00Z",
      },
    },
    activity: {
      ...activity,
      running: false,
      outcome: "interrupted",
      unread: true,
    },
  });
  expect(closed.items).toMatchObject([
    { content: "第一段第二段", interrupted: true },
  ]);
  expect(closed.items[0]).not.toHaveProperty("streaming", true);
});
it("初始现场与订阅缓冲交错仍完整且无重，其他任务和旧执行迟到事件不能污染新执行", () => {
  let state = hydrateLiveTask(snapshot, [
    delta(2, "第二段"),
    delta(3, "第三段"),
    { ...delta(4, "其他任务"), taskId: "b" },
  ]);
  expect(state.items).toMatchObject([
    { content: "第一段第二段第三段", streaming: true },
  ]);
  state = receiveLiveEvent(state, delta(3, "重复第三段"));
  state = receiveLiveEvent(state, {
    ...delta(4, ""),
    executionId: "e2",
    event: {
      type: "user-message",
      message: {
        id: "user2",
        sessionId: "a",
        role: "user",
        content: "继续",
        createdAt: "2026-11-11T08:00:00Z",
      },
    },
  });
  state = receiveLiveEvent(state, delta(5, "旧执行污染"));
  expect(state.items).toMatchObject([
    { content: "第一段第二段第三段" },
    { content: "继续" },
  ]);
  const done = receiveLiveEvent(state, {
    ...delta(6, "", "e2"),
    event: {
      type: "assistant-done",
      message: {
        id: "m2",
        sessionId: "a",
        role: "assistant",
        content: "完成",
        createdAt: "2026-11-11T08:00:00Z",
      },
    },
    activity: {
      ...activity,
      running: false,
      outcome: "completed",
      unread: true,
    },
  });
  expect(receiveLiveEvent(done, delta(7, "终态后污染", "e2"))).toEqual(done);
});

it("历史恢复与运行期流式输出形状一致：同一消息段模型、同一归并入口", () => {
  // 落库历史（user + assistant 完成 + 工具卡）经 initialTranscript 恢复
  const history = [
    {
      kind: "message" as const,
      message: {
        id: "u1",
        sessionId: "a",
        role: "user" as const,
        content: "查一下",
        createdAt: "2026-11-11T08:00:00Z",
      },
    },
    {
      kind: "tool-call" as const,
      call: {
        id: "t1",
        sessionId: "a",
        toolName: "read_file",
        arguments: '{"path":"a.txt"}',
        output: "内容",
        isError: false,
        createdAt: "2026-11-11T08:00:01Z",
      },
    },
    {
      kind: "message" as const,
      message: {
        id: "a1",
        sessionId: "a",
        role: "assistant" as const,
        content: "结论",
        createdAt: "2026-11-11T08:00:02Z",
      },
    },
  ];
  const restored = hydrateLiveTask({
    ...snapshot,
    executionId: null,
    sequence: 0,
    events: [],
    activity: { ...activity, running: false, outcome: "completed" },
    history,
  });
  expect(restored.items.map((item) => item.kind)).toEqual([
    "user",
    "tool-call",
    "assistant",
  ]);
  expect(restored.items.every((item) => item.seq > 0)).toBe(true);

  // 同一轮的运行期事件流经同一 applyTaskEvent 入口，产出同形状段序列
  const userMessage = history[0]?.message;
  const toolCallRecord = history[1]?.call;
  const assistantMessage = history[2]?.message;
  if (
    userMessage?.role !== "user" ||
    toolCallRecord === undefined ||
    assistantMessage?.role !== "assistant"
  ) {
    throw new Error("测试历史构造不完整");
  }
  const liveEvents: Parameters<typeof applyTaskEvent>[1][] = [
    { type: "user-message", message: userMessage },
    { type: "tool-call", call: { ...toolCallRecord, output: "" } },
    { type: "tool-result", call: toolCallRecord },
    { type: "assistant-done", message: assistantMessage },
  ];
  const live = liveEvents.reduce(
    (items, event) => applyTaskEvent(items, event),
    [] as ReturnType<typeof applyTaskEvent>
  );
  expect(live.map((item) => item.kind)).toEqual(
    restored.items.map((item) => item.kind)
  );
  expect(live.map((item) => item.turnId)).toEqual(
    restored.items.map((item) => item.turnId)
  );
});

it("思考的落盘恢复与内存重放衔接（票 02）：切走再切回运行中任务不重复、不丢失；重启后由落盘重建", () => {
  const reasoningEnvelope = (
    sequence: number,
    delta: string
  ): TaskEventEnvelope => ({
    taskId: "a",
    executionId: "e1",
    sequence,
    activity,
    event: { type: "assistant-reasoning", messageId: "m1", delta },
  });
  // 运行中任务切走再切回：view = 执行起点快照（不含本轮）+ 内存事件重放
  const switchedBack = hydrateLiveTask({
    ...snapshot,
    history: [],
    events: [
      reasoningEnvelope(1, "第一段思考"),
      reasoningEnvelope(2, "，第二段"),
    ],
  });
  // 思考不丢失：两段增量归并为一个思考段（同一响应的流态追加）
  const thinking = switchedBack.items.filter(
    (item) => item.kind === "thinking"
  );
  expect(thinking).toHaveLength(1);
  expect(thinking[0]).toMatchObject({ content: "第一段思考，第二段" });
  // 不重复：落盘历史不含本轮（执行起点快照），重放不与快照重复
  expect(
    switchedBack.items.filter(
      (item) => item.kind === "thinking" && item.content.includes("第一段思考")
    )
  ).toHaveLength(1);

  // 重启后：内存事件缓冲消失，落盘终态消息（带 reasoning）经 transcript 恢复
  const restarted = hydrateLiveTask({
    taskId: "a",
    executionId: null,
    sequence: 0,
    history: [
      {
        kind: "message",
        message: {
          id: "u1",
          sessionId: "a",
          role: "user",
          content: "任务内的问题",
          createdAt: "2026-11-11T08:00:00Z",
        },
      },
      {
        kind: "message",
        message: {
          id: "m1",
          sessionId: "a",
          role: "assistant",
          content: "终态正文",
          reasoning: "第一段思考，第二段",
          createdAt: "2026-11-11T08:00:01Z",
        },
      },
    ],
    events: [],
    pendingInteractions: [],
    activity: { ...activity, running: false, outcome: "completed" },
  });
  expect(restarted.items.map((item) => item.kind)).toEqual([
    "user",
    "thinking",
    "assistant",
  ]);
  expect(restarted.items[1]).toMatchObject({
    content: "第一段思考，第二段",
    responseId: "m1",
  });
  const restoredThinking = restarted.items[1];
  if (restoredThinking?.kind !== "thinking")
    throw new Error("恢复后的第二段应为思考段");
  expect(restoredThinking.streaming).toBeUndefined();
});

it("空闲队列事件按任务水位接续，加载缓冲与重复事件不回退队列", () => {
  const view: TaskView = {
    ...snapshot,
    activity: { ...activity, running: false, outcome: "completed" },
  };
  const changed: TaskEventEnvelope = {
    ...delta(3, ""),
    activity: view.activity,
    event: {
      type: "queue-changed",
      reason: "remove",
      queue: [],
      paused: true,
      sendingId: null,
    },
  };
  const initial = hydrateLiveTask(view);
  const next = receiveLiveEvent(initial, changed);
  expect(next.sequence).toBe(3);
  expect(next.queueState.paused).toBe(true);
  expect(next.items).toEqual(initial.items);
  const buffered = hydrateLiveTask(view, [changed]);
  expect(buffered).toMatchObject({
    sequence: next.sequence,
    queueState: next.queueState,
  });
  expect(receiveLiveEvent(next, changed)).toBe(next);
  expect(receiveLiveEvent(next, { ...changed, taskId: "b", sequence: 4 })).toBe(
    next
  );
});

it("正在发出的条目随事件与快照接续（票 03）：sending 锁定 id 不丢、出队后清空、切换恢复保持", () => {
  const item = {
    id: "q1",
    taskId: "a",
    position: 0,
    text: "正在发出的一条",
    mentionPaths: [],
    providerProfileId: "p1",
    thinkingEffort: "auto" as const,
    approvalMode: "ask" as const,
    createdAt: "2026-11-13T00:00:00Z",
  };
  // 取出发送：sending 事件携带锁定 id，条目仍在队列快照中
  const idle: TaskView = {
    ...snapshot,
    activity: { ...activity, running: false, outcome: "completed" },
  };
  let state = hydrateLiveTask(idle);
  state = receiveLiveEvent(state, {
    ...delta(3, ""),
    event: {
      type: "queue-changed",
      reason: "sending",
      queue: [item],
      paused: false,
      sendingId: "q1",
    },
  });
  expect(state.queueState.sendingId).toBe("q1");
  expect(state.queueState.queue.map((entry) => entry.id)).toEqual(["q1"]);
  // 出队完成：条目移除、锁定清空
  state = receiveLiveEvent(state, {
    ...delta(4, ""),
    event: {
      type: "queue-changed",
      reason: "dequeue",
      queue: [],
      paused: false,
      sendingId: null,
    },
  });
  expect(state.queueState.sendingId).toBeNull();
  expect(state.queueState.queue).toEqual([]);
  // 切换/重开恢复：view 快照带回锁定 id（正在发出的条目仍区别显示）
  const restored = hydrateLiveTask({
    ...snapshot,
    queueState: { queue: [item], paused: false, sendingId: "q1" },
    activity: idle.activity,
  });
  expect(restored.queueState.sendingId).toBe("q1");
});

it("输入队列随事件与快照接续（票 01）：入队更新快照，出队开启新执行起点，不进消息流", () => {
  const queued = [
    {
      id: "q1",
      taskId: "a",
      position: 0,
      text: "排队第一条",
      mentionPaths: [],
      providerProfileId: "p1",
      thinkingEffort: "auto" as const,
      approvalMode: "ask" as const,
      createdAt: "2026-11-13T00:00:00Z",
    },
  ];
  // 执行中入队：事件挂当前执行，队列快照更新
  let state = hydrateLiveTask(snapshot);
  const enqueued = receiveLiveEvent(state, {
    ...delta(3, ""),
    event: {
      type: "queue-changed",
      reason: "enqueue",
      queue: queued,
      paused: false,
    },
  });
  expect(enqueued.queueState.queue.map((item) => item.text)).toEqual([
    "排队第一条",
  ]);
  expect(enqueued.queueState.paused).toBe(false);
  // 队列事件不进消息流
  expect(enqueued.items).toEqual(state.items);

  // 停止置暂停（票 02）：paused 随 queue-changed 事件接续
  const pausedState = receiveLiveEvent(enqueued, {
    ...delta(4, ""),
    event: {
      type: "queue-changed",
      reason: "pause",
      queue: queued,
      paused: true,
    },
  });
  expect(pausedState.queueState.paused).toBe(true);

  // 回复结束（running=false）后出队发送：queue-changed 挂新执行，
  // 视为明确执行起点接续（与 user-message 同级的 starts）
  const settled = receiveLiveEvent(pausedState, {
    ...delta(5, ""),
    event: {
      type: "assistant-done",
      message: {
        id: "m1",
        sessionId: "a",
        role: "assistant",
        content: "完成",
        createdAt: "2026-11-13T00:00:01Z",
      },
    },
    activity: { ...activity, running: false, outcome: "completed" },
  });
  state = settled;
  const dequeued = receiveLiveEvent(state, {
    taskId: "a",
    executionId: "e2",
    sequence: 6,
    activity: { ...activity, running: true },
    event: {
      type: "queue-changed",
      reason: "dequeue",
      queue: [],
      paused: false,
    },
  });
  expect(dequeued.queueState.queue).toEqual([]);
  expect(dequeued.queueState.paused).toBe(false);
  expect(dequeued.executionId).toBe("e2");
  // 新执行起点后的正文事件照常接续
  const continued = receiveLiveEvent(dequeued, delta(7, "新回复", "e2"));
  expect(continued.items.at(-1)).toMatchObject({ content: "新回复" });

  // 切换任务快照恢复：view.queue 原样带回队列条与暂停态（票 02）
  const restored = hydrateLiveTask({
    ...snapshot,
    queueState: { queue: queued, paused: true, sendingId: null },
    activity: { ...activity, running: false, outcome: "completed" },
  });
  expect(restored.queueState.queue.map((item) => item.text)).toEqual([
    "排队第一条",
  ]);
  expect(restored.queueState.paused).toBe(true);
});
