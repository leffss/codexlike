import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';

import { expectString, optionalString, parseToolArgs } from './args';
import { defineTool } from './define-tool';
import { toDisplayPath } from './paths';
import { splitLines } from './read-file';
import { globToRegExp, walkFiles } from './walk';
import { resolveInWorkspace } from './workspace';

export interface GrepToolOptions {
  /** 匹配条数上限（默认 100；超出截断并标记） */
  maxResults?: number;
  /** 单行展示长度上限 */
  maxLineLength?: number;
}

/** grep：正则搜索工作区文件内容，输出 `path:行号:行内容` */
export function createGrepTool(options: GrepToolOptions = {}) {
  const maxResults = options.maxResults ?? 100;
  const maxLineLength = options.maxLineLength ?? 500;

  return defineTool({
    name: 'grep',
    description:
      `在工作区文件内容中做正则搜索，输出「路径:行号:行内容」（正斜杠路径）。` +
      `最多 ${maxResults} 处匹配、node_modules 与 .git 默认忽略、二进制文件跳过。` +
      '可用 glob 参数按文件名过滤（如 *.ts）、ignoreCase 忽略大小写。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '限定搜索的子目录（相对工作区，默认整个工作区）' },
        glob: { type: 'string', description: '文件名过滤模式，如 *.ts' },
        ignoreCase: { type: 'boolean', description: '忽略大小写（默认 false）' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    permission: 'readonly',

    async execute(rawArgs, context) {
      const args = parseToolArgs(rawArgs);
      const pattern = expectString(args, 'pattern');
      const scopePath = optionalString(args, 'path');
      const globPattern = optionalString(args, 'glob');
      const ignoreCase = args['ignoreCase'] === true;

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, ignoreCase ? 'i' : '');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`正则表达式不合法（${pattern}）：${reason}`);
      }
      const nameFilter = globPattern === undefined ? undefined : globToRegExp(globPattern);

      const base = resolveInWorkspace(context.workspacePath, scopePath ?? '.');
      const prefix =
        scopePath === undefined ? '' : `${toDisplayPath(relative(context.workspacePath, base))}/`;

      const hits: string[] = [];
      let total = 0;
      for (const relToBase of walkFiles(base)) {
        if (nameFilter !== undefined && !nameFilter.test(basename(relToBase))) {
          continue;
        }
        const absolute = `${base}/${relToBase}`.replaceAll('\\', '/');
        let buffer;
        try {
          buffer = readFileSync(absolute);
        } catch {
          continue;
        }
        if (buffer.includes(0)) {
          continue; // 二进制文件跳过
        }
        const lines = splitLines(buffer.toString('utf8'));
        for (let index = 0; index < lines.length; index += 1) {
          if (!regex.test(lines[index]!)) {
            continue;
          }
          total += 1;
          if (hits.length < maxResults) {
            const content = truncateLine(lines[index]!, maxLineLength);
            hits.push(`${prefix}${relToBase}:${index + 1}:${content}`);
          }
        }
      }

      if (total === 0) {
        return { output: `无匹配（正则 ${pattern}）`, isError: false };
      }
      let output = hits.join('\n');
      if (total > hits.length) {
        output += `\n[已截断：共 ${total} 处匹配，仅显示前 ${hits.length} 处]`;
      }
      return { output, isError: false };
    },
  });
}

function truncateLine(line: string, maxLength: number): string {
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
}
