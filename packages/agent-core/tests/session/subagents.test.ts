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

const profile: ProviderProfile = {
  id: 'main-profile',
  name: 'GLM',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-test',
  model: 'glm-4.7',
};

/** 子代理专用 Profile（设置页「子代理模型」引用；默认 null = 同主模型） */
const subProfile: ProviderProfile = {
  id: 'sub-profile',
  name: 'GLM 子代理',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-sub',
  model: 'glm-4.7-air',
};

function sessionRecord(workspacePath: string): SessionRecord {
  return {
    id: 'session-1',
    title: 'demo',
    workspacePath,
    providerProfileId: null,
    model: null,
    status: 'idle',
    approvalMode: 'suggest',
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

function finishPart(reason: 'stop' | 'tool-calls' = 'stop') {
  return {
    usage: usage(),
    finishReason: { unified: reason, raw: reason === 'stop' ? 'stop' : 'tool_calls' },
  };
}

/** 文本轮流式（ai v7：text-start/delta/end 包裹，前人踩坑） */
function textRound(deltas: string[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-start', id: 'text-1' });
      for (const delta of deltas) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta });
      }
      controller.enqueue({ type: 'text-end', id: 'text-1' });
      controller.enqueue({ type: 'finish', ...finishPart() });
      controller.close();
    },
  });
}

/** 工具调用轮流式（finishReason 为 tool-calls，工具由循环执行后回填） */
function toolCallRound(toolCalls: { toolCallId: string; toolName: string; input: unknown }[]) {
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const call of toolCalls) {
        controller.enqueue({
          type: 'tool-call',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        });
      }
      controller.enqueue({ type: 'finish', ...finishPart('tool-calls') });
      controller.close();
    },
  });
  return { stream };
}

type ScriptedStep =
  | { kind: 'text'; deltas: string[] }
  | { kind: 'tool'; calls: { toolCallId: string; toolName: string; input: unknown }[] };

function scriptedModel(steps: ScriptedStep[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(call++, steps.length - 1)]!;
      if (step.kind === 'tool') {
        return toolCallRound(step.calls);
      }
      return { stream: textRound(step.deltas) };
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

interface SubagentHarnessOptions {
  workspacePath: string;
  /** 主模型脚本 */
  main: ScriptedStep[];
  /** 子代理模型脚本（每个子代理共用同一 mock 实例，按调用次序消费） */
  sub?: ScriptedStep[];
  /** 子代理 Profile 解析（缺省固定返回 sub-profile） */
  resolveProfile?: () => Promise<ProviderProfile | null>;
  /** 并发上限（缺省 3） */
  maxConcurrent?: number;
  /** 审批模式 */
  approvalMode?: SessionRecord['approvalMode'];
}

/**
 * 装配带子代理的会话：主/子模型用不同 mock（profile.id 区分），
 * 工具集为内置六件（不含 spawn_subagent，由会话按 subagents 配置追加）。
 */
function makeSubagentSession(options: SubagentHarnessOptions) {
  const mainModel = scriptedModel(options.main);
  const subModel = scriptedModel(options.sub ?? [{ kind: 'text', deltas: ['子代理默认报告'] }]);
  const persistence = createSqliteSessionStore(':memory:');
  const record = sessionRecord(options.workspacePath);
  record.approvalMode = options.approvalMode ?? 'suggest';
  persistence.insertSession(record);
  const session = createAgentSession({
    record,
    persistence,
    history: persistence.listMessages(record.id),
    languageModelFor: (p) => (p.id === subProfile.id ? subModel : mainModel),
    tools: createBuiltinTools(),
    subagents: {
      // 子代理可用工具：内置六件（实现侧必须剔除 spawn_subagent 防递归）
      tools: createBuiltinTools(),
      languageModelFor: (p) => (p.id === subProfile.id ? subModel : mainModel),
      settings: () => ({ maxConcurrent: options.maxConcurrent ?? 3 }),
      resolveProfile:
        options.resolveProfile ?? (async () => subProfile),
    },
    now: fakeClock(),
  });
  return { session, persistence, mainModel, subModel };
}

describe('子代理（spawn_subagent，GLOSSARY「子代理」）', () => {
  it('委派调研任务：子代理独立完成并以文本报告回流主会话上下文', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const { session, persistence, mainModel, subModel } = makeSubagentSession({
      workspacePath: workspace,
      main: [
        {
          kind: 'tool',
          calls: [
            {
              toolCallId: 'delegate-1',
              toolName: 'spawn_subagent',
              input: { task: '调研本仓库的测试框架并总结' },
            },
          ],
        },
        { kind: 'text', deltas: ['子代理的调研结论已收到'] },
      ],
      sub: [{ kind: 'text', deltas: ['调研报告：本项目使用 vitest，共 200 个用例。'] }],
    });

    const events = await collect(
      session.sendMessage({ text: '帮我调研一下测试框架', profile }),
    );

    // 子代理模型被真实调用（独立上下文，一次 doStream 出报告）
    expect(subModel.doStreamCalls).toHaveLength(1);
    const subPrompt = subModel.doStreamCalls[0]!.prompt;
    // 独立上下文：含任务描述，不含主会话消息原文
    const subPromptJson = JSON.stringify(subPrompt);
    expect(subPromptJson).toContain('调研本仓库的测试框架并总结');
    expect(subPromptJson).not.toContain('帮我调研一下测试框架');

    // 报告作为工具结果回流：spawn_subagent 卡片的 output 是报告文本
    const resultEvent = events.find(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> =>
        e.type === 'tool-result' && e.call.toolName === 'spawn_subagent',
    );
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.call.isError).toBe(false);
    expect(resultEvent!.call.output).toContain('调研报告：本项目使用 vitest');

    // 主模型第二轮收到报告（作为 spawn_subagent 的工具结果）
    expect(mainModel.doStreamCalls).toHaveLength(2);
    const secondPrompt = JSON.stringify(mainModel.doStreamCalls[1]!.prompt);
    expect(secondPrompt).toContain('调研报告：本项目使用 vitest');

    // 主会话正常收尾，子代理调用记录落库（报告随 output 持久化）
    expect(events.at(-1)?.type).toBe('assistant-done');
    const stored = persistence
      .listToolCalls('session-1')
      .find((c) => c.toolName === 'spawn_subagent');
    expect(stored?.output).toContain('调研报告：本项目使用 vitest');
  });

  it('防递归：子代理工具集不含 spawn_subagent，子代理尝试再委派返回可读错误', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const { session, subModel } = makeSubagentSession({
      workspacePath: workspace,
      main: [
        {
          kind: 'tool',
          calls: [{ toolCallId: 'd1', toolName: 'spawn_subagent', input: { task: '再委派一次试试' } }],
        },
        { kind: 'text', deltas: ['收到'] },
      ],
      // 子代理模型第一轮尝试调 spawn_subagent（应被当作未注册工具回填），第二轮出报告
      sub: [
        {
          kind: 'tool',
          calls: [{ toolCallId: 'sub-c1', toolName: 'spawn_subagent', input: { task: '套娃' } }],
        },
        { kind: 'text', deltas: ['子代理无法再委派，直接报告'] },
      ],
    });

    const events = await collect(session.sendMessage({ text: '去调研', profile }));

    // 子代理模型的工具表不含 spawn_subagent（doStream 调用参数的 tools 里没有该名）
    const subCall = subModel.doStreamCalls[0] as { tools?: { name?: string }[] };
    const toolNames = (subCall.tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain('spawn_subagent');
    expect(toolNames).toContain('read_file');

    // 行为断言：子代理尝试调用 → 「未注册」错误回填子代理 → 子代理继续到最终报告
    const subToolEvents = events.filter(
      (e): e is Extract<SessionEvent, { type: 'subagent-tool' }> => e.type === 'subagent-tool',
    );
    const rejected = subToolEvents.find((e) => e.phase === 'result' && e.call.toolName === 'spawn_subagent');
    expect(rejected?.call.isError).toBe(true);
    expect(rejected?.call.output).toContain('未注册');

    // 子代理最终报告回流（未被套娃调用破坏），主会话正常收尾
    const reportEvent = events.find(
      (e): e is Extract<SessionEvent, { type: 'subagent-report' }> => e.type === 'subagent-report',
    );
    expect(reportEvent?.report).toContain('子代理无法再委派');
    expect(events.at(-1)?.type).toBe('assistant-done');
  });
});
