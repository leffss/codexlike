import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageStream } from "../src/components/MessageStream";
import { SubagentCard } from "../src/components/SubagentCard";
import { setRememberedOpen } from "../src/lib/collapse-memory";
import type {
  MessageSegment,
  SubagentSegment,
  ThinkingSegment,
} from "../src/lib/task-view";

/**
 * 思考块开合默认值（呈现层内存态 + collapse-memory）：
 * 流式进行中默认展开（实时可见）、思考结束自动收起、
 * 收起态摘要行回看；收起态内容仍留在 DOM（e2e 以 textContent 回读全文）。
 * Seam：renderToStaticMarkup（默认值与首帧标记；点击交互由 e2e 覆盖）。
 */

function thinking(overrides: Partial<ThinkingSegment> = {}): ThinkingSegment {
  return {
    kind: "thinking",
    id: "thinking-m1-1",
    seq: 2,
    turnId: "u1",
    responseId: "m1",
    at: 1_760_000_000_000,
    content: "先读 vite 配置，\n再数入口与依赖边界",
    ...overrides,
  };
}

function streamOf(items: MessageSegment[]): string {
  return renderToStaticMarkup(
    createElement(MessageStream, { items, taskId: "s1" })
  );
}

/** 思考块 details 的开合标记：open 属性存在即展开 */
function blockMarkup(html: string, testid: string): string {
  const open = html.match(
    new RegExp(`<details[^>]*data-testid="${testid}"[^>]*>`)
  )?.[0];
  if (open === undefined) throw new Error(`未找到 ${testid}`);
  return open;
}

describe("思考块：流式展开 / 完成自动折叠 / 摘要行", () => {
  it("流式进行中默认展开：open 属性、思考中指示器与状态文案", () => {
    const html = streamOf([thinking({ streaming: true })]);
    const block = blockMarkup(html, "thinking-block");
    expect(block).toContain('open=""');
    expect(html).toContain("思考中");
    // 运行提示统一收敛到消息流底部运行行后，思考卡不再内联转圈
    // （「思考中」靠文案与工时跳动表达；本用例未传宿主 streaming，无运行行）
    expect(html).not.toContain('data-testid="thinking-indicator"');
    expect(html.match(/generating-spinner/g)?.length ?? 0).toBe(0);
  });

  it("思考结束默认收起：无 open 属性、无指示器，摘要行显示首行摘要", () => {
    // 完成的轮次过程段默认收进「已工作折叠区」（票 04）：预置展开记忆
    // 让折叠区渲染内容，才观察得到思考块自身的收起态与摘要行
    setRememberedOpen("history-u1", true);
    const html = streamOf([thinking()]);
    const block = blockMarkup(html, "thinking-block");
    expect(block).not.toContain('open=""');
    expect(html).not.toContain('data-testid="thinking-indicator"');
    expect(html).toContain("已思考 · 先读 vite 配置，");
  });

  it("收起态内容仍在 DOM（textContent 可回读全文，e2e 依赖此语义）", () => {
    setRememberedOpen("history-u1", true);
    const html = streamOf([thinking()]);
    const content = html.match(
      /data-testid="thinking-content"[^>]*>((?:[^<]|<(?!\/div))*)/
    )?.[1];
    expect(content).toContain("先读 vite 配置，");
    expect(content).toContain("再数入口与依赖边界");
  });

  it("正文流式气泡不再内联转圈：流式指示统一到消息流底部运行行", () => {
    const html = streamOf([
      {
        kind: "assistant",
        id: "text-m1-1",
        seq: 3,
        turnId: "u1",
        responseId: "m1",
        content: "正在生成中的正文",
        streaming: true,
      },
    ]);
    expect(html).not.toContain('aria-label="正在生成"');
  });
});

describe("子代理卡内思考块：与主任务思考块同构", () => {
  function subagent(state: "running" | "done", id: string): SubagentSegment {
    return {
      kind: "subagent",
      id,
      seq: 2,
      turnId: "u1",
      responseId: null,
      toolCallId: "delegate-1",
      task: "调研测试基建",
      state,
      startedAt: state === "running" ? "2026-11-12T08:00:00.000Z" : null,
      endedAt: null,
      reasoning: "先看 vitest 配置，\n再数现有接缝",
      report: state === "done" ? "报告" : null,
      ok: state === "done" ? true : null,
      tools: [],
    };
  }

  it("运行中默认展开：open 属性，卡内不内联转圈", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentCard, { subagent: subagent("running", "sa-run") })
    );
    const block = blockMarkup(html, "subagent-thinking-block");
    expect(block).toContain('open=""');
    expect(html).not.toContain('data-testid="subagent-thinking-indicator"');
  });

  it("完成后默认收起：无 open 属性，摘要行显示首行摘要", () => {
    // 卡片报告区默认收起：预置展开记忆让 done 态内容渲染出来
    setRememberedOpen("subagent-sa-done", true);
    const html = renderToStaticMarkup(
      createElement(SubagentCard, { subagent: subagent("done", "sa-done") })
    );
    const block = blockMarkup(html, "subagent-thinking-block");
    expect(block).not.toContain('open=""');
    expect(html).not.toContain('data-testid="subagent-thinking-indicator"');
    expect(html).toContain("已思考 · 先看 vitest 配置，");
  });
});
