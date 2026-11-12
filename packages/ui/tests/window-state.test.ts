import type { CodexLikeApi, WindowState } from "@codexlike/desktop/ipc";
import { expect, it, vi } from "vitest";
import { subscribeWindowState } from "../src/lib/window-state";

type WindowApi = NonNullable<CodexLikeApi["windowControls"]>;

function source(
  getState: WindowApi["getState"] = async () => ({ maximized: true })
) {
  let listener: (state: WindowState) => void = () => {};
  const unsubscribe = vi.fn();
  const api: WindowApi = {
    getState,
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    onStateChanged: (receive) => {
      listener = receive;
      return unsubscribe;
    },
  };
  return { api, unsubscribe, emit: (state: WindowState) => listener(state) };
}

it("查询期间到达的窗口事件不会被较旧初始快照覆盖", async () => {
  const port = source(async () => {
    port.emit({ maximized: true });
    return { maximized: false };
  });
  const receive = vi.fn();
  const stop = subscribeWindowState(port.api, receive);
  await Promise.resolve();
  expect(receive).toHaveBeenCalledExactlyOnceWith({ maximized: true });
  stop();
});

it("卸载后退订且忽略未决快照与已排队的事件", async () => {
  const port = source();
  const receive = vi.fn();
  const stop = subscribeWindowState(port.api, receive);
  stop();
  await Promise.resolve();
  port.emit({ maximized: true });
  expect(port.unsubscribe).toHaveBeenCalledOnce();
  expect(receive).not.toHaveBeenCalled();
});

it("初始查询失败被处理，后续窗口事件仍能同步", async () => {
  const port = source(async () => {
    throw new Error("读取失败");
  });
  const receive = vi.fn();
  const stop = subscribeWindowState(port.api, receive);
  // 跨一轮事件循环，让未处理的 rejection 被测试运行器捕获。
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(receive).not.toHaveBeenCalled();
  port.emit({ maximized: true });
  expect(receive).toHaveBeenCalledExactlyOnceWith({ maximized: true });
  stop();
});

it("初始快照与后续主进程窗口状态均同步给 UI", async () => {
  const port = source();
  const receive = vi.fn();
  const stop = subscribeWindowState(port.api, receive);
  await Promise.resolve();
  expect(receive).toHaveBeenLastCalledWith({ maximized: true });
  port.emit({ maximized: false });
  expect(receive).toHaveBeenLastCalledWith({ maximized: false });
  stop();
});
