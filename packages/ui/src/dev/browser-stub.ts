/**
 * dev 浏览器预览设施：window.codexlike 缺失（纯浏览器 vite dev server）时注入
 * 假 API，让渲染层在无 Electron 的情况下挂载出完整工作台（真实组件 + 样例数据）。
 * Electron 下 preload 已注入 window.codexlike，本模块立即返回（no-op）；
 * 生产构建不含本模块（main.tsx 经 import.meta.env.DEV 动态引入）。
 * 写操作一律 no-op，读操作返回 fixtures 静态样例。
 * 来源：ui-redesign 原型的 throwaway stub 转正（分支 prototype/ui-redesign）。
 */
import type { CodexLikeApi } from "@codexlike/desktop/ipc";
import {
  GIT_STATUS,
  PROJECTS,
  PROFILES,
  RESOURCES,
  TASKS,
  WORKSPACE_FILES,
  gitDiffFor,
  taskView,
} from "./fixtures";

const THEME_KEY = "codexlike.theme";

/** dev 预览的目标记录样例（契约形状见 GoalRecord）：恒为「进行中」 */
function devGoal(taskId: string, text: string) {
  const now = new Date().toISOString();
  return {
    id: `goal-${Date.now()}`,
    taskId,
    text,
    status: "active" as const,
    activeMs: 0,
    activeSince: now,
    createdAt: now,
    updatedAt: now,
    idleStreak: 0,
    failureStreak: 0,
    budgetTokens: null,
    baselineTokens: 0,
  };
}

function installBrowserStub(): void {
  if (typeof window === "undefined") return;
  if (window.codexlike !== undefined) return;

  const emptyQueueResult = (taskId: string) => ({
    taskId,
    sequence: 0,
    queue: [],
    paused: false,
    sendingId: null,
  });

  const api = {
    windowControls: {
      getState: async () => ({ maximized: false }),
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      onStateChanged: () => () => {},
    },
    application: {
      exitState: async () => ({ id: "", phase: "idle" }),
      answerExit: async () => {},
      flushed: async () => {},
      onExitState: () => () => {},
    },
    workbench: {
      read: async () => undefined,
      write: async (_target: unknown, entry: unknown) => ({
        accepted: true,
        entry,
      }),
    },
    projects: {
      list: async () => PROJECTS,
      add: async (workspacePath: string) => ({
        id: `proj-${Date.now()}`,
        name: workspacePath.split(/[\\/]/).pop() ?? "新项目",
        workspacePath,
        createdAt: new Date().toISOString(),
      }),
      remove: async () => null,
      setPinned: async () => null,
      setCollapsed: async () => null,
    },
    providerProfiles: {
      list: async () => PROFILES,
      create: async () => PROFILES[0],
      update: async () => PROFILES[0],
      remove: async () => true,
    },
    tasks: {
      list: async () => TASKS,
      search: async () => [],
      start: async () => TASKS[0],
      setProject: async () => null,
      execution: async () => null,
      view: async (taskId: string) => taskView(taskId),
      markViewed: async () => {},
      setPinned: async () => null,
      markUsed: async () => null,
      workspaceSharing: async () => ({ workspacePath: null, runningTasks: [] }),
      selectWorkspace: async () => null,
      messages: async () => [],
      send: async () => {},
      interrupt: async () => false,
      queueResume: async (taskId: string) => emptyQueueResult(taskId),
      queueClear: async (taskId: string) => emptyQueueResult(taskId),
      queueRemove: async (taskId: string) => emptyQueueResult(taskId),
      queueUpdate: async (taskId: string) => emptyQueueResult(taskId),
      queueReorder: async (taskId: string) => emptyQueueResult(taskId),
      rename: async () => null,
      archive: async () => null,
      status: async () => null,
      resources: async () => RESOURCES,
      // draft 态资源预览（tasks:draft-resources）：与 resources 的 preview 同构
      draftResources: async () => RESOURCES,
      compact: async () => ({ compactedMessages: 0 }),
      workspaceFiles: async () => WORKSPACE_FILES,
      toolImage: async () => null,
      revokeAutoApprove: async () => TASKS[0],
      setApprovalMode: async () => null,
      respondApproval: async () => false,
      pendingApproval: async () => null,
      pendingApprovals: async () => [],
      pendingInteractions: async () => [],
      respondInteraction: async () => false,
      // 目标模式（ADR 0035）：/goal 设定——dev 预览不跑宿主编排，只回一个
      // 「进行中」的目标记录供进度行呈现（契约形状见 GoalRecord）
      goalSet: async (taskId: string, text: string) =>
        devGoal(taskId, text.trim()),
      // 目标模式控制面（ADR 0035 票 04）：dev 预览不跑宿主编排，恢复 / 编辑只回
      // 「进行中」的记录供进度行呈现；清除回「已清除」（进度行随之退场）
      goalResume: async (taskId: string) => devGoal(taskId, ""),
      goalEdit: async (taskId: string, text: string) =>
        devGoal(taskId, text.trim()),
      goalClear: async (taskId: string) => ({
        ...devGoal(taskId, ""),
        status: "cleared" as const,
        activeSince: null,
      }),
      // 目标模式护栏（ADR 0035 票 05）：dev 预览没有目标账目可读，预算原样记下
      goalSetBudget: async (taskId: string, tokens: number) => ({
        ...devGoal(taskId, ""),
        budgetTokens: tokens,
      }),
    },
    searchSettings: {
      get: async () => ({ apiKey: "" }),
      set: async (input: { apiKey: string }) => input,
    },
    subagentSettings: {
      get: async () => ({ providerProfileId: null, concurrencyLimit: 3 }),
      set: async (value: unknown) => value,
    },
    agentSettings: {
      // 形状对齐真实 IPC 契约（执行设置票 03/07 + 任务并发上限票 01）：
      // 七项均为默认值——票 01/02 的执行分区此前缺 stub，dev 预览打开
      // 设置页时分区加载失败
      get: async () => ({
        maxToolRounds: 200,
        maxSubagentToolRounds: 200,
        compactKeepRounds: 3,
        contextWarningThresholdPercent: 80,
        mcpCallTimeoutSeconds: 30,
        mcpConnectTimeoutSeconds: 15,
        taskConcurrencyLimit: 3,
      }),
      set: async (value: unknown) => value,
    },
    terminalSettings: {
      // 形状对齐真实 IPC 契约（执行设置票04）：shell null = 未配置 + 超时默认值
      get: async () => ({
        shell: null,
        commandTimeoutSeconds: 30,
        maxCommandTimeoutSeconds: 120,
      }),
      set: async (settings: unknown) => settings,
    },
    themeSettings: {
      get: async () =>
        localStorage.getItem(THEME_KEY) === "dark" ? "dark" : null,
      set: async (theme: unknown) => {
        localStorage.setItem(THEME_KEY, String(theme));
        return theme;
      },
    },
    traySettings: {
      // 形状对齐真实 IPC 契约（托盘轮）：get/set 往返样例值（气泡标志置
      // 已展示，dev 预览不弹）；无 Electron 托盘菜单，订阅恒空——设置页
      // 「启动与托盘」分区挂载即读，缺它纯浏览器预览打开设置页整树崩
      get: async () => ({ launchAtLogin: false, residencyHintShown: true }),
      set: async (settings: { launchAtLogin: boolean }) => ({
        launchAtLogin: settings.launchAtLogin,
        residencyHintShown: true,
      }),
      onLaunchAtLoginChanged: () => () => {},
    },
    launchState: {
      get: async () => null,
      setWorkbenchTarget: async (target: unknown) => ({
        view: "workspace",
        workbenchTarget: target,
      }),
      setView: async (view: unknown) => ({
        view,
        workbenchTarget: null,
      }),
    },
    mcp: {
      overview: async () => ({ servers: [] }),
      addServer: async () => null,
      removeServer: async () => false,
      reconnect: async () => null,
      setToolEnabled: async () => {},
    },
    onTaskEvent: () => () => {},
    clipboard: {
      read: async () => "",
    },
    terminals: {
      // 形状对齐真实 IPC 契约（ADR 0033 票03）：dev 预览暂无终端面板
      //（04 票接线），只补齐命名空间契约让纯浏览器预览挂载不缺 API；
      // 操作 no-op（create 返回明确拒绝），字节流订阅恒空
      create: async () => ({
        ok: false as const,
        reason: "dev 预览环境不支持终端会话",
      }),
      write: async () => ({
        ok: false as const,
        reason: "dev 预览环境不支持终端会话",
      }),
      resize: async () => {},
      kill: async () => ({
        ok: false as const,
        reason: "dev 预览环境不支持终端会话",
      }),
      rename: async () => ({
        ok: false as const,
        reason: "dev 预览环境不支持终端会话",
      }),
      subscribe: async (sessionId: string) => ({
        ok: false as const,
        reason: `dev 预览环境不支持终端会话：${sessionId}`,
      }),
      unsubscribe: async () => {},
      session: async () => null,
      listFor: async () => [],
      onSessionData: () => () => {},
    },
    openers: {
      // 形状对齐真实 IPC 契约（工作区打开器）：资源管理器恒在，
      // 另给终端/VS Code 两个探测项样例呈现下拉密度；open 不真启动程序
      list: async () => ({
        openers: [
          { id: "explorer", label: "资源管理器" },
          { id: "terminal", label: "终端" },
          { id: "vscode", label: "VS Code" },
        ],
        defaultId: "explorer",
      }),
      open: async (input: { openerId?: string }) => ({
        defaultId: input.openerId ?? "explorer",
      }),
    },
    files: {
      // 原型环境不出保存对话框，也不落盘
      saveText: async () => ({ saved: false }),
    },
    git: {
      // 形状对齐真实 IPC 契约（GitStatus 恒在；GitFileDiff{path,original,modified}
      // ——右栏改动 tab 在纯浏览器预览里有密度可看；写操作 no-op）
      status: async () => GIT_STATUS,
      diff: async (_taskId: string, path: string) => ({
        path,
        ...gitDiffFor(path),
      }),
      createBranch: async () => ({
        created: true,
        branch: "feature/dev-preview",
      }),
      generateCommitMessage: async () =>
        "dev 预览样例提交消息（可编辑；Electron 下走真实模型）",
      commit: async () => ({
        committed: false,
        reason: "浏览器预览环境不可提交",
      }),
    },
  } as unknown as CodexLikeApi;

  window.codexlike = api;
}

installBrowserStub();
