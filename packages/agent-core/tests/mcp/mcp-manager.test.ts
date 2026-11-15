import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterAll, describe, expect, it } from "vitest";

import { runTool } from "../../src/tools/registry";

import {
  DEFAULT_MCP_CALL_TIMEOUT_SECONDS,
  DEFAULT_MCP_CONNECT_TIMEOUT_SECONDS,
} from "../../src/task/execution-settings";
import {
  createMcpManager,
  MCP_DEFAULT_CALL_TIMEOUT_MS,
  MCP_DEFAULT_CONNECT_TIMEOUT_MS,
  type McpManager,
  type McpManagerOptions,
  type McpServerConfig,
} from "../../src/mcp/manager";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fake MCP server 夹具的绝对路径（node 子进程直接运行） */
const FIXTURE = join(__dirname, "fixtures", "fake-mcp-server.mjs");

function fakeServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "srv-1",
    name: "fake",
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    ...overrides,
  };
}

/** 收集本文件创建的 manager，测试结束后统一断开全部子进程 */
const managers: McpManager[] = [];

function newManager(
  options: Omit<McpManagerOptions, "servers"> &
    Partial<Pick<McpManagerOptions, "servers">> = {}
): McpManager {
  const manager = createMcpManager({
    servers: () => [],
    ...options,
  });
  managers.push(manager);
  return manager;
}

afterAll(async () => {
  await Promise.all(managers.map((manager) => manager.close()));
});

describe("McpManager 工具发现（连接 stdio server → listTools）", () => {
  it("连接成功后发现工具，名称加 mcp_<server>_ 前缀，schema 与说明透传", async () => {
    const servers = [fakeServer()];
    const manager = newManager({ servers: () => servers });
    const state = await manager.connect("srv-1");

    expect(state.status).toBe("connected");
    expect(state.error).toBeNull();
    expect(state.tools.map((tool) => tool.name)).toEqual([
      "mcp_fake_echo",
      "mcp_fake_slow_echo",
      "mcp_fake_crash",
    ]);

    const echo = state.tools.find((tool) => tool.name === "mcp_fake_echo");
    expect(echo).toMatchObject({
      serverId: "srv-1",
      serverName: "fake",
      originalName: "echo",
      description: "回显输入文本",
    });
    expect(echo?.parameters).toEqual({
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
    });
  });

  it("发现的工具适配为 ToolDefinition：调用经 stdio 往返、结果回填", async () => {
    const manager = newManager({ servers: () => [fakeServer()] });
    await manager.connect("srv-1");

    const echo = manager.tools().find((tool) => tool.name === "mcp_fake_echo");
    expect(echo).toBeDefined();
    expect(echo?.permission).toBe("command");

    const workspace = mkdtempSync(join(tmpdir(), "codexlike-mcp-"));
    const result = await runTool(
      echo!,
      { text: "你好 MCP" },
      {
        workspacePath: workspace,
        approvalMode: "assist",
        taskId: "mcp-test",
      }
    );
    expect(result).toEqual({ output: "echo: 你好 MCP", isError: false });
  });

  it("server 名称归一化为前缀：非法字符转下划线、小写", async () => {
    const manager = newManager({
      servers: () => [fakeServer({ id: "srv-2", name: "My Server.v2" })],
    });
    const state = await manager.connect("srv-2");
    expect(state.tools.map((tool) => tool.originalName)).toContain("echo");
    expect(
      manager
        .tools()
        .map((tool) => tool.name)
        .join(" ")
    ).toContain("mcp_my_server_v2_echo");
  });
});

describe("McpManager 逐工具启停", () => {
  it("disabledTools 中的工具不出现在 tools()，其余不受影响；启停逐次解析即时生效", async () => {
    const disabled = new Set(["mcp_fake_echo"]);
    const manager = newManager({
      servers: () => [fakeServer()],
      disabledTools: () => disabled,
    });
    await manager.connect("srv-1");

    expect(
      manager
        .tools()
        .map((tool) => tool.name)
        .sort()
    ).toEqual(["mcp_fake_crash", "mcp_fake_slow_echo"]);

    // 取消禁用：下一次解析即恢复（无需重连）
    disabled.clear();
    expect(manager.tools().map((tool) => tool.name)).toContain("mcp_fake_echo");
  });

  it("两个 server 间工具撞名时后发现的跳过（注册表同名不可重复）", async () => {
    const manager = newManager({
      servers: () => [fakeServer(), fakeServer({ id: "srv-2" })],
    });
    await manager.connect("srv-1");
    await manager.connect("srv-2");

    const names = manager.tools().map((tool) => tool.name);
    expect(names.filter((name) => name === "mcp_fake_echo")).toHaveLength(1);
  });
});

describe("McpManager 韧性：崩溃/超时/启动失败不拖垮调用方", () => {
  it("server 进程崩溃后调用返回中文错误；下一次调用惰性自动重连成功", async () => {
    const manager = newManager({ servers: () => [fakeServer()] });
    await manager.connect("srv-1");

    const crash = manager
      .tools()
      .find((tool) => tool.name === "mcp_fake_crash")!;
    const crashed = await runTool(
      crash,
      {},
      { workspacePath: tmpdir(), taskId: "mcp-test", approvalMode: "assist" }
    );
    expect(crashed.isError).toBe(true);
    expect(crashed.output).toContain("mcp_fake_crash");
    expect(crashed.output).toMatch(/失败|退出|断开/);

    // 进程死掉后状态可见
    await wait(200);
    const state = manager.states().find((item) => item.serverId === "srv-1");
    expect(state?.status).toBe("disconnected");

    // 惰性自动重连：再次调用 echo 自动重建连接并成功
    const echo = manager.tools().find((tool) => tool.name === "mcp_fake_echo");
    expect(echo).toBeDefined();
    const recovered = await runTool(
      echo!,
      { text: "重连成功" },
      {
        workspacePath: tmpdir(),
        approvalMode: "assist",
        taskId: "mcp-test",
      }
    );
    expect(recovered).toEqual({ output: "echo: 重连成功", isError: false });
  });

  it("调用超时返回中文超时错误（不无限等待）", async () => {
    const manager = newManager({
      servers: () => [fakeServer()],
      callTimeoutMs: 300,
    });
    await manager.connect("srv-1");

    const slow = manager
      .tools()
      .find((tool) => tool.name === "mcp_fake_slow_echo")!;
    const result = await runTool(
      slow,
      { text: "慢", delayMs: 10_000 },
      { workspacePath: tmpdir(), taskId: "mcp-test", approvalMode: "assist" }
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("超时");
  });

  it("命令不存在：connect 返回 failed 状态 + 中文原因（不抛出）", async () => {
    const manager = newManager({
      servers: () => [fakeServer({ command: "definitely-not-exist-cmd-xyz" })],
    });
    const state = await manager.connect("srv-1");
    expect(state.status).toBe("failed");
    expect(state.error).toContain("definitely-not-exist-cmd-xyz");
    expect(manager.tools()).toEqual([]);
  });

  it("server 启动即退出（die-immediately）：connect 失败且中文可读", async () => {
    const manager = newManager({
      servers: () => [fakeServer({ args: [FIXTURE, "die-immediately"] })],
    });
    const state = await manager.connect("srv-1");
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/连接失败|启动失败/);
  });

  it("disconnect 后工具不再提供；states 反映 disconnected", async () => {
    const manager = newManager({ servers: () => [fakeServer()] });
    await manager.connect("srv-1");
    await manager.disconnect("srv-1");

    expect(manager.tools()).toEqual([]);
    expect(manager.states()[0]).toMatchObject({
      serverId: "srv-1",
      status: "disconnected",
    });
  });
});

describe("McpManager 超时注入（执行设置票 07）：函数形态逐次解析", () => {
  it("callTimeoutMs 函数形态生效：慢调用在注入的超时内被掐断", async () => {
    const manager = newManager({
      servers: () => [fakeServer()],
      callTimeoutMs: () => 300,
    });
    await manager.connect("srv-1");

    const slow = manager
      .tools()
      .find((tool) => tool.name === "mcp_fake_slow_echo")!;
    const result = await runTool(
      slow,
      { text: "慢", delayMs: 10_000 },
      { workspacePath: tmpdir(), taskId: "mcp-test", approvalMode: "assist" }
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("超时");
  });

  it("调用超时逐次解析：同一 manager 两次调用各读当时值（无创建时快照）", async () => {
    let callTimeoutMs = 300;
    const manager = newManager({
      servers: () => [fakeServer()],
      callTimeoutMs: () => callTimeoutMs,
    });
    await manager.connect("srv-1");

    const slow = manager
      .tools()
      .find((tool) => tool.name === "mcp_fake_slow_echo")!;
    const timedOut = await runTool(
      slow,
      { text: "慢", delayMs: 10_000 },
      { workspacePath: tmpdir(), taskId: "mcp-test", approvalMode: "assist" }
    );
    expect(timedOut.isError).toBe(true);

    // 设置页调大超时后，下一次调用按新值执行（调用超时不破坏连接）
    callTimeoutMs = 5_000;
    const recovered = await runTool(
      slow,
      { text: "恢复", delayMs: 300 },
      { workspacePath: tmpdir(), taskId: "mcp-test", approvalMode: "assist" }
    );
    expect(recovered).toEqual({ output: "echo: 恢复", isError: false });
  });

  it("解析结果非正有限数回退默认 30s（防宿主注入非法值，与终端 TimeoutOption 同构）", async () => {
    const manager = newManager({
      servers: () => [fakeServer()],
      callTimeoutMs: () => Number.NaN,
    });
    await manager.connect("srv-1");

    const slow = manager
      .tools()
      .find((tool) => tool.name === "mcp_fake_slow_echo")!;
    // 默认 30s 足够 300ms 的慢调用完成
    const result = await runTool(
      slow,
      { text: "默认", delayMs: 300 },
      { workspacePath: tmpdir(), taskId: "mcp-test", approvalMode: "assist" }
    );
    expect(result).toEqual({ output: "echo: 默认", isError: false });
  });

  it("connectTimeoutMs 函数形态逐次解析：小超时连接失败，调大后重连成功", async () => {
    let connectTimeoutMs = 300;
    const manager = newManager({
      servers: () => [
        fakeServer({
          env: { FAKE_MCP_LIST_TOOLS_DELAY_MS: "800" },
        }),
      ],
      connectTimeoutMs: () => connectTimeoutMs,
    });

    // tools/list 被 server 延迟 800ms，300ms 连接超时掐断（连接失败不抛）
    const failed = await manager.connect("srv-1");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("连接超时");

    // 调大后下一次连接（重连语义）按新值执行
    connectTimeoutMs = 5_000;
    const recovered = await manager.connect("srv-1");
    expect(recovered.status).toBe("connected");
    expect(recovered.tools.map((tool) => tool.originalName)).toContain("echo");
  });

  it("默认值 30s/15s 硬约束：毫秒常量从秒常量同源派生（对外毫秒语义不变）", async () => {
    expect(MCP_DEFAULT_CALL_TIMEOUT_MS).toBe(30_000);
    expect(MCP_DEFAULT_CONNECT_TIMEOUT_MS).toBe(15_000);
    expect(MCP_DEFAULT_CALL_TIMEOUT_MS).toBe(
      DEFAULT_MCP_CALL_TIMEOUT_SECONDS * 1000
    );
    expect(MCP_DEFAULT_CONNECT_TIMEOUT_MS).toBe(
      DEFAULT_MCP_CONNECT_TIMEOUT_SECONDS * 1000
    );
  });
});
