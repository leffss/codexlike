import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, describe, expect, it } from 'vitest';

import { runTool } from '../../src/tools/registry';

import {
  createMcpManager,
  type McpManager,
  type McpServerConfig,
} from '../../src/mcp/manager';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fake MCP server 夹具的绝对路径（node 子进程直接运行） */
const FIXTURE = join(__dirname, 'fixtures', 'fake-mcp-server.mjs');

function fakeServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv-1',
    name: 'fake',
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    ...overrides,
  };
}

/** 收集本文件创建的 manager，测试结束后统一断开全部子进程 */
const managers: McpManager[] = [];

function newManager(
  options: Partial<Parameters<typeof createMcpManager>[0]> = {},
): McpManager {
  const manager = createMcpManager(options);
  managers.push(manager);
  return manager;
}

afterAll(async () => {
  await Promise.all(managers.map((manager) => manager.close()));
});

describe('McpManager 工具发现（连接 stdio server → listTools）', () => {
  it('连接成功后发现工具，名称加 mcp_<server>_ 前缀，schema 与说明透传', async () => {
    const servers = [fakeServer()];
    const manager = newManager({ servers: () => servers });
    const state = await manager.connect('srv-1');

    expect(state.status).toBe('connected');
    expect(state.error).toBeNull();
    expect(state.tools.map((tool) => tool.name)).toEqual([
      'mcp_fake_echo',
      'mcp_fake_slow_echo',
      'mcp_fake_crash',
    ]);

    const echo = state.tools.find((tool) => tool.name === 'mcp_fake_echo');
    expect(echo).toMatchObject({
      serverId: 'srv-1',
      serverName: 'fake',
      originalName: 'echo',
      description: '回显输入文本',
    });
    expect(echo?.parameters).toEqual({
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    });
  });

  it('发现的工具适配为 ToolDefinition：调用经 stdio 往返、结果回填', async () => {
    const manager = newManager({ servers: () => [fakeServer()] });
    await manager.connect('srv-1');

    const echo = manager.tools().find((tool) => tool.name === 'mcp_fake_echo');
    expect(echo).toBeDefined();
    expect(echo?.permission).toBe('command');

    const workspace = mkdtempSync(join(tmpdir(), 'codexlike-mcp-'));
    const result = await runTool(echo!, { text: '你好 MCP' }, {
      workspacePath: workspace,
    });
    expect(result).toEqual({ output: 'echo: 你好 MCP', isError: false });
  });

  it('server 名称归一化为前缀：非法字符转下划线、小写', async () => {
    const manager = newManager({
      servers: () => [fakeServer({ id: 'srv-2', name: 'My Server.v2' })],
    });
    const state = await manager.connect('srv-2');
    expect(state.tools.map((tool) => tool.originalName)).toContain('echo');
    expect(
      manager
        .tools()
        .map((tool) => tool.name)
        .join(' '),
    ).toContain('mcp_my_server_v2_echo');
  });
});

describe('McpManager 逐工具启停', () => {
  it('disabledTools 中的工具不出现在 tools()，其余不受影响；启停逐次解析即时生效', async () => {
    const disabled = new Set(['mcp_fake_echo']);
    const manager = newManager({
      servers: () => [fakeServer()],
      disabledTools: () => disabled,
    });
    await manager.connect('srv-1');

    expect(
      manager
        .tools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['mcp_fake_crash', 'mcp_fake_slow_echo']);

    // 取消禁用：下一次解析即恢复（无需重连）
    disabled.clear();
    expect(manager.tools().map((tool) => tool.name)).toContain('mcp_fake_echo');
  });

  it('两个 server 间工具撞名时后发现的跳过（注册表同名不可重复）', async () => {
    const manager = newManager({
      servers: () => [fakeServer(), fakeServer({ id: 'srv-2' })],
    });
    await manager.connect('srv-1');
    await manager.connect('srv-2');

    const names = manager.tools().map((tool) => tool.name);
    expect(names.filter((name) => name === 'mcp_fake_echo')).toHaveLength(1);
  });
});

describe('McpManager 韧性：崩溃/超时/启动失败不拖垮调用方', () => {
  it('server 进程崩溃后调用返回中文错误；下一次调用惰性自动重连成功', async () => {
    const manager = newManager({ servers: () => [fakeServer()] });
    await manager.connect('srv-1');

    const crash = manager.tools().find((tool) => tool.name === 'mcp_fake_crash')!;
    const crashed = await runTool(crash, {}, { workspacePath: tmpdir() });
    expect(crashed.isError).toBe(true);
    expect(crashed.output).toContain('mcp_fake_crash');
    expect(crashed.output).toMatch(/失败|退出|断开/);

    // 进程死掉后状态可见
    await wait(200);
    const state = manager.states().find((item) => item.serverId === 'srv-1');
    expect(state?.status).toBe('disconnected');

    // 惰性自动重连：再次调用 echo 自动重建连接并成功
    const echo = manager.tools().find((tool) => tool.name === 'mcp_fake_echo');
    expect(echo).toBeDefined();
    const recovered = await runTool(echo!, { text: '重连成功' }, {
      workspacePath: tmpdir(),
    });
    expect(recovered).toEqual({ output: 'echo: 重连成功', isError: false });
  });

  it('调用超时返回中文超时错误（不无限等待）', async () => {
    const manager = newManager({
      servers: () => [fakeServer()],
      callTimeoutMs: 300,
    });
    await manager.connect('srv-1');

    const slow = manager
      .tools()
      .find((tool) => tool.name === 'mcp_fake_slow_echo')!;
    const result = await runTool(
      slow,
      { text: '慢', delayMs: 10_000 },
      { workspacePath: tmpdir() },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('超时');
  });

  it('命令不存在：connect 返回 failed 状态 + 中文原因（不抛出）', async () => {
    const manager = newManager({
      servers: () => [
        fakeServer({ command: 'definitely-not-exist-cmd-xyz' }),
      ],
    });
    const state = await manager.connect('srv-1');
    expect(state.status).toBe('failed');
    expect(state.error).toContain('definitely-not-exist-cmd-xyz');
    expect(manager.tools()).toEqual([]);
  });

  it('server 启动即退出（die-immediately）：connect 失败且中文可读', async () => {
    const manager = newManager({
      servers: () => [fakeServer({ args: [FIXTURE, 'die-immediately'] })],
    });
    const state = await manager.connect('srv-1');
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/连接失败|启动失败/);
  });

  it('disconnect 后工具不再提供；states 反映 disconnected', async () => {
    const manager = newManager({ servers: () => [fakeServer()] });
    await manager.connect('srv-1');
    await manager.disconnect('srv-1');

    expect(manager.tools()).toEqual([]);
    expect(manager.states()[0]).toMatchObject({
      serverId: 'srv-1',
      status: 'disconnected',
    });
  });
});
