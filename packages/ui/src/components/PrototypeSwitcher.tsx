/**
 * 【原型设施，验证后删除】UI 原型变体切换条（prototype 技能子形态 A 共享件，
 * 消费方 dev/card-shell.ts）：fixed 底部居中悬浮 pill——左右箭头循环切变体 +
 * 当前变体标签；←/→ 键盘同步（输入控件聚焦时不拦截）；生产构建不渲染
 * （import.meta.env.PROD 直接 null，流浪的合并进不了用户端）。
 * 配套 useSearchParamVariant：变体存 ?variant= search param（replaceState，
 * 刷新与分享稳定），空串 = 无变体 = 走默认渲染路径。
 */
import { useEffect, useState } from "react";

export interface PrototypeVariant {
  key: string;
  name: string;
}

/** 变体状态：读初值 + 写 ?variant=（replaceState）+ popstate 同步（前进后退）。
 * keys 传模块级常量（引用稳定，作 effect 依赖） */
export function useSearchParamVariant(
  keys: string[]
): [string, (key: string) => void] {
  const [current, setCurrent] = useState(() => {
    const initial = new URLSearchParams(window.location.search).get("variant");
    return initial !== null && keys.includes(initial) ? initial : "";
  });
  useEffect(() => {
    const onPop = () => {
      const value = new URLSearchParams(window.location.search).get("variant");
      setCurrent(value !== null && keys.includes(value) ? value : "");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [keys]);
  const set = (key: string) => {
    const url = new URL(window.location.href);
    if (key === "") url.searchParams.delete("variant");
    else url.searchParams.set("variant", key);
    window.history.replaceState(null, "", url);
    setCurrent(key);
  };
  return [current, set];
}

export function PrototypeSwitcher(props: {
  variants: PrototypeVariant[];
  current: string;
  onChange: (key: string) => void;
}) {
  const { variants, current, onChange } = props;
  const index = Math.max(
    0,
    variants.findIndex((item) => item.key === current)
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      // 取模保证在界内；noUncheckedIndexedAccess 下断言非空
      const next =
        variants[(index + delta + variants.length) % variants.length]!;
      onChange(next.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variants, index, onChange]);
  // hook 之后短路：hooks 顺序恒定，生产构建直接不渲染
  if (import.meta.env.PROD) return null;
  const active = variants[index];
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-accent/60 bg-surface py-1 pl-1.5 pr-2 shadow-lg">
      <button
        type="button"
        aria-label="上一个变体"
        onClick={() =>
          onChange(
            variants[(index - 1 + variants.length) % variants.length]!.key
          )
        }
        className="rounded-full px-2 py-0.5 text-sm text-fg hover:bg-hover"
      >
        ←
      </button>
      <span className="min-w-40 text-center text-xs font-medium text-fg">
        原型 {active?.key}（{active?.name}）
      </span>
      <button
        type="button"
        aria-label="下一个变体"
        onClick={() => onChange(variants[(index + 1) % variants.length]!.key)}
        className="rounded-full px-2 py-0.5 text-sm text-fg hover:bg-hover"
      >
        →
      </button>
    </div>
  );
}
