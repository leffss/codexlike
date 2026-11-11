import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";

import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteSessionStore } from "../../src/session/persistence";
import { createAgentSession } from "../../src/session/agent-session";
import type { ApprovalMode } from "../../src/session/approval";
import type { SessionEvent, SessionRecord } from "../../src/session/types";
import type { ToolDefinition } from "../../src/tools/types";
import { createMcpManager, type McpManager } from "../../src/mcp/manager";
import type { AgentResourceSnapshot } from "../../src/context/resource-types";
import { fakeResourceSnapshot } from "../session/resource-fixture";

const FIXTURE = join(__dirname, "fixtures", "fake-mcp-server.mjs");

const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  model: "glm-4.7",
};

const managers: McpManager[] = [];

afterAll(async () => {
  await Promise.all(managers.map((manager) => manager.close()));
});

/** 已连接 fake server 的 McpManager（发现 echo / slow_echo / crash） */
async function connectedFakeManager(): Promise<McpManager> {
  const manager = createMcpManager({
    servers: () => [
      {
        id: "srv-1",
        name: "fake",
        command: process.execPath,
        args: [FIXTURE],
        env: {},
      },
    ],
  });
  managers.push(manager);
  const state = await manager.connect("srv-1");
  expect(state.status).toBe("connected");
  return manager;
}

function sessionRecord(
  workspacePath: string,
  approvalMode: ApprovalMode
): SessionRecord {
  return {
    id: "session-1",
    title: "demo",
    workspacePath,
    providerProfileId: null,
    model: null,
    workspaceMode: "local",
    workspaceOriginPath: null,
    status: "idle",
    approvalMode,
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
      controller.enqueue({
        type: "finish",
        usage: usage(),
        finishReason: { unified: "stop" as const, raw: "stop" },
      });
      controller.close();
    },
  });
}

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
      controller.enqueue({
        type: "finish",
        usage: usage(),
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
      });
      controller.close();
    },
  });
}

type ScriptedStep =
  | { kind: "text"; deltas: string[] }
  | {
      kind: "tool";
      calls: { toolCallId: string; toolName: string; input: unknown }[];
    };

function scriptedModel(steps: ScriptedStep[]) {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(call++, steps.length - 1)]!;
      if (step.kind === "tool") {
        return { stream: toolCallRound(step.calls) };
      }
      return { stream: textRound(step.deltas) };
    },
  });
  return model;
}

function fakeClock() {
  let tick = 0;
  return () => `2026-11-11T08:00:${String(++tick).padStart(2, "0")}.000Z`;
}

function makeSession(
  model: MockLanguageModelV4,
  workspacePath: string,
  tools: ToolDefinition[] | (() => ToolDefinition[]),
  approvalMode: ApprovalMode = "assist",
  resources?: () => AgentResourceSnapshot
) {
  const persistence = createSqliteSessionStore(":memory:");
  const base = sessionRecord(workspacePath, approvalMode);
  persistence.insertSession(base);
  const session = createAgentSession({
    record: base,
    persistence,
    history: persistence.listMessages(base.id),
    languageModelFor: () => model,
    tools,
    resources,
    now: fakeClock(),
  });
  return { session, persistence, model };
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

/** 拉取事件流；interaction-request 到达时自动响应（模拟审批卡片三键） */
async function drive(
  session: ReturnType<typeof makeSession>["session"],
  text: string,
  decide: "approve" | "reject" | "always"
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const iterator = session
    .sendMessage({ text, profile })
    [Symbol.asyncIterator]();
  let head = await iterator.next();
  while (!head.done) {
    const event = head.value;
    events.push(event);
    if (event.type === "interaction-request") {
      session.respondApproval(event.interaction.request.id, decide);
    }
    head = await iterator.next();
  }
  return events;
}

describe("AgentSession 的 MCP 工具链路（工单 12）", () => {
  it("资源工具与 MCP 共存，加载技能不绕过 ask 审批且 MCP 下轮启停仍即时生效", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-mcp-resources-"));
    const manager = await connectedFakeManager();
    let enabled = true;
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "load",
            toolName: "load_skill",
            input: { name: "alpha" },
          },
        ],
      },
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "mcp",
            toolName: "mcp_fake_echo",
            input: { text: "资源与 MCP" },
          },
        ],
      },
      { kind: "text", deltas: ["完成"] },
      { kind: "text", deltas: ["下一轮"] },
    ]);
    const { session, persistence } = makeSession(
      model,
      workspace,
      () => (enabled ? manager.tools() : []),
      "ask",
      () => fakeResourceSnapshot()
    );
    const events = await drive(session, "先加载技能再调用 MCP", "approve");
    expect(
      events
        .filter((event) => event.type === "interaction-request")
        .map((event) =>
          event.interaction.request.kind === "approval"
            ? event.interaction.request.toolName
            : ""
        )
    ).toEqual(["mcp_fake_echo"]);
    expect(
      events.find(
        (event) => event.type === "tool-result" && event.call.id === "mcp"
      )
    ).toMatchObject({ call: { isError: false, output: "echo: 资源与 MCP" } });
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain(
      "ALPHA_PRIVATE_BODY"
    );
    expect(session.resourceState.last?.loaded).toHaveLength(1);
    enabled = false;
    await collect(session.sendMessage({ text: "下一轮", profile }));
    const toolNames = model.doStreamCalls[3]?.tools?.map((tool) => tool.name);
    expect(toolNames).toContain("load_skill");
    expect(toolNames).not.toContain("mcp_fake_echo");
    expect(JSON.stringify(model.doStreamCalls[3]?.prompt)).not.toContain(
      "ALPHA_PRIVATE_BODY"
    );
    persistence.close();
  });

  it("ask 模式：MCP 工具调用弹审批（工具名兜底 command）→ 批准 → 执行 → 结果回填下一轮", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-mcp-"));
    const manager = await connectedFakeManager();
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "mcp_fake_echo",
            input: { text: "你好 MCP" },
          },
        ],
      },
      { kind: "text", deltas: ["MCP 工具返回了：", "echo: 你好 MCP"] },
    ]);
    const { session } = makeSession(
      model,
      workspace,
      () => manager.tools(),
      "ask"
    );

    const events = await drive(session, "调用 MCP echo", "approve");

    const request = events.find(
      (e): e is Extract<SessionEvent, { type: "interaction-request" }> =>
        e.type === "interaction-request"
    );
    // MCP 工具参数无 command 字段 → 审批卡以工具名呈现（04 预留的回退语义）
    if (request?.interaction.request.kind !== "approval")
      throw new Error("预期审批请求");
    expect(request?.interaction.request.toolName).toBe("mcp_fake_echo");
    expect(request?.interaction.request.command).toBe("mcp_fake_echo");
    expect(request?.interaction.request.commandWord).toBe("mcp_fake_echo");

    const result = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(result?.call.toolName).toBe("mcp_fake_echo");
    expect(result?.call.isError).toBe(false);
    expect(result?.call.output).toBe("echo: 你好 MCP");

    // 结果回填：第二次 doStream 的 prompt 含工具输出（fake server 经 stdio 真实往返）
    const lastCall = model.doStreamCalls.at(-1);
    const toolMessage = lastCall?.prompt.find(
      (message) => message.role === "tool"
    );
    expect(JSON.stringify(toolMessage)).toContain("echo: 你好 MCP");

    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("assist 模式：MCP 工具（无 command 参数，非危险命令）自动放行不弹审批", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-mcp-"));
    const manager = await connectedFakeManager();
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "mcp_fake_echo",
            input: { text: "第一次" },
          },
        ],
      },
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c2",
            toolName: "mcp_fake_echo",
            input: { text: "第二次" },
          },
        ],
      },
      { kind: "text", deltas: ["完成"] },
    ]);
    const { session } = makeSession(
      model,
      workspace,
      () => manager.tools(),
      "assist"
    );

    const events = await collect(
      session.sendMessage({ text: "连续两次 echo", profile })
    );
    const requests = events.filter((e) => e.type === "interaction-request");
    const results = events.filter((e) => e.type === "tool-result");

    // 非危险命令自动放行：两次都不弹卡、都真实执行
    expect(requests).toHaveLength(0);
    expect(
      results.map((e) => (e as { call: { output: string } }).call.output)
    ).toEqual(["echo: 第一次", "echo: 第二次"]);
  });

  it("ask 模式 + always：仅放行本次不写记忆，同工具下一次调用仍询问（ADR 0004）", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-mcp-"));
    const manager = await connectedFakeManager();
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "mcp_fake_echo",
            input: { text: "第一次" },
          },
        ],
      },
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c2",
            toolName: "mcp_fake_echo",
            input: { text: "第二次" },
          },
        ],
      },
      { kind: "text", deltas: ["完成"] },
    ]);
    const { session, persistence } = makeSession(
      model,
      workspace,
      () => manager.tools(),
      "ask"
    );

    const events = await drive(session, "连续两次 echo", "always");
    const requests = events.filter((e) => e.type === "interaction-request");
    const results = events.filter((e) => e.type === "tool-result");

    // 「请求批准」始终询问：两次都弹卡；always 只放行本次，不写记忆
    expect(requests).toHaveLength(2);
    expect(
      results.map((e) => (e as { call: { output: string } }).call.output)
    ).toEqual(["echo: 第一次", "echo: 第二次"]);
    expect(persistence.listApprovals("session-1")).toEqual([]);
  });

  it("ask 模式拒绝：MCP 工具被拦截，拒绝原因回填，server 未被调用", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-mcp-"));
    const manager = await connectedFakeManager();
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          { toolCallId: "c1", toolName: "mcp_fake_echo", input: { text: "x" } },
        ],
      },
      { kind: "text", deltas: ["用户没批"] },
    ]);
    const { session } = makeSession(
      model,
      workspace,
      () => manager.tools(),
      "ask"
    );

    const events = await drive(session, "调用", "reject");

    const result = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(result?.call.isError).toBe(true);
    expect(result?.call.output).toContain("拒绝");
    expect(events.some((e) => e.type === "interaction-request")).toBe(true);
  });

  it("server 崩溃：错误作为工具结果返回模型，会话存活继续到最终回复", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-mcp-"));
    const manager = await connectedFakeManager();
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [{ toolCallId: "c1", toolName: "mcp_fake_crash", input: {} }],
      },
      { kind: "text", deltas: ["server 崩了，但会话还在"] },
    ]);
    const { session } = makeSession(
      model,
      workspace,
      () => manager.tools(),
      "full-access"
    );

    const events = await collect(
      session.sendMessage({ text: "触发崩溃", profile })
    );

    const result = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(result?.call.isError).toBe(true);
    expect(result?.call.output).toContain("mcp_fake_crash");
    // 不产生 error 事件（会话存活）、正常收尾
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("调用超时：超时错误回填模型，会话继续（不无限等待）", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-mcp-"));
    const manager = createMcpManager({
      servers: () => [
        {
          id: "srv-1",
          name: "fake",
          command: process.execPath,
          args: [FIXTURE],
          env: {},
        },
      ],
      callTimeoutMs: 300,
    });
    managers.push(manager);
    await manager.connect("srv-1");

    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "mcp_fake_slow_echo",
            input: { text: "慢", delayMs: 10_000 },
          },
        ],
      },
      { kind: "text", deltas: ["超时了但会话没死"] },
    ]);
    const { session } = makeSession(
      model,
      workspace,
      () => manager.tools(),
      "full-access"
    );

    const events = await collect(
      session.sendMessage({ text: "慢调用", profile })
    );
    const result = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(result?.call.isError).toBe(true);
    expect(result?.call.output).toContain("超时");
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("tools 支持工厂函数逐次解析：设置页启停 MCP 工具对后续会话消息即时生效", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-mcp-"));
    const manager = await connectedFakeManager();
    const disabled = new Set<string>();
    let gate: "on" | "off" = "on";
    const tools = () => {
      if (gate === "off") {
        disabled.add("mcp_fake_echo");
      } else {
        disabled.delete("mcp_fake_echo");
      }
      const all = manager.tools();
      return all.filter((tool) => !disabled.has(tool.name));
    };

    const model = scriptedModel([
      { kind: "text", deltas: ["第一轮正常"] },
      {
        kind: "tool",
        calls: [
          { toolCallId: "c1", toolName: "mcp_fake_echo", input: { text: "x" } },
        ],
      },
      { kind: "text", deltas: ["工具没了"] },
    ]);
    const { session } = makeSession(model, workspace, tools, "full-access");

    // 第一条消息：工具在（模型未调用，仅确认不炸）
    const first = await collect(
      session.sendMessage({ text: "第一轮", profile })
    );
    expect(first.at(-1)?.type).toBe("assistant-done");

    // 设置页禁用 echo → 第二条消息模型仍调它 → 「未注册」可读错误回填，会话不崩
    gate = "off";
    const second = await collect(
      session.sendMessage({ text: "第二轮", profile })
    );
    const result = second.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(result?.call.isError).toBe(true);
    expect(result?.call.output).toContain("mcp_fake_echo 未注册");
    expect(second.at(-1)?.type).toBe("assistant-done");
  });
});
