import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { readMentionAttachments } from '../../src/sessions/mentions';

/** 工单 07：@引用 文件读取（主进程侧，路径限制在工作区内） */
const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codexlike-mention-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readMentionAttachments（@引用 文件读取）', () => {
  it('读取工作区内相对路径的文件内容，保持传入顺序', () => {
    const ws = workspace();
    writeFileSync(join(ws, 'a.ts'), 'export const a = 1;');
    mkdirSync(join(ws, 'docs'));
    writeFileSync(join(ws, 'docs', '说明.md'), '# 说明');

    expect(
      readMentionAttachments(ws, ['docs/说明.md', 'a.ts']),
    ).toEqual([
      { path: 'docs/说明.md', content: '# 说明' },
      { path: 'a.ts', content: 'export const a = 1;' },
    ]);
  });

  it('Windows 反斜杠分隔的路径同样可读（@token 原样文本）', () => {
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'b.ts'), 'b');

    expect(readMentionAttachments(ws, ['src\\b.ts'])).toEqual([
      { path: 'src\\b.ts', content: 'b' },
    ]);
  });

  it('.. 逃逸工作区的路径拒绝并给出中文错误', () => {
    const ws = workspace();
    expect(() => readMentionAttachments(ws, ['../outside.txt'])).toThrow(
      /工作区外|不允许/,
    );
    expect(() => readMentionAttachments(ws, ['a/../../escape.txt'])).toThrow(
      /工作区外|不允许/,
    );
  });

  it('符号链接逃逸工作区同样拒绝（realpath 校验）', () => {
    const ws = workspace();
    const outside = mkdtempSync(join(tmpdir(), 'codexlike-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), '秘密');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(ws, 'link.txt'));
    } catch (error) {
      // Windows 无开发者模式/管理员权限时创建符号链接被拒（EPERM）：
      // 环境限制而非实现问题，跳过本用例（其余前缀校验用例已覆盖主路径）。
      console.warn('符号链接用例跳过：', error);
      return;
    }

    expect(() => readMentionAttachments(ws, ['link.txt'])).toThrow(
      /工作区外|不允许/,
    );
  });

  it('文件不存在给出中文错误（引用后文件被删）', () => {
    const ws = workspace();
    expect(() => readMentionAttachments(ws, ['gone.txt'])).toThrow(/不存在/);
  });

  it('超过 128 KiB 的文件内容截断并附中文注明', () => {
    const ws = workspace();
    writeFileSync(join(ws, 'big.txt'), 'x'.repeat(200 * 1024));
    const [attachment] = readMentionAttachments(ws, ['big.txt']);
    expect(attachment?.content.length).toBeLessThan(200 * 1024);
    expect(attachment?.content).toContain('截断');
    expect(attachment?.content.startsWith('x')).toBe(true);
  });
});
