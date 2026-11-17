import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { TraySettings } from "../../src/tray/tray-settings-store";
import { registerTraySettingsHandlers } from "../../src/tray/tray-settings-ipc";
import { createTraySettingsStore } from "../../src/tray/tray-settings-store";
import { IPC } from "../../src/shared/ipc";

/**
 * 托盘设置 IPC（ADR 0025）：get/set 通道 + boolean 边界校验 + 保存回调
 * （主进程在此同步登录项与托盘菜单勾选）。handler 注册与 main.ts 生产
 * 路径同一函数（mock ipcMain 收集后直调）；residencyHintShown 是内部
 * 标志，不经 IPC 透出。
 */

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) =>
      handlers.set(name, fn),
  },
}));

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  handlers.clear();
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册通道 ${channel}`);
  // async 包裹：边界校验的同步抛出统一表现为 promise rejection（与 ipcMain.invoke 一致）
  return handler({}, ...args);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tray-settings-ipc-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = createTraySettingsStore({ dir });
  const saved: TraySettings[] = [];
  registerTraySettingsHandlers({
    store,
    onSaved: (settings) => {
      saved.push(settings);
    },
  });
  return { store, saved };
}

it("get 返回当前设置（默认开机启动关）", async () => {
  setup();
  expect(await invoke(IPC.traySettings.get)).toEqual({
    launchAtLogin: false,
    residencyHintShown: false,
  });
});

it("set 开机启动：落盘并触发 onSaved（登录项与托盘菜单同步入口），返回完整设置", async () => {
  const { saved } = setup();
  expect(await invoke(IPC.traySettings.set, { launchAtLogin: true })).toEqual({
    launchAtLogin: true,
    residencyHintShown: false,
  });
  expect(saved).toEqual([{ launchAtLogin: true, residencyHintShown: false }]);
});

it("set 非布尔值以中文异常拒绝，不触发 onSaved", async () => {
  const { saved } = setup();
  await expect(
    invoke(IPC.traySettings.set, { launchAtLogin: "yes" })
  ).rejects.toThrow("开机启动必须是布尔值");
  await expect(invoke(IPC.traySettings.set, null)).rejects.toThrow();
  expect(saved).toEqual([]);
});
