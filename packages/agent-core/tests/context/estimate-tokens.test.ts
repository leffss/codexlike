import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../../src/context/tokens';

/**
 * token 用量估算（/status 显示、工单 08 compact 复用的稳定接口）。
 * 近似规则：CJK 字符约 1.5 字符/token，其余约 4 字符/token，向上取整。
 */
describe('estimateTokens（字符数近似估算）', () => {
  it('空文本为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('纯拉丁文本：11 字符 → ceil(11/4) = 3', () => {
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('纯中文文本：4 个 CJK 字符 → ceil(4/1.5) = 3', () => {
    expect(estimateTokens('你好世界')).toBe(3);
  });

  it('中英混排：hi 你好（3 拉丁 + 2 CJK）→ ceil(3/4 + 2/1.5) = 3', () => {
    expect(estimateTokens('hi 你好')).toBe(3);
  });

  it('中文全角标点按 CJK 计', () => {
    // 6 个全角字符（。，！？：「）→ ceil(6/1.5) = 4
    expect(estimateTokens('。，！？：「')).toBe(4);
  });

  it('长文本按同一规则线性放大（256 拉丁字符 → 64）', () => {
    expect(estimateTokens('a'.repeat(256))).toBe(64);
  });
});
