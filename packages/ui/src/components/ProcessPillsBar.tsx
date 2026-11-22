/**
 * 任务过程胶囊条（GLOSSARY「工作计划」主任务呈现形态，ADR 0034，原型变体
 * B 转正，三变体快照见 prototype/tri-list-cards 分支）：位于消息正文与消息
 * 队列/输入区之间——取代主任务位的长条形折叠卡（ADR 0019；子代理详情页
 * 的折叠卡保留，不涉本组件）。一行三胶囊（计划/子代理/终端）按内容宽度、
 * 整组在正文列内居中，占行最矮；点任一胶囊向上弹出浮动对话框（绝对定位
 * 锚定被点的胶囊水平居中，不推挤布局，浮层点外收起）；列表行点击复用消息
 * 流标记行语义（ADR 0032：右栏对应 tab 直跳详情页）。无内容的胶囊不渲染
 * （对齐折叠卡「无计划不占布局行」口径，ADR 0019），三类皆空时整条渲染
 * null。开合为一次性查看交互，不做跨会话记忆（ADR 0034 取舍）。
 * 数据源：计划快照与子代理段由消息段序列派生（lib/plan-view / lib/task-view
 * 「事件归并实体段」两处消费口径）；终端会话自装 useTerminalSessions（先例
 * RailPanel 内装配），与右栏终端列表同源同数。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { useTerminalSessions } from "../lib/use-terminal-sessions";
import { useTickingNow } from "../lib/use-ticking-now";
import {
  statusClass,
  statusDotClassName,
  statusPulses,
  statusText,
} from "../lib/subagent-status";
import { formatElapsed } from "./SubagentRailPanel";
import {
  originLabel,
  statusDotClassName as terminalDotClassName,
  statusPulses as terminalPulses,
  statusText as terminalStatusText,
  terminalElapsed,
  terminalStatusClass,
} from "../lib/terminal-status";
import {
  activeStep,
  collectPlanSnapshots,
  completedCount,
  type PlanStep,
} from "../lib/plan-view";
import type {
  MessageSegment,
  SubagentSegment,
  TerminalSegment,
} from "../lib/task-view";
import { DisclosureArrow } from "./DisclosureArrow";
import { StepStatusIcon } from "./WorkPlanCard";

type PillKey = "plan" | "subagents" | "terminals";

/** 计划步骤行（浮层清单用；三态图标对齐 WorkPlanCard 展开清单视觉） */
function PlanStepRow(props: { step: PlanStep }) {
  const { step } = props;
  return (
    <div className="flex min-w-0 items-start gap-2 py-0.5">
      <span className="mt-0.5 shrink-0">
        <StepStatusIcon status={step.status} />
      </span>
      <span
        className={`min-w-0 break-words text-xs leading-5 ${
          step.status === "completed"
            ? "text-fg-subtle line-through"
            : step.status === "in_progress"
              ? "text-fg"
              : "text-fg-subtle"
        }`}
      >
        {step.content}
      </span>
    </div>
  );
}

/** 子代理列表行（点击直跳右栏「子代理」详情，先例 = 消息流标记行） */
function SubagentRow(props: {
  subagent: SubagentSegment;
  now: number;
  onOpen: (subagentId: string) => void;
}) {
  const { subagent, now } = props;
  const elapsed = formatElapsed(subagent, now);
  return (
    <button
      type="button"
      onClick={() => props.onOpen(subagent.id)}
      title="在右栏「子代理」tab 查看详情"
      className="group flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left hover:bg-hover"
    >
      <span
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClassName(subagent)} ${statusPulses(subagent) ? "animate-pulse" : ""}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-xs text-fg">
        {subagent.task}
      </span>
      <span className={`shrink-0 text-[10px] ${statusClass(subagent)}`}>
        {statusText(subagent)}
      </span>
      {elapsed !== null && (
        <span className="shrink-0 font-mono text-xs text-fg-subtle">
          {elapsed}
        </span>
      )}
      <span className="shrink-0 text-[10px] text-fg-subtle opacity-0 transition group-hover:opacity-100">
        右栏查看 →
      </span>
    </button>
  );
}

/** 终端会话列表行（点击直跳右栏「终端」详情页） */
function TerminalRow(props: {
  session: TerminalSegment;
  now: number;
  onOpen: (sessionId: string) => void;
}) {
  const { session, now } = props;
  const elapsed = terminalElapsed(session, now);
  return (
    <button
      type="button"
      onClick={() => props.onOpen(session.sessionId)}
      title="在右栏「终端」tab 查看详情"
      className="group flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left hover:bg-hover"
    >
      <span
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${terminalDotClassName(session)} ${terminalPulses(session) ? "animate-pulse" : ""}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-xs text-fg">
        {session.title ?? session.name}
      </span>
      <span className="shrink-0 text-[10px] text-fg-subtle">
        {originLabel(session.origin)}
      </span>
      <span className={`shrink-0 text-[10px] ${terminalStatusClass(session)}`}>
        {terminalStatusText(session)}
      </span>
      {elapsed !== null && (
        <span className="shrink-0 font-mono text-xs text-fg-subtle">
          {elapsed}
        </span>
      )}
      <span className="shrink-0 text-[10px] text-fg-subtle opacity-0 transition group-hover:opacity-100">
        右栏查看 →
      </span>
    </button>
  );
}

/** 三类图标（size-3 胶囊头 / size-3.5 浮层头共用），对齐 D 设计语言线条 */
function PillsIcon(props: { kind: PillKey; className?: string }) {
  const common = {
    viewBox: "0 0 16 16",
    className: props.className ?? "size-3 shrink-0",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  } as const;
  if (props.kind === "plan") {
    return (
      <svg {...common}>
        <path d="M2.5 4h1.8M7 4h6.5M2.5 8h1.8M7 8h6.5M2.5 12h1.8M7 12h6.5" />
        <path d="m3.4 3.4 1 1 1.6-2" className="opacity-70" />
      </svg>
    );
  }
  if (props.kind === "subagents") {
    return (
      <svg {...common}>
        <circle cx="8" cy="3.2" r="1.7" />
        <path d="M8 5.4v2.1M8 7.5 4.2 10M8 7.5 11.8 10" />
        <circle cx="3.6" cy="11.6" r="1.7" />
        <circle cx="12.4" cy="11.6" r="1.7" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="m3.5 5 3 2.8-3 2.8" />
      <path d="M8.6 12h4" />
    </svg>
  );
}

export function ProcessPillsBar(props: {
  taskId: string;
  /** 计划快照与子代理段的派生源（主任务消息段序列） */
  messages: MessageSegment[];
  /** 终端恢复记录（重启快照，useTerminalSessions 初始合并源），透传 */
  restoredTerminals: import("@codexlike/agent-core").TerminalSessionRecord[];
  onOpenSubagent: (subagentId: string) => void;
  onOpenTerminal: (sessionId: string) => void;
}) {
  const planSnapshots = useMemo(
    () => collectPlanSnapshots(props.messages),
    [props.messages]
  );
  const plan = planSnapshots.at(-1);
  const steps = useMemo(() => plan?.steps ?? [], [plan]);
  const subagents = useMemo(
    () =>
      props.messages.filter(
        (item): item is SubagentSegment => item.kind === "subagent"
      ),
    [props.messages]
  );
  // 终端会话自装 hook（先例 RailPanel 内装配）：与右栏终端列表同源同数
  const { sessions } = useTerminalSessions(
    props.taskId,
    props.restoredTerminals
  );

  const hasPlan = steps.length > 0;
  const anyRunning =
    subagents.some((item) => item.state === "running") ||
    sessions.some((item) => item.status === "running");
  const now = useTickingNow(anyRunning);

  const [openKey, setOpenKey] = useState<PillKey | null>(null);
  const pillRefs = useRef<Partial<Record<PillKey, HTMLButtonElement | null>>>(
    {}
  );
  const barRef = useRef<HTMLDivElement | null>(null);
  const anchor = openKey !== null ? pillRefs.current[openKey] : null;
  // 锚定被点的胶囊：offsetLeft 相对本条 relative 容器（中间无其他定位层）
  const anchorCenter =
    anchor !== null && anchor !== undefined
      ? anchor.offsetLeft + anchor.offsetWidth / 2
      : null;

  // 浮层点外收起（mousedown 在胶囊条容器外时）
  useEffect(() => {
    if (openKey === null) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        barRef.current !== null &&
        barRef.current.contains(event.target as Node)
      )
        return;
      setOpenKey(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [openKey]);

  // 三类皆空：整条不占布局行（对齐折叠卡「无计划 null」先例）
  if (!hasPlan && subagents.length === 0 && sessions.length === 0) return null;

  const done = completedCount(steps);
  const active = activeStep(steps);
  const allDone = steps.length > 0 && done === steps.length;
  const runningSubagents = subagents.filter(
    (item) => item.state === "running"
  ).length;
  const runningTerminals = sessions.filter(
    (item) => item.status === "running"
  ).length;

  interface PillSpec {
    key: PillKey;
    label: string;
    icon: React.ReactNode;
    badge: string | null;
    countText: string;
  }
  const pills: PillSpec[] = [];
  if (hasPlan) {
    pills.push({
      key: "plan",
      label: "计划",
      icon: <PillsIcon kind="plan" />,
      badge: null,
      countText: `${done}/${steps.length}`,
    });
  }
  if (subagents.length > 0) {
    pills.push({
      key: "subagents",
      label: "子代理",
      icon: <PillsIcon kind="subagents" />,
      badge: runningSubagents > 0 ? `运行 ${runningSubagents}` : null,
      countText: String(subagents.length),
    });
  }
  if (sessions.length > 0) {
    pills.push({
      key: "terminals",
      label: "终端",
      icon: <PillsIcon kind="terminals" />,
      badge: runningTerminals > 0 ? `运行 ${runningTerminals}` : null,
      countText: String(sessions.length),
    });
  }

  const openPill = (key: PillKey) => setOpenKey(openKey === key ? null : key);

  return (
    <div ref={barRef} className="relative flex justify-center">
      <div className="flex items-center gap-1.5">
        {pills.map((pill) => {
          const isOpen = openKey === pill.key;
          return (
            <button
              key={pill.key}
              type="button"
              ref={(el) => {
                pillRefs.current[pill.key] = el;
              }}
              data-testid={`process-pill-${pill.key}`}
              aria-expanded={isOpen}
              onClick={() => openPill(pill.key)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
                isOpen
                  ? "bg-accent/15 text-accent"
                  : "bg-surface-muted text-fg-muted hover:bg-hover"
              }`}
            >
              {pill.icon}
              <span className="shrink-0 font-medium">{pill.label}</span>
              {pill.badge !== null && (
                <span
                  data-testid={`process-pill-${pill.key}-running`}
                  className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent"
                >
                  {pill.badge}
                </span>
              )}
              <span
                data-testid={`process-pill-${pill.key}-count`}
                className="shrink-0 pl-1 font-mono text-[10px]"
              >
                {pill.countText}
              </span>
              {/* 折叠箭头（消息区统一视觉基准） */}
              <DisclosureArrow open={isOpen} />
            </button>
          );
        })}
      </div>
      {openKey !== null && anchorCenter !== null && (
        // 向上弹出浮动对话框：锚定被点的胶囊（水平居中于它），浮层不推挤
        // 布局；下方是输入区、上方消息流空间大
        <div
          data-testid={`process-pill-popover-${openKey}`}
          style={{ left: anchorCenter }}
          className="absolute bottom-full z-20 mb-1.5 w-80 -translate-x-1/2 rounded-[10px] border border-line bg-surface px-3 py-1.5 shadow-lg"
        >
          <div className="mb-0.5 flex items-center gap-1.5 border-b border-line pb-1 text-xs font-medium text-fg">
            <PillsIcon
              kind={openKey}
              className="size-3.5 shrink-0 text-accent"
            />
            {openKey === "plan"
              ? `工作计划 · ${steps.length} 步`
              : openKey === "subagents"
                ? `子代理 · ${subagents.length} 个`
                : `终端 · ${sessions.length} 个`}
            <span className="ml-auto font-mono text-[10px] text-fg-subtle">
              {openKey === "plan" && allDone
                ? "全部完成"
                : openKey === "plan" && active !== undefined
                  ? active.content
                  : null}
            </span>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {openKey === "plan" &&
              steps.map((step) => <PlanStepRow key={step.id} step={step} />)}
            {openKey === "subagents" &&
              subagents.map((item) => (
                <SubagentRow
                  key={item.id}
                  subagent={item}
                  now={now}
                  onOpen={(id) => {
                    setOpenKey(null);
                    props.onOpenSubagent(id);
                  }}
                />
              ))}
            {openKey === "terminals" &&
              sessions.map((item) => (
                <TerminalRow
                  key={item.sessionId}
                  session={item}
                  now={now}
                  onOpen={(id) => {
                    setOpenKey(null);
                    props.onOpenTerminal(id);
                  }}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
