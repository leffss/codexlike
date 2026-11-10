import { describe, expect, it } from 'vitest';

import { fuzzyMatch } from '../../src/composer/fuzzy';

/** 命令菜单与 @引用菜单共用的模糊匹配（子序列、大小写不敏感、连续命中优先） */
describe('fuzzyMatch（菜单模糊匹配）', () => {
  it('空 query 返回全部候选（保持原序）', () => {
    expect(fuzzyMatch('', ['status', 'new', 'rename'])).toEqual([
      'status',
      'new',
      'rename',
    ]);
  });

  it('子序列匹配：query 字符按顺序出现即命中', () => {
    expect(fuzzyMatch('md', ['README.md', 'docs/x.md', 'main.ts'])).toEqual([
      'docs/x.md',
      'README.md',
    ]);
  });

  it('大小写不敏感', () => {
    expect(fuzzyMatch('TS', ['main.ts', 'index.js'])).toEqual(['main.ts']);
  });

  it('中文 query 命中中文文件名', () => {
    expect(fuzzyMatch('说明', ['docs/说明.md', 'src/a.ts'])).toEqual([
      'docs/说明.md',
    ]);
  });

  it('字符顺序不构成的候选不命中（ut 不命中 status）', () => {
    expect(fuzzyMatch('ut', ['status'])).toEqual([]);
  });

  it('连续命中段更长的候选排在前面（同分保持原序）', () => {
    // 'dm'：README.md 里 d(3)m(4) 连续；docs/x.md 里 d…m 分离
    expect(fuzzyMatch('dm', ['docs/x.md', 'README.md'])).toEqual([
      'README.md',
      'docs/x.md',
    ]);
  });

  it('支持对象候选：按 textOf 提取文本匹配，返回原对象', () => {
    const candidates = [
      { id: '1', rel: 'src/app.ts' },
      { id: '2', rel: 'docs/指南.md' },
    ];
    expect(fuzzyMatch('指南', candidates, (item) => item.rel)).toEqual([
      { id: '2', rel: 'docs/指南.md' },
    ]);
  });

  it('命令名匹配：st → status；re 连续命中 rename 优先于 archive', () => {
    expect(fuzzyMatch('st', ['new', 'rename', 'archive', 'model', 'status'])).toEqual([
      'status',
    ]);
    expect(fuzzyMatch('re', ['new', 'rename', 'archive', 'model', 'status'])).toEqual([
      'rename',
      'archive',
    ]);
  });
});
