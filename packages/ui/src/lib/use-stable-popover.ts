import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

/**
 * 稳定弹层定位（ADR 0024 呈现修订，原型经验沉淀）：
 * - 打开瞬间量一次实际几何：锁定弹层 width/height 与展开方向，
 *   trigger 宽度同步锁 px（名称/列表变化不再引起跳动）；
 * - 打开期间内容变化不重新测量、不换方向（模型名换、列表变长只在中部滚动）；
 * - resize / 捕获 scroll / trigger 的 ResizeObserver（外部布局挤压）触发重定位：
 *   方向与锁定尺寸保持，位置随 trigger 跟随并夹紧视口，极窄矮保留可操作下限；
 * - 关闭/卸载恢复 trigger 原 inline width，清理全部监听与 observer。
 * 实现边界：trigger 宽度走 imperative style（宿主组件不在 trigger 上声明
 * style.width，React 重渲不会回写），弹层定位走 React state，两路互不覆盖。
 */

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;
/** 视口极矮时的最低可用高度：头尾固定 + 至少一个模型行 */
const MIN_OPERABLE_HEIGHT = 120;
/** 视口极窄时的最低可用宽度 */
const MIN_OPERABLE_WIDTH = 160;

interface LockedGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface LockedAnchor {
  upwards: boolean;
  width: number;
  height: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, max));

export interface StablePopoverOptions {
  /**
   * 中部滚动区（[data-stable-popover-scroll]）的最小可视高度：
   * 首开锁定高度按「头尾固定高 + max(列表自然高, 此值)」计算——
   * 单模型 Profile 打开后切到长列表时，列表仍有足够可视区在内部滚动，
   * 弹层总高保持一次锁定不跳动（稳定与可用同时成立）。
   */
  minScrollHeight?: number;
}

export function useStablePopover(
  open: boolean,
  options: StablePopoverOptions = {}
): {
  triggerRef: RefObject<HTMLButtonElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  popoverStyle: CSSProperties | undefined;
} {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<LockedGeometry | null>(null);
  // 锁定期几何与 trigger 原 inline width 存 ref：重定位读最新值，
  // effect 依赖保持 [open]，不随内容/回调变动重跑。
  const lockedRef = useRef<LockedAnchor | null>(null);
  const priorTriggerWidthRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    function place(): void {
      const triggerEl = triggerRef.current;
      const popoverEl = popoverRef.current;
      if (!triggerEl || !popoverEl) return;
      const anchor = triggerEl.getBoundingClientRect();
      const availableAbove = Math.max(
        0,
        anchor.top - VIEWPORT_MARGIN - ANCHOR_GAP
      );
      const availableBelow = Math.max(
        0,
        window.innerHeight - anchor.bottom - VIEWPORT_MARGIN - ANCHOR_GAP
      );
      const maxWidth = Math.max(
        MIN_OPERABLE_WIDTH,
        window.innerWidth - VIEWPORT_MARGIN * 2
      );
      if (!lockedRef.current) {
        // 首次打开才测量：放得下优先上展开（与 ComposerSelect 同规则）
        const naturalHeight = popoverEl.offsetHeight;
        let lockedHeight = naturalHeight;
        if (options.minScrollHeight !== undefined) {
          const scroller = popoverEl.querySelector<HTMLElement>(
            "[data-stable-popover-scroll]"
          );
          if (scroller) {
            // 头尾固定高 = 自然总高 - 列表自然高；锁定高预留最小列表可视区。
            const chromeHeight = naturalHeight - scroller.offsetHeight;
            lockedHeight = Math.max(
              naturalHeight,
              chromeHeight + options.minScrollHeight
            );
          }
        }
        lockedRef.current = {
          upwards:
            availableAbove >= lockedHeight || availableAbove >= availableBelow,
          width: Math.min(popoverEl.offsetWidth, maxWidth),
          height: lockedHeight,
        };
      }
      const { upwards } = lockedRef.current;
      const width = Math.min(lockedRef.current.width, maxWidth);
      const height = clamp(
        lockedRef.current.height,
        Math.min(MIN_OPERABLE_HEIGHT, Math.max(availableAbove, availableBelow)),
        Math.max(availableAbove, availableBelow)
      );
      setGeometry({
        left: clamp(
          anchor.left,
          VIEWPORT_MARGIN,
          Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)
        ),
        top: clamp(
          upwards
            ? anchor.top - ANCHOR_GAP - height
            : anchor.bottom + ANCHOR_GAP,
          VIEWPORT_MARGIN,
          Math.max(
            VIEWPORT_MARGIN,
            window.innerHeight - height - VIEWPORT_MARGIN
          )
        ),
        width,
        height,
      });
    }

    // 打开：锁 trigger 宽度（imperative，关闭时恢复），量一次并锁定几何
    priorTriggerWidthRef.current = trigger.style.width;
    trigger.style.width = `${trigger.getBoundingClientRect().width}px`;
    place();

    // resize / 布局挤压把弹层夹紧变矮后，滚动区可视高度变小——弹层内
    // 聚焦的选项可能落到可视区外，重定位后滚回（nearest 已可见则无操作）。
    // 页面 scroll 触发的重定位不调它：不打断用户滚轮浏览列表。
    function keepFocusVisible(): void {
      const popoverEl = popoverRef.current;
      const active = document.activeElement;
      if (
        popoverEl &&
        active instanceof HTMLElement &&
        popoverEl.contains(active)
      ) {
        active.scrollIntoView({ block: "nearest" });
      }
    }

    function reposition(): void {
      place();
    }

    function repositionKeepingFocus(): void {
      place();
      // 双 rAF：第一帧等 React 提交夹紧后的 geometry state，第二帧布局稳定
      // 再滚——单 rAF 时容器高度可能还是旧值，nearest 误判已可见而不滚。
      requestAnimationFrame(() => requestAnimationFrame(keepFocusVisible));
    }

    // RO 只观察 trigger（宽度已锁，名称变化不触发；外部布局挤压才触发），
    // 不观察弹层内容——内容变化不重新 place。
    const observer = new ResizeObserver(repositionKeepingFocus);
    observer.observe(trigger);
    window.addEventListener("resize", repositionKeepingFocus);
    window.addEventListener("scroll", reposition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      trigger.style.width = priorTriggerWidthRef.current ?? "";
      priorTriggerWidthRef.current = null;
      lockedRef.current = null;
      setGeometry(null);
    };
    // 故意仅依赖 open：打开期间内容/名称变化不重新 place（稳定性的核心），
    // browsedProfileId 等选项态变化不得进入依赖（原型踩坑：随选重放抖动）；
    // options.minScrollHeight 由调用方传常量且只在首开锁定分支读取——
    // options 是每次渲染的新字面量，进依赖会让 effect 随渲染重跑、破坏锁定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return {
    triggerRef,
    popoverRef,
    popoverStyle: geometry
      ? {
          position: "fixed",
          left: geometry.left,
          top: geometry.top,
          width: geometry.width,
          height: geometry.height,
        }
      : undefined,
  };
}
