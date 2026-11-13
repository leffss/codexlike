import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ProjectRecord } from "@codexlike/agent-core";
import type { ProjectRemoval, TaskListItem } from "@codexlike/desktop/ipc";

const button =
  "rounded border border-line px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50";

/** 选择与确认只表达用户意图，活动及目录约束仍由宿主在实际写入点复查。 */
export function MembershipDialog(props: {
  task: TaskListItem;
  projects: ProjectRecord[];
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const sessionId = props.task.id;
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement;
    const taskTarget = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-session-select]")
      ).find((element) => element.dataset.sessionId === sessionId);
    const returnTarget =
      previous instanceof HTMLElement &&
      previous !== document.body &&
      !previous.closest("[role='menu']")
        ? previous
        : taskTarget();
    (
      dialog.querySelector<HTMLElement>(
        "select:not(:disabled), button:not(:disabled)"
      ) ?? dialog
    ).focus({ preventScroll: true });
    return () => {
      // 等卸载及可能的新对话框聚焦完成，只接管仍空缺的焦点。
      queueMicrotask(() => {
        const active = document.activeElement;
        if (
          active !== document.body &&
          active?.isConnected &&
          !dialog.contains(active)
        )
          return;
        if (document.querySelector("[role='dialog'][aria-modal='true']"))
          return;
        const target = returnTarget?.isConnected
          ? returnTarget
          : (taskTarget() ??
            document.querySelector<HTMLElement>("[data-testid='new-session']"));
        target?.focus({ preventScroll: true });
      });
    };
  }, [sessionId]);
  const movingOut = props.task.projectId !== null;
  const [target, setTarget] = useState(props.projects[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) props.onClose();
    } else if (event.key === "Tab") {
      const targets = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          "select:not(:disabled), button:not(:disabled)"
        )
      );
      const index = targets.indexOf(document.activeElement as HTMLElement);
      if (
        !targets.length ||
        index < 0 ||
        (event.shiftKey ? index === 0 : index === targets.length - 1)
      ) {
        event.preventDefault();
        (event.shiftKey ? targets.at(-1) : targets[0])?.focus();
        if (!targets.length) event.currentTarget.focus();
      }
    }
  }
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (busy) dialog.focus({ preventScroll: true });
    else if (document.activeElement === dialog) {
      dialog
        .querySelector<HTMLElement>(
          "select:not(:disabled), button:not(:disabled)"
        )
        ?.focus({ preventScroll: true });
    }
  }, [busy]);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await window.codexlike.tasks.setProject(
        props.task.id,
        movingOut ? null : target
      );
      await props.onChanged();
      props.onClose();
    } catch (error) {
      setError(
        `调整归属失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <section
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="调整会话归属"
        data-testid="membership-dialog"
        className="w-[440px] rounded-lg border border-line bg-surface p-5 text-fg shadow-xl"
      >
        <h2 className="mb-3 font-medium">
          {movingOut ? "移出项目" : "移入项目"} · {props.task.title}
        </h2>
        <p className="mb-3 text-sm text-fg-muted">
          只调整项目归属，不改变工作区、分支、历史或会话设置。
        </p>
        {!movingOut && (
          <>
            <p className="mb-2 text-xs text-fg-muted">
              {props.task.workspaceMode === "worktree"
                ? "Worktree 会话只能移回来源项目。"
                : "只能移入与实际工作区相同目录的项目。"}
            </p>
            <select
              data-testid="membership-target"
              aria-label="目标项目"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              disabled={busy}
              className="mb-3 w-full rounded border border-line bg-surface p-2 text-sm"
            >
              {props.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {!props.projects.length && (
              <p className="text-sm text-fg-muted">请先添加对应目录的项目。</p>
            )}
          </>
        )}
        {error && (
          <p
            role="alert"
            data-testid="membership-error"
            className="my-3 text-sm text-warn-fg"
          >
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="membership-cancel"
            disabled={busy}
            className={button}
            onClick={props.onClose}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="membership-confirm"
            disabled={busy || (!movingOut && !target)}
            className={button}
            onClick={() => void confirm()}
          >
            {busy ? "处理中…" : movingOut ? "移出为独立会话" : "确认移入"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ProjectRemovalDialog(props: {
  project: ProjectRecord;
  memberCount: number;
  onClose: () => void;
  onRemoved: (result: ProjectRemoval) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await window.codexlike.projects.remove(
        props.project.id,
        true
      );
      if (result) await props.onRemoved(result);
      props.onClose();
    } catch (error) {
      setError(
        `移除项目失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="移除项目确认"
        data-testid="project-removal-dialog"
        className="w-[460px] rounded-lg border border-line bg-surface p-5 text-fg shadow-xl"
      >
        <h2 className="mb-3 font-medium">移除项目「{props.project.name}」？</h2>
        <p className="mb-2 text-sm">
          将移除项目及其全部 {props.memberCount}{" "}
          个所属会话记录（包含归档历史），并清理相关草稿。此操作不可撤销。
        </p>
        <p className="mb-2 text-sm text-fg-muted">
          项目目录、Worktree 和全部磁盘文件均保留。同目录的独立会话及已移出的
          Worktree 会话不会被移除。
        </p>
        <p className="text-xs text-fg-muted">
          如果所属会话正在执行或等待回应，请先明确停止再整理。
        </p>
        {error && (
          <p
            role="alert"
            data-testid="project-removal-error"
            className="my-3 text-sm text-warn-fg"
          >
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="project-removal-cancel"
            disabled={busy}
            className={button}
            onClick={props.onClose}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="project-removal-confirm"
            disabled={busy}
            className={button}
            onClick={() => void confirm()}
          >
            {busy ? "处理中…" : "确认移除记录"}
          </button>
        </div>
      </section>
    </div>
  );
}
