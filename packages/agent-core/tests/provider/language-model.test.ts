import { generateText, jsonSchema, streamText, tool } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  createLanguageModelFromProfile,
  parseThinkingEffort,
  type ProviderProfile,
} from "../../src/index";

/** OpenAI 兼容端点最小的 chat.completion 成功响应 */
const chatCompletionBody = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 0,
  model: "glm-4.7",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "你好" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  models: ["glm-4.7", "glm-4.6"],
};

/** 记录请求并返回最小 chat.completion 成功响应的 fetch 替身 */
function createFetchSpy() {
  return vi.fn(
    async (
      _input: string | URL | Request,
      _init?: RequestInit
    ): Promise<Response> =>
      new Response(JSON.stringify(chatCompletionBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
}

/** 受控的真实 chat completions SSE，不替换 SDK 流解析。 */
function streamResponse() {
  const deltas = [
    { reasoning_content: "先思考" },
    { reasoning_content: "再查文件" },
    { content: "正在读取" },
    {
      tool_calls: [
        {
          index: 0,
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":' },
        },
      ],
    },
    { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] },
  ];
  const chunks = deltas.map((delta) => ({
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: 0,
    model: profile.models[0],
    choices: [{ index: 0, delta, finish_reason: null }],
  }));
  const end = {
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: 0,
    model: profile.models[0],
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
  return new Response(
    [...chunks, end]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    }
  );
}

const readFileTool = tool({
  inputSchema: jsonSchema<{ path: string }>({
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  }),
});

describe("createLanguageModelFromProfile（OpenAI 兼容 provider 构造）", () => {
  it("同一 SSE 将思考、正文和分片工具参数分别输出", async () => {
    const model = createLanguageModelFromProfile(profile, {
      fetch: async () => streamResponse(),
    });
    const result = streamText({
      model,
      prompt: "读文件",
      tools: { read_file: readFileTool },
    });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);

    expect(
      parts
        .filter((part) => part.type === "reasoning-delta")
        .map((part) => part.text)
    ).toEqual(["先思考", "再查文件"]);
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.text)
    ).toEqual(["正在读取"]);
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning-start" }),
        expect.objectContaining({ type: "reasoning-end" }),
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read_file",
          input: { path: "README.md" },
        }),
      ])
    );
    expect(await result.text).toBe("正在读取");
  });
  it("response.messages 工具往返回填时不将展示思考送回 HTTP 历史", async () => {
    const fetchSpy = createFetchSpy();
    fetchSpy.mockImplementationOnce(async () => streamResponse());
    const model = createLanguageModelFromProfile(profile, { fetch: fetchSpy });
    const first = streamText({
      model,
      prompt: "读文件",
      tools: { read_file: readFileTool },
    });
    await first.consumeStream();
    const response = await first.response;
    expect(JSON.stringify(response.messages)).toContain("先思考再查文件");
    await generateText({
      model,
      messages: [
        { role: "user", content: "读文件" },
        ...response.messages,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "read_file",
              output: { type: "text", value: "文件内容" },
            },
          ],
        },
      ],
    });
    const body = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
    expect(body.messages).toEqual([
      { role: "user", content: "读文件" },
      {
        role: "assistant",
        content: "正在读取",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "文件内容" },
    ]);
    expect(JSON.stringify(body)).not.toContain("先思考");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it.each([
    ["auto", undefined, undefined],
    ["low", { type: "enabled" }, "low"],
    ["medium", { type: "enabled" }, "medium"],
    ["high", { type: "enabled" }, "high"],
    ["off", { type: "disabled" }, undefined],
  ] as const)(
    "%s 档实际 HTTP body 符合契约",
    async (thinkingEffort, thinking, effort) => {
      const fetchSpy = createFetchSpy();
      const model = createLanguageModelFromProfile(profile, {
        fetch: fetchSpy,
        thinkingEffort,
      });
      await generateText({ model, prompt: "你好" });
      const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(body.model).toBe("glm-4.7");
      if (thinking === undefined) expect(body).not.toHaveProperty("thinking");
      else expect(body.thinking).toEqual(thinking);
      if (effort === undefined)
        expect(body).not.toHaveProperty("reasoning_effort");
      else expect(body.reasoning_effort).toBe(effort);
      expect(body).not.toHaveProperty("reasoningEffort");
      expect(body).not.toHaveProperty("clear_thinking");
    }
  );

  it("拒绝未知档位，不向服务端发送伪造控制值", () => {
    expect(() =>
      createLanguageModelFromProfile(profile, {
        thinkingEffort: JSON.parse('"max"'),
      })
    ).toThrow("无效的思考档位");
  });

  it("服务端拒绝档位时保留 HTTP 错误，不降档或重试 400", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "thinking not supported",
              type: "invalid_request_error",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
    );
    const model = createLanguageModelFromProfile(profile, {
      fetch: fetchSpy,
      thinkingEffort: "high",
    });
    await expect(generateText({ model, prompt: "你好" })).rejects.toMatchObject(
      { statusCode: 400, message: "thinking not supported" }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("仅有 reasoning 的 SSE 可中断，AbortSignal 到达 fetch", async () => {
    const abort = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const model = createLanguageModelFromProfile(profile, {
      thinkingEffort: "low",
      fetch: async (_input, init) => {
        requestSignal = init?.signal;
        const body = JSON.parse(String(init?.body));
        expect(body.thinking).toEqual({ type: "enabled" });
        expect(body.reasoning_effort).toBe("low");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "尚在思考" }, finish_reason: null }] })}\n\n`
                )
              );
              requestSignal?.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("已中断", "AbortError")),
                { once: true }
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        );
      },
    });
    const result = streamText({
      model,
      prompt: "你好",
      abortSignal: abort.signal,
      maxRetries: 0,
    });
    const parts = [];
    for await (const part of result.fullStream) {
      parts.push(part);
      if (part.type === "reasoning-delta") abort.abort();
    }
    expect(requestSignal?.aborted).toBe(true);
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning-delta", text: "尚在思考" }),
        expect.objectContaining({ type: "abort" }),
      ])
    );
    expect(parts.some((part) => part.type === "text-delta")).toBe(false);
  });

  it("请求发往 profile.baseURL 下的 /chat/completions（baseURL 透传）", async () => {
    const fetchSpy = createFetchSpy();

    const model = createLanguageModelFromProfile(profile, {
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await generateText({ model, prompt: "你好" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    );
  });

  it("多模型 Profile 的请求 model 字段取列表第一项（任务级选择落地前的兼容语义）", async () => {
    const fetchSpy = createFetchSpy();

    const model = createLanguageModelFromProfile(profile, {
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await generateText({ model, prompt: "你好" });

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("glm-4.7");
  });

  it("请求携带 Authorization: Bearer <apiKey>", async () => {
    const fetchSpy = createFetchSpy();

    const model = createLanguageModelFromProfile(profile, {
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await generateText({ model, prompt: "你好" });

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers ?? undefined);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
  });

  it("构造结果可完成一次 generateText 文本往返", async () => {
    const model = createLanguageModelFromProfile(profile, {
      fetch: createFetchSpy() as unknown as typeof globalThis.fetch,
    });

    const { text } = await generateText({ model, prompt: "你好" });

    expect(text).toBe("你好");
  });
});

describe("parseThinkingEffort（五档校验统一入口）", () => {
  it.each(["auto", "low", "medium", "high", "off"] as const)(
    "合法档位 %s 原样返回",
    (effort) => {
      expect(parseThinkingEffort(effort)).toBe(effort);
    }
  );

  it("undefined 等价 auto：未传档位的既有语义收进同一入口", () => {
    expect(parseThinkingEffort(undefined)).toBe("auto");
  });

  it.each(["max", "", "HIGH", 1, null, {}, [], true])(
    "非法值 %p 抛同文案错误",
    (value) => {
      expect(() => parseThinkingEffort(value)).toThrow("无效的思考档位");
    }
  );

  it("非法值错误信息含原始值（可诊断）", () => {
    expect(() => parseThinkingEffort("max")).toThrow("无效的思考档位：max");
  });
});
