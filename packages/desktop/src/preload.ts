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
    send: (sessionId, text, providerProfileId, mentionPaths) =>
      ipcRenderer.invoke(
        IPC.sessions.send,
        sessionId,
        text,
        providerProfileId,
        mentionPaths,
      ),
    rename: (sessionId, title) =>
      ipcRenderer.invoke(IPC.sessions.rename, sessionId, title),
    archive: (sessionId, archived) =>
      ipcRenderer.invoke(IPC.sessions.archive, sessionId, archived),
    status: (sessionId) => ipcRenderer.invoke(IPC.sessions.status, sessionId),
    compact: (sessionId, providerProfileId) =>
      ipcRenderer.invoke(IPC.sessions.compact, sessionId, providerProfileId),
    workspaceFiles: (sessionId) =>
      ipcRenderer.invoke(IPC.sessions.workspaceFiles, sessionId),
  },
  searchSettings: {
    get: () => ipcRenderer.invoke(IPC.searchSettings.get),
    set: (input) => ipcRenderer.invoke(IPC.searchSettings.set, input),
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
  git: {
    status: (sessionId) => ipcRenderer.invoke(IPC.git.status, sessionId),
    diff: (sessionId, path, oldPath) =>
      ipcRenderer.invoke(IPC.git.diff, sessionId, path, oldPath),
    createBranch: (sessionId) =>
      ipcRenderer.invoke(IPC.git.createBranch, sessionId),
    generateCommitMessage: (sessionId, providerProfileId) =>
      ipcRenderer.invoke(IPC.git.commitMessage, sessionId, providerProfileId),
    commit: (sessionId, message) =>
      ipcRenderer.invoke(IPC.git.commit, sessionId, message),
  },
};

contextBridge.exposeInMainWorld('codexlike', api);
