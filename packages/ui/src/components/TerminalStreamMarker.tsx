import type { TerminalSegment } from "../lib/task-view";
import {
  originLabel,
  statusText,
  terminalStatusClass,
} from "../lib/terminal-status";

import { Elapsed, TerminalStatusDot } from "./TerminalRailPanel";

/**
 * 终端会话消息流标记行（ADR 0033 票 06，先例 SubagentStreamMarker）：
 * 会话正文（xterm 终端区）收纳右栏「终端」tab 详情页后，消息流内只留
 * 这行时序锚点——单行轻量标记（终端徽章 + 动作摘要 + 状态点 + 状态 +
 * 已用时 + 来源标注），整行可点，点击经 onOpen 打开右栏、切到终端 tab
 * 并直跳对应会话详情页（不落列表页，幂等守卫照 SubagentFocus 的 seq 模式）。
 *
 * 动作文案（票面例「启动了终端会话 git-bash · 1」）：段由 terminal-started
 * 入流（spawn 动作的时序位置），agent 自启会话以动词摘要表达；用户手开的
 * 会话（origin=user）无 agent 动作，只列会话名。会话退出后段原位推进
 * 终态（upsert 保序），标记行状态区随事件呈现回看语义。
 */
export function TerminalStreamMarker(props: {
  session: TerminalSegment;
  /** 点击打开右栏终端 tab 并直跳详情页（WorkspacePage 装配 focus 信号） */
  onOpen?: (sessionId: string) => void;
}) {
  const { session } = props;
  // 动作动词摘要：agent 会话由 spawn 入流（「启动了终端会话 …」）；用户
  // 手开无动词（不是消息流里 agent 的动作，只作会话实体锚点）
  const summary =
    session.origin === "agent"
      ? `启动了终端会话 ${session.name}`
      : `终端会话 ${session.name}`;
  return (
    <li data-testid="terminal-stream-marker" className="max-w-full">
      <button
        type="button"
        data-testid="terminal-stream-marker-toggle"
        data-terminal-state={session.status}
        onClick={() => props.onOpen?.(session.sessionId)}
        title="在右栏「终端」tab 查看会话"
        className="flex w-full items-center gap-2 rounded-lg bg-surface-muted px-3.5 py-[9px] text-left text-xs hover:bg-hover"
      >
        {/* 徽章与工具名同语汇（bg-code-bg + accent，D 语言机器域标识） */}
        <span className="shrink-0 rounded bg-code-bg px-1.5 py-0.5 font-mono text-[11px] text-accent">
          终端
        </span>
        <span
          className={`min-w-0 flex-1 truncate ${
            session.status === "exited" ? "text-fg-muted" : "text-fg"
          }`}
          title={summary}
        >
          {summary}
        </span>
        {/* 来源标注（ADR 0033 所有权边界）：agent 自启 / 用户手开，与
            rail 列表富行 originLabel 同口径 */}
        <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-[11px] text-fg-subtle">
          {originLabel(session.origin)}
        </span>
        <TerminalStatusDot session={session} />
        <span className={`shrink-0 ${terminalStatusClass(session)}`}>
          {statusText(session)}
        </span>
        <Elapsed session={session} />
        <span className="shrink-0 text-fg-subtle">右栏查看 →</span>
      </button>
    </li>
  );
}
