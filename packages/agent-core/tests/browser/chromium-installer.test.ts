import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const sdkBoundary = vi.hoisted(() => ({ directory: "" }));

// 工厂先于被测模块导入调用；返回真实 SDK，只隔离首次加载的宿主环境。
vi.mock("playwright-core", async () => {
  const { createRequire } = await import("node:module");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadIsolatedPlaywright } = await import("./isolated-playwright");
  sdkBoundary.directory = mkdtempSync(join(tmpdir(), "codexlike-pw-import-"));
  return loadIsolatedPlaywright(
    createRequire(import.meta.url),
    sdkBoundary.directory
  );
});

import {
  createCliChromiumInstaller,
  ensureChromiumReady,
  type ChromiumInstaller,
} from "../../src/browser/chromium";

const directories: string[] = [];

afterAll(() => {
  if (sdkBoundary.directory)
    rmSync(sdkBoundary.directory, { recursive: true, force: true });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexlike-pw-"));
  directories.push(directory);
  return directory;
}

/** 可注入的假安装器：按剧本切换就绪状态、可注入安装失败 */
function fakeInstaller(
  script: {
    readyInitially?: boolean;
    readyAfterInstall?: boolean;
    installError?: Error;
  } = {}
): ChromiumInstaller & { readonly installCalls: number } {
  let installCalls = 0;
  const installer: ChromiumInstaller = {
    executablePath: () => "C:\\fake\\chrome.exe",
    isReady: () =>
      installCalls === 0
        ? script.readyInitially === true
        : (script.readyAfterInstall ?? true),
    install(onProgress) {
      installCalls += 1;
      for (const line of ["正在下载 Chromium…", "下载完成"]) onProgress(line);
      return script.installError
        ? Promise.reject(script.installError)
        : Promise.resolve();
    },
  };
  return Object.defineProperty(installer, "installCalls", {
    get: () => installCalls,
  }) as ChromiumInstaller & { readonly installCalls: number };
}

describe("ensureChromiumReady（首次使用前确保 Chromium 就绪）", () => {
  it("已就绪时不触发下载", async () => {
    const installer = fakeInstaller({ readyInitially: true });
    await ensureChromiumReady(installer, () => {});
    expect(installer.installCalls).toBe(0);
  });

  it("未就绪时执行安装并把进度逐行回调", async () => {
    const lines: string[] = [];
    const installer = fakeInstaller(); // 剧本：初始缺失，安装一次后即就绪
    await ensureChromiumReady(installer, (line) => lines.push(line));
    expect(installer.installCalls).toBe(1);
    expect(lines).toEqual(["正在下载 Chromium…", "下载完成"]);
  });

  it("安装失败抛中文错误（含重试与镜像提示），再次调用可重试", async () => {
    const installer = fakeInstaller({
      installError: new Error("download failed: connect ETIMEDOUT"),
      readyAfterInstall: false, // 两次安装都失败：任何时刻都不就绪
    });
    const progress: string[] = [];
    await expect(
      ensureChromiumReady(installer, (line) => progress.push(line))
    ).rejects.toThrow(/Chromium 下载失败.*重试.*PLAYWRIGHT_DOWNLOAD_HOST/s);
    // 失败可重试：再次调用仍会尝试安装
    await expect(ensureChromiumReady(installer, () => {})).rejects.toThrow();
    expect(installer.installCalls).toBe(2);
  });

  it("安装器成功返回但可执行仍缺失时报「仍未就绪」", async () => {
    const installer = fakeInstaller({ readyAfterInstall: false });
    await expect(ensureChromiumReady(installer, () => {})).rejects.toThrow(
      /仍未就绪/
    );
  });
});

/** 仿 node:child_process.spawn 返回的子进程（stdout/stderr 流 + exit 事件） */
function fakeSpawn(
  script: (
    args: readonly string[],
    env: NodeJS.ProcessEnv
  ) => {
    code: number;
    stdout: string[];
    stderr: string[];
  }
) {
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn = (
    _command: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv }
  ) => {
    calls.push({ args, env: options.env });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill(): void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const plan = script(args, options.env);
    queueMicrotask(() => {
      for (const line of plan.stdout)
        child.stdout.emit("data", Buffer.from(`${line}\n`));
      for (const line of plan.stderr)
        child.stderr.emit("data", Buffer.from(`${line}\n`));
      child.emit("close", plan.code);
    });
    return child;
  };
  return { spawn, calls };
}

describe("createCliChromiumInstaller（默认 CLI 安装器；不真下载）", () => {
  it("executablePath/isReady 基于真实缓存目录判断", () => {
    const chrome = join(temporaryDirectory(), "chrome.exe");
    const installer = createCliChromiumInstaller({
      executablePathOverride: chrome,
      spawnOverride: fakeSpawn(() => ({ code: 0, stdout: [], stderr: [] }))
        .spawn,
    });
    expect(installer.isReady()).toBe(false);
    writeFileSync(chrome, "stub");
    expect(installer.isReady()).toBe(true);
  });

  it("TS/ESM 冷缓存解析真实 CLI，失败后可重试并复用已安装缓存", async () => {
    const executable = join(temporaryDirectory(), "chrome.exe");
    let attempts = 0;
    const { spawn, calls } = fakeSpawn((args) => {
      const cli = args[0]!;
      expect(isAbsolute(cli)).toBe(true);
      expect(existsSync(cli)).toBe(true);
      // CLI 由已安装包的 bin 契约确认，不把安装器自己的拼路径算法再写一遍。
      const pkg = JSON.parse(
        readFileSync(join(dirname(cli), "package.json"), "utf8")
      );
      expect(pkg.name).toBe("playwright-core");
      expect(realpathSync(cli)).toBe(
        realpathSync(join(dirname(cli), pkg.bin["playwright-core"]))
      );
      expect(args.slice(1)).toEqual(["install", "chromium", "--no-progress"]);
      attempts += 1;
      if (attempts === 1)
        return { code: 1, stdout: [], stderr: ["隔离的下载失败"] };
      writeFileSync(executable, "已安装替身，不启动浏览器");
      return { code: 0, stdout: [], stderr: [] };
    });
    const installer = createCliChromiumInstaller({
      executablePathOverride: executable,
      spawnOverride: spawn,
      env: {},
    });
    expect(installer.isReady()).toBe(false);
    await expect(ensureChromiumReady(installer, () => {})).rejects.toThrow(
      /隔离的下载失败/
    );
    expect(installer.isReady()).toBe(false);
    await ensureChromiumReady(installer, () => {});
    expect(installer.isReady()).toBe(true);
    await ensureChromiumReady(installer, () => {});
    expect(calls).toHaveLength(2);
  });

  it("用 playwright-core CLI 安装 chromium；未显式配置下载源时默认 npmmirror 镜像", async () => {
    const { spawn, calls } = fakeSpawn(() => ({
      code: 0,
      stdout: ["下载中 50%"],
      stderr: [],
    }));
    const installer = createCliChromiumInstaller({
      spawnOverride: spawn,
      env: { PATH: "x" },
    });
    const lines: string[] = [];
    await installer.install((line) => lines.push(line));
    expect(calls[0]?.args.join(" ")).toContain("install chromium");
    expect(calls[0]?.env["PLAYWRIGHT_DOWNLOAD_HOST"]).toBe(
      "https://npmmirror.com/mirrors/playwright/"
    );
    expect(lines).toContain("下载中 50%");
  });

  it("用户已设置 PLAYWRIGHT_DOWNLOAD_HOST 时不覆盖", async () => {
    const { spawn, calls } = fakeSpawn(() => ({
      code: 0,
      stdout: [],
      stderr: [],
    }));
    const installer = createCliChromiumInstaller({
      spawnOverride: spawn,
      env: { PLAYWRIGHT_DOWNLOAD_HOST: "https://custom.example.com" },
    });
    await installer.install(() => {});
    expect(calls[0]?.env["PLAYWRIGHT_DOWNLOAD_HOST"]).toBe(
      "https://custom.example.com"
    );
  });

  it("Electron 宿主下以 ELECTRON_RUN_AS_NODE 运行 CLI", async () => {
    const { spawn, calls } = fakeSpawn(() => ({
      code: 0,
      stdout: [],
      stderr: [],
    }));
    const installer = createCliChromiumInstaller({
      spawnOverride: spawn,
      env: {},
      isElectron: true,
    });
    await installer.install(() => {});
    expect(calls[0]?.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
  });

  it("非 0 退出码拒绝并带回尾部输出行", async () => {
    const { spawn } = fakeSpawn(() => ({
      code: 1,
      stdout: [],
      stderr: ["Failed to download: 403"],
    }));
    const installer = createCliChromiumInstaller({
      spawnOverride: spawn,
      env: {},
    });
    await expect(installer.install(() => {})).rejects.toThrow(/403/);
  });
});
