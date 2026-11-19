import { useEffect, useRef, useState } from "react";
import type { AssistantSegment } from "../lib/task-view";
import { formatCompletedTime } from "../lib/completed-time";

/** 导出默认文件名的非法字符（Windows 文件名保留字符）→ 连字符 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/** 任务标题 → 导出文件名基础（无标题回退固定名）；保存对话框仍可改名 */
export function exportFileNameBase(
  taskTitle: string | null | undefined
): string {
  if (taskTitle === null || taskTitle === undefined || taskTitle.trim() === "")
    return "codexlike-回复";
  const sanitized = taskTitle
    .replace(ILLEGAL_FILENAME_CHARS, "-")
    .replace(/[.\s]+$/g, "")
    .trim();
  return sanitized === "" ? "codexlike-回复" : sanitized;
}

/** 最终正文操作栏：时间与段建立时刻独立，复制/导出只针对当前段原始正文。 */
export function AssistantActions(props: {
  segment: AssistantSegment;
  now: Date;
  failed?: boolean;
  /** 导出 Markdown 的默认文件名来源（GLOSSARY「任务」标题）；缺省用固定名 */
  taskTitle?: string | null;
}) {
  const { segment } = props;
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  const [exportState, setExportState] = useState<
    "idle" | "exporting" | "exported" | "failed"
  >("idle");
  // 每次尝试独立令牌；卸载后作废，异步拒绝/成功不再更新已离开的段。
  const attempt = useRef<object | null>(null);
  const exportAttempt = useRef<object | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      attempt.current = null;
      exportAttempt.current = null;
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      if (exportResetTimer.current !== null)
        clearTimeout(exportResetTimer.current);
    },
    []
  );

  /** 瞬时反馈（copied / exported）到点回落 idle；令牌过期不覆盖新状态 */
  function scheduleReset(
    setState: (state: "idle") => void,
    timerRef: typeof resetTimer
  ) {
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setState("idle");
    }, 2000);
  }

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
        scheduleReset(setCopyState, resetTimer);
      }
    } catch {
      if (attempt.current === current) setCopyState("failed");
    } finally {
      if (attempt.current === current) attempt.current = null;
    }
  }

  /** 导出为 Markdown 文件：原生保存对话框（用户可选位置与文件名）；取消静默 */
  async function exportMarkdown() {
    if (exportAttempt.current !== null) return;
    if (exportResetTimer.current !== null) {
      clearTimeout(exportResetTimer.current);
      exportResetTimer.current = null;
    }
    const current = {};
    exportAttempt.current = current;
    setExportState("exporting");
    try {
      const result = await window.codexlike.files.saveText({
        defaultFileName: `${exportFileNameBase(props.taskTitle)}.md`,
        content: segment.content,
      });
      if (exportAttempt.current !== current) return;
      if (result.saved) {
        setExportState("exported");
        scheduleReset(setExportState, exportResetTimer);
      } else {
        setExportState("idle");
      }
    } catch {
      if (exportAttempt.current === current) setExportState("failed");
    } finally {
      if (exportAttempt.current === current) exportAttempt.current = null;
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
  const exportLabel = {
    idle: "导出为 Markdown",
    exporting: "导出中",
    exported: "已导出",
    failed: "导出失败，请重试",
  }[exportState];
  return (
    <div
      data-testid="assistant-actions"
      // 将 sr-only 反馈的绝对定位约束在消息内，避免越过消息流撑大根文档。
      className="relative mt-2 flex flex-wrap items-center gap-3 text-xs text-fg-muted"
    >
      <button
        type="button"
        data-testid="assistant-copy"
        onClick={() => void copy()}
        disabled={copyState === "copying"}
        aria-label={copyLabel}
        title={copyLabel}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
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
      <button
        type="button"
        data-testid="assistant-export"
        onClick={() => void exportMarkdown()}
        disabled={exportState === "exporting"}
        aria-label={exportLabel}
        title={exportLabel}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
      >
        {/* 下载（向下箭头 + 托盘，lucide download 官方 path）。旧版托盘弧
            命令多写一位参数，Chromium 解析到 h 处断链只渲染出左下小碎片。 */}
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
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
      <span
        data-testid="assistant-export-feedback"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={exportState === "failed" ? "text-danger-fg" : "sr-only"}
      >
        {exportState === "exported"
          ? "已导出"
          : exportState === "failed"
            ? "导出失败，请重试"
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
