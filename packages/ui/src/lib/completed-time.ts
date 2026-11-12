const pad = (value: number) => String(value).padStart(2, "0");

/** 完成时刻使用本地日历显示；ISO 身份由调用方保留，不依赖相对时间规则。 */
export function formatCompletedTime(completed: Date, now: Date) {
  const date = `${completed.getFullYear()}-${pad(completed.getMonth() + 1)}-${pad(completed.getDate())}`;
  const time = `${pad(completed.getHours())}:${pad(completed.getMinutes())}`;
  const sameDay =
    completed.getFullYear() === now.getFullYear() &&
    completed.getMonth() === now.getMonth() &&
    completed.getDate() === now.getDate();
  return {
    label: sameDay
      ? time
      : `${completed.getFullYear() === now.getFullYear() ? date.slice(5) : date} ${time}`,
    title: `${date} ${time}:${pad(completed.getSeconds())}`,
  };
}
