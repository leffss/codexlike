import { expect, it } from "vitest";
import type { SessionEventEnvelope, SessionView } from "@codexlike/desktop/ipc";
import { hydrateLiveSession, receiveLiveEvent } from "../src/lib/live-session";

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
): SessionEventEnvelope {
  return {
    sessionId: "a",
    executionId,
    sequence,
    activity,
    event: { type: "assistant-delta", messageId: "m1", delta: text },
  };
}
const snapshot: SessionView = {
  sessionId: "a",
  executionId: "e1",
  sequence: 2,
  history: [],
  events: [delta(1, "第一段"), delta(2, "第二段")],
  pendingInteractions: [],
  activity,
};
it("在停止清理期间切回仍接收中断终态，不能残留流式标记", () => {
  const stopped = hydrateLiveSession({
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
it("初始现场与订阅缓冲交错仍完整且无重，其他会话和旧执行迟到事件不能污染新执行", () => {
  let state = hydrateLiveSession(snapshot, [
    delta(2, "第二段"),
    delta(3, "第三段"),
    { ...delta(4, "其他会话"), sessionId: "b" },
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
