import { useEffect, useState } from "react";

/** 只在消息列表调用一次；所有正文操作栏共享同一个本地日期参照。 */
export function useLocalDay(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => subscribeLocalDay(setNow), []);
  return now;
}

/** 以本地午夜而非固定 24 小时刷新；每个订阅最多持有一个 timeout。 */
export function subscribeLocalDay(onChange: (now: Date) => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  function refresh() {
    clearTimeout(timer);
    const now = new Date();
    onChange(now);
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    timer = setTimeout(refresh, midnight.getTime() - now.getTime());
  }
  function onVisible() {
    if (document.visibilityState === "visible") refresh();
  }
  refresh();
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
