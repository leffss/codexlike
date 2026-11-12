import { useEffect, useState } from "react";

import type { ToolCallSegment } from "../lib/session-view";
import { summarizeToolCall } from "../lib/tool-summary";

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

/** 工具卡片：折叠态显示工具名 + 参数摘要，展开显示完整参数与输出（spec 用户故事 7） */
export function ToolCallCard(props: { call: ToolCallSegment }) {
  const { call } = props;
  const [expanded, setExpanded] = useState(false);

  const statusLabel = call.running ? "运行中" : call.isError ? "失败" : "完成";
  const statusClass = call.running
    ? "text-warn-fg"
    : call.isError
      ? "text-danger-fg"
      : "text-ok-fg";

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
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="rounded bg-code-bg px-1.5 py-0.5 font-mono text-xs text-accent">
          {call.toolName}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
          {summarizeToolCall(call.toolName, call.arguments)}
        </span>
        <span className={`shrink-0 text-xs ${statusClass}`}>{statusLabel}</span>
        <span className="shrink-0 text-fg-subtle">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div className="border-t border-line px-3 py-2">
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

function prettyJson(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson), null, 2);
  } catch {
    return argsJson;
  }
}
