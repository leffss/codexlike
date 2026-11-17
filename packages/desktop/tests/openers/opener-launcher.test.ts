import { describe, expect, it, vi } from "vitest";

import { createOpenerLauncher } from "../../src/openers/opener-launcher";
import type { ResolvedOpener } from "../../src/openers/opener-resolver";

/**
 * 工作区打开器启动器：explorer 走 shell.openPath（错误消息映射为中文异常）、
 * 编辑器 exe 走 detach spawn（spawn 成功即返回，error 拒绝）。
 * 依赖（openPath / spawnProcess）注入，真实绑定在主进程装配处。
 */

/** 假 spawn 子进程：记录 once 订阅，测试手动派发 spawn/error 事件 */
function fakeSpawn() {
  const spawned: {
    command: string;
    args: string[];
    options?: { cwd?: string };
    listeners: { error: ((error: Error) => void)[]; spawn: (() => void)[] };
  }[] = [];
  const unref = vi.fn();
  return {
    spawned,
    unref,
    spawn: vi.fn(
      (
        command: string,
        args: string[],
        options?: { cwd?: string; windowsHide?: boolean }
      ) => {
        const child = {
          command,
          args,
          options,
          listeners: {
            error: [] as ((error: Error) => void)[],
            spawn: [] as (() => void)[],
          },
        };
        spawned.push(child);
        return {
          once: (event: "error" | "spawn", listener: never) => {
            (child.listeners[event] as never[]).push(listener);
          },
          unref: () => unref(),
        };
      }
    ),
    emit(
      child: (typeof spawned)[number],
      event: "error" | "spawn",
      payload?: Error
    ) {
      for (const listener of child.listeners[event]) {
        if (event === "error") (listener as (e: Error) => void)(payload!);
        else (listener as () => void)();
      }
    },
  };
}

const explorer: ResolvedOpener = { id: "explorer", exePath: null };
const vscode: ResolvedOpener = {
  id: "vscode",
  exePath: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
};
const wtTerminal: ResolvedOpener = {
  id: "terminal",
  exePath: "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
  terminalStyle: "wt",
};
const bashTerminal: ResolvedOpener = {
  id: "terminal",
  exePath: "C:\\Program Files\\Git\\bin\\bash.exe",
  terminalStyle: "inherit-cwd",
};

describe("createOpenerLauncher", () => {
  it("explorer：shell.openPath 成功（空串）即通过；失败消息映射为中文异常", async () => {
    const openPath = vi.fn(async () => "");
    const launch = createOpenerLauncher({
      openPath,
      spawnProcess: fakeSpawn().spawn,
    });
    await expect(launch(explorer, "C:\\ws")).resolves.toBeUndefined();
    expect(openPath).toHaveBeenCalledWith("C:\\ws");

    const failing = createOpenerLauncher({
      openPath: vi.fn(async () => "文件不存在"),
      spawnProcess: fakeSpawn().spawn,
    });
    await expect(failing(explorer, "C:\\gone")).rejects.toThrow(
      /资源管理器打开失败：文件不存在/
    );
  });

  it("编辑器 exe：detach spawn 成功即返回并 unref；启动错误拒绝并带 exe 路径", async () => {
    const fake = fakeSpawn();
    const launch = createOpenerLauncher({
      openPath: vi.fn(async () => ""),
      spawnProcess: fake.spawn,
    });

    const pending = launch(vscode, "C:\\ws");
    expect(fake.spawn).toHaveBeenCalledWith(vscode.exePath, ["C:\\ws"]);
    const first = fake.spawned[0];
    if (!first) throw new Error("未记录 spawn 调用");
    fake.emit(first, "spawn");
    await expect(pending).resolves.toBeUndefined();
    expect(fake.unref).toHaveBeenCalledTimes(1);

    const failing = launch(vscode, "C:\\ws");
    const second = fake.spawned[1];
    if (!second) throw new Error("未记录第二次 spawn 调用");
    fake.emit(second, "error", new Error("ENOENT"));
    await expect(failing).rejects.toThrow(/Code\.exe.*ENOENT/);
  });

  it("终端（wt 风格）：-d 显式起始目录（不传 cwd），窗口不隐藏，成功 unref", async () => {
    const fake = fakeSpawn();
    const launch = createOpenerLauncher({
      openPath: vi.fn(async () => ""),
      spawnProcess: fake.spawn,
    });

    const pending = launch(wtTerminal, "C:\\ws");
    expect(fake.spawn).toHaveBeenCalledWith(
      wtTerminal.exePath,
      ["-d", "C:\\ws"],
      { windowsHide: false }
    );
    const first = fake.spawned[0];
    if (!first) throw new Error("未记录 spawn 调用");
    fake.emit(first, "spawn");
    await expect(pending).resolves.toBeUndefined();
    expect(fake.unref).toHaveBeenCalledTimes(1);
  });

  it("终端（cwd 继承风格）：无参启动，工作区经 cwd 传入且窗口不隐藏（bash/powershell/cmd）", async () => {
    const fake = fakeSpawn();
    const launch = createOpenerLauncher({
      openPath: vi.fn(async () => ""),
      spawnProcess: fake.spawn,
    });

    const pending = launch(bashTerminal, "C:\\ws");
    expect(fake.spawn).toHaveBeenCalledWith(bashTerminal.exePath, [], {
      cwd: "C:\\ws",
      windowsHide: false,
    });
    const first = fake.spawned[0];
    if (!first) throw new Error("未记录 spawn 调用");
    fake.emit(first, "spawn");
    await expect(pending).resolves.toBeUndefined();
  });
});
