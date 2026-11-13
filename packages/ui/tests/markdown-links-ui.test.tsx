import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageStream } from "../src/components/MessageStream";
import { SubagentCard } from "../src/components/SubagentCard";
import { setRememberedOpen } from "../src/lib/collapse-memory";
import type { MessageSegment, SubagentSegment } from "../src/lib/task-view";

/** 静态渲染接缝：验证三个真实入口的链接语义，不替代桌面 E2E 点击验证。 */
const entries = ["assistant", "compact-summary", "subagent"] as const;

function render(entry: (typeof entries)[number], content: string): string {
  if (entry === "subagent") {
    const subagent: SubagentSegment = {
      kind: "subagent",
      id: "markdown-links-subagent",
      seq: 2,
      turnId: "markdown-links-turn",
      responseId: null,
      toolCallId: "markdown-links-delegate",
      task: "链接报告",
      state: "done",
      startedAt: null,
      endedAt: null,
      report: content,
      ok: true,
      tools: [],
    };
    setRememberedOpen(`subagent-${subagent.id}`, true);
    return renderToStaticMarkup(createElement(SubagentCard, { subagent }));
  }
  const segment: MessageSegment = {
    kind: entry,
    id: "markdown-links-message",
    seq: 2,
    turnId: "markdown-links-turn",
    responseId: "markdown-links-response",
    content,
  };
  return renderToStaticMarkup(
    createElement(MessageStream, {
      items: [segment],
      sessionId: "markdown-links-task",
    })
  );
}

describe.each(entries)("%s 的 Markdown 链接", (entry) => {
  it("同文档锚点保留原生链接与嵌套内容，不带外部打开属性", () => {
    const html = render(
      entry,
      '[阅读 **章节** 与 `示例`](#intro "章节标题")\n\n[回到顶部](#)'
    );
    const links = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('href="#intro"');
    expect(links[0]).toContain('title="章节标题"');
    expect(links[0]).toContain(
      "阅读 <strong>章节</strong> 与 <code>示例</code>"
    );
    expect(links[1]).toContain('href="#"');
    for (const link of links) {
      expect(link).not.toContain("target=");
      expect(link).not.toContain("rel=");
    }
  });

  it("不支持或非法的目标仅保留可读内容和标题，不生成链接", () => {
    const targets = [
      "./guide.md",
      "../guide.md",
      "/settings",
      "?mode=edit",
      "//example.test/path",
      "mailto:reader@example.test",
      "ftp://example.test/file",
      "tel:123456",
      "custom:launch",
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "jav&#x61;script:alert(1)",
      "data:text/html,danger",
      "file:///C:/Users/example/notes.md",
      "C:/Users/example/notes.md",
      String.raw`C:\Users\example\notes.md`,
      String.raw`\\server\share\notes.md`,
      "https://",
      "https://[invalid",
      "https://example.test:99999",
      "https://%zz",
      "http:example.test",
      "https:/example.test",
      "",
    ];
    for (const target of targets) {
      const html = render(
        entry,
        `[阅读 **指南** 与 \`示例\`](<${target}> "保留标题")`
      );
      expect(html, target).not.toMatch(/<a\b/);
      expect(html, target).not.toContain("href=");
      expect(html, target).toContain(
        "阅读 <strong>指南</strong> 与 <code>示例</code>"
      );
      expect(html, target).toContain('title="保留标题"');
    }
  });

  it("有效外链保留嵌套 children、title 和图片替代文本", () => {
    const html = render(
      entry,
      '[阅读 **指南** 与 `示例` ![无障碍说明](https://example.test/icon.png)](HTTPS://example.test/path?q=one&lang=zh#intro "完整标题")'
    );
    const link = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/)?.[0];
    expect(link).toBeDefined();
    expect(link).toContain(
      'href="HTTPS://example.test/path?q=one&amp;lang=zh#intro"'
    );
    expect(link).toContain('title="完整标题"');
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(link).toContain("阅读 <strong>指南</strong> 与 <code>示例</code>");
    expect(link).toContain('alt="无障碍说明"');
    expect(link).not.toContain("node=");
    expect(link).not.toContain("aria-hidden");
  });

  it("GFM 邮件链接保留文本，原始 HTML 不绕过默认安全转换", () => {
    const html = render(
      entry,
      'reader@example.test\n\n<reader@example.test>\n\n<a href="javascript:alert(1)">原始标签</a>'
    );
    expect(html).not.toMatch(/<a\b/);
    expect(html.match(/reader@example\.test/g)).toHaveLength(2);
    expect(html).toContain("&lt;a href=");
    expect(html).toContain("原始标签");
    expect(html).not.toContain("target=");
  });

  it("HTTP/HTTPS Markdown 与 GFM 自动链接使用隔离的新上下文", () => {
    const html = render(
      entry,
      '[HTTP 文档](http://example.test/docs "文档标题")\n\n' +
        "[HTTPS 文档](https://example.test/docs#intro)\n\n" +
        "http://example.test/plain\n\nhttps://example.test/plain\n\n" +
        "www.example.test\n\n<https://example.test/angle>"
    );
    const links = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(links).toHaveLength(6);
    for (const link of links) {
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener noreferrer"');
    }
    expect(links[0]).toContain('href="http://example.test/docs"');
    expect(links[0]).toContain('title="文档标题"');
    expect(links[0]).toContain(">HTTP 文档</a>");
    expect(links[1]).toContain('href="https://example.test/docs#intro"');
    expect(links[2]).toContain('href="http://example.test/plain"');
    expect(links[3]).toContain('href="https://example.test/plain"');
    expect(links[4]).toContain('href="http://www.example.test"');
    expect(links[5]).toContain('href="https://example.test/angle"');
  });
});
