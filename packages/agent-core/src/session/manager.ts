import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type { LanguageModel } from 'ai';

import { createLanguageModelFromProfile } from '../provider/language-model';
import type { ProviderProfile } from '../provider/provider-profile';
import type { ToolDefinition } from '../tools/types';

import { createAgentSession, type AgentSession } from './agent-session';
import type { SessionPersistence } from './persistence';
import type { SessionRecord, StoredMessage, TranscriptItem } from './types';

export interface CreateSessionManagerOptions {
  persistence: SessionPersistence;
  /** 会话可用的工具（空/缺省 = 纯对话；内置六件工具见 tools/builtin） */
  tools?: ToolDefinition[];
  /** Provider Profile → 语言模型 的工厂；测试注入 mock，默认 OpenAI 兼容构造 */
  languageModelFor?: (profile: ProviderProfile) => LanguageModel;
  now?: () => string;
  generateId?: () => string;
}

/**
 * 会话管理器：desktop 主进程的装配入口。
 * - `create`：新建会话（绑定工作区）并落库；
 * - `list` / `messages`：直接读持久层（应用启动时渲染侧栏与消息历史）；
 * - `get`：惰性恢复会话对象（读历史重建上下文；残留 streaming 状态重置为 idle）。
 */
export interface SessionManager {
  create(options: { workspacePath: string; title?: string }): AgentSession;
  /** 全部会话记录，按 updatedAt 倒序 */
  list(): SessionRecord[];
  /** 指定会话的消息历史（读持久层，不实例化会话对象） */
  messages(sessionId: string): StoredMessage[];
  /** 指定会话的时间线：消息与工具调用按发生顺序合并（UI 渲染与恢复用） */
  transcript(sessionId: string): TranscriptItem[];
  /** 惰性恢复会话对象；不存在返回 null；同 id 返回缓存实例 */
  get(sessionId: string): AgentSession | null;
}

export function createSessionManager(
  options: CreateSessionManagerOptions,
): SessionManager {
  const { persistence } = options;
  const languageModelFor = options.languageModelFor ?? createLanguageModelFromProfile;
  const now = options.now ?? (() => new Date().toISOString());
  const generateId = options.generateId ?? randomUUID;

  const cache = new Map<string, AgentSession>();

  function createdAtOf(item: TranscriptItem): string {
    return item.kind === 'message' ? item.message.createdAt : item.call.createdAt;
  }

  function restore(record: SessionRecord): AgentSession {
    const history = persistence.listMessages(record.id);
    // 上次退出时若流式中途被杀，库里会残留 streaming；恢复即视为空闲
    if (record.status === 'streaming') {
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
        languageModelFor,
        now,
        generateId,
      });
    cache.set(record.id, session);
    return session;
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
  };
}
