import { optionalString, parseToolArgs, expectString } from './args';
import { defineTool } from './define-tool';
import { toDisplayPath } from './paths';
import { globToRegExp, walkFiles } from './walk';
import { relative } from 'node:path';
import { resolveInWorkspace } from './workspace';

export interface GlobToolOptions {
  /** 结果条数上限（默认 200；超出截断并标记） */
  maxResults?: number;
}

/** glob：按模式列出工作区内文件（**、*、?、[abc]；node_modules/.git 默认忽略） */
export function createGlobTool(options: GlobToolOptions = {}) {
  const maxResults = options.maxResults ?? 200;

  return defineTool({
    name: 'glob',
    description:
      `按 glob 模式列出工作区内文件路径（相对工作区、正斜杠）。支持 **（跨目录）、*（单层）、?、[abc]；` +
      `最多返回 ${maxResults} 条。node_modules 与 .git 默认忽略。`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，例如 **/*.ts' },
        path: { type: 'string', description: '限定搜索的子目录（相对工作区，默认整个工作区）' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    permission: 'readonly',

    async execute(rawArgs, context) {
      const args = parseToolArgs(rawArgs);
      const pattern = expectString(args, 'pattern');
      const scopePath = optionalString(args, 'path');

      const base = resolveInWorkspace(context.workspacePath, scopePath ?? '.');
      const regex = globToRegExp(pattern);

      // pattern 语义相对 base（限定了 path 时 *.ts 只在该目录内匹配）
      const all: string[] = [];
      for (const relToBase of walkFiles(base)) {
        if (regex.test(relToBase)) {
          const full = scopePath === undefined
            ? relToBase
            : toDisplayPath(relative(context.workspacePath, base)).concat('/', relToBase);
          all.push(full);
        }
      }
      all.sort();

      if (all.length === 0) {
        return { output: `无匹配文件（模式 ${pattern}）`, isError: false };
      }
      const shown = all.slice(0, maxResults);
      let output = shown.join('\n');
      if (all.length > shown.length) {
        output += `\n[已截断：共 ${all.length} 个匹配，仅显示前 ${shown.length} 个]`;
      }
      return { output, isError: false };
    },
  });
}
