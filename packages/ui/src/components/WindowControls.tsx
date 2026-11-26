import type { CodexLikeApi, WindowState } from "@codexlike/desktop/ipc";

export function WindowControls(props: {
  api: CodexLikeApi["windowControls"] | undefined;
  state: WindowState;
  /**
   * 紧凑档：窗口按钮落进消息卡首行 / 右栏首行（行高更矮），与 26px 图标
   * 按钮对齐；设置顶栏用默认档。
   */
  compact?: boolean;
}) {
  const api = props.api;
  if (!api) return null;
  const buttonClass = `window-no-drag flex ${
    props.compact ? "h-7 w-8" : "h-8 w-9"
  } shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent`;
  // 窗口可能已销毁；失败不猜测本地状态，关闭流程仍由主进程负责。
  async function request(action: () => Promise<void>) {
    try {
      await action();
    } catch {
      // 保留最近一次主进程状态，避免未处理的 IPC rejection。
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        data-testid="window-minimize"
        aria-label="最小化"
        title="最小化"
        onClick={() => request(() => api.minimize())}
        className={buttonClass}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M2 8h12" />
        </svg>
      </button>
      <button
        type="button"
        data-testid="window-maximize"
        aria-label={props.state.maximized ? "还原" : "最大化"}
        title={props.state.maximized ? "还原" : "最大化"}
        onClick={() => request(() => api.toggleMaximize())}
        className={buttonClass}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          {props.state.maximized ? (
            <path d="M5.5 5.5v-3h8v8h-3M2.5 5.5h8v8h-8z" />
          ) : (
            <rect x="2.5" y="2.5" width="11" height="11" />
          )}
        </svg>
      </button>
      <button
        type="button"
        data-testid="window-close"
        aria-label="关闭"
        title="关闭"
        onClick={() => request(() => api.close())}
        className={buttonClass}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="m3 3 10 10M13 3 3 13" />
        </svg>
      </button>
    </div>
  );
}
