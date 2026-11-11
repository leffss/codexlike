import type { ToolDefinition } from "../tools/types";

/** 可跨 IPC 的资源元数据；不包含技能正文。 */
export interface ResourceDiagnostic {
  path: string;
  message: string;
}

export interface SkillDescriptor {
  name: string;
  description: string;
  path: string;
  directory: string;
  scope: "global" | "project";
  source: "codexlike" | "agents";
  status: "active" | "shadowed" | "invalid" | "excluded";
  reason?: string;
}

export interface AgentInstructionSource {
  path: string;
  scope: "global" | "project";
  bytes: number;
  includedBytes: number;
}

export interface ResourceCatalog {
  capturedAt: string;
  agents: {
    sources: AgentInstructionSource[];
    truncated: boolean;
  };
  skills: SkillDescriptor[];
  diagnostics: ResourceDiagnostic[];
  indexBytes: number;
}

export interface SkillLoadRecord {
  executorId: string;
  name: string;
  path: string;
  kind: "skill" | "resource";
  bytes: number;
}

export interface ResourceSnapshotSummary {
  catalog: ResourceCatalog;
  loaded: SkillLoadRecord[];
  /** 主会话规范、索引与已加载文本的 token 估算，不含历史消息。 */
  estimatedTokens: number;
}

export interface SessionResourceState {
  active: ResourceSnapshotSummary | null;
  last: ResourceSnapshotSummary | null;
}

export interface SessionResourcesView extends SessionResourceState {
  /** 最新磁盘预览，不代表当前运行快照。 */
  preview: ResourceSnapshotSummary;
}

/** 每个主/子代理有独立的加载状态与预算。 */
export interface ResourceExecution {
  tools: ToolDefinition[];
  /** 事务性验证本条消息显式引用，返回仅本轮注入的正文；失败抛错。 */
  loadExplicit(names: readonly string[]): string;
}

/** 目录与规范按消息固定；正文仅使用时读取。实现仅从 /node 出口导出。 */
export interface AgentResourceSnapshot {
  systemPrompt: string;
  catalog: ResourceCatalog;
  createExecution(executorId: string): ResourceExecution;
  summary(): ResourceSnapshotSummary;
}
