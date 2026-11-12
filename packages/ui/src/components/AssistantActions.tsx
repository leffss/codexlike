import { useEffect, useRef, useState } from "react";
import type { AssistantSegment } from "../lib/session-view";
import { formatCompletedTime } from "../lib/completed-time";

/** 最终正文操作栏：时间与段建立时刻独立，复制只针对当前段原始正文。 */
export function AssistantActions(props: {
  segment: AssistantSegment;
  now: Date;
  failed?: boolean;
}) {
  const { segment } = props;
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  // 每次尝试独立令牌；卸载后作废，异步拒绝/成功不再更新已离开的段。
  const attempt = useRef<object | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      attempt.current = null;
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    []
  );

  async function copy() {
    if (attempt.current !== null) return;
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    const current = {};
    attempt.current = current;
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(segment.content);
      if (attempt.current === current) {
        setCopyState("copied");
        resetTimer.current = setTimeout(() => {
          resetTimer.current = null;
          setCopyState("idle");
        }, 2000);
      }
    } catch {
      if (attempt.current === current) setCopyState("failed");
    } finally {
      if (attempt.current === current) attempt.current = null;
    }
  }

  const date =
    segment.completedAt === undefined ? null : new Date(segment.completedAt);
  const completed =
    date !== null &&
    Number.isFinite(date.getTime()) &&
    !segment.interrupted &&
    !props.failed
      ? date
      : null;
  const formatted =
    completed === null ? null : formatCompletedTime(completed, props.now);
  const copyLabel = {
    idle: "复制",
    copying: "复制中",
    copied: "已复制",
    failed: "重试复制",
  }[copyState];
  return (
    <div
      data-testid="assistant-actions"
      className="mt-2 flex flex-wrap items-center gap-3 text-xs text-fg-muted"
    >
      <button
        type="button"
        data-testid="assistant-copy"
        onClick={() => void copy()}
        disabled={copyState === "copying"}
        aria-label={copyLabel}
        title={copyLabel}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-line bg-surface-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {copyState === "copied" ? (
            <path d="m5 12 4 4L19 6" />
          ) : (
            <>
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4" />
            </>
          )}
        </svg>
      </button>
      <span
        data-testid="assistant-copy-feedback"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={copyState === "failed" ? "text-danger-fg" : "sr-only"}
      >
        {copyState === "copied"
          ? "已复制"
          : copyState === "failed"
            ? "复制失败，请重试"
            : ""}
      </span>
      {completed !== null && (
        <span>
          完成于{" "}
          <time
            data-testid="assistant-completed-at"
            dateTime={completed.toISOString()}
            title={formatted?.title}
          >
            {formatted?.label}
          </time>
        </span>
      )}
    </div>
  );
}
