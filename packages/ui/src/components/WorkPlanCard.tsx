/**
 * 工作计划进度折叠卡（GLOSSARY「工作计划」，ADR 0019，原型变体 C 转正，
 * 三变体快照见 prototype/plan-card 分支）：消息正文与消息队列/输入区之间的
 * 长条形折叠卡——宽度对齐正文列（挂载点包宽度，同「已开启自动批准」提示卡
 * 先例），收起态头行百分比徽章先行 + N/M 计数，第二行内联预览当前步骤与
 * 下一步（不展开也能读到进行中与接下来做什么）；轻点整卡展开完整步骤清单
 * （完成项删除线、进行中静态箭头；max-h 内部滚动）。
 * 取代 ADR 0016 定稿后退役的 fixed 悬浮进度环徽章（WorkPlanBanner）：悬浮
 * 遮挡消息上下文、拖动/位置记忆/右键复位交互链长，且右栏常驻（ADR 0018）
 * 后中列频繁推窄，浮动位置的可用性随布局变化衰减。开合记忆走
 * collapse-memory 任务作用域（ADR 0011 渲染层内存态：跨任务/重挂载不丢）。
 * 当前计划由段序列派生（lib/plan-view），流内调用处只留一行标记
 * （PlanMarkerRow），不渲染通用工具卡。
 */
import { useMemo } from "react";

import { DisclosureArrow } from "./DisclosureArrow";
import { useCollapseState } from "../lib/collapse-memory";
import {
  activeStep,
  collectPlanSnapshots,
  collectSubagentPlanSnapshots,
  completedCount,
  type PlanSnapshot,
  type PlanStep,
  type PlanStepStatus,
} from "../lib/plan-view";
import type { SubagentToolCall } from "../lib/task-view";

/**
 * 三态图标（ZCode 同构语义）：pending 空心圆最弱；in_progress 用**静态箭头**
 * ——计划卡会长时间停留在页面上，spinner 暗示「加载中」而非「当前所在
 * 步骤」，语义错位；completed 实心对勾成功色。
 */
export function StepStatusIcon(props: { status: PlanStepStatus }) {
  const { status } = props;
  if (status === "completed") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="size-3.5 shrink-0 text-ok-fg"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6.2" />
        <path
          d="m5.4 8.2 1.8 1.8 3.4-3.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="size-3.5 shrink-0 text-fg"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3.5 8h8m-3-3 3 3-3 3" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-fg-subtle"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.2" />
    </svg>
  );
}

const stepTextClasses: Record<PlanStepStatus, string> = {
  pending: "text-fg-subtle",
  in_progress: "text-fg",
  completed: "text-fg-subtle line-through",
};

/** 步骤行：三态图标 + 内容（完成项删除线），展开清单用 */
function StepRow(props: { step: PlanStep }) {
  const { step } = props;
  return (
    <div className="flex min-w-0 items-start gap-2 py-0.5">
      <span className="mt-0.5">
        <StepStatusIcon status={step.status} />
      </span>
      <span
        className={`min-w-0 break-words text-xs leading-5 ${stepTextClasses[step.status]}`}
      >
        {step.content}
      </span>
    </div>
  );
}

/** 工作计划类别图标（流内标记行 / 卡片头行用） */
function PlanIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={props.className ?? "size-3.5 shrink-0 text-fg-muted"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4h1.8M7 4h6.5M2.5 8h1.8M7 8h6.5M2.5 12h1.8M7 12h6.5" />
      <path d="m3.4 3.4 1 1 1.6-2" className="opacity-70" />
    </svg>
  );
}

/**
 * 流内极简标记行（ADR 0016）：update_plan 调用在消息流原位只留一行
 * 小字回看「当时更新到哪」，不占过程区空间（当前状态看进度折叠卡）。
 */
export function PlanMarkerRow(props: {
  snapshot: PlanSnapshot;
  index: number;
}) {
  const { snapshot, index } = props;
  const done = completedCount(snapshot.steps);
  const active = activeStep(snapshot.steps);
  return (
    <li
      data-testid="plan-marker-row"
      className="flex min-w-0 items-center gap-2 py-0.5 text-xs text-fg-subtle"
    >
      <span className="shrink-0 opacity-70">
        <PlanIcon className="size-3 shrink-0" />
      </span>
      <span className="shrink-0">计划更新 {index + 1}</span>
      <span className="shrink-0 font-mono">
        {done}/{snapshot.steps.length}
      </span>
      {active && (
        <span className="min-w-0 flex-1 truncate opacity-80">
          {active.content}
        </span>
      )}
    </li>
  );
}

/**
 * 工作计划进度折叠卡（ADR 0019）：内容 = 当前计划（最后一次 update_plan，
 * 全量替换语义）。无计划时渲染 null（挂载点不占布局行）。
 * 开合记忆作用域按归属参数化：主任务卡传 taskId（任务作用域）；子代理卡
 * 传 subagentId（ADR 0023，各子代理各自记忆、默认收起，与主任务记忆互不
 * 污染，键前缀对齐 collapse-memory 既有 subagent-* 命名）。
 */
export function WorkPlanCard(props: {
  items: PlanSnapshot[];
  taskId?: string | null;
  subagentId?: string | null;
}) {
  const { items, taskId, subagentId } = props;
  const { open, toggle } = useCollapseState(
    subagentId != null
      ? `subagent-plan-card-${subagentId}`
      : `plan-card-${taskId ?? "none"}`,
    false
  );
  const latest = items.at(-1);
  const steps = useMemo(() => latest?.steps ?? [], [latest]);

  if (steps.length === 0) return null;

  const done = completedCount(steps);
  const active = activeStep(steps);
  const allDone = done === steps.length;
  const pct = Math.round((done / steps.length) * 100);
  const next = steps.find((step) => step.status === "pending");

  return (
    <div
      data-testid="plan-card"
      className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm"
    >
      <button
        type="button"
        data-testid="plan-card-toggle"
        onClick={toggle}
        aria-expanded={open}
        aria-label={`工作计划 ${done}/${steps.length}（${pct}%）${allDone ? "，全部完成" : active ? `，当前：${active.content}` : ""}——轻点展开完整清单`}
        className="flex w-full min-w-0 flex-col gap-1 px-3 py-2 text-left hover:bg-hover"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <PlanIcon className="size-3.5 shrink-0 text-accent" />
          <span className="shrink-0 text-xs font-medium text-fg">工作计划</span>
          <span
            data-testid="plan-card-percent"
            className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent"
          >
            {pct}%
          </span>
          <span
            data-testid="plan-card-count"
            className="ml-auto shrink-0 font-mono text-xs text-fg-subtle"
          >
            {done}/{steps.length}
          </span>
          {/* 折叠箭头（消息区统一视觉基准） */}
          <DisclosureArrow open={open} />
        </span>
        {!open && (
          // 收起态预览：当前步骤 + 下一步（信息不展开也可读；全部完成只留一行）
          <span className="flex w-full min-w-0 flex-col gap-0.5">
            {active && !allDone && (
              <span
                data-testid="plan-card-current"
                className="flex min-w-0 items-start gap-2"
              >
                <span className="mt-0.5 shrink-0">
                  <StepStatusIcon status="in_progress" />
                </span>
                <span className="min-w-0 truncate text-xs text-fg">
                  {active.content}
                </span>
              </span>
            )}
            {next && (
              <span
                data-testid="plan-card-next"
                className="flex min-w-0 items-start gap-2"
              >
                <span className="mt-0.5 shrink-0">
                  <StepStatusIcon status="pending" />
                </span>
                <span className="min-w-0 truncate text-xs text-fg-subtle">
                  下一步：{next.content}
                </span>
              </span>
            )}
            {allDone && (
              <span data-testid="plan-card-done" className="text-xs text-ok-fg">
                全部完成
              </span>
            )}
          </span>
        )}
      </button>
      {open && (
        <div
          data-testid="plan-card-panel"
          className="max-h-72 overflow-y-auto border-t border-line px-3 py-1.5"
        >
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 便捷入口：由消息段序列收集快照后渲染卡（无计划时渲染 null） */
export function WorkPlanCardFromSegments(props: {
  items: import("../lib/task-view").MessageSegment[];
  taskId?: string | null;
}) {
  const snapshots = useMemo(
    () => collectPlanSnapshots(props.items),
    [props.items]
  );
  if (snapshots.length === 0) return null;
  return <WorkPlanCard items={snapshots} taskId={props.taskId} />;
}

/**
 * 子代理便捷入口（ADR 0023）：由子代理工具调用序列收集快照后渲染卡，
 * 开合记忆按 subagentId 作用域。任何详情状态常驻挂载——运行中随工具
 * 调用实时刷新（tools 逐次归并）、已完成回看终态、已中断回看最后快照；
 * 无计划渲染 null 不占布局行。
 */
export function WorkPlanCardFromSubagentTools(props: {
  tools: SubagentToolCall[];
  subagentId: string;
}) {
  const snapshots = useMemo(
    () => collectSubagentPlanSnapshots(props.tools),
    [props.tools]
  );
  if (snapshots.length === 0) return null;
  return <WorkPlanCard items={snapshots} subagentId={props.subagentId} />;
}
