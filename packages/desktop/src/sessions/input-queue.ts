import { randomUUID } from "node:crypto";

import type { ApprovalMode, ThinkingEffort } from "@codexlike/agent-core/node";

/**
 * 排队消息（GLOSSARY「排队消息」，票 01 / ADR 0013）：会话忙时用户提交的
 * 普通消息连同发送参数快照一起排队，会话空闲后由主进程按快照逐条发出。
 * 持久化形状见 spec「持久化形状」：顺序位置、消息文本、@引用、
 * Provider Profile、思考档位、审批模式、入队时间。
 */
export interface QueuedMessage {
  id: string;
  sessionId: string;
  /** 顺序位置：按入队顺序递增，消费从最小 position 开始。 */
  position: number;
  text: string;
  mentionPaths: string[];
  providerProfileId: string;
  thinkingEffort: ThinkingEffort;
  approvalMode: ApprovalMode;
  createdAt: string;
}

/** 入队输入：id / position / createdAt 由队列协调器分配。 */
export type QueueEnqueueInput = Omit<
  QueuedMessage,
  "id" | "sessionId" | "position" | "createdAt"
>;

/** 队列持久化接缝：生产用 SQLite（与会话消息同库，ADR 0013），测试注入内存实现。 */
export interface InputQueueStore {
  /** 指定会话的排队消息，按 position 升序。 */
  list(sessionId: string): QueuedMessage[];
  /** 追加一条（position 由 store 分配为当前最大 +1）。 */
  append(
    sessionId: string,
    entry: Omit<QueuedMessage, "sessionId" | "position">
  ): QueuedMessage;
  /** 移除一条；不存在返回 false。 */
  remove(sessionId: string, id: string): boolean;
  /** 清空指定会话的队列。 */
  clear(sessionId: string): void;
  /** 释放数据库句柄（宿主退出前调用；Windows 上未关闭会锁住库文件）。 */
  close(): void;
}

/** 队列变更原因：入队 / 出队发送（事件信封携带变更后快照）。 */
export type QueueChangeReason = "enqueue" | "dequeue";

/**
 * 每会话独立的输入队列协调器（票 01 主干）。
 * - enqueue：入队（含参数快照）；入队时若会话已空闲则立即触发消费。
 * - onIdle：会话执行结束（activity running=false）后调用，空闲且非空则
 *   从队首继续逐条消费（发一条、等其回复完成、再发下一条）。
 * 消费由注入的 dispatch 完成；启动失败时条目保留在队列（不丢），
 * 等待下一个触发点（下一次执行结束或下一次入队）。
 */
export function createSessionInputQueues(deps: {
  store: InputQueueStore;
  isBusy: (sessionId: string) => boolean;
  /**
   * 取队首发送：启动成功（消息已进入会话）即 resolve，此时回调 onSettled
   * 尚未发生；本轮回复结束（完成/出错/中断）时调用 onSettled 恰好一次。
   * 启动失败以异常抛回（onSettled 不会被调用）。
   */
  dispatch: (
    sessionId: string,
    entry: QueuedMessage,
    onSettled: () => void
  ) => Promise<void>;
  /** 队列变更通知（入队、出队发送），queue 为变更后的完整快照。 */
  onChange: (
    sessionId: string,
    reason: QueueChangeReason,
    queue: QueuedMessage[]
  ) => void;
}) {
  const { store, isBusy, dispatch, onChange } = deps;
  const pumping = new Set<string>();

  async function pump(sessionId: string): Promise<void> {
    if (pumping.has(sessionId)) return;
    pumping.add(sessionId);
    try {
      for (;;) {
        if (isBusy(sessionId)) return;
        const head = store.list(sessionId)[0];
        if (head === undefined) return;
        let releaseSettled!: () => void;
        const settled = new Promise<void>((resolve) => {
          releaseSettled = resolve;
        });
        try {
          await dispatch(sessionId, head, releaseSettled);
        } catch {
          // 启动失败：条目保留（消息不丢），等待下一个触发点。
          return;
        }
        // 消息已发出：从队列移除并在本轮流仍在进行时推送出队事件
        // （信封需要当前执行的 executionId，见 session-ipc 装配）。
        store.remove(sessionId, head.id);
        onChange(sessionId, "dequeue", store.list(sessionId));
        // 等本轮回复结束再取下一条（发一条、等完成、再发下一条）。
        await settled;
      }
    } finally {
      pumping.delete(sessionId);
    }
  }

  return {
    /** 会话忙时用户提交普通消息：入队（含参数快照）；空闲时立即触发消费。 */
    enqueue(sessionId: string, input: QueueEnqueueInput): QueuedMessage {
      const entry = store.append(sessionId, {
        ...input,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      onChange(sessionId, "enqueue", store.list(sessionId));
      void pump(sessionId);
      return entry;
    },
    /** 执行结束（activity running=false）后调用：空闲且非空则继续逐条消费。 */
    onIdle(sessionId: string): void {
      void pump(sessionId);
    },
    /** 当前队列快照（position 升序）。 */
    snapshot(sessionId: string): QueuedMessage[] {
      return store.list(sessionId);
    },
  };
}

export type SessionInputQueues = ReturnType<typeof createSessionInputQueues>;

/** 内存队列存储：不传 queueStore 的装配（现有单测）与临时会话使用；生产走 SQLite。 */
export function createMemoryInputQueueStore(): InputQueueStore {
  const rows = new Map<string, QueuedMessage[]>();
  return {
    list(sessionId) {
      return [...(rows.get(sessionId) ?? [])].sort(
        (a, b) => a.position - b.position
      );
    },
    append(sessionId, entry) {
      const current = rows.get(sessionId) ?? [];
      const position = current.reduce(
        (max, item) => Math.max(max, item.position + 1),
        0
      );
      const saved = { ...entry, sessionId, position };
      current.push(saved);
      rows.set(sessionId, current);
      return saved;
    },
    remove(sessionId, id) {
      const current = rows.get(sessionId) ?? [];
      const index = current.findIndex((item) => item.id === id);
      if (index === -1) return false;
      current.splice(index, 1);
      return true;
    },
    clear(sessionId) {
      rows.delete(sessionId);
    },
    close() {},
  };
}
