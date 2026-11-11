import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createThemeSettingsStore,
  isThemeName,
} from '../../src/theme/theme-settings-store';

/**
 * 外观主题偏好（ADR 0006）：light / dark 二值偏好，设置页持久化，默认浅色。
 * 未配置（null）由 UI 以浅色兜底——存储层只负责如实读写。
 */
let tempDir: string;

function makeDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'codexlike-theme-settings-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('theme-settings-store', () => {
  it('未配置（无文件）返回 null；保存后恢复，重启（新实例）仍读到', async () => {
    const dir = makeDir();
    const store = createThemeSettingsStore({ dir });
    expect(await store.get()).toBeNull();

    expect(await store.set('dark')).toBe('dark');
    expect(await store.get()).toBe('dark');

    const reopened = createThemeSettingsStore({ dir });
    expect(await reopened.get()).toBe('dark');
    expect(readFileSync(join(dir, 'theme-settings.json'), 'utf8')).toBe(
      '{\n  "theme": "dark"\n}',
    );
  });

  it('set 拒绝非法枚举值', async () => {
    const dir = makeDir();
    const store = createThemeSettingsStore({ dir });
    await expect(store.set('blue' as never)).rejects.toThrow('light / dark');
  });

  it('损坏文件按未配置（null）处理，不抛错', async () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'theme-settings.json'), '{oops', 'utf8');
    expect(await createThemeSettingsStore({ dir }).get()).toBeNull();
  });

  it('文件存在但 theme 字段非法同样按未配置处理', async () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'theme-settings.json'), '{"theme":"solarized"}', 'utf8');
    expect(await createThemeSettingsStore({ dir }).get()).toBeNull();
  });

  it('父目录不存在时首次写入自建目录（CODING_STANDARDS 数据目录自建）', async () => {
    const dir = join(makeDir(), 'nested', 'codexlike');
    const store = createThemeSettingsStore({ dir });
    expect(await store.set('light')).toBe('light');
    expect(await createThemeSettingsStore({ dir }).get()).toBe('light');
  });
});

describe('isThemeName 枚举判定', () => {
  it('接受 light / dark，拒绝其他', () => {
    expect(isThemeName('light')).toBe(true);
    expect(isThemeName('dark')).toBe(true);
    expect(isThemeName('system')).toBe(false);
    expect(isThemeName(123)).toBe(false);
  });
});
