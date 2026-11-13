import { useEffect, useState } from "react";

import { useCollapseState } from "../lib/collapse-memory";
import type { ToolCallSegment } from "../lib/session-view";
import { summarizeToolCall } from "../lib/tool-summary";
import { formatDurationCn } from "../lib/turn-view";

import { DisclosureArrow } from "./DisclosureArrow";

/** 截图卡片的图片展示：展开时经主进程按 会话+调用 id 读取文件（dataURL） */
function ScreenshotView(props: { call: ToolCallSegment }) {
  const { call } = props;
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setImage(null);
    setFailed(false);
    if (!call.isError) {
      window.codexlike.sessions
        .toolImage(call.sessionId, call.id)
        .then((dataUrl) => {
          if (alive) {
            if (dataUrl === null) {
              setFailed(true);
            } else {
              setImage(dataUrl);
            }
          }
        })
        .catch(() => {
          if (alive) {
            setFailed(true);
          }
        });
    }
    return () => {
      alive = false;
    };
  }, [call.id, call.sessionId, call.isError]);

  if (call.isError) {
    return null;
  }
  if (image !== null) {
    return (
      <img
        data-testid="tool-call-screenshot"
        src={image}
        alt={`截图 ${call.id}`}
        className="mt-2 max-h-96 w-full rounded border border-line object-contain"
      />
    );
  }
  return failed ? (
    <p className="mt-1 text-xs text-fg-subtle">
      截图文件已不存在（可能在其它数据目录）
    </p>
  ) : (
    <p className="mt-1 text-xs text-fg-subtle">截图加载中…</p>
  );
}

/**
 * 工具卡片（票 04 摘要增强）：折叠摘要行 = 类别词 + 动作摘要 + 状态标识 +
 * 耗时（spec 用户故事 26），失败详情在状态位可查（hover 提示 + 展开完整输出，
 * 用户故事 28）；开合为渲染层内存态（滚动、切换会话不丢手动开合）。
 */
export function ToolCallCard(props: { call: ToolCallSegment }) {
  const { call } = props;
  const { open: expanded, toggle } = useCollapseState(`tool-${call.id}`, false);

  const statusLabel = call.running ? "运行中" : call.isError ? "失败" : "完成";
  const statusClass = call.running
    ? "text-warn-fg"
    : call.isError
      ? "text-danger-fg"
      : "text-ok-fg";
  const duration =
    call.endedAt !== undefined && call.startedAt !== undefined
      ? formatDurationCn(call.endedAt - call.startedAt, true)
      : null;

  return (
    <li
      data-testid="tool-call-card"
      data-tool-name={call.toolName}
      className="max-w-full rounded-lg border border-line bg-surface text-sm"
    >
      <button
        type="button"
        data-testid="tool-call-toggle"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover"
        onClick={toggle}
        aria-expanded={expanded}
      >
        <DisclosureArrow open={expanded} />
        <span className="rounded bg-code-bg px-1.5 py-0.5 font-mono text-xs text-accent">
          {call.toolName}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
          {summarizeToolCall(call.toolName, call.arguments)}
        </span>
        {/* 失败详情在状态位可查：悬停提示错误摘要（展开区有完整输出） */}
        <span
          data-testid="tool-call-status"
          className={`shrink-0 text-xs ${statusClass}`}
          title={
            call.isError && call.output !== ""
              ? truncateDetail(call.output)
              : undefined
          }
        >
          {statusLabel}
        </span>
        {/* 耗时：运行期 call→result 打点可得；恢复的历史记录无耗时则省略 */}
        {duration !== null && (
          <span
            data-testid="tool-call-duration"
            className="shrink-0 font-mono text-xs text-fg-subtle"
          >
            {duration}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-line py-2 pl-7 pr-3">
          <details className="group mb-2" open>
            <summary className="cursor-pointer text-xs text-fg-subtle">
              参数
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-code-bg p-2 font-mono text-xs text-code-fg">
              {prettyJson(call.arguments)}
            </pre>
          </details>
          <div className="text-xs text-fg-subtle">输出</div>
          <pre
            data-testid="tool-call-output"
            className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-code-bg p-2 font-mono text-xs text-code-fg"
          >
            {call.output === "" && call.running ? "（执行中…）" : call.output}
          </pre>
          {call.toolName === "browser_screenshot" && !call.running && (
            <ScreenshotView call={call} />
          )}
        </div>
      )}
    </li>
  );
}

/** 失败悬停详情：单行化并截断 */
function truncateDetail(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 200 ? `${single.slice(0, 200)}…` : single;
}

function prettyJson(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson), null, 2);
  } catch {
    return argsJson;
  }
}
