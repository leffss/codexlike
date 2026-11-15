import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { TerminalSettings } from "../../src/terminal/terminal-settings-store";
import { registerTerminalSettingsHandlers } from "../../src/terminal/terminal-settings-ipc";
import { createTerminalSettingsStore } from "../../src/terminal/terminal-settings-store";
import { IPC } from "../../src/shared/ipc";

/**
 * 终端设置 IPC（执行设置票04）：get/set 通道 + 边界校验 + 保存回调。
 * handler 注册与 main.ts 生产路径同一函数（mock ipcMain 收集后直调）。
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
  const dir = mkdtempSync(join(tmpdir(), "terminal-settings-ipc-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = createTerminalSettingsStore({ dir });
  const saved: TerminalSettings[] = [];
  registerTerminalSettingsHandlers({
    store,
    onSaved: (settings) => {
      saved.push(settings);
    },
  });
  return { store, saved };
}

it("get 返回当前终端设置（未配置时 shell null + 超时默认值）", async () => {
  setup();
  expect(await invoke(IPC.terminalSettings.get)).toEqual({
    shell: null,
    commandTimeoutSeconds: 30,
    maxCommandTimeoutSeconds: 120,
  });
});

it("set 合法输入：落盘保存并触发 onSaved（主进程缓存更新入口），返回保存后的值", async () => {
  const { saved } = setup();
  const input = {
    shell: "git-bash",
    commandTimeoutSeconds: 600,
    maxCommandTimeoutSeconds: 1800,
  };
  expect(await invoke(IPC.terminalSettings.set, input)).toEqual(input);
  expect(saved).toEqual([input]);
});

it("set 非法输入以中文异常拒绝，不触发 onSaved", async () => {
  const { saved } = setup();
  await expect(
    invoke(IPC.terminalSettings.set, {
      shell: "zsh",
      commandTimeoutSeconds: 30,
      maxCommandTimeoutSeconds: 120,
    })
  ).rejects.toThrow("git-bash / powershell / cmd");
  await expect(
    invoke(IPC.terminalSettings.set, {
      shell: "cmd",
      commandTimeoutSeconds: 601,
      maxCommandTimeoutSeconds: 1200,
    })
  ).rejects.toThrow("5-600");
  await expect(
    invoke(IPC.terminalSettings.set, {
      shell: "cmd",
      commandTimeoutSeconds: 300,
      maxCommandTimeoutSeconds: 120,
    })
  ).rejects.toThrow("不能大于最大命令超时");
  await expect(invoke(IPC.terminalSettings.set, "cmd")).rejects.toThrow();
  expect(saved).toEqual([]);
});
