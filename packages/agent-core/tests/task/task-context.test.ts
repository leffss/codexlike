import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteSessionStore } from "../../src/task/persistence";
import { createAgentSession } from "../../src/task/agent-task";
import type { SessionRecord } from "../../src/task/types";
import { createSessionManager } from "../../src/task/manager";
import { fakeResourceSnapshot } from "./resource-fixture";

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
    projectId: null,
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
  it("缓存会话每条消息刷新资源规范，并与旧静态 systemPrompt 兼容", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const model = scriptedModel(["收到"]);
    let revision = "第一版规范";
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
      systemPromptFor: () => "旧宿主提示",
      resourcesFor: () => fakeResourceSnapshot(revision),
    });
    const session = manager.create({ workspacePath: "C:/work/demo" });
    for await (const _event of session.sendMessage({
      text: "第一轮",
      profile,
    })) {
    }
    revision = "第二版规范";
    expect(manager.get(session.id)).toBe(session);
    for await (const _event of session.sendMessage({
      text: "第二轮",
      profile,
    })) {
    }

    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
      "第一版规范"
    );
    const next = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(next).toContain("第二版规范");
    expect(next).toContain("旧宿主提示");
    expect(next).not.toContain("第一版规范");
    persistence.close();
  });

  it("显式多技能按顺序去重，首次请求有正文且下一轮不继承、不写入 mentions", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const model = scriptedModel(["收到"]);
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
      resourcesFor: () => fakeResourceSnapshot(),
    });
    const session = manager.create({ workspacePath: "C:/work/demo" });
    for await (const _event of session.sendMessage({
      text: "$beta $alpha $beta",
      profile,
    })) {
    }
    const first = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(first).toContain("BETA_PRIVATE_BODY");
    expect(first).toContain("ALPHA_PRIVATE_BODY");
    expect(first.indexOf("BETA_PRIVATE_BODY")).toBeLessThan(
      first.indexOf("ALPHA_PRIVATE_BODY")
    );
    expect(first.match(/BETA_PRIVATE_BODY/g)).toHaveLength(1);
    expect(manager.messages(session.id)[0]).toMatchObject({
      content: "$beta $alpha $beta",
    });
    expect(manager.messages(session.id)[0]?.mentions).toBeUndefined();
    for await (const _event of session.sendMessage({ text: "继续", profile })) {
    }
    const next = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(next).not.toContain("ALPHA_PRIVATE_BODY");
    expect(next).not.toContain("BETA_PRIVATE_BODY");
    persistence.close();
  });

  it("资源状态只在运行时 active，结束保留无正文摘要；查询未恢复会话不实例化", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    persistence.insertSession(sessionRecord());
    const uninstantiated = createSessionManager({
      persistence,
      systemPromptFor: () => {
        throw new Error("不应实例化会话");
      },
      resourcesFor: () => {
        throw new Error("不应读取资源");
      },
    });
    expect(uninstantiated.resourceState("session-1")).toEqual({
      active: null,
      last: null,
    });
    expect(uninstantiated.resourceState("missing")).toEqual({
      active: null,
      last: null,
    });
    const model = scriptedModel(["收到"]);
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
      resourcesFor: () => fakeResourceSnapshot(),
    });
    const session = manager.get("session-1")!;
    expect(session.resourceState).toEqual({ active: null, last: null });
    for await (const _event of session.sendMessage({
      text: "$alpha",
      profile,
    })) {
      expect(manager.resourceState(session.id).active?.loaded).toEqual([
        expect.objectContaining({
          executorId: "main",
          name: "alpha",
          kind: "skill",
        }),
      ]);
      expect(session.resourceState.last).toBeNull();
    }
    expect(session.resourceState.active).toBeNull();
    expect(manager.resourceState(session.id).last?.loaded).toHaveLength(1);
    expect(JSON.stringify(session.resourceState)).not.toContain(
      "ALPHA_PRIVATE_BODY"
    );
    persistence.close();
  });

  it("未知显式技能不落库、不请求模型，失败后仍能继续普通对话", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const model = scriptedModel(["收到"]);
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
      resourcesFor: () => fakeResourceSnapshot(),
    });
    const session = manager.create({ workspacePath: "C:/work/demo" });
    await expect(
      (async () => {
        for await (const _event of session.sendMessage({
          text: "$alpha $missing",
          profile,
        })) {
        }
      })()
    ).rejects.toThrow("未知技能");
    expect(manager.messages(session.id)).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(session.resourceState.active).toBeNull();
    expect(session.resourceState.last?.loaded).toEqual([]);
    for await (const _event of session.sendMessage({ text: "继续", profile })) {
    }
    expect(model.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain(
      "ALPHA_PRIVATE_BODY"
    );
    persistence.close();
  });

  it.each(["failure", "abort", "return"] as const)(
    "%s 路径释放 active 与互斥，保留最近摘要",
    async (ending) => {
      const persistence = createSqliteSessionStore(":memory:");
      const record = sessionRecord();
      persistence.insertSession(record);
      let fail = ending === "failure";
      const model = new MockLanguageModelV4({
        doStream: async () => {
          if (fail) throw new Error("模型失败");
          return { stream: textStream("收到") };
        },
      });
      const session = createAgentSession({
        record,
        persistence,
        languageModelFor: () => model,
        resources: () => fakeResourceSnapshot(),
      });
      const controller = new AbortController();
      const events = [];
      for await (const event of session.sendMessage({
        text: "$alpha",
        profile,
        signal: controller.signal,
      })) {
        events.push(event);
        if (ending === "return") break;
        if (ending === "abort" && event.type === "user-message")
          controller.abort();
      }
      expect(session.resourceState.active).toBeNull();
      expect(session.resourceState.last?.loaded).toHaveLength(1);
      if (ending === "failure") expect(events.at(-1)?.type).toBe("error");
      if (ending === "abort")
        expect(events.at(-1)?.type).toBe("assistant-aborted");
      fail = false;
      for await (const _event of session.sendMessage({
        text: "继续",
        profile,
      })) {
      }
      expect(session.resourceState.last?.loaded).toEqual([]);
      persistence.close();
    }
  );

  it("未配置 resources 时美元引用仍按普通文本对话", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const model = scriptedModel(["收到"]);
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => model,
    });
    const session = manager.create({ workspacePath: "C:/work/demo" });
    for await (const _event of session.sendMessage({
      text: "$missing",
      profile,
    })) {
    }
    expect(model.doStreamCalls).toHaveLength(1);
    expect(session.resourceState).toEqual({ active: null, last: null });
    persistence.close();
  });

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
