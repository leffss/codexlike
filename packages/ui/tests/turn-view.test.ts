import { describe, expect, it } from "vitest";

import type {
  AssistantSegment,
  ErrorSegment,
  SubagentSegment,
  ThinkingSegment,
  ToolCallSegment,
  UserSegment,
} from "../src/lib/task-view";
import {
  formatWorkDuration,
  groupConsecutiveTools,
  groupTurns,
} from "../src/lib/turn-view";

/* 段工厂：只填聚合逻辑关心的字段，其余给最小合法值 */

let nextSeq = 0;

function userSeg(id: string, turnId: string, at: number): UserSegment {
  return {
    kind: "user",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: null,
    content: `用户消息 ${id}`,
    at,
  };
}

function textSeg(
  id: string,
  turnId: string,
  at: number,
  extra: Partial<AssistantSegment> = {}
): AssistantSegment {
  return {
    kind: "assistant",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: `resp-${turnId}`,
    content: `正文 ${id}`,
    at,
    ...extra,
  };
}

function thinkSeg(
  id: string,
  turnId: string,
  at: number,
  extra: Partial<ThinkingSegment> = {}
): ThinkingSegment {
  return {
    kind: "thinking",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: `resp-${turnId}`,
    content: `思考 ${id}`,
    at,
    ...extra,
  };
}

function toolSeg(
  id: string,
  turnId: string,
  at: number,
  extra: Partial<ToolCallSegment> = {}
): ToolCallSegment {
  return {
    kind: "tool-call",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: null,
    taskId: "s1",
    toolName: "read_file",
    arguments: '{"path":"a.txt"}',
    output: "输出",
    isError: false,
    running: false,
    at,
    ...extra,
  };
}

function subSeg(
  id: string,
  turnId: string,
  at: number,
  state: SubagentSegment["state"]
): SubagentSegment {
  return {
    kind: "subagent",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: null,
    toolCallId: "",
    task: "任务",
    state,
    startedAt: null,
    endedAt: null,
    report: state === "done" ? "报告" : null,
    ok: state === "done" ? true : null,
    tools: [],
    at,
  };
}

function errorSeg(id: string, turnId: string, at: number): ErrorSegment {
  return {
    kind: "error",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: null,
    content: "模型请求失败",
    at,
  };
}

/** 轮视图指纹：user / segments 的段 id 序列 + 运行态与最终正文锚点 */
function fingerprint(turn: ReturnType<typeof groupTurns>[number]) {
  return {
    user: turn.user?.id ?? null,
    segments: turn.segments.map((item) => item.id),
    running: turn.running,
    finalAssistantId: turn.finalAssistantId,
  };
}

describe("groupTurns：轮次聚合（ADR 0011 呈现分层、ADR 0015 逐段呈现）", () => {
  it("轮内段保持事件原序平铺，最终正文锚点指向轮内最后一段正文", () => {
    const turns = groupTurns([
      userSeg("u1", "u1", 0),
      thinkSeg("t1", "u1", 1_000),
      textSeg("a1", "u1", 2_000),
      toolSeg("c1", "u1", 3_000),
      thinkSeg("t2", "u1", 4_000),
      textSeg("a2", "u1", 5_000),
      textSeg("a3", "u1", 6_000), // 最终正文（轮内最后一段正文）
    ]);
    expect(turns.map(fingerprint)).toEqual([
      {
        user: "u1",
        segments: ["t1", "a1", "c1", "t2", "a2", "a3"],
        running: false,
        finalAssistantId: "a3",
      },
    ]);
  });

  it("无正文的轮全部段平铺，最终正文锚点为 null", () => {
    const turns = groupTurns([
      userSeg("u1", "u1", 0),
      thinkSeg("t1", "u1", 1_000),
      toolSeg("c1", "u1", 2_000),
    ]);
    expect(turns.map(fingerprint)).toEqual([
      {
        user: "u1",
        segments: ["t1", "c1"],
        running: false,
        finalAssistantId: null,
      },
    ]);
  });

  it("用户消息段不进 segments，作为轮次起点单独呈现", () => {
    const turns = groupTurns([
      userSeg("u1", "u1", 0),
      toolSeg("c1", "u1", 1_000),
      textSeg("a1", "u1", 2_000),
    ]);
    const [turn] = turns;
    expect(turn?.user?.kind).toBe("user");
    expect(turn?.segments.map((item) => item.id)).toEqual(["c1", "a1"]);
    expect(turn?.finalAssistantId).toBe("a1");
  });

  it("运行中判定：流态段 / 运行中工具卡 / 运行中子代理任一成立", () => {
    const streamingText = groupTurns([
      userSeg("u1", "u1", 0),
      textSeg("a1", "u1", 1_000, { streaming: true }),
    ]);
    expect(streamingText[0]?.running).toBe(true);

    const runningTool = groupTurns([
      userSeg("u1", "u1", 0),
      toolSeg("c1", "u1", 1_000, { running: true }),
    ]);
    expect(runningTool[0]?.running).toBe(true);

    const runningSubagent = groupTurns([
      userSeg("u1", "u1", 0),
      subSeg("sub1", "u1", 1_000, "running"),
    ]);
    expect(runningSubagent[0]?.running).toBe(true);
  });

  it("多轮按序聚簇互不影响", () => {
    const turns = groupTurns([
      userSeg("u1", "u1", 0),
      toolSeg("c1", "u1", 1_000),
      textSeg("a1", "u1", 2_000),
      userSeg("u2", "u2", 3_000),
      textSeg("a2", "u2", 4_000),
    ]);
    expect(turns.map((turn) => turn.turnId)).toEqual(["u1", "u2"]);
    expect(turns[0]?.segments.map((item) => item.id)).toEqual(["c1", "a1"]);
    expect(turns[1]?.segments.map((item) => item.id)).toEqual(["a2"]);
    expect(turns[1]?.finalAssistantId).toBe("a2");
  });

  it("兜底轮（无用户段）同样平铺", () => {
    const turns = groupTurns([
      thinkSeg("t1", "fallback", 1_000),
      textSeg("a1", "fallback", 2_000),
    ]);
    expect(turns.map(fingerprint)).toEqual([
      {
        user: null,
        segments: ["t1", "a1"],
        running: false,
        finalAssistantId: "a1",
      },
    ]);
  });

  it("宿主运行态把最后一轮视为运行中（工具间隙无 running 段不闪断）", () => {
    const segments = [
      userSeg("u1", "u1", 0),
      toolSeg("c1", "u1", 1_000), // 已完成，段级无运行标记
    ];
    // 工具回填后、下一段事件前：段级全部静止，但宿主仍执行中
    const turns = groupTurns(segments, { lastTurnRunning: true });
    expect(turns[0]?.running).toBe(true);
    // 宿主静止时回归段级判定
    const idle = groupTurns(segments);
    expect(idle[0]?.running).toBe(false);
  });

  it("空序列返回空数组", () => {
    expect(groupTurns([])).toEqual([]);
    const onlyUser = groupTurns([userSeg("u1", "u1", 0)]);
    expect(onlyUser).toHaveLength(1);
    expect(onlyUser[0]?.segments).toEqual([]);
    expect(onlyUser[0]?.user?.id).toBe("u1");
    expect(onlyUser[0]?.finalAssistantId).toBeNull();
  });
});

describe("formatWorkDuration：底部运行行工时文案（秒四舍五入）", () => {
  it("秒级与分级工时的人可读格式", () => {
    expect(formatWorkDuration(400)).toBe("0 秒");
    expect(formatWorkDuration(3_400)).toBe("3 秒");
    expect(formatWorkDuration(80_000)).toBe("1 分 20 秒");
    expect(formatWorkDuration(120_000)).toBe("2 分");
  });
});

describe("groupConsecutiveTools：连续同类工具统计分组（spec 用户故事 29）", () => {
  it("连续同类已完成的工具卡合并为统计组", () => {
    const items = groupConsecutiveTools([
      toolSeg("c1", "u1", 0),
      toolSeg("c2", "u1", 1, { toolName: "read_file" }),
      toolSeg("c3", "u1", 2, { toolName: "read_file" }),
    ]);
    expect(items).toEqual([
      {
        kind: "group",
        toolName: "read_file",
        segments: expect.any(Array),
        hasError: false,
      },
    ]);
    const group = items[0];
    if (group?.kind === "group") {
      expect(group.segments.map((seg) => seg.id)).toEqual(["c1", "c2", "c3"]);
    }
  });

  it("运行中的工具卡不参与分组（实时可见）", () => {
    const items = groupConsecutiveTools([
      toolSeg("c1", "u1", 0),
      toolSeg("c2", "u1", 1),
      toolSeg("c3", "u1", 2, { running: true, toolName: "read_file" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["group", "single"]);
  });

  it("不同类工具不相邻合并，单张卡不成组", () => {
    const items = groupConsecutiveTools([
      toolSeg("c1", "u1", 0, { toolName: "read_file" }),
      toolSeg("c2", "u1", 1, { toolName: "grep" }),
      toolSeg("c3", "u1", 2, { toolName: "read_file" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "single",
      "single",
      "single",
    ]);
  });

  it("非工具段打断连续性（透传且两侧工具卡不合并）", () => {
    const items = groupConsecutiveTools([
      toolSeg("c1", "u1", 0),
      thinkSeg("t1", "u1", 1),
      toolSeg("c2", "u1", 2),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "single",
      "passthrough",
      "single",
    ]);
  });

  it("非工具过程段原样透传（不丢段：思考/中间正文夹在工具卡之间保持时序）", () => {
    const items = groupConsecutiveTools([
      thinkSeg("t1", "u1", 0),
      toolSeg("c1", "u1", 1),
      textSeg("a1", "u1", 2),
      toolSeg("c2", "u1", 3),
      toolSeg("c3", "u1", 4),
    ]);
    expect(items).toEqual([
      { kind: "passthrough", segment: expect.objectContaining({ id: "t1" }) },
      { kind: "single", segment: expect.objectContaining({ id: "c1" }) },
      { kind: "passthrough", segment: expect.objectContaining({ id: "a1" }) },
      {
        kind: "group",
        toolName: "read_file",
        segments: [
          expect.objectContaining({ id: "c2" }),
          expect.objectContaining({ id: "c3" }),
        ],
        hasError: false,
      },
    ]);
  });

  it("组头可判失败：组内含失败卡时带失败标记", () => {
    const items = groupConsecutiveTools([
      toolSeg("c1", "u1", 0),
      toolSeg("c2", "u1", 1, { isError: true }),
    ]);
    const group = items[0];
    expect(group?.kind).toBe("group");
    if (group?.kind === "group") {
      expect(group.hasError).toBe(true);
    }
  });

  it("错误段透传且打断连续性（用户可见节点按时序原位显示）", () => {
    const items = groupConsecutiveTools([
      toolSeg("c1", "u1", 0),
      errorSeg("e1", "u1", 1),
      toolSeg("c2", "u1", 2),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "single",
      "passthrough",
      "single",
    ]);
  });
});
