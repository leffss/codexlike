import type {
  SessionManager,
  TranscriptItem,
} from "@codexlike/agent-core/node";
import type {
  SessionActivity,
  SessionEventEnvelope,
  SessionView,
} from "../shared/ipc";

interface LiveExecution {
  executionId: string;
  history: TranscriptItem[];
  events: SessionEventEnvelope[];
  sequence: number;
  viewed: number;
  terminalAt: number;
  stopped: boolean;
  activity: SessionActivity;
}

/** 宿主保存当前执行日志；历史只在执行起点取一次，避免轮末落库与增量重复。
 * 同步采样水位及事件，renderer 先订阅、后读取、仅接续水位之后事件。
 * 日志限于最后一次执行且仅在内存，运行期思考不进入 SQLite。
 */
export function createLiveSessions(manager: SessionManager) {
  const sessions = new Map<string, LiveExecution>();
  const idle = (): SessionActivity => ({
    running: false,
    waitingForUser: false,
    outcome: null,
    unread: false,
  });
  function activity(id: string): SessionActivity {
    const live = sessions.get(id);
    if (!live) {
      const last = manager.messages(id).at(-1);
      return { ...idle(), outcome: last?.aborted ? "interrupted" : null };
    }
    return { ...live.activity, unread: live.terminalAt > live.viewed };
  }
  function begin(id: string, executionId: string) {
    const previous = sessions.get(id);
    sessions.set(id, {
      executionId,
      history: manager.transcript(id),
      events: [],
      sequence: previous?.sequence ?? 0,
      viewed: previous?.sequence ?? 0,
      terminalAt: 0,
      stopped: false,
      activity: { ...idle(), running: true },
    });
    return () => {
      const live = sessions.get(id);
      if (live?.executionId !== executionId || live.events.length > 0) return;
      if (previous) sessions.set(id, previous);
      else sessions.delete(id);
    };
  }
  function accept(
    id: string,
    executionId: string,
    event: SessionEventEnvelope["event"]
  ): SessionEventEnvelope | null {
    const live = sessions.get(id);
    if (!live || live.executionId !== executionId || live.terminalAt > 0)
      return null;
    // 停止后仅接收清理终态，不能再显示新的正文、工具开始或等待请求。
    if (
      live.stopped &&
      ![
        "compact-finished",
        "assistant-aborted",
        "assistant-done",
        "error",
        "tool-result",
        "interaction-resolved",
        "approval-resolved",
        "subagent-report",
        "subagent-tool",
      ].includes(event.type)
    )
      return null;
    if (
      live.stopped &&
      event.type === "subagent-tool" &&
      event.phase === "call"
    )
      return null;
    if (live.stopped && event.type === "assistant-done")
      event = {
        type: "assistant-aborted",
        message: { ...event.message, aborted: true },
      };
    live.sequence += 1;
    if (event.type === "compact-start") {
      live.activity.operation = "compact";
    } else if (event.type === "compact-finished") {
      if (live.stopped) event = { ...event, outcome: "interrupted" };
      live.activity = { ...idle(), outcome: event.outcome };
      live.terminalAt = live.sequence;
      // 同一个终态信封携带权威历史，切换中的客户端无需另一次有竞态的查询。
      live.history = event.history;
      live.events = [];
    } else if (
      event.type === "assistant-done" ||
      event.type === "assistant-aborted" ||
      event.type === "error"
    ) {
      live.activity.running = false;
      live.activity.waitingForUser = false;
      live.activity.outcome =
        event.type === "error"
          ? "failed"
          : event.type === "assistant-aborted"
            ? "interrupted"
            : "completed";
      live.terminalAt = live.sequence;
    } else {
      live.activity.waitingForUser =
        !live.stopped && (manager.get(id)?.pendingInteractions.length ?? 0) > 0;
    }
    const envelope: SessionEventEnvelope = {
      sessionId: id,
      executionId,
      sequence: live.sequence,
      event,
      activity: activity(id),
    };
    live.events.push(envelope);
    return envelope;
  }
  function view(id: string): SessionView | null {
    if (!manager.list().some((record) => record.id === id)) return null;
    const live = sessions.get(id);
    return {
      sessionId: id,
      executionId: live?.executionId ?? null,
      sequence: live?.sequence ?? 0,
      history: live?.history ?? manager.transcript(id),
      events: live ? [...live.events] : [],
      pendingInteractions: manager.get(id)?.pendingInteractions ?? [],
      activity: activity(id),
    };
  }
  function markViewed(id: string, sequence: number) {
    const live = sessions.get(id);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence > (live?.sequence ?? 0)
    )
      throw new Error("查看水位不合法");
    if (live) live.viewed = Math.max(live.viewed, sequence);
  }
  function stop(id: string) {
    const live = sessions.get(id);
    if (!live || live.terminalAt > 0) return;
    live.stopped = true;
    live.activity = {
      running: false,
      waitingForUser: false,
      outcome: "interrupted",
      unread: false,
    };
  }
  return {
    begin,
    accept,
    view,
    activity,
    markViewed,
    stop,
    forget(id: string) {
      sessions.delete(id);
    },
  };
}
