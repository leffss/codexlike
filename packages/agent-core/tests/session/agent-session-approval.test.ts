import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import type { ProviderProfile } from '../../src/provider/provider-profile';
import { createSqliteSessionStore } from '../../src/session/persistence';
import { createAgentSession } from '../../src/session/agent-session';
import type { SessionEvent, SessionRecord } from '../../src/session/types';
import type { ApprovalMode } from '../../src/session/approval';
import { createBuiltinTools } from '../../src/tools/builtin';

const profile: ProviderProfile = {
  id: 'profile-1',
  name: 'GLM',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-test',
  model: 'glm-4.7',
};

function sessionRecord(workspacePath: string, approvalMode: ApprovalMode): SessionRecord {
  return {
    id: 'session-1',
    title: 'demo',
    workspacePath,
    providerProfileId: null,
    model: null,
    status: 'idle',
    approvalMode,
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

function textRound(deltas: string[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-start', id: 'text-1' });
      for (const delta of deltas) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta });
      }
      controller.enqueue({ type: 'text-end', id: 'text-1' });
      controller.enqueue({ type: 'finish', usage: usage(), finishReason: { unified: 'stop' as const, raw: 'stop' } });
      controller.close();
    },
  });
}

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
      controller.enqueue({
        type: 'finish',
        usage: usage(),
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
      });
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

function makeSession(
  model: MockLanguageModelV4,
  workspacePath: string,
  options?: { approvalMode?: ApprovalMode; approvalMemory?: string[] },
) {
  const persistence = createSqliteSessionStore(':memory:');
  const base = sessionRecord(workspacePath, options?.approvalMode ?? 'suggest');
  persistence.insertSession(base);
  const session = createAgentSession({
    record: base,
    persistence,
    history: persistence.listMessages(base.id),
    languageModelFor: () => model,
    tools: createBuiltinTools(),
    approvalMemory: options?.approvalMemory,
    now: fakeClock(),
  });
  return { session, persistence };
}

/** 拉取事件流；收到 approval-request 时以给定决定响应（模拟用户点审批卡片三键） */
async function drive(
  session: ReturnType<typeof makeSession>['session'],
  text: string,
  decide: 'approve' | 'reject' | 'always',
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const iterator = session.sendMessage({ text, profile })[Symbol.asyncIterator]();
  let head = await iterator.next();
  while (!head.done) {
    const event = head.value;
    events.push(event);
    if (event.type === 'approval-request') {
      session.respondApproval(event.request.id, decide);
    }
    head = await iterator.next();
  }
  return events;
}

describe('AgentSession 审批插点（三档）', () => {
  it('readonly：write_file / apply_patch / run_terminal_command 全部被拒，拒绝原因回填模型，文件不落盘', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const model = scriptedModel([
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c1', toolName: 'write_file', input: { path: 'a.txt', content: 'x' } },
          { toolCallId: 'c2', toolName: 'apply_patch', input: { patch: '*** Begin Patch\n*** Add File: b.txt\n+hello\n*** End Patch' } },
          { toolCallId: 'c3', toolName: 'run_terminal_command', input: { command: 'echo hi' } },
        ],
      },
      { kind: 'text', deltas: ['好的，我只读'] },
    ]);
    const { session, persistence } = makeSession(model, workspace, { approvalMode: 'readonly' });

    const events: SessionEvent[] = [];
    for await (const event of session.sendMessage({ text: '随便改点东西', profile })) {
      events.push(event);
    }

    // 三个工具调用都有 tool-call/tool-result 事件（卡片可见），无审批请求
    const results = events.filter((e): e is Extract<SessionEvent, { type: 'tool-result' }> => e.type === 'tool-result');
    expect(results).toHaveLength(3);
    expect(events.some((e) => e.type === 'approval-request')).toBe(false);
    for (const result of results) {
      expect(result.call.isError).toBe(true);
      expect(result.call.output).toContain('readonly');
    }
    // 文件不落盘（真实拦截）
    expect(existsSync(join(workspace, 'a.txt'))).toBe(false);
    expect(existsSync(join(workspace, 'b.txt'))).toBe(false);
    // 拒绝原因回填模型：第二轮 prompt 含可读解释（模型可改用只读工具）
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain('readonly');
    // 会话正常收尾（不崩循环）
    expect(events.at(-1)?.type).toBe('assistant-done');
    // 拒绝的工具调用也落库（时间线可见）
    expect(persistence.listToolCalls('session-1')).toHaveLength(3);
  });

  it('suggest：文件编辑自动应用（无审批请求）；命令暂停等待审批，批准后执行', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const model = scriptedModel([
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c1', toolName: 'write_file', input: { path: 'auto.txt', content: '自动' } },
        ],
      },
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c2', toolName: 'run_terminal_command', input: { command: 'echo codexlike-approval > out.txt' } },
        ],
      },
      { kind: 'text', deltas: ['完成'] },
    ]);
    const { session, persistence } = makeSession(model, workspace, { approvalMode: 'suggest' });

    const requests: Extract<SessionEvent, { type: 'approval-request' }>['request'][] = [];
    const statusesAtRequest: string[] = [];
    const events: SessionEvent[] = [];
    const iterator = session.sendMessage({ text: '写文件并跑命令', profile })[Symbol.asyncIterator]();
    let head = await iterator.next();
    while (!head.done) {
      const event = head.value;
      events.push(event);
      if (event.type === 'approval-request') {
        requests.push(event.request);
        // 等待审批期间：会话落库状态为 waiting-approval（侧栏可见），pendingApproval 可查
        statusesAtRequest.push(persistence.listSessions()[0]!.status);
        expect(session.pendingApproval?.id).toBe(event.request.id);
        expect(session.respondApproval(event.request.id, 'approve')).toBe(true);
      }
      head = await iterator.next();
    }

    // 文件编辑自动应用，命令经审批后执行
    expect(readFileSync(join(workspace, 'auto.txt'), 'utf8')).toBe('自动');
    expect(readFileSync(join(workspace, 'out.txt'), 'utf8')).toBe('codexlike-approval\n');
    // 审批请求恰好一次：命令原文与首词齐全
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      id: 'c2',
      toolName: 'run_terminal_command',
      command: 'echo codexlike-approval > out.txt',
      commandWord: 'echo',
    });
    expect(statusesAtRequest).toEqual(['waiting-approval']);
    // 事件序列：approval-request → approval-resolved 夹在 tool-call 与 tool-result 之间
    expect(events.map((e) => e.type)).toEqual([
      'user-message',
      'assistant-start',
      'tool-call',
      'tool-result',
      'tool-call',
      'approval-request',
      'approval-resolved',
      'tool-result',
      'assistant-delta',
      'assistant-done',
    ]);
    // 审批结束后会话回到收尾状态 idle
    expect(persistence.listSessions()[0]!.status).toBe('idle');
    expect(session.pendingApproval).toBeNull();
  });

  it('suggest：拒绝审批 → 拒绝结果回填模型，会话正常继续到最终回复', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const model = scriptedModel([
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c1', toolName: 'run_terminal_command', input: { command: 'rm -rf something' } },
        ],
      },
      { kind: 'text', deltas: ['好的，我换个思路'] },
    ]);
    const { session, persistence } = makeSession(model, workspace, { approvalMode: 'suggest' });

    const events = await drive(session, '跑个危险命令', 'reject');

    const result = events.find(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> => e.type === 'tool-result',
    );
    expect(result?.call.isError).toBe(true);
    expect(result?.call.output).toContain('拒绝');
    // 拒绝原因进入第二轮模型上下文
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain('拒绝');
    // 循环不崩：最终文本回复正常落库
    expect(events.at(-1)?.type).toBe('assistant-done');
    expect(persistence.listToolCalls('session-1')).toHaveLength(1);
  });

  it('full：终端命令直接执行，无审批请求', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const model = scriptedModel([
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c1', toolName: 'run_terminal_command', input: { command: 'echo full > mode.txt' } },
        ],
      },
      { kind: 'text', deltas: ['全自动完成'] },
    ]);
    const { session } = makeSession(model, workspace, { approvalMode: 'full' });

    const events: SessionEvent[] = [];
    for await (const event of session.sendMessage({ text: '全自动跑', profile })) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'approval-request')).toBe(false);
    expect(readFileSync(join(workspace, 'mode.txt'), 'utf8')).toBe('full\n');
    expect(events.at(-1)?.type).toBe('assistant-done');
  });

  it('「本会话总是允许」：同首词命令后续不再询问，记忆随会话入库（重启恢复后仍生效）', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const model = scriptedModel([
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c1', toolName: 'run_terminal_command', input: { command: 'echo one > first.txt' } },
        ],
      },
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c2', toolName: 'run_terminal_command', input: { command: 'echo two > second.txt' } },
        ],
      },
      { kind: 'text', deltas: ['两次都完成了'] },
    ]);
    const { session, persistence } = makeSession(model, workspace, { approvalMode: 'suggest' });

    const events = await drive(session, '跑两条 echo', 'always');

    // 只有第一条命令触发审批（always），第二条同首词（echo）直接放行
    const requests = events.filter((e) => e.type === 'approval-request');
    expect(requests).toHaveLength(1);
    expect(readFileSync(join(workspace, 'first.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(workspace, 'second.txt'), 'utf8')).toBe('two\n');
    // 记忆入库（按命令首词 echo）
    expect(persistence.listApprovals('session-1')).toEqual(['echo']);

    // 重启恢复：同一持久层重建会话对象（manager.get 路径），记忆仍生效——
    // suggest 下 echo 命令不再询问
    const model2 = scriptedModel([
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c1', toolName: 'run_terminal_command', input: { command: 'echo three > third.txt' } },
        ],
      },
      { kind: 'text', deltas: ['恢复后直接执行'] },
    ]);
    const restored = createAgentSession({
      record: persistence.listSessions()[0]!,
      persistence,
      history: persistence.listMessages('session-1'),
      languageModelFor: () => model2,
      tools: createBuiltinTools(),
      approvalMemory: persistence.listApprovals('session-1'),
      now: fakeClock(),
    });
    const events2 = await drive(restored, '再跑一条 echo', 'always');
    expect(events2.some((e) => e.type === 'approval-request')).toBe(false);
    expect(readFileSync(join(workspace, 'third.txt'), 'utf8')).toBe('three\n');
  });

  it('中途切换模式：readonly 下被拒的工具，切到 full 后下一次调用立即放行', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const model = scriptedModel([
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c1', toolName: 'write_file', input: { path: 'x.txt', content: '第一次' } },
        ],
      },
      { kind: 'text', deltas: ['被拒了'] },
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c2', toolName: 'write_file', input: { path: 'x.txt', content: '第二次' } },
        ],
      },
      { kind: 'text', deltas: ['这次成功了'] },
    ]);
    const { session } = makeSession(model, workspace, { approvalMode: 'readonly' });

    const first: SessionEvent[] = [];
    for await (const event of session.sendMessage({ text: '写入', profile })) {
      first.push(event);
    }
    const firstResult = first.find((e): e is Extract<SessionEvent, { type: 'tool-result' }> => e.type === 'tool-result');
    expect(firstResult?.call.isError).toBe(true);
    expect(existsSync(join(workspace, 'x.txt'))).toBe(false);

    // 会话中途切换（不重启、不重建对象）：对下一次工具调用立即生效
    session.setApprovalMode('full');
    expect(session.record.approvalMode).toBe('full');

    const second: SessionEvent[] = [];
    for await (const event of session.sendMessage({ text: '再试一次', profile })) {
      second.push(event);
    }
    const secondResult = second.find((e): e is Extract<SessionEvent, { type: 'tool-result' }> => e.type === 'tool-result');
    expect(secondResult?.call.isError).toBe(false);
    expect(readFileSync(join(workspace, 'x.txt'), 'utf8')).toBe('第二次');
  });

  it('respondApproval：无等待请求或 id 不匹配时返回 false；同一请求重复响应也拒绝', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const model = scriptedModel([
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c1', toolName: 'run_terminal_command', input: { command: 'echo pending > p.txt' } },
        ],
      },
      { kind: 'text', deltas: ['done'] },
    ]);
    const { session } = makeSession(model, workspace, { approvalMode: 'suggest' });

    // 无等待请求时
    expect(session.respondApproval('c1', 'approve')).toBe(false);
    expect(session.respondApproval('别的id', 'approve')).toBe(false);

    const iterator = session.sendMessage({ text: '跑命令', profile })[Symbol.asyncIterator]();
    let head = await iterator.next();
    while (!head.done && head.value.type !== 'approval-request') {
      head = await iterator.next();
    }
    const request = (head.value as Extract<SessionEvent, { type: 'approval-request' }>).request;
    // id 不匹配
    expect(session.respondApproval('not-the-id', 'approve')).toBe(false);
    // 第一次响应成功，重复响应失败
    expect(session.respondApproval(request.id, 'approve')).toBe(true);
    expect(session.respondApproval(request.id, 'approve')).toBe(false);

    while (!head.done) {
      head = await iterator.next();
    }
    expect(readFileSync(join(workspace, 'p.txt'), 'utf8')).toBe('pending\n');
  });

  it('等待审批期间会话被中断（signal abort）：视为拒绝，生成器不卡死', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-ws-'));
    const model = scriptedModel([
      {
        kind: 'tool',
        calls: [
          { toolCallId: 'c1', toolName: 'run_terminal_command', input: { command: 'echo never > no.txt' } },
        ],
      },
      { kind: 'text', deltas: ['中断后的回复'] },
    ]);
    const { session } = makeSession(model, workspace, { approvalMode: 'suggest' });

    const controller = new AbortController();
    const iterator = session.sendMessage({ text: '跑命令', profile, signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    let head = await iterator.next();
    while (!head.done && head.value.type !== 'approval-request') {
      head = await iterator.next();
    }
    expect(head.done).toBe(false);

    // 等待审批时中断：生成器应以拒绝结果收尾，不永久挂起
    controller.abort();
    const events: SessionEvent[] = [];
    let tail = await iterator.next();
    const timeout = Symbol('timeout');
    const raced = await Promise.race([
      (async () => {
        while (!tail.done) {
          events.push(tail.value);
          tail = await iterator.next();
        }
        return 'done' as const;
      })(),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 3000)),
    ]);
    expect(raced).toBe('done');
    expect(existsSync(join(workspace, 'no.txt'))).toBe(false);
  });
});
