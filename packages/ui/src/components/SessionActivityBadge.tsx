import type { SessionListItem } from "@codexlike/desktop/ipc";

/** 执行结果与已读独立，查看失败/中断不会把结果改成成功。 */
export function SessionActivityBadge({
  session,
  compact = false,
}: {
  session: SessionListItem;
  compact?: boolean;
}) {
  const activity = session.activity;
  const waiting =
    activity?.waitingForUser ??
    (session.status === "waiting-user" ||
      session.status === "waiting-approval");
  const running = activity?.running ?? session.status === "streaming";
  const label = waiting
    ? "等待用户"
    : running
      ? "运行中"
      : activity?.outcome === "failed"
        ? "失败"
        : activity?.outcome === "interrupted"
          ? "已中断"
          : activity?.unread
            ? "完成未查看"
            : null;
  if (!label) return null;
  const tone = waiting
    ? "bg-warn-bg text-warn-fg"
    : activity?.outcome === "failed"
      ? "bg-danger-bg text-danger-fg"
      : "bg-ok-bg text-ok-fg";
  return (
    <span
      data-testid="session-activity"
      title={compact ? label : undefined}
      aria-label={compact ? label : undefined}
      className={
        compact
          ? `flex h-3 w-3 shrink-0 items-center justify-center rounded-full ${tone}`
          : `rounded px-1 py-px text-[10px] ${tone}`
      }
    >
      {compact ? (
        <>
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            {waiting ? (
              <path d="M4 3v6m4-6v6" />
            ) : running ? (
              <circle cx="6" cy="6" r="3.5" strokeDasharray="15 7" />
            ) : activity?.outcome === "failed" ? (
              <path d="m3 3 6 6m0-6L3 9" />
            ) : activity?.outcome === "interrupted" ? (
              <rect x="3" y="3" width="6" height="6" rx="0.5" />
            ) : (
              <circle cx="6" cy="6" r="2.5" fill="currentColor" stroke="none" />
            )}
          </svg>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        label
      )}
    </span>
  );
}
