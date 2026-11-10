import { describe, expect, it } from 'vitest';

import { codexlikeBranchName } from '../../src/git/branch-name';

describe('codexlikeBranchName（会话名 → codexlike/<会话名> 分支名）', () => {
  it('常规标题原样保留（中文合法）', () => {
    expect(codexlikeBranchName('修复登录')).toBe('codexlike/修复登录');
  });

  it('git 分支非法字符替换为连字符（空格、~^:?*[\\ 等）', () => {
    expect(codexlikeBranchName('修复 登录 bug')).toBe('codexlike/修复-登录-bug');
    expect(codexlikeBranchName('feat: add x?')).toBe('codexlike/feat-add-x');
  });

  it('空标题或全非法字符：回退 session', () => {
    expect(codexlikeBranchName('')).toBe('codexlike/session');
    expect(codexlikeBranchName('???')).toBe('codexlike/session');
  });

  it('不以 . 结尾（git 分支名约束），压缩重复分隔符', () => {
    expect(codexlikeBranchName('重构..清理')).toBe('codexlike/重构-清理');
    expect(codexlikeBranchName('结尾点.')).toBe('codexlike/结尾点');
    expect(codexlikeBranchName('多个   空格')).toBe('codexlike/多个-空格');
  });

  it('超长标题截断到 48 字符以内（不含 codexlike/ 前缀）', () => {
    const long = '这是一个非常长的会话标题'.repeat(20);
    const name = codexlikeBranchName(long);
    expect(name.startsWith('codexlike/')).toBe(true);
    expect(name.length).toBeLessThanOrEqual('codexlike/'.length + 48);
  });
});
