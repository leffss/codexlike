import { useEffect, useState } from "react";

/**
 * 运行中耗时的实时跳动源（spec 用户故事 26「实时跳动 + 最终定格」）：
 * active 期间每秒刷新当前时刻，非 active 停止计时（返回值不再更新）。
 * 调用方只在 active 分支消费 now；定格值由 endedAt 打点数据计算，
 * 不依赖本 hook。激活当帧先对齐一次，避免用上一次卸载时的旧时刻。
 */
export function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  return now;
}
