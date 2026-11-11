import { join } from 'node:path';

import type { TerminalShell } from '@codexlike/agent-core/node';

import { readJsonFile, writeJsonFile } from '../storage/json-file';

/**
 * 终端执行偏好（code review 修复 1，spec「设置页：… shell 偏好」）：
 * run_terminal_command 使用的 shell，设置页持久化；未配置时 CODEXLIKE_SHELL
 * 环境变量兜底（保持 E2E/自动化注入兼容），最终默认 Git Bash。
 */

/** 可选值（与 UI select 一致） */
export const TERMINAL_SHELLS: readonly TerminalShell[] = [
  'git-bash',
  'powershell',
  'cmd',
];

export function isTerminalShell(value: unknown): value is TerminalShell {
  return (
    typeof value === 'string' &&
    (TERMINAL_SHELLS as readonly string[]).includes(value)
  );
}

/** shell 中文标签（设置页展示） */
export const TERMINAL_SHELL_LABELS: Record<TerminalShell, string> = {
  'git-bash': 'Git Bash（默认）',
  powershell: 'PowerShell',
  cmd: 'cmd',
};

/**
 * 生效 shell 合并（纯函数）：设置项优先 > CODEXLIKE_SHELL 环境变量兜底 > Git Bash。
 * 设置项为 null（未配置）时环境变量才有机会生效——E2E/自动化仍可经 env 注入。
 */
export function resolveTerminalShell(
  preferred: TerminalShell | null,
  envValue: string | undefined,
): TerminalShell {
  if (preferred !== null && isTerminalShell(preferred)) {
    return preferred;
  }
  if (isTerminalShell(envValue)) {
    return envValue;
  }
  return 'git-bash';
}

export interface TerminalSettingsStore {
  /** 已保存的 shell 偏好；未配置（无文件）返回 null */
  get(): Promise<TerminalShell | null>;
  /** 保存偏好（枚举校验）并返回保存后的值 */
  set(shell: TerminalShell): Promise<TerminalShell>;
}

const FILE_NAME = 'terminal-settings.json';

/** shell 偏好的本地存储（`~/.codexlike/terminal-settings.json`）；损坏文件按未配置处理 */
export function createTerminalSettingsStore(options: {
  dir: string;
}): TerminalSettingsStore {
  const filePath = join(options.dir, FILE_NAME);

  function loadFile(): TerminalShell | null {
    const parsed = readJsonFile<{ shell?: unknown }>(filePath, {}, {
      corruptAsFallback: true,
    });
    return isTerminalShell(parsed.shell) ? parsed.shell : null;
  }

  return {
    async get() {
      return loadFile();
    },

    async set(shell) {
      if (!isTerminalShell(shell)) {
        throw new Error('终端偏好必须是 git-bash / powershell / cmd 之一');
      }
      writeJsonFile(filePath, { shell });
      return shell;
    },
  };
}
