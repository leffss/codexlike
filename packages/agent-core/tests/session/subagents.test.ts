import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

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
    workspaceMode: 'local',
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
  /** 直接注入子代理模型（与 sub 脚本二选一；用于受控挂起等复杂场景） */
  subModel?: MockLanguageModelV4;
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
  const subModel =
    options.subModel ??
    scriptedModel(options.sub ?? [{ kind: 'text', deltas: ['子代理默认报告'] }]);
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

  it('并发上限 3：第 4 个委派排队（FIFO），有空位后开跑；全部完成后报告各自回流', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));

    // 受控子模型：每个子代理的 doStream 挂起直至测试放行（gate），
    // 释放后返回带编号的报告——并发数 = 模型调用数，可精确观察
    const releases: (() => void)[] = [];
    let callSeq = 0;
    const subModel = new MockLanguageModelV4({
      doStream: async () => {
        const index = callSeq++;
        const stream = new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            await new Promise<void>((resolve) => {
              releases[index] = resolve;
            });
            controller.enqueue({ type: 'text-start', id: 'text-1' });
            controller.enqueue({
              type: 'text-delta',
              id: 'text-1',
              delta: `子代理 ${index} 的调研报告`,
            });
            controller.enqueue({ type: 'text-end', id: 'text-1' });
            controller.enqueue({ type: 'finish', ...finishPart() });
            controller.close();
          },
        });
        return { stream };
      },
    });

    const { session, mainModel } = makeSubagentSession({
      workspacePath: workspace,
      main: [
        {
          kind: 'tool',
          calls: [1, 2, 3, 4].map((n) => ({
            toolCallId: `delegate-${n}`,
            toolName: 'spawn_subagent',
            input: { task: `任务 ${n}` },
          })),
        },
        { kind: 'text', deltas: ['四份报告都收到'] },
      ],
      subModel,
    });

    const events: SessionEvent[] = [];
    const iterator = session.sendMessage({
      text: '并行调研四件事',
      profile,
    })[Symbol.asyncIterator]();

    // 推进到 4 个委派全部派发（第 4 个 queued 事件即证据：前 3 个已 start）
    async function drainUntil(predicate: (event: SessionEvent) => boolean): Promise<void> {
      for (let head = await iterator.next(); !head.done; head = await iterator.next()) {
        events.push(head.value);
        if (predicate(head.value)) {
          return;
        }
      }
    }

    await drainUntil(
      (event) =>
        event.type === 'subagent-queued' &&
        events.filter((e) => e.type === 'subagent-queued').length === 4,
    );

    // 前 3 个并发运行（模型调用 = 3），第 4 个排队（无第 4 次模型调用）。
    // 模型调用发生在 resolveProfile 微任务后，用 waitFor 等其稳定。
    await vi.waitFor(() => expect(subModel.doStreamCalls).toHaveLength(3));
    expect(events.filter((e) => e.type === 'subagent-start')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'subagent-report')).toHaveLength(0);

    // 释放第 0 个子代理：队列中的第 4 个立即占位开跑
    releases[0]!();
    await vi.waitFor(() => expect(subModel.doStreamCalls).toHaveLength(4));
    await drainUntil(
      (event) =>
        event.type === 'subagent-start' &&
        events.filter((e) => e.type === 'subagent-start').length === 4,
    );

    // 释放剩余全部：4 份报告各自回流为 tool-result，主会话收尾
    for (let i = 1; i < 4; i += 1) {
      releases[i]?.();
    }
    for (let head = await iterator.next(); !head.done; head = await iterator.next()) {
      events.push(head.value);
    }

    expect(events.filter((e) => e.type === 'subagent-report')).toHaveLength(4);
    const delegationResults = events.filter(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> =>
        e.type === 'tool-result' && e.call.toolName === 'spawn_subagent',
    );
    expect(delegationResults).toHaveLength(4);
    // 各委派的报告与 toolCallId 一一对应（delegate-1..4 按编号回流）
    for (const result of delegationResults) {
      const index = Number(result.call.id.slice(-1));
      expect(result.call.output).toContain(`子代理 ${index - 1} 的调研报告`);
      expect(result.call.isError).toBe(false);
    }
    // 主模型第二轮收到全部 4 份报告
    const secondPrompt = JSON.stringify(mainModel.doStreamCalls[1]?.prompt);
    for (let i = 0; i < 4; i += 1) {
      expect(secondPrompt).toContain(`子代理 ${i} 的调研报告`);
    }
    expect(events.at(-1)?.type).toBe('assistant-done');
  });

  it('readonly 传导：子代理的写入同样被拦截，文件不落盘且拒绝原因回流', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const { session } = makeSubagentSession({
      workspacePath: workspace,
      approvalMode: 'readonly',
      main: [
        {
          kind: 'tool',
          calls: [{ toolCallId: 'd1', toolName: 'spawn_subagent', input: { task: '写入一个文件' } }],
        },
        { kind: 'text', deltas: ['readonly 下子代理没能写入'] },
      ],
      // 子代理先尝试 write_file（应被拒），再返回报告
      sub: [
        {
          kind: 'tool',
          calls: [
            { toolCallId: 'sub-w', toolName: 'write_file', input: { path: 'secret.txt', content: 'x' } },
          ],
        },
        { kind: 'text', deltas: ['写入被审批策略拒绝，改用只读手段完成了调研'] },
      ],
    });

    const events = await collect(session.sendMessage({ text: '让子代理写文件', profile }));

    // 子代理的 write_file 被真实拦截：subagent-tool 结果为拒绝，文件不落盘
    const writeResult = events.find(
      (e): e is Extract<SessionEvent, { type: 'subagent-tool' }> =>
        e.type === 'subagent-tool' &&
        e.phase === 'result' &&
        e.call.toolName === 'write_file',
    );
    expect(writeResult?.call.isError).toBe(true);
    expect(writeResult?.call.output).toContain('readonly');
    expect(existsSync(join(workspace, 'secret.txt'))).toBe(false);

    // 委派本身放行（readonly 不禁调研），子代理报告正常回流
    const delegation = events.find(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> =>
        e.type === 'tool-result' && e.call.toolName === 'spawn_subagent',
    );
    expect(delegation?.call.isError).toBe(false);
    expect(delegation?.call.output).toContain('写入被审批策略拒绝');
    expect(events.at(-1)?.type).toBe('assistant-done');
  });

  it('子代理模型失败：失败原因回流为 isError 结果，主会话不崩并继续到最终回复', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    // 子模型直接抛 401（不可重试类错误）
    const subModel = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: 'Incorrect API key provided',
          url: 'https://api.example.com/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 401,
          responseBody: 'Unauthorized',
        });
      },
    });
    const { session, persistence } = makeSubagentSession({
      workspacePath: workspace,
      main: [
        {
          kind: 'tool',
          calls: [{ toolCallId: 'd1', toolName: 'spawn_subagent', input: { task: '查点资料' } }],
        },
        { kind: 'text', deltas: ['子代理失败了，我自己来'] },
      ],
      subModel,
    });

    const events = await collect(session.sendMessage({ text: '委派失败场景', profile }));

    // 失败以 isError 工具结果回流（中文原因），subagent-report 标记失败
    const delegation = events.find(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> =>
        e.type === 'tool-result' && e.call.toolName === 'spawn_subagent',
    );
    expect(delegation?.call.isError).toBe(true);
    expect(delegation?.call.output).toContain('子代理执行失败');
    const report = events.find(
      (e): e is Extract<SessionEvent, { type: 'subagent-report' }> => e.type === 'subagent-report',
    );
    expect(report?.ok).toBe(false);

    // 主会话不崩：正常收尾、无 error 事件、会话状态回 idle
    expect(events.at(-1)?.type).toBe('assistant-done');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    const stored = persistence
      .listToolCalls('session-1')
      .find((c) => c.toolName === 'spawn_subagent');
    expect(stored?.isError).toBe(true);
  });

  it('suggest 传导：子代理的终端命令弹审批卡片，批准后执行且 always 记忆随会话入库', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const { session, persistence } = makeSubagentSession({
      workspacePath: workspace,
      approvalMode: 'suggest',
      main: [
        {
          kind: 'tool',
          calls: [{ toolCallId: 'd1', toolName: 'spawn_subagent', input: { task: '跑一条命令' } }],
        },
        { kind: 'text', deltas: ['子代理执行完了'] },
      ],
      sub: [
        {
          kind: 'tool',
          calls: [
            {
              toolCallId: 'sub-t',
              toolName: 'run_terminal_command',
              input: { command: 'echo sub-agent-ran > ran.txt' },
            },
          ],
        },
        { kind: 'text', deltas: ['命令已执行，产物在 ran.txt'] },
      ],
    });

    const events: SessionEvent[] = [];
    const iterator = session.sendMessage({ text: '委派跑命令', profile })[
      Symbol.asyncIterator
    ]();

    // 推进到子代理的审批请求（approval-request 带 subagentId）
    let approvalRequest: Extract<SessionEvent, { type: 'approval-request' }> | null = null;
    for (let head = await iterator.next(); !head.done; head = await iterator.next()) {
      events.push(head.value);
      if (head.value.type === 'approval-request') {
        approvalRequest = head.value;
        break;
      }
    }
    expect(approvalRequest).not.toBeNull();
    expect(approvalRequest!.request.subagentId).toBeDefined();
    expect(approvalRequest!.request.command).toContain('echo sub-agent-ran');

    // id 不匹配的响应返回 false；always 批准生效并记忆命令首词
    expect(session.respondApproval('not-the-id', 'approve')).toBe(false);
    expect(session.respondApproval(approvalRequest!.request.id, 'always')).toBe(true);

    // 消费剩余事件：审批卡片转结果态、命令真实执行、报告回流、主会话收尾
    for (let head = await iterator.next(); !head.done; head = await iterator.next()) {
      events.push(head.value);
    }
    expect(
      events.some(
        (e) =>
          e.type === 'approval-resolved' && e.requestId === approvalRequest!.request.id,
      ),
    ).toBe(true);
    expect(readFileSync(join(workspace, 'ran.txt'), 'utf8')).toBe('sub-agent-ran\n');

    // always 记忆随会话入库（恢复后子代理/主会话同首词命令均免审批）
    expect(persistence.listApprovals('session-1')).toContain('echo');
    expect(events.at(-1)?.type).toBe('assistant-done');
  });

  it('主会话中断：运行中的子代理随 AbortSignal 一并中止，主会话以中断态收尾', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    // 挂起子模型：中断前一直挂着；abort signal 到达时以 AbortError 终止流
    // （模拟真实 provider 流对 abortSignal 的响应——MockLanguageModelV4 不会自动做）
    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const subModel = new MockLanguageModelV4({
      doStream: async (options) => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            const onAbort = () =>
              controller.error(new DOMException('Aborted', 'AbortError'));
            const signal = options.abortSignal;
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            await gate;
            signal?.removeEventListener('abort', onAbort);
            controller.enqueue({ type: 'text-start', id: 'text-1' });
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: '不应到达' });
            controller.enqueue({ type: 'text-end', id: 'text-1' });
            controller.enqueue({ type: 'finish', ...finishPart() });
            controller.close();
          },
        }),
      }),
    });
    const { session } = makeSubagentSession({
      workspacePath: workspace,
      main: [
        {
          kind: 'tool',
          calls: [{ toolCallId: 'd1', toolName: 'spawn_subagent', input: { task: '长调研' } }],
        },
        { kind: 'text', deltas: ['汇总'] },
      ],
      subModel,
    });

    const controller = new AbortController();
    const events: SessionEvent[] = [];
    const iterator = session.sendMessage({
      text: '委派后中断',
      profile,
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    // 推进到子代理开跑
    for (let head = await iterator.next(); !head.done; head = await iterator.next()) {
      events.push(head.value);
      if (head.value.type === 'subagent-start') {
        break;
      }
    }
    expect(events.some((e) => e.type === 'subagent-start')).toBe(true);

    // 中断主会话：子代理的模型流随 signal 以 AbortError 终止，事件流收尾不卡死
    controller.abort();
    for (let head = await iterator.next(); !head.done; head = await iterator.next()) {
      events.push(head.value);
    }

    const report = events.find(
      (e): e is Extract<SessionEvent, { type: 'subagent-report' }> => e.type === 'subagent-report',
    );
    expect(report?.ok).toBe(false);
    const delegation = events.find(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> =>
        e.type === 'tool-result' && e.call.toolName === 'spawn_subagent',
    );
    expect(delegation?.call.isError).toBe(true);
    // 主会话以中断态收尾（02 的语义），无 error
    expect(events.at(-1)?.type).toBe('assistant-aborted');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });
});
