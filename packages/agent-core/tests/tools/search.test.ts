import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGlobTool } from '../../src/tools/glob';
import { createGrepTool } from '../../src/tools/grep';
import type { ToolExecutionContext } from '../../src/tools/types';

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
  mkdirSync(join(workspace, 'src', 'lib'), { recursive: true });
  mkdirSync(join(workspace, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'app.ts'), 'export const app = 1;\n');
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export * from "./app";\n');
  writeFileSync(join(workspace, 'src', 'lib', 'util.ts'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(workspace, 'README.md'), '# demo\nCodexLike readme\n');
  writeFileSync(join(workspace, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  return workspace;
}

function context(workspacePath: string): ToolExecutionContext {
  return { workspacePath };
}

describe('glob 工具', () => {
  it('**/*.ts 递归匹配所有 .ts（node_modules 默认忽略，路径 POSIX 风格）', async () => {
    const workspace = makeWorkspace();
    const tool = createGlobTool();
    const result = await tool.execute({ pattern: '**/*.ts' }, context(workspace));

    expect(result.isError).toBe(false);
    const lines = result.output.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('['));
    expect(lines).toEqual(['src/app.ts', 'src/index.ts', 'src/lib/util.ts']);
  });

  it('单层 * 只匹配当前目录', async () => {
    const workspace = makeWorkspace();
    const tool = createGlobTool();
    const result = await tool.execute({ pattern: 'src/*.ts' }, context(workspace));
    const lines = result.output.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('['));
    expect(lines).toEqual(['src/app.ts', 'src/index.ts']);
  });

  it('? 与 [abc] 通配符', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'a1.txt'), 'x');
    writeFileSync(join(workspace, 'a2.txt'), 'x');
    writeFileSync(join(workspace, 'b1.txt'), 'x');
    const tool = createGlobTool();

    const q = await tool.execute({ pattern: 'a?.txt' }, context(workspace));
    expect(q.output).toContain('a1.txt');
    expect(q.output).toContain('a2.txt');
    expect(q.output).not.toContain('b1.txt');

    const cls = await tool.execute({ pattern: '[ab]1.txt' }, context(workspace));
    expect(cls.output).toContain('a1.txt');
    expect(cls.output).toContain('b1.txt');
  });

  it('结果超上限截断并标记', async () => {
    const workspace = makeWorkspace();
    for (let index = 1; index <= 8; index += 1) {
      writeFileSync(join(workspace, `f${index}.log`), 'x');
    }
    const tool = createGlobTool({ maxResults: 5 });
    const result = await tool.execute({ pattern: '*.log' }, context(workspace));

    expect(result.isError).toBe(false);
    expect(result.output).toContain('[已截断：共 8 个匹配，仅显示前 5 个]');
  });

  it('无匹配时输出「无匹配文件」而非报错', async () => {
    const workspace = makeWorkspace();
    const tool = createGlobTool();
    const result = await tool.execute({ pattern: '**/*.java' }, context(workspace));
    expect(result.isError).toBe(false);
    expect(result.output).toContain('无匹配文件');
  });

  it('path 参数限定搜索子目录，越界被拒', async () => {
    const workspace = makeWorkspace();
    const tool = createGlobTool();
    const inSub = await tool.execute({ pattern: '*.ts', path: 'src/lib' }, context(workspace));
    expect(inSub.output).toContain('src/lib/util.ts');
    expect(inSub.output).not.toContain('src/app.ts');

    const escape = await tool.execute({ pattern: '*', path: '..' }, context(workspace));
    expect(escape.isError).toBe(true);
    expect(escape.output).toContain('路径越界');
  });
});

describe('grep 工具', () => {
  it('跨文件正则搜索：path:行号:行内容', async () => {
    const workspace = makeWorkspace();
    const tool = createGrepTool();
    const result = await tool.execute({ pattern: 'export const' }, context(workspace));

    expect(result.isError).toBe(false);
    expect(result.output).toContain('src/app.ts:1:export const app = 1;');
    expect(result.output).toContain('src/lib/util.ts:1:export const add = (a, b) => a + b;');
    // node_modules 默认忽略
    expect(result.output).not.toContain('node_modules');
  });

  it('ignoreCase 与 glob 文件过滤', async () => {
    const workspace = makeWorkspace();
    const tool = createGrepTool();

    const caseHit = await tool.execute(
      { pattern: 'README', ignoreCase: true, glob: '*.md' },
      context(workspace),
    );
    expect(caseHit.output).toContain('README.md:2:CodexLike readme');

    const filtered = await tool.execute(
      { pattern: 'export', glob: '*.ts' },
      context(workspace),
    );
    expect(filtered.output).toContain('src/app.ts');
    expect(filtered.output).not.toContain('.md:');
  });

  it('匹配行本身超长被截断（500 字符）', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'long.txt'), `needle ${'x'.repeat(600)}\n`);
    const tool = createGrepTool();
    const result = await tool.execute({ pattern: 'needle' }, context(workspace));

    expect(result.output).toContain('…');
    expect(result.output.length).toBeLessThan(600);
  });

  it('结果超上限截断并标记', async () => {
    const workspace = makeWorkspace();
    for (let index = 1; index <= 6; index += 1) {
      writeFileSync(join(workspace, `m${index}.txt`), 'target\n');
    }
    const tool = createGrepTool({ maxResults: 4 });
    const result = await tool.execute({ pattern: 'target' }, context(workspace));

    expect(result.isError).toBe(false);
    expect(result.output).toContain('[已截断：共 6 处匹配，仅显示前 4 处]');
  });

  it('无效正则返回可读错误', async () => {
    const workspace = makeWorkspace();
    const tool = createGrepTool();
    const result = await tool.execute({ pattern: '([unclosed' }, context(workspace));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('正则');
  });

  it('二进制文件（含 NUL）被跳过而非报错', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'blob.bin'), Buffer.from([0x74, 0x00, 0x61, 0x72]));
    writeFileSync(join(workspace, 'text.txt'), 'target here\n');
    const tool = createGrepTool();
    const result = await tool.execute({ pattern: 'tar' }, context(workspace));
    expect(result.isError).toBe(false);
    expect(result.output).toContain('text.txt');
    expect(result.output).not.toContain('blob.bin');
  });

  it('path 限定子目录，越界被拒', async () => {
    const workspace = makeWorkspace();
    const tool = createGrepTool();
    const inSub = await tool.execute({ pattern: 'add', path: 'src/lib' }, context(workspace));
    expect(inSub.output).toContain('src/lib/util.ts');

    const escape = await tool.execute({ pattern: 'x', path: '../' }, context(workspace));
    expect(escape.isError).toBe(true);
    expect(escape.output).toContain('路径越界');
  });
});
