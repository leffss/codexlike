import { useState } from "react";
import {
  GOAL_TEXT_MAX_LENGTH,
  type GoalRecord,
  type GoalStatus,
} from "@codexlike/agent-core";

import { GoalBudgetControl } from "./GoalBudgetControl";
import {
  formatGoalElapsed,
  goalControls,
  goalElapsedMs,
  goalStatusText,
  goalSummary,
} from "../lib/goal-view";
import { useTickingNow } from "../lib/use-ticking-now";

/** 状态色：进行中主张色、已完成成功色、暂停类警示色、已清除弱化（已清除时整行退场，不渲染） */
const STATUS_CLASSES: Record<GoalStatus, string> = {
  active: "text-accent",
  completed: "text-ok-fg",
  paused: "text-warn-fg",
  unmet: "text-warn-fg",
  "budget-limited": "text-warn-fg",
  cleared: "text-fg-subtle",
};

/**
 * 控制面四个操作（票 04，ADR 0035「控制面」）的回调。进度行只负责按六态给出
 * 可用性并在点击时通知，状态推进全部由宿主完成：
 * - 暂停与停止按钮同一语义（Stop = 暂停），宿主走同一通道；
 * - onSaveEdit 以编辑框的文本调用：resolve = 已保存（编辑态收起）；reject =
 *   失败（编辑态保持、文本不丢，原因由调用方以本地命令反馈呈现）。
 * busy：操作进行中，按钮组整体禁用，防止重复提交。
 */
export interface GoalControlsHandlers {
  onPause: () => void;
  onResume: () => void;
  onSaveEdit: (text: string) => Promise<void>;
  onClear: () => void;
  busy?: boolean;
}

const CONTROL_CLASS =
  "rounded-md px-2 py-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 disabled:hover:bg-transparent";

/** 目标图标：同心圆靶（线条对齐 D 设计语言，size-3 与工具名徽章同语汇） */
function GoalIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * 目标进度行（ADR 0035，GLOSSARY「目标」）：输入框上方常驻的一行——目标
 * 摘要、状态（六态称谓；完成判定在途时显示副状态「验证中」）、累计时长、
 * 停留原因（因完成判定连续不可用而暂停、护栏阻断为未达成 / 预算受限时写明）、
 * token 预算控件（用量 / 预算的显示与设置，独立组件 GoalBudgetControl），以及
 * 控制面按钮组（暂停 / 恢复 / 编辑 / 清除，按六态给出可用性，见 goalControls）。
 * 进行中时长达实时跳动，离开进行中（已暂停 / 已完成等）即定格。
 * 没有目标、或目标已清除时不占布局行（空态）——清除即进度行退场，任务
 * 回到普通对话形态。
 */
export function GoalProgressRow(props: {
  goal: GoalRecord | null;
  /** 完成判定在途（宿主活动态的 goalPhase = verifying）：状态显示「验证中」 */
  verifying?: boolean;
  /** 停留原因说明（goalPauseReason 给出；没有可说明的原因时不渲染） */
  pauseReason?: string | null;
  /**
   * 目标设定以来的任务用量（tokens）：预算控件的用量显示。
   * = 当前任务用量账目 − 目标基线（goalSpentTokens），由宿主的任务列表给出。
   */
  spentTokens?: number;
  /**
   * 控制面回调（票 04）：缺省时只读呈现、不渲染按钮组（如已归档的任务——
   * 目标操作都要求任务未归档）。
   */
  controls?: GoalControlsHandlers;
}) {
  const { goal } = props;
  const verifying = props.verifying === true;
  // Hook 不受早退影响：是否计时由「目标进行中」决定，空态不起计时器
  const now = useTickingNow(goal?.status === "active");
  /** 编辑态：null = 未在编辑；字符串 = 编辑框里的草稿 */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (goal === null || goal.status === "cleared") return null;

  const handlers = props.controls;
  const controls = goalControls(goal);
  const busy = handlers?.busy === true;

  // 箭头函数（非函数声明）：goal 的非空收窄才能带进闭包
  const save = async () => {
    if (handlers === undefined || saving || draft === null) return;
    const text = draft.trim();
    if (text === "") return;
    // 文本未改动：直接收起编辑态，不发起保存
    if (text === goal.text) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      await handlers.onSaveEdit(draft);
      setDraft(null);
    } catch {
      // 保存被拒：编辑态保持、文本不丢（可修正后重试）；原因由调用方呈现
    } finally {
      setSaving(false);
    }
  };

  // 状态与时长在编辑态照常可见（改文本时看得到目标处于什么状态）
  const statusAndElapsed = (
    <>
      <span
        data-testid="goal-progress-status"
        className={`shrink-0 font-medium ${STATUS_CLASSES[goal.status]}`}
      >
        {goalStatusText(goal, verifying)}
      </span>
      <span
        data-testid="goal-progress-elapsed"
        className="shrink-0 font-mono text-fg-subtle"
        title="累计时长"
      >
        {formatGoalElapsed(goalElapsedMs(goal, now))}
      </span>
    </>
  );

  // token 预算控件（票 05 护栏）：独立组件，行上只有这一个挂载点。位置在只读的
  // 状态播报区之外、按钮组之前（live region 不含可聚焦控件）；编辑态同样保留
  // （预算受限时改目标文本与加预算是并行的两件事）
  const budget = (
    <GoalBudgetControl goal={goal} spentTokens={props.spentTokens ?? 0} />
  );

  return (
    <div
      data-testid="goal-progress-row"
      data-goal-status={goal.status}
      data-goal-phase={verifying ? "verifying" : undefined}
      // 卡片内距与工具卡（ToolCallCard）统一：px-3.5 py-[9px]（D 语言折叠摘要行基准）
      className="flex items-center gap-2 rounded-lg bg-surface-muted px-3.5 py-[9px] text-xs text-fg-muted"
    >
      {draft !== null ? (
        <>
          <div
            data-testid="goal-edit-form"
            className="flex min-w-0 flex-1 flex-col gap-2"
          >
            <span className="flex items-center gap-2">
              <GoalIcon />
              <span className="shrink-0 font-medium text-fg">目标</span>
              <span className="min-w-0 flex-1 truncate text-fg-subtle">
                修改目标文本：下一次完成判定按新文本进行，逐轮验证记录保留
              </span>
              {statusAndElapsed}
            </span>
            <textarea
              data-testid="goal-edit-input"
              aria-label="目标文本"
              autoFocus
              rows={3}
              value={draft}
              maxLength={GOAL_TEXT_MAX_LENGTH}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Esc 取消；Ctrl/⌘+Enter 保存（Enter 留给换行：目标可多行）
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(null);
                } else if (
                  event.key === "Enter" &&
                  (event.ctrlKey || event.metaKey)
                ) {
                  event.preventDefault();
                  void save();
                }
              }}
              className="w-full resize-y rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
            />
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                data-testid="goal-edit-cancel"
                disabled={saving}
                onClick={() => setDraft(null)}
                className={CONTROL_CLASS}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="goal-edit-save"
                disabled={saving || draft.trim() === ""}
                onClick={() => void save()}
                className="rounded-md bg-accent px-2.5 py-0.5 font-medium text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:bg-hover disabled:text-fg-subtle"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
          {budget}
        </>
      ) : (
        <>
          {/* 状态播报区只包住只读信息；预算控件与按钮组在它之外（live region 不含可聚焦控件） */}
          <span
            role="status"
            aria-label="目标进度"
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <GoalIcon />
            <span className="shrink-0 font-medium text-fg">目标</span>
            <span
              data-testid="goal-progress-summary"
              className="min-w-0 flex-1 truncate text-fg"
              title={goal.text}
            >
              {goalSummary(goal.text)}
            </span>
            {props.pauseReason !== null && props.pauseReason !== undefined && (
              <span
                data-testid="goal-progress-reason"
                className="shrink-0 text-warn-fg"
                title={props.pauseReason}
              >
                {props.pauseReason}
              </span>
            )}
            {statusAndElapsed}
          </span>
          {budget}
          {handlers !== undefined && (
            <span
              data-testid="goal-controls"
              className="flex shrink-0 items-center gap-0.5"
            >
              {controls.pause && (
                <button
                  type="button"
                  data-testid="goal-pause"
                  disabled={busy}
                  onClick={handlers.onPause}
                  title="暂停：停止续跑，累计时长定格；可随时恢复（与停止按钮等效）"
                  className={`${CONTROL_CLASS} font-medium text-fg`}
                >
                  暂停
                </button>
              )}
              {controls.resume && (
                <button
                  type="button"
                  data-testid="goal-resume"
                  disabled={busy}
                  onClick={handlers.onResume}
                  title="恢复：从暂停点继续推进，累计时长与验证记录延续"
                  className={`${CONTROL_CLASS} font-medium text-fg`}
                >
                  恢复
                </button>
              )}
              <button
                type="button"
                data-testid="goal-edit"
                disabled={!controls.edit || busy}
                onClick={() => setDraft(goal.text)}
                title={
                  goal.status === "active"
                    ? "进行中不能编辑目标：请先暂停目标"
                    : goal.status === "completed"
                      ? "目标已完成，文本不再修改"
                      : "编辑目标文本：下一次完成判定按新文本进行，逐轮验证记录保留"
                }
                className={`${CONTROL_CLASS} text-fg-muted hover:text-fg`}
              >
                编辑
              </button>
              <button
                type="button"
                data-testid="goal-clear"
                disabled={!controls.clear || busy}
                onClick={handlers.onClear}
                title="清除：移除目标，任务回到普通对话；逐轮验证记录仍可回看"
                className={`${CONTROL_CLASS} text-fg-muted hover:text-danger-fg`}
              >
                清除
              </button>
            </span>
          )}
        </>
      )}
    </div>
  );
}
