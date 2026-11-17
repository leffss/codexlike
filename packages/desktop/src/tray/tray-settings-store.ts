import { join } from "node:path";

import { readJsonFile, writeJsonFile } from "../storage/json-file";

/**
 * 托盘驻留与开机启动设置（ADR 0025，GLOSSARY「托盘驻留」「开机启动」）：
 * 落 `~/.codexlike/tray-settings.json`；开机启动默认关，驻留气泡提示只展示一次。
 */

export interface TraySettings {
  /** 开机启动开关：默认关；主进程保存时同步登录项与托盘菜单勾选 */
  launchAtLogin: boolean;
  /** 驻留气泡是否已展示过（首次驻留提示一次，之后不再打扰） */
  residencyHintShown: boolean;
}

export const DEFAULT_TRAY_SETTINGS: TraySettings = {
  launchAtLogin: false,
  residencyHintShown: false,
};

export interface TraySettingsStore {
  /** 当前设置；未配置（无文件/损坏）按默认值返回 */
  get(): Promise<TraySettings>;
  /** 合并保存（部分字段）并返回保存后的完整设置 */
  set(patch: Partial<TraySettings>): Promise<TraySettings>;
}

const FILE_NAME = "tray-settings.json";

/** 托盘设置的本地存储（`~/.codexlike/tray-settings.json`）；损坏文件按默认处理 */
export function createTraySettingsStore(options: {
  dir: string;
}): TraySettingsStore {
  const filePath = join(options.dir, FILE_NAME);

  function loadFile(): TraySettings {
    const parsed = readJsonFile<Partial<TraySettings>>(
      filePath,
      {},
      {
        corruptAsFallback: true,
      }
    );
    return {
      launchAtLogin:
        typeof parsed.launchAtLogin === "boolean"
          ? parsed.launchAtLogin
          : DEFAULT_TRAY_SETTINGS.launchAtLogin,
      residencyHintShown:
        typeof parsed.residencyHintShown === "boolean"
          ? parsed.residencyHintShown
          : DEFAULT_TRAY_SETTINGS.residencyHintShown,
    };
  }

  function assertBooleans(patch: Partial<TraySettings>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value !== "boolean") {
        throw new Error(`托盘设置的 ${key} 必须是布尔值`);
      }
    }
  }

  return {
    async get() {
      return loadFile();
    },

    async set(patch) {
      assertBooleans(patch);
      const next = { ...loadFile(), ...patch };
      writeJsonFile(filePath, next);
      return next;
    },
  };
}
