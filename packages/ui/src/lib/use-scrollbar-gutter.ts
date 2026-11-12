import { useLayoutEffect, type RefObject } from "react";

/** 同步真实滚动槽宽度；覆盖原生、overlay 滚动条和系统缩放，不假定平台像素值。 */
export function useScrollbarGutter(
  ref: RefObject<HTMLElement | null>,
  onChange?: (width: number) => void
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !onChange) return;
    let previous: number | undefined;
    const measure = () => {
      const style = getComputedStyle(element);
      const border =
        parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      const width = Math.max(
        0,
        element.offsetWidth - element.clientWidth - border
      );
      if (width !== previous) {
        previous = width;
        onChange(width);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, onChange]);
}
