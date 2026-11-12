import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeLocalDay } from "../src/lib/use-local-day";

beforeEach(() => {
  vi.stubEnv("TZ", "America/New_York");
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      visibilityState: "visible",
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("列表级本地日期订阅（时钟与浏览器事件边界）", () => {
  it.each(["focus", "visibilitychange"])(
    "%s 恢复时刷新日期并重排午夜，退订后不再响应",
    (event) => {
      vi.setSystemTime(new Date("2026-12-31T20:00:00Z"));
      let current = "";
      const stop = subscribeLocalDay((now) => {
        current = now.toISOString();
      });
      const target = event === "focus" ? window : document;
      try {
        vi.setSystemTime(new Date("2027-01-02T04:59:59Z"));
        target.dispatchEvent(new Event(event));
        expect(current).toBe("2027-01-02T04:59:59.000Z");
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(1000);
        expect(current).toBe("2027-01-02T05:00:00.000Z");
      } finally {
        stop();
      }
      vi.setSystemTime(new Date("2028-01-01T05:00:00Z"));
      target.dispatchEvent(new Event(event));
      expect(current).toBe("2027-01-02T05:00:00.000Z");
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each([
    ["跨月", "2026-12-01T04:59:59Z", "2026-12-01T05:00:00Z"],
    ["跨年", "2027-01-01T04:59:59Z", "2027-01-01T05:00:00Z"],
  ])(
    "%s时在本地午夜刷新且只保留一个 timeout，退订后停止",
    (_, start, midnight) => {
      vi.setSystemTime(new Date(start));
      const dates: string[] = [];
      const stop = subscribeLocalDay((now) => dates.push(now.toISOString()));
      try {
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(999);
        expect(dates.at(-1)).toBe(start.replace("Z", ".000Z"));
        vi.advanceTimersByTime(1);
        expect(dates.at(-1)).toBe(midnight.replace("Z", ".000Z"));
        expect(vi.getTimerCount()).toBe(1);
      } finally {
        stop();
      }
      expect(vi.getTimerCount()).toBe(0);
      const count = dates.length;
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      expect(dates).toHaveLength(count);
    }
  );
});
