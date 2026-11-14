import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChangesChip } from "../src/components/ChangesChip";

/**
 * 改动摘要胶囊（消息区右上角入口）：静态渲染 seam——点击开抽屉与
 * git 状态拉取由桌面 E2E 验证（renderToStaticMarkup 不执行 effect，
 * 拉取前渲染加载态：无计数、胶囊本体恒在）。
 */
describe("改动摘要胶囊", () => {
  it("保留 changes-toggle 定位器，加载中不渲染计数，无任务时禁用", () => {
    const html = renderToStaticMarkup(
      createElement(ChangesChip, { taskId: "t1", onOpen: () => {} })
    );
    expect(html).toMatch(/data-testid="changes-toggle"/);
    expect(html).toContain('title="查看工作区改动"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("改动");
    expect(html).not.toMatch(/data-testid="changes-chip-count"/);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    const noTask = renderToStaticMarkup(
      createElement(ChangesChip, { taskId: null, onOpen: () => {} })
    );
    expect(noTask).toMatch(/data-testid="changes-toggle"[^>]*disabled/);
  });

  it("点击动作透传给宿主（先例：window-controls-ui 直接调用 props）", () => {
    const onOpen = vi.fn();
    const markup = createElement(ChangesChip, {
      taskId: "t1",
      onOpen,
    });
    markup.props.onOpen();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
