/**
 * 中断注册表（工单 06）：主进程为每条运行中的消息流登记 AbortController。
 * tasks:send 启动流时 begin，流结束（完成/出错/中断）时 end；
 * 停止按钮经 IPC tasks:interrupt 调用 interrupt，AbortController 贯穿
 * agent-core 的流式输出（streamText abortSignal）与工具执行（子进程树终止）。
 */
export interface InterruptRegistry {
  /** 任务的一条消息流启动：返回登记的 AbortController（signal 传给 sendMessage） */
  begin(taskId: string): AbortController;
  /** 流结束：注销登记。带 controller 参数——迟到的旧流 finally 不清掉新流的登记 */
  end(taskId: string, controller: AbortController): void;
  /** 用户点停止：有活跃流则 abort 并返回 true；空闲任务返回 false（幂等） */
  interrupt(taskId: string): boolean;
}

export function createInterruptRegistry(): InterruptRegistry {
  const active = new Map<string, AbortController>();

  return {
    begin(taskId) {
      const controller = new AbortController();
      active.set(taskId, controller);
      return controller;
    },

    end(taskId, controller) {
      if (active.get(taskId) === controller) {
        active.delete(taskId);
      }
    },

    interrupt(taskId) {
      const controller = active.get(taskId);
      if (controller === undefined) {
        return false;
      }
      controller.abort();
      return true;
    },
  };
}
