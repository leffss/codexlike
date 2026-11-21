import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TerminalRailPanelBody,
  TerminalSessionDetail,
} from "../src/components/TerminalRailPanel";
import { TerminalStreamMarker } from "../src/components/TerminalStreamMarker";
import { MessageStream } from "../src/components/MessageStream";
import type { MessageSegment, TerminalSegment } from "../src/lib/task-view";

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
    onRename() {},
    focus: null,
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

  it("分组渲染：运行中 → 已退出顺序，空组不渲染；富行两行式（会话名 + 状态/来源/shell/已用时）", () => {
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
              shell: "powershell",
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
    // 富行元信息：状态文案 + 来源标注 + shell 类型 + 会话名
    expect(html).toContain("运行中");
    expect(html).toContain("已退出");
    expect(html).toContain("用户");
    expect(html).toContain("agent");
    expect(html).toContain("git-bash · 1");
    expect(html).toContain("powershell · 3");
    // shell 类型标注（spec 用户故事 4，code review 修复轮）：每行一枚，
    // 值取 record.shell——powershell 会话的标注是 powershell（与会话名区分）
    expect(html.match(/data-testid="terminal-shell-type"/g)).toHaveLength(3);
    expect(html).toMatch(/data-testid="terminal-shell-type">powershell</);
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

  it("列表行展示标题（标题功能轮）：title 缺省回退默认名（title ?? name）", () => {
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
              title: "构建服务器",
            }),
          ],
        })
      )
    );
    // OSC 动态值 / 用户改名优先
    expect(html).toContain("构建服务器");
    // 无标题的会话回退默认名
    expect(html).toContain("git-bash · 1");
  });
});

describe("TerminalSessionDetail 详情壳（SSR 到容器边界；xterm 交互区是 canvas 不做 SSR）", () => {
  it("running：顶栏返回 + 状态点 + 会话名 + 已用时 + kill 按钮 + xterm 容器壳", () => {
    const html = renderToStaticMarkup(
      createElement(TerminalSessionDetail, {
        session: termSeg(),
        onBack() {},
        onKill() {},
        onRename() {},
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
        onRename() {},
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
        onRename() {},
        killing: false,
      })
    );
    expect(html).toContain("退出码 1");
  });

  it("改名入口（标题功能轮）：running 标题可点击改名并展示 title ?? name；exited 纯文本无入口", () => {
    const running = renderToStaticMarkup(
      createElement(TerminalSessionDetail, {
        session: termSeg({ title: "构建服务器" }),
        onBack() {},
        onKill() {},
        onRename() {},
        killing: false,
      })
    );
    // running：标题是 button（点击改名），展示 OSC / 改名值而非默认名
    expect(running).toMatch(
      /<button[^>]*data-testid="terminal-rail-title"[^>]*>/
    );
    expect(running).toContain("构建服务器");
    expect(running).toContain("点击改名");

    const exited = renderToStaticMarkup(
      createElement(TerminalSessionDetail, {
        session: termSeg({
          status: "exited",
          exitCode: 0,
          exitedAt: "2026-11-21T08:01:30.000Z",
        }),
        onBack() {},
        onKill() {},
        onRename() {},
        killing: false,
      })
    );
    // exited：只读回看标题为纯文本 span，无改名入口
    expect(exited).toMatch(/<span[^>]*data-testid="terminal-rail-title"[^>]*>/);
    expect(exited).not.toContain("点击改名");
  });
});

describe("TerminalStreamMarker（消息流标记行，ADR 0033 票 06）", () => {
  it("单行标记：终端徽章 + 启动动作文案（agent 会话）+ 状态 + 引导，不含终端正文", () => {
    const html = renderToStaticMarkup(
      createElement(TerminalStreamMarker, {
        session: termSeg({ origin: "agent" }),
      })
    );
    expect(html).toMatch(/data-testid="terminal-stream-marker"/);
    expect(html).toMatch(
      /data-testid="terminal-stream-marker-toggle"[^>]*data-terminal-state="running"/
    );
    // 动作动词摘要（票面例：「启动了终端会话 git-bash · 1」）+ agent 来源标注
    expect(html).toContain("启动了终端会话 git-bash · 1");
    expect(html).toContain("agent");
    expect(html).toContain("运行中");
    expect(html).toContain("右栏查看 →");
    // 终端正文不进流（xterm 在 rail 详情页）
    expect(html).not.toMatch(/data-testid="terminal-xterm-host"/);
  });

  it("用户手开的会话：无启动动词，来源标注「用户」", () => {
    const html = renderToStaticMarkup(
      createElement(TerminalStreamMarker, { session: termSeg() })
    );
    expect(html).not.toContain("启动了终端会话");
    expect(html).toContain("终端会话 git-bash · 1");
    expect(html).toContain("用户");
  });

  it("已退出会话：状态文案原位可见（定格回看语义与 rail 富行一致）", () => {
    const html = renderToStaticMarkup(
      createElement(TerminalStreamMarker, {
        session: termSeg({
          origin: "agent",
          status: "exited",
          exitCode: 1,
          exitedAt: "2026-11-21T08:02:00.000Z",
        }),
      })
    );
    expect(html).toMatch(
      /data-testid="terminal-stream-marker-toggle"[^>]*data-terminal-state="exited"/
    );
    expect(html).toContain("退出码 1");
  });

  it("经 MessageStream 渲染：terminal 段是标记行而非 null（票 06 换呈现）", () => {
    const items: MessageSegment[] = [
      {
        kind: "user",
        id: "u1",
        seq: 1,
        turnId: "u1",
        responseId: null,
        content: "起个终端跑构建",
      },
      termSeg({ origin: "agent" }),
    ];
    const html = renderToStaticMarkup(
      createElement(MessageStream, { items, taskId: "t1" })
    );
    expect(html).toMatch(/data-testid="terminal-stream-marker"/);
    expect(html).toContain("启动了终端会话 git-bash · 1");
  });
});
