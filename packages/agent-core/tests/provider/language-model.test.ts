import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  createLanguageModelFromProfile,
  type ProviderProfile,
} from '../../src/index';

/** OpenAI 兼容端点最小的 chat.completion 成功响应 */
const chatCompletionBody = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 0,
  model: 'glm-4.7',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: '你好' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const profile: ProviderProfile = {
  id: 'profile-1',
  name: 'GLM',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-test',
  model: 'glm-4.7',
};

/** 记录请求并返回最小 chat.completion 成功响应的 fetch 替身 */
function createFetchSpy() {
  return vi.fn(
    async (
      _input: string | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      new Response(JSON.stringify(chatCompletionBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

describe('createLanguageModelFromProfile（OpenAI 兼容 provider 构造）', () => {
  it('请求发往 profile.baseURL 下的 /chat/completions（baseURL 透传）', async () => {
    const fetchSpy = createFetchSpy();

    const model = createLanguageModelFromProfile(profile, {
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await generateText({ model, prompt: '你好' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    );
  });

  it('请求携带 Authorization: Bearer <apiKey>', async () => {
    const fetchSpy = createFetchSpy();

    const model = createLanguageModelFromProfile(profile, {
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await generateText({ model, prompt: '你好' });

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers ?? undefined);
    expect(headers.get('authorization')).toBe('Bearer sk-test');
  });

  it('构造结果可完成一次 generateText 文本往返', async () => {
    const model = createLanguageModelFromProfile(profile, {
      fetch: createFetchSpy() as unknown as typeof globalThis.fetch,
    });

    const { text } = await generateText({ model, prompt: '你好' });

    expect(text).toBe('你好');
  });
});
