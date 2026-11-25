import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentResourceSnapshot,
  createTaskManager,
  createSqliteTaskStore,
  createWorktreeService,
  GOAL_TEXT_MAX_LENGTH,
  type GoalRecord,
  type GoalVerificationRecord,
} from "@codexlike/agent-core/node";
import type { BrowserWindow } from "electron";
import type { TaskEventEnvelope } from "../../src/shared/ipc";
import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { createProfileStore } from "../../src/profiles/profile-store";
import { listenMock } from "./mock-server";

/**
 * 目标模式（ADR 0035，GLOSSARY「目标」「目标模式」「完成判定」）票 02 的宿主侧：
 * /goal 命令解析与设定、goal 编排器（回合结束的 idle 边界 → 完成判定）、
 * 输入队列互锁、Stop = 暂停。
 * 接缝：registerTaskHandlers 注册的 tasks:* IPC 通道 + 真实 TaskManager +
 * 本地 OpenAI 兼容 mock（两条脚本化线：工作轮 streamText 可挂起逐轮驱动；
 * 判定 generateText 按票 01 契约的 [goal-verification] 标记识别，可挂起）。
 * 结果一律经 IPC 读回（view / messages / 事件信封）观察。
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
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  handlers.clear();
});
function invoke(name: string, ...args: unknown[]): any {
  const handler = handlers.get(`tasks:${name}`);
  if (!handler) throw new Error(`未注册通道 tasks:${name}`);
  return handler({}, ...args);
}
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 8000 });

/** 判定结论（stub 侧应答形状，同 e2e goal-stub 的 verdict） */
type Verdict = { passed: boolean; reason: string; nextAction: string };

/** 一条到达 mock、尚未应答的判定请求 */
interface PendingVerdict {
  /** 判定请求体（可断言其形状：无 tools、带标记） */
  body: Record<string, unknown>;
  respond(verdict: Verdict): void;
  /** 以 HTTP 401 失败（不可自动重试类，SDK 不会先重试） */
  fail(): void;
}

/** 一条到达 mock、尚未应答的工作轮请求 */
interface PendingRound {
  body: Record<string, unknown>;
  /** 流式应答一帧正文 */
  write(content: string): void;
  /** 收尾（finish_reason=stop） */
  finish(): void;
  /** 以 HTTP 401 失败：回合以模型请求错误终止 */
  fail(): void;
}

const PASSED: Verdict = {
  passed: true,
  reason: "示例测试已全部通过",
  nextAction: "",
};
const FAILED: Verdict = {
  passed: false,
  reason: "尚有步骤未完成",
  nextAction: "继续实现剩余步骤",
};

/** 以 HTTP 401 拒绝一次模型请求 */
function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
}

async function setup(options: { concurrencyLimit?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "goal-ipc-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const dbPath = join(root, "nested", "task-workbench.db");
  const persistence = createSqliteTaskStore(dbPath);
  cleanup.push(() => persistence.close());
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
    tools: [],
  });
  const profiles = createProfileStore({
    dir: root,
    safeStorage: {
      isEncryptionAvailable: async () => true,
      encryptString: async (text) => Buffer.from(text),
      decryptString: async (bytes) => bytes.toString(),
    },
  });

  // 两条线：请求体带 [goal-verification] 标记 = 判定（票 01 对接契约），其余 = 工作轮
  const rounds = new Map<string, PendingRound>();
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
        verdicts.push({
          body: parsed,
          respond(verdict) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: JSON.stringify(verdict),
                    },
                    finish_reason: "stop",
                  },
                ],
              })
            );
          },
          fail: () => unauthorized(res),
        });
        return;
      }
      const lastUser = [...parsed.messages]
        .reverse()
        .find((message) => message.role === "user");
      const text = String(lastUser?.content);
      const frame = (choice: Record<string, unknown>) => {
        if (!res.headersSent) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.flushHeaders();
        }
        res.write(
          `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, ...choice }] })}\n\n`
        );
      };
      rounds.set(text, {
        body: parsed,
        write: (content) => frame({ delta: { content }, finish_reason: null }),
        finish: () => {
          frame({ delta: {}, finish_reason: "stop" });
          res.end("data: [DONE]\n\n");
        },
        fail: () => unauthorized(res),
      });
    });
  });
  const mockPort = await listenMock(server);
  cleanup.push(() => {
    server.close();
    server.closeAllConnections();
  });
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
    profiles,
    getWindow: () => window,
    dataDir: root,
    worktreeService: createWorktreeService({
      worktreesDir: join(root, "worktrees"),
    }),
    resourcesFor,
    concurrencyLimit: options.concurrencyLimit ?? ((): number => 3),
  });
  cleanup.push(async () => {
    for (const task of manager.list()) invoke("interrupt", task.id);
    await waitFor(() =>
      expect(
        manager.list().every((task) => !invoke("execution", task.id).running)
      ).toBe(true)
    );
  });

  /** 等某条用户消息的工作轮请求到达 mock 并挂起（回复进行中） */
  async function hold(text: string): Promise<PendingRound> {
    await waitFor(() => expect(rounds.has(text)).toBe(true));
    const round = rounds.get(text)!;
    rounds.delete(text);
    return round;
  }
  /** 某条用户消息的工作轮请求是否已到达 mock（未被发出即为 false） */
  const hasRequest = (text: string): boolean => rounds.has(text);
  /** 完成一轮：正文 + 收尾（模型请求到达后应答） */
  async function reply(text: string, content = `${text}的回答`): Promise<void> {
    const round = await hold(text);
    round.write(content);
    round.finish();
  }
  /** 等任务回到空闲（execution.running=false） */
  async function idle(taskId: string): Promise<void> {
    await waitFor(() =>
      expect(invoke("execution", taskId).running).toBe(false)
    );
  }
  /** 等下一条判定请求到达并取走（未到达前挂起） */
  async function nextVerdict(): Promise<PendingVerdict> {
    await waitFor(() => expect(verdicts.length).toBeGreaterThan(0));
    return verdicts.shift()!;
  }
  /** 指定任务的目标相关事件（按到达序） */
  const goalEvents = (taskId: string) =>
    delivered.filter(
      (envelope) =>
        envelope.taskId === taskId &&
        typeof envelope.event.type === "string" &&
        envelope.event.type.startsWith("goal-")
    );
  /** 指定任务的用户消息原文（按进入任务的顺序） */
  const userTexts = (taskId: string) =>
    invoke("messages", taskId)
      .filter((item: any) => item.message?.role === "user")
      .map((item: any) => item.message.content as string);
  const goalOf = (taskId: string): GoalRecord | null =>
    invoke("view", taskId).goal;
  /** 指定任务的验证记录（任务时间线读库；消息流标记行的恢复数据源） */
  const verificationsOf = (taskId: string): GoalVerificationRecord[] =>
    invoke("messages", taskId)
      .filter((item: any) => item.kind === "goal-verification")
      .map((item: any) => item.verification as GoalVerificationRecord);
  /** 建一个已有首轮回合的空闲任务 */
  async function newTask(
    requestId: string,
    text = `建立任务-${requestId}`
  ): Promise<any> {
    const task = await invoke("start", { requestId, projectId: null, text });
    await reply(text);
    await idle(task.id);
    return task;
  }
  void runtime;
  return {
    manager,
    profile,
    runtime,
    delivered,
    goalEvents,
    userTexts,
    goalOf,
    verificationsOf,
    hold,
    hasRequest,
    reply,
    idle,
    nextVerdict,
    newTask,
    pendingVerdicts: () => verdicts.length,
    requestCount: () => requestCount,
  };
}

describe("/goal 命令解析与设定（tasks:goal-set）", () => {
  it("空目标与超长目标以中文原因拒绝：不落库、不发模型请求", async () => {
    const app = await setup();
    const task = await app.newTask("goal-parse");
    const before = app.requestCount();

    await expect(invoke("goal-set", task.id, "  \n ")).rejects.toThrow(
      "目标不能为空"
    );
    await expect(
      invoke("goal-set", task.id, "长".repeat(GOAL_TEXT_MAX_LENGTH + 1))
    ).rejects.toThrow("目标文本过长");
    await expect(invoke("goal-set", task.id, 42)).rejects.toThrow(
      "设定目标：参数不合法"
    );

    expect(app.goalOf(task.id)).toBeNull();
    expect(app.requestCount()).toBe(before);
  });

  it("有效目标：设定即「进行中」，目标原文作为用户消息发出首轮；view 携带目标、goal-changed 事件下发", async () => {
    const app = await setup();
    const task = await app.newTask("goal-set");
    expect(app.goalOf(task.id)).toBeNull();

    const goal = await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });

    expect(goal).toMatchObject({
      taskId: task.id,
      text: "让示例测试全部通过",
      status: "active",
    });
    // 首轮已发出：目标原文就是首条用户消息，回复进行中
    const round = await app.hold("让示例测试全部通过");
    expect(round.body.stream).toBe(true);
    expect(app.userTexts(task.id)).toEqual([
      "建立任务-goal-set",
      "让示例测试全部通过",
    ]);
    expect(app.goalOf(task.id)).toEqual(goal);
    // 任务侧状态照旧四值：首轮进行中为 streaming
    expect(invoke("list")[0]).toMatchObject({
      id: task.id,
      status: "streaming",
    });
    expect(app.goalEvents(task.id).at(-1)?.event).toEqual({
      type: "goal-changed",
      goal,
    });

    await round.write("首轮回复");
    await round.finish();
    // 回合结束即进入完成判定：应答后目标完成、任务回到空闲
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
  });

  it("任务不可设定目标的情形以中文原因拒绝：已归档、回复进行中", async () => {
    const app = await setup();
    const running = await app.newTask("goal-running");
    const pending = invoke("send", running.id, "进行中的消息", app.profile.id);
    const round = await app.hold("进行中的消息");
    await expect(
      invoke("goal-set", running.id, "目标", {
        providerProfileId: app.profile.id,
      })
    ).rejects.toThrow("任务正在执行");
    expect(app.goalOf(running.id)).toBeNull();
    round.write("进行中的消息的回答");
    round.finish();
    await pending;
    await app.idle(running.id);

    const archived = await app.newTask("goal-archived");
    await invoke("archive", archived.id, true);
    await expect(
      invoke("goal-set", archived.id, "目标", {
        providerProfileId: app.profile.id,
      })
    ).rejects.toThrow("任务已归档");
    expect(app.goalOf(archived.id)).toBeNull();
  });

  it("首轮启动失败时目标回滚：不留「进行中却没有回合」的半成品，失败原因原样抛回", async () => {
    const app = await setup();
    const task = await app.newTask("goal-rollback");

    // 发送参数非法（思考档位越界）→ 首轮在启动处失败
    await expect(
      invoke("goal-set", task.id, "启动会失败的目标", {
        providerProfileId: app.profile.id,
        thinkingEffort: "bogus",
      })
    ).rejects.toThrow("无效的思考档位");
    expect(app.goalOf(task.id)).toBeNull();

    // 所选模型不存在同样回滚
    await expect(
      invoke("goal-set", task.id, "启动会失败的目标", {
        providerProfileId: "ghost-profile",
      })
    ).rejects.toThrow("Provider Profile 不存在");
    expect(app.goalOf(task.id)).toBeNull();

    // 回滚后名额让出：用合法参数可以重新设定
    const goal = await invoke("goal-set", task.id, "重新设定的目标", {
      providerProfileId: app.profile.id,
    });
    expect(goal.status).toBe("active");
    await app.reply("重新设定的目标");
    (await app.nextVerdict()).respond(PASSED);
    await app.idle(task.id);
  });
});

describe("goal 编排器：回合结束的 idle 边界（ADR 0035）", () => {
  it("编排器单次流转：首轮回合正常结束 → 自动发起完成判定 → 判定通过 → 目标「已完成」，标记行与状态事件下发", async () => {
    const app = await setup();
    const task = await app.newTask("goal-pass");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");

    // 回合正常结束 → 宿主在 idle 边界自动发起完成判定（无需用户操作）
    round.write("示例测试已全部通过。");
    round.finish();
    const verdictRequest = await app.nextVerdict();

    // 判定请求形状（票 01 对接契约 + 完成判定契约）：无工具、首部带标记、带目标与历史
    expect(verdictRequest.body.tools).toBeUndefined();
    expect(verdictRequest.body.stream).not.toBe(true);
    const body = JSON.stringify(verdictRequest.body);
    expect(body).toContain("[goal-verification]");
    expect(body).toContain("让示例测试全部通过");
    expect(body).toContain("示例测试已全部通过。");
    // 判定在途：目标仍进行中，任务仍占执行席（没有回到空闲的空窗）
    expect(app.goalOf(task.id)?.status).toBe("active");
    expect(invoke("execution", task.id).running).toBe(true);

    verdictRequest.respond(PASSED);
    await app.idle(task.id);

    // 判定通过 → 目标「已完成」，累计时长定格
    const goal = app.goalOf(task.id);
    expect(goal).toMatchObject({ status: "completed", activeSince: null });
    expect(goal?.activeMs).toBeGreaterThanOrEqual(0);
    expect(app.verificationsOf(task.id)).toEqual([
      {
        id: expect.any(String),
        taskId: task.id,
        goalId: goal?.id,
        round: 1,
        passed: true,
        reason: "示例测试已全部通过",
        nextAction: "",
        createdAt: expect.any(String),
      },
    ]);
    // 事件序：设定（进行中）→ 判定结论（标记行）→ 状态（已完成）
    const events = app.goalEvents(task.id).map((envelope) => envelope.event);
    expect(events.map((event) => event.type)).toEqual([
      "goal-changed",
      "goal-verification",
      "goal-changed",
    ]);
    expect(events[1]).toEqual({
      type: "goal-verification",
      verification: expect.objectContaining({ round: 1, passed: true }),
    });
    expect(events[2]).toMatchObject({
      type: "goal-changed",
      goal: { status: "completed" },
    });
    // 任务侧状态四值不变：目标完成后任务回到空闲
    expect(invoke("list")[0]).toMatchObject({ id: task.id, status: "idle" });
    expect(invoke("execution", task.id).running).toBe(false);
  }, 15_000);

  it("判定未通过：落「未完成」验证记录后目标转「已暂停」——本票不续跑，任务回到空闲", async () => {
    const app = await setup();
    const task = await app.newTask("goal-unpassed");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");
    round.write("做了一部分。");
    round.finish();

    (await app.nextVerdict()).respond(FAILED);
    await app.idle(task.id);

    // 未通过不是终态：目标保留并转已暂停，结论与下一步方向留痕
    const goal = app.goalOf(task.id);
    expect(goal).toMatchObject({
      status: "paused",
      text: "让示例测试全部通过",
      activeSince: null,
    });
    expect(app.verificationsOf(task.id)).toEqual([
      expect.objectContaining({
        goalId: goal?.id,
        round: 1,
        passed: false,
        reason: "尚有步骤未完成",
        nextAction: "继续实现剩余步骤",
      }),
    ]);
    // 本票不自动续跑：没有第二轮工作请求，任务空闲
    expect(app.requestCount()).toBe(3);
    expect(invoke("execution", task.id).running).toBe(false);
    expect(app.goalEvents(task.id).at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "paused" },
    });
  }, 15_000);

  it("判定不可用（fail-open）：判定请求失败不卡住目标——按未通过落记录，目标转「已暂停」", async () => {
    const app = await setup();
    const task = await app.newTask("goal-failopen");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");
    round.write("做了一部分。");
    round.finish();

    (await app.nextVerdict()).fail();
    await app.idle(task.id);

    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(app.verificationsOf(task.id)).toEqual([
      expect.objectContaining({
        round: 1,
        passed: false,
        reason: expect.stringContaining("完成判定不可用"),
      }),
    ]);
    expect(invoke("execution", task.id).running).toBe(false);
  }, 15_000);

  it("回合出错（模型请求失败）：不发起完成判定，目标转「已暂停」——不留「进行中却没有回合」的空转态", async () => {
    const app = await setup();
    const task = await app.newTask("goal-round-error");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    (await app.hold("让示例测试全部通过")).fail();
    await app.idle(task.id);

    expect(app.goalOf(task.id)).toMatchObject({ status: "paused" });
    expect(app.pendingVerdicts()).toBe(0);
    expect(app.verificationsOf(task.id)).toEqual([]);
    expect(invoke("execution", task.id).running).toBe(false);
  }, 15_000);
});

describe("Stop 在目标进行中 = 暂停（ADR 0035）", () => {
  it("停止按钮：当前回合中断、目标转「已暂停」且不丢失、不发起完成判定、暂停后不自行续跑", async () => {
    const app = await setup();
    const task = await app.newTask("goal-stop");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");
    round.write("写到一半的回复");

    expect(invoke("interrupt", task.id)).toBe(true);
    await app.idle(task.id);

    // 目标不丢失：原文保留，状态转已暂停，累计时长定格
    expect(app.goalOf(task.id)).toMatchObject({
      taskId: task.id,
      text: "让示例测试全部通过",
      status: "paused",
      activeSince: null,
    });
    // 中断的回合不判定
    expect(app.pendingVerdicts()).toBe(0);
    expect(app.verificationsOf(task.id)).toEqual([]);
    // 暂停后不得自行无限续跑：没有新的模型请求，任务保持空闲
    const requests = app.requestCount();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(app.requestCount()).toBe(requests);
    expect(invoke("execution", task.id).running).toBe(false);
    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(app.goalEvents(task.id).at(-1)?.event).toMatchObject({
      type: "goal-changed",
      goal: { status: "paused" },
    });
  }, 15_000);

  it("目标不在进行中时，停止按钮的行为不变（普通任务 / 已完成的目标）", async () => {
    const app = await setup();
    const task = await app.newTask("goal-stop-plain");
    const pending = invoke("send", task.id, "普通消息", app.profile.id);
    const round = await app.hold("普通消息");

    expect(invoke("interrupt", task.id)).toBe(true);
    await app.idle(task.id);
    await pending.catch(() => {});

    // 没有目标：停止不产生任何目标事件
    expect(app.goalOf(task.id)).toBeNull();
    expect(app.goalEvents(task.id)).toEqual([]);
    void round;
  }, 15_000);
});

describe("输入队列互锁（ADR 0035「暂停阀门」）", () => {
  const queueTexts = (taskId: string) =>
    invoke("view", taskId).queueState.queue.map((item: any) => item.text);

  it("目标进行中（含判定在途）排队消息不自动消费；终态后恢复逐条自动发出", async () => {
    const app = await setup();
    const task = await app.newTask("goal-queue");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");
    // 回复进行中提交的两条消息进入输入队列（不丢）
    await invoke("send", task.id, "补充甲", app.profile.id);
    await invoke("send", task.id, "补充乙", app.profile.id);
    expect(queueTexts(task.id)).toEqual(["补充甲", "补充乙"]);

    // 回合结束、判定在途（判定请求未应答）：排队消息不得被发出，队列原样保留
    round.write("首轮回复");
    round.finish();
    const verdict = await app.nextVerdict();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(app.userTexts(task.id)).toEqual([
      "建立任务-goal-queue",
      "让示例测试全部通过",
    ]);
    expect(queueTexts(task.id)).toEqual(["补充甲", "补充乙"]);
    expect(invoke("execution", task.id).running).toBe(true);

    // 判定通过 → 目标已完成（终态）→ 队列恢复自动逐条发出
    verdict.respond(PASSED);
    const first = await app.hold("补充甲");
    // 逐条消费：甲的回复未完成前乙不得发出（发一条、等其回复完成、再发下一条）
    expect(app.hasRequest("补充乙")).toBe(false);
    expect(queueTexts(task.id)).toEqual(["补充甲", "补充乙"]);
    first.write("甲的处理结果");
    first.finish();
    await app.reply("补充乙");
    await app.idle(task.id);

    expect(app.userTexts(task.id)).toEqual([
      "建立任务-goal-queue",
      "让示例测试全部通过",
      "补充甲",
      "补充乙",
    ]);
    expect(queueTexts(task.id)).toEqual([]);
    expect(app.goalOf(task.id)?.status).toBe("completed");
    // 排队消息的回合结束后不再判定：目标已不在进行中
    expect(app.pendingVerdicts()).toBe(0);
  }, 15_000);

  it("判定未过后目标转已暂停（离开进行中）：排队消息同样恢复自动发出", async () => {
    const app = await setup();
    const task = await app.newTask("goal-queue-paused");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");
    await invoke("send", task.id, "补充一句", app.profile.id);

    round.write("首轮回复");
    round.finish();
    (await app.nextVerdict()).respond(FAILED);
    await app.reply("补充一句");
    await app.idle(task.id);

    expect(app.userTexts(task.id)).toEqual([
      "建立任务-goal-queue-paused",
      "让示例测试全部通过",
      "补充一句",
    ]);
    expect(app.goalOf(task.id)?.status).toBe("paused");
    expect(queueTexts(task.id)).toEqual([]);
  }, 15_000);

  it("应用退出屏障：中断在途判定时不做任何目标编排（目标状态原样，重启后的恢复由恢复链路负责）", async () => {
    const app = await setup();
    const task = await app.newTask("goal-exit");
    await invoke("goal-set", task.id, "让示例测试全部通过", {
      providerProfileId: app.profile.id,
    });
    const round = await app.hold("让示例测试全部通过");
    round.write("首轮回复");
    round.finish();
    // 判定在途时用户退出应用：退出屏障中断全部执行并排空
    await app.nextVerdict();
    await app.runtime.stopAndDrain();

    // 退出路径不改目标状态：不落结论、不暂停（与「回合在途被退出中断」同口径）
    expect(app.goalOf(task.id)?.status).toBe("active");
    expect(app.verificationsOf(task.id)).toEqual([]);
    expect(invoke("execution", task.id).running).toBe(false);
    app.runtime.thaw();
  }, 15_000);
});
