/**
 * 工作计划常驻条（GLOSSARY「工作计划」，ADR 0016，原型 B 定稿）：
 * 消息流顶部 sticky 一条「当前计划」——图标 + 当前步骤 + N/M + 进度条，
 * 滚动到哪都可见；点击展开完整步骤面板。当前计划由段序列派生
 * （lib/plan-view），不依赖消息流渲染位置。
 *
 * 开合走 collapse-memory：默认收起（摘要行已含当前步骤与计数），key 带
 * 任务作用域（banner 是单例元素，全局 Map 需防跨任务串记忆）。
 */
import { useMemo } from "react";

import { useCollapseState } from "../lib/collapse-memory";
import {
  activeStep,
  collectPlanSnapshots,
  completedCount,
  type PlanSnapshot,
  type PlanStep,
  type PlanStepStatus,
} from "../lib/plan-view";

/**
 * 三态图标（ZCode 同构语义）：pending 空心圆最弱；in_progress 用**静态箭头**
 * ——计划条会长时间停留在页面上，spinner 暗示「加载中」而非「当前所在
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

/** 步骤行：三态图标 + 内容（完成项删除线） */
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

/** 水平进度条：完成占比（accent 填充），进行中不计入 */
function ProgressBar(props: { steps: PlanStep[] }) {
  const { steps } = props;
  const done = completedCount(steps);
  const percent =
    steps.length === 0 ? 0 : Math.round((done / steps.length) * 100);
  return (
    <div
      data-testid="plan-progress-bar"
      className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted"
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={steps.length}
    >
      <div
        className="h-full rounded-full bg-accent"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** 工作计划类别图标（常驻条与标记行共用） */
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
 * 小字回看「当时更新到哪」，不占过程区空间（当前状态看常驻条）。
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

/** 常驻计划条：消息流顶部 sticky，内容 = 当前计划（最后一次 update_plan） */
export function WorkPlanBanner(props: {
  items: PlanSnapshot[];
  taskId?: string | null;
  /** 内容列宽度类（与消息列/输入区同列对齐，见 lib/content-width） */
  className?: string;
}) {
  const { items } = props;
  const { open, toggle } = useCollapseState(
    `plan-banner-${props.taskId ?? "none"}`,
    false
  );
  const latest = items.at(-1);
  const steps = useMemo(() => latest?.steps ?? [], [latest]);

  if (steps.length === 0) return null;

  const done = completedCount(steps);
  const active = activeStep(steps);
  const allDone = done === steps.length;

  return (
    <div
      data-testid="plan-banner"
      // sticky 吸附消息流顶部；半透明画布底 + 模糊，滚过的内容从下面透出
      className={`sticky top-0 z-10 mb-3 rounded-lg border border-line bg-canvas/90 px-3 py-2 backdrop-blur-sm ${props.className ?? ""}`}
    >
      <button
        type="button"
        data-testid="plan-banner-toggle"
        className="flex w-full min-w-0 items-center gap-2 text-left"
        onClick={toggle}
        aria-expanded={open}
      >
        <PlanIcon className="size-4 shrink-0 text-accent" />
        <span className="shrink-0 text-xs font-medium text-fg">工作计划</span>
        {/* 当前步骤优先占位：滚动中一眼可见 agent 正在哪一步 */}
        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
          {allDone ? "全部完成" : active?.content}
        </span>
        <span
          data-testid="plan-banner-count"
          className="shrink-0 font-mono text-xs text-fg-subtle"
        >
          {done}/{steps.length}
        </span>
        <svg
          viewBox="0 0 16 16"
          className={`size-3.5 shrink-0 text-fg-subtle transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m4 6.5 4 4 4-4" />
        </svg>
      </button>
      {/* 进度条常驻（不随展开收起）：完成占比一目了然 */}
      <div className="mt-1.5 flex items-center gap-2">
        <ProgressBar steps={steps} />
        {allDone && (
          <span className="shrink-0">
            <StepStatusIcon status="completed" />
          </span>
        )}
      </div>

      {open && (
        <div
          data-testid="plan-banner-panel"
          className="mt-2 space-y-0.5 border-t border-line pt-2"
        >
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 便捷入口：由消息段序列收集快照后渲染常驻条（无计划时渲染 null） */
export function WorkPlanBannerFromSegments(props: {
  items: import("../lib/task-view").MessageSegment[];
  taskId?: string | null;
  className?: string;
}) {
  const snapshots = useMemo(
    () => collectPlanSnapshots(props.items),
    [props.items]
  );
  if (snapshots.length === 0) return null;
  return (
    <WorkPlanBanner
      items={snapshots}
      taskId={props.taskId}
      className={props.className}
    />
  );
}
