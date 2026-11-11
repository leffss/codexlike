/** 单消费者事件缓冲：等待工具/子代理 Promise 期间仍实时转发交互，避免轮末才通知。 */
export function createEventBuffer<T>() {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  return {
    push(event: T) {
      queue.push(event);
      wake?.();
    },
    drain(): T[] {
      return queue.splice(0);
    },
    async *during<R>(promise: Promise<R>): AsyncGenerator<T, R> {
      let settled = false;
      let result!: R;
      let failed = false;
      let failure: unknown;
      void promise.then(
        (value) => {
          result = value;
          settled = true;
          wake?.();
        },
        (error) => {
          failed = true;
          failure = error;
          settled = true;
          wake?.();
        }
      );
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (settled) {
          if (failed) throw failure;
          return result;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}
