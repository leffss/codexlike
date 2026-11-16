import { describe, expect, it } from "vitest";

import { subagentExportMarkdown } from "../src/lib/subagent-export";
import type { SubagentSegment } from "../src/lib/task-view";

/**
 * 子代理导出 Markdown（ADR 0021 票 04）：逐轮正文与思考结构离线归档。
 * Seam：subagentExportMarkdown 纯函数（SubagentSegment → Markdown 文本）。
 */
function seg(overrides: Partial<SubagentSegment> = {}): SubagentSegment {
  return {
    kind: "subagent",
    id: "sa-1",
    seq: 1,
    turnId: "u1",
    responseId: null,
    toolCallId: "delegate-1",
    task: "调研折叠记忆约定",
    state: "done",
    startedAt: "2026-11-14T08:00:02.000Z",
    endedAt: "2026-11-14T08:00:30.000Z",
    report: "最终报告：已梳理",
    ok: true,
    tools: [],
    ...overrides,
  };
}

describe("subagentExportMarkdown（逐轮结构导出，票 04）", () => {
  it("完整过程：委派说明头 + 状态/起止 + 逐轮思考与正文 + 最终报告", () => {
    const markdown = subagentExportMarkdown(
      seg({
        turns: [
          { reasoning: "第一轮思考", content: "第一轮正文" },
          { content: "最终报告：已梳理" },
        ],
      })
    );
    expect(markdown).toContain("# 子代理：调研折叠记忆约定");
    // 状态文案与右栏徽章同源（lib/subagent-status）
    expect(markdown).toContain("状态：完成");
    expect(markdown).toContain("开始：2026-11-14T08:00:02.000Z");
    expect(markdown).toContain("完成：2026-11-14T08:00:30.000Z");
    // 逐轮结构：轮标题 + 思考/正文小节（无思考的轮省略思考小节）
    expect(markdown).toContain("### 第 1 轮");
    expect(markdown).toContain("#### 思考\n\n第一轮思考");
    expect(markdown).toContain("#### 正文\n\n第一轮正文");
    expect(markdown).toContain("### 第 2 轮");
    // 最终报告独立收尾（报告原文完整）
    expect(markdown).toContain("## 最终报告\n\n最终报告：已梳理");
  });

  it("interrupted：状态留痕、无最终报告段，已发生逐轮内容照录", () => {
    const markdown = subagentExportMarkdown(
      seg({
        state: "interrupted",
        endedAt: "2026-11-14T08:00:09.000Z",
        report: null,
        ok: false,
        turns: [{ content: "中断前已写出的部分正文" }],
      })
    );
    expect(markdown).toContain("状态：运行中被中断");
    expect(markdown).toContain("#### 正文\n\n中断前已写出的部分正文");
    expect(markdown).not.toContain("## 最终报告");
  });

  it("失败委派：状态「失败」，中文原因随最终报告段照录", () => {
    const markdown = subagentExportMarkdown(
      seg({
        ok: false,
        report: "子代理执行失败：API 429",
        turns: [{ content: "失败前的过程正文" }],
      })
    );
    expect(markdown).toContain("状态：失败");
    expect(markdown).toContain("## 最终报告\n\n子代理执行失败：API 429");
  });

  it("旧记录（无逐轮数据）：回退纯报告导出（现行为不变）", () => {
    const markdown = subagentExportMarkdown(
      seg({ turns: undefined, reasoning: "旧记录拼接的思考" })
    );
    expect(markdown).toContain("# 子代理：调研折叠记忆约定");
    expect(markdown).toContain("最终报告：已梳理");
    expect(markdown).not.toContain("逐轮记录");
    expect(markdown).not.toContain("旧记录拼接的思考");
  });
});
