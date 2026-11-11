import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";

import type { LanguageModel } from "ai";

import type {
  AgentResourceSnapshot,
  SessionResourceState,
} from "../context/resource-types";
import {
  createLanguageModelFromProfile,
  type ThinkingEffort,
} from "../provider/language-model";
import type { ProviderProfile } from "../provider/provider-profile";
import type { ToolDefinition } from "../tools/types";

import { createAgentSession, type AgentSession } from "./agent-session";
import type { ApprovalMode } from "./approval";
import type { SessionPersistence } from "./persistence";
import type { SessionSearchResult } from "./search";
import type { SubagentsConfig } from "./subagent";
import type {
  CompactRecord,
  ProjectRecord,
  SessionRecord,
  StoredMessage,
  TranscriptItem,
} from "./types";

export interface CreateSessionManagerOptions {
  persistence: SessionPersistence;
  /**
   * 会话可用的工具（空/缺省 = 纯对话；内置六件工具见 tools/builtin）。
   * 工厂形式让 desktop 装配把 MCP 工具的启停/连接状态逐次解析进每条消息（工单 12）。
   */
  tools?: ToolDefinition[] | (() => ToolDefinition[]);
  /**
   * 子代理编排配置（工单 13）：传入即向会话工具表追加 spawn_subagent。
   * tools 同时作为子代理的完整工具集（编排器剔除 spawn_subagent 防递归）。
   */
  subagents?: SubagentsConfig;
  /**
   * Provider Profile → 语言模型 的工厂；测试注入 mock，默认 OpenAI 兼容构造。
   * options 携带本条消息的思考档位快照（与 agent-session / subagent 的同名
   * 注入点签名对齐）；少参（0/1 参）工厂仍可注入——不关心档位的调用方不受影响。
   */
  languageModelFor?: (
    profile: ProviderProfile,
    options?: { thinkingEffort?: ThinkingEffort }
  ) => LanguageModel;
  /**
   * 会话系统提示工厂（AGENTS.md 发现 → 组装由宿主注入，agent-core 不依赖 fs）。
   * create 与 get 恢复时各调用一次。
   */
  systemPromptFor?: (record: SessionRecord) => string;
  /** 每条消息开始时刷新规范与技能目录；不会因读取状态而构建。 */
  resourcesFor?: (record: SessionRecord) => AgentResourceSnapshot;
  /** 工具截图是否作为图片附给模型（默认 true；纯文本端点在装配层关掉走降级路径） */
  attachToolImages?: boolean;
  now?: () => string;
  generateId?: () => string;
}

/**
 * 会话管理器：desktop 主进程的装配入口。
 * - `create`：新建会话（绑定工作区）并落库；
 * - `list` / `messages`：直接读持久层（应用启动时渲染侧栏与消息历史）；
 * - `get`：惰性恢复会话对象（读历史重建上下文；残留 streaming 状态重置为 idle）；
 * - `rename` / `setArchived`：/rename、/archive 命令与侧栏等效 UI 操作共用的落点。
 */
export interface SessionManager {
  addProject(workspacePath: string): ProjectRecord;
  projects(): ProjectRecord[];
  setProjectCollapsed(
    projectId: string,
    collapsed: boolean
  ): ProjectRecord | null;
  setPinned(sessionId: string, pinned: boolean): SessionRecord | null;
  markUsed(sessionId: string): SessionRecord | null;
  removeUnstarted(sessionId: string): void;
  create(options: {
    projectId?: string | null;
    creationRequestId?: string;
    approvalMode?: ApprovalMode;
    workspacePath: string;
    title?: string;
    /** 运行位置（默认 local 本目录直跑；worktree 由宿主先检出副本再传入其路径） */
    workspaceMode?: "local" | "worktree";
    /**
     * worktree 模式：用户所选的原始仓库路径（ADR 0005，侧栏项目聚合键）；
     * local 模式不传（origin 恒为 null，工作区即原始目录）。
     */
    workspaceOriginPath?: string;
    /** 会话 id（默认随机生成）；worktree 模式由宿主传入与副本目录同名的 id */
    id?: string;
  }): AgentSession;
  /** 全部会话记录（含已归档），置顶优先、最近使用倒序。 */
  list(): SessionRecord[];
  search(query: string, includeArchived?: boolean): SessionSearchResult[];
  /** 指定会话的消息历史（读持久层，不实例化会话对象） */
  messages(sessionId: string): StoredMessage[];
  /** 指定会话的时间线：消息与工具调用按发生顺序合并（UI 渲染与恢复用） */
  transcript(sessionId: string): TranscriptItem[];
  /** 惰性恢复会话对象；不存在返回 null；同 id 返回缓存实例 */
  get(sessionId: string): AgentSession | null;
  /** 只读缓存实例的运行/最近一轮摘要；未实例化会话返回空状态。 */
  resourceState(sessionId: string): SessionResourceState;
  /** /rename：更新标题并落库；不存在返回 null */
  rename(sessionId: string, title: string): SessionRecord | null;
  /** /archive：archived=true 记归档时间，false 取消归档；不存在返回 null */
  setArchived(sessionId: string, archived: boolean): SessionRecord | null;
  /**
   * 审批模式切换（三档）：落库（随会话记录跨重启恢复）并对已实例化会话立即
   * 生效（下一次工具调用）；拦截语义由工单 04 的审批状态机实现。不存在返回 null。
   */
  setApprovalMode(sessionId: string, mode: ApprovalMode): SessionRecord | null;
  /** 最近一次 compact 记录（/status「已压缩」标记）；从未压缩为 null */
  latestCompact(sessionId: string): CompactRecord | null;
  cancelInteractions(reason: string): void;
}

export function createSessionManager(
  options: CreateSessionManagerOptions
): SessionManager {
  const { persistence } = options;
  const languageModelFor =
    options.languageModelFor ?? createLanguageModelFromProfile;
  const systemPromptFor = options.systemPromptFor;
  const now = options.now ?? (() => new Date().toISOString());
  const generateId = options.generateId ?? randomUUID;

  const cache = new Map<string, AgentSession>();
  // 启动即终结所有残留请求：transcript 可在 get 前读取，绝不重放待执行工具。
  for (const session of persistence.listSessions()) {
    for (const interaction of persistence.listInteractions(session.id)) {
      if (interaction.status === "pending")
        persistence.settleInteraction({
          ...interaction,
          status: "cancelled",
          resolvedAt: now(),
          cancelReason: "应用已重启，原执行已结束",
        });
    }
    if (session.status !== "idle")
      persistence.updateSession(session.id, { status: "idle" });
  }

  function createdAtOf(item: TranscriptItem): string {
    return item.kind === "message"
      ? item.message.createdAt
      : item.kind === "interaction"
        ? item.interaction.request.createdAt
        : item.call.createdAt;
  }

  function restore(record: SessionRecord): AgentSession {
    const history = persistence.listMessages(record.id);
    // 上次退出时若流式/等待审批中途被杀，库里会残留 streaming / waiting-approval；恢复即视为空闲
    if (record.status === "streaming" || record.status === "waiting-approval") {
      const patched: SessionRecord = { ...record, status: "idle" };
      persistence.updateSession(record.id, { status: "idle" });
      return createCachedSession(patched, history);
    }
    return createCachedSession(record, history);
  }

  function createCachedSession(
    record: SessionRecord,
    history: StoredMessage[]
  ): AgentSession {
    const session = createAgentSession({
      record,
      persistence,
      history,
      tools: options.tools,
      subagents: options.subagents,
      systemPrompt: systemPromptFor?.(record) ?? "",
      resources:
        options.resourcesFor === undefined
          ? undefined
          : () => options.resourcesFor!(record),
      attachToolImages: options.attachToolImages,
      languageModelFor,
      approvalMode: record.approvalMode,
      now,
      generateId,
    });
    cache.set(record.id, session);
    return session;
  }

  /** 读取最新记录并应用补丁（rename / setArchived 共用）；同步刷新缓存实例的 record */
  function patchRecord(
    sessionId: string,
    patch: Partial<Omit<SessionRecord, "id" | "createdAt">>
  ): SessionRecord | null {
    const current = persistence
      .listSessions()
      .find((candidate) => candidate.id === sessionId);
    if (current === undefined) {
      return null;
    }
    persistence.updateSession(sessionId, patch);
    const next = { ...current, ...patch };
    const cached = cache.get(sessionId);
    if (cached !== undefined) {
      Object.assign(cached.record, next);
    }
    return next;
  }

  return {
    addProject(workspacePath) {
      if (!isAbsolute(workspacePath)) throw new Error("项目目录必须是绝对路径");
      let path: string;
      try {
        path = realpathSync.native(workspacePath);
        if (!statSync(path).isDirectory()) throw new Error();
      } catch {
        throw new Error(`项目目录不存在或无法访问：${workspacePath}`);
      }
      const existing = persistence
        .listProjects()
        .find((project) => project.workspacePath === path);
      if (existing) return existing;
      const project = {
        id: generateId(),
        name: basename(path) || path,
        workspacePath: path,
        collapsed: false,
        createdAt: now(),
      };
      persistence.insertProject(project);
      return project;
    },
    projects: () => persistence.listProjects(),
    setProjectCollapsed(projectId, collapsed) {
      persistence.setProjectCollapsed(projectId, collapsed);
      return (
        persistence.listProjects().find((item) => item.id === projectId) ?? null
      );
    },
    setPinned(sessionId, pinned) {
      return patchRecord(sessionId, { pinned });
    },
    markUsed(sessionId) {
      return patchRecord(sessionId, { lastUsedAt: now() });
    },
    cancelInteractions(reason) {
      for (const session of cache.values()) session.cancelInteractions(reason);
    },
    removeUnstarted(sessionId) {
      if (persistence.listMessages(sessionId).length)
        throw new Error("不能回滚已有历史的会话");
      persistence.removeUnstartedSession(sessionId);
      cache.delete(sessionId);
    },
    create({
      projectId = null,
      creationRequestId = null,
      approvalMode = "assist",
      workspacePath,
      title,
      workspaceMode = "local",
      id,
      workspaceOriginPath = null,
    }) {
      const timestamp = now();
      const record: SessionRecord = {
        // worktree 模式：宿主先检出托管 Worktree、以同一会话 id 落库（目录名 = 会话 id）
        id: id ?? generateId(),
        projectId,
        creationRequestId,
        title: title ?? (basename(workspacePath) || workspacePath),
        workspacePath,
        workspaceMode,
        workspaceOriginPath,
        providerProfileId: null,
        model: null,
        status: "idle",
        // 新建会话默认「帮我批准」（assist：写入与联网自动放行，仅危险命令审批）
        approvalMode,
        archivedAt: null,
        pinned: false,
        lastUsedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      persistence.insertSession(record);
      return createCachedSession(record, []);
    },

    list() {
      return persistence.listSessions();
    },
    search: (query, includeArchived) =>
      persistence.searchSessions(query, includeArchived),

    messages(sessionId) {
      return persistence.listMessages(sessionId);
    },

    transcript(sessionId) {
      const messages = persistence.listMessages(sessionId);
      const turnIds = new Set(messages.map((message) => message.id));
      const items: TranscriptItem[] = [
        ...persistence
          .listMessages(sessionId)
          .map((message): TranscriptItem => ({ kind: "message", message })),
        ...persistence
          .listToolCalls(sessionId)
          .map((call): TranscriptItem => ({ kind: "tool-call", call })),
        ...persistence
          .listInteractions(sessionId)
          .filter((interaction) => turnIds.has(interaction.request.turnId))
          .map((interaction): TranscriptItem => ({
            kind: "interaction",
            interaction,
          })),
      ];
      // stable sort：同 createdAt 保持 messages 在前的插入顺序
      items.sort((a, b) =>
        createdAtOf(a) < createdAtOf(b)
          ? -1
          : createdAtOf(a) > createdAtOf(b)
            ? 1
            : 0
      );
      return items;
    },

    get(sessionId) {
      const cached = cache.get(sessionId);
      if (cached !== undefined) {
        return cached;
      }
      const record = persistence
        .listSessions()
        .find((candidate) => candidate.id === sessionId);
      if (record === undefined) {
        return null;
      }
      return restore(record);
    },

    resourceState(sessionId) {
      return (
        cache.get(sessionId)?.resourceState ?? { active: null, last: null }
      );
    },

    rename(sessionId, title) {
      const trimmed = title.trim();
      if (trimmed === "") {
        throw new Error("会话名称不能为空");
      }
      return patchRecord(sessionId, { title: trimmed, updatedAt: now() });
    },

    setArchived(sessionId, archived) {
      return patchRecord(sessionId, {
        archivedAt: archived ? now() : null,
        updatedAt: now(),
      });
    },

    /** 审批模式切换（输入区选择器）：落库 + 对缓存实例立即生效（下一次工具调用） */
    setApprovalMode(sessionId, mode) {
      const next = patchRecord(sessionId, {
        approvalMode: mode,
        updatedAt: now(),
      });
      if (next !== null) {
        cache.get(sessionId)?.setApprovalMode(mode);
      }
      return next;
    },

    latestCompact(sessionId) {
      const compacts = persistence.listCompacts(sessionId);
      return compacts.length === 0 ? null : compacts[compacts.length - 1]!;
    },
  };
}
