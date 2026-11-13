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

describe("工作台页面之上的状态", () => {
  it("项目移除清理03缓存及迟到响应，不复活删除草稿且不阻塞幸存会话保存", async () => {
    const entry = {
      revision: 0,
      value: {
        text: "旧草稿",
        requestId: "old",
        questionDrafts: {},
        readingPosition: null,
        preferences: {
          providerProfileId: "default",
          thinkingEffort: "auto" as const,
          approvalMode: "ask" as const,
        },
      },
    };
    let release!: (value: typeof entry) => void;
    let rejectWrite!: (error: Error) => void;
    const state = createWorkspaceState({
      read: async (target) =>
        target.kind === "session" && target.sessionId === "loading"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : structuredClone(entry),
      write: async (target, value) => {
        if (target.kind === "session" && target.sessionId === "writing")
          return new Promise((_resolve, reject) => {
            rejectWrite = reject;
          });
        return { accepted: true, entry: value };
      },
    });
    await state.loadTask("writing");
    await state.loadTask("kept");
    state.setComposer("writing", "已删除目标写入中");
    await vi.waitFor(() => expect(rejectWrite).toBeTypeOf("function"));
    const loading = state.loadTask("loading");
    state.removeProject("p", ["loading", "writing"]);
    release(entry);
    rejectWrite(new Error("会话不存在"));
    await loading;
    state.observe(pending("late", "loading"));
    state.setComposer("kept", "幸存独立输入");
    await expect(state.flush()).resolves.toBeUndefined();
    expect(state.composer("loading")).toBe("");
    expect(state.composer("writing")).toBe("");
    expect(state.records("loading")).toEqual([]);
    expect(state.composer("kept")).toBe("幸存独立输入");
    expect(state.persistenceError()).toBeNull();
  });
  it("保存按目标串行，flush 等待最新编辑；重建状态从宿主恢复而不复活旧问答", async () => {
    const disk = new Map<string, any>();
    let release!: () => void;
    let hold = true;
    const port = {
      async read(target: unknown) {
        return (
          disk.get(JSON.stringify(target)) ?? {
            revision: 0,
            value: {
              requestId: "intent",
              text: "",
              questionDrafts: {},
              readingPosition: null,
              preferences: {
                providerProfileId: "default",
                thinkingEffort: "auto",
                approvalMode: "ask",
              },
            },
          }
        );
      },
      async write(target: unknown, entry: any) {
        if (hold) {
          hold = false;
          await new Promise<void>((done) => {
            release = done;
          });
        }
        disk.set(JSON.stringify(target), structuredClone(entry));
        return { accepted: true, entry };
      },
    };
    const state = createWorkspaceState(port);
    await state.loadTask("s1");
    await state.loadTask("s2");
    state.setComposer("s1", "旧输入");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    state.setComposer("s1", "最新输入");
    state.setComposer("s2", "另一个会话");
    state.setPreferences("s1", {
      thinkingEffort: "high",
      approvalMode: "full-access",
    });
    state.setReadingPosition("s1", { scrollTop: 321 });
    let flushed = false;
    const flush = state.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    await flush;
    const restored = createWorkspaceState(port);
    await restored.loadTask("s1");
    await restored.loadTask("s2");
    expect(restored.composer("s1")).toBe("最新输入");
    expect(restored.composer("s2")).toBe("另一个会话");
    expect(restored.preferences("s1").thinkingEffort).toBe("high");
    expect(restored.readingPosition("s1")).toEqual({ scrollTop: 321 });
    expect(restored.pending("s1")).toEqual([]);
  });
  it("慢速恢复不能覆盖加载期间的新输入，快速切换不会串会话", async () => {
    let release!: (value: any) => void;
    const state = createWorkspaceState({
      read: () =>
        new Promise((done) => {
          release = done;
        }),
      write: async (_target, entry) => ({ accepted: true, entry }),
    });
    const loading = state.loadTask("slow");
    state.setComposer("slow", "加载期间新输入");
    release({
      revision: 5,
      value: {
        text: "旧持久输入",
        requestId: "intent",
        questionDrafts: {},
        readingPosition: null,
        preferences: {
          providerProfileId: "old",
          thinkingEffort: "auto",
          approvalMode: "ask",
        },
      },
    });
    await loading;
    await state.flush();
    expect(state.composer("slow")).toBe("加载期间新输入");
  });
  it("保存暂时失败后重试不会被其他偏好编辑覆盖未保存输入", async () => {
    let saved: any = {
      revision: 0,
      value: {
        text: "",
        requestId: "retry",
        questionDrafts: {},
        readingPosition: null,
        preferences: {
          providerProfileId: "default",
          thinkingEffort: "auto",
          approvalMode: "ask",
        },
      },
    };
    let fail = true;
    const state = createWorkspaceState({
      read: async () => structuredClone(saved),
      write: async (_target, entry) => {
        if (fail) {
          fail = false;
          throw new Error("磁盘暂时不可写");
        }
        saved = structuredClone(entry);
        return { accepted: true, entry };
      },
    });
    await state.loadTask("s");
    state.setComposer("s", "失败也不能丢");
    await expect(state.flush()).rejects.toThrow("磁盘");
    state.setPreferences("s", { thinkingEffort: "high" });
    await state.flush();
    expect(saved.value.text).toBe("失败也不能丢");
    expect(saved.value.preferences.thinkingEffort).toBe("high");
  });
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
