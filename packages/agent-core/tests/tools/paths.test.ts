import { describe, expect, it } from 'vitest';

import {
  posixToWindowsAbsolute,
  toDisplayPath,
  windowsToPosixAbsolute,
} from '../../src/tools/paths';

describe('Windows ↔ POSIX 路径转换（纯逻辑）', () => {
  it('Windows 绝对路径 → POSIX（盘符小写、正斜杠）', () => {
    expect(windowsToPosixAbsolute('C:\\Users\\demo\\repo')).toBe('/c/Users/demo/repo');
    expect(windowsToPosixAbsolute('D:/x/y.txt')).toBe('/d/x/y.txt');
  });

  it('POSIX 绝对路径 → Windows（盘符大写、反斜杠）', () => {
    expect(posixToWindowsAbsolute('/c/users/demo/repo')).toBe('C:\\users\\demo\\repo');
    expect(posixToWindowsAbsolute('/e/tmp/file.txt')).toBe('E:\\tmp\\file.txt');
  });

  it('非「/盘符/」形态原样返回（不误伤）', () => {
    expect(posixToWindowsAbsolute('/usr/local/bin')).toBe('/usr/local/bin');
    expect(posixToWindowsAbsolute('relative/path')).toBe('relative/path');
    expect(windowsToPosixAbsolute('/home/user')).toBe('/home/user');
  });

  it('往返转换幂等（Windows → POSIX → Windows 保真）', () => {
    const original = 'C:\\repo\\packages\\ui\\src\\main.tsx';
    expect(posixToWindowsAbsolute(windowsToPosixAbsolute(original))).toBe(
      'c:\\repo\\packages\\ui\\src\\main.tsx'.replace(/^c/, 'C'),
    );
  });

  it('UNC 路径保留双斜杠形态', () => {
    expect(windowsToPosixAbsolute('\\\\server\\share\\dir')).toBe('//server/share/dir');
  });

  it('toDisplayPath 统一正斜杠（工具输出展示用）', () => {
    expect(toDisplayPath('src\\lib\\util.ts')).toBe('src/lib/util.ts');
    expect(toDisplayPath('already/posix.ts')).toBe('already/posix.ts');
  });
});
