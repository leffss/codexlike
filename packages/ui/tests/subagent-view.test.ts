import { describe, expect, it } from "vitest";

import type { TaskEvent, ToolCallRecord } from "@codexlike/agent-core";

import {
  applyTaskEvent,
  initialTranscript,
  type MessageSegment,
} from "../src/lib/task-view";

/**
 * 子代理段（GLOSSARY「子代理」「消息段」）：主序列成员 + 卡内嵌套进度。
 * Seam：applyTaskEvent 纯函数（流式事件 → MessageSegment[]）与
 * initialTranscript（重启恢复）。
 */
function toolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "call-1",
    sessionId: "task-1",
    toolName: "read_file",
    arguments: '{"path":"a.txt"}',
    output: "ok",
    isError: false,
    createdAt: "2026-11-11T08:00:01.000Z",
    ...overrides,
  };
}

function kinds(items: MessageSegment[]): string[] {
  return items.map((item) => item.kind);
}

describe("task-view 子代理段归并", () => {
  it("queued → start → 工具进度 → report 全链路：卡状态与字段正确迁移", () => {
    let items: MessageSegment[] = [];
    const apply = (event: TaskEvent) => {
      items = applyTaskEvent(items, event);
    };

    apply({ type: "subagent-queued", subagentId: "sa-1", task: "调研 vitest" });
    apply({ type: "subagent-queued", subagentId: "sa-2", task: "调研 pnpm" });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "subagent",
      id: "sa-1",
      task: "调研 vitest",
      state: "queued",
      toolCallId: "",
      tools: [],
    });

    // start：toolCallId 到位（报告回流匹配键）、进入运行态
    apply({
      type: "subagent-start",
      subagentId: "sa-1",
      task: "调研 vitest",
      toolCallId: "delegate-1",
    });
    expect(items[0]).toMatchObject({
      state: "running",
      toolCallId: "delegate-1",
    });

    // 子代理内部工具进度（卡内嵌套，不是主序列成员）：call（运行中）→ result（完成）
    apply({
      type: "subagent-tool",
      subagentId: "sa-1",
      phase: "call",
      call: toolCall({ id: "sub-c1", toolName: "glob", output: "" }),
    });
    apply({
      type: "subagent-tool",
      subagentId: "sa-1",
      phase: "result",
      call: toolCall({ id: "sub-c1", toolName: "glob", output: "a.txt" }),
    });
    const card = items[0];
    if (card?.kind !== "subagent") throw new Error("首段应为子代理段");
    expect(card.tools).toHaveLength(1);
    expect(card.tools[0]).toMatchObject({
      id: "sub-c1",
      toolName: "glob",
      output: "a.txt",
      running: false,
    });

    // 报告到达：完成态、报告全文、ok 标记
    apply({
      type: "subagent-report",
      subagentId: "sa-1",
      task: "调研 vitest",
      report: "调研报告：vitest 5.1",
      ok: true,
    });
    expect(items[0]).toMatchObject({
      state: "done",
      report: "调研报告：vitest 5.1",
      ok: true,
    });
    // 其它子代理不受影响
    expect(items[1]).toMatchObject({ id: "sa-2", state: "queued" });
  });

  it("子代理卡作为消息段按时序出现在主序列：user → 子代理卡 → 后续正文", () => {
    let items = applyTaskEvent([], {
      type: "user-message",
      message: {
        id: "u1",
        sessionId: "s1",
        role: "user",
        content: "委派调研",
        createdAt: "2026-11-11T08:00:00Z",
      },
    });
    items = applyTaskEvent(items, {
      type: "subagent-queued",
      subagentId: "sa-1",
      task: "调研 vitest",
    });
    items = applyTaskEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "已派出子代理，先说明计划",
    });
    expect(kinds(items)).toEqual(["user", "subagent", "assistant"]);
    expect(items[1]).toMatchObject({ id: "sa-1", turnId: "u1" });
    expect(items[2]).toMatchObject({ responseId: "a1", turnId: "u1" });
  });

  it("spawn_subagent 的 tool-call 事件不渲染普通工具卡（子代理段代替）", () => {
    const items = applyTaskEvent([], {
      type: "tool-call",
      call: toolCall({
        id: "delegate-1",
        toolName: "spawn_subagent",
        arguments: '{"task":"x"}',
      }),
    });
    expect(items).toHaveLength(0);
  });

  it("spawn_subagent 的 tool-result 按 toolCallId 回填子代理段报告（流式路径兜底）", () => {
    let items = applyTaskEvent([], {
      type: "subagent-queued",
      subagentId: "sa-1",
      task: "x",
    });
    items = applyTaskEvent(items, {
      type: "subagent-start",
      subagentId: "sa-1",
      task: "x",
      toolCallId: "delegate-1",
    });
    items = applyTaskEvent(items, {
      type: "tool-result",
      call: toolCall({
        id: "delegate-1",
        toolName: "spawn_subagent",
        output: "最终报告内容",
      }),
    });
    expect(items[0]).toMatchObject({
      kind: "subagent",
      state: "done",
      report: "最终报告内容",
    });
  });

  it("重启恢复：transcript 中的 spawn_subagent 记录渲染为完成态子代理段（task + 报告）", () => {
    const items = initialTranscript([
      {
        kind: "tool-call",
        call: toolCall({
          id: "delegate-9",
          toolName: "spawn_subagent",
          arguments: '{"task":"调研依赖版本"}',
          output: "报告：全部依赖为最新",
        }),
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "subagent",
      state: "done",
      task: "调研依赖版本",
      report: "报告：全部依赖为最新",
      ok: true,
      tools: [],
    });
  });
});

/** 思考档位 03：子代理 reasoning 归并（卡内独立折叠思考，并发不串流） */
describe("task-view 子代理思考归并（subagent-reasoning）", () => {
  it("reasoning 增量累积到所属子代理卡，与报告分离，不串流到其他子代理", () => {
    let items: MessageSegment[] = [];
    const apply = (event: TaskEvent) => {
      items = applyTaskEvent(items, event);
    };

    apply({ type: "subagent-queued", subagentId: "sa-1", task: "调研 vitest" });
    apply({ type: "subagent-queued", subagentId: "sa-2", task: "调研 pnpm" });
    apply({
      type: "subagent-start",
      subagentId: "sa-1",
      task: "调研 vitest",
      toolCallId: "delegate-1",
    });
    apply({
      type: "subagent-start",
      subagentId: "sa-2",
      task: "调研 pnpm",
      toolCallId: "delegate-2",
    });
    apply({
      type: "subagent-reasoning",
      subagentId: "sa-1",
      delta: "子代理1的思考",
    });
    apply({
      type: "subagent-reasoning",
      subagentId: "sa-2",
      delta: "子代理2的思考",
    });
    apply({ type: "subagent-reasoning", subagentId: "sa-1", delta: "，继续" });

    expect(items[0]).toMatchObject({
      kind: "subagent",
      id: "sa-1",
      reasoning: "子代理1的思考，继续",
    });
    expect(items[1]).toMatchObject({
      kind: "subagent",
      id: "sa-2",
      reasoning: "子代理2的思考",
    });

    // 报告到达：reasoning 保留（运行期展示），报告与思考分离
    apply({
      type: "subagent-report",
      subagentId: "sa-1",
      task: "调研 vitest",
      report: "调研报告正文",
      ok: true,
    });
    expect(items[0]).toMatchObject({
      state: "done",
      report: "调研报告正文",
      reasoning: "子代理1的思考，继续",
    });
    expect(items[0]).not.toMatchObject({
      report: expect.stringContaining("思考"),
    });
  });

  it("未知 subagentId 的 reasoning 事件被忽略（会话切换后迟到的事件）", () => {
    let items = applyTaskEvent([], {
      type: "assistant-delta",
      messageId: "a1",
      delta: "正文",
    });
    items = applyTaskEvent(items, {
      type: "subagent-reasoning",
      subagentId: "sa-gone",
      delta: "迟到的思考",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", content: "正文" });
    const card = items[0];
    if (card?.kind !== "subagent") return;
    expect(card.reasoning).toBeUndefined();
  });

  it("主会话思考进序列 thinking 段、子代理思考进卡内（主/子思考互不串流）", () => {
    let items = applyTaskEvent([], {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applyTaskEvent(items, {
      type: "subagent-queued",
      subagentId: "sa-1",
      task: "x",
    });
    items = applyTaskEvent(items, {
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "主会话思考",
    });
    items = applyTaskEvent(items, {
      type: "subagent-reasoning",
      subagentId: "sa-1",
      delta: "子代理思考",
    });
    expect(kinds(items)).toEqual(["subagent", "thinking"]);
    expect(items[1]).toMatchObject({
      kind: "thinking",
      content: "主会话思考",
      responseId: "a1",
    });
    expect(items[0]).toMatchObject({
      kind: "subagent",
      reasoning: "子代理思考",
    });
  });
});
