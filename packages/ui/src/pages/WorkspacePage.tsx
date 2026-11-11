import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  createWorkspaceState,
  type WorkspaceState,
} from "../lib/workspace-state";
import { InteractionPanel } from "../components/InteractionPanel";

import {
  evaluateContextWarning,
  resolveComposerSubmission,
  type ApprovalMode,
  type ProviderProfile,
  type ProjectRecord,
  type SessionEvent,
  type SessionRecord,
  type SessionResourcesView,
  type ThinkingEffort,
} from "@codexlike/agent-core";

import { AgentResourcesPanel } from "../components/AgentResourcesPanel";
import { ChangesPanel } from "../components/ChangesPanel";
import { FullAccessConfirmDialog } from "../components/FullAccessConfirmDialog";
import { MessageComposer } from "../components/MessageComposer";
import { MessageStream } from "../components/MessageStream";
import { SessionSidebar } from "../components/SessionSidebar";
import {
  applySessionEvent,
  initialTranscript,
  hydrateTranscript,
  mergeInteractions,
  type UiItem,
} from "../lib/session-view";
import {
  formatSessionStatus,
  matchProfilesForModelSwitch,
  planSlashCommand,
} from "../lib/slash-command-actions";

/**
 * 主界面三栏装配：会话列表 / 消息流 / 输入框。
 * 会话与流式事件经 window.codexlike（类型化 IPC）与主进程交互；
 * 斜杠命令与 @引用 在发送前经解析层分发（工单 07）。
 */
export function WorkspacePage(props: {
  onOpenSettings: () => void;
  state?: WorkspaceState;
}) {
  const [localState] = useState(createWorkspaceState);
  const workspaceState = props.state ?? localState;
  useSyncExternalStore(
    workspaceState.subscribe,
    workspaceState.version,
    workspaceState.version
  );
  const loadingRef = useRef<{
    sessionId: string;
    generation: number;
    events: SessionEvent[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  /** /compact 压缩进行中（不可重复触发、禁用输入） */
  const [compacting, setCompacting] = useState(false);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [draftProjectId, setDraftProjectId] = useState<
    string | null | undefined
  >(workspaceState.activeDraftProjectId);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const draft =
    draftProjectId === undefined
      ? null
      : workspaceState.newDraft(draftProjectId, profiles[0]?.id ?? "");
  const creating = draft?.busy ?? false;
  const [selectedProfileId, setSelectedProfileId] = useState("");
  /**
   * 思考档位（GLOSSARY「思考档位」）：前端临时发送设置，默认 auto，不做会话级记忆。
   * 发送时随消息传 IPC（快照由 agent-core 发送入口固定）；
   * 运行中可改选，只影响下一条消息。
   */
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort>("auto");
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [changesOpen, setChangesOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [resources, setResources] = useState<SessionResourcesView | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const resourceRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);
  /** 切换到「完全访问」的风险确认弹窗打开中（ADR 0004） */
  const [fullAccessPending, setFullAccessPending] = useState(false);
  /** 上下文告警文案（code review 修复 2）：估算 ≥ 窗口 × 80% 时在输入区上方提示 */
  const [contextWarning, setContextWarning] = useState<string | null>(null);
  const currentIdRef = useRef<string | null>(null);

  currentIdRef.current = currentId;
  /** 当前会话记录（审批模式选择器 / 改动面板 / 顶栏共用；sessions 列表随事件刷新） */
  const current = sessions.find((session) => session.id === currentId) ?? null;
  const pending = currentId === null ? [] : workspaceState.pending(currentId);
  const interaction = pending[0];
  const displayMessages =
    currentId === null
      ? messages
      : mergeInteractions(messages, workspaceState.records(currentId));

  const refreshSessions = useCallback(async () => {
    const list = await window.codexlike.sessions.list();
    setSessions(list);
    return list;
  }, []);

  /** 最新请求胜出；同时校验会话与请求代数，防止 A→B→A 的旧结果串线。 */
  const refreshResources = useCallback(async (sessionId: string) => {
    const request = ++resourceRequestRef.current;
    const isCurrent = () =>
      currentIdRef.current === sessionId &&
      resourceRequestRef.current === request;
    setResourcesLoading(true);
    setResourcesError(null);
    try {
      const view = await window.codexlike.sessions.resources(sessionId);
      if (!isCurrent()) return;
      setResources(view);
      if (view === null) setResourcesError("会话资源不可用");
    } catch (error) {
      if (!isCurrent()) return;
      setResources(null);
      setResourcesError(
        `读取规范与技能失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (isCurrent()) setResourcesLoading(false);
    }
  }, []);

  const refreshCurrentResources = useCallback(() => {
    const id = currentIdRef.current;
    if (id !== null) void refreshResources(id);
  }, [refreshResources]);

  /** 本地命令反馈（/status、/rename 结果等）：不落库、不进模型上下文 */
  const pushLocalStatus = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "status",
        content,
      },
    ]);
  }, []);

  /**
   * 上下文告警刷新（code review 修复 2，spec 验收场景 4）：
   * 以 /status 的 token 估算对照模型上下文窗口（Profile 可配，默认 128k）× 80%，
   * 超阈值在输入区上方常驻中文告警（/compact 后重估自然消失）；查询失败静默不打扰。
   */
  const refreshContextWarning = useCallback(async (sessionId: string) => {
    const sessionRequest = sessionRequestRef.current;
    const isCurrent = () =>
      currentIdRef.current === sessionId &&
      sessionRequestRef.current === sessionRequest;
    try {
      const status = await window.codexlike.sessions.status(sessionId);
      if (!isCurrent()) return;
      setContextWarning(
        status === null
          ? null
          : (evaluateContextWarning(
              status.estimatedContextTokens,
              status.contextWindowTokens ?? undefined
            )?.message ?? null)
      );
    } catch {
      if (isCurrent()) setContextWarning(null);
    }
  }, []);

  const openSession = useCallback(
    async (id: string) => {
      setDraftProjectId(undefined);
      workspaceState.activeDraftProjectId = undefined;
      setCurrentId(id);
      workspaceState.activeSessionId = id;
      currentIdRef.current = id;
      const request = ++sessionRequestRef.current;
      const isCurrent = () =>
        currentIdRef.current === id && sessionRequestRef.current === request;
      setMessages([]);
      setWorkspaceFiles([]);
      setResources(null);
      setContextWarning(null);
      setCompacting(false);
      setFullAccessPending(false);
      void refreshResources(id);
      setLoading(true);
      setStreaming(false);
      const buffer = {
        sessionId: id,
        generation: request,
        events: [] as SessionEvent[],
      };
      loadingRef.current = buffer;
      const snapshotVersion = workspaceState.version();
      try {
        const [history, pendingList, list] = await Promise.all([
          window.codexlike.sessions.messages(id),
          window.codexlike.sessions.pendingInteractions(id),
          window.codexlike.sessions.list(),
        ]);
        if (!isCurrent()) return;
        workspaceState.reconcile(
          id,
          history.flatMap((item) =>
            item.kind === "interaction" ? [item.interaction] : []
          ),
          snapshotVersion
        );
        for (const record of pendingList) workspaceState.observe(record);
        setMessages(
          mergeInteractions(
            hydrateTranscript(history, buffer.events),
            workspaceState.records(id)
          )
        );
        setSessions(list);
        const status = list.find((session) => session.id === id)?.status;
        let running =
          status === "streaming" ||
          status === "waiting-user" ||
          status === "waiting-approval";
        for (const event of buffer.events) {
          if (
            event.type === "assistant-start" ||
            event.type === "interaction-request"
          )
            running = true;
          if (
            event.type === "assistant-done" ||
            event.type === "assistant-aborted" ||
            event.type === "error"
          )
            running = false;
        }
        setStreaming(running || workspaceState.pending(id).length > 0);
      } catch (error) {
        if (!isCurrent()) return;
        setMessages([
          {
            id: `load-${request}`,
            role: "error",
            content: `读取会话失败：${error instanceof Error ? error.message : String(error)}`,
          },
        ]);
      } finally {
        if (isCurrent()) {
          loadingRef.current = null;
          setLoading(false);
        }
      }
      if (!isCurrent()) return;
      void refreshContextWarning(id);
      // @引用 菜单候选：随会话（工作区）切换重新枚举
      try {
        const files = await window.codexlike.sessions.workspaceFiles(id);
        if (isCurrent()) setWorkspaceFiles(files);
      } catch {
        if (isCurrent()) setWorkspaceFiles([]);
      }
    },
    [refreshContextWarning, refreshResources, workspaceState]
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      const [list, profileList, projectList] = await Promise.all([
        window.codexlike.sessions.list(),
        window.codexlike.providerProfiles.list(),
        window.codexlike.projects.list(),
      ]);
      if (active) setProjects(projectList);
      if (!active) return;
      setSessions(list);
      setProfiles(profileList);
      if (profileList.length > 0) {
        setSelectedProfileId((prev) => prev || profileList[0]!.id);
      }
      // 启动时自动打开最近的未归档会话（若有）
      const latest =
        list.find((session) => session.id === workspaceState.activeSessionId) ??
        list.find((session) => session.archivedAt === null);
      if (
        latest !== undefined &&
        currentIdRef.current === null &&
        workspaceState.activeDraftProjectId === undefined
      ) {
        await openSession(latest.id);
      }
    })();
    return () => {
      active = false;
    };
  }, [openSession]);

  // 订阅会话事件流：只归并当前打开会话的消息，其余会话仅刷新侧栏状态
  useEffect(() => {
    return window.codexlike.onSessionEvent(({ sessionId, event }) => {
      if (sessionId === currentIdRef.current) {
        if (loadingRef.current?.sessionId === sessionId)
          loadingRef.current.events.push(event);
        else setMessages((prev) => applySessionEvent(prev, event));
        if (
          event.type === "assistant-start" ||
          event.type === "interaction-request"
        ) {
          setStreaming(true);
        }
        if (
          event.type === "assistant-start" ||
          event.type === "tool-result" ||
          (event.type === "subagent-tool" && event.phase === "result") ||
          event.type === "assistant-done" ||
          event.type === "assistant-aborted" ||
          event.type === "error"
        ) {
          void refreshResources(sessionId);
        }
        if (
          event.type === "assistant-done" ||
          event.type === "assistant-aborted" ||
          event.type === "error"
        ) {
          setStreaming(false);
          // 每轮回复结束（完成/中断/出错）后重估上下文告警
          void refreshContextWarning(sessionId);
        }
      }
      if (
        event.type === "user-message" ||
        event.type === "assistant-done" ||
        event.type === "assistant-aborted" ||
        event.type === "error" ||
        event.type === "interaction-request" ||
        event.type === "interaction-resolved"
      ) {
        // 审批事件也驱动侧栏状态徽标（运行中 ↔ 等待审批）
        void refreshSessions();
      }
    });
  }, [
    refreshSessions,
    refreshContextWarning,
    refreshResources,
    workspaceState,
  ]);

  useEffect(
    () => () => {
      // 页面卸载后的迟到加载不能写回新工作台页面。
      sessionRequestRef.current += 1;
      resourceRequestRef.current += 1;
      currentIdRef.current = null;
    },
    []
  );

  /** 入口只打开每项目/独立入口唯一的内存草稿，不调用创建 IPC。 */
  function startCreateSession(projectId: string | null = null) {
    workspaceState.newDraft(projectId, profiles[0]?.id ?? "");
    workspaceState.activeDraftProjectId = projectId;
    workspaceState.activeSessionId = null;
    setDraftProjectId(projectId);
    setCurrentId(null);
    currentIdRef.current = null;
    sessionRequestRef.current += 1;
    resourceRequestRef.current += 1;
    loadingRef.current = null;
    setMessages([]);
    setWorkspaceFiles([]);
    setResources(null);
    setLoading(false);
    setStreaming(false);
    setCompacting(false);
    setContextWarning(null);
    setFullAccessPending(false);
  }

  async function addProject() {
    try {
      const path = await window.codexlike.sessions.selectWorkspace();
      if (path === null) return;
      await window.codexlike.projects.add(path);
      setProjects(await window.codexlike.projects.list());
    } catch (error) {
      pushLocalStatus(
        `添加项目失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function selectDraftWorkspace() {
    if (!draft || draft.projectId !== null || draft.busy) return;
    const path = await window.codexlike.sessions.selectWorkspace();
    if (path !== null)
      workspaceState.editNewDraft(null, { workspacePath: path });
  }

  async function sendFirst(text: string, mentionPaths: string[]) {
    if (!draft || draft.busy) return;
    const projectId = draft.projectId;
    const request = {
      requestId: draft.requestId,
      projectId,
      workspacePath: draft.workspacePath,
      text,
      mentionPaths,
      providerProfileId: draft.providerProfileId || undefined,
      thinkingEffort: draft.thinkingEffort,
      approvalMode: draft.approvalMode,
    };
    workspaceState.editNewDraft(projectId, { busy: true, error: null });
    try {
      const record = await window.codexlike.sessions.start(request);
      workspaceState.completeNewDraft(projectId);
      await refreshSessions();
      if (workspaceState.activeDraftProjectId === projectId) {
        setSelectedProfileId(
          request.providerProfileId ?? profiles[0]?.id ?? ""
        );
        setThinkingEffort(request.thinkingEffort);
        await openSession(record.id);
      }
    } catch (error) {
      workspaceState.editNewDraft(projectId, {
        busy: false,
        error: `创建失败，可重试：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function send(text: string, mentionPaths: string[]) {
    if (
      currentId === null ||
      selectedProfileId === "" ||
      streaming ||
      compacting ||
      loading ||
      workspaceState.pending(currentId).length > 0
    ) {
      return;
    }
    setStreaming(true);
    try {
      await window.codexlike.sessions.send(
        currentId,
        text,
        selectedProfileId,
        mentionPaths.length === 0 ? undefined : mentionPaths,
        thinkingEffort
      );
    } catch (error) {
      // 启动失败（含显式技能解析/加载错误）：只在发起会话仍打开时提示。
      if (currentIdRef.current !== currentId) return;
      setStreaming(false);
      void refreshResources(currentId);
      setMessages((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}`,
          role: "error",
          content: `发送失败：${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
    }
  }

  /** 停止按钮：打断当前会话运行中的本轮（流式输出中断 / 工具子进程终止）。
   *  中断结果经事件流（assistant-aborted / tool-result）回流，streaming 状态随之复位。 */
  async function stop() {
    if (currentId === null) {
      return;
    }
    try {
      await window.codexlike.sessions.interrupt(currentId);
    } catch (error) {
      pushLocalStatus(
        `停止失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** 斜杠命令执行（与等效 UI 操作走同一 IPC 通道，见 slash-command-actions） */
  async function runCommand(name: string, argument: string) {
    const action = planSlashCommand(
      { name: name as never, argument },
      current !== null
    );
    switch (action.type) {
      case "needs-session":
        pushLocalStatus("该命令需要先选择一个会话");
        return;
      case "new-session": {
        // /new：同工作区新会话（不走目录选择器与模式对话框，本目录直跑）
        startCreateSession(current?.projectId ?? null);
        return;
      }
      case "compact": {
        // /compact：压缩进行中不可重复触发；模型在主进程解析（apiKey 不入渲染层）
        if (compacting) {
          pushLocalStatus("正在压缩历史，请等待完成…");
          return;
        }
        if (selectedProfileId === "") {
          pushLocalStatus("压缩需要先选择模型（Provider Profile）");
          return;
        }
        const compactSessionId = current!.id;
        const compactGeneration = sessionRequestRef.current;
        const compactIsCurrent = () =>
          currentIdRef.current === compactSessionId &&
          sessionRequestRef.current === compactGeneration;
        setCompacting(true);
        try {
          const result = await window.codexlike.sessions.compact(
            current!.id,
            selectedProfileId
          );
          await refreshSessions();
          // 重拉时间线：被压缩历史折叠为摘要卡片 + 最近 3 轮原文
          const snapshotVersion = workspaceState.version();
          const history =
            await window.codexlike.sessions.messages(compactSessionId);
          workspaceState.reconcile(
            compactSessionId,
            history.flatMap((item) =>
              item.kind === "interaction" ? [item.interaction] : []
            ),
            snapshotVersion
          );
          if (!compactIsCurrent()) return;
          setMessages(initialTranscript(history));
          // 压缩后用量下降，告警随之重估（大概率消失）
          await refreshContextWarning(compactSessionId);
          if (!compactIsCurrent()) return;
          pushLocalStatus(
            `已压缩：${result.compactedMessages} 条历史消息已替换为摘要（保留最近 3 轮原始对话）`
          );
        } catch (error) {
          if (!compactIsCurrent()) return;
          pushLocalStatus(
            `压缩失败：${error instanceof Error ? error.message : String(error)}（历史未受影响，可重试 /compact）`
          );
        } finally {
          if (compactIsCurrent()) setCompacting(false);
        }
        return;
      }
      case "rename": {
        try {
          await window.codexlike.sessions.rename(current!.id, action.title);
          await refreshSessions();
          pushLocalStatus(`会话已重命名为「${action.title}」`);
        } catch (error) {
          pushLocalStatus(
            `重命名失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
        return;
      }
      case "rename-missing-argument":
        pushLocalStatus("用法：/rename 新名称");
        return;
      case "archive": {
        const archivedId = current!.id;
        try {
          await window.codexlike.sessions.archive(archivedId, true);
          const list = await refreshSessions();
          pushLocalStatus("会话已归档（侧栏「已归档」中可恢复）");
          // 当前会话被归档：切到最近的未归档会话，没有则清空视图
          const next = list.find((session) => session.archivedAt === null);
          if (next !== undefined && next.id !== archivedId) {
            await openSession(next.id);
          } else if (next === undefined) {
            setCurrentId(null);
            currentIdRef.current = null;
            sessionRequestRef.current += 1;
            resourceRequestRef.current += 1;
            setResources(null);
            setResourcesLoading(false);
            setResourcesError(null);
            setMessages([]);
            setWorkspaceFiles([]);
            setContextWarning(null);
          }
        } catch (error) {
          pushLocalStatus(
            `归档失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
        return;
      }
      case "select-model": {
        const match = matchProfilesForModelSwitch(action.query, profiles);
        if (match.kind === "unique") {
          setSelectedProfileId(match.profile.id);
          pushLocalStatus(
            `模型已切换：${match.profile.name} · ${match.profile.model}（对下一条消息生效）`
          );
        } else {
          pushLocalStatus(
            [
              action.query === ""
                ? "当前可选模型（用 /model 关键词 切换）："
                : `「${action.query}」匹配多个模型，请更精确地指定：`,
              ...match.candidates.map(
                (profile) => `- ${profile.name} · ${profile.model}`
              ),
            ].join("\n")
          );
        }
        return;
      }
      case "status": {
        const sessionId = current!.id;
        const request = sessionRequestRef.current;
        try {
          const status = await window.codexlike.sessions.status(sessionId);
          if (
            currentIdRef.current !== sessionId ||
            sessionRequestRef.current !== request
          )
            return;
          if (status === null) {
            pushLocalStatus("会话不存在或已损坏");
          } else {
            pushLocalStatus(formatSessionStatus(status));
          }
        } catch (error) {
          if (
            currentIdRef.current !== sessionId ||
            sessionRequestRef.current !== request
          )
            return;
          pushLocalStatus(
            `查询状态失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
        return;
      }
    }
  }

  /** 输入框提交入口：解析层分发（斜杠命令 / 普通消息 + @引用） */
  function handleSubmit(text: string) {
    if (
      loading ||
      (currentId !== null && workspaceState.pending(currentId).length > 0)
    )
      return;
    const submission = resolveComposerSubmission(text);
    if (submission === null) {
      return;
    }
    if (submission.kind === "slash-command") {
      void runCommand(submission.name, submission.argument);
      return;
    }
    if (draft) void sendFirst(submission.text, submission.mentionPaths);
    else void send(submission.text, submission.mentionPaths);
  }

  /**
   * 审批模式切换：随时可切，对下一次工具调用立即生效。
   * 切到「完全访问」先弹风险确认（ADR 0004：该档放开工作区文件边界）；
   * 取消不发起 IPC，选择器受控值自然回显原档位。
   */
  function selectApprovalMode(mode: ApprovalMode) {
    if (mode === "full-access") {
      const current = sessions.find((session) => session.id === currentId);
      if (current?.approvalMode !== "full-access") {
        setFullAccessPending(true);
        return;
      }
    }
    void applyApprovalMode(mode);
  }

  async function applyApprovalMode(mode: ApprovalMode) {
    if (draft) {
      workspaceState.editNewDraft(draft.projectId, { approvalMode: mode });
      return;
    }
    if (currentId === null) {
      return;
    }
    try {
      await window.codexlike.sessions.setApprovalMode(currentId, mode);
      await refreshSessions();
    } catch (error) {
      pushLocalStatus(
        `切换审批模式失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const composerHint =
    profiles.length === 0
      ? "尚未配置模型，请先前往设置页添加 Provider Profile"
      : compacting
        ? "正在压缩历史，请稍候…"
        : currentId === null && !draft
          ? "新建或选择一个会话后开始对话"
          : "输入消息，Enter 发送（Shift+Enter 换行）；/ 命令、@ 文件引用、$ 技能";

  return (
    <div className="flex h-full">
      {fullAccessPending && (
        <FullAccessConfirmDialog
          onConfirm={() => {
            setFullAccessPending(false);
            void applyApprovalMode("full-access");
          }}
          onCancel={() => setFullAccessPending(false)}
        />
      )}
      <SessionSidebar
        projects={projects}
        onAddProject={() => void addProject()}
        onCreateInProject={startCreateSession}
        sessions={sessions}
        currentId={currentId}
        onSelect={(id) => void openSession(id)}
        onCreate={() => void startCreateSession()}
        creating={creating}
        onRename={(id, title) => {
          void window.codexlike.sessions
            .rename(id, title)
            .then(() => refreshSessions())
            .catch((error: unknown) =>
              pushLocalStatus(
                `重命名失败：${error instanceof Error ? error.message : String(error)}`
              )
            );
        }}
        onArchive={(id, archived) => {
          void window.codexlike.sessions
            .archive(id, archived)
            .then(() => refreshSessions())
            .catch((error: unknown) =>
              pushLocalStatus(
                `${archived ? "归档" : "恢复"}失败：${error instanceof Error ? error.message : String(error)}`
              )
            );
        }}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">
            {current?.title ??
              (draft
                ? draft.projectId === null
                  ? "新建独立会话"
                  : `新建项目会话 · ${projects.find((p) => p.id === draft.projectId)?.name ?? "项目"}`
                : "未选择会话")}
          </span>
          <button
            type="button"
            data-testid="resources-toggle"
            disabled={currentId === null}
            aria-expanded={resourcesOpen}
            onClick={() => {
              if (!resourcesOpen) refreshCurrentResources();
              setResourcesOpen((prev) => !prev);
            }}
            className="rounded border border-line px-3 py-1 text-xs text-fg-muted hover:border-accent hover:text-accent disabled:opacity-50"
          >
            规范与技能
          </button>
          <button
            type="button"
            data-testid="changes-toggle"
            onClick={() => setChangesOpen((prev) => !prev)}
            disabled={currentId === null}
            className="rounded border border-line px-3 py-1 text-xs text-fg-muted hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {changesOpen ? "收起改动" : "改动"}
          </button>
        </header>
        {(current || draft) && (
          <div className="border-b border-line px-4 py-2 text-xs text-fg-muted">
            <div
              data-testid="workspace-path"
              title={
                current?.workspacePath ??
                draft?.workspacePath ??
                projects.find((p) => p.id === draft?.projectId)?.workspacePath
              }
              className="break-all"
            >
              工作区：
              {current?.workspacePath ??
                draft?.workspacePath ??
                projects.find((p) => p.id === draft?.projectId)
                  ?.workspacePath ??
                "应用专用持久目录（首次发送时分配）"}
            </div>
            {draft ? (
              <span>首次发送才创建会话 · 本地模式</span>
            ) : (
              <span>工作区已固定</span>
            )}
            {draft?.projectId === null && (
              <button
                type="button"
                data-testid="draft-select-workspace"
                disabled={creating}
                onClick={() => void selectDraftWorkspace()}
                className="ml-3 text-accent"
              >
                选择已有目录
              </button>
            )}
            {draft?.workspacePath && (
              <button
                type="button"
                data-testid="draft-managed-workspace"
                disabled={creating}
                onClick={() =>
                  workspaceState.editNewDraft(null, {
                    workspacePath: undefined,
                  })
                }
                className="ml-3 text-accent"
              >
                使用专用目录
              </button>
            )}
            {draft?.error && (
              <p
                data-testid="draft-error"
                role="alert"
                className="mt-2 text-danger-fg"
              >
                {draft.error}
              </p>
            )}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <MessageStream
              items={displayMessages}
              compacting={compacting}
              emptyHint={
                profiles.length === 0 ? (
                  <button
                    type="button"
                    className="rounded border border-line px-4 py-2 text-sm text-fg-muted hover:border-accent hover:text-accent"
                    onClick={props.onOpenSettings}
                  >
                    前往设置配置 Provider Profile
                  </button>
                ) : undefined
              }
            />
            {contextWarning !== null && (
              <div
                data-testid="context-warning"
                className="border-t border-warn-fg/40 bg-warn-bg px-4 py-2 text-xs text-warn-fg"
              >
                {contextWarning}
              </div>
            )}
            {interaction ? (
              <InteractionPanel
                key={interaction.request.id}
                record={interaction}
                count={pending.length}
                draft={workspaceState.draft(
                  interaction.request.sessionId,
                  interaction.request.id
                )}
                {...workspaceState.submission(
                  interaction.request.sessionId,
                  interaction.request.id
                )}
                onChange={(action) =>
                  workspaceState.edit(
                    interaction.request.sessionId,
                    interaction.request.id,
                    action
                  )
                }
                onRespond={(response) =>
                  void workspaceState.submit(
                    interaction.request.sessionId,
                    interaction.request.id,
                    response,
                    (sessionId, requestId, payload) =>
                      window.codexlike.sessions.respondInteraction(
                        sessionId,
                        requestId,
                        payload
                      )
                  )
                }
                onStop={() => void stop()}
              />
            ) : (
              <MessageComposer
                key={currentId ?? `draft-${draftProjectId}`}
                draftValue={
                  draft?.text ??
                  (currentId === null ? "" : workspaceState.composer(currentId))
                }
                onDraftChange={(text) => {
                  if (draft)
                    workspaceState.editNewDraft(draft.projectId, { text });
                  else if (currentId !== null)
                    workspaceState.setComposer(currentId, text);
                }}
                clearOnSend={!draft}
                profiles={profiles}
                selectedProfileId={
                  draft?.providerProfileId ?? selectedProfileId
                }
                onSelectProfile={(id) =>
                  draft
                    ? workspaceState.editNewDraft(draft.projectId, {
                        providerProfileId: id,
                      })
                    : setSelectedProfileId(id)
                }
                onSend={handleSubmit}
                workspaceFiles={workspaceFiles}
                skills={resources?.preview.catalog.skills}
                onOpenSkills={refreshCurrentResources}
                disabled={
                  (currentId === null && !draft) ||
                  creating ||
                  profiles.length === 0 ||
                  streaming ||
                  compacting ||
                  loading ||
                  pending.length > 0
                }
                streaming={streaming}
                onStop={() => void stop()}
                hint={composerHint}
                approvalMode={
                  draft?.approvalMode ?? current?.approvalMode ?? null
                }
                onSelectApprovalMode={(mode) => void selectApprovalMode(mode)}
                thinkingEffort={
                  draft?.thinkingEffort ??
                  (currentId === null ? null : thinkingEffort)
                }
                onSelectThinkingEffort={(effort) =>
                  draft
                    ? workspaceState.editNewDraft(draft.projectId, {
                        thinkingEffort: effort,
                      })
                    : setThinkingEffort(effort)
                }
              />
            )}
          </div>
          {resourcesOpen && currentId !== null && (
            <AgentResourcesPanel
              resources={resources}
              loading={resourcesLoading}
              error={resourcesError}
              onRefresh={refreshCurrentResources}
              onClose={() => setResourcesOpen(false)}
            />
          )}
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
