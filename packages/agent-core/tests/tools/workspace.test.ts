import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveInWorkspace } from '../../src/tools/workspace';

/** 真实临时目录作工作区（spec 测试决策：文件系统实际变化，不 mock fs） */
function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
}

describe('工作区边界（resolveInWorkspace）', () => {
  it('相对路径解析为工作区内绝对路径', () => {
    const workspace = makeWorkspace();
    const resolved = resolveInWorkspace(workspace, 'src/app.ts');
    // 断言落在工作区内（用 relative 而非字符串前缀，规避大小写/分隔符差异）
    expect(resolved.startsWith(workspace)).toBe(true);
    expect(resolved).toContain(join(workspace, 'src', 'app.ts'));
  });

  it('工作区内的绝对路径放行', () => {
    const workspace = makeWorkspace();
    const absolute = join(workspace, 'notes.md');
    expect(resolveInWorkspace(workspace, absolute)).toBe(absolute);
  });

  it('.. 逃逸出工作区被拒（含多层回绕）', () => {
    const workspace = makeWorkspace();
    expect(() => resolveInWorkspace(workspace, '../outside.txt')).toThrow('路径越界');
    expect(() => resolveInWorkspace(workspace, 'a/../../outside.txt')).toThrow('路径越界');
  });

  it('工作区外的绝对路径被拒', () => {
    const workspace = makeWorkspace();
    const outside = join(tmpdir(), 'codexlike-outside.txt');
    expect(() => resolveInWorkspace(workspace, outside)).toThrow('路径越界');
  });

  it('目录符号链接指向工作区外：读与写都被拒（realpath 校验）', () => {
    const workspace = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'codexlike-out-'));
    writeFileSync(join(outside, 'secret.txt'), '秘密');
    // junction 不需要 Windows 特权（开发者模式/管理员），CI 可跑
    symlinkSync(outside, join(workspace, 'escape'), 'junction');

    expect(() => resolveInWorkspace(workspace, 'escape/secret.txt')).toThrow('路径越界');
    expect(() => resolveInWorkspace(workspace, 'escape/new-file.txt')).toThrow('路径越界');
  });

  it('符号链接指向工作区内：放行（合法用法不受影响）', () => {
    const workspace = makeWorkspace();
    mkdirSync(join(workspace, 'real'));
    writeFileSync(join(workspace, 'real', 'a.txt'), 'a');
    symlinkSync(join(workspace, 'real'), join(workspace, 'alias'), 'junction');

    const resolved = resolveInWorkspace(workspace, 'alias/a.txt');
    expect(resolved.startsWith(workspace)).toBe(true);
  });

  it('写入尚不存在的深层路径：对存在的最近祖先做 realpath 校验', () => {
    const workspace = makeWorkspace();
    mkdirSync(join(workspace, 'src'));
    const resolved = resolveInWorkspace(workspace, 'src/components/new/deep.ts');
    expect(resolved.startsWith(workspace)).toBe(true);
    // 祖先里的符号链接同样逃不出工作区
    const outside = mkdtempSync(join(tmpdir(), 'codexlike-out-'));
    symlinkSync(outside, join(workspace, 'linked'), 'junction');
    expect(() => resolveInWorkspace(workspace, 'linked/sub/new.ts')).toThrow('路径越界');
  });

  it('工作区自身经过 realpath 归一（工作区若也是链接，内外判断不受骗）', () => {
    const real = makeWorkspace();
    const linkedWorkspace = join(tmpdir(), `codexlike-link-${Date.now()}`);
    symlinkSync(real, linkedWorkspace, 'junction');
    const outside = mkdtempSync(join(tmpdir(), 'codexlike-out-'));

    expect(resolveInWorkspace(linkedWorkspace, 'ok.txt').startsWith(real)).toBe(true);
    expect(() => resolveInWorkspace(linkedWorkspace, '../../evil.txt')).toThrow('路径越界');
    expect(() => resolveInWorkspace(linkedWorkspace, outside)).toThrow('路径越界');
  });
});
