import { describe, expect, it } from 'vitest';

import { SLASH_COMMANDS } from '@codexlike/agent-core';

import {
  applyMentionSelection,
  computeMenu,
  handleMenuKey,
} from '../src/lib/composer-menu';

const FILES = ['src/app.ts', 'src/lib/util.ts', 'docs/指南.md', 'README.md'];

/** 输入框菜单（/ 命令与 @引用）的纯函数核心 */
describe('computeMenu（由草稿解析计算菜单状态）', () => {
  it('命令草稿：按 query 模糊过滤命令表，默认高亮第一项', () => {
    const menu = computeMenu(
      { menu: 'slash-commands', query: 'st' },
      { commands: SLASH_COMMANDS, files: FILES },
    );
    expect(menu).toMatchObject({ kind: 'slash-commands', activeIndex: 0 });
    expect(menu?.items.map((item) => (item as { name: string }).name)).toEqual([
      'status',
    ]);
  });

  it('空 query 展示全部命令', () => {
    const menu = computeMenu(
      { menu: 'slash-commands', query: '' },
      { commands: SLASH_COMMANDS, files: FILES },
    );
    expect(menu?.items).toHaveLength(SLASH_COMMANDS.length);
  });

  it('引用草稿：按 query 过滤工作区文件，最多 20 条', () => {
    const many = Array.from({ length: 50 }, (_, i) => `f${i}.txt`);
    const menu = computeMenu(
      { menu: 'mentions', query: '', mentionStart: 2 },
      { commands: SLASH_COMMANDS, files: many },
    );
    expect(menu?.kind).toBe('mentions');
    expect(menu?.items).toHaveLength(20);
  });

  it('无命中返回 null（不弹菜单）', () => {
    expect(
      computeMenu(
        { menu: 'mentions', query: 'zzz不存在', mentionStart: 0 },
        { commands: SLASH_COMMANDS, files: FILES },
      ),
    ).toBeNull();
    expect(
      computeMenu({ menu: null }, { commands: SLASH_COMMANDS, files: FILES }),
    ).toBeNull();
  });
});

describe('handleMenuKey（菜单键盘导航）', () => {
  const menu = computeMenu(
    { menu: 'mentions', query: '', mentionStart: 0 },
    { commands: SLASH_COMMANDS, files: FILES },
  )!;

  it('ArrowDown / ArrowUp 移动高亮并循环', () => {
    expect(handleMenuKey(menu, 'ArrowDown')).toMatchObject({
      action: 'move',
      activeIndex: 1,
    });
    expect(handleMenuKey({ ...menu, activeIndex: 0 }, 'ArrowUp')).toMatchObject({
      action: 'move',
      activeIndex: menu.items.length - 1,
    });
  });

  it('Enter / Tab 选中当前高亮项', () => {
    expect(handleMenuKey({ ...menu, activeIndex: 1 }, 'Enter')).toMatchObject({
      action: 'select',
      item: menu.items[1],
    });
    expect(handleMenuKey(menu, 'Tab')).toMatchObject({ action: 'select' });
  });

  it('Escape 关闭菜单；其他键交回输入框默认行为', () => {
    expect(handleMenuKey(menu, 'Escape')).toEqual({ action: 'close' });
    expect(handleMenuKey(menu, 'a')).toEqual({ action: 'default' });
  });
});

describe('applyMentionSelection（把选中文件写回输入框）', () => {
  it('替换从 @ 到光标的 token，路径后补空格，光标移到末尾', () => {
    const result = applyMentionSelection({
      text: '看看 @src/ap',
      mentionStart: 3,
      selectedPath: 'src/app.ts',
    });
    expect(result.text).toBe('看看 @src/app.ts ');
    expect(result.caretIndex).toBe('看看 @src/app.ts '.length);
  });

  it('光标停在 token 中间时同样整段替换', () => {
    const result = applyMentionSelection({
      text: '看看 @src/app.ts 后面还有字',
      mentionStart: 3,
      // token '@src/app.ts' 占 index 3..14，替换到 token 尾部
      tokenEnd: 14,
      selectedPath: 'src/lib/util.ts',
    });
    expect(result.text).toBe('看看 @src/lib/util.ts 后面还有字');
  });
});
