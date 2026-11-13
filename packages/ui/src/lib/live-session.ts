import type {
  QueuedMessage,
  SessionActivity,
  SessionEventEnvelope,
  SessionView,
} from "@codexlike/desktop/ipc";
import {
  applySessionEvent,
  initialTranscript,
  mergeInteractions,
  type MessageSegment,
} from "./session-view";

export interface LiveSession {
  sessionId: string;
  autoApprove: boolean;
  executionId: string | null;
  sequence: number;
  activity: SessionActivity;
  items: MessageSegment[];
  /** 输入队列快照（票 01）：随 queue-changed 事件与 view 快照接续，不进消息流 */
  queue: QueuedMessage[];
  /** 队列暂停标志（票 02）：随 queue-changed 事件与 view 快照接续 */
  queuePaused: boolean;
  /** 正在发出的条目 id（票 03）：区别显示并锁定；随 queue-changed 事件与 view 快照接续 */
  queueSendingId: string | null;
}

function applyLiveEvent(
  items: MessageSegment[],
  event: SessionEventEnvelope["event"]
): MessageSegment[] {
  if (event.type === "compact-start") return items;
  if (event.type === "compact-finished")
    return initialTranscript(event.history);
  if (event.type === "queue-changed") return items;
  return applySessionEvent(items, event);
}

/** 信封只按单调水位接续；新执行必须由明确起点开启，旧执行不能越界。 */
export function receiveLiveEvent(
  state: LiveSession,
  envelope: SessionEventEnvelope
): LiveSession {
  if (
    envelope.sessionId !== state.sessionId ||
    envelope.sequence <= state.sequence
  )
    return state;
  const starts =
    envelope.event.type === "user-message" ||
    envelope.event.type === "compact-start" ||
    // 队列是会话状态而非执行增量：空闲修改也按主进程单调水位接续。
    envelope.event.type === "queue-changed";
  const cleanup =
    state.activity.outcome === "interrupted" &&
    [
      "compact-finished",
      "session-auto-approve-changed",
      "assistant-aborted",
      "tool-result",
      "interaction-resolved",
      "subagent-report",
      "subagent-tool",
      "error",
    ].includes(envelope.event.type);
  if (
    !starts &&
    (envelope.executionId !== state.executionId ||
      (!state.activity.running && !cleanup))
  )
    return state;
  return {
    sessionId: state.sessionId,
    autoApprove:
      envelope.event.type === "session-auto-approve-changed"
        ? envelope.event.autoApprove
        : state.autoApprove,
    executionId: envelope.executionId,
    sequence: envelope.sequence,
    activity: envelope.activity,
    items: applyLiveEvent(state.items, envelope.event),
    queue:
      envelope.event.type === "queue-changed"
        ? envelope.event.queue
        : state.queue,
    queuePaused:
      envelope.event.type === "queue-changed"
        ? envelope.event.paused
        : state.queuePaused,
    queueSendingId:
      envelope.event.type === "queue-changed"
        ? (envelope.event.sendingId ?? null)
        : state.queueSendingId,
  };
}

/** 快照历史固定于执行起点，运行日志不会与轮末落库的正文重复。 */
export function hydrateLiveSession(
  view: SessionView,
  buffered: SessionEventEnvelope[] = []
): LiveSession {
  let items = initialTranscript(view.history);
  for (const envelope of view.events)
    items = applyLiveEvent(items, envelope.event);
  let state: LiveSession = {
    sessionId: view.sessionId,
    autoApprove: view.autoApprove ?? false,
    executionId: view.executionId,
    sequence: view.sequence,
    activity: view.activity,
    items: mergeInteractions(items, view.pendingInteractions),
    queue: view.queue ?? [],
    queuePaused: view.queuePaused ?? false,
    queueSendingId: view.queueSendingId ?? null,
  };
  for (const envelope of buffered) state = receiveLiveEvent(state, envelope);
  return state;
}
