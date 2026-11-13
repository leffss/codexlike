import {
  createMcpManager,
  type McpDiscoveredTool,
  type McpManager,
  type McpServerConfig,
  type McpServerStatus,
} from "@codexlike/agent-core/node";
import type { ToolDefinition } from "@codexlike/agent-core";

import type { McpStore, McpServerInput } from "./mcp-store";

/** 设置页 server 卡片需要的工具视图（发现结果 + 启停状态） */
export interface McpToolView extends McpDiscoveredTool {
  enabled: boolean;
}

/** 设置页 server 卡片的完整视图（IPC 返回形状） */
export interface McpServerView {
  config: McpServerConfig;
  status: McpServerStatus;
  error: string | null;
  tools: McpToolView[];
}

export interface McpService {
  /** 全部 server 配置 + 连接状态 + 工具（含启停），设置页渲染用 */
  overview(): Promise<{ servers: McpServerView[] }>;
  /** 新增 server：保存配置并立即尝试连接（连接失败也算添加成功，状态可见可重连） */
  addServer(input: McpServerInput): Promise<McpServerView>;
  /** 删除 server：断开连接并移除配置 */
  removeServer(id: string): Promise<void>;
  /** 手动重连（server 崩溃/启动失败后的显式入口；调用时也会惰性重连） */
  reconnect(id: string): Promise<McpServerView>;
  /** 工具启停：对后续任务消息即时生效（tools 工厂逐次解析） */
  setToolEnabled(toolName: string, enabled: boolean): Promise<void>;
  /**
   * 任务工具工厂：内置工具在前（同名优先），MCP 启用工具随后；
   * 交给 TaskManager 的 tools 选项，每条消息逐次解析。
   */
  taskTools(builtin?: ToolDefinition[]): ToolDefinition[];
  /** 应用启动时连接全部已配置 server（失败不抛，状态可见） */
  startup(): Promise<void>;
  /** 应用退出时断开全部子进程 */
  shutdown(): Promise<void>;
}

/**
 * MCP 装配服务：配置存储（mcp-store）+ 连接管理（agent-core McpManager）。
 * 配置与启停状态在内存缓存（McpManager 的 servers/disabledTools 是同步函数），
 * 任一写操作后从 store 重新加载。
 */
export function createMcpService(options: {
  store: McpStore;
  callTimeoutMs?: number;
}): McpService {
  const { store } = options;

  let configs: McpServerConfig[] = [];
  let disabledTools = new Set<string>();

  const manager: McpManager = createMcpManager({
    servers: () => configs,
    disabledTools: () => disabledTools,
    callTimeoutMs: options.callTimeoutMs,
  });

  async function reload(): Promise<void> {
    const snapshot = await store.snapshot();
    configs = snapshot.servers;
    disabledTools = new Set(snapshot.disabledTools);
  }

  async function viewOf(config: McpServerConfig): Promise<McpServerView> {
    const state = manager
      .states()
      .find((candidate) => candidate.serverId === config.id);
    return {
      config,
      status: state?.status ?? "disconnected",
      error: state?.error ?? null,
      tools: (state?.tools ?? []).map((tool) => ({
        ...tool,
        enabled: !disabledTools.has(tool.name),
      })),
    };
  }

  return {
    async overview() {
      await reload();
      const servers = await Promise.all(configs.map(viewOf));
      return { servers };
    },

    async addServer(input) {
      const config = await store.createServer(input);
      await reload();
      await manager.connect(config.id); // 立即连接；失败状态可见
      return viewOf(config);
    },

    async removeServer(id) {
      await manager.disconnect(id);
      await store.removeServer(id);
      await reload();
    },

    async reconnect(id) {
      await reload();
      await manager.connect(id);
      const config = configs.find((server) => server.id === id);
      if (config === undefined) {
        throw new Error(`MCP server ${id} 不存在`);
      }
      return viewOf(config);
    },

    async setToolEnabled(toolName, enabled) {
      await store.setToolEnabled(toolName, enabled);
      await reload();
    },

    taskTools(builtin = []) {
      const mcpTools = manager.tools();
      const names = new Set(builtin.map((tool) => tool.name));
      return [...builtin, ...mcpTools.filter((tool) => !names.has(tool.name))];
    },

    async startup() {
      await reload();
      await Promise.all(configs.map((config) => manager.connect(config.id)));
    },

    async shutdown() {
      await manager.close();
    },
  };
}
