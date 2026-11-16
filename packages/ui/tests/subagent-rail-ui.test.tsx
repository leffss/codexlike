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

  it("默认选中最后一个（最新）：摘要行计数 + 当前行锚点 + 详情报告直接可读", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [subSeg("sa-1"), subSeg("sa-2", { report: "最新报告" })],
        focus: null,
      })
    );
    // 摘要行常驻：总数一目了然（浮层收起，列表行不渲染）
    expect(html).toMatch(/data-testid="subagent-rail-summary"/);
    expect(html).toContain("子代理 2 个");
    expect(html).not.toMatch(/data-testid="subagent-rail-item"/);
    // 当前行：默认最后一个（最新）作为详情锚点
    expect(html).toMatch(
      /data-testid="subagent-rail-current"[^>]*data-subagent-state="done"/
    );
    expect(html).toContain("任务 sa-2");
    // 详情：报告直接渲染（无展开记忆门槛）
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
      /data-testid="subagent-rail-current"[^>]*data-subagent-state="running"/
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

  it("正文折叠块（票 04）：完成态默认收起、逐轮分段、与思考折叠同构；报告块呈现不变", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [
          subSeg("sa-body", {
            startedAt: "2026-11-14T08:00:02.000Z",
            endedAt: "2026-11-14T08:00:30.000Z",
            turns: [
              { reasoning: "第一轮思考", content: "第一轮正文" },
              { content: "最终报告：已梳理" },
            ],
          }),
        ],
        focus: null,
      })
    );
    // 与思考折叠同构：details/summary 结构，完成态默认收起（无 open）
    const block = html.match(
      /<details[^>]*data-testid="subagent-body-block"[^>]*>/
    )?.[0];
    expect(block).toBeDefined();
    expect(block).not.toContain('open=""');
    expect(html).toMatch(/data-testid="subagent-body-toggle"/);
    // 逐轮分段：轮次标签 + 各轮正文（最终轮即报告轮，正文内含报告文本）
    expect(html).toMatch(/data-testid="subagent-body-round-1"/);
    expect(html).toMatch(/data-testid="subagent-body-round-2"/);
    expect(html).toContain("第一轮正文");
    // 分轮思考：思考折叠块同样逐轮
    expect(html).toMatch(/data-testid="subagent-thinking-round-1"/);
    expect(html).toContain("第一轮思考");
    // 完成态报告块呈现不变：报告与操作行照旧
    expect(html).toMatch(/data-testid="subagent-report"/);
    expect(html).toMatch(/data-testid="subagent-report-actions"/);
  });

  it("正文折叠块：运行态默认展开流式；collapse-memory 独立键与思考块互不影响", () => {
    setRememberedOpen("subagent-body-sa-run2", false);
    setRememberedOpen("subagent-thinking-sa-run2", true);
    const html = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [
          subSeg("sa-run2", {
            state: "running",
            endedAt: null,
            report: null,
            ok: null,
            turns: [{ reasoning: "进行中的思考", content: "流式正文增量" }],
          }),
        ],
        focus: null,
      })
    );
    // 思考块预置展开记忆生效；正文块独立键：记忆为收起（用户手动收过）
    const body = html.match(
      /<details[^>]*data-testid="subagent-body-block"[^>]*>/
    )?.[0];
    const thinking = html.match(
      /<details[^>]*data-testid="subagent-thinking-block"[^>]*>/
    )?.[0];
    expect(body).toBeDefined();
    expect(thinking).toBeDefined();
    expect(body).not.toContain('open=""');
    expect(thinking).toContain('open=""');
    expect(html).toContain("流式正文增量");
  });

  it("旧记录（无 turns、仅拼接种 reasoning）：思考折叠单段呈现，不渲染正文折叠块", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [subSeg("sa-legacy", { reasoning: "旧记录拼接的思考" })],
        focus: null,
      })
    );
    expect(html).toContain("旧记录拼接的思考");
    expect(html).not.toMatch(/data-testid="subagent-body-block"/);
    // 旧记录无轮边界：不出现「第 N 轮」分轮标签
    expect(html).not.toContain("第 1 轮");
  });

  it("interrupted 委派（票 04）：列表状态点/详情徽章/中断说明；无报告操作行，已发生内容可回看", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentRailPanelBody, {
        subagents: [
          subSeg("sa-int", {
            state: "interrupted",
            endedAt: "2026-11-14T08:00:09.000Z",
            report: null,
            ok: false,
            startedAt: "2026-11-14T08:00:03.000Z",
            turns: [{ content: "中断前已写出的部分正文" }],
            tools: [TOOL],
          }),
        ],
        focus: null,
      })
    );
    // 当前行状态点 + 详情徽章（委派说明块头）同文案
    expect(html).toMatch(
      /data-testid="subagent-rail-current"[^>]*data-subagent-state="interrupted"/
    );
    expect(html.match(/运行中被中断/g)?.length).toBeGreaterThanOrEqual(2);
    // 中断说明 + 已发生过程内容可回看（正文折叠 + 工具清单）
    expect(html).toMatch(/data-testid="subagent-interrupted-note"/);
    expect(html).toMatch(/data-testid="subagent-body-block"/);
    expect(html).toContain("中断前已写出的部分正文");
    expect(html).toMatch(/data-testid="subagent-tools"/);
    // 无报告块与操作行（未产出报告）
    expect(html).not.toMatch(/data-testid="subagent-report"/);
    expect(html).not.toMatch(/data-testid="subagent-report-actions"/);
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

  it("interrupted 标记行（票 04）：状态点与「运行中被中断」状态原位可见", () => {
    const html = renderToStaticMarkup(
      createElement(SubagentStreamMarker, {
        subagent: subSeg("sa-int", {
          state: "interrupted",
          report: null,
          ok: false,
          endedAt: "2026-11-14T08:00:09.000Z",
        }),
      })
    );
    expect(html).toMatch(
      /data-testid="subagent-stream-marker-toggle"[^>]*data-subagent-state="interrupted"/
    );
    expect(html).toContain("运行中被中断");
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
  it("interrupted 终态同样以 endedAt 定格（不随 now 跳动）", () => {
    const interrupted = subSeg("sa-int", {
      state: "interrupted",
      startedAt: "2026-11-12T08:00:00.000Z",
      endedAt: "2026-11-12T08:00:09.000Z",
    });
    expect(formatElapsed(interrupted, 9_999_999)).toBe("00:09");
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
