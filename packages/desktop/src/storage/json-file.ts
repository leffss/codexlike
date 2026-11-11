import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 四个 JSON 设置存储（profiles / mcp / subagents / search）共享的文件读写。
 * 读：ENOENT → fallback（未配置态）；写：确保目录存在后以 2 空格缩进落盘。
 * 损坏（非法 JSON）默认抛错，由调用方决定是否容错（corruptAsFallback）。
 */
export function readJsonFile<T>(
  filePath: string,
  fallback: T,
  options: { corruptAsFallback?: boolean } = {},
): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    if (options.corruptAsFallback === true) {
      return fallback;
    }
    throw error;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}
