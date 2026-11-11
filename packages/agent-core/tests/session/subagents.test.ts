import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteSessionStore } from "../../src/session/persistence";
import { createAgentSession } from "../../src/session/agent-session";
import type { SessionEvent, SessionRecord } from "../../src/session/types";
import { createBuiltinTools } from "../../src/tools/builtin";
import type { AgentResourceSnapshot } from "../../src/context/resource-types";
import type { ToolDefinition } from "../../src/tools/types";
import { fakeResourceSnapshot } from "./resource-fixture";

const profile: ProviderProfile = {
  id: "main-profile",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  model: "glm-4.7",
};

/** 子代理专用 Profile（设置页「子代理模型」引用；默认 null = 同主模型） */
const subProfile: ProviderProfile = {
  id: "sub-profile",
  name: "GLM 子代理",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-sub",
  model: "glm-4.7-air",
};

function sessionRecord(workspacePath: string): SessionRecord {
  return {
    id: "session-1",
    title: "demo",
    workspacePath,
    providerProfileId: null,
    model: null,
    workspaceMode: "local",
    workspaceOriginPath: null,
    status: "idle",
    approvalMode: "assist",
    archivedAt: null,
    createdAt: "2026-11-11T08:00:00.000Z",
    updatedAt: "2026-11-11T08:00:00.000Z",
  };
}

function usage() {
  return {
    inputTokens: {
      total: 1,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 2, text: undefined, reasoning: undefined },
  };
}

function finishPart(reason: "stop" | "tool-calls" = "stop") {
  return {
    usage: usage(),
    finishReason: {
      unified: reason,
      raw: reason === "stop" ? "stop" : "tool_calls",
    },
  };
}

/** 文本轮流式（ai v7：text-start/delta/end 包裹，前人踩坑） */
function textRound(
  deltas: string[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "text-1" });
      for (const delta of deltas) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta });
      }
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({ type: "finish", ...finishPart() });
      controller.close();
    },
  });
}

/** 工具调用轮流式（finishReason 为 tool-calls，工具由循环执行后回填） */
function toolCallRound(
  toolCalls: { toolCallId: string; toolName: string; input: unknown }[]
) {
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const call of toolCalls) {
        controller.enqueue({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        });
      }
      controller.enqueue({ type: "finish", ...finishPart("tool-calls") });
      controller.close();
    },
  });
  return { stream };
}

type ScriptedStep =
  | { kind: "text"; deltas: string[] }
  | {
      kind: "tool";
      calls: { toolCallId: string; toolName: string; input: unknown }[];
    };

function scriptedModel(steps: ScriptedStep[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(call++, steps.length - 1)]!;
      if (step.kind === "tool") {
        return toolCallRound(step.calls);
      }
      return { stream: textRound(step.deltas) };
    },
  });
}

function fakeClock() {
  let tick = 0;
  return () => `2026-11-11T08:00:${String(++tick).padStart(2, "0")}.000Z`;
}

async function collect(
  iterable: AsyncIterable<SessionEvent>
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

interface SubagentHarnessOptions {
  workspacePath: string;
  /** 主模型脚本 */
  main: ScriptedStep[];
  /** 子代理模型脚本（每个子代理共用同一 mock 实例，按调用次序消费） */
  sub?: ScriptedStep[];
  /** 直接注入子代理模型（与 sub 脚本二选一；用于受控挂起等复杂场景） */
  subModel?: MockLanguageModelV4;
  /** 子代理 Profile 解析（缺省固定返回 sub-profile） */
  resolveProfile?: () => Promise<ProviderProfile | null>;
  /** 并发上限（缺省 3） */
  maxConcurrent?: number;
  /** 审批模式 */
  approvalMode?: SessionRecord["approvalMode"];
  resources?: () => AgentResourceSnapshot;
  subTools?: ToolDefinition[];
}

/**
 * 装配带子代理的会话：主/子模型用不同 mock（profile.id 区分），
 * 工具集为内置六件（不含 spawn_subagent，由会话按 subagents 配置追加）。
 */
function makeSubagentSession(options: SubagentHarnessOptions) {
  const mainModel = scriptedModel(options.main);
  const subModel =
    options.subModel ??
    scriptedModel(
      options.sub ?? [{ kind: "text", deltas: ["子代理默认报告"] }]
    );
  const persistence = createSqliteSessionStore(":memory:");
  const record = sessionRecord(options.workspacePath);
  record.approvalMode = options.approvalMode ?? "assist";
  persistence.insertSession(record);
  const session = createAgentSession({
    record,
    persistence,
    history: persistence.listMessages(record.id),
    languageModelFor: (p) => (p.id === subProfile.id ? subModel : mainModel),
    tools: createBuiltinTools(),
    resources: options.resources,
    subagents: {
      // 子代理可用工具：内置六件（实现侧必须剔除 spawn_subagent 防递归）
      tools: options.subTools ?? createBuiltinTools(),
      languageModelFor: (p) => (p.id === subProfile.id ? subModel : mainModel),
      settings: () => ({ maxConcurrent: options.maxConcurrent ?? 3 }),
      resolveProfile: options.resolveProfile ?? (async () => subProfile),
    },
    now: fakeClock(),
  });
  return { session, persistence, mainModel, subModel };
}

describe("子代理（spawn_subagent，GLOSSARY「子代理」）", () => {
  it("子代理继承本轮规范与目录，正文隔离且任务中的美元引用不自动激活", async () => {
    const { session, mainModel, subModel, persistence } = makeSubagentSession({
      workspacePath: "C:/work/demo",
      resources: () =>
        fakeResourceSnapshot("共享规范：使用中文、目录含 alpha/beta"),
      main: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "delegate",
              toolName: "spawn_subagent",
              input: { task: "检查 $beta" },
            },
          ],
        },
        { kind: "text", deltas: ["收到报告"] },
      ],
      sub: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "read-main",
              toolName: "read_skill_resource",
              input: { name: "alpha" },
            },
          ],
        },
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "load-sub",
              toolName: "load_skill",
              input: { name: "beta" },
            },
          ],
        },
        { kind: "text", deltas: ["子代理报告"] },
      ],
    });
    const events = await collect(
      session.sendMessage({ text: "$alpha 委派任务", profile })
    );
    const firstSub = JSON.stringify(subModel.doStreamCalls[0]?.prompt);
    expect(firstSub).toContain("你是 CodexLike 的子代理");
    expect(firstSub).toContain("共享规范：使用中文");
    expect(firstSub).not.toContain("ALPHA_PRIVATE_BODY");
    expect(firstSub).not.toContain("BETA_PRIVATE_BODY");
    expect(
      subModel.doStreamCalls[0]?.tools?.map((tool) => tool.name)
    ).not.toContain("spawn_subagent");
    expect(
      subModel.doStreamCalls[0]?.tools?.map((tool) => tool.name)
    ).toContain("load_skill");
    expect(
      events.find(
        (event) =>
          event.type === "subagent-tool" &&
          event.phase === "result" &&
          event.call.id === "read-main"
      )
    ).toMatchObject({
      call: { isError: true, output: expect.stringContaining("尚未加载") },
    });
    expect(JSON.stringify(subModel.doStreamCalls[2]?.prompt)).toContain(
      "BETA_PRIVATE_BODY"
    );
    const nextMain = JSON.stringify(mainModel.doStreamCalls[1]?.prompt);
    expect(nextMain).toContain("ALPHA_PRIVATE_BODY");
    expect(nextMain).not.toContain("BETA_PRIVATE_BODY");
    const queued = events.find((event) => event.type === "subagent-queued");
    expect(session.resourceState.last?.loaded).toEqual([
      expect.objectContaining({ executorId: "main", name: "alpha" }),
      expect.objectContaining({
        executorId:
          queued?.type === "subagent-queued" ? queued.subagentId : "missing",
        name: "beta",
      }),
    ]);
    expect(session.resourceState.active).toBeNull();
    persistence.close();
  });

  it("子代理工具与资源工具重名时报错回流，不请求子模型", async () => {
    const { session, subModel, persistence } = makeSubagentSession({
      workspacePath: "C:/work/demo",
      resources: () => fakeResourceSnapshot(),
      subTools: [
        {
          name: "load_skill",
          description: "重名工具",
          parameters: { type: "object", properties: {} },
          permission: "readonly",
          async execute() {
            throw new Error("不应执行");
          },
        },
      ],
      main: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "delegate",
              toolName: "spawn_subagent",
              input: { task: "任务" },
            },
          ],
        },
        { kind: "text", deltas: ["失败报告已收到"] },
      ],
    });
    const events = await collect(
      session.sendMessage({ text: "委派", profile })
    );
    expect(
      events.find((event) => event.type === "subagent-report")
    ).toMatchObject({
      ok: false,
      report: expect.stringContaining("工具名称冲突：load_skill"),
    });
    expect(subModel.doStreamCalls).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("assistant-done");
    expect(session.resourceState.active).toBeNull();
    persistence.close();
  });

  it("并行子代理共享固定规范快照但不共享已加载正文或资源权限", async () => {
    let revision = "运行快照第一版";
    let releaseAlpha!: () => void;
    const alphaGate = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    const steps = new Map<string, number>();
    const subModel = new MockLanguageModelV4({
      doStream: async (request) => {
        const isAlpha = JSON.stringify(request.prompt[1]).includes(
          "alpha-worker"
        );
        const worker = isAlpha ? "alpha-worker" : "beta-worker";
        const step = steps.get(worker) ?? 0;
        steps.set(worker, step + 1);
        if (isAlpha && step === 0)
          return toolCallRound([
            {
              toolCallId: "a-load",
              toolName: "load_skill",
              input: { name: "alpha" },
            },
          ]);
        if (isAlpha) {
          await alphaGate;
          return { stream: textRound(["甲报告"]) };
        }
        if (step === 0)
          return toolCallRound([
            {
              toolCallId: "b-read",
              toolName: "read_skill_resource",
              input: { name: "alpha" },
            },
          ]);
        if (step === 1)
          return toolCallRound([
            {
              toolCallId: "b-load",
              toolName: "load_skill",
              input: { name: "beta" },
            },
          ]);
        return { stream: textRound(["乙报告"]) };
      },
    });
    const { session, mainModel, persistence } = makeSubagentSession({
      workspacePath: "C:/work/demo",
      maxConcurrent: 2,
      subModel,
      resources: () => fakeResourceSnapshot(revision),
      main: [
        {
          kind: "tool",
          calls: ["alpha-worker", "beta-worker"].map((task) => ({
            toolCallId: task,
            toolName: "spawn_subagent",
            input: { task },
          })),
        },
        { kind: "text", deltas: ["两份报告已收到"] },
      ],
    });
    const events: SessionEvent[] = [];
    for await (const event of session.sendMessage({
      text: "并行委派",
      profile,
    })) {
      events.push(event);
      if (event.type === "user-message") revision = "下轮磁盘第二版";
      if (event.type === "subagent-report" && event.task === "beta-worker") {
        expect(
          events.some(
            (item) =>
              item.type === "subagent-report" && item.task === "alpha-worker"
          )
        ).toBe(false);
        expect(session.resourceState.active?.loaded).toHaveLength(2);
        releaseAlpha();
      }
    }
    expect(
      events.find(
        (event) =>
          event.type === "subagent-tool" &&
          event.phase === "result" &&
          event.call.id === "b-read"
      )
    ).toMatchObject({
      call: { isError: true, output: expect.stringContaining("尚未加载") },
    });
    for (const request of subModel.doStreamCalls) {
      const prompt = JSON.stringify(request.prompt);
      expect(prompt).toContain("运行快照第一版");
      expect(prompt).not.toContain("下轮磁盘第二版");
      if (prompt.includes("alpha-worker"))
        expect(prompt).not.toContain("BETA_PRIVATE_BODY");
      else expect(prompt).not.toContain("ALPHA_PRIVATE_BODY");
    }
    expect(
      JSON.stringify(mainModel.doStreamCalls.at(-1)?.prompt)
    ).not.toContain("PRIVATE_BODY");
    const loaded = session.resourceState.last?.loaded ?? [];
    expect(loaded.map((item) => item.name).sort()).toEqual(["alpha", "beta"]);
    expect(new Set(loaded.map((item) => item.executorId)).size).toBe(2);
    expect(loaded.every((item) => item.executorId !== "main")).toBe(true);
    expect(session.resourceState.active).toBeNull();
    persistence.close();
  });

  it("委派调研任务：子代理独立完成并以文本报告回流主会话上下文", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const { session, persistence, mainModel, subModel } = makeSubagentSession({
      workspacePath: workspace,
      main: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "delegate-1",
              toolName: "spawn_subagent",
              input: { task: "调研本仓库的测试框架并总结" },
            },
          ],
        },
        { kind: "text", deltas: ["子代理的调研结论已收到"] },
      ],
      sub: [
        {
          kind: "text",
          deltas: ["调研报告：本项目使用 vitest，共 200 个用例。"],
        },
      ],
    });

    const events = await collect(
      session.sendMessage({ text: "帮我调研一下测试框架", profile })
    );

    // 子代理模型被真实调用（独立上下文，一次 doStream 出报告）
    expect(subModel.doStreamCalls).toHaveLength(1);
    const subPrompt = subModel.doStreamCalls[0]!.prompt;
    // 独立上下文：含任务描述，不含主会话消息原文
    const subPromptJson = JSON.stringify(subPrompt);
    expect(subPromptJson).toContain("调研本仓库的测试框架并总结");
    expect(subPromptJson).not.toContain("帮我调研一下测试框架");

    // 报告作为工具结果回流：spawn_subagent 卡片的 output 是报告文本
    const resultEvent = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.call.toolName === "spawn_subagent"
    );
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.call.isError).toBe(false);
    expect(resultEvent!.call.output).toContain("调研报告：本项目使用 vitest");

    // 主模型第二轮收到报告（作为 spawn_subagent 的工具结果）
    expect(mainModel.doStreamCalls).toHaveLength(2);
    const secondPrompt = JSON.stringify(mainModel.doStreamCalls[1]!.prompt);
    expect(secondPrompt).toContain("调研报告：本项目使用 vitest");

    // 主会话正常收尾，子代理调用记录落库（报告随 output 持久化）
    expect(events.at(-1)?.type).toBe("assistant-done");
    const stored = persistence
      .listToolCalls("session-1")
      .find((c) => c.toolName === "spawn_subagent");
    expect(stored?.output).toContain("调研报告：本项目使用 vitest");
  });

  it("防递归：子代理工具集不含 spawn_subagent，子代理尝试再委派返回可读错误", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const { session, subModel } = makeSubagentSession({
      workspacePath: workspace,
      main: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "d1",
              toolName: "spawn_subagent",
              input: { task: "再委派一次试试" },
            },
          ],
        },
        { kind: "text", deltas: ["收到"] },
      ],
      // 子代理模型第一轮尝试调 spawn_subagent（应被当作未注册工具回填），第二轮出报告
      sub: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "sub-c1",
              toolName: "spawn_subagent",
              input: { task: "套娃" },
            },
          ],
        },
        { kind: "text", deltas: ["子代理无法再委派，直接报告"] },
      ],
    });

    const events = await collect(
      session.sendMessage({ text: "去调研", profile })
    );

    // 子代理模型的工具表不含 spawn_subagent（doStream 调用参数的 tools 里没有该名）
    const subCall = subModel.doStreamCalls[0] as {
      tools?: { name?: string }[];
    };
    const toolNames = (subCall.tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain("spawn_subagent");
    expect(toolNames).toContain("read_file");

    // 行为断言：子代理尝试调用 → 「未注册」错误回填子代理 → 子代理继续到最终报告
    const subToolEvents = events.filter(
      (e): e is Extract<SessionEvent, { type: "subagent-tool" }> =>
        e.type === "subagent-tool"
    );
    const rejected = subToolEvents.find(
      (e) => e.phase === "result" && e.call.toolName === "spawn_subagent"
    );
    expect(rejected?.call.isError).toBe(true);
    expect(rejected?.call.output).toContain("未注册");

    // 子代理最终报告回流（未被套娃调用破坏），主会话正常收尾
    const reportEvent = events.find(
      (e): e is Extract<SessionEvent, { type: "subagent-report" }> =>
        e.type === "subagent-report"
    );
    expect(reportEvent?.report).toContain("子代理无法再委派");
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("并发上限 3：第 4 个委派排队（FIFO），有空位后开跑；全部完成后报告各自回流", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));

    // 受控子模型：每个子代理的 doStream 挂起直至测试放行（gate），
    // 释放后返回带编号的报告——并发数 = 模型调用数，可精确观察
    const releases: (() => void)[] = [];
    let callSeq = 0;
    const subModel = new MockLanguageModelV4({
      doStream: async () => {
        const index = callSeq++;
        const stream = new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            await new Promise<void>((resolve) => {
              releases[index] = resolve;
            });
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({
              type: "text-delta",
              id: "text-1",
              delta: `子代理 ${index} 的调研报告`,
            });
            controller.enqueue({ type: "text-end", id: "text-1" });
            controller.enqueue({ type: "finish", ...finishPart() });
            controller.close();
          },
        });
        return { stream };
      },
    });

    const { session, mainModel } = makeSubagentSession({
      workspacePath: workspace,
      main: [
        {
          kind: "tool",
          calls: [1, 2, 3, 4].map((n) => ({
            toolCallId: `delegate-${n}`,
            toolName: "spawn_subagent",
            input: { task: `任务 ${n}` },
          })),
        },
        { kind: "text", deltas: ["四份报告都收到"] },
      ],
      subModel,
    });

    const events: SessionEvent[] = [];
    const iterator = session
      .sendMessage({
        text: "并行调研四件事",
        profile,
      })
      [Symbol.asyncIterator]();

    // 推进到 4 个委派全部派发（第 4 个 queued 事件即证据：前 3 个已 start）
    async function drainUntil(
      predicate: (event: SessionEvent) => boolean
    ): Promise<void> {
      for (
        let head = await iterator.next();
        !head.done;
        head = await iterator.next()
      ) {
        events.push(head.value);
        if (predicate(head.value)) {
          return;
        }
      }
    }

    await drainUntil(
      (event) =>
        event.type === "subagent-queued" &&
        events.filter((e) => e.type === "subagent-queued").length === 4
    );

    // 前 3 个并发运行（模型调用 = 3），第 4 个排队（无第 4 次模型调用）。
    // 模型调用发生在 resolveProfile 微任务后，用 waitFor 等其稳定。
    await vi.waitFor(() => expect(subModel.doStreamCalls).toHaveLength(3));
    expect(events.filter((e) => e.type === "subagent-start")).toHaveLength(3);
    expect(events.filter((e) => e.type === "subagent-report")).toHaveLength(0);

    // 释放第 0 个子代理：队列中的第 4 个立即占位开跑
    releases[0]!();
    await vi.waitFor(() => expect(subModel.doStreamCalls).toHaveLength(4));
    await drainUntil(
      (event) =>
        event.type === "subagent-start" &&
        events.filter((e) => e.type === "subagent-start").length === 4
    );

    // 释放剩余全部：4 份报告各自回流为 tool-result，主会话收尾
    for (let i = 1; i < 4; i += 1) {
      releases[i]?.();
    }
    for (
      let head = await iterator.next();
      !head.done;
      head = await iterator.next()
    ) {
      events.push(head.value);
    }

    expect(events.filter((e) => e.type === "subagent-report")).toHaveLength(4);
    const delegationResults = events.filter(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.call.toolName === "spawn_subagent"
    );
    expect(delegationResults).toHaveLength(4);
    // 各委派的报告与 toolCallId 一一对应（delegate-1..4 按编号回流）
    for (const result of delegationResults) {
      const index = Number(result.call.id.slice(-1));
      expect(result.call.output).toContain(`子代理 ${index - 1} 的调研报告`);
      expect(result.call.isError).toBe(false);
    }
    // 主模型第二轮收到全部 4 份报告
    const secondPrompt = JSON.stringify(mainModel.doStreamCalls[1]?.prompt);
    for (let i = 0; i < 4; i += 1) {
      expect(secondPrompt).toContain(`子代理 ${i} 的调研报告`);
    }
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("ask 传导：子代理的写入弹审批卡，拒绝后不落盘且拒绝原因回流", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const { session } = makeSubagentSession({
      workspacePath: workspace,
      approvalMode: "ask",
      resources: () => fakeResourceSnapshot(),
      main: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "d1",
              toolName: "spawn_subagent",
              input: { task: "写入一个文件" },
            },
          ],
        },
        { kind: "text", deltas: ["ask 档下子代理的写入没被批准"] },
      ],
      // 加载技能不会提升写入权限：只读加载放行，write_file 仍须审批。
      sub: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "sub-load",
              toolName: "load_skill",
              input: { name: "alpha" },
            },
          ],
        },
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "sub-w",
              toolName: "write_file",
              input: { path: "secret.txt", content: "x" },
            },
          ],
        },
        { kind: "text", deltas: ["写入被用户拒绝，改用只读手段完成了调研"] },
      ],
    });

    const events: SessionEvent[] = [];
    const iterator = session
      .sendMessage({ text: "让子代理写文件", profile })
      [Symbol.asyncIterator]();
    let approvalRequest: Extract<
      SessionEvent,
      { type: "interaction-request" }
    > | null = null;
    for (
      let head = await iterator.next();
      !head.done;
      head = await iterator.next()
    ) {
      events.push(head.value);
      if (head.value.type === "interaction-request") {
        approvalRequest = head.value;
        break;
      }
    }
    // 子代理的写入弹卡（request.subagentId 标注来源），拒绝
    expect(approvalRequest).not.toBeNull();
    if (
      approvalRequest!.interaction.request.kind !== "approval" ||
      approvalRequest!.interaction.request.source.kind !== "subagent"
    )
      throw new Error("预期子代理审批");
    expect(approvalRequest!.interaction.request.toolName).toBe("write_file");
    expect(session.resourceState.active?.loaded).toEqual([
      expect.objectContaining({
        executorId: approvalRequest!.interaction.request.source.subagentId,
        name: "alpha",
      }),
    ]);
    expect(
      events.filter((event) => event.type === "interaction-request")
    ).toHaveLength(1);
    expect(
      session.respondApproval(approvalRequest!.interaction.request.id, "reject")
    ).toBe(true);

    for (
      let head = await iterator.next();
      !head.done;
      head = await iterator.next()
    ) {
      events.push(head.value);
    }

    // 子代理的 write_file 被真实拦截：subagent-tool 结果为拒绝，文件不落盘
    const writeResult = events.find(
      (e): e is Extract<SessionEvent, { type: "subagent-tool" }> =>
        e.type === "subagent-tool" &&
        e.phase === "result" &&
        e.call.toolName === "write_file"
    );
    expect(writeResult?.call.isError).toBe(true);
    expect(writeResult?.call.output).toContain("拒绝");
    expect(existsSync(join(workspace, "secret.txt"))).toBe(false);

    // 委派本身放行（ask 不禁调研），子代理报告正常回流
    const delegation = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.call.toolName === "spawn_subagent"
    );
    expect(delegation?.call.isError).toBe(false);
    expect(delegation?.call.output).toContain("写入被用户拒绝");
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("子代理模型失败：失败原因回流为 isError 结果，主会话不崩并继续到最终回复", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    // 子模型直接抛 401（不可重试类错误）
    const subModel = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: "Incorrect API key provided",
          url: "https://api.example.com/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 401,
          responseBody: "Unauthorized",
        });
      },
    });
    const { session, persistence } = makeSubagentSession({
      workspacePath: workspace,
      main: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "d1",
              toolName: "spawn_subagent",
              input: { task: "查点资料" },
            },
          ],
        },
        { kind: "text", deltas: ["子代理失败了，我自己来"] },
      ],
      subModel,
    });

    const events = await collect(
      session.sendMessage({ text: "委派失败场景", profile })
    );

    // 失败以 isError 工具结果回流（中文原因），subagent-report 标记失败
    const delegation = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.call.toolName === "spawn_subagent"
    );
    expect(delegation?.call.isError).toBe(true);
    expect(delegation?.call.output).toContain("子代理执行失败");
    const report = events.find(
      (e): e is Extract<SessionEvent, { type: "subagent-report" }> =>
        e.type === "subagent-report"
    );
    expect(report?.ok).toBe(false);

    // 主会话不崩：正常收尾、无 error 事件、会话状态回 idle
    expect(events.at(-1)?.type).toBe("assistant-done");
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    const stored = persistence
      .listToolCalls("session-1")
      .find((c) => c.toolName === "spawn_subagent");
    expect(stored?.isError).toBe(true);
  });

  it("assist 传导：子代理的危险命令弹审批卡片，always 仅放行本次不写记忆（ADR 0004）", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const { session, persistence } = makeSubagentSession({
      workspacePath: workspace,
      approvalMode: "assist",
      main: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "d1",
              toolName: "spawn_subagent",
              input: { task: "跑一条命令" },
            },
          ],
        },
        { kind: "text", deltas: ["子代理执行完了"] },
      ],
      sub: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "sub-t",
              toolName: "run_terminal_command",
              // rm 首词命中危险黑名单：assist 档弹卡；目标不存在 → 执行报错（无害）
              input: { command: "rm codexlike-subagent-target" },
            },
          ],
        },
        { kind: "text", deltas: ["命令已执行（目标不存在，报错回填）"] },
      ],
    });

    const events: SessionEvent[] = [];
    const iterator = session
      .sendMessage({ text: "委派跑命令", profile })
      [Symbol.asyncIterator]();

    // 推进到子代理的审批请求（interaction-request 带 subagentId）
    let approvalRequest: Extract<
      SessionEvent,
      { type: "interaction-request" }
    > | null = null;
    for (
      let head = await iterator.next();
      !head.done;
      head = await iterator.next()
    ) {
      events.push(head.value);
      if (head.value.type === "interaction-request") {
        approvalRequest = head.value;
        break;
      }
    }
    expect(approvalRequest).not.toBeNull();
    if (
      approvalRequest!.interaction.request.kind !== "approval" ||
      approvalRequest!.interaction.request.source.kind !== "subagent"
    )
      throw new Error("预期子代理审批");
    expect(approvalRequest!.interaction.request.command).toContain(
      "rm codexlike-subagent-target"
    );

    // id 不匹配的响应返回 false；always 批准生效但不记忆（ADR 0004）
    expect(session.respondApproval("not-the-id", "approve")).toBe(false);
    expect(
      session.respondApproval(approvalRequest!.interaction.request.id, "always")
    ).toBe(true);

    // 消费剩余事件：审批卡片转结果态、命令真实执行、报告回流、主会话收尾
    for (
      let head = await iterator.next();
      !head.done;
      head = await iterator.next()
    ) {
      events.push(head.value);
    }
    expect(
      events.some(
        (e) =>
          e.type === "interaction-resolved" &&
          e.interaction.request.id === approvalRequest!.interaction.request.id
      )
    ).toBe(true);
    // 真实执行（目标不存在 → rm 报错回填）
    const commandResult = events.find(
      (e): e is Extract<SessionEvent, { type: "subagent-tool" }> =>
        e.type === "subagent-tool" &&
        e.phase === "result" &&
        e.call.toolName === "run_terminal_command"
    );
    expect(commandResult?.call.isError).toBe(true);
    expect(commandResult?.call.output).toContain("codexlike-subagent-target");

    // always 不再写「总是允许」记忆
    expect(persistence.listApprovals("session-1")).toEqual([]);
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("主会话中断：运行中的子代理随 AbortSignal 一并中止，主会话以中断态收尾", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    // 子模型先独立加载技能，再挂起；中断时须释放本轮资源与审批状态。
    // （模拟真实 provider 流对 abortSignal 的响应——MockLanguageModelV4 不会自动做）
    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let loaded = false;
    const subModel = new MockLanguageModelV4({
      doStream: async (options) => {
        if (!loaded) {
          loaded = true;
          return toolCallRound([
            {
              toolCallId: "before-abort",
              toolName: "load_skill",
              input: { name: "alpha" },
            },
          ]);
        }
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            async start(controller) {
              const onAbort = () =>
                controller.error(new DOMException("Aborted", "AbortError"));
              const signal = options.abortSignal;
              if (signal?.aborted) {
                onAbort();
                return;
              }
              signal?.addEventListener("abort", onAbort, { once: true });
              await gate;
              signal?.removeEventListener("abort", onAbort);
              controller.enqueue({ type: "text-start", id: "text-1" });
              controller.enqueue({
                type: "text-delta",
                id: "text-1",
                delta: "不应到达",
              });
              controller.enqueue({ type: "text-end", id: "text-1" });
              controller.enqueue({ type: "finish", ...finishPart() });
              controller.close();
            },
          }),
        };
      },
    });
    const { session } = makeSubagentSession({
      resources: () => fakeResourceSnapshot(),
      workspacePath: workspace,
      main: [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "d1",
              toolName: "spawn_subagent",
              input: { task: "长调研" },
            },
          ],
        },
        { kind: "text", deltas: ["汇总"] },
      ],
      subModel,
    });

    const controller = new AbortController();
    const events: SessionEvent[] = [];
    const iterator = session
      .sendMessage({
        text: "委派后中断",
        profile,
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();

    // 推进到子代理开跑
    for (
      let head = await iterator.next();
      !head.done;
      head = await iterator.next()
    ) {
      events.push(head.value);
      if (
        head.value.type === "subagent-tool" &&
        head.value.phase === "result" &&
        head.value.call.id === "before-abort"
      ) {
        break;
      }
    }
    expect(events.some((e) => e.type === "subagent-start")).toBe(true);
    expect(session.resourceState.active?.loaded).toHaveLength(1);

    // 中断主会话：子代理的模型流随 signal 以 AbortError 终止，事件流收尾不卡死
    controller.abort();
    for (
      let head = await iterator.next();
      !head.done;
      head = await iterator.next()
    ) {
      events.push(head.value);
    }

    const report = events.find(
      (e): e is Extract<SessionEvent, { type: "subagent-report" }> =>
        e.type === "subagent-report"
    );
    expect(report?.ok).toBe(false);
    const delegation = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.call.toolName === "spawn_subagent"
    );
    expect(delegation?.call.isError).toBe(true);
    // 主会话以中断态收尾（02 的语义），无 error
    expect(events.at(-1)?.type).toBe("assistant-aborted");
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
    expect(session.resourceState.active).toBeNull();
    expect(session.resourceState.last?.loaded).toHaveLength(1);
    expect(JSON.stringify(session.resourceState)).not.toContain(
      "ALPHA_PRIVATE_BODY"
    );
  });
});
