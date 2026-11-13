import { contextBridge, ipcRenderer } from "electron";

import { IPC, type CodexLikeApi, type TaskApi } from "./shared/ipc";

// contextBridge 暴露类型化 API；渲染进程经 `window.codexlike` 访问，
// 无 nodeIntegration、无裸 ipcRenderer（安全基线）。

/**
 * 任务域命名空间工厂（票 03）：tasks 与旧 sessions 共用 TaskApi 形状，
 * 分别走新 tasks:* 与旧 sessions:* channel（主进程双注册同一 handler）。
 */
function taskApi(channels: { [K in keyof typeof IPC.tasks]: string }): TaskApi {
  return {
    start: (input) => ipcRenderer.invoke(channels.start, input),
    setProject: (id, projectId) =>
      ipcRenderer.invoke(channels.setProject, id, projectId),
    execution: (id) => ipcRenderer.invoke(channels.execution, id),
    view: (id) => ipcRenderer.invoke(channels.view, id),
    markViewed: (id, sequence) =>
      ipcRenderer.invoke(channels.markViewed, id, sequence),
    setPinned: (id, pinned) =>
      ipcRenderer.invoke(channels.setPinned, id, pinned),
    markUsed: (id) => ipcRenderer.invoke(channels.markUsed, id),
    workspaceSharing: (target) =>
      ipcRenderer.invoke(channels.workspaceSharing, target),
    list: () => ipcRenderer.invoke(channels.list),
    search: (query, includeArchived) =>
      ipcRenderer.invoke(channels.search, query, includeArchived),
    selectWorkspace: () => ipcRenderer.invoke(channels.selectWorkspace),
    messages: (sessionId) => ipcRenderer.invoke(channels.messages, sessionId),
    send: (
      sessionId,
      text,
      providerProfileId,
      mentionPaths,
      thinkingEffort,
      approvalMode
    ) =>
      ipcRenderer.invoke(
        channels.send,
        sessionId,
        text,
        providerProfileId,
        mentionPaths,
        thinkingEffort,
        approvalMode
      ),
    interrupt: (sessionId) => ipcRenderer.invoke(channels.interrupt, sessionId),
    queueResume: (sessionId) =>
      ipcRenderer.invoke(channels.queueResume, sessionId),
    queueClear: (sessionId) =>
      ipcRenderer.invoke(channels.queueClear, sessionId),
    queueRemove: (sessionId, itemId) =>
      ipcRenderer.invoke(channels.queueRemove, sessionId, itemId),
    queueUpdate: (sessionId, itemId, text, expectedText, mentionPaths) =>
      ipcRenderer.invoke(
        channels.queueUpdate,
        sessionId,
        itemId,
        text,
        expectedText,
        mentionPaths
      ),
    queueReorder: (sessionId, orderedIds) =>
      ipcRenderer.invoke(channels.queueReorder, sessionId, orderedIds),
    rename: (sessionId, title) =>
      ipcRenderer.invoke(channels.rename, sessionId, title),
    archive: (sessionId, archived) =>
      ipcRenderer.invoke(channels.archive, sessionId, archived),
    status: (sessionId) => ipcRenderer.invoke(channels.status, sessionId),
    resources: (sessionId) => ipcRenderer.invoke(channels.resources, sessionId),
    compact: (sessionId, providerProfileId) =>
      ipcRenderer.invoke(channels.compact, sessionId, providerProfileId),
    workspaceFiles: (sessionId) =>
      ipcRenderer.invoke(channels.workspaceFiles, sessionId),
    toolImage: (sessionId, toolCallId) =>
      ipcRenderer.invoke(channels.toolImage, sessionId, toolCallId),
    revokeAutoApprove: (sessionId) =>
      ipcRenderer.invoke(channels.revokeAutoApprove, sessionId),
    setApprovalMode: (sessionId, mode) =>
      ipcRenderer.invoke(channels.setApprovalMode, sessionId, mode),
    respondApproval: (sessionId, requestId, decision) =>
      ipcRenderer.invoke(
        channels.respondApproval,
        sessionId,
        requestId,
        decision
      ),
    pendingApproval: (sessionId) =>
      ipcRenderer.invoke(channels.pendingApproval, sessionId),
    pendingApprovals: (sessionId) =>
      ipcRenderer.invoke(channels.pendingApprovals, sessionId),
    pendingInteractions: (sessionId) =>
      ipcRenderer.invoke(channels.pendingInteractions, sessionId),
    respondInteraction: (sessionId, requestId, response) =>
      ipcRenderer.invoke(
        channels.respondInteraction,
        sessionId,
        requestId,
        response
      ),
  };
}

const api: CodexLikeApi = {
  windowControls: {
    getState: () => ipcRenderer.invoke(IPC.windowControls.getState),
    minimize: () => ipcRenderer.invoke(IPC.windowControls.minimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowControls.toggleMaximize),
    close: () => ipcRenderer.invoke(IPC.windowControls.close),
    onStateChanged: (listener) => {
      const handle = (
        _event: Electron.IpcRendererEvent,
        state: import("./shared/ipc").WindowState
      ) => listener(state);
      ipcRenderer.on(IPC.windowControls.stateChanged, handle);
      return () => {
        ipcRenderer.removeListener(IPC.windowControls.stateChanged, handle);
      };
    },
  },
  application: {
    exitState: () => ipcRenderer.invoke(IPC.application.exitState),
    answerExit: (id, confirmed) =>
      ipcRenderer.invoke(IPC.application.answerExit, id, confirmed),
    flushed: (id, error) =>
      ipcRenderer.invoke(IPC.application.flushed, id, error),
    onExitState: (listener) => {
      const handle = (
        _event: Electron.IpcRendererEvent,
        state: import("./shared/ipc").ExitState
      ) => listener(state);
      ipcRenderer.on(IPC.application.exitChanged, handle);
      return () => {
        ipcRenderer.removeListener(IPC.application.exitChanged, handle);
      };
    },
  },
  workbench: {
    read: (target) => ipcRenderer.invoke(IPC.workbench.read, target),
    write: (target, entry) =>
      ipcRenderer.invoke(IPC.workbench.write, target, entry),
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC.projects.list),
    remove: (id, confirmed) =>
      ipcRenderer.invoke(IPC.projects.remove, id, confirmed),
    add: (workspacePath) => ipcRenderer.invoke(IPC.projects.add, workspacePath),
    setPinned: (id, pinned) =>
      ipcRenderer.invoke(IPC.projects.setPinned, id, pinned),
    setCollapsed: (id, collapsed) =>
      ipcRenderer.invoke(IPC.projects.setCollapsed, id, collapsed),
  },
  providerProfiles: {
    list: () => ipcRenderer.invoke(IPC.providerProfiles.list),
    create: (input) => ipcRenderer.invoke(IPC.providerProfiles.create, input),
    update: (id, input) =>
      ipcRenderer.invoke(IPC.providerProfiles.update, id, input),
    remove: (id) => ipcRenderer.invoke(IPC.providerProfiles.remove, id),
  },
  tasks: taskApi(IPC.tasks),
  /** expand 兼容（票 03）：旧 sessions 命名空间仍走旧 sessions:* channel；票 06 删除。 */
  sessions: taskApi(IPC.sessions),
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
  themeSettings: {
    get: () => ipcRenderer.invoke(IPC.themeSettings.get),
    set: (theme) => ipcRenderer.invoke(IPC.themeSettings.set, theme),
  },
  launchState: {
    get: () => ipcRenderer.invoke(IPC.launchState.get),
    setWorkbenchTarget: (target) =>
      ipcRenderer.invoke(IPC.launchState.setWorkbenchTarget, target),
    setView: (view) => ipcRenderer.invoke(IPC.launchState.setView, view),
  },
  mcp: {
    overview: () => ipcRenderer.invoke(IPC.mcp.overview),
    addServer: (input) => ipcRenderer.invoke(IPC.mcp.addServer, input),
    removeServer: (id) => ipcRenderer.invoke(IPC.mcp.removeServer, id),
    reconnect: (id) => ipcRenderer.invoke(IPC.mcp.reconnect, id),
    setToolEnabled: (toolName, enabled) =>
      ipcRenderer.invoke(IPC.mcp.setToolEnabled, toolName, enabled),
  },
  onTaskEvent: (listener) => {
    const handler: (
      _event: Electron.IpcRendererEvent,
      envelope: Parameters<typeof listener>[0]
    ) => void = (_event, envelope) => listener(envelope);
    ipcRenderer.on(IPC.taskEvents, handler);
    return () => {
      ipcRenderer.removeListener(IPC.taskEvents, handler);
    };
  },
  /** expand 兼容（票 03）：订阅旧 session:events channel（与 task:events 双发同一信封）；票 06 删除。 */
  onSessionEvent: (listener) => {
    const handler: (
      _event: Electron.IpcRendererEvent,
      envelope: Parameters<typeof listener>[0]
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

contextBridge.exposeInMainWorld("codexlike", api);
