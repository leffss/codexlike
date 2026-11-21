import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RailPanel, clampRailWidth } from "../src/components/RailPanel";
import type { SubagentSegment } from "../src/lib/task-view";

function subSeg(
  id: string,
  state: "queued" | "running" | "done"
): SubagentSegment {
  return {
    kind: "subagent",
    id,
    seq: 1,
    turnId: "u1",
    responseId: null,
    toolCallId: `delegate-${id}`,
    task: `任务 ${id}`,
    state,
    startedAt: state === "queued" ? null : "2026-11-12T08:00:00.000Z",
    endedAt: null,
    report: state === "done" ? "报告" : null,
    ok: state === "done" ? true : null,
    tools: [],
  };
}

function railProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    taskId: "task-1",
    taskTitle: "重构主窗口布局",
    selectedProfileId: "prof-1",
    changesRevision: 0,
    resources: null,
    resourcesLoading: false,
    resourcesError: null,
    onRefreshResources() {},
    onChangesCount() {},
    subagents: [],
    subagentFocus: null,
    ...overrides,
  };
}

describe("clampRailWidth（双端最小宽夹取）", () => {
  it("低于右栏最小宽夹到 320；超过上限夹到 max（正文最小宽约束）", () => {
    expect(clampRailWidth(100, 640)).toBe(320);
    expect(clampRailWidth(320, 640)).toBe(320);
    expect(clampRailWidth(400, 640)).toBe(400);
    expect(clampRailWidth(9999, 640)).toBe(640);
  });
  it("上限本身不低于最小宽时按区间原样通过", () => {
    expect(clampRailWidth(350, 400)).toBe(350);
    // 上限小于最小宽的退化输入（窗口极窄）：上限优先——右栏跟随容器
    // 收窄保布局不溢出，而非死守 320 最小宽
    expect(clampRailWidth(200, 100)).toBe(100);
  });
});

describe("RailPanel（SSR 静态结构）", () => {
  it("关闭时不渲染任何节点（宽度与选中状态由挂载态保留，e2e 覆盖）", () => {
    const html = renderToStaticMarkup(
      createElement(RailPanel, railProps({ open: false }))
    );
    expect(html).toBe("");
  });

  it("展开态：分隔条 + 右栏容器 + 四个描边 tab 按钮（默认「改动」选中）", () => {
    const html = renderToStaticMarkup(createElement(RailPanel, railProps()));
    // 分隔条：separator 语义 + 可聚焦（键盘微调入口）
    expect(html).toMatch(
      /<div[^>]*role="separator"[^>]*aria-label="调整右栏宽度"/
    );
    expect(html).toMatch(/data-testid="rail-separator"[^>]*tabindex="0"/);
    // 右栏容器
    expect(html).toMatch(/data-testid="rail-panel"/);
    // tab：改动默认选中、规范与技能/子代理/终端未选中（描边按钮非胶囊分段；
    // SSR 属性序 aria-selected 在 data-testid 之前）
    expect(html).toMatch(
      /aria-selected="true"[^>]*data-testid="rail-tab-changes"/
    );
    expect(html).toMatch(
      /aria-selected="false"[^>]*data-testid="rail-tab-resources"/
    );
    expect(html).toContain("规范与技能");
    // 子代理 tab（ADR 0020）：无运行中不渲染徽章
    expect(html).toMatch(
      /aria-selected="false"[^>]*data-testid="rail-tab-subagents"/
    );
    expect(html).not.toMatch(/data-testid="subagent-rail-badge"/);
    // 终端 tab（ADR 0033 票 04）：SSR 时 hook 尚未拉取，无徽章
    expect(html).toMatch(
      /aria-selected="false"[^>]*data-testid="rail-tab-terminals"/
    );
    expect(html).not.toMatch(/data-testid="terminal-rail-badge"/);
  });

  it("子代理 tab 徽章：运行中/排队计数（不含已完成）", () => {
    const subagents = [
      subSeg("sa-1", "done"),
      subSeg("sa-2", "running"),
      subSeg("sa-3", "queued"),
      subSeg("sa-4", "done"),
    ];
    const html = renderToStaticMarkup(
      createElement(RailPanel, railProps({ subagents }))
    );
    expect(html).toMatch(/data-testid="subagent-rail-badge"[^>]*>2</);
  });

  it("改动 tab（无任务）：新建任务提示占位（零「草稿」文案），不渲染分支行与提交动作", () => {
    const html = renderToStaticMarkup(
      createElement(RailPanel, railProps({ taskId: null, taskTitle: null }))
    );
    expect(html).toContain("新建任务暂无改动，发送第一条消息后可检视");
    expect(html).not.toContain("草稿");
    expect(html).not.toMatch(/data-testid="changes-branch"/);
    expect(html).not.toMatch(/data-testid="changes-create-branch"/);
  });

  it("任务态 SSR 初始快照：git 状态未返回前列占位，不显示分支行", () => {
    // SSR 不跑 effect：status 初始 null。断言不误渲染分支行/文件行，
    // 加载后的数据路径由 e2e（changes.mjs）覆盖。
    const html = renderToStaticMarkup(createElement(RailPanel, railProps()));
    expect(html).toContain("点上方文件查看 diff");
    expect(html).not.toMatch(/data-testid="changes-branch"/);
  });

  it("规范与技能/子代理/终端 tab 容器在默认（改动 tab）下互斥不渲染", () => {
    // 默认渲染改动 tab；其余 tab 未挂载（tab 互斥，e2e 覆盖切换），
    // 此处断言互斥初始态：resources-panel / subagents-panel / terminals-panel 不出现。
    const html = renderToStaticMarkup(createElement(RailPanel, railProps()));
    expect(html).toMatch(/data-testid="changes-panel"/);
    expect(html).not.toMatch(/data-testid="resources-panel"/);
    expect(html).not.toMatch(/data-testid="subagents-panel"/);
    expect(html).not.toMatch(/data-testid="terminals-panel"/);
  });
});
