import { randomUUID } from "node:crypto";
import type {
  SubagentSnapshot,
  TaskManager,
  TranscriptItem,
} from "@codexlike/agent-core/node";
import type { TaskActivity, TaskEventEnvelope, TaskView } from "../shared/ipc";

interface LiveExecution {
  executionId: string;
  history: TranscriptItem[];
  /** 子代理恢复快照（票 03）：与 history 同为执行起点快照，compact 只替换 history */
  subagents: SubagentSnapshot[];
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
 * 子代理恢复快照（票 03）与 history 并行同点采样：本轮新委派经事件流重建
 * （不与落库行重复计数），compact 整体替换 history 时并行字段原样保留。
 */
export function createLiveTasks(manager: TaskManager) {
  const tasks = new Map<string, LiveExecution>();
  const idle = (): TaskActivity => ({
    running: false,
    waitingForUser: false,
    outcome: null,
    unread: false,
  });
  function activity(id: string): TaskActivity {
    const live = tasks.get(id);
    if (!live) {
      const last = manager.messages(id).at(-1);
      return { ...idle(), outcome: last?.aborted ? "interrupted" : null };
    }
    return { ...live.activity, unread: live.terminalAt > live.viewed };
  }
  function begin(id: string, executionId: string) {
    const previous = tasks.get(id);
    tasks.set(id, {
      executionId,
      history: manager.transcript(id),
      subagents: manager.subagents(id),
      events: [],
      sequence: previous?.sequence ?? 0,
      viewed: previous?.sequence ?? 0,
      terminalAt: 0,
      stopped: false,
      activity: { ...idle(), running: true },
    });
    return () => {
      const live = tasks.get(id);
      if (live?.executionId !== executionId || live.events.length > 0) return;
      if (previous) tasks.set(id, previous);
      else tasks.delete(id);
    };
  }
  function accept(
    id: string,
    executionId: string,
    event: TaskEventEnvelope["event"]
  ): TaskEventEnvelope | null {
    const live = tasks.get(id);
    if (
      !live ||
      live.executionId !== executionId ||
      (live.terminalAt > 0 &&
        event.type !== "queue-changed" &&
        event.type !== "task-queue-changed")
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
        "task-auto-approve-changed",
        "subagent-report",
        "subagent-tool",
        // 输入队列变更（票 01）：停止期间入队仍要推送队列快照；
        // 任务排队变更（任务并发上限票 02）同为任务状态快照，同口径放行
        "queue-changed",
        "task-queue-changed",
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
      taskId: id,
      executionId,
      sequence: live.sequence,
      event,
      activity: activity(id),
    };
    live.events.push(envelope);
    return envelope;
  }
  /**
   * 队列修改不等同于执行：空闲/重开后也延续任务水位，不伪造运行态。
   * 任务排队变更（任务并发上限票 02）与输入队列变更同口径——排队中的
   * 任务无执行现场，信封为其延续水位并携带 queued 活动态。
   */
  function acceptQueue(
    id: string,
    event:
      | Extract<TaskEventEnvelope["event"], { type: "queue-changed" }>
      | Extract<TaskEventEnvelope["event"], { type: "task-queue-changed" }>
  ): TaskEventEnvelope | null {
    if (!tasks.has(id)) {
      if (!manager.list().some((record) => record.id === id)) return null;
      tasks.set(id, {
        executionId: randomUUID(),
        history: manager.transcript(id),
        subagents: manager.subagents(id),
        events: [],
        sequence: 0,
        viewed: 0,
        terminalAt: 0,
        stopped: false,
        activity: activity(id),
      });
    }
    return accept(id, tasks.get(id)!.executionId, event);
  }
  function view(id: string): TaskView | null {
    const record = manager.list().find((record) => record.id === id);
    if (!record) return null;
    const live = tasks.get(id);
    return {
      taskId: id,
      autoApprove: record.autoApprove ?? false,
      executionId: live?.executionId ?? null,
      sequence: live?.sequence ?? 0,
      history: live?.history ?? manager.transcript(id),
      // 并行恢复字段（票 03）：有现场用执行起点快照，无现场（重启后首次查看）
      // 直接读库——含启动收尾补记的 interrupted 骨架
      subagents: live?.subagents ?? manager.subagents(id),
      events: live ? [...live.events] : [],
      pendingInteractions: manager.get(id)?.pendingInteractions ?? [],
      activity: activity(id),
    };
  }
  function markViewed(id: string, sequence: number) {
    const live = tasks.get(id);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence > (live?.sequence ?? 0)
    )
      throw new Error("查看水位不合法");
    if (live) live.viewed = Math.max(live.viewed, sequence);
  }
  function stop(id: string) {
    const live = tasks.get(id);
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
      tasks.delete(id);
    },
  };
}
