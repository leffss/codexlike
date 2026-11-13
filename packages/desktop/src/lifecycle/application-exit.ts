import { randomUUID } from "node:crypto";

export interface TaskExitRuntime {
  hasWork(): boolean;
  freeze(): void;
  thaw(): void;
  stopAndDrain(): Promise<void>;
}
export interface ExitState {
  id: string;
  phase: "idle" | "confirming" | "flushing" | "stopping" | "ready" | "error";
  error?: string;
}

/** 真正退出的唯一协调入口。确认前不停止；保存屏障成功后才中断并等待收尾。 */
export function createApplicationExit(options: {
  runtime: TaskExitRuntime;
  publish(state: ExitState): void;
  finish(): void;
}) {
  let current: ExitState = { id: "", phase: "idle" };
  function set(phase: ExitState["phase"], error?: string) {
    current = { id: current.id, phase, ...(error ? { error } : {}) };
    options.publish(current);
  }
  return {
    state: () => ({ ...current }),
    request() {
      if (current.phase !== "idle" && current.phase !== "error") return;
      options.runtime.freeze();
      current = { id: randomUUID(), phase: "idle" };
      set(options.runtime.hasWork() ? "confirming" : "flushing");
    },
    answer(id: string, confirmed: boolean) {
      if (id !== current.id || current.phase !== "confirming") return;
      if (confirmed) set("flushing");
      else {
        options.runtime.thaw();
        set("idle");
      }
    },
    async flushed(id: string, error?: string) {
      if (id !== current.id || current.phase !== "flushing") return;
      if (error) {
        options.runtime.thaw();
        set("error", `保存工作现场失败，未退出：${error}`);
        return;
      }
      set("stopping");
      try {
        await options.runtime.stopAndDrain();
        set("ready");
        options.finish();
      } catch (error) {
        options.runtime.thaw();
        set(
          "error",
          `退出收尾失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  };
}
