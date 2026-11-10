import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';


import type { ToolDefinition, ToolResult } from '../tools/types';

import type {
  McpDiscoveredTool,
  McpServerConfig,
  McpServerState,
} from './types';

export type { McpServerConfig, McpServerState } from './types';

/** 默认工具调用超时：30 秒（spec「工具执行带超时」） */
export const MCP_DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** 默认连接建立（spawn + initialize + tools/list）超时：15 秒 */
export const MCP_DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export interface McpManagerOptions {
  /** 逐次解析当前 server 配置（设置页改配置免重启对下一次连接生效） */
  servers: () => McpServerConfig[];
  /** 被禁用工具的全名集合（逐次解析，逐工具启停对之后的会话生效） */
  disabledTools?: () => Iterable<string>;
  /** 工具调用超时毫秒（默认 30s） */
  callTimeoutMs?: number;
  /** 连接建立超时毫秒（默认 15s） */
  connectTimeoutMs?: number;
}

export interface McpManager {
  /**
   * 连接指定 server（spawn stdio 子进程 → initialize 握手 → tools/list 工具发现）。
   * 连接失败不抛：返回 status=failed + 中文 error（会话与其它 server 不受影响）。
   */
  connect(serverId: string): Promise<McpServerState>;
  /** 主动断开指定 server（设置页删除/重连前调用）；未知 id 忽略 */
  disconnect(serverId: string): Promise<void>;
  /** 全部已配置 server 的状态快照（从未连接过的为 disconnected） */
  states(): McpServerState[];
  /**
   * 可用工具，适配为 ToolDefinition（内部再防一次撞名：后发现的跳过）。
   * 断线 server 的工具按「最后已知列表」保留：调用时惰性自动重连（工单 12 的重连策略），
   * 因此会话中途 server 崩溃重启，模型下一轮仍可调用其工具。
   */
  tools(): ToolDefinition[];
  /** 断开全部连接（应用退出时调用） */
  close(): Promise<void>;
}

/** server 名 → 工具前缀成分：小写、非法字符转下划线 */
function normalizeSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized === '' ? 'server' : normalized;
}

interface Connection {
  client: Client;
  transport: StdioClientTransport;
  tools: McpDiscoveredTool[];
}

/** 每个 server 的管理簿记：活动连接 + 最后已知工具 + 最近错误 */
interface Entry {
  connection: Connection | null;
  /** 最后一次成功发现到的工具（断线后保留，支撑惰性重连） */
  tools: McpDiscoveredTool[];
  status: McpServerState['status'];
  error: string | null;
}

/** 把 CallToolResult 的 content 转为模型可读的纯文本输出（参数 unknown：SDK 泛型形态随版本变，结构窄化在此收口） */
function contentToOutput(raw: unknown): { output: string; isError: boolean } {
  const result =
    typeof raw === 'object' && raw !== null
      ? (raw as { content?: unknown; isError?: unknown })
      : {};
  const isError = result.isError === true;
  const parts = Array.isArray(result.content) ? result.content : [];
  const texts = parts
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text);
  if (texts.length > 0) {
    return { output: texts.join('\n'), isError };
  }
  return {
    output: isError
      ? 'MCP 工具返回了错误（无文本内容）'
      : 'MCP 工具没有返回文本内容',
    isError,
  };
}

/** 创建 MCP 连接管理器：stdio transport、工具发现、调用适配（GLOSSARY「MCP」「工具注册表」） */
export function createMcpManager(options: McpManagerOptions): McpManager {
  const callTimeoutMs = options.callTimeoutMs ?? MCP_DEFAULT_CALL_TIMEOUT_MS;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? MCP_DEFAULT_CONNECT_TIMEOUT_MS;

  /** serverId → 管理簿记（断线不清除，保留最后已知工具） */
  const entries = new Map<string, Entry>();

  function entryOf(serverId: string): Entry {
    let entry = entries.get(serverId);
    if (entry === undefined) {
      entry = { connection: null, tools: [], status: 'disconnected', error: null };
      entries.set(serverId, entry);
    }
    return entry;
  }

  /** spawn 子进程并完成 initialize + tools/list；任何失败抛中文错误 */
  async function establish(
    config: McpServerConfig,
    entry: Entry,
  ): Promise<Connection> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      // 在 SDK 基础白名单（PATH/HOME 等）之上合并用户 env：子进程能找到可执行文件
      env: { ...getDefaultEnvironment(), ...config.env },
    });
    const client = new Client(
      { name: 'codexlike', version: '0.1.0' },
      { capabilities: {} },
    );

    // server 进程退出/崩溃：清理活动连接但保留最后已知工具（调用时惰性重连）
    transport.onclose = () => {
      if (entry.connection?.client === client) {
        entry.connection = null;
        entry.status = 'disconnected';
        entry.error = `MCP server「${config.name}」进程已退出，将在下次工具调用时自动重连`;
      }
    };

    try {
      await client.connect(transport, { timeout: connectTimeoutMs });
      const listed = await client.listTools(undefined, {
        timeout: connectTimeoutMs,
      });
      const serverName = normalizeSegment(config.name);
      const tools: McpDiscoveredTool[] = (listed.tools ?? []).map((tool) => ({
        serverId: config.id,
        serverName,
        originalName: tool.name,
        name: `mcp_${serverName}_${normalizeSegment(tool.name)}`,
        description:
          tool.description && tool.description.trim() !== ''
            ? tool.description
            : `MCP server「${config.name}」提供的工具 ${tool.name}`,
        parameters: (tool.inputSchema ?? {
          type: 'object',
        }) as McpDiscoveredTool['parameters'],
      }));
      return { client, transport, tools };
    } catch (error) {
      // 连接失败：确保子进程（若已 spawn）被回收
      await client.close().catch(() => undefined);
      throw new Error(describeConnectError(config, error));
    }
  }

  /** 取活动连接；已断开则惰性自动重连（重连失败抛中文错误） */
  async function ensureConnection(
    config: McpServerConfig,
    entry: Entry,
  ): Promise<Connection> {
    if (entry.connection !== null) {
      return entry.connection;
    }
    const connection = await establish(config, entry);
    entry.connection = connection;
    entry.tools = connection.tools;
    entry.status = 'connected';
    entry.error = null;
    return connection;
  }

  return {
    async connect(serverId) {
      const config = options.servers().find((server) => server.id === serverId);
      if (config === undefined) {
        throw new Error(`MCP server ${serverId} 不存在`);
      }
      const entry = entryOf(serverId);
      // 重复连接：先断开旧连接（重连语义）
      if (entry.connection !== null) {
        const previous = entry.connection;
        entry.connection = null;
        await previous.client.close().catch(() => undefined);
      }
      entry.status = 'connecting';
      entry.error = null;
      try {
        entry.connection = await establish(config, entry);
        entry.tools = entry.connection.tools;
        entry.status = 'connected';
      } catch (error) {
        entry.status = 'failed';
        entry.error =
          error instanceof Error ? error.message : String(error);
      }
      return {
        serverId,
        status: entry.status,
        tools: entry.tools,
        error: entry.error,
      };
    },

    async disconnect(serverId) {
      const entry = entries.get(serverId);
      if (entry === undefined || entry.connection === null) {
        return;
      }
      const previous = entry.connection;
      entry.connection = null;
      entry.status = 'disconnected';
      entry.error = null;
      // 主动断开（区别于进程崩溃）：工具列表一并清空，不再提供给会话
      entry.tools = [];
      await previous.client.close().catch(() => undefined);
    },

    states() {
      return options.servers().map((config) => {
        const entry = entries.get(config.id);
        if (entry === undefined) {
          return { serverId: config.id, status: 'disconnected', tools: [], error: null };
        }
        return {
          serverId: config.id,
          status: entry.status,
          tools: entry.tools,
          error: entry.error,
        };
      });
    },

    tools() {
      const disabled = new Set(options.disabledTools?.() ?? []);
      const result: ToolDefinition[] = [];
      const seen = new Set<string>();
      for (const config of options.servers()) {
        const entry = entries.get(config.id);
        // 未连接过（entry 不存在）或从未发现过工具的 server 不提供工具；
        // 断线但已知工具的 server 保留（execute 内惰性重连）
        if (entry === undefined || entry.tools.length === 0) {
          continue;
        }
        for (const discovered of entry.tools) {
          if (disabled.has(discovered.name) || seen.has(discovered.name)) {
            continue;
          }
          seen.add(discovered.name);
          result.push(adaptTool(config, discovered));
        }
      }
      return result;
    },

    async close() {
      const closing = [...entries.values()]
        .map((entry) => entry.connection)
        .filter((connection): connection is Connection => connection !== null);
      for (const entry of entries.values()) {
        entry.connection = null;
        entry.status = 'disconnected';
      }
      await Promise.all(
        closing.map((connection) =>
          connection.client.close().catch(() => undefined),
        ),
      );
    },
  };

  /** 单个 MCP 工具 → ToolDefinition（permission=command：suggest 下走审批链路） */
  function adaptTool(
    config: McpServerConfig,
    discovered: McpDiscoveredTool,
  ): ToolDefinition {
    return {
      name: discovered.name,
      description: `【MCP:${config.name}】${discovered.description}`,
      parameters: discovered.parameters,
      // spec：MCP 工具按 command 级权限处理（server 端行为不可知，保守对待）
      permission: 'command',
      async execute(args, context): Promise<ToolResult> {
        try {
          // 惰性自动重连：连接断开（server 崩溃/重启）时先重建，再转发调用
          const entry = entryOf(config.id);
          const connection = await ensureConnection(config, entry);
          const result = await connection.client.callTool(
            { name: discovered.originalName, arguments: asRecord(args) },
            undefined,
            {
              timeout: callTimeoutMs,
              signal: context.signal ?? undefined,
            },
          );
          return contentToOutput(result);
        } catch (error) {
          return {
            output: describeCallError(discovered.name, callTimeoutMs, error),
            isError: true,
          };
        }
      },
    };
  }
}

function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null
    ? (args as Record<string, unknown>)
    : {};
}

/** 调用阶段错误的中文描述（超时明确点出，其余保留原文） */
function describeCallError(
  toolName: string,
  timeoutMs: number,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|timeout/i.test(message)) {
    return `MCP 工具 ${toolName} 调用超时（${Math.round(timeoutMs / 1000)} 秒）：server 未在规定时间内响应，可稍后重试`;
  }
  return `MCP 工具 ${toolName} 调用失败：${message}`;
}

/** 连接阶段的错误信息中文化（附命令名便于排查） */
function describeConnectError(config: McpServerConfig, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|spawn/i.test(message)) {
    return `MCP server「${config.name}」启动失败：找不到命令 ${config.command}`;
  }
  if (/timed out|timeout/i.test(message)) {
    return `MCP server「${config.name}」连接超时：进程启动或初始化未在规定时间内完成（命令：${config.command}）`;
  }
  return `MCP server「${config.name}」连接失败：${message}（命令：${config.command}）`;
}
