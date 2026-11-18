import { spawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { realpathSync } from "node:fs";
import { win32 } from "node:path";

/** 系统字节保护边界；生产实现为 DPAPI CurrentUser，测试可注入。 */
export interface ByteProtector {
  protect(plain: Buffer): Promise<Buffer>;
  unprotect(encrypted: Buffer): Promise<Buffer>;
}

export const MAX_PLAIN_BYTES = 1024 * 1024;
export const MAX_PROTECTED_BYTES = MAX_PLAIN_BYTES + 16 * 1024;

function unavailable(): Error {
  return new Error("系统凭据加密存储不可用或数据损坏，已拒绝处理凭据");
}

/** 脚本恒定；凭据只从 stdin 读入，异常既不打印也不跨进程传播。 */
function encodedCommand(operation: "Protect" | "Unprotect"): string {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { exit 1 }
  [void][System.Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
  $inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $outputBytes = [System.Security.Cryptography.ProtectedData]::${operation}($inputBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($outputBytes))
} catch { exit 1 }
`;
  return Buffer.from(script, "utf16le").toString("base64");
}

const commands = {
  Protect: encodedCommand("Protect"),
  Unprotect: encodedCommand("Unprotect"),
};

/** 仅 OS 边界注入；生产不传任何选项，也不提供可配置脚本/任意 exe。 */
export interface WindowsDpapiOptions {
  spawn?: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio
  ) => ChildProcessWithoutNullStreams;
  systemRoot?: string;
  realpath?: (path: string) => string;
}

export function createWindowsDpapiProtector(
  options: WindowsDpapiOptions = {}
): ByteProtector {
  // 无法确认旧进程已退出时永久关闸，禁止逻辑队列补出更多系统进程。
  let disabled = false;

  async function run(
    operation: "Protect" | "Unprotect",
    input: Buffer
  ): Promise<Buffer> {
    try {
      if (disabled) throw unavailable();
      const root =
        options.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
      // 只接受驱动器根目录下的 Windows 系统位，不走 PATH 或应用 cwd。
      if (!/^[a-z]:\\Windows$/i.test(root)) throw unavailable();
      const system32 = win32.join(root, "System32");
      const executable = win32.join(
        system32,
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
      const realpath = options.realpath ?? realpathSync.native;
      if (realpath(executable).toLowerCase() !== executable.toLowerCase())
        throw unavailable();
      return await new Promise<Buffer>((resolve, reject) => {
        const child = (options.spawn ?? spawn)(
          executable,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            commands[operation],
          ],
          {
            shell: false,
            windowsHide: true,
            cwd: system32,
            env: { SystemRoot: root, WINDIR: root, PATH: system32 },
          }
        );
        const output: Buffer[] = [];
        let outputBytes = 0;
        const maxOutputBytes =
          operation === "Protect" ? MAX_PROTECTED_BYTES : MAX_PLAIN_BYTES;
        const maxOutputBase64 = Math.ceil(maxOutputBytes / 3) * 4;
        let failed = false;
        let closed = false;
        let abandoned = false;
        let streamsDestroyed = false;
        let reapTimer: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(fail, 10_000);
        function destroyStreams(): void {
          if (streamsDestroyed) return;
          streamsDestroyed = true;
          child.stdout.off("data", collect);
          child.stderr.off("data", fail);
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        }
        function fail(): void {
          if (failed || closed) return;
          failed = true;
          clearTimeout(timer);
          output.length = 0;
          // 通常等 close 才归还槽位；宽限后仍无确认则先永久关闸再拒绝，
          // 排队请求会直接失败，不能把逻辑槽位释放当作物理进程已退出。
          reapTimer = setTimeout(() => {
            if (closed) return;
            disabled = true;
            abandoned = true;
            reject(unavailable());
          }, 1_000);
          try {
            child.kill();
          } catch {
            /* 不传播系统错误或凭据 */
          }
          destroyStreams();
        }
        function collect(chunk: Buffer): void {
          if (failed || closed) return;
          outputBytes += chunk.length;
          if (outputBytes > maxOutputBase64) {
            fail();
            return;
          }
          output.push(chunk);
        }
        function onClose(code: number | null): void {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          clearTimeout(reapTimer);
          if (abandoned) return;
          destroyStreams();
          const text = Buffer.concat(output).toString("latin1");
          output.length = 0;
          if (failed || code !== 0) {
            reject(unavailable());
            return;
          }
          const decoded = Buffer.from(text, "base64");
          if (
            decoded.toString("base64") !== text ||
            decoded.length > maxOutputBytes ||
            (operation === "Protect" && decoded.length === 0)
          ) {
            reject(unavailable());
            return;
          }
          resolve(decoded);
        }
        child.on("error", fail);
        child.stdin.on("error", fail);
        child.stdout.on("error", fail);
        child.stderr.on("error", fail);
        child.stderr.on("data", fail);
        child.stdout.on("data", collect);
        child.once("close", onClose);
        try {
          child.stdin.end(input.toString("base64"));
        } catch {
          fail();
        }
      });
    } catch {
      throw unavailable();
    }
  }

  return {
    protect: (plain) => run("Protect", plain),
    unprotect: (encrypted) => run("Unprotect", encrypted),
  };
}
