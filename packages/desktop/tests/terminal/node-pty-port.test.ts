import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createNodePtyPort,
  type NodePtyModule,
  type NodePtyProcess,
  type NodePtySpawnOptions,
} from "../../src/terminal/node-pty-port";

/**
 * node-pty 适配器单测（票02）：ABI 红线下真件（node-pty）不得被单测加载，
 * 全部用例经注入 fake NodePtyModule 驱动（真件验证归 Electron 冒烟脚本）。
 */

/** fake pty 进程：记录调用、可手动发事件，实现适配器期望的 node-pty 形状 */
class FakePtyProcess implements NodePtyProcess {
  pid = 4242;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killCalls = 0;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(columns: number, rows: number): void {
    this.resizes.push([columns, rows]);
  }

  kill(): void {
    this.killCalls += 1;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  /** 测试驱动：向所有 onData 监听者发输出 */
  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  /** 测试驱动：向所有 onExit 监听者发退出事件 */
  emitExit(event: { exitCode: number; signal?: number }): void {
    for (const listener of [...this.exitListeners]) listener(event);
  }
}

/** fake node-pty 模块：记录 spawn 调用并产出 fake 进程 */
class FakeNodePty implements NodePtyModule {
  spawnCalls: Array<{
    file: string;
    args: string[];
    options: NodePtySpawnOptions;
  }> = [];
  processes: FakePtyProcess[] = [];

  spawn(
    file: string,
    args: string[],
    options: NodePtySpawnOptions
  ): NodePtyProcess {
    this.spawnCalls.push({ file, args, options });
    const proc = new FakePtyProcess();
    this.processes.push(proc);
    return proc;
  }
}

/** taskkill 调用记录（替代真实 node:child_process.spawn） */
interface SpawnCall {
  file: string;
  args: string[];
  options: unknown;
}

const BASE_REQUEST = {
  shell: "git-bash",
  cwd: "C:\\work\\demo",
  env: { PATH: "C:\\bin", SYSTEMROOT: "C:\\WINDOWS" },
  size: { cols: 100, rows: 30 },
} as const;

interface Harness {
  fakePty: FakeNodePty;
  taskkillCalls: SpawnCall[];
  port: ReturnType<typeof createNodePtyPort>;
}

function makeHarness(overrides?: {
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
}): Harness {
  const fakePty = new FakeNodePty();
  const taskkillCalls: SpawnCall[] = [];
  const port = createNodePtyPort({
    nodePty: fakePty,
    platform: overrides?.platform ?? "win32",
    fileExists: overrides?.fileExists ?? (() => true),
    spawnImpl: (file, args, options) => {
      taskkillCalls.push({ file, args, options });
      // 返回值只被适配器 fire-and-forget，给个最小假对象即可
      return { pid: 99 } as never;
    },
  });
  return { fakePty, taskkillCalls, port };
}

afterEach(() => {
  delete process.env["CODEXLIKE_GIT_BASH_PATH"];
});

describe("node-pty-port spawn（shell 命令行映射与环境透传）", () => {
  it("git-bash 解析到固定安装位 bash.exe 并以 --login -i 交互参数 spawn", () => {
    const seen: string[] = [];
    const { fakePty, port } = makeHarness({
      fileExists: (path) => {
        seen.push(path);
        return path === "C:\\Program Files\\Git\\bin\\bash.exe";
      },
    });
    port.spawn({ ...BASE_REQUEST });
    expect(fakePty.spawnCalls).toHaveLength(1);
    expect(fakePty.spawnCalls[0]?.file).toBe(
      "C:\\Program Files\\Git\\bin\\bash.exe"
    );
    expect(fakePty.spawnCalls[0]?.args).toEqual(["--login", "-i"]);
    expect(seen[0]).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("cwd/env/初始尺寸原样透传 node-pty，不设 encoding（node-pty 默认 utf8 文本）", () => {
    const { fakePty, port } = makeHarness();
    port.spawn({ ...BASE_REQUEST });
    const options = fakePty.spawnCalls[0]?.options;
    expect(options?.cwd).toBe("C:\\work\\demo");
    expect(options?.env).toEqual(BASE_REQUEST.env);
    expect(options?.cols).toBe(100);
    expect(options?.rows).toBe(30);
    expect(options?.encoding).toBeUndefined();
  });

  it("env 携带 TERM 时沿用宿主值不另设 name；缺省时 name 为 xterm-256color", () => {
    const { fakePty, port } = makeHarness();
    port.spawn({ ...BASE_REQUEST, env: { TERM: "xterm-color" } });
    expect(fakePty.spawnCalls[0]?.options.name).toBeUndefined();

    port.spawn({ ...BASE_REQUEST });
    expect(fakePty.spawnCalls[1]?.options.name).toBe("xterm-256color");
  });

  it("initialCommand 在 spawn 后立即写入 pty（以回车结尾）", () => {
    const { fakePty, port } = makeHarness();
    port.spawn({ ...BASE_REQUEST, initialCommand: "echo hello" });
    expect(fakePty.processes[0]?.writes).toEqual(["echo hello\r"]);
  });

  it("无 initialCommand 时不向 pty 写入任何内容", () => {
    const { fakePty, port } = makeHarness();
    port.spawn({ ...BASE_REQUEST });
    expect(fakePty.processes[0]?.writes).toEqual([]);
  });

  it("powershell 与 cmd 的命令行映射", () => {
    const { fakePty, port } = makeHarness();
    port.spawn({ ...BASE_REQUEST, shell: "powershell" });
    port.spawn({ ...BASE_REQUEST, shell: "cmd" });
    expect(fakePty.spawnCalls[0]?.file).toBe("powershell.exe");
    expect(fakePty.spawnCalls[0]?.args).toEqual(["-NoLogo"]);
    expect(fakePty.spawnCalls[1]?.file).toBe("cmd.exe");
    expect(fakePty.spawnCalls[1]?.args).toEqual([]);
  });
});

describe("node-pty-port 进程事件透传", () => {
  it("onData 透传输出，退订后不再收到", () => {
    const { fakePty, port } = makeHarness();
    const proc = port.spawn({ ...BASE_REQUEST });
    const received: string[] = [];
    const unsubscribe = proc.onData((data) => received.push(data));
    const fake = fakePty.processes[0] as FakePtyProcess;
    fake.emitData("chunk-1");
    unsubscribe();
    fake.emitData("chunk-2");
    expect(received).toEqual(["chunk-1"]);
  });

  it("onExit 透传 exitCode 与 signal，退订后不再收到", () => {
    const { fakePty, port } = makeHarness();
    const proc = port.spawn({ ...BASE_REQUEST });
    const events: Array<{ exitCode: number; signal?: number }> = [];
    const unsubscribe = proc.onExit((event) => events.push(event));
    const fake = fakePty.processes[0] as FakePtyProcess;
    fake.emitExit({ exitCode: 7, signal: 9 });
    unsubscribe();
    fake.emitExit({ exitCode: 0 });
    expect(events).toEqual([{ exitCode: 7, signal: 9 }]);
  });

  it("多个监听者收到同一次事件；exit 只通知一次（底层重复 emit 不重复转发）", () => {
    const { fakePty, port } = makeHarness();
    const proc = port.spawn({ ...BASE_REQUEST });
    const a: number[] = [];
    const b: number[] = [];
    proc.onExit((event) => a.push(event.exitCode));
    proc.onExit((event) => b.push(event.exitCode));
    const fake = fakePty.processes[0] as FakePtyProcess;
    fake.emitExit({ exitCode: 0 });
    fake.emitExit({ exitCode: 0 });
    expect(a).toEqual([0]);
    expect(b).toEqual([0]);
  });

  it("write 与 resize 原样透传 node-pty", () => {
    const { fakePty, port } = makeHarness();
    const proc = port.spawn({ ...BASE_REQUEST });
    proc.write("ls\r");
    proc.resize({ cols: 120, rows: 40 });
    const fake = fakePty.processes[0] as FakePtyProcess;
    expect(fake.writes).toEqual(["ls\r"]);
    expect(fake.resizes).toEqual([[120, 40]]);
  });

  it("resize 非法尺寸（0/负数/NaN）静默忽略，不触达 node-pty", () => {
    const { fakePty, port } = makeHarness();
    const proc = port.spawn({ ...BASE_REQUEST });
    proc.resize({ cols: 0, rows: 30 });
    proc.resize({ cols: 80, rows: -1 });
    proc.resize({ cols: Number.NaN, rows: 30 });
    const fake = fakePty.processes[0] as FakePtyProcess;
    expect(fake.resizes).toEqual([]);
  });

  it("exit 之后 write/resize/kill 安全 no-op，不再触达 node-pty", () => {
    const { fakePty, port } = makeHarness();
    const proc = port.spawn({ ...BASE_REQUEST });
    const fake = fakePty.processes[0] as FakePtyProcess;
    fake.emitExit({ exitCode: 0 });
    proc.write("late\r");
    proc.resize({ cols: 80, rows: 24 });
    proc.kill();
    expect(fake.writes).toEqual([]);
    expect(fake.resizes).toEqual([]);
    expect(fake.killCalls).toBe(0);
  });
});

describe("node-pty-port kill 与 exit 保证", () => {
  it("win32 kill 先 taskkill /T /F 打 pty pid 再调 node-pty kill，窗口隐藏且不收输出", () => {
    const { fakePty, taskkillCalls, port } = makeHarness({ platform: "win32" });
    const proc = port.spawn({ ...BASE_REQUEST });
    const fake = fakePty.processes[0] as FakePtyProcess;
    proc.kill();
    expect(taskkillCalls).toHaveLength(1);
    expect(taskkillCalls[0]?.file).toBe("taskkill");
    expect(taskkillCalls[0]?.args).toEqual(["/pid", "4242", "/T", "/F"]);
    expect(taskkillCalls[0]?.options).toMatchObject({
      windowsHide: true,
      stdio: "ignore",
    });
    expect(fake.killCalls).toBe(1);
  });

  it("非 win32 kill 只调 node-pty kill，不起 taskkill", () => {
    const { fakePty, taskkillCalls, port } = makeHarness({ platform: "linux" });
    const proc = port.spawn({ ...BASE_REQUEST });
    const fake = fakePty.processes[0] as FakePtyProcess;
    proc.kill();
    expect(taskkillCalls).toHaveLength(0);
    expect(fake.killCalls).toBe(1);
  });

  it("kill 幂等：重复调用只 taskkill 一次、node-pty kill 一次", () => {
    const { fakePty, taskkillCalls, port } = makeHarness({ platform: "win32" });
    const proc = port.spawn({ ...BASE_REQUEST });
    const fake = fakePty.processes[0] as FakePtyProcess;
    proc.kill();
    proc.kill();
    proc.kill();
    expect(taskkillCalls).toHaveLength(1);
    expect(fake.killCalls).toBe(1);
  });

  it("kill 后真实 exit 事件正常转发，兜底窗内不合成第二份", () => {
    vi.useFakeTimers();
    try {
      const { fakePty, port } = makeHarness({ platform: "win32" });
      const proc = port.spawn({ ...BASE_REQUEST });
      const events: Array<{ exitCode: number; signal?: number }> = [];
      proc.onExit((event) => events.push(event));
      const fake = fakePty.processes[0] as FakePtyProcess;
      proc.kill();
      fake.emitExit({ exitCode: 0, signal: undefined });
      vi.advanceTimersByTime(5_000);
      expect(events).toEqual([{ exitCode: 0, signal: undefined }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kill 后真实 exit 迟到（超过兜底窗）：合成 exit 先到，真实事件不再转发", () => {
    vi.useFakeTimers();
    try {
      const { fakePty, port } = makeHarness({ platform: "win32" });
      const proc = port.spawn({ ...BASE_REQUEST });
      const events: Array<{ exitCode: number; signal?: number }> = [];
      proc.onExit((event) => events.push(event));
      const fake = fakePty.processes[0] as FakePtyProcess;
      proc.kill();
      vi.advanceTimersByTime(2_000);
      expect(events).toEqual([{ exitCode: 1 }]);
      fake.emitExit({ exitCode: 15, signal: 1 });
      expect(events).toEqual([{ exitCode: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("node-pty-port Git Bash 定位与启动失败", () => {
  it("显式 gitBashPath 存在时优先于候选", () => {
    const { fakePty } = makeHarness({
      fileExists: (path) => path === "D:\\tools\\bash.exe",
    });
    // 显式路径走工厂 options（请求级不带），独立工厂断言优先级
    const explicit = createNodePtyPort({
      nodePty: fakePty,
      platform: "win32",
      gitBashPath: "D:\\tools\\bash.exe",
      fileExists: (path) => path === "D:\\tools\\bash.exe",
    });
    explicit.spawn({ ...BASE_REQUEST });
    expect(fakePty.spawnCalls.at(-1)?.file).toBe("D:\\tools\\bash.exe");
  });

  it("显式 gitBashPath 不存在时中文报错并携带路径", () => {
    const port = createNodePtyPort({
      nodePty: new FakeNodePty(),
      platform: "win32",
      gitBashPath: "D:\\missing\\bash.exe",
      fileExists: () => false,
    });
    expect(() => port.spawn({ ...BASE_REQUEST })).toThrowError(
      "指定的 Git Bash 不存在：D:\\missing\\bash.exe"
    );
  });

  it("候选全不存在时报错指引安装 Git for Windows 或设 CODEXLIKE_GIT_BASH_PATH", () => {
    const port = createNodePtyPort({
      nodePty: new FakeNodePty(),
      platform: "win32",
      fileExists: () => false,
    });
    expect(() => port.spawn({ ...BASE_REQUEST })).toThrowError(
      "未找到 Git Bash（bash.exe）。请安装 Git for Windows，或设置环境变量 CODEXLIKE_GIT_BASH_PATH 指向 bash.exe。"
    );
  });

  it("CODEXLIKE_GIT_BASH_PATH env 兜底指向存在路径时直接使用", () => {
    const { fakePty, port } = makeHarness({
      fileExists: (path) => path === "E:\\portable-git\\bin\\bash.exe",
    });
    process.env["CODEXLIKE_GIT_BASH_PATH"] = "E:\\portable-git\\bin\\bash.exe";
    port.spawn({ ...BASE_REQUEST });
    expect(fakePty.spawnCalls[0]?.file).toBe("E:\\portable-git\\bin\\bash.exe");
  });

  it("node-pty spawn 抛错（shell 不可用）原样传播给管理器转拒绝", () => {
    const failing: NodePtyModule = {
      spawn: () => {
        throw new Error("File not found: cmd.exe");
      },
    };
    const port = createNodePtyPort({
      nodePty: failing,
      platform: "win32",
      fileExists: () => true,
    });
    expect(() => port.spawn({ ...BASE_REQUEST, shell: "cmd" })).toThrowError(
      "File not found: cmd.exe"
    );
  });
});

describe("node-pty-port ABI 边界（源码形状，票02 红线）", () => {
  // 适配器真件（node-pty）不得被单测静态加载：静态 import 会在 vitest 的
  // node ABI 下加载 .node 二进制。该红线靠源码形状守住——真件只允许出现在
  // defaultLoadNodePty 的 createRequire 动态加载路径里。
  it("适配器源码无 node-pty 静态 import，真件加载仅经 createRequire 动态路径", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/terminal/node-pty-port.ts"),
      "utf8"
    );
    expect(source).not.toMatch(
      /import\s+(?:type\s+)?[\s\S]*?from\s+["']node-pty["']/
    );
    expect(source).toMatch(/createRequire\(import\.meta\.url\)/);
    // 真件 require 只出现在动态加载函数体内（字符串形态恰一次）
    expect(source.match(/requireFromHere\("node-pty"\)/g)).toHaveLength(1);
  });
});
