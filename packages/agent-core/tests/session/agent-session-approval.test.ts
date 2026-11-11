import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteSessionStore } from "../../src/session/persistence";
import { createAgentSession } from "../../src/session/agent-session";
import type { SessionEvent, SessionRecord } from "../../src/session/types";
import type { ApprovalMode } from "../../src/session/approval";
import { createBuiltinTools } from "../../src/tools/builtin";

const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  model: "glm-4.7",
};

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
    status: "idle",
    workspaceMode: "local",
    projectId: null,
    workspaceOriginPath: null,
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
      controller.enqueue({
        type: "finish",
        usage: usage(),
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
      });
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

function makeSession(
  model: MockLanguageModelV4,
  workspacePath: string,
  options?: { approvalMode?: ApprovalMode }
) {
  const persistence = createSqliteSessionStore(":memory:");
  const base = sessionRecord(workspacePath, options?.approvalMode ?? "assist");
  persistence.insertSession(base);
  const session = createAgentSession({
    record: base,
    persistence,
    history: persistence.listMessages(base.id),
    languageModelFor: () => model,
    tools: createBuiltinTools(),
    now: fakeClock(),
  });
  return { session, persistence };
}

/** 拉取事件流；收到 interaction-request 时以给定决定响应（模拟用户点审批卡片三键） */
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

describe("AgentSession 审批插点（请求批准 / 帮我批准 / 完全访问）", () => {
  it("ask 请求批准：写入与命令一律弹审批卡，批准后执行", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "write_file",
            input: { path: "a.txt", content: "经批准" },
          },
          {
            toolCallId: "c2",
            toolName: "run_terminal_command",
            input: { command: "echo ask > cmd.txt" },
          },
        ],
      },
      { kind: "text", deltas: ["都批准了"] },
    ]);
    const { session, persistence } = makeSession(model, workspace, {
      approvalMode: "ask",
    });

    const events = await drive(session, "写文件并跑命令", "approve");

    // 两个工具调用都弹了审批卡（「始终询问」），批准后真实执行
    const requests = events.filter(
      (e): e is Extract<SessionEvent, { type: "interaction-request" }> =>
        e.type === "interaction-request"
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.interaction.request).toMatchObject({
      toolCallId: "c1",
      toolName: "write_file",
      commandWord: "write_file",
    });
    expect(requests[1]?.interaction.request).toMatchObject({
      toolCallId: "c2",
      toolName: "run_terminal_command",
      command: "echo ask > cmd.txt",
      commandWord: "echo",
    });
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("经批准");
    expect(readFileSync(join(workspace, "cmd.txt"), "utf8")).toBe("ask\n");
    // 工具调用落库（时间线可见），无错误
    expect(persistence.listToolCalls("session-1")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("ask 请求批准：拒绝写入 → 拒绝结果回填模型，文件不落盘，会话正常继续", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "write_file",
            input: { path: "blocked.txt", content: "x" },
          },
        ],
      },
      { kind: "text", deltas: ["好的，我只读"] },
    ]);
    const { session, persistence } = makeSession(model, workspace, {
      approvalMode: "ask",
    });

    const events = await drive(session, "写个文件", "reject");

    const result = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(result?.call.isError).toBe(true);
    expect(result?.call.output).toContain("拒绝");
    expect(existsSync(join(workspace, "blocked.txt"))).toBe(false);
    // 拒绝原因进入第二轮模型上下文
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("拒绝");
    // 循环不崩：最终文本回复正常落库
    expect(events.at(-1)?.type).toBe("assistant-done");
    expect(persistence.listToolCalls("session-1")).toHaveLength(1);
  });

  it("assist 帮我批准：文件编辑自动应用（无审批请求）；危险命令（黑名单首词）弹审批，批准后执行", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "write_file",
            input: { path: "auto.txt", content: "自动" },
          },
        ],
      },
      {
        kind: "tool",
        // rm 首词命中危险黑名单：弹审批；目标不存在 → 执行报错（无害，验证真实执行）
        calls: [
          {
            toolCallId: "c2",
            toolName: "run_terminal_command",
            input: { command: "rm codexlike-nonexistent-target" },
          },
        ],
      },
      { kind: "text", deltas: ["完成"] },
    ]);
    const { session, persistence } = makeSession(model, workspace, {
      approvalMode: "assist",
    });

    const requests: Extract<
      SessionEvent,
      { type: "interaction-request" }
    >["interaction"]["request"][] = [];
    const statusesAtRequest: string[] = [];
    const events: SessionEvent[] = [];
    const iterator = session
      .sendMessage({ text: "写文件并删个东西", profile })
      [Symbol.asyncIterator]();
    let head = await iterator.next();
    while (!head.done) {
      const event = head.value;
      events.push(event);
      if (event.type === "interaction-request") {
        requests.push(event.interaction.request);
        // 等待审批期间：会话落库状态为 waiting-user（侧栏可见），pendingApproval 可查
        statusesAtRequest.push(persistence.listSessions()[0]!.status);
        expect(session.pendingApproval?.id).toBe(event.interaction.request.id);
        expect(
          session.respondApproval(event.interaction.request.id, "approve")
        ).toBe(true);
      }
      head = await iterator.next();
    }

    // 文件编辑自动应用；危险命令经审批后真实执行（rm 报错回填，目标本就不存在）
    expect(readFileSync(join(workspace, "auto.txt"), "utf8")).toBe("自动");
    const commandResult = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.call.id === "c2"
    );
    expect(commandResult?.call.isError).toBe(true);
    expect(commandResult?.call.output).toContain(
      "codexlike-nonexistent-target"
    );
    // 审批请求恰好一次（只来自危险命令，文件编辑不弹卡）
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      toolCallId: "c2",
      toolName: "run_terminal_command",
      command: "rm codexlike-nonexistent-target",
      commandWord: "rm",
    });
    expect(statusesAtRequest).toEqual(["waiting-user"]);
    // 事件序列：文件编辑无审批，危险命令 interaction-request → interaction-resolved 夹在中间
    expect(events.map((e) => e.type)).toEqual([
      "user-message",
      "assistant-start",
      "tool-call",
      "tool-result",
      "tool-call",
      "interaction-request",
      "interaction-resolved",
      "tool-result",
      "assistant-delta",
      "assistant-done",
    ]);
    // 审批结束后会话回到收尾状态 idle
    expect(persistence.listSessions()[0]!.status).toBe("idle");
    expect(session.pendingApproval).toBeNull();
  });

  it("assist 帮我批准：普通命令（非黑名单）直接执行，无审批请求", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "run_terminal_command",
            input: { command: "echo assist > mode.txt" },
          },
        ],
      },
      { kind: "text", deltas: ["自动放行"] },
    ]);
    const { session } = makeSession(model, workspace, {
      approvalMode: "assist",
    });

    const events: SessionEvent[] = [];
    for await (const event of session.sendMessage({
      text: "跑个命令",
      profile,
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "interaction-request")).toBe(false);
    expect(readFileSync(join(workspace, "mode.txt"), "utf8")).toBe("assist\n");
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("assist 帮我批准：拒绝危险命令 → 拒绝结果回填模型，会话正常继续到最终回复", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "run_terminal_command",
            input: { command: "rm -rf something" },
          },
        ],
      },
      { kind: "text", deltas: ["好的，我换个思路"] },
    ]);
    const { session, persistence } = makeSession(model, workspace, {
      approvalMode: "assist",
    });

    const events = await drive(session, "跑个危险命令", "reject");

    const result = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(result?.call.isError).toBe(true);
    expect(result?.call.output).toContain("拒绝");
    // 拒绝原因进入第二轮模型上下文
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("拒绝");
    // 循环不崩：最终文本回复正常落库
    expect(events.at(-1)?.type).toBe("assistant-done");
    expect(persistence.listToolCalls("session-1")).toHaveLength(1);
  });

  it("full-access 完全访问：终端命令直接执行，无审批请求", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "run_terminal_command",
            input: { command: "echo full-access > mode.txt" },
          },
        ],
      },
      { kind: "text", deltas: ["全自动完成"] },
    ]);
    const { session } = makeSession(model, workspace, {
      approvalMode: "full-access",
    });

    const events: SessionEvent[] = [];
    for await (const event of session.sendMessage({
      text: "全自动跑",
      profile,
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "interaction-request")).toBe(false);
    expect(readFileSync(join(workspace, "mode.txt"), "utf8")).toBe(
      "full-access\n"
    );
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("full-access（ADR 0004）：写入工作区外的本地文件成功；assist 档同路径被工作区边界拒绝", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "codexlike-out-"));
    const outsideFile = join(outside, "escaped.txt");

    // full-access：绝对路径写入工作区外成功（工作区边界放开）
    const fullModel = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "write_file",
            input: { path: outsideFile, content: "越界" },
          },
        ],
      },
      { kind: "text", deltas: ["写好了"] },
    ]);
    const { session: fullSession } = makeSession(fullModel, workspace, {
      approvalMode: "full-access",
    });
    const fullEvents = await drive(fullSession, "写到工作区外", "approve");
    expect(fullEvents.some((e) => e.type === "interaction-request")).toBe(
      false
    );
    expect(readFileSync(outsideFile, "utf8")).toBe("越界");

    // assist：同路径被 resolveInWorkspace 边界拒绝（isError 结果回填，文件不落盘）
    const assistModel = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "write_file",
            input: { path: outsideFile, content: "assist-越界" },
          },
        ],
      },
      { kind: "text", deltas: ["被边界拦了"] },
    ]);
    const { session: assistSession } = makeSession(assistModel, workspace, {
      approvalMode: "assist",
    });
    const assistEvents: SessionEvent[] = [];
    for await (const event of assistSession.sendMessage({
      text: "写工作区外",
      profile,
    })) {
      assistEvents.push(event);
    }
    const blockedResult = assistEvents.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(blockedResult?.call.isError).toBe(true);
    expect(blockedResult?.call.output).toContain("越界");
    // assist 档内容未覆盖 full-access 写入的文件
    expect(readFileSync(outsideFile, "utf8")).toBe("越界");
  });

  it("「本会话总是允许」不再写记忆（ADR 0004）：ask 档同首词命令每次都询问", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "run_terminal_command",
            input: { command: "echo one > first.txt" },
          },
        ],
      },
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c2",
            toolName: "run_terminal_command",
            input: { command: "echo two > second.txt" },
          },
        ],
      },
      { kind: "text", deltas: ["两次都批准了"] },
    ]);
    const { session, persistence } = makeSession(model, workspace, {
      approvalMode: "ask",
    });

    const events = await drive(session, "跑两条 echo", "always");

    // always 仅放行本次（「始终询问」）：两条命令各自弹一次审批卡
    const requests = events.filter((e) => e.type === "interaction-request");
    expect(requests).toHaveLength(2);
    expect(readFileSync(join(workspace, "first.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(workspace, "second.txt"), "utf8")).toBe("two\n");
    // 不再写「总是允许」记忆
    expect(persistence.listApprovals("session-1")).toEqual([]);
  });

  it("中途切换模式：ask 下被拒绝的工具，切到 full-access 后下一次调用立即放行", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "write_file",
            input: { path: "x.txt", content: "第一次" },
          },
        ],
      },
      { kind: "text", deltas: ["被拒了"] },
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c2",
            toolName: "write_file",
            input: { path: "x.txt", content: "第二次" },
          },
        ],
      },
      { kind: "text", deltas: ["这次成功了"] },
    ]);
    const { session } = makeSession(model, workspace, { approvalMode: "ask" });

    const first = await drive(session, "写入", "reject");
    const firstResult = first.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(firstResult?.call.isError).toBe(true);
    expect(existsSync(join(workspace, "x.txt"))).toBe(false);

    // 会话中途切换（不重启、不重建对象）：对下一次工具调用立即生效
    session.setApprovalMode("full-access");
    expect(session.record.approvalMode).toBe("full-access");

    const second: SessionEvent[] = [];
    for await (const event of session.sendMessage({
      text: "再试一次",
      profile,
    })) {
      second.push(event);
    }
    const secondResult = second.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(secondResult?.call.isError).toBe(false);
    expect(readFileSync(join(workspace, "x.txt"), "utf8")).toBe("第二次");
  });

  it("respondApproval：无等待请求或 id 不匹配时返回 false；同一请求重复响应也拒绝", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "run_terminal_command",
            input: { command: "rm codexlike-nonexistent-target" },
          },
        ],
      },
      { kind: "text", deltas: ["done"] },
    ]);
    const { session, persistence } = makeSession(model, workspace, {
      approvalMode: "assist",
    });

    // 无等待请求时
    expect(session.respondApproval("c1", "approve")).toBe(false);
    expect(session.respondApproval("别的id", "approve")).toBe(false);

    const events: SessionEvent[] = [];
    const iterator = session
      .sendMessage({ text: "跑命令", profile })
      [Symbol.asyncIterator]();
    let head = await iterator.next();
    while (!head.done) {
      events.push(head.value);
      if (head.value.type === "interaction-request") {
        const request = head.value.interaction.request;
        // id 不匹配
        expect(session.respondApproval("not-the-id", "approve")).toBe(false);
        // 第一次响应成功，重复响应失败
        expect(session.respondApproval(request.id, "approve")).toBe(true);
        expect(session.respondApproval(request.id, "approve")).toBe(false);
      }
      head = await iterator.next();
    }
    // 批准后真实执行（目标不存在 → rm 报错回填，不卡审批等待）
    const result = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(result?.call.isError).toBe(true);
    expect(result?.call.output).toContain("codexlike-nonexistent-target");
    expect(persistence.listToolCalls("session-1")).toHaveLength(1);
  });

  it("等待审批期间会话被中断（signal abort）：视为拒绝，生成器不卡死", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "run_terminal_command",
            input: { command: "echo never > no.txt" },
          },
        ],
      },
      { kind: "text", deltas: ["中断后的回复"] },
    ]);
    const { session } = makeSession(model, workspace, { approvalMode: "ask" });

    const controller = new AbortController();
    const iterator = session
      .sendMessage({ text: "跑命令", profile, signal: controller.signal })
      [Symbol.asyncIterator]();
    let head = await iterator.next();
    while (!head.done && head.value.type !== "interaction-request") {
      head = await iterator.next();
    }
    expect(head.done).toBe(false);

    // 等待审批时中断：生成器应以拒绝结果收尾，不永久挂起
    controller.abort();
    const events: SessionEvent[] = [];
    let tail = await iterator.next();
    const timeout = Symbol("timeout");
    const raced = await Promise.race([
      (async () => {
        while (!tail.done) {
          events.push(tail.value);
          tail = await iterator.next();
        }
        return "done" as const;
      })(),
      new Promise<typeof timeout>((resolve) =>
        setTimeout(() => resolve(timeout), 3000)
      ),
    ]);
    expect(raced).toBe("done");
    expect(existsSync(join(workspace, "no.txt"))).toBe(false);
  });
});
