import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import type { ProviderProfile } from '../../src/provider/provider-profile';
import { createSqliteSessionStore } from '../../src/session/persistence';
import { createAgentSession } from '../../src/session/agent-session';
import type { SessionEvent, SessionRecord } from '../../src/session/types';

/** 测试用 Provider Profile（apiKey 不会被真实使用：模型工厂注入 mock） */
const profile: ProviderProfile = {
  id: 'profile-1',
  name: 'GLM',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-test',
  model: 'glm-4.7',
};

function sessionRecord(): SessionRecord {
  return {
    id: 'session-1',
    title: 'demo',
    workspacePath: 'C:\\work\\demo',
    providerProfileId: null,
    model: null,
    status: 'idle',
    approvalMode: 'suggest',
    archivedAt: null,
    createdAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T08:00:00.000Z',
  };
}

/** ai v7 起流式文本必须包裹 text-start / text-end part（最小合法形状） */
function textStream(deltas: string[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-start', id: 'text-1' });
      for (const delta of deltas) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta });
      }
      controller.enqueue({ type: 'text-end', id: 'text-1' });
      controller.enqueue({
        type: 'finish',
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 2,
            text: undefined,
            reasoning: undefined,
          },
        },
        finishReason: { unified: 'stop' as const, raw: 'stop' },
      });
      controller.close();
    },
  });
}

/** 脚本化响应：每次 doStream 调用依次取一项；超出脚本后重复最后一项 */
type ScriptedResponse = { deltas: string[] } | { error: Error };

function scriptedModel(responses: ScriptedResponse[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const response = responses[Math.min(call++, responses.length - 1)]!;
      if ('error' in response) {
        throw response.error;
      }
      return { stream: textStream(response.deltas) };
    },
  });
}

/** 固定时钟 + 递增秒，让断言不依赖真实时间 */
function fakeClock() {
  let tick = 0;
  return () => `2026-11-10T08:00:${String(++tick).padStart(2, '0')}.000Z`;
}

async function collect(
  iterable: AsyncIterable<SessionEvent>,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** 装配一个挂在首个 delta 之后的流：等 gate 打开后继续输出（测试 abort 时序用） */
function gatedFirstDeltaStream(
  gate: Promise<void>,
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue({ type: 'text-start', id: 'text-1' });
      controller.enqueue({ type: 'text-delta', id: 'text-1', delta: '部分回复' });
      await gate;
      controller.enqueue({ type: 'text-delta', id: 'text-1', delta: '（不应出现）' });
      controller.enqueue({ type: 'text-end', id: 'text-1' });
      controller.enqueue({
        type: 'finish',
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 2,
            text: undefined,
            reasoning: undefined,
          },
        },
        finishReason: { unified: 'stop' as const, raw: 'stop' },
      });
      controller.close();
    },
  });
}

describe('AgentSession.sendMessage（会话流式循环）', () => {
  it('单轮问答：事件序列为 user-message → assistant-start → delta×2 → assistant-done，消息与状态落库', async () => {
    const persistence = createSqliteSessionStore(':memory:');
    const record = sessionRecord();
    persistence.insertSession(record);
    const model = scriptedModel([{ deltas: ['你好，', '世界'] }]);

    const session = createAgentSession({
      record,
      persistence,
      languageModelFor: () => model,
      now: fakeClock(),
    });

    const events = await collect(
      session.sendMessage({ text: '打个招呼', profile }),
    );

    // 事件序列（正常路径）
    expect(events.map((e) => e.type)).toEqual([
      'user-message',
      'assistant-start',
      'assistant-delta',
      'assistant-delta',
      'assistant-done',
    ]);
    const deltas = events
      .filter(
        (e): e is Extract<SessionEvent, { type: 'assistant-delta' }> =>
          e.type === 'assistant-delta',
      )
      .map((e) => e.delta);
    expect(deltas).toEqual(['你好，', '世界']);
    const last = events.at(-1);
    expect(last?.type).toBe('assistant-done');
    if (last?.type === 'assistant-done') {
      expect(last.message.content).toBe('你好，世界');
    }

    // 消息落库：user + assistant
    expect(
      persistence.listMessages('session-1').map((m) => [m.role, m.content]),
    ).toEqual([
      ['user', '打个招呼'],
      ['assistant', '你好，世界'],
    ]);

    // 会话记录：模型选择已持久化，状态回到 idle
    const stored = persistence.listSessions().at(0);
    expect(stored?.providerProfileId).toBe('profile-1');
    expect(stored?.model).toBe('glm-4.7');
    expect(stored?.status).toBe('idle');
  });

  it('多轮上下文保持：第二轮请求携带第一轮的 user 与 assistant 消息', async () => {
    const persistence = createSqliteSessionStore(':memory:');
    const record = sessionRecord();
    persistence.insertSession(record);
    const model = scriptedModel([
      { deltas: ['第一轮回答'] },
      { deltas: ['第二轮回答'] },
    ]);

    const session = createAgentSession({
      record,
      persistence,
      languageModelFor: () => model,
      now: fakeClock(),
    });

    await collect(session.sendMessage({ text: '第一问', profile }));
    await collect(session.sendMessage({ text: '第二问', profile }));

    // 第二次调用的 prompt 序列化后包含第一轮完整往返
    expect(model.doStreamCalls).toHaveLength(2);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain('第一问');
    expect(secondPrompt).toContain('第一轮回答');
    expect(secondPrompt).toContain('第二问');

    // 恢复场景：用同库重建会话（等价应用重启后续聊），历史仍然续上
    const restored = createAgentSession({
      record: persistence.listSessions().at(0)!,
      persistence,
      history: persistence.listMessages('session-1'),
      languageModelFor: () => model,
      now: fakeClock(),
    });
    await collect(restored.sendMessage({ text: '重启后的第三问', profile }));
    const thirdPrompt = JSON.stringify(model.doStreamCalls[2]?.prompt);
    expect(thirdPrompt).toContain('第二问');
    expect(thirdPrompt).toContain('第二轮回答');
    expect(thirdPrompt).toContain('重启后的第三问');
  });

  it('流式中断（abort）：部分文本保留为助手消息，会话可继续发消息', async () => {
    const persistence = createSqliteSessionStore(':memory:');
    const record = sessionRecord();
    persistence.insertSession(record);
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (call++ === 0) {
          return { stream: gatedFirstDeltaStream(gate) };
        }
        return { stream: textStream(['中断后的新回答']) };
      },
    });

    const session = createAgentSession({
      record,
      persistence,
      languageModelFor: () => model,
      now: fakeClock(),
    });

    const controller = new AbortController();
    const events: SessionEvent[] = [];
    for await (const event of session.sendMessage({
      text: '慢慢说',
      profile,
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === 'assistant-delta') {
        controller.abort();
      }
    }
    openGate();

    expect(events.at(-1)?.type).toBe('assistant-aborted');
    const lastEvent = events.at(-1);
    if (lastEvent?.type === 'assistant-aborted') {
      expect(lastEvent.message.content).toBe('部分回复');
    }

    // 中断后落库的是部分文本；状态回 idle
    const messages = persistence.listMessages('session-1');
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '慢慢说'],
      ['assistant', '部分回复'],
    ]);
    expect(persistence.listSessions().at(0)?.status).toBe('idle');

    // 会话可继续：下一轮正常完成
    const second = await collect(
      session.sendMessage({ text: '再来一次', profile }),
    );
    const secondLast = second.at(-1);
    expect(secondLast?.type).toBe('assistant-done');
    if (secondLast?.type === 'assistant-done') {
      expect(secondLast.message.content).toBe('中断后的新回答');
    }
  });

  it('模型 API 出错：error 事件带中文提示并落库，error 不进上下文，会话可继续使用', async () => {
    const persistence = createSqliteSessionStore(':memory:');
    const record = sessionRecord();
    persistence.insertSession(record);
    const model = scriptedModel([
      {
        error: new APICallError({
          url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
          requestBodyValues: {},
          statusCode: 401,
          message: 'Unauthorized',
        }),
      },
      { deltas: ['恢复后的回答'] },
    ]);

    const session = createAgentSession({
      record,
      persistence,
      languageModelFor: () => model,
      now: fakeClock(),
    });

    const events = await collect(session.sendMessage({ text: '第一问', profile }));

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.message.role).toBe('error');
      expect(errorEvent.message.content).toContain('模型请求失败');
      expect(errorEvent.message.content).toContain('401');
    }

    // 落库：user + error（无 assistant）
    expect(
      persistence.listMessages('session-1').map((m) => [m.role, m.content]),
    ).toEqual([
      ['user', '第一问'],
      ['error', expect.stringContaining('模型请求失败')],
    ]);
    expect(persistence.listSessions().at(0)?.status).toBe('idle');

    // 会话可继续使用，且 error 提示不进入第二轮上下文
    const second = await collect(session.sendMessage({ text: '第二问', profile }));
    expect(second.at(-1)?.type).toBe('assistant-done');
    expect(
      persistence.listMessages('session-1').map((m) => m.role),
    ).toEqual(['user', 'error', 'user', 'assistant']);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain('第二问');
    expect(secondPrompt).not.toContain('模型请求失败');
  });

  it('同一会话流式进行中拒绝并发发送', async () => {
    const persistence = createSqliteSessionStore(':memory:');
    const record = sessionRecord();
    persistence.insertSession(record);
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (call++ === 0) {
          return { stream: gatedFirstDeltaStream(gate) };
        }
        return { stream: textStream(['ok']) };
      },
    });

    const session = createAgentSession({
      record,
      persistence,
      languageModelFor: () => model,
      now: fakeClock(),
    });

    const first = session.sendMessage({ text: '慢消息', profile });
    const firstIterator = first[Symbol.asyncIterator]();
    await firstIterator.next(); // user-message 事件已产出，会话进入 streaming

    await expect(
      collect(session.sendMessage({ text: '并发消息', profile })),
    ).rejects.toThrow('仍在回复中');

    openGate();
    // 消费完第一个流，会话回到可用状态
    let last: SessionEvent | undefined;
    for (let head = await firstIterator.next(); !head.done; head = await firstIterator.next()) {
      last = head.value;
    }
    expect(last?.type).toBe('assistant-done');
  });
});
