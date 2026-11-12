import { describe, expect, it } from "vitest";

import type {
  InteractionRecord,
  SessionEvent,
  StoredMessage,
  ToolCallRecord,
  TranscriptItem,
} from "@codexlike/agent-core";

import {
  appendLocalSegment,
  applySessionEvent,
  initialTranscript,
  mergeInteractions,
  type AssistantSegment,
  type MessageSegment,
} from "../src/lib/session-view";

function stored(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "user",
    content: "你好",
    createdAt: "2026-11-10T08:00:00.000Z",
    ...overrides,
  };
}

/** 取第 index 个元素（不存在即失败：测试自身的前提错误）；保留入参收窄类型 */
function seg<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`元素 ${index} 不存在`);
  return item;
}

/** 过滤正文段（类型收窄） */
function textSegments(items: MessageSegment[]): AssistantSegment[] {
  return items.filter(
    (item): item is AssistantSegment => item.kind === "assistant"
  );
}

function toolRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "c1",
    sessionId: "s1",
    toolName: "read_file",
    arguments: '{"path":"a.txt"}',
    output: "文件正文",
    isError: false,
    createdAt: "2026-11-11T08:00:00Z",
    ...overrides,
  };
}

/** 段序列的时序指纹：kind 依次排列（顺序断言的主视角，不靠文本过滤） */
function kinds(items: MessageSegment[]): string[] {
  return items.map((item) => item.kind);
}

describe("initialTranscript（历史恢复 → 消息段时序序列）", () => {
  it("全部项类型映射为段：user 开新轮、assistant 带响应 id、中断标记保留", () => {
    const interaction: InteractionRecord = {
      request: {
        id: "r1",
        sessionId: "s1",
        turnId: "m1",
        toolCallId: "c1",
        kind: "approval",
        toolName: "run_terminal_command",
        command: "git status",
        commandWord: "git",
        source: { kind: "main" },
        createdAt: "2026-11-11T08:00:00Z",
      },
      status: "resolved",
      response: { kind: "approval", decision: "approve" },
      resolvedAt: "2026-11-11T08:00:01Z",
      cancelReason: null,
    };
    const items: TranscriptItem[] = [
      { kind: "message", message: stored({ id: "u1", role: "user" }) },
      { kind: "tool-call", call: toolRecord() },
      {
        kind: "message",
        message: stored({
          id: "a1",
          role: "assistant",
          content: "第一轮回答",
        }),
      },
      { kind: "interaction", interaction },
      {
        kind: "message",
        message: stored({ id: "e1", role: "error", content: "请求失败" }),
      },
      {
        kind: "message",
        message: stored({ id: "u2", role: "user", content: "压缩吧" }),
      },
      {
        kind: "message",
        message: stored({
          id: "sum",
          role: "compact-summary",
          content: "此前对话摘要",
        }),
      },
      {
        kind: "message",
        message: stored({
          id: "a2",
          role: "assistant",
          content: "被打断的回答",
          aborted: true,
        }),
      },
    ];

    const view = initialTranscript(items);
    expect(kinds(view)).toEqual([
      "user",
      "tool-call",
      "assistant",
      "interaction",
      "error",
      "user",
      "compact-summary",
      "assistant",
    ]);
    // 稳定序号：会话内单调递增
    expect(view.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 轮次标签：user 段开新轮，之后段归该轮
    expect(seg(view, 0).turnId).toBe("u1");
    expect(seg(view, 1).turnId).toBe("u1");
    expect(seg(view, 5).turnId).toBe("u2");
    expect(seg(view, 7).turnId).toBe("u2");
    // 共享响应 id：历史 assistant 段以消息 id 关联；user/工具卡为 null
    expect(seg(view, 2).responseId).toBe("a1");
    expect(seg(view, 0).responseId).toBeNull();
    expect(seg(view, 1).responseId).toBeNull();
    // 中断标记：aborted → interrupted
    expect(seg(view, 7)).toMatchObject({ interrupted: true });
    // 工具卡终态
    expect(seg(view, 1)).toMatchObject({
      id: "c1",
      toolName: "read_file",
      running: false,
    });
    expect(seg(view, 3)).toMatchObject({
      kind: "interaction",
      id: "r1",
      interaction,
    });
  });

  it("历史开头的无轮主消息（如 compact 摘要）自成兜底轮，不报错", () => {
    const view = initialTranscript([
      {
        kind: "message",
        message: stored({ id: "sum", role: "compact-summary" }),
      },
    ]);
    expect(view).toHaveLength(1);
    expect(seg(view, 0).turnId).toBe("sum");
  });

  it("历史加载重建思考段（票 02）：带 reasoning 的 assistant 消息 → 思考段在正文段之前", () => {
    const view = initialTranscript([
      { kind: "message", message: stored({ id: "u1", role: "user" }) },
      {
        kind: "message",
        message: stored({
          id: "a1",
          role: "assistant",
          content: "最终正文",
          reasoning: "当时的推理过程",
        }),
      },
      {
        kind: "message",
        message: stored({
          id: "a2",
          role: "assistant",
          content: "被打断的回答",
          reasoning: "中断前的思考",
          aborted: true,
        }),
      },
    ]);
    expect(kinds(view)).toEqual([
      "user",
      "thinking",
      "assistant",
      "thinking",
      "assistant",
    ]);
    // 思考段与正文段共享响应 id（历史消息以自身 id 关联）、归同一轮；
    // 恢复的思考段非流态（无 streaming 标记）
    expect(seg(view, 1)).toMatchObject({
      id: "thinking-a1-1",
      content: "当时的推理过程",
      turnId: "u1",
      responseId: "a1",
    });
    const firstThinking = seg(view, 1);
    if (firstThinking.kind !== "thinking")
      throw new Error("恢复后的第二段应为思考段");
    expect(firstThinking.streaming).toBeUndefined();
    expect(seg(view, 2)).toMatchObject({ content: "最终正文" });
    // 中断终态的思考同样重建；中断标记仍在正文段上
    expect(seg(view, 3)).toMatchObject({
      content: "中断前的思考",
      responseId: "a2",
    });
    expect(seg(view, 4)).toMatchObject({ interrupted: true });
    // 稳定序号随追加递增
    expect(view.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("旧会话（无思考列数据）打开不产生空思考段：assistant 消息恢复为单正文段", () => {
    const view = initialTranscript([
      { kind: "message", message: stored({ id: "u1", role: "user" }) },
      {
        kind: "message",
        message: stored({
          id: "a1",
          role: "assistant",
          content: "旧回答",
          reasoning: undefined,
        }),
      },
    ]);
    expect(kinds(view)).toEqual(["user", "assistant"]);
    expect(view.every((item) => item.kind !== "thinking")).toBe(true);
  });
});

describe("时序保真（交错回复按事件发生顺序排列）", () => {
  it("正文→工具→再正文：同一响应的第二次正文显示在工具卡之后", () => {
    let items = applySessionEvent([], {
      type: "user-message",
      message: stored({ id: "u1", content: "跑一下测试" }),
    });
    items = applySessionEvent(items, {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applySessionEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "先看文件，",
    });
    items = applySessionEvent(items, {
      type: "tool-call",
      call: toolRecord({ id: "t1", output: "" }),
    });
    items = applySessionEvent(items, {
      type: "tool-result",
      call: toolRecord({ id: "t1", output: "结果" }),
    });
    items = applySessionEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "测试通过",
    });

    expect(kinds(items)).toEqual([
      "user",
      "assistant",
      "tool-call",
      "assistant",
    ]);
    const texts = textSegments(items).map((item) => item.content);
    expect(texts).toEqual(["先看文件，", "测试通过"]);
  });

  it("多段思考与正文、工具穿插保持交错：思考不再被提升合并成一段", () => {
    let items = applySessionEvent([], {
      type: "user-message",
      message: stored({ id: "u1", content: "交错任务" }),
    });
    const apply = (event: SessionEvent) => {
      items = applySessionEvent(items, event);
    };
    apply({ type: "assistant-start", messageId: "a1" });
    apply({
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "第一段思考",
    });
    apply({ type: "assistant-delta", messageId: "a1", delta: "先读文件" });
    apply({
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "第二段思考",
    });
    apply({
      type: "tool-call",
      call: toolRecord({ id: "t1", toolName: "glob", output: "" }),
    });
    apply({
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "工具后思考",
    });
    apply({ type: "assistant-delta", messageId: "a1", delta: "最终结论" });

    expect(kinds(items)).toEqual([
      "user",
      "thinking",
      "assistant",
      "thinking",
      "tool-call",
      "thinking",
      "assistant",
    ]);
    const thinking = items.filter((item) => item.kind === "thinking");
    expect(thinking.map((item) => item.content)).toEqual([
      "第一段思考",
      "第二段思考",
      "工具后思考",
    ]);
    // 关联：同响应 id、同轮次
    expect(new Set(items.slice(1).map((item) => item.responseId))).toEqual(
      new Set(["a1"])
    );
    expect(new Set(items.map((item) => item.turnId))).toEqual(new Set(["u1"]));
  });

  it("流式增量只追加到末尾流态段：同段内容连续累积", () => {
    let items = applySessionEvent([], {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applySessionEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "你",
    });
    items = applySessionEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "好",
    });
    expect(items).toHaveLength(1);
    expect(seg(items, 0)).toMatchObject({ kind: "assistant", content: "你好" });
    const seqBefore = seg(items, 0).seq;
    items = applySessionEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "！",
    });
    expect(seg(items, 0).seq).toBe(seqBefore);
  });
});

describe("封闭更新集（尾部追加 / 按 id 整段替换 / 截断重放 / 流态追加）", () => {
  it("tool-result 按 id 整段替换工具卡：段 id 与序号不变、状态迁移", () => {
    let items = applySessionEvent([], {
      type: "tool-call",
      call: toolRecord({ id: "t1", output: "" }),
    });
    const before = seg(items, 0);
    expect(before).toMatchObject({ running: true });
    items = applySessionEvent(items, {
      type: "tool-result",
      call: toolRecord({ id: "t1", output: "结果", isError: true }),
    });
    expect(items).toHaveLength(1);
    expect(seg(items, 0).id).toBe(before.id);
    expect(seg(items, 0).seq).toBe(before.seq);
    expect(seg(items, 0)).toMatchObject({
      running: false,
      output: "结果",
      isError: true,
    });
  });

  it("重复事件幂等：同 id 事件不重建段、序号不复用", () => {
    let items = applySessionEvent([], {
      type: "tool-result",
      call: toolRecord({ id: "t1" }),
    });
    items = applySessionEvent(items, {
      type: "tool-result",
      call: toolRecord({ id: "t1" }),
    });
    items = applySessionEvent(items, {
      type: "tool-call",
      call: toolRecord({ id: "t1" }),
    });
    expect(items).toHaveLength(1);
    expect(seg(items, 0).seq).toBe(1);
  });

  it("compact 整体重放：initialTranscript 生成全新序列（截断删除的表达方式）", () => {
    let items = applySessionEvent([], {
      type: "user-message",
      message: stored({ id: "u1", content: "旧问题" }),
    });
    items = applySessionEvent(items, {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applySessionEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "旧回答",
    });
    const replayed = initialTranscript([
      {
        kind: "message",
        message: stored({
          id: "sum",
          role: "compact-summary",
          content: "摘要",
        }),
      },
      {
        kind: "message",
        message: stored({ id: "u2", role: "user", content: "新问题" }),
      },
    ]);
    expect(kinds(replayed)).toEqual(["compact-summary", "user"]);
    expect(replayed.map((item) => item.seq)).toEqual([1, 2]);
  });
});

describe("终态收敛与事件兜底", () => {
  it("完整一轮往返：user 追加，assistant 流式累积到完成、流态标记收敛", () => {
    const events: SessionEvent[] = [
      {
        type: "user-message",
        message: stored({ id: "u1", content: "打个招呼" }),
      },
      { type: "assistant-start", messageId: "a1" },
      { type: "assistant-delta", messageId: "a1", delta: "你好，" },
      { type: "assistant-delta", messageId: "a1", delta: "世界" },
      {
        type: "assistant-done",
        message: stored({ id: "a1", role: "assistant", content: "你好，世界" }),
      },
    ];
    let items: MessageSegment[] = [];
    for (const event of events) items = applySessionEvent(items, event);
    expect(kinds(items)).toEqual(["user", "assistant"]);
    expect(seg(items, 1)).toMatchObject({
      content: "你好，世界",
      streaming: undefined,
    });
  });

  it("单正文段的 done 以终稿全文整段替换（防增量缺失）", () => {
    let items = applySessionEvent([], {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applySessionEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "部分",
    });
    items = applySessionEvent(items, {
      type: "assistant-done",
      message: stored({ id: "a1", role: "assistant", content: "完整终稿" }),
    });
    expect(items).toHaveLength(1);
    expect(seg(items, 0)).toMatchObject({
      content: "完整终稿",
      streaming: undefined,
    });
  });

  it("跨工具卡的多正文段 done：保持切分、只收敛流态、末段带中断标记", () => {
    let items = applySessionEvent([], {
      type: "user-message",
      message: stored({ id: "u1" }),
    });
    items = applySessionEvent(items, {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applySessionEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "前半",
    });
    items = applySessionEvent(items, {
      type: "tool-call",
      call: toolRecord({ id: "t1", output: "" }),
    });
    items = applySessionEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "后半",
    });
    items = applySessionEvent(items, {
      type: "assistant-aborted",
      message: stored({
        id: "a1",
        role: "assistant",
        content: "前半后半",
        aborted: true,
      }),
    });
    expect(kinds(items)).toEqual([
      "user",
      "assistant",
      "tool-call",
      "assistant",
    ]);
    const parts = textSegments(items);
    expect(seg(parts, 0).content).toBe("前半");
    expect(seg(parts, 0).interrupted).toBeUndefined();
    expect(seg(parts, 1)).toMatchObject({ content: "后半", interrupted: true });
    expect(parts.every((part) => part.streaming !== true)).toBe(true);
    const thinking = items.filter((item) => item.kind === "thinking");
    expect(thinking).toHaveLength(0);
  });

  it("aborted 收敛思考段：流态去除、内容保留", () => {
    let items = applySessionEvent([], {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applySessionEvent(items, {
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "想到一半",
    });
    items = applySessionEvent(items, {
      type: "assistant-aborted",
      message: stored({
        id: "a1",
        role: "assistant",
        content: "",
        aborted: true,
      }),
    });
    expect(kinds(items)).toEqual(["thinking", "assistant"]);
    const thinking = seg(items, 0);
    if (thinking.kind !== "thinking") throw new Error("首段应为思考段");
    expect(thinking.content).toBe("想到一半");
    expect(thinking.streaming).toBeUndefined();
  });

  it("error：全部流态段收敛 + 尾部追加错误段", () => {
    let items = applySessionEvent([], {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applySessionEvent(items, {
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "出错前的思考",
    });
    items = applySessionEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "半截正文",
    });
    items = applySessionEvent(items, {
      type: "error",
      message: stored({
        id: "e1",
        role: "error",
        content: "模型请求失败：500",
      }),
    });
    expect(kinds(items)).toEqual(["thinking", "assistant", "error"]);
    expect(
      items.every(
        (item) =>
          (item.kind !== "assistant" && item.kind !== "thinking") ||
          item.streaming !== true
      )
    ).toBe(true);
    expect(seg(items, 2)).toMatchObject({ content: "模型请求失败：500" });
  });

  it("错过 start 的 delta / reasoning / done 仍按序兜底重建段", () => {
    let items = applySessionEvent([], {
      type: "assistant-delta",
      messageId: "a1",
      delta: "只有增量",
    });
    expect(items).toMatchObject([
      {
        kind: "assistant",
        content: "只有增量",
        responseId: "a1",
        streaming: true,
      },
    ]);
    const done = applySessionEvent(items, {
      type: "assistant-done",
      message: stored({ id: "a1", role: "assistant", content: "终稿" }),
    });
    expect(done[0]).toMatchObject({ content: "终稿" });
    const onlyDone = applySessionEvent([], {
      type: "assistant-done",
      message: stored({ id: "a2", role: "assistant", content: "直接终稿" }),
    });
    expect(onlyDone).toMatchObject([
      { kind: "assistant", content: "直接终稿", responseId: "a2" },
    ]);
  });

  it("消息流外的本地反馈（status）经 appendLocalSegment 尾部追加并归当前轮", () => {
    let items = applySessionEvent([], {
      type: "user-message",
      message: stored({ id: "u1" }),
    });
    items = appendLocalSegment(items, {
      kind: "status",
      content: "会话已重命名",
    });
    expect(items.at(-1)).toMatchObject({
      kind: "status",
      content: "会话已重命名",
      turnId: "u1",
    });
    const empty = appendLocalSegment([], {
      kind: "error",
      content: "读取失败",
    });
    expect(empty.at(-1)).toMatchObject({ kind: "error", content: "读取失败" });
    expect(typeof seg(empty, 0).seq).toBe("number");
  });
});

describe("子代理段（主序列成员 + 卡内嵌套进度）", () => {
  it("queued → start → 工具进度 → report：卡状态迁移、时序位置保持", () => {
    let items = applySessionEvent([], {
      type: "user-message",
      message: stored({ id: "u1" }),
    });
    const apply = (event: SessionEvent) => {
      items = applySessionEvent(items, event);
    };
    apply({ type: "subagent-queued", subagentId: "sa-1", task: "调研 vitest" });
    apply({
      type: "subagent-start",
      subagentId: "sa-1",
      task: "调研 vitest",
      toolCallId: "delegate-1",
    });
    apply({
      type: "subagent-tool",
      subagentId: "sa-1",
      phase: "call",
      call: toolRecord({ id: "sub-c1", toolName: "glob", output: "" }),
    });
    apply({
      type: "subagent-tool",
      subagentId: "sa-1",
      phase: "result",
      call: toolRecord({ id: "sub-c1", toolName: "glob", output: "a.txt" }),
    });
    apply({
      type: "subagent-reasoning",
      subagentId: "sa-1",
      delta: "子代理思考",
    });
    apply({
      type: "subagent-report",
      subagentId: "sa-1",
      task: "调研 vitest",
      report: "调研报告：vitest 5.1",
      ok: true,
    });

    expect(kinds(items)).toEqual(["user", "subagent"]);
    expect(seg(items, 1)).toMatchObject({
      id: "sa-1",
      turnId: "u1",
      state: "done",
      report: "调研报告：vitest 5.1",
      ok: true,
      reasoning: "子代理思考",
      tools: [
        { id: "sub-c1", toolName: "glob", output: "a.txt", running: false },
      ],
    });
    const seq = seg(items, 1).seq;
    expect(seq).toBe(2);
  });

  it("spawn_subagent 不出普通工具卡；tool-result 按 toolCallId 回填卡报告", () => {
    let items = applySessionEvent([], {
      type: "tool-call",
      call: toolRecord({
        id: "d1",
        toolName: "spawn_subagent",
        arguments: '{"task":"x"}',
      }),
    });
    expect(items).toHaveLength(0);
    items = applySessionEvent([], {
      type: "tool-result",
      call: toolRecord({
        id: "d1",
        toolName: "spawn_subagent",
        arguments: '{"task":"x"}',
        output: "最终报告",
      }),
    });
    expect(items).toMatchObject([
      { kind: "subagent", toolCallId: "d1", state: "done", report: "最终报告" },
    ]);
  });

  it("未知 subagentId 的迟到 reasoning 被忽略", () => {
    const items = applySessionEvent([], {
      type: "subagent-reasoning",
      subagentId: "sa-gone",
      delta: "迟到的思考",
    });
    expect(items).toHaveLength(0);
  });

  it("重启恢复：spawn_subagent 记录映射为完成态子代理段", () => {
    const view = initialTranscript([
      {
        kind: "tool-call",
        call: toolRecord({
          id: "d9",
          toolName: "spawn_subagent",
          arguments: '{"task":"调研依赖"}',
          output: "报告：全部为最新",
        }),
      },
    ]);
    expect(view).toHaveLength(1);
    expect(seg(view, 0)).toMatchObject({
      kind: "subagent",
      state: "done",
      task: "调研依赖",
      report: "报告：全部为最新",
      ok: true,
      tools: [],
    });
  });

  it("重启恢复子代理思考（票 02）：落库 reasoning 重建卡内思考折叠块，旧记录不产生空块", () => {
    const restored = initialTranscript([
      {
        kind: "tool-call",
        call: toolRecord({
          id: "d9",
          toolName: "spawn_subagent",
          arguments: '{"task":"调研依赖"}',
          output: "报告：全部为最新",
          reasoning: "子代理当时的思考",
        }),
      },
    ]);
    expect(seg(restored, 0)).toMatchObject({
      kind: "subagent",
      state: "done",
      report: "报告：全部为最新",
      reasoning: "子代理当时的思考",
    });
    // 旧记录（无 reasoning）不产生空思考
    const legacy = initialTranscript([
      {
        kind: "tool-call",
        call: toolRecord({
          id: "d8",
          toolName: "spawn_subagent",
          arguments: '{"task":"旧任务"}',
          output: "旧报告",
        }),
      },
    ]);
    const legacyCard = legacy[0];
    if (legacyCard?.kind !== "subagent")
      throw new Error("旧记录应恢复为子代理段");
    expect(legacyCard.reasoning).toBeUndefined();
  });
});

describe("交互记录段（mergeInteractions）", () => {
  it("同一记录幂等合并，终态不被迟到 pending 复活", () => {
    const record: InteractionRecord = {
      request: {
        id: "r",
        sessionId: "s1",
        turnId: "t",
        toolCallId: "c1",
        kind: "approval",
        toolName: "run_terminal_command",
        command: "git status",
        commandWord: "git",
        source: { kind: "main" },
        createdAt: "2026-11-11T08:00:00Z",
      },
      status: "pending",
      response: null,
      resolvedAt: null,
      cancelReason: null,
    };
    let state = initialTranscript([
      { kind: "interaction", interaction: record },
    ]);
    state = applySessionEvent(state, {
      type: "interaction-request",
      interaction: record,
    });
    expect(state).toHaveLength(1);
    const resolved: InteractionRecord = {
      ...record,
      status: "resolved",
      response: { kind: "approval", decision: "approve" },
    };
    state = applySessionEvent(state, {
      type: "interaction-resolved",
      interaction: resolved,
    });
    state = applySessionEvent(state, {
      type: "interaction-request",
      interaction: record,
    });
    expect(state).toEqual([
      expect.objectContaining({
        kind: "interaction",
        id: "r",
        interaction: resolved,
      }),
    ]);
  });

  it("旧审批事件不再创建可操作审批卡", () => {
    let state = applySessionEvent([], {
      type: "approval-request",
      request: {
        id: "c1",
        sessionId: "s1",
        toolName: "run_terminal_command",
        command: "git status",
        commandWord: "git",
        createdAt: "2026-11-11T08:00:01.000Z",
      },
    });
    expect(state).toHaveLength(0);
    state = applySessionEvent(state, {
      type: "approval-resolved",
      requestId: "ghost",
      decision: "approve",
    });
    expect(state).toHaveLength(0);
  });
});

describe("段时刻打点（已工作折叠区工时与工具耗时的数据来源）", () => {
  it("运行期尾部追加的段都带 at（epoch ms）", () => {
    const before = Date.now();
    const state = applySessionEvent(
      applySessionEvent([], {
        type: "user-message",
        message: stored({ id: "u1", role: "user" }),
      }),
      { type: "assistant-delta", messageId: "a1", delta: "你好" }
    );
    const after = Date.now();
    for (const item of state) {
      expect(typeof item.at).toBe("number");
      expect(item.at).toBeGreaterThanOrEqual(before);
      expect(item.at).toBeLessThanOrEqual(after);
    }
  });

  it("工具卡打点：call 记 startedAt，result 补 endedAt 且原值不变", () => {
    const seeded = applySessionEvent(
      applySessionEvent([], {
        type: "user-message",
        message: stored({ id: "u1", role: "user" }),
      }),
      {
        type: "tool-call",
        call: toolRecord({
          id: "c1",
          arguments: "{}",
          output: "",
        }),
      }
    );
    const startedAt = seg(seeded, 1).at;
    const final = applySessionEvent(seeded, {
      type: "tool-result",
      call: toolRecord({ id: "c1", output: "结果" }),
    });
    const card = final.find((item) => item.id === "c1");
    expect(card).toEqual(
      expect.objectContaining({
        kind: "tool-call",
        running: false,
        startedAt,
        endedAt: expect.any(Number),
      })
    );
  });

  it("历史恢复的段 at 取自落库 createdAt", () => {
    const items = initialTranscript([
      {
        kind: "message",
        message: stored({
          id: "u1",
          role: "user",
          createdAt: "2026-11-11T08:00:00.000Z",
        }),
      },
      {
        kind: "tool-call",
        call: toolRecord({ createdAt: "2026-11-11T08:00:02.000Z" }),
      },
    ]);
    expect(items[0]?.at).toBe(Date.parse("2026-11-11T08:00:00.000Z"));
    expect(items[1]?.at).toBe(Date.parse("2026-11-11T08:00:02.000Z"));
  });
});
