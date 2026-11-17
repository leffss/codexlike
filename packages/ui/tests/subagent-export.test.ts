import { describe, expect, it } from "vitest";

import { subagentExportMarkdown } from "../src/lib/subagent-export";
import type { SubagentSegment, SubagentToolCall } from "../src/lib/task-view";

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

/** 子代理 update_plan 工具调用样例（ADR 0023：计划状态即工具调用记录） */
function planTool(
  id: string,
  steps: { content: string; status: string }[]
): SubagentToolCall {
  return {
    id,
    taskId: "s1",
    toolName: "update_plan",
    arguments: JSON.stringify({ steps }),
    output: "工作计划已更新",
    isError: false,
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

  it("工作计划终态段（票 03）：最后一次 update_plan 完整清单三态回看，位于最终报告之前", () => {
    const markdown = subagentExportMarkdown(
      seg({
        tools: [
          planTool("sub-p1", [
            { content: "调研折叠记忆约定", status: "in_progress" },
            { content: "梳理开合键约定", status: "pending" },
          ]),
          planTool("sub-p2", [
            { content: "调研折叠记忆约定", status: "completed" },
            { content: "梳理开合键约定", status: "in_progress" },
            { content: "汇总成文", status: "pending" },
          ]),
        ],
        turns: [{ content: "过程正文" }],
      })
    );
    // 终态 = 最后一次 update_plan（全量替换语义）：统计行 + 三态清单
    expect(markdown).toContain("## 工作计划");
    expect(markdown).toContain("共 3 项：1 已完成、1 进行中、1 待办");
    expect(markdown).toContain("- 已完成：调研折叠记忆约定");
    expect(markdown).toContain("- 进行中：梳理开合键约定");
    expect(markdown).toContain("- 待办：汇总成文");
    // 段序：逐轮记录之后、最终报告之前
    expect(markdown.indexOf("## 工作计划")).toBeGreaterThan(
      markdown.indexOf("### 第 1 轮")
    );
    expect(markdown.indexOf("## 工作计划")).toBeLessThan(
      markdown.indexOf("## 最终报告")
    );
  });

  it("无计划（无 update_plan 调用）：导出不含工作计划段", () => {
    const markdown = subagentExportMarkdown(
      seg({
        tools: [
          {
            id: "sub-t1",
            taskId: "s1",
            toolName: "read_file",
            arguments: '{"path":"a.ts"}',
            output: "内容",
            isError: false,
          },
        ],
        turns: [{ content: "过程正文" }],
      })
    );
    expect(markdown).toContain("## 最终报告");
    expect(markdown).not.toContain("## 工作计划");
  });

  it("旧记录（无逐轮数据）：回退纯报告导出（现行为不变）", () => {
    const markdown = subagentExportMarkdown(
      seg({ turns: undefined, reasoning: "旧记录拼接的思考" })
    );
    expect(markdown).toContain("# 子代理：调研折叠记忆约定");
    expect(markdown).toContain("最终报告：已梳理");
    expect(markdown).not.toContain("逐轮记录");
    expect(markdown).not.toContain("旧记录拼接的思考");
    // 旧记录（本特性落地前）无 update_plan 调用：同样不含工作计划段
    expect(markdown).not.toContain("## 工作计划");
  });
});
