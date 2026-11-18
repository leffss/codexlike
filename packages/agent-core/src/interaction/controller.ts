import type { TaskPersistence } from "../task/persistence";
import type { TaskEvent } from "../task/types";
import type {
  InteractionRecord,
  InteractionRequest,
  QuestionAnswerSnapshot,
} from "./types";
import { parseInteractionResponse, questionSnapshot } from "./questions";

/** 审批与问答唯一 waiter 所有者；先持久化，再更新内存并通知，最后唤醒工具。 */
export function createInteractionController(options: {
  persistence: TaskPersistence;
  now(): string;
  emit(event: TaskEvent): void;
  waiting(waiting: boolean, persisted?: boolean): void;
  answered(snapshot: QuestionAnswerSnapshot): void;
  /** 所属任务实时授权；不参与冻结的审批模式/路径权限。 */
  autoApprove?(taskId: string): boolean;
  /** 仅在授权事务提交后更新任务内存并发布状态事件。 */
  autoApproved?(taskId: string): void;
}) {
  const waiters = new Map<
    string,
    {
      record: InteractionRecord;
      signal?: AbortSignal;
      resolve(record: InteractionRecord): void;
      dispose(): void;
    }
  >();
  function finish(
    id: string,
    record: InteractionRecord,
    snapshot?: QuestionAnswerSnapshot
  ): boolean {
    const waiter = waiters.get(id);
    if (!waiter) return false;
    if (!options.persistence.settleInteraction(record, snapshot)) return false;
    waiters.delete(id);
    try {
      waiter.dispose();
      if (snapshot) options.answered(snapshot);
      options.waiting(waiters.size > 0);
      options.emit({
        type: "interaction-resolved",
        interaction: structuredClone(record),
      });
    } finally {
      // 结算已经提交：后置状态写入/通知失败仍须唤醒，不能遗失 waiter。
      waiter.resolve(record);
    }
    return true;
  }
  function cancel(id: string, reason: string): boolean {
    const waiter = waiters.get(id);
    if (!waiter) return true;
    return finish(id, {
      ...waiter.record,
      status: "cancelled",
      resolvedAt: options.now(),
      cancelReason: reason,
    });
  }
  return {
    get pending() {
      return [...waiters.values()].map((waiter) =>
        structuredClone(waiter.record)
      );
    },
    request(
      request: InteractionRequest,
      signal?: AbortSignal
    ): Promise<InteractionRecord> {
      const record: InteractionRecord = {
        request: structuredClone(request),
        status: "pending",
        response: null,
        resolvedAt: null,
        cancelReason: null,
      };
      options.persistence.insertInteraction(record);
      // 审批门读取与入队之间可能已获得授权；入队边界再次检查，不自动回答问答。
      // 反馈2留痕：自动批准放行的请求同样落库（autoApproved 标记区分用户手动授权），
      // 经 interaction-resolved 事件进消息流展示。
      if (
        request.kind === "approval" &&
        !signal?.aborted &&
        options.autoApprove?.(request.taskId)
      ) {
        const resolved: InteractionRecord = {
          ...record,
          status: "resolved",
          resolvedAt: options.now(),
          response: { kind: "approval", decision: "approve", scope: "task" },
          autoApproved: true,
        };
        if (!options.persistence.settleInteraction(resolved))
          throw new Error("审批请求已失效，未执行工具");
        options.emit({
          type: "interaction-resolved",
          interaction: structuredClone(resolved),
        });
        return Promise.resolve(resolved);
      }
      return new Promise((resolve) => {
        const onAbort = () => {
          let reason = "本轮已中断";
          try {
            if (cancel(request.id, reason)) return;
            reason += "（取消记录未能结算）";
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            reason += `（取消记录或通知失败：${message}）`;
          }
          // abort 是不可重试的终止信号，不同于 respond 保存失败后继续等待。
          // EventTarget listener 不允许向外抛错；只结束运行时等待，绝不授权。
          // 保存失败的记录仍是 pending，留给任务 finally/重启收尾补结算。
          resolve({
            ...record,
            status: "cancelled",
            response: null,
            resolvedAt: null,
            cancelReason: reason,
          });
        };
        waiters.set(request.id, {
          record,
          signal,
          resolve,
          dispose: () => signal?.removeEventListener("abort", onAbort),
        });
        options.waiting(true);
        options.emit({
          type: "interaction-request",
          interaction: structuredClone(record),
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
    respond(id: string, input: unknown): boolean {
      const waiter = waiters.get(id);
      if (!waiter || waiter.signal?.aborted) return false;
      const response = parseInteractionResponse(waiter.record.request, input);
      if (
        response.kind === "approval" &&
        response.decision === "approve" &&
        response.scope === "task"
      ) {
        const taskId = waiter.record.request.taskId;
        const records = options.persistence.approveTaskInteraction(
          taskId,
          id,
          options.now()
        );
        if (!records) return false;
        // 同步事务返回后不再 await：全部更新内存，再通知，最后一起唤醒。
        const completed = records.flatMap((record) => {
          const pending = waiters.get(record.request.id);
          if (!pending || pending.record.request.taskId !== taskId) return [];
          waiters.delete(record.request.id);
          return [{ record, waiter: pending }];
        });
        try {
          for (const { waiter } of completed) waiter.dispose();
          options.autoApproved?.(taskId);
          options.waiting(waiters.size > 0, true);
          for (const { record } of completed)
            options.emit({
              type: "interaction-resolved",
              interaction: structuredClone(record),
            });
        } finally {
          // 一个通知失败不能阻断同事务内其余已获准调用的唤醒。
          for (const { record, waiter } of completed) waiter.resolve(record);
        }
        return true;
      }
      return finish(
        id,
        {
          ...waiter.record,
          status: "resolved",
          response,
          resolvedAt: options.now(),
        },
        questionSnapshot(waiter.record.request, response)
      );
    },
    cancel(reason: string) {
      const errors: unknown[] = [];
      for (const id of [...waiters.keys()]) {
        try {
          cancel(id, reason);
        } catch (error) {
          // 单条结算或通知失败不能阻止其余请求收尾；失败结算仍保留 waiter。
          errors.push(error);
        }
      }
      if (errors.length > 0) throw errors[0];
    },
  };
}
