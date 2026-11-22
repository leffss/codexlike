// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MessageStream } from "../src/components/MessageStream";
import type {
  TerminalSegment,
  ToolCallSegment,
  UserSegment,
} from "../src/lib/task-view";

/**
 * read 锚点行集成面（ADR 0033「消息流 read 锚点」）：MessageStream 从
 * items 里的终端段派生会话名索引，terminal_read 段按轮聚合为锚点行并
 * 以会话名呈现（不是 sessionId）——e2e 前的渲染端守门。
 */

afterEach(() => cleanup());

let nextSeq = 0;

function userSeg(): UserSegment {
  return {
    kind: "user",
    id: "u1",
    seq: ++nextSeq,
    turnId: "u1",
    responseId: null,
    content: "追一下构建输出",
    at: 0,
  };
}

function terminalSeg(): TerminalSegment {
  return {
    kind: "terminal",
    id: "term-1",
    seq: ++nextSeq,
    turnId: "u1",
    responseId: null,
    sessionId: "sess-abc",
    name: "git-bash · 1",
    shell: "git-bash",
    origin: "user",
    status: "running",
    createdAt: "2026-11-22T00:00:00.000Z",
  };
}

function readSeg(id: string, running = false): ToolCallSegment {
  return {
    kind: "tool-call",
    id,
    seq: ++nextSeq,
    turnId: "u1",
    responseId: null,
    taskId: "s1",
    toolName: "terminal_read",
    arguments: JSON.stringify({ sessionId: "sess-abc" }),
    output: running ? "" : "构建增量输出",
    isError: false,
    running,
    at: 1_000,
  };
}

describe("MessageStream：terminal_read 锚点集成（会话名呈现）", () => {
  it("终端段在 items 中时锚点行按会话名呈现，read 段不再成工具卡", () => {
    render(
      <MessageStream
        items={[userSeg(), terminalSeg(), readSeg("r1"), readSeg("r2")]}
      />
    );
    const marker = screen.getByTestId("terminal-read-marker");
    expect(marker.textContent).toContain("读取终端「git-bash · 1」· 2 次");
    expect(marker.textContent).not.toContain("sess-abc");
    // read 段不再渲染通用工具卡
    expect(screen.queryByTestId("tool-call-card")).toBeNull();
  });
});
