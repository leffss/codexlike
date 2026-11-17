import type { ApprovalMode, ThinkingEffort } from "@codexlike/agent-core/node";

/**
 * 排队任务的首条执行快照（GLOSSARY「排队任务」，任务并发上限票 02 /
 * ADR 0022）：任务空闲时的发送（新任务首条或新一轮直发）因全局满员入队，
 * 连同发送参数快照一起排队，名额空出后由主进程按快照自动开跑。
 * 持久化形状：顺序位置、发送参数快照（消息文本、@引用、Provider Profile、
 * 思考档位、审批模式）、入队时间（票 05 接真实存储，语义与输入队列同构）。
 */
export interface QueuedTaskStart {
  taskId: string;
  /** 顺序位置：按入队顺序递增，开跑从最小 position 开始（严格 FIFO）。 */
  position: number;
  text: string;
  mentionPaths: string[];
  providerProfileId: string;
  /** 任务所选具体模型（票 02 二元组）；null = 未显式选（回退列表第一项） */
  model: string | null;
  thinkingEffort: ThinkingEffort;
  approvalMode: ApprovalMode;
  createdAt: string;
}

/** 闸门入队输入：taskId / position / createdAt 由协调器分配。 */
export type TaskQueueEnqueueInput = Omit<
  QueuedTaskStart,
  "taskId" | "position" | "createdAt"
>;

/**
 * 任务排队持久化接缝（票 02 内存态，票 05 换真实实现）：全局单队列，
 * 排队中每任务至多一条（闸门幂等），形态紧贴 InputQueueStore。
 */
export interface TaskQueueStore {
  /** 全部排队任务，按 position 升序。 */
  list(): QueuedTaskStart[];
  /** 追加一条（position 由 store 分配为当前最大 +1）。 */
  append(entry: Omit<QueuedTaskStart, "position">): QueuedTaskStart;
  /** 出队指定任务；不在队列返回 false。 */
  remove(taskId: string): boolean;
  /** 释放存储句柄（宿主退出前调用；内存实现为空操作）。 */
  close(): void;
}

/** 队列变更原因：入队 / 出队开跑 / 出队移除（中断与清理共用 remove）。 */
export type TaskQueueChangeReason = "enqueue" | "dequeue" | "remove";

/**
 * 全局任务排队协调器（任务并发上限票 02 主干，ADR 0022）。
 * - gate：发送闸门——执行中任务数（含等待用户交互，占坑口径由注入的
 *   executingTaskIds 单一给出）达到上限时入队返回 "queued"，有空位放行
 *   返回 "start"（调用方在同一同步段内占坑开始执行）；已在排队幂等返回
 *   "queued"，不重复入队也不覆盖快照。
 * - pump：名额释放（执行结束）或上限调大后调用——严格 FIFO 逐个开跑
 *   到名额用尽或队列清空。开跑成功（消息已进入任务）才出队落库；
 *   开跑失败条目保留（不丢也不跳过），等待下一个触发点重试队首。
 * 调小上限不中断执行中任务：limit 每次调用都读最新值，只影响后续 gate。
 */
export function createTaskQueueCoordinator(deps: {
  store: TaskQueueStore;
  /** 上限 resolver（读主进程设置缓存）：逐次调用取最新值（调大即时生效）。 */
  limit: () => number;
  /**
   * 当前执行中的任务（占坑口径单一真相，ADR 0022）：从执行开始到执行
   * 结束占名额，等待审批/问答（waiting-user）期间不释放——由装配层的
   * 执行中判定给出，协调器只数个数。
   */
  executingTaskIds: () => readonly string[];
  /**
   * 开跑排队任务：启动成功（消息已进入任务）即 resolve；启动失败以异常
   * 抛回（条目保留，等待下一个触发点重试）。
   */
  start: (entry: QueuedTaskStart) => Promise<void>;
  /** 队列变更通知：queue 为变更后的完整快照（不含已开跑出队的条目）。 */
  onChange: (
    taskId: string,
    reason: TaskQueueChangeReason,
    queue: QueuedTaskStart[]
  ) => void;
}) {
  const { store, limit, executingTaskIds, start, onChange } = deps;
  /** 防重入：pump 进行中（await 开跑）时其余触发点直接返回，循环每轮重新判定名额。 */
  let pumping = false;

  function notify(taskId: string, reason: TaskQueueChangeReason): void {
    onChange(taskId, reason, store.list());
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const head = store.list()[0];
        if (head === undefined) return;
        if (executingTaskIds().length >= limit()) return;
        try {
          await start(head);
        } catch {
          // 开跑失败：队首条目保留（消息不丢、FIFO 不跳过），等待下一个
          // 触发点（下一次名额释放或上限调大）重试。
          return;
        }
        // 开跑成功才出队（崩溃重启不重发由持久层保证，与输入队列同构）。
        // 出队落库 / 通知失败（存储故障）与开跑失败是两种错误：消息已进入
        // 任务，吞错会让条目残留待下轮重复开跑同一首条——上抛由调用方
        // 记录处置，本轮 pump 就此终止。
        store.remove(head.taskId);
        notify(head.taskId, "dequeue");
      }
    } finally {
      pumping = false;
    }
  }

  return {
    /**
     * 发送闸门：有空位返回 "start"（调用方继续执行并占坑）；满员入队返回
     * "queued"（调用方本轮不再执行）。判定与调用方占坑须在同一同步段。
     */
    gate(taskId: string, input: TaskQueueEnqueueInput): "start" | "queued" {
      if (store.list().some((entry) => entry.taskId === taskId))
        return "queued";
      if (executingTaskIds().length < limit()) return "start";
      store.append({
        ...input,
        taskId,
        createdAt: new Date().toISOString(),
      });
      notify(taskId, "enqueue");
      return "queued";
    },
    /** 当前是否满员：内部消费路径（输入队列/排队开跑）撞满员时以此拒绝并保留条目。 */
    isFull(): boolean {
      return executingTaskIds().length >= limit();
    },
    /** 指定任务是否在排队（activity.queued 下发与闸门幂等共用）。 */
    isQueued(taskId: string): boolean {
      return store.list().some((entry) => entry.taskId === taskId);
    },
    /** 当前队列快照（按 position 升序）。 */
    snapshot(): QueuedTaskStart[] {
      return store.list();
    },
    /** 名额释放 / 上限调大后推进：严格 FIFO 开跑到名额用尽或队列清空。 */
    pump,
    /** 出队移除（中断排队/归档/项目移除清理）：在队返回 true 并推送通知。 */
    remove(taskId: string): boolean {
      if (!store.remove(taskId)) return false;
      notify(taskId, "remove");
      return true;
    },
  };
}

export type TaskQueueCoordinator = ReturnType<
  typeof createTaskQueueCoordinator
>;

/** 内存排队存储：票 02 的默认装配与单测假件；生产持久化由票 05 接入。 */
export function createMemoryTaskQueueStore(): TaskQueueStore {
  const rows: QueuedTaskStart[] = [];
  return {
    list() {
      return [...rows].sort((a, b) => a.position - b.position);
    },
    append(entry) {
      const position = rows.reduce(
        (max, item) => Math.max(max, item.position + 1),
        0
      );
      const saved = { ...entry, position };
      rows.push(saved);
      return saved;
    },
    remove(taskId) {
      const index = rows.findIndex((item) => item.taskId === taskId);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    },
    close() {},
  };
}
