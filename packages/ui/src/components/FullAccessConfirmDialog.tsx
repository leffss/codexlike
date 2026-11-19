import { useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";

/**
 * 切换到「完全访问」审批模式前的风险确认对话框（ADR 0004）。
 * 完全访问 = 全自动执行 + 放开工作区文件边界（可不受限读写本地任意文件、联网），
 * 误操作不可逆范围最大，因此 UI 层在 selectApprovalMode 前拦截确认；
 * 取消则不发起 IPC，选择器自然回显原档位。
 */
export function FullAccessConfirmDialog(props: {
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
      data-testid="full-access-confirm-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
    >
      {/* 模态卡统一语汇（ADR 0028）：白卡 12px 圆角 + shadow-modal 档，无边框（层次靠投影）；
          风险语义保留在标题与正文文字色，不再用警示色描边 */}
      <div className="w-[28rem] rounded-xl bg-surface p-5 shadow-modal">
        <h3 id={titleId} className="text-base font-medium text-warn-fg">
          切换到完全访问？
        </h3>
        <p className="mt-2 text-sm leading-6 text-fg-muted">
          完全访问（full-access）下，Agent 将：
        </p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6 text-fg-muted">
          <li>自动执行全部操作，不再逐条询问（含危险命令）；</li>
          <li>
            可不受限地读写本机任意位置的文件——
            <span className="text-warn-fg">工作区边界保护将失效</span>；
          </li>
          <li>可自由访问互联网。</li>
        </ul>
        <p className="mt-3 text-sm leading-6 text-fg-muted">
          仅在你完全信任当前任务时使用；随时可切回「帮我批准」恢复边界。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            ref={cancelRef}
            data-testid="full-access-confirm-cancel"
            className="rounded border border-line px-3 py-1.5 text-sm text-fg-muted hover:border-fg-muted"
            onClick={props.onCancel}
          >
            取消
          </button>
          <button
            type="button"
            ref={confirmRef}
            data-testid="full-access-confirm-ok"
            className="rounded bg-danger-solid px-3 py-1.5 text-sm text-on-accent hover:bg-danger-solid-hover"
            onClick={props.onConfirm}
          >
            我已了解风险，切换
          </button>
        </div>
      </div>
    </div>
  );
}
