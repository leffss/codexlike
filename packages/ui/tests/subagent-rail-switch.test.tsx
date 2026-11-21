// @vitest-environment jsdom
// 交互回路（列表页点行进详情 / 返回列表 / 翻页器 / 标记行 focus 直跳）：
// SSR 静态断言测不到 useEffect 与本地 state，此处用 jsdom + testing-library
// 驱动真实点击与流式 rerender，锁定「运行中流式更新不得覆盖用户的手动
// 列表选择」与拆页导航（ADR 0032）的页面切换语义。
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

/** 按序取列表行（缺失直接抛错，避免 noUncheckedIndexedAccess 的宽化） */
function listItemAt(index: number): HTMLElement {
  const item = screen.getAllByTestId("subagent-rail-item")[index];
  if (item === undefined) {
    throw new Error(`subagent-rail-item[${index}] not found`);
  }
  return item;
}

/** 按任务文本取列表行（分组后行序不等于全列表顺序，文本定位才稳） */
function listRow(taskFragment: string): HTMLElement {
  const row = screen
    .getAllByTestId("subagent-rail-item")
    .find((item) => item.textContent?.includes(taskFragment));
  if (row === undefined) {
    throw new Error(`列表行未找到：${taskFragment}`);
  }
  return row;
}

/** 当前是否在详情页（顶栏返回按钮为详情页锚点） */
function onDetailPage(): boolean {
  return screen.queryByTestId("subagent-rail-back") !== null;
}

/** 翻页器当前序号文本（「i / N」） */
function pagerLabel(): string {
  return screen.getByTestId("subagent-rail-pager-label").textContent ?? "";
}

function pagerButton(side: "prev" | "next"): HTMLButtonElement {
  return screen.getByTestId(`subagent-rail-pager-${side}`) as HTMLButtonElement;
}

afterEach(() => cleanup());

describe("SubagentRailPanelBody 拆页导航（列表页 ↔ 详情页）", () => {
  it("列表页为默认入口：行直接渲染、详情不渲染；点行进详情、返回列表回列表页", () => {
    const a = subSeg("sa-a");
    const b = subSeg("sa-b");
    const { rerender } = render(
      <SubagentRailPanelBody subagents={[a, b]} focus={null} />
    );
    // 列表页入口：两行直接渲染（无浮层概念），详情不挂载
    expect(screen.getAllByTestId("subagent-rail-item")).toHaveLength(2);
    expect(selectedTask()).toBeNull();
    // 点第一行进详情：委派说明 + 顶栏标题 + 翻页器
    fireEvent.click(listItemAt(0));
    expect(selectedTask()).toContain("sa-a");
    expect(screen.getByTestId("subagent-rail-title").textContent).toContain(
      "任务 sa-a"
    );
    expect(pagerLabel()).toBe("1 / 2");
    // 顶栏已用时定格（起止对齐产物；恢复态记录无起止对自然缺省）
    expect(screen.getByTestId("subagent-elapsed").textContent).toBe("00:30");
    // 返回列表：详情卸载、列表行仍在
    fireEvent.click(screen.getByTestId("subagent-rail-back"));
    expect(onDetailPage()).toBe(false);
    expect(screen.getAllByTestId("subagent-rail-item")).toHaveLength(2);
    // 静态数据 rerender（新数组引用）：保持列表页，不自行进详情
    rerender(
      <SubagentRailPanelBody
        subagents={[subSeg("sa-a"), subSeg("sa-b")]}
        focus={null}
      />
    );
    expect(onDetailPage()).toBe(false);
    expect(screen.getAllByTestId("subagent-rail-item")).toHaveLength(2);
  });

  it("翻页器连续阅读：‹ › 全列表顺序翻页，详情随之切换，首尾禁用", () => {
    render(
      <SubagentRailPanelBody
        subagents={[subSeg("sa-a"), subSeg("sa-b"), subSeg("sa-c")]}
        focus={null}
      />
    );
    fireEvent.click(listItemAt(0));
    expect(pagerLabel()).toBe("1 / 3");
    expect(pagerButton("prev").disabled).toBe(true);
    expect(pagerButton("next").disabled).toBe(false);
    fireEvent.click(pagerButton("next"));
    expect(pagerLabel()).toBe("2 / 3");
    expect(selectedTask()).toContain("sa-b");
    fireEvent.click(pagerButton("next"));
    expect(pagerLabel()).toBe("3 / 3");
    expect(selectedTask()).toContain("sa-c");
    expect(pagerButton("next").disabled).toBe(true);
    expect(pagerButton("prev").disabled).toBe(false);
    fireEvent.click(pagerButton("prev"));
    expect(pagerLabel()).toBe("2 / 3");
    expect(selectedTask()).toContain("sa-b");
  });

  it("标记行 focus 直跳详情页（不落列表页），静态 rerender 不重放", () => {
    const a = subSeg("sa-a");
    const b = subSeg("sa-b");
    const { rerender } = render(
      <SubagentRailPanelBody
        subagents={[a, b]}
        focus={{ id: "sa-a", seq: 1 }}
      />
    );
    // 直跳详情页：选中的是 focus 目标而非默认列表入口
    expect(onDetailPage()).toBe(true);
    expect(selectedTask()).toContain("sa-a");
    expect(pagerLabel()).toBe("1 / 2");
    // 静态数据 rerender（新数组引用 + 同 focus 对象）：seq 幂等守卫不重放
    rerender(
      <SubagentRailPanelBody
        subagents={[subSeg("sa-a"), subSeg("sa-b")]}
        focus={{ id: "sa-a", seq: 1 }}
      />
    );
    expect(onDetailPage()).toBe(true);
    expect(selectedTask()).toContain("sa-a");
  });

  it("运行中流式更新不把手动选择拉回 focus 目标（标记行定位后点列表其他项）", () => {
    const done = subSeg("sa-done");
    const running = subSeg("sa-run", {
      state: "running",
      endedAt: null,
      report: null,
      ok: null,
      turns: [{ content: "流式正文增量 1" }],
    });
    // 用户先点过消息流标记行定位 done（focus 直跳其详情页）
    const { rerender } = render(
      <SubagentRailPanelBody
        subagents={[done, running]}
        focus={{ id: "sa-done", seq: 1 }}
      />
    );
    expect(selectedTask()).toContain("sa-done");
    // 用户返回列表、点击正在运行的子代理，查看其流式详情
    // （分组后行序不等于全列表顺序：进行中组在最前，按文本定位）
    fireEvent.click(screen.getByTestId("subagent-rail-back"));
    fireEvent.click(listRow("sa-run"));
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
    expect(onDetailPage()).toBe(true);
  });

  it("focus 信号变化仍重新定位（标记行重复点击：列表页与详情页皆可跳转）", () => {
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
    expect(selectedTask()).toContain("sa-done");
    // 用户返回列表、手动点选运行中的子代理（分组后按文本定位）
    fireEvent.click(screen.getByTestId("subagent-rail-back"));
    fireEvent.click(listRow("sa-run"));
    expect(selectedTask()).toContain("sa-run");
    // 用户再次点击消息流标记行（seq 递增）：从当前页直接重新定位到 sa-done
    rerender(
      <SubagentRailPanelBody
        subagents={[done, running]}
        focus={{ id: "sa-done", seq: 2 }}
      />
    );
    expect(selectedTask()).toContain("sa-done");
    expect(onDetailPage()).toBe(true);
  });
});

describe("详情页内交互（进入详情页后的内容行为）", () => {
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
    // 列表页点行进详情（拆页导航入口）
    fireEvent.click(listItemAt(0));
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

  it("切换子代理（翻页器）：详情切换重置贴底跟随（不保留上一个的阅读位置）", () => {
    const first = subSeg("sa-first");
    render(
      <SubagentRailPanelBody
        subagents={[first, subSeg("sa-second")]}
        focus={null}
      />
    );
    fireEvent.click(listItemAt(0));
    // 默认跟随：无「回到最新」入口
    expect(screen.queryByTestId("subagent-back-to-latest")).toBeNull();
    // 翻到下一个子代理：详情切换（委派说明随之变化），仍无脱离入口
    fireEvent.click(pagerButton("next"));
    expect(selectedTask()).toContain("sa-second");
    expect(screen.queryByTestId("subagent-back-to-latest")).toBeNull();
  });
});

describe("详情滚动跟随（与主代理 MessageStream 同构，2026-11-19）", () => {
  /** jsdom 无布局：为滚动容器伪装修征几何（scrollHeight/clientHeight/
   *  scrollTop 是只读 getter，实例级 defineProperty 覆盖后方可驱动状态机） */
  function fakeGeometry(scroller: HTMLElement, scrollHeight: number) {
    Object.defineProperty(scroller, "scrollHeight", {
      value: scrollHeight,
      configurable: true,
    });
    Object.defineProperty(scroller, "clientHeight", {
      value: 400,
      configurable: true,
    });
    // 初始 scrollTop 取 100：挂载贴底回执在 TTL 内值为 0，与用户滚动
    // 同值会被误吞为程序化滚动（MessageStream 同款回执口径）
    Object.defineProperty(scroller, "scrollTop", {
      value: 100,
      writable: true,
      configurable: true,
    });
    return scroller;
  }

  function detailScroller(): HTMLElement {
    const scroller = screen
      .getByTestId("subagents-panel-body")
      .querySelector("[data-scrollbar-content-signal='off']");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("详情滚动容器未找到");
    }
    return scroller;
  }

  it("上翻脱离跟随出「回到最新」，脱离期间流式内容不拉回；点击回底并恢复跟随", () => {
    const base = subSeg("s1");
    const { rerender } = render(
      <SubagentRailPanelBody subagents={[base]} focus={null} />
    );
    // 列表页点行进详情
    fireEvent.click(listItemAt(0));
    // 默认跟随：无「回到最新」入口
    expect(screen.queryByTestId("subagent-back-to-latest")).toBeNull();
    // 用户上翻（scrollTop=100，离底 500px > 48px 容差）：脱离跟随，入口出现
    const scroller = fakeGeometry(detailScroller(), 1_000);
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("subagent-back-to-latest")).toBeTruthy();
    // 脱离期间内容变化（流式增量）：保持阅读位置，不贴底、入口仍在
    rerender(
      <SubagentRailPanelBody
        subagents={[subSeg("s1", { report: "报告 s1 —— 更长的流式正文" })]}
        focus={null}
      />
    );
    expect(scroller.scrollTop).toBe(100);
    expect(screen.getByTestId("subagent-back-to-latest")).toBeTruthy();
    // 点击回底：贴底（1000-400=600）并恢复跟随，入口消失
    fireEvent.click(screen.getByTestId("subagent-back-to-latest"));
    expect(scroller.scrollTop).toBe(600);
    expect(screen.queryByTestId("subagent-back-to-latest")).toBeNull();
    // 跟随期间内容变化（内容更高）：自动贴底到新底部（1200-400=800）
    Object.defineProperty(scroller, "scrollHeight", {
      value: 1_200,
      configurable: true,
    });
    rerender(
      <SubagentRailPanelBody
        subagents={[subSeg("s1", { report: "报告 s1 —— 再次增高的正文" })]}
        focus={null}
      />
    );
    expect(scroller.scrollTop).toBe(800);
    expect(screen.queryByTestId("subagent-back-to-latest")).toBeNull();
  });
});
