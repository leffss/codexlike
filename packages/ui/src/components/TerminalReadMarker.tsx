import {
  COLLAPSE_BODY_CLASS,
  COLLAPSE_ROW_PADDING,
} from "../lib/collapse-card";
import { useCollapseState } from "../lib/collapse-memory";
import { isNoOutputRead } from "../lib/terminal-read-view";
import type { TerminalReadItem } from "../lib/turn-view";

import { DisclosureArrow } from "./DisclosureArrow";

/**
 * terminal_read 轮内锚点行（ADR 0033「消息流 read 锚点」，先例
 * TerminalStreamMarker）：一轮内对同一会话的历次读取收敛为单行可展开
 * 锚点——收起态「读取终端『会话名』· N 次」+ 状态区（等待新输出… /
 * 最新 +N 字符 / 暂无新输出），展开态历次列表最新置顶（序号仍为时序
 * 序号），空读极简行呈现不静默；「右栏查看」跳终端详情页。
 *
 * calls 是单一事实源（计数与摘要现场派生）；开合为渲染层内存态
 * （collapse-memory，默认收起——运行态在状态区表达，不占展开位）。
 */

/** 增量字数文案：千以上缩写一位小数（30k 截断上限即「+30.0k 字符」） */
function formatCharCount(count: number): string {
  return count >= 1_000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** 读取时刻文案（epoch ms → HH:mm:ss；无打点省略） */
function formatClock(at: number | undefined): string | null {
  if (at === undefined) return null;
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function TerminalReadMarker(props: {
  item: TerminalReadItem;
  /** 会话名（主流按 terminal 段解析；缺省回退 sessionId 呈现） */
  sessionName?: string;
  /** 点击「右栏查看」：开右栏终端 tab 并直跳详情页（与标记行同款接线） */
  onOpen?: (sessionId: string) => void;
}) {
  const { item } = props;
  const label = props.sessionName ?? item.sessionId;
  const { open: expanded, toggle } = useCollapseState(
    `terminal-read-${item.calls[0]?.id ?? item.sessionId}`,
    false
  );

  const running = item.calls.some((call) => call.running === true);
  // 最新摘要取最近一次有输出的读（空读与运行中段跳过）
  const lastWithOutput = [...item.calls]
    .reverse()
    .find(
      (call) =>
        call.running !== true && call.output !== "" && !isNoOutputRead(call)
    );
  const status = running
    ? "等待新输出…"
    : lastWithOutput === undefined
      ? "暂无新输出"
      : `最新 +${formatCharCount(lastWithOutput.output.length)} 字符`;

  return (
    <li
      data-testid="terminal-read-marker"
      className="max-w-full rounded-lg bg-surface-muted text-sm"
    >
      <div className="flex items-center">
        <button
          type="button"
          data-testid="terminal-read-toggle"
          className={`flex min-w-0 flex-1 items-center gap-2 ${COLLAPSE_ROW_PADDING} text-left hover:bg-hover`}
          onClick={toggle}
          aria-expanded={expanded}
        >
          <DisclosureArrow open={expanded} />
          {/* 徽章与终端标记行同语汇（bg-code-bg + accent，D 语言机器域标识） */}
          <span className="shrink-0 rounded bg-code-bg px-1.5 py-0.5 font-mono text-[11px] text-accent">
            终端
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-fg">
            读取终端「{label}」· {item.calls.length} 次
          </span>
          <span
            data-testid="terminal-read-status"
            className={`shrink-0 text-xs ${running ? "text-warn-fg" : "text-fg-subtle"}`}
          >
            {status}
          </span>
        </button>
        <button
          type="button"
          data-testid="terminal-read-open"
          className="shrink-0 px-3 py-[9px] text-xs text-fg-subtle hover:text-fg"
          onClick={() => props.onOpen?.(item.sessionId)}
          title="在右栏「终端」tab 查看会话"
        >
          右栏查看 →
        </button>
      </div>

      {expanded && (
        <div className={COLLAPSE_BODY_CLASS}>
          <ol className="flex flex-col gap-2">
            {[...item.calls].reverse().map((call, idx) => {
              // 最新置顶，序号仍为时序序号（第 1 次…第 N 次）
              const seq = item.calls.length - idx;
              const clock = formatClock(call.startedAt);
              const head = isNoOutputRead(call)
                ? `第 ${seq} 次${clock === null ? "" : ` · ${clock}`} · 无新输出`
                : call.running === true
                  ? `第 ${seq} 次${clock === null ? "" : ` · ${clock}`} · 等待新输出…`
                  : `第 ${seq} 次${clock === null ? "" : ` · ${clock}`} · +${formatCharCount(call.output.length)} 字符${call.isError ? " · 失败" : ""}`;
              return (
                <li
                  key={call.id}
                  data-testid="terminal-read-entry"
                  data-index={seq}
                  className="rounded bg-code-bg/40 px-2 py-1.5"
                >
                  <div
                    className={`font-mono text-[11px] ${call.isError ? "text-danger-fg" : "text-fg-subtle"}`}
                  >
                    {head}
                  </div>
                  {call.output !== "" && call.running !== true && (
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-fg-muted">
                      {call.output}
                    </pre>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </li>
  );
}
