import { describe, expect, it } from "vitest";

import type { SessionEvent, StoredMessage } from "@codexlike/agent-core";

import {
  applySessionEvent,
  initialMessages,
  initialTranscript,
  type UiItem,
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

describe("initialMessages（持久化历史 → 消息流初始状态）", () => {
  it("按原顺序映射 user / assistant / error 消息，无流式标记", () => {
    const history: StoredMessage[] = [
      stored(),
      stored({ id: "m2", role: "assistant", content: "你好，世界" }),
      stored({
        id: "m3",
        role: "error",
        content: "模型请求失败：timeout",
      }),
    ];

    expect(initialMessages(history)).toEqual([
      { id: "m1", role: "user", content: "你好" },
      { id: "m2", role: "assistant", content: "你好，世界" },
      { id: "m3", role: "error", content: "模型请求失败：timeout" },
    ]);
  });
});

describe("applySessionEvent（流式事件 → 消息流增量更新）", () => {
  it("完整一轮往返：user 追加，assistant 从空流式累积到完成", () => {
    const events: SessionEvent[] = [
      { type: "user-message", message: stored({ content: "打个招呼" }) },
      { type: "assistant-start", messageId: "a1" },
      { type: "assistant-delta", messageId: "a1", delta: "你好，" },
      { type: "assistant-delta", messageId: "a1", delta: "世界" },
      {
        type: "assistant-done",
        message: stored({ id: "a1", role: "assistant", content: "你好，世界" }),
      },
    ];

    let state: UiItem[] = initialMessages([]);
    for (const event of events) {
      state = applySessionEvent(state, event);
    }

    expect(state).toEqual([
      { id: "m1", role: "user", content: "打个招呼" },
      { id: "a1", role: "assistant", content: "你好，世界" },
    ]);
  });

  it("流式进行中：assistant 消息带 streaming 标记，delta 增量追加", () => {
    let state: UiItem[] = initialMessages([]);
    state = applySessionEvent(state, {
      type: "user-message",
      message: stored(),
    });
    state = applySessionEvent(state, {
      type: "assistant-start",
      messageId: "a1",
    });
    state = applySessionEvent(state, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "部分",
    });

    expect(state).toEqual([
      { id: "m1", role: "user", content: "你好" },
      { id: "a1", role: "assistant", content: "部分", streaming: true },
    ]);
  });

  it("中断：assistant-aborted 标记 interrupted 且保留部分内容", () => {
    let state = applySessionEvent(
      [{ id: "a1", role: "assistant", content: "部分", streaming: true }],
      {
        type: "assistant-aborted",
        message: stored({ id: "a1", role: "assistant", content: "部分" }),
      }
    );

    expect(state).toEqual([
      { id: "a1", role: "assistant", content: "部分", interrupted: true },
    ]);
  });

  it("错误：追加 error 消息（中文提示），不动既有 assistant 消息", () => {
    let state = applySessionEvent(
      [{ id: "a1", role: "assistant", content: "旧回答" }],
      {
        type: "error",
        message: stored({
          id: "e1",
          role: "error",
          content: "模型请求失败（HTTP 401）：Unauthorized",
        }),
      }
    );

    expect(state).toEqual([
      { id: "a1", role: "assistant", content: "旧回答" },
      {
        id: "e1",
        role: "error",
        content: "模型请求失败（HTTP 401）：Unauthorized",
      },
    ]);
  });

  it("审批：approval-request 追加等待中的审批卡片，approval-resolved 更新为结果态", () => {
    let state: UiItem[] = [
      {
        kind: "tool-call",
        id: "c1",
        sessionId: "s1",
        toolName: "run_terminal_command",
        arguments: '{"command":"git status"}',
        output: "",
        isError: false,
        running: true,
      },
    ];
    state = applySessionEvent(state, {
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
    expect(state).toEqual([
      {
        kind: "tool-call",
        id: "c1",
        sessionId: "s1",
        toolName: "run_terminal_command",
        arguments: '{"command":"git status"}',
        output: "",
        isError: false,
        running: true,
      },
      {
        kind: "approval",
        id: "c1",
        toolName: "run_terminal_command",
        command: "git status",
        commandWord: "git",
        decision: null,
      },
    ]);

    // 批准后卡片转为结果态（不再等待）
    state = applySessionEvent(state, {
      type: "approval-resolved",
      requestId: "c1",
      decision: "always",
    });
    expect(state[1]).toEqual({
      kind: "approval",
      id: "c1",
      toolName: "run_terminal_command",
      command: "git status",
      commandWord: "git",
      decision: "always",
    });
  });

  it("审批：迟到的 approval-resolved（会话切换后/未知 id）被忽略", () => {
    const state: UiItem[] = [];
    const next = applySessionEvent(state, {
      type: "approval-resolved",
      requestId: "ghost",
      decision: "approve",
    });
    expect(next).toEqual(state);
  });
});

/** 工单 08：重启恢复后的 compact-summary 行映射为消息流条目（渲染摘要卡片） */
describe("initialMessages（压缩摘要恢复）", () => {
  it("持久化历史中的 compact-summary 行原样映射（id/role/content 透传）", () => {
    const state = initialMessages([
      stored({
        id: "s1",
        role: "compact-summary",
        content: "此前对话的压缩摘要",
      }),
      stored({ id: "k1", role: "user", content: "第4轮问题" }),
      stored({ id: "k2", role: "assistant", content: "第4轮回复" }),
    ]);
    expect(state).toEqual([
      { id: "s1", role: "compact-summary", content: "此前对话的压缩摘要" },
      { id: "k1", role: "user", content: "第4轮问题" },
      { id: "k2", role: "assistant", content: "第4轮回复" },
    ]);
  });
});

/** 思考档位 02：reasoning 事件归并（只更新所属消息，终态收敛，历史加载不造思考块） */
describe("applySessionEvent（assistant-reasoning 思考归并）", () => {
  it("reasoning 增量累积到所属助手消息，与正文分离，不串流到其他消息", () => {
    let state: UiItem[] = [{ id: "a0", role: "assistant", content: "旧回答" }];
    state = applySessionEvent(state, {
      type: "assistant-start",
      messageId: "a1",
    });
    state = applySessionEvent(state, {
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "先思考",
    });
    state = applySessionEvent(state, {
      type: "assistant-delta",
      messageId: "a1",
      delta: "正文",
    });
    state = applySessionEvent(state, {
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "再核对",
    });

    expect(state).toEqual([
      { id: "a0", role: "assistant", content: "旧回答" },
      {
        id: "a1",
        role: "assistant",
        content: "正文",
        reasoning: "先思考再核对",
        streaming: true,
      },
    ]);
  });

  it("未知 messageId 的 reasoning 事件被忽略（会话切换后迟到的事件）", () => {
    const state: UiItem[] = [{ id: "a1", role: "assistant", content: "正文" }];
    const next = applySessionEvent(state, {
      type: "assistant-reasoning",
      messageId: "ghost",
      delta: "迟到",
    });
    expect(next).toEqual(state);
  });

  it("assistant-done：思考块保留为完整内容，流式标记移除（终态收敛）", () => {
    let state: UiItem[] = [];
    state = applySessionEvent(state, {
      type: "assistant-start",
      messageId: "a1",
    });
    state = applySessionEvent(state, {
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "思考内容",
    });
    state = applySessionEvent(state, {
      type: "assistant-done",
      message: stored({ id: "a1", role: "assistant", content: "最终正文" }),
    });

    expect(state).toEqual([
      {
        id: "a1",
        role: "assistant",
        content: "最终正文",
        reasoning: "思考内容",
      },
    ]);
  });

  it("assistant-aborted：思考块保留部分内容，中断标记收敛", () => {
    let state: UiItem[] = [];
    state = applySessionEvent(state, {
      type: "assistant-start",
      messageId: "a1",
    });
    state = applySessionEvent(state, {
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "想到一半",
    });
    state = applySessionEvent(state, {
      type: "assistant-aborted",
      message: stored({ id: "a1", role: "assistant", content: "" }),
    });

    expect(state).toEqual([
      {
        id: "a1",
        role: "assistant",
        content: "",
        reasoning: "想到一半",
        interrupted: true,
      },
    ]);
  });

  it("error：追加错误消息且正在流式中的助手消息（含思考）收敛，不残留进行中", () => {
    let state: UiItem[] = [];
    state = applySessionEvent(state, {
      type: "assistant-start",
      messageId: "a1",
    });
    state = applySessionEvent(state, {
      type: "assistant-reasoning",
      messageId: "a1",
      delta: "出错前的思考",
    });
    state = applySessionEvent(state, {
      type: "error",
      message: stored({
        id: "e1",
        role: "error",
        content: "模型请求失败：500",
      }),
    });

    expect(state).toEqual([
      { id: "a1", role: "assistant", content: "", reasoning: "出错前的思考" },
      { id: "e1", role: "error", content: "模型请求失败：500" },
    ]);
  });

  it("历史加载（initialMessages / initialTranscript）不制造思考块", () => {
    const history = initialMessages([
      stored({ id: "a1", role: "assistant", content: "历史回答" }),
    ]);
    expect(history.every((message) => message.reasoning === undefined)).toBe(
      true
    );
    const transcript = initialTranscript([
      {
        kind: "message",
        message: stored({ id: "a2", role: "assistant", content: "时间线回答" }),
      },
    ]);
    expect(
      transcript.every(
        (item) =>
          item.kind !== undefined ||
          (item as { reasoning?: string }).reasoning === undefined
      )
    ).toBe(true);
  });
});
