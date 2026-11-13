import type {
  LaunchBounds,
  LaunchState,
  LaunchStateStore,
} from "./launch-state-store";

/**
 * 窗口现场保存（票02）：主进程监听窗口事件，把启动现场持续写入 store。
 * - move/resize 结束后防抖合并（约 500ms）落盘——拖动期间不产生高频写盘；
 * - maximize/unmaximize 切换后立即写入 maximized 标志（低频事件不防抖）；
 * - bounds 始终记录正常态尺寸（getNormalBounds 语义），最大化期间不把
 *   全屏尺寸写进 bounds；
 * - 退出屏障在退出前调用 flush()，把防抖中未落盘的变化刷出（写盘本身
 *   同步完成，flush 返回即已落盘）；崩溃/被杀场景由已过防抖期的写盘天然覆盖。
 * 命名避开 WindowState——该词已被运行时最大化标志（shared/ipc.ts）占用。
 */

/** move/resize 结束后的防抖窗口期（票面：约 500ms） */
export const LAUNCH_STATE_SAVE_DEBOUNCE_MS = 500;

/**
 * 可注入的窗口事件源：主进程监听所需的最小 BrowserWindow 结构
 * （结构兼容 Electron BrowserWindow；单测注入假窗口驱动事件）。
 */
export interface LaunchStateWindow {
  on(
    event: "move" | "resize" | "maximize" | "unmaximize" | "closed",
    listener: () => void
  ): unknown;
  removeListener(
    event: "move" | "resize" | "maximize" | "unmaximize" | "closed",
    listener: () => void
  ): unknown;
  isDestroyed(): boolean;
  isMaximized(): boolean;
  /** 正常态 bounds：最大化期间返回还原后的 bounds */
  getNormalBounds(): LaunchBounds;
}

/** 跟踪句柄：退出屏障 flush；closed 事件自动 dispose，也可显式调用 */
export interface LaunchStateTracking {
  flush(): void;
  dispose(): void;
}

export function trackWindowLaunchState(options: {
  win: LaunchStateWindow;
  store: LaunchStateStore;
  /** 防抖窗口期，省略用 LAUNCH_STATE_SAVE_DEBOUNCE_MS */
  debounceMs?: number;
}): LaunchStateTracking {
  const { win, store } = options;
  const debounceMs = options.debounceMs ?? LAUNCH_STATE_SAVE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 读当前完整现场（正常态 bounds + 是否最大化）写盘；先取消挂起的防抖写 */
  function saveNow(): void {
    cancelTimer();
    if (win.isDestroyed()) return;
    const state: LaunchState = {
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
    };
    void store.set(state).catch((error: unknown) => {
      // 写盘失败不拖垮主进程；下次窗口事件会再尝试
      console.error("[launch-state] 保存失败：", error);
    });
  }

  function scheduleSave(): void {
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      saveNow();
    }, debounceMs);
  }

  win.on("move", scheduleSave);
  win.on("resize", scheduleSave);
  win.on("maximize", saveNow);
  win.on("unmaximize", saveNow);
  win.on("closed", dispose);

  function dispose(): void {
    cancelTimer();
    win.removeListener("move", scheduleSave);
    win.removeListener("resize", scheduleSave);
    win.removeListener("maximize", saveNow);
    win.removeListener("unmaximize", saveNow);
    win.removeListener("closed", dispose);
  }

  return {
    /** 把防抖中未落盘的变化立即刷出（无挂起变化则不写） */
    flush() {
      if (timer === null) return;
      saveNow();
    },
    dispose,
  };
}
