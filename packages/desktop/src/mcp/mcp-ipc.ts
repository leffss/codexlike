import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { IPC } from '../shared/ipc';
import { validateMcpServerInput } from './mcp-store';
import type { McpService } from './mcp-service';

/** 注册 MCP 设置的 IPC 指令（渲染 → 主；工单 12「设置页 MCP 区」） */
export function registerMcpHandlers(service: McpService): void {
  ipcMain.handle(IPC.mcp.overview, () => service.overview());

  ipcMain.handle(IPC.mcp.addServer, (_e: IpcMainInvokeEvent, input: unknown) => {
    // IPC 边界不信任渲染进程：校验后才进入存储/连接层
    const parsed = validateMcpServerInput(input);
    return service.addServer(parsed);
  });

  ipcMain.handle(IPC.mcp.removeServer, (_e: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('removeServer：id 必须是字符串');
    }
    return service.removeServer(id).then(() => true);
  });

  ipcMain.handle(IPC.mcp.reconnect, (_e: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('reconnect：id 必须是字符串');
    }
    return service.reconnect(id);
  });

  ipcMain.handle(
    IPC.mcp.setToolEnabled,
    (_e: IpcMainInvokeEvent, toolName: unknown, enabled: unknown) => {
      if (typeof toolName !== 'string') {
        throw new Error('setToolEnabled：toolName 必须是字符串');
      }
      if (typeof enabled !== 'boolean') {
        throw new Error('setToolEnabled：enabled 必须是布尔值');
      }
      return service.setToolEnabled(toolName, enabled);
    },
  );
}
