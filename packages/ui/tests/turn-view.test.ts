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

/* 段工厂：只填切分逻辑关心的字段，其余给最小合法值 */

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

/** 轮视图指纹：user / history / following 的段 id 序列 + 开合与工时 */
function fingerprint(turn: ReturnType<typeof groupTurns>[number]) {
  return {
    user: turn.user?.id ?? null,
    history: turn.history.map((item) => item.id),
    following: turn.following.map((item) => item.id),
    open: turn.historyDefaultOpen,
    running: turn.running,
    durationMs: turn.durationMs,
  };
}

describe("groupTurns：轮次聚合与轮内切分（ADR 0011 呈现分层）", () => {
  it("以最终正文为界切分：之前的过程段进折叠区，最终正文与其后的段跟随显示", () => {
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
        history: ["t1", "a1", "c1", "t2", "a2"],
        following: ["a3"],
        open: false,
        running: false,
        durationMs: 6_000,
      },
    ]);
  });

  it("无正文的轮全部过程段进折叠区，跟随区为空", () => {
    const turns = groupTurns([
      userSeg("u1", "u1", 0),
      thinkSeg("t1", "u1", 1_000),
      toolSeg("c1", "u1", 2_000),
    ]);
    expect(turns.map(fingerprint)).toEqual([
      {
        user: "u1",
        history: ["t1", "c1"],
        following: [],
        open: false,
        running: false,
        durationMs: 2_000,
      },
    ]);
  });

  it("用户消息段不进折叠区，作为轮次起点单独呈现", () => {
    const turns = groupTurns([
      userSeg("u1", "u1", 0),
      toolSeg("c1", "u1", 1_000),
      textSeg("a1", "u1", 2_000),
    ]);
    const [turn] = turns;
    expect(turn?.user?.kind).toBe("user");
    expect(turn?.history.map((item) => item.id)).toEqual(["c1"]);
    expect(turn?.following.map((item) => item.id)).toEqual(["a1"]);
  });

  it("运行中的轮强制展开（流态段 / 运行中工具卡 / 运行中子代理任一成立）", () => {
    const streamingText = groupTurns([
      userSeg("u1", "u1", 0),
      textSeg("a1", "u1", 1_000, { streaming: true }),
    ]);
    expect(streamingText[0]?.historyDefaultOpen).toBe(true);
    expect(streamingText[0]?.running).toBe(true);

    const runningTool = groupTurns([
      userSeg("u1", "u1", 0),
      toolSeg("c1", "u1", 1_000, { running: true }),
    ]);
    expect(runningTool[0]?.historyDefaultOpen).toBe(true);
    expect(runningTool[0]?.running).toBe(true);

    const runningSubagent = groupTurns([
      userSeg("u1", "u1", 0),
      subSeg("sub1", "u1", 1_000, "running"),
    ]);
    expect(runningSubagent[0]?.historyDefaultOpen).toBe(true);
    expect(runningSubagent[0]?.running).toBe(true);
  });

  it("中断终态的轮强制展开", () => {
    const turns = groupTurns([
      userSeg("u1", "u1", 0),
      thinkSeg("t1", "u1", 1_000),
      toolSeg("c1", "u1", 2_000),
      textSeg("a1", "u1", 3_000, { interrupted: true }),
    ]);
    expect(turns[0]?.historyDefaultOpen).toBe(true);
    expect(turns[0]?.running).toBe(false);
  });

  it("错误终态的轮强制展开（错误段即失败终态）", () => {
    const turns = groupTurns([
      userSeg("u1", "u1", 0),
      thinkSeg("t1", "u1", 1_000),
      errorSeg("e1", "u1", 2_000),
    ]);
    expect(turns[0]?.historyDefaultOpen).toBe(true);
  });

  it("正常完成的轮默认收起", () => {
    const turns = groupTurns([
      userSeg("u1", "u1", 0),
      thinkSeg("t1", "u1", 1_000),
      toolSeg("c1", "u1", 2_000),
      textSeg("a1", "u1", 3_000),
    ]);
    expect(turns[0]?.historyDefaultOpen).toBe(false);
    expect(turns[0]?.running).toBe(false);
  });

  it("多轮按序切分互不影响", () => {
    const turns = groupTurns([
      userSeg("u1", "u1", 0),
      toolSeg("c1", "u1", 1_000),
      textSeg("a1", "u1", 2_000),
      userSeg("u2", "u2", 3_000),
      textSeg("a2", "u2", 4_000),
    ]);
    expect(turns.map((turn) => turn.turnId)).toEqual(["u1", "u2"]);
    expect(turns[0]?.history.map((item) => item.id)).toEqual(["c1"]);
    expect(turns[1]?.history).toEqual([]);
    expect(turns[1]?.following.map((item) => item.id)).toEqual(["a2"]);
  });

  it("工时 = 段时间线极差（终点取 endedAt/completedAt，流式时长计入）；段缺时间数据则为 null", () => {
    const withTime = groupTurns([
      userSeg("u1", "u1", 1_000),
      toolSeg("c1", "u1", 4_000, { startedAt: 4_000, endedAt: 6_000 }),
      // 最终正文：建立 9_500，流式到 12_000 才完成（completedAt 定格终点）
      textSeg("a1", "u1", 9_500, { completedAt: 12_000 }),
    ]);
    expect(withTime[0]?.durationMs).toBe(11_000);
    expect(withTime[0]?.startedAtMs).toBe(1_000);

    // 思考段收敛打点（endedAt）同样计入终点
    const withThinking = groupTurns([
      userSeg("u1", "u1", 1_000),
      thinkSeg("t1", "u1", 2_000, { endedAt: 6_500 }),
      textSeg("a1", "u1", 8_000),
    ]);
    expect(withThinking[0]?.durationMs).toBe(7_000);

    const noTime = groupTurns([
      { ...userSeg("u1", "u1", 0), at: undefined },
      textSeg("a1", "u1", 1_000),
    ]);
    expect(noTime[0]?.durationMs).toBeNull();
    expect(noTime[0]?.startedAtMs).toBeNull();
  });

  it("兜底轮（无用户段）同样按最终正文切分", () => {
    const turns = groupTurns([
      thinkSeg("t1", "fallback", 1_000),
      textSeg("a1", "fallback", 2_000),
    ]);
    expect(turns.map(fingerprint)).toEqual([
      {
        user: null,
        history: ["t1"],
        following: ["a1"],
        open: false,
        running: false,
        durationMs: 1_000,
      },
    ]);
  });

  it("交互/错误/状态段穿透折叠区（用户可见节点不进「已工作」过程区）", () => {
    const turns = groupTurns([
      userSeg("u1", "u1", 0),
      thinkSeg("t1", "u1", 1_000),
      toolSeg("c1", "u1", 2_000),
      {
        kind: "interaction",
        id: "r1",
        seq: 90,
        turnId: "u1",
        responseId: null,
        interaction: {} as never,
      },
      errorSeg("e1", "u1", 3_000),
      textSeg("a1", "u1", 4_000),
    ]);
    expect(turns[0]?.history.map((item) => item.id)).toEqual(["t1", "c1"]);
    // 穿透段按相对顺序显示在折叠区之后、最终正文之前
    expect(turns[0]?.following.map((item) => item.id)).toEqual([
      "r1",
      "e1",
      "a1",
    ]);
  });

  it("宿主运行态把最后一轮视为运行中（工具间隙无 running 段也不收起）", () => {
    const segments = [
      userSeg("u1", "u1", 0),
      toolSeg("c1", "u1", 1_000), // 已完成，段级无运行标记
    ];
    // 工具回填后、下一段事件前：段级全部静止，但宿主仍执行中
    const turns = groupTurns(segments, { lastTurnRunning: true });
    expect(turns[0]?.running).toBe(true);
    expect(turns[0]?.historyDefaultOpen).toBe(true);
    // 宿主静止时回归段级判定
    const idle = groupTurns(segments);
    expect(idle[0]?.running).toBe(false);
    expect(idle[0]?.historyDefaultOpen).toBe(false);
  });

  it("空序列与单用户段序列返回空/无折叠结构", () => {
    expect(groupTurns([])).toEqual([]);
    const onlyUser = groupTurns([userSeg("u1", "u1", 0)]);
    expect(onlyUser[0]?.history).toEqual([]);
    expect(onlyUser[0]?.following).toEqual([]);
    expect(onlyUser[0]?.user?.id).toBe("u1");
  });
});

describe("formatWorkDuration：已工作折叠区摘要行工时（用户故事 21）", () => {
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
});
