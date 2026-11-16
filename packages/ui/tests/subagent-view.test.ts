import { describe, expect, it } from "vitest";

import type {
  SubagentMessageRecord,
  SubagentSnapshot,
  SubagentToolCallRecord,
  TaskEvent,
  ToolCallRecord,
} from "@codexlike/agent-core";

import {
  applyTaskEvent,
  initialTranscript,
  type MessageSegment,
} from "../src/lib/task-view";

/**
 * 子代理段（GLOSSARY「子代理」「消息段」）：主序列成员 + 卡内嵌套进度。
 * Seam：applyTaskEvent 纯函数（流式事件 → MessageSegment[]）与
 * initialTranscript（重启恢复：并行 subagents 快照走新路径，无则回退
 * spawn_subagent 工具行反推旧路径，ADR 0021）。
 */
function toolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "call-1",
    taskId: "task-1",
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
        taskId: "s1",
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

/** 恢复新路径（ADR 0021 票 04）：并行 subagents 快照 → 过程重建 */
function snapshotMessage(
  overrides: Partial<SubagentMessageRecord> = {}
): SubagentMessageRecord {
  return {
    id: "sm-1",
    taskId: "task-1",
    subagentId: "sa-1",
    content: "轮正文",
    createdAt: "2026-11-14T08:00:05.000Z",
    ...overrides,
  };
}

function snapshotToolCall(
  overrides: Partial<SubagentToolCallRecord> = {}
): SubagentToolCallRecord {
  return {
    id: "st-1",
    taskId: "task-1",
    subagentId: "sa-1",
    toolName: "grep",
    arguments: '{"pattern":"useCollapseState"}',
    output: "collapse-memory.ts:36",
    isError: false,
    createdAt: "2026-11-14T08:00:07.000Z",
    ...overrides,
  };
}

function snapshot(overrides: {
  record?: Partial<SubagentSnapshot["record"]>;
  messages?: SubagentMessageRecord[];
  toolCalls?: SubagentToolCallRecord[];
}): SubagentSnapshot {
  return {
    record: {
      id: "sa-1",
      taskId: "task-1",
      task: "调研折叠记忆约定",
      status: "completed",
      queuedAt: "2026-11-14T08:00:01.000Z",
      startedAt: "2026-11-14T08:00:02.000Z",
      completedAt: "2026-11-14T08:00:30.000Z",
      ...overrides.record,
    },
    messages: overrides.messages ?? [],
    toolCalls: overrides.toolCalls ?? [],
  };
}

describe("task-view 恢复新路径（并行 subagents 快照，ADR 0021）", () => {
  it("快照命中 spawn 行：骨架 + 逐轮正文与思考 + 工具清单 + 起止时间完整重建", () => {
    const items = initialTranscript(
      [
        {
          kind: "tool-call",
          call: toolCall({
            id: "delegate-9",
            toolName: "spawn_subagent",
            arguments: '{"task":"调研折叠记忆约定"}',
            // 瘦身后的 spawn 行：output=报告、reasoning 不再拼接
            output: "最终报告：约定已梳理",
          }),
        },
      ],
      [
        snapshot({
          messages: [
            snapshotMessage({
              id: "sm-1",
              content: "第一轮先读源码",
              reasoning: "从 useCollapseState 入手",
            }),
            snapshotMessage({
              id: "sm-2",
              content: "最终报告：约定已梳理",
              createdAt: "2026-11-14T08:00:28.000Z",
            }),
          ],
          toolCalls: [
            snapshotToolCall({
              id: "st-1",
              toolName: "grep",
              isError: false,
            }),
            snapshotToolCall({
              id: "st-2",
              toolName: "read_file",
              arguments: '{"path":"collapse-memory.ts"}',
              output: "…（51 行）",
              createdAt: "2026-11-14T08:00:10.000Z",
            }),
          ],
        }),
      ]
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "subagent",
      // 段 id = 委派骨架 id（与运行期事件 subagentId 同键）；toolCallId 来自行
      id: "sa-1",
      toolCallId: "delegate-9",
      task: "调研折叠记忆约定",
      state: "done",
      startedAt: "2026-11-14T08:00:02.000Z",
      endedAt: "2026-11-14T08:00:30.000Z",
      report: "最终报告：约定已梳理",
      ok: true,
      turns: [
        { content: "第一轮先读源码", reasoning: "从 useCollapseState 入手" },
        { content: "最终报告：约定已梳理" },
      ],
    });
    const card = items[0];
    if (card?.kind !== "subagent") throw new Error("应为子代理段");
    expect(card.tools).toHaveLength(2);
    expect(card.tools[0]).toMatchObject({
      id: "st-1",
      toolName: "grep",
      output: "collapse-memory.ts:36",
      isError: false,
      running: false,
    });
  });

  it("被中断的委派（无 spawn 行）：interrupted 段按委派时点插入（晚于全部条目时在末尾），已发生内容完整回看", () => {
    const items = initialTranscript(
      [
        {
          kind: "message",
          message: {
            id: "u1",
            taskId: "task-1",
            role: "user",
            content: "委派调研",
            createdAt: "2026-11-14T08:00:00.000Z",
          },
        },
      ],
      [
        snapshot({
          record: {
            id: "sa-killed",
            task: "运行中被杀的委派",
            status: "interrupted",
            startedAt: "2026-11-14T08:00:03.000Z",
            completedAt: "2026-11-14T08:00:09.000Z",
          },
          messages: [
            snapshotMessage({
              subagentId: "sa-killed",
              content: "中断前已写出的部分正文",
            }),
          ],
          toolCalls: [
            snapshotToolCall({
              subagentId: "sa-killed",
              toolName: "glob",
              arguments: '{"pattern":"*.ts"}',
              output: "a.ts b.ts",
            }),
          ],
        }),
      ]
    );
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: "subagent",
      id: "sa-killed",
      state: "interrupted",
      task: "运行中被杀的委派",
      startedAt: "2026-11-14T08:00:03.000Z",
      endedAt: "2026-11-14T08:00:09.000Z",
      report: null,
      ok: false,
      turns: [{ content: "中断前已写出的部分正文" }],
    });
    const card = items[1];
    if (card?.kind !== "subagent") throw new Error("应为子代理段");
    expect(card.tools).toHaveLength(1);
    expect(card.tools[0]).toMatchObject({ toolName: "glob" });
  });

  it("无行快照插回委派时点：排队被杀的委派回到时间线中段，轮标签归委派时的轮", () => {
    const items = initialTranscript(
      [
        {
          kind: "message",
          message: {
            id: "u1",
            taskId: "task-1",
            role: "user",
            content: "第一轮委派",
            createdAt: "2026-11-14T08:00:00.000Z",
          },
        },
        // 先派发的委派（行与快照命中，段位置由行决定，at 即委派时点）
        {
          kind: "tool-call",
          call: toolCall({
            id: "delegate-a",
            toolName: "spawn_subagent",
            arguments: '{"task":"先派发的委派"}',
            output: "甲的报告",
            createdAt: "2026-11-14T08:00:05.000Z",
          }),
        },
        {
          kind: "message",
          message: {
            id: "a2",
            taskId: "task-1",
            role: "assistant",
            content: "收到甲的报告。",
            createdAt: "2026-11-14T08:01:00.000Z",
          },
        },
        {
          kind: "message",
          message: {
            id: "u2",
            taskId: "task-1",
            role: "user",
            content: "第二轮提问",
            createdAt: "2026-11-14T08:02:00.000Z",
          },
        },
      ],
      [
        snapshot({
          record: {
            id: "sa-a",
            task: "先派发的委派",
            queuedAt: "2026-11-14T08:00:05.000Z",
          },
          messages: [
            snapshotMessage({ subagentId: "sa-a", content: "甲的报告" }),
          ],
        }),
        // 排队中被杀的委派（第 2 个派发，queuedAt 晚于甲、早于后续正文），无行
        snapshot({
          record: {
            id: "sa-queued-killed",
            task: "排队中被杀的委派",
            status: "interrupted",
            queuedAt: "2026-11-14T08:00:10.000Z",
            startedAt: null,
            completedAt: "2026-11-14T08:00:11.000Z",
          },
        }),
      ]
    );
    // 时序位置：插在先派发的委派（08:00:05）之后、后续正文（08:01:00）之前，
    // 不堆在末尾（u2 之后）
    expect(items.map((item) => item.id)).toEqual([
      "u1",
      "sa-a",
      "sa-queued-killed",
      "a2",
      "u2",
    ]);
    const inserted = items[2];
    if (inserted?.kind !== "subagent") throw new Error("应为子代理段");
    expect(inserted).toMatchObject({
      id: "sa-queued-killed",
      state: "interrupted",
      startedAt: null,
      report: null,
    });
    // 轮标签归插入点之前的最后一个 user 段（委派发生时的轮），seq 全局唯一
    expect(inserted.turnId).toBe("u1");
    expect(inserted.seq).not.toBe(items[1]?.seq);
  });

  it("同文本多委派：行与快照按委派序对齐配对（顺序对齐假设守护，review 显式化）", () => {
    // 同一轮派两个委派说明完全相同的 spawn_subagent：行与快照两侧都按
    // 委派时点排序（listToolCalls / listSubagents 同源时钟），文本匹配的
    // findIndex 首个命中 = 按序配对——甲行配甲快照、乙行配乙快照
    const items = initialTranscript(
      [
        {
          kind: "tool-call",
          call: toolCall({
            id: "delegate-jia",
            toolName: "spawn_subagent",
            arguments: '{"task":"调研同文本委派"}',
            output: "甲的报告",
            createdAt: "2026-11-14T08:00:01.000Z",
          }),
        },
        {
          kind: "tool-call",
          call: toolCall({
            id: "delegate-yi",
            toolName: "spawn_subagent",
            arguments: '{"task":"调研同文本委派"}',
            output: "乙的报告",
            createdAt: "2026-11-14T08:00:02.000Z",
          }),
        },
      ],
      [
        snapshot({
          record: {
            id: "sa-jia",
            task: "调研同文本委派",
            queuedAt: "2026-11-14T08:00:01.000Z",
          },
          messages: [
            snapshotMessage({
              subagentId: "sa-jia",
              content: "甲的过程正文",
            }),
          ],
        }),
        snapshot({
          record: {
            id: "sa-yi",
            task: "调研同文本委派",
            queuedAt: "2026-11-14T08:00:02.000Z",
          },
          messages: [
            snapshotMessage({
              subagentId: "sa-yi",
              content: "乙的过程正文",
            }),
          ],
        }),
      ]
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "subagent",
      id: "sa-jia",
      toolCallId: "delegate-jia",
      report: "甲的报告",
      turns: [{ content: "甲的过程正文" }],
    });
    expect(items[1]).toMatchObject({
      kind: "subagent",
      id: "sa-yi",
      toolCallId: "delegate-yi",
      report: "乙的报告",
      turns: [{ content: "乙的过程正文" }],
    });
  });

  it("快照 task 与 spawn 行不匹配（或无快照）：回退 subagentFromToolRecord 旧路径", () => {
    const items = initialTranscript(
      [
        {
          kind: "tool-call",
          call: toolCall({
            id: "delegate-old",
            toolName: "spawn_subagent",
            arguments: '{"task":"旧任务委派"}',
            output: "旧路径报告",
            reasoning: "旧记录拼接的思考全文",
          }),
        },
      ],
      // 快照属于另一条委派（task 不同）：不误配，行回退旧路径
      [snapshot({ record: { task: "另一条委派" } })]
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "subagent",
      id: "restore-delegate-old",
      state: "done",
      report: "旧路径报告",
      reasoning: "旧记录拼接的思考全文",
      tools: [],
      startedAt: null,
    });
    // 未匹配的快照不丢：interrupted/排队骨架按委派时点插入留痕
    // （本用例委派时点与行同刻，位置在行段之后）
    expect(items[1]).toMatchObject({ kind: "subagent", id: "sa-1" });
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

  it("未知 subagentId 的 reasoning 事件被忽略（任务切换后迟到的事件）", () => {
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

  it("主任务思考进序列 thinking 段、子代理思考进卡内（主/子思考互不串流）", () => {
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
      delta: "主任务思考",
    });
    items = applyTaskEvent(items, {
      type: "subagent-reasoning",
      subagentId: "sa-1",
      delta: "子代理思考",
    });
    expect(kinds(items)).toEqual(["subagent", "thinking"]);
    expect(items[1]).toMatchObject({
      kind: "thinking",
      content: "主任务思考",
      responseId: "a1",
    });
    expect(items[0]).toMatchObject({
      kind: "subagent",
      reasoning: "子代理思考",
    });
  });
});

/** 正文折叠块（ADR 0021 票 04）：subagent-text-delta 逐轮流式累积 */
describe("task-view 子代理正文归并（subagent-text-delta）", () => {
  it("正文增量逐轮累积：思考先于正文、工具后新起轮，与落库轮边界同构", () => {
    let items: MessageSegment[] = [];
    const apply = (event: TaskEvent) => {
      items = applyTaskEvent(items, event);
    };

    apply({ type: "subagent-queued", subagentId: "sa-1", task: "调研 vitest" });
    apply({
      type: "subagent-start",
      subagentId: "sa-1",
      task: "调研 vitest",
      toolCallId: "delegate-1",
    });
    // 第一轮：思考 → 正文 → 工具
    apply({
      type: "subagent-reasoning",
      subagentId: "sa-1",
      delta: "第一轮思考",
    });
    apply({ type: "subagent-text-delta", subagentId: "sa-1", delta: "第一轮" });
    apply({ type: "subagent-text-delta", subagentId: "sa-1", delta: "正文" });
    apply({
      type: "subagent-tool",
      subagentId: "sa-1",
      phase: "call",
      call: toolCall({ id: "sub-c1", toolName: "grep", output: "" }),
    });
    apply({
      type: "subagent-tool",
      subagentId: "sa-1",
      phase: "result",
      call: toolCall({ id: "sub-c1", toolName: "grep", output: "a.ts" }),
    });
    // 第二轮：思考 → 正文（最终报告轮）
    apply({
      type: "subagent-reasoning",
      subagentId: "sa-1",
      delta: "第二轮思考",
    });
    apply({
      type: "subagent-text-delta",
      subagentId: "sa-1",
      delta: "最终报告",
    });
    apply({
      type: "subagent-report",
      subagentId: "sa-1",
      task: "调研 vitest",
      report: "最终报告",
      ok: true,
    });

    expect(items[0]).toMatchObject({
      kind: "subagent",
      turns: [
        { reasoning: "第一轮思考", content: "第一轮正文" },
        { reasoning: "第二轮思考", content: "最终报告" },
      ],
    });
  });

  it("显式轮键（roundIndex，review 修复）归并与启发式同构；交错轮不拆分、目标轮不足补空轮", () => {
    let items: MessageSegment[] = [];
    const apply = (event: TaskEvent) => {
      items = applyTaskEvent(items, event);
    };
    apply({ type: "subagent-queued", subagentId: "sa-1", task: "调研 vitest" });
    // 第 0 轮：思考 → 正文（与启发式路径同构）
    apply({
      type: "subagent-reasoning",
      subagentId: "sa-1",
      delta: "第一轮思考",
      roundIndex: 0,
    });
    apply({
      type: "subagent-text-delta",
      subagentId: "sa-1",
      delta: "第一轮正文",
      roundIndex: 0,
    });
    // 工具轮（第 1 轮流式生成）：纯工具轮无增量，roundIndex 直接跳到 2——
    // 中间目标轮不足以空轮补齐（呈现层过滤空轮，与落库空行不落同构）
    apply({
      type: "subagent-text-delta",
      subagentId: "sa-1",
      delta: "最终报告",
      roundIndex: 2,
    });
    expect(items[0]).toMatchObject({
      kind: "subagent",
      turns: [
        { reasoning: "第一轮思考", content: "第一轮正文" },
        { content: "" },
        { content: "最终报告" },
      ],
    });

    // 同轮内正文之后的思考增量（interleaved 输出）：显式轮键按权威轮次
    // 归入同一轮（启发式会误拆新轮，与落库行边界分叉——消灭双写即为此）
    items = applyTaskEvent(items, {
      type: "subagent-reasoning",
      subagentId: "sa-1",
      delta: "同轮补思考",
      roundIndex: 2,
    });
    expect(items[0]).toMatchObject({
      kind: "subagent",
      turns: [
        { reasoning: "第一轮思考", content: "第一轮正文" },
        { content: "" },
        { reasoning: "同轮补思考", content: "最终报告" },
      ],
    });
  });

  it("并发子代理正文互不串流；未知 subagentId 的增量被忽略", () => {
    let items: MessageSegment[] = [];
    const apply = (event: TaskEvent) => {
      items = applyTaskEvent(items, event);
    };
    apply({ type: "subagent-queued", subagentId: "sa-1", task: "调研 a" });
    apply({ type: "subagent-queued", subagentId: "sa-2", task: "调研 b" });
    apply({
      type: "subagent-text-delta",
      subagentId: "sa-1",
      delta: "sa1 正文",
    });
    apply({
      type: "subagent-text-delta",
      subagentId: "sa-2",
      delta: "sa2 正文",
    });
    apply({
      type: "subagent-text-delta",
      subagentId: "sa-gone",
      delta: "迟到",
    });
    expect(items[0]).toMatchObject({
      turns: [{ content: "sa1 正文" }],
    });
    expect(items[1]).toMatchObject({ turns: [{ content: "sa2 正文" }] });
  });

  it("报告到达后正文轮保留（最终轮即报告轮，过程内容不因终态丢失）", () => {
    let items = applyTaskEvent([], {
      type: "subagent-queued",
      subagentId: "sa-1",
      task: "x",
    });
    items = applyTaskEvent(items, {
      type: "subagent-text-delta",
      subagentId: "sa-1",
      delta: "过程正文",
    });
    items = applyTaskEvent(items, {
      type: "subagent-report",
      subagentId: "sa-1",
      task: "x",
      report: "最终报告",
      ok: true,
    });
    expect(items[0]).toMatchObject({
      state: "done",
      report: "最终报告",
      turns: [{ content: "过程正文" }],
    });
  });
});
