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
  /**
   * 存活终端会话数（ADR 0033 票07）：confirming 阶段由 terminalSessionCount
   * 注入读取（无存活或未注入时缺省）——渲染端确认卡据此渲染
   * 「N 个终端会话将关闭」提示行；其余阶段不携带（终局路径无需再提示）。
   */
  terminalSessions?: number;
}

/** 真正退出的唯一协调入口。确认前不停止；保存屏障成功后才中断并等待收尾。 */
export function createApplicationExit(options: {
  runtime: TaskExitRuntime;
  publish(state: ExitState): void;
  finish(): void;
  /**
   * 存活终端会话数 resolver（ADR 0033 票07）：request 时刻读取一次——
   * main.ts 注入 aliveSessionCount（终端存活已并入 hasWork 判定，注入
   * 则确认卡必带数据）。未注入维持既有形状（可选装配）。
   */
  terminalSessionCount?: () => number;
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
      // 确认状态一次性成型（单次 publish）：有未完成工作时进入 confirming
      // 并携带存活终端计数（>0 才带——0 视为无终端参与，渲染端不出现终端
      // 提示行）；无工作直接 flushing。
      const work = options.runtime.hasWork();
      const terminalSessions = work
        ? (options.terminalSessionCount?.() ?? 0)
        : 0;
      current = {
        id: randomUUID(),
        phase: work ? "confirming" : "flushing",
        ...(terminalSessions > 0 ? { terminalSessions } : {}),
      };
      options.publish(current);
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
