import { describe, expect, it } from "vitest";

import { createBuiltinTools } from "../../src/tools/builtin";
import type { ToolExecutionContext } from "../../src/tools/types";
import {
  createTavilySearchSource,
  createWebSearchTool,
  type SearchSource,
  type SearchResult,
} from "../../src/tools/web-search";

/** Tavily 响应体（截取本工具用到的字段） */
function tavilyResponse(
  results: { title: string; url: string; content: string }[]
) {
  return { query: "demo", results, response_time: 0.5 };
}

/** JSON 响应的 Response 形状 */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** 捕获请求的 fake fetch：返回预设响应，记录 URL 与请求体 */
function fakeFetch(response: Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchLike = async (url: unknown, init?: unknown) => {
    calls.push({
      url: String(url),
      init: (init ?? {}) as RequestInit,
    });
    return response;
  };
  return { fetchLike, calls } as const;
}

describe("TavilySearchSource", () => {
  it("正常路径：POST api.tavily.com/search，api_key + query 进请求体，结果映射为 {title,url,snippet}", async () => {
    const fake = fakeFetch(
      jsonResponse(
        200,
        tavilyResponse([
          {
            title: "Vercel AI SDK",
            url: "https://ai-sdk.dev",
            content: "Typesafe AI SDK.",
          },
          {
            title: "Docs",
            url: "https://ai-sdk.dev/docs",
            content: "Documentation.",
          },
        ])
      )
    );
    const source = createTavilySearchSource({
      apiKey: "tvly-test",
      fetch: fake.fetchLike,
    });

    const results = await source.search("ai sdk");

    expect(results).toEqual([
      {
        title: "Vercel AI SDK",
        url: "https://ai-sdk.dev",
        snippet: "Typesafe AI SDK.",
      },
      {
        title: "Docs",
        url: "https://ai-sdk.dev/docs",
        snippet: "Documentation.",
      },
    ]);
    // 请求形态：POST + JSON 体携带 api_key 与 query
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe("https://api.tavily.com/search");
    expect(fake.calls[0]?.init.method).toBe("POST");
    const body = JSON.parse(String(fake.calls[0]?.init.body));
    expect(body).toMatchObject({ api_key: "tvly-test", query: "ai sdk" });
  });

  it("空结果路径：results 为空数组时返回空列表（不抛错）", async () => {
    const source = createTavilySearchSource({
      apiKey: "tvly-test",
      fetch: fakeFetch(jsonResponse(200, tavilyResponse([]))).fetchLike,
    });
    await expect(source.search("不存在的词")).resolves.toEqual([]);
  });

  it("HTTP 错误路径：非 2xx 抛含状态码的中文错误", async () => {
    const source = createTavilySearchSource({
      apiKey: "tvly-bad",
      fetch: fakeFetch(jsonResponse(432, { detail: "Invalid API key" }))
        .fetchLike,
    });
    await expect(source.search("x")).rejects.toThrow(
      "Tavily API 返回错误（HTTP 432）"
    );
  });

  it("超时路径：超时窗口内无响应时抛中文超时错误", async () => {
    // 永不完成的 fetch，但尊重传入的 abort signal（signal 触发时 reject）
    const hangingFetch = (_url: unknown, init?: unknown) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        });
      }) as Promise<Response>;
    const source = createTavilySearchSource({
      apiKey: "tvly-test",
      fetch: hangingFetch as typeof globalThis.fetch,
      timeoutMs: 20,
    });
    await expect(source.search("slow")).rejects.toThrow("搜索请求超时");
  });

  it("网络失败路径：fetch reject 时抛含原因的中文错误", async () => {
    const source = createTavilySearchSource({
      apiKey: "tvly-test",
      fetch: (async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(source.search("x")).rejects.toThrow("搜索请求发送失败");
  });

  it("baseUrl 可覆盖（E2E/自建代理场景）：请求打到指定端点", async () => {
    const fake = fakeFetch(jsonResponse(200, tavilyResponse([])));
    const source = createTavilySearchSource({
      apiKey: "tvly-test",
      baseUrl: "http://127.0.0.1:9999/search",
      fetch: fake.fetchLike,
    });
    await source.search("local");
    expect(fake.calls[0]?.url).toBe("http://127.0.0.1:9999/search");
  });
});

describe("web_search 工具", () => {
  const context: ToolExecutionContext = {
    workspacePath: "C:/ws",
    sessionId: "web-search-test",
    approvalMode: "assist",
  };

  /** 固定结果的假搜索源（记录收到的 query/maxResults） */
  function fakeSource(results: SearchResult[] | Error) {
    const searches: { query: string; maxResults?: number }[] = [];
    const source: SearchSource = {
      async search(query, options) {
        searches.push({ query, maxResults: options?.maxResults });
        if (results instanceof Error) {
          throw results;
        }
        return results;
      },
    };
    return { source, searches } as const;
  }

  it("未配置搜索源：返回中文错误（不抛出、会话不崩）", async () => {
    const tool = createWebSearchTool({ searchSource: () => null });
    const result = await tool.execute({ query: "anything" }, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("未配置搜索源");
    expect(result.output).toContain("设置页");
  });

  it("正常路径：结果以「序号. 标题 / URL / 摘要」格式回填模型", async () => {
    const { source, searches } = fakeSource([
      {
        title: "AI SDK 文档",
        url: "https://ai-sdk.dev/docs",
        snippet: "开始使用。",
      },
      { title: "GitHub", url: "https://github.com", snippet: "代码托管。" },
    ]);
    const tool = createWebSearchTool({ searchSource: () => source });

    const result = await tool.execute({ query: "ai sdk 文档" }, context);

    expect(result.isError).toBe(false);
    expect(result.output).toBe(
      [
        "1. AI SDK 文档",
        "   https://ai-sdk.dev/docs",
        "   开始使用。",
        "",
        "2. GitHub",
        "   https://github.com",
        "   代码托管。",
      ].join("\n")
    );
    expect(searches).toEqual([{ query: "ai sdk 文档", maxResults: undefined }]);
  });

  it("空结果路径：返回可读的「未搜到」提示，不算失败", async () => {
    const { source } = fakeSource([]);
    const tool = createWebSearchTool({ searchSource: () => source });
    const result = await tool.execute({ query: "冷门词" }, context);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("未搜到「冷门词」");
  });

  it("失败路径：搜索源抛错时包装为工具失败的中文结果", async () => {
    const { source } = fakeSource(new Error("Tavily API 返回错误（HTTP 429）"));
    const tool = createWebSearchTool({ searchSource: () => source });
    const result = await tool.execute({ query: "x" }, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("web_search 执行失败");
    expect(result.output).toContain("HTTP 429");
  });

  it("maxResults 透传且封顶 10；非法值回退默认", async () => {
    const { source, searches } = fakeSource([]);
    const tool = createWebSearchTool({ searchSource: () => source });
    await tool.execute({ query: "a", maxResults: 50 }, context);
    await tool.execute({ query: "b", maxResults: 3 }, context);
    await tool.execute({ query: "c", maxResults: "很多" }, context);
    expect(searches.map((s) => s.maxResults)).toEqual([10, 3, undefined]);
  });

  it("注册进内置工具表：带 webSearch 选项时 createBuiltinTools 追加 web_search，工具元数据齐全", () => {
    const { source } = fakeSource([]);
    const tools = createBuiltinTools({
      webSearch: { searchSource: () => source },
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("web_search");
    const webSearch = tools.find((t) => t.name === "web_search");
    expect(webSearch?.parameters).toMatchObject({
      type: "object",
      required: ["query"],
    });
    expect(webSearch?.permission).toBe("network");

    // 未传 webSearch 时不注册（任务无搜索能力）
    const without = createBuiltinTools();
    expect(without.map((t) => t.name)).not.toContain("web_search");
  });
});
