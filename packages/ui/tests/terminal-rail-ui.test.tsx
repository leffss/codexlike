import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TerminalRailPanelBody,
  TerminalSessionDetail,
} from "../src/components/TerminalRailPanel";
import type { TerminalSegment } from "../src/lib/task-view";

/** 终端段样例（record 字段对齐 TerminalSessionRecord 呈现投影） */
function termSeg(overrides: Partial<TerminalSegment> = {}): TerminalSegment {
  return {
    kind: "terminal",
    id: "ts-1",
    seq: 1,
    turnId: "ts-1",
    responseId: null,
    sessionId: "ts-1",
    name: "git-bash · 1",
    shell: "git-bash",
    origin: "user",
    status: "running",
    createdAt: "2026-11-21T08:00:00.000Z",
    ...overrides,
  };
}

function bodyProps(
  overrides: Partial<Parameters<typeof TerminalRailPanelBody>[0]> = {}
): Parameters<typeof TerminalRailPanelBody>[0] {
  return {
    sessions: [],
    taskId: "task-1",
    onCreate() {},
    createError: null,
    creating: false,
    onKill() {},
    killingSessionId: null,
    ...overrides,
  };
}

describe("TerminalRailPanelBody 列表页（SSR 静态结构，ADR 0032 拆页导航）", () => {
  it("空列表：占位提示 + 「+ 新建会话」仍在（空态可开第一个会话），无分组标题", () => {
    const html = renderToStaticMarkup(
      createElement(TerminalRailPanelBody, bodyProps())
    );
    expect(html).toContain("本任务尚无终端会话");
    expect(html).toMatch(/data-testid="terminal-create"/);
    expect(html).not.toMatch(/data-testid="terminal-rail-group-header"/);
    expect(html).not.toMatch(/data-testid="terminal-rail-item"/);
  });

  it("无任务（草稿）：创建按钮禁用", () => {
    const html = renderToStaticMarkup(
      createElement(TerminalRailPanelBody, bodyProps({ taskId: null }))
    );
    const button = html.match(
      /<button[^>]*data-testid="terminal-create"[^>]*>/
    )?.[0];
    expect(button).toContain("disabled");
  });

  it("分组渲染：运行中 → 已退出顺序，空组不渲染；富行两行式（会话名 + 状态/来源/已用时）", () => {
    const html = renderToStaticMarkup(
      createElement(
        TerminalRailPanelBody,
        bodyProps({
          sessions: [
            termSeg(),
            termSeg({
              sessionId: "ts-2",
              id: "ts-2",
              name: "git-bash · 2",
              origin: "agent",
              status: "exited",
              exitCode: 0,
              exitedAt: "2026-11-21T08:02:00.000Z",
            }),
            termSeg({
              sessionId: "ts-3",
              id: "ts-3",
              name: "powershell · 3",
              origin: "agent",
              status: "exited",
              exitCode: 1,
              exitedAt: "2026-11-21T08:03:00.000Z",
            }),
          ],
        })
      )
    );
    expect(
      html.match(/data-testid="terminal-rail-group-header"/g)
    ).toHaveLength(2);
    expect(html.indexOf("运行中")).toBeLessThan(html.indexOf("已退出"));
    expect(html.match(/data-testid="terminal-rail-item"/g)).toHaveLength(3);
    expect(html).toMatch(
      /data-testid="terminal-rail-item"[^>]*data-terminal-state="running"/
    );
    expect(html).toMatch(
      /data-testid="terminal-rail-item"[^>]*data-terminal-state="exited"/
    );
    // 富行元信息：状态文案 + 来源标注 + 会话名
    expect(html).toContain("运行中");
    expect(html).toContain("已退出");
    expect(html).toContain("用户");
    expect(html).toContain("agent");
    expect(html).toContain("git-bash · 1");
    expect(html).toContain("powershell · 3");
    // 异常退出在富行即标退出码（扫读一眼定位失败的会话）
    expect(html).toContain("退出码 1");
    // 详情不在列表页
    expect(html).not.toMatch(/data-testid="terminal-rail-back"/);
    expect(html).not.toMatch(/data-testid="terminal-xterm-host"/);
  });

  it("只有已退出会话：运行中组不渲染（空组不渲染口径）", () => {
    const html = renderToStaticMarkup(
      createElement(
        TerminalRailPanelBody,
        bodyProps({
          sessions: [
            termSeg({
              status: "exited",
              exitCode: 0,
              exitedAt: "2026-11-21T08:02:00.000Z",
            }),
          ],
        })
      )
    );
    expect(
      html.match(/data-testid="terminal-rail-group-header"/g)
    ).toHaveLength(1);
    expect(html).toContain("已退出");
  });

  it("超上限错误（create 返回的中文 reason）直接展示，不另造错误态", () => {
    const html = renderToStaticMarkup(
      createElement(
        TerminalRailPanelBody,
        bodyProps({
          createError: "每个任务最多同时运行 5 个终端会话，请先结束部分会话",
        })
      )
    );
    expect(html).toMatch(/data-testid="terminal-create-error"/);
    expect(html).toContain("每个任务最多同时运行 5 个终端会话");
  });

  it("创建中：按钮禁用防重复点击", () => {
    const html = renderToStaticMarkup(
      createElement(TerminalRailPanelBody, bodyProps({ creating: true }))
    );
    const button = html.match(
      /<button[^>]*data-testid="terminal-create"[^>]*>/
    )?.[0];
    expect(button).toContain("disabled");
  });
});

describe("TerminalSessionDetail 详情壳（SSR 到容器边界；xterm 交互区是 canvas 不做 SSR）", () => {
  it("running：顶栏返回 + 状态点 + 会话名 + 已用时 + kill 按钮 + xterm 容器壳", () => {
    const html = renderToStaticMarkup(
      createElement(TerminalSessionDetail, {
        session: termSeg(),
        onBack() {},
        onKill() {},
        killing: false,
      })
    );
    expect(html).toMatch(/data-testid="terminal-rail-detail-header"/);
    expect(html).toMatch(/data-testid="terminal-rail-back"/);
    expect(html).toMatch(/data-testid="terminal-rail-title"/);
    expect(html).toMatch(/data-testid="terminal-elapsed"/);
    expect(html).toMatch(/data-testid="terminal-rail-kill"/);
    // xterm 容器壳存在（交互区在浏览器挂载后实例化，SSR 只有壳）
    expect(html).toMatch(/data-testid="terminal-xterm-host"/);
    // 已退出标注不出现在运行中详情
    expect(html).not.toContain("只读回看");
  });

  it("exited：无 kill 按钮、只读回看标注、已用时以 exitedAt 定格", () => {
    const html = renderToStaticMarkup(
      createElement(TerminalSessionDetail, {
        session: termSeg({
          status: "exited",
          exitCode: 0,
          exitedAt: "2026-11-21T08:01:30.000Z",
        }),
        onBack() {},
        onKill() {},
        killing: false,
      })
    );
    expect(html).not.toMatch(/data-testid="terminal-rail-kill"/);
    expect(html).toContain("只读回看");
    expect(html).toContain("01:30");
  });

  it("异常退出：退出码在顶栏状态文案可见（回看时先看到失败原因）", () => {
    const html = renderToStaticMarkup(
      createElement(TerminalSessionDetail, {
        session: termSeg({
          status: "exited",
          exitCode: 1,
          exitedAt: "2026-11-21T08:01:30.000Z",
        }),
        onBack() {},
        onKill() {},
        killing: false,
      })
    );
    expect(html).toContain("退出码 1");
  });
});
