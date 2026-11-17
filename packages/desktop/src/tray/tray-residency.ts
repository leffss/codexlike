import { Menu, Tray, type BrowserWindow } from "electron";

import type { TraySettingsStore } from "./tray-settings-store";

/**
 * 托盘驻留控制器（ADR 0025，GLOSSARY「托盘驻留」）：只管托盘 UI 面——
 * 右键菜单（打开 / 开机启动勾选 / 退出）、单击显示聚焦、驻留 hide 与首次气泡。
 * 开关的业务编排（设置落盘 + 登录项）经 onToggleLaunchAtLogin 注入；
 * 退出经 quit 注入（app.quit——走退出屏障，GLOSSARY「退出屏障」）。
 */
export function createTrayResidency(options: {
  window: BrowserWindow;
  /** 托盘图标（build/icon.ico；Windows 自动选帧） */
  iconPath: string;
  /** 创建时的开机启动勾选态（装配方已读设置，同步建菜单避免竞态） */
  initialLaunchAtLogin: boolean;
  /**
   * 静默驻留启动携带的最大化现场（ADR 0025）：Electron 的 maximize() 会
   * 强制显示窗口，驻留期间不能恢复；首次从托盘显示时补最大化（只补一次，
   * 防止最大化现场被静默启动覆盖丢失）。
   */
  pendingMaximize?: boolean;
  settings: TraySettingsStore;
  onToggleLaunchAtLogin(enabled: boolean): void;
  quit(): void;
}) {
  const win = options.window;
  const tray = new Tray(options.iconPath);
  tray.setToolTip("CodexLike");
  // 单击与双击同行为（显示聚焦；Windows 双击只派发 double-click 不再派发 click）
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());

  function applyMenu(launchAtLogin: boolean): void {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 CodexLike", click: () => showMainWindow() },
        {
          label: "开机启动",
          type: "checkbox",
          checked: launchAtLogin,
          click: (menuItem) => options.onToggleLaunchAtLogin(menuItem.checked),
        },
        { type: "separator" },
        { label: "退出", click: () => options.quit() },
      ])
    );
  }
  applyMenu(options.initialLaunchAtLogin);

  let pendingMaximize = options.pendingMaximize === true;

  function showMainWindow(): void {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (pendingMaximize && !win.isVisible()) {
      // maximize() 自带显示（不聚焦），一步完成补恢复后聚焦
      pendingMaximize = false;
      win.maximize();
      win.focus();
      return;
    }
    pendingMaximize = false;
    win.show();
    win.focus();
  }

  async function minimizeToTray(): Promise<void> {
    win.hide();
    // 首次驻留气泡提示一次（GLOSSARY「托盘驻留」），标志落盘后不再打扰
    const settings = await options.settings.get();
    if (!settings.residencyHintShown) {
      tray.displayBalloon({
        iconType: "info",
        title: "CodexLike",
        content: "应用已最小化到系统托盘，任务继续后台运行；可从托盘菜单退出。",
      });
      await options.settings.set({ residencyHintShown: true });
    }
  }

  return {
    /** 用户点关闭按钮：隐藏到托盘并（首次）气泡提示 */
    minimizeToTray,
    /** 显示并聚焦主窗口（托盘单击 / 菜单「打开」/ 第二实例激活共用） */
    showMainWindow,
    /** 开机启动开关变化后刷新菜单勾选态 */
    setLaunchAtLoginChecked(enabled: boolean) {
      applyMenu(enabled);
    },
  };
}

export type TrayResidency = ReturnType<typeof createTrayResidency>;
