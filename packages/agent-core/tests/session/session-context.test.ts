import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteSessionStore } from "../../src/session/persistence";
import { createAgentSession } from "../../src/session/agent-session";
import type { SessionRecord } from "../../src/session/types";

/** 工单 07：AGENTS.md → 系统提示、@引用 → 该条消息的模型上下文 */
const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  model: "glm-4.7",
};

function sessionRecord(): SessionRecord {
  return {
    id: "session-1",
    title: "demo",
    workspacePath: "C:\\work\\demo",
    providerProfileId: null,
    model: null,
    status: "idle",
    workspaceMode: "local",
    workspaceOriginPath: null,
    approvalMode: "assist",
    archivedAt: null,
    createdAt: "2026-11-10T08:00:00.000Z",
    updatedAt: "2026-11-10T08:00:00.000Z",
  };
}

function textStream(text: string): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "text-1" });
      controller.enqueue({ type: "text-delta", id: "text-1", delta: text });
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({
        type: "finish",
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 2, text: undefined, reasoning: undefined },
        },
        finishReason: { unified: "stop" as const, raw: "stop" },
      });
      controller.close();
    },
  });
}

function scriptedModel(responses: string[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const text = responses[Math.min(call++, responses.length - 1)]!;
      return { stream: textStream(text) };
    },
  });
}

function fakeClock() {
  let tick = 0;
  return () => `2026-11-10T08:00:${String(++tick).padStart(2, "0")}.000Z`;
}

describe("AgentSession 上下文注入（系统提示与 @引用）", () => {
  it("systemPrompt 进入模型请求的 system 角色", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const record = sessionRecord();
    persistence.insertSession(record);
    const model = scriptedModel(["收到"]);
    const session = createAgentSession({
      record,
      persistence,
      systemPrompt: "# 用户与项目规范（AGENTS.md）\n\n回答保持简洁。",
      languageModelFor: () => model,
      now: fakeClock(),
    });

    for await (const _event of session.sendMessage({ text: "你好", profile })) {
      // 消费完事件流
    }

    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("回答保持简洁");
  });

  it("未配置 systemPrompt 时不注入 system 角色（保持工单 02 行为）", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const record = sessionRecord();
    persistence.insertSession(record);
    const model = scriptedModel(["收到"]);
    const session = createAgentSession({
      record,
      persistence,
      languageModelFor: () => model,
      now: fakeClock(),
    });

    for await (const _event of session.sendMessage({ text: "你好", profile })) {
      // 消费完事件流
    }

    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).not.toContain("回答保持简洁");
  });

  it("@引用 文件内容附加进该条消息的模型上下文（XML 标签 + 路径标注）", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const record = sessionRecord();
    persistence.insertSession(record);
    const model = scriptedModel(["收到"]);
    const session = createAgentSession({
      record,
      persistence,
      languageModelFor: () => model,
      now: fakeClock(),
    });

    const events = [];
    for await (const event of session.sendMessage({
      text: "看看 @src/a.ts 和 @docs/b.md",
      profile,
      mentions: [
        { path: "src/a.ts", content: "export const a = 1;" },
        { path: "docs/b.md", content: "# 使用说明" },
      ],
    })) {
      events.push(event);
    }

    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    // 用户原文与两个文件内容、路径标注都在模型上下文中
    expect(prompt).toContain("看看 @src/a.ts 和 @docs/b.md");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("export const a = 1;");
    expect(prompt).toContain("docs/b.md");
    expect(prompt).toContain("# 使用说明");
    expect(prompt).toContain("attached-file");

    // 落库与 user-message 事件保持用户原文（消息流回显不含文件内容）
    const userEvent = events.find((event) => event.type === "user-message");
    expect(userEvent).toMatchObject({
      message: { content: "看看 @src/a.ts 和 @docs/b.md" },
    });
    expect(
      persistence
        .listMessages("session-1")
        .map((message) => [message.role, message.content])
    ).toEqual([
      ["user", "看看 @src/a.ts 和 @docs/b.md"],
      ["assistant", "收到"],
    ]);
  });

  it("多轮会话中 @引用 只附加在所属那条消息上", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const record = sessionRecord();
    persistence.insertSession(record);
    const model = scriptedModel(["第一轮", "第二轮"]);
    const session = createAgentSession({
      record,
      persistence,
      languageModelFor: () => model,
      now: fakeClock(),
    });

    for await (const _event of session.sendMessage({
      text: "读这个 @x.txt",
      profile,
      mentions: [{ path: "x.txt", content: "被引用的内容" }],
    })) {
      // 消费
    }
    for await (const _event of session.sendMessage({
      text: "第二条没有引用",
      profile,
    })) {
      // 消费
    }

    const first = JSON.stringify(model.doStreamCalls[0]?.prompt);
    const second = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(first).toContain("被引用的内容");
    // 第二条消息：历史中的第一条 user 消息仍带引用内容（属于那条消息），新消息不带
    expect(second).toContain("被引用的内容");
    expect(second.indexOf("被引用的内容")).toBeLessThan(
      second.indexOf("第二条没有引用")
    );
  });
});
