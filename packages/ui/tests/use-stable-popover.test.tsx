// @vitest-environment jsdom
// use-stable-popover 定位接缝（ADR 0024 呈现修订）：jsdom 无真实布局，
// 以 mock 几何（getBoundingClientRect / offsetWidth/Height / innerWidth/Height）
// + fake ResizeObserver 验证「开时锁几何、内容不重测、外部变化重定位、
// 视口夹紧、清理恢复」的几何决策——真实视觉稳定性由 E2E boundingBox 验收。
import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createPortal } from "react-dom";
import { useStablePopover } from "../src/lib/use-stable-popover";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  callback: ResizeObserverCallback;
  targets: Element[] = [];
  disconnected = false;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve(target: Element) {
    this.targets = this.targets.filter((item) => item !== target);
  }
  disconnect() {
    this.disconnected = true;
    this.targets = [];
  }
}

function Harness(props: {
  children?: React.ReactNode;
  minScrollHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const { triggerRef, popoverRef, popoverStyle } = useStablePopover(open, {
    minScrollHeight: props.minScrollHeight,
  });
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        ref: triggerRef,
        "data-testid": "trigger",
        onClick: () => setOpen(!open),
      },
      "trigger"
    ),
    open && null,
    // popover 常驻 DOM（hidden 控制显隐）：让 mock 几何先于打开生效，
    // 真实组件的条件挂载不影响 hook 接缝（open 翻转的 layout effect 读 ref）
    createPortal(
      createElement(
        "div",
        {
          ref: popoverRef,
          style: open ? popoverStyle : undefined,
          hidden: !open,
          "data-testid": "popover",
        },
        props.children
      ),
      document.body
    )
  );
}

function mockGeometry(
  element: HTMLElement,
  rect: { top: number; bottom: number; left: number; width: number },
  size: { width: number; height: number }
) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.left + rect.width,
    width: rect.width,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  });
  Object.defineProperty(element, "offsetWidth", {
    get: () => size.width,
    configurable: true,
  });
  Object.defineProperty(element, "offsetHeight", {
    get: () => size.height,
    configurable: true,
  });
}

function mockViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    get: () => width,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    get: () => height,
    configurable: true,
  });
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useStablePopover 稳定定位", () => {
  it("打开时锁定实际几何：下方空间不足向上展开，width/height 固定，trigger 宽度锁定 px", () => {
    mockViewport(1200, 600);
    render(createElement(Harness));
    const trigger = screen.getByTestId<HTMLButtonElement>("trigger");
    mockGeometry(
      trigger,
      { top: 400, bottom: 430, left: 100, width: 120 },
      { width: 120, height: 30 }
    );
    mockGeometry(
      screen.getByTestId<HTMLDivElement>("popover"),
      { top: 0, bottom: 240, left: 0, width: 320 },
      { width: 320, height: 240 }
    );
    fireEvent.click(trigger);
    const popover = screen.getByTestId<HTMLDivElement>("popover");
    // 上方空间 386 ≥ 需要高度 240：向上展开，紧贴 trigger 上缘
    expect(popover.style.top).toBe("154px");
    expect(popover.style.left).toBe("100px");
    expect(popover.style.width).toBe("320px");
    expect(popover.style.height).toBe("240px");
    expect(trigger.style.width).toBe("120px");
  });

  it("上方不足向下展开；打开后内容变长不重测自然尺寸（锁定 height 不变，重定位也不换）", () => {
    mockViewport(1200, 600);
    const view = render(createElement(Harness));
    const trigger = screen.getByTestId<HTMLButtonElement>("trigger");
    mockGeometry(
      trigger,
      { top: 200, bottom: 230, left: 100, width: 120 },
      { width: 120, height: 30 }
    );
    let naturalHeight = 240;
    const popover = screen.getByTestId<HTMLDivElement>("popover");
    mockGeometry(
      popover,
      { top: 0, bottom: 0, left: 0, width: 0 },
      { width: 320, height: 0 }
    );
    Object.defineProperty(popover, "offsetHeight", {
      get: () => naturalHeight,
      configurable: true,
    });
    fireEvent.click(trigger);
    expect(popover.style.top).toBe("236px");
    expect(popover.style.height).toBe("240px");

    // 同次打开内切到更长列表（自然高度 500）：不重新 place、方向不换
    naturalHeight = 500;
    view.rerender(
      createElement(Harness, {
        children: createElement(
          "div",
          null,
          ...Array.from({ length: 25 }, (_, index) =>
            createElement("p", { key: index }, `model-${index}`)
          )
        ),
      })
    );
    expect(popover.style.height).toBe("240px");
    expect(popover.style.top).toBe("236px");

    // 外部变化触发的重定位也只移动位置，不重测自然尺寸/方向
    fireEvent(window, new Event("resize"));
    expect(popover.style.height).toBe("240px");
    expect(popover.style.top).toBe("236px");
    expect(popover.style.width).toBe("320px");
  });

  it("resize 重定位夹紧视口：极窄时宽度压到可用下限之上，位置贴边不溢出", () => {
    mockViewport(1200, 600);
    render(createElement(Harness));
    const trigger = screen.getByTestId<HTMLButtonElement>("trigger");
    mockGeometry(
      trigger,
      { top: 200, bottom: 230, left: 100, width: 120 },
      { width: 120, height: 30 }
    );
    mockGeometry(
      screen.getByTestId<HTMLDivElement>("popover"),
      { top: 0, bottom: 0, left: 0, width: 0 },
      { width: 320, height: 240 }
    );
    fireEvent.click(trigger);
    const popover = screen.getByTestId<HTMLDivElement>("popover");
    mockViewport(200, 600);
    fireEvent(window, new Event("resize"));
    expect(popover.style.width).toBe("184px");
    expect(popover.style.left).toBe("8px");
    expect(popover.style.height).toBe("240px");
    expect(popover.style.top).toBe("236px");
  });

  it("外部滚动（防御路径，当前布局不可达）触发重定位：位置随锚点更新，尺寸方向保持", () => {
    mockViewport(1200, 600);
    render(createElement(Harness));
    const trigger = screen.getByTestId<HTMLButtonElement>("trigger");
    mockGeometry(
      trigger,
      { top: 200, bottom: 230, left: 100, width: 120 },
      { width: 120, height: 30 }
    );
    mockGeometry(
      screen.getByTestId<HTMLDivElement>("popover"),
      { top: 0, bottom: 0, left: 0, width: 0 },
      { width: 320, height: 240 }
    );
    fireEvent.click(trigger);
    const popover = screen.getByTestId<HTMLDivElement>("popover");
    expect(popover.style.top).toBe("236px");
    // 页面滚动使锚点上移（真实布局中外层不滚，此处验证 capture 监听的防御行为）
    mockGeometry(
      trigger,
      { top: 100, bottom: 130, left: 100, width: 120 },
      { width: 120, height: 30 }
    );
    fireEvent(window, new Event("scroll"));
    expect(popover.style.top).toBe("136px");
    expect(popover.style.height).toBe("240px");
  });

  it("trigger 的 ResizeObserver（外部布局挤压）触发重定位：位置跟随、方向尺寸保持", async () => {
    mockViewport(1200, 600);
    render(createElement(Harness));
    const trigger = screen.getByTestId<HTMLButtonElement>("trigger");
    mockGeometry(
      trigger,
      { top: 200, bottom: 230, left: 100, width: 120 },
      { width: 120, height: 30 }
    );
    mockGeometry(
      screen.getByTestId<HTMLDivElement>("popover"),
      { top: 0, bottom: 0, left: 0, width: 0 },
      { width: 320, height: 240 }
    );
    fireEvent.click(trigger);
    const popover = screen.getByTestId<HTMLDivElement>("popover");
    expect(popover.style.top).toBe("236px");

    const observer = FakeResizeObserver.instances.find((instance) =>
      instance.targets.includes(trigger)
    );
    expect(observer).toBeTruthy();
    // 右栏开合等外部布局变化：trigger 移位/收窄（宽度锁不覆盖外部挤压后的真实 rect）
    mockGeometry(
      trigger,
      { top: 300, bottom: 330, left: 400, width: 90 },
      { width: 90, height: 30 }
    );
    observer!.callback([], observer as unknown as ResizeObserver);
    // 手动派发 RO 回调在 act 外，包 act 让 React 同步 flush 几何 state
    await act(async () => {});
    expect(popover.style.top).toBe("336px");
    expect(popover.style.left).toBe("400px");
    expect(popover.style.height).toBe("240px");
  });

  it("minScrollHeight：单模型打开即预留最小列表可视区（头尾 + min），切长列表仍一次锁定不重测", () => {
    mockViewport(1200, 600);
    // 自然总高 130 = 头尾 90 + 列表 40；期望锁定高 = 90 + 220 = 310
    const view = render(
      createElement(Harness, {
        minScrollHeight: 220,
        children: createElement("div", {
          "data-stable-popover-scroll": "",
          "data-testid": "scroller",
        }),
      })
    );
    const trigger = screen.getByTestId<HTMLButtonElement>("trigger");
    mockGeometry(
      trigger,
      { top: 200, bottom: 230, left: 100, width: 120 },
      { width: 120, height: 30 }
    );
    const popover = screen.getByTestId<HTMLDivElement>("popover");
    mockGeometry(
      popover,
      { top: 0, bottom: 0, left: 0, width: 0 },
      { width: 320, height: 130 }
    );
    const scroller = screen.getByTestId<HTMLElement>("scroller");
    Object.defineProperty(scroller, "offsetHeight", {
      get: () => 40,
      configurable: true,
    });
    fireEvent.click(trigger);
    expect(popover.style.height).toBe("310px");

    // 切到长列表（自然高 500）：锁定值不变，列表在 220px 可视区内滚动
    Object.defineProperty(popover, "offsetHeight", {
      get: () => 500,
      configurable: true,
    });
    view.rerender(
      createElement(Harness, {
        minScrollHeight: 220,
        children: createElement("div", {
          "data-stable-popover-scroll": "",
          "data-testid": "scroller",
        }),
      })
    );
    fireEvent(window, new Event("resize"));
    expect(popover.style.height).toBe("310px");
  });

  it("关闭恢复 trigger 原 inline width 并清理：observer 断开，resize 不再改弹层样式", () => {
    mockViewport(1200, 600);
    render(createElement(Harness));
    const trigger = screen.getByTestId<HTMLButtonElement>("trigger");
    mockGeometry(
      trigger,
      { top: 200, bottom: 230, left: 100, width: 120 },
      { width: 120, height: 30 }
    );
    mockGeometry(
      screen.getByTestId<HTMLDivElement>("popover"),
      { top: 0, bottom: 0, left: 0, width: 0 },
      { width: 320, height: 240 }
    );
    fireEvent.click(trigger);
    expect(trigger.style.width).toBe("120px");
    const observer = FakeResizeObserver.instances.find((instance) =>
      instance.targets.includes(trigger)
    )!;

    fireEvent.click(trigger); // 关闭
    expect(trigger.style.width).toBe("");
    expect(observer.disconnected).toBe(true);
    const popover = screen.getByTestId<HTMLDivElement>("popover");
    expect(popover.style.width).toBe("");
    mockViewport(300, 300);
    fireEvent(window, new Event("resize"));
    expect(popover.style.width).toBe("");
  });
});
