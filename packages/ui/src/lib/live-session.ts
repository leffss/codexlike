import type {
  QueueSnapshot,
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

/** 队列状态为空时的基准快照（无排队、未暂停、无正在发出条目）。 */
export const EMPTY_QUEUE_STATE: QueueSnapshot = {
  queue: [],
  paused: false,
  sendingId: null,
};

export interface LiveSession {
  sessionId: string;
  autoApprove: boolean;
  executionId: string | null;
  sequence: number;
  activity: SessionActivity;
  items: MessageSegment[];
  /**
   * 输入队列状态快照（票 01/02/03，review 重构收拢三元组）：随 queue-changed
   * 事件与 view 快照接续，不进消息流——含排队条目、暂停标志与正在发出条目。
   */
  queueState: QueueSnapshot;
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
    queueState:
      envelope.event.type === "queue-changed"
        ? {
            queue: envelope.event.queue,
            paused: envelope.event.paused,
            sendingId: envelope.event.sendingId ?? null,
          }
        : state.queueState,
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
    queueState: view.queueState ?? EMPTY_QUEUE_STATE,
  };
  for (const envelope of buffered) state = receiveLiveEvent(state, envelope);
  return state;
}
