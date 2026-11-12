import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SessionSidebar } from "../src/components/SessionSidebar";

it("项目置顶入口是独立键盘按钮，置顶标识与空项目均保留", () => {
  const html = renderToStaticMarkup(
    createElement(SessionSidebar, {
      projects: [
        {
          id: "p",
          name: "空项目",
          workspacePath: "/work",
          createdAt: "2026-11-12",
          pinned: true,
        },
      ],
      sessions: [],
      currentId: null,
      creating: false,
      onAddProject() {},
      onCreateInProject() {},
      onSelect() {},
      onCreate() {},
      onMembership() {},
      onRename() {},
      onArchive() {},
      onPin() {},
      onPinProject() {},
      onCollapseProject() {},
    })
  );
  expect(html).toContain('data-testid="project-pinned"');
  expect(html).toMatch(
    /<button[^>]*data-testid="project-pin"[^>]*aria-pressed="true"/
  );
  expect(html).toContain('aria-label="取消项目置顶"');
  expect(html).toContain("group-focus-within/header:opacity-100");
  expect(html.indexOf('data-testid="project-header"')).toBeLessThan(
    html.indexOf('data-testid="standalone-header"')
  );
});
