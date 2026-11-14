/**
 * 侧栏相对时间（ADR 0006 侧栏改版）：把任务的 updatedAt（ISO，「最近更新」口径
 * ——重命名/归档也会刷新）格式化为弱化的相对时间文案。
 * 分钟级粒度：调用方共享 60 秒时钟刷新，函数本身纯同步、无定时器。
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 超过 7 天不再相对化，直接显示本地日期 */
const RELATIVE_LIMIT_SECONDS = 7 * DAY;

export function formatRelativeTime(iso: string, now: number): string {
  const updated = Date.parse(iso);
  if (Number.isNaN(updated)) {
    return "";
  }
  // 未来时间（时钟偏差）按「刚刚」兜底，不显示负数
  const seconds = Math.max(0, Math.floor((now - updated) / 1000));

  if (seconds < MINUTE) {
    return "刚刚";
  }
  if (seconds < HOUR) {
    return `${Math.floor(seconds / MINUTE)} 分钟前`;
  }
  if (seconds < DAY) {
    return `${Math.floor(seconds / HOUR)} 小时前`;
  }
  if (seconds < RELATIVE_LIMIT_SECONDS) {
    return `${Math.floor(seconds / DAY)} 天前`;
  }
  return formatLocalDate(updated);
}

function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
