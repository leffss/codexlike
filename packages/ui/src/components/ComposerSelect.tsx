import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface ComposerOption<Value extends string> {
  value: Value;
  label: string;
  title: string;
}

/** 受控单选：DOM 焦点留在触发器，活动项通过 aria-activedescendant 暴露。 */
export function ComposerSelect<Value extends string>(props: {
  testId: string;
  label: string;
  value: Value;
  options: readonly ComposerOption<Value>[];
  disabled?: boolean;
  onSelect: (value: Value) => void;
  renderIcon?: (value: Value) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.value)
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 280 });
  const expanded = open && !props.disabled;
  const selected = props.options[selectedIndex];

  useLayoutEffect(() => {
    if (!expanded) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    function place() {
      if (!trigger || !menu) return;
      const anchor = trigger.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const above = Math.max(0, anchor.top - margin - gap);
      const below = Math.max(
        0,
        window.innerHeight - anchor.bottom - margin - gap
      );
      const desiredHeight = Math.min(menu.scrollHeight, 280);
      // 放得下时优先上展开；上下均不足时使用较宽裕的一侧并滚动。
      const upwards = above >= desiredHeight || above >= below;
      const maxHeight = Math.min(280, upwards ? above : below);
      const height = Math.min(desiredHeight, maxHeight);
      setPosition({
        left: Math.max(
          margin,
          Math.min(anchor.left, window.innerWidth - menu.offsetWidth - margin)
        ),
        top: Math.max(
          margin,
          upwards ? anchor.top - gap - height : anchor.bottom + gap
        ),
        maxHeight,
      });
    }
    place();
    function outside(event: Event) {
      if (
        event.target instanceof Node &&
        !menu!.contains(event.target) &&
        !trigger!.contains(event.target)
      )
        setOpen(false);
    }
    function close() {
      setOpen(false);
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("blur", close);
    };
  }, [expanded]);

  useLayoutEffect(() => {
    if (expanded) {
      menuRef.current?.children[activeIndex]?.scrollIntoView({
        block: "nearest",
      });
    }
  }, [expanded, activeIndex]);

  useLayoutEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);

  function choose(index: number) {
    const option = props.options[index];
    if (props.disabled || !option) return;
    setOpen(false);
    // 先归还焦点再调用业务回调；不能在风险确认弹出后异步抢回焦点。
    triggerRef.current?.focus({ preventScroll: true });
    props.onSelect(option.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (props.disabled || event.nativeEvent.isComposing) return;
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Escape") {
      if (expanded) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = expanded
          ? Math.min(activeIndex + 1, props.options.length - 1)
          : selectedIndex;
        break;
      case "ArrowUp":
        next = expanded ? Math.max(activeIndex - 1, 0) : selectedIndex;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = props.options.length - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (expanded) choose(activeIndex);
        else {
          setActiveIndex(selectedIndex);
          setOpen(true);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    setActiveIndex(next);
    setOpen(true);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        aria-activedescendant={expanded ? `${id}-${activeIndex}` : undefined}
        data-testid={props.testId}
        data-value={props.value}
        disabled={props.disabled}
        title={selected?.title}
        className={`inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-muted px-2.5 py-1 text-xs text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg-muted disabled:cursor-not-allowed disabled:opacity-50 ${props.className ?? "shrink-0"}`}
        onKeyDown={onKeyDown}
        onClick={() => {
          setActiveIndex(selectedIndex);
          setOpen(!expanded);
        }}
      >
        {props.renderIcon?.(props.value)}
        <span className="min-w-0 truncate">{selected?.label}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          className="h-3 w-3 shrink-0 opacity-60"
        >
          <path
            d="M4.5 6.5 8 10l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {expanded &&
        createPortal(
          <div
            ref={menuRef}
            id={id}
            role="listbox"
            aria-label={props.label}
            data-testid={`${props.testId}-listbox`}
            className="fixed z-50 min-w-40 max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-line bg-surface p-1 text-xs text-fg-muted shadow-lg"
            style={position}
            onPointerDown={(event) => event.preventDefault()}
          >
            {props.options.map((option, index) => (
              <div
                key={option.value}
                id={`${id}-${index}`}
                role="option"
                aria-selected={option.value === props.value}
                data-testid={`${props.testId}-option-${option.value}`}
                data-value={option.value}
                title={option.title}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 ${
                  option.value === props.value ? "bg-hover" : ""
                } ${index === activeIndex ? "outline-1 -outline-offset-1 outline-fg-subtle" : ""}`}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => choose(index)}
              >
                {props.renderIcon?.(option.value)}
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {option.label}
                </span>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  fill="none"
                  className={`h-3 w-3 shrink-0 ${option.value === props.value ? "" : "invisible"}`}
                >
                  <path
                    d="m3 8 3 3 7-7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
