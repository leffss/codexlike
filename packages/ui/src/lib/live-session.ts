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

function applyLiveEvent(
  items: UiItem[],
  event: SessionEventEnvelope["event"]
): UiItem[] {
  if (event.type === "compact-start") return items;
  if (event.type === "compact-finished")
    return initialTranscript(event.history);
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
    envelope.event.type === "compact-start";
  const cleanup =
    state.activity.outcome === "interrupted" &&
    [
      "compact-finished",
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
    items: applyLiveEvent(state.items, envelope.event),
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
    executionId: view.executionId,
    sequence: view.sequence,
    activity: view.activity,
    items: mergeInteractions(items, view.pendingInteractions),
  };
  for (const envelope of buffered) state = receiveLiveEvent(state, envelope);
  return state;
}
