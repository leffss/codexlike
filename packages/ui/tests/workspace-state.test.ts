import { describe, expect, it, vi } from "vitest";
import type { InteractionRecord } from "@codexlike/agent-core";
import { createWorkspaceState } from "../src/lib/workspace-state";

function pending(
  id: string,
  sessionId = "s1",
  createdAt = "2026-11-11T08:00:00Z"
): InteractionRecord {
  return {
    request: {
      id,
      sessionId,
      turnId: "t1",
      toolCallId: id,
      source: { kind: "main" },
      createdAt,
      kind: "approval",
      toolName: "run_terminal_command",
      command: "git status",
      commandWord: "git",
    },
    status: "pending",
    response: null,
    resolvedAt: null,
    cancelReason: null,
  };
}

describe("工作台页面之上的内存状态", () => {
  it("Compact权威快照清理已折叠历史，保留终态墓碑和真实pending草稿，快照期间新终态不丢", () => {
    const store = createWorkspaceState();
    const old = {
      ...pending("old"),
      status: "resolved" as const,
      response: { kind: "approval" as const, decision: "approve" as const },
    };
    store.observe(old);
    const question: InteractionRecord = {
      ...pending("q"),
      request: {
        ...pending("q").request,
        kind: "questions",
        questions: [
          {
            id: "q1",
            header: "问题",
            question: "怎么做？",
            multiSelect: false,
            options: [],
          },
        ],
      },
    };
    store.observe(question);
    store.edit("s1", "q", { type: "custom", text: "不能丢" });
    const since = store.version();
    const fresh = {
      ...pending("fresh"),
      status: "resolved" as const,
      response: { kind: "approval" as const, decision: "reject" as const },
    };
    store.observe(fresh);
    store.reconcile("s1", [], since);
    expect(store.records("s1").map((record) => record.request.id)).toEqual([
      "q",
      "fresh",
    ]);
    expect(store.draft("s1", "q")?.answers.q1?.text).toBe("不能丢");
    store.observe(pending("old"));
    expect(store.records("s1").map((record) => record.request.id)).toEqual([
      "q",
      "fresh",
    ]);
    expect(store.pending("s1").map((record) => record.request.id)).toEqual([
      "q",
    ]);
  });
  it("停止终态先于提交响应到达时不复活；另一个请求仍待处理", async () => {
    const store = createWorkspaceState();
    const first = pending("first");
    store.observe(first);
    store.observe(pending("second", "s1", "2026-11-11T08:00:01Z"));
    let resolve!: (accepted: boolean) => void;
    const result = store.submit(
      "s1",
      "first",
      { kind: "approval", decision: "approve" },
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        })
    );
    store.observe({ ...first, status: "cancelled", cancelReason: "停止" });
    resolve(true);
    await result;
    expect(store.records("s1")[0]?.status).toBe("cancelled");
    expect(store.pending("s1").map((record) => record.request.id)).toEqual([
      "second",
    ]);
    expect(store.submission("s1", "first")).toEqual({
      busy: false,
      error: null,
    });
  });
  it("提交锁同步生效；错误保留草稿，重试成功转终态，迟到失败不污染别的会话", async () => {
    const store = createWorkspaceState();
    const record: InteractionRecord = {
      ...pending("q"),
      request: {
        ...pending("q").request,
        kind: "questions",
        questions: [
          {
            id: "q1",
            header: "问题",
            question: "怎么做？",
            multiSelect: false,
            options: [],
          },
        ],
      },
    };
    store.observe(record);
    store.edit("s1", "q", { type: "custom", text: "保留我" });
    const response = {
      kind: "questions" as const,
      answers: [
        {
          questionId: "q1",
          status: "answered" as const,
          selectedOptionIds: [],
          text: "保留我",
        },
      ],
    };
    let reject!: (error: Error) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((_, rejectPromise) => {
          reject = rejectPromise;
        })
    );
    const submitting = store.submit("s1", "q", response, send);
    await store.submit("s1", "q", response, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.submission("s1", "q").busy).toBe(true);
    reject(new Error("暂时离线"));
    await submitting;
    expect(store.submission("s1", "q").error).toContain("暂时离线");
    expect(store.submission("s2", "q").error).toBeNull();
    expect(store.draft("s1", "q")?.answers.q1?.text).toBe("保留我");
    await store.submit("s1", "q", response, async () => true);
    expect(store.pending("s1")).toEqual([]);
    expect(store.draft("s1", "q")).toBeUndefined();
    await store.submit("s1", "q", response, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("IPC false 将过期卡关闭并保留错误，不再可提交", async () => {
    const store = createWorkspaceState();
    store.observe(pending("r"));
    await store.submit(
      "s1",
      "r",
      { kind: "approval", decision: "approve" },
      async () => false
    );
    expect(store.pending("s1")).toEqual([]);
    expect(store.submission("s1", "r").error).toContain("失效");
    store.observe(pending("r"));
    expect(store.pending("s1")).toEqual([]);
  });
  it("请求草稿与普通输入按会话隔离，切页不丢且新 App 实例不恢复", () => {
    const store = createWorkspaceState();
    const record: InteractionRecord = {
      ...pending("q"),
      request: {
        ...pending("q").request,
        kind: "questions",
        questions: [
          {
            id: "q1",
            header: "问题",
            question: "怎么做？",
            multiSelect: false,
            options: [],
          },
          {
            id: "q2",
            header: "问题2",
            question: "下一步？",
            multiSelect: false,
            options: [],
          },
        ],
      },
    };
    store.observe(record);
    store.edit("s1", "q", { type: "custom", text: "草稿" });
    store.edit("s1", "q", { type: "next" });
    store.setComposer("s1", "原输入");
    store.setComposer("s2", "别的输入");
    expect(store.draft("s1", "q")?.index).toBe(1);
    expect(store.draft("s1", "q")?.answers.q1?.text).toBe("草稿");
    expect(store.composer("s1")).toBe("原输入");
    expect(store.composer("s2")).toBe("别的输入");
    expect(createWorkspaceState().draft("s1", "q")).toBeUndefined();
    expect(createWorkspaceState().composer("s1")).toBe("");
  });
  it("pending FIFO；实时终态优先于迟到快照且不同会话隔离", () => {
    const store = createWorkspaceState();
    const first = pending("first");
    const second = pending("second", "s1", "2026-11-11T08:00:01Z");
    store.observe({ ...first, status: "cancelled", cancelReason: "已停止" });
    store.observe(pending("background", "s2"));
    store.observe(second);
    store.observe(first);
    expect(store.pending("s1").map((record) => record.request.id)).toEqual([
      "second",
    ]);
    expect(store.pending("s2").map((record) => record.request.id)).toEqual([
      "background",
    ]);
    store.observe(pending("earlier", "s1", "2026-11-11T07:00:00Z"));
    expect(store.pending("s1").map((record) => record.request.id)).toEqual([
      "earlier",
      "second",
    ]);
  });
});
