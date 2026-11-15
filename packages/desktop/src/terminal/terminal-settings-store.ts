import { join } from "node:path";

import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_MAX_COMMAND_TIMEOUT_SECONDS,
  type TerminalShell,
} from "@codexlike/agent-core/node";

import { readJsonFile, writeJsonFile } from "../storage/json-file";

/**
 * 终端设置：shell 偏好（code review 修复 1，spec「设置页：… shell 偏好」）+
 * 命令超时两项（执行设置票04，ADR 0017「终端两项扩展现有终端设置文件」）。
 * run_terminal_command 消费：shell 未配置时 CODEXLIKE_SHELL 环境变量兜底
 * （保持 E2E/自动化注入兼容），最终默认 Git Bash；超时经工具 options 注入逐次解析。
 */

/** 可选值（与 UI select 一致） */
export const TERMINAL_SHELLS: readonly TerminalShell[] = [
  "git-bash",
  "powershell",
  "cmd",
];

export function isTerminalShell(value: unknown): value is TerminalShell {
  return (
    typeof value === "string" &&
    (TERMINAL_SHELLS as readonly string[]).includes(value)
  );
}

/** shell 中文标签（设置页展示） */
export const TERMINAL_SHELL_LABELS: Record<TerminalShell, string> = {
  "git-bash": "Git Bash（默认）",
  powershell: "PowerShell",
  cmd: "cmd",
};

/** 命令超时合法范围（秒，spec/ADR 0017）：5–600 */
export const COMMAND_TIMEOUT_MIN = 5;
export const COMMAND_TIMEOUT_MAX = 600;
/** 最大命令超时合法范围（秒）：10–1800 */
export const MAX_COMMAND_TIMEOUT_MIN = 10;
export const MAX_COMMAND_TIMEOUT_MAX = 1800;

/** 终端设置（get 返回完整形状；shell null = 未配置，保存前 env 兜底生效） */
export interface TerminalSettings {
  shell: TerminalShell | null;
  /** 命令超时（秒，5–600，默认 30） */
  commandTimeoutSeconds: number;
  /** 最大命令超时（秒，10–1800，默认 120）；恒 ≥ commandTimeoutSeconds */
  maxCommandTimeoutSeconds: number;
}

/**
 * 生效 shell 合并（纯函数）：设置项优先 > CODEXLIKE_SHELL 环境变量兜底 > Git Bash。
 * 设置项为 null（未配置）时环境变量才有机会生效——E2E/自动化仍可经 env 注入。
 */
export function resolveTerminalShell(
  preferred: TerminalShell | null,
  envValue: string | undefined
): TerminalShell {
  if (preferred !== null && isTerminalShell(preferred)) {
    return preferred;
  }
  if (isTerminalShell(envValue)) {
    return envValue;
  }
  return "git-bash";
}

/** 超时字段读取收敛（纯函数）：非法/越界值回默认或夹进合法范围（防手改文件） */
function normalizeTimeoutSeconds(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const num = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(num)) {
    return fallback;
  }
  return Math.min(Math.max(num, min), max);
}

/** 读取侧超时对收敛：先夹最大命令超时，再把命令超时压到不大于它 */
function normalizeTimeouts(parsed: {
  commandTimeoutSeconds?: unknown;
  maxCommandTimeoutSeconds?: unknown;
}): Pick<
  TerminalSettings,
  "commandTimeoutSeconds" | "maxCommandTimeoutSeconds"
> {
  const maxCommandTimeoutSeconds = normalizeTimeoutSeconds(
    parsed.maxCommandTimeoutSeconds,
    MAX_COMMAND_TIMEOUT_MIN,
    MAX_COMMAND_TIMEOUT_MAX,
    DEFAULT_MAX_COMMAND_TIMEOUT_SECONDS
  );
  const commandTimeoutSeconds = Math.min(
    normalizeTimeoutSeconds(
      parsed.commandTimeoutSeconds,
      COMMAND_TIMEOUT_MIN,
      COMMAND_TIMEOUT_MAX,
      DEFAULT_COMMAND_TIMEOUT_SECONDS
    ),
    maxCommandTimeoutSeconds
  );
  return { commandTimeoutSeconds, maxCommandTimeoutSeconds };
}

/** 超时写入校验（纯函数）：非法时返回中文错误消息，合法返回 null */
function validateTimeouts(
  commandTimeoutSeconds: unknown,
  maxCommandTimeoutSeconds: unknown
): string | null {
  if (
    !Number.isInteger(commandTimeoutSeconds) ||
    (commandTimeoutSeconds as number) < COMMAND_TIMEOUT_MIN ||
    (commandTimeoutSeconds as number) > COMMAND_TIMEOUT_MAX
  ) {
    return `命令超时必须是 ${COMMAND_TIMEOUT_MIN}-${COMMAND_TIMEOUT_MAX} 的整数（秒）`;
  }
  if (
    !Number.isInteger(maxCommandTimeoutSeconds) ||
    (maxCommandTimeoutSeconds as number) < MAX_COMMAND_TIMEOUT_MIN ||
    (maxCommandTimeoutSeconds as number) > MAX_COMMAND_TIMEOUT_MAX
  ) {
    return `最大命令超时必须是 ${MAX_COMMAND_TIMEOUT_MIN}-${MAX_COMMAND_TIMEOUT_MAX} 的整数（秒）`;
  }
  if (
    (commandTimeoutSeconds as number) > (maxCommandTimeoutSeconds as number)
  ) {
    return "命令超时不能大于最大命令超时";
  }
  return null;
}

/**
 * IPC 边界输入解析（纯函数，不信任渲染进程）：unknown → TerminalSettings，
 * 形状/枚举/范围/联动校验任一失败以中文异常抛回。
 */
export function parseTerminalSettingsInput(input: unknown): TerminalSettings {
  if (typeof input !== "object" || input === null) {
    throw new Error("终端设置输入不合法");
  }
  const { shell, commandTimeoutSeconds, maxCommandTimeoutSeconds } =
    input as Record<string, unknown>;
  if (!isTerminalShell(shell)) {
    throw new Error("终端偏好必须是 git-bash / powershell / cmd 之一");
  }
  const timeoutError = validateTimeouts(
    commandTimeoutSeconds,
    maxCommandTimeoutSeconds
  );
  if (timeoutError !== null) {
    throw new Error(timeoutError);
  }
  return {
    shell,
    commandTimeoutSeconds: commandTimeoutSeconds as number,
    maxCommandTimeoutSeconds: maxCommandTimeoutSeconds as number,
  };
}

export interface TerminalSettingsStore {
  /** 已保存的终端设置；未配置（无文件）时 shell 为 null、超时为默认值 */
  get(): Promise<TerminalSettings>;
  /** 保存设置（枚举/范围/联动校验）并返回保存后的值 */
  set(settings: TerminalSettings): Promise<TerminalSettings>;
}

const FILE_NAME = "terminal-settings.json";

/** 终端设置的本地存储（`~/.codexlike/terminal-settings.json`）；损坏文件按默认值处理 */
export function createTerminalSettingsStore(options: {
  dir: string;
}): TerminalSettingsStore {
  const filePath = join(options.dir, FILE_NAME);

  function loadFile(): TerminalSettings {
    const parsed = readJsonFile<Partial<TerminalSettings>>(
      filePath,
      {},
      {
        corruptAsFallback: true,
      }
    );
    return {
      shell: isTerminalShell(parsed.shell) ? parsed.shell : null,
      ...normalizeTimeouts(parsed),
    };
  }

  return {
    async get() {
      return loadFile();
    },

    async set(settings) {
      if (!isTerminalShell(settings.shell)) {
        throw new Error("终端偏好必须是 git-bash / powershell / cmd 之一");
      }
      const timeoutError = validateTimeouts(
        settings.commandTimeoutSeconds,
        settings.maxCommandTimeoutSeconds
      );
      if (timeoutError !== null) {
        throw new Error(timeoutError);
      }
      const next: TerminalSettings = {
        shell: settings.shell,
        commandTimeoutSeconds: settings.commandTimeoutSeconds,
        maxCommandTimeoutSeconds: settings.maxCommandTimeoutSeconds,
      };
      writeJsonFile(filePath, next);
      return next;
    },
  };
}
