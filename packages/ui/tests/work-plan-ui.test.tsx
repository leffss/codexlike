import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { MessageStream } from "../src/components/MessageStream";
import { setRememberedOpen } from "../src/lib/collapse-memory";
import {
  activeStep,
  collectPlanSnapshots,
  completedCount,
  currentPlan,
  parsePlanSteps,
} from "../src/lib/plan-view";
import type { MessageSegment, ToolCallSegment } from "../src/lib/task-view";

/**
 * 工作计划（GLOSSARY「工作计划」「计划项」，ADR 0016，原型 B 定稿）：
 * 派生层纯函数（参数解析 / 快照收集 / 当前计划 / 派生量）与呈现层
 * （常驻计划条 + 流内标记行 + 连续工具分组排除）。
 * Seam：renderToStaticMarkup（存在性与收起态默认值；开合交互由
 * collapse-memory 承载，静态渲染断言首帧 + setRememberedOpen 预置记忆）。
 */

let nextSeq = 0;

function userSeg(id: string, turnId: string): MessageSegment {
  return {
    kind: "user",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: null,
    content: "列个计划",
    at: 1_000,
  };
}

function planSeg(
  id: string,
  turnId: string,
  steps: { content: string; status: string }[],
  taskId = "s1"
): ToolCallSegment {
  return {
    kind: "tool-call",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: null,
    at: 2_000,
    taskId,
    toolName: "update_plan",
    arguments: JSON.stringify({ steps }),
    output: "工作计划已更新",
    isError: false,
    running: false,
  };
}

function textSeg(id: string, turnId: string): MessageSegment {
  return {
    kind: "assistant",
    id,
    seq: ++nextSeq,
    turnId,
    responseId: "m1",
    at: 3_000,
    content: `正文 ${id}`,
  };
}

/** 7 步清单（贴近 fixtures 主任务样例：5 完成 + 1 进行中 + 1 待办） */
const SEVEN_STEPS = [
  { content: "调研现有布局代码", status: "completed" },
  { content: "梳理分区与警告条现状清单", status: "completed" },
  { content: "标题栏改任务上下文行方案", status: "completed" },
  { content: "workspace-info 缩为标题栏徽章", status: "completed" },
  { content: "警告条合并为单条状态胶囊", status: "completed" },
  { content: "右栏两面板改 tab 切换", status: "in_progress" },
  { content: "布局变体原型与回归测试", status: "pending" },
];

function streamOf(items: MessageSegment[], taskId = "s1"): string {
  return renderToStaticMarkup(createElement(MessageStream, { items, taskId }));
}

beforeEach(() => {
  // collapse-memory 是模块全局态：每个用例独立 taskId 隔离开合记忆
  nextSeq = 0;
});

describe("plan-view 派生层纯函数", () => {
  it("parsePlanSteps：正常解析，id 按序号+内容补全供渲染 key", () => {
    const steps = parsePlanSteps(
      JSON.stringify({
        steps: [
          { content: "一", status: "in_progress" },
          { content: "二", status: "pending" },
        ],
      })
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ content: "一", status: "in_progress" });
    expect(steps.map((step) => step.id)).toEqual(["0-一", "1-二"]);
  });

  it("parsePlanSteps 宽容解析：非法 JSON / 非数组 / 空清单返回 []，缺 status 兜底 pending，空内容项过滤", () => {
    expect(parsePlanSteps("{oops")).toEqual([]);
    expect(parsePlanSteps('{"steps":"x"}')).toEqual([]);
    expect(parsePlanSteps('{"steps":[]}')).toEqual([]);
    expect(
      parsePlanSteps('{"steps":[{"content":"a"},{"content":"b","status":"x"}]}')
    ).toEqual([
      { id: "0-a", content: "a", status: "pending" },
      { id: "1-b", content: "b", status: "pending" },
    ]);
    expect(
      parsePlanSteps('{"steps":[{"content":"  ","status":"pending"}]}')
    ).toEqual([]);
  });

  it("collectPlanSnapshots / currentPlan：按段序收集，当前计划 = 最后一次 update_plan", () => {
    const items = [
      userSeg("u1", "t1"),
      planSeg("p1", "t1", [{ content: "一", status: "in_progress" }]),
      planSeg("p2", "t1", [{ content: "一", status: "completed" }]),
    ];
    const snapshots = collectPlanSnapshots(items);
    expect(snapshots.map((snapshot) => snapshot.segmentId)).toEqual([
      "p1",
      "p2",
    ]);
    expect(currentPlan(items)?.segmentId).toBe("p2");
    expect(currentPlan([userSeg("u1", "t1")])).toBeNull();
  });

  it("completedCount / activeStep：in_progress 优先，其次第一个未完成，兜底末项", () => {
    expect(
      completedCount(parsePlanSteps(JSON.stringify({ steps: SEVEN_STEPS })))
    ).toBe(5);
    expect(
      activeStep(parsePlanSteps(JSON.stringify({ steps: SEVEN_STEPS })))
        ?.content
    ).toBe("右栏两面板改 tab 切换");
    const allDone = SEVEN_STEPS.map((step) => ({
      ...step,
      status: "completed",
    }));
    expect(
      activeStep(parsePlanSteps(JSON.stringify({ steps: allDone })))?.content
    ).toBe("布局变体原型与回归测试");
  });
});

describe("工作计划呈现（常驻条 + 标记行，ADR 0016）", () => {
  it("有计划时渲染常驻条：当前步骤 + N/M 计数 + 进度条 + sticky 吸附，默认收起无步骤面板", () => {
    const html = streamOf([
      userSeg("u1", "t1"),
      planSeg("p1", "t1", SEVEN_STEPS),
      textSeg("a1", "t1"),
    ]);
    expect(html).toContain('data-testid="plan-banner"');
    expect(html).toContain('data-testid="plan-banner-count"');
    expect(html).toContain("5/7");
    expect(html).toContain("右栏两面板改 tab 切换");
    expect(html).toContain('data-testid="plan-progress-bar"');
    expect(html).toContain("sticky top-0");
    // 默认收起：完整步骤面板不渲染（当前状态由摘要行 + 进度条承载）
    expect(html).not.toContain('data-testid="plan-banner-panel"');
    // 全量参数 JSON 不进呈现层（对用户无阅读价值）
    expect(html).not.toContain('data-testid="tool-call-card"');
  });

  it("展开态（预置开合记忆）：完整步骤面板渲染，完成项删除线、进行中不删除线", () => {
    const items = [
      userSeg("u1", "t1"),
      planSeg("p1", "t1", SEVEN_STEPS, "s2"),
      textSeg("a1", "t1"),
    ];
    const html = renderToStaticMarkup(
      createElement(MessageStream, { items, taskId: "s2" })
    );
    // 预置展开记忆后重新渲染（SSR 下无法点击，直接验证记忆通道）
    setRememberedOpen("plan-banner-s2", true);
    const openHtml = renderToStaticMarkup(
      createElement(MessageStream, { items, taskId: "s2" })
    );
    expect(html).not.toContain('data-testid="plan-banner-panel"');
    expect(openHtml).toContain('data-testid="plan-banner-panel"');
    expect(openHtml).toContain("调研现有布局代码");
    expect(openHtml).toContain("line-through");
    expect(openHtml.match(/line-through/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("全部完成态：摘要显示「全部完成」+ 完成对勾", () => {
    const allDone = SEVEN_STEPS.map((step) => ({
      ...step,
      status: "completed",
    }));
    const html = streamOf(
      [userSeg("u1", "t1"), planSeg("p1", "t1", allDone), textSeg("a1", "t1")],
      "s3"
    );
    expect(html).toContain("全部完成");
    expect(html).toContain("7/7");
  });

  it("流内标记行：每次 update_plan 一行（计划更新 N + N/M + 当时步骤），相邻两次不成工具组", () => {
    const html = streamOf(
      [
        userSeg("u1", "t1"),
        planSeg("p1", "t1", [{ content: "一", status: "in_progress" }]),
        planSeg("p2", "t1", [{ content: "一", status: "completed" }]),
        textSeg("a1", "t1"),
      ],
      "s4"
    );
    const markers = html.match(/data-testid="plan-marker-row"/g);
    expect(markers).toHaveLength(2);
    expect(html).toContain("计划更新 1");
    expect(html).toContain("计划更新 2");
    expect(html).toContain("0/1");
    expect(html).toContain("1/1");
    // 分组排除（ADR 0016）：相邻 update_plan 不折叠成「update_plan × 2」组头
    expect(html).not.toContain('data-testid="tool-call-group"');
  });

  it("无计划时：常驻条与标记行都不渲染", () => {
    const html = streamOf([userSeg("u1", "t1"), textSeg("a1", "t1")], "s5");
    expect(html).not.toContain('data-testid="plan-banner"');
    expect(html).not.toContain('data-testid="plan-marker-row"');
  });

  it("运行中的 update_plan 段也走标记行（不进组、不渲染工具卡）", () => {
    const running = {
      ...planSeg("p1", "t1", SEVEN_STEPS, "s6"),
      running: true,
      startedAt: 2_000,
    };
    const html = streamOf(
      [userSeg("u1", "t1"), running, textSeg("a1", "t1")],
      "s6"
    );
    expect(html).toContain('data-testid="plan-marker-row"');
    expect(html).not.toContain('data-testid="tool-call-card"');
  });
});
