import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DrawerTabHeader,
  PanelsDrawer,
  type DrawerTab,
} from "../src/components/PanelsDrawer";

/** 面板内容以占位节点注入：抽屉容器只负责 tab 映射，不关心面板内部实现 */
function stub(testid: string, text: string) {
  return createElement("div", { "data-testid": testid }, text);
}

function drawer(tab: DrawerTab, overrides: Record<string, unknown> = {}) {
  return createElement(PanelsDrawer, {
    tab,
    onTabChange: () => {},
    onClose: () => {},
    resources: stub("resources-panel", "规范内容"),
    changes: stub("changes-panel", "改动内容"),
    ...overrides,
  });
}

describe("右栏面板抽屉（票03）", () => {
  it("抽屉浮于消息流上方：右侧 absolute 覆盖层，宽 30rem 上限 60%", () => {
    const html = renderToStaticMarkup(drawer("resources"));
    expect(html).toMatch(/data-testid="panels-drawer"/);
    expect(html).toContain("absolute inset-y-0 right-0");
    expect(html).toContain("w-[30rem] max-w-[60%]");
    expect(html).toContain("shadow-2xl");
  });

  it("tab 头提供「规范与技能 / 改动」切换与 × 关闭按钮", () => {
    const html = renderToStaticMarkup(drawer("resources"));
    expect(html).toContain("规范与技能");
    expect(html).toContain("改动");
    // 属性顺序无关：先截按钮标签再断言 aria 状态
    const resourcesTab = html.match(
      /<button[^>]*data-testid="drawer-tab-resources"[^>]*>/
    )?.[0];
    const changesTab = html.match(
      /<button[^>]*data-testid="drawer-tab-changes"[^>]*>/
    )?.[0];
    expect(resourcesTab).toContain('aria-selected="true"');
    expect(changesTab).toContain('aria-selected="false"');
    expect(html).toMatch(
      /data-testid="drawer-close"[^>]*aria-label="关闭面板"/
    );
  });

  it("按当前 tab 挂载对应面板，未激活面板不渲染（开合状态）", () => {
    const resourcesHtml = renderToStaticMarkup(drawer("resources"));
    expect(resourcesHtml).toContain("规范内容");
    expect(resourcesHtml).not.toContain("改动内容");
    const changesHtml = renderToStaticMarkup(drawer("changes"));
    expect(changesHtml).toContain("改动内容");
    expect(changesHtml).not.toContain("规范内容");
  });

  it("tab 按钮与 × 关闭把动作回传宿主（先例：window-controls-ui 直接调用元素 props）", () => {
    const onTabChange = vi.fn();
    const onClose = vi.fn();
    const header = DrawerTabHeader({
      active: "resources",
      onTabChange,
      onClose,
    });
    // 结构：两个 tab 按钮 + 关闭按钮（JSX children 为嵌套数组，先拍平）
    const buttons = (header!.props.children as unknown[]).flat(2) as Array<{
      props: { onClick: () => void };
    }>;
    expect(buttons).toHaveLength(3);
    buttons[0]!.props.onClick();
    expect(onTabChange).toHaveBeenCalledWith("resources");
    buttons[1]!.props.onClick();
    expect(onTabChange).toHaveBeenCalledWith("changes");
    buttons[2]!.props.onClick();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onTabChange).toHaveBeenCalledTimes(2);
  });
});
