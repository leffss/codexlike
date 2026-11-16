/**
 * 任务内顶部排队状态条（任务并发上限票 03 / ADR 0022）：当前任务因全局
 * 并发满员进入应用级任务排队、尚未开跑时提示等待原因与当前运行数；
 * 开跑（或出队回空闲）后由父层随排队态卸载，组件只管呈现。
 */
export function TaskQueuedNotice(props: { runningCount: number }) {
  return (
    <div
      data-testid="task-queued-notice"
      role="status"
      // 弱提示（弱于运行中的 accent 转圈、强于无状态）：静态时钟 + muted 色
      className="flex items-center gap-2 text-xs text-fg-muted"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        aria-hidden="true"
        className="shrink-0"
      >
        {/* 静态时钟（与侧栏排队徽章同形）：等待空位开跑，不转圈 */}
        <circle cx="6" cy="6" r="4.5" />
        <path d="M6 3.8V6l1.4 1.4" />
      </svg>
      <span className="tabular-nums">
        排队中（并发已满，{props.runningCount} 个任务运行中）
      </span>
    </div>
  );
}
