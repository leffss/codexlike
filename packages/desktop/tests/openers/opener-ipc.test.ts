import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { TerminalShell } from "@codexlike/agent-core/node";

import { registerOpenerHandlers } from "../../src/openers/opener-ipc";
import { createOpenerSettingsStore } from "../../src/openers/opener-settings-store";
import type {
  OpenerProbeEnv,
  ResolvedOpener,
} from "../../src/openers/opener-resolver";
import { IPC } from "../../src/shared/ipc";

/**
 * 工作区打开器 IPC：list（候选+默认折算）与 open（主按钮默认打开 / 点选
 * 打开并记默认）两通道 + 边界校验 + E2E 测试钩子（CODEXLIKE_TEST_OPENER_LOG：
 * 全量可用、open 只记录不启动）。handler 注册与 main.ts 生产路径同一函数
 * （mock ipcMain 收集后直调）；launch/probeEnv 注入假实现。
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
  return handler({}, ...args);
}

/** 假探测环境：files 内的 exe 视为可用（explorer 恒在）；系统装根目录固定 */
function probeEnv(
  files: string[],
  overrides: Partial<OpenerProbeEnv> = {}
): OpenerProbeEnv {
  const fileSet = new Set(files);
  return {
    localAppData: null,
    programFiles: "C:\\Program Files",
    pathEntries: [],
    exists: (path) => fileSet.has(path),
    readDir: () => null,
    ...overrides,
  };
}

interface Launch {
  id: string;
  workspacePath: string;
}

function setup(options: {
  files?: string[];
  probeOverrides?: Partial<OpenerProbeEnv>;
  launchError?: Error;
  testLogPath?: string;
  terminalShell?: () => TerminalShell;
}) {
  const dir = mkdtempSync(join(tmpdir(), "opener-ipc-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = createOpenerSettingsStore({ dir });
  const launched: Launch[] = [];
  const resolved: ResolvedOpener[] = [];
  registerOpenerHandlers({
    store,
    probeEnv: probeEnv(options.files ?? [], options.probeOverrides),
    launch: async (opener, workspacePath) => {
      if (options.launchError) throw options.launchError;
      launched.push({ id: opener.id, workspacePath });
      resolved.push(opener);
    },
    ...(options.terminalShell !== undefined
      ? { terminalShell: options.terminalShell }
      : {}),
    ...(options.testLogPath !== undefined
      ? { testLogPath: options.testLogPath }
      : {}),
  });
  return { store, launched, resolved, dir };
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "opener-ipc-ws-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const VSCODE_EXE = "C:\\Program Files\\Microsoft VS Code\\Code.exe";

it("list：返回探测到的候选（含标签）与默认 explorer", async () => {
  const {} = setup({ files: [VSCODE_EXE] });
  const result = (await invoke(IPC.openers.list)) as {
    openers: { id: string; label: string }[];
    defaultId: string;
  };
  expect(result.openers).toEqual([
    { id: "explorer", label: "资源管理器" },
    { id: "vscode", label: "VS Code" },
  ]);
  expect(result.defaultId).toBe("explorer");
});

it("list：保存的默认已不在可用列表（卸载）时折算回 explorer，不改写文件", async () => {
  const { store } = setup({});
  await store.set({ defaultId: "pycharm" });
  const result = (await invoke(IPC.openers.list)) as { defaultId: string };
  expect(result.defaultId).toBe("explorer");
  // 文件仍保存 pycharm，重装后自行恢复
  expect(await store.get()).toEqual({ defaultId: "pycharm" });
});

it("open（主按钮，无 id）：用当前默认打开，不改保存值", async () => {
  const { launched, store } = setup({});
  const ws = workspace();
  const result = (await invoke(IPC.openers.open, {
    workspacePath: ws,
  })) as { defaultId: string };
  expect(launched).toEqual([{ id: "explorer", workspacePath: ws }]);
  expect(result.defaultId).toBe("explorer");
  expect(await store.get()).toEqual({ defaultId: "explorer" });
});

it("open（点选下拉项）：以该程序打开并持久化为默认，list 反映新默认", async () => {
  const { launched, store } = setup({ files: [VSCODE_EXE] });
  const ws = workspace();
  const result = (await invoke(IPC.openers.open, {
    workspacePath: ws,
    openerId: "vscode",
  })) as { defaultId: string };
  expect(launched).toEqual([{ id: "vscode", workspacePath: ws }]);
  expect(result.defaultId).toBe("vscode");
  expect(await store.get()).toEqual({ defaultId: "vscode" });
  const list = (await invoke(IPC.openers.list)) as { defaultId: string };
  expect(list.defaultId).toBe("vscode");
});

it("终端打开器：点选即打开并记默认，偏好注入决定探测结果（terminalStyle 传到启动器）", async () => {
  const cmd = join("C:\\Windows", "System32", "cmd.exe");
  const { resolved, store } = setup({
    files: [cmd],
    probeOverrides: { systemRoot: "C:\\Windows" },
    terminalShell: () => "cmd",
  });
  const ws = workspace();
  const result = (await invoke(IPC.openers.open, {
    workspacePath: ws,
    openerId: "terminal",
  })) as { defaultId: string };
  expect(result.defaultId).toBe("terminal");
  expect(await store.get()).toEqual({ defaultId: "terminal" });
  expect(resolved.find((o) => o.id === "terminal")).toMatchObject({
    exePath: cmd,
    terminalStyle: "inherit-cwd",
  });
});

it("open 边界：非法输入、目录不存在、未知/未探测到的 id 均中文拒绝", async () => {
  const { launched } = setup({ files: [VSCODE_EXE] });
  const ws = workspace();
  await expect(invoke(IPC.openers.open, null)).rejects.toThrow(/不合法/);
  await expect(invoke(IPC.openers.open, { workspacePath: "" })).rejects.toThrow(
    /不合法/
  );
  await expect(
    invoke(IPC.openers.open, { workspacePath: "C:\\__missing__" })
  ).rejects.toThrow(/目录不存在/);
  await expect(
    invoke(IPC.openers.open, { workspacePath: ws, openerId: "notepad" })
  ).rejects.toThrow(/未知打开器/);
  await expect(
    invoke(IPC.openers.open, { workspacePath: ws, openerId: "pycharm" })
  ).rejects.toThrow(/PyCharm 未检测到/);
  expect(launched).toEqual([]);
});

it("open 失败（启动器抛错）不改默认", async () => {
  const { store } = setup({
    files: [VSCODE_EXE],
    launchError: new Error("spawn ENOENT"),
  });
  await expect(
    invoke(IPC.openers.open, {
      workspacePath: workspace(),
      openerId: "vscode",
    })
  ).rejects.toThrow(/ENOENT/);
  expect(await store.get()).toEqual({ defaultId: "explorer" });
});

it("E2E 钩子：testLogPath 下 list 全量可用、open 记录 JSON 行不启动程序、默认仍持久化", async () => {
  const logFile = join(
    mkdtempSync(join(tmpdir(), "opener-ipc-log-")),
    "openings.log"
  );
  const { launched } = setup({ testLogPath: logFile });
  const ws = workspace();
  const list = (await invoke(IPC.openers.list)) as {
    openers: { id: string }[];
  };
  expect(list.openers.map((o) => o.id)).toEqual([
    "explorer",
    "terminal",
    "vscode",
    "pycharm",
    "intellij",
    "webstorm",
  ]);
  await invoke(IPC.openers.open, { workspacePath: ws, openerId: "pycharm" });
  await invoke(IPC.openers.open, { workspacePath: ws });
  expect(launched).toEqual([]);
  const lines = readFileSync(logFile, "utf8").trim().split("\n");
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    { openerId: "pycharm", workspacePath: ws },
    // 主按钮：默认已折算为上一次点选的 pycharm
    { openerId: "pycharm", workspacePath: ws },
  ]);
});

it("损坏的设置文件不阻断 list（回退默认 explorer）", async () => {
  const { dir } = setup({});
  writeFileSync(join(dir, "opener-settings.json"), "{broken", "utf8");
  const result = (await invoke(IPC.openers.list)) as { defaultId: string };
  expect(result.defaultId).toBe("explorer");
});
