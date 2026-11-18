import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import type { BuildOptions } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  createCliChromiumInstaller,
  ensureChromiumReady,
} from "@codexlike/agent-core/node";
import { loadIsolatedPlaywright } from "../../agent-core/tests/browser/isolated-playwright";

const capture = vi.hoisted(() => ({
  builds: [] as BuildOptions[],
  stopBeforeLaunch: new Error("构建参数已收集；不等待 Vite 或启动 Electron"),
}));

// 执行真正的脚本，只替换构建和启动边界；不能复制一份配置让测试自行通过。
vi.mock("esbuild", () => ({
  build: async (options: BuildOptions) => {
    capture.builds.push(options);
  },
}));
vi.mock("wait-on", () => ({
  default: async () => {
    throw capture.stopBeforeLaunch;
  },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: () => {
    throw new Error("构建脚本测试禁止启动 Electron 或下载子进程");
  },
}));

const { build } = await vi.importActual<typeof import("esbuild")>("esbuild");
const packageDir = fileURLToPath(new URL("../", import.meta.url));
const repoDir = resolve(packageDir, "../..");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexlike-build-load-"));
  directories.push(directory);
  return directory;
}

async function scriptBuildOptions(
  script: "dev" | "build"
): Promise<BuildOptions[]> {
  vi.resetModules();
  capture.builds.length = 0;
  const scriptUrl = new URL(`../scripts/${script}.mjs`, import.meta.url).href;
  if (script === "dev") {
    await expect(import(/* @vite-ignore */ scriptUrl)).rejects.toBe(
      capture.stopBeforeLaunch
    );
  } else {
    await import(/* @vite-ignore */ scriptUrl);
  }
  expect(capture.builds).toHaveLength(2);
  return [...capture.builds];
}

function inside(directory: string, filename: string): boolean {
  const path = relative(directory, filename);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

/** 只允许入口求值，不进入 app.whenReady，也不读真实用户目录或启动外部程序。 */
function loadMainBundle(source: string, filename: string, directory: string) {
  const nativeRequire = createRequire(filename);
  const blocked = () => {
    throw new Error("构建加载测试禁止外部 IO 或应用启动");
  };
  const app = {
    isPackaged: false,
    on: vi.fn(),
    whenReady: vi.fn(() => new Promise<never>(() => {})),
    quit: blocked,
  };
  const contextBridge = { exposeInMainWorld: vi.fn() };
  const fs = nativeRequire("node:fs") as typeof import("node:fs");
  const readOnlyFs = (target: object): object =>
    new Proxy(target, {
      get(object, key) {
        if (key === "promises") return readOnlyFs(fs.promises);
        if (
          /^(write|append|mkdir|mkdtemp|rm|rmdir|unlink|rename|copy|cp|chmod|chown|truncate|symlink|link|open|createWriteStream)/.test(
            String(key)
          )
        ) {
          return blocked;
        }
        const value: unknown = Reflect.get(object, key);
        if (
          typeof value === "function" &&
          /^(read|stat|lstat|exists|access|realpath)/.test(String(key))
        ) {
          return (path: string | URL, ...args: unknown[]) => {
            const absolute = resolve(
              path instanceof URL ? fileURLToPath(path) : String(path)
            );
            if (!inside(repoDir, absolute) && !inside(directory, absolute))
              blocked();
            return Reflect.apply(value, object, [path, ...args]);
          };
        }
        return value;
      },
    });
  const processBoundary = Object.assign(Object.create(process), {
    env: {
      CODEXLIKE_HOME: directory,
      PLAYWRIGHT_BROWSERS_PATH: join(directory, "browsers"),
    },
    argv: [process.execPath, filename],
    cwd: () => directory,
    on: vi.fn(),
    once: vi.fn(),
    exit: blocked,
    kill: blocked,
    chdir: blocked,
  });
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    __filename: filename,
    __dirname: dirname(filename),
    process: processBoundary,
    console,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    performance,
    atob,
    btoa,
    AbortController,
    AbortSignal,
    ReadableStream,
    WritableStream,
    TransformStream,
    Event,
    EventTarget,
    DOMException,
    structuredClone,
    crypto,
    Headers,
    Request,
    Response,
    FormData,
    Blob,
    File,
    fetch: blocked,
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
    setInterval,
    clearInterval,
    queueMicrotask,
    require(specifier: string) {
      if (specifier === "electron")
        return { app, contextBridge, BrowserWindow: blocked };
      if (specifier === "playwright-core")
        return loadIsolatedPlaywright(nativeRequire, directory);
      const builtin = specifier.replace(/^node:/, "");
      if (builtin === "fs") return readOnlyFs(fs);
      if (builtin === "fs/promises") return readOnlyFs(fs.promises);
      if (builtin === "os")
        return { ...nativeRequire("node:os"), homedir: () => directory };
      if (builtin === "child_process") {
        return {
          ...nativeRequire("node:child_process"),
          spawn: blocked,
          spawnSync: blocked,
          exec: blocked,
          execSync: blocked,
          execFile: blocked,
          execFileSync: blocked,
          fork: blocked,
        };
      }
      if (["http", "https", "net", "tls"].includes(builtin)) {
        return {
          ...nativeRequire(specifier),
          request: blocked,
          get: blocked,
          connect: blocked,
          createConnection: blocked,
          createServer: blocked,
        };
      }
      if (!isBuiltin(specifier) && specifier !== "playwright-core") {
        if (!isAbsolute(specifier) || !inside(repoDir, specifier)) blocked();
      }
      return nativeRequire(specifier);
    },
  };
  runInNewContext(
    source,
    { ...sandbox, global: sandbox },
    { filename, timeout: 15_000 }
  );
  return { app, contextBridge, exports: module.exports };
}

describe("真实 Electron 构建产物（内存构建，无网络、无应用启动）", () => {
  it("首次加载真实 Playwright 不受宿主日志/缓存环境影响（全新进程 sentinel）", async () => {
    const directory = temporaryDirectory();
    const sentinel = join(directory, "debug-sentinel.log");
    const original = "哨兵内容必须保留，不能被 Playwright 日志流截断";
    writeFileSync(sentinel, original);
    const probe = await build({
      stdin: {
        contents: `
          import { createRequire } from "node:module";
          import { loadIsolatedPlaywright } from "../../agent-core/tests/browser/isolated-playwright.ts";
          const originalEnv = process.env;
          const playwright = loadIsolatedPlaywright(createRequire(process.argv[1]), process.argv[2]);
          if (process.env !== originalEnv) throw new Error("宿主环境未恢复");
          console.log(JSON.stringify({ executable: playwright.chromium.executablePath() }));
        `,
        resolveDir: fileURLToPath(new URL(".", import.meta.url)),
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      logLevel: "silent",
    });
    // 不展开 process.env、不查看宿主 DEBUG_FILE；子进程仅收到本测试合成的环境。
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        probe.outputFiles[0]!.text,
        join(packageDir, "dist/main.cjs"),
        directory,
      ],
      {
        cwd: directory,
        env: {
          SYSTEMROOT: process.env.SYSTEMROOT,
          HOME: directory,
          USERPROFILE: directory,
          LOCALAPPDATA: directory,
          APPDATA: directory,
          TEMP: directory,
          TMP: directory,
          DEBUG_FILE: sentinel,
          PLAYWRIGHT_BROWSERS_PATH: join(
            directory,
            "host-cache-must-not-be-used"
          ),
        },
        encoding: "utf8",
        timeout: 10_000,
      }
    );
    expect(child.error).toBeUndefined();
    expect(child.status, `${child.stdout}${child.stderr}`).toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe(original);
    const loaded = JSON.parse(child.stdout) as { executable: string };
    expect(inside(join(directory, "browsers"), loaded.executable)).toBe(true);
  });

  it.each(["dev", "build"] as const)(
    "%s 真实入口保留 Playwright 包边界，无空 import.meta，主进程/preload 均可加载",
    async (script) => {
      const configurations = await scriptBuildOptions(script);
      for (const options of configurations) {
        const result = await build({
          ...options,
          absWorkingDir: packageDir,
          write: false,
          metafile: true,
          logLevel: "silent",
        });
        expect(result.warnings).toEqual([]);
        expect(
          Object.keys(result.metafile!.inputs).some((input) =>
            input.includes("playwright-core")
          )
        ).toBe(false);
        const output = result.outputFiles!.find((file) =>
          file.path.endsWith(".cjs")
        )!;
        const loaded = loadMainBundle(
          output.text,
          output.path,
          temporaryDirectory()
        );
        if (output.path.endsWith("main.cjs")) {
          expect(
            Object.values(result.metafile!.outputs).flatMap(
              (item) => item.imports
            )
          ).toContainEqual(
            expect.objectContaining({ path: "playwright-core", external: true })
          );
          expect(loaded.app.whenReady).toHaveBeenCalledOnce();
        } else {
          expect(loaded.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
            "codexlike",
            expect.any(Object)
          );
        }
      }
    }
  );

  it.each(["dev", "build"] as const)(
    "%s CJS 冷缓存可到达合法 Chromium CLI，失败可重试，成功后复用缓存",
    async (script) => {
      const options = (await scriptBuildOptions(script))[0]!;
      const result = await build({
        ...options,
        absWorkingDir: packageDir,
        entryPoints: undefined,
        stdin: {
          // 保留真实主入口，同时通过 Core 的公开 API 驱动产物，不截取私有函数段。
          contents:
            'import "./src/main.ts"; export { createCliChromiumInstaller, ensureChromiumReady } from "@codexlike/agent-core/node";',
          resolveDir: packageDir,
          sourcefile: "cold-cache-entry.ts",
          loader: "ts",
        },
        write: false,
        logLevel: "silent",
      });
      expect(result.warnings).toEqual([]);
      const output = result.outputFiles!.find((file) =>
        file.path.endsWith("main.cjs")
      )!;
      const directory = temporaryDirectory();
      const loaded = loadMainBundle(output.text, output.path, directory);
      const api = loaded.exports as {
        createCliChromiumInstaller: typeof createCliChromiumInstaller;
        ensureChromiumReady: typeof ensureChromiumReady;
      };
      const executable = join(directory, "chrome.exe");
      let attempts = 0;
      const spawn = vi.fn(
        (
          command: string,
          args: readonly string[],
          options: { env: NodeJS.ProcessEnv }
        ) => {
          expect(command).toBe(process.execPath);
          const cli = args[0]!;
          expect(isAbsolute(cli)).toBe(true);
          expect(existsSync(cli)).toBe(true);
          const pkg = JSON.parse(
            readFileSync(join(dirname(cli), "package.json"), "utf8")
          );
          expect(pkg.name).toBe("playwright-core");
          expect(realpathSync(cli)).toBe(
            realpathSync(join(dirname(cli), pkg.bin["playwright-core"]))
          );
          expect(args.slice(1)).toEqual([
            "install",
            "chromium",
            "--no-progress",
          ]);
          expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1");
          const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
          });
          attempts += 1;
          queueMicrotask(() => {
            if (attempts === 1) {
              child.stderr.emit("data", Buffer.from("隔离的下载失败\n"));
              child.emit("close", 1);
            } else {
              writeFileSync(executable, "已安装替身，不启动浏览器");
              child.emit("close", 0);
            }
          });
          return child;
        }
      );
      const installer = api.createCliChromiumInstaller({
        env: {},
        isElectron: true,
        executablePathOverride: executable,
        spawnOverride: spawn,
      });
      expect(installer.isReady()).toBe(false);
      await expect(
        api.ensureChromiumReady(installer, () => {})
      ).rejects.toThrow(/隔离的下载失败/);
      expect(installer.isReady()).toBe(false);
      await api.ensureChromiumReady(installer, () => {});
      expect(installer.isReady()).toBe(true);
      await api.ensureChromiumReady(installer, () => {});
      expect(spawn).toHaveBeenCalledTimes(2);
    }
  );
});
