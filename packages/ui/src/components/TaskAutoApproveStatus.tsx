/** 会话级持久授权，与当前执行、问答和基础审批模式独立。 */
export function TaskAutoApproveStatus(props: {
  autoApprove: boolean;
  busy: boolean;
  error: string | null;
  onRevoke: () => void;
}) {
  if (!props.autoApprove) return null;
  return (
    <section
      data-testid="session-auto-approve"
      aria-label="会话自动批准"
      className="border-t border-line bg-warn-bg px-4 py-2 text-xs text-warn-fg"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span>本会话已开启自动批准</span>
        <button
          type="button"
          data-testid="session-auto-approve-revoke"
          disabled={props.busy}
          onClick={props.onRevoke}
          className="rounded border border-line px-2 py-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {props.busy ? "取消中…" : "取消自动批准"}
        </button>
      </div>
      <p className="mt-1">
        取消后恢复基础审批模式的允许策略，不撤回已批准的执行。
      </p>
      {props.error && (
        <p role="alert" className="mt-1 text-danger-fg">
          {props.error}
        </p>
      )}
    </section>
  );
}
