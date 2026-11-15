import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { IPC } from "../shared/ipc";
import {
  parseTerminalSettingsInput,
  type TerminalSettings,
  type TerminalSettingsStore,
} from "./terminal-settings-store";

/**
 * 注册终端设置的 IPC 指令（shell 偏好 + 命令超时两项，执行设置票04）。
 * 设置经内存缓存注入终端工具（逐次解析），保存后对下一次 run_terminal_command
 * 即时生效；IPC 边界不信任渲染进程，输入经 parseTerminalSettingsInput 校验。
 */
export function registerTerminalSettingsHandlers(options: {
  store: TerminalSettingsStore;
  onSaved: (settings: TerminalSettings) => void;
}): void {
  const { store, onSaved } = options;
  ipcMain.handle(IPC.terminalSettings.get, () => store.get());
  ipcMain.handle(
    IPC.terminalSettings.set,
    (_e: IpcMainInvokeEvent, input: unknown) => {
      const parsed = parseTerminalSettingsInput(input);
      return store
        .set(parsed)
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
