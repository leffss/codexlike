import { describe, expect, it } from "vitest";

import type {
  SessionEvent,
  StoredMessage,
  ToolCallRecord,
  TranscriptItem,
} from "@codexlike/agent-core";

import { applySessionEvent, initialTranscript } from "../src/lib/session-view";
import { summarizeToolCall } from "../src/lib/tool-summary";

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

function call(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "c1",
    sessionId: "s1",
    toolName: "read_file",
    arguments: '{"path":"a.txt"}',
    output: "1\taaa",
    isError: false,
    createdAt: "2026-11-10T08:00:01.000Z",
    ...overrides,
  };
}

describe("initialTranscript（时间线 → 消息流初始状态）", () => {
  it("消息与工具卡片按时间顺序交错渲染", () => {
    const items: TranscriptItem[] = [
      { kind: "message", message: stored({ id: "m1", role: "user" }) },
      { kind: "tool-call", call: call() },
      {
        kind: "message",
        message: stored({
          id: "m2",
          role: "assistant",
          createdAt: "2026-11-10T08:00:02.000Z",
        }),
      },
    ];

    const view = initialTranscript(items);
    expect(view).toHaveLength(3);
    expect(view[1]).toMatchObject({
      kind: "tool-call",
      toolName: "read_file",
      output: "1\taaa",
      running: false,
    });
  });

  it("重启恢复：被中断的助手消息保留中断点标记（aborted → interrupted）", () => {
    const items: TranscriptItem[] = [
      {
        kind: "message",
        message: stored({ id: "m1", role: "user", content: "慢慢说" }),
      },
      {
        kind: "message",
        message: stored({
          id: "m2",
          role: "assistant",
          content: "被打断的部分",
          aborted: true,
          createdAt: "2026-11-10T08:00:02.000Z",
        }),
      },
    ];

    const view = initialTranscript(items);
    expect(view[1]).toMatchObject({ id: "m2", interrupted: true });
  });
});

describe("applySessionEvent（工具事件归并）", () => {
  it("tool-call 后卡片显示运行中，tool-result 填充输出并结束运行", () => {
    let state = applySessionEvent([], {
      type: "user-message",
      message: stored({ role: "user" }),
    } satisfies SessionEvent);
    state = applySessionEvent(state, {
      type: "assistant-start",
      messageId: "a1",
    });
    state = applySessionEvent(state, {
      type: "tool-call",
      call: call({ output: "" }),
    });
    // 运行中：卡片排在最后，无输出
    const running = state.at(-1);
    expect(running).toMatchObject({
      kind: "tool-call",
      running: true,
      output: "",
    });

    state = applySessionEvent(state, {
      type: "tool-result",
      call: call({ output: "已读 3 行" }),
    });
    const done = state.at(-1);
    expect(done).toMatchObject({
      kind: "tool-call",
      running: false,
      output: "已读 3 行",
    });
  });

  it("当前执行错过 tool-call 时由 tool-result 补齐卡片；旧执行由信封层隔离", () => {
    const state = applySessionEvent([], {
      type: "tool-result",
      call: call({ id: "restored", output: "已读内容" }),
    });
    expect(state).toMatchObject([
      { kind: "tool-call", id: "restored", running: false, output: "已读内容" },
    ]);
  });
});

describe("summarizeToolCall（工具卡片参数摘要）", () => {
  it("各工具给出人可读摘要", () => {
    expect(summarizeToolCall("read_file", '{"path":"src/app.ts"}')).toBe(
      "src/app.ts"
    );
    expect(
      summarizeToolCall("write_file", '{"path":"a.txt","content":"hello"}')
    ).toBe("a.txt（5 字符）");
    expect(
      summarizeToolCall(
        "apply_patch",
        '{"patch":"*** Begin Patch\\n*** Update File: a\\n-x\\n+y\\n*** End Patch"}'
      )
    ).toBe("a 的补丁（2 行变更）");
    expect(summarizeToolCall("glob", '{"pattern":"**/*.ts"}')).toBe("**/*.ts");
    expect(summarizeToolCall("grep", '{"pattern":"TODO","path":"src"}')).toBe(
      "src 中搜 TODO"
    );
    expect(
      summarizeToolCall("run_terminal_command", '{"command":"pnpm test"}')
    ).toBe("$ pnpm test");
    expect(summarizeToolCall("web_search", '{"query":"tavily api 定价"}')).toBe(
      "搜「tavily api 定价」"
    );
  });

  it("超长命令截断；未知工具回退 JSON 摘要；坏 JSON 不抛错", () => {
    const long = summarizeToolCall(
      "run_terminal_command",
      `{"command":"${"x".repeat(100)}"}`
    );
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long.endsWith("…")).toBe(true);

    expect(summarizeToolCall("mcp_tool", '{"a":1}')).toContain("a");
    expect(summarizeToolCall("read_file", "不是 json")).toBe("不是 json");

    // MCP 工具摘要（工单 12）：text 类字段优先，否则压缩 JSON
    expect(summarizeToolCall("mcp_fake_echo", '{"text":"你好"}')).toBe(
      "MCP mcp_fake_echo：你好"
    );
    expect(summarizeToolCall("mcp_fake_x", '{"n":1}')).toBe(
      'MCP mcp_fake_x {"n":1}'
    );
  });

  it("浏览器五件工具给出人可读摘要", () => {
    expect(
      summarizeToolCall(
        "browser_navigate",
        '{"url":"https://example.com/docs"}'
      )
    ).toBe("https://example.com/docs");
    expect(summarizeToolCall("browser_click", '{"selector":"#submit"}')).toBe(
      "点击 #submit"
    );
    expect(
      summarizeToolCall("browser_type", '{"selector":"#q","text":"playwright"}')
    ).toBe("在 #q 输入 playwright");
    expect(summarizeToolCall("browser_screenshot", "{}")).toBe("整页截图");
    expect(summarizeToolCall("browser_read", "{}")).toBe("提取页面正文");
  });
});
