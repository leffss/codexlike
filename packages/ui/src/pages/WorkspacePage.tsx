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
import { TaskAutoApproveStatus } from "../components/TaskAutoApproveStatus";
import {
  WorkspaceModeSelector,
  WorkspaceSharingNotice,
} from "../components/WorkspaceModeControl";
import type {
  QueuedMessage,
  QueueOperationResult,
  QueueSnapshot,
  TaskEventEnvelope,
  TaskListItem,
  ProjectRemoval,
} from "@codexlike/desktop/ipc";
import {
  EMPTY_QUEUE_STATE,
  hydrateLiveTask,
  receiveLiveEvent,
  type LiveTask,
} from "../lib/live-task";

import {
  evaluateContextWarning,
  resolveComposerSubmission,
  type ApprovalMode,
  type ProviderProfile,
  type ProjectRecord,
  type TaskResourcesView,
  type ThinkingEffort,
  type WorkbenchTarget,
} from "@codexlike/agent-core";

import { AgentResourcesPanel } from "../components/AgentResourcesPanel";
import { ChangesPanel } from "../components/ChangesPanel";
import { FullAccessConfirmDialog } from "../components/FullAccessConfirmDialog";
import { MessageComposer } from "../components/MessageComposer";
import { MessageStream } from "../components/MessageStream";
import { TaskSidebar } from "../components/TaskSidebar";
import { TaskSearch } from "../components/TaskSearch";
import {
  MembershipDialog,
  ProjectRemovalDialog,
} from "../components/MembershipDialogs";
import { TASK_CONTENT_WIDTH_CLASS } from "../lib/content-width";
import { reportLaunchState } from "../lib/launch-state";
import {
  appendLocalSegment,
  mergeInteractions,
  type MessageSegment,
} from "../lib/task-view";
import {
  formatTaskStatus,
  matchProfilesForModelSwitch,
  planSlashCommand,
} from "../lib/slash-command-actions";

/** 取回编辑任务（票 03）：目标条目 + 载入时原文（CAS）+ 进入编辑前的输入框草稿。 */
interface QueueEditTask {
  taskId: string;
  itemId: string;
  originalText: string;
  savedDraft: string;
}

/**
 * 主界面三栏装配：任务列表 / 消息流 / 输入框。
 * 任务与流式事件经 window.codexlike（类型化 IPC）与主进程交互；
 * 斜杠命令与 @引用 在发送前经解析层分发（工单 07）。
 */
export function WorkspacePage(props: {
  onOpenSettings: () => void;
  state?: WorkspaceState;
  /** 启动现场的工作台目标（票03）：冷启动恢复的第一优先级；缺省走现有回退链 */
  initialTarget?: WorkbenchTarget | null;
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
    taskId: string;
    generation: number;
    events: TaskEventEnvelope[];
  } | null>(null);
  const liveRef = useRef<LiveTask | null>(null);
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const revokingRef = useRef(new Set<string>());
  const [revokeErrors, setRevokeErrors] = useState<
    Record<string, string | null>
  >({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageSegment[]>([]);
  /**
   * 输入队列状态（票 01/02/03，review 重构收拢三元组）：排队条目 + 暂停标志 +
   * 正在发出条目单点持有；view 快照、事件接续与队列操作结果都整块应用。
   */
  const [queueState, setQueueState] =
    useState<QueueSnapshot>(EMPTY_QUEUE_STATE);
  /**
   * 取回编辑任务（票 03）：点击排队消息把内容载入输入框，保存原地更新。
   * originalText 为载入时的原文（主进程 CAS 校验）；savedDraft 为进入编辑前
   * 的输入框草稿，取消编辑或切走任务时还原，不丢用户文字。
   */
  const [queueEdit, setQueueEdit] = useState<QueueEditTask | null>(null);
  /** 编辑任务的即时读数：事件回调里不读过期的渲染帧状态 */
  const queueEditRef = useRef<QueueEditTask | null>(null);
  queueEditRef.current = queueEdit;
  const [streaming, setStreaming] = useState(false);
  /** /compact 压缩进行中（不可重复触发、禁用输入） */
  const [compacting, setCompacting] = useState(false);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [recordsRevision, setRecordsRevision] = useState(0);
  const [membershipTask, setMembershipTask] = useState<TaskListItem | null>(
    null
  );
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
  const [resources, setResources] = useState<TaskResourcesView | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const resourceRequestRef = useRef(0);
  const taskRequestRef = useRef(0);
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
  /** 启动现场的工作台目标（票03）：固定挂载时刻值，冷启动一次性恢复用 */
  const initialTargetRef = useRef<WorkbenchTarget | null>(
    props.initialTarget ?? null
  );

  currentIdRef.current = currentId;
  /** 当前任务记录（审批模式选择器 / 改动面板 / 顶栏共用；tasks 列表随事件刷新） */
  const current = tasks.find((task) => task.id === currentId) ?? null;
  const pending = currentId === null ? [] : workspaceState.pending(currentId);
  const interaction = pending[0];
  const displayMessages =
    currentId === null
      ? messages
      : mergeInteractions(messages, workspaceState.records(currentId));
  // 新建、加载与已有任务始终使用同一档位；滚动条宽度由消息流实际测量。
  const contentWidthClass = TASK_CONTENT_WIDTH_CLASS;
  const [scrollbarGutter, setScrollbarGutter] = useState(0);
  const contentPadding = {
    paddingRight: "calc(1rem + var(--task-scrollbar-gutter, 0px))",
  };

  const listRequestRef = useRef(0);
  const refreshTasks = useCallback(async () => {
    const request = ++listRequestRef.current;
    const list = await window.codexlike.tasks.list();
    if (listRequestRef.current === request) setTasks(list);
    return list;
  }, []);

  /**
   * 工作台目标上报启动现场（票03）：切换任务 / 进出新建草稿时即时落盘
   * （低频事件不防抖），重开回到退出前正在查看的目标；失败不阻塞界面。
   */
  const reportWorkbenchTarget = useCallback((target: WorkbenchTarget) => {
    reportLaunchState(
      window.codexlike.launchState.setWorkbenchTarget(target),
      "保存工作台目标现场失败"
    );
  }, []);

  async function revokeAutoApprove(id: string) {
    if (revokingRef.current.has(id)) return;
    revokingRef.current.add(id);
    setRevoking(new Set(revokingRef.current));
    setRevokeErrors((errors) => ({ ...errors, [id]: null }));
    try {
      const record = await window.codexlike.tasks.revokeAutoApprove(id);
      // 落盘成功才更新，按原任务标识归并，切换查看不会改错任务。
      listRequestRef.current += 1;
      setTasks((list) =>
        list.map((task) => (task.id === id ? { ...task, ...record } : task))
      );
      if (liveRef.current?.taskId === id)
        liveRef.current = {
          ...liveRef.current,
          autoApprove: record.autoApprove ?? false,
        };
    } catch (error) {
      setRevokeErrors((errors) => ({
        ...errors,
        [id]: `取消自动批准失败：${String(error)}`,
      }));
    } finally {
      revokingRef.current.delete(id);
      setRevoking(new Set(revokingRef.current));
    }
  }

  /** 最新请求胜出；同时校验任务与请求代数，防止 A→B→A 的旧结果串线。 */
  const refreshResources = useCallback(async (taskId: string) => {
    const request = ++resourceRequestRef.current;
    const isCurrent = () =>
      currentIdRef.current === taskId && resourceRequestRef.current === request;
    setResourcesLoading(true);
    setResourcesError(null);
    try {
      const view = await window.codexlike.tasks.resources(taskId);
      if (!isCurrent()) return;
      setResources(view);
      if (view === null) setResourcesError("任务资源不可用");
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
  const refreshContextWarning = useCallback(async (taskId: string) => {
    const taskRequest = taskRequestRef.current;
    const isCurrent = () =>
      currentIdRef.current === taskId && taskRequestRef.current === taskRequest;
    try {
      const status = await window.codexlike.tasks.status(taskId);
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

  const openTask = useCallback(
    async (id: string) => {
      reportWorkbenchTarget({ kind: "task", taskId: id });
      setDraftProjectId(undefined);
      workspaceState.activeDraftProjectId = undefined;
      // 编辑中的排队消息随任务归属：切走先还原该任务的输入框草稿，不丢文字（票 03）
      const editing = queueEditRef.current;
      if (editing !== null && editing.taskId !== id)
        workspaceState.setComposer(editing.taskId, editing.savedDraft);
      setQueueEdit(null);
      setCurrentId(id);
      workspaceState.activeTaskId = id;
      currentIdRef.current = id;
      const request = ++taskRequestRef.current;
      const isCurrent = () =>
        currentIdRef.current === id && taskRequestRef.current === request;
      setMessages([]);
      setQueueState(EMPTY_QUEUE_STATE);
      setWorkspaceFiles([]);
      setResources(null);
      setContextWarning(null);
      setCompacting(false);
      setFullAccessPending(false);
      void refreshResources(id);
      setLoading(true);
      setStreaming(false);
      const buffer = {
        taskId: id,
        generation: request,
        events: [] as TaskEventEnvelope[],
      };
      loadingRef.current = buffer;
      const snapshotVersion = workspaceState.version();
      try {
        const [view] = await Promise.all([
          window.codexlike.tasks.view(id),
          workspaceState.loadTask(id),
        ]);
        if (!isCurrent()) return;
        if (!view) throw new Error("任务不存在或已损坏");
        const live = hydrateLiveTask(view, buffer.events);
        liveRef.current = live;
        setTasks((list) =>
          list.map((task) =>
            task.id === id ? { ...task, autoApprove: live.autoApprove } : task
          )
        );
        workspaceState.reconcile(
          id,
          live.items.flatMap((item) =>
            item.kind === "interaction" ? [item.interaction] : []
          ),
          snapshotVersion
        );
        setMessages(live.items);
        setQueueState(live.queueState);
        setStreaming(live.activity.running);
        setCompacting(
          live.activity.running && live.activity.operation === "compact"
        );
        void window.codexlike.tasks
          .markViewed(id, live.sequence)
          .then(() => refreshTasks());
      } catch (error) {
        if (!isCurrent()) return;
        setMessages(
          appendLocalSegment([], {
            kind: "error",
            content: `读取任务失败：${error instanceof Error ? error.message : String(error)}`,
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
      // @引用 菜单候选：随任务（工作区）切换重新枚举
      try {
        const files = await window.codexlike.tasks.workspaceFiles(id);
        if (isCurrent()) setWorkspaceFiles(files);
      } catch {
        if (isCurrent()) setWorkspaceFiles([]);
      }
    },
    [
      refreshContextWarning,
      refreshResources,
      refreshTasks,
      reportWorkbenchTarget,
      workspaceState,
    ]
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      const [list, profileList, projectList] = await Promise.all([
        window.codexlike.tasks.list(),
        window.codexlike.providerProfiles.list(),
        window.codexlike.projects.list(),
      ]);
      if (active) setProjects(projectList);
      if (!active) return;
      setTasks(list);
      setProfiles(profileList);
      // 冷启动恢复（票03）：第一优先级取启动现场的工作台目标——记住的任务
      // （归档照常恢复）或新建草稿入口（连同项目关联，草稿文本由 workbench_state
      // 既有机制恢复）。项目已删除的草稿目标视为失效，走回退链。
      // 真冷启动守卫（对照下方回退链守卫的语义）：只在无已打开任务、无草稿时
      // 恢复并上报。currentIdRef 在重挂后恒为 null（组件级），故「无已打开任务」
      // 由 App 级 workspaceState.activeTaskId 承载——切设置页卸载本页后重挂
      // 时它仍是用户最后查看的任务，不得以挂载时刻固化的启动目标抢占，否则
      // 拉回旧任务并把它重新写回启动现场。
      const target = initialTargetRef.current;
      const coldStart =
        workspaceState.activeTaskId === null &&
        workspaceState.activeDraftProjectId === undefined;
      if (coldStart && target?.kind === "task") {
        const remembered = list.find((task) => task.id === target.taskId);
        if (remembered !== undefined) {
          await openTask(remembered.id);
          return;
        }
      } else if (coldStart && target?.kind === "new") {
        const projectId = target.projectId;
        if (
          projectId === null ||
          projectList.some((project) => project.id === projectId)
        ) {
          await startCreateTask(projectId);
          return;
        }
      }
      // 回退链（现状不变）：内存活动任务 → 排序最前的未归档任务；都没有则停在新建草稿入口
      const latest =
        list.find((task) => task.id === workspaceState.activeTaskId) ??
        list.find((task) => task.archivedAt === null);
      if (
        latest !== undefined &&
        currentIdRef.current === null &&
        workspaceState.activeDraftProjectId === undefined
      ) {
        await openTask(latest.id);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 冷启动一次性恢复：initialTarget/activeTaskId/activeDraftProjectId 取挂载时刻的持久化值，后续变化不得重新触发自动打开
  }, [openTask]);

  // 订阅任务事件流：只归并当前打开任务的消息，其余任务仅刷新侧栏状态
  useEffect(() => {
    return window.codexlike.onTaskEvent((envelope) => {
      const { taskId, event } = envelope;
      if (taskId === currentIdRef.current) {
        if (loadingRef.current?.taskId === taskId) {
          loadingRef.current.events.push(envelope);
        } else if (liveRef.current?.taskId === taskId) {
          const previous = liveRef.current;
          const live = receiveLiveEvent(previous, { ...envelope });
          if (live === previous) return;
          liveRef.current = live;
          if (event.type === "compact-finished") {
            workspaceState.reconcile(
              taskId,
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
          setQueueState(live.queueState);
          setStreaming(live.activity.running);
          setCompacting(
            live.activity.running && live.activity.operation === "compact"
          );
          if (!live.activity.running)
            void window.codexlike.tasks
              .markViewed(taskId, live.sequence)
              .then(() => refreshTasks());
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
          void refreshResources(taskId);
        }
        if (
          event.type === "compact-finished" ||
          event.type === "assistant-done" ||
          event.type === "assistant-aborted" ||
          event.type === "error"
        ) {
          // 每轮回复结束（完成/中断/出错）后重估上下文告警
          void refreshContextWarning(taskId);
        }
      }
      if (event.type === "task-auto-approve-changed") {
        // 废弃事件之前发起的列表查询，避免旧快照覆盖已持久化的授权状态。
        listRequestRef.current += 1;
        setTasks((list) =>
          list.map((task) =>
            task.id === taskId
              ? { ...task, autoApprove: event.autoApprove }
              : task
          )
        );
      }
      if (
        event.type === "user-message" ||
        event.type === "task-auto-approve-changed" ||
        event.type === "compact-start" ||
        event.type === "compact-finished" ||
        event.type === "assistant-done" ||
        event.type === "assistant-aborted" ||
        event.type === "error" ||
        event.type === "interaction-request" ||
        event.type === "interaction-resolved"
      ) {
        // 审批事件也驱动侧栏状态徽标（运行中 ↔ 等待审批）
        void refreshTasks();
      }
    });
  }, [refreshTasks, refreshContextWarning, refreshResources, workspaceState]);

  useEffect(
    () => () => {
      // 页面卸载后的迟到加载不能写回新工作台页面。
      taskRequestRef.current += 1;
      resourceRequestRef.current += 1;
      currentIdRef.current = null;
    },
    []
  );

  /** 入口只恢复该项目/独立入口草稿，不调用创建 IPC。 */
  async function startCreateTask(projectId: string | null = null) {
    const request = ++taskRequestRef.current;
    setLoading(true);
    try {
      await workspaceState.flush();
      await workspaceState.loadNewDraft(projectId, profiles[0]?.id ?? "");
    } catch (error) {
      if (taskRequestRef.current === request) {
        setLoading(false);
        pushLocalStatus(
          `恢复草稿失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
      return;
    }
    if (taskRequestRef.current !== request) return;
    // 进入新建草稿也更新启动现场（票03）：重开回到同一草稿状态（含项目关联）
    reportWorkbenchTarget({ kind: "new", projectId });
    workspaceState.activeDraftProjectId = projectId;
    workspaceState.activeTaskId = null;
    setDraftProjectId(projectId);
    setCurrentId(null);
    currentIdRef.current = null;
    taskRequestRef.current += 1;
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
      const path = await window.codexlike.tasks.selectWorkspace();
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
    const path = await window.codexlike.tasks.selectWorkspace();
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
      const record = await window.codexlike.tasks.start(request);
      await workspaceState.completeNewDraft(projectId);
      await refreshTasks();
      if (workspaceState.activeDraftProjectId === projectId) {
        await openTask(record.id);
      }
    } catch (error) {
      workspaceState.editNewDraft(projectId, {
        busy: false,
        error: `创建失败，可重试：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function send(text: string, mentionPaths: string[]) {
    // 回复进行中不再拦截（票 01 输入队列）：主进程忙时入队、空闲时直接发送；
    // 等待用户交互（pending）期间仍禁用（spec 用户故事 17）。
    if (
      currentId === null ||
      selectedProfileId === "" ||
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
      await window.codexlike.tasks.send(
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
      // 启动失败（含显式技能解析/加载错误）：只在发起任务仍打开时提示。
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

  /** 停止按钮：打断当前任务运行中的本轮（流式输出中断 / 工具子进程终止）。
   *  中断结果经事件流（assistant-aborted / tool-result）回流，streaming 状态随之复位。
   *  排队消息存在时队列进入暂停（票 02），队列条显示恢复/清空操作。 */
  async function stop() {
    if (currentId === null) {
      return;
    }
    try {
      await window.codexlike.tasks.interrupt(currentId);
    } catch (error) {
      pushLocalStatus(
        `停止失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 队列操作共享包装（review 重构）：守卫任务在场 → 调用 IPC → 整块应用
   * 返回的队列快照 → 失败以中文提示。恢复/清空/删除/重排共用；
   * 后续队列变更经事件流接续，操作结果快照先行落到本地状态。
   */
  async function runQueueOperation(
    failure: string,
    invoke: (taskId: string) => Promise<QueueOperationResult>
  ) {
    const taskId = currentId;
    if (taskId === null) return;
    try {
      setQueueState(await invoke(taskId));
    } catch (error) {
      pushLocalStatus(
        `${failure}：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** 队列暂停手动恢复（票 02）：清暂停标志并立即从队首继续逐条消费。 */
  function resumeQueue() {
    return runQueueOperation("恢复队列失败", (taskId) =>
      window.codexlike.tasks.queueResume(taskId)
    );
  }

  /** 队列清空（票 02）：作废全部排队消息并清暂停标志，队列条消失。 */
  function clearQueue() {
    return runQueueOperation("清空队列失败", (taskId) =>
      window.codexlike.tasks.queueClear(taskId)
    );
  }

  /** 删除单条排队消息（票 03）：立即作废，不会被消费。 */
  function removeQueueItem(itemId: string) {
    return runQueueOperation("删除排队消息失败", (taskId) =>
      window.codexlike.tasks.queueRemove(taskId, itemId)
    );
  }

  /** 拖拽重排（票 03）：提交仍在排队条目的完整新顺序，顺序即时生效并持久化。 */
  function reorderQueue(orderedIds: string[]) {
    return runQueueOperation("调整发送顺序失败", (taskId) =>
      window.codexlike.tasks.queueReorder(taskId, orderedIds)
    );
  }

  /** 点击排队消息取回编辑（票 03）：内容载入输入框；正在发出的条目锁定不可编辑。 */
  function startQueueItemEdit(item: QueuedMessage) {
    if (currentId === null || item.taskId !== currentId) return;
    if (item.id === queueState.sendingId) return;
    const editing = queueEditRef.current;
    // 切换编辑目标时沿用最早保存的草稿（当前输入框已是另一条排队内容）
    const savedDraft =
      editing?.taskId === currentId
        ? editing.savedDraft
        : workspaceState.composer(currentId);
    setQueueEdit({
      taskId: currentId,
      itemId: item.id,
      originalText: item.text,
      savedDraft,
    });
    workspaceState.setComposer(currentId, item.text);
  }

  /** 取消编辑（票 03）：条目原样保留，输入框还原进入编辑前的草稿。 */
  function cancelQueueEdit() {
    const editing = queueEditRef.current;
    if (editing === null) return;
    setQueueEdit(null);
    if (currentIdRef.current === editing.taskId)
      workspaceState.setComposer(editing.taskId, editing.savedDraft);
  }

  /**
   * 保存编辑（票 03）：原地更新该条，顺序与参数快照不变。
   * 主进程按载入原文 CAS 校验：条目已被其他窗口修改或已取出发送则拒绝，
   * 此时编辑文本保留在输入框（不无声丢失，由用户决定下一步）。
   */
  async function saveQueueEdit(text: string, mentionPaths: string[]) {
    const editing = queueEditRef.current;
    if (editing === null) return;
    const { taskId, itemId, originalText } = editing;
    const composerSnapshot = workspaceState.composer(taskId);
    try {
      const result = await window.codexlike.tasks.queueUpdate(
        taskId,
        itemId,
        text,
        originalText,
        mentionPaths.length === 0 ? undefined : mentionPaths
      );
      if (currentIdRef.current === taskId) setQueueState(result);
      setQueueEdit(null);
      if (workspaceState.composer(taskId) === composerSnapshot)
        workspaceState.setComposer(taskId, "");
    } catch (error) {
      // 保存被拒：编辑任务结束，文本留在输入框，用户可重新取回或直接发送
      setQueueEdit(null);
      if (currentIdRef.current === taskId)
        pushLocalStatus(
          `保存排队消息失败：${error instanceof Error ? error.message : String(error)}（输入已保留）`
        );
    }
  }

  // 编辑目标被消费/移除/他窗口操作时结束编辑任务：文本保留在输入框（票 03）
  useEffect(() => {
    if (queueEdit === null || loading) return;
    if (currentId === null || queueEdit.taskId !== currentId) return;
    const item = queueState.queue.find(
      (entry) => entry.id === queueEdit.itemId
    );
    if (item === undefined) {
      setQueueEdit(null);
      pushLocalStatus(
        "编辑的排队消息已发出或被移除：编辑未保存，文本保留在输入框"
      );
      return;
    }
    if (item.id === queueState.sendingId) {
      setQueueEdit(null);
      pushLocalStatus("编辑的排队消息已开始发送：编辑未保存，文本保留在输入框");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pushLocalStatus 为稳定 useCallback
  }, [queueState, queueEdit, currentId, loading]);

  /** 重命名按钮及命令共享记录刷新，已展开搜索不得保留旧标题。 */
  async function renameTask(id: string, title: string, announce = false) {
    const generation = taskRequestRef.current;
    try {
      await window.codexlike.tasks.rename(id, title);
      setRecordsRevision((value) => value + 1);
      await refreshTasks();
      if (
        announce &&
        currentIdRef.current === id &&
        taskRequestRef.current === generation
      )
        pushLocalStatus(`任务已重命名为「${title}」`);
    } catch (error) {
      pushLocalStatus(
        `重命名失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** 侧栏及 /archive 共用导航，异步返回不能抢走用户刚切换的任务。 */
  async function archiveTask(id: string, archived: boolean) {
    const generation = taskRequestRef.current;
    try {
      await window.codexlike.tasks.archive(id, archived);
      setRecordsRevision((value) => value + 1);
      const list = await refreshTasks();
      if (currentIdRef.current !== id || taskRequestRef.current !== generation)
        return;
      if (archived) {
        const next = list.find((task) => task.archivedAt === null);
        if (next) await openTask(next.id);
        else startCreateTask();
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
      result.taskIds.includes(currentIdRef.current ?? "") ||
      workspaceState.activeDraftProjectId === result.projectId;
    workspaceState.removeProject(result.projectId, result.taskIds);
    setProjects((previous) =>
      previous.filter((item) => item.id !== result.projectId)
    );
    setTasks((previous) =>
      previous.filter((item) => !result.taskIds.includes(item.id))
    );
    setRecordsRevision((value) => value + 1);
    if (affected) {
      // 03恢复草稿是异步的：先同步断开删除目标，不能留着旧composer等待flush。
      taskRequestRef.current += 1;
      resourceRequestRef.current += 1;
      currentIdRef.current = null;
      workspaceState.activeTaskId = null;
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
    const generation = taskRequestRef.current;
    try {
      const list = await refreshTasks();
      if (affected && taskRequestRef.current === generation) {
        const next = list.find((task) => task.archivedAt === null);
        if (next) await openTask(next.id);
        else await startCreateTask();
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
      case "needs-task":
        pushLocalStatus("该命令需要先选择一个任务");
        return;
      case "new-task": {
        // 只沿用显式管理归属，不从执行目录或 Worktree 来源派生项目。
        void startCreateTask(current?.projectId ?? draft?.projectId ?? null);
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
        const compactTaskId = current!.id;
        const compactGeneration = taskRequestRef.current;
        const compactIsCurrent = () =>
          currentIdRef.current === compactTaskId &&
          taskRequestRef.current === compactGeneration;
        setCompacting(true);
        try {
          const result = await window.codexlike.tasks.compact(
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
        await renameTask(current!.id, action.title, true);
        return;
      }
      case "rename-missing-argument":
        pushLocalStatus("用法：/rename 新名称");
        return;
      case "archive": {
        await archiveTask(current!.id, true);
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
        const taskId = current!.id;
        const request = taskRequestRef.current;
        try {
          const status = await window.codexlike.tasks.status(taskId);
          if (
            currentIdRef.current !== taskId ||
            taskRequestRef.current !== request
          )
            return;
          if (status === null) {
            pushLocalStatus("任务不存在或已损坏");
          } else {
            pushLocalStatus(formatTaskStatus(status));
          }
        } catch (error) {
          if (
            currentIdRef.current !== taskId ||
            taskRequestRef.current !== request
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
    // 取回编辑优先（票 03）：编辑中的提交是原地更新该条，不是新消息/入队
    const editing = queueEditRef.current;
    if (editing !== null && editing.taskId === currentId) {
      if (submission.kind === "slash-command") {
        pushLocalStatus("编辑中的排队消息不能是命令（输入已保留）");
        return;
      }
      void saveQueueEdit(submission.text, submission.mentionPaths);
      return;
    }
    if (submission.kind === "slash-command") {
      // 忙时命令不入队不执行（spec 用户故事 16，票 05）：命令在错误的时机被
      // 延迟执行没有意义；提示后保留输入，回复结束后原样重发即可执行。
      if (streaming) {
        pushLocalStatus(
          `命令 /${submission.name} 不入队：回复结束后可用（输入已保留）`
        );
        return;
      }
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
      ? "已归档 · 历史只读，恢复任务后可继续发送"
      : profiles.length === 0
        ? "尚未配置模型，请先前往设置页添加模型"
        : compacting
          ? "正在压缩历史，请稍候…"
          : currentId === null && !draft
            ? "新建或选择一个任务后开始对话"
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
      {membershipTask && (
        <MembershipDialog
          key={membershipTask.id}
          task={membershipTask}
          projects={projects}
          onClose={() => setMembershipTask(null)}
          onChanged={async () => {
            setRecordsRevision((value) => value + 1);
            await refreshTasks();
          }}
        />
      )}
      {removingProject && (
        <ProjectRemovalDialog
          key={removingProject.id}
          project={removingProject}
          memberCount={
            tasks.filter((task) => task.projectId === removingProject.id).length
          }
          onClose={() => setRemovingProject(null)}
          onRemoved={projectRemoved}
        />
      )}
      <TaskSidebar
        projects={projects}
        onRemoveProject={(id) =>
          setRemovingProject(projects.find((item) => item.id === id) ?? null)
        }
        onAddProject={() => void addProject()}
        onCreateInProject={startCreateTask}
        tasks={tasks}
        currentId={currentId}
        onSelect={(id) => void openTask(id)}
        onCreate={() => void startCreateTask()}
        creating={creating}
        onRename={(id, title) => void renameTask(id, title)}
        onArchive={(id, archived) => void archiveTask(id, archived)}
        onMembership={(id) =>
          setMembershipTask(tasks.find((task) => task.id === id) ?? null)
        }
        onPin={(id, pinned) => {
          void window.codexlike.tasks
            .setPinned(id, pinned)
            .then(refreshTasks)
            .catch((error: unknown) =>
              pushLocalStatus(`置顶失败：${String(error)}`)
            );
        }}
        onPinProject={(id, pinned) => {
          void window.codexlike.projects
            .setPinned(id, pinned)
            .then(() => window.codexlike.projects.list())
            .then(setProjects)
            .catch((error: unknown) =>
              pushLocalStatus(`项目置顶失败：${String(error)}`)
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
      {/* 任务容器（票 05）：内容列宽度分档（@min-[864px]/task 等）以本栏为
          断点基准而非视口——侧栏开合改变本栏宽度时按档位分档响应，右侧
          （规范与技能 / 改动）面板是本容器内的兄弟节点，开合不改变容器宽度、
          不触发断点切换导致内容列跳宽 */}
      <section className="@container/task flex min-w-0 flex-1">
        <div
          className="flex min-w-0 flex-1 flex-col"
          style={
            {
              "--task-scrollbar-gutter": `${scrollbarGutter}px`,
            } as CSSProperties
          }
        >
          <header
            className="shrink-0 border-b border-line px-4 py-2"
            style={contentPadding}
          >
            {/* 头部内容与消息流、输入区共用同一内容列宽度类，左右缘对齐 */}
            <div
              data-testid="task-header-content"
              className={`${contentWidthClass} flex items-center gap-2`}
            >
              <span
                data-testid="task-title"
                className="min-w-0 flex-1 truncate text-sm font-semibold text-fg"
              >
                {current?.title ??
                  (draft
                    ? draft.projectId === null
                      ? "新建独立任务"
                      : `新建项目任务 · ${projects.find((p) => p.id === draft.projectId)?.name ?? "项目"}`
                    : "未选择任务")}
              </span>
              <div className="shrink-0 whitespace-nowrap">
                <TaskSearch
                  recordsRevision={recordsRevision}
                  onSelect={(id) => void openTask(id)}
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
            taskId={currentId}
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
                  前往设置配置模型
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
                  : { taskId: current!.id }
              }
            />
          )}
          {current && (
            <TaskAutoApproveStatus
              autoApprove={current.autoApprove ?? false}
              busy={revoking.has(current.id)}
              error={revokeErrors[current.id] ?? null}
              onRevoke={() => void revokeAutoApprove(current.id)}
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
                  (taskId, requestId, payload) =>
                    window.codexlike.tasks.respondInteraction(
                      taskId,
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
                // streaming 不再禁用（票 01 输入队列）：忙时 Enter 直接入队；
                // 等待用户交互（pending）期间维持禁用（spec 用户故事 17）。
                compacting ||
                loading ||
                pending.length > 0
              }
              streaming={streaming}
              queueState={currentId === null ? EMPTY_QUEUE_STATE : queueState}
              queueEditingItemId={
                queueEdit !== null && queueEdit.taskId === currentId
                  ? queueEdit.itemId
                  : null
              }
              onQueueResume={() => void resumeQueue()}
              onQueueClear={() => void clearQueue()}
              onQueueRemove={(itemId) => void removeQueueItem(itemId)}
              onQueueEditItem={startQueueItemEdit}
              onQueueReorder={(orderedIds) => void reorderQueue(orderedIds)}
              onQueueCancelEdit={cancelQueueEdit}
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
                taskId={current.id}
                taskTitle={current.title}
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
