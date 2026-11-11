import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readJsonFile, writeJsonFile } from '../../src/storage/json-file';

/**
 * 四个 JSON 设置存储共享的读写（code review 修复 4 抽取）：
 * ENOENT → fallback、损坏 JSON 默认抛错（corruptAsFallback 可容错）、写侧建目录 + 2 空格缩进。
 */
let tempDir: string;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'codexlike-json-file-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('readJsonFile', () => {
  it('文件不存在（ENOENT）返回 fallback，不抛错', () => {
    const dir = makeTempDir();
    expect(readJsonFile(join(dir, 'absent.json'), { a: 1 })).toEqual({ a: 1 });
  });

  it('正常 JSON 原样解析', () => {
    const dir = makeTempDir();
    const path = join(dir, 'data.json');
    writeFileSync(path, '{"b":2}', 'utf8');
    expect(readJsonFile<{ b: number }>(path, { b: 0 })).toEqual({ b: 2 });
  });

  it('损坏 JSON 默认抛错；corruptAsFallback 时返回 fallback', () => {
    const dir = makeTempDir();
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{oops', 'utf8');
    expect(() => readJsonFile(path, { a: 1 })).toThrow();
    expect(readJsonFile(path, { a: 1 }, { corruptAsFallback: true })).toEqual({ a: 1 });
  });
});

describe('writeJsonFile', () => {
  it('目录不存在时自动创建，落盘为 2 空格缩进的 JSON', () => {
    const dir = makeTempDir();
    const path = join(dir, 'nested', 'deeper', 'data.json');
    writeJsonFile(path, { name: '值' });
    expect(readJsonFile<{ name?: string }>(path, {})).toEqual({ name: '值' });
    expect(readFileSync(path, 'utf8')).toBe('{\n  "name": "值"\n}');
  });
});
