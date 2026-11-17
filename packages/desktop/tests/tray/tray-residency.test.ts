import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";

import { createTrayResidency } from "../../src/tray/tray-residency";
import { createTraySettingsStore } from "../../src/tray/tray-settings-store";

/**
 * 托盘驻留控制器（ADR 0025，GLOSSARY「托盘驻留」）：只管托盘 UI 面——
 * 菜单结构、单击显示、驻留 hide 与首次气泡、勾选态刷新；
 * 开关的业务编排（落盘 + 登录项）经 onToggleLaunchAtLogin 注入。
 * 替换 Electron 系统边界（Tray / Menu，vi.hoisted 内不用 import 绑定），设置存储用真实落盘。
 */

interface MenuTemplateItem {
  label?: string;
  type?: string;
  checked?: boolean;
  click?: (menuItem: { checked: boolean }) => void;
}

const { FakeTray, builtMenus } = vi.hoisted(() => {
  // 迷你 emitter：vi.hoisted 提升到 import 初始化前执行，不能 extends EventEmitter
  class FakeTray {
    static instances: FakeTray[] = [];
    private handlers = new Map<string, (() => void)[]>();
    menu: unknown = null;
    tooltip = "";
    balloons: unknown[] = [];
    constructor(public icon: unknown) {
      FakeTray.instances.push(this);
    }
    on(name: string, handler: () => void) {
      const list = this.handlers.get(name) ?? [];
      list.push(handler);
      this.handlers.set(name, list);
    }
    emit(name: string) {
      for (const handler of this.handlers.get(name) ?? []) handler();
    }
    setContextMenu(menu: unknown) {
      this.menu = menu;
    }
    setToolTip(text: string) {
      this.tooltip = text;
    }
    displayBalloon(options: unknown) {
      this.balloons.push(options);
    }
  }
  const builtMenus: { template: MenuTemplateItem[] }[] = [];
  return { FakeTray, builtMenus };
});

vi.mock("electron", () => ({
  Tray: FakeTray,
  Menu: {
    buildFromTemplate: (template: MenuTemplateItem[]) => {
      const menu = { template };
      builtMenus.push(menu);
      return menu;
    },
  },
}));

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  FakeTray.instances.length = 0;
  builtMenus.length = 0;
});

function makeWindow() {
  return {
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    maximize: vi.fn(),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
  };
}

function setup(
  options: { launchAtLogin?: boolean; pendingMaximize?: boolean } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), "tray-residency-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const settings = createTraySettingsStore({ dir });
  const win = makeWindow();
  const onToggleLaunchAtLogin = vi.fn();
  const quit = vi.fn();
  const tray = createTrayResidency({
    window: win as unknown as BrowserWindow,
    iconPath: join(dir, "icon.ico"),
    initialLaunchAtLogin: options.launchAtLogin === true,
    pendingMaximize: options.pendingMaximize,
    settings,
    onToggleLaunchAtLogin,
    quit,
  });
  return { dir, settings, win, onToggleLaunchAtLogin, quit, tray };
}

/** 最近一次构建的菜单模板（重建菜单后取 builtMenus 最后一项） */
function lastTemplate() {
  return builtMenus[builtMenus.length - 1]!.template;
}

function findItem(template: MenuTemplateItem[], label: string) {
  const item = template.find((entry) => entry.label === label);
  if (!item) throw new Error(`菜单中找不到「${label}」`);
  return item;
}

it("创建托盘：用注入图标、tooltip CodexLike、菜单四项且勾选态跟设置", () => {
  const { tray } = setup({ launchAtLogin: true });
  expect(FakeTray.instances).toHaveLength(1);
  const instance = FakeTray.instances[0]!;
  expect(instance.icon).toContain("icon.ico");
  expect(instance.tooltip).toBe("CodexLike");
  const labels = lastTemplate().map((item) => item.label ?? item.type);
  expect(labels).toEqual(["打开 CodexLike", "开机启动", "separator", "退出"]);
  expect(findItem(lastTemplate(), "开机启动").checked).toBe(true);
  expect(tray).toBeDefined();
});

it("托盘单击：显示并聚焦主窗口；最小化态先还原", () => {
  const { win } = setup();
  FakeTray.instances[0]!.emit("click");
  expect(win.show).toHaveBeenCalledOnce();
  expect(win.focus).toHaveBeenCalledOnce();
  expect(win.restore).not.toHaveBeenCalled();

  win.isMinimized.mockReturnValue(true);
  FakeTray.instances[0]!.emit("click");
  expect(win.restore).toHaveBeenCalledOnce();
});

it("双击与单击同行为（Windows 双击只派发 double-click，GLOSSARY「托盘驻留」）", () => {
  const { win } = setup();
  FakeTray.instances[0]!.emit("double-click");
  expect(win.show).toHaveBeenCalledOnce();
  expect(win.focus).toHaveBeenCalledOnce();
});

it("minimizeToTray 首次：隐藏窗口、气泡提示一次、标志落盘", async () => {
  const { dir, win, tray } = setup();
  await tray.minimizeToTray();
  expect(win.hide).toHaveBeenCalledOnce();
  const instance = FakeTray.instances[0]!;
  expect(instance.balloons).toHaveLength(1);
  expect(instance.balloons[0]).toMatchObject({ title: "CodexLike" });
  expect(
    JSON.parse(readFileSync(join(dir, "tray-settings.json"), "utf8"))
  ).toEqual({ launchAtLogin: false, residencyHintShown: true });
});

it("minimizeToTray 第二次起不再气泡", async () => {
  const { tray } = setup();
  await tray.minimizeToTray();
  await tray.minimizeToTray();
  await tray.minimizeToTray();
  expect(FakeTray.instances[0]!.balloons).toHaveLength(1);
});

it("菜单「打开」click 显示主窗口；「退出」click 走注入的 quit", () => {
  const { win, quit } = setup();
  findItem(lastTemplate(), "打开 CodexLike").click!({ checked: false });
  expect(win.show).toHaveBeenCalledOnce();
  findItem(lastTemplate(), "退出").click!({ checked: false });
  expect(quit).toHaveBeenCalledOnce();
});

it("菜单「开机启动」click 以切换后的勾选态回调注入编排", () => {
  const { onToggleLaunchAtLogin } = setup();
  findItem(lastTemplate(), "开机启动").click!({ checked: true });
  expect(onToggleLaunchAtLogin).toHaveBeenCalledExactlyOnceWith(true);
  findItem(lastTemplate(), "开机启动").click!({ checked: false });
  expect(onToggleLaunchAtLogin).toHaveBeenNthCalledWith(2, false);
});

it("setLaunchAtLoginChecked 重建菜单并更新勾选态", () => {
  const { tray } = setup();
  expect(findItem(lastTemplate(), "开机启动").checked).toBe(false);
  tray.setLaunchAtLoginChecked(true);
  const instance = FakeTray.instances[0]!;
  expect(instance.menu).toBe(builtMenus[builtMenus.length - 1]);
  expect(findItem(lastTemplate(), "开机启动").checked).toBe(true);
});

it("pendingMaximize：静默启动携最大化现场，首次从托盘显示时最大化补恢复（只补一次）", () => {
  const { tray, win } = setup({ pendingMaximize: true });
  win.isVisible = vi.fn(() => false);
  tray.showMainWindow();
  expect(win.maximize).toHaveBeenCalledOnce();
  expect(win.show).not.toHaveBeenCalled();
  // 第二次显示（如再驻留后再打开）不再重复最大化
  tray.showMainWindow();
  expect(win.maximize).toHaveBeenCalledOnce();
  expect(win.show).toHaveBeenCalledOnce();
});
