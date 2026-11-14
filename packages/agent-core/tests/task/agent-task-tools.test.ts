import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteTaskStore } from "../../src/task/persistence";
import { createAgentTask } from "../../src/task/agent-task";
import type { TaskEvent, TaskRecord } from "../../src/task/types";
import { createBuiltinTools } from "../../src/tools/builtin";
import type { SearchSource } from "../../src/tools/web-search";
import { fakeResourceSnapshot } from "./resource-fixture";

const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  model: "glm-4.7",
};

function taskRecord(workspacePath: string): TaskRecord {
  return {
    id: "task-1",
    title: "demo",
    workspacePath,
    providerProfileId: null,
    model: null,
    status: "idle",
    workspaceMode: "local",
    projectId: null,
    workspaceOriginPath: null,
    approvalMode: "assist",
    archivedAt: null,
    createdAt: "2026-11-11T08:00:00.000Z",
    updatedAt: "2026-11-11T08:00:00.000Z",
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

function finish() {
  return {
    usage: usage(),
    finishReason: { unified: "stop" as const, raw: "stop" },
  };
}

/** 文本轮流式（ai v7：text-start/delta/end 包裹，前人踩坑） */
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
      controller.enqueue({ type: "finish", ...finish() });
      controller.close();
    },
  });
}

/** 工具调用轮流式（finishReason 为 tool-calls，工具由任务循环执行后回填） */
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

function scriptedModel(steps: ScriptedStep[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(call++, steps.length - 1)]!;
      if (step.kind === "tool") {
        return toolCallRound(step.calls);
      }
      return { stream: textRound(step.deltas) };
    },
  });
}

function fakeClock() {
  let tick = 0;
  return () => `2026-11-11T08:00:${String(++tick).padStart(2, "0")}.000Z`;
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

function makeTask(
  model: MockLanguageModelV4,
  workspacePath: string,
  record?: TaskRecord
) {
  const persistence = createSqliteTaskStore(":memory:");
  const base = record ?? taskRecord(workspacePath);
  persistence.insertTask(base);
  const task = createAgentTask({
    record: base,
    persistence,
    history: persistence.listMessages(base.id),
    languageModelFor: () => model,
    tools: createBuiltinTools(),
    now: fakeClock(),
  });
  return { task, persistence };
}

describe("AgentTask 工具循环（六件工具默认放行）", () => {
  it("普通请求自主加载技能与资源，仅同轮回填且 active 摘要实时变化，下轮执行者清空", async () => {
    const persistence = createSqliteTaskStore(":memory:");
    const record = taskRecord("C:/work/demo");
    persistence.insertTask(record);
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "load",
            toolName: "load_skill",
            input: { name: "alpha" },
          },
        ],
      },
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "read",
            toolName: "read_skill_resource",
            input: { name: "alpha" },
          },
        ],
      },
      { kind: "text", deltas: ["已处理"] },
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "unloaded",
            toolName: "read_skill_resource",
            input: { name: "alpha" },
          },
        ],
      },
      { kind: "text", deltas: ["需要重新加载"] },
    ]);
    const task = createAgentTask({
      record,
      persistence,
      resources: () => fakeResourceSnapshot(),
      languageModelFor: () => model,
    });
    for await (const event of task.sendMessage({
      text: "处理任务",
      profile,
    })) {
      if (event.type === "tool-result" && event.call.id === "load") {
        expect(event.call.isError).toBe(false);
        expect(task.resourceState.active?.loaded).toHaveLength(1);
      }
    }
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain(
      "ALPHA_PRIVATE_BODY"
    );
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      "ALPHA_PRIVATE_BODY"
    );
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain(
      "RESOURCE_PRIVATE_BODY"
    );
    expect(task.resourceState.last?.loaded).toHaveLength(2);
    expect(task.resourceState.active).toBeNull();
    const next = await collect(task.sendMessage({ text: "下一轮", profile }));
    expect(JSON.stringify(model.doStreamCalls[3]?.prompt)).not.toContain(
      "PRIVATE_BODY"
    );
    expect(next.find((event) => event.type === "tool-result")).toMatchObject({
      call: { isError: true, output: expect.stringContaining("尚未加载") },
    });
    expect(task.resourceState.last?.loaded).toEqual([]);
    persistence.close();
  });

  it.each(["load_skill", "read_skill_resource"])(
    "宿主工具与资源工具 %s 重名时发送前拒绝，不静默覆盖",
    async (name) => {
      const persistence = createSqliteTaskStore(":memory:");
      const record = taskRecord("C:/work/demo");
      persistence.insertTask(record);
      const model = scriptedModel([{ kind: "text", deltas: ["不应请求"] }]);
      const task = createAgentTask({
        record,
        persistence,
        resources: () => fakeResourceSnapshot(),
        languageModelFor: () => model,
        tools: [
          {
            name,
            description: "重名工具",
            parameters: { type: "object", properties: {} },
            permission: "readonly",
            async execute() {
              throw new Error("不应执行");
            },
          },
        ],
      });
      await expect(
        collect(task.sendMessage({ text: "任务", profile }))
      ).rejects.toThrow(`工具名称冲突：${name}`);
      expect(model.doStreamCalls).toHaveLength(0);
      expect(persistence.listMessages(record.id)).toEqual([]);
      expect(task.resourceState.active).toBeNull();
      persistence.close();
    }
  );

  it("宿主工具与 update_plan 重名时发送前拒绝（工作计划工具强制并入，ADR 0016）", async () => {
    const persistence = createSqliteTaskStore(":memory:");
    const record = taskRecord("C:/work/demo");
    persistence.insertTask(record);
    const model = scriptedModel([{ kind: "text", deltas: ["不应请求"] }]);
    const task = createAgentTask({
      record,
      persistence,
      resources: () => fakeResourceSnapshot(),
      languageModelFor: () => model,
      tools: [
        {
          name: "update_plan",
          description: "重名工具",
          parameters: { type: "object", properties: {} },
          permission: "readonly",
          async execute() {
            throw new Error("不应执行");
          },
        },
      ],
    });
    await expect(
      collect(task.sendMessage({ text: "任务", profile }))
    ).rejects.toThrow("工具名称冲突：update_plan");
    expect(model.doStreamCalls).toHaveLength(0);
    persistence.close();
  });

  it("模型调 update_plan → 免审批执行 → 统计结果回填，调用记录随 transcript 入库（派生式数据通道）", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const plan = {
      steps: [
        { content: "调研布局代码", status: "completed" },
        { content: "输出方案", status: "in_progress" },
        { content: "回归测试", status: "pending" },
      ],
    };
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [{ toolCallId: "plan-1", toolName: "update_plan", input: plan }],
      },
      { kind: "text", deltas: ["计划已建立"] },
    ]);
    const { task, persistence } = makeTask(model, workspace);

    const events = await collect(
      task.sendMessage({ text: "列个计划", profile })
    );

    const result = events.find(
      (event) => event.type === "tool-result" && event.call.id === "plan-1"
    );
    expect(result).toMatchObject({
      call: {
        toolName: "update_plan",
        isError: false,
        output: "工作计划已更新（共 3 项：1 已完成、1 进行中、1 待办）",
        // 全量清单进调用记录：UI 从这里派生当前计划（常驻计划条）
        arguments: JSON.stringify(plan),
      },
    });
    // 落库：任务恢复时 initialTranscript 重建段序列，常驻计划条随之恢复
    const calls = persistence.listToolCalls("task-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: "plan-1",
      toolName: "update_plan",
      isError: false,
      arguments: JSON.stringify(plan),
    });
    // 工具结果回传模型：下一轮请求体含统计摘要
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      "工作计划已更新"
    );
    persistence.close();
  });

  it("工作计划策略随主任务每轮系统提示注入一次，不入库（ADR 0016）", async () => {
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "policy-plan",
            toolName: "update_plan",
            input: {
              steps: [{ content: "第一步", status: "in_progress" }],
            },
          },
        ],
      },
      { kind: "text", deltas: ["开工"] },
    ]);
    const { task, persistence } = makeTask(model, "C:/work/demo");

    await collect(task.sendMessage({ text: "列个计划", profile }));

    expect(model.doStreamCalls).toHaveLength(2);
    for (const request of model.doStreamCalls) {
      const system = request.prompt.filter(
        (message) => message.role === "system"
      );
      expect(JSON.stringify(system)).toContain("## 工作计划策略");
      expect(
        JSON.stringify(request.prompt).match(/## 工作计划策略/g)
      ).toHaveLength(1);
    }
    // 策略是逐轮组装的提示层，不随 transcript 落库
    expect(JSON.stringify(persistence.listMessages("task-1"))).not.toContain(
      "## 工作计划策略"
    );
    persistence.close();
  });

  it("模型调工具 → 执行 → 结果回填 → 最终回复；文件真实落盘，调用记录入库", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "call-1",
            toolName: "write_file",
            input: { path: "hello.txt", content: "你好工具" },
          },
        ],
      },
      { kind: "text", deltas: ["已为你创建 ", "hello.txt"] },
    ]);
    const { task, persistence } = makeTask(model, workspace);

    const events = await collect(
      task.sendMessage({ text: "帮我创建 hello.txt", profile })
    );

    // 事件序列：工具卡片事件夹在 assistant-start 与最终文本之间
    expect(events.map((e) => e.type)).toEqual([
      "user-message",
      "assistant-start",
      "tool-call",
      "tool-result",
      "assistant-delta",
      "assistant-delta",
      "assistant-done",
    ]);

    const toolCallEvent = events.find(
      (e): e is Extract<TaskEvent, { type: "tool-call" }> =>
        e.type === "tool-call"
    );
    expect(toolCallEvent?.call.toolName).toBe("write_file");
    expect(toolCallEvent?.call.id).toBe("call-1");
    expect(JSON.parse(toolCallEvent!.call.arguments)).toEqual({
      path: "hello.txt",
      content: "你好工具",
    });

    const toolResultEvent = events.find(
      (e): e is Extract<TaskEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(toolResultEvent?.call.isError).toBe(false);
    expect(toolResultEvent?.call.output).toContain("已写入 hello.txt");

    // 文件系统真实变化（真实临时目录工作区）
    expect(readFileSync(join(workspace, "hello.txt"), "utf8")).toBe("你好工具");

    // 工具结果回填模型：第二次 doStream 的 prompt 含 tool-result 内容
    expect(model.doStreamCalls).toHaveLength(2);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("已写入 hello.txt");

    // 工具调用记录落库
    const calls = persistence.listToolCalls("task-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: "call-1",
      toolName: "write_file",
      isError: false,
    });

    // 最终 assistant 消息照常落库（02 的行为不变）
    expect(
      persistence.listMessages("task-1").map((m) => [m.role, m.content])
    ).toContainEqual(["assistant", "已为你创建 hello.txt"]);
  });

  it("read_file 串起多轮：先读后改（apply_patch），全部入库", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const fs = await import("node:fs");
    fs.writeFileSync(join(workspace, "config.txt"), "debug=false\n", "utf8");

    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "read_file",
            input: { path: "config.txt" },
          },
        ],
      },
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c2",
            toolName: "apply_patch",
            input: {
              patch:
                "*** Begin Patch\n*** Update File: config.txt\n-debug=false\n+debug=true\n*** End Patch",
            },
          },
        ],
      },
      { kind: "text", deltas: ["已把 debug 打开"] },
    ]);
    const { task, persistence } = makeTask(model, workspace);

    const events = await collect(
      task.sendMessage({ text: "打开 debug", profile })
    );

    expect(events.filter((e) => e.type === "tool-result")).toHaveLength(2);
    expect(fs.readFileSync(join(workspace, "config.txt"), "utf8")).toBe(
      "debug=true\n"
    );
    expect(persistence.listToolCalls("task-1").map((c) => c.toolName)).toEqual([
      "read_file",
      "apply_patch",
    ]);
  });

  it("工具失败（如文件不存在）：isError 结果回填模型，任务继续到最终回复", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "read_file",
            input: { path: "ghost.txt" },
          },
        ],
      },
      { kind: "text", deltas: ["文件不存在，我来新建"] },
      // （第三步不需要：第二轮文本即结束）
    ]);
    const { task, persistence } = makeTask(model, workspace);

    const events = await collect(
      task.sendMessage({ text: "读一下 ghost.txt", profile })
    );

    const resultEvent = events.find(
      (e): e is Extract<TaskEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(resultEvent?.call.isError).toBe(true);
    expect(resultEvent?.call.output).toContain("不存在");

    // 错误信息回填给模型（第二次 doStream prompt 含中文原因）
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("不存在");

    expect(events.at(-1)?.type).toBe("assistant-done");
    expect(persistence.listToolCalls("task-1")[0]?.isError).toBe(true);
  });

  it("模型调用未注册的工具名：返回可读错误结果而不是中断任务", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [{ toolCallId: "c1", toolName: "no_such_tool", input: {} }],
      },
      { kind: "text", deltas: ["好吧"] },
    ]);
    const { task } = makeTask(model, workspace);

    const events = await collect(
      task.sendMessage({ text: "试试神秘工具", profile })
    );

    const resultEvent = events.find(
      (e): e is Extract<TaskEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(resultEvent?.call.isError).toBe(true);
    expect(resultEvent?.call.output).toContain("no_such_tool");
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("不带 tools 的任务保持 02 的纯对话行为（向后兼容）", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const persistence = createSqliteTaskStore(":memory:");
    const record = taskRecord(workspace);
    persistence.insertTask(record);
    const model = scriptedModel([{ kind: "text", deltas: ["纯文本回答"] }]);
    const task = createAgentTask({
      record,
      persistence,
      languageModelFor: () => model,
      now: fakeClock(),
    });

    const events = await collect(task.sendMessage({ text: "你好", profile }));
    expect(events.map((e) => e.type)).toEqual([
      "user-message",
      "assistant-start",
      "assistant-delta",
      "assistant-done",
    ]);
  });

  it("web_search 注册与调用链路（工单 10）：模型搜索 → 结果回填下一轮 prompt", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const queries: string[] = [];
    const source: SearchSource = {
      async search(query) {
        queries.push(query);
        return [
          {
            title: "Tavily 文档",
            url: "https://docs.tavily.com",
            snippet: "Search API for AI agents.",
          },
        ];
      },
    };
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "w1",
            toolName: "web_search",
            input: { query: "tavily api" },
          },
        ],
      },
      { kind: "text", deltas: ["查到了，Tavily 是给 agent 用的搜索 API"] },
    ]);
    const persistence = createSqliteTaskStore(":memory:");
    const record = taskRecord(workspace);
    persistence.insertTask(record);
    const task = createAgentTask({
      record,
      persistence,
      history: persistence.listMessages(record.id),
      languageModelFor: () => model,
      tools: createBuiltinTools({ webSearch: { searchSource: () => source } }),
      now: fakeClock(),
    });

    const events = await collect(
      task.sendMessage({ text: "查一下 tavily", profile })
    );

    // 搜索源被真实调用，结果以标题/URL/摘要回填模型上下文
    expect(queries).toEqual(["tavily api"]);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("Tavily 文档");
    expect(secondPrompt).toContain("https://docs.tavily.com");
    expect(secondPrompt).toContain("Search API for AI agents.");

    const resultEvent = events.find(
      (e): e is Extract<TaskEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(resultEvent?.call.toolName).toBe("web_search");
    expect(resultEvent?.call.isError).toBe(false);
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("web_search 未配置搜索源：工具返回中文错误回填模型，任务继续不崩（工单 10）", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          { toolCallId: "w1", toolName: "web_search", input: { query: "x" } },
        ],
      },
      { kind: "text", deltas: ["没配搜索 key，我换个思路"] },
    ]);
    const persistence = createSqliteTaskStore(":memory:");
    const record = taskRecord(workspace);
    persistence.insertTask(record);
    const task = createAgentTask({
      record,
      persistence,
      history: persistence.listMessages(record.id),
      languageModelFor: () => model,
      tools: createBuiltinTools({ webSearch: { searchSource: () => null } }),
      now: fakeClock(),
    });

    const events = await collect(
      task.sendMessage({ text: "搜个东西", profile })
    );

    const resultEvent = events.find(
      (e): e is Extract<TaskEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(resultEvent?.call.isError).toBe(true);
    expect(resultEvent?.call.output).toContain("未配置搜索源");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      "未配置搜索源"
    );
    expect(events.at(-1)?.type).toBe("assistant-done");
  });

  it("工具执行中点停止（AbortSignal）：子进程被杀，结果标记为用户中断，本轮终止后可继续发消息", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "run_terminal_command",
            input: { command: "echo started; sleep 30", timeoutMs: 120_000 },
          },
        ],
      },
      { kind: "text", deltas: ["（不应被请求）"] },
    ]);
    // ask 档：echo 长命令也弹审批（本用例以批准点为 abort 计时锚点，见下）
    const askRecord = taskRecord(workspace);
    askRecord.approvalMode = "ask";
    const { task, persistence } = makeTask(model, workspace, askRecord);

    const controller = new AbortController();
    const events: TaskEvent[] = [];
    const startedAt = Date.now();
    // 批准后 1000ms 点停止：此时长命令已在执行中（echo started 已产出、sleep 30 进行中）。
    // 不能在收到 tool-call 事件后立刻 abort——生成器在 yield 处暂停，工具尚未启动；
    // 也不能从 sendMessage 起算固定延时——满载并发下 interaction-request 迟到，
    // abort 落在等待审批期（2026-11-11 全量并发 flaky 实证）。
    // 从批准点起算，abort 必落执行中（子进程被杀）。
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    for await (const event of task.sendMessage({
      text: "跑个长命令",
      profile,
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "interaction-request") {
        task.respondApproval(event.interaction.request.id, "approve");
        stopTimer = setTimeout(() => controller.abort(), 1000);
      }
    }
    clearTimeout(stopTimer);
    const elapsed = Date.now() - startedAt;

    // 结果事件标记用户中断（而非超时），进程树已被杀（不会等满 30 秒）
    const resultEvent = events.find(
      (e): e is Extract<TaskEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(resultEvent?.call.isError).toBe(true);
    expect(resultEvent?.call.output).toContain("started");
    expect(resultEvent?.call.output).toContain("已被用户中断");
    expect(resultEvent?.call.output).not.toContain("超时");
    expect(elapsed).toBeLessThan(15_000);

    // 本轮终止：assistant-aborted 收尾，状态回 idle
    expect(events.at(-1)?.type).toBe("assistant-aborted");
    expect(persistence.listTasks().at(0)?.status).toBe("idle");

    // 中断的工具调用记录落库（含用户中断标记）
    const stored = persistence.listToolCalls("task-1");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.isError).toBe(true);
    expect(stored[0]?.output).toContain("已被用户中断");

    // 中断后可继续发新消息，上下文包含中断前的历史
    const second = await collect(
      task.sendMessage({ text: "刚才怎样", profile })
    );
    expect(second.at(-1)?.type).toBe("assistant-done");
    const secondPrompt = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
    expect(secondPrompt).toContain("跑个长命令");
    expect(secondPrompt).toContain("刚才怎样");
  }, 60_000);

  it("tool-call 事件与执行之间点停止：工具不再启动，结果标记未执行", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-ws-"));
    const model = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "c1",
            toolName: "run_terminal_command",
            // 若仍被执行会留下痕迹文件，用于断言「未执行」
            input: { command: "echo leaked > interrupted-marker.txt" },
          },
        ],
      },
      { kind: "text", deltas: ["（不应被请求）"] },
    ]);
    const { task, persistence } = makeTask(model, workspace);

    const controller = new AbortController();
    const events: TaskEvent[] = [];
    for await (const event of task.sendMessage({
      text: "写个文件",
      profile,
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "tool-call") {
        // 生成器在 yield 处暂停：此刻 abort，工具尚未启动
        controller.abort();
      }
    }

    const resultEvent = events.find(
      (e): e is Extract<TaskEvent, { type: "tool-result" }> =>
        e.type === "tool-result"
    );
    expect(resultEvent?.call.isError).toBe(true);
    expect(resultEvent?.call.output).toContain("已被用户中断");
    expect(events.at(-1)?.type).toBe("assistant-aborted");

    // 工具确实未执行（无痕迹文件），记录落库
    expect(existsSync(join(workspace, "interrupted-marker.txt"))).toBe(false);
    expect(persistence.listToolCalls("task-1")[0]?.output).toContain(
      "已被用户中断"
    );
  });
});
