/**
 * node-pty 版 PtyPort 适配器（ADR 0033 票02）：desktop 侧把 agent-core 定义
 * 的 PtyPort 缝隙接到 node-pty 真件（Windows 走 conpty），实现真 TTY 的
 * spawn / write / resize / onData / onExit / kill（子进程树覆盖）。
 *
 * ## ABI 红线（票02 定案）
 *
 * vitest 跑在 node ABI、Electron 主进程跑在 Electron ABI，同一份 .node 原生
 * 二进制跨不过两者。因此本文件**不得静态 import node-pty**：真件只在
 * createNodePtyPort() 未注入 nodePty 时经 defaultLoadNodePty() 动态加载
 * （createRequire 运行时 require），而该路径只在 Electron 运行时被走到；
 * 逻辑单测全部经 options.nodePty 注入 fake 驱动，不触碰真件。真件行为验证
 * 归 Electron 冒烟脚本（scripts/pty-smoke.mjs）与 e2e。
 *
 * ## build 期约束
 *
 * esbuild 打包对 node-pty external（见 scripts/build-options.mjs）——真件
 * 不进 bundle，运行时从 desktop node_modules（开发目录模式）或打包产物
 * resources/node_modules/node-pty（dist vendor 组装，同 playwright-core）解析。
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import type {
  PtyExitEvent,
  PtyPort,
  PtyProcess,
  PtySpawnRequest,
} from "@codexlike/agent-core/node";
import type { TerminalShell } from "@codexlike/agent-core/node";
// Git Bash 安装位候选单一来源（code review 修复轮）：与 agent-core
// run_terminal_command 共用同一名单（本文件的 resolveBashPath 与 agent-core
// 的 findGitBash 解析函数不整合——两侧 spawn 语义不同：一次性执行 vs 交互 pty）
import { GIT_BASH_CANDIDATES } from "@codexlike/agent-core/node";

/** node-pty 模块的最小形状（适配器只用到的部分）；单测注入 fake 用 */
export interface NodePtySpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** 终端类型（node-pty 侧作为 $TERM 语义）；env 已带 TERM 时适配器不再设置 */
  name?: string;
  cols?: number;
  rows?: number;
  /** onData 交付解码文本（PtyPort 契约）；固定 utf8 */
  encoding?: string;
}

export interface NodePtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
}

export interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: NodePtySpawnOptions
  ): NodePtyProcess;
}

/** kill 后等待真实 exit 事件的兜底窗（毫秒）：conpty 正常拆除远快于此值 */
const KILL_EXIT_FALLBACK_MS = 2_000;
/** 兜底合成 exit 的退出码：取 taskkill /F 强杀的进程退出码约定值 1 */
const TASKKILL_FALLBACK_EXIT_CODE = 1;

export interface NodePtyPortOptions {
  /**
   * 注入 node-pty 模块（单测 fake）；缺省经 defaultLoadNodePty 动态加载真件
   * （仅 Electron 运行时该缺省路径成立，见文件头 ABI 红线说明）。
   */
  nodePty?: NodePtyModule;
  /** 平台判定（单测注入 win32/linux 分支）；缺省 process.platform */
  platform?: NodeJS.Platform;
  /** taskkill 的 spawn 注入（单测记录调用）；缺省 node:child_process.spawn */
  spawnImpl?: (
    file: string,
    args: string[],
    options: SpawnOptions
  ) => ChildProcess;
  /** 文件存在性探测（单测替换）；缺省 fs.existsSync */
  fileExists?: (path: string) => boolean;
  /** 显式 Git Bash 路径（宿主高级配置）；缺省 CODEXLIKE_GIT_BASH_PATH env > 固定候选 */
  gitBashPath?: string;
}

/** 真件动态加载：vitest（node ABI）不触达本函数——单测必注入 fake；
 * Electron 主进程走到这里时 require 的是 electron-rebuild/prebuild 产物 */
function defaultLoadNodePty(): NodePtyModule {
  const requireFromHere = createRequire(import.meta.url);
  return requireFromHere("node-pty") as NodePtyModule;
}

/** Git Bash 定位：显式配置 > CODEXLIKE_GIT_BASH_PATH > 固定安装位候选 */
function resolveBashPath(
  options: Pick<NodePtyPortOptions, "gitBashPath" | "fileExists">
): string {
  const fileExists = options.fileExists ?? existsSync;
  const configured =
    options.gitBashPath ?? process.env["CODEXLIKE_GIT_BASH_PATH"];
  if (configured !== undefined && configured !== "") {
    if (!fileExists(configured)) {
      throw new Error(`指定的 Git Bash 不存在：${configured}`);
    }
    return configured;
  }
  for (const candidate of GIT_BASH_CANDIDATES) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "未找到 Git Bash（bash.exe）。请安装 Git for Windows，或设置环境变量 CODEXLIKE_GIT_BASH_PATH 指向 bash.exe。"
  );
}

/** shell 类型 → 可执行文件与交互参数（持久会话要交互提示符，与前台工具的
 * -c 一次性执行不同）：git-bash 用 VS Code Git Bash profile 同款 --login -i，
 * powershell 去 banner，cmd 无 NoLogo 旗标、以 /k cls 清掉启动 banner
 * （conpty 实证：banner 输出后被 cls 转义序列清屏含 scrollback，首屏只剩
 * 提示符；/k 保持交互不退出） */
function buildShellCommand(
  shell: TerminalShell,
  resolveBash: () => string
): { file: string; args: string[] } {
  if (shell === "powershell") {
    return { file: "powershell.exe", args: ["-NoLogo"] };
  }
  if (shell === "cmd") {
    return { file: "cmd.exe", args: ["/k", "cls"] };
  }
  return { file: resolveBash(), args: ["--login", "-i"] };
}

export function createNodePtyPort(options: NodePtyPortOptions = {}): PtyPort {
  const isWin = (options.platform ?? process.platform) === "win32";
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const nodePty = options.nodePty ?? defaultLoadNodePty();
  const resolveBash = () => resolveBashPath(options);

  return {
    spawn(request: PtySpawnRequest): PtyProcess {
      const { file, args } = buildShellCommand(request.shell, resolveBash);
      const env = request.env;
      const proc = nodePty.spawn(file, args, {
        cwd: request.cwd,
        env,
        cols: request.size.cols,
        rows: request.size.rows,
        // encoding 不设置：node-pty 默认即 utf8 解码文本（Windows 不支持该
        // 选项，设置会打警告；Unix 默认 'utf8'），正合 PtyPort 的文本契约
        // node-pty 的 name 是 $TERM 语义：宿主白名单已带 TERM 时不覆盖
        ...(env["TERM"] === undefined ? { name: "xterm-256color" } : {}),
      });
      // initialCommand 选型（票面 Comments 授权适配器自定）：spawn 后立即写入
      // pty 输入缓冲（conpty 对早到的输入有缓冲，shell 初始化完即读到），
      // 三种 shell 一条路径、无引号转义层，且保持交互提示符。备选的 shell
      // 参数内嵌（bash -c '…; exec bash' / powershell -NoExit / cmd /k）要为
      // 每 shell 维护一套引号拼装，且经 node-pty 的 Windows 命令行转义，风险面更大。
      if (
        request.initialCommand !== undefined &&
        request.initialCommand !== ""
      ) {
        proc.write(`${request.initialCommand}\r`);
      }
      return wrapProcess(proc, { isWin, spawnImpl });
    },
  };
}

interface WrappedContext {
  isWin: boolean;
  spawnImpl: (
    file: string,
    args: string[],
    options: SpawnOptions
  ) => ChildProcess;
}

/** 把 node-pty 进程包装成 PtyProcess：事件归一（exit 单次）、kill 树覆盖、
 * 退出后操作安全化、kill 后 exit 保证 */
function wrapProcess(proc: NodePtyProcess, ctx: WrappedContext): PtyProcess {
  let exitFired = false;
  let killStarted = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  const exitListeners = new Set<(event: PtyExitEvent) => void>();

  const fireExit = (event: PtyExitEvent): void => {
    if (exitFired) return;
    exitFired = true;
    if (fallbackTimer !== undefined) {
      clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
    }
    for (const listener of [...exitListeners]) listener(event);
  };

  // 真实退出事件：进包装即订阅（不漏早期 exit），归一后转发
  proc.onExit((event) => {
    fireExit(
      event.signal === undefined
        ? { exitCode: event.exitCode }
        : { exitCode: event.exitCode, signal: event.signal }
    );
  });

  return {
    get pid() {
      return proc.pid;
    },

    write(data) {
      if (exitFired) return;
      try {
        proc.write(data);
      } catch {
        // 退出竞态下 native 可能抛错；会话已死，静默丢弃（exit 事件兜底在位）
      }
    },

    resize(size) {
      if (exitFired) return;
      const { cols, rows } = size;
      // 非法尺寸静默忽略：native resize 对 0/负值行为不可靠，不给它机会
      if (
        !Number.isFinite(cols) ||
        !Number.isFinite(rows) ||
        cols < 1 ||
        rows < 1
      ) {
        return;
      }
      try {
        proc.resize(cols, rows);
      } catch {
        // 同 write：退出竞态保护
      }
    },

    kill() {
      if (killStarted || exitFired) return;
      killStarted = true;
      if (ctx.isWin) {
        // 子进程树覆盖：taskkill /T /F 对 pty pid（= shell 进程，node-pty
        // windowsTerminal 的 pid 即 innerPid）。node-pty 自带 kill 走「进程列表
        // 快照 + 逐个杀」，快照后新生的子进程会漏杀；taskkill 在杀的瞬间枚举
        // 整棵树，bash 派生的孙进程（vim/less/sleep 类）一并覆盖。
        try {
          ctx.spawnImpl("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          // taskkill 启动失败不阻断：下方 pty.kill 与 exit 兜底仍在位
        }
      }
      try {
        proc.kill();
      } catch {
        // 同上：已死 pty 的 kill 抛错吞掉
      }
      // kill 后必须触发 onExit（01 票契约：管理器终态/快照由 exit 驱动）：
      // 真实事件未到时按兜底窗合成（退出码取 taskkill /F 约定值）
      fallbackTimer = setTimeout(() => {
        fireExit({ exitCode: TASKKILL_FALLBACK_EXIT_CODE });
      }, KILL_EXIT_FALLBACK_MS);
    },

    onData(listener) {
      const disposable = proc.onData(listener);
      return () => disposable.dispose();
    },

    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
}
