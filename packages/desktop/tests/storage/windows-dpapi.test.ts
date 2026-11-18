import { ChildProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SafeStorageLike } from "../../src/profiles/profile-store";
import { createCredentialStorage } from "../../src/storage/credential-storage";
import { createWindowsDpapiProtector } from "../../src/storage/windows-dpapi";

const legacy: SafeStorageLike = {
  isEncryptionAvailable: async () => false,
  encryptString: async () => {
    throw new Error("不应回退 Electron");
  },
  decryptString: async () => {
    throw new Error("不应回退 Electron");
  },
};

function fakeProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdio: ChildProcessWithoutNullStreams["stdio"] = [
    stdin,
    stdout,
    stderr,
    undefined,
    undefined,
  ];
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio,
  });
  let kills = 0;
  child.kill = () => {
    kills++;
    queueMicrotask(() => child.emit("close", 1, null));
    return true;
  };
  return { child, kills: () => kills };
}

const systemRoot = "C:\\Windows";
const executable =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function makeStorage(
  spawn: NonNullable<Parameters<typeof createWindowsDpapiProtector>[0]>["spawn"]
) {
  return createCredentialStorage({
    legacy,
    platform: "win32",
    protector: createWindowsDpapiProtector({
      spawn,
      systemRoot,
      realpath: (path) => path,
    }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DPAPI 进程系统边界（经 SafeStorageLike 调用）", () => {
  it.each(["!!AQID", "AQID\n", "AR==", "AQID-", "AQI", ""])(
    "stdout 必须为 canonical base64，拒绝协议响应 %j",
    async (response) => {
      const storage = makeStorage(() => {
        const { child } = fakeProcess();
        child.stdin.once("finish", () => {
          child.stdout.end(response);
          child.emit("close", 0, null);
        });
        return child;
      });
      await expect(storage.encryptString("fake")).rejects.toThrow("系统凭据");
    }
  );
  it("stdout 累计超限即终止，不等无限流结束，也不保留原始响应", async () => {
    vi.useFakeTimers();
    const process = fakeProcess();
    const storage = makeStorage(() => process.child);
    const result = storage.encryptString("fake");
    const rejected = expect(result).rejects.toThrow("系统凭据");
    process.child.stdout.write(Buffer.alloc(800_000, 65));
    process.child.stdout.write(Buffer.alloc(800_000, 65));
    try {
      expect(process.kills()).toBe(1);
    } finally {
      process.child.emit("close", 1, null);
      await rejected;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("超时和连续错误只终止一次，close 前不释放并发槽位，之后清理所有资源", async () => {
    vi.useFakeTimers();
    const spawned: ReturnType<typeof fakeProcess>[] = [];
    const storage = makeStorage(() => {
      const process = fakeProcess();
      process.child.kill = vi.fn(() => true);
      spawned.push(process);
      return process.child;
    });
    const results = Promise.allSettled([
      storage.encryptString("a"),
      storage.encryptString("b"),
      storage.encryptString("c"),
    ]);
    expect(spawned).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    for (const process of spawned) {
      process.child.emit("error", new Error("测试-secret 原始异常"));
      process.child.stderr.emit("data", Buffer.from("测试-secret stderr"));
    }
    try {
      expect(spawned).toHaveLength(2);
      for (const process of spawned) {
        expect(process.child.kill).toHaveBeenCalledTimes(1);
      }
    } finally {
      for (const process of spawned) process.child.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(0);
      spawned.at(-1)!.child.emit("close", 1, null);
      await results;
    }
    expect(spawned).toHaveLength(3);
    for (const process of spawned) {
      expect(process.child.stdin.destroyed).toBe(true);
      expect(process.child.stdout.destroyed).toBe(true);
      expect(process.child.stderr.destroyed).toBe(true);
      expect(process.child.listenerCount("close")).toBe(0);
      expect(process.child.stdout.listenerCount("data")).toBe(0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["false", "throw", "true"] as const)(
    "kill 返回 %s 且永不 close：宽限后全部脱敏失败、不补 spawn，迟到 close 幂等",
    async (killResult) => {
      vi.useFakeTimers();
      const spawned: ReturnType<typeof fakeProcess>[] = [];
      const destroyed: Array<ReturnType<typeof vi.spyOn>> = [];
      const storage = makeStorage(() => {
        const process = fakeProcess();
        process.child.kill = vi.fn(() => {
          if (killResult === "throw")
            throw new Error("测试-secret kill 原始异常");
          return killResult === "true";
        });
        destroyed.push(
          vi.spyOn(process.child.stdin, "destroy"),
          vi.spyOn(process.child.stdout, "destroy"),
          vi.spyOn(process.child.stderr, "destroy")
        );
        spawned.push(process);
        return process.child;
      });
      let settled = 0;
      const results = ["a", "b", "排队的第三个"].map((plain) =>
        storage.encryptString(plain).then(
          () => {
            settled++;
            return null;
          },
          (error: unknown) => {
            settled++;
            return error;
          }
        )
      );
      expect(spawned).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(0);
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      try {
        expect(settled).toBe(3);
        for (const error of await Promise.all(results)) {
          expect(error).toHaveProperty(
            "message",
            "系统凭据加密存储不可用或数据损坏，已拒绝处理凭据"
          );
          expect(error).not.toHaveProperty("cause");
        }
        await expect(storage.encryptString("后续也不能 spawn")).rejects.toThrow(
          "系统凭据"
        );
        await expect(storage.isEncryptionAvailable()).resolves.toBe(false);
        expect(spawned).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
        for (const process of spawned) {
          expect(process.child.kill).toHaveBeenCalledTimes(1);
          expect(process.child.stdout.listenerCount("data")).toBe(0);
          expect(process.child.stderr.listenerCount("data")).toBe(0);
        }
        for (const destroy of destroyed)
          expect(destroy).toHaveBeenCalledTimes(1);
        for (const process of spawned) {
          process.child.emit("close", 1, null);
          process.child.emit("close", 0, null);
        }
        for (const destroy of destroyed)
          expect(destroy).toHaveBeenCalledTimes(1);
        await expect(
          storage.encryptString("迟到 close 不解除锁定")
        ).rejects.toThrow("系统凭据");
        expect(spawned).toHaveLength(2);
      } finally {
        // 红灯阶段也回收测试假进程，不让未结算请求污染后续测试。
        for (const process of spawned) process.child.emit("close", 1, null);
        await vi.advanceTimersByTimeAsync(0);
        for (const process of spawned) process.child.emit("close", 1, null);
        await Promise.all(results);
      }
    }
  );

  it.each([
    { root: "Windows", redirected: false },
    { root: "C:Windows", redirected: false },
    { root: "C:\\Users\\test\\Windows", redirected: false },
    { root: "\\\\server\\Windows", redirected: false },
    { root: systemRoot, redirected: true },
  ])(
    "拒绝非绝对系统目录或重解析到非系统位置 $root / $redirected",
    async ({ root, redirected }) => {
      let attempts = 0;
      const storage = createCredentialStorage({
        platform: "win32",
        legacy,
        protector: createWindowsDpapiProtector({
          systemRoot: root,
          realpath: (path) =>
            redirected ? "C:\\Users\\test\\powershell.exe" : path,
          spawn: () => {
            attempts++;
            const { child } = fakeProcess();
            child.stdin.once("finish", () => {
              child.stdout.end("AQID");
              child.emit("close", 0, null);
            });
            return child;
          },
        }),
      });
      await expect(storage.encryptString("fake")).rejects.toThrow("系统凭据");
      expect(attempts).toBe(0);
    }
  );

  it.each([
    "spawn-throw",
    "spawn-error",
    "stdin-error",
    "stdout-error",
    "stderr-error",
    "stderr-data",
    "exit",
    "stdin-throw",
  ] as const)("%s 失败脱敏、释放资源且不阻塞后续请求", async (mode) => {
    vi.useFakeTimers();
    const spawned: ReturnType<typeof fakeProcess>[] = [];
    const storage = makeStorage(() => {
      if (mode === "spawn-throw") throw new Error("测试-secret spawn 原始异常");
      const process = fakeProcess();
      spawned.push(process);
      if (mode === "stdin-throw") {
        process.child.stdin.end = () => {
          throw new Error("测试-secret 写入失败");
        };
      } else {
        process.child.stdin.once("finish", () => {
          const raw = new Error("测试-secret 系统异常");
          switch (mode) {
            case "spawn-error":
              process.child.emit("error", raw);
              break;
            case "stdin-error":
              process.child.stdin.emit("error", raw);
              break;
            case "stdout-error":
              process.child.stdout.emit("error", raw);
              break;
            case "stderr-error":
              process.child.stderr.emit("error", raw);
              break;
            case "stderr-data":
              process.child.stderr.write("测试-secret stderr");
              break;
            case "exit":
              process.child.emit("close", 1, null);
              break;
          }
        });
      }
      return process.child;
    });
    for (let index = 0; index < 3; index++) {
      const result = await storage.encryptString("测试-secret").then(
        () => null,
        (error: unknown) => error
      );
      expect(result).toHaveProperty(
        "message",
        "系统凭据加密存储不可用或数据损坏，已拒绝处理凭据"
      );
      expect(result).not.toHaveProperty("cause");
    }
    for (const process of spawned) {
      expect(process.child.stdin.destroyed).toBe(true);
      expect(process.child.stdout.destroyed).toBe(true);
      expect(process.child.stderr.destroyed).toBe(true);
      expect(process.child.listenerCount("close")).toBe(0);
      expect(process.child.stdout.listenerCount("data")).toBe(0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("只启动绝对系统 PowerShell，固定 EncodedCommand 且假凭据仅走 stdin", async () => {
    vi.useFakeTimers();
    const spawned: ReturnType<typeof fakeProcess>[] = [];
    const inputs: string[] = [];
    const scripts: string[] = [];
    const storage = makeStorage((command, args, options) => {
      expect(command).toBe(executable);
      expect(args.slice(0, -1)).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
      ]);
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
      scripts.push(script);
      expect(script).toContain("::CurrentUser");
      expect(script).not.toContain("测试-secret");
      expect(JSON.stringify(options)).not.toContain("测试-secret");
      expect(options).toMatchObject({
        shell: false,
        windowsHide: true,
        cwd: "C:\\Windows\\System32",
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          PATH: "C:\\Windows\\System32",
        },
      });
      expect(Object.keys(options.env ?? {}).sort()).toEqual([
        "PATH",
        "SystemRoot",
        "WINDIR",
      ]);
      const process = fakeProcess();
      spawned.push(process);
      const chunks: Buffer[] = [];
      process.child.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
      process.child.stdin.once("finish", () => {
        inputs.push(Buffer.concat(chunks).toString("ascii"));
        process.child.stdout.end("AQID");
        process.child.emit("close", 0, null);
      });
      return process.child;
    });
    expect(spawned).toHaveLength(0);
    await storage.encryptString("测试-secret-A");
    await storage.encryptString("测试-secret-B");
    expect(
      inputs.map((input) => Buffer.from(input, "base64").toString())
    ).toEqual(["测试-secret-A", "测试-secret-B"]);
    expect(scripts[0]).toBe(scripts[1]);
    expect(spawned).toHaveLength(2);
    for (const process of spawned) {
      expect(process.kills()).toBe(0);
      expect(process.child.stdin.destroyed).toBe(true);
      expect(process.child.stdout.destroyed).toBe(true);
      expect(process.child.stderr.destroyed).toBe(true);
      expect(process.child.listenerCount("close")).toBe(0);
      expect(process.child.stdout.listenerCount("data")).toBe(0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
