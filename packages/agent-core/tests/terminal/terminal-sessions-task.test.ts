import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createTerminalSessionManager } from "../../src/terminal/manager";
import type { TerminalSessionManager } from "../../src/terminal/manager";
import type {
  PtyExitEvent,
  PtyPort,
  PtyProcess,
  PtySpawnRequest,
} from "../../src/terminal/pty-port";
import { createSqliteTaskStore } from "../../src/task/persistence";
import { createAgentTask } from "../../src/task/agent-task";
import type { TaskEvent, TaskRecord } from "../../src/task/types";
import { createBuiltinTools } from "../../src/tools/builtin";

/**
 * 终端会话四工具 × 真实任务循环（票面「实跑通路」验收口径）：真管理器 +
 * fake PtyPort（绝不触 node-pty 真件，01 票 fake 先例），mock model 脚本化
 * spawn → read → write → kill 全链，验证接线、审批门、所有权与增量读取。
 */

const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  models: ["glm-4.7"],
};

/** 一次 PTY 进程实例的 fake：测试用它向会话注入输出与退出事件 */
class FakePtyProcess implements PtyProcess {
  readonly pid: number;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: PtyExitEvent) => void>();
  written: string[] = [];
  killed = false;

  constructor(
    readonly request: PtySpawnRequest,
    pid: number
  ) {
    this.pid = pid;
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(): void {}

  kill(): void {
    this.killed = true;
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** 测试辅助：模拟 shell 输出到达（进缓冲、唤醒等待的 read） */
  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  /** 测试辅助：模拟进程退出（终态与快照由管理器生成） */
  emitExit(event: PtyExitEvent = { exitCode: 0 }): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

/** PtyPort 的 fake：记录 spawn 请求并产出可控 fake 进程 */
class FakePtyPort implements PtyPort {
  spawned: FakePtyProcess[] = [];
  private nextPid = 1000;

  spawn(request: PtySpawnRequest): PtyProcess {
    const process = new FakePtyProcess(request, this.nextPid++);
    this.spawned.push(process);
    return process;
  }
}

/** 真管理器 + fake 端口；sessionId 固定便于 mock model 脚本硬编码引用 */
function makeManager(maxAlivePerTask?: number): {
  manager: TerminalSessionManager;
  port: FakePtyPort;
} {
  const port = new FakePtyPort();
  const manager = createTerminalSessionManager({
    port,
    ...(maxAlivePerTask === undefined ? {} : { maxAlivePerTask }),
    generateId: () => "session-agent-1",
  });
  return { manager, port };
}

function taskRecord(workspacePath: string): TaskRecord {
  return {
    id: "task-1",
    title: "demo",
    workspacePath: "C:\\work\\demo",
    providerProfileId: null,
    model: null,
    status: "idle",
    workspaceMode: "local",
    projectId: null,
    workspaceOriginPath: null,
    approvalMode: "assist",
    archivedAt: null,
    createdAt: "2026-11-21T08:00:00.000Z",
    updatedAt: "2026-11-21T08:00:00.000Z",
  };
}

function usage() {
  return {
    inputTokens: {
      total: 1,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 2, text: undefined, reasoning: undefined },
  };
}

function textRound(
  deltas: string[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "text-1" });
      for (const delta of deltas) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta });
      }
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({
        type: "finish",
        usage: usage(),
        finishReason: { unified: "stop" as const, raw: "stop" },
      });
      controller.close();
    },
  });
}

function toolCallRound(
  toolCalls: { toolCallId: string; toolName: string; input: unknown }[]
) {
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const call of toolCalls) {
        controller.enqueue({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        });
      }
      controller.enqueue({
        type: "finish",
        usage: usage(),
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
      });
      controller.close();
    },
  });
  return { stream };
}

type ScriptedStep =
  | { kind: "text"; deltas: string[] }
  | {
      kind: "tool";
      calls: { toolCallId: string; toolName: string; input: unknown }[];
    };

function scriptedModel(
  steps: ScriptedStep[],
  /** doStream 每次调用前的钩子（序号从 0 起）：会话输出的确定性注入锚点 */
  onCall?: (callIndex: number) => void
) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const index = call++;
      onCall?.(index);
      const step = steps[Math.min(index, steps.length - 1)]!;
      if (step.kind === "tool") {
        return toolCallRound(step.calls);
      }
      return { stream: textRound(step.deltas) };
    },
  });
}

function fakeClock() {
  let tick = 0;
  return () => `2026-11-21T08:00:${String(++tick).padStart(2, "0")}.000Z`;
}

/** 装配任务：createBuiltinTools 注入终端会话管理器（宿主接线同款形状） */
function makeTask(
  model: MockLanguageModelV4,
  manager: TerminalSessionManager,
  overrides?: Partial<TaskRecord>
) {
  const persistence = createSqliteTaskStore(":memory:");
  const base = { ...taskRecord("C:\\work\\demo"), ...overrides };
  persistence.insertTask(base);
  const task = createAgentTask({
    record: base,
    persistence,
    history: persistence.listMessages(base.id),
    languageModelFor: () => model,
    tools: createBuiltinTools({ terminalSessions: { manager } }),
    now: fakeClock(),
  });
  return { task, persistence, taskId: base.id };
}

async function collect(
  iterable: AsyncIterable<TaskEvent>
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function toolResults(events: TaskEvent[], toolName: string) {
  return events.filter(
    (event): event is Extract<TaskEvent, { type: "tool-result" }> =>
      event.type === "tool-result" && event.call.toolName === toolName
  );
}

function interactionRequests(events: TaskEvent[]) {
  return events.filter(
    (event): event is Extract<TaskEvent, { type: "interaction-request" }> =>
      event.type === "interaction-request"
  );
}

describe("终端会话四工具 × 真实任务循环（mock model）", () => {
  it("接线一条龙：spawn → read（增量）→ write → kill 全部真实执行，assist 档普通命令免审批", async () => {
    const { manager, port } = makeManager();
    const model = scriptedModel(
      [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "t1",
              toolName: "spawn_terminal",
              input: { command: "pnpm build" },
            },
          ],
        },
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "t2",
              toolName: "terminal_read",
              input: { sessionId: "session-agent-1" },
            },
          ],
        },
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "t3",
              toolName: "terminal_write",
              input: { sessionId: "session-agent-1", command: "y\n" },
            },
          ],
        },
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "t4",
              toolName: "terminal_kill",
              input: { sessionId: "session-agent-1" },
            },
          ],
        },
        { kind: "text", deltas: ["构建完成"] },
      ],
      (index) => {
        // 确定性注入：doStream 第 2 次调用（read 轮生成前，spawn 已执行完）——
        // 会话输出已进环形缓冲，第 2 轮工具 terminal_read 恰好读到增量
        if (index === 1 && port.spawned.length > 0) {
          port.spawned[0]!.emitData("compiling...\n");
        }
      }
    );
    const { task, persistence } = makeTask(model, manager);

    const events = await collect(
      task.sendMessage({ text: "帮我构建", profile })
    );

    // 四个工具结果全部成功
    expect(toolResults(events, "spawn_terminal")[0]?.call.isError).toBe(false);
    expect(toolResults(events, "spawn_terminal")[0]?.call.output).toContain(
      "session-agent-1"
    );
    expect(toolResults(events, "terminal_read")[0]?.call.isError).toBe(false);
    expect(toolResults(events, "terminal_read")[0]?.call.output).toContain(
      "compiling..."
    );
    expect(toolResults(events, "terminal_write")[0]?.call.isError).toBe(false);
    expect(toolResults(events, "terminal_kill")[0]?.call.isError).toBe(false);

    // spawn 组装：任务归属与 agent 来源在管理器记录层，端口请求只含进程参数
    expect(manager.session("session-agent-1")).toMatchObject({
      taskId: "task-1",
      origin: "agent",
      status: "running",
    });
    expect(port.spawned[0]!.request).toMatchObject({
      cwd: "C:\\work\\demo",
      initialCommand: "pnpm build",
    });
    // write 真实到达 PTY 输入、kill 真实调用
    expect(port.spawned[0]!.written).toEqual(["y\n"]);
    expect(port.spawned[0]!.killed).toBe(true);

    // assist 档普通命令全自动放行：全程无审批卡
    expect(interactionRequests(events)).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("assistant-done");

    // 调用记录全部落库
    const stored = persistence.listToolCalls("task-1");
    expect(stored.map((call) => call.toolName)).toEqual([
      "spawn_terminal",
      "terminal_read",
      "terminal_write",
      "terminal_kill",
    ]);
  });

  it("spawn 即返不阻塞对话轮：会话未退出任务也正常收尾，会话留存", async () => {
    const { manager, port } = makeManager();
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [{ toolCallId: "t1", toolName: "spawn_terminal", input: {} }],
      },
      { kind: "text", deltas: ["已启动长命令"] },
    ]);
    const { task } = makeTask(model, manager);

    const events = await collect(
      task.sendMessage({ text: "后台跑构建", profile })
    );

    // 轮末不等待会话（终端绝不挂 orchestrator.wait）：任务正常结束
    expect(events.at(-1)?.type).toBe("assistant-done");
    // 会话仍 running（未退出、未被任务收尾连带终止）
    expect(manager.session("session-agent-1")?.status).toBe("running");
    expect(port.spawned[0]!.killed).toBe(false);
  });

  it("ask 档逐次审批：spawn 初始命令与 write 弹卡（command 原文进审批请求），read 不弹，kill 弹", async () => {
    const { manager, port } = makeManager();
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "t1",
            toolName: "spawn_terminal",
            input: { command: "pnpm build" },
          },
        ],
      },
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "t2",
            toolName: "terminal_read",
            input: { sessionId: "session-agent-1" },
          },
        ],
      },
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "t3",
            toolName: "terminal_write",
            input: { sessionId: "session-agent-1", command: "y\n" },
          },
        ],
      },
      { kind: "text", deltas: ["都批了"] },
    ]);
    const { task } = makeTask(model, manager, { approvalMode: "ask" });

    const events: TaskEvent[] = [];
    const iterator = task
      .sendMessage({ text: "跑构建", profile })
      [Symbol.asyncIterator]();
    let head = await iterator.next();
    while (!head.done) {
      const event = head.value;
      events.push(event);
      if (event.type === "interaction-request") {
        task.respondApproval(event.interaction.request.id, "approve");
      }
      head = await iterator.next();
    }

    // 恰好 3 张审批卡：spawn（command 类）、write（command 类）、kill 未被调用故无卡
    const requests = interactionRequests(events);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.interaction.request).toMatchObject({
      toolName: "spawn_terminal",
      command: "pnpm build",
    });
    expect(requests[1]!.interaction.request).toMatchObject({
      toolName: "terminal_write",
      command: "y\n",
    });
    // read 是只读工具：ask 档也不弹卡、真实执行
    expect(toolResults(events, "terminal_read")[0]?.call.isError).toBe(false);
    expect(port.spawned).toHaveLength(1);
  });

  it("assist 档危险命令：spawn 初始命令命中 isRiskyCommand 弹卡，拒绝后会话不启动", async () => {
    const { manager, port } = makeManager();
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "t1",
            toolName: "spawn_terminal",
            input: { command: "rm -rf build" },
          },
        ],
      },
      { kind: "text", deltas: ["好吧不删了"] },
    ]);
    const { task } = makeTask(model, manager);

    const events: TaskEvent[] = [];
    const iterator = task
      .sendMessage({ text: "清掉 build", profile })
      [Symbol.asyncIterator]();
    let head = await iterator.next();
    while (!head.done) {
      const event = head.value;
      events.push(event);
      if (event.type === "interaction-request") {
        task.respondApproval(event.interaction.request.id, "reject");
      }
      head = await iterator.next();
    }

    // 危险命令弹卡（与 run_terminal_command 同款黑名单），拒绝后不执行
    const requests = interactionRequests(events);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.interaction.request).toMatchObject({
      command: "rm -rf build",
    });
    const spawnResult = toolResults(events, "spawn_terminal")[0];
    expect(spawnResult?.call.isError).toBe(true);
    expect(spawnResult?.call.output).toContain("被用户拒绝");
    // PTY 从未启动（审批在执行前）
    expect(port.spawned).toHaveLength(0);
    expect(manager.session("session-agent-1")).toBeUndefined();
  });

  it("所有权边界：用户手开会话 write/kill 被拒、read 可用（帮用户诊断）", async () => {
    const { manager, port } = makeManager();
    // 用户经终端面板手开（desktop IPC 同款调用形状）：同任务、user 来源
    const userSpawn = manager.spawn({
      taskId: "task-1",
      shell: "git-bash",
      origin: "user",
      cwd: "C:\\work\\demo",
    });
    if (!userSpawn.ok) throw new Error("用户会话应启动成功");
    const userSessionId = userSpawn.sessionId;
    // 用户会话里已有输出：read 应原样带回
    port.spawned[0]!.emitData("command not found: lss\n");

    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "t1",
            toolName: "terminal_write",
            input: { sessionId: userSessionId, command: "echo hacked\n" },
          },
          {
            toolCallId: "t2",
            toolName: "terminal_kill",
            input: { sessionId: userSessionId },
          },
          {
            toolCallId: "t3",
            toolName: "terminal_read",
            input: { sessionId: userSessionId },
          },
        ],
      },
      { kind: "text", deltas: ["你的终端里是 command not found"] },
    ]);
    const { task } = makeTask(model, manager);
    const events = await collect(
      task.sendMessage({ text: "我的终端怎么了", profile })
    );

    // write 与 kill 被拒（中文 reason 回填模型）
    const writeResult = toolResults(events, "terminal_write")[0];
    expect(writeResult?.call.isError).toBe(true);
    expect(writeResult?.call.output).toContain("用户手动创建");
    const killResult = toolResults(events, "terminal_kill")[0];
    expect(killResult?.call.isError).toBe(true);
    expect(killResult?.call.output).toContain("用户手动创建");
    // read 任意会话可用：只读诊断不拒绝
    const readResult = toolResults(events, "terminal_read")[0];
    expect(readResult?.call.isError).toBe(false);
    // 用户会话未被终止
    expect(manager.session(userSessionId)?.status).toBe("running");
  });

  it("超上限 spawn：管理器拒绝 reason 原文回填模型，任务继续", async () => {
    const { manager, port } = makeManager(1);
    // 已有 1 个存活会话（用户手开），达到 maxAlivePerTask=1
    const userSpawn = manager.spawn({
      taskId: "task-1",
      shell: "git-bash",
      origin: "user",
      cwd: "C:\\work\\demo",
    });
    if (!userSpawn.ok) throw new Error("首个会话应启动成功");

    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "t1",
            toolName: "spawn_terminal",
            input: { command: "pnpm test" },
          },
        ],
      },
      { kind: "text", deltas: ["等待会话释放后再试"] },
    ]);
    const { task } = makeTask(model, manager);

    const events = await collect(
      task.sendMessage({ text: "再开一个跑测试", profile })
    );

    const spawnResult = toolResults(events, "spawn_terminal")[0];
    expect(spawnResult?.call.isError).toBe(true);
    expect(spawnResult?.call.output).toContain("已达上限 1");
    // 失败原因回填模型上下文（第二次请求 prompt 含中文原因）
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      "已达上限 1"
    );
    // PTY 只有用户会话那一次 spawn（agent 的 spawn 在上限检查处被拒，未触端口）
    expect(port.spawned).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("终端会话策略随主任务每轮系统提示注入一次，不入库（ADR 0033）", async () => {
    const model = scriptedModel([
      // 首轮带一次工具调用强制出现第二轮：两轮各自恰好注入一次
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "policy-read",
            toolName: "terminal_read",
            input: { sessionId: "missing" },
          },
        ],
      },
      { kind: "text", deltas: ["完成"] },
    ]);
    const { manager } = makeManager();
    const { task, persistence } = makeTask(model, manager);

    await collect(task.sendMessage({ text: "看下终端", profile }));

    expect(model.doStreamCalls).toHaveLength(2);
    for (const request of model.doStreamCalls) {
      const prompt = JSON.stringify(request.prompt);
      // 宿主注入 manager（终端四工具在表）→ 策略逐轮注入且每轮恰一次
      expect(prompt).toContain("## 终端会话策略");
      expect(prompt.match(/## 终端会话策略/g)).toHaveLength(1);
    }
    // 策略是逐轮组装的提示层，不随 transcript 落库（与工作计划策略同口径）
    expect(JSON.stringify(persistence.listMessages("task-1"))).not.toContain(
      "## 终端会话策略"
    );
    persistence.close();
  });

  it("中断不杀会话：terminal_read 等待中被 abort，工具即断、会话仍 running", async () => {
    const { manager, port } = makeManager();
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "t1",
            toolName: "spawn_terminal",
            input: { command: "pnpm build" },
          },
        ],
      },
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "t2",
            toolName: "terminal_read",
            input: {
              sessionId: "session-agent-1",
              wait: true,
              timeoutMs: 30_000,
            },
          },
        ],
      },
      { kind: "text", deltas: ["（不应被请求）"] },
    ]);
    const { task } = makeTask(model, manager);

    const controller = new AbortController();
    const startedAt = Date.now();
    const events: TaskEvent[] = [];
    for await (const event of task.sendMessage({
      text: "盯一下构建",
      profile,
      signal: controller.signal,
    })) {
      events.push(event);
      if (
        event.type === "tool-call" &&
        event.call.toolName === "terminal_read"
      ) {
        // read 已在执行中（wait 挂起）：500ms 后中断——工具调用自身取消
        setTimeout(() => controller.abort(), 500);
      }
    }
    const elapsed = Date.now() - startedAt;

    // read 未等满 30s：abort 即断（分片轮询响应中断）
    const readResult = toolResults(events, "terminal_read")[0];
    expect(readResult?.call.isError).toBe(true);
    expect(readResult?.call.output).toContain("已被用户中断");
    expect(elapsed).toBeLessThan(15_000);
    // 本轮终止收尾
    expect(events.at(-1)?.type).toBe("assistant-aborted");
    // 会话留存（ADR 0033：中断不杀——长命令躲开任务中断正是功能存在理由）
    expect(manager.session("session-agent-1")?.status).toBe("running");
    expect(port.spawned[0]!.killed).toBe(false);
  }, 30_000);

  it("已退出会话可读：kill 后 exit 到达，read 返回最后输出（快照诊断场景）", async () => {
    const { manager, port } = makeManager();
    const model = scriptedModel(
      [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "t1",
              toolName: "spawn_terminal",
              input: { command: "pnpm build" },
            },
          ],
        },
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "t2",
              toolName: "terminal_kill",
              input: { sessionId: "session-agent-1" },
            },
          ],
        },
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "t3",
              toolName: "terminal_read",
              input: { sessionId: "session-agent-1" },
            },
          ],
        },
        { kind: "text", deltas: ["构建被终止"] },
      ],
      (index) => {
        // 确定性注入：doStream 第 3 次调用（read 轮生成前，kill 已执行）——
        // 模拟 exit 事件到达：残留输出进缓冲、终态由管理器生成
        if (index === 2 && port.spawned[0]?.killed === true) {
          port.spawned[0]!.emitData("killed by signal\n");
          port.spawned[0]!.emitExit({ exitCode: 1 });
        }
      }
    );
    const { task } = makeTask(model, manager);

    const events = await collect(
      task.sendMessage({ text: "收掉它看看输出", profile })
    );

    // kill 成功；kill 后的 exit 驱动终态，read 仍可读（缓冲保留至 discard）
    expect(toolResults(events, "terminal_kill")[0]?.call.isError).toBe(false);
    const readResult = toolResults(events, "terminal_read")[0];
    expect(readResult?.call.isError).toBe(false);
    expect(readResult?.call.output).toContain("killed by signal");
    expect(readResult?.call.output).toContain("已退出");
    expect(manager.session("session-agent-1")?.status).toBe("exited");
  });
});
