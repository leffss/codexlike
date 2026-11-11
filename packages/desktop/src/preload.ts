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
    create: (workspacePath, workspaceMode) =>
      ipcRenderer.invoke(IPC.sessions.create, workspacePath, workspaceMode),
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
    interrupt: (sessionId) => ipcRenderer.invoke(IPC.sessions.interrupt, sessionId),
    rename: (sessionId, title) =>
      ipcRenderer.invoke(IPC.sessions.rename, sessionId, title),
    archive: (sessionId, archived) =>
      ipcRenderer.invoke(IPC.sessions.archive, sessionId, archived),
    status: (sessionId) => ipcRenderer.invoke(IPC.sessions.status, sessionId),
    compact: (sessionId, providerProfileId) =>
      ipcRenderer.invoke(IPC.sessions.compact, sessionId, providerProfileId),
    workspaceFiles: (sessionId) =>
      ipcRenderer.invoke(IPC.sessions.workspaceFiles, sessionId),
    toolImage: (sessionId, toolCallId) =>
      ipcRenderer.invoke(IPC.sessions.toolImage, sessionId, toolCallId),
    setApprovalMode: (sessionId, mode) =>
      ipcRenderer.invoke(IPC.sessions.setApprovalMode, sessionId, mode),
    respondApproval: (sessionId, requestId, decision) =>
      ipcRenderer.invoke(IPC.sessions.respondApproval, sessionId, requestId, decision),
    pendingApproval: (sessionId) =>
      ipcRenderer.invoke(IPC.sessions.pendingApproval, sessionId),
    pendingApprovals: (sessionId) =>
      ipcRenderer.invoke(IPC.sessions.pendingApprovals, sessionId),
  },
  searchSettings: {
    get: () => ipcRenderer.invoke(IPC.searchSettings.get),
    set: (input) => ipcRenderer.invoke(IPC.searchSettings.set, input),
  },
  subagentSettings: {
    get: () => ipcRenderer.invoke(IPC.subagentSettings.get),
    set: (input) => ipcRenderer.invoke(IPC.subagentSettings.set, input),
  },
  terminalSettings: {
    get: () => ipcRenderer.invoke(IPC.terminalSettings.get),
    set: (shell) => ipcRenderer.invoke(IPC.terminalSettings.set, shell),
  },
  mcp: {
    overview: () => ipcRenderer.invoke(IPC.mcp.overview),
    addServer: (input) => ipcRenderer.invoke(IPC.mcp.addServer, input),
    removeServer: (id) => ipcRenderer.invoke(IPC.mcp.removeServer, id),
    reconnect: (id) => ipcRenderer.invoke(IPC.mcp.reconnect, id),
    setToolEnabled: (toolName, enabled) =>
      ipcRenderer.invoke(IPC.mcp.setToolEnabled, toolName, enabled),
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
