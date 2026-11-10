import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProviderProfile, SessionRecord } from '@codexlike/agent-core';

import { MessageComposer } from '../components/MessageComposer';
import { MessageStream } from '../components/MessageStream';
import { SessionSidebar } from '../components/SessionSidebar';
import {
  applySessionEvent,
  initialMessages,
  type UiMessage,
} from '../lib/session-view';

/**
 * 主界面三栏装配：会话列表 / 消息流 / 输入框。
 * 会话与流式事件经 window.codexlike（类型化 IPC）与主进程交互。
 */
export function WorkspacePage(props: {
  onOpenSettings: () => void;
}) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const currentIdRef = useRef<string | null>(null);

  currentIdRef.current = currentId;

  const refreshSessions = useCallback(async () => {
    const list = await window.codexlike.sessions.list();
    setSessions(list);
    return list;
  }, []);

  const openSession = useCallback(async (id: string) => {
    setCurrentId(id);
    currentIdRef.current = id;
    const history = await window.codexlike.sessions.messages(id);
    setMessages(initialMessages(history));
    setStreaming(false);
  }, []);

  useEffect(() => {
    void (async () => {
      const [list, profileList] = await Promise.all([
        window.codexlike.sessions.list(),
        window.codexlike.providerProfiles.list(),
      ]);
      setSessions(list);
      setProfiles(profileList);
      if (profileList.length > 0) {
        setSelectedProfileId((prev) => prev || profileList[0]!.id);
      }
      // 启动时自动打开最近的会话（若有）
      if (list.length > 0) {
        const latest = list[0]!;
        setCurrentId(latest.id);
        currentIdRef.current = latest.id;
        const history = await window.codexlike.sessions.messages(latest.id);
        setMessages(initialMessages(history));
      }
    })();
  }, []);

  // 订阅会话事件流：只归并当前打开会话的消息，其余会话仅刷新侧栏状态
  useEffect(() => {
    return window.codexlike.onSessionEvent(({ sessionId, event }) => {
      if (sessionId === currentIdRef.current) {
        setMessages((prev) => applySessionEvent(prev, event));
        if (event.type === 'assistant-start') {
          setStreaming(true);
        }
        if (
          event.type === 'assistant-done' ||
          event.type === 'assistant-aborted' ||
          event.type === 'error'
        ) {
          setStreaming(false);
        }
      }
      if (
        event.type === 'user-message' ||
        event.type === 'assistant-done' ||
        event.type === 'assistant-aborted' ||
        event.type === 'error'
      ) {
        void refreshSessions();
      }
    });
  }, [refreshSessions]);

  async function createSession() {
    setCreating(true);
    try {
      const dir = await window.codexlike.sessions.selectWorkspace();
      if (dir === null) {
        return;
      }
      const record = await window.codexlike.sessions.create(dir);
      await refreshSessions();
      await openSession(record.id);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}`,
          role: 'error',
          content: `新建会话失败：${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
    } finally {
      setCreating(false);
    }
  }

  async function send(text: string) {
    if (currentId === null || selectedProfileId === '' || streaming) {
      return;
    }
    setStreaming(true);
    try {
      await window.codexlike.sessions.send(currentId, text, selectedProfileId);
    } catch (error) {
      // 启动失败（会话回复中 / Profile 缺失等）：直接在消息流提示
      setStreaming(false);
      setMessages((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}`,
          role: 'error',
          content: `发送失败：${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
    }
  }

  const composerHint =
    profiles.length === 0
      ? '尚未配置模型，请先前往设置页添加 Provider Profile'
      : currentId === null
        ? '新建或选择一个会话后开始对话'
        : '输入消息，Enter 发送（Shift+Enter 换行）';

  return (
    <div className="flex h-full">
      <SessionSidebar
        sessions={sessions}
        currentId={currentId}
        onSelect={(id) => void openSession(id)}
        onCreate={() => void createSession()}
        creating={creating}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        <MessageStream
          messages={messages}
          emptyHint={
            profiles.length === 0 ? (
              <button
                type="button"
                className="rounded border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-sky-600 hover:text-sky-400"
                onClick={props.onOpenSettings}
              >
                前往设置配置 Provider Profile
              </button>
            ) : undefined
          }
        />
        <MessageComposer
          profiles={profiles}
          selectedProfileId={selectedProfileId}
          onSelectProfile={setSelectedProfileId}
          onSend={(text) => void send(text)}
          disabled={currentId === null || profiles.length === 0 || streaming}
          hint={composerHint}
        />
      </section>
    </div>
  );
}
