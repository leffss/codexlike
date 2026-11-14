import type { WorkspaceMode } from "@codexlike/agent-core";

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
          : "首次发送才创建任务"}
      </span>
    </label>
  );
}
