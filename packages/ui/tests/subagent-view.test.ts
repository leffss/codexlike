import { describe, expect, it } from "vitest";

import type { SessionEvent, ToolCallRecord } from "@codexlike/agent-core";

import {
  applySessionEvent,
  initialTranscript,
  type UiItem,
} from "../src/lib/session-view";

/**
 * 工单 13：子代理嵌套卡片的状态归并（GLOSSARY「子代理」）。
 * Seam：applySessionEvent 纯函数（流式事件 → UiItem[]）与 initialTranscript（重启恢复）。
 */
function toolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "call-1",
    sessionId: "session-1",
    toolName: "read_file",
    arguments: '{"path":"a.txt"}',
    output: "ok",
    isError: false,
    createdAt: "2026-11-11T08:00:01.000Z",
    ...overrides,
  };
}

describe("session-view 子代理归并", () => {
  it("queued → start → 工具进度 → report 全链路：嵌套卡片状态与字段正确迁移", () => {
    let items: UiItem[] = [];
    const apply = (event: SessionEvent) => {
      items = applySessionEvent(items, event);
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

    // 子代理内部工具进度：call（运行中）→ result（完成）
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
    const card = items[0] as Extract<UiItem, { kind: "subagent" }>;
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

  it("spawn_subagent 的 tool-call 事件不渲染普通工具卡片（嵌套卡片代替）", () => {
    let items: UiItem[] = [];
    items = applySessionEvent(items, {
      type: "tool-call",
      call: toolCall({
        id: "delegate-1",
        toolName: "spawn_subagent",
        arguments: '{"task":"x"}',
      }),
    });
    expect(items).toHaveLength(0);
  });

  it("spawn_subagent 的 tool-result 按 toolCallId 回填嵌套卡片报告（流式路径兜底）", () => {
    let items: UiItem[] = [];
    items = applySessionEvent(items, {
      type: "subagent-queued",
      subagentId: "sa-1",
      task: "x",
    });
    items = applySessionEvent(items, {
      type: "subagent-start",
      subagentId: "sa-1",
      task: "x",
      toolCallId: "delegate-1",
    });
    items = applySessionEvent(items, {
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

  it("重启恢复：transcript 中的 spawn_subagent 记录渲染为完成态嵌套卡片（task + 报告）", () => {
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

/** 思考档位 03：子代理 reasoning 事件归并（独立折叠思考块，并发不串流） */
describe("session-view 子代理思考归并（subagent-reasoning）", () => {
  it("reasoning 增量累积到所属子代理卡片，与报告分离，不串流到其他子代理", () => {
    let items: UiItem[] = [];
    const apply = (event: SessionEvent) => {
      items = applySessionEvent(items, event);
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
    let items: UiItem[] = [{ id: "m1", role: "assistant", content: "正文" }];
    items = applySessionEvent(items, {
      type: "subagent-reasoning",
      subagentId: "sa-gone",
      delta: "迟到的思考",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("reasoning");
  });

  it("reasoning 不混入主会话助手消息（主/子思考互不串流）", () => {
    let items: UiItem[] = [
      { id: "a1", role: "assistant", content: "", streaming: true },
    ];
    items = applySessionEvent(items, {
      type: "subagent-reasoning",
      subagentId: "sa-1",
      delta: "子代理思考不应进入主消息",
    });
    expect(items[0]).toMatchObject({ id: "a1", content: "" });
    expect((items[0] as { reasoning?: string }).reasoning).toBeUndefined();
  });

  it("历史加载不重建子代理思考块（重启恢复卡片无 reasoning）", () => {
    const items = initialTranscript([
      {
        kind: "tool-call",
        call: toolCall({
          id: "delegate-9",
          toolName: "spawn_subagent",
          arguments: '{"task":"x"}',
          output: "报告",
        }),
      },
    ]);
    expect((items[0] as { reasoning?: string }).reasoning).toBeUndefined();
  });
});
