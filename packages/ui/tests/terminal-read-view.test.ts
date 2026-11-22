import { describe, expect, it } from "vitest";

import type { ThinkingSegment, ToolCallSegment } from "../src/lib/task-view";
import {
  isNoOutputRead,
  terminalReadSessionId,
} from "../src/lib/terminal-read-view";
import { foldTerminalReads, groupConsecutiveTools } from "../src/lib/turn-view";

/* 段工厂：只填聚合逻辑关心的字段，其余给最小合法值（同 turn-view.test.ts 口径） */

let nextSeq = 0;

function thinkSeg(id: string, turnId: string, at: number): ThinkingSegment {
  return {
    kind: "thinking",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: `resp-${turnId}`,
    content: `思考 ${id}`,
    at,
  };
}

/** terminal_read 调用段工厂：arguments 带 sessionId */
function readSeg(
  id: string,
  turnId: string,
  at: number,
  sessionId: string,
  extra: Partial<ToolCallSegment> = {}
): ToolCallSegment {
  return {
    kind: "tool-call",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: null,
    taskId: "s1",
    toolName: "terminal_read",
    arguments: JSON.stringify({ sessionId }),
    output: "构建输出增量",
    isError: false,
    running: false,
    at,
    ...extra,
  };
}

describe("foldTerminalReads：terminal_read 轮内锚点聚合（ADR 0033 read 锚点）", () => {
  it("跨思考段归并：轮内同会话历次读取收敛为单锚点，位置=首个 read，其余段时序原位", () => {
    const items = groupConsecutiveTools([
      thinkSeg("t1", "u1", 0),
      readSeg("r1", "u1", 1_000, "s-a"),
      thinkSeg("t2", "u1", 2_000),
      readSeg("r2", "u1", 3_000, "s-a"),
      thinkSeg("t3", "u1", 4_000),
      readSeg("r3", "u1", 5_000, "s-a"),
    ]);
    const folded = foldTerminalReads(items);
    expect(folded.map((item) => item.kind)).toEqual([
      "passthrough",
      "terminal-read",
      "passthrough",
      "passthrough",
    ]);
    const anchor = folded[1];
    if (anchor?.kind === "terminal-read") {
      expect(anchor.sessionId).toBe("s-a");
      expect(anchor.calls.map((call) => call.id)).toEqual(["r1", "r2", "r3"]);
    }
  });

  it("连续 read 先被折成 group 形态，同样收纳为锚点（常见路径）", () => {
    const items = groupConsecutiveTools([
      readSeg("r1", "u1", 0, "s-a"),
      readSeg("r2", "u1", 1_000, "s-a"),
      readSeg("r3", "u1", 2_000, "s-a"),
    ]);
    // 前置事实：连续同名已完成卡确实折成了 group
    expect(items[0]?.kind).toBe("group");
    const folded = foldTerminalReads(items);
    expect(folded).toHaveLength(1);
    const anchor = folded[0];
    if (anchor?.kind === "terminal-read") {
      expect(anchor.sessionId).toBe("s-a");
      expect(anchor.calls.map((call) => call.id)).toEqual(["r1", "r2", "r3"]);
    }
  });

  it("多会话各自成锚点：位置=各会话首个 read 的时序位置", () => {
    const items = groupConsecutiveTools([
      readSeg("r1", "u1", 0, "s-a"),
      readSeg("b1", "u1", 1_000, "s-b"),
      thinkSeg("t1", "u1", 2_000),
      readSeg("r2", "u1", 3_000, "s-a"),
    ]);
    const folded = foldTerminalReads(items);
    // 前两个 read 同名相邻被折成同一个 group；s-a 与 s-b 的锚点都在该
    // group 的时序位置上（r1 先于 b1），随后思考段与 s-a 第二次读原位
    expect(folded.map((item) => item.kind)).toEqual([
      "terminal-read",
      "terminal-read",
      "passthrough",
    ]);
    const [anchorA, anchorB] = folded;
    if (anchorA?.kind === "terminal-read") {
      expect(anchorA.sessionId).toBe("s-a");
      expect(anchorA.calls.map((call) => call.id)).toEqual(["r1", "r2"]);
    }
    if (anchorB?.kind === "terminal-read") {
      expect(anchorB.sessionId).toBe("s-b");
      expect(anchorB.calls.map((call) => call.id)).toEqual(["b1"]);
    }
  });

  it("运行中的 read 段并入锚点（wait 等待实时态由锚点行表达，不另挂单卡）", () => {
    const items = groupConsecutiveTools([
      readSeg("r1", "u1", 0, "s-a"),
      readSeg("r2", "u1", 1_000, "s-a", { running: true, output: "" }),
    ]);
    // 前置事实：运行中卡不进组，第一个已完成卡为 single
    expect(items.map((item) => item.kind)).toEqual(["single", "single"]);
    const folded = foldTerminalReads(items);
    expect(folded).toHaveLength(1);
    const anchor = folded[0];
    if (anchor?.kind === "terminal-read") {
      expect(anchor.calls.map((call) => call.id)).toEqual(["r1", "r2"]);
    }
  });

  it("参数畸形的 read（缺 sessionId）退回原工具卡，不丢段", () => {
    const malformed: ToolCallSegment = {
      ...readSeg("bad1", "u1", 0, "ignored"),
      arguments: '{"timeoutMs":1000}',
    };
    const items = groupConsecutiveTools([
      malformed,
      readSeg("r1", "u1", 1_000, "s-a"),
    ]);
    const folded = foldTerminalReads(items);
    expect(folded.map((item) => item.kind)).toEqual([
      "single",
      "terminal-read",
    ]);
    if (folded[0]?.kind === "single") {
      expect(folded[0].segment.id).toBe("bad1");
    }
  });

  it("无 read 调用的序列原样返回（其他工具分组与透传不受影响）", () => {
    const items = groupConsecutiveTools([
      thinkSeg("t1", "u1", 0),
      readSeg("r1", "u1", 1_000, "s-a", { toolName: "read_file" }),
    ]);
    expect(foldTerminalReads(items)).toBe(items);
  });
});

describe("terminalReadSessionId / isNoOutputRead：read 调用域判定", () => {
  it("解析 read 调用的目标会话 id；非 read 调用与畸形参数返回 undefined", () => {
    expect(terminalReadSessionId(readSeg("r1", "u1", 0, "s-a"))).toBe("s-a");
    expect(
      terminalReadSessionId(
        readSeg("c1", "u1", 0, "ignored", {
          toolName: "terminal_write",
          arguments: '{"sessionId":"s-a","command":"ls\\n"}',
        })
      )
    ).toBeUndefined();
    expect(
      terminalReadSessionId({
        ...readSeg("bad1", "u1", 0, "ignored"),
        arguments: "not json",
      })
    ).toBeUndefined();
  });

  it("空读判定：已完成且输出为「暂无新输出」标记文案；运行中与有输出不算空读", () => {
    expect(
      isNoOutputRead(
        readSeg("r1", "u1", 0, "s-a", {
          output: "[暂无新输出——会话运行中，可用 wait=true 等待新输出]",
        })
      )
    ).toBe(true);
    expect(isNoOutputRead(readSeg("r2", "u1", 0, "s-a", { output: "" }))).toBe(
      false
    );
    expect(
      isNoOutputRead(
        readSeg("r3", "u1", 0, "s-a", {
          running: true,
          output: "[暂无新输出——会话运行中，可用 wait=true 等待新输出]",
        })
      )
    ).toBe(false);
  });
});
