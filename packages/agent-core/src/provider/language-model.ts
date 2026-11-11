import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, type LanguageModel } from "ai";

import type { ProviderProfile } from "./provider-profile";

/** 逐条消息的思考档位；缺省保留服务端默认行为。 */
export type ThinkingEffort = "auto" | "low" | "medium" | "high" | "off";

/** 五档枚举值（IPC 边界校验与 UI 选项列表共用；spec「边界接受值限于上述枚举」） */
export const THINKING_EFFORTS: readonly ThinkingEffort[] = [
  "auto",
  "low",
  "medium",
  "high",
  "off",
];

/**
 * 五档校验的统一入口（IPC 边界 / 发送入口 / provider 工厂共用）：
 * 接受 unknown，undefined 等价 auto（未传档位的既有语义），
 * 五档内的字符串原样返回；枚举外的值抛「无效的思考档位：<原始值>」——
 * 拒绝把伪造控制值原样发给服务端（spec「边界接受值限于上述枚举」）。
 */
export function parseThinkingEffort(value: unknown): ThinkingEffort {
  if (value === undefined) {
    return "auto";
  }
  if (
    typeof value === "string" &&
    THINKING_EFFORTS.includes(value as ThinkingEffort)
  ) {
    return value as ThinkingEffort;
  }
  throw new Error(`无效的思考档位：${String(value)}`);
}

/** 构造语言模型时可注入的选项 */
export interface CreateLanguageModelOptions {
  /**
   * 自定义 fetch（测试注入用）。
   * 默认使用全局 fetch。
   */
  fetch?: typeof globalThis.fetch;
  thinkingEffort?: ThinkingEffort;
}

/**
 * 由 Provider Profile 构造 OpenAI 兼容的语言模型。
 *
 * 统一走 chat completions 协议（`<baseURL>/chat/completions`）而非 Responses API：
 * CodexLike 支持的端点（GLM、DeepSeek、Ollama 等）对 Responses API 的支持参差不齐，
 * chat completions 是 OpenAI 兼容生态的最大公约数。
 *
 * 这是 agent-core 的稳定公共接口：后续工单的对话循环、compact、subagent
 * 都通过它把 Provider Profile 变成可调用的模型。
 */
export function createLanguageModelFromProfile(
  profile: ProviderProfile,
  options: CreateLanguageModelOptions = {}
): LanguageModel {
  // 未传字段的既有调用方走 auto；显式传入的值必须在五档枚举内，
  // 拒绝把伪造控制值原样发给服务端（spec「边界接受值限于上述枚举」）
  const effort = parseThinkingEffort(options.thinkingEffort);
  const provider = createOpenAICompatible({
    name: "codexlike",
    baseURL: profile.baseURL,
    apiKey: profile.apiKey,
    fetch: options.fetch,
  });
  return wrapLanguageModel({
    model: provider.chatModel(profile.model),
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        // compatible 会将 response.messages 的 reasoning 自动转回 reasoning_content。
        // 思考仅作本次展示，在 SDK prompt 边界剥离；正文与工具调用仍原样往返。
        prompt: params.prompt.map((message) =>
          message.role === "assistant"
            ? {
                ...message,
                content: message.content.filter(
                  (part) => part.type !== "reasoning"
                ),
              }
            : message
        ),
        ...(effort === "auto"
          ? {}
          : {
              providerOptions: {
                ...params.providerOptions,
                codexlike: {
                  ...params.providerOptions?.codexlike,
                  thinking: { type: effort === "off" ? "disabled" : "enabled" },
                  ...(effort === "off" ? {} : { reasoning_effort: effort }),
                },
              },
            }),
      }),
    },
  });
}
