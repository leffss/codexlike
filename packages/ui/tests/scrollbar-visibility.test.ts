import { describe, expect, it } from "vitest";

import {
  scrollbarHit,
  SCROLLBAR_EDGE_PX,
} from "../src/lib/scrollbar-visibility";

/** 300×200 的盒，右缘带 [290,300]、底缘带 [190,200]（edge 默认 10） */
const BOX = { left: 0, top: 0, right: 300, bottom: 200 };

describe("scrollbarHit（滚动条边缘命中纯函数）", () => {
  it("右缘带内命中 vertical", () => {
    expect(scrollbarHit(BOX, 295, 100)).toBe("vertical");
    expect(scrollbarHit(BOX, 300, 0)).toBe("vertical");
    expect(scrollbarHit(BOX, 290, 200)).toBe("vertical");
  });

  it("底缘带内命中 horizontal（右下角 vertical 优先）", () => {
    expect(scrollbarHit(BOX, 150, 195)).toBe("horizontal");
    expect(scrollbarHit(BOX, 0, 200)).toBe("horizontal");
    // 右下角两带重叠：按拖竖直条更常用优先 vertical
    expect(scrollbarHit(BOX, 295, 195)).toBe("vertical");
  });

  it("带外 / 盒外返回 null", () => {
    expect(scrollbarHit(BOX, 289, 100)).toBe(null);
    expect(scrollbarHit(BOX, 150, 189)).toBe(null);
    expect(scrollbarHit(BOX, 150, 100)).toBe(null);
    expect(scrollbarHit(BOX, -5, 100)).toBe(null);
    expect(scrollbarHit(BOX, 150, 250)).toBe(null);
  });

  it("自定义 edge 收窄/放宽命中带", () => {
    expect(scrollbarHit(BOX, 295, 100, 4)).toBe(null);
    expect(scrollbarHit(BOX, 298, 100, 4)).toBe("vertical");
    expect(scrollbarHit(BOX, 280, 100, 20)).toBe("vertical");
  });

  it("默认 edge 为 SCROLLBAR_EDGE_PX", () => {
    expect(SCROLLBAR_EDGE_PX).toBe(10);
    expect(scrollbarHit(BOX, 300 - SCROLLBAR_EDGE_PX, 50)).toBe("vertical");
    expect(scrollbarHit(BOX, 300 - SCROLLBAR_EDGE_PX - 1, 50)).toBe(null);
  });
});
