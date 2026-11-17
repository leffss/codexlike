import { MockLanguageModelV4 } from "ai/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteTaskStore } from "../../src/task/persistence";
import { createAgentTask } from "../../src/task/agent-task";
import type { TaskEvent, TaskRecord } from "../../src/task/types";
import type {
  CreateLanguageModelOptions,
  ProviderProfile,
} from "../../src/index";

/**
 * 任务级模型选择（票 02，ADR 0024 二元组）：sendMessage / compact 携带
 * (providerProfileId, model)，模型经 resolveModelOf 归一（缺省与失效一律
 * 回退 Profile 列表第一项），落库 TaskRecord.model、传给 languageModelFor
 * 的 options.model。Seam：AgentTask 公共接口 + languageModelFor 注入点
 * 收到的 model 快照 + SQLite 落库记录。
 */
const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  models: ["glm-4.7", "glm-4.6"],
};

function taskRecord(): TaskRecord {
  return {
    id: "task-1",
    title: "demo",
    workspacePath: "C:/work/demo",
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

function fakeClock() {
  let tick = 0;
  return () => `2026-11-11T08:00:${String(++tick).padStart(2, "0")}.000Z`;
}

const tempStores: ReturnType<typeof createSqliteTaskStore>[] = [];
const tempDirs: string[] = [];

/** 记录 languageModelFor 收到的 (profile, options) 快照并返回固定成功模型 */
function makeRecordingTask(
  options: {
    record?: TaskRecord;
    history?: Parameters<typeof createAgentTask>[0]["history"];
  } = {}
) {
  const persistence = createSqliteTaskStore(":memory:");
  tempStores.push(persistence);
  const record = options.record ?? taskRecord();
  persistence.insertTask(record);
  const modelCalls: {
    profileId: string;
    options: CreateLanguageModelOptions;
  }[] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "text-1" });
          controller.enqueue({
            type: "text-delta",
            id: "text-1",
            delta: "回复",
          });
          controller.enqueue({ type: "text-end", id: "text-1" });
          controller.enqueue({
            type: "finish",
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
            finishReason: { unified: "stop" as const, raw: "stop" },
          });
          controller.close();
        },
      }),
    }),
    doGenerate: async () => ({
      content: [{ type: "text", text: "摘要" }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: {
          total: 1,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: 1,
          text: undefined,
          reasoning: undefined,
        },
      },
      warnings: [],
    }),
  });
  const task = createAgentTask({
    record,
    persistence,
    history: options.history ?? persistence.listMessages(record.id),
    languageModelFor: (modelProfile, modelOptions) => {
      modelCalls.push({
        profileId: modelProfile.id,
        options: { ...modelOptions },
      });
      return model;
    },
    now: fakeClock(),
  });
  return { task, persistence, modelCalls };
}

afterEach(() => {
  for (const store of tempStores.splice(0)) {
    store.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function collect(
  iterable: AsyncIterable<TaskEvent>
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("AgentTask 任务级模型选择（票 02 二元组）", () => {
  it("sendMessage 携带的 model 传给 languageModelFor 并落库 TaskRecord.model", async () => {
    const { task, persistence, modelCalls } = makeRecordingTask();
    await collect(
      task.sendMessage({ text: "打个招呼", profile, model: "glm-4.6" })
    );

    expect(modelCalls.map((call) => call.options.model)).toEqual(["glm-4.6"]);
    const stored = persistence.listTasks().find((task) => task.id === "task-1");
    expect(stored?.model).toBe("glm-4.6");
    expect(stored?.providerProfileId).toBe("profile-1");
  });

  it("sendMessage 未携带 model（新建任务默认）回退 Profile 列表第一项", async () => {
    const { task, persistence, modelCalls } = makeRecordingTask();
    await collect(task.sendMessage({ text: "打个招呼", profile }));

    expect(modelCalls.map((call) => call.options.model)).toEqual(["glm-4.7"]);
    expect(
      persistence.listTasks().find((task) => task.id === "task-1")?.model
    ).toBe("glm-4.7");
  });

  it("sendMessage 携带的 model 已从 Profile 列表删除时回退第一项（记录失效）", async () => {
    const { task, persistence, modelCalls } = makeRecordingTask();
    await collect(
      task.sendMessage({ text: "打个招呼", profile, model: "glm-4.5" })
    );

    expect(modelCalls.map((call) => call.options.model)).toEqual(["glm-4.7"]);
    expect(
      persistence.listTasks().find((task) => task.id === "task-1")?.model
    ).toBe("glm-4.7");
  });
});

describe("AgentTask /compact 任务级模型选择（票 02 二元组）", () => {
  /** 压缩装配：直接注入足够长的历史（与 compact 既有测试同构） */
  function makeCompactRecordingTask() {
    return makeRecordingTask({
      history: Array.from({ length: 8 }, (_, index) => ({
        id: `history-${index}`,
        taskId: "task-1",
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `历史 ${index}`,
        createdAt: `2026-11-11T08:00:0${index}.000Z`,
      })),
    });
  }

  it("compact 携带的 model 传给 languageModelFor 并落库（压缩沿用任务所选模型）", async () => {
    const { task, persistence, modelCalls } = makeCompactRecordingTask();
    await task.compact({ profile, model: "glm-4.6" });

    expect(modelCalls.map((call) => call.options.model)).toEqual(["glm-4.6"]);
    expect(
      persistence.listTasks().find((task) => task.id === "task-1")?.model
    ).toBe("glm-4.6");
  });

  it("compact 未携带 model 回退 Profile 列表第一项", async () => {
    const { task, modelCalls } = makeCompactRecordingTask();
    await task.compact({ profile });

    expect(modelCalls.map((call) => call.options.model)).toEqual(["glm-4.7"]);
  });
});

describe("SQLite 存量任务无 model 记录（票 02 兼容，ADR 0024）", () => {
  it("旧库任务行 model 为 NULL：读回 null，恢复后续跑回退 Profile 列表第一项", async () => {
    // 文件库：先经 store 建库写入，再以原生 SQL 把 model 置 NULL——模拟
    // 票 02 升级前创建的存量任务行（无 model 记录）
    const dir = mkdtempSync(join(tmpdir(), "codexlike-model-selection-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "codexlike.db");
    const seed = createSqliteTaskStore(dbPath);
    seed.insertTask(taskRecord());
    seed.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE tasks SET model = NULL WHERE id = 'task-1'");
    raw.close();

    const persistence = createSqliteTaskStore(dbPath);
    tempStores.push(persistence);
    const restored = persistence
      .listTasks()
      .find((record) => record.id === "task-1");
    expect(restored?.model).toBeNull();

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({
              type: "text-delta",
              id: "text-1",
              delta: "ok",
            });
            controller.enqueue({ type: "text-end", id: "text-1" });
            controller.enqueue({
              type: "finish",
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: 1,
                  text: undefined,
                  reasoning: undefined,
                },
              },
              finishReason: { unified: "stop" as const, raw: "stop" },
            });
            controller.close();
          },
        }),
      }),
    });
    const modelCalls: (string | undefined)[] = [];
    const task = createAgentTask({
      record: restored!,
      persistence,
      languageModelFor: (_profile, options) => {
        modelCalls.push(options.model);
        return model;
      },
      now: fakeClock(),
    });
    await collect(task.sendMessage({ text: "继续跑", profile }));

    // 存量任务解析为列表第一项；落库补上 model 记录（下次恢复不再回退）
    expect(modelCalls).toEqual(["glm-4.7"]);
    expect(
      persistence.listTasks().find((record) => record.id === "task-1")?.model
    ).toBe("glm-4.7");
  });
});
