import { join } from 'node:path';

import { readJsonFile, writeJsonFile } from '../storage/json-file';

/**
 * 外观主题偏好（ADR 0006）：应用级 light / dark 切换，默认浅色。
 * 偏好落 `~/.codexlike/theme-settings.json`；渲染端以 localStorage 镜像防首帧闪烁，
 * 本存储是权威来源（主进程据此设置窗口底色与 nativeTheme，重启不闪错色）。
 */

/** 可选值（与设置页外观段一致） */
export type ThemeName = 'light' | 'dark';

export const THEMES: readonly ThemeName[] = ['light', 'dark'];

export function isThemeName(value: unknown): value is ThemeName {
  return (
    typeof value === 'string' && (THEMES as readonly string[]).includes(value)
  );
}

export interface ThemeSettingsStore {
  /** 已保存的主题偏好；未配置（无文件/非法）返回 null，UI 以浅色兜底 */
  get(): Promise<ThemeName | null>;
  /** 保存偏好（枚举校验）并返回保存后的值 */
  set(theme: ThemeName): Promise<ThemeName>;
}

const FILE_NAME = 'theme-settings.json';

/** 主题偏好的本地存储（`~/.codexlike/theme-settings.json`）；损坏文件按未配置处理 */
export function createThemeSettingsStore(options: {
  dir: string;
}): ThemeSettingsStore {
  const filePath = join(options.dir, FILE_NAME);

  function loadFile(): ThemeName | null {
    const parsed = readJsonFile<{ theme?: unknown }>(filePath, {}, {
      corruptAsFallback: true,
    });
    return isThemeName(parsed.theme) ? parsed.theme : null;
  }

  return {
    async get() {
      return loadFile();
    },

    async set(theme) {
      if (!isThemeName(theme)) {
        throw new Error('主题偏好必须是 light / dark 之一');
      }
      writeJsonFile(filePath, { theme });
      return theme;
    },
  };
}
