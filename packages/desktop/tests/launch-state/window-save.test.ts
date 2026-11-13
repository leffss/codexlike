import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLaunchStateStore,
  type LaunchState,
  type LaunchStateStore,
} from "../../src/launch-state/launch-state-store";
import {
  LAUNCH_STATE_SAVE_DEBOUNCE_MS,
  trackWindowLaunchState,
  type LaunchStateWindow,
} from "../../src/launch-state/window-save";

/**
 * 窗口现场保存（票02）：主进程监听窗口事件防抖落盘（接缝=可注入窗口事件源 +
 * 启动现场 store + 假计时器）。窗口事件保存链路不放 e2e（CI 无显示器驱动不可靠），
 * 这里覆盖防抖合并、maximize 状态记录、退出 flush。bounds 始终取 getNormalBounds()
 * （正常态尺寸），最大化期间不把全屏尺寸写进 bounds。
 */

type WindowEvent = Parameters<LaunchStateWindow["on"]>[0];

/** 假窗口（可注入事件源）：bounds 字段即正常态 bounds——最大化期间
 * getNormalBounds() 仍返回它（Electron getNormalBounds 语义）。 */
class FakeWindow implements LaunchStateWindow {
  private emitter = new EventEmitter();
  maximized = false;
  destroyed = false;
  private bounds = { x: 100, y: 80, width: 900, height: 640 };

  on(event: WindowEvent, listener: () => void): unknown {
    this.emitter.on(event, listener);
    return this;
  }
  removeListener(event: WindowEvent, listener: () => void): unknown {
    this.emitter.removeListener(event, listener);
    return this;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMaximized(): boolean {
    return this.maximized;
  }
  getNormalBounds() {
    return { ...this.bounds };
  }

  // —— 测试驱动：每个操作只发自己那一个事件（连带序列由测试显式组合）——
  moveTo(x: number, y: number): void {
    this.bounds = { ...this.bounds, x, y };
    this.emitter.emit("move");
  }
  resizeTo(width: number, height: number): void {
    this.bounds = { ...this.bounds, width, height };
    this.emitter.emit("resize");
  }
  maximize(): void {
    this.maximized = true;
    this.emitter.emit("maximize");
  }
  unmaximize(): void {
    this.maximized = false;
    this.emitter.emit("unmaximize");
  }
  /** 原始事件触发（模拟只发事件不改变几何的场景，如最大化期间的 resize） */
  fire(event: WindowEvent): void {
    this.emitter.emit(event);
  }
  destroy(): void {
    this.destroyed = true;
    this.emitter.emit("closed");
  }
}

/** 观察写盘次数与内容的假 store（patch 是 seam 上的依赖注入；窗口保存只改窗口字段） */
function fakeStore() {
  const saved: LaunchState[] = [];
  const store: LaunchStateStore = {
    async get() {
      return saved.at(-1) ?? null;
    },
    async set(state) {
      saved.push(state);
      return state;
    },
    async patch(state) {
      saved.push(state);
      return state;
    },
  };
  return { store, saved, patch: vi.spyOn(store, "patch") };
}

let win: FakeWindow;

beforeEach(() => {
  vi.useFakeTimers();
  win = new FakeWindow();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("窗口现场保存：move/resize 防抖合并", () => {
  it("移动结束约 500ms 后落盘一次，bounds 与最终窗口一致", () => {
    const { store, patch } = fakeStore();
    trackWindowLaunchState({ win, store });

    win.moveTo(240, 160);
    expect(patch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LAUNCH_STATE_SAVE_DEBOUNCE_MS - 1);
    expect(patch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toEqual({
      bounds: { x: 240, y: 160, width: 900, height: 640 },
      maximized: false,
    });
  });

  it("连续拖动期间事件被合并：全程零写盘，静止后仅一次写盘", () => {
    const { store, patch } = fakeStore();
    trackWindowLaunchState({ win, store });

    for (let i = 1; i <= 20; i++) {
      win.moveTo(100 + i * 30, 90);
      vi.advanceTimersByTime(100); // 每次拖动间隔均小于防抖期
    }
    expect(patch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LAUNCH_STATE_SAVE_DEBOUNCE_MS);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toEqual({
      bounds: { x: 100 + 20 * 30, y: 90, width: 900, height: 640 },
      maximized: false,
    });
  });

  it("缩放与移动混合同样合并为一次写盘", () => {
    const { store, patch } = fakeStore();
    trackWindowLaunchState({ win, store });

    win.moveTo(10, 20);
    vi.advanceTimersByTime(300);
    win.resizeTo(1100, 720);
    vi.advanceTimersByTime(300);
    win.moveTo(40, 50);
    expect(patch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LAUNCH_STATE_SAVE_DEBOUNCE_MS);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toEqual({
      bounds: { x: 40, y: 50, width: 1100, height: 720 },
      maximized: false,
    });
  });
});

describe("窗口现场保存：maximize/unmaximize 及时记录", () => {
  it("最大化后立即写盘：maximized 为 true，bounds 仍是正常态尺寸而非全屏", () => {
    const { store, patch } = fakeStore();
    trackWindowLaunchState({ win, store });

    win.maximize();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toEqual({
      bounds: { x: 100, y: 80, width: 900, height: 640 },
      maximized: true,
    });
  });

  it("还原后立即写盘：maximized 为 false，bounds 为还原后的正常态", () => {
    const { store, patch } = fakeStore();
    trackWindowLaunchState({ win, store });

    win.maximize();
    win.unmaximize();
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1]?.[0]).toEqual({
      bounds: { x: 100, y: 80, width: 900, height: 640 },
      maximized: false,
    });
  });

  it("最大化前挂起的防抖移动被立即写吸收：不再产生第二次写盘", () => {
    const { store, patch } = fakeStore();
    trackWindowLaunchState({ win, store });

    win.moveTo(300, 200);
    vi.advanceTimersByTime(LAUNCH_STATE_SAVE_DEBOUNCE_MS - 1); // 未到期
    win.maximize();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toEqual({
      bounds: { x: 300, y: 200, width: 900, height: 640 },
      maximized: true,
    });
    vi.advanceTimersByTime(10_000);
    expect(patch).toHaveBeenCalledTimes(1); // 挂起的防抖写已被取消
  });

  it("最大化期间的 resize 事件：防抖到期写的 bounds 仍是正常态而非全屏", () => {
    const { store, patch } = fakeStore();
    trackWindowLaunchState({ win, store });

    win.maximize();
    win.fire("resize"); // 最大化改变窗口尺寸（全屏），但正常态 bounds 不变
    expect(patch).toHaveBeenCalledTimes(1); // maximize 立即写
    vi.advanceTimersByTime(LAUNCH_STATE_SAVE_DEBOUNCE_MS);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1]?.[0]).toEqual({
      bounds: { x: 100, y: 80, width: 900, height: 640 },
      maximized: true,
    });
  });
});

describe("窗口现场保存：退出 flush", () => {
  it("防抖中的未落盘变化被 flush 立即刷出，且不重复写", () => {
    const { store, patch } = fakeStore();
    const tracking = trackWindowLaunchState({ win, store });

    win.moveTo(500, 300);
    vi.advanceTimersByTime(LAUNCH_STATE_SAVE_DEBOUNCE_MS - 1); // 尚未到期
    expect(patch).not.toHaveBeenCalled();
    tracking.flush();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toEqual({
      bounds: { x: 500, y: 300, width: 900, height: 640 },
      maximized: false,
    });
    vi.advanceTimersByTime(10_000);
    expect(patch).toHaveBeenCalledTimes(1); // flush 后挂起写已取消
  });

  it("无挂起变化时 flush 不产生多余写盘", () => {
    const { store, patch } = fakeStore();
    const tracking = trackWindowLaunchState({ win, store });

    tracking.flush();
    win.moveTo(10, 10);
    vi.advanceTimersByTime(LAUNCH_STATE_SAVE_DEBOUNCE_MS); // 防抖写已落盘
    expect(patch).toHaveBeenCalledTimes(1);
    tracking.flush();
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("flush 后继续正常跟踪（后续移动照常防抖落盘）", () => {
    const { store, patch } = fakeStore();
    const tracking = trackWindowLaunchState({ win, store });

    win.moveTo(20, 30);
    tracking.flush();
    win.moveTo(60, 70);
    vi.advanceTimersByTime(LAUNCH_STATE_SAVE_DEBOUNCE_MS);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1]?.[0]).toEqual({
      bounds: { x: 60, y: 70, width: 900, height: 640 },
      maximized: false,
    });
  });

  it("窗口已销毁时 flush 不抛错（window-all-closed 先于 before-quit 的路径）", () => {
    const { store, patch } = fakeStore();
    const tracking = trackWindowLaunchState({ win, store });
    win.destroy();
    expect(() => tracking.flush()).not.toThrow();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("窗口现场保存：closed 清理与崩溃衔接", () => {
  it("closed 后停止监听：挂起防抖取消、后续事件不再写盘", () => {
    const { store, patch } = fakeStore();
    trackWindowLaunchState({ win, store });

    win.moveTo(400, 250);
    win.destroy(); // closed 事件触发 dispose
    vi.advanceTimersByTime(10_000);
    expect(patch).not.toHaveBeenCalled(); // 挂起写随 dispose 取消
    win.fire("move"); // 迟到事件（真实窗口不会发生，防御性验证）
    vi.advanceTimersByTime(10_000);
    expect(patch).not.toHaveBeenCalled();
  });

  it("已过防抖期的写盘天然落盘：新 store 实例（重启）读回（票01恢复链路衔接）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codexlike-window-save-"));
    try {
      const store = createLaunchStateStore({ dir });
      trackWindowLaunchState({ win, store });
      win.moveTo(-600, 120); // 负坐标合法（多屏）
      vi.advanceTimersByTime(LAUNCH_STATE_SAVE_DEBOUNCE_MS);
      // 「崩溃」：跟踪对象与 store 都不复存在，只剩磁盘文件
      const reopened = createLaunchStateStore({ dir });
      await expect(reopened.get()).resolves.toEqual({
        bounds: { x: -600, y: 120, width: 900, height: 640 },
        maximized: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("窗口保存是合并写：不清掉渲染层上报的工作台目标与视图（票02×票03 衔接）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codexlike-window-save-"));
    try {
      const store = createLaunchStateStore({ dir });
      // 渲染层先上报目标与视图（票03 渲染层路径）
      await store.patch({
        workbenchTarget: { kind: "session", sessionId: "s-remembered" },
        view: "settings",
      });
      trackWindowLaunchState({ win, store });
      win.moveTo(320, 240);
      vi.advanceTimersByTime(LAUNCH_STATE_SAVE_DEBOUNCE_MS);
      await expect(store.get()).resolves.toEqual({
        bounds: { x: 320, y: 240, width: 900, height: 640 },
        maximized: false,
        workbenchTarget: { kind: "session", sessionId: "s-remembered" },
        view: "settings",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("写盘失败不拖垮主进程：记日志、后续事件仍会再试", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const saved: LaunchState[] = [];
      let diskFull = true; // 第一次写盘失败，之后恢复
      const store: LaunchStateStore = {
        async get() {
          return saved.at(-1) ?? null;
        },
        async set(state) {
          saved.push(state);
          return state;
        },
        async patch(state) {
          if (diskFull) {
            diskFull = false;
            return Promise.reject(new Error("磁盘满"));
          }
          saved.push(state);
          return state;
        },
      };
      trackWindowLaunchState({ win, store });

      win.moveTo(10, 20);
      // 异步版推进会排空 microtask：rejected promise 的 catch 回调得以执行
      await vi.advanceTimersByTimeAsync(LAUNCH_STATE_SAVE_DEBOUNCE_MS);
      expect(error).toHaveBeenCalledOnce();
      win.moveTo(30, 40);
      await vi.advanceTimersByTimeAsync(LAUNCH_STATE_SAVE_DEBOUNCE_MS);
      expect(saved.at(-1)).toEqual({
        bounds: { x: 30, y: 40, width: 900, height: 640 },
        maximized: false,
      });
    } finally {
      error.mockRestore();
    }
  });
});
