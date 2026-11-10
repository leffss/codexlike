import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

import type { ProviderProfile } from './provider-profile';

/** 构造语言模型时可注入的选项 */
export interface CreateLanguageModelOptions {
  /**
   * 自定义 fetch（测试注入用）。
   * 默认使用全局 fetch。
   */
  fetch?: typeof globalThis.fetch;
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
  options: CreateLanguageModelOptions = {},
): LanguageModel {
  const provider = createOpenAI({
    baseURL: profile.baseURL,
    apiKey: profile.apiKey,
    fetch: options.fetch,
  });
  return provider.chat(profile.model);
}
