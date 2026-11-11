import type { SessionPersistence } from "../session/persistence";
import type { SessionEvent } from "../session/types";
import type {
  InteractionRecord,
  InteractionRequest,
  QuestionAnswerSnapshot,
} from "./types";
import { parseInteractionResponse, questionSnapshot } from "./questions";

/** 审批与问答唯一 waiter 所有者；先持久化，再更新内存并通知，最后唤醒工具。 */
export function createInteractionController(options: {
  persistence: SessionPersistence;
  now(): string;
  emit(event: SessionEvent): void;
  waiting(waiting: boolean): void;
  answered(snapshot: QuestionAnswerSnapshot): void;
}) {
  const waiters = new Map<
    string,
    {
      record: InteractionRecord;
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
    waiter.dispose();
    if (snapshot) options.answered(snapshot);
    options.waiting(waiters.size > 0);
    options.emit({
      type: "interaction-resolved",
      interaction: structuredClone(record),
    });
    waiter.resolve(record);
    return true;
  }
  function cancel(id: string, reason: string) {
    const waiter = waiters.get(id);
    if (waiter)
      finish(id, {
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
      return new Promise((resolve) => {
        const onAbort = () => cancel(request.id, "本轮已中断");
        waiters.set(request.id, {
          record,
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
      if (!waiter) return false;
      const response = parseInteractionResponse(waiter.record.request, input);
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
      for (const id of [...waiters.keys()]) cancel(id, reason);
    },
  };
}
