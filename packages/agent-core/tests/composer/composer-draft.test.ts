import { describe, expect, it } from 'vitest';

import { parseComposerDraft } from '../../src/composer/parse';

/**
 * 输入中（光标）解析：驱动 `/` 命令菜单与 `@文件引用` 菜单的弹出。
 * 约定：光标省略时取文本末尾（最常见场景）。
 */
describe('parseComposerDraft（输入中光标解析）', () => {
  it('以 / 开头的单行草稿 → 命令菜单，query 为命令 token（不含 /）', () => {
    expect(parseComposerDraft('/re')).toEqual({
      menu: 'slash-commands',
      query: 're',
    });
    expect(parseComposerDraft('/')).toEqual({
      menu: 'slash-commands',
      query: '',
    });
  });

  it('前导空白不影响命令草稿判定（与发送解析的 trim 规则一致）', () => {
    expect(parseComposerDraft('  /sta')).toEqual({
      menu: 'slash-commands',
      query: 'sta',
    });
  });

  it('已知命令已完整并跟空白（正在输参数）→ 不弹菜单', () => {
    expect(parseComposerDraft('/rename 新名称', { caretIndex: 12 })).toEqual({
      menu: null,
    });
    expect(parseComposerDraft('/status ')).toEqual({ menu: null });
  });

  it('未知 / token 仍报命令菜单（匹配过滤交给菜单层）', () => {
    expect(parseComposerDraft('/etc')).toEqual({
      menu: 'slash-commands',
      query: 'etc',
    });
  });

  it('斜杠不在行首、或多行文本 → 不构成命令草稿', () => {
    expect(parseComposerDraft('看看 /sta')).toEqual({ menu: null });
    expect(parseComposerDraft('第一行\n/st')).toEqual({ menu: null });
  });

  it('光标位于 @token 内 → 引用菜单，query 为 @ 到光标的文本', () => {
    expect(parseComposerDraft('看看 @src/ind')).toEqual({
      menu: 'mentions',
      query: 'src/ind',
      mentionStart: 3,
    });
    // 光标停在 token 中间：query 截到光标，不取 token 剩余
    expect(parseComposerDraft('看看 @src/index.ts', { caretIndex: 7 })).toEqual({
      menu: 'mentions',
      query: 'src',
      mentionStart: 3,
    });
  });

  it('刚输入 @（token 为空）→ 引用菜单空 query（展示全部候选）', () => {
    expect(parseComposerDraft('看看 @')).toEqual({
      menu: 'mentions',
      query: '',
      mentionStart: 3,
    });
    expect(parseComposerDraft('@')).toEqual({
      menu: 'mentions',
      query: '',
      mentionStart: 0,
    });
  });

  it('光标已离开 @token（后面有空白/终止标点）→ 不弹引用菜单', () => {
    expect(parseComposerDraft('看 @src 下一个词')).toEqual({
      menu: null,
    });
    expect(parseComposerDraft('@docs/x.md，说明')).toEqual({ menu: null });
  });

  it('@ 前是普通字符（邮箱）→ 不构成引用草稿', () => {
    expect(parseComposerDraft('user@example.com')).toEqual({ menu: null });
  });

  it('命令草稿与引用 token 可以共存判断：非命令输入里的 @ 优先判引用', () => {
    // 光标停在 token 尾（'s' 之后、空格之前）
    expect(parseComposerDraft('修 @pkg/a.ts 的 bug', { caretIndex: 11 })).toEqual({
      menu: 'mentions',
      query: 'pkg/a.ts',
      mentionStart: 2,
    });
  });
});
