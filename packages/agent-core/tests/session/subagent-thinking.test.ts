import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  createLanguageModelFromProfile,
  type CreateLanguageModelOptions,
  type ThinkingEffort,
} from "../../src/provider/language-model";
import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteSessionStore } from "../../src/session/persistence";
import { createAgentSession } from "../../src/session/agent-session";
import type { SessionEvent, SessionRecord } from "../../src/session/types";
import { createBuiltinTools } from "../../src/tools/builtin";

/** 主会话 Profile（sendMessage 携带；「同主模型」回退路径用到） */
const profile: ProviderProfile = {
  id: "main-profile",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  model: "glm-4.7",
};

/** 子代理独立 Profile（设置页「子代理模型」引用） */
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
    status: "idle",
    workspaceMode: "local",
    projectId: null,
    workspaceOriginPath: null,
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

/** 文本轮流式（ai v7：text-start/delta/end 包裹） */
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

/** 工具调用轮流式 */
function toolCallRound(
  toolCalls: { toolCallId: string; toolName: string; input: unknown }[]
) {
  return new ReadableStream<LanguageModelV4StreamPart>({
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
}

/** 思考 + 工具调用轮流式（子代理模型先思考再调工具） */
function reasoningToolCallRound(
  reasoning: string[],
  toolCalls: { toolCallId: string; toolName: string; input: unknown }[]
) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({ type: "reasoning-start", id: "rs-1" });
      for (const delta of reasoning) {
        controller.enqueue({ type: "reasoning-delta", id: "rs-1", delta });
      }
      controller.enqueue({ type: "reasoning-end", id: "rs-1" });
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
}

/** 思考 + 文本轮流式 */
function reasoningTextRound(
  reasoning: string[],
  text: string[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "reasoning-start", id: "rs-1" });
      for (const delta of reasoning) {
        controller.enqueue({ type: "reasoning-delta", id: "rs-1", delta });
      }
      controller.enqueue({ type: "reasoning-end", id: "rs-1" });
      controller.enqueue({ type: "text-start", id: "text-1" });
      for (const delta of text) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta });
      }
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({ type: "finish", ...finishPart() });
      controller.close();
    },
  });
}

type ScriptedStep =
  | { kind: "text"; deltas: string[] }
  | {
      kind: "tool";
      calls: { toolCallId: string; toolName: string; input: unknown }[];
    }
  | {
      kind: "reasoning-text";
      reasoning: string[];
      text: string[];
    }
  | {
      kind: "reasoning-tool";
      reasoning: string[];
      calls: { toolCallId: string; toolName: string; input: unknown }[];
    };

/** 受控脚本模型：逐次消费 steps；可选记录每次 doStream 的 prompt */
function scriptedModel(
  steps: ScriptedStep[],
  prompts?: unknown[]
): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts?.push(prompt);
      const step = steps[Math.min(call++, steps.length - 1)]!;
      if (step.kind === "tool") {
        return { stream: toolCallRound(step.calls) };
      }
      if (step.kind === "reasoning-text") {
        return { stream: reasoningTextRound(step.reasoning, step.text) };
      }
      if (step.kind === "reasoning-tool") {
        return { stream: reasoningToolCallRound(step.reasoning, step.calls) };
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

/** 模型工厂调用记录（主/子共用同一记录表，按 profile.id 区分） */
interface FactoryCall {
  profile: ProviderProfile;
  options: CreateLanguageModelOptions | undefined;
}

interface SubagentThinkingHarnessOptions {
  workspacePath: string;
  main: ScriptedStep[];
  sub?: ScriptedStep[];
  subModel?: MockLanguageModelV4;
  /** 子代理 Profile 解析（缺省固定返回独立 subProfile；null = 回退主模型） */
  resolveProfile?: () => Promise<ProviderProfile | null>;
  maxConcurrent?: number;
  thinkingEffort?: ThinkingEffort;
}

/**
 * 装配带子代理的会话并记录两级模型工厂调用：
 * 主会话与子代理的 languageModelFor 均为 (profile, options) 双参签名，
 * 子代理的档位继承链 = 主会话工具上下文 → 编排器快照 → 子代理模型工厂。
 */
function makeSubagentThinkingSession(
  options: SubagentThinkingHarnessOptions,
  factoryCalls?: FactoryCall[]
) {
  const mainModel = scriptedModel(options.main);
  const subModel =
    options.subModel ??
    scriptedModel(
      options.sub ?? [{ kind: "text", deltas: ["子代理默认报告"] }]
    );
  const persistence = createSqliteSessionStore(":memory:");
  const record = sessionRecord(options.workspacePath);
  persistence.insertSession(record);
  const factory = (
    modelProfile: ProviderProfile,
    factoryOptions: CreateLanguageModelOptions | undefined
  ) => {
    factoryCalls?.push({ profile: modelProfile, options: factoryOptions });
    return modelProfile.id === subProfile.id ? subModel : mainModel;
  };
  const session = createAgentSession({
    record,
    persistence,
    languageModelFor: factory,
    tools: createBuiltinTools(),
    subagents: {
      tools: createBuiltinTools(),
      languageModelFor: factory,
      settings: () => ({ maxConcurrent: options.maxConcurrent ?? 3 }),
      resolveProfile: options.resolveProfile ?? (async () => subProfile),
    },
    now: fakeClock(),
  });
  return { session, persistence, mainModel, subModel };
}

/** 主会话脚本：一轮 spawn_subagent 委派 → 一轮汇总文本 */
function delegateThenSummarize(task: string): ScriptedStep[] {
  return [
    {
      kind: "tool",
      calls: [
        {
          toolCallId: "delegate-1",
          toolName: "spawn_subagent",
          input: { task },
        },
      ],
    },
    { kind: "text", deltas: ["委派结果已收到"] },
  ];
}

describe("子代理思考档位快照继承（spec「子代理继承触发消息的档位」）", () => {
  it("独立 Profile 路径：子代理模型工厂收到触发消息的档位快照", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const factoryCalls: FactoryCall[] = [];
    const { session } = makeSubagentThinkingSession(
      {
        workspacePath: workspace,
        main: delegateThenSummarize("调研测试框架"),
        sub: [{ kind: "text", deltas: ["调研报告"] }],
      },
      factoryCalls
    );

    await collect(
      session.sendMessage({
        text: "帮我调研",
        profile,
        thinkingEffort: "high",
      })
    );

    // 主会话两轮 + 子代理一轮；子代理调用必须用独立 Profile + 继承档位
    const subCalls = factoryCalls.filter(
      (call) => call.profile.id === subProfile.id
    );
    expect(subCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of subCalls) {
      expect(call.options?.thinkingEffort).toBe("high");
    }
    const mainCalls = factoryCalls.filter(
      (call) => call.profile.id === profile.id
    );
    expect(mainCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of mainCalls) {
      expect(call.options?.thinkingEffort).toBe("high");
    }
  });

  it("回退主模型路径（子代理 Profile = null）：子代理沿用主会话 Profile 且继承档位", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const factoryCalls: FactoryCall[] = [];
    const { session } = makeSubagentThinkingSession(
      {
        workspacePath: workspace,
        main: delegateThenSummarize("调研测试框架"),
        sub: [{ kind: "text", deltas: ["调研报告"] }],
        resolveProfile: async () => null,
      },
      factoryCalls
    );

    await collect(
      session.sendMessage({
        text: "帮我调研",
        profile,
        thinkingEffort: "low",
      })
    );

    // 回退路径：全部工厂调用都是主 Profile；子代理一轮也带同一档位
    expect(factoryCalls.every((call) => call.profile.id === profile.id)).toBe(
      true
    );
    expect(factoryCalls.length).toBe(3);
    expect(factoryCalls.map((call) => call.options?.thinkingEffort)).toEqual([
      "low",
      "low",
      "low",
    ]);
  });

  it("排队快照：并发上限 1 时第二个委派出队启动，仍用触发消息的档位", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const factoryCalls: FactoryCall[] = [];
    const { session } = makeSubagentThinkingSession(
      {
        workspacePath: workspace,
        maxConcurrent: 1,
        main: [
          {
            kind: "tool",
            calls: [1, 2].map((n) => ({
              toolCallId: `delegate-${n}`,
              toolName: "spawn_subagent",
              input: { task: `任务 ${n}` },
            })),
          },
          { kind: "text", deltas: ["两份报告都收到"] },
        ],
        sub: [{ kind: "text", deltas: ["报告"] }],
      },
      factoryCalls
    );

    const events = await collect(
      session.sendMessage({
        text: "并行调研两件事",
        profile,
        thinkingEffort: "medium",
      })
    );

    // FIFO：两个子代理先后运行（subagent-start 两个，第一个 report 后第二个才 start）
    const startEvents = events.filter(
      (event) => event.type === "subagent-start"
    );
    expect(startEvents).toHaveLength(2);
    const reportEvents = events.filter(
      (event) => event.type === "subagent-report"
    );
    expect(reportEvents).toHaveLength(2);
    // 出队启动的第二个子代理同样用入队时的档位快照
    const subCalls = factoryCalls.filter(
      (call) => call.profile.id === subProfile.id
    );
    expect(subCalls).toHaveLength(2);
    expect(
      subCalls.every((call) => call.options?.thinkingEffort === "medium")
    ).toBe(true);
  });

  it("未传档位：子代理与主会话一样按 auto 处理（既有调用方不受影响）", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const factoryCalls: FactoryCall[] = [];
    const { session } = makeSubagentThinkingSession(
      {
        workspacePath: workspace,
        main: delegateThenSummarize("调研测试框架"),
        sub: [{ kind: "text", deltas: ["调研报告"] }],
      },
      factoryCalls
    );

    await collect(session.sendMessage({ text: "帮我调研", profile }));

    expect(factoryCalls.length).toBe(3);
    expect(
      factoryCalls.every((call) => call.options?.thinkingEffort === "auto")
    ).toBe(true);
  });
});

describe("子代理 reasoning 流（fullStream → subagent-reasoning 事件）", () => {
  it("子代理思考转为 subagent-reasoning 事件：带 subagentId、与主会话 reasoning 及正文分离", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const { session } = makeSubagentThinkingSession({
      workspacePath: workspace,
      main: [
        {
          kind: "reasoning-tool",
          reasoning: ["主会话自己的思考"],
          calls: [
            {
              toolCallId: "delegate-1",
              toolName: "spawn_subagent",
              input: { task: "调研测试框架" },
            },
          ],
        },
        { kind: "text", deltas: ["委派结果已收到"] },
      ],
      sub: [
        {
          kind: "reasoning-text",
          reasoning: ["子代理先想想", "再核对一下"],
          text: ["调研报告正文"],
        },
      ],
    });

    const events = await collect(
      session.sendMessage({ text: "帮我调研", profile, thinkingEffort: "high" })
    );

    // 子代理 reasoning：独立事件类型、增量有序、subagentId 正确
    const subReasoning = events.filter(
      (event): event is Extract<SessionEvent, { type: "subagent-reasoning" }> =>
        event.type === "subagent-reasoning"
    );
    expect(subReasoning.map((event) => event.delta)).toEqual([
      "子代理先想想",
      "再核对一下",
    ]);
    const started = events.find((event) => event.type === "subagent-start");
    for (const event of subReasoning) {
      expect(event.subagentId).toBe(
        started?.type === "subagent-start" ? started.subagentId : undefined
      );
    }
    // 主会话自己的 reasoning 仍在 assistant-reasoning（互不串流）
    const mainReasoning = events.filter(
      (event) => event.type === "assistant-reasoning"
    );
    expect(mainReasoning.map((event) => event.delta)).toEqual([
      "主会话自己的思考",
    ]);

    // 报告正文不含思考；子代理报告回流正常
    const report = events.find(
      (event): event is Extract<SessionEvent, { type: "subagent-report" }> =>
        event.type === "subagent-report"
    );
    expect(report?.report).toBe("调研报告正文");
    expect(report?.ok).toBe(true);
    const delegation = events.find(
      (event): event is Extract<SessionEvent, { type: "tool-result" }> =>
        event.type === "tool-result" && event.call.toolName === "spawn_subagent"
    );
    expect(delegation?.call.output).toBe("调研报告正文");
    // 主会话 assistant 正文与落库消息均不含子代理思考
    expect(
      events
        .filter((event) => event.type === "assistant-delta")
        .every((event) => !event.delta.includes("子代理先想想"))
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("并发子代理的 reasoning 互不串流：各 subagentId 只收到自己的增量", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const { session } = makeSubagentThinkingSession({
      workspacePath: workspace,
      main: [
        {
          kind: "tool",
          calls: [1, 2].map((n) => ({
            toolCallId: `delegate-${n}`,
            toolName: "spawn_subagent",
            input: { task: `任务 ${n}` },
          })),
        },
        { kind: "text", deltas: ["两份报告都收到"] },
      ],
      // 受控子模型：交替输出两个子代理的 reasoning（并发流交错），
      // 每个 doStream 按调用次序输出对应编号的思考与报告
      subModel: (() => {
        let call = 0;
        return new MockLanguageModelV4({
          doStream: async () => {
            const index = call++;
            return {
              stream: reasoningTextRound(
                [`子代理${index}的思考`],
                [`子代理${index}的报告`]
              ),
            };
          },
        });
      })(),
    });

    const events = await collect(
      session.sendMessage({ text: "并行调研", profile })
    );

    const reasoning = events.filter(
      (event): event is Extract<SessionEvent, { type: "subagent-reasoning" }> =>
        event.type === "subagent-reasoning"
    );
    expect(reasoning).toHaveLength(2);
    const reports = events.filter(
      (event): event is Extract<SessionEvent, { type: "subagent-report" }> =>
        event.type === "subagent-report"
    );
    // 每个思考增量的 subagentId 与其报告内容中的编号一一对应（同一次 doStream）
    const reportById = new Map(reports.map((r) => [r.subagentId, r.report]));
    for (const event of reasoning) {
      const report = reportById.get(event.subagentId);
      const marker = event.delta.replace("的思考", "");
      expect(report?.includes(marker)).toBe(true);
    }
    // 两个子代理的思考各不相同（未互相覆盖或串流）
    expect(new Set(reasoning.map((event) => event.delta)).size).toBe(2);
  });

  it("思考随 spawn_subagent 记录落库（票 02）：报告与思考分离、消息表不含思考", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const { session, persistence } = makeSubagentThinkingSession({
      workspacePath: workspace,
      main: delegateThenSummarize("调研测试框架"),
      sub: [
        {
          kind: "reasoning-text",
          reasoning: ["子代理的思考全文", "（第二段）"],
          text: ["调研报告"],
        },
      ],
    });

    await collect(
      session.sendMessage({ text: "帮我调研", profile, thinkingEffort: "high" })
    );

    const calls = persistence.listToolCalls("session-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("spawn_subagent");
    // 报告（output）与思考（reasoning）分离；思考全文多段拼接
    expect(calls[0]?.output).toBe("调研报告");
    expect(calls[0]?.reasoning).toBe("子代理的思考全文（第二段）");
    // 消息表不含子代理思考（主会话 assistant 正文不混入）
    const messagesJson = JSON.stringify(persistence.listMessages("session-1"));
    expect(messagesJson).not.toContain("子代理的思考全文");
  });

  it("主会话中断联动取消：只有思考尚无正文的子代理也能终止，已流出 reasoning 保留且收敛", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    // 挂起子模型：先流出一段思考，随后挂起；abort 到达时以 AbortError 终止
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const subModel = new MockLanguageModelV4({
      doStream: async (options) => ({
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
            controller.enqueue({ type: "reasoning-start", id: "rs-1" });
            controller.enqueue({
              type: "reasoning-delta",
              id: "rs-1",
              delta: "中断前的子代理思考",
            });
            controller.enqueue({ type: "reasoning-end", id: "rs-1" });
            await gate;
            signal?.removeEventListener("abort", onAbort);
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({
              type: "text-delta",
              id: "text-1",
              delta: "不应到达的报告",
            });
            controller.enqueue({ type: "text-end", id: "text-1" });
            controller.enqueue({ type: "finish", ...finishPart() });
            controller.close();
          },
        }),
      }),
    });
    const { session } = makeSubagentThinkingSession({
      workspacePath: workspace,
      main: delegateThenSummarize("长调研"),
      subModel,
    });

    const controller = new AbortController();
    const events: SessionEvent[] = [];
    const iterator = session
      .sendMessage({
        text: "委派后中断",
        profile,
        thinkingEffort: "high",
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();

    // 推进到子代理思考已流出
    for (
      let head = await iterator.next();
      !head.done;
      head = await iterator.next()
    ) {
      events.push(head.value);
      if (head.value.type === "subagent-reasoning") {
        break;
      }
    }
    controller.abort();
    for (
      let head = await iterator.next();
      !head.done;
      head = await iterator.next()
    ) {
      events.push(head.value);
    }
    releaseGate();

    // 已流出的思考保留；子代理以失败报告收敛（无正文 → 未产出报告原因）
    const reasoning = events.filter(
      (event) => event.type === "subagent-reasoning"
    );
    expect(reasoning.map((event) => event.delta)).toEqual([
      "中断前的子代理思考",
    ]);
    const report = events.find(
      (event): event is Extract<SessionEvent, { type: "subagent-report" }> =>
        event.type === "subagent-report"
    );
    expect(report?.ok).toBe(false);
    expect(report?.report).not.toContain("不应到达的报告");
    // 主会话以中断态收尾，不残留挂起
    expect(events.at(-1)?.type).toBe("assistant-aborted");
  });
});

describe("子代理入口 → 真实 provider 工厂（fetch 替身全链路）", () => {
  it("子代理思考不回传：工具轮回填后的第二个子代理请求 body 不含 reasoning_content", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    writeFileSync(join(workspace, "note.txt"), "子代理思考测试预置内容");

    const seenBodies: string[] = [];
    /** 按请求序号分流：主会话委派 → 子代理思考+工具 → 子代理收尾 → 主会话汇总 */
    const fetchSpy = async (
      _input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      seenBodies.push(String(init?.body));
      const index = seenBodies.length;
      const framesFor = (chunks: Record<string, unknown>[], finish: string) => {
        const frames = [
          ...chunks.map((delta) => ({
            id: "chatcmpl-sub-thinking",
            object: "chat.completion.chunk",
            created: 0,
            model: "sub-model",
            choices: [{ index: 0, delta, finish_reason: null }],
          })),
          {
            id: "chatcmpl-sub-thinking",
            object: "chat.completion.chunk",
            created: 0,
            model: "sub-model",
            choices: [{ index: 0, delta: {}, finish_reason: finish }],
          },
        ];
        return new Response(
          frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } }
        );
      };
      if (index === 1) {
        // 主会话第一轮：委派
        return framesFor(
          [
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call-delegate",
                  type: "function",
                  function: {
                    name: "spawn_subagent",
                    arguments: '{"task":"读 note.txt 并总结"}',
                  },
                },
              ],
            },
          ],
          "tool_calls"
        );
      }
      if (index === 2) {
        // 子代理第一轮：思考 + 工具调用
        return framesFor(
          [
            { reasoning_content: "子代理真实端点思考ABC" },
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call-sub-read",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"note.txt"}',
                  },
                },
              ],
            },
          ],
          "tool_calls"
        );
      }
      if (index === 3) {
        // 子代理第二轮（工具结果回填）：正文报告
        return framesFor([{ content: "子代理最终报告" }], "stop");
      }
      // 主会话第二轮：汇总
      return framesFor([{ content: "收到报告" }], "stop");
    };

    const persistence = createSqliteSessionStore(":memory:");
    const record = sessionRecord(workspace);
    persistence.insertSession(record);
    const realFactory = (
      modelProfile: ProviderProfile,
      factoryOptions: CreateLanguageModelOptions
    ) =>
      createLanguageModelFromProfile(modelProfile, {
        ...factoryOptions,
        fetch: fetchSpy,
      });
    const session = createAgentSession({
      record,
      persistence,
      languageModelFor: realFactory,
      tools: createBuiltinTools(),
      subagents: {
        tools: createBuiltinTools(),
        languageModelFor: realFactory,
        settings: () => ({ maxConcurrent: 3 }),
        resolveProfile: async () => subProfile,
      },
      now: fakeClock(),
    });

    const events = await collect(
      session.sendMessage({
        text: "委派读文件",
        profile,
        thinkingEffort: "high",
      })
    );

    expect(events.at(-1)?.type).toBe("assistant-done");
    // 子代理思考作为独立事件流出
    expect(
      events
        .filter((event) => event.type === "subagent-reasoning")
        .map((event) => event.delta)
    ).toEqual(["子代理真实端点思考ABC"]);
    // 第 3 个请求 = 子代理第二轮：不回传思考（transformParams 剥离），
    // 工具结果（note.txt 内容）正常回填
    const subSecondRound = seenBodies[2]!;
    expect(subSecondRound).not.toContain("子代理真实端点思考ABC");
    expect(subSecondRound.includes("reasoning_content")).toBe(false);
    expect(subSecondRound).toContain("子代理思考测试预置内容");
    // 子代理全部请求都带档位（独立 Profile + high 继承）
    const subFirstRound = JSON.parse(seenBodies[1]!);
    expect(subFirstRound.thinking).toEqual({ type: "enabled" });
    expect(subFirstRound.reasoning_effort).toBe("high");
    const subSecondParsed = JSON.parse(subSecondRound);
    expect(subSecondParsed.reasoning_effort).toBe("high");
    // 报告回流与最终正文不含思考
    const delegation = events.find(
      (event): event is Extract<SessionEvent, { type: "tool-result" }> =>
        event.type === "tool-result" && event.call.toolName === "spawn_subagent"
    );
    expect(delegation?.call.output).toBe("子代理最终报告");
    expect(JSON.stringify(persistence.listMessages("session-1"))).not.toContain(
      "子代理真实端点思考ABC"
    );
  });
});
