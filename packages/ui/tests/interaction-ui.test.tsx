import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InteractionRecord } from "@codexlike/agent-core";
import { InteractionPanel } from "../src/components/InteractionPanel";
import { InteractionHistory } from "../src/components/InteractionHistory";
import { MessageStream } from "../src/components/MessageStream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createQuestionDraft } from "../src/lib/interaction-draft";
import { TASK_CONTENT_WIDTH_CLASS } from "../src/lib/content-width";

const approval: InteractionRecord = {
  request: {
    id: "approval-1",
    taskId: "s1",
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
  it("历史明确区分任务授权批量通过与旧无 scope 单次批准", () => {
    for (const scope of [undefined, "once", "task"] as const) {
      const html = renderToStaticMarkup(
        createElement(InteractionHistory, {
          record: {
            ...approval,
            status: "resolved",
            response: {
              kind: "approval",
              decision: "approve",
              ...(scope ? { scope } : {}),
            },
          },
        })
      );
      expect(html).toContain(
        scope === "task" ? "任务授权批量通过" : "已批准（本次）"
      );
      expect(html).not.toContain("<button");
    }
  });
  it("自动批准即时放行的审批在历史中显示「已自动批准」，与用户手动授权区分（反馈2）", () => {
    const html = renderToStaticMarkup(
      createElement(InteractionHistory, {
        record: {
          ...approval,
          status: "resolved",
          autoApproved: true,
          response: { kind: "approval", decision: "approve", scope: "task" },
        },
      })
    );
    expect(html).toContain("已自动批准");
    expect(html).not.toContain("任务授权批量通过");
    expect(html).not.toContain("<button");
  });
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
  it("答案过长时滚动只作用于选项列表：问题说明与自定义回答、按钮固定显示（反馈4）", () => {
    const request = {
      ...approval.request,
      kind: "questions" as const,
      questions: [
        {
          id: "q1",
          header: "方案",
          question: "选择方案？",
          multiSelect: false,
          options: [
            { id: "a", label: "方案A" },
            { id: "b", label: "方案B" },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(InteractionPanel, {
        ...props,
        record: { ...approval, request },
        draft: createQuestionDraft(request),
      })
    );
    // 滚动容器是选项 div（fieldset 仅承载禁用语义，display:contents 不生成盒——
    // Chromium 对 fieldset 盒模型的 flex/overflow 约束不生效）：带 min-h-0 + overflow-y-auto
    const fieldset = html.match(/<fieldset[^>]*>/)?.[0] ?? "";
    expect(fieldset).toContain("contents");
    expect(fieldset).not.toContain("overflow-y-auto");
    const scroller =
      html.match(/<div[^>]*data-testid="question-options"[^>]*>/)?.[0] ?? "";
    expect(scroller).toContain("overflow-y-auto");
    expect(scroller).toContain("min-h-0");
    // 顺序保真：问题说明在滚动区之前，自定义回答与提交按钮在滚动区之后
    const titleAt = html.indexOf('data-testid="question-title"');
    const scrollerAt = html.indexOf('data-testid="question-options"');
    const customAt = html.indexOf('data-testid="question-custom"');
    const submitAt = html.indexOf('data-testid="question-submit"');
    expect(titleAt).toBeGreaterThanOrEqual(0);
    expect(scrollerAt).toBeGreaterThan(titleAt);
    expect(customAt).toBeGreaterThan(scrollerAt);
    expect(submitAt).toBeGreaterThan(scrollerAt);
  });
  it("每题最多渲染 8 个选项：超出部分不进面板（渲染层上限，与 agent-core 0–8 契约一致）", () => {
    const request = {
      ...approval.request,
      kind: "questions" as const,
      questions: [
        {
          id: "q1",
          header: "方案",
          question: "选择方案？",
          multiSelect: false,
          options: Array.from({ length: 10 }, (_, index) => ({
            id: `opt-${index + 1}`,
            label: `选项${index + 1}`,
          })),
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(InteractionPanel, {
        ...props,
        record: { ...approval, request },
        draft: createQuestionDraft(request),
      })
    );
    for (let index = 1; index <= 8; index += 1) {
      expect(html).toContain(`question-option-opt-${index}`);
    }
    expect(html).not.toContain("question-option-opt-9");
    expect(html).not.toContain("question-option-opt-10");
  });
  it("最后一题提交按钮 hover 用 accent-hover 保持文字可见，文案为「提交」（反馈5）", () => {
    const request = {
      ...approval.request,
      kind: "questions" as const,
      questions: [
        {
          id: "q1",
          header: "方案",
          question: "选择方案？",
          multiSelect: false,
          options: [{ id: "a", label: "方案A" }],
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(InteractionPanel, {
        ...props,
        record: { ...approval, request },
        draft: createQuestionDraft(request),
      })
    );
    const submit =
      html.match(/<button[^>]*data-testid="question-submit"[^>]*>/)?.[0] ?? "";
    expect(submit).toContain("hover:bg-accent-hover");
    expect(submit).not.toContain("hover:bg-hover");
    expect(html).toContain(">提交</button>");
    expect(html).not.toContain("提交整组");
  });
  it("审批显示单次、任务授权与拒绝，说明批量范围和风险；提交中停止仍可点", () => {
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
      "批准本任务后续所有请求",
      "主代理与子代理",
      "当前排队",
      "危险命令",
      "重启",
      "不代答问答",
      "文件工具边界",
      "approval-approve-task",
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
  it("问题区域与输入框共用 ComposerRegion 外壳，宽度收窄不再占满中栏", () => {
    const html = renderToStaticMarkup(
      createElement(InteractionPanel, { ...props, record: approval })
    );
    // 外壳与 composer-region 同构：画布背景 + px-4 py-3 + 滚动槽右缘补偿
    expect(html).toMatch(
      /data-testid="interaction-region"[^>]*class="bg-canvas px-4 py-3"/
    );
    expect(html).toContain("var(--task-scrollbar-gutter");
    // 内容列宽度类与消息流/输入区同一基准（TASK_CONTENT_WIDTH_CLASS +
    // @container），居中收窄；面板本体在壳内。
    expect(html).toContain(`class="${TASK_CONTENT_WIDTH_CLASS} @container"`);
    expect(html.indexOf('data-testid="interaction-region"')).toBeLessThan(
      html.indexOf('data-testid="interaction-panel"')
    );
    // 面板本体复用 composer-card 卡片形态：rounded-2xl 浮卡带边框阴影，
    // 高度上限 65vh 随内容增加；不再是 border-t 全宽条带。
    const panel =
      html.match(/<section[^>]*data-testid="interaction-panel"[^>]*>/)?.[0] ??
      "";
    expect(panel).toContain("rounded-2xl");
    expect(panel).toContain("shadow-lg");
    expect(panel).toContain("max-h-[65vh]");
    expect(panel).not.toContain("border-t");
  });
});
