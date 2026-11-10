import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type { LanguageModel } from 'ai';

import { createLanguageModelFromProfile } from '../provider/language-model';
import type { ProviderProfile } from '../provider/provider-profile';
import type { ToolDefinition } from '../tools/types';

import { createAgentSession, type AgentSession } from './agent-session';
import type { ApprovalMode } from './approval';
import type { SessionPersistence } from './persistence';
import type { SubagentsConfig } from './subagent';
import type {
  CompactRecord,
  SessionRecord,
  StoredMessage,
  TranscriptItem,
} from './types';

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
  /** Provider Profile → 语言模型 的工厂；测试注入 mock，默认 OpenAI 兼容构造 */
  languageModelFor?: (profile: ProviderProfile) => LanguageModel;
  /**
   * 会话系统提示工厂（AGENTS.md 发现 → 组装由宿主注入，agent-core 不依赖 fs）。
   * create 与 get 恢复时各调用一次。
   */
  systemPromptFor?: (record: SessionRecord) => string;
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
  create(options: { workspacePath: string; title?: string }): AgentSession;
  /** 全部会话记录（含已归档），按 updatedAt 倒序 */
  list(): SessionRecord[];
  /** 指定会话的消息历史（读持久层，不实例化会话对象） */
  messages(sessionId: string): StoredMessage[];
  /** 指定会话的时间线：消息与工具调用按发生顺序合并（UI 渲染与恢复用） */
  transcript(sessionId: string): TranscriptItem[];
  /** 惰性恢复会话对象；不存在返回 null；同 id 返回缓存实例 */
  get(sessionId: string): AgentSession | null;
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
}

export function createSessionManager(
  options: CreateSessionManagerOptions,
): SessionManager {
  const { persistence } = options;
  const languageModelFor = options.languageModelFor ?? createLanguageModelFromProfile;
  const systemPromptFor = options.systemPromptFor;
  const now = options.now ?? (() => new Date().toISOString());
  const generateId = options.generateId ?? randomUUID;

  const cache = new Map<string, AgentSession>();

  function createdAtOf(item: TranscriptItem): string {
    return item.kind === 'message' ? item.message.createdAt : item.call.createdAt;
  }

  function restore(record: SessionRecord): AgentSession {
    const history = persistence.listMessages(record.id);
    // 上次退出时若流式/等待审批中途被杀，库里会残留 streaming / waiting-approval；恢复即视为空闲
    if (record.status === 'streaming' || record.status === 'waiting-approval') {
      const patched: SessionRecord = { ...record, status: 'idle' };
      persistence.updateSession(record.id, { status: 'idle' });
      return createCachedSession(patched, history);
    }
    return createCachedSession(record, history);
  }

  function createCachedSession(
    record: SessionRecord,
    history: StoredMessage[],
  ): AgentSession {
    const session = createAgentSession({
      record,
      persistence,
      history,
      tools: options.tools,
      subagents: options.subagents,
      systemPrompt: systemPromptFor?.(record) ?? '',
      languageModelFor,
      approvalMode: record.approvalMode,
      approvalMemory: persistence.listApprovals(record.id),
      now,
      generateId,
    });
    cache.set(record.id, session);
    return session;
  }

  /** 读取最新记录并应用补丁（rename / setArchived 共用）；同步刷新缓存实例的 record */
  function patchRecord(
    sessionId: string,
    patch: Partial<Omit<SessionRecord, 'id' | 'createdAt'>>,
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
    create({ workspacePath, title }) {
      const timestamp = now();
      const record: SessionRecord = {
        id: generateId(),
        title: title ?? (basename(workspacePath) || workspacePath),
        workspacePath,
        providerProfileId: null,
        model: null,
        status: 'idle',
        // 新建会话默认协作模式（suggest：文件编辑自动应用、命令逐条审批）
        approvalMode: 'suggest',
        archivedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      persistence.insertSession(record);
      return createCachedSession(record, []);
    },

    list() {
      return persistence.listSessions();
    },

    messages(sessionId) {
      return persistence.listMessages(sessionId);
    },

    transcript(sessionId) {
      const items: TranscriptItem[] = [
        ...persistence.listMessages(sessionId).map(
          (message): TranscriptItem => ({ kind: 'message', message }),
        ),
        ...persistence.listToolCalls(sessionId).map(
          (call): TranscriptItem => ({ kind: 'tool-call', call }),
        ),
      ];
      // stable sort：同 createdAt 保持 messages 在前的插入顺序
      items.sort((a, b) =>
        createdAtOf(a) < createdAtOf(b) ? -1 : createdAtOf(a) > createdAtOf(b) ? 1 : 0,
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

    rename(sessionId, title) {
      const trimmed = title.trim();
      if (trimmed === '') {
        throw new Error('会话名称不能为空');
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
      const next = patchRecord(sessionId, { approvalMode: mode, updatedAt: now() });
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
