// @vitest-environment jsdom
// 交互与接线（拆页导航列表页 ↔ 详情页；xterm 字节流直写纪律）：
// SSR 静态断言测不到 useEffect 与本地 state，此处用 jsdom + testing-library
// 驱动真实点击与 IPC fake——xterm 是 canvas（jsdom 不可实例化），按
// CODING_STANDARDS「vi.hoisted 不引用 import 绑定」自包含 fake Terminal /
// FitAddon 经 vi.mock 拦动态 import，真件行为归 09 票 e2e 文本层。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { RailPanel } from "../src/components/RailPanel";
import {
  TerminalRailPanelBody,
  type TerminalFocus,
} from "../src/components/TerminalRailPanel";
import { MessageStream } from "../src/components/MessageStream";
import type { TerminalSessionRecord } from "@codexlike/agent-core";
import type { TerminalSegment } from "../src/lib/task-view";

// ===== xterm fake（vi.mock 工厂提升，自包含不引用 import 绑定）=====
const xtermFakes = vi.hoisted(() => {
  type FakeOpts = { disableStdin?: boolean; theme?: unknown };
  class FakeFitAddon {
    fit = () => {};
    proposeDimensions = () => ({ cols: 80, rows: 24 });
    activate = () => {};
    dispose = () => {};
  }
  class FakeTerminal {
    opts: FakeOpts;
    loadAddon = () => {};
    open = () => {};
    written: string[] = [];
    write = (data: string) => {
      this.written.push(data);
    };
    dataHandler: ((data: string) => void) | null = null;
    onData = (cb: (data: string) => void) => {
      this.dataHandler = cb;
      return { dispose: () => {} };
    };
    /** 复制/粘贴接线（attachCustomKeyEventHandler 捕获，用例手动派发按键） */
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    attachCustomKeyEventHandler = (cb: (event: KeyboardEvent) => boolean) => {
      this.keyHandler = cb;
    };
    /** 选区态（用例按需覆写模拟「已有选区」） */
    hasSelection = () => false;
    getSelection = () => "";
    dispose = () => {};
    constructor(opts: FakeOpts) {
      this.opts = opts;
      instances.push(this);
    }
  }
  const instances: FakeTerminal[] = [];
  return { FakeTerminal, FakeFitAddon, instances };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xtermFakes.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xtermFakes.FakeFitAddon }));

// ===== window.codexlike.terminals fake（调用记录 + 可控 subscribe 结果）=====
const ipc = vi.hoisted(() => {
  const state = {
    calls: {
      subscribe: [] as string[],
      unsubscribe: [] as string[],
      write: [] as Array<{ sessionId: string; data: string }>,
      resize: [] as Array<{ sessionId: string; cols: number; rows: number }>,
      create: [] as Array<{ taskId: string }>,
      kill: [] as string[],
      listFor: [] as string[],
    },
    dataListeners: [] as Array<
      (payload: { sessionId: string; data: string }) => void
    >,
    dataListenerRegistered: 0,
    /** subscribe 结果表（sessionId → 结果；缺省成功） */
    subscribeResults: {} as Record<
      string,
      | { ok: true; sessionId: string; record: unknown; buffered: string }
      | { ok: false; reason: string }
    >,
    /** listFor 结果表（taskId → 会话记录清单；缺省空。恢复记录形状为
     * TerminalSessionRecord——hoisted 内不引用 import 绑定，放宽为 unknown） */
    listForResults: {} as Record<string, unknown[]>,
    /** create 结果表（taskId → 结果；缺省拒绝） */
    createResult: null as
      { ok: true; sessionId: string } | { ok: false; reason: string } | null,
    /** onTaskEvent 监听器（测试手动派发信封） */
    taskListeners: [] as Array<
      (envelope: {
        taskId: string;
        sequence: number;
        event: { type: string; record?: Record<string, unknown> };
      }) => void
    >,
  };
  const stub = {
    create: async (input: { taskId: string }) => {
      state.calls.create.push(input);
      return state.createResult ?? { ok: false as const, reason: "stub 拒绝" };
    },
    write: async (sessionId: string, data: string) => {
      state.calls.write.push({ sessionId, data });
      return { ok: true as const };
    },
    resize: async (sessionId: string, size: { cols: number; rows: number }) => {
      state.calls.resize.push({ sessionId, ...size });
    },
    kill: async (sessionId: string) => {
      state.calls.kill.push(sessionId);
      return { ok: true as const };
    },
    subscribe: async (sessionId: string) => {
      state.calls.subscribe.push(sessionId);
      return (
        state.subscribeResults[sessionId] ?? {
          ok: true as const,
          sessionId,
          record: {},
          buffered: "",
        }
      );
    },
    unsubscribe: async (sessionId: string) => {
      state.calls.unsubscribe.push(sessionId);
    },
    session: async () => null,
    listFor: async (taskId: string) => {
      state.calls.listFor.push(taskId);
      return state.listForResults[taskId] ?? [];
    },
    onSessionData: (
      listener: (payload: { sessionId: string; data: string }) => void
    ) => {
      state.dataListenerRegistered += 1;
      state.dataListeners.push(listener);
      return () => {
        const index = state.dataListeners.indexOf(listener);
        if (index >= 0) state.dataListeners.splice(index, 1);
      };
    },
    onTaskEvent: (
      listener: (envelope: {
        taskId: string;
        sequence: number;
        event: { type: string; record?: Record<string, unknown> };
      }) => void
    ) => {
      state.taskListeners.push(listener);
      return () => {
        const index = state.taskListeners.indexOf(listener);
        if (index >= 0) state.taskListeners.splice(index, 1);
      };
    },
  };
  return { state, stub };
});

function resetFakes() {
  xtermFakes.instances.length = 0;
  ipc.state.calls.subscribe = [];
  ipc.state.calls.unsubscribe = [];
  ipc.state.calls.write = [];
  ipc.state.calls.resize = [];
  ipc.state.calls.create = [];
  ipc.state.calls.kill = [];
  ipc.state.calls.listFor = [];
  ipc.state.dataListeners = [];
  ipc.state.dataListenerRegistered = 0;
  ipc.state.subscribeResults = {};
  ipc.state.listForResults = {};
  ipc.state.createResult = null;
  ipc.state.taskListeners = [];
}

function installStub() {
  window.codexlike = {
    ...window.codexlike,
    // onTaskEvent 挂顶层（hook 订阅信封通道）；terminals 子命名空间独立
    onTaskEvent: ipc.stub.onTaskEvent,
    terminals: ipc.stub,
    // RailPanel 的 useGitStatus 在挂载即拉取：非 git 仓库最小值放行
    git: {
      status: async () => ({ isGitRepo: false, files: [], branch: null }),
    },
  } as unknown as typeof window.codexlike;
}

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
    sessions: [termSeg()],
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

function listItemAt(index: number): HTMLElement {
  const item = screen.getAllByTestId("terminal-rail-item")[index];
  if (item === undefined)
    throw new Error(`terminal-rail-item[${index}] 不存在`);
  return item;
}

afterEach(() => {
  cleanup();
  resetFakes();
  vi.unstubAllGlobals();
});

describe("TerminalRailPanelBody 拆页导航（列表页 ↔ 详情页）", () => {
  it("列表页为默认入口；点行进详情（xterm 壳挂载）、返回列表回列表页", async () => {
    installStub();
    render(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg(),
            termSeg({ sessionId: "ts-2", id: "ts-2", name: "git-bash · 2" }),
          ],
        })}
      />
    );
    expect(screen.getAllByTestId("terminal-rail-item")).toHaveLength(2);
    expect(screen.queryByTestId("terminal-xterm-host")).toBeNull();
    fireEvent.click(listItemAt(0));
    // 详情页：xterm 容器挂载 + 订阅发起（字节流三合一）
    expect(screen.getByTestId("terminal-xterm-host")).not.toBeNull();
    await waitFor(() => {
      expect(ipc.state.calls.subscribe).toEqual(["ts-1"]);
    });
    // 返回列表：详情卸载、退订、列表行仍在
    fireEvent.click(screen.getByTestId("terminal-rail-back"));
    expect(screen.queryByTestId("terminal-xterm-host")).toBeNull();
    expect(screen.getAllByTestId("terminal-rail-item")).toHaveLength(2);
    await waitFor(() => {
      expect(ipc.state.calls.unsubscribe).toEqual(["ts-1"]);
    });
  });

  it("kill 按钮回调 onKill（不弹确认）；已退出详情无 kill 按钮", async () => {
    installStub();
    const onKill = vi.fn();
    const { rerender } = render(
      <TerminalRailPanelBody {...bodyProps({ onKill })} />
    );
    fireEvent.click(listItemAt(0));
    const kill = await screen.findByTestId("terminal-rail-kill");
    fireEvent.click(kill);
    expect(onKill).toHaveBeenCalledWith("ts-1");
    // exited 后无 kill 按钮、显示只读回看（事件推进呈现，不换页）
    rerender(
      <TerminalRailPanelBody
        {...bodyProps({
          onKill,
          sessions: [
            termSeg({
              status: "exited",
              exitCode: 0,
              exitedAt: "2026-11-21T08:01:00.000Z",
            }),
          ],
        })}
      />
    );
    expect(screen.queryByTestId("terminal-rail-kill")).toBeNull();
    expect(screen.getByText("只读回看")).not.toBeNull();
  });
});

describe("TerminalRailPanelBody focus 直跳（票 06，ADR 0032 语义照搬）", () => {
  /** 当前是否在详情页（顶栏返回按钮为详情页锚点） */
  function onDetailPage(): boolean {
    return screen.queryByTestId("terminal-rail-back") !== null;
  }

  /** 详情顶栏标题（当前选中会话身份） */
  function detailTitle(): string | null {
    return screen.queryByTestId("terminal-rail-title")?.textContent ?? null;
  }

  function listItemAt(index: number): HTMLElement {
    const item = screen.getAllByTestId("terminal-rail-item")[index];
    if (item === undefined)
      throw new Error(`terminal-rail-item[${index}] 不存在`);
    return item;
  }

  it("标记行 focus 直跳详情页（不落列表页），选中目标会话", () => {
    installStub();
    render(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg(),
            termSeg({ sessionId: "ts-2", id: "ts-2", name: "git-bash · 2" }),
          ],
          focus: { sessionId: "ts-2", seq: 1 },
        })}
      />
    );
    // 直跳详情页：选中的是 focus 目标而非默认列表入口
    expect(onDetailPage()).toBe(true);
    expect(detailTitle()).toBe("git-bash · 2");
  });

  it("seq 幂等守卫：静态数据 rerender 不重放，手动返回列表不强行拉回", () => {
    installStub();
    const focus: TerminalFocus = { sessionId: "ts-2", seq: 1 };
    const { rerender } = render(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg(),
            termSeg({ sessionId: "ts-2", id: "ts-2", name: "git-bash · 2" }),
          ],
          focus,
        })}
      />
    );
    expect(onDetailPage()).toBe(true);
    // 用户手动返回列表页
    fireEvent.click(screen.getByTestId("terminal-rail-back"));
    expect(onDetailPage()).toBe(false);
    // 静态 rerender（新数组引用 + 同 seq focus）：守卫不重放，保持列表页
    rerender(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg(),
            termSeg({ sessionId: "ts-2", id: "ts-2", name: "git-bash · 2" }),
            termSeg({ sessionId: "ts-3", id: "ts-3", name: "git-bash · 3" }),
          ],
          focus,
        })}
      />
    );
    expect(onDetailPage()).toBe(false);
    expect(screen.getAllByTestId("terminal-rail-item")).toHaveLength(3);
  });

  it("段晚于点击到达：focus 先到 sessions 后到，目标入列后补跳详情页", () => {
    installStub();
    const { rerender } = render(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [termSeg()],
          focus: { sessionId: "ts-9", seq: 1 },
        })}
      />
    );
    // 目标尚不在列表：停在列表页（不跳到空选中）
    expect(onDetailPage()).toBe(false);
    // terminal-started 事件让目标会话入列：补跳直落详情页
    rerender(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg(),
            termSeg({ sessionId: "ts-9", id: "ts-9", name: "git-bash · 9" }),
          ],
          focus: { sessionId: "ts-9", seq: 1 },
        })}
      />
    );
    expect(onDetailPage()).toBe(true);
    expect(detailTitle()).toBe("git-bash · 9");
  });

  it("运行中流式更新不把手动选择拉回 focus 目标（先例 SubagentRailPanelBody）", () => {
    installStub();
    const { rerender } = render(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg(),
            termSeg({ sessionId: "ts-2", id: "ts-2", name: "git-bash · 2" }),
            termSeg({ sessionId: "ts-3", id: "ts-3", name: "git-bash · 3" }),
          ],
          focus: { sessionId: "ts-3", seq: 1 },
        })}
      />
    );
    expect(detailTitle()).toBe("git-bash · 3");
    // 用户返回列表并手动点选 ts-2
    fireEvent.click(screen.getByTestId("terminal-rail-back"));
    fireEvent.click(listItemAt(1));
    expect(detailTitle()).toBe("git-bash · 2");
    // 流式 rerender（新 sessions 引用 + 同 focus）：手动选择保持
    rerender(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg(),
            termSeg({ sessionId: "ts-2", id: "ts-2", name: "git-bash · 2" }),
            termSeg({ sessionId: "ts-3", id: "ts-3", name: "git-bash · 3" }),
          ],
          focus: { sessionId: "ts-3", seq: 1 },
        })}
      />
    );
    expect(onDetailPage()).toBe(true);
    expect(detailTitle()).toBe("git-bash · 2");
  });

  it("seq 递增重新定位：标记行重复点击（同 id）仍能重新跳转", () => {
    installStub();
    const { rerender } = render(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg(),
            termSeg({ sessionId: "ts-2", id: "ts-2", name: "git-bash · 2" }),
          ],
          focus: { sessionId: "ts-2", seq: 1 },
        })}
      />
    );
    expect(detailTitle()).toBe("git-bash · 2");
    fireEvent.click(screen.getByTestId("terminal-rail-back"));
    // 同 id 新 seq：重新定位（消费守卫只拦同 seq 重放）
    rerender(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg(),
            termSeg({ sessionId: "ts-2", id: "ts-2", name: "git-bash · 2" }),
          ],
          focus: { sessionId: "ts-2", seq: 2 },
        })}
      />
    );
    expect(onDetailPage()).toBe(true);
    expect(detailTitle()).toBe("git-bash · 2");
  });
});

describe("MessageStream 终端标记行接线（票 06）", () => {
  it("terminal 段渲染标记行；点击携带 sessionId 透传 onOpenTerminal", () => {
    installStub();
    const onOpenTerminal = vi.fn();
    render(
      <MessageStream
        items={[
          {
            kind: "user",
            id: "u1",
            seq: 1,
            turnId: "u1",
            responseId: null,
            content: "起个终端",
          },
          termSeg({ origin: "agent" }),
        ]}
        taskId="task-1"
        onOpenTerminal={onOpenTerminal}
      />
    );
    fireEvent.click(screen.getByTestId("terminal-stream-marker-toggle"));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    expect(onOpenTerminal).toHaveBeenCalledWith("ts-1");
  });
});

describe("TerminalSessionView 字节流接线（fake Terminal；双通道纪律）", () => {
  it("订阅时序：onSessionData 监听先于 subscribe 注册（不丢登记窗口字节）", async () => {
    installStub();
    render(<TerminalRailPanelBody {...bodyProps()} />);
    fireEvent.click(listItemAt(0));
    await waitFor(() => {
      expect(ipc.state.calls.subscribe).toEqual(["ts-1"]);
    });
    expect(ipc.state.dataListenerRegistered).toBe(1);
  });

  it("buffered 回放直写 xterm；后续实时字节经 session-data 通道直写（不进 React 状态）", async () => {
    installStub();
    ipc.state.subscribeResults["ts-1"] = {
      ok: true,
      sessionId: "ts-1",
      record: {},
      buffered: "历史输出\n",
    };
    render(<TerminalRailPanelBody {...bodyProps()} />);
    fireEvent.click(listItemAt(0));
    await waitFor(() => {
      expect(xtermFakes.instances).toHaveLength(1);
    });
    const term = xtermFakes.instances[0]!;
    expect(term.written).toEqual(["历史输出\n"]);
    // 实时字节直写（listener 通道 → term.write，绕过 React）
    ipc.state.dataListeners[0]!({ sessionId: "ts-1", data: "新输出\r\n" });
    expect(term.written).toEqual(["历史输出\n", "新输出\r\n"]);
    // 其他会话的字节不串写
    ipc.state.dataListeners[0]!({ sessionId: "ts-other", data: "别的会话" });
    expect(term.written).toHaveLength(2);
  });

  it("term 就绪前到达的实时字节先攒后冲：顺序 = buffered → 攒冲（不丢不重）", async () => {
    installStub();
    ipc.state.subscribeResults["ts-1"] = {
      ok: true,
      sessionId: "ts-1",
      record: {},
      buffered: "回放",
    };
    render(<TerminalRailPanelBody {...bodyProps()} />);
    fireEvent.click(listItemAt(0));
    // subscribe 已返回但 term 尚未实例化（动态 import 微任务间隙）：
    // 实时字节先攒
    await waitFor(() => {
      expect(ipc.state.dataListenerRegistered).toBe(1);
    });
    ipc.state.dataListeners[0]!({ sessionId: "ts-1", data: "订阅窗口字节" });
    await waitFor(() => {
      expect(xtermFakes.instances).toHaveLength(1);
    });
    const term = xtermFakes.instances[0]!;
    expect(term.written).toEqual(["回放", "订阅窗口字节"]);
  });

  it("键入经 term.onData → terminals:write 原样透传（回车 \\r 不做加工）", async () => {
    installStub();
    render(<TerminalRailPanelBody {...bodyProps()} />);
    fireEvent.click(listItemAt(0));
    await waitFor(() => {
      expect(xtermFakes.instances).toHaveLength(1);
    });
    const term = xtermFakes.instances[0]!;
    term.dataHandler!("ls -la\r");
    await waitFor(() => {
      expect(ipc.state.calls.write).toEqual([
        { sessionId: "ts-1", data: "ls -la\r" },
      ]);
    });
  });

  it("fit 尺寸上报 terminals:resize（proposeDimensions → cols/rows）", async () => {
    installStub();
    render(<TerminalRailPanelBody {...bodyProps()} />);
    fireEvent.click(listItemAt(0));
    await waitFor(() => {
      expect(ipc.state.calls.resize).toEqual([
        { sessionId: "ts-1", cols: 80, rows: 24 },
      ]);
    });
  });

  it("已退出会话：disableStdin 传给 Terminal、onData 不透传 write（只读回看）", async () => {
    installStub();
    render(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg({
              status: "exited",
              exitCode: 0,
              exitedAt: "2026-11-21T08:01:00.000Z",
            }),
          ],
        })}
      />
    );
    fireEvent.click(listItemAt(0));
    await waitFor(() => {
      expect(xtermFakes.instances).toHaveLength(1);
    });
    const term = xtermFakes.instances[0]!;
    expect(term.opts.disableStdin).toBe(true);
    if (term.dataHandler !== null) term.dataHandler("敲不进去");
    expect(ipc.state.calls.write).toEqual([]);
  });

  it("切换会话（点另一行）：旧订阅退订、新会话重新订阅", async () => {
    installStub();
    render(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg(),
            termSeg({ sessionId: "ts-2", id: "ts-2", name: "git-bash · 2" }),
          ],
        })}
      />
    );
    fireEvent.click(listItemAt(0));
    await waitFor(() => {
      expect(ipc.state.calls.subscribe).toEqual(["ts-1"]);
    });
    // 返回列表再点另一行（TerminalSessionView 换 sessionId 重建）
    fireEvent.click(screen.getByTestId("terminal-rail-back"));
    fireEvent.click(listItemAt(1));
    await waitFor(() => {
      expect(ipc.state.calls.subscribe).toEqual(["ts-1", "ts-2"]);
    });
    expect(ipc.state.calls.unsubscribe).toContain("ts-1");
  });

  it("subscribe 明确拒绝（会话不存在）：容器内展示中文 reason 不崩溃", async () => {
    installStub();
    ipc.state.subscribeResults["ts-1"] = {
      ok: false,
      reason: "终端会话不存在：ts-1",
    };
    render(<TerminalRailPanelBody {...bodyProps()} />);
    fireEvent.click(listItemAt(0));
    await waitFor(() => {
      expect(screen.getByTestId("terminal-xterm-host").textContent).toContain(
        "终端会话不存在"
      );
    });
    expect(xtermFakes.instances).toHaveLength(0);
  });
});

describe("TerminalSessionView 复制/粘贴接线（Ctrl+C/V + Shift 变体）", () => {
  /**
   * jsdom 无 navigator.clipboard：注入可控 fake。Electron 渲染端
   * navigator.clipboard 即 OS 剪贴板（AssistantActions 同款用法）。
   */
  function installClipboard() {
    const clipboard = {
      written: [] as string[],
      readTextResult: "粘贴内容",
      writeText: async (text: string) => {
        clipboard.written.push(text);
      },
      readText: async () => clipboard.readTextResult,
    };
    Object.defineProperty(window.navigator, "clipboard", {
      value: clipboard,
      configurable: true,
    });
    return clipboard;
  }

  /** attachCustomKeyEventHandler 只消费这五个字段，极简事件即可 */
  function keyEvent(
    overrides: {
      ctrlKey?: boolean;
      shiftKey?: boolean;
      key?: string;
      type?: string;
    } = {}
  ): KeyboardEvent {
    return {
      type: "keydown",
      ctrlKey: true,
      shiftKey: false,
      key: "c",
      ...overrides,
    } as KeyboardEvent;
  }

  async function mountTerm() {
    installStub();
    render(<TerminalRailPanelBody {...bodyProps()} />);
    fireEvent.click(listItemAt(0));
    await waitFor(() => {
      expect(xtermFakes.instances).toHaveLength(1);
    });
    return xtermFakes.instances[0]!;
  }

  it("Ctrl+C 有选区：选区文本进剪贴板、吞键不透传 ^C", async () => {
    const clipboard = installClipboard();
    const term = await mountTerm();
    term.hasSelection = () => true;
    term.getSelection = () => "选中输出";
    expect(term.keyHandler!(keyEvent())).toBe(false);
    await waitFor(() => {
      expect(clipboard.written).toEqual(["选中输出"]);
    });
    expect(ipc.state.calls.write).toEqual([]);
  });

  it("Ctrl+C 无选区：透传返回 true（SIGINT 主路径不吞）", async () => {
    const clipboard = installClipboard();
    const term = await mountTerm();
    expect(term.keyHandler!(keyEvent())).toBe(true);
    expect(clipboard.written).toEqual([]);
  });

  it("Ctrl+Shift+C 恒复制；无选区吞键但不写剪贴板", async () => {
    const clipboard = installClipboard();
    const term = await mountTerm();
    term.hasSelection = () => true;
    term.getSelection = () => "命令行文本";
    expect(term.keyHandler!(keyEvent({ shiftKey: true }))).toBe(false);
    await waitFor(() => {
      expect(clipboard.written).toEqual(["命令行文本"]);
    });
    // 清空 written 后验证无选区分支：吞键（不 SIGINT）但剪贴板不动
    clipboard.written.length = 0;
    term.hasSelection = () => false;
    term.getSelection = () => "";
    expect(term.keyHandler!(keyEvent({ shiftKey: true }))).toBe(false);
    expect(clipboard.written).toEqual([]);
  });

  it("Ctrl+V：读剪贴板写入 pty（terminals:write 原文透传）", async () => {
    installClipboard();
    const term = await mountTerm();
    expect(term.keyHandler!(keyEvent({ key: "v" }))).toBe(false);
    await waitFor(() => {
      expect(ipc.state.calls.write).toEqual([
        { sessionId: "ts-1", data: "粘贴内容" },
      ]);
    });
  });

  it("已退出会话 Ctrl+V：吞键不写（只读回看）", async () => {
    installClipboard();
    installStub();
    render(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg({
              status: "exited",
              exitCode: 0,
              exitedAt: "2026-11-21T08:01:00.000Z",
            }),
          ],
        })}
      />
    );
    fireEvent.click(listItemAt(0));
    await waitFor(() => {
      expect(xtermFakes.instances).toHaveLength(1);
    });
    const term = xtermFakes.instances[0]!;
    expect(term.keyHandler!(keyEvent({ key: "v" }))).toBe(false);
    expect(ipc.state.calls.write).toEqual([]);
  });

  it("非剪贴板组合键一律透传：Ctrl+C 之外的 Ctrl 系、无 Ctrl 的普通键", async () => {
    installClipboard();
    const term = await mountTerm();
    expect(term.keyHandler!(keyEvent({ key: "d" }))).toBe(true);
    expect(term.keyHandler!(keyEvent({ key: "v", ctrlKey: false }))).toBe(true);
    expect(term.keyHandler!(keyEvent({ type: "keyup" }))).toBe(true);
    expect(ipc.state.calls.write).toEqual([]);
  });
});

describe("RailPanel 终端 tab（useTerminalSessions 数据装载与事件归并）", () => {
  /** RailPanel 所需 props（改动 tab 默认；终端 tab 数据由 hook 拉取） */
  function railProps(
    overrides: Partial<Parameters<typeof RailPanel>[0]> = {}
  ): Parameters<typeof RailPanel>[0] {
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
      terminalFocus: null,
      restoredTerminals: [],
      ...overrides,
    };
  }

  /** 会话记录样例（manager 下发形状；hook 侧映射为段） */
  function record(
    overrides: Partial<TerminalSegment> & { sessionId: string }
  ): Record<string, unknown> {
    const { kind, id, seq, turnId, responseId, ...rest } = termSeg(overrides);
    void kind;
    void id;
    void seq;
    void turnId;
    void responseId;
    return { ...rest };
  }

  function emitTaskEvent(
    taskId: string,
    type: string,
    record: Record<string, unknown>,
    sequence = 1
  ) {
    for (const listener of ipc.state.taskListeners) {
      listener({ taskId, sequence, event: { type, record } });
    }
  }

  it("listFor 初始装载 + 切 tab 看列表；运行中计数徽章", async () => {
    installStub();
    ipc.state.listForResults["task-1"] = [
      record({ sessionId: "ts-1", status: "running" }),
      record({ sessionId: "ts-2", name: "git-bash · 2", status: "running" }),
      record({
        sessionId: "ts-3",
        name: "git-bash · 3",
        status: "exited",
        exitCode: 0,
        exitedAt: "2026-11-21T08:02:00.000Z",
      }),
    ];
    render(<RailPanel {...railProps()} />);
    await screen.findByTestId("terminal-rail-badge");
    // 徽章 = 运行中计数（exited 不计）
    expect(screen.getByTestId("terminal-rail-badge").textContent).toBe("2");
    fireEvent.click(screen.getByTestId("rail-tab-terminals"));
    expect(await screen.findByTestId("terminals-panel")).not.toBeNull();
    expect(screen.getAllByTestId("terminal-rail-item")).toHaveLength(3);
    expect(screen.getAllByTestId("terminal-rail-group-header")).toHaveLength(2);
  });

  it("terminalFocus 定位信号（票 06）：自动切终端 tab 并直跳详情页，不落列表页", async () => {
    installStub();
    ipc.state.listForResults["task-1"] = [
      record({ sessionId: "ts-1", status: "running" }),
      record({ sessionId: "ts-2", name: "git-bash · 2", status: "running" }),
    ];
    render(
      <RailPanel
        {...railProps({ terminalFocus: { sessionId: "ts-2", seq: 1 } })}
      />
    );
    // 自动切 tab（无需手点 rail-tab-terminals）
    expect(await screen.findByTestId("terminals-panel")).not.toBeNull();
    // 直跳详情页：顶栏标题锚定 focus 目标
    await waitFor(() => {
      expect(screen.queryByTestId("terminal-rail-back")).not.toBeNull();
    });
    expect(screen.getByTestId("terminal-rail-title").textContent).toBe(
      "git-bash · 2"
    );
    // 详情页订阅对应会话字节流
    await waitFor(() => {
      expect(ipc.state.calls.subscribe).toEqual(["ts-2"]);
    });
  });

  it("terminal-* 事件增量归并：started 追加、exited 推进并同步徽章", async () => {
    installStub();
    ipc.state.listForResults["task-1"] = [
      record({ sessionId: "ts-1", status: "running" }),
    ];
    render(<RailPanel {...railProps()} />);
    await screen.findByTestId("terminal-rail-badge");
    fireEvent.click(screen.getByTestId("rail-tab-terminals"));
    await screen.findByTestId("terminals-panel");
    // 新会话事件追加（origin=agent 侧 spawn 的会话同通道到达）
    emitTaskEvent(
      "task-1",
      "terminal-started",
      record({ sessionId: "ts-9", name: "git-bash · 9" })
    );
    expect(await screen.findByText("git-bash · 9")).not.toBeNull();
    // 其他任务的事件不归并
    emitTaskEvent(
      "task-other",
      "terminal-started",
      record({ sessionId: "ts-x", name: "别任务会话" })
    );
    expect(screen.queryByText("别任务会话")).toBeNull();
    // 退出事件推进状态（行 data-terminal-state 与徽章同步）
    emitTaskEvent(
      "task-1",
      "terminal-exited",
      record({
        sessionId: "ts-9",
        status: "exited",
        exitCode: 0,
        exitedAt: "2026-11-21T08:05:00.000Z",
      })
    );
    await waitFor(() => {
      expect(screen.getByTestId("terminal-rail-badge").textContent).toBe("1");
    });
  });

  it("切任务重建：新任务 listFor 重拉，旧任务会话不残留", async () => {
    installStub();
    ipc.state.listForResults["task-1"] = [
      record({ sessionId: "ts-1", status: "running" }),
    ];
    ipc.state.listForResults["task-2"] = [
      record({ sessionId: "ts-2", name: "git-bash · 2", status: "running" }),
    ];
    const { rerender } = render(<RailPanel {...railProps()} />);
    await screen.findByTestId("terminal-rail-badge");
    fireEvent.click(screen.getByTestId("rail-tab-terminals"));
    await screen.findByTestId("terminals-panel");
    expect(screen.queryByText("git-bash · 2")).toBeNull();
    rerender(<RailPanel {...railProps({ taskId: "task-2" })} />);
    expect(await screen.findByText("git-bash · 2")).not.toBeNull();
    expect(screen.queryByText("git-bash · 1")).toBeNull();
  });

  it("+ 新建会话：create({taskId}) 调用；超上限中文 reason 直接展示", async () => {
    installStub();
    render(<RailPanel {...railProps()} />);
    fireEvent.click(screen.getByTestId("rail-tab-terminals"));
    const create = await screen.findByTestId("terminal-create");
    fireEvent.click(create);
    await waitFor(() => {
      expect(ipc.state.calls.create).toEqual([{ taskId: "task-1" }]);
    });
    // 拒绝结果直接展示（不另造错误态）
    expect(
      await screen.findByTestId("terminal-create-error").catch(() => null)
    ).not.toBeNull();
    expect(screen.getByTestId("terminal-create-error").textContent).toBe(
      "stub 拒绝"
    );
  });

  it("详情页 kill：onKill → terminals.kill 调用（不弹确认）", async () => {
    installStub();
    ipc.state.listForResults["task-1"] = [
      record({ sessionId: "ts-1", status: "running" }),
    ];
    render(<RailPanel {...railProps()} />);
    await screen.findByTestId("terminal-rail-badge");
    fireEvent.click(screen.getByTestId("rail-tab-terminals"));
    fireEvent.click(await screen.findByTestId("terminal-rail-item"));
    fireEvent.click(await screen.findByTestId("terminal-rail-kill"));
    await waitFor(() => {
      expect(ipc.state.calls.kill).toEqual(["ts-1"]);
    });
  });

  /**
   * 恢复初始化（ADR 0033 票 08）：重启后 list-for 为空（注册表已清），
   * view 并行字段的恢复快照记录（含快照文本）初始化「已退出」组——
   * 重启前后 UI 呈现一致。
   */
  it("恢复快照记录初始化「已退出」组：list-for 为空时恢复记录进列表", async () => {
    installStub();
    // 重启形态：内存注册表空（list-for 空），恢复记录来自 view 并行字段
    render(
      <RailPanel {...railProps({ restoredTerminals: [restoredRecord()] })} />
    );
    // 重启形态无运行中会话：徽章不渲染（runningTerminals > 0 才挂），
    // 直接切终端 tab 等「已退出」组内容
    fireEvent.click(screen.getByTestId("rail-tab-terminals"));
    expect(await screen.findByText("git-bash · 1")).not.toBeNull();
    expect(screen.queryByTestId("terminal-rail-badge")).toBeNull();
    // 分组：恢复记录全部落入「已退出」组（1 组，无运行中组）
    expect(screen.getAllByTestId("terminal-rail-group-header")).toHaveLength(1);
  });

  /** 恢复记录样例（view 并行字段形状：record 含 snapshot 字段进数据源） */
  function restoredRecord(): TerminalSessionRecord {
    return {
      sessionId: "ts-old",
      taskId: "task-1",
      name: "git-bash · 1",
      shell: "git-bash",
      origin: "user",
      status: "exited",
      createdAt: "2026-11-21T08:00:00.000Z",
      exitedAt: "2026-11-21T08:01:00.000Z",
      exitCode: 0,
      snapshot: "重启前输出的尾部",
    };
  }

  it("恢复快照记录与 list-for 同清单合并去重：不重不漏（同进程形态）", async () => {
    installStub();
    // 同进程：list-for 有运行中会话与同 id 已退出会话，恢复记录并入同一
    // 清单（合并层去重 live 优先，rail 列表不重不漏）
    ipc.state.listForResults["task-1"] = [
      record({ sessionId: "ts-live", name: "git-bash · 2", status: "running" }),
      restoredRecord(),
    ];
    render(
      <RailPanel {...railProps({ restoredTerminals: [restoredRecord()] })} />
    );
    await screen.findByTestId("terminal-rail-badge");
    fireEvent.click(screen.getByTestId("rail-tab-terminals"));
    expect(await screen.findByText("git-bash · 2")).not.toBeNull();
    expect(screen.getByText("git-bash · 1")).not.toBeNull();
    expect(screen.getAllByTestId("terminal-rail-item")).toHaveLength(2);
    // 运行中计数徽章只算运行中（恢复的已退出记录不计）
    expect(screen.getByTestId("terminal-rail-badge").textContent).toBe("1");
  });
});

describe("TerminalSessionDetail 改名（标题功能轮）", () => {
  /** 进详情页并进入改名输入态，返回输入框元素 */
  async function openRenameInput(
    onRename: (sessionId: string, title: string) => void
  ) {
    installStub();
    render(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [termSeg({ title: "构建服务器" })],
          onRename,
        })}
      />
    );
    fireEvent.click(listItemAt(0));
    await waitFor(() => {
      expect(screen.getByTestId("terminal-rail-detail-header")).toBeTruthy();
    });
    expect(screen.getByTestId("terminal-rail-title").textContent).toBe(
      "构建服务器"
    );
    fireEvent.click(screen.getByTestId("terminal-rail-title"));
    return screen.getByTestId("terminal-rename-input");
  }

  it("点标题进输入态，Enter 提交 trim 后的值经 onRename", async () => {
    const onRename = vi.fn();
    const input = await openRenameInput(onRename);
    fireEvent.change(input, { target: { value: "  部署终端  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("ts-1", "部署终端");
    // 提交后回到展示态
    expect(screen.queryByTestId("terminal-rename-input")).toBeNull();
  });

  it("Esc 取消不提交；同值提交不触发 onRename", async () => {
    const onRename = vi.fn();
    const input = await openRenameInput(onRename);
    fireEvent.change(input, { target: { value: "改一半" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId("terminal-rename-input")).toBeNull();

    // 再进编辑态：同值（含首尾空白）提交不触发
    fireEvent.click(screen.getByTestId("terminal-rail-title"));
    const again = screen.getByTestId("terminal-rename-input");
    fireEvent.change(again, { target: { value: "  构建服务器  " } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
  });

  it("已退出会话标题为纯文本，无改名入口", async () => {
    installStub();
    const onRename = vi.fn();
    render(
      <TerminalRailPanelBody
        {...bodyProps({
          sessions: [
            termSeg({
              status: "exited",
              exitCode: 0,
              exitedAt: "2026-11-21T08:01:00.000Z",
            }),
          ],
          onRename,
        })}
      />
    );
    fireEvent.click(listItemAt(0));
    await waitFor(() => {
      expect(screen.getByTestId("terminal-rail-detail-header")).toBeTruthy();
    });
    // 纯文本 span：点击不产生输入态
    fireEvent.click(screen.getByTestId("terminal-rail-title"));
    expect(screen.queryByTestId("terminal-rename-input")).toBeNull();
  });
});
