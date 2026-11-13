import { useEffect, useState } from "react";
import type { WorkspaceMode } from "@codexlike/agent-core";
import type {
  WorkspaceSharingTarget,
  WorkspaceSharingView,
} from "@codexlike/desktop/ipc";

/** 项目草稿的工作区模式选择：首次发送后不再提供切换入口。 */
export function WorkspaceModeSelector(props: {
  mode: WorkspaceMode;
  busy: boolean;
  onModeChange: (mode: WorkspaceMode) => void;
}) {
  return (
    <label className="flex flex-wrap items-center gap-2">
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
  );
}

/** 共享检查始终订阅，仅在风险或检查失败时占用提示空间。 */
export function WorkspaceSharingNotice(props: {
  target: WorkspaceSharingTarget;
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
        const view = await window.codexlike.tasks.workspaceSharing(
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

  if (!sharing?.runningSessions.length && !error) return null;

  return (
    <div
      data-testid="workspace-sharing-notice"
      className="shrink-0 border-t border-line px-4 py-2 text-xs text-fg-muted"
    >
      {sharing && sharing.runningSessions.length > 0 && (
        <p
          data-testid="workspace-sharing-warning"
          role="status"
          className="text-warn-fg"
        >
          共享文件风险：另有 {sharing.runningSessions.length}{" "}
          个会话正在同一实际目录执行或等待回应（
          {sharing.runningSessions.map((item) => item.title).join("、")}
          ）。修改会互相影响，可继续发送，也可先停止其他任务。
        </p>
      )}
      {error && (
        <p
          data-testid="workspace-sharing-error"
          className="text-danger-fg"
          role="status"
        >
          {error}
        </p>
      )}
    </div>
  );
}
