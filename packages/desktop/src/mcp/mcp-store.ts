import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { McpServerConfig } from '@codexlike/agent-core';

import type { SafeStorageLike } from '../profiles/profile-store';

/** 新增/编辑 server 的输入（IPC 边界校验后进入存储层） */
export interface McpServerInput {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** 落盘形态：env 值逐个加密（base64），磁盘上无明文凭据 */
interface StoredServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  encryptedEnv: Record<string, string>;
}

interface StoredFile {
  servers: StoredServer[];
  /** 被禁用的工具全名（mcp_<server>_<tool>） */
  disabledTools: string[];
}

export interface McpSnapshot {
  servers: McpServerConfig[];
  disabledTools: string[];
}

export interface McpStore {
  /** 全部配置 + 工具启停（env 已解密，仅存在于主进程内存） */
  snapshot(): Promise<McpSnapshot>;
  /** 新建 server 并落盘；env 非空且 safeStorage 不可用时拒绝（不落明文） */
  createServer(input: McpServerInput): Promise<McpServerConfig>;
  /** 删除 server；不存在返回 not-found */
  removeServer(id: string): Promise<{ status: 'removed' | 'not-found' }>;
  /** 工具启停（设置页逐工具开关）；enabled=true 时从禁用表移除 */
  setToolEnabled(toolName: string, enabled: boolean): Promise<void>;
}

const FILE_NAME = 'mcp-servers.json';

/** 输入校验（IPC 边界不信任渲染进程） */
export function validateMcpServerInput(input: unknown): McpServerInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('MCP server 配置不合法');
  }
  const { name, command, args, env } = input as Record<string, unknown>;
  const parsedName = typeof name === 'string' ? name.trim() : '';
  const parsedCommand = typeof command === 'string' ? command.trim() : '';
  if (parsedName === '') {
    throw new Error('MCP server 名称不能为空');
  }
  if (parsedCommand === '') {
    throw new Error('MCP server 启动命令不能为空');
  }
  if (args !== undefined && !Array.isArray(args)) {
    throw new Error('MCP server 参数必须是字符串数组');
  }
  if (env !== undefined && typeof env !== 'object') {
    throw new Error('MCP server 环境变量必须是键值对对象');
  }
  const parsedArgs = (args === undefined ? [] : (args as unknown[])).map((arg) =>
    typeof arg === 'string' ? arg : String(arg),
  );
  const parsedEnv: Record<string, string> = {};
  if (env !== undefined && env !== null) {
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error(`环境变量 ${key} 的值必须是字符串`);
      }
      parsedEnv[key] = value;
    }
  }
  return { name: parsedName, command: parsedCommand, args: parsedArgs, env: parsedEnv };
}

/** 基于 JSON 文件 + safeStorage 的 MCP server 配置存储（设置页「MCP servers」区） */
export function createMcpStore(options: {
  dir: string;
  safeStorage: SafeStorageLike;
}): McpStore {
  const { dir, safeStorage } = options;
  const filePath = join(dir, FILE_NAME);

  function loadFile(): StoredFile {
    try {
      const raw = readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as StoredFile;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { servers: [], disabledTools: [] };
      }
      throw error;
    }
  }

  function saveFile(file: StoredFile): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf8');
  }

  async function toStored(input: McpServerInput, id: string): Promise<StoredServer> {
    const encryptedEnv: Record<string, string> = {};
    const entries = Object.entries(input.env);
    if (entries.length > 0) {
      if (!(await safeStorage.isEncryptionAvailable())) {
        throw new Error(
          '系统加密存储（safeStorage）不可用，为避免环境变量明文落盘已拒绝保存（请清空环境变量后重试）',
        );
      }
      for (const [key, value] of entries) {
        encryptedEnv[key] = (await safeStorage.encryptString(value)).toString('base64');
      }
    }
    return {
      id,
      name: input.name,
      command: input.command,
      args: input.args,
      encryptedEnv,
    };
  }

  async function toConfig(stored: StoredServer): Promise<McpServerConfig> {
    const env: Record<string, string> = {};
    for (const [key, encrypted] of Object.entries(stored.encryptedEnv)) {
      env[key] = await safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    }
    return {
      id: stored.id,
      name: stored.name,
      command: stored.command,
      args: stored.args,
      env,
    };
  }

  return {
    async snapshot() {
      const file = loadFile();
      return {
        servers: await Promise.all(file.servers.map(toConfig)),
        disabledTools: [...file.disabledTools],
      };
    },

    async createServer(input) {
      const validated = validateMcpServerInput(input);
      const file = loadFile();
      const stored = await toStored(validated, randomUUID());
      saveFile({ ...file, servers: [...file.servers, stored] });
      return toConfig(stored);
    },

    async removeServer(id) {
      const file = loadFile();
      const remaining = file.servers.filter((server) => server.id !== id);
      if (remaining.length === file.servers.length) {
        return { status: 'not-found' as const };
      }
      saveFile({ servers: remaining, disabledTools: file.disabledTools });
      return { status: 'removed' as const };
    },

    async setToolEnabled(toolName, enabled) {
      const file = loadFile();
      const disabledTools = new Set(file.disabledTools);
      if (enabled) {
        disabledTools.delete(toolName);
      } else {
        disabledTools.add(toolName);
      }
      saveFile({
        servers: file.servers,
        disabledTools: [...disabledTools],
      });
    },
  };
}
