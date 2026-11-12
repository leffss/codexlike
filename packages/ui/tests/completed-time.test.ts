import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatCompletedTime } from "../src/lib/completed-time";

beforeEach(() => vi.stubEnv("TZ", "America/New_York"));
afterEach(() => vi.unstubAllEnvs());

describe("完成时间的本地日历格式", () => {
  it.each([
    ["2026-12-01T05:00:00Z", "11-30 23:08"],
    ["2026-12-30T05:00:00Z", "11-30 23:08"],
    ["2026-11-30T05:00:00Z", "23:08"],
  ])("跨月或不同日按完整本地日期比较：%s", (now, label) => {
    expect(
      formatCompletedTime(new Date("2026-12-01T04:08:09Z"), new Date(now))
    ).toEqual({ label, title: "2026-11-30 23:08:09" });
  });
  it("本地跨年显示年份，而非只比较月日或 UTC 年份", () => {
    const completed = new Date("2027-01-01T04:08:09Z");
    expect(
      formatCompletedTime(completed, new Date("2027-01-01T05:00:00Z"))
    ).toEqual({ label: "2026-12-31 23:08", title: "2026-12-31 23:08:09" });
    expect(
      formatCompletedTime(completed, new Date("2028-01-01T04:59:00Z"))
    ).toEqual({ label: "2026-12-31 23:08", title: "2026-12-31 23:08:09" });
  });

  it("本地同日仅显示时分，完整 title 保留秒（UTC 已跨日）", () => {
    expect(
      formatCompletedTime(
        new Date("2026-11-12T04:08:09Z"),
        new Date("2026-11-12T04:59:00Z")
      )
    ).toEqual({ label: "23:08", title: "2026-11-11 23:08:09" });
  });
});
