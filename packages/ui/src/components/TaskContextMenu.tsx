import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export interface TaskMenuAnchor {
  x: number;
  y: number;
  target: HTMLElement;
}

interface MenuItem {
  testId: string;
  label: string;
  onSelect: () => void;
}

/**
 * 焦点仅在主动取消时归还；执行操作不能抢走对话框或重命名输入的焦点。
 * taskId 缺省即为项目等非任务实体的菜单（不输出 data-task-id），
 * menuLabel 承担 aria-label 与归属区分（任务菜单默认「任务操作」）。
 */
export function TaskContextMenu(props: {
  taskId?: string;
  menuLabel?: string;
  anchor: TaskMenuAnchor;
  items: MenuItem[];
  onClose: (restoreFocus: boolean) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const { anchor, onClose } = props;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    setPosition({
      left: Math.max(
        margin,
        Math.min(anchor.x, window.innerWidth - rect.width - margin)
      ),
      top: Math.max(
        margin,
        Math.min(anchor.y, window.innerHeight - rect.height - margin)
      ),
    });
    menu.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus({
      preventScroll: true,
    });

    function outside(event: Event) {
      if (!(event.target instanceof Node) || !menu!.contains(event.target)) {
        onClose(false);
      }
    }
    function close() {
      onClose(false);
    }
    const observer = new MutationObserver(() => {
      if (!anchor.target.isConnected) onClose(true);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("wheel", outside, { capture: true, passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("wheel", outside, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [anchor, onClose]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key === "Tab") {
      onClose(true);
      return;
    }
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']"
      ) ?? []
    );
    const index = buttons.findIndex(
      (button) => button === document.activeElement
    );
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (index + 1) % buttons.length;
        break;
      case "ArrowUp":
        next = (index - 1 + buttons.length) % buttons.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = buttons.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    buttons[next]?.focus();
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={props.menuLabel ?? "任务操作"}
      data-testid="task-context-menu"
      data-task-id={props.taskId}
      // 弹层统一语汇（ADR 0028）：白卡 + line 发丝线 + shadow-popover 档 + 10px 圆角
      className="fixed z-50 w-40 max-w-[calc(100vw-16px)] overflow-y-auto rounded-[10px] border border-line bg-surface p-1 text-sm text-fg shadow-popover"
      style={{ ...position, maxHeight: "calc(100vh - 16px)" }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {props.items.map((item) => (
        <button
          key={item.testId}
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-testid={item.testId}
          className="block w-full rounded px-3 py-1.5 text-left hover:bg-hover focus:bg-hover focus:outline-none"
          onClick={() => {
            onClose(false);
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
