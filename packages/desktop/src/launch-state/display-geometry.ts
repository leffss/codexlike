import type { LaunchBounds } from "./launch-state-store";

/**
 * 显示器校验纯函数（spec「显示器校验」）：恢复 bounds 与所有现存显示器
 * 可见工作区均无交集才判失效；失效则保留尺寸、位置改主屏居中。
 * 部分越界与负坐标不修正（交给系统）。尺寸小于窗口底线时收紧。
 * 不依赖 electron——显示器数据（screen.getAllDisplays 等）由主进程传入，
 * 单测直接构造几何输入。
 */

/** 屏幕矩形（显示器可见工作区 / 主屏工作区），结构与 Electron Rectangle 兼容 */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 窗口底线（票04，与主进程 BrowserWindow minWidth/minHeight 同源）：
 * 取值依据见票 04 Comments——标题栏左右区不可压缩内容容纳度 + 中列
 * （容器 712px）composer 工具栏一行不换行 + 消息流最小可读高度。
 * 恢复路径显式夹紧：存储的越界恢复值（旧版本小窗现场）不依赖
 * Electron 运行时行为，建窗前即收紧到底线。
 */
export const MIN_WINDOW_SIZE = { width: 1000, height: 600 };

/** 两矩形是否有面积重叠（贴边相切不算——窗口完全在工作区之外） */
function overlaps(a: ScreenRect, b: ScreenRect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * 解析恢复用的窗口 bounds：先收紧尺寸（窗口底线，票04），再判交集。
 * 无交集（含显示器列表为空的兜底）时保留收紧后的尺寸、位置改主屏工作区居中。
 */
export function resolveLaunchBounds(options: {
  saved: LaunchBounds;
  /** 所有现存显示器的可见工作区 */
  workAreas: ScreenRect[];
  /** 主屏工作区（居中回退目标） */
  primaryWorkArea: ScreenRect;
  /** 窗口底线尺寸，省略则用 MIN_WINDOW_SIZE */
  minSize?: { width: number; height: number };
}): LaunchBounds {
  const { saved, workAreas, primaryWorkArea } = options;
  const minSize = options.minSize ?? MIN_WINDOW_SIZE;
  const bounds: LaunchBounds = {
    x: saved.x,
    y: saved.y,
    width: Math.max(saved.width, minSize.width),
    height: Math.max(saved.height, minSize.height),
  };
  if (workAreas.some((area) => overlaps(bounds, area))) {
    return bounds;
  }
  return {
    x:
      primaryWorkArea.x +
      Math.floor((primaryWorkArea.width - bounds.width) / 2),
    y:
      primaryWorkArea.y +
      Math.floor((primaryWorkArea.height - bounds.height) / 2),
    width: bounds.width,
    height: bounds.height,
  };
}
