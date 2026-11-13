import { app, ipcMain, type BrowserWindow } from "electron";
import { IPC } from "../shared/ipc";
import {
  createApplicationExit,
  type SessionExitRuntime,
} from "./application-exit";

/** 所有正常关闭入口都保留窗口，直到renderer保存屏障及执行清理完成。 */
export function registerApplicationExit(options: {
  window: BrowserWindow;
  runtime: SessionExitRuntime;
  closeStorage(): void;
  releaseResources(): Promise<void>;
  /**
   * 退出请求被接受时同步调用（窗口仍存活、尚未进入销毁）：
   * 供各持久化层刷出防抖中的未落盘写（如启动现场，票02）。
   */
  flushPendingWrites?(): void;
}) {
  const win = options.window;
  let storageClosed = false;
  function closeStorage() {
    if (storageClosed) return;
    storageClosed = true;
    options.closeStorage();
  }
  // 先关闭renderer再关库，避免终态事件触发的只读IPC撞上已释放statement。
  app.on("will-quit", closeStorage);
  const exit = createApplicationExit({
    runtime: options.runtime,
    publish: (state) => {
      if (!win.isDestroyed())
        win.webContents.send(IPC.application.exitChanged, state);
    },
    finish: () => {
      void options.releaseResources().finally(() => app.quit());
      // 仅在持久化和主/子执行已安全排空后兜底Electron/MCP原生收尾挂起。
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
        closeStorage();
        app.exit(0);
      }, 2_000).unref();
    },
  });
  function request(event: { preventDefault(): void }) {
    if (exit.state().phase === "ready") return;
    event.preventDefault();
    options.flushPendingWrites?.();
    exit.request();
  }
  win.on("close", request);
  app.on("before-quit", request);
  app.on("window-all-closed", () => app.quit());
  const owned = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== win.webContents) throw new Error("退出握手来源无效");
  };
  ipcMain.handle(IPC.application.exitState, (event) => {
    owned(event);
    return exit.state();
  });
  ipcMain.handle(
    IPC.application.answerExit,
    (event, id: unknown, confirmed: unknown) => {
      owned(event);
      if (typeof id !== "string" || typeof confirmed !== "boolean")
        throw new Error("退出确认参数不合法");
      exit.answer(id, confirmed);
    }
  );
  ipcMain.handle(
    IPC.application.flushed,
    (event, id: unknown, error: unknown) => {
      owned(event);
      if (
        typeof id !== "string" ||
        (error !== undefined && typeof error !== "string")
      )
        throw new Error("退出保存参数不合法");
      return exit.flushed(id, error);
    }
  );
}
