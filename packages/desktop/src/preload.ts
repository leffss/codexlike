import { contextBridge, ipcRenderer } from 'electron';

import { IPC, type CodexLikeApi } from './shared/ipc';

// contextBridge 暴露类型化 API；渲染进程经 `window.codexlike` 访问，
// 无 nodeIntegration、无裸 ipcRenderer（安全基线）。
const api: CodexLikeApi = {
  providerProfiles: {
    list: () => ipcRenderer.invoke(IPC.providerProfiles.list),
    create: (input) => ipcRenderer.invoke(IPC.providerProfiles.create, input),
    update: (id, input) =>
      ipcRenderer.invoke(IPC.providerProfiles.update, id, input),
    remove: (id) => ipcRenderer.invoke(IPC.providerProfiles.remove, id),
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessions.list),
    create: (workspacePath) =>
      ipcRenderer.invoke(IPC.sessions.create, workspacePath),
    selectWorkspace: () => ipcRenderer.invoke(IPC.sessions.selectWorkspace),
    messages: (sessionId) => ipcRenderer.invoke(IPC.sessions.messages, sessionId),
    send: (sessionId, text, providerProfileId) =>
      ipcRenderer.invoke(IPC.sessions.send, sessionId, text, providerProfileId),
  },
  onSessionEvent: (listener) => {
    const handler: (
      _event: Electron.IpcRendererEvent,
      envelope: Parameters<typeof listener>[0],
    ) => void = (_event, envelope) => listener(envelope);
    ipcRenderer.on(IPC.sessionEvents, handler);
    return () => {
      ipcRenderer.removeListener(IPC.sessionEvents, handler);
    };
  },
};

contextBridge.exposeInMainWorld('codexlike', api);
