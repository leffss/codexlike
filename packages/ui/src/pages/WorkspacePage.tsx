import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  createWorkspaceState,
  type WorkspaceState,
} from "../lib/workspace-state";
import { InteractionPanel } from "../components/InteractionPanel";
import {
  WorkspaceModeSelector,
  WorkspaceSharingNotice,
} from "../components/WorkspaceModeControl";
import type {
  SessionEventEnvelope,
  SessionListItem,
  ProjectRemoval,
} from "@codexlike/desktop/ipc";
import {
  hydrateLiveSession,
  receiveLiveEvent,
  type LiveSession,
} from "../lib/live-session";

import {
  evaluateContextWarning,
  resolveComposerSubmission,
  type ApprovalMode,
  type ProviderProfile,
  type ProjectRecord,
  type SessionResourcesView,
  type ThinkingEffort,
} from "@codexlike/agent-core";

import { AgentResourcesPanel } from "../components/AgentResourcesPanel";
import { ChangesPanel } from "../components/ChangesPanel";
import { FullAccessConfirmDialog } from "../components/FullAccessConfirmDialog";
import { MessageComposer } from "../components/MessageComposer";
import { MessageStream } from "../components/MessageStream";
import { SessionSidebar } from "../components/SessionSidebar";
import { SessionSearch } from "../components/SessionSearch";
import {
  MembershipDialog,
  ProjectRemovalDialog,
} from "../components/MembershipDialogs";
import { SESSION_CONTENT_WIDTH_CLASS } from "../lib/content-width";
import {
  appendLocalSegment,
  mergeInteractions,
  type MessageSegment,
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
  const [localState] = useState(() =>
    createWorkspaceState(
      typeof window === "undefined" ? undefined : window.codexlike.workbench
    )
  );
  const workspaceState = props.state ?? localState;
  useSyncExternalStore(
    workspaceState.subscribe,
    workspaceState.version,
    workspaceState.version
  );
  const loadingRef = useRef<{
    sessionId: string;
    generation: number;
    events: SessionEventEnvelope[];
  } | null>(null);
  const liveRef = useRef<LiveSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageSegment[]>([]);
  const [streaming, setStreaming] = useState(false);
  /** /compact 压缩进行中（不可重复触发、禁用输入） */
  const [compacting, setCompacting] = useState(false);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [recordsRevision, setRecordsRevision] = useState(0);
  const [membershipSession, setMembershipSession] =
    useState<SessionListItem | null>(null);
  const [removingProject, setRemovingProject] = useState<ProjectRecord | null>(
    null
  );
  const [draftProjectId, setDraftProjectId] = useState<
    string | null | undefined
  >(workspaceState.activeDraftProjectId);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const draft =
    draftProjectId === undefined
      ? null
      : workspaceState.newDraft(draftProjectId, profiles[0]?.id ?? "");
  const creating = draft?.busy ?? false;
  const preferences =
    currentId === null ? null : workspaceState.preferences(currentId);
  const selectedProfileId = preferences?.providerProfileId ?? "";
  const thinkingEffort = preferences?.thinkingEffort ?? "auto";
  function setSelectedProfileId(providerProfileId: string) {
    if (currentId !== null)
      workspaceState.setPreferences(currentId, { providerProfileId });
  }
  function setThinkingEffort(thinkingEffort: ThinkingEffort) {
    if (currentId !== null)
      workspaceState.setPreferences(currentId, { thinkingEffort });
  }
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
  /**
   * 强制回底信号（票 03 滚动跟随）：发送新 prompt 时递增，
   * MessageStream 收到后立即贴底并进入跟随态。
   */
  const [followSignal, setFollowSignal] = useState(0);
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
  // 新建、加载与已有会话始终使用同一档位；滚动条宽度由消息流实际测量。
  const contentWidthClass = SESSION_CONTENT_WIDTH_CLASS;
  const [scrollbarGutter, setScrollbarGutter] = useState(0);
  const contentPadding = {
    paddingRight: "calc(1rem + var(--session-scrollbar-gutter, 0px))",
  };

  const listRequestRef = useRef(0);
  const refreshSessions = useCallback(async () => {
    const request = ++listRequestRef.current;
    const list = await window.codexlike.sessions.list();
    if (listRequestRef.current === request) setSessions(list);
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
    setMessages((prev) =>
      appendLocalSegment(prev, { kind: "status", content })
    );
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
        events: [] as SessionEventEnvelope[],
      };
      loadingRef.current = buffer;
      const snapshotVersion = workspaceState.version();
      try {
        const [view] = await Promise.all([
          window.codexlike.sessions.view(id),
          workspaceState.loadSession(id),
        ]);
        if (!isCurrent()) return;
        if (!view) throw new Error("会话不存在或已损坏");
        const live = hydrateLiveSession(view, buffer.events);
        liveRef.current = live;
        workspaceState.reconcile(
          id,
          live.items.flatMap((item) =>
            item.kind === "interaction" ? [item.interaction] : []
          ),
          snapshotVersion
        );
        setMessages(live.items);
        setStreaming(live.activity.running);
        setCompacting(
          live.activity.running && live.activity.operation === "compact"
        );
        void window.codexlike.sessions
          .markViewed(id, live.sequence)
          .then(() => refreshSessions());
      } catch (error) {
        if (!isCurrent()) return;
        setMessages(
          appendLocalSegment([], {
            kind: "error",
            content: `读取会话失败：${error instanceof Error ? error.message : String(error)}`,
          })
        );
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
    [refreshContextWarning, refreshResources, refreshSessions, workspaceState]
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 冷启动一次性恢复：activeSessionId/activeDraftProjectId 取挂载时刻的持久化值，后续变化不得重新触发自动打开
  }, [openSession]);

  // 订阅会话事件流：只归并当前打开会话的消息，其余会话仅刷新侧栏状态
  useEffect(() => {
    return window.codexlike.onSessionEvent((envelope) => {
      const { sessionId, event } = envelope;
      if (sessionId === currentIdRef.current) {
        if (loadingRef.current?.sessionId === sessionId) {
          loadingRef.current.events.push(envelope);
        } else if (liveRef.current?.sessionId === sessionId) {
          const previous = liveRef.current;
          const live = receiveLiveEvent(previous, { ...envelope });
          if (live === previous) return;
          liveRef.current = live;
          if (event.type === "compact-finished") {
            workspaceState.reconcile(
              sessionId,
              live.items.flatMap((item) =>
                item.kind === "interaction" ? [item.interaction] : []
              ),
              workspaceState.version()
            );
          }
          // 本地 /status 反馈不属于宿主历史，接续时保留。
          setMessages((prev) => [
            ...live.items,
            ...prev.filter((item) => item.kind === "status"),
          ]);
          setStreaming(live.activity.running);
          setCompacting(
            live.activity.running && live.activity.operation === "compact"
          );
          if (!live.activity.running)
            void window.codexlike.sessions
              .markViewed(sessionId, live.sequence)
              .then(() => refreshSessions());
        }
        if (
          event.type === "assistant-start" ||
          event.type === "tool-result" ||
          (event.type === "subagent-tool" && event.phase === "result") ||
          event.type === "compact-finished" ||
          event.type === "assistant-done" ||
          event.type === "assistant-aborted" ||
          event.type === "error"
        ) {
          void refreshResources(sessionId);
        }
        if (
          event.type === "compact-finished" ||
          event.type === "assistant-done" ||
          event.type === "assistant-aborted" ||
          event.type === "error"
        ) {
          // 每轮回复结束（完成/中断/出错）后重估上下文告警
          void refreshContextWarning(sessionId);
        }
      }
      if (
        event.type === "user-message" ||
        event.type === "compact-start" ||
        event.type === "compact-finished" ||
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

  /** 入口只恢复该项目/独立入口草稿，不调用创建 IPC。 */
  async function startCreateSession(projectId: string | null = null) {
    const request = ++sessionRequestRef.current;
    setLoading(true);
    try {
      await workspaceState.flush();
      await workspaceState.loadNewDraft(projectId, profiles[0]?.id ?? "");
    } catch (error) {
      if (sessionRequestRef.current === request) {
        setLoading(false);
        pushLocalStatus(
          `恢复草稿失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
      return;
    }
    if (sessionRequestRef.current !== request) return;
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
      workspaceMode: draft.workspaceMode ?? "local",
      text,
      mentionPaths,
      providerProfileId: draft.providerProfileId || undefined,
      thinkingEffort: draft.thinkingEffort,
      approvalMode: draft.approvalMode,
    };
    workspaceState.editNewDraft(projectId, { busy: true, error: null });
    try {
      await workspaceState.flush();
      const record = await window.codexlike.sessions.start(request);
      await workspaceState.completeNewDraft(projectId);
      await refreshSessions();
      if (workspaceState.activeDraftProjectId === projectId) {
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
    const composerSnapshot = workspaceState.composer(currentId);
    try {
      await workspaceState.flush();
      await window.codexlike.sessions.send(
        currentId,
        text,
        selectedProfileId,
        mentionPaths.length === 0 ? undefined : mentionPaths,
        thinkingEffort,
        preferences?.approvalMode
      );
      if (workspaceState.composer(currentId) === composerSnapshot)
        workspaceState.setComposer(currentId, "");
    } catch (error) {
      // 启动失败（含显式技能解析/加载错误）：只在发起会话仍打开时提示。
      if (currentIdRef.current !== currentId) return;
      setStreaming(false);
      void refreshResources(currentId);
      setMessages((prev) =>
        appendLocalSegment(prev, {
          kind: "error",
          content: `发送失败：${error instanceof Error ? error.message : String(error)}`,
        })
      );
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

  /** 重命名按钮及命令共享记录刷新，已展开搜索不得保留旧标题。 */
  async function renameSession(id: string, title: string, announce = false) {
    const generation = sessionRequestRef.current;
    try {
      await window.codexlike.sessions.rename(id, title);
      setRecordsRevision((value) => value + 1);
      await refreshSessions();
      if (
        announce &&
        currentIdRef.current === id &&
        sessionRequestRef.current === generation
      )
        pushLocalStatus(`会话已重命名为「${title}」`);
    } catch (error) {
      pushLocalStatus(
        `重命名失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** 侧栏及 /archive 共用导航，异步返回不能抢走用户刚切换的会话。 */
  async function archiveSession(id: string, archived: boolean) {
    const generation = sessionRequestRef.current;
    try {
      await window.codexlike.sessions.archive(id, archived);
      setRecordsRevision((value) => value + 1);
      const list = await refreshSessions();
      if (
        currentIdRef.current !== id ||
        sessionRequestRef.current !== generation
      )
        return;
      if (archived) {
        const next = list.find((session) => session.archivedAt === null);
        if (next) await openSession(next.id);
        else startCreateSession();
      }
    } catch (error) {
      pushLocalStatus(
        `${archived ? "归档" : "恢复"}失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function projectRemoved(result: ProjectRemoval) {
    // 宿主已提交后立即清掉可发送目标与加载代数；迟到view不能恢复删除记录。
    const affected =
      result.sessionIds.includes(currentIdRef.current ?? "") ||
      workspaceState.activeDraftProjectId === result.projectId;
    workspaceState.removeProject(result.projectId, result.sessionIds);
    setProjects((previous) =>
      previous.filter((item) => item.id !== result.projectId)
    );
    setSessions((previous) =>
      previous.filter((item) => !result.sessionIds.includes(item.id))
    );
    setRecordsRevision((value) => value + 1);
    if (affected) {
      // 03恢复草稿是异步的：先同步断开删除目标，不能留着旧composer等待flush。
      sessionRequestRef.current += 1;
      resourceRequestRef.current += 1;
      currentIdRef.current = null;
      workspaceState.activeSessionId = null;
      workspaceState.activeDraftProjectId = undefined;
      setCurrentId(null);
      setDraftProjectId(undefined);
      loadingRef.current = null;
      liveRef.current = null;
      setMessages([]);
      setWorkspaceFiles([]);
      setResources(null);
      setStreaming(false);
      setLoading(false);
      setCompacting(false);
      setContextWarning(null);
      setFullAccessPending(false);
    }
    const generation = sessionRequestRef.current;
    try {
      const list = await refreshSessions();
      if (affected && sessionRequestRef.current === generation) {
        const next = list.find((session) => session.archivedAt === null);
        if (next) await openSession(next.id);
        else await startCreateSession();
      }
    } catch (error) {
      // 删除已提交，不能将后续列表读取失败误报成删除失败并让用户重复确认。
      pushLocalStatus(`项目记录已移除，刷新列表失败：${String(error)}`);
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
        // 只沿用显式管理归属，不从执行目录或 Worktree 来源派生项目。
        void startCreateSession(current?.projectId ?? draft?.projectId ?? null);
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
          // 历史与运行状态由同序号终态事件更新；IPC回包只提供本地命令反馈。
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
        await renameSession(current!.id, action.title, true);
        return;
      }
      case "rename-missing-argument":
        pushLocalStatus("用法：/rename 新名称");
        return;
      case "archive": {
        await archiveSession(current!.id, true);
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
      if (currentId !== null) workspaceState.setComposer(currentId, "");
      else if (draft)
        workspaceState.editNewDraft(draft.projectId, { text: "" });
      return;
    }
    // 发送新 prompt：强制回底并进入跟随（spec 用户故事 6，票 03）
    setFollowSignal((signal) => signal + 1);
    if (draft) void sendFirst(submission.text, submission.mentionPaths);
    else void send(submission.text, submission.mentionPaths);
  }

  /**
   * 审批模式切换：随时可切，只对下一次发送生效。
   * 切到「完全访问」先弹风险确认（ADR 0004：该档放开工作区文件边界）；
   * 取消不发起 IPC，选择器受控值自然回显原档位。
   */
  function selectApprovalMode(mode: ApprovalMode) {
    if (mode === "full-access") {
      if (
        (draft?.approvalMode ?? preferences?.approvalMode) !== "full-access"
      ) {
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
      workspaceState.setPreferences(currentId, { approvalMode: mode });
      await workspaceState.flush();
    } catch (error) {
      pushLocalStatus(
        `切换审批模式失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const composerHint =
    current?.archivedAt != null
      ? "已归档 · 历史只读，恢复会话后可继续发送"
      : profiles.length === 0
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
      {membershipSession && (
        <MembershipDialog
          key={membershipSession.id}
          session={membershipSession}
          projects={projects}
          onClose={() => setMembershipSession(null)}
          onChanged={async () => {
            setRecordsRevision((value) => value + 1);
            await refreshSessions();
          }}
        />
      )}
      {removingProject && (
        <ProjectRemovalDialog
          key={removingProject.id}
          project={removingProject}
          memberCount={
            sessions.filter(
              (session) => session.projectId === removingProject.id
            ).length
          }
          onClose={() => setRemovingProject(null)}
          onRemoved={projectRemoved}
        />
      )}
      <SessionSidebar
        projects={projects}
        onRemoveProject={(id) =>
          setRemovingProject(projects.find((item) => item.id === id) ?? null)
        }
        onAddProject={() => void addProject()}
        onCreateInProject={startCreateSession}
        sessions={sessions}
        currentId={currentId}
        onSelect={(id) => void openSession(id)}
        onCreate={() => void startCreateSession()}
        creating={creating}
        onRename={(id, title) => void renameSession(id, title)}
        onArchive={(id, archived) => void archiveSession(id, archived)}
        onMembership={(id) =>
          setMembershipSession(
            sessions.find((session) => session.id === id) ?? null
          )
        }
        onPin={(id, pinned) => {
          void window.codexlike.sessions
            .setPinned(id, pinned)
            .then(refreshSessions)
            .catch((error: unknown) =>
              pushLocalStatus(`置顶失败：${String(error)}`)
            );
        }}
        onCollapseProject={(id, collapsed) => {
          void window.codexlike.projects
            .setCollapsed(id, collapsed)
            .then(() => window.codexlike.projects.list())
            .then(setProjects)
            .catch((error: unknown) =>
              pushLocalStatus(`折叠失败：${String(error)}`)
            );
        }}
      />
      {/* 会话容器（票 05）：内容列宽度分档（@min-[864px]/session 等）以本栏为
          断点基准而非视口——侧栏开合改变本栏宽度时按档位分档响应，右侧
          （规范与技能 / 改动）面板是本容器内的兄弟节点，开合不改变容器宽度、
          不触发断点切换导致内容列跳宽 */}
      <section className="@container/session flex min-w-0 flex-1">
        <div
          className="flex min-w-0 flex-1 flex-col"
          style={
            {
              "--session-scrollbar-gutter": `${scrollbarGutter}px`,
            } as CSSProperties
          }
        >
          <header
            className="shrink-0 border-b border-line px-4 py-2"
            style={contentPadding}
          >
            {/* 头部内容与消息流、输入区共用同一内容列宽度类，左右缘对齐 */}
            <div
              data-testid="session-header-content"
              className={`${contentWidthClass} flex items-center gap-2`}
            >
              <span
                data-testid="session-title"
                className="min-w-0 flex-1 truncate text-sm font-semibold text-fg"
              >
                {current?.title ??
                  (draft
                    ? draft.projectId === null
                      ? "新建独立会话"
                      : `新建项目会话 · ${projects.find((p) => p.id === draft.projectId)?.name ?? "项目"}`
                    : "未选择会话")}
              </span>
              <div className="shrink-0 whitespace-nowrap">
                <SessionSearch
                  recordsRevision={recordsRevision}
                  onSelect={(id) => void openSession(id)}
                />
              </div>
              <button
                type="button"
                data-testid="resources-toggle"
                disabled={currentId === null}
                aria-expanded={resourcesOpen}
                onClick={() => {
                  if (!resourcesOpen) refreshCurrentResources();
                  setResourcesOpen((prev) => !prev);
                }}
                className="shrink-0 whitespace-nowrap rounded border border-line px-3 py-1 text-xs text-fg-muted hover:border-accent hover:text-accent disabled:opacity-50"
              >
                规范与技能
              </button>
              <button
                type="button"
                data-testid="changes-toggle"
                onClick={() => setChangesOpen((prev) => !prev)}
                disabled={currentId === null}
                className="shrink-0 whitespace-nowrap rounded border border-line px-3 py-1 text-xs text-fg-muted hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {changesOpen ? "收起改动" : "改动"}
              </button>
            </div>
          </header>
          {(current || draft) && (
            <div
              data-testid="workspace-info"
              className="shrink-0 border-b border-line px-4 py-2 text-xs text-fg-muted"
              style={contentPadding}
            >
              <div className={contentWidthClass}>
                <div
                  data-testid="workspace-path"
                  title={
                    current?.workspacePath ??
                    draft?.workspacePath ??
                    projects.find((p) => p.id === draft?.projectId)
                      ?.workspacePath
                  }
                  className="flex flex-wrap items-center gap-x-2 gap-y-1"
                >
                  <span className="min-w-0 break-all">
                    {draft?.workspaceMode === "worktree"
                      ? "来源目录（发送后使用隔离工作区）："
                      : "工作区："}
                    {current?.workspacePath ??
                      draft?.workspacePath ??
                      projects.find((p) => p.id === draft?.projectId)
                        ?.workspacePath ??
                      "应用专用持久目录（首次发送时分配）"}
                  </span>
                  {current && !draft && (
                    <span
                      data-testid="workspace-mode"
                      title="首次执行后工作区固定，调整项目归属不会改变目录、分支和历史；不代表文件只读或权限受限。"
                      className="shrink-0 rounded border border-line bg-surface px-2 py-0.5"
                    >
                      {current.workspaceMode === "worktree"
                        ? "Worktree"
                        : "本地"}
                    </span>
                  )}
                  {draft && draft.projectId !== null && (
                    <WorkspaceModeSelector
                      mode={draft.workspaceMode ?? "local"}
                      busy={creating}
                      onModeChange={(workspaceMode) => {
                        if (!draft.busy)
                          workspaceState.editNewDraft(draft.projectId, {
                            workspaceMode,
                            error: null,
                          });
                      }}
                    />
                  )}
                </div>
                {current?.workspaceOriginPath && (
                  <div data-testid="workspace-origin">
                    来源目录：{current.workspaceOriginPath}
                  </div>
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
            </div>
          )}
          {workspaceState.persistenceError() && (
            <p
              role="alert"
              data-testid="workbench-save-error"
              className="px-4 text-danger-fg"
            >
              工作现场保存失败：{workspaceState.persistenceError()}
            </p>
          )}
          {(draft?.providerProfileId ?? selectedProfileId) &&
            !profiles.some(
              (p) => p.id === (draft?.providerProfileId ?? selectedProfileId)
            ) && (
              <p
                role="alert"
                data-testid="unavailable-profile"
                className="px-4 text-danger-fg"
              >
                已保存的模型配置不可用，请重新选择模型；不会自动替换。
              </p>
            )}
          <MessageStream
            key={`stream-${currentId ?? `draft-${draftProjectId}`}`}
            sessionId={currentId}
            questionDraft={(requestId) =>
              currentId === null
                ? undefined
                : workspaceState.draft(currentId, requestId)
            }
            loading={loading}
            onScrollbarGutterChange={setScrollbarGutter}
            readingPosition={
              currentId === null
                ? null
                : workspaceState.readingPosition(currentId)
            }
            onReadingPosition={(position) => {
              if (currentId !== null)
                workspaceState.setReadingPosition(currentId, position);
            }}
            items={displayMessages}
            streaming={streaming}
            compacting={compacting}
            contentWidthClass={contentWidthClass}
            followSignal={followSignal}
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
          {(draft || current) && (
            <WorkspaceSharingNotice
              target={
                draft
                  ? {
                      projectId: draft.projectId,
                      workspacePath: draft.workspacePath,
                      workspaceMode: draft.workspaceMode ?? "local",
                    }
                  : { sessionId: current!.id }
              }
            />
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
              clearOnSend={false}
              profiles={profiles}
              selectedProfileId={draft?.providerProfileId ?? selectedProfileId}
              onSelectProfile={(id) =>
                draft
                  ? workspaceState.editNewDraft(draft.projectId, {
                      providerProfileId: id,
                    })
                  : setSelectedProfileId(id)
              }
              onSend={handleSubmit}
              contentWidthClass={contentWidthClass}
              workspaceFiles={workspaceFiles}
              skills={resources?.preview.catalog.skills}
              onOpenSkills={refreshCurrentResources}
              readOnly={loading || creating}
              disabled={
                (currentId === null && !draft) ||
                current?.archivedAt != null ||
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
                draft?.approvalMode ?? preferences?.approvalMode ?? null
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
        {currentId !== null && (resourcesOpen || changesOpen) && (
          // 面板共享限宽区域：同时打开时纵向排列，至少为主列保留六成宽度。
          // 在装配层覆盖面板原固定宽高，面板内部仍各自滚动、独立关闭。
          <div
            className={`flex min-h-0 max-w-[40%] shrink-0 flex-col [&>aside]:h-auto [&>aside]:min-h-0 [&>aside]:min-w-0 [&>aside]:w-full [&>aside]:flex-1 ${changesOpen ? "w-[30rem]" : "w-96"}`}
          >
            {resourcesOpen && (
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
        )}
      </section>
    </div>
  );
}
