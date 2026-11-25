import type { GoalRecord } from "@codexlike/agent-core";
import type {
  QueueSnapshot,
  TaskActivity,
  TaskEventEnvelope,
  TaskView,
} from "@codexlike/desktop/ipc";
import {
  appendGoalVerification,
  applyTaskEvent,
  beginGoalVerification,
  dropPendingGoalVerifications,
  initialTranscript,
  mergeInteractions,
  mergeSubagentsAfterCompact,
  type MessageSegment,
} from "./task-view";

/** 队列状态为空时的基准快照（无排队、未暂停、无正在发出条目）。 */
export const EMPTY_QUEUE_STATE: QueueSnapshot = {
  queue: [],
  paused: false,
  sendingId: null,
};

export interface LiveTask {
  taskId: string;
  autoApprove: boolean;
  executionId: string | null;
  sequence: number;
  activity: TaskActivity;
  items: MessageSegment[];
  /**
   * 输入队列状态快照（票 01/02/03，review 重构收拢三元组）：随 queue-changed
   * 事件与 view 快照接续，不进消息流——含排队条目、暂停标志与正在发出条目。
   */
  queueState: QueueSnapshot;
  /**
   * 任务排队中的首条执行文本（任务并发上限票 03 / ADR 0022）：排队任务的
   * 首条消息尚未进入执行（不落 transcript、无 user-message 事件），消息流
   * 的本地呈现从 task-queue-changed 信封携带的全局快照里取本任务条目。
   * 开跑（user-message 接管，此时快照可能尚未出队）与出队（快照不再含
   * 本任务）都由显示层按 running / 快照缺席判定，字段本身只跟随最后的
   * 快照。不在排队为 null。
   */
  queuedStart: string | null;
  /**
   * 当前目标（ADR 0035，GLOSSARY「目标」）：输入框上方进度行的数据源。
   * 随 view.goal 恢复、随 goal-changed 事件接续；null = 当前无目标（进度行不占位）。
   */
  goal: GoalRecord | null;
}

function applyLiveEvent(
  items: MessageSegment[],
  event: TaskEventEnvelope["event"]
): MessageSegment[] {
  if (event.type === "compact-start") return items;
  if (event.type === "compact-finished")
    // compact 只裁消息流历史；子代理过程记录与 compact 无关（ADR 0021），
    // 重放后按 toolCallId 回接 compact 前的过程富段（轮次/工具/起止时间）
    return mergeSubagentsAfterCompact(initialTranscript(event.history), items);
  if (event.type === "queue-changed") return items;
  // 任务排队变更（任务并发上限票 02）同为任务状态而非消息增量，不进消息流
  if (event.type === "task-queue-changed") return items;
  // 目标状态变化（ADR 0035）不进消息流；目标离开进行中时，还没出结论的
  // 「验证中」占位行撤下（判定在途被中断不留结论）
  if (event.type === "goal-changed")
    return event.goal !== null && event.goal.status === "active"
      ? items
      : dropPendingGoalVerifications(items);
  // 完成判定开始：原位出现「第 N 次迭代 · 验证中」占位行
  if (event.type === "goal-verifying")
    return beginGoalVerification(items, {
      goalId: event.goalId,
      round: event.round,
    });
  if (event.type === "goal-verification")
    return appendGoalVerification(items, event.verification);
  // 续跑轮的内部输入（ADR 0035）：不产生用户气泡，回复照常入流
  if (event.type === "goal-continuation") return items;
  return applyTaskEvent(items, event);
}

/** 全局任务排队快照里本任务的首条执行文本；不在队为 null（票 03）。 */
function queuedStartOf(
  taskId: string,
  event: Extract<TaskEventEnvelope["event"], { type: "task-queue-changed" }>
): string | null {
  return event.queue.find((entry) => entry.taskId === taskId)?.text ?? null;
}

/** 信封只按单调水位接续；新执行必须由明确起点开启，旧执行不能越界。 */
export function receiveLiveEvent(
  state: LiveTask,
  envelope: TaskEventEnvelope
): LiveTask {
  if (envelope.taskId !== state.taskId || envelope.sequence <= state.sequence)
    return state;
  const starts =
    envelope.event.type === "user-message" ||
    envelope.event.type === "compact-start" ||
    // 队列是任务状态而非执行增量：空闲修改也按主进程单调水位接续。
    envelope.event.type === "queue-changed" ||
    // 任务排队（任务并发上限票 02）同为任务状态：排队中的任务无执行现场
    //（running=false），不按起点接续会被丢弃——queued 活动态随信封携带。
    envelope.event.type === "task-queue-changed" ||
    // 终端会话生命周期（ADR 0033 票09 e2e 揭示的渲染端缺口）：终端是宿主级
    // 常驻实体、在执行现场之外启停（宿主桥 pushTaskEvent 经 ensureExecution
    // 挂当前现场，信封是任务级状态快照而非执行增量）——rail 直连
    // onTaskEvent 不经本闸门，消息流却会在空闲期丢事件：用户手开会话的
    // 标记行不出现、空闲期 kill 后标记行停留 running 与 rail 状态分裂。
    // 与 queue-changed 同口径按水位接续（09 票补 ui 单测锁定）。
    envelope.event.type === "terminal-started" ||
    envelope.event.type === "terminal-exited" ||
    // 目标模式（ADR 0035）：判定在回合终态之后的 idle 边界发出、Stop = 暂停
    // 的状态变化紧随用户停止——到达时宿主已不处于运行态，同为任务级状态
    // 快照，按水位接续（否则进度行与标记行在空闲期收不到）
    envelope.event.type === "goal-changed" ||
    envelope.event.type === "goal-verifying" ||
    envelope.event.type === "goal-verification" ||
    // 续跑轮是新的宿主执行（上一轮已收尾）：goal-continuation 是它的起点
    // 信号，续跑轮后续的正文 / 工具事件按新执行接续
    envelope.event.type === "goal-continuation";
  const cleanup =
    state.activity.outcome === "interrupted" &&
    [
      "compact-finished",
      "task-auto-approve-changed",
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
    taskId: state.taskId,
    autoApprove:
      envelope.event.type === "task-auto-approve-changed"
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
    queuedStart:
      envelope.event.type === "task-queue-changed"
        ? queuedStartOf(state.taskId, envelope.event)
        : state.queuedStart,
    goal:
      envelope.event.type === "goal-changed" ? envelope.event.goal : state.goal,
  };
}

/** 快照历史固定于执行起点，运行日志不会与轮末落库的正文重复。 */
export function hydrateLiveTask(
  view: TaskView,
  buffered: TaskEventEnvelope[] = []
): LiveTask {
  // 恢复新路径（票 04）：并行子代理快照随 history 同一载荷重建过程段
  let items = initialTranscript(view.history, view.subagents);
  // 排队首条快照（review 修复 F2）：重启后仍排队任务无信封可重放，
  // 由 view 的排队快照字段恢复；同进程会话 events 里的信封重放更新
  //（最后一个含/不含本任务的快照生效），覆盖快照字段。
  let queuedStart: string | null = view.queuedStart ?? null;
  for (const envelope of view.events) {
    if (envelope.event.type === "task-queue-changed")
      queuedStart = queuedStartOf(view.taskId, envelope.event);
    items = applyLiveEvent(items, envelope.event);
  }
  let state: LiveTask = {
    taskId: view.taskId,
    autoApprove: view.autoApprove ?? false,
    executionId: view.executionId,
    sequence: view.sequence,
    activity: view.activity,
    items: mergeInteractions(items, view.pendingInteractions),
    queueState: view.queueState ?? EMPTY_QUEUE_STATE,
    queuedStart,
    goal: view.goal ?? null,
  };
  for (const envelope of buffered) state = receiveLiveEvent(state, envelope);
  return state;
}
