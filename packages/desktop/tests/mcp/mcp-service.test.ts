import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterAll, describe, expect, it } from "vitest";

import { runTool } from "@codexlike/agent-core/node";
import type { ToolDefinition } from "@codexlike/agent-core";

import { createMcpStore } from "../../src/mcp/mcp-store";
import { createMcpService, type McpService } from "../../src/mcp/mcp-service";

/** 复用 agent-core 的 fake MCP server 夹具（纯 .mjs 脚本，node 直接运行） */
const FIXTURE = join(
  __dirname,
  "..",
  "..",
  "..",
  "agent-core",
  "tests",
  "mcp",
  "fixtures",
  "fake-mcp-server.mjs"
);

const fakeSafeStorage = {
  isEncryptionAvailable: async () => true,
  encryptString: async (plainText: string) =>
    Buffer.from(`enc:${Buffer.from(plainText, "utf8").toString("base64")}`),
  decryptString: async (encrypted: Buffer) => {
    const text = encrypted.toString("utf8");
    return Buffer.from(text.slice(4), "base64").toString("utf8");
  },
};

const services: McpService[] = [];
let tempDir = "";

afterAll(async () => {
  await Promise.all(services.map((service) => service.shutdown()));
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function newService(): McpService {
  tempDir = mkdtempSync(join(tmpdir(), "codexlike-mcp-service-"));
  const store = createMcpStore({ dir: tempDir, safeStorage: fakeSafeStorage });
  const service = createMcpService({ store });
  services.push(service);
  return service;
}

const fakeServerInput = {
  name: "fake",
  command: process.execPath,
  args: [FIXTURE],
  env: {},
};

describe("mcp service（desktop 装配：store + McpManager + 任务工具工厂）", () => {
  it("startup 自动连接已配置 server；addServer 即时连接，overview 可见状态与工具", async () => {
    const service = newService();
    const added = await service.addServer(fakeServerInput);
    expect(added.status).toBe("connected"); // 添加即连接

    // 等价重启：新 service 从同一 store 读配置，startup 自动连接
    const store2 = createMcpStore({
      dir: tempDir,
      safeStorage: fakeSafeStorage,
    });
    const service2 = createMcpService({ store: store2 });
    services.push(service2);
    await service2.startup();

    const overview = await service2.overview();
    expect(overview.servers).toHaveLength(1);
    const server = overview.servers[0]!;
    expect(server.status).toBe("connected");
    expect(server.error).toBeNull();
    expect(server.tools.map((tool) => tool.name)).toEqual([
      "mcp_fake_echo",
      "mcp_fake_slow_echo",
      "mcp_fake_crash",
    ]);
    expect(server.tools.every((tool) => tool.enabled)).toBe(true);
  });

  it("setToolEnabled(false) 后任务工具工厂不再提供该工具；再启用恢复", async () => {
    const service = newService();
    await service.addServer(fakeServerInput);

    const names = () =>
      service.taskTools().map((tool: ToolDefinition) => tool.name);
    expect(names()).toContain("mcp_fake_echo");

    await service.setToolEnabled("mcp_fake_echo", false);
    expect(names()).not.toContain("mcp_fake_echo");
    expect(names()).toContain("mcp_fake_slow_echo");

    await service.setToolEnabled("mcp_fake_echo", true);
    expect(names()).toContain("mcp_fake_echo");

    // overview 中启停状态可见
    const overview = await service.overview();
    const echo = overview.servers[0]!.tools.find(
      (t) => t.name === "mcp_fake_echo"
    );
    expect(echo?.enabled).toBe(true);
  });

  it("removeServer 断开连接并从 overview 消失；任务工具同步撤下", async () => {
    const service = newService();
    await service.addServer(fakeServerInput);
    expect(service.taskTools().length).toBeGreaterThan(0);

    await service.removeServer(
      (await service.overview()).servers[0]!.config.id
    );
    expect((await service.overview()).servers).toEqual([]);
    expect(service.taskTools()).toEqual([]);
  });

  it("连接失败的 server 不拖垮整体：failed 状态 + 中文原因可见，其余 server 正常", async () => {
    const service = newService();
    await service.addServer({
      name: "坏 server",
      command: "definitely-not-exist-cmd-xyz",
      args: [],
      env: {},
    });
    await service.addServer(fakeServerInput);
    await service.startup();

    const overview = await service.overview();
    const broken = overview.servers.find((s) => s.config.name === "坏 server");
    const healthy = overview.servers.find((s) => s.config.name === "fake");
    expect(broken?.status).toBe("failed");
    expect(broken?.error).toContain("definitely-not-exist-cmd-xyz");
    expect(healthy?.status).toBe("connected");
  });

  it("reconnect 重连指定 server（手动重连入口）", async () => {
    const service = newService();
    const created = await service.addServer(fakeServerInput);
    const view = await service.reconnect(created.config.id);
    expect(view.status).toBe("connected");
    expect(view.tools.length).toBe(3);
  });

  it("taskTools 与内置工具合并时内置优先（MCP 撞名跳过）", async () => {
    const service = newService();
    await service.addServer(fakeServerInput);
    const builtin: ToolDefinition[] = [
      {
        name: "mcp_fake_echo",
        description: "内置同名工具",
        parameters: { type: "object" },
        permission: "readonly",
        execute: async () => ({ output: "builtin", isError: false }),
      },
    ];
    const merged = service.taskTools(builtin);
    expect(merged.filter((tool) => tool.name === "mcp_fake_echo")).toHaveLength(
      1
    );
    expect(
      merged.find((tool) => tool.name === "mcp_fake_echo")?.description
    ).toBe("内置同名工具");
  });

  it("MCP 超时经函数形态透传 manager（执行设置票 07）：连接与调用逐次解析，改动即时生效", async () => {
    // 宿主侧模拟设置缓存：闭包变量即「当前设置值」（秒→毫秒换算由装配层做，
    // service 层只透传毫秒 resolver）
    let connectTimeoutMs = 300;
    let callTimeoutMs = 300;
    tempDir = mkdtempSync(join(tmpdir(), "codexlike-mcp-service-"));
    const store = createMcpStore({
      dir: tempDir,
      safeStorage: fakeSafeStorage,
    });
    const service = createMcpService({
      store,
      connectTimeoutMs: () => connectTimeoutMs,
      callTimeoutMs: () => callTimeoutMs,
    });
    services.push(service);

    // 连接阶段：tools/list 被 server 延迟 800ms，300ms 连接超时掐断（添加仍成功）
    const added = await service.addServer({
      ...fakeServerInput,
      env: { FAKE_MCP_LIST_TOOLS_DELAY_MS: "800" },
    });
    expect(added.status).toBe("failed");
    expect(added.error).toContain("连接超时");

    // 调大后手动重连按新值执行
    connectTimeoutMs = 5_000;
    const reconnected = await service.reconnect(added.config.id);
    expect(reconnected.status).toBe("connected");

    // 调用阶段：小超时掐断慢调用，调大后同一 service 下一次调用成功
    const slow = service
      .taskTools()
      .find((tool: ToolDefinition) => tool.name === "mcp_fake_slow_echo")!;
    const timedOut = await runTool(
      slow,
      { text: "慢", delayMs: 10_000 },
      {
        workspacePath: tmpdir(),
        taskId: "mcp-service-test",
        approvalMode: "assist",
      }
    );
    expect(timedOut.isError).toBe(true);
    expect(timedOut.output).toContain("超时");

    callTimeoutMs = 5_000;
    const recovered = await runTool(
      slow,
      { text: "恢复", delayMs: 300 },
      {
        workspacePath: tmpdir(),
        taskId: "mcp-service-test",
        approvalMode: "assist",
      }
    );
    expect(recovered).toEqual({ output: "echo: 恢复", isError: false });
  });
});
