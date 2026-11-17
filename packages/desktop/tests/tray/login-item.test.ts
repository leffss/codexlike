import { expect, it, vi } from "vitest";

import { shouldStartHidden, syncLoginItem } from "../../src/tray/login-item";

/**
 * 开机启动登录项同步（ADR 0025，GLOSSARY「开机启动」）：
 * 打包环境按 openAtLogin + args=['--hidden'] 注册（随登录静默驻留托盘）；
 * 开发模式（exe 是 electron.exe）不写，避免把开发器注册进登录项。
 */

function fakeApp(isPackaged: boolean) {
  return {
    isPackaged,
    setLoginItemSettings: vi.fn(),
  };
}

it("打包环境开启：注册登录项并携带 --hidden（开机静默驻留）", () => {
  const app = fakeApp(true);
  syncLoginItem(app, true);
  expect(app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({
    openAtLogin: true,
    args: ["--hidden"],
  });
});

it("打包环境关闭：写 openAtLogin=false 移除登录项", () => {
  const app = fakeApp(true);
  syncLoginItem(app, false);
  expect(app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({
    openAtLogin: false,
    args: ["--hidden"],
  });
});

it("开发模式（未打包）不写登录项，避免注册 electron.exe", () => {
  const app = fakeApp(false);
  syncLoginItem(app, true);
  expect(app.setLoginItemSettings).not.toHaveBeenCalled();
});

it("shouldStartHidden：argv 含 --hidden 判定开机静默驻留（手动打开不带该参数）", () => {
  expect(shouldStartHidden(["CodexLike.exe"])).toBe(false);
  expect(shouldStartHidden([])).toBe(false);
  expect(shouldStartHidden(["CodexLike.exe", "--hidden"])).toBe(true);
});
