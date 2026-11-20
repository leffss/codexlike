import type { ToastEntry } from "../lib/toast-state";

/**
 * toast 浮层（票02）：原消息流上方五类常驻横条的替代呈现。
 * 右下角 fixed 浮出、多条纵向堆叠，完全不占布局行；观感参数取自
 * 原型变体 D（bottom-20 避开 composer 与交互区）。
 * 外观只用现有语义 token（ADR 0006），light/dark 由变量整体翻转。
 */

/** kind → 条目外观（底色/文字类别语义保留），均来自语义 token；
 *  边框统一中性 hairline（D 语汇：类别色不再走描边，经底色与圆点保留可辨） */
const KIND_CLASS: Record<ToastEntry["kind"], string> = {
  warn: "bg-warn-bg text-warn-fg",
  error: "bg-danger-bg text-danger-fg",
  info: "bg-surface text-fg-muted",
};

/** kind → 状态圆点（原型：实心小圆点标识类别） */
const DOT_CLASS: Record<ToastEntry["kind"], string> = {
  warn: "bg-warn-fg",
  error: "bg-danger-fg",
  info: "bg-info-fg",
};

export function ToastHost(props: {
  /** 展示快照（toast 管理器 toasts()），插入序即堆叠序 */
  toasts: ToastEntry[];
  /** 手动关闭透传（条目 id） */
  onDismiss: (id: string) => void;
}) {
  if (props.toasts.length === 0) return null;
  return (
    <div
      data-testid="toast-region"
      aria-label="界面提示"
      className="pointer-events-none fixed bottom-20 right-6 z-30 flex flex-col gap-2"
    >
      {props.toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid={toast.id}
          role={toast.kind === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex max-h-64 max-w-sm flex-col gap-1 overflow-y-auto rounded-[10px] border border-line px-3 py-2 text-xs shadow-toast ${KIND_CLASS[toast.kind]}`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[toast.kind]}`}
              aria-hidden="true"
            />
            <p
              data-testid={toast.contentTestId}
              className="min-w-0 flex-1 break-words whitespace-pre-wrap"
            >
              {toast.content}
            </p>
            {toast.action && (
              <button
                type="button"
                data-testid={toast.action.testId}
                disabled={toast.action.disabled}
                onClick={toast.action.onAction}
                className="shrink-0 rounded border border-line px-2 py-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              data-testid={`${toast.id}-close`}
              aria-label="关闭提示"
              onClick={() => props.onDismiss(toast.id)}
              className="shrink-0 opacity-70 hover:opacity-100"
            >
              ×
            </button>
          </div>
          {toast.detail && (
            <p className="break-words whitespace-pre-wrap opacity-80">
              {toast.detail}
            </p>
          )}
          {toast.actionError && <p role="alert">{toast.actionError}</p>}
        </div>
      ))}
    </div>
  );
}
