// @vitest-environment jsdom
// 交互回路（列表点击切换详情 / 标记行定位直接显示详情）：SSR 静态断言
// 测不到 useEffect 与本地 state，此处用 jsdom + testing-library 驱动真实
// 点击与流式 rerender，锁定「运行中流式更新不得覆盖用户的手动列表选择」。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { SubagentRailPanelBody } from "../src/components/SubagentRailPanel";
import { initialTranscript, type SubagentSegment } from "../src/lib/task-view";

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
    startedAt: "2026-11-16T08:00:00.000Z",
    endedAt: "2026-11-16T08:00:30.000Z",
    report: `报告 ${id}`,
    ok: true,
    tools: [],
    ...overrides,
  };
}

/** 详情区当前选中的子代理身份：委派说明块正文含 task 文本 */
function selectedTask(): string | null {
  return screen.queryByTestId("subagent-delegation-text")?.textContent ?? null;
}

/** 按序取列表项（缺失直接抛错，避免 noUncheckedIndexedAccess 的宽化） */
function listItemAt(index: number): HTMLElement {
  const item = screen.getAllByTestId("subagent-rail-item")[index];
  if (item === undefined) {
    throw new Error(`subagent-rail-item[${index}] not found`);
  }
  return item;
}

/** 展开浮层列表（摘要行点击；focus 为 null 的用例需手动展开） */
function openList(): void {
  fireEvent.click(screen.getByTestId("subagent-rail-summary"));
}

afterEach(() => cleanup());

describe("SubagentRailPanelBody 列表点击切换详情", () => {
  it("恢复 interrupted 的工具长输出与完整参数按需展开（主代理同款单卡），HTML 只作文本且失败卡不请求截图", async () => {
    const output = `${"日志行\n".repeat(1_000)}唯一错误长尾 <img src=x onerror=alert(1)>`;
    const args = {
      command: "检查",
      cwd: "C:/完整参数/目录",
      nested: { detail: "不能被摘要隐藏" },
    };
    const toolImage = vi.fn();
    Object.defineProperty(window, "codexlike", {
      configurable: true,
      value: { tasks: { toolImage } },
    });
    const subagents = initialTranscript(
      [],
      [
        {
          record: {
            id: "tool-detail-subagent",
            taskId: "task-1",
            task: "恢复工具",
            status: "interrupted",
            queuedAt: "2026-11-18T08:00:00Z",
            startedAt: null,
            completedAt: "2026-11-18T08:01:00Z",
          },
          messages: [],
          toolCalls: [
            {
              id: "sub-shot",
              taskId: "task-1",
              subagentId: "tool-detail-subagent",
              toolName: "browser_screenshot",
              arguments: JSON.stringify(args),
              output,
              isError: true,
              createdAt: "2026-11-18T08:00:30Z",
            },
          ],
        },
      ]
    ).filter((item): item is SubagentSegment => item.kind === "subagent");
    render(<SubagentRailPanelBody subagents={subagents} focus={null} />);
    // 主代理同款工具卡（2026-11-19 呈现对齐轮）：终态默认收起，展开按需挂载
    expect(screen.queryByTestId("tool-call-arguments")).toBeNull();
    expect(screen.getByTestId("tool-call-toggle").textContent).toContain(
      "失败"
    );
    fireEvent.click(screen.getByTestId("tool-call-toggle"));
    const renderedOutput = await screen.findByTestId("tool-call-output");
    expect(renderedOutput.textContent).toBe(output);
    expect(
      JSON.parse(screen.getByTestId("tool-call-arguments").textContent ?? "")
    ).toEqual(args);
    expect(renderedOutput.querySelector("img")).toBeNull();
    // 失败卡（isError）不渲染截图视图：不发起 toolImage 请求
    expect(toolImage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("tool-call-toggle"));
    await waitFor(() =>
      expect(screen.queryByTestId("tool-call-output")).toBeNull()
    );
  });

  it("点击列表项切换详情到对应子代理（focus 为 null 的基线）", () => {
    const a = subSeg("sa-a");
    const b = subSeg("sa-b");
    const { rerender } = render(
      <SubagentRailPanelBody subagents={[a, b]} focus={null} />
    );
    // 默认选中最后一个（sa-b）；浮层收起：完整列表在摘要行展开后才渲染
    expect(selectedTask()).toContain("sa-b");
    expect(screen.queryAllByTestId("subagent-rail-item")).toHaveLength(0);
    openList();
    fireEvent.click(listItemAt(0));
    expect(selectedTask()).toContain("sa-a");
    // 点选即选中并收起浮层
    expect(screen.queryAllByTestId("subagent-rail-item")).toHaveLength(0);
    // 静态数据 rerender（新数组引用）：选中不回跳
    rerender(
      <SubagentRailPanelBody
        subagents={[subSeg("sa-a"), subSeg("sa-b")]}
        focus={null}
      />
    );
    expect(selectedTask()).toContain("sa-a");
  });

  it("运行中流式更新不把手动选择拉回 focus 目标（标记行点击后点击列表其他项）", () => {
    const done = subSeg("sa-done");
    const running = subSeg("sa-run", {
      state: "running",
      endedAt: null,
      report: null,
      ok: null,
      turns: [{ content: "流式正文增量 1" }],
    });
    // 用户先点过消息流标记行定位 done（focus 指向它，右栏已选中）
    const { rerender } = render(
      <SubagentRailPanelBody
        subagents={[done, running]}
        focus={{ id: "sa-done", seq: 1 }}
      />
    );
    expect(selectedTask()).toContain("sa-done");
    // focus 定位不再自动展开列表浮层：直接显示详情（2026-11-19 起定案）
    expect(screen.queryAllByTestId("subagent-rail-item")).toHaveLength(0);
    // 用户展开列表、点击正在运行的子代理，查看其流式详情
    openList();
    fireEvent.click(listItemAt(1));
    expect(selectedTask()).toContain("sa-run");
    // 流式事件到达：subagents 全量重建（新数组 + 新对象引用，内容增量）
    rerender(
      <SubagentRailPanelBody
        subagents={[
          subSeg("sa-done"),
          subSeg("sa-run", {
            state: "running",
            endedAt: null,
            report: null,
            ok: null,
            turns: [{ content: "流式正文增量 2" }],
          }),
        ]}
        focus={{ id: "sa-done", seq: 1 }}
      />
    );
    // 选择必须保持：详情仍是用户手点选中的 sa-run，不被拉回 focus 的 sa-done
    expect(selectedTask()).toContain("sa-run");
  });

  it("focus 信号变化仍重新定位选中（标记行重复点击不受切换保护影响）", () => {
    const done = subSeg("sa-done");
    const running = subSeg("sa-run", {
      state: "running",
      endedAt: null,
      report: null,
      ok: null,
    });
    const { rerender } = render(
      <SubagentRailPanelBody
        subagents={[done, running]}
        focus={{ id: "sa-done", seq: 1 }}
      />
    );
    openList();
    fireEvent.click(listItemAt(1));
    expect(selectedTask()).toContain("sa-run");
    // 用户再次点击消息流标记行（seq 递增）：应重新定位到 sa-done
    rerender(
      <SubagentRailPanelBody
        subagents={[done, running]}
        focus={{ id: "sa-done", seq: 2 }}
      />
    );
    expect(selectedTask()).toContain("sa-done");
  });
});
