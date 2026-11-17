import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { IPC } from "../shared/ipc";
import type { TraySettings, TraySettingsStore } from "./tray-settings-store";

/**
 * 注册托盘设置的 IPC 指令（ADR 0025，GLOSSARY「开机启动」）。
 * set 只接受 launchAtLogin 开关（residencyHintShown 为内部标志，不经 IPC）；
 * 保存回调里装配方同步登录项与托盘菜单勾选（托盘菜单切换走同一编排）。
 */
export function registerTraySettingsHandlers(options: {
  store: TraySettingsStore;
  onSaved(settings: TraySettings): void;
}): void {
  const { store, onSaved } = options;
  ipcMain.handle(IPC.traySettings.get, () => store.get());
  ipcMain.handle(
    IPC.traySettings.set,
    (_e: IpcMainInvokeEvent, input: unknown) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("托盘设置输入不合法");
      }
      const { launchAtLogin } = input as Record<string, unknown>;
      if (typeof launchAtLogin !== "boolean") {
        throw new Error("开机启动必须是布尔值");
      }
      return store
        .set({ launchAtLogin })
        .then((settings) => {
          onSaved(settings);
          return settings;
        })
        .catch((error: unknown) => {
          throw error instanceof Error ? error : new Error(String(error));
        });
    }
  );
}
