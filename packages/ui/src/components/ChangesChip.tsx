import { useEffect, useState } from "react";
import type { GitStatus } from "@codexlike/agent-core";

/**
 * 改动摘要胶囊（消息区右上角）：原标题栏「改动」开关迁出后的入口，
 * 工作台视图恒在——无任务时禁用（原「无任务两面板不可用」语义），
 * 非 git 工作区不显示计数（降级说明由抽屉内的改动面板表达）。
 * 有任务时显示未提交变更文件数，点击打开右侧抽屉的 changes tab
 * （diff / 建分支 / 提交能力不变，抽屉内仍可切回「规范与技能」）。
 * 计数在任务切换与 refreshSignal 递增（一轮回答结束、面板关闭）后刷新。
 * 抽屉打开期间胶囊不渲染（覆盖区内无法交互，关闭与切 tab 走抽屉自带控件）。
 */
export function ChangesChip(props: {
  /** 当前任务 ID；null（草稿/未选任务）不拉取状态且入口禁用 */
  taskId: string | null;
  /** 递增信号：触发重新读取 git 状态（挂载与任务切换必刷） */
  refreshSignal?: number;
  onOpen: () => void;
}) {
  const { taskId, refreshSignal } = props;
  const [status, setStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
    if (taskId === null) {
      setStatus(null);
      return;
    }
    let active = true;
    setStatus(null);
    window.codexlike.git
      .status(taskId)
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setStatus(null);
      });
    return () => {
      active = false;
    };
  }, [taskId, refreshSignal]);

  const count = status?.isGitRepo === true ? status.files.length : null;
  return (
    <button
      type="button"
      data-testid="changes-toggle"
      disabled={taskId === null}
      aria-haspopup="dialog"
      title="查看工作区改动"
      onClick={props.onOpen}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-fg-muted shadow-sm hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
    >
      {/* 分支图标（git 工作区改动） */}
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="4.2" cy="3.8" r="1.8" />
        <circle cx="4.2" cy="12.2" r="1.8" />
        <circle cx="11.8" cy="3.8" r="1.8" />
        <path d="M4.2 5.6v4.8M11.8 5.6v1.1c0 2.1-1.7 3.2-3.6 3.2H6" />
      </svg>
      改动
      {count !== null && (
        <span
          data-testid="changes-chip-count"
          className={`font-mono ${count > 0 ? "" : "opacity-60"}`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
