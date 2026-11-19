/**
 * 「回到最新」悬浮回底按钮（票 03 滚动跟随语汇的入口件）：脱离跟随时
 * 可见，点击贴底并恢复跟随。主代理消息流（back-to-latest）与子代理详情
 * （subagent-back-to-latest）共用同一视觉与交互——两容器可能同屏共存，
 * testid 经 props 区分，e2e 定位不串。
 */
export function BackToLatestButton(props: {
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-label="回到最新"
      title="回到最新"
      onClick={props.onClick}
      className="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-fg-muted shadow-floating hover:border-fg/30 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 5v14m-6-6 6 6 6-6" />
      </svg>
    </button>
  );
}
