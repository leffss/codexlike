import { describe, expect, it } from "vitest";

import type {
  InteractionRecord,
  TaskEvent,
  StoredMessage,
  TerminalSessionRecord,
  ToolCallRecord,
  TranscriptItem,
} from "@codexlike/agent-core";

import {
  appendLocalSegment,
  applyTaskEvent,
  initialTranscript,
  mergeInteractions,
  mergeTerminalRecords,
  terminalSegmentsFromRecords,
  upsertTerminalSession,
  type AssistantSegment,
  type MessageSegment,
  type TerminalSegment,
} from "../src/lib/task-view";

function stored(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "m1",
    taskId: "s1",
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
    taskId: "s1",
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

describe("正文完成时刻", () => {
  it.each(["assistant-aborted", "assistant-done"] as const)(
    "多段正文经 %s 中断后，新轮正常完成不污染旧轮时间与正文",
    (type) => {
      let items: MessageSegment[] = [];
      const events: TaskEvent[] = [
        { type: "user-message", message: stored({ id: "u1" }) },
        { type: "assistant-delta", messageId: "a1", delta: "工具前正文" },
        { type: "tool-call", call: toolRecord() },
        { type: "tool-result", call: toolRecord() },
        { type: "assistant-delta", messageId: "a1", delta: "工具后部分正文" },
      ];
      for (const event of events) items = applyTaskEvent(items, event);
      const before = textSegments(items);
      items = applyTaskEvent(items, {
        type,
        message: stored({
          id: "a1",
          role: "assistant",
          content: "工具前正文工具后部分正文",
          aborted: true,
          createdAt: "2026-11-11T08:00:09.000Z",
        }),
      });
      const interrupted = textSegments(items);
      expect(interrupted).toHaveLength(2);
      expect(interrupted).toMatchObject([
        { turnId: "u1", responseId: "a1", content: "工具前正文" },
        {
          turnId: "u1",
          responseId: "a1",
          content: "工具后部分正文",
          interrupted: true,
        },
      ]);
      expect(interrupted.map((item) => item.interrupted)).toEqual([
        undefined,
        true,
      ]);
      for (const item of interrupted) {
        expect(item.streaming).toBeUndefined();
        expect(item.completedAt).toBeUndefined();
      }
      expect(interrupted.map((item) => [item.id, item.seq, item.at])).toEqual(
        before.map((item) => [item.id, item.seq, item.at])
      );

      items = applyTaskEvent(items, {
        type: "user-message",
        message: stored({ id: "u2", content: "继续" }),
      });
      items = applyTaskEvent(items, {
        type: "assistant-delta",
        messageId: "a2",
        delta: "新轮正文",
      });
      const newText = seg(textSegments(items), 2);
      expect(newText).toMatchObject({ turnId: "u2", streaming: true });
      expect(newText.completedAt).toBeUndefined();
      expect(textSegments(items).slice(0, 2)).toEqual(interrupted);
      items = applyTaskEvent(items, {
        type: "assistant-done",
        message: stored({
          id: "a2",
          role: "assistant",
          content: "新轮完整正文",
          createdAt: "2026-11-11T08:01:19.000Z",
        }),
      });
      expect(textSegments(items)).toEqual([
        ...interrupted,
        {
          ...newText,
          content: "新轮完整正文",
          streaming: undefined,
          // 流态收敛打点（段耗时数据）：终态消息落库时刻，与 completedAt 同源
          endedAt: Date.UTC(2026, 10, 11, 8, 1, 19),
          completedAt: Date.UTC(2026, 10, 11, 8, 1, 19),
        },
      ]);
    }
  );

  it.each([false, true])(
    "中断标记的终态即使经 done 接收也不记成功时间（已有增量=%s）",
    (withDelta) => {
      const message = stored({
        role: "assistant",
        aborted: true,
        content: "部分正文",
      });
      const items = withDelta
        ? applyTaskEvent([], {
            type: "assistant-delta",
            messageId: message.id,
            delta: "部分",
          })
        : [];
      const result = applyTaskEvent(items, {
        type: "assistant-done",
        message,
      });
      expect(textSegments(result)[0]).toMatchObject({
        interrupted: true,
        content: "部分正文",
      });
      expect(textSegments(result)[0]?.completedAt).toBeUndefined();
      expect(
        textSegments(initialTranscript([{ kind: "message", message }]))[0]
          ?.completedAt
      ).toBeUndefined();
    }
  );

  it.each(["assistant-aborted", "error"] as const)(
    "有效终态时间也不能让非成功事件标为完成：%s",
    (type) => {
      const message = stored({
        role: type === "error" ? "error" : "assistant",
        content: "部分正文",
      });
      const live = applyTaskEvent(
        applyTaskEvent([], {
          type: "assistant-delta",
          messageId: message.id,
          delta: "部分正文",
        }),
        { type, message }
      );
      expect(textSegments(live)[0]?.completedAt).toBeUndefined();
      expect(textSegments(live)[0]?.streaming).toBeUndefined();
      expect(textSegments(live)[0]?.content).toBe("部分正文");
    }
  );

  it.each(["assistant-done", "assistant-aborted", "error"] as const)(
    "非法时间与非成功终态不产生成功标记：%s",
    (type) => {
      const message = stored({
        role: type === "error" ? "error" : "assistant",
        createdAt: "非法时间",
        content: "部分正文",
      });
      const live = applyTaskEvent(
        applyTaskEvent([], {
          type: "assistant-delta",
          messageId: message.id,
          delta: "部分正文",
        }),
        { type, message }
      );
      const missed = applyTaskEvent([], { type, message });
      const restored = initialTranscript([{ kind: "message", message }]);
      for (const items of [live, missed, restored]) {
        expect(
          items.every(
            (item) => !("completedAt" in item) || item.completedAt === undefined
          )
        ).toBe(true);
      }
    }
  );

  it("正常终态只给最后正文记录消息完成时刻，不覆盖段建立时刻或合并过程正文", () => {
    let items = applyTaskEvent([], {
      type: "assistant-delta",
      messageId: "a1",
      delta: "过程正文",
    });
    items = applyTaskEvent(items, { type: "tool-call", call: toolRecord() });
    items = applyTaskEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "最终正文",
    });
    const before = textSegments(items);
    items = applyTaskEvent(items, {
      type: "assistant-done",
      message: stored({
        id: "a1",
        role: "assistant",
        content: "过程正文最终正文",
        createdAt: "2026-11-11T08:00:09.000Z",
      }),
    });
    const after = textSegments(items);
    expect(after[0]).not.toHaveProperty("completedAt");
    expect(after[1]).toMatchObject({
      content: "最终正文",
      completedAt: Date.UTC(2026, 10, 11, 8, 0, 9),
    });
    expect(after.map((item) => [item.id, item.seq, item.at])).toEqual(
      before.map((item) => [item.id, item.seq, item.at])
    );
  });
});

describe("initialTranscript（历史恢复 → 消息段时序序列）", () => {
  it("全部项类型映射为段：user 开新轮、assistant 带响应 id、中断标记保留", () => {
    const interaction: InteractionRecord = {
      request: {
        id: "r1",
        taskId: "s1",
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
    // 稳定序号：任务内单调递增
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

  it("旧任务（无思考列数据）打开不产生空思考段：assistant 消息恢复为单正文段", () => {
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
    let items = applyTaskEvent([], {
      type: "user-message",
      message: stored({ id: "u1", content: "跑一下测试" }),
    });
    items = applyTaskEvent(items, {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applyTaskEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "先看文件，",
    });
    items = applyTaskEvent(items, {
      type: "tool-call",
      call: toolRecord({ id: "t1", output: "" }),
    });
    items = applyTaskEvent(items, {
      type: "tool-result",
      call: toolRecord({ id: "t1", output: "结果" }),
    });
    items = applyTaskEvent(items, {
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
    let items = applyTaskEvent([], {
      type: "user-message",
      message: stored({ id: "u1", content: "交错任务" }),
    });
    const apply = (event: TaskEvent) => {
      items = applyTaskEvent(items, event);
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
    let items = applyTaskEvent([], {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applyTaskEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "你",
    });
    items = applyTaskEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "好",
    });
    expect(items).toHaveLength(1);
    expect(seg(items, 0)).toMatchObject({ kind: "assistant", content: "你好" });
    const seqBefore = seg(items, 0).seq;
    items = applyTaskEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "！",
    });
    expect(seg(items, 0).seq).toBe(seqBefore);
  });
});

describe("封闭更新集（尾部追加 / 按 id 整段替换 / 截断重放 / 流态追加）", () => {
  it("tool-result 按 id 整段替换工具卡：段 id 与序号不变、状态迁移", () => {
    let items = applyTaskEvent([], {
      type: "tool-call",
      call: toolRecord({ id: "t1", output: "" }),
    });
    const before = seg(items, 0);
    expect(before).toMatchObject({ running: true });
    items = applyTaskEvent(items, {
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
    let items = applyTaskEvent([], {
      type: "tool-result",
      call: toolRecord({ id: "t1" }),
    });
    items = applyTaskEvent(items, {
      type: "tool-result",
      call: toolRecord({ id: "t1" }),
    });
    items = applyTaskEvent(items, {
      type: "tool-call",
      call: toolRecord({ id: "t1" }),
    });
    expect(items).toHaveLength(1);
    expect(seg(items, 0).seq).toBe(1);
  });

  it("compact 整体重放：initialTranscript 生成全新序列（截断删除的表达方式）", () => {
    let items = applyTaskEvent([], {
      type: "user-message",
      message: stored({ id: "u1", content: "旧问题" }),
    });
    items = applyTaskEvent(items, {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applyTaskEvent(items, {
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
    const events: TaskEvent[] = [
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
    for (const event of events) items = applyTaskEvent(items, event);
    expect(kinds(items)).toEqual(["user", "assistant"]);
    expect(seg(items, 1)).toMatchObject({
      content: "你好，世界",
      streaming: undefined,
    });
  });

  it("单正文段的 done 以终稿全文整段替换（防增量缺失）", () => {
    let items = applyTaskEvent([], {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applyTaskEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "部分",
    });
    items = applyTaskEvent(items, {
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
    let items = applyTaskEvent([], {
      type: "user-message",
      message: stored({ id: "u1" }),
    });
    items = applyTaskEvent(items, {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applyTaskEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "前半",
    });
    items = applyTaskEvent(items, {
      type: "tool-call",
      call: toolRecord({ id: "t1", output: "" }),
    });
    items = applyTaskEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "后半",
    });
    items = applyTaskEvent(items, {
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
    let items = applyTaskEvent([], {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applyTaskEvent(items, {
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "想到一半",
    });
    items = applyTaskEvent(items, {
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
    let items = applyTaskEvent([], {
      type: "assistant-start",
      messageId: "a1",
    });
    items = applyTaskEvent(items, {
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "出错前的思考",
    });
    items = applyTaskEvent(items, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "半截正文",
    });
    items = applyTaskEvent(items, {
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
    let items = applyTaskEvent([], {
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
    const done = applyTaskEvent(items, {
      type: "assistant-done",
      message: stored({ id: "a1", role: "assistant", content: "终稿" }),
    });
    expect(done[0]).toMatchObject({ content: "终稿" });
    const onlyDone = applyTaskEvent([], {
      type: "assistant-done",
      message: stored({ id: "a2", role: "assistant", content: "直接终稿" }),
    });
    expect(onlyDone).toMatchObject([
      { kind: "assistant", content: "直接终稿", responseId: "a2" },
    ]);
  });

  it("消息流外的本地错误段经 appendLocalSegment 尾部追加并归当前轮", () => {
    let items = applyTaskEvent([], {
      type: "user-message",
      message: stored({ id: "u1" }),
    });
    items = appendLocalSegment(items, {
      kind: "error",
      content: "读取失败",
    });
    expect(items.at(-1)).toMatchObject({
      kind: "error",
      content: "读取失败",
      turnId: "u1",
    });
    const empty = appendLocalSegment([], {
      kind: "error",
      content: "读取失败",
    });
    expect(empty.at(-1)).toMatchObject({ kind: "error", content: "读取失败" });
    expect(typeof seg(empty, 0).seq).toBe("number");
  });

  it("/status 报告段（ADR 0031）经 appendLocalSegment 尾部追加并归当前轮", () => {
    let items = applyTaskEvent([], {
      type: "user-message",
      message: stored({ id: "u1" }),
    });
    items = appendLocalSegment(items, {
      kind: "status",
      content: "任务状态（/status）\n模型：Mock · mock-model",
    });
    expect(items.at(-1)).toMatchObject({
      kind: "status",
      content: "任务状态（/status）\n模型：Mock · mock-model",
      turnId: "u1",
    });
  });
});

describe("子代理段（主序列成员 + 卡内嵌套进度）", () => {
  it("queued → start → 工具进度 → report：卡状态迁移、时序位置保持", () => {
    let items = applyTaskEvent([], {
      type: "user-message",
      message: stored({ id: "u1" }),
    });
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
    let items = applyTaskEvent([], {
      type: "tool-call",
      call: toolRecord({
        id: "d1",
        toolName: "spawn_subagent",
        arguments: '{"task":"x"}',
      }),
    });
    expect(items).toHaveLength(0);
    items = applyTaskEvent([], {
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
    const items = applyTaskEvent([], {
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
        taskId: "s1",
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
    state = applyTaskEvent(state, {
      type: "interaction-request",
      interaction: record,
    });
    expect(state).toHaveLength(1);
    const resolved: InteractionRecord = {
      ...record,
      status: "resolved",
      response: { kind: "approval", decision: "approve" },
    };
    state = applyTaskEvent(state, {
      type: "interaction-resolved",
      interaction: resolved,
    });
    state = applyTaskEvent(state, {
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
    let state = applyTaskEvent([], {
      type: "approval-request",
      request: {
        id: "c1",
        taskId: "s1",
        toolName: "run_terminal_command",
        command: "git status",
        commandWord: "git",
        createdAt: "2026-11-11T08:00:01.000Z",
      },
    });
    expect(state).toHaveLength(0);
    state = applyTaskEvent(state, {
      type: "approval-resolved",
      requestId: "ghost",
      decision: "approve",
    });
    expect(state).toHaveLength(0);
  });
});

describe("段时刻打点（各段卡耗时与工具耗时的数据来源）", () => {
  it("运行期尾部追加的段都带 at（epoch ms）", () => {
    const before = Date.now();
    const state = applyTaskEvent(
      applyTaskEvent([], {
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
    const seeded = applyTaskEvent(
      applyTaskEvent([], {
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
    const final = applyTaskEvent(seeded, {
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

  it("新起流态段收敛旧流态段（多转圈回归）：思考→正文、正文→工具→再正文，旧段 streaming 清除并打 endedAt", () => {
    const before = Date.now();
    const items = [
      { type: "user-message", message: stored({ id: "u1", role: "user" }) },
      { type: "assistant-reasoning", messageId: "a1", delta: "先想" },
      { type: "assistant-delta", messageId: "a1", delta: "工具前正文" },
      { type: "tool-call", call: toolRecord({ id: "c1", output: "" }) },
      { type: "tool-result", call: toolRecord({ id: "c1", output: "结果" }) },
      { type: "assistant-delta", messageId: "a1", delta: "工具后正文" },
    ].reduce(
      (acc, event) => applyTaskEvent(acc, event as TaskEvent),
      [] as MessageSegment[]
    );
    const after = Date.now();
    const thinking = items.find((item) => item.kind === "thinking");
    const texts = items.filter((item) => item.kind === "assistant");
    // 任一时刻至多一个流态段：旧思考段与被工具卡隔断的正文段都已收敛
    expect(thinking).toMatchObject({
      streaming: undefined,
      endedAt: expect.any(Number),
    });
    expect(texts[0]).toMatchObject({
      content: "工具前正文",
      streaming: undefined,
      endedAt: expect.any(Number),
    });
    // 只有末尾新起的正文段在流式中
    expect(texts[1]).toMatchObject({ content: "工具后正文", streaming: true });
    expect(texts[1]?.endedAt).toBeUndefined();
    // 收敛打点落在事件处理时刻窗口内（段耗时数据来源）
    for (const item of [thinking, texts[0]]) {
      expect((item?.endedAt ?? 0) >= before).toBe(true);
      expect((item?.endedAt ?? 0) <= after).toBe(true);
    }
  });

  it("子代理卡打点：report/tool-result 回流记 endedAt，恢复的完成态无起止对", () => {
    let items: MessageSegment[] = applyTaskEvent([], {
      type: "subagent-queued",
      subagentId: "sa-1",
      task: "调研",
    });
    items = applyTaskEvent(items, {
      type: "subagent-start",
      subagentId: "sa-1",
      task: "调研",
      toolCallId: "delegate-1",
    });
    items = applyTaskEvent(items, {
      type: "subagent-tool",
      subagentId: "sa-1",
      phase: "call",
      call: toolRecord({ id: "sub-c1", toolName: "glob", output: "" }),
    });
    // 卡内工具行打点：call 记 startedAt，result 补 endedAt
    const withCall = items[0];
    if (withCall?.kind !== "subagent") throw new Error("首段应为子代理段");
    expect(withCall.tools[0]).toMatchObject({
      running: true,
      startedAt: expect.any(Number),
    });
    items = applyTaskEvent(items, {
      type: "subagent-tool",
      subagentId: "sa-1",
      phase: "result",
      call: toolRecord({ id: "sub-c1", toolName: "glob", output: "a.txt" }),
    });
    const card = items[0];
    if (card?.kind !== "subagent") throw new Error("首段应为子代理段");
    expect(card.tools[0]).toMatchObject({
      running: false,
      startedAt: expect.any(Number),
      endedAt: expect.any(Number),
    });
    expect(card.state).toBe("running");
    expect(card.endedAt).toBeNull();
    // 报告到达：完成态打 endedAt（总耗时定格基准）
    items = applyTaskEvent(items, {
      type: "subagent-report",
      subagentId: "sa-1",
      task: "调研",
      report: "报告",
      ok: true,
    });
    const done = items[0];
    if (done?.kind !== "subagent") throw new Error("首段应为子代理段");
    expect(done.state).toBe("done");
    expect(done.endedAt).toEqual(expect.any(String));
    // 恢复的记录无起止对：完成态不显示总耗时
    const restored = initialTranscript([
      {
        kind: "tool-call",
        call: toolRecord({
          toolName: "spawn_subagent",
          arguments: '{"task":"调研"}',
        }),
      },
    ]);
    expect(restored[0]).toMatchObject({
      kind: "subagent",
      state: "done",
      startedAt: null,
      endedAt: null,
    });
  });
});

describe("终端会话段（ADR 0033 票 04：消息流成员 + rail tab 列表数据源）", () => {
  /** TerminalSessionRecord 样例（record 字段与 manager 下发对齐） */
  function termRecord(
    overrides: Partial<TerminalSessionRecord> = {}
  ): TerminalSessionRecord {
    return {
      sessionId: "ts-1",
      taskId: "s1",
      name: "git-bash · 1",
      shell: "git-bash",
      origin: "user",
      status: "running",
      createdAt: "2026-11-21T08:00:00.000Z",
      ...overrides,
    };
  }

  /** 收窄取终端段（测试自身前提错误即抛） */
  function termOf(items: MessageSegment[], index: number): TerminalSegment {
    const item = seg(items, index);
    if (item.kind !== "terminal") throw new Error(`段 ${index} 不是终端段`);
    return item;
  }

  it("terminal-started 尾部追加终端段：record 字段映射、归当前轮", () => {
    let items = applyTaskEvent([], {
      type: "user-message",
      message: stored({ id: "u1" }),
    });
    items = applyTaskEvent(items, {
      type: "terminal-started",
      record: termRecord(),
    });
    expect(kinds(items)).toEqual(["user", "terminal"]);
    expect(termOf(items, 1)).toMatchObject({
      kind: "terminal",
      id: "ts-1",
      sessionId: "ts-1",
      turnId: "u1",
      name: "git-bash · 1",
      shell: "git-bash",
      origin: "user",
      status: "running",
      createdAt: "2026-11-21T08:00:00.000Z",
    });
    // 快照不进段：64KB 终态文本与消息流无关（回看走 subscribe 的 buffered）
    items = applyTaskEvent(items, {
      type: "terminal-started",
      record: termRecord({ sessionId: "ts-1", snapshot: "大段输出" }),
    });
    expect(termOf(items, 1)).not.toHaveProperty("snapshot");
  });

  it("terminal-exited 整段替换推进状态：段 id 与序号保持（封闭集操作二）", () => {
    let items = applyTaskEvent([], {
      type: "terminal-started",
      record: termRecord(),
    });
    const startedSeq = termOf(items, 0).seq;
    items = applyTaskEvent(items, {
      type: "terminal-exited",
      record: termRecord({
        status: "exited",
        exitedAt: "2026-11-21T08:05:00.000Z",
        exitCode: 0,
      }),
    });
    expect(kinds(items)).toEqual(["terminal"]);
    const exited = termOf(items, 0);
    expect(exited).toMatchObject({
      id: "ts-1",
      seq: startedSeq,
      status: "exited",
      exitedAt: "2026-11-21T08:05:00.000Z",
      exitCode: 0,
    });
    // 迟到的重复 started（幂等防御）不把终态拉回 running
    items = applyTaskEvent(items, {
      type: "terminal-started",
      record: termRecord(),
    });
    expect(termOf(items, 0).status).toBe("exited");
  });

  it("迟到 exited（错过 started）兜底建段（先例 tool-result 补齐终态卡）", () => {
    const items = applyTaskEvent([], {
      type: "terminal-exited",
      record: termRecord({
        status: "exited",
        exitCode: 2,
        exitedAt: "2026-11-21T08:05:00.000Z",
      }),
    });
    expect(kinds(items)).toEqual(["terminal"]);
    expect(termOf(items, 0)).toMatchObject({
      sessionId: "ts-1",
      status: "exited",
      exitCode: 2,
    });
  });

  it("terminalSegmentsFromRecords：list-for 初始清单 → 段列表（rail 列表重建数据源）", () => {
    const segments = terminalSegmentsFromRecords([
      termRecord(),
      termRecord({
        sessionId: "ts-2",
        name: "git-bash · 2",
        status: "exited",
        exitCode: 0,
        exitedAt: "2026-11-21T08:01:00.000Z",
        snapshot: "快照文本",
      }),
    ]);
    expect(segments.map((item) => item.sessionId)).toEqual(["ts-1", "ts-2"]);
    expect(segments[0]).toMatchObject({ status: "running" });
    expect(segments[1]).toMatchObject({
      status: "exited",
      exitCode: 0,
      exitedAt: "2026-11-21T08:01:00.000Z",
    });
    // 快照不进段（大文本不进 React 状态）
    expect(segments[1]).not.toHaveProperty("snapshot");
    // 段 id 用 sessionId（渲染 key 与详情定位同一键）
    expect(segments[0]!.id).toBe("ts-1");
  });

  it("upsertTerminalSession：rail 列表事件增量归并幂等（新增/替换双路径）", () => {
    let sessions = terminalSegmentsFromRecords([termRecord()]);
    // 新会话事件追加
    sessions = upsertTerminalSession(
      sessions,
      termRecord({ sessionId: "ts-2", name: "git-bash · 2" })
    );
    expect(sessions.map((item) => item.sessionId)).toEqual(["ts-1", "ts-2"]);
    // 退出事件替换状态，序位不变
    sessions = upsertTerminalSession(
      sessions,
      termRecord({
        sessionId: "ts-1",
        status: "exited",
        exitCode: 0,
        exitedAt: "2026-11-21T08:02:00.000Z",
      })
    );
    expect(sessions.map((item) => item.sessionId)).toEqual(["ts-1", "ts-2"]);
    expect(sessions[0]).toMatchObject({ status: "exited", exitCode: 0 });
    // 重复事件幂等
    const before = sessions;
    sessions = upsertTerminalSession(
      sessions,
      termRecord({
        sessionId: "ts-1",
        status: "exited",
        exitCode: 0,
        exitedAt: "2026-11-21T08:02:00.000Z",
      })
    );
    expect(sessions).not.toBe(before);
    expect(sessions.map((item) => item.sessionId)).toEqual(["ts-1", "ts-2"]);
  });

  it("mergeTerminalRecords：恢复快照记录与 list-for 合并去重（同会话 live 优先），按创建序排列", () => {
    // 恢复记录（view 并行字段，重启后 list-for 为空时的「已退出」组数据源）
    const restored = [
      termRecord({
        sessionId: "ts-old",
        name: "git-bash · 1",
        status: "exited",
        exitCode: 0,
        exitedAt: "2026-11-21T08:01:00.000Z",
        createdAt: "2026-11-21T08:00:00.000Z",
        snapshot: "重启前输出的尾部",
      }),
    ];
    // 同进程清单：一个新会话 + 一个与恢复记录同 id 的会话（live 数据面更新）
    const live = [
      termRecord({
        sessionId: "ts-old",
        name: "git-bash · 1",
        status: "exited",
        exitCode: 0,
        exitedAt: "2026-11-21T08:01:30.000Z",
        createdAt: "2026-11-21T08:00:00.000Z",
        snapshot: "同进程定格的快照（更新）",
      }),
      termRecord({
        sessionId: "ts-live",
        name: "git-bash · 2",
        createdAt: "2026-11-21T08:02:00.000Z",
      }),
    ];
    const merged = mergeTerminalRecords(restored, live);
    // 去重（同 id 只留 live 侧）+ 创建序排列
    expect(merged.map((row) => row.sessionId)).toEqual(["ts-old", "ts-live"]);
    expect(merged[0]).toMatchObject({ exitedAt: "2026-11-21T08:01:30.000Z" });
    // record 层携带快照（进段投影才丢弃——大文本不进 React 状态的口径
    // 在 terminalSegmentOf 落地，合并层不私自剥离）
    expect(merged[0]?.snapshot).toBe("同进程定格的快照（更新）");
    // 重启形态：list-for 为空，恢复记录原样成为数据源
    expect(mergeTerminalRecords(restored, [])).toEqual(restored);
  });
});
