import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());

import { MessageStream } from "../src/components/MessageStream";
import { setRememberedOpen } from "../src/lib/collapse-memory";
import type { AssistantSegment, MessageSegment } from "../src/lib/task-view";

function assistant(
  overrides: Partial<AssistantSegment> = {}
): AssistantSegment {
  return {
    kind: "assistant",
    id: "final",
    seq: 2,
    turnId: "actions-turn",
    responseId: "response",
    content: "**最终正文**",
    ...overrides,
  };
}

function render(items: MessageSegment[], streaming = false): string {
  return renderToStaticMarkup(
    createElement(MessageStream, {
      items,
      streaming,
      taskId: "actions-task",
    })
  );
}

describe("最终正文操作栏（静态渲染 seam，点击与剪贴板由桌面 E2E 验证）", () => {
  it("复制入口是有明确名称的 28px 图标按钮，装饰 SVG 不进入无障碍树", () => {
    const html = render([assistant()]);
    const button = html.match(
      /<button[^>]*data-testid="assistant-copy"[^>]*>[\s\S]*?<\/button>/
    )?.[0];
    expect(button).toContain('aria-label="复制"');
    expect(button).toContain('title="复制"');
    expect(button).toContain("h-7 w-7");
    expect(button).toContain("border border-line bg-surface-muted");
    expect(button).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(button).not.toContain(">复制<");
    expect(html).toMatch(
      /<span[^>]*data-testid="assistant-copy-feedback"[^>]*class="sr-only"/
    );
  });

  it.each(["正文流式", "宿主仍运行", "工具仍运行"])(
    "%s时不显示操作栏，即使较早正文已去除 streaming",
    (phase) => {
      const items: MessageSegment[] = [
        assistant({
          streaming: phase === "正文流式",
          completedAt: Date.UTC(2026, 10, 11),
        }),
      ];
      if (phase === "工具仍运行")
        items.push({
          kind: "tool-call",
          id: "tool",
          seq: 3,
          turnId: "actions-turn",
          responseId: "response",
          taskId: "s",
          toolName: "read_file",
          arguments: "{}",
          output: "",
          isError: false,
          running: true,
        });
      const html = render(items, phase === "宿主仍运行");
      expect(html).not.toContain('data-testid="assistant-actions"');
      expect(html).not.toContain("完成于");
    }
  );

  it("新轮运行不隐藏旧轮结果操作栏，非正文消息不生成复制入口", () => {
    const html = render(
      [
        assistant({
          turnId: "previous-turn",
          completedAt: Date.UTC(2026, 10, 11),
        }),
        {
          kind: "user",
          id: "next-turn",
          seq: 3,
          turnId: "next-turn",
          responseId: null,
          content: "继续",
        },
        {
          kind: "status",
          id: "status",
          seq: 4,
          turnId: "next-turn",
          responseId: null,
          content: "处理中",
        },
      ],
      true
    );
    expect(html.match(/data-testid="assistant-copy"/g)).toHaveLength(1);
    expect(html.match(/data-testid="assistant-completed-at"/g)).toHaveLength(1);
    expect(html).toContain(
      'role="status" aria-live="polite" aria-atomic="true"'
    );
  });

  it("多段中断旧轮保持可复制且无完成时间，新轮运行隐藏操作栏、完成时间仅属新轮", () => {
    const interrupted: MessageSegment[] = [
      assistant({ id: "old-process", seq: 1, content: "工具前正文" }),
      {
        kind: "tool-call",
        id: "old-tool",
        seq: 2,
        turnId: "actions-turn",
        responseId: "response",
        taskId: "s",
        toolName: "read_file",
        arguments: "{}",
        output: "工具结果",
        isError: false,
        running: false,
      },
      assistant({
        id: "old-final",
        seq: 3,
        content: "工具后部分正文",
        interrupted: true,
      }),
    ];
    const nextUser: MessageSegment = {
      kind: "user",
      id: "next-turn",
      seq: 4,
      turnId: "next-turn",
      responseId: null,
      content: "继续",
    };
    const nextText = assistant({
      id: "next-final",
      seq: 5,
      turnId: "next-turn",
      responseId: "next-response",
      content: "新轮完整正文",
    });
    const completedAt = new Date(2026, 10, 11, 16, 1, 19).getTime();
    for (const phase of ["正文流式", "宿主仍运行", "正常完成"] as const) {
      const completed = phase === "正常完成";
      const html = render(
        [
          ...interrupted,
          nextUser,
          {
            ...nextText,
            streaming: phase === "正文流式",
            completedAt: completed ? completedAt : undefined,
          },
        ],
        !completed
      );
      const [oldTurn, newTurn] = html.split('data-turn-id="next-turn"');
      expect(newTurn).toBeDefined();
      expect(oldTurn).toContain("工具前正文");
      expect(oldTurn).toContain("工具后部分正文");
      expect(oldTurn?.match(/data-testid="assistant-copy"/g)).toHaveLength(1);
      expect(oldTurn).not.toContain('data-testid="assistant-completed-at"');
      expect(oldTurn).not.toContain("完成于");
      if (completed) {
        expect(newTurn?.match(/data-testid="assistant-copy"/g)).toHaveLength(1);
        expect(
          newTurn?.match(/data-testid="assistant-completed-at"/g)
        ).toHaveLength(1);
        expect(newTurn).toContain("2026-11-11 16:01:19");
        expect(newTurn).toContain(new Date(completedAt).toISOString());
        expect(newTurn).not.toContain("已中断");
      } else {
        expect(newTurn).not.toContain('data-testid="assistant-actions"');
        expect(newTurn).not.toContain("完成于");
      }
    }
  });

  it.each(["中断", "错误", "未知时间", "非法时间"])(
    "停止后的%s正文可复制，但不显示成功时间",
    (outcome) => {
      const items: MessageSegment[] = [
        assistant({
          interrupted: outcome === "中断",
          completedAt:
            outcome === "非法时间"
              ? Number.NaN
              : outcome === "未知时间"
                ? undefined
                : Date.UTC(2026, 10, 11),
        }),
      ];
      if (outcome === "错误")
        items.push({
          kind: "error",
          id: "error",
          seq: 3,
          turnId: "actions-turn",
          responseId: null,
          content: "请求失败",
        });
      const html = render(items);
      expect(html).toContain('data-testid="assistant-copy"');
      expect(html).not.toContain('data-testid="assistant-completed-at"');
    }
  );

  it("最终正文下方显示同日短时间与完整 title，展开过程正文不重复显示操作栏", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 11, 17));
    setRememberedOpen("history-actions-turn", true);
    const html = render([
      assistant({
        id: "process",
        seq: 1,
        content: "过程正文",
        completedAt: Date.UTC(2026, 10, 10),
      }),
      assistant({ completedAt: new Date(2026, 10, 11, 16, 8, 9).getTime() }),
    ]);
    expect(html).toContain("过程正文");
    expect(html.match(/data-testid="assistant-actions"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="assistant-copy"');
    expect(html).toContain("复制");
    expect(html).toContain("完成于");
    expect(html).toContain('title="2026-11-11 16:08:09"');
    expect(html).toMatch(/<time[^>]*>16:08<\/time>/);
    expect(html).toContain(new Date(2026, 10, 11, 16, 8, 9).toISOString());
    expect(html).toMatch(/<time[^>]*dateTime="[^"]+"/i);
    expect(html.indexOf('data-testid="assistant-actions"')).toBeGreaterThan(
      html.indexOf("<strong>最终正文</strong>")
    );
  });
});
