import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import type { ProviderProfile } from '../../src/provider/provider-profile';
import { createSqliteSessionStore } from '../../src/session/persistence';
import { createAgentSession } from '../../src/session/agent-session';
import type { SessionEvent, SessionRecord } from '../../src/session/types';
import { createBuiltinTools } from '../../src/tools/builtin';

/**
 * 会话快照恢复等价性（工单 06 AC：恢复后「继续」在既有历史上续跑，上下文与原一致）。
 * 接缝：createAgentSession 公共接口——给定含工具轮次、@引用、被中断回复的完整历史，
 * 「重启恢复后续跑」发给模型的 prompt 必须与「不重启直接续跑」完全一致。
 */
const profile: ProviderProfile = {
  id: 'profile-1',
  name: 'GLM',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-test',
  model: 'glm-4.7',
};

function sessionRecord(workspacePath: string): SessionRecord {
  return {
    id: 'session-1',
    title: 'demo',
    workspacePath,
    providerProfileId: null,
    model: null,
    status: 'idle',
    archivedAt: null,
    createdAt: '2026-11-11T08:00:00.000Z',
    updatedAt: '2026-11-11T08:00:00.000Z',
  };
}

function usage() {
  return {
    inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: undefined, reasoning: undefined },
  };
}

function finishReason(unified: 'stop' | 'tool-calls') {
  return { unified, raw: unified === 'stop' ? 'stop' : 'tool_calls' } as const;
}

function textRound(deltas: string[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-start', id: 'text-1' });
      for (const delta of deltas) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta });
      }
      controller.enqueue({ type: 'text-end', id: 'text-1' });
      controller.enqueue({
        type: 'finish',
        usage: usage(),
        finishReason: finishReason('stop'),
      });
      controller.close();
    },
  });
}

function toolCallRound(calls: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}[]) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const call of calls) {
        controller.enqueue({
          type: 'tool-call',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        });
      }
      controller.enqueue({
        type: 'finish',
        usage: usage(),
        finishReason: finishReason('tool-calls'),
      });
      controller.close();
    },
  });
}

type ScriptedStep =
  | { kind: 'text'; deltas: string[] }
  | { kind: 'tool'; calls: { toolCallId: string; toolName: string; input: unknown }[] }
  | { kind: 'gated-text'; deltas: string[] };

/** gated-text：产出 deltas 后挂起（等 gate 打开才继续），用于中断时序 */
function makeGatedStream(deltas: string[], gate: Promise<void>) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    async start(controller) {
      controller.enqueue({ type: 'text-start', id: 'text-1' });
      for (const delta of deltas) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta });
      }
      await gate;
      controller.enqueue({ type: 'text-delta', id: 'text-1', delta: '（不应出现）' });
      controller.enqueue({ type: 'text-end', id: 'text-1' });
      controller.enqueue({
        type: 'finish',
        usage: usage(),
        finishReason: finishReason('stop'),
      });
      controller.close();
    },
  });
}

function scriptedModel(steps: ScriptedStep[], gate?: Promise<void>) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(call++, steps.length - 1)]!;
      if (step.kind === 'text') {
        return { stream: textRound(step.deltas) };
      }
      if (step.kind === 'gated-text') {
        return { stream: makeGatedStream(step.deltas, gate!) };
      }
      return { stream: toolCallRound(step.calls) };
    },
  });
}

function fakeClock() {
  let tick = 0;
  return () => `2026-11-11T08:00:${String(++tick).padStart(2, '0')}.000Z`;
}

async function collect(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe('会话快照恢复等价性', () => {
  it('含工具轮次、@引用与被中断回复的历史：重启恢复后续跑的模型上下文与不重启续跑完全一致', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-resume-'));
    const persistence = createSqliteSessionStore(':memory:');
    const base = sessionRecord(workspace);
    persistence.insertSession(base);
    const tools = createBuiltinTools({ env: {} });

    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    // 历史：① 工具轮（write_file）→ 最终回复；② 带中断的流
    const historyModel = scriptedModel(
      [
        {
          kind: 'tool',
          calls: [
            { toolCallId: 'call-1', toolName: 'write_file', input: { path: 'a.txt', content: '材料内容' } },
          ],
        },
        { kind: 'text', deltas: ['已写入 a.txt'] },
        { kind: 'gated-text', deltas: ['被打断的部分'] },
      ],
      gate,
    );

    // 原会话的模型可切换：跑历史用 historyModel，续跑换 inPlaceModel（记录原地续跑的 prompt）
    const resumedInPlace = scriptedModel([{ kind: 'text', deltas: ['原地续跑'] }]);
    let activeModel = historyModel;
    const session = createAgentSession({
      record: base,
      persistence,
      tools,
      languageModelFor: () => activeModel,
      now: fakeClock(),
    });

    // 第 1 轮：@引用 附件 + 工具调用
    await collect(
      session.sendMessage({
        text: '读取材料并写入 a.txt',
        profile,
        mentions: [{ path: 'material.txt', content: '被引用的文件内容' }],
      }),
    );
    // 第 2 轮：流式中断
    const controller = new AbortController();
    for await (const event of session.sendMessage({ text: '慢慢说', profile, signal: controller.signal })) {
      if (event.type === 'assistant-delta') {
        controller.abort();
      }
    }
    openGate();

    // 恢复会话在历史定格时构造（等价应用重启：读库重建上下文）
    const restoredRecord = persistence.listSessions().at(0)!;
    expect(restoredRecord.providerProfileId).toBe('profile-1');
    expect(restoredRecord.model).toBe('glm-4.7');

    const resumedAfterRestart = scriptedModel([{ kind: 'text', deltas: ['恢复后续跑'] }]);
    const restoredSession = createAgentSession({
      record: restoredRecord,
      persistence,
      history: persistence.listMessages('session-1'),
      tools,
      languageModelFor: () => resumedAfterRestart,
      now: fakeClock(),
    });

    // 路径 A（不重启）：原会话对象直接续跑（内存上下文：含 @引用 组装后的 user 消息）
    activeModel = resumedInPlace;
    await collect(session.sendMessage({ text: '继续', profile }));

    // 路径 B（重启恢复）：恢复的会话续跑
    await collect(restoredSession.sendMessage({ text: '继续', profile }));

    // 两条路径发给模型的 prompt 必须完全一致（mentions 内容、工具轮、中断消息都不丢）
    expect(resumedAfterRestart.doStreamCalls).toHaveLength(1);
    expect(resumedInPlace.doStreamCalls).toHaveLength(1);
    expect(resumedInPlace.doStreamCalls[0]?.prompt).toEqual(
      resumedAfterRestart.doStreamCalls[0]?.prompt,
    );

    // 快照等价的实质：@引用 内容与中断前的历史都在恢复后的上下文里
    const promptJson = JSON.stringify(resumedAfterRestart.doStreamCalls[0]?.prompt);
    expect(promptJson).toContain('被引用的文件内容');
    expect(promptJson).toContain('读取材料并写入 a.txt');
    expect(promptJson).toContain('已写入 a.txt');
    expect(promptJson).toContain('被打断的部分');
    expect(promptJson).toContain('慢慢说');
    expect(promptJson).toContain('继续');
  });
});
