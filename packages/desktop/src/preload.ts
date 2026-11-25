import { contextBridge, ipcRenderer } from "electron";

import { IPC, type CodexLikeApi, type TaskApi } from "./shared/ipc";

// contextBridge 暴露类型化 API；渲染进程经 `window.codexlike` 访问，
// 无 nodeIntegration、无裸 ipcRenderer（安全基线）。

/** 任务域命名空间工厂：转发到 tasks:* channel。 */
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
    messages: (taskId) => ipcRenderer.invoke(channels.messages, taskId),
    send: (
      taskId,
      text,
      providerProfileId,
      mentionPaths,
      thinkingEffort,
      approvalMode,
      model
    ) =>
      ipcRenderer.invoke(
        channels.send,
        taskId,
        text,
        providerProfileId,
        mentionPaths,
        thinkingEffort,
        approvalMode,
        model
      ),
    interrupt: (taskId) => ipcRenderer.invoke(channels.interrupt, taskId),
    queueResume: (taskId) => ipcRenderer.invoke(channels.queueResume, taskId),
    queueClear: (taskId) => ipcRenderer.invoke(channels.queueClear, taskId),
    queueRemove: (taskId, itemId) =>
      ipcRenderer.invoke(channels.queueRemove, taskId, itemId),
    queueUpdate: (taskId, itemId, text, expectedText, mentionPaths) =>
      ipcRenderer.invoke(
        channels.queueUpdate,
        taskId,
        itemId,
        text,
        expectedText,
        mentionPaths
      ),
    queueReorder: (taskId, orderedIds) =>
      ipcRenderer.invoke(channels.queueReorder, taskId, orderedIds),
    rename: (taskId, title) =>
      ipcRenderer.invoke(channels.rename, taskId, title),
    archive: (taskId, archived) =>
      ipcRenderer.invoke(channels.archive, taskId, archived),
    status: (taskId) => ipcRenderer.invoke(channels.status, taskId),
    resources: (taskId) => ipcRenderer.invoke(channels.resources, taskId),
    draftResources: (workspacePath) =>
      ipcRenderer.invoke(channels.draftResources, workspacePath),
    compact: (taskId, providerProfileId, model) =>
      ipcRenderer.invoke(channels.compact, taskId, providerProfileId, model),
    workspaceFiles: (taskId) =>
      ipcRenderer.invoke(channels.workspaceFiles, taskId),
    toolImage: (taskId, toolCallId) =>
      ipcRenderer.invoke(channels.toolImage, taskId, toolCallId),
    revokeAutoApprove: (taskId) =>
      ipcRenderer.invoke(channels.revokeAutoApprove, taskId),
    setApprovalMode: (taskId, mode) =>
      ipcRenderer.invoke(channels.setApprovalMode, taskId, mode),
    respondApproval: (taskId, requestId, decision) =>
      ipcRenderer.invoke(channels.respondApproval, taskId, requestId, decision),
    pendingApproval: (taskId) =>
      ipcRenderer.invoke(channels.pendingApproval, taskId),
    pendingApprovals: (taskId) =>
      ipcRenderer.invoke(channels.pendingApprovals, taskId),
    pendingInteractions: (taskId) =>
      ipcRenderer.invoke(channels.pendingInteractions, taskId),
    respondInteraction: (taskId, requestId, response) =>
      ipcRenderer.invoke(
        channels.respondInteraction,
        taskId,
        requestId,
        response
      ),
    // 目标模式（ADR 0035）：/goal 设定目标（原文作为首轮用户消息发出）
    goalSet: (taskId, text, options) =>
      ipcRenderer.invoke(channels.goalSet, taskId, text, options),
    // 目标模式（ADR 0035「护栏」）：设定 / 调整当前目标的 token 预算
    goalSetBudget: (taskId, tokens) =>
      ipcRenderer.invoke(channels.goalSetBudget, taskId, tokens),
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
  searchSettings: {
    get: () => ipcRenderer.invoke(IPC.searchSettings.get),
    set: (input) => ipcRenderer.invoke(IPC.searchSettings.set, input),
  },
  subagentSettings: {
    get: () => ipcRenderer.invoke(IPC.subagentSettings.get),
    set: (input) => ipcRenderer.invoke(IPC.subagentSettings.set, input),
  },
  agentSettings: {
    get: () => ipcRenderer.invoke(IPC.agentSettings.get),
    set: (input) => ipcRenderer.invoke(IPC.agentSettings.set, input),
  },
  terminalSettings: {
    get: () => ipcRenderer.invoke(IPC.terminalSettings.get),
    set: (settings) => ipcRenderer.invoke(IPC.terminalSettings.set, settings),
  },
  themeSettings: {
    get: () => ipcRenderer.invoke(IPC.themeSettings.get),
    set: (theme) => ipcRenderer.invoke(IPC.themeSettings.set, theme),
  },
  traySettings: {
    get: () => ipcRenderer.invoke(IPC.traySettings.get),
    set: (input) => ipcRenderer.invoke(IPC.traySettings.set, input),
    onLaunchAtLoginChanged: (listener) => {
      const handle = (_event: Electron.IpcRendererEvent, enabled: boolean) =>
        listener(enabled);
      ipcRenderer.on(IPC.traySettings.changed, handle);
      return () => {
        ipcRenderer.removeListener(IPC.traySettings.changed, handle);
      };
    },
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
  terminals: {
    create: (input) => ipcRenderer.invoke(IPC.terminals.create, input),
    write: (sessionId, data) =>
      ipcRenderer.invoke(IPC.terminals.write, sessionId, data),
    resize: (sessionId, size) =>
      ipcRenderer.invoke(IPC.terminals.resize, sessionId, size),
    kill: (sessionId) => ipcRenderer.invoke(IPC.terminals.kill, sessionId),
    rename: (sessionId, title) =>
      ipcRenderer.invoke(IPC.terminals.rename, sessionId, title),
    subscribe: (sessionId) =>
      ipcRenderer.invoke(IPC.terminals.subscribe, sessionId),
    unsubscribe: (sessionId) =>
      ipcRenderer.invoke(IPC.terminals.unsubscribe, sessionId),
    session: (sessionId) =>
      ipcRenderer.invoke(IPC.terminals.session, sessionId),
    listFor: (taskId) => ipcRenderer.invoke(IPC.terminals.listFor, taskId),
    // PTY 字节流专用通道（不进 React 状态，直写 xterm.js）；生命周期
    // 事件不走这里——terminal-* 经 onTaskEvent 的信封下发
    onSessionData: (listener) => {
      const handler: (
        _event: Electron.IpcRendererEvent,
        payload: import("./shared/ipc").TerminalSessionDataPayload
      ) => void = (_event, payload) => listener(payload);
      ipcRenderer.on(IPC.terminals.sessionData, handler);
      return () => {
        ipcRenderer.removeListener(IPC.terminals.sessionData, handler);
      };
    },
  },
  clipboard: {
    read: () => ipcRenderer.invoke(IPC.clipboard.read),
  },
  git: {
    status: (taskId) => ipcRenderer.invoke(IPC.git.status, taskId),
    diff: (taskId, path, oldPath) =>
      ipcRenderer.invoke(IPC.git.diff, taskId, path, oldPath),
    createBranch: (taskId) => ipcRenderer.invoke(IPC.git.createBranch, taskId),
    generateCommitMessage: (taskId, providerProfileId) =>
      ipcRenderer.invoke(IPC.git.commitMessage, taskId, providerProfileId),
    commit: (taskId, message) =>
      ipcRenderer.invoke(IPC.git.commit, taskId, message),
  },
  files: {
    saveText: (input) => ipcRenderer.invoke(IPC.files.saveText, input),
  },
  openers: {
    list: () => ipcRenderer.invoke(IPC.openers.list),
    open: (input) => ipcRenderer.invoke(IPC.openers.open, input),
  },
};

contextBridge.exposeInMainWorld("codexlike", api);
