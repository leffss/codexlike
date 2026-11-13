import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { QueuedMessage } from "@codexlike/desktop/ipc";
import { QueueBar } from "../src/components/QueueBar";

function queued(texts: string[]): QueuedMessage[] {
  return texts.map((text, index) => ({
    id: `q-${index}`,
    sessionId: "s",
    position: index,
    text,
    mentionPaths: [],
    providerProfileId: "p",
    thinkingEffort: "auto",
    approvalMode: "ask",
    createdAt: "2026-11-13T00:00:00Z",
  }));
}

it("输入队列条（票 01）：空队列不显示；有条目显示预览与条数", () => {
  expect(renderToStaticMarkup(createElement(QueueBar, { queue: [] }))).toBe("");
  const html = renderToStaticMarkup(
    createElement(QueueBar, { queue: queued(["接着做第二步", "再跑一遍测试"]) })
  );
  expect(html).toContain('data-testid="queue-bar"');
  expect(html).toContain("接着做第二步");
  expect(html).toContain("再跑一遍测试");
  expect(html).toContain('data-testid="queue-count"');
  expect(html).toContain("2");
  // 不进消息流：只读列表，无交互控件
  expect(html).not.toContain("<button");
});

it("超过 5 条折叠为「+N 更多」，预览仍按顺序展示前 5 条", () => {
  const html = renderToStaticMarkup(
    createElement(QueueBar, {
      queue: queued(["一", "二", "三", "四", "五", "六", "七"]),
    })
  );
  for (const text of ["一", "二", "三", "四", "五"]) {
    expect(html).toContain(text);
  }
  expect(html).not.toContain(">六<");
  expect(html).not.toContain(">七<");
  expect(html).toContain('data-testid="queue-more"');
  expect(html).toContain("+2 更多");
  expect(html).toContain('data-testid="queue-count"');
  expect(html).toContain("7");
});
