import { useEffect, useState } from "react";
import type { WorkspaceSharingTarget } from "@codexlike/desktop/ipc";

/**
 * 工作区共享检查（票02）：原 WorkspaceSharingNotice 横条的数据源，
 * 组件改为 toast 后订阅逻辑保留在此 hook，展示交由 toast 管理器同步。
 * 检查始终随 target 订阅，仅在风险或检查失败时产出提示内容。
 */
export function useWorkspaceSharing(target: WorkspaceSharingTarget | null): {
  /** 共享风险文案；无风险为 null */
  warning: string | null;
  /** 检查失败文案；检查正常为 null */
  error: string | null;
} {
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 无目标（未选任务也未开草稿）不检查；有目标按稳定 JSON 键订阅
  const targetKey = target === null ? null : JSON.stringify(target);
  useEffect(() => {
    if (targetKey === null) {
      setWarning(null);
      setError(null);
      return;
    }
    // 闭包内使用的稳定键（TS 窄化不跨函数，先落成新绑定）
    const key: string = targetKey;
    let active = true;
    let request = 0;
    setWarning(null);
    setError(null);
    async function refresh() {
      const generation = ++request;
      try {
        const view = await window.codexlike.tasks.workspaceSharing(
          JSON.parse(key)
        );
        if (active && generation === request) {
          setWarning(
            view.runningTasks.length > 0
              ? `共享文件风险：另有 ${view.runningTasks.length} 个任务正在同一实际目录执行或等待回应（${view.runningTasks
                  .map((item) => item.title)
                  .join(
                    "、"
                  )}）。修改会互相影响，可继续发送，也可先停止其他任务。`
              : null
          );
          setError(null);
        }
      } catch (failure) {
        if (active && generation === request) {
          setWarning(null);
          setError(
            `工作区检查失败：${failure instanceof Error ? failure.message : String(failure)}`
          );
        }
      }
    }
    void refresh();
    const unsubscribe = window.codexlike.onTaskEvent(({ event }) => {
      if (
        [
          "user-message",
          "assistant-done",
          "assistant-aborted",
          "error",
          "interaction-request",
          "interaction-resolved",
        ].includes(event.type)
      )
        void refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [targetKey]);
  return { warning, error };
}
