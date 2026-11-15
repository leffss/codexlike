import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { IPC } from "../shared/ipc";
import type { AgentSettings, AgentSettingsStore } from "./agent-settings-store";

/**
 * 注册执行设置的 IPC 指令（ADR 0017，GLOSSARY「执行设置」）。
 * 与现有设置频道同构：get 直读 store；set 经 store 校验落盘后回调 onSaved——
 * 装配层（main.ts）在回调里刷新内存缓存，resolver 逐次解析读缓存，
 * 保存后对下一个回合（回合开始快照）生效，无需重启任务。
 */
export function registerAgentSettingsHandlers(options: {
  store: AgentSettingsStore;
  onSaved: (settings: AgentSettings) => Promise<void>;
}): void {
  const { store, onSaved } = options;
  ipcMain.handle(IPC.agentSettings.get, () => store.get());
  ipcMain.handle(
    IPC.agentSettings.set,
    (_e: IpcMainInvokeEvent, input: unknown) => {
      // IPC 边界不信任渲染进程：只接受 { maxToolRounds: number } 形状
      if (typeof input !== "object" || input === null) {
        throw new Error("执行设置输入不合法");
      }
      const maxToolRounds = Number(
        (input as Record<string, unknown>)["maxToolRounds"]
      );
      return store
        .set({ maxToolRounds })
        .then(async (settings) => {
          await onSaved(settings);
          return settings;
        })
        .catch((error: unknown) => {
          throw error instanceof Error ? error : new Error(String(error));
        });
    }
  );
}
