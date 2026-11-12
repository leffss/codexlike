import { useEffect, useRef, useState } from "react";
import type { AssistantSegment } from "../lib/session-view";

/** 最终正文操作栏：时间与段建立时刻独立，复制只针对当前段原始正文。 */
export function AssistantActions(props: {
  segment: AssistantSegment;
  failed?: boolean;
}) {
  const { segment } = props;
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  // 每次尝试独立令牌；卸载后作废，异步拒绝/成功不再更新已离开的段。
  const attempt = useRef<object | null>(null);
  useEffect(
    () => () => {
      attempt.current = null;
    },
    []
  );

  async function copy() {
    if (attempt.current !== null) return;
    const current = {};
    attempt.current = current;
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(segment.content);
      if (attempt.current === current) setCopyState("copied");
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
  const pad = (value: number) => String(value).padStart(2, "0");
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
        className="rounded px-2 py-1 hover:bg-hover hover:text-fg disabled:opacity-50"
      >
        {copyState === "copying"
          ? "复制中…"
          : copyState === "failed"
            ? "重试复制"
            : "复制"}
      </button>
      <span
        data-testid="assistant-copy-feedback"
        role="status"
        aria-live="polite"
        aria-atomic="true"
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
          >
            {`${completed.getFullYear()}-${pad(completed.getMonth() + 1)}-${pad(completed.getDate())} ${pad(completed.getHours())}:${pad(completed.getMinutes())}:${pad(completed.getSeconds())}`}
          </time>
        </span>
      )}
    </div>
  );
}
