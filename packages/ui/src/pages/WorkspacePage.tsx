import {
  useCallback,
  useEffect,
  useMemo,
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
import { ToastHost } from "../components/ToastHost";
import { WorkspaceModeSelector } from "../components/WorkspaceModeSelector";
import {
  createToastManager,
  type ToastContent,
  type ToastManager,
} from "../lib/toast-state";
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
import { ChangesChip } from "../components/ChangesChip";
import { ChangesPanel } from "../components/ChangesPanel";
import { PanelsDrawer, type DrawerTab } from "../components/PanelsDrawer";
import { FullAccessConfirmDialog } from "../components/FullAccessConfirmDialog";
import { MessageComposer } from "../components/MessageComposer";
import { MessageStream } from "../components/MessageStream";
import {
  type TitlebarContext,
  type TitlebarTask,
} from "../components/TitlebarTaskContext";
import { TaskSidebar } from "../components/TaskSidebar";
import {
  MembershipDialog,
  ProjectRemovalDialog,
} from "../components/MembershipDialogs";
import { TASK_CONTENT_WIDTH_CLASS } from "../lib/content-width";
import { reportLaunchState } from "../lib/launch-state";
import { useWorkspaceSharing } from "../lib/workspace-sharing";
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

/**
 * 提示状态同步一元（审查修复 5 抽取）：五类原常驻横条（票02）的
 * 「状态在 → toast 幂等 upsert；状态消失 → retract 无条件撤除」同构走此入口，
 * content 为 null 即撤除。dismissed 记录与内容变化语义由 toast-state 承担。
 */
function syncToast(
  toastState: ToastManager,
  id: string,
  content: ToastContent | null
) {
  if (content) toastState.show(id, content);
  else toastState.retract(id);
}

/** 取回编辑任务（票 03）：目标条目 + 载入时原文（CAS）+ 进入编辑前的输入框草稿。 */
interface QueueEditTask {
  taskId: string;
  itemId: string;
  originalText: string;
  savedDraft: string;
}

/**
 * 运行起始时刻的恢复推导（消息流底部「运行中」工时的记账基准）：
 * 取最后一条用户消息段的 at（轮次起点）；无用户段或缺时间数据退回当前时刻。
 * 本地发送走直接记账（发送瞬间用户段尚未回流），本函数只服务重启/切回恢复
 * 与事件接续两条路径。
 */
function deriveRunStartedAt(items: MessageSegment[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "user" && item.at !== undefined) return item.at;
  }
  return Date.now();
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
  /** 标题栏任务上下文上报（票01）：任务/搜索/面板开关交由 App 的 Header 装配 */
  onTitlebarContext?: (context: TitlebarContext) => void;
}) {
  const [localState] = useState(() =>
    createWorkspaceState(
      typeof window === "undefined" ? undefined : window.codexlike.workbench
    )
  );
  const workspaceState = props.state ?? localState;
  /** 标题栏上下文上报（票01）：解构以稳定 effect 依赖 */
  const { onTitlebarContext } = props;
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
  /**
   * 当前运行起始时刻（epoch ms）：与 streaming 成对记账——本地发送记当下；
   * 重启/切回恢复与事件接续取最后一条用户消息段的 at；离开执行态清空。
   * 等待用户交互期间宿主 running 保持 true，工时含等待段（与轮次工时口径一致）。
   */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
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
  /**
   * 右栏 overlay 抽屉（票03）：两面板收进同一浮层，状态为「当前 tab 或关」。
   * 入口：标题栏「规范与技能」图标开关（resources tab）与消息区右上角的
   * 改动摘要胶囊（changes tab），各自经 aria-expanded 与抽屉状态同步。
   */
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [resources, setResources] = useState<TaskResourcesView | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const resourceRequestRef = useRef(0);
  const taskRequestRef = useRef(0);
  /** 切换到「完全访问」的风险确认弹窗打开中（ADR 0004） */
  const [fullAccessPending, setFullAccessPending] = useState(false);
  /**
   * toast 管理器（票02）：渲染层内存态，不持久化。五类原常驻横条
   * （保存失败 / 模型配置不可用 / 上下文告警 / 工作区共享 / 自动批准状态）
   * 统一经状态同步 effect 推送到右下角浮层。
   */
  const [toastState] = useState<ToastManager>(() => createToastManager());
  useSyncExternalStore(
    toastState.subscribe,
    toastState.version,
    toastState.version
  );
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

  /**
   * 抽屉状态动作（票03）：标题栏两开关与抽屉 tab 头共用同一状态源。
   * 打开/切到「规范与技能」页即刷新资源（与原「开面板即刷新」语义一致；
   * 「改动」面板挂载时自刷新）；动作经稳定引用上报，读取走 ref 防过期闭包。
   */
  const drawerRef = useRef<DrawerTab | null>(null);
  drawerRef.current = drawer;
  const openDrawer = useCallback(
    (tab: DrawerTab) => {
      if (tab === "resources") refreshCurrentResources();
      setDrawer(tab);
    },
    [refreshCurrentResources]
  );
  const toggleResources = useCallback(() => {
    if (drawerRef.current === "resources") setDrawer(null);
    else openDrawer("resources");
  }, [openDrawer]);
  const toggleChanges = useCallback(() => {
    if (drawerRef.current === "changes") setDrawer(null);
    else openDrawer("changes");
  }, [openDrawer]);
  const closeDrawer = useCallback(() => setDrawer(null), []);

  /**
   * 改动摘要胶囊刷新信号：一轮回答结束（streaming 真转假）与面板抽屉
   * 关闭（含提交后关闭）时递增，驱动胶囊重新读取 git 状态；任务切换
   * 由胶囊自身按 taskId 刷新。
   */
  const [changesRevision, setChangesRevision] = useState(0);
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !streaming)
      setChangesRevision((v) => v + 1);
    prevStreamingRef.current = streaming;
  }, [streaming]);
  const prevDrawerRef = useRef<DrawerTab | null>(null);
  useEffect(() => {
    if (prevDrawerRef.current !== null && drawer === null)
      setChangesRevision((v) => v + 1);
    prevDrawerRef.current = drawer;
  }, [drawer]);

  /** 本地命令反馈（/status、/rename 结果等）：不落库、不进模型上下文 */
  const pushLocalStatus = useCallback((content: string) => {
    setMessages((prev) =>
      appendLocalSegment(prev, { kind: "status", content })
    );
  }, []);

  /**
   * 上下文告警刷新（code review 修复 2，spec 验收场景 4）：
   * 以 /status 的 token 估算对照模型上下文窗口（Profile 可配，默认 128k）× 80%，
   * 超阈值以 toast 常驻右下角（票02；/compact 后重估自然消失）；查询失败静默不打扰。
   */
  const refreshContextWarning = useCallback(
    async (taskId: string) => {
      const taskRequest = taskRequestRef.current;
      const isCurrent = () =>
        currentIdRef.current === taskId &&
        taskRequestRef.current === taskRequest;
      try {
        const status = await window.codexlike.tasks.status(taskId);
        if (!isCurrent()) return;
        const message =
          status === null
            ? null
            : (evaluateContextWarning(
                status.estimatedContextTokens,
                status.contextWindowTokens ?? undefined
              )?.message ?? null);
        syncToast(
          toastState,
          "context-warning",
          message ? { kind: "warn", content: message } : null
        );
      } catch {
        if (isCurrent()) toastState.retract("context-warning");
      }
    },
    [toastState]
  );

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
      toastState.retract("context-warning");
      setCompacting(false);
      setFullAccessPending(false);
      void refreshResources(id);
      setLoading(true);
      setStreaming(false);
      setRunStartedAt(null);
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
        // 运行中恢复：从消息段重推运行起点（轮次起点），工时不因重开清零
        setRunStartedAt(
          live.activity.running ? deriveRunStartedAt(live.items) : null
        );
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
      toastState,
    ]
  );

  /** 任务搜索迁入标题栏（票01）：切换任务的入口保持同一 openTask 管线 */
  const selectTask = useCallback((id: string) => void openTask(id), [openTask]);

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
          // 连续运行（排队续发、工具间隙事件）保留先记账的起点——整段运行
          // 连续计时；本地未记账的运行中接续（prev 为空）才从消息段重推
          setRunStartedAt((prev) =>
            live.activity.running
              ? (prev ?? deriveRunStartedAt(live.items))
              : null
          );
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
    setRunStartedAt(null);
    setCompacting(false);
    toastState.retract("context-warning");
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
    // 运行起点记账（消息流底部「运行中」工时）：发送瞬间即起算，
    // 模型尚无输出的间隙也开始显示
    setRunStartedAt(Date.now());
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
      setRunStartedAt(null);
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
      setRunStartedAt(null);
      setLoading(false);
      setCompacting(false);
      toastState.retract("context-warning");
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
    // 反馈1：换档即收权——手动改档时自动批准随之撤销（同档不动）。
    // 主进程 setApprovalMode 同步撤销；这里走撤销 IPC 让提示卡与侧栏即时消失。
    const previousMode = preferences?.approvalMode;
    const autoApproveActive = current?.autoApprove ?? false;
    try {
      workspaceState.setPreferences(currentId, { approvalMode: mode });
      await workspaceState.flush();
      if (
        previousMode !== undefined &&
        previousMode !== mode &&
        autoApproveActive
      ) {
        void revokeAutoApprove(currentId);
      }
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

  /**
   * 标题栏任务上下文上报（票01）：任务名、项目·Worktree/本地 徽章数据、
   * 任务搜索与面板开关交由 App 的 Header 装配；无任务（未选任务/草稿）
   * 时 task 为 null，标题栏回退品牌展示。上下文按内容记忆，仅在
   * 数据变化时上报，App 级 setState 不会反向触发本页 effect 重跑。
   */
  const hasCurrentTask = current !== null;
  const titlebarTask = useMemo<TitlebarTask | null>(
    () =>
      current
        ? {
            taskId: current.id,
            title: current.title,
            projectName:
              current.projectId === null
                ? null
                : (projects.find((p) => p.id === current.projectId)?.name ??
                  null),
            workspaceMode: current.workspaceMode,
            workspacePath: current.workspacePath,
            workspaceOriginPath: current.workspaceOriginPath,
          }
        : null,
    [current, projects]
  );
  const titlebarContext = useMemo<TitlebarContext>(
    () => ({
      task: titlebarTask,
      search: { recordsRevision, onSelect: selectTask },
      panels: {
        resourcesOpen: drawer === "resources",
        disabled: !hasCurrentTask,
        onToggleResources: toggleResources,
      },
    }),
    [
      titlebarTask,
      recordsRevision,
      selectTask,
      drawer,
      hasCurrentTask,
      toggleResources,
    ]
  );
  useEffect(() => {
    onTitlebarContext?.(titlebarContext);
  }, [titlebarContext, onTitlebarContext]);

  /** 工作区共享检查（票02）：展示目标为当前草稿或当前任务，toast 同步见下 */
  const sharingTarget = draft
    ? {
        projectId: draft.projectId,
        workspacePath: draft.workspacePath,
        workspaceMode: draft.workspaceMode ?? "local",
      }
    : current
      ? { taskId: current.id }
      : null;
  const sharing = useWorkspaceSharing(sharingTarget);

  /**
   * 五类提示的状态同步（票02）：原消息流上方常驻横条迁为右下角 toast。
   * 约定：状态在 → toast 在（不占布局行、持续可见）；状态消失 → retract
   * 无条件撤除（状态重现须重新提示）。事件文案相同的手动关闭在状态持续
   * 期间不复活（toast-state 的 dismissed 记录），内容变化视为新提示。
   */
  const persistenceError = workspaceState.persistenceError();
  useEffect(() => {
    syncToast(
      toastState,
      "workbench-save-error",
      persistenceError !== null
        ? {
            kind: "error",
            content: `工作现场保存失败：${persistenceError}`,
          }
        : null
    );
  }, [persistenceError, toastState]);

  const pendingProfileId = draft?.providerProfileId ?? selectedProfileId;
  const profileUnavailable =
    Boolean(pendingProfileId) &&
    !profiles.some((profile) => profile.id === pendingProfileId);
  useEffect(() => {
    syncToast(
      toastState,
      "unavailable-profile",
      profileUnavailable
        ? {
            kind: "error",
            content: "已保存的模型配置不可用，请重新选择模型；不会自动替换。",
          }
        : null
    );
  }, [profileUnavailable, toastState]);

  useEffect(() => {
    syncToast(
      toastState,
      "workspace-sharing-notice",
      sharing.error !== null
        ? {
            kind: "error",
            content: sharing.error,
            contentTestId: "workspace-sharing-error",
          }
        : sharing.warning !== null
          ? {
              kind: "warn",
              content: sharing.warning,
              contentTestId: "workspace-sharing-warning",
            }
          : null
    );
  }, [sharing.warning, sharing.error, toastState]);

  const autoApproveOn = current?.autoApprove ?? false;
  const autoApproveBusy = current !== null && revoking.has(current.id);
  const autoApproveError =
    current === null ? null : (revokeErrors[current.id] ?? null);

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
          断点基准而非视口——侧栏开合改变本栏宽度时按档位分档响应。
          票03 起「规范与技能 / 改动」为消息流上方 overlay 抽屉（见下方
          消息流区域容器），开合不改变容器宽度、不触发断点切换。 */}
      <section className="@container/task flex min-w-0 flex-1">
        <div
          className="flex min-w-0 flex-1 flex-col"
          style={
            {
              "--task-scrollbar-gutter": `${scrollbarGutter}px`,
            } as CSSProperties
          }
        >
          {/* 草稿场景就地收纳（票01）：workspace-info 整行取消后，新建草稿的
              目录选择与工作区模式入口保留在本列（仅草稿期间渲染，非常驻行）；
              正式任务的路径/模式/来源目录收进标题栏徽章。内容与消息流、
              输入区共用同一内容列宽度类，左右缘对齐。 */}
          {draft && (
            <div
              data-testid="draft-workspace-info"
              className="shrink-0 border-b border-line px-4 py-2 text-xs text-fg-muted"
              style={contentPadding}
            >
              <div className={contentWidthClass}>
                <div
                  data-testid="workspace-path"
                  title={
                    draft.workspacePath ??
                    projects.find((p) => p.id === draft.projectId)
                      ?.workspacePath
                  }
                  className="flex flex-wrap items-center gap-x-2 gap-y-1"
                >
                  <span className="min-w-0 break-all">
                    {draft.workspaceMode === "worktree"
                      ? "来源目录（发送后使用隔离工作区）："
                      : "工作区："}
                    {draft.workspacePath ??
                      projects.find((p) => p.id === draft.projectId)
                        ?.workspacePath ??
                      "应用专用持久目录（首次发送时分配）"}
                  </span>
                  {draft.projectId !== null && (
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
                {draft.projectId === null && (
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
                {draft.workspacePath && (
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
                {draft.error && (
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
          {/* 消息流区域容器（票03）：overlay 抽屉的定位基准。抽屉浮于消息流
              上方（absolute），打开时不改变消息流与内容列宽度——原「分栏
              兄弟节点 max-w-[40%] 挤压」行为取消；面板开合也不再影响
              @container/task 容器宽度（三档分档行为保持稳定）。
              票02：原消息流上方的五类常驻横条已迁为右下角 toast，不再占行。 */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* 消息流顶部行（同宽对齐正文列）：改动摘要胶囊恒驻右上角
             * （无任务禁用；抽屉打开期间不渲染，关闭与切 tab 走抽屉控件）。
             * 「已开启自动批准」提示卡已迁至消息流下方、输入区上方——
             * 靠近审批动作的发生点，宽度对齐正文列。 */}
            <div className="shrink-0 pt-3 pl-4" style={contentPadding}>
              <div
                className={`${contentWidthClass} flex items-start justify-end gap-2`}
              >
                {drawer === null && (
                  <ChangesChip
                    taskId={currentId}
                    refreshSignal={changesRevision}
                    onOpen={toggleChanges}
                  />
                )}
              </div>
            </div>
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
              runStartedAt={runStartedAt}
              compacting={compacting}
              contentWidthClass={contentWidthClass}
              followSignal={followSignal}
              taskTitle={current?.title ?? null}
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
            {currentId !== null && drawer !== null && (
              <PanelsDrawer
                tab={drawer}
                onTabChange={openDrawer}
                onClose={closeDrawer}
                resources={
                  <AgentResourcesPanel
                    resources={resources}
                    loading={resourcesLoading}
                    error={resourcesError}
                    onRefresh={refreshCurrentResources}
                    onClose={closeDrawer}
                  />
                }
                changes={
                  current !== null ? (
                    <ChangesPanel
                      key={current.id}
                      taskId={current.id}
                      taskTitle={current.title}
                      selectedProfileId={selectedProfileId}
                      onClose={closeDrawer}
                    />
                  ) : null
                }
              />
            )}
          </div>
          {/* 「已开启自动批准」提示卡：位于消息正文与消息队列/输入框（或
           *  交互面板）之间，靠近取消操作的发生点。宽度对齐正文列：左右
           *  padding 对齐消息流滚动容器的 px-4（右缘再补滚动槽宽），
           *  contentWidthClass 的居中基准与消息列、输入区完全一致。 */}
          {current !== null && autoApproveOn && (
            <div className="shrink-0 pb-1 pl-4" style={contentPadding}>
              <div className={contentWidthClass}>
                <div
                  data-testid="task-auto-approve"
                  role="status"
                  className="flex items-start gap-2 rounded-lg border border-warn-fg/40 bg-warn-bg px-3 py-2 text-xs text-warn-fg"
                >
                  <span
                    className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-warn-fg"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      data-testid="task-auto-approve-content"
                      className="break-words"
                    >
                      本任务已开启自动批准
                    </p>
                    <p className="break-words opacity-80">
                      取消后恢复基础审批模式的允许策略，不撤回已批准的执行。
                    </p>
                    {autoApproveError !== null && (
                      <p role="alert">{autoApproveError}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    data-testid="task-auto-approve-revoke"
                    disabled={autoApproveBusy}
                    // 读 ref 不闭包捕获：切换任务后不重渲染也不会撤错任务
                    onClick={() => {
                      const id = currentIdRef.current;
                      if (id !== null) void revokeAutoApprove(id);
                    }}
                    className="shrink-0 rounded border border-line px-2 py-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
                  >
                    {autoApproveBusy ? "取消中…" : "取消自动批准"}
                  </button>
                </div>
              </div>
            </div>
          )}
          {interaction ? (
            <InteractionPanel
              key={interaction.request.id}
              record={interaction}
              count={pending.length}
              draft={workspaceState.draft(
                interaction.request.taskId,
                interaction.request.id
              )}
              {...workspaceState.submission(
                interaction.request.taskId,
                interaction.request.id
              )}
              onChange={(action) =>
                workspaceState.edit(
                  interaction.request.taskId,
                  interaction.request.id,
                  action
                )
              }
              onRespond={(response) =>
                void workspaceState.submit(
                  interaction.request.taskId,
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
      </section>
      {/* 票02：五类提示的右下角浮层，fixed 定位不占布局行 */}
      <ToastHost
        toasts={toastState.toasts()}
        onDismiss={(id) => toastState.dismiss(id)}
      />
    </div>
  );
}
