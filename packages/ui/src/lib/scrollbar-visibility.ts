/**
 * 全局滚动条显隐（透明 thumb 方案，样式见 styles.css「全局滚动条」块）：
 * CSS 侧轨道恒占 8px、thumb 默认透明，本模块补齐三类「应显示」信号——
 * - 正在滚动：捕获阶段监听 scroll（scroll 不冒泡，捕获截获全部滚动
 *   容器），给滚动元素挂 scrollbar-live，停止 SCROLL_IDLE_MS 后移除；
 * - 鼠标移到滚动条位置：mousemove 以 rAF 节流走祖先链，命中元素右缘/
 *   底缘 SCROLLBAR_EDGE_PX 带内且该方向实际可滚动时同样挂
 *   scrollbar-live（thumb 透明时 ::-webkit-scrollbar-thumb:hover 只能
 *   命中 thumb 自身几何，这里补全整条轨道区域），移出即移除；
 * - 内容变化：消息自动刷新未必伴随滚动位移——上翻看历史时 scrollTop
 *   不动，窗口隐藏（最小化/托盘驻留/切走）期间增长的贴底滚动不派发
 *   scroll 事件，两类场景下滚动条永远无显色信号。ResizeObserver 观察
 *   滚动容器的内容根，scrollHeight 变化且纵向可滚动时同样挂
 *   scrollbar-live；隐藏期间的 ResizeObserver 回调会被渲染节流吞掉，
 *   visibilitychange 恢复可见时对全部已登记容器补一次高度比对。
 *   容器宽度同帧变化视为重排（右栏开合改变正文宽度、文本重排改
 *   scrollHeight），只重置快照不显色，避免滚动条随面板开关闪烁。
 *   流式自动刷新的面板可标记 data-scrollbar-content-signal="off" 豁免
 *   本信号（见 CONTENT_SIGNAL_OFF_SELECTOR）。
 * main.tsx 先安装后渲染（初始扫描扑空），滚动容器由 MutationObserver
 * 持续发现；SSR 测试只覆盖纯函数 scrollbarHit，装配层回归见
 * tests/scrollbar-visibility.test.ts（jsdom + 假 ResizeObserver）。
 */

/** 滚动停止后 thumb 保持显色的时长 */
export const SCROLL_IDLE_MS = 800;

/** 鼠标距元素右缘/底缘多少像素内视为「移到滚动条位置」 */
export const SCROLLBAR_EDGE_PX = 10;

/**
 * 滚动容器选择器：与 styles.css「滚动容器恒留滚动槽」同源——有稳定
 * 滚动槽的容器才有内容信号诉求；内联 overflow 而无类名的容器不登记。
 */
const SCROLL_CONTAINER_SELECTOR =
  ".overflow-auto, .overflow-y-auto, .overflow-scroll, .overflow-y-scroll";

/**
 * 内容变化信号豁免（2026-11-19 子代理详情轮）：流式自动刷新的检视面板
 * 标记 data-scrollbar-content-signal="off"——运行中正文/工具卡每秒改
 * scrollHeight，内容信号会让滚动条反复显色闪烁；滚动与悬停信号照常
 * （用户真实交互仍显色）。标记在滚动容器自身或其任意祖先上均生效
 * （面板内嵌滚动区随根豁免一并覆盖）。
 */
const CONTENT_SIGNAL_OFF_SELECTOR = "[data-scrollbar-content-signal='off']";

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
  /** 滚动/内容信号 → 到期定时器；到期时若 hover 仍命中则保留显色 */
  const scrollTimers = new Map<Element, ReturnType<typeof setTimeout>>();
  const hoverLive = new Set<Element>();

  function addLive(element: Element) {
    element.classList.add(LIVE_CLASS);
  }

  function removeLive(element: Element) {
    element.classList.remove(LIVE_CLASS);
  }

  /** 滚动与内容变化共用的显色信号：挂 live 并按 SCROLL_IDLE_MS 续期 */
  function touchLive(element: Element) {
    const previous = scrollTimers.get(element);
    if (previous !== undefined) clearTimeout(previous);
    addLive(element);
    scrollTimers.set(
      element,
      setTimeout(() => {
        scrollTimers.delete(element);
        if (!hoverLive.has(element)) removeLive(element);
      }, SCROLL_IDLE_MS)
    );
  }

  // —— 内容变化信号 ——
  /** 内容快照：scrollHeight 变化且 clientWidth 未变才显色——宽度变化
   *  即重排（右栏开合改正文宽度、文本重排改 scrollHeight），高度变化
   *  是重排副产品而非内容增长，只重置快照跳过显色 */
  interface ContentSnapshot {
    scrollHeight: number;
    clientWidth: number;
  }

  /** 滚动容器 → 上次内容快照（visibilitychange 恢复比对的基准） */
  const contentSnapshots = new Map<Element, ContentSnapshot>();
  /** 滚动容器 → 观察中的内容根（child 替换后重挂的依据） */
  const containerRoots = new Map<Element, Element>();
  /** 内容根 → 所属滚动容器（ResizeObserver 回调反查） */
  const contentOwners = new Map<Element, Element>();

  const contentObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const container = contentOwners.get(entry.target);
      if (container !== undefined) refreshContentSignal(container);
    }
  });

  /** scrollHeight 较快照变化、宽度未变且纵向可滚动 → 显色信号 */
  function refreshContentSignal(container: Element) {
    const next = (container as HTMLElement).scrollHeight;
    const width = (container as HTMLElement).clientWidth;
    const previous = contentSnapshots.get(container);
    contentSnapshots.set(container, { scrollHeight: next, clientWidth: width });
    if (previous === undefined) return;
    if (next === previous.scrollHeight) return;
    if (width !== previous.clientWidth) return;
    if (!isScrollable(container as HTMLElement, "y")) return;
    touchLive(container);
  }

  /** 登记滚动容器：观察其内容根（首个元素子节点）的尺寸变化；带豁免
   *  标记的容器（自身或祖先）不登记内容信号——滚动/悬停信号不受影响 */
  function trackContent(container: Element) {
    if (!container.matches(SCROLL_CONTAINER_SELECTOR)) return;
    if (container.closest(CONTENT_SIGNAL_OFF_SELECTOR) !== null) return;
    const root = container.firstElementChild ?? container;
    if (containerRoots.get(container) === root) return;
    const previousRoot = containerRoots.get(container);
    if (previousRoot !== undefined) {
      contentObserver.unobserve(previousRoot);
      contentOwners.delete(previousRoot);
    }
    containerRoots.set(container, root);
    contentOwners.set(root, container);
    contentSnapshots.set(container, {
      scrollHeight: (container as HTMLElement).scrollHeight,
      clientWidth: (container as HTMLElement).clientWidth,
    });
    contentObserver.observe(root);
  }

  /** 在元素自身及其子树内发现滚动容器并登记 */
  function discoverScrollContainers(scope: ParentNode) {
    if (scope instanceof Element) trackContent(scope);
    for (const element of scope.querySelectorAll(SCROLL_CONTAINER_SELECTOR)) {
      trackContent(element);
    }
  }

  /** 隐藏期 ResizeObserver 回调被节流吞掉：恢复可见时补一次高度比对 */
  function onVisibilityChange() {
    if (document.visibilityState !== "visible") return;
    for (const container of containerRoots.keys()) {
      refreshContentSignal(container);
    }
  }

  function onScroll(event: Event) {
    const target =
      event.target instanceof Element
        ? event.target
        : event.target instanceof Document
          ? document.documentElement
          : null;
    if (target === null) return;
    // 滚动目标必然是滚动容器：顺路补登（React 重挂载替换内容根后重挂观察）
    trackContent(target);
    touchLive(target);
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
        trackContent(element);
      }
    });
  }

  discoverScrollContainers(document);
  // main.tsx 先安装后渲染：初始扫描扑空，由 MutationObserver 持续发现
  //（面板/页面切换新增的滚动容器、任务重挂载替换的内容根）
  const domObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) discoverScrollContainers(node);
      }
    }
  });
  domObserver.observe(document, { childList: true, subtree: true });

  document.addEventListener("scroll", onScroll, {
    capture: true,
    passive: true,
  });
  document.addEventListener("mousemove", onMouseMove, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (frame !== null) cancelAnimationFrame(frame);
    contentObserver.disconnect();
    domObserver.disconnect();
    containerRoots.clear();
    contentOwners.clear();
    contentSnapshots.clear();
    for (const [element, timer] of scrollTimers) {
      clearTimeout(timer);
      removeLive(element);
    }
    for (const element of hoverLive) removeLive(element);
  };
}
