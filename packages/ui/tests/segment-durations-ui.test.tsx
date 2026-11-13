import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageStream } from "../src/components/MessageStream";
import { setRememberedOpen } from "../src/lib/collapse-memory";
import type {
  AssistantSegment,
  MessageSegment,
  SubagentSegment,
  ThinkingSegment,
  ToolCallSegment,
  UserSegment,
} from "../src/lib/task-view";

/**
 * 过程段耗时呈现（spec 用户故事 26「实时跳动 + 最终定格」）：
 * 工具卡 / 子代理卡 / 思考块 / 中间正文段 / 工具组组头的耗时标记。
 * Seam：renderToStaticMarkup（定格值与标记存在性；跳动节拍由
 * useTickingNow 的 interval 驱动，静态渲染只断言首帧）。
 */

let nextSeq = 0;

function userSeg(): UserSegment {
  return {
    kind: "user",
    id: "u1",
    seq: ++nextSeq,
    turnId: "u1",
    responseId: null,
    content: "跑一下",
    at: 1_000,
  };
}

function toolSeg(
  id: string,
  overrides: Partial<ToolCallSegment> = {}
): ToolCallSegment {
  return {
    kind: "tool-call",
    id,
    seq: ++nextSeq,
    turnId: "u1",
    responseId: null,
    at: 2_000,
    taskId: "s1",
    toolName: "read_file",
    arguments: '{"path":"a.txt"}',
    output: "输出",
    isError: false,
    running: false,
    ...overrides,
  };
}

function thinkingSeg(
  overrides: Partial<ThinkingSegment> = {}
): ThinkingSegment {
  return {
    kind: "thinking",
    id: "thinking-m1-1",
    seq: ++nextSeq,
    turnId: "u1",
    responseId: "m1",
    at: 1_500,
    content: "先看配置",
    ...overrides,
  };
}

function textSeg(
  id: string,
  overrides: Partial<AssistantSegment> = {}
): AssistantSegment {
  return {
    kind: "assistant",
    id,
    seq: ++nextSeq,
    turnId: "u1",
    responseId: "m1",
    at: 3_000,
    content: `正文 ${id}`,
    ...overrides,
  };
}

function subagentSeg(
  overrides: Partial<SubagentSegment> = {}
): SubagentSegment {
  return {
    kind: "subagent",
    id: "sa-1",
    seq: ++nextSeq,
    turnId: "u1",
    responseId: null,
    toolCallId: "delegate-1",
    task: "调研",
    state: "done",
    startedAt: "2026-11-12T08:00:00.000Z",
    endedAt: "2026-11-12T08:00:30.000Z",
    report: "报告",
    ok: true,
    tools: [],
    ...overrides,
  };
}

function streamOf(items: MessageSegment[]): string {
  return renderToStaticMarkup(
    createElement(MessageStream, { items, taskId: "s1" })
  );
}

describe("工具卡耗时：运行中跳动、完成定格、无打点省略", () => {
  it("完成态显示定格耗时（endedAt - startedAt）", () => {
    setRememberedOpen("history-u1", true);
    const html = streamOf([
      userSeg(),
      toolSeg("c1", { startedAt: 2_000, endedAt: 14_000 }),
    ]);
    expect(html).toContain('data-testid="tool-call-duration"');
    expect(html).toContain("12.0 秒");
  });

  it("运行中显示实时耗时（startedAt 起，首帧即有数字）", () => {
    const html = streamOf([
      userSeg(),
      toolSeg("c1", { running: true, startedAt: Date.now() - 3_000 }),
    ]);
    expect(html).toContain('data-testid="tool-call-duration"');
    expect(html).toMatch(/data-testid="tool-call-duration"[^<]*>[\d.]+ 秒/);
  });

  it("恢复的历史卡无 endedAt 打点：不显示耗时", () => {
    setRememberedOpen("history-u1", true);
    const html = streamOf([userSeg(), toolSeg("c1", { startedAt: 2_000 })]);
    expect(html).not.toContain('data-testid="tool-call-duration"');
  });
});

describe("思考块与中间正文段耗时：收敛定格", () => {
  it("思考收敛后摘要行显示定格耗时", () => {
    setRememberedOpen("history-u1", true);
    const html = streamOf([userSeg(), thinkingSeg({ endedAt: 4_500 })]);
    expect(html).toContain('data-testid="thinking-duration"');
    expect(html).toContain("3 秒");
  });

  it("中间正文段（无 completedAt）气泡下显示定格耗时，最终正文不显示", () => {
    setRememberedOpen("history-u1", true);
    const html = streamOf([
      userSeg(),
      textSeg("text-m1-1", { endedAt: 6_000 }),
      textSeg("text-m1-2", { completedAt: 9_000 }),
    ]);
    expect(html).toContain('data-testid="assistant-segment-duration"');
    expect(html.match(/assistant-segment-duration/g)?.length).toBe(1);
  });
});

describe("工具组与子代理卡耗时", () => {
  it("同名连续工具组组头显示跨度汇总（首段开始 → 末段结束）", () => {
    setRememberedOpen("history-u1", true);
    const html = streamOf([
      userSeg(),
      toolSeg("c1", { startedAt: 2_000, endedAt: 5_000 }),
      toolSeg("c2", { startedAt: 6_000, endedAt: 9_000 }),
    ]);
    expect(html).toContain('data-testid="tool-call-group"');
    expect(html).toContain('data-testid="tool-call-group-duration"');
    expect(html).toContain("7 秒");
  });

  it("子代理卡完成态显示定格总耗时（startedAt → endedAt）", () => {
    setRememberedOpen("history-u1", true);
    const html = streamOf([userSeg(), subagentSeg()]);
    expect(html).toContain('data-testid="subagent-elapsed"');
    expect(html).toContain("00:30");
  });

  it("恢复的完成态子代理卡无起止对：不显示耗时", () => {
    setRememberedOpen("history-u1", true);
    const html = streamOf([
      userSeg(),
      subagentSeg({ startedAt: null, endedAt: null }),
    ]);
    expect(html).not.toContain('data-testid="subagent-elapsed"');
  });
});

describe("流式指示唯一性（多转圈回归的呈现侧）", () => {
  it("已收敛的思考/正文段不再渲染 spinner：一轮至多末段正文一个转圈", () => {
    setRememberedOpen("history-u1", true);
    const html = streamOf([
      userSeg(),
      thinkingSeg({ endedAt: 2_500 }),
      textSeg("text-m1-1", { endedAt: 4_000 }),
      toolSeg("c1", { startedAt: 4_000, endedAt: 6_000, running: false }),
      textSeg("text-m1-2", { streaming: true }),
    ]);
    // 全序列仅最终流式正文段一个 generating-spinner
    expect(html.match(/generating-spinner/g)?.length).toBe(1);
  });
});
