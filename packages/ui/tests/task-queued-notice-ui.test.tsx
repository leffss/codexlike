import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TaskQueuedNotice } from "../src/components/TaskQueuedNotice";

/** 排队状态条（任务并发上限票 03）：显示/隐藏由父层按排队态控制，组件只管呈现。 */
it("显示排队提示与当前运行数，静态时钟弱提示（不转圈、muted 色）", () => {
  const html = renderToStaticMarkup(
    createElement(TaskQueuedNotice, { runningCount: 3 })
  );
  expect(html).toContain('data-testid="task-queued-notice"');
  expect(html).toContain('role="status"');
  expect(html).toContain("排队中（并发已满，3 个任务运行中）");
  // 弱提示：静态时钟不转圈，muted 色而非 accent
  expect(html).not.toContain("animate-spin");
  expect(html).not.toContain("text-accent");
  expect(html).toContain("text-fg-muted");
});

it("运行数随 props 变化（tabular-nums 对齐数字宽度）", () => {
  for (const count of [1, 8]) {
    const html = renderToStaticMarkup(
      createElement(TaskQueuedNotice, { runningCount: count })
    );
    expect(html).toContain(`排队中（并发已满，${count} 个任务运行中）`);
    expect(html).toContain("tabular-nums");
  }
});
