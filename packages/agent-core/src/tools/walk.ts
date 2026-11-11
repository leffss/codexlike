import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { toDisplayPath } from './paths';

/** 搜索默认忽略的目录（依赖目录与 VCS 元数据，噪音远大于价值） */
export const DEFAULT_IGNORE_DIRS = new Set(['node_modules', '.git']);

/**
 * 深度优先遍历 base 下的所有文件，产出相对 base 的 POSIX 风格路径。
 * 符号链接目录不跟随（防环、防越过工作区边界读文件）；字母序稳定输出。
 */
export function* walkFiles(
  base: string,
  ignoreDirs: Set<string> = DEFAULT_IGNORE_DIRS,
): Generator<string> {
  const stack: string[][] = [[]];
  while (stack.length > 0) {
    const prefix = stack.pop()!;
    const dir = join(base, ...prefix);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限等：跳过该目录
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) {
          continue;
        }
        stack.push([...prefix, entry.name]);
        continue;
      }
      if (entry.isFile()) {
        yield toDisplayPath([...prefix, entry.name].join('/'));
      }
      // 符号链接文件不产出：readFileSync 会读目标（可能越界），搜索类工具不冒这个险
    }
  }
}

/**
 * 受限 glob 模式 → 正则：支持 `**`（跨目录）、`*`（单层）、`?`（单字符）、`[abc]`（字符类）。
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]*/)*'; // **/ 零或多层目录
          index += 3;
        } else {
          source += '.*'; // ** 跨任意路径段
          index += 2;
        }
      } else {
        source += '[^/]*';
        index += 1;
      }
    } else if (char === '?') {
      source += '[^/]';
      index += 1;
    } else if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close === -1) {
        source += escapeRegExp(char);
        index += 1;
      } else {
        source += pattern.slice(index, close + 1);
        index = close + 1;
      }
    } else {
      source += escapeRegExp(char);
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
