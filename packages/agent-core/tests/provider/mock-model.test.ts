import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

/**
 * MockLanguageModelV4 冒烟测试：确认 `ai/test` 的脚本化模型与 vitest 基建协作正常。
 * 后续工单（agent 循环、审批、compact）都用它脚本化模型响应序列，
 * 这里的用例是那套测试范式的最小样板。
 */
describe('MockLanguageModelV4 测试基建', () => {
  it('脚本化的 doGenerate 驱动 generateText 返回预期文本', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '你好，我是测试模型' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
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

    const { text, finishReason, usage } = await generateText({
      model,
      prompt: '打个招呼',
    });

    expect(text).toBe('你好，我是测试模型');
    expect(finishReason).toBe('stop');
    expect(usage.totalTokens).toBe(8);
  });
});
