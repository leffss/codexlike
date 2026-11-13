import type { DragEvent, ReactNode } from "react";

import type { QueuedMessage, QueueSnapshot } from "@codexlike/desktop/ipc";
import { EMPTY_QUEUE_STATE } from "../lib/live-task";

/** 队列条最多直接预览的条目数：超过折叠为「+N 更多」（spec 用户故事 4） */
const PREVIEW_LIMIT = 5;

/** 单条预览取首行并截断：队列条是紧凑摘要，全文由取回编辑入口承载。 */
function previewText(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

/** 拖拽负载只用条目 id：不携带文本，避免跨组件意外注入内容。 */
const DRAG_PAYLOAD = "application/x-codexlike-queue-item";

/**
 * 输入框上缘的紧凑队列条（票 01/02/03）：显示当前会话排队消息的预览与条数。
 * - 不进入消息流（ADR 0013：渲染层只呈现）；
 * - 超过 5 条折叠为「+N 更多」；
 * - 队列暂停（票 02，停止保留队列）：显示「已暂停」并提供「恢复」「清空」；
 * - 单条删除（票 03）：立即作废，不参与消费；
 * - 点击预览取回编辑（票 03）：载入输入框，保存原地更新；编辑中的条目
 *   显示「编辑中」与「取消」（取消保留条目原文并还原输入框草稿）；
 * - 拖拽重排（票 03）：拖柄拖到目标行之前，顺序即时生效并持久化；
 * - 正在发出的条目（票 03，spec 用户故事 25）：区别显示且锁定——
 *   无删除/取回编辑/拖拽入口，也不作为重排目标（主进程同步强制）。
 */
export function QueueBar(props: {
  /** 队列状态快照（review 重构收拢三元组）：排队条目 + 暂停标志 + 正在发出条目 */
  queueState?: QueueSnapshot;
  /** 编辑中的条目 id（票 03）：高亮并显示取消入口 */
  editingItemId?: string | null;
  /** 手动恢复：清暂停标志并立即继续消费 */
  onResume?: () => void;
  /** 清空：作废全部排队消息 */
  onClear?: () => void;
  /** 删除单条排队消息（票 03） */
  onRemove?: (itemId: string) => void;
  /** 点击预览取回编辑（票 03）：内容载入输入框 */
  onEditItem?: (item: QueuedMessage) => void;
  /** 拖拽重排（票 03）：提交仍在排队条目的完整新顺序 */
  onReorder?: (orderedIds: string[]) => void;
  /** 取消编辑（票 03）：条目原样保留，输入框还原先前草稿 */
  onCancelEdit?: () => void;
}) {
  const { queueState = EMPTY_QUEUE_STATE } = props;
  const { queue, paused, sendingId: sendingItemId } = queueState;
  const editingItemId = props.editingItemId ?? null;
  if (queue.length === 0) return null;
  const visible = queue.slice(0, PREVIEW_LIMIT);
  const hidden = queue.length - visible.length;
  // 计数口径（review 修复）：排队计数「待发 N」不含正在发出（inflight）的条目；
  // inflight 在下方以锁定态展示并单独标注「发送中」。
  const waitingCount = queue.filter((item) => item.id !== sendingItemId).length;
  const sending =
    sendingItemId !== null && queue.some((item) => item.id === sendingItemId);

  function handleDrop(event: DragEvent<HTMLLIElement>, target: QueuedMessage) {
    const draggedId = event.dataTransfer.getData(DRAG_PAYLOAD);
    if (!draggedId || draggedId === target.id) return;
    if (draggedId === sendingItemId || target.id === sendingItemId) return;
    // 重排只作用于仍在排队的条目：正在发出的条目留在原位（已锁定）
    const ids = queue
      .filter((item) => item.id !== sendingItemId)
      .map((item) => item.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(target.id);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, draggedId);
    props.onReorder?.(ids);
  }

  function row(item: QueuedMessage): ReactNode {
    const sending = item.id === sendingItemId;
    const editing = item.id === editingItemId;
    if (sending) {
      return (
        <li
          key={item.id}
          data-testid="queue-item"
          data-item-id={item.id}
          className="flex items-center gap-2"
          aria-label={`发送中：${previewText(item.text)}`}
        >
          <div
            data-testid="queue-item-sending"
            className="flex min-w-0 flex-1 items-center gap-2"
            title={`${item.text}（已取出发送，锁定不可操作）`}
          >
            <span className="min-w-0 flex-1 truncate">
              {previewText(item.text)}
            </span>
            <span
              data-testid="queue-item-sending-badge"
              className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-fg"
            >
              发送中
            </span>
          </div>
        </li>
      );
    }
    return (
      <li
        key={item.id}
        data-testid="queue-item"
        data-item-id={item.id}
        className="flex items-center gap-2"
        onDragOver={(event) => {
          if (item.id !== sendingItemId) event.preventDefault();
        }}
        onDrop={(event) => handleDrop(event, item)}
      >
        <span
          data-testid="queue-item-drag"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(DRAG_PAYLOAD, item.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          className="shrink-0 cursor-grab select-none text-fg-subtle"
          title="拖动调整发送顺序"
          aria-label={`拖动重排：${previewText(item.text)}`}
        >
          ⋮⋮
        </span>
        <button
          type="button"
          data-testid="queue-item-preview"
          onClick={() => props.onEditItem?.(item)}
          title={`${item.text}（点击取回输入框编辑，保存原地更新）`}
          className={`min-w-0 flex-1 truncate text-left hover:text-fg ${
            editing ? "font-medium text-accent-fg" : ""
          }`}
        >
          {previewText(item.text)}
        </button>
        {editing && (
          <>
            <span
              data-testid="queue-item-editing"
              className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-fg"
            >
              编辑中
            </span>
            <button
              type="button"
              data-testid="queue-item-cancel-edit"
              onClick={() => props.onCancelEdit?.()}
              className="shrink-0 rounded-md border border-line px-1.5 py-0.5 hover:bg-hover"
              title="取消编辑：条目原样保留，输入框还原先前草稿"
            >
              取消
            </button>
          </>
        )}
        <button
          type="button"
          data-testid="queue-item-remove"
          onClick={() => props.onRemove?.(item.id)}
          className="shrink-0 rounded px-1.5 py-0.5 hover:bg-hover hover:text-danger-fg"
          aria-label={`删除排队消息：${previewText(item.text)}`}
          title="删除：立即作废，不会被发送"
        >
          删除
        </button>
      </li>
    );
  }

  return (
    <div
      data-testid="queue-bar"
      className="mb-2 rounded-xl border border-line bg-surface px-3 py-2 text-xs text-fg-muted"
      aria-label={
        paused
          ? `输入队列 待发 ${waitingCount} 条，已暂停`
          : `输入队列 待发 ${waitingCount} 条`
      }
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium text-fg">输入队列</span>
        <span data-testid="queue-count" className="tabular-nums">
          待发 {waitingCount} 条
        </span>
        {sending && (
          <span data-testid="queue-sending-count" className="text-fg-subtle">
            1 条发送中
          </span>
        )}
        {paused && (
          <span
            data-testid="queue-paused"
            className="rounded-full bg-warn-bg px-1.5 py-0.5 text-[11px] font-medium text-warn-fg"
          >
            已暂停
          </span>
        )}
        {paused && (
          <span className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              data-testid="queue-resume"
              onClick={() => props.onResume?.()}
              className="rounded-md border border-line px-2 py-0.5 font-medium text-fg hover:bg-hover"
              title="恢复：从队首继续逐条自动发送"
            >
              恢复
            </button>
            <button
              type="button"
              data-testid="queue-clear"
              onClick={() => props.onClear?.()}
              className="rounded-md border border-line px-2 py-0.5 text-fg-muted hover:bg-hover hover:text-danger-fg"
              title="清空：作废全部排队消息"
            >
              清空
            </button>
          </span>
        )}
      </div>
      <ul className="space-y-0.5">{visible.map((item) => row(item))}</ul>
      {hidden > 0 && (
        <div data-testid="queue-more" className="mt-1 text-fg-subtle">
          +{hidden} 更多
        </div>
      )}
    </div>
  );
}
