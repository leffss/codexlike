import { describe, expect, it } from "vitest";

import { thinkingSummary } from "../src/lib/thinking-summary";

/** 思考折叠卡摘要行（呈现层纯函数）：首个非空行、空白压平、码点截断 */
describe("thinkingSummary", () => {
  it("取首个非空行（跳过前导空行与缩进）", () => {
    expect(thinkingSummary("  \n\n  先读 vite 配置，\n再数入口  \n")).toBe(
      "先读 vite 配置，"
    );
  });

  it("行内空白（tab / 连续空格）压平为单空格", () => {
    expect(thinkingSummary("a\tb   c\td")).toBe("a b c d");
  });

  it("超长按码点截断加省略号；不超长原样返回", () => {
    expect(thinkingSummary("a".repeat(61))).toBe(`${"a".repeat(60)}…`);
    expect(thinkingSummary("a".repeat(60), 60)).toBe("a".repeat(60));
    expect(thinkingSummary("ABCDEFGHIJ", 5)).toBe("ABCDE…");
  });

  it("emoji 等代理对不在中间切断（按码点而非 UTF-16 单元截断）", () => {
    expect(thinkingSummary("🎉🎉🎉🎉", 2)).toBe("🎉🎉…");
  });

  it("空内容 / 全空白返回空串（调用方回退占位文案）", () => {
    expect(thinkingSummary("")).toBe("");
    expect(thinkingSummary(" \n\t \n")).toBe("");
  });
});
