import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';

import { expectString, parseToolArgs } from './args';
// content 允许空串（清空文件是合法操作），在 execute 内单独校验
import { defineTool } from './define-tool';
import { toDisplayPath } from './paths';
import { resolveInWorkspace } from './workspace';

/** write_file：在工作区内写入文件（覆盖语义），自动创建父目录；路径越界被拒 */
export function createWriteFileTool() {
  return defineTool({
    name: 'write_file',
    description:
      '把完整内容写入工作区内的文件（存在则整体覆盖，不存在则新建，父目录自动创建）。' +
      '局部修改优先用 apply_patch，整文件重写或新建才用它。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内相对路径' },
        content: { type: 'string', description: '写入的完整文件内容' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    permission: 'write',

    async execute(rawArgs, context) {
      const args = parseToolArgs(rawArgs);
      const target = expectString(args, 'path');
      const content = args['content'];
      if (typeof content !== 'string') {
        throw new Error('参数 content 缺失或不是字符串');
      }

      const absolute = resolveInWorkspace(context.workspacePath, target);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf8');

      const shown = toDisplayPath(relative(context.workspacePath, absolute)) || toDisplayPath(target);
      const bytes = Buffer.byteLength(content, 'utf8');
      return { output: `已写入 ${shown}（${bytes} 字节）`, isError: false };
    },
  });
}
