import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTerminalSettingsStore,
  isTerminalShell,
  parseTerminalSettingsInput,
  resolveTerminalShell,
} from "../../src/terminal/terminal-settings-store";

/**
 * 终端设置（code review 修复 1 + 执行设置票04）：shell 偏好与命令超时两项的
 * store 持久化、「设置项优先、env 兜底」合并纯函数、IPC 边界输入解析。
 */
let tempDir: string;

function makeDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "codexlike-terminal-settings-"));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("terminal-settings-store", () => {
  it("未配置（无文件）返回 shell null 与超时默认值 30s/120s，不落文件", async () => {
    const dir = makeDir();
    const store = createTerminalSettingsStore({ dir });
    expect(await store.get()).toEqual({
      shell: null,
      commandTimeoutSeconds: 30,
      maxCommandTimeoutSeconds: 120,
    });
  });

  it("set/get 往返：shell 与两项超时持久化，重启（新实例）仍读到", async () => {
    const dir = makeDir();
    const store = createTerminalSettingsStore({ dir });
    const saved = await store.set({
      shell: "powershell",
      commandTimeoutSeconds: 300,
      maxCommandTimeoutSeconds: 1800,
    });
    expect(saved).toEqual({
      shell: "powershell",
      commandTimeoutSeconds: 300,
      maxCommandTimeoutSeconds: 1800,
    });
    expect(await store.get()).toEqual(saved);

    const reopened = createTerminalSettingsStore({ dir });
    expect(await reopened.get()).toEqual(saved);
    expect(
      JSON.parse(readFileSync(join(dir, "terminal-settings.json"), "utf8"))
    ).toEqual(saved);
  });

  it("set 拒绝非法输入（shell 枚举、超时范围、非整数、命令超时 > 最大命令超时），且不落盘", async () => {
    const dir = makeDir();
    const store = createTerminalSettingsStore({ dir });
    await expect(
      store.set({
        shell: "zsh" as never,
        commandTimeoutSeconds: 30,
        maxCommandTimeoutSeconds: 120,
      })
    ).rejects.toThrow("git-bash / powershell / cmd");

    for (const commandTimeoutSeconds of [4, 601]) {
      await expect(
        store.set({
          shell: "cmd",
          commandTimeoutSeconds,
          maxCommandTimeoutSeconds: 120,
        })
      ).rejects.toThrow("5-600");
    }
    for (const maxCommandTimeoutSeconds of [9, 1801]) {
      await expect(
        store.set({
          shell: "cmd",
          commandTimeoutSeconds: 30,
          maxCommandTimeoutSeconds,
        })
      ).rejects.toThrow("10-1800");
    }
    await expect(
      store.set({
        shell: "cmd",
        commandTimeoutSeconds: 30.5,
        maxCommandTimeoutSeconds: 120,
      })
    ).rejects.toThrow("整数");
    await expect(
      store.set({
        shell: "cmd",
        commandTimeoutSeconds: 300,
        maxCommandTimeoutSeconds: 120,
      })
    ).rejects.toThrow("不能大于最大命令超时");

    // 全部被拒：文件不应产生
    expect(await store.get()).toEqual({
      shell: null,
      commandTimeoutSeconds: 30,
      maxCommandTimeoutSeconds: 120,
    });
  });

  it("损坏文件按默认值处理，不抛错", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "terminal-settings.json"), "{oops", "utf8");
    expect(await createTerminalSettingsStore({ dir }).get()).toEqual({
      shell: null,
      commandTimeoutSeconds: 30,
      maxCommandTimeoutSeconds: 120,
    });
  });

  it("旧格式文件（只有 shell 字段）：超时两项按默认值补齐", async () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "terminal-settings.json"),
      '{"shell":"cmd"}',
      "utf8"
    );
    expect(await createTerminalSettingsStore({ dir }).get()).toEqual({
      shell: "cmd",
      commandTimeoutSeconds: 30,
      maxCommandTimeoutSeconds: 120,
    });
  });

  it("文件存在但字段非法（shell 越枚举、超时非数字）分别按未配置/默认值处理", async () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "terminal-settings.json"),
      '{"shell":"fish","commandTimeoutSeconds":"abc","maxCommandTimeoutSeconds":null}',
      "utf8"
    );
    expect(await createTerminalSettingsStore({ dir }).get()).toEqual({
      shell: null,
      commandTimeoutSeconds: 30,
      maxCommandTimeoutSeconds: 120,
    });
  });

  it("越界的历史值读取时收敛到合法范围，且命令超时不大于最大命令超时（防手改文件）", async () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "terminal-settings.json"),
      '{"shell":"cmd","commandTimeoutSeconds":9999,"maxCommandTimeoutSeconds":9999}',
      "utf8"
    );
    expect(await createTerminalSettingsStore({ dir }).get()).toEqual({
      shell: "cmd",
      commandTimeoutSeconds: 600,
      maxCommandTimeoutSeconds: 1800,
    });

    const dir2 = makeDir();
    writeFileSync(
      join(dir2, "terminal-settings.json"),
      '{"commandTimeoutSeconds":3000,"maxCommandTimeoutSeconds":50}',
      "utf8"
    );
    // 命令超时先被范围收敛到 600，再被最大命令超时压到 50
    expect(await createTerminalSettingsStore({ dir: dir2 }).get()).toEqual({
      shell: null,
      commandTimeoutSeconds: 50,
      maxCommandTimeoutSeconds: 50,
    });
  });
});

describe("parseTerminalSettingsInput（IPC 边界：不信任渲染进程输入）", () => {
  it("合法对象解析为 TerminalSettings 形状", () => {
    expect(
      parseTerminalSettingsInput({
        shell: "git-bash",
        commandTimeoutSeconds: 60,
        maxCommandTimeoutSeconds: 300,
      })
    ).toEqual({
      shell: "git-bash",
      commandTimeoutSeconds: 60,
      maxCommandTimeoutSeconds: 300,
    });
  });

  it("非对象 / 缺字段 / 字段类型错误均以中文异常拒绝", () => {
    expect(() => parseTerminalSettingsInput(null)).toThrow();
    expect(() => parseTerminalSettingsInput("cmd")).toThrow();
    expect(() => parseTerminalSettingsInput({})).toThrow();
    expect(() =>
      parseTerminalSettingsInput({ shell: "cmd", commandTimeoutSeconds: 30 })
    ).toThrow();
    expect(() =>
      parseTerminalSettingsInput({
        shell: "zsh",
        commandTimeoutSeconds: 30,
        maxCommandTimeoutSeconds: 120,
      })
    ).toThrow();
    expect(() =>
      parseTerminalSettingsInput({
        shell: "cmd",
        commandTimeoutSeconds: "30",
        maxCommandTimeoutSeconds: 120,
      })
    ).toThrow();
  });

  it("超时越界或命令超时大于最大命令超时同样拒绝", () => {
    expect(() =>
      parseTerminalSettingsInput({
        shell: "cmd",
        commandTimeoutSeconds: 0,
        maxCommandTimeoutSeconds: 120,
      })
    ).toThrow("5-600");
    expect(() =>
      parseTerminalSettingsInput({
        shell: "cmd",
        commandTimeoutSeconds: 300,
        maxCommandTimeoutSeconds: 100,
      })
    ).toThrow("不能大于最大命令超时");
  });
});

describe("resolveTerminalShell（设置项优先、CODEXLIKE_SHELL 兜底）", () => {
  it("设置项存在时优先于环境变量", () => {
    expect(resolveTerminalShell("cmd", "powershell")).toBe("cmd");
    expect(resolveTerminalShell("git-bash", "powershell")).toBe("git-bash");
  });

  it("未配置（null）时环境变量兜底", () => {
    expect(resolveTerminalShell(null, "powershell")).toBe("powershell");
    expect(resolveTerminalShell(null, "cmd")).toBe("cmd");
    expect(resolveTerminalShell(null, "git-bash")).toBe("git-bash");
  });

  it("环境变量非法或缺失时默认 Git Bash", () => {
    expect(resolveTerminalShell(null, undefined)).toBe("git-bash");
    expect(resolveTerminalShell(null, "zsh")).toBe("git-bash");
    expect(resolveTerminalShell(null, "")).toBe("git-bash");
  });

  it("isTerminalShell 枚举判定", () => {
    expect(isTerminalShell("powershell")).toBe(true);
    expect(isTerminalShell("zsh")).toBe(false);
    expect(isTerminalShell(123)).toBe(false);
  });
});
