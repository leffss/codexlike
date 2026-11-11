import { useEffect, useState } from 'react';

import type { UiToolCall } from '../lib/session-view';
import { summarizeToolCall } from '../lib/tool-summary';

/** 截图卡片的图片展示：展开时经主进程按 会话+调用 id 读取文件（dataURL） */
function ScreenshotView(props: { call: UiToolCall }) {
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
        className="mt-2 max-h-96 w-full rounded border border-slate-800 object-contain"
      />
    );
  }
  return failed ? (
    <p className="mt-1 text-xs text-slate-500">截图文件已不存在（可能在其它数据目录）</p>
  ) : (
    <p className="mt-1 text-xs text-slate-500">截图加载中…</p>
  );
}

/** 工具卡片：折叠态显示工具名 + 参数摘要，展开显示完整参数与输出（spec 用户故事 7） */
export function ToolCallCard(props: { call: UiToolCall }) {
  const { call } = props;
  const [expanded, setExpanded] = useState(false);

  const statusLabel = call.running
    ? '运行中'
    : call.isError
      ? '失败'
      : '完成';
  const statusClass = call.running
    ? 'text-amber-400'
    : call.isError
      ? 'text-red-400'
      : 'text-emerald-400';

  return (
    <li
      data-testid="tool-call-card"
      data-tool-name={call.toolName}
      className="max-w-full rounded-lg border border-slate-800 bg-slate-900/80 text-sm"
    >
      <button
        type="button"
        data-testid="tool-call-toggle"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-800/60"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-sky-300">
          {call.toolName}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-400">
          {summarizeToolCall(call.toolName, call.arguments)}
        </span>
        <span className={`shrink-0 text-xs ${statusClass}`}>{statusLabel}</span>
        <span className="shrink-0 text-slate-500">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 px-3 py-2">
          <details className="group mb-2" open>
            <summary className="cursor-pointer text-xs text-slate-500">参数</summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950/70 p-2 font-mono text-xs text-slate-300">
              {prettyJson(call.arguments)}
            </pre>
          </details>
          <div className="text-xs text-slate-500">输出</div>
          <pre
            data-testid="tool-call-output"
            className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950/70 p-2 font-mono text-xs text-slate-300"
          >
            {call.output === '' && call.running ? '（执行中…）' : call.output}
          </pre>
          {call.toolName === 'browser_screenshot' && !call.running && (
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
