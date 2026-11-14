/**
 * toast 管理器（票02）：渲染层内存态提示队列，不持久化。
 * 触发方（状态同步 effect）与展示方（ToastHost）经此解耦：
 * show 幂等 upsert、dismiss 手动关闭、retract 随状态消失移除。
 */

export type ToastKind = "error" | "warn" | "info";

export interface ToastAction {
  /** 操作按钮定位器（先例：task-auto-approve-revoke） */
  testId: string;
  label: string;
  disabled?: boolean;
  onAction: () => void;
}

/** 单条 toast 的内容（触发方提供；展示方只读渲染） */
export interface ToastContent {
  kind: ToastKind;
  /** 主文案 */
  content: string;
  /** 次要说明段（如自动批准的撤销后果） */
  detail?: string;
  /** 主文案定位器（共享提示的 warning/error 子定位） */
  contentTestId?: string;
  /** 内联操作（如「取消自动批准」按钮） */
  action?: ToastAction;
  /** 操作失败提示段（role=alert，如撤销失败原因） */
  actionError?: string;
}

export interface ToastEntry extends ToastContent {
  /** 条目标识（沿用被删除横条的 testid，e2e 断言不变） */
  id: string;
  /** 内容指纹：手动关闭只对同一内容生效，内容变化视为新提示 */
  key: string;
}

export function createToastManager() {
  const entries = new Map<string, ToastEntry>();
  const dismissedKeys = new Set<string>();
  const listeners = new Set<() => void>();
  let revision = 0;
  function notify() {
    revision += 1;
    for (const listener of listeners) listener();
  }
  const entryKey = (id: string, content: string) => `${id}\n${content}`;
  return {
    /** 幂等 upsert：同 testId 更新内容保持堆叠位置；已手动关闭的同内容不复活 */
    show(id: string, toast: ToastContent) {
      const key = entryKey(id, toast.content);
      const previous = entries.get(id);
      if (previous) {
        if (
          previous.key === key &&
          previous.kind === toast.kind &&
          previous.detail === toast.detail &&
          previous.contentTestId === toast.contentTestId &&
          previous.actionError === toast.actionError &&
          previous.action?.label === toast.action?.label &&
          previous.action?.disabled === toast.action?.disabled
        )
          return;
        entries.set(id, { id, key, ...toast });
        notify();
        return;
      }
      if (dismissedKeys.has(key)) return;
      entries.set(id, { id, key, ...toast });
      notify();
    },
    /** 手动关闭：移除并记录内容指纹；状态持续期间同内容不再自动复活 */
    dismiss(id: string) {
      const previous = entries.get(id);
      if (!previous) return;
      dismissedKeys.add(previous.key);
      entries.delete(id);
      notify();
    },
    /**
     * 状态消失：无条件移除，并解除该条目的已确认记录（状态重现须重新可见）。
     * dismissed 记录以 entryKey 的 `${id}\n${content}` 为键：retract 按同一
     * 前缀扫描清除该条目的全部内容变体，`\n` 分隔保证不同 id 的前缀不互混。
     */
    retract(id: string) {
      let removed = false;
      for (const key of [...dismissedKeys]) {
        if (key.startsWith(`${id}\n`)) {
          dismissedKeys.delete(key);
          removed = true;
        }
      }
      if (entries.delete(id)) removed = true;
      if (removed) notify();
    },
    /** 展示快照（插入序即堆叠序） */
    toasts(): ToastEntry[] {
      return [...entries.values()];
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => revision,
  };
}

export type ToastManager = ReturnType<typeof createToastManager>;
