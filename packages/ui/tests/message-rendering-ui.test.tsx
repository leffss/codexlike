// @vitest-environment jsdom
// 已批准接缝：真实组件更新 + Markdown 外部解析边界工作量；保留真实 GFM/高亮。
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageStream } from "../src/components/MessageStream";
import { SubagentRailPanelBody } from "../src/components/SubagentRailPanel";
import type {
  AssistantSegment,
  MessageSegment,
  SubagentSegment,
} from "../src/lib/task-view";

const { parsed } = vi.hoisted(() => ({ parsed: [] as string[] }));
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      parsed.push(props.children ?? "");
      return actual.default(props);
    },
  };
});

function text(
  id: string,
  content: string,
  streaming = false
): AssistantSegment {
  return {
    kind: "assistant",
    id,
    seq: 1,
    turnId: id,
    responseId: id,
    content,
    streaming,
  };
}

/** 固定 1,355 字符 / 24 行 TS 代码：只比较调用/字符数，不依赖机器速度。 */
function historicalText(index: number): string {
  const code = Array.from(
    { length: 24 },
    (_, line) => `const item${line} = { value: ${line}, label: "history" };`
  ).join("\n");
  return `# 历史 ${index}\n\n\`\`\`ts\n${code}\n\`\`\`\n`.padEnd(1_355, " ");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T08:00:00Z"));
  parsed.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("消息流 Markdown 工作量", () => {
  it("子代理关闭的过程详情不挂载，未变报告在无关父更新中零解析", () => {
    const subagent: SubagentSegment = {
      kind: "subagent",
      id: "lazy-subagent",
      seq: 1,
      turnId: "u1",
      responseId: null,
      toolCallId: "spawn-lazy",
      task: "委派",
      state: "done",
      startedAt: null,
      endedAt: null,
      report: "稳定报告",
      ok: true,
      tools: [],
      turns: [
        { content: "过程正文\n正文长尾", reasoning: "过程思考\n思考长尾" },
      ],
    };
    const view = render(
      <SubagentRailPanelBody subagents={[subagent]} focus={null} />
    );
    // 拆页导航（ADR 0032）：列表页点行进详情，过程折叠块默认收起
    fireEvent.click(screen.getByTestId("subagent-rail-item"));
    expect(screen.queryByTestId("subagent-body-content")).toBeNull();
    expect(screen.queryByTestId("subagent-thinking-content")).toBeNull();
    parsed.length = 0;
    view.rerender(
      <SubagentRailPanelBody subagents={[{ ...subagent }]} focus={null} />
    );
    expect(parsed).toHaveLength(0);
    fireEvent.click(screen.getByTestId("subagent-body-toggle"));
    fireEvent.click(screen.getByTestId("subagent-thinking-toggle"));
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByTestId("subagent-body-content").textContent).toContain(
      "正文长尾"
    );
    expect(
      screen.getByTestId("subagent-thinking-content").textContent
    ).toContain("思考长尾");
    expect(parsed).toHaveLength(0);
  });

  it("切任务即清掉旧尾随正文，即使段 id 相同也不能串入新任务；卸载清 timer", () => {
    const active = text("same-id", "甲首段", true);
    const view = render(
      <MessageStream items={[active]} taskId="switch-a" streaming />
    );
    view.rerender(
      <MessageStream
        items={[{ ...active, content: "甲未提交尾随正文" }]}
        taskId="switch-a"
        streaming
      />
    );
    view.rerender(
      <MessageStream
        items={[{ ...active, content: "乙独立正文" }]}
        taskId="switch-b"
        streaming
      />
    );
    expect(screen.getByTestId("assistant-content").textContent).toBe(
      "乙独立正文"
    );
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByTestId("assistant-content").textContent).toBe(
      "乙独立正文"
    );
    view.rerender(
      <MessageStream
        items={[{ ...active, content: "乙待提交正文" }]}
        taskId="switch-b"
        streaming
      />
    );
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("尾随内容晚提交仍跟随，用户上翻后不抢阅读位置", () => {
    const active = text("follow-active", "开始", true);
    const view = render(
      <MessageStream items={[active]} taskId="follow-task" streaming />
    );
    const stream = screen.getByTestId("message-stream");
    Object.defineProperties(stream, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: {
        configurable: true,
        get: () =>
          300 +
          (screen.getByTestId("assistant-content").textContent?.length ?? 0) *
            10,
      },
    });
    view.rerender(
      <MessageStream
        items={[{ ...active, content: "尾随长正文晚一点才进入 DOM" }]}
        taskId="follow-task"
        streaming
      />
    );
    const beforeCommit = stream.scrollTop;
    act(() => vi.advanceTimersByTime(100));
    expect(stream.scrollTop).toBeGreaterThan(beforeCommit);
    expect(stream.scrollTop).toBe(stream.scrollHeight - stream.clientHeight);

    fireEvent.wheel(stream, { deltaY: -120 });
    stream.scrollTop = 30;
    fireEvent.scroll(stream);
    view.rerender(
      <MessageStream
        items={[
          { ...active, content: "用户上翻以后尾随的更长正文不应夺走滚动权" },
        ]}
        taskId="follow-task"
        streaming
      />
    );
    act(() => vi.advanceTimersByTime(100));
    expect(stream.scrollTop).toBe(30);
    expect(screen.getByTestId("back-to-latest")).toBeTruthy();
  });

  it("活动正文 trailing throttle 持续吐出最新内容，错误事件与终稿立即显示", () => {
    const active = text("throttle", "开始", true);
    const view = render(
      <MessageStream items={[active]} taskId="throttle-task" streaming />
    );
    parsed.length = 0;
    for (let index = 1; index <= 20; index += 1) {
      view.rerender(
        <MessageStream
          items={[
            { ...active, content: `开始 ${index}` },
            {
              kind: "error",
              id: "status",
              seq: 2,
              turnId: active.turnId,
              responseId: null,
              content: `状态 ${index}`,
            },
          ]}
          taskId="throttle-task"
          streaming
        />
      );
      expect(screen.getByTestId("message-error").textContent).toBe(
        `状态 ${index}`
      );
      act(() => vi.advanceTimersByTime(10));
      if (index === 4) expect(parsed).toHaveLength(0);
      if (index === 10) {
        expect(parsed).toHaveLength(1);
        expect(screen.getByTestId("assistant-content").textContent).not.toBe(
          "开始"
        );
      }
    }
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    expect(parsed.length).toBeLessThanOrEqual(4);
    view.rerender(
      <MessageStream
        items={[{ ...active, content: "完整终稿", streaming: false }]}
        taskId="throttle-task"
      />
    );
    expect(screen.getByTestId("assistant-content").textContent).toBe(
      "完整终稿"
    );
    expect(screen.getByTestId("assistant-actions")).toBeTruthy();
    parsed.length = 0;
    act(() => vi.advanceTimersByTime(100));
    expect(parsed).toHaveLength(0);
    expect(screen.getByTestId("assistant-content").textContent).toBe(
      "完整终稿"
    );
  });

  it("关闭的过程正文、思考与压缩摘要按需挂载，展开后才解析全文", () => {
    const process = Array.from({ length: 5 }, (_, index) => ({
      ...text(`closed-process-${index}`, historicalText(index)),
      turnId: "lazy-turn",
    }));
    const items: MessageSegment[] = [
      {
        kind: "thinking",
        id: "closed-thinking",
        seq: 1,
        turnId: "lazy-turn",
        responseId: "lazy-turn",
        content: "思考摘要\n只在展开时挂载的思考长尾",
      },
      ...process,
      { ...text("lazy-final", "最终正文"), turnId: "lazy-turn" },
      {
        kind: "compact-summary",
        id: "lazy-compact",
        seq: 9,
        turnId: "compact",
        responseId: null,
        content: "压缩摘要全文",
      },
    ];
    render(<MessageStream items={items} taskId="lazy-task" />);
    expect(parsed).toEqual(["最终正文"]);
    expect(screen.queryByTestId("thinking-content")).toBeNull();
    expect(screen.queryAllByTestId("process-text-content")).toHaveLength(0);

    fireEvent.click(screen.getAllByTestId("process-text-toggle")[0]!);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByTestId("process-text-content").textContent).toContain(
      "const item23"
    );
    expect(parsed).toHaveLength(2);
    fireEvent.click(screen.getByTestId("compact-summary-toggle"));
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByTestId("compact-summary-content").textContent).toContain(
      "压缩摘要全文"
    );
    expect(parsed).toHaveLength(3);
    fireEvent.click(screen.getByTestId("thinking-toggle"));
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByTestId("thinking-content").textContent).toContain(
      "只在展开时挂载的思考长尾"
    );
  });

  it.each([5, 100])(
    "%i 条历史：纯计时与无关更新零解析，增量只解析活动段",
    (count) => {
      const history = Array.from({ length: count }, (_, index) =>
        text(`history-${index}`, historicalText(index))
      );
      const active = text("active", "首段", true);
      const props = {
        items: [...history, active],
        taskId: "render-budget",
        streaming: true,
        runStartedAt: Date.now(),
      };
      const view = render(<MessageStream {...props} />);
      parsed.length = 0;
      act(() => vi.advanceTimersByTime(1_000));
      const tick = parsed.length;
      expect(screen.getByTestId("running-elapsed").textContent).toBe("1 秒");

      parsed.length = 0;
      view.rerender(<MessageStream {...props} taskTitle="无关标题更新" />);
      const parent = parsed.length;

      parsed.length = 0;
      view.rerender(
        <MessageStream
          {...props}
          items={[...history, { ...active, content: "首段加增量" }]}
        />
      );
      act(() => vi.advanceTimersByTime(100));
      const delta = parsed.length;
      const unchanged = parsed.filter((value) =>
        value.startsWith("# 历史")
      ).length;
      console.info("Markdown 工作量", {
        history: count,
        tick,
        parent,
        delta,
        unchanged,
      });
      expect({ tick, parent, delta, unchanged }).toEqual({
        tick: 0,
        parent: 0,
        delta: 1,
        unchanged: 0,
      });
      expect(
        screen.getAllByTestId("assistant-content").at(-1)?.textContent
      ).toBe("首段加增量");
    },
    20_000
  );
});

describe("/status 报告块（ADR 0031：回消息流带关闭按钮）", () => {
  it("多行报告全文渲染，关闭按钮点击透传段 id", () => {
    const onDismissStatus = vi.fn();
    render(
      <MessageStream
        items={[
          {
            kind: "status",
            id: "status-1",
            seq: 1,
            turnId: "status-1",
            responseId: null,
            content: "任务状态（/status）\n模型：Mock · mock-model",
          },
        ]}
        taskId="status-task"
        onDismissStatus={onDismissStatus}
      />
    );
    const block = screen.getByTestId("message-status");
    expect(block.textContent).toContain("任务状态（/status）");
    expect(block.textContent).toContain("mock-model");
    fireEvent.click(screen.getByTestId("message-status-close"));
    expect(onDismissStatus).toHaveBeenCalledWith("status-1");
  });
});
