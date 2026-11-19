// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installScrollbarVisibility,
  scrollbarHit,
  SCROLLBAR_EDGE_PX,
  SCROLL_IDLE_MS,
} from "../src/lib/scrollbar-visibility";

/** 300×200 的盒，右缘带 [290,300]、底缘带 [190,200]（edge 默认 10） */
const BOX = { left: 0, top: 0, right: 300, bottom: 200 };

describe("scrollbarHit（滚动条边缘命中纯函数）", () => {
  it("右缘带内命中 vertical", () => {
    expect(scrollbarHit(BOX, 295, 100)).toBe("vertical");
    expect(scrollbarHit(BOX, 300, 0)).toBe("vertical");
    expect(scrollbarHit(BOX, 290, 200)).toBe("vertical");
  });

  it("底缘带内命中 horizontal（右下角 vertical 优先）", () => {
    expect(scrollbarHit(BOX, 150, 195)).toBe("horizontal");
    expect(scrollbarHit(BOX, 0, 200)).toBe("horizontal");
    // 右下角两带重叠：按拖竖直条更常用优先 vertical
    expect(scrollbarHit(BOX, 295, 195)).toBe("vertical");
  });

  it("带外 / 盒外返回 null", () => {
    expect(scrollbarHit(BOX, 289, 100)).toBe(null);
    expect(scrollbarHit(BOX, 150, 189)).toBe(null);
    expect(scrollbarHit(BOX, 150, 100)).toBe(null);
    expect(scrollbarHit(BOX, -5, 100)).toBe(null);
    expect(scrollbarHit(BOX, 150, 250)).toBe(null);
  });

  it("自定义 edge 收窄/放宽命中带", () => {
    expect(scrollbarHit(BOX, 295, 100, 4)).toBe(null);
    expect(scrollbarHit(BOX, 298, 100, 4)).toBe("vertical");
    expect(scrollbarHit(BOX, 280, 100, 20)).toBe("vertical");
  });

  it("默认 edge 为 SCROLLBAR_EDGE_PX", () => {
    expect(SCROLLBAR_EDGE_PX).toBe(10);
    expect(scrollbarHit(BOX, 300 - SCROLLBAR_EDGE_PX, 50)).toBe("vertical");
    expect(scrollbarHit(BOX, 300 - SCROLLBAR_EDGE_PX - 1, 50)).toBe(null);
  });
});

/**
 * 装配层回归（jsdom + 假 ResizeObserver）：内容变化信号是第三类显色来源。
 * 背景 bug：消息自动刷新时若无滚动位移（上翻看历史、窗口隐藏期间增长），
 * 只有 scroll 事件驱动的显色永远不触发，thumb 恒透明——「滚动条不自动显示」。
 * jsdom 无 ResizeObserver 与真实布局，几何属性经 defineProperty 注入。
 */
describe("installScrollbarVisibility（内容变化信号）", () => {
  const teardowns: Array<() => void> = [];

  afterEach(() => {
    for (const teardown of teardowns.splice(0)) teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /** 可滚动容器：overflowY 内联 + 可覆写的 scrollHeight/clientHeight */
  function makeContainer(initialScrollHeight: number, clientHeight = 400) {
    const container = document.createElement("div");
    container.style.overflowY = "auto";
    container.className = "overflow-y-auto";
    const content = document.createElement("div");
    container.appendChild(content);
    const heights = { scrollHeight: initialScrollHeight };
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => heights.scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });
    document.body.appendChild(container);
    return { container, content, heights };
  }

  /** 假 ResizeObserver：记录 observe 目标，fire() 手动派发回调 */
  function fakeResizeObserver() {
    const observed = new Set<Element>();
    const callbacks: Array<(entries: Array<{ target: Element }>) => void> = [];
    class FakeResizeObserver {
      constructor(callback: (entries: Array<{ target: Element }>) => void) {
        callbacks.push(callback);
      }
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    return {
      fire(target: Element) {
        for (const callback of callbacks) callback([{ target }]);
      },
      observed,
    };
  }

  function setHidden(hidden: boolean) {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
  }

  it("内容增长（内容根 resize）挂 scrollbar-live，闲置后摘除", () => {
    vi.useFakeTimers();
    const observer = fakeResizeObserver();
    const { container, content, heights } = makeContainer(1000);
    const uninstall = installScrollbarVisibility();
    teardowns.push(uninstall);

    expect(observer.observed.has(content)).toBe(true); // 初始扫描登记内容根
    expect(container.classList.contains("scrollbar-live")).toBe(false);

    heights.scrollHeight = 1500; // 内容自动刷新增长
    observer.fire(content);

    expect(container.classList.contains("scrollbar-live")).toBe(true);

    vi.advanceTimersByTime(SCROLL_IDLE_MS);
    expect(container.classList.contains("scrollbar-live")).toBe(false);
  });

  it("内容高度未变的 resize 不显色", () => {
    vi.useFakeTimers();
    const observer = fakeResizeObserver();
    const { container, content } = makeContainer(1000);
    const uninstall = installScrollbarVisibility();
    teardowns.push(uninstall);

    observer.fire(content); // 内容根因布局抖动 resize，scrollHeight 不变

    expect(container.classList.contains("scrollbar-live")).toBe(false);
  });

  it("不可滚动容器（内容未超出）的内容增长不显色", () => {
    vi.useFakeTimers();
    const observer = fakeResizeObserver();
    const { container, content, heights } = makeContainer(300, 400);
    const uninstall = installScrollbarVisibility();
    teardowns.push(uninstall);

    heights.scrollHeight = 350; // 仍小于 clientHeight，无滚动条可言
    observer.fire(content);

    expect(container.classList.contains("scrollbar-live")).toBe(false);
  });

  it("窗口隐藏期间增长、恢复可见时补显色（visibilitychange 兜底）", () => {
    vi.useFakeTimers();
    fakeResizeObserver();
    const { container, heights } = makeContainer(1000);
    const uninstall = installScrollbarVisibility();
    teardowns.push(uninstall);

    setHidden(true);
    heights.scrollHeight = 2000; // 隐藏期增长，ResizeObserver 回调被节流吞掉
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(container.classList.contains("scrollbar-live")).toBe(true);

    vi.advanceTimersByTime(SCROLL_IDLE_MS);
    expect(container.classList.contains("scrollbar-live")).toBe(false);
  });

  it("滚动信号回归守护：scroll 事件仍显色", () => {
    vi.useFakeTimers();
    fakeResizeObserver();
    const { container } = makeContainer(1000);
    const uninstall = installScrollbarVisibility();
    teardowns.push(uninstall);

    container.dispatchEvent(new Event("scroll"));

    expect(container.classList.contains("scrollbar-live")).toBe(true);
    vi.advanceTimersByTime(SCROLL_IDLE_MS);
    expect(container.classList.contains("scrollbar-live")).toBe(false);
  });

  it("安装后动态出现的滚动容器也被登记（main.tsx 先安装后渲染）", async () => {
    vi.useFakeTimers();
    const observer = fakeResizeObserver();
    // 安装时 DOM 为空：真实时序是 install 先于 React root.render
    const uninstall = installScrollbarVisibility();
    teardowns.push(uninstall);

    const { container, content, heights } = makeContainer(1000);
    // MutationObserver 回调是微任务：flush 后登记才发生
    await Promise.resolve();
    await Promise.resolve();
    heights.scrollHeight = 1600; // 挂载即内容增长（消息流首屏渲染）
    observer.fire(content);

    expect(container.classList.contains("scrollbar-live")).toBe(true);
  });

  it("豁免容器（data-scrollbar-content-signal=off）内容增长不显色，滚动信号照常", () => {
    vi.useFakeTimers();
    const observer = fakeResizeObserver();
    const { container, content, heights } = makeContainer(1000);
    container.setAttribute("data-scrollbar-content-signal", "off");
    const uninstall = installScrollbarVisibility();
    teardowns.push(uninstall);

    // 豁免容器不登记内容根：流式自动刷新改高度不触发显色（防闪烁）
    expect(observer.observed.has(content)).toBe(false);
    heights.scrollHeight = 1500;
    observer.fire(content);

    expect(container.classList.contains("scrollbar-live")).toBe(false);

    // 滚动信号不受豁免影响：用户真实滚动仍显色
    container.dispatchEvent(new Event("scroll"));
    expect(container.classList.contains("scrollbar-live")).toBe(true);
    vi.advanceTimersByTime(SCROLL_IDLE_MS);
    expect(container.classList.contains("scrollbar-live")).toBe(false);
  });

  it("豁免标记在祖先上同样生效（面板内嵌滚动区随根豁免）", () => {
    vi.useFakeTimers();
    const observer = fakeResizeObserver();
    const panel = document.createElement("div");
    panel.setAttribute("data-scrollbar-content-signal", "off");
    document.body.appendChild(panel);
    const { container, content, heights } = makeContainer(1000);
    panel.appendChild(container); // 滚动容器移入豁免祖先（子代理详情形态）
    const uninstall = installScrollbarVisibility();
    teardowns.push(uninstall);

    expect(observer.observed.has(content)).toBe(false);
    heights.scrollHeight = 1800;
    observer.fire(content);
    expect(container.classList.contains("scrollbar-live")).toBe(false);
  });

  it("卸载后内容信号停止（观察器断开、回调不再显色）", () => {
    vi.useFakeTimers();
    const observer = fakeResizeObserver();
    const { container, content, heights } = makeContainer(1000);
    const uninstall = installScrollbarVisibility();
    uninstall();

    heights.scrollHeight = 1500;
    observer.fire(content);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(container.classList.contains("scrollbar-live")).toBe(false);
  });
});
