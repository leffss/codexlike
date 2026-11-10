import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  type IpcMainInvokeEvent,
} from 'electron';

import { validateProviderProfile } from '@codexlike/agent-core';

import {
  createProfileStore,
  type ProfileStore,
  type SafeStorageLike,
} from './profiles/profile-store';
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

/** 应用数据目录（spec 约定：`~/.codexlike/`） */
function dataDir(): string {
  return join(homedir(), '.codexlike');
}

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
  const store = createProfileStore({ dir: dataDir(), safeStorage: asSafeStorageLike() });
  registerProviderProfileHandlers(store);
  createMainWindow();
  console.log(`[main] CodexLike 已启动，数据目录：${dataDir()}`);

  // Windows 优先：全部窗口关闭即退出（无 macOS dock 常驻）
  app.on('window-all-closed', () => {
    app.quit();
  });
});
