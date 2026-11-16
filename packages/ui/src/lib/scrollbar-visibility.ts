/**
 * 全局滚动条显隐（透明 thumb 方案，样式见 styles.css「全局滚动条」块）：
 * CSS 侧轨道恒占 8px、thumb 默认透明，本模块补齐两类「应显示」信号——
 * - 正在滚动：捕获阶段监听 scroll（scroll 不冒泡，捕获截获全部滚动
 *   容器），给滚动元素挂 scrollbar-live，停止 SCROLL_IDLE_MS 后移除；
 * - 鼠标移到滚动条位置：mousemove 以 rAF 节流走祖先链，命中元素右缘/
 *   底缘 SCROLLBAR_EDGE_PX 带内且该方向实际可滚动时同样挂
 *   scrollbar-live（thumb 透明时 ::-webkit-scrollbar-thumb:hover 只能
 *   命中 thumb 自身几何，这里补全整条轨道区域），移出即移除。
 * main.tsx 安装一次；SSR 测试只覆盖纯函数 scrollbarHit。
 */

/** 滚动停止后 thumb 保持显色的时长 */
export const SCROLL_IDLE_MS = 800;

/** 鼠标距元素右缘/底缘多少像素内视为「移到滚动条位置」 */
export const SCROLLBAR_EDGE_PX = 10;

/** 滚动条命中判定用的矩形（DOMRect 的最小面） */
export interface EdgeBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 点 (x, y) 是否落在盒右缘竖直滚动条带（vertical）或底缘水平滚动条带
 * （horizontal）内；两带重叠的右下角按 vertical 优先（拖竖直条更常用）。
 */
export function scrollbarHit(
  box: EdgeBox,
  x: number,
  y: number,
  edge: number = SCROLLBAR_EDGE_PX
): "vertical" | "horizontal" | null {
  if (
    x >= box.right - edge &&
    x <= box.right &&
    y >= box.top &&
    y <= box.bottom
  ) {
    return "vertical";
  }
  if (
    y >= box.bottom - edge &&
    y <= box.bottom &&
    x >= box.left &&
    x <= box.right
  ) {
    return "horizontal";
  }
  return null;
}

/** 元素在指定方向是否实际可滚动（overflow 允许且内容超出客户端） */
function isScrollable(element: HTMLElement, axis: "x" | "y"): boolean {
  const style = window.getComputedStyle(element);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (overflow !== "auto" && overflow !== "scroll" && overflow !== "overlay") {
    return false;
  }
  return axis === "y"
    ? element.scrollHeight > element.clientHeight
    : element.scrollWidth > element.clientWidth;
}

/** 安装全局监听（main.tsx 调用一次）；返回卸载函数（应用内不使用，保对称） */
export function installScrollbarVisibility(): () => void {
  const LIVE_CLASS = "scrollbar-live";
  /** scroll 信号 → 到期定时器；到期时若 hover 仍命中则保留显色 */
  const scrollTimers = new Map<Element, ReturnType<typeof setTimeout>>();
  const hoverLive = new Set<Element>();

  function addLive(element: Element) {
    element.classList.add(LIVE_CLASS);
  }

  function removeLive(element: Element) {
    element.classList.remove(LIVE_CLASS);
  }

  function onScroll(event: Event) {
    const target =
      event.target instanceof Element
        ? event.target
        : event.target instanceof Document
          ? document.documentElement
          : null;
    if (target === null) return;
    const previous = scrollTimers.get(target);
    if (previous !== undefined) clearTimeout(previous);
    addLive(target);
    scrollTimers.set(
      target,
      setTimeout(() => {
        scrollTimers.delete(target);
        if (!hoverLive.has(target)) removeLive(target);
      }, SCROLL_IDLE_MS)
    );
  }

  let frame: number | null = null;
  let pending: MouseEvent | null = null;
  function onMouseMove(event: MouseEvent) {
    pending = event;
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const mouse = pending;
      pending = null;
      if (mouse === null) return;
      const hits = new Set<Element>();
      let el: Element | null =
        mouse.target instanceof Element ? mouse.target : null;
      while (el !== null) {
        if (el instanceof HTMLElement) {
          const hit = scrollbarHit(
            el.getBoundingClientRect(),
            mouse.clientX,
            mouse.clientY
          );
          if (
            hit !== null &&
            isScrollable(el, hit === "vertical" ? "y" : "x")
          ) {
            hits.add(el);
          }
        }
        el = el.parentElement;
      }
      for (const previous of hoverLive) {
        if (!hits.has(previous)) {
          removeLive(previous);
          hoverLive.delete(previous);
        }
      }
      for (const element of hits) {
        addLive(element);
        hoverLive.add(element);
      }
    });
  }

  document.addEventListener("scroll", onScroll, {
    capture: true,
    passive: true,
  });
  document.addEventListener("mousemove", onMouseMove, { passive: true });
  return () => {
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("mousemove", onMouseMove);
    if (frame !== null) cancelAnimationFrame(frame);
    for (const [element, timer] of scrollTimers) {
      clearTimeout(timer);
      removeLive(element);
    }
    for (const element of hoverLive) removeLive(element);
  };
}
