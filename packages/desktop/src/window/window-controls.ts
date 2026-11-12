import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { IPC, type WindowState } from "../shared/ipc";

export function registerWindowControls(win: BrowserWindow): void {
  function publish(): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(IPC.windowControls.stateChanged, {
      maximized: win.isMaximized(),
    } satisfies WindowState);
  }
  win.on("maximize", publish);
  win.on("unmaximize", publish);
  win.once("closed", () => {
    win.removeListener("maximize", publish);
    win.removeListener("unmaximize", publish);
    ipcMain.removeHandler(IPC.windowControls.getState);
    ipcMain.removeHandler(IPC.windowControls.minimize);
    ipcMain.removeHandler(IPC.windowControls.toggleMaximize);
    ipcMain.removeHandler(IPC.windowControls.close);
  });
  function owned(event: IpcMainInvokeEvent): void {
    if (win.isDestroyed()) throw new Error("窗口已销毁");
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    ) {
      throw new Error("窗口控制来源无效");
    }
  }
  ipcMain.handle(IPC.windowControls.close, (event) => {
    owned(event);
    // 保留既有退出确认、保存屏障和任务收尾，不绕过 close 事件。
    win.close();
  });
  ipcMain.handle(IPC.windowControls.toggleMaximize, (event) => {
    owned(event);
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle(IPC.windowControls.minimize, (event) => {
    owned(event);
    win.minimize();
  });
  ipcMain.handle(IPC.windowControls.getState, (event): WindowState => {
    owned(event);
    return { maximized: win.isMaximized() };
  });
}
