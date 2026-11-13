import { defineTool } from "./define-tool";
import type { ToolDefinition } from "./types";

/**
 * web_search（工单 10）：搜索源抽象 + Tavily 默认实现 + 工具定义。
 *
 * 搜索源是注入式接口（spec「web_search 与浏览器」：搜索源抽象为接口可替换）：
 * agent-core 不关心实现，宿主（Electron 主进程）把 Tavily 实例或测试替身注入进来。
 * 本模块只用全局 fetch，不依赖 Node 内置 API。
 */

/** 一条搜索结果（标题/URL/片段；spec 用户故事 25 的三要素） */
export interface SearchResult {
  title: string;
  url: string;
  /** 结果摘要（Tavily 的 content 字段） */
  snippet: string;
}

/** 搜索源接口：实现可替换（Tavily 为默认实现） */
export interface SearchSource {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

export interface SearchOptions {
  /** 结果条数上限（Tavily 上限 10） */
  maxResults?: number;
}

export interface TavilySearchSourceOptions {
  /** Tavily API key（设置页配置） */
  apiKey: string;
  /**
   * 自定义端点 URL（默认 https://api.tavily.com/search）。
   * 测试与自建代理场景使用；宿主可从环境变量注入。
   */
  baseUrl?: string;
  /** 自定义 fetch（测试注入用；默认全局 fetch） */
  fetch?: typeof globalThis.fetch;
  /** 请求超时毫秒数（默认 15000） */
  timeoutMs?: number;
}

const DEFAULT_TAVILY_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESULTS_LIMIT = 10;

/**
 * Tavily 搜索源（默认实现）：POST https://api.tavily.com/search，
 * 请求体携带 api_key + query，结果映射为 {title, url, snippet}。
 * 超时、HTTP 错误、网络失败均抛中文错误（由工具层转 isError 结果）。
 */
export function createTavilySearchSource(
  options: TavilySearchSourceOptions
): SearchSource {
  const fetchLike = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = options.baseUrl ?? DEFAULT_TAVILY_ENDPOINT;

  return {
    async search(query, searchOptions) {
      const maxResults = searchOptions?.maxResults ?? 5;
      const timeout = AbortSignal.timeout(timeoutMs);

      let response: Response;
      try {
        response = await fetchLike(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: options.apiKey,
            query,
            max_results: maxResults,
          }),
          signal: timeout,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new Error(
            `搜索请求超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试`,
            { cause: error }
          );
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(
            `搜索请求超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试`,
            { cause: error }
          );
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`搜索请求发送失败：${reason}`, { cause: error });
      }

      if (!response.ok) {
        throw new Error(`Tavily API 返回错误（HTTP ${response.status}）`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Tavily API 响应不是合法 JSON：${reason}`, {
          cause: error,
        });
      }

      const rawResults = (body as { results?: unknown }).results;
      if (!Array.isArray(rawResults)) {
        throw new Error("Tavily API 响应缺少 results 字段");
      }
      return rawResults.map((item) => {
        const record = (item ?? {}) as Record<string, unknown>;
        return {
          title: typeof record["title"] === "string" ? record["title"] : "",
          url: typeof record["url"] === "string" ? record["url"] : "",
          snippet:
            typeof record["content"] === "string" ? record["content"] : "",
        };
      });
    },
  };
}

export interface WebSearchToolOptions {
  /**
   * 解析当前搜索源：每次工具调用时取值（null = 未配置，返回中文错误指引），
   * 因此设置页改 key 后无需重启任务即可生效。
   */
  searchSource: () => SearchSource | null;
}

/** web_search 工具：query → 搜索源 → 标题/URL/片段列表回填模型 */
export function createWebSearchTool(
  options: WebSearchToolOptions
): ToolDefinition {
  return defineTool({
    name: "web_search",
    description:
      "搜索互联网上的最新资料（文档、新闻、技术方案等），返回结果的标题、URL 与内容摘要。" +
      "适合回答时效性问题或补充训练数据之外的细节。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        maxResults: {
          type: "number",
          description: `结果条数（1-${MAX_RESULTS_LIMIT}，默认 5）`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    permission: "network",

    async execute(rawArgs) {
      const source = options.searchSource();
      if (source === null) {
        throw new Error(
          "未配置搜索源：请在设置页填写搜索服务（Tavily）的 API key"
        );
      }

      const args = (
        typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {}
      ) as Record<string, unknown>;
      const query = args["query"];
      if (typeof query !== "string" || query === "") {
        throw new Error("参数 query 缺失或不是非空字符串");
      }
      const maxResults = args["maxResults"];
      const resolvedMax =
        typeof maxResults === "number" &&
        Number.isInteger(maxResults) &&
        maxResults > 0
          ? Math.min(maxResults, MAX_RESULTS_LIMIT)
          : undefined;

      const results = await source.search(query, { maxResults: resolvedMax });
      if (results.length === 0) {
        return {
          output: `未搜到「${query}」的相关结果，请尝试更换关键词`,
          isError: false,
        };
      }
      const lines = results.map(
        (item, index) =>
          `${index + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet}`
      );
      return { output: lines.join("\n\n"), isError: false };
    },
  });
}
