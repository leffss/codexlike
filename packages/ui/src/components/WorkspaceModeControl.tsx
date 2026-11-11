import { useEffect, useState } from "react";
import type { WorkspaceMode } from "@codexlike/agent-core";
import type {
  WorkspaceSharingTarget,
  WorkspaceSharingView,
} from "@codexlike/desktop/ipc";

/** 工作区草稿选择与共享事实提示：正式会话不提供切换入口。 */
export function WorkspaceModeControl(props: {
  target: WorkspaceSharingTarget;
  mode: WorkspaceMode;
  draft: boolean;
  busy: boolean;
  onModeChange: (mode: WorkspaceMode) => void;
}) {
  const [sharing, setSharing] = useState<WorkspaceSharingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetKey = JSON.stringify(props.target);
  useEffect(() => {
    let active = true;
    let request = 0;
    setSharing(null);
    setError(null);
    async function refresh() {
      const generation = ++request;
      try {
        const view = await window.codexlike.sessions.workspaceSharing(
          JSON.parse(targetKey)
        );
        if (active && generation === request) {
          setSharing(view);
          setError(null);
        }
      } catch (failure) {
        if (active && generation === request) {
          setSharing(null);
          setError(
            `工作区检查失败：${failure instanceof Error ? failure.message : String(failure)}`
          );
        }
      }
    }
    void refresh();
    const unsubscribe = window.codexlike.onSessionEvent(({ event }) => {
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

  return (
    <div className="border-t border-line px-4 py-2 text-xs text-fg-muted">
      {props.draft &&
      "projectId" in props.target &&
      props.target.projectId !== null ? (
        <label className="flex items-center gap-2">
          工作区模式
          <select
            data-testid="draft-workspace-mode"
            aria-label="工作区模式"
            className="rounded border border-line bg-surface px-2 py-1"
            disabled={props.busy}
            value={props.mode}
            onChange={(event) =>
              props.onModeChange(
                event.target.value === "worktree" ? "worktree" : "local"
              )
            }
          >
            <option value="local">本地 · 项目目录</option>
            <option value="worktree">Worktree · 独立目录与分支</option>
          </select>
          <span>
            {props.mode === "worktree"
              ? "首次发送时创建隔离副本"
              : "首次发送才创建会话"}
          </span>
        </label>
      ) : (
        <span data-testid="workspace-mode">
          {props.mode === "worktree" ? "Worktree" : "本地"} ·{" "}
          {props.draft ? "首次发送才创建会话" : "工作区已固定"}
        </span>
      )}
      {sharing && sharing.runningSessions.length > 0 && (
        <p
          data-testid="workspace-sharing-warning"
          role="status"
          className="mt-2 text-warn-fg"
        >
          共享文件风险：另有 {sharing.runningSessions.length}{" "}
          个会话正在同一实际目录执行或等待回应（
          {sharing.runningSessions.map((item) => item.title).join("、")}
          ）。修改会互相影响，可继续发送，也可先停止其他任务。
        </p>
      )}
      {error && (
        <p className="mt-2 text-danger-fg" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
