import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_MAX_COMMAND_TIMEOUT_SECONDS,
} from "../task/execution-settings";
import {
  expectString,
  optionalNumber,
  optionalString,
  parseToolArgs,
} from "./args";
import { defineTool } from "./define-tool";
import { windowsToPosixAbsolute } from "./paths";
import { resolvePath } from "./workspace";

/** 可配置 shell（spec：默认 Git Bash，可切换 PowerShell/cmd） */
export type TerminalShell = "git-bash" | "powershell" | "cmd";

/** 静态值或逐次解析的函数（宿主注入设置缓存，保存后对下一次命令即时生效） */
export type TimeoutOption = number | (() => number);

export interface TerminalToolOptions {
  /**
   * shell 偏好：静态值或逐次解析的函数（宿主可注入「设置项优先、环境变量兜底」的
   * 合并逻辑，设置页保存后无需重启工具实例即对下一次命令生效）；缺省 git-bash。
   */
  shell?: TerminalShell | (() => TerminalShell);
  /** 宿主传入的完整环境变量；工具层按白名单过滤（不透传全部，spec 约定） */
  env?: Record<string, string | undefined>;
  /** 默认超时（毫秒）；函数形态逐次解析，解析结果非正有限数时回退默认 */
  defaultTimeoutMs?: TimeoutOption;
  /** 超时上限（毫秒）；函数形态逐次解析，解析结果非正有限数时回退默认 */
  maxTimeoutMs?: TimeoutOption;
  /** 合并输出的字符上限 */
  maxOutputLength?: number;
  /** 显式指定 bash.exe 路径（测试或高级配置用） */
  gitBashPath?: string;
}

/** 环境变量白名单（大小写不敏感）：基础项才透传给子进程 */
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "TZ",
  "TERM",
  "USERPROFILE",
  "USERNAME",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);

// 固定安装位候选，刻意不扫 PATH：PATH 首段 System32 的 bash.exe 是 WSL
// 启动器，命中会落 Linux shell 且 cwd 翻成 /mnt/c/...（见 CODING_STANDARDS
// 「Windows spawn 坑」）；自定义安装位置走下方显式配置项
const GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];

/** 定位 Git Bash：显式配置 > CODEXLIKE_GIT_BASH_PATH > 常见安装路径 */
function findGitBash(explicit?: string): string {
  const configured = explicit ?? process.env["CODEXLIKE_GIT_BASH_PATH"];
  if (configured !== undefined && configured !== "") {
    if (!existsSync(configured)) {
      throw new Error(`指定的 Git Bash 不存在：${configured}`);
    }
    return configured;
  }
  if (process.platform !== "win32") {
    return "/bin/bash";
  }
  for (const candidate of GIT_BASH_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "未找到 Git Bash（bash.exe）。请安装 Git for Windows，或设置环境变量 CODEXLIKE_GIT_BASH_PATH 指向 bash.exe。"
  );
}

/** 白名单过滤环境变量（大小写不敏感匹配键名） */
function filterEnv(
  env: Record<string, string | undefined>
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/** 命令文本中的 Windows 反斜杠绝对路径 → POSIX（`C:\\x\\y` → `/c/x/y`），供 Git Bash 使用 */
function convertWindowsPathsForBash(command: string): string {
  return command.replace(/[A-Za-z]:\\[^\s'"|;&<>()]+/g, (match) =>
    windowsToPosixAbsolute(match.replace(/\\$/, ""))
  );
}

interface SpawnPlan {
  commandLine: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  convertPaths: boolean;
}

function buildSpawnPlan(
  shell: TerminalShell,
  command: string,
  cwd: string,
  env: Record<string, string>
): SpawnPlan {
  if (shell === "powershell") {
    return {
      commandLine: command,
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      cwd,
      env,
      convertPaths: false,
    };
  }
  if (shell === "cmd") {
    return {
      commandLine: command,
      file: "cmd.exe",
      // /s /c 只剥掉最外层引号；内部命令保持 cmd 原生转义，不走 CRT 参数转义。
      args: ["/d", "/s", "/c", `"${command}"`],
      cwd,
      env,
      convertPaths: false,
    };
  }
  const bash = findGitBash();
  const converted = convertWindowsPathsForBash(command);
  return {
    commandLine: converted,
    file: bash,
    args: ["-c", converted],
    cwd,
    env,
    convertPaths: true,
  };
}

/** 终止进程树：Windows 用 taskkill /T /F（bash 的子进程不被 child.kill 连带） */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGKILL");
  }
}

export function createTerminalTool(options: TerminalToolOptions = {}) {
  /** shell 在每次执行时解析（函数形态支持设置页保存后即时生效） */
  const resolveShell = (): TerminalShell =>
    typeof options.shell === "function"
      ? options.shell()
      : (options.shell ?? "git-bash");
  /**
   * 超时在每次执行时解析（与 shell 同构）：函数形态读宿主设置缓存，
   * 解析结果非正有限数时回退默认（防宿主注入非法值）。
   */
  const resolveTimeoutOption = (
    value: TimeoutOption | undefined,
    fallbackMs: number
  ): number => {
    const resolved = typeof value === "function" ? value() : value;
    return typeof resolved === "number" &&
      Number.isFinite(resolved) &&
      resolved > 0
      ? resolved
      : fallbackMs;
  };
  const resolveDefaultTimeoutMs = (): number =>
    resolveTimeoutOption(
      options.defaultTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_SECONDS * 1000
    );
  const resolveMaxTimeoutMs = (): number =>
    resolveTimeoutOption(
      options.maxTimeoutMs,
      DEFAULT_MAX_COMMAND_TIMEOUT_SECONDS * 1000
    );
  const maxOutputLength = options.maxOutputLength ?? 30_000;
  const env = options.env ?? {};

  return defineTool({
    name: "run_terminal_command",
    // 工具描述不携带具体超时数字（code review 修复 5）：超时两项已用户可调
    // （执行设置票04），描述随实例定型，携带创建时刻快照会在设置改动后向
    // 模型呈现过时数字；改为指明「由应用设置决定」+ timeoutMs 参数用法指引
    description:
      `在工作区内执行终端命令（默认 Git Bash：ls、cat、grep、管道等 POSIX 命令可用）。` +
      `cwd 默认为工作区根。命令默认在应用设置的超时内完成，可用 timeoutMs 参数为单条命令指定更长时限，上限同样由应用设置决定。` +
      `输出最长 ${maxOutputLength} 字符（超出截断）。环境变量仅透传白名单基础项。`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的命令（POSIX shell 语法）",
        },
        cwd: {
          type: "string",
          description: "工作目录（相对工作区，默认工作区根）",
        },
        timeoutMs: { type: "integer", minimum: 100, description: "超时毫秒数" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    permission: "command",

    async execute(rawArgs, context) {
      const args = parseToolArgs(rawArgs);
      const command = expectString(args, "command");
      const cwdArg = optionalString(args, "cwd");
      const requestedTimeout = optionalNumber(args, "timeoutMs");
      // 超时逐次解析：默认值与上限都可能在两次执行之间被设置页改写
      const timeoutMs = Math.min(
        requestedTimeout ?? resolveDefaultTimeoutMs(),
        resolveMaxTimeoutMs()
      );

      // 中断先于 spawn 到达：已 abort 的 signal 不会触发 listener，显式短路
      if (context.signal?.aborted === true) {
        return { output: "已被用户中断，未执行", isError: true };
      }

      const cwd = resolvePath(
        context.workspacePath,
        cwdArg ?? ".",
        context.approvalMode
      );
      const shell = resolveShell();
      const plan = buildSpawnPlan(shell, command, cwd, filterEnv(env));

      return await new Promise((resolve) => {
        const child = spawn(plan.file, plan.args, {
          cwd: plan.cwd,
          env: plan.env,
          windowsHide: true,
          windowsVerbatimArguments: shell === "cmd",
        });

        let stdout = "";
        let stderr = "";
        let truncated = false;
        let settled = false;

        const collect = (bucket: "out" | "err", chunk: Buffer) => {
          const text = chunk.toString("utf8");
          if (bucket === "out") {
            if (stdout.length < maxOutputLength) stdout += text;
            else truncated = true;
          } else if (stderr.length < maxOutputLength) {
            stderr += text;
          } else {
            truncated = true;
          }
        };
        child.stdout?.on("data", (chunk: Buffer) => collect("out", chunk));
        child.stderr?.on("data", (chunk: Buffer) => collect("err", chunk));

        const finish = (
          outcome: { code: number } | { timedOut: true } | { aborted: true }
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          context.signal?.removeEventListener("abort", onAbort);

          let output = stdout;
          if (stderr.trim() !== "") {
            output += `${output.endsWith("\n") || output === "" ? "" : "\n"}[stderr]\n${stderr}`;
          }
          if (output.length > maxOutputLength) {
            output = output.slice(0, maxOutputLength);
            truncated = true;
          }
          if (truncated) {
            output += `\n[输出已截断：原始输出超过 ${maxOutputLength} 字符，仅显示前面部分]\n`;
          }
          if ("aborted" in outcome) {
            // 用户打断（停止按钮）：子进程树已被终止，标记区别于超时
            output += `\n[已被用户中断，进程已终止]\n`;
            resolve({ output, isError: true });
            return;
          }
          if ("timedOut" in outcome) {
            output += `\n[命令超时（${timeoutMs / 1000} 秒），已强制终止]\n`;
            resolve({ output, isError: true });
            return;
          }
          if (outcome.code !== 0) {
            output += `\n[退出码 ${outcome.code}]\n`;
            resolve({ output, isError: true });
            return;
          }
          resolve({ output, isError: false });
        };

        const timer = setTimeout(() => {
          killTree(child);
          finish({ timedOut: true });
        }, timeoutMs);

        function onAbort() {
          killTree(child);
          finish({ aborted: true });
        }
        context.signal?.addEventListener("abort", onAbort);

        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            output: `命令无法启动：${error.message}（shell：${shell}）`,
            isError: true,
          });
        });
        child.on("close", (code) => {
          finish({ code: code ?? -1 });
        });
      });
    },
  });
}
