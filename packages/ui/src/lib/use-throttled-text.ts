import { useEffect, useRef, useState } from "react";

/** 只节流显示，不延迟 reducer/事件；持续输入每 75ms 交付最新值，而非 debounce。 */
export function useThrottledText(content: string, active: boolean): string {
  const [displayed, setDisplayed] = useState(content);
  const latest = useRef(content);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latest.current = content;
    if (!active) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      setDisplayed(content);
    } else if (content !== displayed && timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        setDisplayed(latest.current);
      }, 75);
    }
  }, [content, active, displayed]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  // 终态当帧即用权威全文，不能等待 effect 或尾随计时器。
  return active ? displayed : content;
}
