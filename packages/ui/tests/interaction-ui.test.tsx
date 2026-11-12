import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InteractionRecord } from "@codexlike/agent-core";
import { InteractionPanel } from "../src/components/InteractionPanel";
import { MessageStream } from "../src/components/MessageStream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createQuestionDraft } from "../src/lib/interaction-draft";

const approval: InteractionRecord = {
  request: {
    id: "approval-1",
    sessionId: "s1",
    turnId: "t1",
    toolCallId: "c1",
    kind: "approval",
    source: { kind: "subagent", subagentId: "child", task: "核对改动" },
    createdAt: "2026-11-11T08:00:00Z",
    toolName: "run_terminal_command",
    command: "git diff --stat",
    commandWord: "git",
  },
  status: "pending",
  response: null,
  resolvedAt: null,
  cancelReason: null,
};
const props = {
  count: 2,
  busy: false,
  error: null,
  onChange: () => {},
  onRespond: () => {},
  onStop: () => {},
};

describe("唯一底部 InteractionPanel", () => {
  it("长来源/题目在窄屏可折行，所有颜色都来自双主题语义 token", () => {
    const html = renderToStaticMarkup(
      createElement(InteractionPanel, { ...props, record: approval })
    );
    expect(html).toMatch(
      /data-testid="interaction-source"[^>]*overflow-wrap:anywhere/
    );
    expect(html).toContain("overflow-y-auto");
    const css = readFileSync(
      join(import.meta.dirname, "../src/styles.css"),
      "utf8"
    );
    for (const filename of ["InteractionPanel.tsx", "InteractionHistory.tsx"]) {
      const source = readFileSync(
        join(import.meta.dirname, "../src/components", filename),
        "utf8"
      );
      expect(source).not.toMatch(
        /(?:bg|text|border)-(?:slate|sky|gray|blue|red|green|white|black)(?:-|\b)/
      );
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
    for (const token of [
      "surface",
      "line",
      "fg",
      "accent",
      "warn-fg",
      "danger-fg",
      "code-bg",
      "code-fg",
    ]) {
      expect(css.match(new RegExp(`--${token}:`, "g"))?.length).toBe(2);
    }
  });
  it("消息流审批只读折叠摘要，没有批准按钮；取消与结果文案可见", () => {
    const html = renderToStaticMarkup(
      createElement(MessageStream, {
        items: [
          {
            kind: "interaction",
            id: "r1",
            seq: 1,
            turnId: "u1",
            responseId: null,
            interaction: approval,
          },
          {
            kind: "interaction",
            id: "r2",
            seq: 2,
            turnId: "u1",
            responseId: null,
            interaction: {
              ...approval,
              status: "resolved",
              response: { kind: "approval", decision: "approve" },
            },
          },
          {
            kind: "interaction",
            id: "r3",
            seq: 3,
            turnId: "u1",
            responseId: null,
            interaction: {
              ...approval,
              status: "cancelled",
              cancelReason: "用户已停止",
            },
          },
        ],
      })
    );
    for (const text of [
      "interaction-history",
      "<details",
      "等待审批",
      "已批准",
      "已取消",
      "用户已停止",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("approval-approve");
    expect(html).not.toContain("approval-reject");
  });
  it("问答一次一题、显示说明和原生选择输入；未答禁止继续/提交但可忽略", () => {
    const request = {
      ...approval.request,
      kind: "questions" as const,
      questions: [
        {
          id: "q1",
          header: "方案",
          question: "选择方案？",
          multiSelect: false,
          options: [{ id: "a", label: "方案A", description: "小改动" }],
        },
        {
          id: "q2",
          header: "能力",
          question: "需要能力？",
          multiSelect: true,
          options: [{ id: "x", label: "能力X" }],
        },
      ],
    };
    const record: InteractionRecord = { ...approval, request };
    const draft = createQuestionDraft(request);
    const html = renderToStaticMarkup(
      createElement(InteractionPanel, { ...props, record, draft })
    );
    for (const text of [
      "question-title",
      "question-progress",
      "第 1 / 2 题",
      "question-option-a",
      'type="radio"',
      "小改动",
      "question-custom",
      "question-prev",
      "question-next",
      "question-skip",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("需要能力？");
    expect(html).not.toContain("<form");
    expect(html).toMatch(
      /<button[^>]*data-testid="question-next"[^>]*disabled/
    );
    const last = renderToStaticMarkup(
      createElement(InteractionPanel, {
        ...props,
        record,
        draft: { ...draft, index: 1 },
        error: "提交失败",
      })
    );
    expect(last).toContain('type="checkbox"');
    expect(last).toMatch(
      /<button[^>]*data-testid="question-submit"[^>]*disabled/
    );
    expect(last).toContain("interaction-error");
  });
  it("审批显示来源、数量、命令原文，仅批准本次/拒绝；提交中停止仍可点", () => {
    const html = renderToStaticMarkup(
      createElement(InteractionPanel, {
        ...props,
        record: approval,
        busy: true,
      })
    );
    for (const text of [
      "interaction-panel",
      "interaction-source",
      "interaction-count",
      "核对改动",
      "git diff --stat",
      "批准本次",
      "approval-approve",
      "approval-reject",
      "composer-stop",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("approval-always");
    expect(html).toMatch(
      /<button[^>]*data-testid="approval-approve"[^>]*disabled/
    );
    expect(html).not.toMatch(
      /<button[^>]*data-testid="composer-stop"[^>]*disabled/
    );
    expect(html).toContain('data-interaction-id="approval-1"');
  });
});
