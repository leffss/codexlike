import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import type { ThemeName } from '@codexlike/desktop/ipc';

/**
 * 外观主题上下文（ADR 0006）：light / dark，默认浅色。
 * 权威存储在主进程 `~/.codexlike/theme-settings.json`（窗口底色 / nativeTheme 随之）；
 * localStorage 是渲染端镜像——index.html 内联脚本启动时同步读取防首帧闪烁，
 * 这里挂载后再与主进程校准一次（镜像缺失 / 漂移时纠正）。
 */

const THEME_STORAGE_KEY = 'codexlike.theme';

function readInitialTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

interface ThemeContextValue {
  theme: ThemeName;
  /** 切换主题：立即换肤并异步持久化到主进程 */
  setTheme: (theme: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  setTheme: () => {},
});

export function ThemeProvider(props: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(readInitialTheme);

  useEffect(() => {
    let cancelled = false;
    void window.codexlike.themeSettings
      .get()
      .then((saved) => {
        if (!cancelled && saved !== null && saved !== readInitialTheme()) {
          applyTheme(saved);
          setThemeState(saved);
        }
      })
      .catch(() => {
        // 读不到偏好时保持浅色默认（localStorage 镜像兜底已生效）
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setTheme(next: ThemeName) {
    applyTheme(next);
    setThemeState(next);
    void window.codexlike.themeSettings.set(next).catch(() => {
      // 持久化失败不回滚视觉（下次启动回落浅色/镜像值，可接受）
    });
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {props.children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
