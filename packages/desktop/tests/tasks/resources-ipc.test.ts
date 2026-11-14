import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentResourceSnapshot,
  createTaskManager,
  createSqliteTaskStore,
  createWorktreeService,
} from "@codexlike/agent-core/node";

import { registerTaskHandlers } from "../../src/tasks/task-ipc";
import { createProfileStore } from "../../src/profiles/profile-store";
import { IPC } from "../../src/shared/ipc";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  dialog: {},
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(name, handler),
  },
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  handlers.clear();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "codexlike-resource-ipc-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const skillDir = join(workspace, ".agents", "skills", "review");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(workspace, "AGENTS.md"), "当前项目规范");
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: review\ndescription: 审查改动\n---\nSECRET_SKILL_BODY"
  );
  const persistence = createSqliteTaskStore(":memory:");
  cleanups.push(() => persistence.close());
  const resourcesFor = ({ workspacePath }: { workspacePath: string }) =>
    createAgentResourceSnapshot({
      workspacePath,
      globalDir: join(root, "home"),
      compatibleGlobalDir: join(root, "compatible"),
      findGitRoot: () => null,
    });
  const manager = createTaskManager({ persistence, resourcesFor });
  const task = manager.create({ workspacePath: workspace });
  const profiles = createProfileStore({
    dir: join(root, "profiles"),
    safeStorage: {
      isEncryptionAvailable: async () => true,
      encryptString: async (text) => Buffer.from(text),
      decryptString: async (bytes) => bytes.toString(),
    },
  });
  registerTaskHandlers({
    manager,
    profiles,
    getWindow: () => null,
    dataDir: root,
    worktreeService: createWorktreeService({
      worktreesDir: join(root, "worktrees"),
    }),
    resourcesFor,
  });
  return { task, workspace };
}

function invoke(name: string, ...args: unknown[]) {
  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`未注册通道 ${name}`);
  return handler({}, ...args);
}

describe("规范与技能 IPC", () => {
  it("只返回元数据，首次预览不实例化加载正文，外部编辑后预览刷新", async () => {
    const { task, workspace } = setup();
    const first = invoke(IPC.tasks.resources, task.id);
    expect(first).toMatchObject({
      active: null,
      last: null,
      preview: { loaded: [] },
    });
    expect(JSON.stringify(first)).toContain("审查改动");
    expect(JSON.stringify(first)).not.toContain("SECRET_SKILL_BODY");
    writeFileSync(join(workspace, "AGENTS.md"), "变更后的新规范内容");
    const status = await invoke(IPC.tasks.status, task.id);
    expect(status).toMatchObject({
      resourcePhase: "preview",
      agentsMd: { sources: [join(workspace, "AGENTS.md")] },
    });
    expect(invoke(IPC.tasks.resources, task.id)).toMatchObject({
      active: null,
      last: null,
    });
  });

  it("运行中的快照不会被磁盘预览替换，结束后只留下加载摘要", async () => {
    const { task, workspace } = setup();
    const iterator = task
      .sendMessage({
        text: "$review 审查这次改动",
        profile: {
          id: "mock",
          name: "Mock",
          baseURL: "http://127.0.0.1:1/v1",
          apiKey: "test",
          model: "mock",
        },
      })
      [Symbol.asyncIterator]();
    // 暂停在 user-message，不进入网络请求即可观察本轮快照。
    await iterator.next();
    const before = task.resourceState.active;
    expect(before?.loaded).toHaveLength(1);
    writeFileSync(
      join(workspace, "AGENTS.md"),
      "新的规范比原来的更长并且应该只影响下一条消息"
    );
    const overview = invoke(IPC.tasks.resources, task.id);
    expect(overview).toMatchObject({
      active: before,
      last: null,
      preview: { loaded: [] },
    });
    const status = await invoke(IPC.tasks.status, task.id);
    expect(status).toMatchObject({
      resourcePhase: "active",
      resources: before,
    });
    expect(JSON.stringify(overview)).not.toContain("SECRET_SKILL_BODY");
    await iterator.return?.();
    expect(task.resourceState).toEqual({ active: null, last: before });
    expect(await invoke(IPC.tasks.status, task.id)).toMatchObject({
      resourcePhase: "preview",
    });
  });

  it("拒绝伪造 taskId 参数，不允许以任意文件路径作为读取入口", () => {
    setup();
    expect(() =>
      invoke(IPC.tasks.resources, { path: "C:/private/SKILL.md" })
    ).toThrow("taskId 必须是字符串");
    expect(invoke(IPC.tasks.resources, "C:/private/SKILL.md")).toBeNull();
  });
});
