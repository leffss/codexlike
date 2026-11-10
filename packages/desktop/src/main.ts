import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  type IpcMainInvokeEvent,
} from 'electron';

import {
  composeSystemPrompt,
  createBuiltinTools,
  createSessionManager,
  createSqliteSessionStore,
  createTavilySearchSource,
  createWorktreeService,
  discoverAgentsInstructions,
  validateProviderProfile,
  type SearchSource,
  type SessionRecord,
} from '@codexlike/agent-core/node';

import {
  createProfileStore,
  type ProfileStore,
  type SafeStorageLike,
} from './profiles/profile-store';
import { registerGitHandlers } from './git/git-ipc';
import {
  createSearchSettingsStore,
  type SearchSettingsStore,
} from './search/search-settings-store';
import { registerSessionHandlers } from './sessions/session-ipc';
import {
  createSubagentSettingsStore,
  type SubagentSettings,
  type SubagentSettingsStore,
} from './subagents/subagent-settings-store';
import { IPC } from './shared/ipc';
import { createMcpStore } from './mcp/mcp-store';
import { createMcpService } from './mcp/mcp-service';
import { registerMcpHandlers } from './mcp/mcp-ipc';

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
  return process.env.CODEXLIKE_HOME ?? join(homedir(), '.codexlike');
}

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'CodexLike',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要 require('electron') 的 contextBridge
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    // 生产构建：ui 包产物位于平级目录 packages/ui/dist
    void win.loadFile(join(__dirname, '..', '..', 'ui', 'dist', 'index.html'));
  }

  return win;
}

/** 注册 Provider Profile 的 IPC 指令（渲染 → 主） */
function registerProviderProfileHandlers(store: ProfileStore): void {
  ipcMain.handle(IPC.providerProfiles.list, () => store.list());

  ipcMain.handle(IPC.providerProfiles.create, (_e: IpcMainInvokeEvent, input: unknown) => {
    const parsed = assertValidInput(input);
    return store.create(parsed);
  });

  ipcMain.handle(
    IPC.providerProfiles.update,
    (_e: IpcMainInvokeEvent, id: unknown, input: unknown) => {
      if (typeof id !== 'string') {
        throw new Error('update：id 必须是字符串');
      }
      const parsed = assertValidInput(input);
      return store.update(id, parsed);
    },
  );

  ipcMain.handle(IPC.providerProfiles.remove, (_e: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id !== 'string') {
      throw new Error('remove：id 必须是字符串');
    }
    return store.remove(id);
  });
}

/** IPC 边界不信任渲染进程：输入经 agent-core 校验后才进入存储层 */
function assertValidInput(input: unknown) {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Provider Profile 输入不合法');
  }
  const { name, baseURL, apiKey, model } = input as Record<string, unknown>;
  const parsed = {
    name: String(name ?? ''),
    baseURL: String(baseURL ?? ''),
    apiKey: String(apiKey ?? ''),
    model: String(model ?? ''),
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
  onSaved: () => Promise<void>,
): void {
  ipcMain.handle(IPC.searchSettings.get, () => store.get());
  ipcMain.handle(IPC.searchSettings.set, (_e: IpcMainInvokeEvent, input: unknown) => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('搜索源设置输入不合法');
    }
    const apiKey = (input as Record<string, unknown>)['apiKey'];
    if (typeof apiKey !== 'string') {
      throw new Error('apiKey 必须是字符串（空字符串表示清除配置）');
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
  });
}

/**
 * 注册子代理全局设置的 IPC 指令（工单 13）。
 * 设置经内存缓存注入 SubagentsConfig（逐次解析），保存后对下一次委派即时生效；
 * providerProfileId 非空时必须在 Provider Profile 列表中真实存在（引用有效性在边界校验）。
 */
function registerSubagentSettingsHandlers(options: {
  store: SubagentSettingsStore;
  profiles: ProfileStore;
  onSaved: (settings: SubagentSettings) => Promise<void>;
}): void {
  const { store, profiles, onSaved } = options;
  ipcMain.handle(IPC.subagentSettings.get, () => store.get());
  ipcMain.handle(IPC.subagentSettings.set, (_e: IpcMainInvokeEvent, input: unknown) => {
    if (typeof input !== 'object' || input === null) {
      throw new Error('子代理设置输入不合法');
    }
    const { providerProfileId, maxConcurrent } = input as Record<string, unknown>;
    const profileId =
      providerProfileId === null || providerProfileId === ''
        ? null
        : String(providerProfileId);
    return (async () => {
      if (profileId !== null) {
        const exists = (await profiles.list()).some((p) => p.id === profileId);
        if (!exists) {
          throw new Error('所选 Provider Profile 不存在，请重新选择子代理模型');
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
  });
}

void app.whenReady().then(async () => {
  // 会话持久化：SQLite 库文件位于 ~/.codexlike/codexlike.db（spec「会话与持久化」）
  const persistence = createSqliteSessionStore(join(dataDir(), 'codexlike.db'));

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
      settings.apiKey === ''
        ? null
        : createTavilySearchSource({
            apiKey: settings.apiKey,
            // E2E 隔离钩子（与 CODEXLIKE_TEST_WORKSPACE 同款模式）：指向本地 mock
            baseUrl: process.env['CODEXLIKE_TAVILY_URL'],
          });
  };
  await refreshSearchSource();

  // 内置工具（工单 03 六件 + 工单 10 web_search）：无状态实例，全部会话共享；
  // 工作区经执行上下文逐会话注入。shell 偏好可用 CODEXLIKE_SHELL 环境变量切换（设置页 UI 在后续工单接入）。
  const shellEnv = process.env['CODEXLIKE_SHELL'];
  const builtinTools = createBuiltinTools({
    env: process.env,
    shell:
      shellEnv === 'powershell' || shellEnv === 'cmd' || shellEnv === 'git-bash'
        ? shellEnv
        : undefined,
    webSearch: { searchSource: () => searchSource },
  });

  // 子代理全局设置（工单 13）：内存缓存注入 SubagentsConfig（逐次解析），
  // 设置页保存后对下一次委派即时生效（无需重启会话）
  const subagentSettingsStore = createSubagentSettingsStore({ dir: dataDir() });
  const profileStore = createProfileStore({ dir: dataDir(), safeStorage: asSafeStorageLike() });
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

  // AGENTS.md 自动注入（工单 07）：全局 + 项目根 → cwd 逐层发现，
  // 会话创建与恢复时各计算一次系统提示（agent-core 不依赖 fs，发现逻辑注入宿主）
  const systemPromptFor = (record: SessionRecord) =>
    composeSystemPrompt(
      discoverAgentsInstructions({ workspacePath: record.workspacePath }),
    );
  const manager = createSessionManager({
    persistence,
    tools: () => mcpService.sessionTools(builtinTools),
    systemPromptFor,
    subagents: {
      // 子代理工具集 = 完整会话工具（内置 + 启用的 MCP 工具，与主会话同一工厂逐次解析；
      // 编排器剔除 spawn_subagent 防递归）
      tools: () => mcpService.sessionTools(builtinTools),
      settings: () => subagentSettings,
      // 子代理模型（设置页 Provider Profile 引用）；null = 同主模型（回退当前会话所选）
      resolveProfile: async () => {
        const profileId = subagentSettings.providerProfileId;
        if (profileId === null) {
          return null;
        }
        const found = (await profileStore.list()).find((p) => p.id === profileId);
        return found ?? null;
      },
    },
  });
  const store = profileStore;

  // 托管 Worktree（工单 09）：worktree 模式会话的隔离副本根目录
  // （~/.codexlike/worktrees，CODEXLIKE_HOME 隔离由 dataDir 统一解析）
  const worktreeService = createWorktreeService({
    worktreesDir: join(dataDir(), 'worktrees'),
  });

  // 上次退出若在流式/等待审批中途被杀，库里会残留 streaming / waiting-approval；
  // 进程刚启动不可能有真实运行中的流，统一重置（manager.get 的恢复路径会落库 idle）
  for (const record of manager.list()) {
    if (record.status === 'streaming' || record.status === 'waiting-approval') {
      manager.get(record.id);
    }
  }

  // 启动时跑一次 LRU 清理：会话已删除/已归档的托管 Worktree 超量部分回收
  // （运行中的永不清理；此刻无运行中会话，主要是孤儿目录与超量归档副本）
  void worktreeService
    .cleanup({ sessions: manager.list() })
    .then((result) => {
      if (result.removed.length > 0) {
        console.log(`[main] 已清理 ${result.removed.length} 个过期托管 Worktree`);
      }
    })
    .catch((error: unknown) => {
      console.error('[main] worktree 启动清理失败', error);
    });

  registerProviderProfileHandlers(store);
  registerSearchSettingsHandlers(searchSettings, refreshSearchSource);
  registerSubagentSettingsHandlers({
    store: subagentSettingsStore,
    profiles: profileStore,
    onSaved: refreshSubagentSettings,
  });
  registerMcpHandlers(mcpService);
  registerSessionHandlers({
    manager,
    profiles: store,
    getWindow: () => mainWindow,
    worktreeService,
  });
  // 改动面板 + git 集成（工单 05）
  registerGitHandlers({ manager, profiles: store });
  mainWindow = createMainWindow();
  console.log(`[main] CodexLike 已启动，数据目录：${dataDir()}`);

  // Windows 优先：全部窗口关闭即退出（无 macOS dock 常驻）
  app.on('window-all-closed', () => {
    app.quit();
  });

  // 退出前释放数据库句柄（Windows 上未关闭会锁住库文件）并断开 MCP 子进程
  app.on('will-quit', () => {
    persistence.close();
    void mcpService.shutdown();
  });
});
