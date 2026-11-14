import { describe, expect, it } from "vitest";

import {
  MIN_WINDOW_SIZE,
  resolveLaunchBounds,
} from "../../src/launch-state/display-geometry";

/**
 * 显示器校验纯函数（spec「显示器校验」）：
 * - 恢复 bounds 与所有现存显示器可见工作区均无交集才判失效；
 *   失效则保留尺寸、位置改主屏居中。
 * - 部分越界与负坐标不修正（交给系统），贴边相切视为无交集。
 * - 尺寸小于最小可用值时收紧。
 * 纯函数不依赖 electron，显示器数据由调用方（主进程）传入。
 */
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const SECONDARY = { x: 1920, y: 0, width: 1280, height: 1040 };
const MIN = { width: 400, height: 300 };

function resolve(
  saved: Parameters<typeof resolveLaunchBounds>[0]["saved"],
  {
    workAreas = [PRIMARY],
    primaryWorkArea = PRIMARY,
  }: { workAreas?: (typeof PRIMARY)[]; primaryWorkArea?: typeof PRIMARY } = {}
) {
  return resolveLaunchBounds({
    saved,
    workAreas,
    primaryWorkArea,
    minSize: MIN,
  });
}

describe("resolveLaunchBounds 无交集判定与居中回退", () => {
  it("主屏内 bounds 原样恢复", () => {
    const saved = { x: 120, y: 80, width: 900, height: 640 };
    expect(resolve(saved)).toEqual(saved);
  });

  it("负坐标与部分越界照常恢复，不判失效", () => {
    const saved = { x: -500, y: -100, width: 900, height: 640 };
    expect(resolve(saved)).toEqual(saved);
  });

  it("完全在所有显示器之外：尺寸保留、位置改主屏居中", () => {
    const centered = resolve({ x: 20000, y: 20000, width: 900, height: 640 });
    expect(centered).toEqual({
      x: Math.floor((PRIMARY.width - 900) / 2),
      y: Math.floor((PRIMARY.height - 640) / 2),
      width: 900,
      height: 640,
    });
  });

  it("贴边相切（与工作区零面积重叠）视为无交集，主屏居中", () => {
    // x+width 恰好等于主屏左缘：覆盖 [1920, 2820)，与 [0, 1920) 无面积重叠
    const centered = resolve({ x: 1920, y: 100, width: 900, height: 640 });
    expect(centered.x).toBe(Math.floor((PRIMARY.width - 900) / 2));
  });

  it("与任一现存显示器有交集即有效：副屏 bounds 原样恢复", () => {
    const saved = { x: 2200, y: 100, width: 900, height: 640 };
    expect(resolve(saved, { workAreas: [PRIMARY, SECONDARY] })).toEqual(saved);
  });

  it("副屏被拔掉后：原副屏 bounds 无交集 → 主屏居中且尺寸保留", () => {
    const centered = resolve(
      { x: 2200, y: 100, width: 900, height: 640 },
      { workAreas: [PRIMARY] }
    );
    expect(centered).toEqual({
      x: Math.floor((PRIMARY.width - 900) / 2),
      y: Math.floor((PRIMARY.height - 640) / 2),
      width: 900,
      height: 640,
    });
  });

  it("无任何显示器数据（空集）：兜底主屏居中", () => {
    const centered = resolve(
      { x: 100, y: 100, width: 900, height: 640 },
      { workAreas: [] }
    );
    expect(centered.x).toBe(Math.floor((PRIMARY.width - 900) / 2));
  });

  it("主屏带偏移（任务栏/缩放）时居中基于主屏工作区原点", () => {
    const offsetPrimary = { x: 10, y: 20, width: 1900, height: 1020 };
    const centered = resolve(
      { x: 30000, y: 100, width: 900, height: 640 },
      { workAreas: [offsetPrimary], primaryWorkArea: offsetPrimary }
    );
    expect(centered).toEqual({
      x: 10 + Math.floor((1900 - 900) / 2),
      y: 20 + Math.floor((1020 - 640) / 2),
      width: 900,
      height: 640,
    });
  });
});

describe("resolveLaunchBounds 尺寸收紧", () => {
  it("尺寸小于最小可用值时收紧到最小可用（位置不动）", () => {
    expect(resolve({ x: 100, y: 50, width: 10, height: 20 })).toEqual({
      x: 100,
      y: 50,
      width: MIN.width,
      height: MIN.height,
    });
  });

  it("收紧后仍无交集则进一步主屏居中（尺寸已收紧）", () => {
    const centered = resolve({ x: 20000, y: 20000, width: 10, height: 20 });
    expect(centered).toEqual({
      x: Math.floor((PRIMARY.width - MIN.width) / 2),
      y: Math.floor((PRIMARY.height - MIN.height) / 2),
      width: MIN.width,
      height: MIN.height,
    });
  });
});

describe("resolveLaunchBounds minSize 缺省", () => {
  it("省略 minSize 时按 MIN_WINDOW_SIZE 收紧", () => {
    const clamped = resolveLaunchBounds({
      saved: { x: 100, y: 50, width: 10, height: 20 },
      workAreas: [PRIMARY],
      primaryWorkArea: PRIMARY,
    });
    expect(clamped).toEqual({
      x: 100,
      y: 50,
      width: MIN_WINDOW_SIZE.width,
      height: MIN_WINDOW_SIZE.height,
    });
  });

  // 票04：MIN_WINDOW_SIZE 与主进程 BrowserWindow minWidth/minHeight 同源，
  // 存储的越界恢复值（旧版本保存的小窗现场）恢复时被夹紧到窗口底线，
  // 期望值用独立字面量（1000×600）而非常量引用，防止常量改值后断言自我失效。
  it("存储越界小尺寸恢复值夹紧到窗口底线 1000×600（位置保留）", () => {
    const clamped = resolveLaunchBounds({
      saved: { x: 100, y: 80, width: 400, height: 200 },
      workAreas: [PRIMARY],
      primaryWorkArea: PRIMARY,
    });
    expect(clamped).toEqual({ x: 100, y: 80, width: 1000, height: 600 });
  });

  it("BrowserWindow 窗口底线与 MIN_WINDOW_SIZE 同值（票04 同源约束）", () => {
    expect(MIN_WINDOW_SIZE).toEqual({ width: 1000, height: 600 });
  });
});
