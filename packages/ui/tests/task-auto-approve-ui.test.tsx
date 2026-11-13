import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { TaskAutoApproveStatus } from "../src/components/TaskAutoApproveStatus";

it("持久授权状态独立于审批面板，取消期间和失败时仍可见，未开启不显示", () => {
  const props = {
    autoApprove: true,
    busy: false,
    error: null,
    onRevoke: vi.fn(),
  };
  const html = renderToStaticMarkup(
    createElement(TaskAutoApproveStatus, props)
  );
  expect(html).toContain("本会话已开启自动批准");
  expect(html).toContain('data-testid="session-auto-approve-revoke"');
  expect(html).toContain("取消自动批准");
  expect(
    renderToStaticMarkup(
      createElement(TaskAutoApproveStatus, { ...props, busy: true })
    )
  ).toMatch(/<button[^>]*disabled/);
  const failed = renderToStaticMarkup(
    createElement(TaskAutoApproveStatus, {
      ...props,
      error: "保存失败，请重试",
    })
  );
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("保存失败，请重试");
  expect(failed).toContain("本会话已开启自动批准");
  expect(
    renderToStaticMarkup(
      createElement(TaskAutoApproveStatus, { ...props, autoApprove: false })
    )
  ).toBe("");
});
