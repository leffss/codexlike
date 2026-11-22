// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalReadMarker } from "../src/components/TerminalReadMarker";
import type { ToolCallSegment } from "../src/lib/task-view";
import type { TerminalReadItem } from "../src/lib/turn-view";

/**
 * terminal_read 轮内锚点行（ADR 0033「消息流 read 锚点」）的渲染端确认面：
 * 收起态单行摘要（会话名 + 计数 + 最新增量/等待态）、展开态历次列表
 * （最新置顶、空读极简行）、右栏跳转回调。collapse-memory 是模块级记忆，
 * 各用例首段 id 互不相同避免跨用例开合残留。
 */

afterEach(() => cleanup());

const NO_OUTPUT = "[暂无新输出——会话运行中，可用 wait=true 等待新输出]";

let nextSeq = 0;

function readCall(
  id: string,
  sessionId: string,
  extra: Partial<ToolCallSegment> = {}
): ToolCallSegment {
  return {
    kind: "tool-call",
    id,
    seq: ++nextSeq,
    turnId: "u1",
    responseId: null,
    taskId: "s1",
    toolName: "terminal_read",
    arguments: JSON.stringify({ sessionId }),
    output: "输出",
    isError: false,
    running: false,
    startedAt: 1_000,
    endedAt: 2_000,
    at: 1_000,
    ...extra,
  };
}

function markerItem(
  ids: string[],
  extra: (id: string) => Partial<ToolCallSegment> = () => ({})
): TerminalReadItem {
  return {
    kind: "terminal-read",
    sessionId: "s-a",
    calls: ids.map((id) => readCall(id, "s-a", extra(id))),
  };
}

describe("TerminalReadMarker：read 锚点行收起态", () => {
  it("单行摘要：会话名 + 读取次数 + 最新一次增量字数", () => {
    render(
      <TerminalReadMarker
        item={markerItem(["a1", "a2", "a3"], (id) => ({
          output: id === "a3" ? "编译 90%" : id === "a2" ? NO_OUTPUT : "第一步",
        }))}
        sessionName="git-bash · 1"
      />
    );
    expect(screen.getByTestId("terminal-read-marker").textContent).toContain(
      "读取终端「git-bash · 1」· 3 次"
    );
    // 最新一次有输出的读是第 3 次（「编译 90%」6 字符），空读不计入摘要
    expect(screen.getByTestId("terminal-read-status").textContent).toBe(
      "最新 +6 字符"
    );
  });

  it("缺会话名时以 sessionId 呈现", () => {
    render(<TerminalReadMarker item={markerItem(["b1"])} />);
    expect(screen.getByTestId("terminal-read-marker").textContent).toContain(
      "读取终端「s-a」· 1 次"
    );
  });

  it("运行中的 read 并入行内状态区：等待新输出…", () => {
    render(
      <TerminalReadMarker
        item={{
          kind: "terminal-read",
          sessionId: "s-a",
          calls: [
            readCall("c1", "s-a", { output: "编译 10%" }),
            readCall("c2", "s-a", {
              running: true,
              output: "",
              endedAt: undefined,
            }),
          ],
        }}
      />
    );
    expect(screen.getByTestId("terminal-read-marker").textContent).toContain(
      "读取终端「s-a」· 2 次"
    );
    expect(screen.getByTestId("terminal-read-status").textContent).toBe(
      "等待新输出…"
    );
  });

  it("历次全为空读时状态区呈现暂无新输出（而非错误地引用运行态）", () => {
    render(
      <TerminalReadMarker
        item={markerItem(["d1", "d2"], () => ({ output: NO_OUTPUT }))}
      />
    );
    expect(screen.getByTestId("terminal-read-status").textContent).toBe(
      "暂无新输出"
    );
  });
});

describe("TerminalReadMarker：read 锚点行展开态", () => {
  it("历次列表最新置顶，空读极简行，输出滚动区可见", () => {
    render(
      <TerminalReadMarker
        item={markerItem(["e1", "e2", "e3"], (id) => ({
          output: id === "e2" ? NO_OUTPUT : `输出 ${id}`,
        }))}
        sessionName="git-bash · 1"
      />
    );
    fireEvent.click(screen.getByTestId("terminal-read-toggle"));
    const rows = screen.getAllByTestId(/^terminal-read-entry$/);
    // 最新置顶：第 3 次在最上；序号仍为时序序号
    expect(rows.map((row) => row.dataset.index)).toEqual(["3", "2", "1"]);
    expect(rows[0]?.textContent).toContain("输出 e3");
    expect(rows[1]?.textContent).toContain("无新输出");
    expect(rows[2]?.textContent).toContain("输出 e1");
  });

  it("「右栏查看」点击回调 onOpen 携带会话 id", () => {
    const onOpen = vi.fn();
    render(<TerminalReadMarker item={markerItem(["f1"])} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("terminal-read-open"));
    expect(onOpen).toHaveBeenCalledWith("s-a");
  });
});
