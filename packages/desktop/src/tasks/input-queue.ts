import { randomUUID } from "node:crypto";

import type { ApprovalMode, ThinkingEffort } from "@codexlike/agent-core/node";

/**
 * 排队消息（GLOSSARY「排队消息」，票 01 / ADR 0013）：任务忙时用户提交的
 * 普通消息连同发送参数快照一起排队，任务空闲后由主进程按快照逐条发出。
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

/** 队列持久化接缝：生产用 SQLite（与任务消息同库，ADR 0013），测试注入内存实现。 */
export interface InputQueueStore {
  /** 指定任务的排队消息，按 position 升序。 */
  list(sessionId: string): QueuedMessage[];
  /** 追加一条（position 由 store 分配为当前最大 +1）。 */
  append(
    sessionId: string,
    entry: Omit<QueuedMessage, "sessionId" | "position">
  ): QueuedMessage;
  /** 移除一条；不存在返回 false。 */
  remove(sessionId: string, id: string): boolean;
  /** 原地更新内容（顺序与参数快照不变）；条目不存在返回 null。 */
  update(
    sessionId: string,
    id: string,
    patch: { text: string; mentionPaths: string[] }
  ): QueuedMessage | null;
  /**
   * 按给定子集顺序重排：子集当前占用的 position 集合内重新分配，
   * 子集外的条目（如正在发出未出队的队首）位置不动。
   * 清单与队列子集不符（未知/重复）抛错，顺序不变。
   */
  reorder(sessionId: string, orderedIds: string[]): void;
  /** 清空指定任务的队列。 */
  clear(sessionId: string): void;
  /** 队列暂停标志（票 02）：随队列持久化，重启后保持暂停（启动扫描见票 04）。 */
  isPaused(sessionId: string): boolean;
  /** 置/清队列暂停标志。 */
  setPaused(sessionId: string, paused: boolean): void;
  /** 释放数据库句柄（宿主退出前调用；Windows 上未关闭会锁住库文件）。 */
  close(): void;
}

/** 队列变更原因：入队 / 出队发送 / 置暂停 / 恢复 / 清空 / 单条删除 / 原地编辑 / 重排 / 正在发出状态变化。 */
export type QueueChangeReason =
  | "enqueue"
  | "dequeue"
  | "pause"
  | "resume"
  | "clear"
  | "remove"
  | "update"
  | "reorder"
  | "sending";

/**
 * 每任务独立的输入队列协调器（票 01 主干）。
 * - enqueue：入队（含参数快照）；入队时若任务已空闲则立即触发消费。
 * - onIdle：任务执行结束（activity running=false）后调用，空闲且非空则
 *   从队首继续逐条消费（发一条、等其回复完成、再发下一条）。
 * 消费由注入的 dispatch 完成；启动失败时条目保留在队列（不丢），
 * 等待下一个触发点（下一次执行结束或下一次入队）。
 */
/**
 * 重排清单校验（review 重构共享）：orderedIds 必须无重复、且每个 id 都在
 * 当前队列条目中（子集语义——协调器排除正在发出的队首后要求恰好全量排列，
 * store 按子集重排 position）。报错文案单点：协调器与两个 store 不再各验一遍。
 */
export function assertReorderableList(
  current: readonly QueuedMessage[],
  orderedIds: readonly string[]
): void {
  if (new Set(orderedIds).size !== orderedIds.length)
    throw new Error("重排清单与当前排队条目不一致，请刷新后重试");
  const known = new Set(current.map((entry) => entry.id));
  if (orderedIds.some((id) => !known.has(id)))
    throw new Error("重排清单与当前排队条目不一致，请刷新后重试");
}

export function createTaskInputQueues(deps: {
  store: InputQueueStore;
  isBusy: (sessionId: string) => boolean;
  /**
   * 取队首发送：启动成功（消息已进入任务）即 resolve，此时回调 onSettled
   * 尚未发生；本轮回复结束（完成/出错/中断）时调用 onSettled 恰好一次。
   * 启动失败以异常抛回（onSettled 不会被调用）。
   */
  dispatch: (
    sessionId: string,
    entry: QueuedMessage,
    onSettled: () => void
  ) => Promise<void>;
  /** 队列变更通知（入队、出队发送、暂停/恢复/清空），queue 为变更后的完整快照。 */
  onChange: (
    sessionId: string,
    reason: QueueChangeReason,
    queue: QueuedMessage[],
    /** 变更后的队列暂停标志（票 02）：渲染层据此区分暂停态与正常排队。 */
    paused: boolean,
    /** 正在发出的条目 id（票 03）：已取出发送、尚未出队；null 表示无。 */
    sendingId: string | null
  ) => void;
}) {
  const { store, isBusy, dispatch, onChange } = deps;
  const pumping = new Set<string>();
  /** 插话（票 02）在途标记：暂停期间直发的新消息已开始执行，其回复结束时自动恢复消费。 */
  const interjections = new Set<string>();
  /**
   * 正在发出的条目（票 03）：pump 取队首发送前同步登记（主进程单一真相，
   * 不靠 UI disabled）——await 期间该条目不可编辑/删除/重排；发送启动完成
   * 出队或启动失败解锁。每任务同时至多一条（消费逐条进行）。
   */
  const sendingIds = new Map<string, string>();
  /**
   * 本轮已取出发送、回复尚未结束的条目（票 03，spec 用户故事 25）：已从
   * 持久层移除（崩溃重启不会重发），但保留在队列视图中以「正在发出」区别
   * 显示并锁定，本轮回复结束（完成/出错/中断）后从视图移除。内存态，
   * 重启后自然消失（条目已出队落库）。
   */
  const inflight = new Map<string, QueuedMessage>();

  /** 队列视图：正在发出的条目置顶（锁定显示）+ 仍在排队的条目。 */
  function queueView(sessionId: string): QueuedMessage[] {
    const sending = inflight.get(sessionId);
    const rest = store.list(sessionId);
    return sending === undefined ? rest : [sending, ...rest];
  }

  /** 正在发出的条目 id：取出发送中，或本轮已发出、回复未结束（inflight）。 */
  function currentSendingId(sessionId: string): string | null {
    return sendingIds.get(sessionId) ?? inflight.get(sessionId)?.id ?? null;
  }

  function notify(sessionId: string, reason: QueueChangeReason): void {
    onChange(
      sessionId,
      reason,
      queueView(sessionId),
      store.isPaused(sessionId),
      currentSendingId(sessionId)
    );
  }

  async function pump(sessionId: string): Promise<void> {
    if (pumping.has(sessionId)) return;
    pumping.add(sessionId);
    try {
      for (;;) {
        if (isBusy(sessionId)) return;
        // 队列暂停（票 02）：不取队首，等待手动恢复或插话回复结束
        if (store.isPaused(sessionId)) return;
        const head = store.list(sessionId)[0];
        if (head === undefined) return;
        // 票 03：取出发送即同步锁定（主进程强制）——dispatch 内部的 await
        // 窗口期里，迟到的编辑/删除/重排都会被拒，已发出的条目不能被改写。
        sendingIds.set(sessionId, head.id);
        notify(sessionId, "sending");
        let releaseSettled!: () => void;
        const settled = new Promise<void>((resolve) => {
          releaseSettled = resolve;
        });
        try {
          await dispatch(sessionId, head, releaseSettled);
        } catch {
          // 启动失败：解锁并保留条目（消息不丢），等待下一个触发点。
          sendingIds.delete(sessionId);
          notify(sessionId, "sending");
          return;
        }
        // 消息已发出：立即从持久层移除（崩溃重启不重发），转入 inflight
        // 视图（正在发出、锁定显示）直到本轮回复结束。
        store.remove(sessionId, head.id);
        sendingIds.delete(sessionId);
        inflight.set(sessionId, head);
        notify(sessionId, "dequeue");
        // 等本轮回复结束再取下一条（发一条、等完成、再发下一条）。
        await settled;
        if (inflight.get(sessionId) === head) {
          inflight.delete(sessionId);
          notify(sessionId, "sending");
        }
      }
    } finally {
      pumping.delete(sessionId);
    }
  }

  return {
    /** 任务忙时用户提交普通消息：入队（含参数快照）；空闲时立即触发消费。 */
    enqueue(sessionId: string, input: QueueEnqueueInput): QueuedMessage {
      const entry = store.append(sessionId, {
        ...input,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      notify(sessionId, "enqueue");
      void pump(sessionId);
      return entry;
    },
    /** 执行结束（activity running=false）后调用：空闲且非空则继续逐条消费。 */
    onIdle(sessionId: string): void {
      // 插话完成（票 02）：暂停期间直发的新消息回复结束（完成/出错/中断），
      // 自动清除暂停标志并恢复队列消费——暂停只是插话窗口，不是永久冻结。
      if (interjections.delete(sessionId) && store.isPaused(sessionId)) {
        store.setPaused(sessionId, false);
        notify(sessionId, "resume");
      }
      void pump(sessionId);
    },
    /** 删除只作用于仍在排队的本任务条目，不容许跨任务操作。 */
    remove(sessionId: string, id: string): void {
      if (sendingIds.get(sessionId) === id)
        throw new Error("该消息正在发出，不能删除");
      if (!store.remove(sessionId, id))
        throw new Error("排队消息不存在或已发出，请刷新队列");
      notify(sessionId, "remove");
    },
    /**
     * 原地编辑（票 03）：内容更新、位置与参数快照不变，顺序不受影响。
     * expectedText 是取回编辑时的原文（CAS）：条目已被其他窗口修改则拒绝，
     * 由用户重新载入；正在发出的条目拒绝迟到保存。
     */
    update(
      sessionId: string,
      id: string,
      patch: { text: string; mentionPaths: string[] },
      expectedText: string
    ): QueuedMessage {
      if (sendingIds.get(sessionId) === id)
        throw new Error("该消息正在发出，不能编辑");
      const current = store.list(sessionId).find((entry) => entry.id === id);
      if (current === undefined)
        throw new Error("排队消息不存在或已发出，请刷新队列");
      if (current.text !== expectedText)
        throw new Error("该消息已被其他窗口修改，请重新点击载入编辑");
      const updated = store.update(sessionId, id, patch);
      if (updated === null)
        throw new Error("排队消息不存在或已发出，请刷新队列");
      notify(sessionId, "update");
      return updated;
    },
    /**
     * 重排（票 03）：orderedIds 必须恰好是本任务仍在排队（不含正在发出）
     * 的全部条目 id 的一次排列——清单不完整或夹带未知 id 一律拒绝，
     * 异步入队/删除交错时不会遗漏或复活条目；合法则在排队子集内重排。
     * 权威校验在协调器（review 重构）：无重复/未知走共享校验，完整性单点补齐。
     */
    reorder(sessionId: string, orderedIds: string[]): void {
      const sendingId = sendingIds.get(sessionId);
      if (sendingId !== undefined && orderedIds.includes(sendingId))
        throw new Error("正在发出的消息不能重排");
      const current = store.list(sessionId);
      assertReorderableList(current, orderedIds);
      const queuedCount = current.filter(
        (entry) => entry.id !== sendingId
      ).length;
      if (orderedIds.length !== queuedCount)
        throw new Error("重排清单与当前排队条目不一致，请刷新后重试");
      store.reorder(sessionId, orderedIds);
      notify(sessionId, "reorder");
    },
    /** 正在发出的条目 id（票 03）：取出发送中或本轮已发出未结束；null 表示无。 */
    sendingItem(sessionId: string): string | null {
      return currentSendingId(sessionId);
    },
    /** 当前队列快照（正在发出的条目置顶 + 仍按 position 升序的排队条目）。 */
    snapshot(sessionId: string): QueuedMessage[] {
      return queueView(sessionId);
    },
    /** 队列暂停标志（票 02）。 */
    isPaused(sessionId: string): boolean {
      return store.isPaused(sessionId);
    },
    /**
     * 停止路径（票 02）：排队消息存在时置暂停——当前回复按现有中断行为终止，
     * 队列原样保留、消费循环不取队首。队列非空才生效，幂等。
     */
    pause(sessionId: string): void {
      if (store.isPaused(sessionId)) return;
      if (store.list(sessionId).length === 0) return;
      store.setPaused(sessionId, true);
      notify(sessionId, "pause");
    },
    /**
     * 手动恢复（票 02）：清暂停标志并立即从队首继续逐条消费；未暂停时幂等。
     */
    resume(sessionId: string): void {
      if (!store.isPaused(sessionId)) return;
      store.setPaused(sessionId, false);
      notify(sessionId, "resume");
      void pump(sessionId);
    },
    /**
     * 清空（票 02）：作废删除全部排队消息并清暂停标志，无残留；
     * 之后的任何消费触发点都无事可做。
     */
    clearQueue(sessionId: string): void {
      store.clear(sessionId);
      store.setPaused(sessionId, false);
      notify(sessionId, "clear");
    },
    /**
     * 插话登记（票 02）：暂停期间的直发消息已开始执行（任务空闲走现有直发
     * 路径），其回复结束时经 onIdle 自动恢复消费。幂等。
     */
    beginInterjection(sessionId: string): void {
      interjections.add(sessionId);
    },
  };
}

export type TaskInputQueues = ReturnType<typeof createTaskInputQueues>;

/** 内存队列存储：不传 queueStore 的装配（现有单测）与临时任务使用；生产走 SQLite。 */
export function createMemoryInputQueueStore(): InputQueueStore {
  const rows = new Map<string, QueuedMessage[]>();
  const paused = new Set<string>();
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
    update(sessionId, id, patch) {
      const current = rows.get(sessionId) ?? [];
      const index = current.findIndex((item) => item.id === id);
      if (index === -1) return null;
      const saved = { ...current[index]!, ...patch };
      current[index] = saved;
      return saved;
    },
    reorder(sessionId, orderedIds) {
      const current = rows.get(sessionId) ?? [];
      // 无重复/未知校验走共享函数（review 重构）；完整性由协调器权威把关
      assertReorderableList(current, orderedIds);
      const idSet = new Set(orderedIds);
      const members = current.filter((item) => idSet.has(item.id));
      // 子集占用的 position 集合内重新分配，子集外条目（如正在发出的队首）不动
      const positions = members
        .map((item) => item.position)
        .sort((a, b) => a - b);
      const byId = new Map(members.map((item) => [item.id, item]));
      orderedIds.forEach((id, index) => {
        byId.get(id)!.position = positions[index]!;
      });
    },
    clear(sessionId) {
      rows.delete(sessionId);
    },
    isPaused: (sessionId) => paused.has(sessionId),
    setPaused(sessionId, value) {
      if (value) paused.add(sessionId);
      else paused.delete(sessionId);
    },
    close() {},
  };
}
