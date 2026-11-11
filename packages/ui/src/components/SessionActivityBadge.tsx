import type { SessionListItem } from "@codexlike/desktop/ipc";

/** 执行结果与已读独立，查看失败/中断不会把结果改成成功。 */
export function SessionActivityBadge({
  session,
}: {
  session: SessionListItem;
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
      className={`rounded px-1 py-px text-[10px] ${tone}`}
    >
      {label}
    </span>
  );
}
