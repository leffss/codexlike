import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  createWorkspaceState,
  type WorkspaceState,
} from "../lib/workspace-state";
import { InteractionPanel } from "../components/InteractionPanel";
import { ToastHost } from "../components/ToastHost";
import {
  createToastManager,
  type ToastContent,
  type ToastKind,
  type ToastManager,
} from "../lib/toast-state";
import type {
  QueuedMessage,
  QueueOperationResult,
  QueueSnapshot,
  TaskActivity,
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
  goalSpentTokens,
  resolveComposerSubmission,
  taskUsageTokens,
  type ApprovalMode,
  type GoalRecord,
  type ProviderProfile,
  type ProjectRecord,
  type TaskResourcesView,
  type TerminalSessionRecord,
  type ThinkingEffort,
  type WorkbenchTarget,
} from "@codexlike/agent-core";

import { contextWarningMessage } from "../lib/context-warning";

import { RailPanel } from "../components/RailPanel";
import type { SubagentFocus } from "../components/SubagentRailPanel";
import type { TerminalFocus } from "../components/TerminalRailPanel";
import { FullAccessConfirmDialog } from "../components/FullAccessConfirmDialog";
import { GoalProgressRow } from "../components/GoalProgressRow";
import { goalPauseReason, goalRoundNumber } from "../lib/goal-view";
import { NewTaskStart } from "../components/NewTaskStart";
import { MessageComposer } from "../components/MessageComposer";
import { MessageStream } from "../components/MessageStream";
import { TaskQueuedNotice } from "../components/TaskQueuedNotice";
import { ProcessPillsBar } from "../components/ProcessPillsBar";
import {
  TitlebarResourceToggle,
  WorkspaceOpenerButton,
  type TitlebarContext,
  type TitlebarTask,
} from "../components/TitlebarTaskContext";
import { TaskSidebar } from "../components/TaskSidebar";
import {
  MembershipDialog,
  ProjectRemovalDialog,
} from "../components/MembershipDialogs";
import { ArchiveTerminalDialog } from "../components/ArchiveTerminalDialog";
import { TASK_CONTENT_WIDTH_CLASS } from "../lib/content-width";
import { reportLaunchState } from "../lib/launch-state";
import { useWorkspaceSharing } from "../lib/workspace-sharing";
import { terminalNameIndex } from "../lib/terminal-read-view";
import {
  appendLocalSegment,
  mergeInteractions,
  type MessageSegment,
  type SubagentSegment,
  type UserSegment,
} from "../lib/task-view";
import {
  busyCommandFeedback,
  clearsCommandInput,
  formatTaskStatus,
  matchModelsForModelSwitch,
  planSlashCommand,
  type SlashCommandAction,
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
 * 完成判定是否在途（ADR 0035「验证中」副状态）：宿主活动态带 goalPhase =
 * verifying 且任务仍在执行。快照恢复与事件接续两条路径共用同一判定。
 */
function isVerifying(activity: TaskActivity): boolean {
  return activity.running && activity.goalPhase === "verifying";
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
  /**
   * 消息卡首行右侧的动作组（App 装配）：settingsButton / themeToggle 分开成
   * 槽（右栏开关夹在两者之间——用户指定「设置 ↔ 右栏开关」对调）；
   * windowControls = 最小化 / 最大化 / 关闭（按右栏开合落在消息卡首行或
   * 右栏首行）。
   */
  chrome: {
    settingsButton: ReactNode;
    themeToggle: ReactNode;
    windowControls: ReactNode;
  };
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
  // 输入队列有独立水位：IPC 回包先到时，不抬高消息事件水位而吞掉正文事件。
  const queueSequenceRef = useRef(-1);
  /**
   * 取回编辑任务（票 03）：点击排队消息把内容载入输入框，保存原地更新。
   * originalText 为载入时的原文（主进程 CAS 校验）；savedDraft 为进入编辑前
   * 的输入框草稿，取消编辑或切走任务时还原，不丢用户文字。
   */
  const [queueEdit, setQueueEditState] = useState<QueueEditTask | null>(null);
  /** 编辑实例同步切换：同一帧内导航/IPC 回包也不能读到上一份编辑状态。 */
  const queueEditRef = useRef<QueueEditTask | null>(null);
  const setQueueEdit = useCallback((editing: QueueEditTask | null) => {
    queueEditRef.current = editing;
    setQueueEditState(editing);
  }, []);
  const restoreQueueEditDraft = useCallback(() => {
    const editing = queueEditRef.current;
    if (editing === null) return;
    setQueueEdit(null);
    workspaceState.setComposer(editing.taskId, editing.savedDraft);
  }, [setQueueEdit, workspaceState]);
  /**
   * 任务排队中的首条执行文本（任务并发上限票 03 / ADR 0022）：随 openTask
   * 快照与 task-queue-changed 事件接续（live 状态机单一来源）。非 null 且
   * 未开跑（streaming=false）时：消息流本地呈现首条消息 + 顶部状态条；
   * 开跑后 user-message 接管首条、dequeue 快照清空字段。
   */
  const [queuedStart, setQueuedStart] = useState<string | null>(null);
  /**
   * 当前任务的目标（ADR 0035，GLOSSARY「目标」）：输入框上方进度行的数据源。
   * 随任务快照（view.goal）恢复、随 goal-changed 事件接续；null = 无目标，
   * 进度行不占布局行。
   */
  const [goal, setGoal] = useState<GoalRecord | null>(null);
  /**
   * 完成判定在途（ADR 0035「验证中」副状态）：随宿主活动态的 goalPhase 接续，
   * 进度行据此显示「验证中」而非「进行中」。
   */
  const [goalVerifying, setGoalVerifying] = useState(false);
  /**
   * 目标的暂停说明（票 04）：宿主在 goal-changed 上附带的暂停原因（不由目标
   * 记录本身推得的场合，如目标循环的下一轮没能发起），随快照恢复与事件接续。
   */
  const [goalPauseNote, setGoalPauseNote] = useState<string | null>(null);
  /** 目标控制操作（暂停 / 恢复 / 清除）进行中：进度行按钮组整体禁用，防止重复提交 */
  const [goalBusy, setGoalBusy] = useState(false);
  /**
   * 进度行「第 N 轮」的轮次（ADR 0035「控制面」）：与标记行同源——从消息流
   * goal-verification 段的 round 推导当前目标的已完成轮数，验证中再 +1 得到
   * 正在判定的轮次。不另存一份计数。
   */
  const goalRound =
    goal === null
      ? 0
      : goalRoundNumber(
          goal.id,
          messages.flatMap((item) =>
            item.kind === "goal-verification" && item.verification !== undefined
              ? [
                  {
                    goalId: item.verification.goalId,
                    round: item.verification.round,
                  },
                ]
              : []
          ),
          goalVerifying
        );
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
  // 终端会话硬边（ADR 0033 票07）：归档带存活会话任务的待确认请求——
  // null = 无挂起；非 null 时渲染 ArchiveTerminalDialog（确认/取消回调分流）
  const [archiveTerminalConfirm, setArchiveTerminalConfirm] = useState<{
    id: string;
    title: string;
    aliveCount: number;
  } | null>(null);
  const [draftProjectId, setDraftProjectId] = useState<
    string | null | undefined
  >(workspaceState.activeDraftProjectId);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const draft =
    draftProjectId === undefined
      ? null
      : workspaceState.newDraft(
          draftProjectId,
          profiles[0]?.id ?? "",
          profiles[0]?.models[0] ?? ""
        );
  // 归属解析（review 上提）：NewTaskStart 只消费解析结果（工作区路径
  // 回退与归属回显），归属 find 不散在子组件里
  const draftProject =
    draft?.projectId != null
      ? (projects.find((item) => item.id === draft.projectId) ?? null)
      : null;
  const creating = draft?.busy ?? false;
  const preferences =
    currentId === null ? null : workspaceState.preferences(currentId);
  const thinkingEffort = preferences?.thinkingEffort ?? "auto";
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
  // 检视右栏（ADR 0018）：默认关闭（与桌面双卡前的开合语义一致）；开合由
  // 消息卡首行「右栏开关」驱动，未提交变更数由右栏上报（角标消费）。
  const [railOpen, setRailOpen] = useState(false);
  const [changesCount, setChangesCount] = useState<number | null>(null);
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
  // 任务记住的模型（票 02）：优先「对下一条生效」的偏好，缺省回退任务记录
  // （重启/切回后未改选时沿用上次实际发送所用的二元组，spec 用户故事 7）
  const selectedProfileId =
    preferences?.providerProfileId || current?.providerProfileId || "";
  const selectedModel = preferences?.model || current?.model || "";
  function setSelectedModel(providerProfileId: string, model: string) {
    if (currentId !== null)
      workspaceState.setPreferences(currentId, { providerProfileId, model });
  }
  const pending = currentId === null ? [] : workspaceState.pending(currentId);
  const interaction = pending[0];
  /**
   * 排队首条的本地呈现窗口（任务并发上限票 03）：有排队快照且未开跑
   *（开跑瞬间 user-message 信封的 running 已置真而 dequeue 快照可能未到，
   * 以 streaming 判定避免本地段与真实首条同帧重复）。
   */
  const queuedVisible =
    currentId !== null && queuedStart !== null && !streaming;
  const displayMessages = useMemo(() => {
    const merged =
      currentId === null
        ? messages
        : mergeInteractions(messages, workspaceState.records(currentId));
    if (!queuedVisible || queuedStart === null) return merged;
    // 排队任务的首条消息尚未进入执行（不落 transcript、无事件），从任务
    // 排队快照本地回显为首条用户段；开跑后由 user-message 事件接管。
    return [
      {
        id: "queued-start",
        seq: 0,
        turnId: "queued-start",
        responseId: null,
        kind: "user",
        content: queuedStart,
      } satisfies UserSegment,
      ...merged,
    ];
  }, [currentId, messages, queuedVisible, queuedStart, workspaceState]);
  // 终端会话名索引（ADR 0033 read 锚点）：供右栏子代理详情工具流的
  // read 锚点行按会话名呈现（主消息流在 MessageStream 内自派生，同款
  // terminalNameIndex 规则、不同数据源实例）
  const terminalNames = useMemo(
    () => terminalNameIndex(displayMessages),
    [displayMessages]
  );
  // 子代理段（ADR 0020）：右栏「子代理」tab 的数据来源（消息段过滤）
  const subagentSegments = useMemo(
    () =>
      displayMessages.filter(
        (item): item is SubagentSegment => item.kind === "subagent"
      ),
    [displayMessages]
  );
  // 标记行点击定位信号（seq 单调递增：同 id 重复点击也重新定位）
  const subagentFocusSeqRef = useRef(0);
  const [subagentFocus, setSubagentFocus] = useState<SubagentFocus | null>(
    null
  );
  const openSubagentFromStream = useCallback((subagentId: string) => {
    setRailOpen(true);
    setSubagentFocus({ id: subagentId, seq: ++subagentFocusSeqRef.current });
  }, []);
  // 终端标记行点击定位信号（ADR 0033 票 06，先例 SubagentFocus：seq 单调
  // 递增——同 sessionId 重复点击也重新定位；RailPanel 切 tab、详情页选中
  // 与幂等守卫在 TerminalRailPanelBody 内）
  const terminalFocusSeqRef = useRef(0);
  const [terminalFocus, setTerminalFocus] = useState<TerminalFocus | null>(
    null
  );
  const openTerminalFromStream = useCallback((sessionId: string) => {
    setRailOpen(true);
    setTerminalFocus({ sessionId, seq: ++terminalFocusSeqRef.current });
  }, []);
  // 终端会话恢复快照（ADR 0033 票 08）：当前任务 view 并行字段的已退出
  // 记录（含快照文本），右栏终端 tab 初始拉取的恢复数据源——重启后内存
  // 注册表为空，rail「已退出」组由此恢复（任务打开时随 view 一次刷新）
  const [restoredTerminals, setRestoredTerminals] = useState<
    TerminalSessionRecord[]
  >([]);
  // 新建、加载与已有任务始终使用同一档位；滚动条宽度由消息流实际测量。
  const contentWidthClass = TASK_CONTENT_WIDTH_CLASS;
  const [scrollbarGutter, setScrollbarGutter] = useState(0);
  // 正文列左右同宽（2026-11-26 用户反馈「正文与输入框左右离卡片边框不一样」）：
  // 消息流滚动槽恒占右侧 8px，若只补右缘，正文会被挤成左窄右宽——左右都按
  // 「基准 1rem + 滚动槽」留白，滚动条算进可视留白，正文块在卡片内居中。
  const contentPadding = {
    paddingLeft: "calc(1rem + var(--task-scrollbar-gutter, 0px))",
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

  /** draft 态预览的主动刷新旋钮（面板刷新按钮 / 抽屉打开即刷新共用）。 */
  const [draftPreviewNonce, setDraftPreviewNonce] = useState(0);
  /** draft 与任务两态统一的资源刷新入口：按当前视图路由到对应管线。 */
  const refreshResourcesForView = useCallback(() => {
    if (currentIdRef.current !== null) refreshCurrentResources();
    else setDraftPreviewNonce((nonce) => nonce + 1);
  }, [refreshCurrentResources]);

  /**
   * draft 态（首条消息前无任务记录）按工作区路径预览规范与技能：
   * 输入框技能菜单与「规范与技能」面板共用同一 resources 状态，首条消息
   * 发出后由 tasks.start → openTask 切换到任务快照管线。worktree 模式的
   * 草稿用源工作区路径预览（worktree 在首条消息后才创建，内容一致）。
   * request 代数防旧结果串线（与 refreshResources 同款守卫）。
   */
  const draftWorkspacePath = draft
    ? (draft.workspacePath ??
      // 独立任务草稿的路径经「选择已有目录」写入 draft；项目会话草稿的
      // 路径在项目记录上（发送前不落 draft，主进程 tasks:start 从 project
      // 解析且禁改工作区），渲染时从 projects 现查。应用专用持久目录型
      // 项目无路径（首次发送时分配），与界面文案一致地不可预览。
      projects.find((p) => p.id === draft.projectId)?.workspacePath ??
      null)
    : null;
  useEffect(() => {
    if (currentId !== null) return; // 任务态由 openTask 管线负责
    if (draftWorkspacePath === null) {
      setResources(null); // draft 未选工作区（或已关闭），无可预览
      return;
    }
    const request = ++resourceRequestRef.current;
    const isCurrent = () =>
      currentIdRef.current === null && resourceRequestRef.current === request;
    setResourcesLoading(true);
    setResourcesError(null);
    window.codexlike.tasks
      .draftResources(draftWorkspacePath)
      .then((view) => {
        if (!isCurrent()) return;
        setResources(view);
        if (view === null) setResourcesError("任务资源不可用");
      })
      .catch((error) => {
        if (!isCurrent()) return;
        setResources(null);
        setResourcesError(
          `读取规范与技能失败：${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        if (isCurrent()) setResourcesLoading(false);
      });
  }, [currentId, draftWorkspacePath, draftPreviewNonce]);

  /**
   * 右栏状态动作（ADR 0018）：标题栏「右栏开关」唯一开合入口；打开瞬间
   * 刷新资源（与原「开面板即刷新」语义一致；改动 tab 挂载时自刷新 git
   * 状态）。关闭瞬间递增 changesRevision（角标在右栏关闭期间仍需刷新）。
   */
  const toggleRail = useCallback(() => {
    setRailOpen((open) => !open);
  }, []);
  const prevRailOpenRef = useRef(false);
  useEffect(() => {
    if (!prevRailOpenRef.current && railOpen) refreshResourcesForView();
    if (prevRailOpenRef.current && !railOpen) setChangesRevision((v) => v + 1);
    prevRailOpenRef.current = railOpen;
  }, [railOpen, refreshResourcesForView]);

  /**
   * git 状态刷新信号：一轮回答结束（streaming 真转假）与右栏关闭时递增，
   * 驱动右栏 hook 重新读取（标题栏角标在右栏关闭期间也随此刷新）；
   * 任务切换由 hook 自身按 taskId 刷新。
   */
  const [changesRevision, setChangesRevision] = useState(0);
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !streaming)
      setChangesRevision((v) => v + 1);
    prevStreamingRef.current = streaming;
  }, [streaming]);

  /** 本地命令反馈（GLOSSARY）：不落库、不进模型上下文，右下角 toast 一次性
   *  展示（ADR 0030）——同 id 顶替（右下角只保留最新一条），info 类约 6 秒
   *  自动消失、error 类常驻直到手动关闭。 */
  const pushCommandFeedback = useCallback(
    (kind: ToastKind, content: string) => {
      toastState.flash("command-feedback", { kind, content });
    },
    [toastState]
  );

  /** /status 报告块关闭（ADR 0031）：按段 id 从消息列表移除该报告 */
  const dismissStatusSegment = useCallback((id: string) => {
    setMessages((prev) => prev.filter((item) => item.id !== id));
  }, []);

  /**
   * 上下文告警刷新（code review 修复 2，spec 验收场景 4；执行设置票 03）：
   * 以 /status 的 token 估算对照模型上下文窗口（Profile 可配，默认 128k）
   * × 告警阈值——阈值来自执行设置，每次刷新逐次读取（无快照语义，设置页
   * 保存后下一次评估即生效，默认 80%），超阈值以 toast 常驻右下角
   * （票02；/compact 后重估自然消失）；查询失败静默不打扰。
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
            : await contextWarningMessage(window.codexlike, status);
        if (!isCurrent()) return;
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
    /**
     * countAsViewed=false：冷启动自动恢复（启动现场/回退链）不算「查看」
     * ——中断等终态未读提醒（d87c04e 口径）保留到用户显式打开才熄灭；
     * 该路径下 live 无执行现场，markViewed 只是 recoveredViewed 记账。
     */
    async (id: string, options?: { countAsViewed?: boolean }) => {
      reportWorkbenchTarget({ kind: "task", taskId: id });
      setDraftProjectId(undefined);
      workspaceState.activeDraftProjectId = undefined;
      // 打开任务会结束当前编辑实例，包括重新选择同一任务。
      restoreQueueEditDraft();
      setCurrentId(id);
      workspaceState.activeTaskId = id;
      currentIdRef.current = id;
      const request = ++taskRequestRef.current;
      const isCurrent = () =>
        currentIdRef.current === id && taskRequestRef.current === request;
      setMessages([]);
      queueSequenceRef.current = -1;
      setQueueState(EMPTY_QUEUE_STATE);
      // 排队首条（票 03）：随快照恢复，加载期间先清空防上个任务的值闪现
      setQueuedStart(null);
      // 目标（ADR 0035）：加载期间先清空，随快照恢复
      setGoal(null);
      setGoalVerifying(false);
      setGoalPauseNote(null);
      setGoalBusy(false);
      // 终端恢复快照（票 08）：加载期间先清空防上个任务的已退出组闪现
      setRestoredTerminals([]);
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
        queueSequenceRef.current = live.sequence;
        setQueueState(live.queueState);
        setQueuedStart(live.queuedStart);
        setGoal(live.goal);
        setGoalPauseNote(live.goalPauseNote);
        setGoalVerifying(isVerifying(live.activity));
        // 终端恢复快照（票 08）：view 并行字段随任务打开一次刷新
        setRestoredTerminals(view.terminals);
        setStreaming(live.activity.running);
        // 运行中恢复：从消息段重推运行起点（轮次起点），工时不因重开清零
        setRunStartedAt(
          live.activity.running ? deriveRunStartedAt(live.items) : null
        );
        setCompacting(
          live.activity.running && live.activity.operation === "compact"
        );
        if (options?.countAsViewed !== false)
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
      restoreQueueEditDraft,
      workspaceState,
      toastState,
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
          await openTask(remembered.id, { countAsViewed: false });
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
        await openTask(latest.id, { countAsViewed: false });
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
          // /status 报告段（ADR 0031）不属于宿主历史，事件接续时保留驻留。
          setMessages((prev) => [
            ...live.items,
            ...prev.filter((item) => item.kind === "status"),
          ]);
          if (
            event.type === "queue-changed" &&
            envelope.sequence >= queueSequenceRef.current
          ) {
            queueSequenceRef.current = envelope.sequence;
            setQueueState(live.queueState);
          }
          setQueuedStart(live.queuedStart);
          // 目标状态（ADR 0035）：随 goal-changed 接续（判定后的状态推进、Stop = 暂停）
          setGoal(live.goal);
          setGoalPauseNote(live.goalPauseNote);
          setGoalVerifying(isVerifying(live.activity));
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
        event.type === "interaction-resolved" ||
        // 目标模式（ADR 0035）：目标循环的开始与结束都改变任务的运行口径——后台
        // 目标任务的循环结束时没有本地消息段变化，侧栏徽章与「N 个执行中」
        // 统计要靠这些事件刷新（否则循环结束后侧栏停在「运行中」）
        event.type === "goal-changed" ||
        event.type === "goal-verifying" ||
        event.type === "goal-verification" ||
        event.type === "goal-continuation" ||
        // 任务排队变更（任务并发上限票 03）：排队态进出（入队/开跑出队/中断
        // 出队）驱动侧栏徽章与「N 个执行中」统计刷新——后台任务的排队变化
        // 不进消息流，仅刷新列表
        event.type === "task-queue-changed"
      ) {
        // 审批事件也驱动侧栏状态徽标（运行中 ↔ 等待审批）
        void refreshTasks();
      }
    });
  }, [refreshTasks, refreshContextWarning, refreshResources, workspaceState]);

  useEffect(
    () => () => {
      // 页面卸载也离开编辑目标：先排入原草稿恢复，再让迟到加载失效。
      restoreQueueEditDraft();
      taskRequestRef.current += 1;
      resourceRequestRef.current += 1;
      currentIdRef.current = null;
    },
    [restoreQueueEditDraft]
  );

  /**
   * 入口只恢复该项目/独立入口草稿，不调用创建 IPC。恢复失败或被更新的
   * 打开请求取代时停留在错误提示/最新请求的现场，不做后续动作。
   */
  async function startCreateTask(
    projectId: string | null = null
  ): Promise<void> {
    const request = ++taskRequestRef.current;
    restoreQueueEditDraft();
    setLoading(true);
    try {
      await workspaceState.flush();
      await workspaceState.loadNewDraft(
        projectId,
        profiles[0]?.id ?? "",
        profiles[0]?.models[0] ?? ""
      );
    } catch (error) {
      if (taskRequestRef.current === request) {
        setLoading(false);
        pushCommandFeedback(
          "error",
          `进入新建任务失败：${error instanceof Error ? error.message : String(error)}`
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
    // 任务态右栏（可能停在「改动」tab）随任务上下文失效，进入草稿即关闭
    setRailOpen(false);
    setMessages([]);
    setQueuedStart(null);
    // 新建草稿没有任务，也就没有目标
    setGoal(null);
    setGoalVerifying(false);
    setGoalPauseNote(null);
    setGoalBusy(false);
    setWorkspaceFiles([]);
    setResources(null);
    setLoading(false);
    setStreaming(false);
    setRunStartedAt(null);
    setCompacting(false);
    toastState.retract("context-warning");
    setFullAccessPending(false);
  }

  /**
   * 归属选择器切换（票 02）：切归属 = 切入口——与从对应入口进入同一语义
   * （startCreateTask：flush → 恢复该入口持久草稿 → 上报启动现场 target
   * 随切换更新），持久化模型一寸不动。切换为纯恢复目标入口草稿：已选
   * 目录是入口「设置」的一部分（用户故事 5），随草稿恢复、不做重置。
   */
  async function switchDraftProject(projectId: string | null) {
    if (draftProjectId === projectId) return;
    await startCreateTask(projectId);
  }

  async function addProject() {
    try {
      const path = await window.codexlike.tasks.selectWorkspace();
      if (path === null) return;
      await window.codexlike.projects.add(path);
      setProjects(await window.codexlike.projects.list());
    } catch (error) {
      pushCommandFeedback(
        "error",
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

  /**
   * 新建任务页的首个提交（普通消息 / /goal，ADR 0035）：建任务并发出首条消息。
   * goal 为 true 时首条消息同时作为目标——宿主建任务即设目标、进入目标模式，
   * 与任务态 /goal 同一语义。失败沿用首次发送的回滚（任务与目标都不留）；
   * goal 命令失败时把 `/goal X` 原样回填输入框（与任务态命令失败「输入已
   * 保留」同口径）。
   */
  async function sendFirst(
    text: string,
    mentionPaths: string[],
    goal = false
  ): Promise<void> {
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
      model: draft.model || undefined,
      thinkingEffort: draft.thinkingEffort,
      approvalMode: draft.approvalMode,
      goal: goal || undefined,
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
        ...(goal ? { text: `/goal ${text}` } : {}),
      });
    }
  }

  /**
   * 新建任务页 /goal（ADR 0035）：建任务、设目标、目标原文作首条用户消息开跑
   * ——与任务态 /goal 同一语义，只是任务此刻还不存在。失败沿用首次发送的
   * 回滚（目标行随任务同滚），命令原样回填输入框。
   */
  async function startGoalTask(text: string): Promise<void> {
    await sendFirst(text, [], true);
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
        preferences?.approvalMode,
        selectedModel || undefined
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
   *  排队消息存在时队列进入暂停（票 02），队列条显示恢复/清空操作。
   *  目标进行中时 Stop = 暂停（ADR 0035）：目标转已暂停，队列不置暂停、排队消息
   *  随即自动逐条发出（规格故事 12，票 04）。 */
  async function stop() {
    if (currentId === null) {
      return;
    }
    try {
      await window.codexlike.tasks.interrupt(currentId);
    } catch (error) {
      pushCommandFeedback(
        "error",
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
    const taskId = currentIdRef.current;
    if (taskId === null || loadingRef.current !== null) return;
    const generation = taskRequestRef.current;
    const isCurrent = () =>
      currentIdRef.current === taskId && taskRequestRef.current === generation;
    try {
      const result = await invoke(taskId);
      if (
        isCurrent() &&
        result.taskId === taskId &&
        result.sequence >= queueSequenceRef.current
      ) {
        queueSequenceRef.current = result.sequence;
        setQueueState(result);
      }
    } catch (error) {
      if (!isCurrent()) return;
      pushCommandFeedback(
        "error",
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
    workspaceState.setComposer(currentId, item.text, false);
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
    const generation = taskRequestRef.current;
    const isCurrent = () =>
      currentIdRef.current === taskId && taskRequestRef.current === generation;
    const composerSnapshot = workspaceState.composer(taskId);
    try {
      const result = await window.codexlike.tasks.queueUpdate(
        taskId,
        itemId,
        text,
        originalText,
        mentionPaths.length === 0 ? undefined : mentionPaths
      );
      if (!isCurrent() || result.taskId !== taskId) return;
      if (result.sequence >= queueSequenceRef.current) {
        queueSequenceRef.current = result.sequence;
        setQueueState(result);
      }
      if (queueEditRef.current !== editing) return;
      setQueueEdit(null);
      workspaceState.setComposer(
        taskId,
        workspaceState.composer(taskId) === composerSnapshot
          ? ""
          : workspaceState.composer(taskId)
      );
    } catch (error) {
      // 保存被拒：只结束发起保存的实例，取消后重开的编辑不受影响。
      if (!isCurrent() || queueEditRef.current !== editing) return;
      setQueueEdit(null);
      workspaceState.setComposer(taskId, workspaceState.composer(taskId));
      if (currentIdRef.current === taskId)
        pushCommandFeedback(
          "error",
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
      workspaceState.setComposer(currentId, workspaceState.composer(currentId));
      pushCommandFeedback(
        "info",
        "编辑的排队消息已发出或被移除：编辑未保存，文本保留在输入框"
      );
      return;
    }
    if (item.id === queueState.sendingId) {
      setQueueEdit(null);
      workspaceState.setComposer(currentId, workspaceState.composer(currentId));
      pushCommandFeedback(
        "info",
        "编辑的排队消息已开始发送：编辑未保存，文本保留在输入框"
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pushCommandFeedback 为稳定 useCallback
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
        pushCommandFeedback("info", `任务已重命名为「${title}」`);
    } catch (error) {
      pushCommandFeedback(
        "error",
        `重命名失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** 侧栏及 /archive 共用导航，异步返回不能抢走用户刚切换的任务。 */
  async function archiveTask(id: string, archived: boolean) {
    if (archived) {
      // 终端会话硬边（ADR 0033 票07）：任务有存活终端会话时提示后关闭——
      // 先确认再归档，确认后宿主「先杀后归档」；取消则不发起归档 IPC，
      // 会话继续运行（拒绝路径）。查询失败不阻断既有归档行为。
      try {
        const sessions = await window.codexlike.terminals.listFor(id);
        const aliveCount = sessions.filter(
          (session) => session.status === "running"
        ).length;
        if (aliveCount > 0) {
          const title =
            tasks.find((item) => item.id === id)?.title ?? "未命名任务";
          setArchiveTerminalConfirm({ id, title, aliveCount });
          return;
        }
      } catch {
        // 终端查询不可用（如旧版宿主）时按无存活会话处理
      }
    }
    await performArchive(id, archived);
  }

  /** 归档/恢复的实际执行（archiveTask 确认分流后的共用路径）。 */
  async function performArchive(id: string, archived: boolean) {
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
      pushCommandFeedback(
        "error",
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
      setQueuedStart(null);
      setGoal(null);
      setGoalVerifying(false);
      setGoalPauseNote(null);
      setGoalBusy(false);
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
      pushCommandFeedback(
        "error",
        `项目记录已移除，刷新列表失败：${String(error)}`
      );
    }
  }

  /**
   * /goal <目标>（ADR 0035，GLOSSARY「目标」）：为当前任务设定目标并进入目标
   * 模式——宿主把目标原文作为首条用户消息发出（首轮），目标落库为「进行中」，
   * 回合结束后自动进行完成判定。发送参数与直发消息同一组快照（首轮按它发出）。
   * 成功 / 失败走本地命令反馈；失败时命令输入保留，修正后可直接重发。
   */
  async function setGoalForTask(text: string) {
    if (currentId === null) return;
    const taskId = currentId;
    const generation = taskRequestRef.current;
    const isCurrent = () =>
      currentIdRef.current === taskId && taskRequestRef.current === generation;
    try {
      await workspaceState.flush();
      const record = await window.codexlike.tasks.goalSet(taskId, text, {
        providerProfileId: selectedProfileId,
        model: selectedModel || undefined,
        thinkingEffort,
        approvalMode: preferences?.approvalMode,
      });
      if (!isCurrent()) return;
      setGoal(record);
      setGoalPauseNote(null);
      pushCommandFeedback(
        "info",
        "已设定目标，进入目标模式：每轮回复结束后自动进行完成判定"
      );
    } catch (error) {
      if (!isCurrent()) return;
      // 设定失败（任务正在执行 / 已有未结束的目标 / 首轮启动失败等）：输入保留
      workspaceState.setComposer(taskId, `/goal ${text}`);
      pushCommandFeedback(
        "error",
        `设定目标失败：${error instanceof Error ? error.message : String(error)}（输入已保留）`
      );
    }
  }

  /** 控制操作失败的统一文案：<操作>失败：<原因> */
  function goalFailure(action: string, error: unknown, suffix = ""): string {
    const reason = error instanceof Error ? error.message : String(error);
    return `${action}失败：${reason}${suffix}`;
  }

  /**
   * 暂停目标（ADR 0035「Stop = 暂停」，GLOSSARY「目标」）：与停止按钮同一通道
   * ——宿主中断在途回合（或判定）并在 idle 边界把目标转已暂停，两轮之间则直接
   * 暂停；排队消息随即自动逐条发出。成功与失败都走本地命令反馈。
   */
  async function pauseGoal() {
    const taskId = currentIdRef.current;
    if (taskId === null) return;
    setGoalBusy(true);
    try {
      const stopped = await window.codexlike.tasks.interrupt(taskId);
      // 停止落定的那一刻目标已不在进行中：没有可暂停的东西，不报成功
      if (stopped)
        pushCommandFeedback(
          "info",
          "目标已暂停：可随时恢复，累计时长与逐轮验证记录保留"
        );
    } catch (error) {
      pushCommandFeedback("error", goalFailure("暂停目标", error));
    } finally {
      setGoalBusy(false);
    }
  }

  /**
   * 恢复目标（票 04）：宿主把已暂停 / 预算受限 / 未达成的目标转回进行中，并以
   * 内部输入从暂停点发起下一轮（不产生用户气泡）。下一轮没能发起时宿主抛回
   * 原因（目标已回已暂停，进度行另有暂停说明）。
   */
  async function resumeGoal() {
    const taskId = currentIdRef.current;
    if (taskId === null || loadingRef.current !== null) return;
    const generation = taskRequestRef.current;
    setGoalBusy(true);
    try {
      const record = await window.codexlike.tasks.goalResume(taskId);
      if (
        currentIdRef.current === taskId &&
        taskRequestRef.current === generation &&
        record.status === "active"
      ) {
        setGoal(record);
        setGoalPauseNote(null);
        pushCommandFeedback("info", "目标已恢复：从暂停点继续推进");
      }
      // 未抛错而已不在进行中：恢复途中目标被停止 / 清除，状态以事件快照为准
    } catch (error) {
      pushCommandFeedback("error", goalFailure("恢复目标", error));
    } finally {
      setGoalBusy(false);
    }
  }

  /**
   * 保存目标文本的编辑（票 04）：宿主原地更新目标记录并下发快照，逐轮验证
   * 记录保留；下一次完成判定按新文本进行。失败原因走本地命令反馈，异常原样
   * 抛回进度行（编辑态保持、内容不丢）。
   */
  async function saveGoalEdit(text: string) {
    const taskId = currentIdRef.current;
    if (taskId === null) throw new Error("当前没有打开的任务");
    const generation = taskRequestRef.current;
    try {
      const record = await window.codexlike.tasks.goalEdit(taskId, text);
      if (
        currentIdRef.current === taskId &&
        taskRequestRef.current === generation
      ) {
        setGoal(record);
        pushCommandFeedback(
          "info",
          "目标已更新：下一次完成判定按新文本进行，逐轮验证记录保留"
        );
      }
    } catch (error) {
      pushCommandFeedback(
        "error",
        goalFailure("编辑目标", error, "（编辑内容已保留）")
      );
      throw error;
    }
  }

  /**
   * 清除目标（票 04）：目标转「已清除」、进度行退场，任务回到普通对话形态
   * （宿主让输入队列恢复自动消费、占用的并发名额让出）；逐轮验证记录仍随
   * 任务留痕。目标进行中时宿主一并中断在途回合或判定，不判定、不续跑。
   */
  async function clearGoal() {
    const taskId = currentIdRef.current;
    if (taskId === null) return;
    setGoalBusy(true);
    try {
      const record = await window.codexlike.tasks.goalClear(taskId);
      if (currentIdRef.current === taskId) {
        setGoal(record);
        setGoalPauseNote(null);
      }
      pushCommandFeedback(
        "info",
        "目标已清除：任务回到普通对话，逐轮验证记录仍可回看"
      );
    } catch (error) {
      pushCommandFeedback("error", goalFailure("清除目标", error));
    } finally {
      setGoalBusy(false);
    }
  }

  /** 斜杠命令执行（与等效 UI 操作走同一 IPC 通道，见 slash-command-actions） */
  async function runCommand(action: SlashCommandAction) {
    switch (action.type) {
      case "needs-task":
        pushCommandFeedback("info", "该命令需要先选择一个任务");
        return;
      case "goal-missing-argument":
        // 三要素引导以轻提示为限（规格 Out of Scope：不做 setup 访谈）
        pushCommandFeedback(
          "info",
          "用法：/goal 目标描述（建议写明期望结果、约束与验证方式）"
        );
        return;
      case "set-goal":
        await setGoalForTask(action.text);
        return;
      case "start-task-with-goal":
        await startGoalTask(action.text);
        return;
      case "new-task": {
        // 只沿用显式管理归属，不从执行目录或 Worktree 来源派生项目。
        void startCreateTask(current?.projectId ?? draft?.projectId ?? null);
        return;
      }
      case "compact": {
        // /compact：压缩进行中不可重复触发；模型在主进程解析（apiKey 不入渲染层）
        if (compacting) {
          pushCommandFeedback("info", "正在压缩历史，请等待完成…");
          return;
        }
        if (selectedProfileId === "") {
          pushCommandFeedback("info", "压缩需要先选择模型（Provider Profile）");
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
            selectedProfileId,
            selectedModel || undefined
          );
          // 历史与运行状态由同序号终态事件更新；IPC回包只提供本地命令反馈。
          if (!compactIsCurrent()) return;
          pushCommandFeedback(
            "info",
            `已压缩：${result.compactedMessages} 条历史消息已替换为摘要（保留最近 3 轮原始对话）`
          );
        } catch (error) {
          if (!compactIsCurrent()) return;
          pushCommandFeedback(
            "error",
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
        pushCommandFeedback("info", "用法：/rename 新名称");
        return;
      case "archive": {
        await archiveTask(current!.id, true);
        return;
      }
      case "select-model": {
        // /model 同选择器平铺「Profile · 模型」（票 02）：关键词可匹配到具体模型
        const match = matchModelsForModelSwitch(action.query, profiles);
        if (match.kind === "unique") {
          setSelectedModel(match.profile.id, match.model);
          pushCommandFeedback(
            "info",
            `模型已切换：${match.profile.name} · ${match.model}（对下一条消息生效）`
          );
        } else {
          pushCommandFeedback(
            "info",
            [
              action.query === ""
                ? "当前可选模型（用 /model 关键词 切换）："
                : `「${action.query}」匹配多个模型，请更精确地指定：`,
              ...match.candidates.map(
                (candidate) =>
                  `- ${candidate.profile.name} · ${candidate.model}`
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
            pushCommandFeedback("error", "任务不存在或已损坏");
          } else {
            // /status 多行报告驻留消息流逐条可关闭（ADR 0031），
            // 不走右下角 toast（限高滚动 + 短驻留不适合细看）。
            setMessages((prev) =>
              appendLocalSegment(prev, {
                kind: "status",
                content: formatTaskStatus(status),
              })
            );
          }
        } catch (error) {
          if (
            currentIdRef.current !== taskId ||
            taskRequestRef.current !== request
          )
            return;
          pushCommandFeedback(
            "error",
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
        pushCommandFeedback("info", "编辑中的排队消息不能是命令（输入已保留）");
        return;
      }
      void saveQueueEdit(submission.text, submission.mentionPaths);
      return;
    }
    if (submission.kind === "slash-command") {
      // 忙时命令不入队不执行（spec 用户故事 16，票 05）：命令在错误的时机被
      // 延迟执行没有意义；提示后保留输入，回复结束后原样重发即可执行。
      // 目标进行中（ADR 0035）时任务恒为执行中，同一条规则照常生效——文案按
      // 目标状态说准（/compact 提示先暂停目标，见 busyCommandFeedback）。
      if (streaming) {
        pushCommandFeedback(
          "info",
          busyCommandFeedback(submission.name, {
            goalRunning: goal?.status === "active",
          })
        );
        return;
      }
      const action = planSlashCommand(
        { name: submission.name, argument: submission.argument },
        // 判据是「视图里有任务」（current）：与 runCommand 各分支的 current! 同源，
        // 列表刷新与视图短暂脱节时不能放行依赖任务的命令。
        { hasTask: current !== null, hasDraft: draft !== null }
      );
      void runCommand(action);
      // 只有真正执行的命令才由这里清空输入：被拦命令、用法提示与新建任务页
      // /goal 保留输入（后者由宿主在建任务时消费草稿文本，见 clearsCommandInput）。
      if (clearsCommandInput(action)) {
        if (currentId !== null) workspaceState.setComposer(currentId, "");
        else if (draft)
          workspaceState.editNewDraft(draft.projectId, { text: "" });
      }
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
      pushCommandFeedback(
        "error",
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
  // draft 已选工作区时同样可开右栏，预览走 draft 管线
  const hasDraftWorkspace = draft !== null && draftWorkspacePath !== null;
  // 工作区打开器（GLOSSARY）：任务工作区优先，draft 已选目录次之，其余禁用
  const openerWorkspacePath = titlebarTask
    ? titlebarTask.workspacePath
    : hasDraftWorkspace
      ? draftWorkspacePath
      : null;
  const titlebarContext = useMemo<TitlebarContext>(
    () => ({
      task: titlebarTask,
      panels: {
        open: railOpen,
        disabled: !hasCurrentTask && !hasDraftWorkspace,
        onToggle: toggleRail,
        changesCount,
      },
      opener: {
        workspacePath: openerWorkspacePath,
        // IPC 绑定收在 page 层：标题栏组件保持纯 props 可测
        listOpeners: () => window.codexlike.openers.list(),
        openWorkspace: (input) => window.codexlike.openers.open(input),
        notifyError: (message) => {
          toastState.show("workspace-opener", {
            kind: "error",
            content: message,
            contentTestId: "workspace-opener-error",
          });
        },
      },
    }),
    [
      titlebarTask,
      railOpen,
      hasCurrentTask,
      hasDraftWorkspace,
      openerWorkspacePath,
      toggleRail,
      changesCount,
      toastState,
    ]
  );

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
  /**
   * 「N 个任务执行中」（任务并发上限票 03）：任务列表活动态统计——含等待
   * 审批/问答（占坑口径，ADR 0022 / GLOSSARY「任务并发上限」：执行中含
   * 等待用户交互）；排队任务自身 running=false 不计入。侧栏徽章与状态条
   * 同一数据面（事件驱动刷新）。
   */
  const runningTaskCount = tasks.filter(
    (task) => task.activity?.running === true
  ).length;

  return (
    <div className="flex h-full gap-2">
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
      {archiveTerminalConfirm && (
        <ArchiveTerminalDialog
          taskTitle={archiveTerminalConfirm.title}
          aliveCount={archiveTerminalConfirm.aliveCount}
          onConfirm={() => {
            const { id } = archiveTerminalConfirm;
            setArchiveTerminalConfirm(null);
            // 确认路径：宿主 tasks:archive 内「先杀后归档」（存活会话终止并
            // 等 exit 后写入归档，terminal-exited 事件先于归档推进）
            void performArchive(id, true);
          }}
          onCancel={() => setArchiveTerminalConfirm(null)}
        />
      )}
      <TaskSidebar
        projects={projects}
        searchRecordsRevision={recordsRevision}
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
              pushCommandFeedback("error", `置顶失败：${String(error)}`)
            );
        }}
        onPinProject={(id, pinned) => {
          void window.codexlike.projects
            .setPinned(id, pinned)
            .then(() => window.codexlike.projects.list())
            .then(setProjects)
            .catch((error: unknown) =>
              pushCommandFeedback("error", `项目置顶失败：${String(error)}`)
            );
        }}
        onCollapseProject={(id, collapsed) => {
          void window.codexlike.projects
            .setCollapsed(id, collapsed)
            .then(() => window.codexlike.projects.list())
            .then(setProjects)
            .catch((error: unknown) =>
              pushCommandFeedback("error", `折叠失败：${String(error)}`)
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
          {/* 草稿态（票 01 居中起点式）：新建任务主列整体替换为居中起点页
              （工作区卡/决策行/专属输入卡见 NewTaskStart），原草稿就地收纳行
              与底部 composer 不再渲染；正式任务的消息流与 composer 零波及。 */}

          {/* 任务排队状态条（任务并发上限票 03 / ADR 0022）：满员排队期间
              显示等待原因与当前执行数（首条消息本地回显进消息流）；开跑后
              随 queuedStart 清空卸载。仅任务态渲染（草稿无排队）。 */}
          {queuedVisible && (
            <div
              className="shrink-0 border-b border-line px-4 py-2"
              style={contentPadding}
            >
              <div className={contentWidthClass}>
                <TaskQueuedNotice runningCount={runningTaskCount} />
              </div>
            </div>
          )}
          {/* 中列主区（ADR 0018 检视右栏）：主列（消息流 + 审批提示卡 +
              输入区/交互面板）与右栏并列——打开时整列一起推窄，输入卡以
              消息列基准左右各外扩 12px（2026-11-19 起取代「同宽」口径，
              见 MessageComposer）；关闭时右栏整体卸载、主列
              恢复全宽。右栏自带拖拽分隔条与双端最小宽；开合唯一入口在
              消息卡首行「右栏开关」（改动计数角标）。@container/task 容器宽度
              不受右栏开合影响（三档分档行为保持稳定）。票02：原消息流上方
              的五类常驻横条已迁为右下角 toast，不再占行。 */}
          {/* 桌面双卡：右栏拖拽条改为绝对定位骑缝、不占布局宽，
              卡片间距只由本行 gap 决定（4px） */}
          <div className="flex min-h-0 flex-1 gap-1">
            {/* 中列卡片：消息流 + 输入区同一张卡（右栏打开时与右栏卡并排） */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-floating">
              {/* 消息卡首行：任务标题 + 目录（左），打开目录 / 右栏开关 /
                  主题 / 设置 / 窗口按钮（右）。标题栏退役后这一行兼任窗口
                  拖动区；交互控件各自免拖。 */}
              <div
                data-testid="workspace-topbar"
                className="window-titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-line px-3"
              >
                {/* 任务标题（14px）与目录（12px mono）按基线对齐：
                      盒居中（items-center）会让 mono 小字抬眼 1.5px，
                      两段文字看起来不在一条线上（2026-11-26 用户反馈） */}
                <div className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span
                    data-testid="task-title"
                    title={titlebarTask?.title ?? "新建任务"}
                    className="min-w-0 shrink truncate text-sm font-semibold text-fg"
                  >
                    {titlebarTask?.title ?? (draft ? "新建任务" : "CodexLike")}
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-fg-subtle">
                    ·
                  </span>
                  <span
                    data-testid="workspace-topbar-path"
                    title={openerWorkspacePath ?? undefined}
                    className="min-w-0 truncate font-mono text-xs text-fg-muted"
                  >
                    {openerWorkspacePath ?? "未选择工作区"}
                  </span>
                  {titlebarTask?.workspaceMode === "worktree" && (
                    <span
                      data-testid="workspace-mode"
                      title="首次执行后工作区固定，调整项目归属不会改变目录、分支和历史；不代表文件只读或权限受限。"
                      className="shrink-0 rounded bg-worktree-bg px-1.5 py-0.5 text-[10px] text-worktree-fg"
                    >
                      Worktree
                    </span>
                  )}
                </div>
                <div className="window-no-drag flex shrink-0 items-center gap-1">
                  {/* 首行图标密集：打开目录用紧凑版（图标与下拉箭头贴紧） */}
                  <WorkspaceOpenerButton
                    opener={titlebarContext.opener}
                    compact
                  />
                  {/* 右侧动作从左到右：主题、设置、右栏开关、窗口按钮
                        （2026-11-26 用户对调设置与主题后的顺序） */}
                  {props.chrome.themeToggle}
                  {props.chrome.settingsButton}
                  <TitlebarResourceToggle panels={titlebarContext.panels} />
                  {railOpen ? null : props.chrome.windowControls}
                </div>
              </div>
              {draft ? (
                <NewTaskStart
                  draft={draft}
                  project={draftProject}
                  projects={projects}
                  profiles={profiles}
                  workspaceFiles={workspaceFiles}
                  skills={resources?.preview.catalog.skills}
                  onOpenSkills={refreshResourcesForView}
                  onEditDraft={(patch) =>
                    workspaceState.editNewDraft(draft.projectId, patch)
                  }
                  onSwitchProject={(projectId) =>
                    void switchDraftProject(projectId)
                  }
                  onSelectWorkspace={() => void selectDraftWorkspace()}
                  onSelectApprovalMode={(mode) => void selectApprovalMode(mode)}
                  onSend={handleSubmit}
                  onOpenSettings={props.onOpenSettings}
                />
              ) : (
                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
                    onOpenSubagent={openSubagentFromStream}
                    onOpenTerminal={openTerminalFromStream}
                    onDismissStatus={dismissStatusSegment}
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
                  {/* 任务过程胶囊条（GLOSSARY「工作计划」，ADR 0034，原型变体
                  B 转正，快照见 prototype/tri-list-cards 分支）：位于消息
                  正文与消息队列/输入框（或交互面板）之间——取代主任务位的
                  长条形折叠卡（ADR 0019；子代理详情页折叠卡保留）。一行三
                  胶囊（计划/子代理/终端）按内容宽度居中，点开向上弹出浮动
                  对话框（锚定被点胶囊），行点击直跳右栏详情（ADR 0032 语义）。
                  宽度对齐正文列：左右 padding 对齐消息流滚动容器的 px-4（右
                  缘再补滚动槽宽），contentWidthClass 的居中基准与消息列、
                  输入区完全一致（同下方自动批准卡先例）。三类皆空渲染 null
                  不占布局行。 */}
                  <div className="shrink-0 pb-1 pl-4" style={contentPadding}>
                    <div className={contentWidthClass}>
                      {/* 草稿态（currentId === null）无消息段，条本就渲染
                      null；条件短路使 taskId 收紧为非空（终端 hook 按
                      任务装配） */}
                      {currentId !== null && (
                        <ProcessPillsBar
                          taskId={currentId}
                          messages={displayMessages}
                          restoredTerminals={restoredTerminals}
                          onOpenSubagent={openSubagentFromStream}
                          onOpenTerminal={openTerminalFromStream}
                        />
                      )}
                    </div>
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
                          className="flex items-start gap-2 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn-fg"
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
                            className="shrink-0 rounded-md px-2 py-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
                          >
                            {autoApproveBusy ? "取消中…" : "取消自动批准"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  {/* 目标进度行（ADR 0035，GLOSSARY「目标」）：过程胶囊条与输入区之间
                    常驻——目标摘要、状态（六态称谓）、累计时长，以及控制面按钮组
                    （暂停 / 恢复 / 编辑 / 清除，票 04；按六态给出可用性）与编辑入口；
                    没有目标或目标已清除时不占布局行。宽度对齐正文列（与上方胶囊条
                    同一 contentWidthClass 居中基准）。已归档的任务只读（不提供操作）；
                    以目标记录为 key：换了一条目标（清除后重新设定）编辑态随之重置。 */}
                  {currentId !== null && (
                    <div className="shrink-0 pb-1 pl-4" style={contentPadding}>
                      <div className={contentWidthClass}>
                        <GoalProgressRow
                          key={goal?.id ?? currentId}
                          goal={goal}
                          round={goalRound}
                          verifying={goalVerifying}
                          pauseReason={
                            goal === null
                              ? null
                              : (goalPauseReason(goal) ?? goalPauseNote)
                          }
                          controls={
                            current?.archivedAt == null
                              ? {
                                  onPause: () => void pauseGoal(),
                                  onResume: () => void resumeGoal(),
                                  onSaveEdit: saveGoalEdit,
                                  onClear: () => void clearGoal(),
                                  busy: goalBusy,
                                }
                              : undefined
                          }
                          // 目标用量 = 任务用量账目 − 目标基线：取任务列表的最新账目
                          // （目标事件驱动列表刷新，预算显示随每轮判定之后更新）
                          spentTokens={
                            goal === null || current === null
                              ? 0
                              : goalSpentTokens(goal, taskUsageTokens(current))
                          }
                        />
                      </div>
                    </div>
                  )}
                  {interaction ? (
                    <InteractionPanel
                      key={interaction.request.id}
                      record={interaction}
                      count={pending.length}
                      contentWidthClass={contentWidthClass}
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
                      key={currentId ?? "no-task"}
                      draftValue={
                        currentId === null
                          ? ""
                          : workspaceState.composer(currentId)
                      }
                      onDraftChange={(text) => {
                        if (currentId !== null)
                          workspaceState.setComposer(
                            currentId,
                            text,
                            queueEditRef.current?.taskId !== currentId
                          );
                      }}
                      clearOnSend={false}
                      profiles={profiles}
                      selectedProfileId={selectedProfileId}
                      selectedModel={selectedModel || null}
                      onSelectModel={(profileId, model) =>
                        setSelectedModel(profileId, model)
                      }
                      onSend={handleSubmit}
                      contentWidthClass={contentWidthClass}
                      workspaceFiles={workspaceFiles}
                      skills={resources?.preview.catalog.skills}
                      onOpenSkills={refreshResourcesForView}
                      readOnly={loading}
                      disabled={
                        currentId === null ||
                        current?.archivedAt != null ||
                        profiles.length === 0 ||
                        // streaming 不再禁用（票 01 输入队列）：忙时 Enter 直接入队；
                        // 等待用户交互（pending）期间维持禁用（spec 用户故事 17）。
                        compacting ||
                        loading ||
                        pending.length > 0
                      }
                      streaming={streaming}
                      queueState={
                        currentId === null ? EMPTY_QUEUE_STATE : queueState
                      }
                      queueEditingItemId={
                        queueEdit !== null && queueEdit.taskId === currentId
                          ? queueEdit.itemId
                          : null
                      }
                      onQueueResume={() => void resumeQueue()}
                      onQueueClear={() => void clearQueue()}
                      onQueueRemove={(itemId) => void removeQueueItem(itemId)}
                      onQueueEditItem={startQueueItemEdit}
                      onQueueReorder={(orderedIds) =>
                        void reorderQueue(orderedIds)
                      }
                      onQueueCancelEdit={cancelQueueEdit}
                      onStop={() => void stop()}
                      hint={composerHint}
                      approvalMode={preferences?.approvalMode ?? null}
                      onSelectApprovalMode={(mode) =>
                        void selectApprovalMode(mode)
                      }
                      thinkingEffort={
                        currentId === null ? null : thinkingEffort
                      }
                      onSelectThinkingEffort={(effort) =>
                        setThinkingEffort(effort)
                      }
                    />
                  )}
                </div>
              )}
            </div>
            <RailPanel
              open={railOpen}
              taskId={currentId}
              taskTitle={current?.title ?? null}
              selectedProfileId={selectedProfileId}
              changesRevision={changesRevision}
              resources={resources}
              resourcesLoading={resourcesLoading}
              resourcesError={resourcesError}
              onRefreshResources={refreshResourcesForView}
              onChangesCount={setChangesCount}
              subagents={subagentSegments}
              subagentFocus={subagentFocus}
              terminalFocus={terminalFocus}
              restoredTerminals={restoredTerminals}
              terminalNames={terminalNames}
              onOpenTerminal={openTerminalFromStream}
              // 右栏打开时窗口按钮落到右栏首行右侧
              headerTrailing={
                railOpen ? props.chrome.windowControls : undefined
              }
            />
          </div>
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
