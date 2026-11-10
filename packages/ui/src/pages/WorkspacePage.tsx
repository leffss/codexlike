import { useCallback, useEffect, useRef, useState } from 'react';

import {
  resolveComposerSubmission,
  type ProviderProfile,
  type SessionRecord,
} from '@codexlike/agent-core';

import { ChangesPanel } from '../components/ChangesPanel';
import { MessageComposer } from '../components/MessageComposer';
import { MessageStream } from '../components/MessageStream';
import { SessionSidebar } from '../components/SessionSidebar';
import {
  applySessionEvent,
  initialTranscript,
  type UiItem,
} from '../lib/session-view';
import {
  formatSessionStatus,
  matchProfilesForModelSwitch,
  planSlashCommand,
} from '../lib/slash-command-actions';

/**
 * 主界面三栏装配：会话列表 / 消息流 / 输入框。
 * 会话与流式事件经 window.codexlike（类型化 IPC）与主进程交互；
 * 斜杠命令与 @引用 在发送前经解析层分发（工单 07）。
 */
export function WorkspacePage(props: {
  onOpenSettings: () => void;
}) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [changesOpen, setChangesOpen] = useState(false);
  const currentIdRef = useRef<string | null>(null);

  currentIdRef.current = currentId;

  const refreshSessions = useCallback(async () => {
    const list = await window.codexlike.sessions.list();
    setSessions(list);
    return list;
  }, []);

  /** 本地命令反馈（/status、/rename 结果等）：不落库、不进模型上下文 */
  const pushLocalStatus = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role: 'status', content },
    ]);
  }, []);

  const openSession = useCallback(async (id: string) => {
    setCurrentId(id);
    currentIdRef.current = id;
    const history = await window.codexlike.sessions.messages(id);
    setMessages(initialTranscript(history));
    setStreaming(false);
    // @引用 菜单候选：随会话（工作区）切换重新枚举
    try {
      setWorkspaceFiles(await window.codexlike.sessions.workspaceFiles(id));
    } catch {
      setWorkspaceFiles([]);
    }
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
      // 启动时自动打开最近的未归档会话（若有）
      const latest = list.find((session) => session.archivedAt === null);
      if (latest !== undefined) {
        setCurrentId(latest.id);
        currentIdRef.current = latest.id;
        const history = await window.codexlike.sessions.messages(latest.id);
        setMessages(initialTranscript(history));
        try {
          setWorkspaceFiles(await window.codexlike.sessions.workspaceFiles(latest.id));
        } catch {
          setWorkspaceFiles([]);
        }
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

  async function createSession(workspacePath?: string) {
    setCreating(true);
    try {
      const dir = workspacePath ?? (await window.codexlike.sessions.selectWorkspace());
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

  async function send(text: string, mentionPaths: string[]) {
    if (currentId === null || selectedProfileId === '' || streaming) {
      return;
    }
    setStreaming(true);
    try {
      await window.codexlike.sessions.send(
        currentId,
        text,
        selectedProfileId,
        mentionPaths.length === 0 ? undefined : mentionPaths,
      );
    } catch (error) {
      // 启动失败（会话回复中 / Profile 缺失 / @引用 不可读等）：直接在消息流提示
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

  /** 斜杠命令执行（与等效 UI 操作走同一 IPC 通道，见 slash-command-actions） */
  async function runCommand(name: string, argument: string) {
    const action = planSlashCommand(
      { name: name as never, argument },
      current !== null,
    );
    switch (action.type) {
      case 'needs-session':
        pushLocalStatus('该命令需要先选择一个会话');
        return;
      case 'new-session': {
        // /new：同工作区新会话（不走目录选择器）
        await createSession(current!.workspacePath);
        return;
      }
      case 'rename': {
        try {
          await window.codexlike.sessions.rename(current!.id, action.title);
          await refreshSessions();
          pushLocalStatus(`会话已重命名为「${action.title}」`);
        } catch (error) {
          pushLocalStatus(`重命名失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      case 'rename-missing-argument':
        pushLocalStatus('用法：/rename 新名称');
        return;
      case 'archive': {
        const archivedId = current!.id;
        try {
          await window.codexlike.sessions.archive(archivedId, true);
          const list = await refreshSessions();
          pushLocalStatus('会话已归档（侧栏「已归档」中可恢复）');
          // 当前会话被归档：切到最近的未归档会话，没有则清空视图
          const next = list.find((session) => session.archivedAt === null);
          if (next !== undefined && next.id !== archivedId) {
            await openSession(next.id);
          } else if (next === undefined) {
            setCurrentId(null);
            currentIdRef.current = null;
            setMessages([]);
            setWorkspaceFiles([]);
          }
        } catch (error) {
          pushLocalStatus(`归档失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      case 'select-model': {
        const match = matchProfilesForModelSwitch(action.query, profiles);
        if (match.kind === 'unique') {
          setSelectedProfileId(match.profile.id);
          pushLocalStatus(
            `模型已切换：${match.profile.name} · ${match.profile.model}（对下一条消息生效）`,
          );
        } else {
          pushLocalStatus(
            [
              action.query === ''
                ? '当前可选模型（用 /model 关键词 切换）：'
                : `「${action.query}」匹配多个模型，请更精确地指定：`,
              ...match.candidates.map(
                (profile) => `- ${profile.name} · ${profile.model}`,
              ),
            ].join('\n'),
          );
        }
        return;
      }
      case 'status': {
        try {
          const status = await window.codexlike.sessions.status(current!.id);
          if (status === null) {
            pushLocalStatus('会话不存在或已损坏');
          } else {
            pushLocalStatus(formatSessionStatus(status));
          }
        } catch (error) {
          pushLocalStatus(`查询状态失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
    }
  }

  /** 输入框提交入口：解析层分发（斜杠命令 / 普通消息 + @引用） */
  function handleSubmit(text: string) {
    const submission = resolveComposerSubmission(text);
    if (submission === null) {
      return;
    }
    if (submission.kind === 'slash-command') {
      void runCommand(submission.name, submission.argument);
      return;
    }
    void send(submission.text, submission.mentionPaths);
  }

  const composerHint =
    profiles.length === 0
      ? '尚未配置模型，请先前往设置页添加 Provider Profile'
      : currentId === null
        ? '新建或选择一个会话后开始对话'
        : '输入消息，Enter 发送（Shift+Enter 换行）；/ 命令菜单、@ 引用工作区文件';

  /** 当前打开的会话记录（改动面板与顶栏显示用） */
  const current = sessions.find((session) => session.id === currentId) ?? null;

  return (
    <div className="flex h-full">
      <SessionSidebar
        sessions={sessions}
        currentId={currentId}
        onSelect={(id) => void openSession(id)}
        onCreate={() => void createSession()}
        creating={creating}
        onRename={(id, title) => {
          void window.codexlike.sessions
            .rename(id, title)
            .then(() => refreshSessions())
            .catch((error: unknown) =>
              pushLocalStatus(`重命名失败：${error instanceof Error ? error.message : String(error)}`),
            );
        }}
        onArchive={(id, archived) => {
          void window.codexlike.sessions
            .archive(id, archived)
            .then(() => refreshSessions())
            .catch((error: unknown) =>
              pushLocalStatus(
                `${archived ? '归档' : '恢复'}失败：${error instanceof Error ? error.message : String(error)}`,
              ),
            );
        }}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-slate-800 px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-sm text-slate-400">
            {current?.title ?? '未选择会话'}
          </span>
          <button
            type="button"
            data-testid="changes-toggle"
            onClick={() => setChangesOpen((prev) => !prev)}
            disabled={currentId === null}
            className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-sky-600 hover:text-sky-400 disabled:opacity-50"
          >
            {changesOpen ? '收起改动' : '改动'}
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <MessageStream
              items={messages}
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
              onSend={handleSubmit}
              workspaceFiles={workspaceFiles}
              disabled={currentId === null || profiles.length === 0 || streaming}
              hint={composerHint}
            />
          </div>
          {changesOpen && current !== null && (
            <ChangesPanel
              key={current.id}
              sessionId={current.id}
              sessionTitle={current.title}
              selectedProfileId={selectedProfileId}
              onClose={() => setChangesOpen(false)}
            />
          )}
        </div>
      </section>
    </div>
  );
}
