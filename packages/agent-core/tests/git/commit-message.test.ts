import { MockLanguageModelV4 } from "ai/test";
import { createLanguageModelFromProfile } from "../../src/index";
import { describe, expect, it } from "vitest";

import {
  buildCommitMessagePrompt,
  generateCommitMessage,
} from "../../src/git/commit-message";

/** 最小 mock 模型：doGenerate 固定返回给定文本（参照 tests/provider/mock-model.test.ts 样板） */
function mockModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: {
          total: 3,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 5, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

describe("buildCommitMessagePrompt（纯函数）", () => {
  it("包含最近的任务内容与变更文件列表", () => {
    const prompt = buildCommitMessagePrompt(
      [
        { role: "user", content: "修复登录页的空指针" },
        { role: "assistant", content: "已修改 auth.ts 修复" },
      ],
      ["src/auth.ts", "tests/auth.test.ts"]
    );
    expect(prompt).toContain("修复登录页的空指针");
    expect(prompt).toContain("已修改 auth.ts 修复");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("tests/auth.test.ts");
  });

  it("error 消息与超长单条消息被裁剪，只保留最近 20 条", () => {
    const messages = [
      ...Array.from({ length: 25 }, (_, i) => ({
        role: "user" as const,
        content: `第 ${i} 条`,
      })),
      { role: "error" as const, content: "不该出现" },
      { role: "user" as const, content: "x".repeat(600) },
    ];
    const prompt = buildCommitMessagePrompt(messages, []);
    expect(prompt).toContain("第 6 条"); // 25 条里取最近 20 条：第 6..24
    expect(prompt).not.toContain("第 5 条");
    expect(prompt).not.toContain("不该出现");
    expect(prompt).not.toContain("x".repeat(500)); // 单条截断
  });
});

describe("generateCommitMessage（一次不发工具的 LLM 请求）", () => {
  it("兼容工厂的 commit 草稿 HTTP 请求保留服务端默认档位", async () => {
    let body: Record<string, unknown> = {};
    const model = createLanguageModelFromProfile(
      {
        id: "p",
        name: "local",
        baseURL: "https://provider.test/v1",
        apiKey: "key",
        model: "test-model",
      },
      {
        fetch: async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content: "修复登录" },
                  finish_reason: "stop",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } }
          );
        },
      }
    );
    expect(
      await generateCommitMessage({
        model,
        messages: [{ role: "user", content: "修复登录" }],
        changedFiles: ["auth.ts"],
      })
    ).toBe("修复登录");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("tools");
  });

  it("返回模型生成的消息（trim 后）", async () => {
    const message = await generateCommitMessage({
      model: mockModel("  修复登录页空指针  "),
      messages: [{ role: "user", content: "修复登录 bug" }],
      changedFiles: ["src/auth.ts"],
    });
    expect(message).toBe("修复登录页空指针");
  });

  it("请求不带工具且 prompt 含任务内容与变更文件", async () => {
    const model = mockModel("提交消息");
    await generateCommitMessage({
      model,
      messages: [{ role: "assistant", content: "重构了配置模块" }],
      changedFiles: ["src/config.ts"],
    });
    const call = model.doGenerateCalls[0]!;
    // prompt 是 ModelMessage[]：按结构断言（07 Comments 的教训）
    const promptText = JSON.stringify(call.prompt);
    expect(promptText).toContain("重构了配置模块");
    expect(promptText).toContain("src/config.ts");
    expect(call.tools ?? []).toHaveLength(0); // 不发工具：只生成文本
  });

  it("模型返回空白：中文报错（可回退手写）", async () => {
    await expect(
      generateCommitMessage({
        model: mockModel("   "),
        messages: [{ role: "user", content: "做了点事" }],
        changedFiles: [],
      })
    ).rejects.toThrow("未返回有效的提交消息");
  });
});
