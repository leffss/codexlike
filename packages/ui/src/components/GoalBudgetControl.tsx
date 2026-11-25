import { useEffect, useRef, useState } from "react";
import { isGoalOpen, type GoalRecord } from "@codexlike/agent-core";

import { formatGoalTokens, parseGoalBudgetInput } from "../lib/goal-view";

/**
 * 预算变更入口：设定 / 调整任务的 token 预算，返回更新后的目标记录。
 * 缺省走 IPC（tasks.goalSetBudget）；更新后的目标快照由宿主经 goal-changed
 * 下发，进度行随之重渲——本组件不另存一份目标状态。
 */
export type GoalBudgetSetter = (
  taskId: string,
  tokens: number
) => Promise<GoalRecord>;

const setBudgetOverIpc: GoalBudgetSetter = (taskId, tokens) =>
  window.codexlike.tasks.goalSetBudget(taskId, tokens);

/**
 * 一键加预算的档位（在现有预算上累加）：预算受限后不必手敲新的总数，
 * 点一下即把预算抬到够再跑一段的高度。
 */
const QUICK_ADDS: readonly { label: string; tokens: number }[] = [
  { label: "+10 万", tokens: 100_000 },
  { label: "+50 万", tokens: 500_000 },
  { label: "+100 万", tokens: 1_000_000 },
];

/**
 * 目标进度行上的 token 预算控件（ADR 0035「护栏」，票 05）：用量 / 预算的显示
 * 与设置入口。预算是目标级参数（规格故事 13「给目标设定 token 预算」），不进
 * 执行设置——入口就在进度行上，「预算受限」态可直接加预算。
 * 独立组件：进度行只留一个挂载点；按钮组（暂停 / 恢复 / 编辑 / 清除）不在
 * 本组件内。用量取目标设定以来的任务用量增量（GLOSSARY「任务用量」）。
 */
export function GoalBudgetControl(props: {
  goal: GoalRecord;
  /** 目标设定以来的任务用量（tokens）：当前任务用量账目 − 目标基线 */
  spentTokens: number;
  /** 预算变更入口（测试注入；缺省走 IPC） */
  setBudget?: GoalBudgetSetter;
}) {
  const { goal, spentTokens } = props;
  const setBudget = props.setBudget ?? setBudgetOverIpc;
  const editable = isGoalOpen(goal.status);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点浮层外收起（mousedown 落在控件之外时；先例 = 过程胶囊条的浮层）
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // 已结束且从未设过预算：没有可看可改的，整个控件不占位（hook 不受早退影响)
  if (!editable && goal.budgetTokens === null) return null;

  const openEditor = () => {
    setDraft(goal.budgetTokens === null ? "" : String(goal.budgetTokens));
    setError(null);
    setOpen(true);
  };

  const submit = async (tokens: number) => {
    setSaving(true);
    setError(null);
    try {
      await setBudget(goal.taskId, tokens);
      setOpen(false);
    } catch (error) {
      // 失败原因留在浮层里：目标已结束 / 应用退出中 / 宿主校验——可修正后重试
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (draft.trim() === "") {
      setError("请输入 token 预算（正整数，单位 tokens）");
      return;
    }
    const tokens = parseGoalBudgetInput(draft);
    if (tokens === null) {
      setError("token 预算必须是正整数");
      return;
    }
    void submit(tokens);
  };

  const limit = goal.budgetTokens;
  const over = limit !== null && spentTokens >= limit;

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        data-testid="goal-budget-trigger"
        data-over={over ? "true" : undefined}
        aria-expanded={open}
        disabled={!editable}
        onClick={() => (open ? setOpen(false) : openEditor())}
        title={
          goal.budgetTokens === null
            ? "未设 token 预算（不限）。点击设置：目标用量达到预算后暂停为「预算受限」，可加预算后恢复"
            : `目标设定以来的任务用量（含子代理与压缩）${formatGoalTokens(spentTokens)} / token 预算 ${formatGoalTokens(goal.budgetTokens)}${editable ? "。点击调整预算" : ""}`
        }
        className={`shrink-0 font-mono tabular-nums ${
          over ? "text-warn-fg" : "text-fg-subtle"
        } ${
          editable
            ? "rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-fg disabled:opacity-50"
            : ""
        }`}
      >
        {goal.budgetTokens === null ? (
          "预算 不限"
        ) : (
          <>
            {"用量 "}
            <span data-testid="goal-budget-spent">
              {formatGoalTokens(spentTokens)}
            </span>
            {" / "}
            <span data-testid="goal-budget-limit">
              {formatGoalTokens(goal.budgetTokens)}
            </span>
          </>
        )}
      </button>
      {goal.status === "budget-limited" && (
        // 预算受限：恢复路径要一眼可见——醒目的「加预算」入口打开同一个浮层
        <button
          type="button"
          data-testid="goal-budget-add"
          aria-expanded={open}
          onClick={() => (open ? setOpen(false) : openEditor())}
          title="提高 token 预算（目标保持「预算受限」，加预算后由你恢复）"
          className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-on-accent hover:bg-accent-hover"
        >
          加预算
        </button>
      )}
      {open && (
        // 向上弹出的编辑浮层：右缘对齐入口（入口在行的右半段），不推挤布局；
        // 下方是输入区、上方消息流空间大（先例 = 过程胶囊条）
        <div
          data-testid="goal-budget-editor"
          role="dialog"
          aria-label="设置 token 预算"
          className="absolute bottom-full right-0 z-20 mb-1.5 w-72 rounded-[10px] border border-line bg-surface px-3 py-2 shadow-lg"
        >
          <div className="text-xs font-medium text-fg">token 预算</div>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              data-testid="goal-budget-input"
              type="number"
              min={1}
              step={1}
              autoFocus
              aria-label="token 预算"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  save();
                } else if (event.key === "Escape") {
                  setOpen(false);
                }
              }}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface-muted px-2 py-1 text-xs text-fg"
            />
            <button
              type="button"
              data-testid="goal-budget-save"
              disabled={saving}
              onClick={save}
              className="shrink-0 rounded-md bg-accent px-2 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              保存
            </button>
            <button
              type="button"
              data-testid="goal-budget-cancel"
              disabled={saving}
              onClick={() => setOpen(false)}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-hover hover:text-fg"
            >
              取消
            </button>
          </div>
          {limit !== null && (
            // 已有预算：可在现有预算上一键累加（预算受限后的加预算不必手敲总数）
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="shrink-0 text-[11px] text-fg-subtle">
                加预算
              </span>
              {QUICK_ADDS.map((option) => (
                <button
                  key={option.tokens}
                  type="button"
                  data-testid="goal-budget-quick-add"
                  disabled={saving}
                  title={`预算增加 ${formatGoalTokens(option.tokens)} tokens`}
                  onClick={() => void submit(limit + option.tokens)}
                  className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <p className="mt-1.5 text-[11px] leading-4 text-fg-subtle">
            目标用量（任务用量，含子代理与压缩）达到预算后暂停为「预算受限」，加预算后可恢复。
          </p>
          {error !== null && (
            <p
              role="alert"
              data-testid="goal-budget-error"
              className="mt-1.5 text-xs text-warn-fg"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
