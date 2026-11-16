import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import type { ThinkingEffort } from "../../src/provider/language-model";
import type { ProviderProfile } from "../../src/provider/provider-profile";
import { createSqliteTaskStore } from "../../src/task/persistence";
import { createTaskManager } from "../../src/task/manager";
import type { SubagentStatus } from "../../src/task/types";

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

describe("createTaskManager（任务创建 / 列表 / 恢复）", () => {
  it("项目默认未置顶，管理器切换置顶但保留创建顺序和折叠状态", () => {
    const directory = mkdtempSync(join(tmpdir(), "project-pin-"));
    tempDirs.push(directory);
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({ persistence });
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
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    const task = manager.create({ workspacePath: "C:\\work\\demo" });
    // 消费完整事件流（等价一次消息往返完成）
    for await (const _event of task.sendMessage({ text: "你好", profile })) {
      // 只驱动流走完
    }

    expect(task.id).not.toBe("");
    const records = manager.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.title).toBe(basename("C:\\work\\demo") || "demo");
    expect(records[0]?.status).toBe("idle");
    persistence.close();
  });

  it("注入的模型工厂收到思考档位：sendMessage 带档位时 options 经 manager 透传到工厂", async () => {
    const persistence = createSqliteTaskStore(":memory:");
    const factoryOptions: ({ thinkingEffort?: ThinkingEffort } | undefined)[] =
      [];
    const manager = createTaskManager({
      persistence,
      languageModelFor: (_profile, options) => {
        factoryOptions.push(options);
        return okModel();
      },
    });

    const task = manager.create({ workspacePath: "C:\\work\\demo" });
    for await (const _event of task.sendMessage({
      text: "你好",
      profile,
      thinkingEffort: "high",
    })) {
      // 只驱动流走完
    }

    // 双参工厂拿到档位快照：签名与 agent-task / subagent 的注入点对齐，
    // 注入方不再因 TS 参数逆变静默丢弃 thinkingEffort
    expect(factoryOptions).toEqual([{ thinkingEffort: "high" }]);
    persistence.close();
  });

  it("create 支持 worktree 模式与外部生成的任务 id（宿主先建 worktree 再落库）", () => {
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    // 宿主（desktop 主进程）先创建托管 worktree、再以同一 id 落库：workspacePath 指向副本
    const task = manager.create({
      id: "wt-task-1",
      workspacePath: "C:\\home\\.codexlike\\worktrees\\wt-task-1",
      workspaceMode: "worktree",
      title: "demo",
    });

    expect(task.id).toBe("wt-task-1");
    expect(task.record.workspaceMode).toBe("worktree");
    expect(manager.list()[0]?.workspaceMode).toBe("worktree");
    // 默认（不传模式）仍是本目录直跑
    const local = manager.create({ workspacePath: "C:\\work\\demo" });
    expect(local.record.workspaceMode).toBe("local");
    persistence.close();
  });

  it("get 惰性恢复既有任务：历史完整接续（等价应用重启后继续对话）", async () => {
    const dbPath = join(
      (() => {
        const dir = mkdtempSync(join(tmpdir(), "codexlike-mgr-"));
        tempDirs.push(dir);
        return dir;
      })(),
      "codexlike.db"
    );

    const model = okModel();
    const persistence1 = createSqliteTaskStore(dbPath);
    const first = createTaskManager({
      persistence: persistence1,
      languageModelFor: () => model,
    });
    const task = first.create({ workspacePath: "C:\\work\\demo" });
    for await (const _event of task.sendMessage({
      text: "第一问",
      profile,
    })) {
      // 消费完整流
    }
    expect(first.messages(task.id).map((m) => m.content)).toContain("第一问");

    // 等价重启：同一库文件上的新 manager
    const persistence2 = createSqliteTaskStore(dbPath);
    const second = createTaskManager({
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
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const task = manager.create({ workspacePath: "C:\\work\\demo" });
    // 模拟应用在流式中途被杀：库里残留 streaming
    persistence.updateTask(task.id, { status: "streaming" });
    expect(persistence.listTasks().at(0)?.status).toBe("streaming");

    // get 惰性恢复：用全新 manager 绕过缓存，读取残留记录并重置为 idle 落库
    const manager2 = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const restored = manager2.get(task.id);
    expect(restored).not.toBeNull();
    expect(persistence.listTasks().at(0)?.status).toBe("idle");
    persistence.close();
  });

  it("启动收尾把残留 queued/running 子代理骨架行标记 interrupted，终态行不动且二次重开幂等（ADR 0021）", () => {
    const dbPath = join(
      (() => {
        const dir = mkdtempSync(join(tmpdir(), "codexlike-subagent-recover-"));
        tempDirs.push(dir);
        return dir;
      })(),
      "codexlike.db"
    );
    const persistence1 = createSqliteTaskStore(dbPath);
    const manager1 = createTaskManager({
      persistence: persistence1,
      languageModelFor: () => okModel(),
    });
    const task = manager1.create({ workspacePath: "C:\\work\\demo" });
    // 模拟被杀进程留下的骨架行：queued（排队中被杀）、running（运行中被杀）、
    // 两条已正常收尾的终态行
    const insert = (id: string, status: SubagentStatus) =>
      persistence1.insertSubagent({
        id,
        taskId: task.id,
        task: `委派 ${id}`,
        status,
        queuedAt: "2026-11-11T08:00:01.000Z",
        startedAt: status === "queued" ? null : "2026-11-11T08:00:02.000Z",
        completedAt:
          status === "completed" || status === "failed"
            ? "2026-11-11T08:00:03.000Z"
            : null,
      });
    insert("sub-queued", "queued");
    insert("sub-running", "running");
    insert("sub-done", "completed");
    insert("sub-fail", "failed");
    persistence1.close();

    // 等价应用重启：新 store + 新 manager，启动收尾补记 interrupted
    const persistence2 = createSqliteTaskStore(dbPath);
    createTaskManager({ persistence: persistence2 });
    const rows = new Map(
      persistence2.listSubagents(task.id).map((row) => [row.id, row])
    );
    expect(rows.get("sub-queued")?.status).toBe("interrupted");
    expect(rows.get("sub-queued")?.completedAt).not.toBeNull();
    expect(rows.get("sub-running")?.status).toBe("interrupted");
    expect(rows.get("sub-running")?.completedAt).not.toBeNull();
    // 终态行不受收尾影响（留痕不被改写）
    expect(rows.get("sub-done")).toMatchObject({ status: "completed" });
    expect(rows.get("sub-fail")).toMatchObject({ status: "failed" });
    persistence2.close();

    // 二次重开幂等：interrupted 行不再变化
    const persistence3 = createSqliteTaskStore(dbPath);
    createTaskManager({ persistence: persistence3 });
    const settled = persistence3
      .listSubagents(task.id)
      .filter((row) => row.status === "interrupted");
    expect(settled.map((row) => row.id).sort()).toEqual([
      "sub-queued",
      "sub-running",
    ]);
    persistence3.close();
  });

  it("subagents：骨架+逐轮消息+工具调用一次读出并按委派归组；transcript 不读子代理行（ADR 0021 票 03）", () => {
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const task = manager.create({ workspacePath: "C:\\work\\demo" });

    // 手工落库两份委派的过程记录（真实路径由子代理循环逐条实时写；
    // 此处验证恢复数据面的归组语义：骨架按排队序、消息/工具按写入序归属）
    const insert = (id: string, queuedAt: string) =>
      persistence.insertSubagent({
        id,
        taskId: task.id,
        task: `委派 ${id}`,
        status: "completed",
        queuedAt,
        startedAt: "2026-11-11T08:00:02.000Z",
        completedAt: "2026-11-11T08:00:09.000Z",
      });
    insert("sub-b", "2026-11-11T08:00:01.000Z");
    insert("sub-a", "2026-11-11T08:00:05.000Z");
    const insertMessage = (
      id: string,
      subagentId: string,
      content: string,
      reasoning?: string
    ) =>
      persistence.insertSubagentMessage({
        id,
        taskId: task.id,
        subagentId,
        content,
        ...(reasoning ? { reasoning } : {}),
        createdAt: `2026-11-11T08:00:0${id.at(-1)}.000Z`,
      });
    insertMessage("sm1", "sub-b", "第一轮正文", "第一轮思考");
    insertMessage("sm2", "sub-a", "另一委派的正文");
    insertMessage("sm3", "sub-b", "第二轮正文");
    persistence.insertSubagentToolCall({
      id: "st1",
      taskId: task.id,
      subagentId: "sub-b",
      toolName: "read_file",
      arguments: "{}",
      output: "已读",
      isError: false,
      createdAt: "2026-11-11T08:00:03.500Z",
    });
    persistence.insertSubagentToolCall({
      id: "st2",
      taskId: task.id,
      subagentId: "sub-a",
      toolName: "run_command",
      arguments: "{}",
      output: "已跑",
      isError: true,
      createdAt: "2026-11-11T08:00:06.500Z",
    });

    const subagents = manager.subagents(task.id);
    // 骨架按排队时间正序（与 listSubagents 同序）
    expect(subagents.map((snapshot) => snapshot.record.id)).toEqual([
      "sub-b",
      "sub-a",
    ]);
    expect(subagents[0]?.record).toMatchObject({
      task: "委派 sub-b",
      status: "completed",
      startedAt: "2026-11-11T08:00:02.000Z",
      completedAt: "2026-11-11T08:00:09.000Z",
    });
    // 逐轮消息与工具调用按委派归组、保持写入序（轮边界即行边界）
    expect(subagents[0]?.messages.map((row) => row.id)).toEqual(["sm1", "sm3"]);
    expect(subagents[0]?.messages[0]?.reasoning).toBe("第一轮思考");
    expect(subagents[0]?.messages[1]?.reasoning).toBeUndefined();
    expect(subagents[0]?.toolCalls.map((row) => row.id)).toEqual(["st1"]);
    expect(subagents[1]?.messages.map((row) => row.id)).toEqual(["sm2"]);
    expect(subagents[1]?.toolCalls.map((row) => row.id)).toEqual(["st2"]);
    expect(subagents[1]?.toolCalls[0]?.isError).toBe(true);
    // 隔离的结构性守护：时间线（模型上下文组装的数据来源）不含子代理过程行
    expect(manager.transcript(task.id)).toEqual([]);
    expect(manager.subagents("nope")).toEqual([]);
    persistence.close();
  });

  it("transcript：消息与工具调用按时间顺序合并（重启恢复时间线用）", async () => {
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const task = manager.create({ workspacePath: "C:\work\demo" });

    // 手工落库一份交错的记录（真实路径由任务循环产生；此处验证合并语义）
    persistence.insertMessage({
      id: "m1",
      taskId: task.id,
      role: "user",
      content: "读一下",
      createdAt: "2026-11-11T08:00:01.000Z",
    });
    persistence.insertToolCall({
      id: "t1",
      taskId: task.id,
      toolName: "read_file",
      arguments: JSON.stringify({ path: "a.txt" }),
      output: "已读",
      isError: false,
      createdAt: "2026-11-11T08:00:02.000Z",
    });
    persistence.insertMessage({
      id: "m2",
      taskId: task.id,
      role: "assistant",
      content: "读完了",
      createdAt: "2026-11-11T08:00:03.000Z",
    });

    const transcript = manager.transcript(task.id);
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

  it("get 不存在的任务返回 null；create 后 get 返回同一实例（缓存）", () => {
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    expect(manager.get("nope")).toBeNull();

    const task = manager.create({ workspacePath: "C:\\work\\demo" });
    expect(manager.get(task.id)).toBe(task);
    persistence.close();
  });

  it("create 默认 assist 审批模式；setApprovalMode 落库并即时生效于缓存实例", () => {
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    const task = manager.create({ workspacePath: "C:\work\demo" });
    expect(task.record.approvalMode).toBe("assist");
    expect(manager.list()[0]?.approvalMode).toBe("assist");

    // 切换：落库 + 缓存实例立即拿到新档位（下一次工具调用生效）
    const updated = manager.setApprovalMode(task.id, "ask");
    expect(updated?.approvalMode).toBe("ask");
    expect(task.record.approvalMode).toBe("ask");
    expect(manager.list()[0]?.approvalMode).toBe("ask");

    // 不存在的任务返回 null
    expect(manager.setApprovalMode("nope", "full-access")).toBeNull();
    persistence.close();
  });

  it("setApprovalMode 对未实例化任务只落库：get 恢复时读到新档位", () => {
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    const created = manager.create({ workspacePath: "C:\work\demo" });

    // 未 get 实例化前切换模式（IPC 可先于任务打开发生）
    manager.setApprovalMode(created.id, "full-access");
    const restored = manager.get(created.id)!;
    expect(restored.record.approvalMode).toBe("full-access");
    persistence.close();
  });

  it("setApprovalMode 档位实际变更时自动撤销任务自动批准（反馈1：换档即收权，同档不动）", () => {
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const task = manager.create({ workspacePath: "C:\\work\\demo" });
    // 开启自动批准（任务授权批量批准后的落库状态；走授权事务才置位，这里模拟已置位）
    persistence.updateTask(task.id, { autoApprove: true });
    task.record.autoApprove = true;
    expect(task.record.autoApprove).toBe(true);

    // 换档：自动批准随之撤销（内存 + 落库）
    const updated = manager.setApprovalMode(task.id, "ask");
    expect(updated?.approvalMode).toBe("ask");
    expect(updated?.autoApprove).toBe(false);
    expect(task.record.autoApprove).toBe(false);
    expect(task.record.approvalMode).toBe("ask");
    expect(
      persistence.listTasks().find((r) => r.id === task.id)?.autoApprove
    ).toBe(false);

    // 同档重复设置（每次发送都会同步偏好）：不动授权状态
    persistence.updateTask(task.id, { autoApprove: true });
    task.record.autoApprove = true;
    const same = manager.setApprovalMode(task.id, "ask");
    expect(same?.autoApprove).toBe(true);
    expect(task.record.autoApprove).toBe(true);

    // 未实例化任务（第二实例未缓存）：换档同样撤销，只落库
    persistence.updateTask(task.id, { autoApprove: true });
    const manager2 = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const updated2 = manager2.setApprovalMode(task.id, "full-access");
    expect(updated2?.approvalMode).toBe("full-access");
    expect(updated2?.autoApprove).toBe(false);
    expect(
      persistence.listTasks().find((r) => r.id === task.id)?.autoApprove
    ).toBe(false);
    persistence.close();
  });

  it("恢复时把异常残留的 waiting-approval 状态重置为 idle（上次退出时等待审批中途被杀）", () => {
    const persistence = createSqliteTaskStore(":memory:");
    const manager = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });

    const created = manager.create({ workspacePath: "C:\work\demo" });
    // 模拟应用在等待审批时被杀：库里残留 waiting-approval
    persistence.updateTask(created.id, {
      status: "waiting-approval",
      updatedAt: "2026-11-11T09:00:00.000Z",
    });

    // 等价应用重启：全新 manager 读残留记录并重置为 idle 落库
    const manager2 = createTaskManager({
      persistence,
      languageModelFor: () => okModel(),
    });
    const restored = manager2.get(created.id)!;
    expect(restored.record.status).toBe("idle");
    expect(
      persistence.listTasks().find((r) => r.id === created.id)?.status
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

    const persistence1 = createSqliteTaskStore(dbPath);
    const first = createTaskManager({
      persistence: persistence1,
      languageModelFor: () => okModel(),
    });
    const task = first.create({ workspacePath: "C:\\work\\demo" });
    expect(task.record.approvalMode).toBe("assist");

    expect(first.setApprovalMode(task.id, "full-access")?.approvalMode).toBe(
      "full-access"
    );
    expect(first.list()[0]?.approvalMode).toBe("full-access");
    expect(first.setApprovalMode("nope", "full-access")).toBeNull();
    persistence1.close();

    // 等价重启：审批模式随任务记录恢复
    const persistence2 = createSqliteTaskStore(dbPath);
    const second = createTaskManager({
      persistence: persistence2,
      languageModelFor: () => okModel(),
    });
    expect(second.list()[0]?.approvalMode).toBe("full-access");
    expect(second.get(task.id)?.record.approvalMode).toBe("full-access");
    persistence2.close();
  });
});
