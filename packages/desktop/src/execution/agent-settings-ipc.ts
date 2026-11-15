import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { IPC } from "../shared/ipc";
import {
  parseAgentSettingsInput,
  type AgentSettings,
  type AgentSettingsStore,
} from "./agent-settings-store";

/**
 * 注册执行设置的 IPC 指令（ADR 0017，GLOSSARY「执行设置」）。
 * 与现有设置频道同构：get 直读 store；set 经边界解析与 store 校验落盘后
 * 回调 onSaved——装配层（main.ts）在回调里刷新内存缓存，resolver 逐次解析
 * 读缓存，保存后对下一个回合（回合开始快照）生效，无需重启任务。
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
      // IPC 边界不信任渲染进程：parseAgentSettingsInput 纯函数校验四字段形状
      // 与取值（code review 修复 4——不再经 Number 强转，字符串数字 "200"
      // 直接拒绝），非法输入以中文异常抛回，与 store.set 校验同源同消息
      const parsed = parseAgentSettingsInput(input);
      return store
        .set(parsed)
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
