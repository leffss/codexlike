import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTerminalSettingsStore,
  isTerminalShell,
  resolveTerminalShell,
} from '../../src/terminal/terminal-settings-store';

/**
 * 终端执行偏好（code review 修复 1）：store 持久化 + 「设置项优先、env 兜底」合并纯函数。
 */
let tempDir: string;

function makeDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'codexlike-terminal-settings-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('terminal-settings-store', () => {
  it('未配置（无文件）返回 null；保存后恢复，重启（新实例）仍读到', async () => {
    const dir = makeDir();
    const store = createTerminalSettingsStore({ dir });
    expect(await store.get()).toBeNull();

    expect(await store.set('powershell')).toBe('powershell');
    expect(await store.get()).toBe('powershell');

    const reopened = createTerminalSettingsStore({ dir });
    expect(await reopened.get()).toBe('powershell');
    expect(readFileSync(join(dir, 'terminal-settings.json'), 'utf8')).toBe(
      '{\n  "shell": "powershell"\n}',
    );
  });

  it('set 拒绝非法枚举值', async () => {
    const dir = makeDir();
    const store = createTerminalSettingsStore({ dir });
    await expect(store.set('zsh' as never)).rejects.toThrow('git-bash / powershell / cmd');
  });

  it('损坏文件按未配置（null）处理，不抛错', async () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'terminal-settings.json'), '{oops', 'utf8');
    expect(await createTerminalSettingsStore({ dir }).get()).toBeNull();
  });

  it('文件存在但 shell 字段非法同样按未配置处理', async () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'terminal-settings.json'), '{"shell":"fish"}', 'utf8');
    expect(await createTerminalSettingsStore({ dir }).get()).toBeNull();
  });
});

describe('resolveTerminalShell（设置项优先、CODEXLIKE_SHELL 兜底）', () => {
  it('设置项存在时优先于环境变量', () => {
    expect(resolveTerminalShell('cmd', 'powershell')).toBe('cmd');
    expect(resolveTerminalShell('git-bash', 'powershell')).toBe('git-bash');
  });

  it('未配置（null）时环境变量兜底', () => {
    expect(resolveTerminalShell(null, 'powershell')).toBe('powershell');
    expect(resolveTerminalShell(null, 'cmd')).toBe('cmd');
    expect(resolveTerminalShell(null, 'git-bash')).toBe('git-bash');
  });

  it('环境变量非法或缺失时默认 Git Bash', () => {
    expect(resolveTerminalShell(null, undefined)).toBe('git-bash');
    expect(resolveTerminalShell(null, 'zsh')).toBe('git-bash');
    expect(resolveTerminalShell(null, '')).toBe('git-bash');
  });

  it('isTerminalShell 枚举判定', () => {
    expect(isTerminalShell('powershell')).toBe(true);
    expect(isTerminalShell('zsh')).toBe(false);
    expect(isTerminalShell(123)).toBe(false);
  });
});
