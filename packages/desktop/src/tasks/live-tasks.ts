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
/**
 * 终端会话生命周期事件类型（ADR 0033）：两处白名单共用的清单。
 * 终端会话是宿主级常驻、任务中断不杀（ADR 0033）——事件可能在无执行现场
 * （空闲）、已终态（terminalAt > 0）或用户停止（stopped）后到达，三个关口
 * 都须放行：它们是任务级状态快照事件，不是执行现场的新正文/工具。
 * 标题变化（标题功能轮）同为会话级状态：只进 rail 列表归并（useTerminal
 * Sessions 直连 onTaskEvent），消息流闸门（ui live-task）不放行、标记行不
 * 重写历史。
 */
const TERMINAL_EVENT_TYPES = [
  "terminal-started",
  "terminal-exited",
  "terminal-title-changed",
];

/**
 * 目标模式事件类型（ADR 0035）：goal-changed（目标状态快照）、goal-verifying
 * （完成判定开始，「验证中」）与 goal-verification（完成判定结论）。完成判定在
 * 回合结束后的 idle 边界发出——晚于终态事件；Stop = 暂停的目标状态变化也紧随
 * 用户停止。三者都是任务级状态快照，不是执行现场的新正文/工具：终态后与停止后
 * 一律放行（与终端生命周期同口径）。
 */
const GOAL_EVENT_TYPES = [
  "goal-changed",
  "goal-verifying",
  "goal-verification",
];

export function createLiveTasks(manager: TaskManager) {
  const tasks = new Map<string, LiveExecution>();
  // 恢复态中断任务的「本会话已查看」记账：无执行现场的任务没有 viewed
  // 水位可推进，单独记集合——重启恢复的 interrupted 在查看一次后不再以
  // 未读提醒（与中断徽章的未读口径配套，2026-11-19；会话内有效，再次
  // 重启重新提醒一次）
  const recoveredViewed = new Set<string>();
  const idle = (): TaskActivity => ({
    running: false,
    waitingForUser: false,
    outcome: null,
    unread: false,
  });
  function activity(id: string): TaskActivity {
    const live = tasks.get(id);
    if (!live) {
      const aborted = manager.messages(id).at(-1)?.aborted === true;
      return {
        ...idle(),
        outcome: aborted ? "interrupted" : null,
        unread: aborted && !recoveredViewed.has(id),
      };
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
        event.type !== "task-queue-changed" &&
        // 终端生命周期（ADR 0033）：任务终态后终端仍会启停（宿主级常驻），
        // 与 queue-changed 同口径延续任务水位
        !TERMINAL_EVENT_TYPES.includes(event.type) &&
        // 目标模式（ADR 0035）：完成判定在回合终态之后的 idle 边界发出
        !GOAL_EVENT_TYPES.includes(event.type))
    )
      return null;
    // 停止后仅接收清理终态，不能再显示新的正文、工具开始或等待请求。
    // 终端事件例外：任务中断不杀会话（ADR 0033），停止后的会话启停
    // 照常下发——这正是终端躲开任务中断的功能起点。
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
        // 终端生命周期（ADR 0033）：停止后终端照常启停
        ...TERMINAL_EVENT_TYPES,
        // 目标模式（ADR 0035）：停止后的目标状态变化（Stop = 暂停）与已在途
        // 判定的结论照常下发，否则界面停在停止前的目标状态
        ...GOAL_EVENT_TYPES,
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
    const executionId = ensureExecution(id);
    return executionId === null ? null : accept(id, executionId, event);
  }
  /**
   * 延续或建立无执行现场任务的现场并返回其 executionId（review 修复 F1）：
   * 排队等离流事件（补落的 user-message）需挂在现场信封上推送；任务不
   * 存在返回 null（与 acceptQueue 建现场同一分支抽出）。
   */
  function ensureExecution(id: string): string | null {
    const live = tasks.get(id);
    if (live !== undefined) return live.executionId;
    if (!manager.list().some((record) => record.id === id)) return null;
    const created: LiveExecution = {
      executionId: randomUUID(),
      history: manager.transcript(id),
      subagents: manager.subagents(id),
      events: [],
      sequence: 0,
      viewed: 0,
      terminalAt: 0,
      stopped: false,
      activity: activity(id),
    };
    tasks.set(id, created);
    return created.executionId;
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
      // 并行恢复字段（ADR 0033 票 08）：已退出会话随 view 一次性下发
      // （含重启收尾置终态的行，快照缺省容忍）；运行中的会话不经本字段
      // ——list-for 与 terminal-* 事件是其呈现通道。重启后内存注册表为空，
      // 本字段是「已退出」组恢复的唯一数据源
      terminals: manager
        .terminalSessions(id)
        .filter((record) => record.status === "exited"),
      events: live ? [...live.events] : [],
      pendingInteractions: manager.get(id)?.pendingInteractions ?? [],
      activity: activity(id),
      // 当前目标（ADR 0035）：读库——目标状态随任务落库，不依赖执行现场
      goal: manager.goal(id),
    };
  }
  function markViewed(id: string, sequence: number) {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence > (tasks.get(id)?.sequence ?? 0)
    )
      throw new Error("查看水位不合法");
    const live = tasks.get(id);
    if (live) live.viewed = Math.max(live.viewed, sequence);
    // 无执行现场（重启恢复的历史任务）没有水位可推进：记入集合即视为
    // 已查看，恢复态中断的未读提醒随之熄灭
    else recoveredViewed.add(id);
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
    ensureExecution,
    view,
    activity,
    markViewed,
    stop,
    forget(id: string) {
      tasks.delete(id);
      recoveredViewed.delete(id);
    },
  };
}
