import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  safeStorage,
  screen,
  type IpcMainInvokeEvent,
} from "electron";

import {
  createAgentResourceSnapshot,
  createBrowserSessionManager,
  createBrowserTools,
  createBuiltinTools,
  createSessionManager,
  createSqliteSessionStore,
  createTavilySearchSource,
  createWorktreeService,
  validateProviderProfile,
  type SearchSource,
  type SessionRecord,
} from "@codexlike/agent-core/node";

import {
  createProfileStore,
  type ProfileStore,
  type SafeStorageLike,
} from "./profiles/profile-store";
import { registerGitHandlers } from "./git/git-ipc";
import {
  createSearchSettingsStore,
  type SearchSettingsStore,
} from "./search/search-settings-store";
import {
  createTerminalSettingsStore,
  isTerminalShell,
  resolveTerminalShell,
  type TerminalSettingsStore,
} from "./terminal/terminal-settings-store";
import {
  createThemeSettingsStore,
  isThemeName,
  type ThemeName,
  type ThemeSettingsStore,
} from "./theme/theme-settings-store";
import {
  createLaunchStateStore,
  type LaunchState,
} from "./launch-state/launch-state-store";
import { resolveLaunchBounds } from "./launch-state/display-geometry";
import type { TerminalShell } from "@codexlike/agent-core/node";
import { registerSessionHandlers } from "./sessions/session-ipc";
import { createSqliteInputQueueStore } from "./sessions/input-queue-store";
import { registerApplicationExit } from "./lifecycle/exit-ipc";
import { registerWindowControls } from "./window/window-controls";
import { registerNavigationPolicy } from "./window/navigation-policy";
import { sessionScreenshotDir } from "./sessions/screenshots";
import {
  createSubagentSettingsStore,
  type SubagentSettings,
  type SubagentSettingsStore,
} from "./subagents/subagent-settings-store";
import { IPC } from "./shared/ipc";
import { createMcpStore } from "./mcp/mcp-store";
import { createMcpService } from "./mcp/mcp-service";
import { registerMcpHandlers } from "./mcp/mcp-ipc";

/**
 * 把 Electron safeStorage（async API，Electron 45 起同步版已弃用）
 * 适配为存储层的 SafeStorageLike。
 */
function asSafeStorageLike(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encryptString: (plainText) => safeStorage.encryptStringAsync(plainText),
    decryptString: async (encrypted) => {
      const { result } = await safeStorage.decryptStringAsync(encrypted);
      return result;
    },
  };
}

/** 应用数据目录（spec 约定：`~/.codexlike/`；CODEXLIKE_HOME 供 E2E 隔离） */
function dataDir(): string {
  return process.env.CODEXLIKE_HOME ?? join(homedir(), ".codexlike");
}

let mainWindow: BrowserWindow | null = null;

/** 各主题的窗口底色（页面加载前可见；与 styles.css 的 --canvas 保持一致） */
const WINDOW_BACKGROUND: Record<ThemeName, string> = {
  light: "#f8fafc",
  dark: "#0f172a",
};

/** 原生侧同步（原生控件/滚动条跟随应用主题而非系统；未配置默认浅色，ADR 0006） */
function applyNativeTheme(theme: ThemeName | null): void {
  const resolved = theme ?? "light";
  nativeTheme.themeSource = resolved;
}

function createMainWindow(
  theme: ThemeName | null,
  launch: LaunchState | null
): BrowserWindow {
  const options: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    title: "CodexLike",
    frame: false,
    backgroundColor: WINDOW_BACKGROUND[theme ?? "light"],
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要 require('electron') 的 contextBridge
    },
  };
  // 启动现场（票01）：有有效现场则按恢复 bounds 建窗（显示器校验纯函数负责
  // 无交集回退与尺寸收紧）；无现场维持现有默认 1280×800 居中。
  if (launch !== null) {
    Object.assign(
      options,
      resolveLaunchBounds({
        saved: launch.bounds,
        workAreas: screen.getAllDisplays().map((display) => display.workArea),
        primaryWorkArea: screen.getPrimaryDisplay().workArea,
      })
    );
  }
  const win = new BrowserWindow(options);
  // maximized 为真：先按正常态 bounds 建窗再 maximize（取消最大化可回到现场 bounds）
  if (launch !== null && launch.maximized) {
    win.maximize();
  }

  registerWindowControls(win);

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  // 打包时由 extraResources 提供静态界面；开发目录的生产构建（含 E2E）使用 ui/dist。
  const entryFile = app.isPackaged
    ? join(process.resourcesPath, "ui-dist", "index.html")
    : join(__dirname, "..", "..", "ui", "dist", "index.html");
  // 必须先注册保护，连首次加载的重定向也不能替换工作台。
  registerNavigationPolicy(
    win.webContents,
    devServerUrl || pathToFileURL(entryFile).href
  );
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(entryFile);
  }

  return win;
}

/** 注册 Provider Profile 的 IPC 指令（渲染 → 主） */
function registerProviderProfileHandlers(store: ProfileStore): void {
  ipcMain.handle(IPC.providerProfiles.list, () => store.list());

  ipcMain.handle(
    IPC.providerProfiles.create,
    (_e: IpcMainInvokeEvent, input: unknown) => {
      const parsed = assertValidInput(input);
      return store.create(parsed);
    }
  );

  ipcMain.handle(
    IPC.providerProfiles.update,
    (_e: IpcMainInvokeEvent, id: unknown, input: unknown) => {
      if (typeof id !== "string") {
        throw new Error("update：id 必须是字符串");
      }
      const parsed = assertValidInput(input);
      return store.update(id, parsed);
    }
  );

  ipcMain.handle(
    IPC.providerProfiles.remove,
    (_e: IpcMainInvokeEvent, id: unknown) => {
      if (typeof id !== "string") {
        throw new Error("remove：id 必须是字符串");
      }
      return store.remove(id);
    }
  );
}

/** IPC 边界不信任渲染进程：输入经 agent-core 校验后才进入存储层 */
function assertValidInput(input: unknown) {
  if (typeof input !== "object" || input === null) {
    throw new Error("Provider Profile 输入不合法");
  }
  const { name, baseURL, apiKey, model, contextWindowTokens } = input as Record<
    string,
    unknown
  >;
  // 上下文窗口为可选数字（表单空串/未填 → undefined，走默认 128k）
  const windowTokens =
    contextWindowTokens === undefined ||
    contextWindowTokens === null ||
    contextWindowTokens === ""
      ? undefined
      : Number(contextWindowTokens);
  const parsed = {
    name: String(name ?? ""),
    baseURL: String(baseURL ?? ""),
    apiKey: String(apiKey ?? ""),
    model: String(model ?? ""),
    ...(windowTokens !== undefined
      ? { contextWindowTokens: windowTokens }
      : {}),
  };
  const errors = validateProviderProfile(parsed);
  const first = Object.values(errors).find((message) => message !== undefined);
  if (first !== undefined) {
    throw new Error(first);
  }
  return parsed;
}

/**
 * 注册搜索源设置的 IPC 指令（工单 10）。
 * web_search 工具的 searchSource 每次调用时解析内存缓存，
 * 因此设置页保存/清除 key 后无需重启即可对进行中的会话生效。
 */
function registerSearchSettingsHandlers(
  store: SearchSettingsStore,
  onSaved: () => Promise<void>
): void {
  ipcMain.handle(IPC.searchSettings.get, () => store.get());
  ipcMain.handle(
    IPC.searchSettings.set,
    (_e: IpcMainInvokeEvent, input: unknown) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("搜索源设置输入不合法");
      }
      const apiKey = (input as Record<string, unknown>)["apiKey"];
      if (typeof apiKey !== "string") {
        throw new Error("apiKey 必须是字符串（空字符串表示清除配置）");
      }
      return store
        .set({ apiKey })
        .then(async (settings) => {
          await onSaved();
          return settings;
        })
        .catch((error: unknown) => {
          throw error instanceof Error ? error : new Error(String(error));
        });
    }
  );
}

/**
 * 注册子代理全局设置的 IPC 指令（工单 13）。
 * 设置经内存缓存注入 SubagentsConfig（逐次解析），保存后对下一次委派即时生效；
 * providerProfileId 非空时必须在 Provider Profile 列表中真实存在（引用有效性在边界校验）。
 */ function registerSubagentSettingsHandlers(options: {
  store: SubagentSettingsStore;
  profiles: ProfileStore;
  onSaved: (settings: SubagentSettings) => Promise<void>;
}): void {
  const { store, profiles, onSaved } = options;
  ipcMain.handle(IPC.subagentSettings.get, () => store.get());
  ipcMain.handle(
    IPC.subagentSettings.set,
    (_e: IpcMainInvokeEvent, input: unknown) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("子代理设置输入不合法");
      }
      const { providerProfileId, maxConcurrent } = input as Record<
        string,
        unknown
      >;
      const profileId =
        providerProfileId === null || providerProfileId === ""
          ? null
          : String(providerProfileId);
      return (async () => {
        if (profileId !== null) {
          const exists = (await profiles.list()).some(
            (p) => p.id === profileId
          );
          if (!exists) {
            throw new Error(
              "所选 Provider Profile 不存在，请重新选择子代理模型"
            );
          }
        }
        const settings = await store.set({
          providerProfileId: profileId,
          maxConcurrent: Number(maxConcurrent),
        });
        await onSaved(settings);
        return settings;
      })().catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      });
    }
  );
}

/**
 * 注册终端执行偏好的 IPC 指令（code review 修复 1）。
 * 偏好经内存缓存注入终端工具（逐次解析），保存后对下一次 run_terminal_command 即时生效。
 */
function registerTerminalSettingsHandlers(options: {
  store: TerminalSettingsStore;
  onSaved: (shell: TerminalShell) => void;
}): void {
  const { store, onSaved } = options;
  ipcMain.handle(IPC.terminalSettings.get, () => store.get());
  ipcMain.handle(
    IPC.terminalSettings.set,
    (_e: IpcMainInvokeEvent, input: unknown) => {
      // IPC 边界不信任渲染进程：只接受三档枚举
      if (!isTerminalShell(input)) {
        throw new Error("终端偏好必须是 git-bash / powershell / cmd 之一");
      }
      return store
        .set(input)
        .then((shell) => {
          onSaved(shell);
          return shell;
        })
        .catch((error: unknown) => {
          throw error instanceof Error ? error : new Error(String(error));
        });
    }
  );
}

/**
 * 注册外观主题偏好的 IPC 指令（ADR 0006）。
 * 保存后同步原生窗口底色与 nativeTheme（渲染端由 ThemeProvider 换 data-theme）。
 */
function registerThemeSettingsHandlers(options: {
  store: ThemeSettingsStore;
  onSaved: (theme: ThemeName) => void;
}): void {
  const { store, onSaved } = options;
  ipcMain.handle(IPC.themeSettings.get, () => store.get());
  ipcMain.handle(
    IPC.themeSettings.set,
    (_e: IpcMainInvokeEvent, input: unknown) => {
      // IPC 边界不信任渲染进程：只接受 light / dark 枚举
      if (!isThemeName(input)) {
        throw new Error("主题偏好必须是 light / dark 之一");
      }
      return store
        .set(input)
        .then((theme) => {
          onSaved(theme);
          return theme;
        })
        .catch((error: unknown) => {
          throw error instanceof Error ? error : new Error(String(error));
        });
    }
  );
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // ADR 0010：新管理数据独立初始化，旧 codexlike.db 与用户文件原样保留，不迁移不删除。
  const persistence = createSqliteSessionStore(
    join(dataDir(), "session-workbench.db")
  );

  // 搜索源（工单 10）：key 存设置页（safeStorage 加密），内存缓存供 web_search 逐次解析；
  // 未配置时 searchSource 为 null → 工具返回「未配置搜索源」中文指引，会话不崩。
  const searchSettings = createSearchSettingsStore({
    dir: dataDir(),
    safeStorage: asSafeStorageLike(),
  });
  let searchSource: SearchSource | null = null;
  const refreshSearchSource = async () => {
    const settings = await searchSettings.get();
    searchSource =
      settings.apiKey === ""
        ? null
        : createTavilySearchSource({
            apiKey: settings.apiKey,
            // E2E 隔离钩子（与 CODEXLIKE_TEST_WORKSPACE 同款模式）：指向本地 mock
            baseUrl: process.env["CODEXLIKE_TAVILY_URL"],
          });
  };
  await refreshSearchSource();

  // 终端执行偏好（code review 修复 1，spec「设置页：… shell 偏好」）：
  // 内存缓存逐次解析注入终端工具——设置页保存后无需重启即对下一次命令生效；
  // 未配置时 CODEXLIKE_SHELL 环境变量兜底（E2E/自动化兼容），最终默认 Git Bash。
  const terminalSettingsStore = createTerminalSettingsStore({ dir: dataDir() });
  let shellPreference = await terminalSettingsStore.get();

  // 外观主题偏好（ADR 0006）：启动时先读偏好再建窗口——窗口底色与页面主题一致，
  // 避免深色用户重启先闪浅色底；未配置默认浅色。渲染端另有 localStorage 镜像防页内闪烁。
  const themeSettingsStore = createThemeSettingsStore({ dir: dataDir() });
  const themePreference = await themeSettingsStore.get();
  applyNativeTheme(themePreference);
  // 浏览器工具组（工单 11）：Playwright headless Chromium 会话级复用；
  // 首次使用自动下载（进度打到主进程日志，镜像默认 npmmirror）。
  const browserManager = createBrowserSessionManager({
    progress: (line) => console.log(`[browser] ${line}`),
  });
  const browserTools = createBrowserTools({
    manager: browserManager,
    // 截图保存到会话数据目录（约定路径，重启后 UI 仍可读回）
    screenshotDirFor: (sessionId) => sessionScreenshotDir(dataDir(), sessionId),
  });

  const builtinTools = createBuiltinTools({
    env: process.env,
    // shell 逐次解析：设置项优先、CODEXLIKE_SHELL 兜底（见上方 shellPreference 缓存）
    shell: () =>
      resolveTerminalShell(shellPreference, process.env["CODEXLIKE_SHELL"]),
    webSearch: { searchSource: () => searchSource },
  });

  // 子代理全局设置（工单 13）：内存缓存注入 SubagentsConfig（逐次解析），
  // 设置页保存后对下一次委派即时生效（无需重启会话）
  const subagentSettingsStore = createSubagentSettingsStore({ dir: dataDir() });
  const profileStore = createProfileStore({
    dir: dataDir(),
    safeStorage: asSafeStorageLike(),
  });
  let subagentSettings = await subagentSettingsStore.get();
  const refreshSubagentSettings = async () => {
    subagentSettings = await subagentSettingsStore.get();
  };

  // MCP（工单 12）：stdio server 的配置存储 + 连接管理；启动时连接全部已配置
  // server（失败不拖垮应用，状态在设置页可见）。会话工具 = 内置 + 启用的 MCP 工具，
  // 工厂逐次解析——设置页启停/断线重连对后续消息即时生效。
  const mcpService = createMcpService({
    store: createMcpStore({ dir: dataDir(), safeStorage: asSafeStorageLike() }),
  });
  await mcpService.startup();

  // 会话工具工厂（主会话与子代理共用）：MCP 启用集 + 浏览器五件工具（工单 11）
  const sessionTools = () => [
    ...mcpService.sessionTools(builtinTools),
    ...browserTools,
  ];
  // 每条消息发现一次规范与技能；预览和运行使用同一规则，执行中的快照不被预览替换。
  const resourcesFor = (record: SessionRecord) =>
    createAgentResourceSnapshot({
      workspacePath: record.workspacePath,
      globalDir: dataDir(),
      // E2E 隔离兼容来源，不扫描测试机器的真实 ~/.agents。
      compatibleGlobalDir: process.env["CODEXLIKE_TEST_AGENTS_HOME"],
    });
  // 截图附图开关（工单 11）：端点支持图片输入时设 CODEXLIKE_ATTACH_TOOL_IMAGES=1，
  // 截图以 image_url 附给模型；默认关闭走降级路径（输出文本含文件路径）。
  const attachToolImages = ["1", "true"].includes(
    (process.env["CODEXLIKE_ATTACH_TOOL_IMAGES"] ?? "").toLowerCase()
  );
  const manager = createSessionManager({
    persistence,
    tools: sessionTools,
    resourcesFor,
    attachToolImages,
    subagents: {
      // 子代理工具集 = 完整会话工具（内置 + MCP + 浏览器，同一工厂逐次解析；
      // 编排器剔除 spawn_subagent 防递归）
      tools: sessionTools,
      settings: () => subagentSettings,
      // 子代理模型（设置页 Provider Profile 引用）；null = 同主模型（回退当前会话所选）
      resolveProfile: async () => {
        const profileId = subagentSettings.providerProfileId;
        if (profileId === null) {
          return null;
        }
        const found = (await profileStore.list()).find(
          (p) => p.id === profileId
        );
        return found ?? null;
      },
    },
  });
  const store = profileStore;

  // 托管 Worktree（工单 09）：worktree 模式会话的隔离副本根目录
  // （~/.codexlike/worktrees，CODEXLIKE_HOME 隔离由 dataDir 统一解析）
  const worktreeService = createWorktreeService({
    worktreesDir: join(dataDir(), "worktrees"),
  });

  // manager 初始化已取消全部遗留交互；非空闲会话再恢复为 idle，不恢复工具执行。
  // 同时兼容旧库的 waiting-approval 状态。
  for (const record of manager.list()) {
    if (record.status !== "idle") manager.get(record.id);
  }

  // 新库不认识旧会话，不以此将旧 Worktree 当孤儿回收；磁盘文件独立保留。

  registerProviderProfileHandlers(store);
  registerSearchSettingsHandlers(searchSettings, refreshSearchSource);
  registerSubagentSettingsHandlers({
    store: subagentSettingsStore,
    profiles: profileStore,
    onSaved: refreshSubagentSettings,
  });
  registerTerminalSettingsHandlers({
    store: terminalSettingsStore,
    onSaved: (shell: TerminalShell) => {
      shellPreference = shell;
    },
  });
  registerThemeSettingsHandlers({
    store: themeSettingsStore,
    onSaved: (theme: ThemeName) => {
      applyNativeTheme(theme);
      // 已打开窗口的底色同步（页面加载完成前穿透可见的原生层）
      mainWindow?.setBackgroundColor(WINDOW_BACKGROUND[theme]);
    },
  });
  registerMcpHandlers(mcpService);
  // 输入队列（票 01 / ADR 0013）：与 session-workbench.db 同库的独立连接
  const queueStore = createSqliteInputQueueStore(
    join(dataDir(), "session-workbench.db")
  );
  const sessionRuntime = registerSessionHandlers({
    manager,
    profiles: store,
    getWindow: () => mainWindow,
    getWindows: () => BrowserWindow.getAllWindows(),
    dataDir: dataDir(),
    browserManager,
    worktreeService,
    resourcesFor,
    queueStore,
  });
  // 改动面板 + git 集成（工单 05）
  registerGitHandlers({ manager, profiles: store });
  // 输入队列恢复（票 04 / ADR 0013）：主进程服务与凭据装配完成后启用，
  // 不依赖窗口、view 或渲染层加载；暂停态队列由持久标志保持不消费。
  sessionRuntime.startInputQueues();
  // 启动现场（票01）：与主题同构的建窗前时序——先读现场再建窗；无现场或
  // 损坏（null）维持默认 1280×800 居中。
  const launchStateStore = createLaunchStateStore({ dir: dataDir() });
  const launchState = await launchStateStore.get();
  mainWindow = createMainWindow(themePreference, launchState);
  console.log(`[main] CodexLike 已启动，数据目录：${dataDir()}`);

  registerApplicationExit({
    window: mainWindow,
    runtime: sessionRuntime,
    closeStorage: () => {
      persistence.close();
      queueStore.close();
    },
    releaseResources: async () => {
      await Promise.allSettled([mcpService.shutdown(), browserManager.close()]);
    },
  });
});
