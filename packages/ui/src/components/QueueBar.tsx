import type { QueuedMessage } from "@codexlike/desktop/ipc";

/** 队列条最多直接预览的条目数：超过折叠为「+N 更多」（spec 用户故事 4） */
const PREVIEW_LIMIT = 5;

/** 单条预览取首行并截断：队列条是紧凑摘要，全文由后续票的编辑入口承载。 */
function previewText(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

/**
 * 输入框上缘的只读队列条（票 01）：显示当前会话排队消息的预览与条数。
 * - 不进入消息流（ADR 0013：渲染层只呈现）；
 * - 超过 5 条折叠为「+N 更多」；
 * - 编辑 / 删除 / 重排等操作由票 03 在此组件上扩展。
 */
export function QueueBar(props: { queue: QueuedMessage[] }) {
  const { queue } = props;
  if (queue.length === 0) return null;
  const visible = queue.slice(0, PREVIEW_LIMIT);
  const hidden = queue.length - visible.length;
  return (
    <div
      data-testid="queue-bar"
      className="mb-2 rounded-xl border border-line bg-surface px-3 py-2 text-xs text-fg-muted"
      aria-label={`输入队列 ${queue.length} 条`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium text-fg">输入队列</span>
        <span data-testid="queue-count" className="tabular-nums">
          {queue.length} 条
        </span>
      </div>
      <ul className="space-y-0.5">
        {visible.map((item) => (
          <li
            key={item.id}
            data-testid="queue-item-preview"
            className="truncate"
            title={item.text}
          >
            {previewText(item.text)}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <div data-testid="queue-more" className="mt-1 text-fg-subtle">
          +{hidden} 更多
        </div>
      )}
    </div>
  );
}
