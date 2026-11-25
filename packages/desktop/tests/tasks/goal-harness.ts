import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import {
  createAgentResourceSnapshot,
  createTaskManager,
  createSqliteTaskStore,
  createWorktreeService,
  type GoalRecord,
  type GoalVerificationRecord,
  type TaskManager,
  type ToolDefinition,
} from "@codexlike/agent-core/node";
import type { BrowserWindow } from "electron";
import {
  IPC,
  type TaskActivity,
  type TaskEventEnvelope,
} from "../../src/shared/ipc";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { createProfileStore } from "../../src/profiles/profile-store";
import { listenMock } from "./mock-server";

/**
 * 目标模式（ADR 0035，GLOSSARY「目标」「目标模式」「完成判定」）的宿主侧测试装配：
 * registerTaskHandlers 注册的 tasks:* IPC 通道 + 真实 TaskManager + 本地 OpenAI
 * 兼容 mock（两条脚本化线：工作轮 streamText 可挂起逐轮驱动、可脚本化工具调用；
 * 判定 generateText 按票 01 契约的 [goal-verification] 标记识别，可挂起）。
 * 结果一律经 IPC 读回（view / messages / list / 事件信封）观察。
 * 票 02 的 goal-ipc.test.ts 与票 03 的 goal-continuation-ipc.test.ts 共用。
 */
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => any>(),
}));
vi.mock("electron", () => ({
  dialog: {},
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => any) =>
      handlers.set(name, fn),
  },
}));

/** 按 IPC 表键调用主进程 handler（如 ipcInvoke("pendingApprovals", taskId)） */
export function ipcInvoke(name: string, ...args: unknown[]): any {
  const channel =
    (IPC.tasks as Record<string, string>)[name] ?? `tasks:${name}`;
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册通道 ${channel}`);
  return handler({}, ...args);
}

/** 判定结论（stub 侧应答形状，同 e2e goal-stub 的 verdict） */
export type Verdict = { passed: boolean; reason: string; nextAction: string };

export const PASSED: Verdict = {
  passed: true,
  reason: "示例测试已全部通过",
  nextAction: "",
};
export const FAILED: Verdict = {
  passed: false,
  reason: "尚有步骤未完成",
  nextAction: "继续实现剩余步骤",
};

/** 一次模型调用应答携带的真实 usage（OpenAI 兼容协议的 prompt / completion tokens） */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** usage 的协议形状；未给出时不带 usage 字段（任务用量按「没报记 0」不入账） */
function usageField(usage: Usage | undefined): Record<string, unknown> {
  if (usage === undefined) return {};
  return {
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
    },
  };
}

/** 一条到达 mock、尚未应答的判定请求 */
export interface PendingVerdict {
  /** 判定请求体（可断言其形状：无 tools、带标记） */
  body: Record<string, unknown>;
  /** 以给定结论应答；usage 计入任务用量（判定自身的消耗，票 05 的预算对账含它） */
  respond(verdict: Verdict, usage?: Usage): void;
  /** 以 HTTP 401 失败（不可自动重试类，SDK 不会先重试） */
  fail(): void;
  /** HTTP 200 但正文不是判定结论（坏输出） */
  garbage(text?: string): void;
}

/** 一条到达 mock、尚未应答的工作轮请求 */
export interface PendingRound {
  body: Record<string, unknown>;
  /** 本条请求最后一条 user 消息的文本（续跑轮即续跑指令全文） */
  lastUserText: string;
  /** 流式应答一帧正文 */
  write(content: string): void;
  /** 收尾（finish_reason=stop）；usage 计入任务用量 */
  finish(usage?: Usage): void;
  /** 以 HTTP 401 失败：回合以模型请求错误终止 */
  fail(): void;
  /**
   * 让模型发起一次工具调用；工具结果回填后的下一次请求是新的 PendingRound。
   * args 为字符串时原样作为工具入参的 JSON（可构造非法入参：SDK 解析失败的调用）
   */
  toolCall(name: string, args: Record<string, unknown> | string): void;
}

/** 以 HTTP 401 拒绝一次模型请求 */
function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
}

/** 续跑指令的稳定锚（buildGoalContinuationInput 的首行）：按它认出续跑轮请求 */
export const CONTINUATION_ANCHOR = "【目标续跑】";

export interface GoalApp {
  manager: TaskManager;
  profile: { id: string };
  runtime: ReturnType<typeof registerTaskHandlers>;
  /** 全部已下发的事件信封（按到达序） */
  delivered: TaskEventEnvelope[];
  /** 指定任务的目标相关事件（按到达序） */
  goalEvents(taskId: string): TaskEventEnvelope[];
  /** 指定任务的用户消息原文（按进入任务的顺序） */
  userTexts(taskId: string): string[];
  /** 指定任务全部消息的角色序列（按时间顺序） */
  messageRoles(taskId: string): string[];
  goalOf(taskId: string): GoalRecord | null;
  /** 指定任务的验证记录（任务时间线读库；消息流标记行的恢复数据源） */
  verificationsOf(taskId: string): GoalVerificationRecord[];
  /** 侧栏列表里该任务的活动态（tasks.list 的 activity 字段） */
  activityOf(taskId: string): TaskActivity;
  /** 等某条用户消息的工作轮请求到达 mock 并取走（回复进行中） */
  hold(text: string): Promise<PendingRound>;
  /** 等首条满足条件的工作轮请求到达并取走（lastUserText 为最后一条 user 消息文本） */
  holdWhere(
    match: (lastUserText: string, body: Record<string, unknown>) => boolean
  ): Promise<PendingRound>;
  /** 是否有未取走的工作轮请求满足条件 */
  hasRequestWhere(match: (lastUserText: string) => boolean): boolean;
  hasRequest(text: string): boolean;
  /** 完成一轮：正文 + 收尾（模型请求到达后应答） */
  reply(text: string, content?: string): Promise<void>;
  /** 等任务回到空闲（宿主执行态 running=false——目标循环结束才会发生） */
  idle(taskId: string): Promise<void>;
  /** 等下一条判定请求到达并取走（未到达前挂起） */
  nextVerdict(): Promise<PendingVerdict>;
  pendingVerdicts(): number;
  requestCount(): number;
  /** 建一个已有首轮回合的空闲任务 */
  newTask(requestId: string, text?: string): Promise<any>;
  /** 输入队列里的排队消息文本 */
  queueTexts(taskId: string): string[];
  /**
   * 给「下一次 Provider Profile 读取」装一道闸：续跑轮发起时要读一次发送参数，
   * 卡住它即可稳定停在「目标进行中、上一轮已收尾、续跑轮尚未发起」的轮间窗口。
   * 调用方在判定应答前装闸（判定的 profile 解析发生在应答之前，不会被卡）。
   */
  armProfileGate(): { reached: Promise<void>; release(): void };
  /** 删除测试用的 Provider Profile（任务所用模型不可用的场合） */
  removeProfile(): Promise<boolean>;
}

/** 目标状态事件（宿主 goal 编排器下发）：不含续跑轮自己的 goal-continuation 开始事件 */
const GOAL_STATE_EVENTS = [
  "goal-changed",
  "goal-verifying",
  "goal-verification",
];

const apps: GoalApp[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  // 用例收尾：中断全部在途回合，等宿主执行态回到空闲（目标循环随之落定）
  for (const app of apps.splice(0)) {
    for (const task of app.manager.list()) ipcInvoke("interrupt", task.id);
    await vi
      .waitFor(
        () => {
          for (const task of app.manager.list())
            expect(ipcInvoke("execution", task.id).running).toBe(false);
        },
        { timeout: 8000 }
      )
      .catch(() => {});
  }
  for (const fn of cleanups.splice(0).reverse()) await fn();
  handlers.clear();
});

export async function setupGoalApp(
  options: {
    concurrencyLimit?: () => number;
    /** 任务可用工具（缺省纯对话）；工具活动与审批用例注入 */
    tools?: ToolDefinition[];
  } = {}
): Promise<GoalApp> {
  const root = mkdtempSync(join(tmpdir(), "goal-ipc-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const dbPath = join(root, "nested", "task-workbench.db");
  const persistence = createSqliteTaskStore(dbPath);
  cleanups.push(() => persistence.close());
  const resourcesFor = ({ workspacePath }: { workspacePath: string }) =>
    createAgentResourceSnapshot({
      workspacePath,
      globalDir: root,
      compatibleGlobalDir: join(root, "compatible"),
      findGitRoot: () => null,
    });
  const manager = createTaskManager({
    persistence,
    resourcesFor,
    tools: options.tools ?? [],
  });
  const profiles = createProfileStore({
    dir: root,
    safeStorage: {
      isEncryptionAvailable: async () => true,
      encryptString: async (text) => Buffer.from(text),
      decryptString: async (bytes) => bytes.toString(),
    },
  });
  // Provider Profile 读取闸（轮间窗口用例）：装闸后的下一次 list() 挂起到放行
  let gate: { reached: () => void; wait: Promise<void> } | null = null;
  let armed = false;
  const gatedProfiles = {
    ...profiles,
    async list() {
      if (armed) {
        armed = false;
        gate?.reached();
        await gate?.wait;
      }
      return profiles.list();
    },
  };

  // 两条线：请求体带 [goal-verification] 标记 = 判定（票 01 对接契约），其余 = 工作轮
  const roundQueue: { text: string; round: PendingRound }[] = [];
  const verdicts: PendingVerdict[] = [];
  let requestCount = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requestCount += 1;
      const parsed = JSON.parse(body) as {
        stream?: boolean;
        tools?: unknown;
        messages: { role: string; content: unknown }[];
      };
      if (body.includes("[goal-verification]")) {
        const completion = (content: string, usage?: Usage) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content },
                  finish_reason: "stop",
                },
              ],
              ...usageField(usage),
            })
          );
        };
        verdicts.push({
          body: parsed,
          respond: (verdict, usage) =>
            completion(JSON.stringify(verdict), usage),
          fail: () => unauthorized(res),
          garbage: (text = "我觉得已经做完了，不用再改了。") =>
            completion(text),
        });
        return;
      }
      const lastUser = [...parsed.messages]
        .reverse()
        .find((message) => message.role === "user");
      const text = String(lastUser?.content);
      const frame = (
        choice: Record<string, unknown>,
        chunk: Record<string, unknown> = {}
      ) => {
        if (!res.headersSent) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.flushHeaders();
        }
        res.write(
          `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, ...choice }], ...chunk })}\n\n`
        );
      };
      const done = () => res.end("data: [DONE]\n\n");
      roundQueue.push({
        text,
        round: {
          body: parsed,
          lastUserText: text,
          write: (content) =>
            frame({ delta: { content }, finish_reason: null }),
          finish: (usage) => {
            // usage 随收尾帧一并上报（OpenAI 兼容流式协议：usage 在 chunk 顶层，
            // 任一帧携带即被采用）
            frame({ delta: {}, finish_reason: "stop" }, usageField(usage));
            done();
          },
          fail: () => unauthorized(res),
          toolCall: (name, args) => {
            frame({
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requestCount}`,
                    type: "function",
                    function: {
                      name,
                      arguments:
                        typeof args === "string" ? args : JSON.stringify(args),
                    },
                  },
                ],
              },
              finish_reason: null,
            });
            frame({ delta: {}, finish_reason: "tool_calls" });
            done();
          },
        },
      });
    });
  });
  cleanups.push(async () => {
    server.close();
    server.closeAllConnections();
  });
  const mockPort = await listenMock(server);
  const profile = await profiles.create({
    name: "可控模型",
    models: ["mock"],
    apiKey: "test",
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
  });
  const delivered: TaskEventEnvelope[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, envelope: TaskEventEnvelope) =>
        delivered.push(structuredClone(envelope)),
    },
  } as unknown as BrowserWindow;
  const runtime = registerTaskHandlers({
    manager,
    profiles: gatedProfiles,
    getWindow: () => window,
    dataDir: root,
    worktreeService: createWorktreeService({
      worktreesDir: join(root, "worktrees"),
    }),
    resourcesFor,
    concurrencyLimit: options.concurrencyLimit ?? ((): number => 3),
  });

  const waitFor = (check: () => unknown) =>
    vi.waitFor(check, { timeout: 8000 });

  const app: GoalApp = {
    manager,
    profile,
    runtime,
    delivered,
    goalEvents: (taskId) =>
      delivered.filter(
        (envelope) =>
          envelope.taskId === taskId &&
          typeof envelope.event.type === "string" &&
          GOAL_STATE_EVENTS.includes(envelope.event.type)
      ),
    userTexts: (taskId) =>
      ipcInvoke("messages", taskId)
        .filter((item: any) => item.message?.role === "user")
        .map((item: any) => item.message.content as string),
    messageRoles: (taskId) =>
      ipcInvoke("messages", taskId)
        .filter((item: any) => item.kind === "message")
        .map((item: any) => item.message.role as string),
    goalOf: (taskId) => ipcInvoke("view", taskId).goal,
    verificationsOf: (taskId) =>
      ipcInvoke("messages", taskId)
        .filter((item: any) => item.kind === "goal-verification")
        .map((item: any) => item.verification as GoalVerificationRecord),
    activityOf: (taskId) =>
      ipcInvoke("list").find((task: any) => task.id === taskId)
        .activity as TaskActivity,
    hold: (text) => app.holdWhere((last) => last === text),
    holdWhere: async (match) => {
      await waitFor(() =>
        expect(
          roundQueue.some((entry) => match(entry.text, entry.round.body))
        ).toBe(true)
      );
      const index = roundQueue.findIndex((entry) =>
        match(entry.text, entry.round.body)
      );
      return roundQueue.splice(index, 1)[0]!.round;
    },
    hasRequestWhere: (match) => roundQueue.some((entry) => match(entry.text)),
    hasRequest: (text) => roundQueue.some((entry) => entry.text === text),
    reply: async (text, content = `${text}的回答`) => {
      const round = await app.hold(text);
      round.write(content);
      round.finish();
    },
    idle: async (taskId) => {
      await waitFor(() =>
        expect(ipcInvoke("execution", taskId).running).toBe(false)
      );
    },
    nextVerdict: async () => {
      await waitFor(() => expect(verdicts.length).toBeGreaterThan(0));
      return verdicts.shift()!;
    },
    pendingVerdicts: () => verdicts.length,
    requestCount: () => requestCount,
    newTask: async (requestId, text = `建立任务-${requestId}`) => {
      const task = await ipcInvoke("start", {
        requestId,
        projectId: null,
        text,
      });
      await app.reply(text);
      await app.idle(task.id);
      return task;
    },
    queueTexts: (taskId) =>
      ipcInvoke("view", taskId).queueState.queue.map((item: any) => item.text),
    armProfileGate: () => {
      let release!: () => void;
      let markReached!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      gate = { reached: markReached, wait };
      armed = true;
      return { reached, release };
    },
    removeProfile: () => profiles.remove(profile.id),
  };
  apps.push(app);
  return app;
}
