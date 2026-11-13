import { randomUUID } from "node:crypto";
import type { TaskManager, TranscriptItem } from "@codexlike/agent-core/node";
import type { TaskActivity, TaskEventEnvelope, TaskView } from "../shared/ipc";

interface LiveExecution {
  executionId: string;
  history: TranscriptItem[];
  events: TaskEventEnvelope[];
  sequence: number;
  viewed: number;
  terminalAt: number;
  stopped: boolean;
  activity: TaskActivity;
}

/** 宿主保存当前执行日志；历史只在执行起点取一次，避免轮末落库与增量重复。
 * 同步采样水位及事件，renderer 先订阅、后读取、仅接续水位之后事件。
 * 日志限于最后一次执行且仅在内存；思考随终态消息/委派记录落 SQLite（票 02），
 * 重启后走 transcript 恢复，与这里的内存重放互不重复。
 */
export function createLiveTasks(manager: TaskManager) {
  const sessions = new Map<string, LiveExecution>();
  const idle = (): TaskActivity => ({
    running: false,
    waitingForUser: false,
    outcome: null,
    unread: false,
  });
  function activity(id: string): TaskActivity {
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
    event: TaskEventEnvelope["event"]
  ): TaskEventEnvelope | null {
    const live = sessions.get(id);
    if (
      !live ||
      live.executionId !== executionId ||
      (live.terminalAt > 0 && event.type !== "queue-changed")
    )
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
        "session-auto-approve-changed",
        "subagent-report",
        "subagent-tool",
        // 输入队列变更（票 01）：停止期间入队仍要推送队列快照
        "queue-changed",
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
    const envelope: TaskEventEnvelope = {
      sessionId: id,
      executionId,
      sequence: live.sequence,
      event,
      activity: activity(id),
    };
    live.events.push(envelope);
    return envelope;
  }
  /** 队列修改不等同于执行：空闲/重开后也延续任务水位，不伪造运行态。 */
  function acceptQueue(
    id: string,
    event: Extract<TaskEventEnvelope["event"], { type: "queue-changed" }>
  ): TaskEventEnvelope | null {
    if (!sessions.has(id)) {
      if (!manager.list().some((record) => record.id === id)) return null;
      sessions.set(id, {
        executionId: randomUUID(),
        history: manager.transcript(id),
        events: [],
        sequence: 0,
        viewed: 0,
        terminalAt: 0,
        stopped: false,
        activity: activity(id),
      });
    }
    return accept(id, sessions.get(id)!.executionId, event);
  }
  function view(id: string): TaskView | null {
    const record = manager.list().find((record) => record.id === id);
    if (!record) return null;
    const live = sessions.get(id);
    return {
      sessionId: id,
      autoApprove: record.autoApprove ?? false,
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
    acceptQueue,
    view,
    activity,
    markViewed,
    stop,
    forget(id: string) {
      sessions.delete(id);
    },
  };
}
