import { useEffect, useRef, useState } from "react";

import {
  isExitedTerminalStatus,
  originLabel,
  statusDotClassName,
  statusPulses,
  statusText,
  terminalElapsed,
  terminalStatusClass,
} from "../lib/terminal-status";
import type { TerminalSegment } from "../lib/task-view";
import { useTickingNow } from "../lib/use-ticking-now";
import TerminalSessionView from "./TerminalSessionView";

/**
 * 终端会话检视面板（ADR 0033 票 04；tab 体拆页导航 ADR 0032 照
 * SubagentRailPanel 先例另写组件，不做参数化抽象——两处状态语义不同：
 * 子代理是 agent 轮次流，终端是 PTY 会话存续，强行参数化会泄漏）：
 * 右栏第四 tab「终端」的 tab 体。
 *
 * 结构（拆页导航）：列表页 ↔ 详情页两页互斥。列表页为默认入口——头行
 * 计数摘要 +「+ 新建会话」（超上限的中文 reason 直接展示，不另造错误态）
 * + 按状态分组（运行中 → 已退出，空组不渲染；富行两行式：标题 +
 * 状态/来源/shell 类型/已用时元信息，来源标注 用户 / agent）；点行进详情页——顶栏
 * 返回 + 状态点 + 状态文案 + 标题（running 可点击改名，标题功能轮）+ 已用时
 * + kill（running 才有，用户 kill 不弹确认，ADR 0033 非破坏性）+ 主体
 * xterm.js 终端区。
 *
 * 标题口径（标题功能轮）：展示标题 = session.title ?? session.name——OSC 0/2
 * 动态值或用户改名后携带 title，缺省回退默认名；改名提交经 terminals:rename
 * （manager 置 source=user，此后 OSC 更新不再覆盖），清单由
 * terminal-title-changed 事件归并推进。
 *
 * 数据面（票面口径）：列表数据源 = `terminals:list-for` 初始 +
 * `terminal-*` 事件增量归并（useTerminalSessions hook，RailPanel 装配），
 * 切任务时重建；字节流不走 React 状态（terminals:session-data 专用通道
 * 直写 xterm.js，见 TerminalSessionView）。本票 live-only：重启恢复归 08 票。
 */

/** 列表页分组顺序：运行中 → 已退出（空组不渲染，先例 groupSubagents） */
function groupTerminals(sessions: TerminalSegment[]): Array<{
  label: string;
  items: TerminalSegment[];
}> {
  const running = sessions.filter((item) => item.status === "running");
  const exited = sessions.filter((item) => item.status === "exited");
  return [
    { label: "运行中", items: running },
    { label: "已退出", items: exited },
  ].filter((group) => group.items.length > 0);
}

/** 消息流标记行点击的定位信号（seq 递增触发 effect，sessionId 为目标；
 *  先例 SubagentFocus——同 id 重复点击也能重新定位） */
export interface TerminalFocus {
  sessionId: string;
  /** 单调递增序号：同 sessionId 重复点击也能重新定位 */
  seq: number;
}

export function TerminalRailPanelBody(props: {
  /** 会话段列表（rail 数据源，切任务时重建） */
  sessions: TerminalSegment[];
  /** 当前任务 id；null（草稿）创建按钮禁用 */
  taskId: string | null;
  /** 创建用户侧会话（useTerminalSessions 注入，IPC terminals:create） */
  onCreate: () => void;
  /** 创建失败的中文 reason（超上限等）直接展示，不另造错误态 */
  createError: string | null;
  /** 创建请求进行中（按钮禁用防重复点击） */
  creating: boolean;
  /** 终止会话（不弹确认，ADR 0033 非破坏性） */
  onKill: (sessionId: string) => void;
  /** 终止请求进行中的 sessionId（按钮禁用防重复点击） */
  killingSessionId: string | null;
  /** 用户改名（标题功能轮；提交 terminals:rename，清单经事件归并推进） */
  onRename: (sessionId: string, title: string) => void;
  /** 消息流标记行点击直跳（票 06，ADR 0032 语义：直落详情页不落列表页） */
  focus: TerminalFocus | null;
}) {
  const [page, setPage] = useState<"list" | "detail">("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    props.sessions.find((item) => item.sessionId === selectedId) ?? null;

  // 标记行点击直跳详情（票 06）：focus 信号变化时选中对应会话并进详情页。
  // 每个 focus.seq 只消费一次（ref 幂等，照 SubagentRailPanelBody）：依赖里
  // 保留 sessions 是为「段晚于点击到达列表」的重试，但运行中会话事件会持续
  // 产生新数组引用，无幂等守卫时每次流式事件都重放 setSelectedId(focus.
  // sessionId)，把用户手动点选的会话强行拉回 focus 目标。
  const focus = props.focus;
  const consumedFocusSeqRef = useRef(-1);
  useEffect(() => {
    if (focus === null) return;
    if (focus.seq === consumedFocusSeqRef.current) return;
    if (!props.sessions.some((item) => item.sessionId === focus.sessionId))
      return;
    consumedFocusSeqRef.current = focus.seq;
    setSelectedId(focus.sessionId);
    setPage("detail");
  }, [focus, props.sessions]);

  // 详情页：顶栏（返回 + 状态 + 会话名 + 已用时 + kill）+ xterm 终端区。
  // 会话被 kill/退出后 selected 由事件推进为终态，页面原位转只读回看。
  if (page === "detail" && selected !== null) {
    return (
      <div
        data-testid="terminals-panel-body"
        className="flex min-h-0 flex-1 flex-col"
      >
        <TerminalSessionDetail
          session={selected}
          onBack={() => setPage("list")}
          onKill={props.onKill}
          killing={props.killingSessionId === selected.sessionId}
          onRename={props.onRename}
        />
      </div>
    );
  }

  // 列表页：头行（计数摘要 + 新建入口）+ 分组富行列表（默认入口）
  const running = props.sessions.filter(
    (item) => item.status === "running"
  ).length;
  return (
    <div
      data-testid="terminals-panel-body"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-fg-subtle">
        <span className="min-w-0 flex-1 truncate">
          {props.sessions.length > 0
            ? `终端会话 ${props.sessions.length} 个${running > 0 ? ` · 运行中 ${running}` : ""}`
            : "本任务尚无终端会话"}
        </span>
        <button
          type="button"
          data-testid="terminal-create"
          onClick={props.onCreate}
          disabled={props.taskId === null || props.creating}
          title={
            props.taskId === null
              ? "新建任务暂不能创建终端会话"
              : "在当前任务工作区打开一个 shell 会话"
          }
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent"
        >
          ＋ 新建会话
        </button>
      </div>
      {/* 创建失败原因（超上限等）：中文 reason 原样展示，直接一行错误文案 */}
      {props.createError !== null && (
        <p
          data-testid="terminal-create-error"
          className="shrink-0 border-b border-line px-3 py-1.5 text-xs text-danger-fg"
        >
          {props.createError}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {groupTerminals(props.sessions).map((group) => (
          <div key={group.label}>
            {/* 分组标题：accent 竖条 + 加粗标签 + 计数章（与子代理组头同构，
                ADR 0032 分组富行语汇；终端两态语义简单不加强调变体） */}
            <div
              data-testid="terminal-rail-group-header"
              className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-canvas px-3 py-1.5"
            >
              <span
                className="h-3 w-0.5 shrink-0 rounded-full bg-accent"
                aria-hidden="true"
              />
              <span className="text-xs font-semibold text-fg">
                {group.label}
              </span>
              <span className="rounded-full bg-accent/15 px-1.5 text-xs text-accent">
                {group.items.length}
              </span>
            </div>
            <ul>
              {group.items.map((item) => (
                <li key={item.sessionId}>
                  <button
                    type="button"
                    data-testid="terminal-rail-item"
                    data-terminal-state={item.status}
                    onClick={() => {
                      setSelectedId(item.sessionId);
                      setPage("detail");
                    }}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-hover"
                  >
                    <span className="flex w-full items-start gap-2">
                      <span className="pt-1.5">
                        <TerminalStatusDot session={item} />
                      </span>
                      {/* 展示标题：OSC 动态值 / 用户改名优先，缺省回退默认名 */}
                      <span
                        className="min-w-0 flex-1 truncate text-xs leading-5 text-fg"
                        title={item.title ?? item.name}
                      >
                        {item.title ?? item.name}
                      </span>
                    </span>
                    <span className="flex w-full items-center gap-2 pl-4 text-xs text-fg-subtle">
                      <span className={terminalStatusClass(item)}>
                        {statusText(item)}
                      </span>
                      <span>{originLabel(item.origin)}</span>
                      {/* shell 类型（spec 用户故事 4）：直接展示 shell 标识
                          （git-bash / powershell / cmd），与会话名前缀同源 */}
                      <span data-testid="terminal-shell-type">
                        {item.shell}
                      </span>
                      <Elapsed session={item} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 终端详情页（顶栏 + xterm 终端区）：导出供单测直接渲染详情壳断言
 * （xterm 交互区是 canvas，SSR 测到容器边界为止——TerminalSessionView
 * 挂载后才动态加载 xterm 实例化，SSR 只有容器壳）。
 *
 * 已退出会话只读回看：无 kill 按钮、终端区禁输入（disableStdin），内容
 * = subscribe 取回的缓冲回放（本票 live-only 的内存回看，落库快照恢复
 * 归 08 票）；运行中会话 kill 不弹确认（用户即授权者，ADR 0033）。
 */
export function TerminalSessionDetail(props: {
  session: TerminalSegment;
  /** 返回列表页（拆页导航的返回方向） */
  onBack: () => void;
  /** 终止会话（用户 kill 不弹确认） */
  onKill: (sessionId: string) => void;
  /** 终止请求进行中（按钮禁用；退出由 terminal-exited 事件推进呈现） */
  killing: boolean;
  /** 用户改名（标题功能轮；running 可改，已退出只读回看不改） */
  onRename: (sessionId: string, title: string) => void;
}) {
  const { session } = props;
  const exited = isExitedTerminalStatus(session.status);
  // 展示标题 = title ?? name（OSC 动态值 / 用户改名优先，缺省回退默认名）。
  // 改名 inline 编辑：点标题进输入态，Enter / 失焦提交（trim 后同值不提交），
  // Esc 取消；已退出会话保持纯文本（manager 侧同样拒绝，双保险）。
  const displayTitle = session.title ?? session.name;
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const commitRename = () => {
    setRenaming(false);
    const trimmed = renameDraft.trim();
    if (trimmed !== "" && trimmed !== displayTitle) {
      props.onRename(session.sessionId, trimmed);
    }
  };
  return (
    <>
      <div
        data-testid="terminal-rail-detail-header"
        className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2"
      >
        <button
          type="button"
          data-testid="terminal-rail-back"
          onClick={props.onBack}
          className="flex shrink-0 items-center gap-1 text-xs text-fg-muted hover:text-fg"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
          返回列表
        </button>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <TerminalStatusDot session={session} />
          {/* 状态文案在顶栏可见（终端详情没有委派说明块，状态不另挂卡内） */}
          <span className={`shrink-0 text-xs ${terminalStatusClass(session)}`}>
            {statusText(session)}
          </span>
          {renaming ? (
            <input
              data-testid="terminal-rename-input"
              value={renameDraft}
              autoFocus
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitRename();
                if (event.key === "Escape") setRenaming(false);
              }}
              onBlur={commitRename}
              aria-label="终端会话标题"
              className="min-w-0 flex-1 rounded border border-line bg-surface px-1 py-0.5 text-xs text-fg outline-none focus:input-focus-ring"
            />
          ) : exited ? (
            <span
              data-testid="terminal-rail-title"
              className="min-w-0 flex-1 truncate text-xs text-fg"
              title={displayTitle}
            >
              {displayTitle}
            </span>
          ) : (
            <button
              type="button"
              data-testid="terminal-rail-title"
              title={`${displayTitle}（点击改名）`}
              onClick={() => {
                setRenameDraft(displayTitle);
                setRenaming(true);
              }}
              className="min-w-0 flex-1 truncate text-left text-xs text-fg hover:text-fg-muted"
            >
              {displayTitle}
            </button>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
          {/* 已用时：running 实时跳动、exited 定格（创建 → 退出的存续时长） */}
          <Elapsed session={session} />
          {exited ? (
            <span className="shrink-0 text-xs text-fg-subtle">只读回看</span>
          ) : (
            <button
              type="button"
              data-testid="terminal-rail-kill"
              onClick={() => props.onKill(session.sessionId)}
              disabled={props.killing}
              title="终止该终端会话（进程树终止，不弹确认）"
              className="shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-danger-fg disabled:opacity-50"
            >
              {props.killing ? "终止中…" : "终止"}
            </button>
          )}
        </span>
      </div>
      <TerminalSessionView sessionId={session.sessionId} exited={exited} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 共享小件（列表行与详情顶栏共用；状态口径在 lib/terminal-status）      */

/** 状态点：running 黄脉冲 / 正常退出绿 / 异常退出红 / 信号终止黄静态 */
export function TerminalStatusDot(props: { session: TerminalSegment }) {
  const { session } = props;
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClassName(
        session
      )} ${statusPulses(session) ? "animate-pulse" : ""}`}
    />
  );
}

/** 已用时（mm:ss）：running 每秒跳动，exited 以 exitedAt 定格 */
export function Elapsed(props: { session: TerminalSegment }) {
  const now = useTickingNow(props.session.status === "running");
  const text = terminalElapsed(props.session, now);
  if (text === null) return null;
  return (
    <span
      data-testid="terminal-elapsed"
      className="shrink-0 font-mono text-xs text-fg-subtle"
    >
      {text}
    </span>
  );
}
