import type {
  SessionActivity,
  SessionEventEnvelope,
  SessionView,
} from "@codexlike/desktop/ipc";
import {
  applySessionEvent,
  initialTranscript,
  mergeInteractions,
  type UiItem,
} from "./session-view";

export interface LiveSession {
  sessionId: string;
  executionId: string | null;
  sequence: number;
  activity: SessionActivity;
  items: UiItem[];
}

/** 信封只按单调水位接续；新执行必须由 user-message 开启，旧执行不能越界。 */
export function receiveLiveEvent(
  state: LiveSession,
  envelope: SessionEventEnvelope
): LiveSession {
  if (
    envelope.sessionId !== state.sessionId ||
    envelope.sequence <= state.sequence
  )
    return state;
  const starts = envelope.event.type === "user-message";
  const cleanup =
    state.activity.outcome === "interrupted" &&
    [
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
    executionId: envelope.executionId,
    sequence: envelope.sequence,
    activity: envelope.activity,
    items: applySessionEvent(state.items, envelope.event),
  };
}

/** 快照历史固定于执行起点，运行日志不会与轮末落库的正文重复。 */
export function hydrateLiveSession(
  view: SessionView,
  buffered: SessionEventEnvelope[] = []
): LiveSession {
  let items = initialTranscript(view.history);
  for (const envelope of view.events)
    items = applySessionEvent(items, envelope.event);
  let state: LiveSession = {
    sessionId: view.sessionId,
    executionId: view.executionId,
    sequence: view.sequence,
    activity: view.activity,
    items: mergeInteractions(items, view.pendingInteractions),
  };
  for (const envelope of buffered) state = receiveLiveEvent(state, envelope);
  return state;
}
