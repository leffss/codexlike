import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageStream } from "../src/components/MessageStream";
import type { GoalVerificationRecord } from "@codexlike/agent-core";
import { initialTranscript, type MessageSegment } from "../src/lib/task-view";

/**
 * 完成判定标记行（ADR 0035，GLOSSARY「完成判定」）：目标模式每轮判定在
 * 消息流原位留一行「第 N 次迭代 · 已完成 / 未完成」。
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

function verification(
  id: string,
  round: number,
  passed: boolean
): MessageSegment {
  return {
    kind: "goal-verification",
    id,
    seq: 0,
    turnId: "u1",
    responseId: null,
    verification: {
      id,
      taskId: "goal-task",
      goalId: "goal-1",
      round,
      passed,
      reason: passed ? "示例测试已全部通过" : "尚有步骤未完成",
      nextAction: passed ? "" : "继续实现剩余步骤",
      createdAt: "2026-11-25T08:00:09.000Z",
    },
  };
}

function record(id: string, round: number, passed: boolean) {
  const segment = verification(id, round, passed);
  if (segment.kind !== "goal-verification")
    throw new Error("测试夹具应构造出验证记录段");
  return {
    kind: "goal-verification" as const,
    verification: segment.verification as GoalVerificationRecord,
  };
}

/** 渲染消息流并去掉 React 静态标记里的相邻文本分隔注释 */
function streamOf(items: MessageSegment[]): string {
  return renderToStaticMarkup(
    createElement(MessageStream, { items, taskId: "goal-task" })
  ).replace(/<!-- -->/g, "");
}

function markers(html: string): string[] {
  return [
    ...html.matchAll(
      /<li[^>]*data-testid="goal-verification-marker"[^>]*>([\s\S]*?)<\/li>/g
    ),
  ].map((match) => match[1]!.replace(/<[^>]+>/g, ""));
}

describe("完成判定标记行", () => {
  it("判定通过：当轮回复之后出现一行「第 1 次迭代 · 已完成」，不渲染成工具卡或气泡", () => {
    const html = streamOf([
      user("u1", "u1", "让示例测试全部通过"),
      assistant("a1", "u1", "示例测试已全部通过。"),
      verification("gv-1", 1, true),
    ]);

    expect(markers(html)).toEqual(["第 1 次迭代 · 已完成"]);
    expect(html).toContain('data-goal-verdict="passed"');
    expect(html).toContain('data-goal-round="1"');
    expect(html).not.toContain('data-testid="tool-call-card"');
    // 标记行排在当轮回复之后
    expect(html.indexOf("示例测试已全部通过。")).toBeLessThan(
      html.indexOf("goal-verification-marker")
    );
  });

  it("判定未通过：「第 N 次迭代 · 未完成」", () => {
    const html = streamOf([
      user("u1", "u1", "让示例测试全部通过"),
      assistant("a1", "u1", "做了一部分。"),
      verification("gv-3", 3, false),
    ]);

    expect(markers(html)).toEqual(["第 3 次迭代 · 未完成"]);
    expect(html).toContain('data-goal-verdict="unpassed"');
  });

  it("多轮判定各留一行，按时间顺序排列", () => {
    const html = streamOf([
      user("u1", "u1", "让示例测试全部通过"),
      assistant("a1", "u1", "第一轮。"),
      verification("gv-1", 1, false),
      assistant("a2", "u1", "第二轮。"),
      verification("gv-2", 2, true),
    ]);

    expect(markers(html)).toEqual([
      "第 1 次迭代 · 未完成",
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
        record("gv-1", 1, true),
      ])
    );

    expect(markers(html)).toEqual(["第 1 次迭代 · 已完成"]);
  });

  it("没有判定的消息流不出现标记行", () => {
    const html = streamOf([
      user("u1", "u1", "普通任务"),
      assistant("a1", "u1", "普通回复"),
    ]);

    expect(html).not.toContain("goal-verification-marker");
  });
});
