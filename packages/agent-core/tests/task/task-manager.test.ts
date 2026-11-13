import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import type { ThinkingEffort } from "../../src/provider/language-model";
import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteSessionStore } from "../../src/task/persistence";
import { createSessionManager } from "../../src/task/manager";

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
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createSessionManager（会话创建 / 列表 / 恢复）", () => {
  it("项目默认未置顶，管理器切换置顶但保留创建顺序和折叠状态", () => {
    const directory = mkdtempSync(join(tmpdir(), "project-pin-"));
    tempDirs.push(directory);
    const persistence = createSqliteSessionStore(":memory:");
    const manager = createSessionManager({ persistence });
    const project = manager.addProject(directory);
    expect(project.pinned).toBe(false);
    manager.setProjectCollapsed(project.id, true);
    expect(manager.setProjectPinned(project.id, true)).toMatchObject({
      pinned: true,
      collapsed: true,
    });
    expect(manager.projects().map((p) => p.id)).toEqual([project.id]);
    expect(manager.setProjectPinned("missing", true)).toBeNull();
    persistence.close();
  });
  it("create 落库并默认以工作区目录名作为标题；list 按 updatedAt 倒序", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    const session = manager.create({ workspacePath: "C:\\work\\demo" });
    // 消费完整事件流（等价一次消息往返完成）
    for await (const _event of session.sendMessage({ text: "你好", profile })) {
      // 只驱动流走完
    }

    expect(session.id).not.toBe("");
    const records = manager.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.title).toBe(basename("C:\\work\\demo") || "demo");
    expect(records[0]?.status).toBe("idle");
    persistence.close();
  });

  it("注入的模型工厂收到思考档位：sendMessage 带档位时 options 经 manager 透传到工厂", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const factoryOptions: ({ thinkingEffort?: ThinkingEffort } | undefined)[] =
      [];
    const manager = createSessionManager({
      persistence,
      languageModelFor: (_profile, options) => {
        factoryOptions.push(options);
        return okModel();
      },
    });

    const session = manager.create({ workspacePath: "C:\\work\\demo" });
    for await (const _event of session.sendMessage({
      text: "你好",
      profile,
      thinkingEffort: "high",
    })) {
      // 只驱动流走完
    }

    // 双参工厂拿到档位快照：签名与 agent-session / subagent 的注入点对齐，
    // 注入方不再因 TS 参数逆变静默丢弃 thinkingEffort
    expect(factoryOptions).toEqual([{ thinkingEffort: "high" }]);
    persistence.close();
  });

  it("create 支持 worktree 模式与外部生成的会话 id（宿主先建 worktree 再落库）", () => {
    const persistence = createSqliteSessionStore(":memory:");
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    // 宿主（desktop 主进程）先创建托管 worktree、再以同一 id 落库：workspacePath 指向副本
    const session = manager.create({
      id: "wt-session-1",
      workspacePath: "C:\\home\\.codexlike\\worktrees\\wt-session-1",
      workspaceMode: "worktree",
      title: "demo",
    });

    expect(session.id).toBe("wt-session-1");
    expect(session.record.workspaceMode).toBe("worktree");
    expect(manager.list()[0]?.workspaceMode).toBe("worktree");
    // 默认（不传模式）仍是本目录直跑
    const local = manager.create({ workspacePath: "C:\\work\\demo" });
    expect(local.record.workspaceMode).toBe("local");
    persistence.close();
  });

  it("get 惰性恢复既有会话：历史完整接续（等价应用重启后继续对话）", async () => {
    const dbPath = join(
      (() => {
        const dir = mkdtempSync(join(tmpdir(), "codexlike-mgr-"));
        tempDirs.push(dir);
        return dir;
      })(),
      "codexlike.db"
    );

    const model = okModel();
    const persistence1 = createSqliteSessionStore(dbPath);
    const first = createSessionManager({
      persistence: persistence1,
      languageModelFor: () => model,
    });
    const session = first.create({ workspacePath: "C:\\work\\demo" });
    for await (const _event of session.sendMessage({
      text: "第一问",
      profile,
    })) {
      // 消费完整流
    }
    expect(first.messages(session.id).map((m) => m.content)).toContain(
      "第一问"
    );

    // 等价重启：同一库文件上的新 manager
    const persistence2 = createSqliteSessionStore(dbPath);
    const second = createSessionManager({
      persistence: persistence2,
      languageModelFor: () => model,
    });
    const listed = second.list();
    expect(listed).toHaveLength(1);
    expect(second.messages(listed[0]!.id).map((m) => m.content)).toContain(
      "第一问"
    );

    const restored = second.get(listed[0]!.id);
    expect(restored).not.toBeNull();
    for await (const _event of restored!.sendMessage({
      text: "第二问",
      profile,
    })) {
      // 消费完整流
    }
    // 恢复后继续的对话包含重启前的历史
    const contents = second.messages(listed[0]!.id).map((m) => m.content);
    expect(contents).toContain("第一问");
    expect(contents).toContain("第二问");
    persistence1.close();
    persistence2.close();
  });

  it("恢复时把异常残留的 streaming 状态重置为 idle", () => {
    const persistence = createSqliteSessionStore(":memory:");
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const session = manager.create({ workspacePath: "C:\\work\\demo" });
    // 模拟应用在流式中途被杀：库里残留 streaming
    persistence.updateSession(session.id, { status: "streaming" });
    expect(persistence.listSessions().at(0)?.status).toBe("streaming");

    // get 惰性恢复：用全新 manager 绕过缓存，读取残留记录并重置为 idle 落库
    const manager2 = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const restored = manager2.get(session.id);
    expect(restored).not.toBeNull();
    expect(persistence.listSessions().at(0)?.status).toBe("idle");
    persistence.close();
  });

  it("transcript：消息与工具调用按时间顺序合并（重启恢复时间线用）", async () => {
    const persistence = createSqliteSessionStore(":memory:");
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const session = manager.create({ workspacePath: "C:\work\demo" });

    // 手工落库一份交错的记录（真实路径由会话循环产生；此处验证合并语义）
    persistence.insertMessage({
      id: "m1",
      sessionId: session.id,
      role: "user",
      content: "读一下",
      createdAt: "2026-11-11T08:00:01.000Z",
    });
    persistence.insertToolCall({
      id: "t1",
      sessionId: session.id,
      toolName: "read_file",
      arguments: JSON.stringify({ path: "a.txt" }),
      output: "已读",
      isError: false,
      createdAt: "2026-11-11T08:00:02.000Z",
    });
    persistence.insertMessage({
      id: "m2",
      sessionId: session.id,
      role: "assistant",
      content: "读完了",
      createdAt: "2026-11-11T08:00:03.000Z",
    });

    const transcript = manager.transcript(session.id);
    expect(transcript.map((item) => item.kind)).toEqual([
      "message",
      "tool-call",
      "message",
    ]);
    const toolItem = transcript[1];
    if (toolItem?.kind === "tool-call") {
      expect(toolItem.call.toolName).toBe("read_file");
      expect(toolItem.call.isError).toBe(false);
    }
    expect(manager.transcript("nope")).toEqual([]);
    persistence.close();
  });

  it("get 不存在的会话返回 null；create 后 get 返回同一实例（缓存）", () => {
    const persistence = createSqliteSessionStore(":memory:");
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    expect(manager.get("nope")).toBeNull();

    const session = manager.create({ workspacePath: "C:\\work\\demo" });
    expect(manager.get(session.id)).toBe(session);
    persistence.close();
  });

  it("create 默认 assist 审批模式；setApprovalMode 落库并即时生效于缓存实例", () => {
    const persistence = createSqliteSessionStore(":memory:");
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    const session = manager.create({ workspacePath: "C:\work\demo" });
    expect(session.record.approvalMode).toBe("assist");
    expect(manager.list()[0]?.approvalMode).toBe("assist");

    // 切换：落库 + 缓存实例立即拿到新档位（下一次工具调用生效）
    const updated = manager.setApprovalMode(session.id, "ask");
    expect(updated?.approvalMode).toBe("ask");
    expect(session.record.approvalMode).toBe("ask");
    expect(manager.list()[0]?.approvalMode).toBe("ask");

    // 不存在的会话返回 null
    expect(manager.setApprovalMode("nope", "full-access")).toBeNull();
    persistence.close();
  });

  it("setApprovalMode 对未实例化会话只落库：get 恢复时读到新档位", () => {
    const persistence = createSqliteSessionStore(":memory:");
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    const created = manager.create({ workspacePath: "C:\work\demo" });

    // 未 get 实例化前切换模式（IPC 可先于会话打开发生）
    manager.setApprovalMode(created.id, "full-access");
    const restored = manager.get(created.id)!;
    expect(restored.record.approvalMode).toBe("full-access");
    persistence.close();
  });

  it("恢复时把异常残留的 waiting-approval 状态重置为 idle（上次退出时等待审批中途被杀）", () => {
    const persistence = createSqliteSessionStore(":memory:");
    const manager = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    const created = manager.create({ workspacePath: "C:\work\demo" });
    // 模拟应用在等待审批时被杀：库里残留 waiting-approval
    persistence.updateSession(created.id, {
      status: "waiting-approval",
      updatedAt: "2026-11-11T09:00:00.000Z",
    });

    // 等价应用重启：全新 manager 读残留记录并重置为 idle 落库
    const manager2 = createSessionManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const restored = manager2.get(created.id)!;
    expect(restored.record.status).toBe("idle");
    expect(
      persistence.listSessions().find((r) => r.id === created.id)?.status
    ).toBe("idle");
    persistence.close();
  });

  it("审批模式默认 assist，切换后落库并跨重启恢复（工单 06 恢复语义，档位由 GLOSSARY「审批模式」定义）", () => {
    const dbPath = join(
      (() => {
        const dir = mkdtempSync(join(tmpdir(), "codexlike-mgr-"));
        tempDirs.push(dir);
        return dir;
      })(),
      "codexlike.db"
    );

    const persistence1 = createSqliteSessionStore(dbPath);
    const first = createSessionManager({
      persistence: persistence1,
      languageModelFor: () => okModel(),
    });
    const session = first.create({ workspacePath: "C:\\work\\demo" });
    expect(session.record.approvalMode).toBe("assist");

    expect(first.setApprovalMode(session.id, "full-access")?.approvalMode).toBe(
      "full-access"
    );
    expect(first.list()[0]?.approvalMode).toBe("full-access");
    expect(first.setApprovalMode("nope", "full-access")).toBeNull();
    persistence1.close();

    // 等价重启：审批模式随会话记录恢复
    const persistence2 = createSqliteSessionStore(dbPath);
    const second = createSessionManager({
      persistence: persistence2,
      languageModelFor: () => okModel(),
    });
    expect(second.list()[0]?.approvalMode).toBe("full-access");
    expect(second.get(session.id)?.record.approvalMode).toBe("full-access");
    persistence2.close();
  });
});
