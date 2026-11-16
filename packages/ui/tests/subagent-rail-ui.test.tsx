import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { setRememberedOpen } from "../src/lib/collapse-memory";
import { MessageStream } from "../src/components/MessageStream";
import {
  SubagentRailPanelBody,
  formatElapsed,
} from "../src/components/SubagentRailPanel";
import { SubagentStreamMarker } from "../src/components/SubagentStreamMarker";
import type {
  MessageSegment,
  SubagentSegment,
  SubagentToolCall,
} from "../src/lib/task-view";

function subSeg(
  id: string,
  overrides: Partial<SubagentSegment> = {}
): SubagentSegment {
  return {
    kind: "subagent",
    id,
    seq: 1,
    turnId: "u1",
    responseId: null,
    toolCallId: `delegate-${id}`,
    task: `任务 ${id}`,
    state: "done",
    startedAt: "2026-11-12T08:00:00.000Z",
    endedAt: "2026-11-12T08:00:30.000Z",
    report: "报告正文",
    ok: true,
    tools: [],
    ...overrides,
  };
}

const TOOL: SubagentToolCall = {
  id: "t1",
  taskId: "task-1",
  toolName: "read_file",
  arguments: '{"path":"a.ts"}',
  output: "内容",
  isError: false,
  startedAt: 1_000,
  endedAt: 3_000,
};

describe("SubagentRailPanelBody（SSR 静态结构，ADR 0020）", () => {
  it("空列表：占位提示，不渲染列表", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, { subagents: [], focus: null })
    );
    expect(html).toContain("本任务尚无子代理委派");
    expect(html).not.toMatch(/data-testid="subagent-rail-item"/);
  });

  it("默认选中最后一个（最新）：列表项与详情同渲染，报告直接可读", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [subSeg("sa-1"), subSeg("sa-2", { report: "最新报告" })],
        focus: null,
      })
    );
    expect(html).toMatch(
      /data-testid="subagent-rail-item"[^>]*data-subagent-state="done"/
    );
    expect((html.match(/data-testid="subagent-rail-item"/g) ?? []).length).toBe(
      2
    );
    // 详情：默认最后一个被选中（bg-hover）且报告直接渲染（无展开记忆门槛）
    expect(html).toContain("最新报告");
    expect(html).toMatch(/data-testid="subagent-report"/);
    expect(html).toMatch(/data-testid="subagent-report-copy"/);
    expect(html).toMatch(/data-testid="subagent-report-export"/);
    expect(html).toMatch(/data-testid="subagent-report-completed-at"/);
  });

  it("恢复态完成（无起止对）与失败委派：不显示完成时间，失败无绿态", () => {
    const restored = subSeg("sa-r", {
      startedAt: null,
      endedAt: null,
    });
    const failed = subSeg("sa-f", {
      ok: false,
      report: "子代理执行失败：API 429",
      startedAt: null,
      endedAt: null,
    });
    const html = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [restored, failed],
        focus: null,
      })
    );
    expect(html).not.toMatch(/data-testid="subagent-report-completed-at"/);
    expect(html).toContain("失败");
    expect(html).toContain("API 429");
  });

  it("事件态完成（含 endedAt）：显示完成于时间；工具清单折叠在报告后", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [subSeg("sa-e", { tools: [TOOL] })],
        focus: null,
      })
    );
    expect(html).toMatch(/完成于/);
    expect(html).toMatch(/data-testid="subagent-tools"/);
    // 工具清单默认收起：details 无 open 属性（内容在 DOM，视觉折叠）
    const tools = html.match(
      /<details[^>]*data-testid="subagent-tools"[^>]*>/
    )?.[0];
    expect(tools).not.toContain('open=""');
  });

  it("运行中：当前活动工具与思考块默认展开（流式），无报告操作行", () => {
    const running = subSeg("sa-run", {
      state: "running",
      endedAt: null,
      report: null,
      ok: null,
      reasoning: "流式思考增量",
      tools: [{ ...TOOL, running: true }],
    });
    const html = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [running],
        focus: null,
      })
    );
    expect(html).toMatch(
      /data-testid="subagent-rail-item"[^>]*data-subagent-state="running"/
    );
    expect(html).toContain("read_file");
    const block = html.match(
      /<details[^>]*data-testid="subagent-thinking-block"[^>]*>/
    )?.[0];
    expect(block).toContain('open=""');
    expect(html).not.toMatch(/data-testid="subagent-report-actions"/);
  });

  it("委派说明块：主代理委派正文特殊标明，默认 line-clamp-3 部分显示", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [subSeg("sa-d")],
        focus: null,
      })
    );
    expect(html).toMatch(/data-testid="subagent-delegation"/);
    expect(html).toContain("主代理的委派说明");
    // accent 左边框引述样式（与子代理自身产出区分）
    expect(html).toMatch(/data-testid="subagent-delegation"[^>]*border-accent/);
    // 默认收起：正文带 line-clamp-3；SSR 无测量，切换按钮不渲染
    expect(html).toMatch(
      /data-testid="subagent-delegation-text"[^>]*line-clamp-3/
    );
    expect(html).not.toMatch(/data-testid="subagent-delegation-toggle"/);
  });

  it("委派说明块：预置展开记忆时正文无截断类；空任务给占位", () => {
    setRememberedOpen("subagent-delegation-sa-open", true);
    const opened = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [subSeg("sa-open")],
        focus: null,
      })
    );
    const openedText = opened.match(
      /data-testid="subagent-delegation-text"[^>]*>任务 sa-open/
    )?.[0];
    expect(openedText).toBeDefined();
    expect(openedText).not.toContain("line-clamp-3");

    const empty = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [subSeg("sa-empty", { task: "" })],
        focus: null,
      })
    );
    expect(empty).toContain("（任务描述缺失）");
  });
});

describe("SubagentStreamMarker（消息流标记行，ADR 0020）", () => {
  it("单行标记：徽章 + 任务 + 状态 + 引导，不含报告正文", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentStreamMarker, { subagent: subSeg("sa-1") })
    );
    expect(html).toMatch(/data-testid="subagent-stream-marker"/);
    expect(html).toMatch(
      /data-testid="subagent-stream-marker-toggle"[^>]*data-subagent-state="done"/
    );
    expect(html).toContain("子代理");
    expect(html).toContain("右栏查看 →");
    expect(html).toContain("完成");
    expect(html).not.toContain("报告正文");
  });

  it("经 MessageStream 渲染：标记行在消息流内（大卡退役）", () => {
    const items: MessageSegment[] = [
      {
        kind: "user",
        id: "u1",
        seq: 1,
        turnId: "u1",
        responseId: null,
        content: "去调研",
      },
      subSeg("sa-1"),
    ];
    const html = renderToStaticMarkup(
      createElement(MessageStream, { items, taskId: "t1" })
    );
    expect(html).toMatch(/data-testid="subagent-stream-marker"/);
    expect(html).not.toMatch(/data-testid="subagent-card"/);
  });
});

describe("formatElapsed（已用时定格/跳动基准）", () => {
  it("完成态以 endedAt 定格总耗时", () => {
    expect(formatElapsed(subSeg("sa-1"), 9_999_999)).toBe("00:30");
  });
  it("运行中以传入 now 实时计算；恢复态无 startedAt 不显示", () => {
    const running = subSeg("sa-r", {
      state: "running",
      startedAt: "2026-11-12T08:00:00.000Z",
      endedAt: null,
    });
    expect(formatElapsed(running, Date.parse("2026-11-12T08:01:05.000Z"))).toBe(
      "01:05"
    );
    expect(formatElapsed(subSeg("sa-x", { startedAt: null }), 0)).toBeNull();
  });
});
