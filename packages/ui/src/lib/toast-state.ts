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

/** 一次性反馈的自动消失延迟（ADR 0030：本地命令反馈 info 类约 6 秒） */
const FEEDBACK_TTL_MS = 6000;

export function createToastManager() {
  const entries = new Map<string, ToastEntry>();
  const dismissedKeys = new Set<string>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  let revision = 0;
  function notify() {
    revision += 1;
    for (const listener of listeners) listener();
  }
  const entryKey = (id: string, content: string) => `${id}\n${content}`;
  function clearExpiry(id: string) {
    const timer = expiryTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      expiryTimers.delete(id);
    }
  }
  return {
    /** 一次性反馈（ADR 0030）：无条件 upsert——重复执行同命令是新事件，不受
     *  dismissedKeys 约束；info 类约 6 秒自动消失（被顶替则计时从头算），
     *  warn/error 常驻直到手动关闭。 */
    flash(id: string, toast: ToastContent) {
      clearExpiry(id);
      entries.set(id, { id, key: entryKey(id, toast.content), ...toast });
      if (toast.kind === "info") {
        expiryTimers.set(
          id,
          setTimeout(() => {
            expiryTimers.delete(id);
            if (entries.delete(id)) notify();
          }, FEEDBACK_TTL_MS)
        );
      }
      notify();
    },
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
    /** 手动关闭：移除并记录内容指纹；状态持续期间同内容不再自动复活
     *  （flash 条目不查该表，指纹残留无影响）；到期定时器一并清理 */
    dismiss(id: string) {
      clearExpiry(id);
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
      clearExpiry(id);
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
