import type { TaskListItem } from "@codexlike/desktop/ipc";

/** 执行结果与已读独立，查看失败/中断不会把结果改成成功。 */
export function TaskActivityBadge({
  task,
  compact = false,
}: {
  task: TaskListItem;
  compact?: boolean;
}) {
  const activity = task.activity;
  const waiting =
    activity?.waitingForUser ??
    (task.status === "waiting-user" || task.status === "waiting-approval");
  const running = activity?.running ?? task.status === "streaming";
  // 排队中（任务并发上限票 03 / ADR 0022）排在运行之后：开跑瞬间信封可能
  // 短暂 queued 与 running 并存，以运行中为准（排队徽章弱于运行中转圈）。
  const queued = activity?.queued === true;
  const label = waiting
    ? "等待用户"
    : running
      ? "运行中"
      : queued
        ? "排队中"
        : activity?.outcome === "failed"
          ? "失败"
          : activity?.outcome === "interrupted"
            ? "已中断"
            : activity?.unread
              ? "完成未查看"
              : null;
  if (!label) return null;
  // 运行中统一用 accent 主张色（D 语言 accent=黑/白主张）：与消息流
  // generating-spinner 同源 var(--accent)（转圈图标全局一致）
  const tone = waiting
    ? "bg-warn-bg text-warn-fg"
    : activity?.outcome === "failed"
      ? "bg-danger-bg text-danger-fg"
      : running
        ? "text-accent"
        : queued
          ? // 排队是静默等待而非执行：muted 色静态时钟，弱于运行中转圈、强于无状态
            "text-fg-muted"
          : "bg-ok-bg text-ok-fg";
  return (
    <span
      data-testid="task-activity"
      title={compact ? label : undefined}
      aria-label={compact ? label : undefined}
      className={
        compact
          ? `flex ${running ? "h-4 w-4" : "h-3 w-3"} shrink-0 items-center justify-center rounded-full ${tone}`
          : `rounded px-1 py-px text-[10px] ${tone}`
      }
    >
      {compact ? (
        <>
          <svg
            width={running ? 14 : 10}
            height={running ? 14 : 10}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
            className={running && !waiting ? "animate-spin" : undefined}
          >
            {waiting ? (
              <path d="M4 3v6m4-6v6" />
            ) : running ? (
              /* 圆弧缺口约 130°，配合 animate-spin 呈转圈加载效果 */
              <circle cx="6" cy="6" r="3.5" strokeDasharray="8 14" />
            ) : queued ? (
              /* 静态时钟（任务并发上限票 03）：等待空位开跑，不转圈 */
              <>
                <circle cx="6" cy="6" r="3.5" />
                <path d="M6 4.5V6l1.2 1.2" />
              </>
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
