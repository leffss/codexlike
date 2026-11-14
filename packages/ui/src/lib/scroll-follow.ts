/**
 * 滚动跟随纯函数（票 03，GLOSSARY「跟随」，ADR 0011 滚动跟随边界）：
 * 消息流把「是否跟随最新内容」建成显式 FOLLOWING/DETACHED 状态而非
 * 每帧瞬时几何判断；本模块只做无 DOM/React 依赖的裁决计算，
 * DOM 事件接线在 MessageStream 组件。设计参考 ZCode 调研报告第 1 节
 * （借鉴思想，不复制代码）。
 */

/** 距底 ≤48px 视为贴底：容差覆盖亚像素滚动与末行 padding */
export const BOTTOM_SNAP_EPSILON_PX = 48;

/** 跟随状态机：following=贴近底部自动追踪最新；detached=用户翻阅历史 */
export type FollowMode = "following" | "detached";

/** 滚动事件成因：只有真实用户输入（user-input）允许改变跟随态 */
export type ScrollCause = "user-input" | "scripted" | "reflow";

/** 输入意图朝向：up=翻向更早内容（远离底部），down=翻向最新，neutral=无纵向意图 */
export type VerticalIntent = "up" | "down" | "neutral";

/** 滚动容器几何快照 */
export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceFromBottom(geometry: ScrollGeometry): number {
  return geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop;
}

export function isBottomWithinEpsilon(
  geometry: ScrollGeometry,
  epsilon: number = BOTTOM_SNAP_EPSILON_PX
): boolean {
  return distanceFromBottom(geometry) <= epsilon;
}

/** 滚轮：deltaY<0 上翻（更早内容），>0 下翻，0（如横向滚轮）无纵向意图 */
export function wheelVerticalIntent(deltaY: number): VerticalIntent {
  if (deltaY < 0) return "up";
  if (deltaY > 0) return "down";
  return "neutral";
}

/**
 * 触摸：手指下拖（纵坐标增大）把更早内容拖入视口（远离底部），
 * 手指上拖翻向最新。
 */
export function touchVerticalIntent(
  fromClientY: number,
  toClientY: number
): VerticalIntent {
  if (toClientY > fromClientY) return "up";
  if (toClientY < fromClientY) return "down";
  return "neutral";
}

/**
 * 方向键/翻页键：ArrowUp/PageUp/Home/Shift+Space 朝上，
 * ArrowDown/PageDown/End/Space 朝下；输入控件（textarea/input/可编辑）内
 * 的按键属于文本编辑，不算滚动意图。
 */
export function keyVerticalIntent(input: {
  key: string;
  shiftKey?: boolean;
  editable?: boolean;
}): VerticalIntent {
  if (input.editable === true) return "neutral";
  if (input.key === "ArrowUp" || input.key === "PageUp" || input.key === "Home")
    return "up";
  if (
    input.key === "ArrowDown" ||
    input.key === "PageDown" ||
    input.key === "End"
  )
    return "down";
  if (input.key === " ") return input.shiftKey === true ? "up" : "down";
  return "neutral";
}

/**
 * scroll 事件到达后的跟随态裁决。只有真实用户输入（滚轮/触摸/方向键/
 * 滚动条拖动）能改变跟随态；程序化贴底（scripted）与布局测高（reflow）
 * 产生的滚动只更新几何账目，一律返回原状态（spec 用户故事 7）。
 *
 * 用户输入的裁决优先级：
 * - 向上意图 → 立即脱离（scroll 事件滞后一帧：内容 commit 把落点拽回底部
 *   时，最近登记的向上意图同帧让位，上翻不被吞掉——spec 用户故事 8）；
 * - 向下意图 → 落点贴底恢复跟随，否则保持现状；
 * - 无登记意图/无纵向意图（滚动条拖动等方向未知来源）→ 按落点裁决：
 *   贴底跟随、离底脱离。
 */
export function followModeAfterScroll(input: {
  mode: FollowMode;
  cause: ScrollCause;
  /** 最近登记的用户输入纵向意图；无登记传 undefined */
  intent?: VerticalIntent;
  geometry: ScrollGeometry;
}): FollowMode {
  const { mode, cause, intent, geometry } = input;
  if (cause !== "user-input") return mode;
  if (intent === "up") return "detached";
  const nearBottom = isBottomWithinEpsilon(geometry);
  if (intent === "down") return nearBottom ? "following" : mode;
  return nearBottom ? "following" : "detached";
}

/**
 * 内容变化（流式增量、工具卡更新、折叠变化）后的锚定动作：
 * 跟随中贴底，脱离时保持阅读位置（绝不拉回）。
 */
export function anchorDecisionAfterContentChange(
  mode: FollowMode
): "snap" | "hold" {
  return mode === "following" ? "snap" : "hold";
}

/** 「回到最新」入口可见性 = 脱离跟随且有消息 */
export function backToLatestVisible(
  mode: FollowMode,
  segmentCount: number
): boolean {
  return mode === "detached" && segmentCount > 0;
}

/** 阅读位置记忆（按任务保存）：像素位置 + 离开时是否贴底跟随 */
export interface SavedReadingSpot {
  scrollTop: number;
  atBottom?: boolean;
}

/** 离开任务/组件卸载前记录阅读位置：跟随态按贴底记忆 */
export function readingSpotOnLeave(input: {
  mode: FollowMode;
  geometry: ScrollGeometry;
}): SavedReadingSpot {
  return {
    scrollTop: input.geometry.scrollTop,
    atBottom: input.mode === "following",
  };
}

function clampedScrollTop(value: number, geometry: ScrollGeometry): number {
  const max = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
  return Math.min(Math.max(value, 0), max);
}

/**
 * 阅读位置恢复计算（spec 用户故事 10-12）：
 * - 无记忆（新任务）→ 定位当前最新并跟随；
 * - 贴底记忆 → 恢复到当前最新并跟随（旧的像素位置作废）；
 * - 非贴底记忆 → 恢复像素位置并按当前高度夹紧；夹紧后恰好贴底
 *   （含旧数据无贴底标记的场景）按贴底恢复跟随。
 */
export function restoreReadingPlan(input: {
  saved: SavedReadingSpot | null;
  geometry: ScrollGeometry;
}): { mode: FollowMode; scrollTop: number } {
  const { saved, geometry } = input;
  const latest = clampedScrollTop(Number.POSITIVE_INFINITY, geometry);
  if (saved === null || saved.atBottom === true)
    return { mode: "following", scrollTop: latest };
  const scrollTop = clampedScrollTop(saved.scrollTop, geometry);
  const mode: FollowMode = isBottomWithinEpsilon({
    ...geometry,
    scrollTop,
  })
    ? "following"
    : "detached";
  return { mode, scrollTop };
}
