import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteTaskStore } from "../../src/task/persistence";
import type {
  SubagentMessageRecord,
  SubagentRecord,
  SubagentToolCallRecord,
  TaskRecord,
  StoredMessage,
} from "../../src/task/types";

/** 最小合法任务记录（固定时间戳避免测试不稳定） */
function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    creationRequestId: null,
    title: "demo",
    workspacePath: "C:\\work\\demo",
    providerProfileId: null,
    model: null,
    status: "idle",
    workspaceMode: "local",
    projectId: null,
    workspaceOriginPath: null,
    approvalMode: "assist",
    autoApprove: false,
    archivedAt: null,
    pinned: false,
    lastUsedAt: overrides.createdAt ?? "2026-11-10T08:00:00.000Z",
    createdAt: "2026-11-10T08:00:00.000Z",
    updatedAt: "2026-11-10T08:00:00.000Z",
    ...overrides,
  };
}

/** 最小合法消息记录 */
function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "message-1",
    taskId: "task-1",
    role: "user",
    content: "你好",
    createdAt: "2026-11-10T08:00:01.000Z",
    ...overrides,
  };
}

const tempDirs: string[] = [];

/** 每个用例独立的临时目录（文件库路径） */
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "codexlike-store-"));
  tempDirs.push(dir);
  return join(dir, "codexlike.db");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createSqliteTaskStore（SQLite 任务持久化）", () => {
  it("项目置顶跨重启保存且不改变创建顺序，旧项目幂等补列默认关闭", () => {
    const path = tempDbPath();
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      INSERT INTO projects VALUES ('old', '旧项目', '/old', '2026-01-01');`);
    raw.close();
    const store = createSqliteTaskStore(path);
    expect(store.listProjects()[0]?.pinned).toBe(false);
    store.insertProject({
      id: "new",
      name: "新项目",
      workspacePath: "/new",
      createdAt: "2026-01-02",
    });
    store.setProjectPinned("new", true);
    expect(store.listProjects().map((p) => p.id)).toEqual(["old", "new"]);
    store.close();
    const reopened = createSqliteTaskStore(path);
    expect(reopened.listProjects().map((p) => p.pinned)).toEqual([false, true]);
    reopened.setProjectPinned("new", false);
    expect(reopened.listProjects()[1]?.pinned).toBe(false);
    reopened.close();
  });
  it("自动批准默认关闭、独立于遗留命令授权，更新后跨重启保留", () => {
    const path = tempDbPath();
    const first = createSqliteTaskStore(path);
    first.insertTask(taskRecord());
    first.insertApproval("task-1", "git");
    expect(first.listTasks()[0]?.autoApprove).toBe(false);
    first.updateTask("task-1", { autoApprove: true });
    first.close();
    const reopened = createSqliteTaskStore(path);
    expect(reopened.listTasks()[0]?.autoApprove).toBe(true);
    reopened.insertTask(taskRecord({ id: "new" }));
    expect(reopened.listTasks().find((s) => s.id === "new")?.autoApprove).toBe(
      false
    );
    reopened.close();
  });
  it("插入的任务与消息可原样读回（内存库）", () => {
    const store = createSqliteTaskStore(":memory:");

    store.insertTask(taskRecord());
    store.insertMessage(message());
    store.insertMessage(
      message({
        id: "message-2",
        role: "assistant",
        content: "你好，有什么可以帮你？",
        createdAt: "2026-11-10T08:00:02.000Z",
      })
    );

    expect(store.listTasks()).toEqual([taskRecord()]);
    expect(store.listMessages("task-1")).toEqual([
      message(),
      message({
        id: "message-2",
        role: "assistant",
        content: "你好，有什么可以帮你？",
        createdAt: "2026-11-10T08:00:02.000Z",
      }),
    ]);
  });

  it("任务记录的 (providerProfileId, model) 二元组跨重启存取一致（票 02）", () => {
    const path = tempDbPath();
    const first = createSqliteTaskStore(path);
    first.insertTask(
      taskRecord({
        providerProfileId: "profile-1",
        model: "glm-4.6",
      })
    );
    first.updateTask("task-1", {
      providerProfileId: "profile-1",
      model: "glm-4.6",
    });
    first.close();

    const reopened = createSqliteTaskStore(path);
    const stored = reopened.listTasks().find((s) => s.id === "task-1");
    expect(stored?.providerProfileId).toBe("profile-1");
    expect(stored?.model).toBe("glm-4.6");
    reopened.close();
  });

  it("同一路径重开 store（等价应用重启）数据完整恢复", () => {
    const dbPath = tempDbPath();

    const first = createSqliteTaskStore(dbPath);
    first.insertTask(taskRecord({ id: "task-a", title: "项目A" }));
    first.insertTask(
      taskRecord({
        id: "task-b",
        title: "项目B",
        createdAt: "2026-11-10T09:00:00.000Z",
        updatedAt: "2026-11-10T09:00:00.000Z",
      })
    );
    first.insertMessage(message({ taskId: "task-b" }));
    first.close();

    const reopened = createSqliteTaskStore(dbPath);
    // 最近使用倒序：task-b（09:00）比 task-a（08:00）新
    const ids = reopened.listTasks().map((s) => s.id);
    expect(ids).toEqual(["task-b", "task-a"]);
    expect(reopened.listMessages("task-b")).toHaveLength(1);
    reopened.close();
  });

  it("后台记录更新不改变最近使用排序", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(
      taskRecord({ id: "old", updatedAt: "2026-11-10T08:00:00.000Z" })
    );
    store.insertTask(
      taskRecord({
        id: "new",
        createdAt: "2026-11-10T09:00:00.000Z",
        updatedAt: "2026-11-10T09:00:00.000Z",
      })
    );

    store.updateTask("old", {
      status: "streaming",
      updatedAt: "2026-11-10T10:00:00.000Z",
    });

    expect(store.listTasks().map((s) => s.id)).toEqual(["new", "old"]);
    expect(store.listTasks()[1]?.status).toBe("streaming");
  });

  it("未写入过的任务消息查询返回空数组", () => {
    const store = createSqliteTaskStore(":memory:");
    expect(store.listMessages("nope")).toEqual([]);
  });

  it("审批模式随任务落库：insert 读回一致，updateTask 补丁生效", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRecord({ approvalMode: "ask" }));
    expect(store.listTasks()[0]?.approvalMode).toBe("ask");

    store.updateTask("task-1", {
      approvalMode: "full-access",
      updatedAt: "2026-11-10T08:30:00.000Z",
    });
    expect(store.listTasks()[0]?.approvalMode).toBe("full-access");
  });

  it("旧三档值读侧迁移（ADR 0004，不回写）：readonly→ask、suggest→assist、full→full-access；非法值回退 assist", () => {
    const dbPath = tempDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        provider_profile_id TEXT,
        model TEXT,
        status TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        workspace_mode TEXT NOT NULL DEFAULT 'local',
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES ('legacy-ro', '旧只读', 'C:\\work\\old', NULL, NULL, 'idle', 'readonly', 'local', NULL, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
      INSERT INTO tasks VALUES ('legacy-sg', '旧协作', 'C:\\work\\old', NULL, NULL, 'idle', 'suggest', 'local', NULL, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
      INSERT INTO tasks VALUES ('legacy-fl', '旧自主', 'C:\\work\\old', NULL, NULL, 'idle', 'full', 'local', NULL, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
      INSERT INTO tasks VALUES ('legacy-bad', '损坏值', 'C:\\work\\old', NULL, NULL, 'idle', 'yolo', 'local', NULL, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    `);
    raw.close();

    const store = createSqliteTaskStore(dbPath);
    const byId = new Map(store.listTasks().map((r) => [r.id, r.approvalMode]));
    expect(byId.get("legacy-ro")).toBe("ask");
    expect(byId.get("legacy-sg")).toBe("assist");
    expect(byId.get("legacy-fl")).toBe("full-access");
    expect(byId.get("legacy-bad")).toBe("assist");
    // 不回写：库里仍是旧值（幂等迁移，无数据改写风险）
    const rawAgain = new DatabaseSync(dbPath);
    const values = rawAgain
      .prepare("SELECT approval_mode FROM tasks WHERE id = 'legacy-ro'")
      .all() as { approval_mode: string }[];
    expect(values[0]?.approval_mode).toBe("readonly");
    rawAgain.close();
    store.close();
  });

  it("运行模式（local/worktree）随任务落库：insert 读回一致，updateTask 补丁生效", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRecord({ workspaceMode: "worktree" }));
    expect(store.listTasks()[0]?.workspaceMode).toBe("worktree");

    store.updateTask("task-1", {
      workspaceMode: "local",
      updatedAt: "2026-11-10T08:40:00.000Z",
    });
    expect(store.listTasks()[0]?.workspaceMode).toBe("local");
  });

  it("worktree 任务的原始仓库路径（workspaceOriginPath）随任务落库读回；local 任务为 null（ADR 0005）", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(
      taskRecord({
        id: "task-wt",
        workspaceMode: "worktree",
        workspacePath: "C:\\home\\.codexlike\\worktrees\\task-wt",
        workspaceOriginPath: "C:\\work\\demo",
        updatedAt: "2026-11-10T08:30:00.000Z",
      })
    );
    store.insertTask(taskRecord());

    const byId = new Map(
      store.listTasks().map((r) => [r.id, r.workspaceOriginPath])
    );
    expect(byId.get("task-wt")).toBe("C:\\work\\demo");
    expect(byId.get("task-1")).toBeNull();
    store.close();
  });

  it("旧库迁移（ADR 0005）：无 workspace_origin_path 列的存量库打开后补列，旧行读回 null 且新写入正常", () => {
    const dbPath = tempDbPath();
    // ADR 0005 之前的生产库形状（有 workspace_mode、无 workspace_origin_path）
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        provider_profile_id TEXT,
        model TEXT,
        status TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        workspace_mode TEXT NOT NULL DEFAULT 'local',
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES ('legacy-wt', '旧worktree任务', 'C:\\home\\.codexlike\\worktrees\\legacy-wt', NULL, NULL, 'idle', 'assist', 'worktree', NULL, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    `);
    raw.close();

    const store = createSqliteTaskStore(dbPath);
    store.insertTask(
      taskRecord({
        id: "task-wt",
        workspaceMode: "worktree",
        workspacePath: "C:\\home\\.codexlike\\worktrees\\task-wt",
        workspaceOriginPath: "C:\\work\\demo",
      })
    );

    const byId = new Map(
      store.listTasks().map((r) => [r.id, r.workspaceOriginPath])
    );
    expect(byId.get("legacy-wt")).toBeNull();
    expect(byId.get("task-wt")).toBe("C:\\work\\demo");
    store.close();
  });

  it("旧库迁移：无 workspace_mode 列的旧任务恢复为 local（本目录直跑）", () => {
    const dbPath = tempDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        provider_profile_id TEXT,
        model TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES ('legacy-wt', '旧任务', 'C:\\work\\old', NULL, NULL, 'idle', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    `);
    raw.close();

    const store = createSqliteTaskStore(dbPath);
    expect(store.listTasks()[0]?.workspaceMode).toBe("local");
    store.close();
  });

  it("「总是允许」记忆入库：幂等（同词不重复）、按任务隔离、重开库完整恢复", () => {
    const dbPath = tempDbPath();
    const first = createSqliteTaskStore(dbPath);
    first.insertTask(taskRecord({ id: "task-a" }));
    first.insertTask(
      taskRecord({
        id: "task-b",
        createdAt: "2026-11-10T09:00:00.000Z",
        updatedAt: "2026-11-10T09:00:00.000Z",
      })
    );

    first.insertApproval("task-a", "git");
    first.insertApproval("task-a", "git"); // 幂等：同词重复写入不重复
    first.insertApproval("task-a", "pnpm");
    first.insertApproval("task-b", "npm");

    expect(first.listApprovals("task-a")).toEqual(["git", "pnpm"]);
    expect(first.listApprovals("task-b")).toEqual(["npm"]);
    expect(first.listApprovals("nope")).toEqual([]);
    first.close();

    // 等价应用重启：记忆完整恢复（审批恢复后仍生效的数据来源）
    const reopened = createSqliteTaskStore(dbPath);
    expect(reopened.listApprovals("task-a")).toEqual(["git", "pnpm"]);
    reopened.close();
  });

  it("旧库迁移：工单 03 时代 schema（无 approval_mode / approvals 表）打开后自动补齐", () => {
    const dbPath = tempDbPath();
    // 手工建 03 时代的旧 schema 并写入一行旧任务
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        provider_profile_id TEXT,
        model TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES ('legacy-1', '旧任务', 'C:\\work\\old', NULL, NULL, 'idle', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    `);
    raw.close();

    // 打开旧库：迁移幂等补列（approval_mode 默认 assist）+ approvals 表可用
    const store = createSqliteTaskStore(dbPath);
    const record = store.listTasks()[0]!;
    expect(record.id).toBe("legacy-1");
    expect(record.approvalMode).toBe("assist");
    store.insertApproval("legacy-1", "git");
    expect(store.listApprovals("legacy-1")).toEqual(["git"]);
    store.updateTask("legacy-1", {
      approvalMode: "full-access",
      updatedAt: "2026-11-02T00:00:00.000Z",
    });
    expect(store.listTasks()[0]?.approvalMode).toBe("full-access");
    store.close();
  });

  it("消息的 @引用 与中断标记原样往返（快照恢复的数据来源）", () => {
    const dbPath = tempDbPath();
    const store = createSqliteTaskStore(dbPath);
    store.insertTask(taskRecord());
    store.insertMessage(
      message({
        mentions: [{ path: "material.txt", content: "被引用的文件内容" }],
      })
    );
    store.insertMessage(
      message({
        id: "message-2",
        role: "assistant",
        content: "部分回复",
        aborted: true,
        createdAt: "2026-11-10T08:00:02.000Z",
      })
    );
    store.close();

    const reopened = createSqliteTaskStore(dbPath);
    const restored = reopened.listMessages("task-1");
    expect(restored[0]?.mentions).toEqual([
      { path: "material.txt", content: "被引用的文件内容" },
    ]);
    expect(restored[0]?.aborted).toBeUndefined();
    expect(restored[1]?.aborted).toBe(true);
    expect(restored[1]?.mentions).toBeUndefined();
    reopened.close();
  });

  it("reasoning 随消息与工具调用记录落库：重开库完整恢复（票 02 思考回看的数据来源）", () => {
    const dbPath = tempDbPath();
    const store = createSqliteTaskStore(dbPath);
    store.insertTask(taskRecord());
    store.insertMessage(
      message({
        id: "assistant-1",
        role: "assistant",
        content: "正文回答",
        reasoning: "先想想再回答",
        createdAt: "2026-11-10T08:00:02.000Z",
      })
    );
    store.insertMessage(
      message({
        id: "assistant-2",
        role: "assistant",
        content: "无思考的回答",
        createdAt: "2026-11-10T08:00:03.000Z",
      })
    );
    store.insertToolCall({
      id: "delegate-1",
      taskId: "task-1",
      toolName: "spawn_subagent",
      arguments: '{"task":"调研"}',
      output: "子代理报告",
      isError: false,
      reasoning: "子代理思考全文",
      createdAt: "2026-11-10T08:00:04.000Z",
    });
    store.insertToolCall({
      id: "call-1",
      taskId: "task-1",
      toolName: "read_file",
      arguments: '{"path":"a.txt"}',
      output: "内容",
      isError: false,
      createdAt: "2026-11-10T08:00:05.000Z",
    });
    store.close();

    const reopened = createSqliteTaskStore(dbPath);
    const messages = reopened.listMessages("task-1");
    expect(messages[0]?.reasoning).toBe("先想想再回答");
    expect(messages[0]?.content).toBe("正文回答");
    // 无思考的消息：reasoning 保持 undefined（旧数据等价，不产生空字符串）
    expect(messages[1]?.reasoning).toBeUndefined();
    const calls = reopened.listToolCalls("task-1");
    expect(calls[0]?.reasoning).toBe("子代理思考全文");
    expect(calls[0]?.output).toBe("子代理报告");
    expect(calls[1]?.reasoning).toBeUndefined();
    reopened.close();
  });

  it("旧库迁移（票 02）：messages/tool_calls 无 reasoning 列的存量库打开后补列，旧行读回无思考且新写入正常", async () => {
    const dbPath = tempDbPath();
    // 票 02 之前的生产库形状：messages / tool_calls 均无 reasoning 列
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_path TEXT NOT NULL,
      provider_profile_id TEXT, model TEXT, status TEXT NOT NULL, approval_mode TEXT NOT NULL DEFAULT 'assist',
      workspace_mode TEXT NOT NULL DEFAULT 'local', archived_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    raw.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      mentions TEXT,
      aborted INTEGER
    )`);
    raw.exec(`CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      arguments TEXT NOT NULL,
      output TEXT NOT NULL,
      is_error INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
    raw.exec(`INSERT INTO tasks (id, title, workspace_path, status, created_at, updated_at)
      VALUES ('task-1', 'demo', 'C:\\work\\demo', 'idle', '2026-11-10T08:00:00.000Z', '2026-11-10T08:00:00.000Z')`);
    raw.exec(`INSERT INTO messages (id, task_id, role, content, created_at)
      VALUES ('legacy-a', 'task-1', 'assistant', '旧回答', '2026-11-10T08:00:01.000Z')`);
    raw.exec(`INSERT INTO tool_calls (id, task_id, tool_name, arguments, output, is_error, created_at)
      VALUES ('legacy-d', 'task-1', 'spawn_subagent', '{"task":"旧任务"}', '旧报告', 0, '2026-11-10T08:00:02.000Z')`);
    raw.close();

    const migrated = createSqliteTaskStore(dbPath);
    // 旧行读回：reasoning 自然缺失（undefined），不报错、不产生空思考
    expect(migrated.listMessages("task-1")[0]?.reasoning).toBeUndefined();
    expect(migrated.listToolCalls("task-1")[0]?.reasoning).toBeUndefined();
    // 迁移后可按新 schema 写入思考
    migrated.insertMessage(
      message({
        id: "new-a",
        role: "assistant",
        content: "新回答",
        reasoning: "新思考",
        createdAt: "2026-11-10T08:00:03.000Z",
      })
    );
    expect(migrated.listMessages("task-1")[1]?.reasoning).toBe("新思考");
    migrated.close();
  });

  it("工单 03 时代的旧库（messages 无 mentions/aborted 列）打开时幂等迁移，旧数据可读", async () => {
    const dbPath = tempDbPath();
    // 手工建工单 03 时代的旧 schema（messages 无 mentions / aborted 列，07 踩坑样例）
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_path TEXT NOT NULL,
      provider_profile_id TEXT, model TEXT, status TEXT NOT NULL, archived_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.prepare(
      "INSERT INTO tasks (id, title, workspace_path, provider_profile_id, model, status, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "task-1",
      "demo",
      "C:\\work\\demo",
      null,
      null,
      "idle",
      null,
      "2026-11-10T08:00:00.000Z",
      "2026-11-10T08:00:00.000Z"
    );
    db.prepare(
      "INSERT INTO messages (id, task_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("legacy-1", "task-1", "user", "旧消息", "2026-11-10T08:00:01.000Z");
    db.close();

    const migrated = createSqliteTaskStore(dbPath);
    const messages = migrated.listMessages("task-1");
    expect(messages).toEqual([
      {
        id: "legacy-1",
        taskId: "task-1",
        role: "user",
        content: "旧消息",
        createdAt: "2026-11-10T08:00:01.000Z",
      },
    ]);
    // 迁移后可继续按新 schema 写入
    migrated.insertMessage(
      message({ id: "new-1", createdAt: "2026-11-10T08:00:02.000Z" })
    );
    expect(migrated.listMessages("task-1")).toHaveLength(2);
    migrated.close();
  });
});

describe("TaskPersistence compact 落库（工单 08）", () => {
  it("replaceHistory 单事务替换消息历史并追加 compact 记录；重开库完整恢复", () => {
    const dbPath = tempDbPath();
    const store = createSqliteTaskStore(dbPath);
    store.insertTask(taskRecord());
    store.insertMessage(message({ id: "m1", content: "旧问题1" }));
    store.insertMessage(
      message({
        id: "m2",
        role: "assistant",
        content: "旧回复1",
        createdAt: "2026-11-10T08:00:02.000Z",
      })
    );
    store.insertMessage(
      message({
        id: "m3",
        content: "旧问题2",
        createdAt: "2026-11-10T08:00:03.000Z",
      })
    );

    store.replaceHistory(
      "task-1",
      [
        message({
          id: "summary-1",
          role: "compact-summary",
          content: "摘要",
          createdAt: "2026-11-10T09:00:00.000Z",
        }),
        message({
          id: "kept-1",
          content: "旧问题2",
          createdAt: "2026-11-10T09:00:01.000Z",
        }),
      ],
      {
        id: "compact-1",
        taskId: "task-1",
        summary: "摘要",
        messagesCompacted: 2,
        createdAt: "2026-11-10T09:00:02.000Z",
      }
    );
    store.close();

    const reopened = createSqliteTaskStore(dbPath);
    expect(reopened.listMessages("task-1").map((m) => [m.id, m.role])).toEqual([
      ["summary-1", "compact-summary"],
      ["kept-1", "user"],
    ]);
    expect(reopened.listCompacts("task-1")).toEqual([
      {
        id: "compact-1",
        taskId: "task-1",
        summary: "摘要",
        messagesCompacted: 2,
        createdAt: "2026-11-10T09:00:02.000Z",
      },
    ]);
    reopened.close();
  });

  it("listCompacts 按时间正序（多次压缩累积，末条为当前生效摘要）", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRecord());
    const compact = (id: string, at: string) =>
      store.replaceHistory(
        "task-1",
        [
          message({
            id: `s-${id}`,
            role: "compact-summary",
            content: `摘要${id}`,
            createdAt: at,
          }),
        ],
        {
          id,
          taskId: "task-1",
          summary: `摘要${id}`,
          messagesCompacted: 2,
          createdAt: at,
        }
      );
    compact("c-2", "2026-11-10T09:00:00.000Z");
    compact("c-1", "2026-11-10T08:00:00.000Z");

    expect(store.listCompacts("task-1").map((c) => c.id)).toEqual([
      "c-1",
      "c-2",
    ]);
    expect(store.listCompacts("nope")).toEqual([]);
    store.close();
  });

  it("工单 02/07 时代的旧库（无 compact_records 表）打开时自动建表，旧数据不受影响", () => {
    const dbPath = tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_path TEXT NOT NULL,
        provider_profile_id TEXT, model TEXT, status TEXT NOT NULL, archived_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES ('task-1', 'demo', 'C:\\work', NULL, NULL, 'idle', NULL, '2026-11-10T08:00:00.000Z', '2026-11-10T08:00:00.000Z');
      INSERT INTO messages VALUES ('m1', 'task-1', 'user', '旧消息', '2026-11-10T08:00:01.000Z');
    `);
    db.close();

    const store = createSqliteTaskStore(dbPath);
    expect(store.listMessages("task-1")).toHaveLength(1);
    expect(store.listCompacts("task-1")).toEqual([]);
    store.close();
  });

  it("数据库父目录不存在时自动创建（打包后首次启动，~/.codexlike 尚未建立的场景）", () => {
    const dir = mkdtempSync(join(tmpdir(), "codexlike-mkdir-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "nested", "deeper", "codexlike.db");

    const store = createSqliteTaskStore(dbPath);
    store.insertTask(taskRecord());
    store.insertMessage(message());
    store.close();

    // 重开验证：目录由 store 自建，库文件落在嵌套路径且可读回
    const reopened = createSqliteTaskStore(dbPath);
    expect(reopened.listMessages("task-1")).toHaveLength(1);
    reopened.close();
  });
});

describe("TaskPersistence 子代理骨架表（ADR 0021，票 01）", () => {
  /** 最小合法子代理骨架行（queued 即写的入队瞬间形状） */
  function subagentRow(
    overrides: Partial<SubagentRecord> = {}
  ): SubagentRecord {
    return {
      id: "sub-1",
      taskId: "task-1",
      task: "调研本仓库的测试框架并总结",
      status: "queued",
      queuedAt: "2026-11-10T08:00:01.000Z",
      startedAt: null,
      completedAt: null,
      ...overrides,
    };
  }

  it("骨架行插入读回往返：insertSubagent 原样读回，updateSubagent 状态补丁生效（内存库）", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRecord());
    store.insertSubagent(subagentRow());
    expect(store.listSubagents("task-1")).toEqual([subagentRow()]);
    expect(store.listSubagents("nope")).toEqual([]);

    // 状态机推进（编排器写点）：queued → running → 终态，只更新给定字段
    store.updateSubagent("sub-1", {
      status: "running",
      startedAt: "2026-11-10T08:00:02.000Z",
    });
    store.updateSubagent("sub-1", {
      status: "completed",
      completedAt: "2026-11-10T08:00:03.000Z",
    });
    expect(store.listSubagents("task-1")).toEqual([
      subagentRow({
        status: "completed",
        startedAt: "2026-11-10T08:00:02.000Z",
        completedAt: "2026-11-10T08:00:03.000Z",
      }),
    ]);
    // 目标不存在时静默忽略（与 updateTask 同语义）
    store.updateSubagent("missing", { status: "running" });
    expect(store.listSubagents("task-1")).toHaveLength(1);
    store.close();
  });

  it("骨架行按任务列出、排队时间正序；文件库关-重开完整恢复（等价应用重启）", () => {
    const dbPath = tempDbPath();
    const store = createSqliteTaskStore(dbPath);
    store.insertTask(taskRecord());
    store.insertSubagent(
      subagentRow({ id: "sub-2", queuedAt: "2026-11-10T08:00:02.000Z" })
    );
    store.insertSubagent(
      subagentRow({
        id: "sub-1",
        queuedAt: "2026-11-10T08:00:01.000Z",
        status: "running",
        startedAt: "2026-11-10T08:00:03.000Z",
      })
    );
    store.close();

    const reopened = createSqliteTaskStore(dbPath);
    expect(reopened.listSubagents("task-1").map((row) => row.id)).toEqual([
      "sub-1",
      "sub-2",
    ]);
    expect(reopened.listSubagents("task-1")[0]).toEqual(
      subagentRow({
        id: "sub-1",
        queuedAt: "2026-11-10T08:00:01.000Z",
        status: "running",
        startedAt: "2026-11-10T08:00:03.000Z",
      })
    );
    reopened.close();
  });

  it("旧库（无子代理三表）打开时幂等补建，旧行可读且新写入正常", () => {
    const dbPath = tempDbPath();
    // 票 01 之前的生产库形状：无 subagents / subagent_messages / subagent_tool_calls
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_path TEXT NOT NULL,
        provider_profile_id TEXT, model TEXT, status TEXT NOT NULL, archived_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES ('legacy-1', '旧任务', 'C:\\work\\old', NULL, NULL, 'idle', NULL, '2026-11-10T08:00:00.000Z', '2026-11-10T08:00:00.000Z');
      INSERT INTO messages VALUES ('m1', 'legacy-1', 'user', '旧消息', '2026-11-10T08:00:01.000Z');
    `);
    raw.close();

    const store = createSqliteTaskStore(dbPath);
    // 旧行可读：旧任务与旧消息不受补建影响
    expect(store.listMessages("legacy-1").map((m) => m.content)).toEqual([
      "旧消息",
    ]);
    expect(store.listSubagents("legacy-1")).toEqual([]);
    // 补建后可按新 schema 写入骨架行
    store.insertSubagent(
      subagentRow({
        id: "new-sub",
        taskId: "legacy-1",
        status: "interrupted",
        completedAt: "2026-11-10T09:00:00.000Z",
      })
    );
    expect(store.listSubagents("legacy-1")[0]?.status).toBe("interrupted");
    store.close();

    // 三张子代理表都已补建（另两张票 01 只建表不写入，验证表存在即可）
    const verify = new DatabaseSync(dbPath);
    const tables = verify
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = new Set(tables.map((row) => row.name));
    expect(names.has("subagents")).toBe(true);
    expect(names.has("subagent_messages")).toBe(true);
    expect(names.has("subagent_tool_calls")).toBe(true);
    verify.close();
  });

  it("removeProject 清理任务数据时子代理三表行同步清理，无孤儿行", () => {
    const dbPath = tempDbPath();
    const store = createSqliteTaskStore(dbPath);
    store.insertProject({
      id: "proj-1",
      name: "项目",
      workspacePath: "C:\\work\\proj",
      createdAt: "2026-11-10T08:00:00.000Z",
    });
    store.insertTask(
      taskRecord({
        id: "task-proj",
        projectId: "proj-1",
        workspacePath: "C:\\work\\proj",
      })
    );
    store.insertTask(
      taskRecord({ id: "task-free", workspacePath: "C:\\work\\free" })
    );
    store.insertSubagent(subagentRow({ id: "sub-proj", taskId: "task-proj" }));
    store.insertSubagent(subagentRow({ id: "sub-free", taskId: "task-free" }));
    // 另两张表票 01 尚无写入方，用原生 SQL 模拟票 02 落下的过程行
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      INSERT INTO subagent_messages (id, task_id, subagent_id, content, reasoning, created_at)
        VALUES ('sm-1', 'task-proj', 'sub-proj', '正文', '思考', '2026-11-10T08:00:02.000Z');
      INSERT INTO subagent_tool_calls (id, task_id, subagent_id, tool_name, arguments, output, is_error, created_at)
        VALUES ('st-1', 'task-proj', 'sub-proj', 'read_file', '{}', '内容', 0, '2026-11-10T08:00:03.000Z');
    `);
    raw.close();

    store.removeProject("proj-1");
    expect(store.listSubagents("task-proj")).toEqual([]);
    // 独立任务的骨架行不受影响
    expect(store.listSubagents("task-free").map((row) => row.id)).toEqual([
      "sub-free",
    ]);
    const verify = new DatabaseSync(dbPath);
    const orphans = verify
      .prepare(
        "SELECT (SELECT COUNT(*) FROM subagent_messages WHERE task_id = 'task-proj') AS messages, (SELECT COUNT(*) FROM subagent_tool_calls WHERE task_id = 'task-proj') AS tool_calls"
      )
      .all() as { messages: number; tool_calls: number }[];
    expect(orphans[0]).toEqual({ messages: 0, tool_calls: 0 });
    verify.close();
    store.close();
  });
});

describe("TaskPersistence 子代理过程表（ADR 0021，票 02）", () => {
  /** 最小合法逐轮消息行（轮终态写入的形状：正文 + 思考 + 双归属） */
  function subagentMessageRow(
    overrides: Partial<SubagentMessageRecord> = {}
  ): SubagentMessageRecord {
    return {
      id: "sm-1",
      taskId: "task-1",
      subagentId: "sub-1",
      content: "第一轮正文",
      reasoning: "第一轮思考",
      createdAt: "2026-11-10T08:00:02.000Z",
      ...overrides,
    };
  }

  /** 最小合法工具调用行（工具完成即写的形状：截断口径同主代理 tool_calls） */
  function subagentToolCallRow(
    overrides: Partial<SubagentToolCallRecord> = {}
  ): SubagentToolCallRecord {
    return {
      id: "st-1",
      taskId: "task-1",
      subagentId: "sub-1",
      toolName: "read_file",
      arguments: '{"path":"a.txt"}',
      output: "文件内容",
      isError: false,
      createdAt: "2026-11-10T08:00:03.000Z",
      ...overrides,
    };
  }

  it("逐轮消息与逐条工具调用插入读回往返：reasoning 缺失归一，未知任务空数组", () => {
    const store = createSqliteTaskStore(":memory:");
    store.insertTask(taskRecord());
    store.insertSubagentMessage(subagentMessageRow());
    store.insertSubagentMessage(
      subagentMessageRow({
        id: "sm-2",
        reasoning: undefined,
        content: "第二轮正文",
        createdAt: "2026-11-10T08:00:04.000Z",
      })
    );
    store.insertSubagentToolCall(subagentToolCallRow({ isError: true }));
    expect(store.listSubagentMessages("task-1")).toEqual([
      subagentMessageRow(),
      subagentMessageRow({
        id: "sm-2",
        reasoning: undefined,
        content: "第二轮正文",
        createdAt: "2026-11-10T08:00:04.000Z",
      }),
    ]);
    // reasoning 列为空时读回不产生空思考段（与 messages.reasoning 归一口径一致）
    expect(store.listSubagentMessages("task-1")[1]?.reasoning).toBeUndefined();
    expect(store.listSubagentToolCalls("task-1")).toEqual([
      subagentToolCallRow({ isError: true }),
    ]);
    expect(store.listSubagentMessages("nope")).toEqual([]);
    expect(store.listSubagentToolCalls("nope")).toEqual([]);
    store.close();
  });

  it("过程行按任务列出、写入时间正序；文件库关-重开完整恢复（等价应用重启）", () => {
    const dbPath = tempDbPath();
    const store = createSqliteTaskStore(dbPath);
    store.insertTask(taskRecord());
    store.insertSubagentMessage(
      subagentMessageRow({ id: "sm-b", createdAt: "2026-11-10T08:00:09.000Z" })
    );
    store.insertSubagentMessage(
      subagentMessageRow({
        id: "sm-a",
        subagentId: "sub-2",
        createdAt: "2026-11-10T08:00:05.000Z",
      })
    );
    store.insertSubagentToolCall(
      subagentToolCallRow({ id: "st-b", createdAt: "2026-11-10T08:00:08.000Z" })
    );
    store.insertSubagentToolCall(
      subagentToolCallRow({
        id: "st-a",
        subagentId: "sub-2",
        createdAt: "2026-11-10T08:00:06.000Z",
      })
    );
    store.close();

    const reopened = createSqliteTaskStore(dbPath);
    // 同任务内按写入时间正序、行 id 保序（时间戳并列时按 rowid）
    expect(
      reopened.listSubagentMessages("task-1").map((row) => row.id)
    ).toEqual(["sm-a", "sm-b"]);
    expect(
      reopened.listSubagentToolCalls("task-1").map((row) => row.id)
    ).toEqual(["st-a", "st-b"]);
    // 双归属齐读：跨子代理的行各自携带 subagentId
    expect(
      new Set(
        reopened.listSubagentMessages("task-1").map((row) => row.subagentId)
      )
    ).toEqual(new Set(["sub-1", "sub-2"]));
    reopened.close();
  });
});
