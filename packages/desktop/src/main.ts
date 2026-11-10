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
  createBuiltinTools,
  createSessionManager,
  createSqliteSessionStore,
  validateProviderProfile,
} from '@codexlike/agent-core/node';

import {
  createProfileStore,
  type ProfileStore,
  type SafeStorageLike,
} from './profiles/profile-store';
import { registerSessionHandlers } from './sessions/session-ipc';
import { IPC } from './shared/ipc';

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

void app.whenReady().then(() => {
  // 会话持久化：SQLite 库文件位于 ~/.codexlike/codexlike.db（spec「会话与持久化」）
  const persistence = createSqliteSessionStore(join(dataDir(), 'codexlike.db'));
  // 六件内置工具：无状态实例，全部会话共享；工作区经执行上下文逐会话注入。
  // shell 偏好可用 CODEXLIKE_SHELL 环境变量切换（设置页 UI 在后续工单接入）。
  const shellEnv = process.env['CODEXLIKE_SHELL'];
  const tools = createBuiltinTools({
    env: process.env,
    shell:
      shellEnv === 'powershell' || shellEnv === 'cmd' || shellEnv === 'git-bash'
        ? shellEnv
        : undefined,
  });
  const manager = createSessionManager({ persistence, tools });
  const store = createProfileStore({ dir: dataDir(), safeStorage: asSafeStorageLike() });

  // 上次退出若在流式中途被杀，库里会残留 streaming；进程刚启动不可能有真实运行中的流，统一重置
  for (const record of manager.list()) {
    if (record.status === 'streaming') {
      manager.get(record.id);
    }
  }

  registerProviderProfileHandlers(store);
  registerSessionHandlers({
    manager,
    profiles: store,
    getWindow: () => mainWindow,
  });
  mainWindow = createMainWindow();
  console.log(`[main] CodexLike 已启动，数据目录：${dataDir()}`);

  // Windows 优先：全部窗口关闭即退出（无 macOS dock 常驻）
  app.on('window-all-closed', () => {
    app.quit();
  });

  // 退出前释放数据库句柄（Windows 上未关闭会锁住库文件）
  app.on('will-quit', () => {
    persistence.close();
  });
});
