import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteTaskStore } from "../../src/task/persistence";
import { createTaskManager } from "../../src/task/manager";

/** 工单 07：/rename /archive 与 AGENTS.md 系统提示注入（manager 层） */
const profile: ProviderProfile = {
  id: "profile-1",
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
  model: "glm-4.7",
};

function okModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "text-1" });
          controller.enqueue({
            type: "text-delta",
            id: "text-1",
            delta: "好的",
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
              outputTokens: { total: 1, text: undefined, reasoning: undefined },
            },
            finishReason: { unified: "stop" as const, raw: "stop" },
          });
          controller.close();
        },
      }),
    }),
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TaskManager /rename 与 /archive（会话管理命令）", () => {
  it("create 默认未归档；rename 更新标题并落库", () => {
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    const session = manager.create({ workspacePath: "C:\\work\\demo" });
    expect(manager.list().at(0)?.archivedAt).toBeNull();

    const renamed = manager.rename(session.id, "修登录 bug");
    expect(renamed).toMatchObject({
      id: session.id,
      title: "修登录 bug",
      archivedAt: null,
    });
    expect(manager.list().at(0)?.title).toBe("修登录 bug");

    // 不存在的任务返回 null
    expect(manager.rename("nope", "x")).toBeNull();
    persistence.close();
  });

  it("setArchived 归档落库（archivedAt 时间戳），取消归档恢复 null", () => {
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
      now: () => "2026-11-11T08:00:00.000Z",
    });

    const session = manager.create({ workspacePath: "C:\\work\\demo" });
    const archived = manager.setArchived(session.id, true);
    expect(archived?.archivedAt).toBe("2026-11-11T08:00:00.000Z");
    expect(manager.list().at(0)?.archivedAt).toBe("2026-11-11T08:00:00.000Z");

    const unarchived = manager.setArchived(session.id, false);
    expect(unarchived?.archivedAt).toBeNull();
    expect(manager.list().at(0)?.archivedAt).toBeNull();

    expect(manager.setArchived("nope", true)).toBeNull();
    persistence.close();
  });

  it("旧库（无 archived_at 列）打开时自动迁移：既有记录 archivedAt 为 null", () => {
    const dir = mkdtempSync(join(tmpdir(), "codexlike-mig-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "codexlike.db");

    // 手工建工单 02 时代的旧 schema 并写入一行
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      provider_profile_id TEXT,
      model TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    legacy
      .prepare(
        "INSERT INTO tasks VALUES ('s1', '旧会话', 'C:\\work\\demo', NULL, NULL, 'idle', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')"
      )
      .run();
    legacy.close();

    const persistence = createSqliteTaskStore(dbPath);
    expect(persistence.listTasks().at(0)).toMatchObject({
      id: "s1",
      archivedAt: null,
    });
    // 迁移后新列可写
    persistence.updateSession("s1", { archivedAt: "2026-11-11T08:00:00.000Z" });
    expect(persistence.listTasks().at(0)?.archivedAt).toBe(
      "2026-11-11T08:00:00.000Z"
    );
    persistence.close();
  });
});

describe("TaskManager 系统提示注入（systemPromptFor）", () => {
  it("create 与 get 恢复都会话注入 systemPromptFor 的系统提示", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codexlike-sys-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "codexlike.db");
    const model = okModel();

    const persistence1 = createSqliteTaskStore(dbPath);
    const first = createTaskManager({
      persistence: persistence1,
      languageModelFor: () => model,
      systemPromptFor: (record) => `规范：${record.workspacePath}`,
    });
    const session = first.create({ workspacePath: "C:\\work\\demo" });
    for await (const _event of session.sendMessage({ text: "你好", profile })) {
      // 消费完整流
    }
    const firstPrompt = model.doStreamCalls[0]?.prompt as {
      role: string;
      content: string;
    }[];
    expect(firstPrompt?.[0]).toMatchObject({
      role: "system",
      content: "规范：C:\\work\\demo",
    });

    // 等价重启：恢复的任务同样注入系统提示
    const persistence2 = createSqliteTaskStore(dbPath);
    const second = createTaskManager({
      persistence: persistence2,
      languageModelFor: () => model,
      systemPromptFor: (record) => `规范：${record.workspacePath}`,
    });
    const restored = second.get(session.id);
    expect(restored).not.toBeNull();
    for await (const _event of restored!.sendMessage({
      text: "第二问",
      profile,
    })) {
      // 消费完整流
    }
    const secondPrompt = model.doStreamCalls[1]?.prompt as {
      role: string;
      content: string;
    }[];
    expect(secondPrompt?.[0]).toMatchObject({
      role: "system",
      content: "规范：C:\\work\\demo",
    });
    persistence1.close();
    persistence2.close();
  });
});

describe("TaskManager compact 支持（工单 08）", () => {
  /** 双通道模型：doStream 对话 + doGenerate 压缩摘要 */
  function dualModel() {
    let streamCall = 0;
    return new MockLanguageModelV4({
      doStream: async () => {
        streamCall += 1;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "text-1" });
              controller.enqueue({
                type: "text-delta",
                id: "text-1",
                delta: `回复${streamCall}`,
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
        };
      },
      doGenerate: async () => ({
        content: [{ type: "text", text: "压缩摘要" }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
    });
  }

  it("latestCompact：未压缩 null；压缩后返回最近记录；重启后仍可读", async () => {
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => dualModel(),
      now: () => "2026-11-11T08:00:00.000Z",
    });
    const session = manager.create({ workspacePath: "C:\work\demo" });

    expect(manager.latestCompact(session.id)).toBeNull();

    for (let i = 1; i <= 4; i += 1) {
      for await (const _event of session.sendMessage({
        text: `问${i}`,
        profile,
      })) {
        // 消费完整流
      }
    }
    await session.compact({ profile });

    const latest = manager.latestCompact(session.id);
    expect(latest).toMatchObject({
      sessionId: session.id,
      summary: "压缩摘要",
      messagesCompacted: 2,
    });
    persistence.close();
  });

  it("压缩后 manager.get 恢复的会话继续对话，上下文含摘要", async () => {
    const persistence = createSqliteTaskStore(":memory:");
    const model = dualModel();
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => model,
    });
    const session = manager.create({ workspacePath: "C:\work\demo" });
    for (let i = 1; i <= 4; i += 1) {
      for await (const _event of session.sendMessage({
        text: `问${i}`,
        profile,
      })) {
        // 消费完整流
      }
    }
    await session.compact({ profile });
    const callsBefore = model.doStreamCalls.length;

    // 抛弃缓存实例（模拟重启后 get）：从库恢复，摘要仍在上下文中
    const restored = manager.get(session.id)!;
    expect(restored.id).toBe(session.id);
    for await (const _event of restored.sendMessage({
      text: "继续",
      profile,
    })) {
      // 消费完整流
    }
    const lastPrompt = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
    expect(lastPrompt).toContain("compact-summary");
    expect(lastPrompt).toContain("压缩摘要");
    expect(model.doStreamCalls.length).toBe(callsBefore + 1);
    persistence.close();
  });
});
