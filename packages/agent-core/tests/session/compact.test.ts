import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderProfile } from '../../src/provider/provider-profile';
import { createSqliteSessionStore } from '../../src/session/persistence';
import { createAgentSession } from '../../src/session/agent-session';
import type { SessionEvent, SessionRecord } from '../../src/session/types';

/**
 * 工单 08：/compact 手动压缩（GLOSSARY「Compact」）。
 * Seam：AgentSession.compact 公共接口 + SessionPersistence（库行为经 listMessages/listCompacts 观察）
 * + MockLanguageModelV4 的调用记录（注入模型的请求内容）。
 */
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
    workspaceMode: 'local',
    approvalMode: 'suggest',
    archivedAt: null,
    createdAt: '2026-11-11T08:00:00.000Z',
    updatedAt: '2026-11-11T08:00:00.000Z',
  };
}

/** ai v7 起流式文本必须包裹 text-start / text-end part */
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

/**
 * 提取 prompt 消息的纯文本：ai v7 传给 provider 层时 string content 会转为 parts 数组。
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: { text?: string }) => part.text ?? '')
      .join('');
  }
  return String(content);
}

/**
 * 脚本化双通道模型：doStream 服务对话轮次（每次调用回显轮号），
 * doGenerate 服务压缩请求（返回固定摘要）。调用记录供断言注入的 prompt。
 */
function compactableModel(summaryText: string) {
  let streamCall = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      streamCall += 1;
      return { stream: textStream([`第${streamCall}轮回复`]) };
    },
    doGenerate: async () => ({
      content: [{ type: 'text', text: summaryText }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
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
      warnings: [],
    }),
  });
}

/** 固定时钟 + 递增秒 */
function fakeClock() {
  let tick = 0;
  return () => `2026-11-11T08:00:${String(++tick).padStart(2, '0')}.000Z`;
}

const tempStores: ReturnType<typeof createSqliteSessionStore>[] = [];

function memoryStore() {
  const store = createSqliteSessionStore(':memory:');
  tempStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of tempStores.splice(0)) {
    store.close();
  }
});

/** 驱动 N 轮对话（user「第k轮问题」→ assistant「第k轮回复」） */
async function talkRounds(
  session: ReturnType<typeof createAgentSession>,
  rounds: number,
): Promise<void> {
  for (let i = 1; i <= rounds; i += 1) {
    const events: SessionEvent[] = [];
    for await (const event of session.sendMessage({
      text: `第${i}轮问题`,
      profile,
    })) {
      events.push(event);
    }
    expect(events.at(-1)?.type).toBe('assistant-done');
  }
}

describe('AgentSession.compact（手动压缩）', () => {
  it('压缩成功：摘要替换旧历史，仅保留最近 3 轮原始对话，compact 记录入库', async () => {
    const persistence = memoryStore();
    persistence.insertSession(sessionRecord());
    const model = compactableModel('此前对话的压缩摘要：修复了登录 bug。');
    const session = createAgentSession({
      record: sessionRecord(),
      persistence,
      history: [],
      languageModelFor: () => model,
      now: fakeClock(),
      generateId: (() => {
        let n = 0;
        return () => `id-${String(++n).padStart(3, '0')}`;
      })(),
    });

    await talkRounds(session, 5);

    const result = await session.compact({ profile });

    // 压缩请求确实带上了被压缩的旧历史（前 2 轮），且不含将被保留的后 3 轮
    const generateCall = model.doGenerateCalls.at(-1)!;
    expect(JSON.stringify(generateCall.prompt)).toContain('第1轮问题');
    expect(JSON.stringify(generateCall.prompt)).toContain('第2轮问题');
    expect(JSON.stringify(generateCall.prompt)).toContain('第2轮回复');
    expect(JSON.stringify(generateCall.prompt)).not.toContain('第4轮问题');

    // 库中消息历史 = 1 条摘要 + 最近 3 轮（6 条原文，顺序在前的是更早轮次）
    const stored = persistence.listMessages('session-1');
    expect(stored).toHaveLength(7);
    expect(stored[0]).toMatchObject({
      role: 'compact-summary',
      content: '此前对话的压缩摘要：修复了登录 bug。',
    });
    expect(stored.slice(1).map((m) => m.content)).toEqual([
      '第3轮问题',
      '第3轮回复',
      '第4轮问题',
      '第4轮回复',
      '第5轮问题',
      '第5轮回复',
    ]);

    // compact 记录入库
    const compacts = persistence.listCompacts('session-1');
    expect(compacts).toHaveLength(1);
    expect(compacts[0]).toMatchObject({
      sessionId: 'session-1',
      summary: '此前对话的压缩摘要：修复了登录 bug。',
      messagesCompacted: 4,
    });

    // 返回值：被压缩条数与保留轮次
    expect(result.compactedMessages).toBe(4);
    expect(result.keptMessages).toHaveLength(6);
    expect(result.summaryMessage.role).toBe('compact-summary');
  });

  it('压缩后继续对话：注入模型的消息序列 = 摘要（包装 user）+ 最近 3 轮 + 新消息', async () => {
    const persistence = memoryStore();
    persistence.insertSession(sessionRecord());
    const model = compactableModel('压缩摘要：调通了安装流程。');
    const session = createAgentSession({
      record: sessionRecord(),
      persistence,
      history: [],
      languageModelFor: () => model,
      now: fakeClock(),
      generateId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });

    await talkRounds(session, 4);
    const streamCallsBefore = model.doStreamCalls.length;
    await session.compact({ profile });

    for await (const event of session.sendMessage({ text: '继续', profile })) {
      expect(event.type).not.toBe('error');
    }

    const lastCall = model.doStreamCalls.at(-1)!;
    expect(model.doStreamCalls.length).toBe(streamCallsBefore + 1);
    // 结构断言（避免 JSON.stringify 转义问题）：
    // [摘要 user, 第2轮 u/a, 第3轮 u/a, 第4轮 u/a, 新消息 user]
    expect(lastCall.prompt).toHaveLength(8);
    expect(lastCall.prompt.map((m) => m.role)).toEqual([
      'user',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(textOf(lastCall.prompt[0]!.content)).toContain('<compact-summary>');
    expect(textOf(lastCall.prompt[0]!.content)).toContain('压缩摘要：调通了安装流程。');
    expect(lastCall.prompt.slice(1, 7).map((m) => textOf(m.content))).toEqual([
      '第2轮问题',
      '第2轮回复',
      '第3轮问题',
      '第3轮回复',
      '第4轮问题',
      '第4轮回复',
    ]);
    expect(textOf(lastCall.prompt[7]!.content)).toBe('继续');
  });

  it('压缩请求失败：原历史与上下文不受损，可重试且成功', async () => {
    const persistence = memoryStore();
    persistence.insertSession(sessionRecord());
    let failFirst = true;
    let streamCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamCall += 1;
        return { stream: textStream([`第${streamCall}轮回复`]) };
      },
      doGenerate: async () => {
        if (failFirst) {
          failFirst = false;
          // 401（不可自动重试类）：SDK 对 5xx 会先自动重试，测试要观察「失败→可重试」
          throw new APICallError({
            message: 'boom',
            url: 'https://example.com',
            requestBodyValues: {},
            statusCode: 401,
            responseBody: '',
          });
        }
        return {
          content: [{ type: 'text', text: '重试后的摘要' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 2, text: undefined, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const session = createAgentSession({
      record: sessionRecord(),
      persistence,
      history: [],
      languageModelFor: () => model,
      now: fakeClock(),
      generateId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });

    await talkRounds(session, 5);
    const before = persistence.listMessages('session-1');

    await expect(session.compact({ profile })).rejects.toThrow('模型请求失败（HTTP 401）');

    // 原历史不受损：库与 compact 记录原样
    expect(persistence.listMessages('session-1')).toEqual(before);
    expect(persistence.listCompacts('session-1')).toEqual([]);

    // 可重试：第二次成功，替换生效
    await session.compact({ profile });
    expect(persistence.listMessages('session-1')[0]).toMatchObject({
      role: 'compact-summary',
      content: '重试后的摘要',
    });
  });

  it('互斥：压缩进行中不可发送/重复压缩；回复中不可压缩', async () => {
    const persistence = memoryStore();
    persistence.insertSession(sessionRecord());
    let releaseGenerate: (() => void) | null = null;
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: textStream(['回复']) }),
      doGenerate: async () => {
        await new Promise<void>((resolve) => {
          releaseGenerate = resolve;
        });
        return {
          content: [{ type: 'text', text: '摘要' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 2, text: undefined, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const session = createAgentSession({
      record: sessionRecord(),
      persistence,
      history: [],
      languageModelFor: () => model,
      now: fakeClock(),
      generateId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });

    await talkRounds(session, 4);
    const compacting = session.compact({ profile });
    // 压缩挂起（doGenerate 未返回）时：发送与再次压缩都被拒绝
    await expect(session.compact({ profile })).rejects.toThrow('正在回复或压缩中');
    const sending = session.sendMessage({ text: '插队', profile });
    const sendDone = (async () => {
      for await (const event of sending) {
        void event;
      }
    })();
    // 等 sendMessage 启动抛错（busy 拒绝是同步 throw，出现于迭代启动时）
    await expect(sendDone).rejects.toThrow('仍在回复中');
    // 等压缩请求真正挂起在 doGenerate 上再放行（闭包内赋值，as 绕过 TS 收窄）
    while (releaseGenerate === null) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const release = releaseGenerate as () => void;
    release();
    await compacting;

    // 压缩完成后可正常发送
    for await (const event of session.sendMessage({ text: '继续', profile })) {
      expect(event.type).not.toBe('error');
    }
  });

  it('历史过短（≤3 轮）：中文提示且不动库', async () => {
    const persistence = memoryStore();
    persistence.insertSession(sessionRecord());
    const model = compactableModel('摘要');
    const session = createAgentSession({
      record: sessionRecord(),
      persistence,
      history: [],
      languageModelFor: () => model,
      now: fakeClock(),
      generateId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });

    await talkRounds(session, 3);
    await expect(session.compact({ profile })).rejects.toThrow('没有可压缩的内容');
    expect(persistence.listMessages('session-1')).toHaveLength(6);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('重启等价：压缩后经持久层恢复的上下文与压缩后立即发送一致（含 @引用 保留轮次）', async () => {
    const persistence = memoryStore();
    persistence.insertSession(sessionRecord());
    const summary = '修复了打包脚本';
    let streamCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        streamCall += 1;
        return { stream: textStream([`第${streamCall}轮回复`]) };
      },
      doGenerate: async () => ({
        content: [{ type: 'text', text: summary }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 2, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const session = createAgentSession({
      record: sessionRecord(),
      persistence,
      history: [],
      languageModelFor: () => model,
      now: fakeClock(),
      generateId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });

    // 4 轮对话；第 4 轮带 @引用（将落入保留的最近 3 轮内）
    for (let i = 1; i <= 3; i += 1) {
      for await (const event of session.sendMessage({ text: `第${i}轮问题`, profile })) {
        expect(event.type).not.toBe('error');
      }
    }
    for await (const event of session.sendMessage({
      text: '第4轮问题',
      profile,
      mentions: [{ path: 'docs/说明.md', content: '被引用的文件内容' }],
    })) {
      expect(event.type).not.toBe('error');
    }

    await session.compact({ profile });

    // 压缩后立即发送：保留轮次的 @引用 附加内容仍在内存上下文中
    for await (const event of session.sendMessage({ text: '压缩后立即', profile })) {
      expect(event.type).not.toBe('error');
    }
    const immediateCall = model.doStreamCalls.at(-1)!;
    expect(textOf(immediateCall.prompt[5]!.content)).toContain('被引用的文件内容');

    // 等价重启：同一持久层重建会话（manager.get 的恢复路径）
    const restored = createAgentSession({
      record: sessionRecord(),
      persistence,
      history: persistence.listMessages('session-1'),
      languageModelFor: () => model,
      now: fakeClock(),
      generateId: (() => {
        let n = 100;
        return () => `id-${++n}`;
      })(),
    });

    for await (const event of restored.sendMessage({ text: '重启后继续', profile })) {
      expect(event.type).not.toBe('error');
    }
    const lastCall = model.doStreamCalls.at(-1)!;
    // 恢复后的上下文 = 摘要 + 3 轮原文 + 新消息。工单 06 起 @引用 随消息持久化：
    // 保留轮次里的第 4 轮恢复后重组附加内容（与压缩后立即发送的内存上下文一致，快照等价）
    expect(textOf(lastCall.prompt[0]!.content)).toContain('<compact-summary>');
    expect(textOf(lastCall.prompt[0]!.content)).toContain(summary);
    expect(lastCall.prompt.slice(1, 7).map((m) => textOf(m.content))).toEqual([
      '第2轮问题',
      '第2轮回复',
      '第3轮问题',
      '第3轮回复',
      '第4轮问题\n\n以下为该消息 @引用 的工作区文件内容：\n\n<attached-file path="docs/说明.md">\n被引用的文件内容\n</attached-file>',
      '第4轮回复',
    ]);
    expect(textOf(lastCall.prompt[9]!.content)).toBe('重启后继续');
  });
});

describe('compact 与工具调用记录的合并融合（工单 03+08）', () => {
  it('压缩落地时同步清理被压缩轮次的工具调用记录（保留轮次的不动）', async () => {
    const persistence = memoryStore();
    persistence.insertSession(sessionRecord());
    const summary = '含工具调用的压缩摘要';
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: textStream(['回复']) }),
      doGenerate: async () => ({
        content: [{ type: 'text', text: summary }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 2, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const session = createAgentSession({
      record: sessionRecord(),
      persistence,
      history: [],
      languageModelFor: () => model,
      now: fakeClock(),
      generateId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });

    // 5 轮对话，第 1、2 轮带工具调用记录（模拟 03 的 insertToolCall）
    for (let i = 1; i <= 5; i += 1) {
      for await (const event of session.sendMessage({ text: `第${i}轮问题`, profile })) {
        expect(event.type).not.toBe('error');
      }
    }
    const stored = persistence.listMessages('session-1');
    const secondRoundEndAt = stored.filter((m) => m.role === 'assistant')[1]!.createdAt;
    persistence.insertToolCall({
      id: 'tc-1',
      sessionId: 'session-1',
      toolName: 'read_file',
      arguments: '{}',
      output: '第1轮的读取结果',
      isError: false,
      createdAt: secondRoundEndAt,
    });
    persistence.insertToolCall({
      id: 'tc-2',
      sessionId: 'session-1',
      toolName: 'read_file',
      arguments: '{}',
      output: '第2轮的读取结果',
      isError: false,
      createdAt: secondRoundEndAt,
    });
    // 保留轮次（第 3 轮内）的工具调用：晚于第 3 轮 user 消息
    persistence.insertToolCall({
      id: 'tc-3',
      sessionId: 'session-1',
      toolName: 'grep',
      arguments: '{}',
      output: '第3轮的搜索结果',
      isError: false,
      createdAt: stored.filter((m) => m.role === 'user')[3]!.createdAt,
    });
    expect(persistence.listToolCalls('session-1')).toHaveLength(3);

    await session.compact({ profile });

    // 被压缩轮次（1、2）的工具调用清理；保留轮次（3）的不动
    const remaining = persistence.listToolCalls('session-1');
    expect(remaining.map((call) => call.id)).toEqual(['tc-3']);
  });
});
