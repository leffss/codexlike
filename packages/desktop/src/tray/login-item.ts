/** 登录项同步所需的 Electron App 面（窄接口注入，便于测试） */
export interface LoginItemApp {
  isPackaged: boolean;
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    args: string[];
  }): void;
}

/**
 * 开机启动登录项同步（ADR 0025，GLOSSARY「开机启动」）：
 * 开启时带 `--hidden` 参数注册——随登录静默驻留托盘不弹主窗口；
 * 开发模式（未打包，exe 是 electron.exe）不写，避免把开发器注册进登录项。
 */
export function syncLoginItem(app: LoginItemApp, enabled: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
}

/**
 * 开机静默驻留判定（ADR 0025）：登录项以 `--hidden` 参数启动本应用时
 * 不弹主窗口、直接驻留托盘；手动打开不带该参数，永远正常弹窗。
 */
export function shouldStartHidden(argv: readonly string[]): boolean {
  return argv.includes("--hidden");
}
