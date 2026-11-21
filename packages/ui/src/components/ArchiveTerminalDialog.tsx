import { useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";

/**
 * 归档带存活终端会话的任务前的确认对话框（ADR 0033 票07：任务归档时若有
 * 存活会话则提示后关闭）。确认后宿主「先杀后归档」——terminal-exited 在
 * 归档写入前推进，会话在终端面板「已退出」组可回看最后输出；取消则不发起
 * 归档 IPC，会话继续运行。
 */
export function ArchiveTerminalDialog(props: {
  taskTitle: string;
  aliveCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    cancelRef.current?.focus({ preventScroll: true });
    return () => {
      // 只归还仍属于本对话框的焦点；不能覆盖关闭操作已交给其他界面的焦点。
      const active = document.activeElement;
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        (active === document.body ||
          (active !== null && dialog?.contains(active)))
      )
        previous.focus({ preventScroll: true });
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onCancel();
    } else if (event.key === "Tab") {
      event.preventDefault();
      const first = cancelRef.current;
      const last = confirmRef.current;
      const next = event.shiftKey
        ? document.activeElement === first
          ? last
          : first
        : document.activeElement === last
          ? first
          : last;
      next?.focus({ preventScroll: true });
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      data-testid="archive-terminal-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
    >
      {/* 模态卡统一语汇（ADR 0028）：白卡 12px 圆角 + shadow-modal 档，无边框 */}
      <div className="w-[28rem] rounded-xl bg-surface p-5 shadow-modal">
        <h3 id={titleId} className="text-base font-medium text-fg">
          归档「{props.taskTitle}」？
        </h3>
        <p className="mt-2 text-sm leading-6 text-fg-muted">
          该任务有 {props.aliveCount} 个终端会话仍在运行，归档将关闭它们。
        </p>
        <p className="mt-1 text-sm leading-6 text-fg-muted">
          关闭后的会话可在终端面板的「已退出」组回看最后输出。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            ref={cancelRef}
            data-testid="archive-terminal-cancel"
            className="rounded border border-line px-3 py-1.5 text-sm text-fg-muted hover:border-fg-muted"
            onClick={props.onCancel}
          >
            取消
          </button>
          <button
            type="button"
            ref={confirmRef}
            data-testid="archive-terminal-confirm"
            className="rounded bg-accent px-3 py-1.5 text-sm text-on-accent hover:bg-accent-hover"
            onClick={props.onConfirm}
          >
            归档并关闭会话
          </button>
        </div>
      </div>
    </div>
  );
}
