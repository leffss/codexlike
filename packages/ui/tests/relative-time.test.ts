import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from '../src/lib/relative-time';

/**
 * 侧栏相对时间（ADR 0006 侧栏改版）：口径为 SessionRecord.updatedAt「最近更新」。
 * 分钟级粒度（侧栏共享 60s 时钟刷新），超过 7 天回落为日期。
 */
// 本地时区正午构造（整天数偏移在任何时区都不跨日，测试稳定）
const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime();

function iso(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

describe('formatRelativeTime', () => {
  it('1 分钟内（含未来时钟偏移）显示「刚刚」', () => {
    expect(formatRelativeTime(iso(0), NOW)).toBe('刚刚');
    expect(formatRelativeTime(iso(59), NOW)).toBe('刚刚');
    // 未来 10 秒（时钟偏差兜底）：不显示负数
    expect(formatRelativeTime(iso(-10), NOW)).toBe('刚刚');
  });

  it('1–59 分钟显示「N 分钟前」', () => {
    expect(formatRelativeTime(iso(60), NOW)).toBe('1 分钟前');
    expect(formatRelativeTime(iso(61), NOW)).toBe('1 分钟前');
    expect(formatRelativeTime(iso(3599), NOW)).toBe('59 分钟前');
  });

  it('1–23 小时显示「N 小时前」', () => {
    expect(formatRelativeTime(iso(3600), NOW)).toBe('1 小时前');
    expect(formatRelativeTime(iso(3600 * 23 + 59 * 60), NOW)).toBe('23 小时前');
  });

  it('1–7 天显示「N 天前」', () => {
    expect(formatRelativeTime(iso(24 * 3600), NOW)).toBe('1 天前');
    expect(formatRelativeTime(iso(3 * 24 * 3600), NOW)).toBe('3 天前');
    // 7 天为排他上限：6.99 天向下取整为 6
    expect(formatRelativeTime(iso(7 * 24 * 3600 - 1), NOW)).toBe('6 天前');
  });

  it('超过 7 天回落为 YYYY-MM-DD 日期', () => {
    expect(formatRelativeTime(iso(7 * 24 * 3600), NOW)).toBe('2026-11-04');
    expect(formatRelativeTime(iso(30 * 24 * 3600), NOW)).toBe('2026-10-12');
  });

  it('非法 ISO 字符串返回空串（行内不渲染时间列）', () => {
    expect(formatRelativeTime('', NOW)).toBe('');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });
});
