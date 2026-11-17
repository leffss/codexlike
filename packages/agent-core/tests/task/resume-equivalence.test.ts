import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteTaskStore } from "../../src/task/persistence";
import { createAgentTask } from "../../src/task/agent-task";
import type { TaskEvent, TaskRecord } from "../../src/task/types";
import { createBuiltinTools } from "../../src/tools/builtin";

/**
 * 任务快照恢复等价性（工单 06 AC：恢复后「继续」在既有历史上续跑，上下文与原一致）。
 * 接缝：createAgentTask 公共接口——给定含工具轮次、@引用、被中断回复的完整历史，
 * 「重启恢复后续跑」发给模型的 prompt 必须与「不重启直接续跑」完全一致。
 */
const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  models: ["glm-4.7"],
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

function finishReason(unified: "stop" | "tool-calls") {
  return { unified, raw: unified === "stop" ? "stop" : "tool_calls" } as const;
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
        finishReason: finishReason("stop"),
      });
      controller.close();
    },
  });
}

function toolCallRound(
  calls: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }[]
) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const call of calls) {
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
        finishReason: finishReason("tool-calls"),
      });
      controller.close();
    },
  });
}

/** 子代理过程轮流式：先流出思考与正文，再以工具调用收轮（过程内容三件齐备） */
function reasoningTextToolRound(
  reasoning: string[],
  text: string[],
  calls: { toolCallId: string; toolName: string; input: unknown }[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "reasoning-start", id: "rs-1" });
      for (const delta of reasoning) {
        controller.enqueue({ type: "reasoning-delta", id: "rs-1", delta });
      }
      controller.enqueue({ type: "reasoning-end", id: "rs-1" });
      controller.enqueue({ type: "text-start", id: "text-1" });
      for (const delta of text) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta });
      }
      controller.enqueue({ type: "text-end", id: "text-1" });
      for (const call of calls) {
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
        finishReason: finishReason("tool-calls"),
      });
      controller.close();
    },
  });
}

type ScriptedStep =
  | { kind: "text"; deltas: string[] }
  | {
      kind: "tool";
      calls: { toolCallId: string; toolName: string; input: unknown }[];
    }
  | { kind: "gated-text"; deltas: string[] };

/** gated-text：产出 deltas 后挂起（等 gate 打开才继续），用于中断时序 */
function makeGatedStream(deltas: string[], gate: Promise<void>) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    async start(controller) {
      controller.enqueue({ type: "text-start", id: "text-1" });
      for (const delta of deltas) {
        controller.enqueue({ type: "text-delta", id: "text-1", delta });
      }
      await gate;
      controller.enqueue({
        type: "text-delta",
        id: "text-1",
        delta: "（不应出现）",
      });
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({
        type: "finish",
        usage: usage(),
        finishReason: finishReason("stop"),
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
      if (step.kind === "text") {
        return { stream: textRound(step.deltas) };
      }
      if (step.kind === "gated-text") {
        return { stream: makeGatedStream(step.deltas, gate!) };
      }
      return { stream: toolCallRound(step.calls) };
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

describe("任务快照恢复等价性", () => {
  it("含工具轮次、@引用与被中断回复的历史：重启恢复后续跑的模型上下文与不重启续跑完全一致", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-resume-"));
    const persistence = createSqliteTaskStore(":memory:");
    const base = taskRecord(workspace);
    persistence.insertTask(base);
    const tools = createBuiltinTools({ env: {} });

    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    // 历史：① 工具轮（write_file）→ 最终回复；② 带中断的流
    const historyModel = scriptedModel(
      [
        {
          kind: "tool",
          calls: [
            {
              toolCallId: "call-1",
              toolName: "write_file",
              input: { path: "a.txt", content: "材料内容" },
            },
          ],
        },
        { kind: "text", deltas: ["已写入 a.txt"] },
        { kind: "gated-text", deltas: ["被打断的部分"] },
      ],
      gate
    );

    // 原任务的模型可切换：跑历史用 historyModel，续跑换 inPlaceModel（记录原地续跑的 prompt）
    const resumedInPlace = scriptedModel([
      { kind: "text", deltas: ["原地续跑"] },
    ]);
    let activeModel = historyModel;
    const task = createAgentTask({
      record: base,
      persistence,
      tools,
      languageModelFor: () => activeModel,
      now: fakeClock(),
    });

    // 第 1 轮：@引用 附件 + 工具调用
    await collect(
      task.sendMessage({
        text: "读取材料并写入 a.txt",
        profile,
        mentions: [{ path: "material.txt", content: "被引用的文件内容" }],
      })
    );
    // 第 2 轮：流式中断
    const controller = new AbortController();
    for await (const event of task.sendMessage({
      text: "慢慢说",
      profile,
      signal: controller.signal,
    })) {
      if (event.type === "assistant-delta") {
        controller.abort();
      }
    }
    openGate();

    // 恢复任务在历史定格时构造（等价应用重启：读库重建上下文）
    const restoredRecord = persistence.listTasks().at(0)!;
    expect(restoredRecord.providerProfileId).toBe("profile-1");
    expect(restoredRecord.model).toBe("glm-4.7");

    const resumedAfterRestart = scriptedModel([
      { kind: "text", deltas: ["恢复后续跑"] },
    ]);
    const restoredTask = createAgentTask({
      record: restoredRecord,
      persistence,
      history: persistence.listMessages("task-1"),
      tools,
      languageModelFor: () => resumedAfterRestart,
      now: fakeClock(),
    });

    // 路径 A（不重启）：原任务对象直接续跑（内存上下文：含 @引用 组装后的 user 消息）
    activeModel = resumedInPlace;
    await collect(task.sendMessage({ text: "继续", profile }));

    // 路径 B（重启恢复）：恢复的任务续跑
    await collect(restoredTask.sendMessage({ text: "继续", profile }));

    // 两条路径发给模型的 prompt 必须完全一致（mentions 内容、工具轮、中断消息都不丢）
    expect(resumedAfterRestart.doStreamCalls).toHaveLength(1);
    expect(resumedInPlace.doStreamCalls).toHaveLength(1);
    expect(resumedInPlace.doStreamCalls[0]?.prompt).toEqual(
      resumedAfterRestart.doStreamCalls[0]?.prompt
    );

    // 快照等价的实质：@引用 内容与中断前的历史都在恢复后的上下文里
    const promptJson = JSON.stringify(
      resumedAfterRestart.doStreamCalls[0]?.prompt
    );
    expect(promptJson).toContain("被引用的文件内容");
    expect(promptJson).toContain("读取材料并写入 a.txt");
    expect(promptJson).toContain("已写入 a.txt");
    expect(promptJson).toContain("被打断的部分");
    expect(promptJson).toContain("慢慢说");
    expect(promptJson).toContain("继续");
  });

  it("带子代理委派的任务：恢复续跑 prompt 与不重启一致，且不含任何子代理过程内容（ADR 0021 隔离守护）", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codexlike-resume-sub-"));
    writeFileSync(join(workspace, "note.txt"), "子代理要读的文件内容");
    const persistence = createSqliteTaskStore(":memory:");
    const base = taskRecord(workspace);
    persistence.insertTask(base);
    const tools = createBuiltinTools({ env: {} });

    const subProfile: ProviderProfile = {
      id: "sub-profile",
      name: "GLM 子代理",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "sk-sub",
      models: ["glm-4.7-air"],
    };
    // 子模型两轮：① 思考+正文+读文件工具轮（过程内容）；② 报告轮
    let subCall = 0;
    const subModel = new MockLanguageModelV4({
      doStream: async () => {
        subCall += 1;
        return subCall === 1
          ? {
              stream: reasoningTextToolRound(
                ["子代理过程思考"],
                ["子代理中间轮正文"],
                [
                  {
                    toolCallId: "sub-read",
                    toolName: "read_file",
                    input: { path: "note.txt" },
                  },
                ]
              ),
            }
          : { stream: textRound(["最终报告：已核实 note.txt"]) };
      },
    });
    // 主模型：委派工具轮 → 汇总文本轮；续跑时切换为记录模型
    const mainModel = scriptedModel([
      {
        kind: "tool",
        calls: [
          {
            toolCallId: "call-spawn",
            toolName: "spawn_subagent",
            input: { task: "调研子任务" },
          },
        ],
      },
      { kind: "text", deltas: ["汇总完成"] },
    ]);
    const resumedInPlace = scriptedModel([
      { kind: "text", deltas: ["原地续跑"] },
    ]);
    let activeMain = mainModel;
    const subagentsConfig = {
      tools,
      languageModelFor: () => subModel,
      settings: () => ({ maxConcurrent: 3 }),
      resolveModel: async () => ({
        profile: subProfile,
        model: subProfile.models[0]!,
      }),
    };
    const task = createAgentTask({
      record: base,
      persistence,
      tools,
      languageModelFor: () => activeMain,
      subagents: subagentsConfig,
      now: fakeClock(),
    });

    await collect(task.sendMessage({ text: "委派调研", profile }));

    // 库里确有完整子代理过程（守护不空转：内容真实存在于存储，只是不进上下文）
    expect(
      persistence.listSubagentMessages("task-1").map((row) => row.content)
    ).toEqual(["子代理中间轮正文", "最终报告：已核实 note.txt"]);
    expect(
      persistence
        .listSubagentMessages("task-1")
        .some((row) => row.reasoning === "子代理过程思考")
    ).toBe(true);
    expect(persistence.listSubagentToolCalls("task-1")).toHaveLength(1);

    // 恢复路径（等价重启）：新任务对象读库重建上下文后续跑
    const restoredRecord = persistence.listTasks().at(0)!;
    const resumedAfterRestart = scriptedModel([
      { kind: "text", deltas: ["恢复后续跑"] },
    ]);
    const restoredTask = createAgentTask({
      record: restoredRecord,
      persistence,
      history: persistence.listMessages("task-1"),
      tools,
      languageModelFor: () => resumedAfterRestart,
      subagents: {
        ...subagentsConfig,
        languageModelFor: () => subModel,
      },
      now: fakeClock(),
    });

    // 路径 A（不重启）：原任务对象直接续跑
    activeMain = resumedInPlace;
    await collect(task.sendMessage({ text: "继续", profile }));
    // 路径 B（重启恢复）：恢复的任务续跑
    await collect(restoredTask.sendMessage({ text: "继续", profile }));

    expect(resumedAfterRestart.doStreamCalls).toHaveLength(1);
    expect(resumedInPlace.doStreamCalls).toHaveLength(1);
    expect(resumedInPlace.doStreamCalls[0]?.prompt).toEqual(
      resumedAfterRestart.doStreamCalls[0]?.prompt
    );

    const promptJson = JSON.stringify(
      resumedAfterRestart.doStreamCalls[0]?.prompt
    );
    // 主上下文的合法组成：用户消息与主代理最终正文（工具轮只活在轮内 pending，
    // 轮末不进长期上下文——这是主代理工具的既有语义，子代理不得更宽）
    expect(promptJson).toContain("委派调研");
    expect(promptJson).toContain("汇总完成");
    expect(promptJson).toContain("继续");
    // 隔离的结构性守护：任何子代理过程内容都不进上下文——逐轮思考（也随 spawn
    // 行 reasoning 列落库）、逐轮正文、工具结果、委派参数与最终报告（spawn 行
    // output，落库仅供检视）一概不出现
    expect(promptJson).not.toContain("子代理过程思考");
    expect(promptJson).not.toContain("子代理中间轮正文");
    expect(promptJson).not.toContain("子代理要读的文件内容");
    expect(promptJson).not.toContain("调研子任务");
    expect(promptJson).not.toContain("最终报告：已核实 note.txt");
  });
});
