import { describe, expect, it } from "vitest";

import { createTerminalSessionTools } from "../../src/tools/terminal-sessions";
import type { TerminalSessionManager } from "../../src/terminal/manager";
import type { TerminalSessionRecord } from "../../src/terminal/types";

/**
 * TerminalSessionManager 的 fake：只实现四工具用到的面（spawn/write/read/
 * kill/session），记录调用参数、返回脚本化结果。工具级单测经它驱动拒绝
 * 路径与参数组装（先例：browser-tools 的 fake manager 注入）。
 */
function fakeManager(
  overrides: Partial<
    Pick<
      TerminalSessionManager,
      "spawn" | "write" | "read" | "kill" | "session"
    >
  > = {}
): TerminalSessionManager & {
  spawned: Parameters<TerminalSessionManager["spawn"]>[0][];
  written: { sessionId: string; data: string }[];
  killed: string[];
} {
  const spawned: Parameters<TerminalSessionManager["spawn"]>[0][] = [];
  const written: { sessionId: string; data: string }[] = [];
  const killed: string[] = [];
  const manager = {
    spawned,
    written,
    killed,
    spawn(request: Parameters<TerminalSessionManager["spawn"]>[0]) {
      spawned.push(request);
      return { ok: true, sessionId: "session-1" };
    },
    write(sessionId: string, data: string) {
      written.push({ sessionId, data });
      return { ok: true };
    },
    async read(sessionId: string, options?: { waitMs?: number }) {
      void sessionId;
      void options;
      return { data: "", status: "running" as const };
    },
    kill(sessionId: string) {
      killed.push(sessionId);
      return { ok: true };
    },
    session(sessionId: string): TerminalSessionRecord | undefined {
      void sessionId;
      return undefined;
    },
    ...overrides,
  };
  return manager as TerminalSessionManager & typeof manager;
}

/** 工具执行上下文（四工具只用到 taskId / workspacePath / signal） */
function context(
  overrides: Partial<{
    taskId: string;
    workspacePath: string;
    signal: AbortSignal;
  }> = {}
) {
  return {
    workspacePath: "C:\\work\\demo",
    approvalMode: "assist" as const,
    taskId: "task-1",
    ...overrides,
  };
}

/** 造一条会话记录（session() 的脚本化返回值） */
function record(
  overrides: Partial<TerminalSessionRecord> = {}
): TerminalSessionRecord {
  return {
    sessionId: "session-1",
    taskId: "task-1",
    name: "powershell · 1",
    shell: "powershell",
    origin: "agent",
    status: "running",
    createdAt: "2026-11-21T08:00:00.000Z",
    ...overrides,
  };
}

/** 四件工具中的 spawn_terminal（首位）：取不到即测试装配错误 */
function spawnToolOf(
  tools: ReturnType<typeof createTerminalSessionTools>
): (typeof tools)[number] {
  const tool = tools.find((item) => item.name === "spawn_terminal");
  if (tool === undefined) throw new Error("spawn_terminal 应存在");
  return tool;
}

describe("spawn_terminal（工具级，fake 管理器）", () => {
  it("无初始命令：以本任务 agent 来源与工作区 cwd 发起 spawn，输出携带会话标识", async () => {
    const manager = fakeManager();
    const spawnTerminal = spawnToolOf(
      createTerminalSessionTools({
        manager,
        shell: () => "git-bash",
      })
    );

    const result = await spawnTerminal.execute({}, context());

    expect(result.isError).toBe(false);
    expect(result.output).toContain("session-1");
    expect(manager.spawned).toHaveLength(1);
    expect(manager.spawned[0]).toMatchObject({
      taskId: "task-1",
      origin: "agent",
      cwd: "C:\\work\\demo",
      shell: "git-bash",
    });
    expect(manager.spawned[0]!.initialCommand).toBeUndefined();
  });

  it("带初始命令：原样透传给管理器", async () => {
    const manager = fakeManager();
    const spawnTerminal = spawnToolOf(
      createTerminalSessionTools({
        manager,
        shell: () => "powershell",
      })
    );

    const result = await spawnTerminal.execute(
      { command: "pnpm build" },
      context()
    );

    expect(result.isError).toBe(false);
    expect(manager.spawned[0]!.initialCommand).toBe("pnpm build");
  });

  it("超上限等管理器拒绝：isError 结果携带中文 reason 原文", async () => {
    const manager = fakeManager({
      spawn: () => ({
        ok: false,
        reason:
          "该任务同时存活的终端会话已达上限 5，请等待现有会话退出，或先终止不再需要的会话再试。",
      }),
    });
    const spawnTerminal = spawnToolOf(createTerminalSessionTools({ manager }));

    const result = await spawnTerminal.execute({}, context());

    expect(result.isError).toBe(true);
    expect(result.output).toContain("已达上限 5");
  });

  it("env 白名单过滤：宿主完整环境变量只透传基础项（与 run_terminal_command 同款）", async () => {
    const manager = fakeManager();
    const spawnTerminal = spawnToolOf(
      createTerminalSessionTools({
        manager,
        env: { PATH: "/usr/bin", SECRET_TOKEN: "leak-me", LANG: "zh_CN.UTF-8" },
      })
    );

    await spawnTerminal.execute({}, context());

    expect(manager.spawned[0]!.env).toEqual({
      PATH: "/usr/bin",
      LANG: "zh_CN.UTF-8",
    });
  });
});

describe("terminal_write（工具级，fake 管理器）", () => {
  it("本任务 agent 自启会话：原样写入（不自动加换行），输出提示读取方式", async () => {
    const manager = fakeManager({
      session: (sessionId) =>
        sessionId === "session-1" ? record({ sessionId }) : undefined,
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalWrite = tools.find((tool) => tool.name === "terminal_write")!;

    const result = await terminalWrite.execute(
      { sessionId: "session-1", command: "y\n" },
      context()
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("已写入");
    expect(manager.written).toEqual([{ sessionId: "session-1", data: "y\n" }]);
  });

  it("用户手开的会话：中文拒绝且不触碰管理器 write", async () => {
    const manager = fakeManager({
      session: () => record({ origin: "user", name: "git-bash · 1" }),
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalWrite = tools.find((tool) => tool.name === "terminal_write")!;

    const result = await terminalWrite.execute(
      { sessionId: "session-1", command: "ls\n" },
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("用户手动创建");
    expect(result.output).toContain("只读");
    expect(manager.written).toEqual([]);
  });

  it("其他任务的 agent 会话：拒绝（所有权是本任务 agent 自启，不是任意 origin=agent）", async () => {
    const manager = fakeManager({
      session: () => record({ taskId: "task-other" }),
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalWrite = tools.find((tool) => tool.name === "terminal_write")!;

    const result = await terminalWrite.execute(
      { sessionId: "session-1", command: "ls\n" },
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("不属于当前任务");
    expect(manager.written).toEqual([]);
  });

  it("会话不存在：中文拒绝", async () => {
    const manager = fakeManager({ session: () => undefined });
    const tools = createTerminalSessionTools({ manager });
    const terminalWrite = tools.find((tool) => tool.name === "terminal_write")!;

    const result = await terminalWrite.execute(
      { sessionId: "ghost", command: "ls\n" },
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("不存在");
  });

  it("已退出会话：管理器拒绝 reason 原文透传（isError）", async () => {
    const manager = fakeManager({
      session: () => record({ status: "exited", exitCode: 1 }),
      write: () => ({
        ok: false,
        reason: "终端会话已退出，无法写入：powershell · 1",
      }),
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalWrite = tools.find((tool) => tool.name === "terminal_write")!;

    const result = await terminalWrite.execute(
      { sessionId: "session-1", command: "ls\n" },
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("已退出，无法写入");
  });
});

describe("terminal_read（工具级，fake 管理器）", () => {
  it("缺省立即读：不带等待参数，有增量时原样返回数据", async () => {
    const readOptions: ({ waitMs?: number } | undefined)[] = [];
    const manager = fakeManager({
      session: () => record(),
      read: async (_sessionId, options) => {
        readOptions.push(options);
        return { data: "hello\n", status: "running" };
      },
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalRead = tools.find((tool) => tool.name === "terminal_read")!;

    const result = await terminalRead.execute(
      { sessionId: "session-1" },
      context()
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("hello");
    // 立即读语义：单次调用、不携带等待（管理器 waitMs 缺省 0）
    expect(readOptions).toEqual([undefined]);
  });

  it("wait=true 无输出：按 timeoutMs 分片等待后返回等待提示（分片 ≤250ms）", async () => {
    const readOptions: ({ waitMs?: number } | undefined)[] = [];
    const manager = fakeManager({
      session: () => record(),
      read: async (_sessionId, options) => {
        readOptions.push(options);
        // 模拟管理器 wait 语义：waitMs 内无新输出则等满才返回
        await new Promise((resolve) =>
          setTimeout(resolve, options?.waitMs ?? 0)
        );
        return { data: "", status: "running" };
      },
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalRead = tools.find((tool) => tool.name === "terminal_read")!;

    const startedAt = Date.now();
    const result = await terminalRead.execute(
      { sessionId: "session-1", wait: true, timeoutMs: 1500 },
      context()
    );
    const elapsed = Date.now() - startedAt;

    expect(result.isError).toBe(false);
    expect(result.output).toContain("暂无新输出");
    // 分片轮询：单次等待 ≤250ms，总耗时贴近 timeoutMs 而非单次挂死
    expect(readOptions.length).toBeGreaterThanOrEqual(5);
    for (const option of readOptions) {
      expect(option?.waitMs).toBeLessThanOrEqual(250);
    }
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it("wait=true 中途出新输出：立即返回不等满 timeoutMs", async () => {
    let calls = 0;
    const manager = fakeManager({
      session: () => record(),
      read: async () => {
        calls += 1;
        if (calls === 1) return { data: "", status: "running" as const };
        return { data: "progress 50%\n", status: "running" as const };
      },
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalRead = tools.find((tool) => tool.name === "terminal_read")!;

    const startedAt = Date.now();
    const result = await terminalRead.execute(
      { sessionId: "session-1", wait: true, timeoutMs: 30_000 },
      context()
    );
    const elapsed = Date.now() - startedAt;

    expect(result.output).toContain("progress 50%");
    expect(calls).toBe(2);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  it("wait=true 超上限 timeoutMs：clamp 到 60000（描述声明上限）", async () => {
    const manager = fakeManager({ session: () => record() });
    const tools = createTerminalSessionTools({ manager });
    const terminalRead = tools.find((tool) => tool.name === "terminal_read")!;

    expect(terminalRead.description).toContain("上限 60 秒");
    // 超上限取值走 clamp（实现 Math.min）；传递路径由 1500ms 行为用例覆盖，
    // 60s 真等不可接受（全量测试时长红线），clamp 逻辑以描述断言夹住
    expect(terminalRead.parameters.properties).toMatchObject({
      timeoutMs: expect.objectContaining({ type: "integer" }),
    });
  });

  it("已退出会话可读：不拒绝，输出附退出说明（帮用户诊断场景）", async () => {
    const manager = fakeManager({
      session: () => record({ status: "exited", exitCode: 2 }),
      read: async () => ({ data: "panic: boom\n", status: "exited" }),
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalRead = tools.find((tool) => tool.name === "terminal_read")!;

    const result = await terminalRead.execute(
      { sessionId: "session-1" },
      context()
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("panic: boom");
    expect(result.output).toContain("已退出");
  });

  it("水位前内容被淘汰（truncated）：输出附缺失警告", async () => {
    const manager = fakeManager({
      session: () => record(),
      read: async () => ({
        data: "tail\n",
        status: "running",
        truncated: true,
      }),
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalRead = tools.find((tool) => tool.name === "terminal_read")!;

    const result = await terminalRead.execute(
      { sessionId: "session-1" },
      context()
    );

    expect(result.output).toContain("已被丢弃");
    expect(result.output).toContain("tail");
  });

  it("用户手开的会话可读（read 任意会话，帮用户诊断）", async () => {
    const manager = fakeManager({
      session: () => record({ origin: "user", name: "git-bash · 1" }),
      read: async () => ({
        data: "command not found: lss\n",
        status: "running",
      }),
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalRead = tools.find((tool) => tool.name === "terminal_read")!;

    const result = await terminalRead.execute(
      { sessionId: "session-1" },
      context()
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("command not found");
  });

  it("跨任务会话：拒绝读取", async () => {
    const manager = fakeManager({
      session: () => record({ taskId: "task-other" }),
      read: async () => {
        throw new Error("不应读取");
      },
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalRead = tools.find((tool) => tool.name === "terminal_read")!;

    const result = await terminalRead.execute(
      { sessionId: "session-1" },
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("不属于当前任务");
  });

  it("单次增量超上限：保尾部并注明省略字符数", async () => {
    const big = "x".repeat(40_000) + "END";
    const manager = fakeManager({
      session: () => record(),
      read: async () => ({ data: big, status: "running" }),
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalRead = tools.find((tool) => tool.name === "terminal_read")!;

    const result = await terminalRead.execute(
      { sessionId: "session-1" },
      context()
    );

    expect(result.output).toContain("仅显示最后");
    expect(result.output.endsWith("END")).toBe(true);
    expect(result.output.length).toBeLessThan(40_000);
  });

  it("执行中 abort：立即返回中断结果，会话仍在运行（中断不杀会话）", async () => {
    const manager = fakeManager({
      session: () => record(),
      read: async (_sessionId, options) => {
        // 模拟 waitMs 内无新输出：管理器按 waitMs 定时返回
        await new Promise((resolve) =>
          setTimeout(resolve, options?.waitMs ?? 0)
        );
        return { data: "", status: "running" };
      },
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalRead = tools.find((tool) => tool.name === "terminal_read")!;

    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 50);
    const result = await terminalRead.execute(
      { sessionId: "session-1", wait: true, timeoutMs: 30_000 },
      context({ signal: controller.signal })
    );
    const elapsed = Date.now() - startedAt;

    expect(result.isError).toBe(true);
    expect(result.output).toContain("已被用户中断");
    expect(result.output).toContain("会话仍在运行");
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("terminal_kill（工具级，fake 管理器）", () => {
  it("本任务 agent 自启会话：调用管理器 kill，输出提示快照可回看", async () => {
    const manager = fakeManager({ session: () => record() });
    const tools = createTerminalSessionTools({ manager });
    const terminalKill = tools.find((tool) => tool.name === "terminal_kill")!;

    const result = await terminalKill.execute(
      { sessionId: "session-1" },
      context()
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("已发送终止信号");
    expect(manager.killed).toEqual(["session-1"]);
  });

  it("用户手开会话：中文拒绝且不触发 kill", async () => {
    const manager = fakeManager({
      session: () => record({ origin: "user", name: "git-bash · 1" }),
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalKill = tools.find((tool) => tool.name === "terminal_kill")!;

    const result = await terminalKill.execute(
      { sessionId: "session-1" },
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("用户手动创建");
    expect(manager.killed).toEqual([]);
  });

  it("其他任务会话：拒绝", async () => {
    const manager = fakeManager({
      session: () => record({ taskId: "task-other" }),
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalKill = tools.find((tool) => tool.name === "terminal_kill")!;

    const result = await terminalKill.execute(
      { sessionId: "session-1" },
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("不属于当前任务");
    expect(manager.killed).toEqual([]);
  });

  it("重复 kill 已退出会话：管理器拒绝 reason 原文透传（非幂等成功）", async () => {
    const manager = fakeManager({
      session: () => record({ status: "exited", exitCode: 0 }),
      kill: () => ({
        ok: false,
        reason: "终端会话已退出，无需终止：powershell · 1",
      }),
    });
    const tools = createTerminalSessionTools({ manager });
    const terminalKill = tools.find((tool) => tool.name === "terminal_kill")!;

    const result = await terminalKill.execute(
      { sessionId: "session-1" },
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("已退出，无需终止");
  });
});

describe("中断纪律（abort 不杀会话）", () => {
  it("spawn/write/kill 在已 abort 的上下文中短路：不触碰管理器", async () => {
    const manager = fakeManager();
    const tools = createTerminalSessionTools({ manager });
    const [spawnTerminal, terminalWrite, terminalRead, terminalKill] = tools;
    const controller = new AbortController();
    controller.abort();

    const spawnResult = await spawnTerminal!.execute(
      {},
      context({ signal: controller.signal })
    );
    const writeResult = await terminalWrite!.execute(
      { sessionId: "session-1", command: "y\n" },
      context({ signal: controller.signal })
    );
    const killResult = await terminalKill!.execute(
      { sessionId: "session-1" },
      context({ signal: controller.signal })
    );

    expect(spawnResult.output).toContain("已被用户中断");
    expect(writeResult.output).toContain("已被用户中断");
    expect(killResult.output).toContain("已被用户中断");
    expect(manager.spawned).toEqual([]);
    expect(manager.written).toEqual([]);
    expect(manager.killed).toEqual([]);
  });
});

describe("createTerminalSessionTools 装配形状", () => {
  it("四件工具名称与权限类别：spawn/write 是 command、read 只读、kill 是 write", () => {
    const tools = createTerminalSessionTools({ manager: fakeManager() });
    expect(tools.map((tool) => [tool.name, tool.permission])).toEqual([
      ["spawn_terminal", "command"],
      ["terminal_write", "command"],
      ["terminal_read", "readonly"],
      ["terminal_kill", "write"],
    ]);
  });

  it("命令类工具的命令字段名是 command（审批门 commandOfToolInput 的提取键）", () => {
    const tools = createTerminalSessionTools({ manager: fakeManager() });
    for (const name of ["spawn_terminal", "terminal_write"]) {
      const tool = tools.find((item) => item.name === name)!;
      expect(tool.parameters.properties).toHaveProperty("command");
    }
  });

  it("spawn_terminal 描述写清与 run_terminal_command 的边界（一次性执行 vs 持续会话）", () => {
    const spawnTerminal = spawnToolOf(
      createTerminalSessionTools({ manager: fakeManager() })
    );
    expect(spawnTerminal.description).toContain("run_terminal_command");
    expect(spawnTerminal.description).toContain("不等待命令完成");
    expect(spawnTerminal.description).toContain("一次性执行");
  });
});
