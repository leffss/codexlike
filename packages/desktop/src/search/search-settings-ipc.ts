import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { IPC } from "../shared/ipc";
import type {
  SearchSettings,
  SearchSettingsStore,
} from "./search-settings-store";

/** 设置读取/保存和搜索源缓存的同一刷新接缝；错误保持 IPC 拒绝。 */
export function registerSearchSettingsHandlers(
  store: SearchSettingsStore,
  refresh: () => Promise<SearchSettings>
): void {
  ipcMain.handle(IPC.searchSettings.get, refresh);
  ipcMain.handle(
    IPC.searchSettings.set,
    (_e: IpcMainInvokeEvent, input: unknown) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("搜索源设置输入不合法");
      }
      const apiKey = (input as Record<string, unknown>)["apiKey"];
      if (typeof apiKey !== "string") {
        throw new Error("apiKey 必须是字符串（空字符串表示清除配置）");
      }
      return store.set({ apiKey }).then(async (settings) => {
        await refresh();
        return settings;
      });
    }
  );
}
