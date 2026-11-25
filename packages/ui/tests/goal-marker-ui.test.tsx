import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageStream } from "../src/components/MessageStream";
import type { GoalVerificationRecord } from "@codexlike/agent-core";
import {
  initialTranscript,
  type GoalVerificationSegment,
  type MessageSegment,
} from "../src/lib/task-view";

/**
 * 完成判定标记行（ADR 0035，GLOSSARY「完成判定」）：目标模式每轮判定在
 * 消息流原位留一行「第 N 次迭代 · 验证中 / 已完成 / 未完成 / 判定不可用」。
 * Seam：renderToStaticMarkup（存在性与文案）；恢复路径经 initialTranscript。
 */

function user(id: string, turnId: string, content: string): MessageSegment {
  return {
    kind: "user",
    id,
    seq: 0,
    turnId,
    responseId: null,
    content,
  };
}

function assistant(
  id: string,
  turnId: string,
  content: string
): MessageSegment {
  return {
    kind: "assistant",
    id,
    seq: 0,
    turnId,
    responseId: id,
    content,
  };
}

function record(
  id: string,
  round: number,
  outcome: GoalVerificationRecord["outcome"]
): GoalVerificationRecord {
  return {
    id,
    taskId: "goal-task",
    goalId: "goal-1",
    round,
    passed: outcome === "passed",
    outcome,
    reason:
      outcome === "passed"
        ? "示例测试已全部通过"
        : outcome === "unpassed"
          ? "尚有步骤未完成"
          : "完成判定不可用（HTTP 401），本轮没有判定结论",
    nextAction: outcome === "unpassed" ? "继续实现剩余步骤" : "",
    toolActivity: outcome !== "passed",
    createdAt: `2026-11-25T08:00:0${round + 1}.000Z`,
  };
}

function verification(
  id: string,
  round: number,
  outcome: GoalVerificationRecord["outcome"]
): GoalVerificationSegment {
  return {
    kind: "goal-verification",
    id,
    seq: 0,
    turnId: "u1",
    responseId: null,
    verification: record(id, round, outcome),
  };
}

/** 「验证中」占位行（判定在途、尚无结论） */
function verifying(round: number): GoalVerificationSegment {
  return {
    kind: "goal-verification",
    id: `goal-verifying-goal-1-${round}`,
    seq: 0,
    turnId: "u1",
    responseId: null,
    pending: { goalId: "goal-1", round },
  };
}

/** 渲染消息流并去掉 React 静态标记里的相邻文本分隔注释 */
function streamOf(items: MessageSegment[]): string {
  return renderToStaticMarkup(
    createElement(MessageStream, { items, taskId: "goal-task" })
  ).replace(/<!-- -->/g, "");
}

/** 按前缀取出某种标记行的可见文本序列 */
function markers(html: string, testId: string): string[] {
  return [
    ...html.matchAll(
      new RegExp(`<li[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</li>`, "g")
    ),
  ].map((match) => match[1]!.replace(/<[^>]+>/g, ""));
}

describe("完成判定标记行", () => {
  it("判定通过：当轮回复之后出现一行「第 1 次迭代 · 已完成」，不渲染成工具卡或气泡", () => {
    const html = streamOf([
      user("u1", "u1", "让示例测试全部通过"),
      assistant("a1", "u1", "示例测试已全部通过。"),
      verification("gv-1", 1, "passed"),
    ]);

    expect(markers(html, "goal-verification-marker")).toEqual([
      "第 1 次迭代 · 已完成",
    ]);
    expect(html).toContain('data-goal-verdict="passed"');
    expect(html).toContain('data-goal-round="1"');
    expect(html).not.toContain('data-testid="tool-call-card"');
    // 标记行排在当轮回复之后
    expect(html.indexOf("示例测试已全部通过。")).toBeLessThan(
      html.indexOf("goal-verification-marker")
    );
  });

  it("验证中：判定在途时原位是「第 N 次迭代 · 验证中」占位行（与结论行是同一行）", () => {
    const html = streamOf([
      user("u1", "u1", "让示例测试全部通过"),
      assistant("a1", "u1", "做了一部分。"),
      verifying(1),
    ]);

    expect(markers(html, "goal-verifying-marker")).toEqual([
      "第 1 次迭代 · 验证中",
    ]);
    expect(html).not.toContain("goal-verification-marker");
  });

  it("判定未通过：「第 N 次迭代 · 未完成」并附下一步方向一句摘要", () => {
    const html = streamOf([
      user("u1", "u1", "让示例测试全部通过"),
      assistant("a1", "u1", "做了一部分。"),
      verification("gv-3", 3, "unpassed"),
    ]);

    expect(markers(html, "goal-verification-marker")).toEqual([
      "第 3 次迭代 · 未完成 · 下一步：继续实现剩余步骤",
    ]);
    expect(html).toContain('data-goal-verdict="unpassed"');
    expect(html).toContain('data-testid="goal-verification-next-step"');
  });

  it("判定不可用：如实写「判定不可用」（原因可悬停查看），不显示成普通「未完成」", () => {
    const html = streamOf([
      user("u1", "u1", "让示例测试全部通过"),
      assistant("a1", "u1", "做了一部分。"),
      verification("gv-2", 2, "unavailable"),
    ]);

    expect(markers(html, "goal-verification-marker")).toEqual([
      "第 2 次迭代 · 判定不可用",
    ]);
    expect(html).toContain('data-goal-verdict="unavailable"');
    expect(html).toContain("HTTP 401");
    expect(html).not.toContain("未完成");
  });

  it("多轮判定各留一行，按时间顺序排列", () => {
    const html = streamOf([
      user("u1", "u1", "让示例测试全部通过"),
      assistant("a1", "u1", "第一轮。"),
      verification("gv-1", 1, "unpassed"),
      assistant("a2", "u1", "第二轮。"),
      verification("gv-2", 2, "passed"),
    ]);

    expect(markers(html, "goal-verification-marker")).toEqual([
      "第 1 次迭代 · 未完成 · 下一步：继续实现剩余步骤",
      "第 2 次迭代 · 已完成",
    ]);
  });

  it("重启恢复：任务时间线里的验证记录重建为同形标记行", () => {
    const html = streamOf(
      initialTranscript([
        {
          kind: "message",
          message: {
            id: "u1",
            taskId: "goal-task",
            role: "user",
            content: "让示例测试全部通过",
            createdAt: "2026-11-25T08:00:00.000Z",
          },
        },
        {
          kind: "message",
          message: {
            id: "a1",
            taskId: "goal-task",
            role: "assistant",
            content: "示例测试已全部通过。",
            createdAt: "2026-11-25T08:00:05.000Z",
          },
        },
        {
          kind: "goal-verification",
          verification: record("gv-1", 1, "passed"),
        },
      ])
    );

    expect(markers(html, "goal-verification-marker")).toEqual([
      "第 1 次迭代 · 已完成",
    ]);
    // 占位行不落库：重启后不会出现「验证中」
    expect(html).not.toContain("goal-verifying-marker");
  });

  it("没有判定的消息流不出现标记行", () => {
    const html = streamOf([
      user("u1", "u1", "普通任务"),
      assistant("a1", "u1", "普通回复"),
    ]);

    expect(html).not.toContain("goal-verification-marker");
    expect(html).not.toContain("goal-verifying-marker");
  });
});
