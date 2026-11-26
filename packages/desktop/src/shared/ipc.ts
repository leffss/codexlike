import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  GoalRecord,
  GoalVerificationRecord,
  InteractionRecord,
  InteractionResponse,
  ProviderProfile,
  ProviderProfileInput,
  ProjectRecord,
  SubagentSnapshot,
  TaskEvent,
  TaskRecord,
  TaskSearchResult,
  TaskResourcesView,
  ThinkingEffort,
  TranscriptItem,
  WorkspaceMode,
  WorkbenchTarget,
  WorkbenchEntry,
} from "@codexlike/agent-core";
import type {
  GitBranchResult,
  GitCommitResult,
  GitFileDiff,
  GitStatus,
} from "@codexlike/agent-core";

import type { TaskStatusInfo } from "../tasks/status";
import type { QueueChangeReason, QueuedMessage } from "../tasks/input-queue";
import type {
  QueuedTaskStart,
  TaskQueueChangeReason,
} from "../tasks/task-queue";
import type { SearchSettings } from "../search/search-settings-store";
import type { SubagentSettings } from "../subagents/subagent-settings-store";
import type { AgentSettings } from "../execution/agent-settings-store";
import type { TerminalShell } from "@codexlike/agent-core/node";
import type { PtySize } from "@codexlike/agent-core/node";
import type {
  TerminalActionFailure,
  TerminalSessionRecord,
} from "@codexlike/agent-core";
import type { TerminalSettings } from "../terminal/terminal-settings-store";
import type {
  OpenerListResult,
  OpenerOpenInput,
  OpenerOpenResult,
  OpenerView,
} from "../openers/opener-settings-store";
import type { McpServerView } from "../mcp/mcp-service";
import type { McpServerInput } from "../mcp/mcp-store";
import type { ThemeName } from "../theme/theme-settings-store";
import type { TraySettings } from "../tray/tray-settings-store";
import type { ExitState } from "../lifecycle/application-exit";
import type {
  LaunchState,
  LaunchView,
} from "../launch-state/launch-state-store";
export type { ExitState };
export type WindowState = { maximized: boolean };
// 启动现场（票03）：冷启动查询与目标/视图上报的类型契约
export type { LaunchState, LaunchView };

// ui 侧经 `@codexlike/desktop/ipc` 引用 /status 数据形状
export type { TaskStatusInfo };
export type { SearchSettings };
export type { SubagentSettings };
export type { AgentSettings };
export type { TerminalSettings };
export type { TerminalShell };
// 工作区打开器（GLOSSARY）：候选/打开通道的公共形状
export type { OpenerView, OpenerListResult, OpenerOpenInput, OpenerOpenResult };
export type { McpServerView, McpServerInput };
export type { ThemeName };
// 托盘驻留（ADR 0025）：设置通道的公共形状
export type { TraySettings };
// 输入队列（票 01/02）：队列条与事件载荷的公共形状
export type { QueuedMessage, QueueChangeReason };
// 任务排队（任务并发上限票 02）：队列条与事件载荷的公共形状
export type { QueuedTaskStart, TaskQueueChangeReason };

/**
 * 渲染进程 ←→ 主进程 的类型化 IPC 契约。
 * preload（contextBridge）暴露 `window.codexlike`，UI 通过 `@codexlike/desktop/ipc` 引用类型。
 * 主→渲染：任务事件流（`task:events` channel，按任务 ID 多路复用）。
 */
export const IPC = {
  windowControls: {
    getState: "window-controls:get-state",
    minimize: "window-controls:minimize",
    toggleMaximize: "window-controls:toggle-maximize",
    close: "window-controls:close",
    stateChanged: "window-controls:state-changed",
  },
  application: {
    exitState: "application:exit-state",
    exitChanged: "application:exit-changed",
    answerExit: "application:answer-exit",
    flushed: "application:flushed",
  },
  workbench: { read: "workbench:read", write: "workbench:write" },
  projects: {
    list: "projects:list",
    add: "projects:add",
    remove: "projects:remove",
    setCollapsed: "projects:set-collapsed",
    setPinned: "projects:set-pinned",
  },
  providerProfiles: {
    list: "provider-profiles:list",
    create: "provider-profiles:create",
    update: "provider-profiles:update",
    remove: "provider-profiles:remove",
  },
  tasks: {
    /** 全部任务（含已归档；置顶优先、最近使用倒序，侧栏按归属分区）。 */
    list: "tasks:list",
    search: "tasks:search",
    /** 首次发送：幂等创建正式任务并启动正常发送。 */
    start: "tasks:start",
    execution: "tasks:execution",
    /** 执行起点历史与截至 sequence 的完整运行现场；先订阅再读取。 */
    view: "tasks:view",
    markViewed: "tasks:mark-viewed",
    setPinned: "tasks:set-pinned",
    markUsed: "tasks:mark-used",
    workspaceSharing: "tasks:workspace-sharing",
    setProject: "tasks:set-project",
    /** 打开原生目录选择器；取消返回 null */
    selectWorkspace: "tasks:select-workspace",
    /** 指定任务的消息历史 */
    messages: "tasks:messages",
    /** 发送消息；流式事件经 taskEvents 推送 */
    send: "tasks:send",
    /** 停止按钮：打断指定任务运行中的本轮（流式输出或工具执行）；空闲返回 false */
    interrupt: "tasks:interrupt",
    /** 输入队列（票 02）：手动恢复——清暂停标志并立即从队首继续逐条消费 */
    queueResume: "tasks:queue-resume",
    /** 输入队列（票 02）：清空——作废全部排队消息并清暂停标志 */
    queueClear: "tasks:queue-clear",
    queueRemove: "tasks:queue-remove",
    queueUpdate: "tasks:queue-update",
    queueReorder: "tasks:queue-reorder",
    /** /rename 与侧栏重命名共用（同一 IPC 通道） */
    rename: "tasks:rename",
    /** /archive 与侧栏归档共用；archived=false 取消归档 */
    archive: "tasks:archive",
    /** /status：上下文用量估算 + 模型 + 审批模式 */
    status: "tasks:status",
    /** 规范与技能：当前/最近运行摘要及下条消息的磁盘预览。 */
    resources: "tasks:resources",
    /** 规范与技能：draft 态（首条消息前无任务记录）按工作区路径的磁盘预览。 */
    draftResources: "tasks:draft-resources",
    /** /compact：手动压缩历史为摘要（保留最近 3 轮）；成功返回压缩概要 */
    compact: "tasks:compact",
    /** @引用 菜单候选：工作区文件相对路径列表 */
    workspaceFiles: "tasks:workspace-files",
    /** 工具截图数据（dataURL）；文件不存在（如已清理）返回 null */
    toolImage: "tasks:tool-image",
    /** 审批模式切换（三档）：落库并只对下一次发送生效 */
    setApprovalMode: "tasks:set-approval-mode",
    revokeAutoApprove: "tasks:revoke-auto-approve",
    /** 旧审批响应兼容入口，转发统一交互；always 仅批准本次。 */
    respondApproval: "tasks:respond-approval",
    /** 当前等待审批的请求（切回任务时恢复审批卡片）；无等待返回 null */
    pendingApproval: "tasks:pending-approval",
    /** 全部等待审批的请求（工单 13：主任务与子代理可能并行等待）；按到达顺序 */
    pendingApprovals: "tasks:pending-approvals",
    /** 当前任务全部待处理交互（审批和问答），按创建顺序返回。 */
    pendingInteractions: "tasks:pending-interactions",
    /** 响应一个待处理交互；类型与内容由 Core 对照请求校验。 */
    respondInteraction: "tasks:respond-interaction",
    /**
     * 目标模式（ADR 0035，GLOSSARY「目标」）：/goal 设定目标——目标原文作为首条
     * 用户消息发出（首轮），任务进入目标模式。
     */
    goalSet: "tasks:goal-set",
    /**
     * 目标模式控制面（ADR 0035，票 04）：恢复——已暂停 / 预算受限 / 未达成的目标
     * 转回进行中，从暂停点续跑。暂停与停止按钮同一通道（tasks:interrupt，Stop =
     * 暂停），不另设。
     */
    goalResume: "tasks:goal-resume",
    /** 目标模式控制面（ADR 0035，票 04）：编辑——修改目标文本（已暂停 / 预算受限 / 未达成时可编辑） */
    goalEdit: "tasks:goal-edit",
    /** 目标模式控制面（ADR 0035，票 04）：清除——目标转「已清除」，任务回到普通对话 */
    goalClear: "tasks:goal-clear",
    /**
     * 目标模式（ADR 0035「护栏」，票 05）：设定 / 调整当前目标的 token 预算——
     * 进度行上预算显示与设置的入口（预算是目标级参数，不进执行设置）。
     */
    goalSetBudget: "tasks:goal-set-budget",
  },
  /** 搜索源设置（工单 10）：key 经 safeStorage 加密落盘 */
  searchSettings: {
    get: "search-settings:get",
    set: "search-settings:set",
  },
  /** 子代理全局设置（工单 13）：子代理模型引用 + 并发上限 */
  subagentSettings: {
    get: "subagent-settings:get",
    set: "subagent-settings:set",
  },
  /** 执行设置（ADR 0017）：agent 执行参数（首个：主任务工具轮次上限） */
  agentSettings: {
    get: "agent-settings:get",
    set: "agent-settings:set",
  },
  /** 终端设置（code review 修复 1 + 执行设置票04）：shell 偏好 + 命令超时两项 */
  terminalSettings: {
    get: "terminal-settings:get",
    set: "terminal-settings:set",
  },
  /**
   * 终端会话（ADR 0033 票03）：宿主级会话服务的渲染端操作面（独立
   * namespace，对齐 tasks 三段式：快照（session/listFor）→ 订阅
   * （subscribe 携缓冲回放）→ 事件接续（sessionData 专用通道）。
   * 生命周期 terminal-* 事件并入 taskEvents（live-tasks 白名单已放行）。
   */
  terminals: {
    /** 创建会话：cwd 一律任务工作区（ADR 0004 不开 cwd 口子）、shell 跟随执行设置 */
    create: "terminals:create",
    /** 向会话写入用户键入（用户即授权者，不走审批） */
    write: "terminals:write",
    /** 调整 PTY 尺寸；会话不存在或已退出静默忽略（01 票口径，渲染端无需防御） */
    resize: "terminals:resize",
    /** 终止会话（用户 kill 不弹确认，非破坏性）；进程树终止由适配器保证 */
    kill: "terminals:kill",
    /** 用户改名（标题功能轮）：设置展示标题，此后 OSC 动态更新不再覆盖 */
    rename: "terminals:rename",
    /**
     * 订阅字节流并取初始回放：返回会话记录与当前缓冲全量（manager.bufferedOutput，
     * 不推读取水位——05 票工具 read 的水位语义不受影响）。重复订阅幂等。
     */
    subscribe: "terminals:subscribe",
    /** 退订字节流转发（详情页关闭时调用） */
    unsubscribe: "terminals:unsubscribe",
    /** 单会话记录；不存在返回 null */
    session: "terminals:session",
    /** 任务内会话清单（rail 列表页数据）：按创建顺序，含已退出会话 */
    listFor: "terminals:list-for",
    /** 主→渲染：PTY 字节流专用通道（高频，直写 xterm.js，绝不进 React 状态） */
    sessionData: "terminals:session-data",
  },
  /** 外观主题偏好（ADR 0006）：light / dark，默认浅色；主进程同步窗口底色与 nativeTheme */
  themeSettings: {
    get: "theme-settings:get",
    set: "theme-settings:set",
  },
  /** 托盘驻留与开机启动（ADR 0025）：开机启动开关（托盘菜单与设置页双入口同步） */
  traySettings: {
    get: "tray-settings:get",
    set: "tray-settings:set",
    /** 主→渲染：开关在任一入口变更（设置页已打开时实时刷新 checkbox） */
    changed: "tray-settings:changed",
  },
  /** 启动现场（票03）：冷启动查询 + 工作台目标/视图变更上报（低频事件即时落盘） */
  launchState: {
    get: "launch-state:get",
    setWorkbenchTarget: "launch-state:set-workbench-target",
    setView: "launch-state:set-view",
  },
  /** MCP servers（工单 12）：配置 + 连接状态 + 工具启停 */
  mcp: {
    overview: "mcp:overview",
    addServer: "mcp:add-server",
    removeServer: "mcp:remove-server",
    reconnect: "mcp:reconnect",
    setToolEnabled: "mcp:set-tool-enabled",
  },
  /** 主→渲染：任务事件流（TaskEventEnvelope，按任务 ID 多路复用）。 */
  taskEvents: "task:events",
  /** 改动面板 + git 集成（工单 05）：status/diff/分支/提交消息生成/提交 */
  git: {
    /** 工作区 git 状态（非 git 工作区返回 isGitRepo=false，不报错） */
    status: "git:status",
    /** 单文件 diff（新旧两侧全文，Monaco 双栏渲染） */
    diff: "git:diff",
    /** 一键创建任务分支（`taskBranchName` 由任务名生成 `类型/<slug>`，中文剥除、≤50 字符） */
    createBranch: "git:create-branch",
    /** 由模型按任务内容生成提交消息草稿（一次不发工具的请求） */
    commitMessage: "git:commit-message",
    /** 提交当前全部变更（消息可编辑后传入） */
    commit: "git:commit",
  },
  /** 渲染层导出文件（如助手正文导出 Markdown）：原生保存对话框 + 主进程写盘 */
  files: {
    /** 保存文本文件：取消返回 { saved: false }；写入成功返回保存路径 */
    saveText: "files:save-text",
  },
  /** 工作区打开器（GLOSSARY）：标题栏分裂按钮的候选列表与打开 */
  openers: {
    /** 候选打开器（仅本机探测到的，资源管理器恒在）与当前默认 */
    list: "openers:list",
    /** 打开工作区目录；携带 openerId 时以它打开并记为默认（点选即设置） */
    open: "openers:open",
  },
  /**
   * 剪贴板（终端粘贴用）：Chromium 的 navigator.clipboard.readText 在文档
   * 无 OS 焦点时静默返回空串，主进程 clipboard.readText 无此约束——终端
   * 粘贴走本桥保证任意焦点态可用（写侧 navigator.clipboard.writeText 无
   * 焦点约束，AssistantActions 沿用）。
   */
  clipboard: {
    /** 读 OS 剪贴板文本 */
    read: "clipboard:read",
  },
} as const;

/** 事件流信封：按任务 ID 多路复用 */
export interface TaskEventEnvelope {
  taskId: string;
  /** 本次宿主执行的稳定标识，结束后不复用。 */
  executionId: string;
  /** 任务内单调递增，跨执行不重置；快照含 <= sequence 的全部事件。 */
  sequence: number;
  event:
    | TaskEvent
    | { type: "compact-start" }
    | {
        type: "compact-finished";
        outcome: "completed" | "failed" | "interrupted";
        history: TranscriptItem[];
        error?: string;
      }
    | {
        /** 输入队列变更（票 01/02/03）：入队、出队发送、暂停/恢复/清空、删除/编辑/重排/发出锁定；queue 为变更后完整快照（正在发出的条目置顶） */
        type: "queue-changed";
        reason: QueueChangeReason;
        queue: QueuedMessage[];
        /** 变更后的队列暂停标志（票 02）：渲染层据此区分暂停态与正常排队 */
        paused: boolean;
        /** 正在发出的条目 id（票 03）：队列快照中置顶锁定显示的条目；省略/null 表示无 */
        sendingId?: string | null;
      }
    | {
        /**
         * 任务排队变更（任务并发上限票 02 / ADR 0022）：入队 / 出队开跑 / 出队
         * 移除；queue 为变更后的全局任务排队完整快照（按发起顺序），信封的
         * activity 同步携带 queued 活动态（侧栏徽章渲染是票 03）。
         */
        type: "task-queue-changed";
        reason: TaskQueueChangeReason;
        queue: QueuedTaskStart[];
      }
    /**
     * 目标状态变化（ADR 0035）：goal 为变更后的当前目标完整快照（设定 / 状态机
     * 每次推进都下发）；null 表示当前已无目标（清除）。
     */
    | {
        type: "goal-changed";
        goal: GoalRecord | null;
        /**
         * 本次转已暂停的原因（票 04）：只在原因不由目标记录本身推得时携带——
         * 目前是目标循环的下一轮没能发起（如任务所用模型已被删除）。手动暂停、
         * 回合被中断等没有对应的持久化原因，不携带。随事件下发、不落库。
         */
        pauseReason?: string;
      }
    /**
     * 一次完成判定开始（ADR 0035，GLOSSARY「完成判定」）：回合结束后的 idle
     * 边界发起判定时下发——消息流标记行的「第 N 次迭代 · 验证中」占位与进度行
     * 「验证中」副状态的实时信号。结论到达后以 goal-verification 原位升级为同一
     * 行；判定在途被中断则不留结论，占位随目标离开进行中撤下。
     */
    | { type: "goal-verifying"; goalId: string; round: number }
    /**
     * 一次完成判定的结论（ADR 0035，GLOSSARY「完成判定」）：消息流标记行
     * 「第 N 次迭代 · 已完成/未完成/判定不可用」的实时数据源；重启后由任务
     * 时间线恢复。
     */
    | { type: "goal-verification"; verification: GoalVerificationRecord };
  activity: TaskActivity;
}

/** 当前进程的执行/查看状态，不参与最近使用排序，不持久化思考内容。 */
export interface TaskActivity {
  /** 仅活动期间用于恢复正确入口；省略表示普通消息执行或空闲。 */
  operation?: "compact";
  /**
   * 目标模式（ADR 0035）的副状态：`verifying` = 完成判定在途（回合已收尾、
   * 结论未到）。只在任务呈现为执行中时出现；续跑轮进行中与两轮之间省略。
   * 进度行据此显示「验证中」而非「进行中」。
   */
  goalPhase?: "verifying";
  /**
   * 任务排队中（任务并发上限票 02 / ADR 0022）：空闲任务的发送因全局满员
   * 进入应用级任务排队、尚未开跑；开跑或出队后撤销。排队不是执行
   * （running=false），侧栏「排队中」徽章渲染是票 03。
   */
  queued?: boolean;
  running: boolean;
  waitingForUser: boolean;
  outcome: "completed" | "failed" | "interrupted" | null;
  unread: boolean;
}
export type TaskListItem = TaskRecord & { activity?: TaskActivity };

export interface TaskView {
  taskId: string;
  autoApprove?: boolean;
  executionId: string | null;
  sequence: number;
  history: TranscriptItem[];
  /**
   * 子代理恢复快照（ADR 0021 票 03）：骨架+逐轮消息+工具调用一次读出
   * （含重启收尾补记的 interrupted 骨架），随初始 history 同一次 IPC 发出、
   * 不走按需拉取；compact 整体替换 history 时本字段保留。
   * 仅为检视与导出，模型上下文组装不读它（transcript 仍是唯一来源）。
   */
  subagents: SubagentSnapshot[];
  /**
   * 终端会话恢复快照（ADR 0033 票 08）：已退出会话记录（含 64KB 终态快照
   * 文本；重启收尾置终态的行快照缺省）随 view 同一次 IPC 发出、不走按需
   * 拉取（恢复传输惯例对齐）。快照只供 rail「已退出」组恢复与只读回看，
   * 模型上下文组装不读它；同进程运行中的会话不经本字段——list-for 与
   * terminal-* 事件是其呈现通道。
   */
  terminals: TerminalSessionRecord[];
  events: TaskEventEnvelope[];
  pendingInteractions: InteractionRecord[];
  activity: TaskActivity;
  /**
   * 输入队列状态快照（票 01/02/03，review 重构收拢为三元组单点）：
   * 切换/重启恢复时队列条（含暂停态与正在发出条目）原样恢复。
   */
  queueState?: QueueSnapshot;
  /**
   * 任务排队中的首条执行文本（任务并发上限 review 修复 F2 / ADR 0022）：
   * 当前排队快照里本任务的条目文本，不在队为 null。重启后排队任务无
   * task-queue-changed 信封可重放，view 以此字段恢复排队首条回显与
   * 状态条；同进程会话以 events 里的信封重放为准（晚于快照）。
   */
  queuedStart?: string | null;
  /**
   * 当前目标（ADR 0035）：view 快照时刻的目标记录（进度行恢复数据源）；
   * 从未设定为 null。同进程会话以 events 里的 goal-changed 信封接续。
   */
  goal?: GoalRecord | null;
}

/**
 * /goal 设定目标的首轮发送参数（ADR 0035）：与 tasks.send 同一组发送快照——
 * 目标原文作为首条用户消息按它发出；缺省字段回退任务保存的发送偏好。
 */
export interface GoalSendOptions {
  providerProfileId?: string;
  /** 本条消息使用的具体模型（票 02 二元组）；缺省回退 Profile 列表第一项 */
  model?: string;
  thinkingEffort?: ThinkingEffort;
  approvalMode?: ApprovalMode;
}

/**
 * 队列状态快照（review 重构）：queue / paused / sendingId 三元组的单一携带
 * 形状——view 快照、事件接续与组件 props 不再各自摊开三个字段。
 */
export type QueueSnapshot = Pick<
  QueueOperationResult,
  "queue" | "paused" | "sendingId"
>;

/** 队列操作结果（票 02/03）：操作生效后的队列快照、暂停标志与正在发出条目 */
export interface QueueOperationResult {
  taskId: string;
  sequence: number;
  queue: QueuedMessage[];
  paused: boolean;
  sendingId: string | null;
}

export interface ProjectRemoval {
  projectId: string;
  taskIds: string[];
}

/** 一个草稿意图沿用同一个 requestId 重试；成功后重试仅返回原任务，不重放消息。 */
export interface StartTaskInput {
  requestId: string;
  projectId: string | null;
  /** 仅独立任务可指定；省略则在首次发送时分配专用持久目录。 */
  workspacePath?: string;
  workspaceMode?: WorkspaceMode;
  text: string;
  providerProfileId?: string;
  /** 首条消息使用的具体模型（票 02 二元组）；缺省回退 Profile 列表第一项 */
  model?: string;
  thinkingEffort?: ThinkingEffort;
  approvalMode?: ApprovalMode;
  mentionPaths?: string[];
  /**
   * 首条消息同时作为目标（ADR 0035，GLOSSARY「目标」「目标模式」）：新建任务页
   * 的 /goal 走这一条路径——建任务、目标落库、目标原文作首条用户消息开跑，
   * 与任务态 /goal 同一语义。缺省 false（普通首条消息）。
   */
  goal?: boolean;
}

export type WorkspaceSharingTarget =
  | { taskId: string }
  | {
      projectId: string | null;
      workspacePath?: string;
      workspaceMode?: WorkspaceMode;
    };

export interface WorkspaceSharingView {
  workspacePath: string | null;
  runningTasks: { id: string; title: string }[];
}

/** 宿主权威运行信息；与当前页面无关，等待回应也视为执行中。 */
export interface TaskExecutionState {
  taskId: string;
  executionId: string | null;
  running: boolean;
  waitingForUser: boolean;
  pendingInteractionIds: string[];
}

/** 终端会话创建结果：spawn 走判别 union，reason 是可直接展示的中文（01 票口径） */
export type TerminalSpawnResult =
  { ok: true; sessionId: string } | TerminalActionFailure;

/**
 * 字节流订阅结果：record 为订阅时刻的会话记录副本（running 或含终态快照的
 * exited），buffered 为当前缓冲全量（详情页 xterm.js 初始回放数据源，
 * manager.bufferedOutput 不推读取水位）。
 */
export type TerminalSubscribeResult =
  | {
      ok: true;
      sessionId: string;
      record: TerminalSessionRecord;
      buffered: string;
    }
  | { ok: false; reason: string };

/** sessionData 专用通道载荷（主→渲染）：按 sessionId 多路复用的实时字节流 */
export interface TerminalSessionDataPayload {
  sessionId: string;
  data: string;
}

/** 终端会话域 API：`window.codexlike.terminals` 的形状（ADR 0033 票03）。 */
export interface TerminalApi {
  /**
   * 创建用户侧终端会话：cwd 一律为 taskId 对应任务的工作区（ADR 0004，
   * 不接受任意 cwd 参数）、shell 跟随执行设置、origin 固定 user。
   * initialCommand 缺省为空（落在交互提示符）。任务不存在以中文异常抛回。
   */
  create(input: {
    taskId: string;
    initialCommand?: string;
  }): Promise<TerminalSpawnResult>;
  /** 向会话写入用户键入；会话不存在 / 已退出返回 ok:false（中文 reason） */
  write(
    sessionId: string,
    data: string
  ): Promise<{ ok: true } | TerminalActionFailure>;
  /** 调整 PTY 尺寸；会话不存在或已退出静默忽略（渲染端无需防御） */
  resize(sessionId: string, size: PtySize): Promise<void>;
  /** 终止会话（进程树死透由适配器保证）；重复 kill 已退出会话返回明确拒绝 */
  kill(sessionId: string): Promise<{ ok: true } | TerminalActionFailure>;
  /**
   * 用户改名（标题功能轮）：设置展示标题（source=user），此后 OSC 动态更新
   * 不再覆盖。会话不存在 / 已退出 / 空串 / 超长返回 ok:false（中文 reason）。
   */
  rename(
    sessionId: string,
    title: string
  ): Promise<{ ok: true } | TerminalActionFailure>;
  /**
   * 订阅字节流并取初始回放（三段式的订阅段）：先订阅后读缓冲，订阅后的
   * 实时输出经 onSessionData 推送，不丢不重。重复订阅幂等（不叠加转发）。
   */
  subscribe(sessionId: string): Promise<TerminalSubscribeResult>;
  /** 退订字节流转发；未订阅时幂等无副作用 */
  unsubscribe(sessionId: string): Promise<void>;
  /** 单会话记录（详情页刷新）；不存在返回 null */
  session(sessionId: string): Promise<TerminalSessionRecord | null>;
  /** 任务内会话清单（rail 列表页数据）：按创建顺序，含已退出会话 */
  listFor(taskId: string): Promise<TerminalSessionRecord[]>;
  /**
   * 订阅 PTY 字节流专用通道（terminals:session-data）：载荷按 sessionId
   * 多路复用，直写 xterm.js——绝不进 React 状态（spec 双通道纪律）。
   * 生命周期启停不走本通道（terminal-* 事件经 onTaskEvent）。
   */
  onSessionData(
    listener: (payload: TerminalSessionDataPayload) => void
  ): () => void;
}

/** 剪贴板 API：`window.codexlike.clipboard` 的形状（终端粘贴桥） */
export interface ClipboardApi {
  /** 读 OS 剪贴板文本（主进程 clipboard.readText，无焦点约束） */
  read(): Promise<string>;
}

/** `window.codexlike` 的完整 API 形状 */
export interface CodexLikeApi {
  windowControls: {
    getState(): Promise<WindowState>;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    onStateChanged(listener: (state: WindowState) => void): () => void;
  };
  application: {
    exitState(): Promise<ExitState>;
    answerExit(id: string, confirmed: boolean): Promise<void>;
    flushed(id: string, error?: string): Promise<void>;
    onExitState(listener: (state: ExitState) => void): () => void;
  };
  workbench: {
    read(target: WorkbenchTarget): Promise<WorkbenchEntry>;
    write(
      target: WorkbenchTarget,
      entry: WorkbenchEntry
    ): Promise<{ accepted: boolean; entry: WorkbenchEntry }>;
  };
  projects: {
    list(): Promise<ProjectRecord[]>;
    add(workspacePath: string): Promise<ProjectRecord>;
    /** 仅确认后移除应用记录；false 无副作用，目录及无归属同目录任务保留。 */
    remove(
      projectId: string,
      confirmed: boolean
    ): Promise<ProjectRemoval | null>;
    setPinned(
      projectId: string,
      pinned: boolean
    ): Promise<ProjectRecord | null>;
    setCollapsed(
      projectId: string,
      collapsed: boolean
    ): Promise<ProjectRecord | null>;
  };
  providerProfiles: {
    /** 全部 Provider Profile（apiKey 已解密，仅存在于渲染进程内存） */
    list(): Promise<ProviderProfile[]>;
    create(input: ProviderProfileInput): Promise<ProviderProfile>;
    /** 目标不存在时返回 null */
    update(
      id: string,
      input: ProviderProfileInput
    ): Promise<ProviderProfile | null>;
    /** 目标不存在时返回 false */
    remove(id: string): Promise<boolean>;
  };
  tasks: TaskApi;
  files: {
    /**
     * 原生保存对话框写出文本文件（如助手正文导出 Markdown）：
     * 用户取消返回 { saved: false }；写入失败以异常抛回。
     */
    saveText(input: {
      defaultFileName: string;
      content: string;
    }): Promise<{ saved: boolean; path?: string }>;
  };
}

/** 任务域 API：`window.codexlike.tasks` 的形状。 */
export interface TaskApi {
  start(input: StartTaskInput): Promise<TaskRecord>;
  /** 仅调整归属；null 移出项目，移入由宿主校验实际目录及活动状态。 */
  setProject(
    taskId: string,
    projectId: string | null
  ): Promise<TaskRecord | null>;
  execution(taskId: string): Promise<TaskExecutionState | null>;
  view(taskId: string): Promise<TaskView | null>;
  /** 只确认用户已经看到的水位，不消费更新之后产生的完成提醒。 */
  markViewed(taskId: string, sequence: number): Promise<void>;
  setPinned(taskId: string, pinned: boolean): Promise<TaskRecord | null>;
  /** 只在用户主动查看时调用；发送由宿主自动登记，后台刷新不调用。 */
  markUsed(taskId: string): Promise<TaskRecord | null>;
  /** 读取同实际目录的其他运行任务；不锁定并行，不创建工作区。 */
  workspaceSharing(
    target: WorkspaceSharingTarget
  ): Promise<WorkspaceSharingView>;
  /** 全部任务（重启后从 SQLite 恢复；含已归档，侧栏自行过滤） */
  list(): Promise<TaskListItem[]>;
  /** 标题与持久消息正文的字面子串搜索；默认排除归档，不读取私有配置或目录。 */
  search(query: string, includeArchived?: boolean): Promise<TaskSearchResult[]>;
  /** 原生目录选择器；取消返回 null */
  selectWorkspace(): Promise<string | null>;
  /** 指定任务的时间线：消息与工具卡片按发生顺序合并（含 error 消息） */
  messages(taskId: string): Promise<TranscriptItem[]>;
  /**
   * 发送消息：成功即启动流式回复（事件经 onTaskEvent 推送）。
   * mentionPaths 为消息中 @引用 的工作区相对路径，内容由主进程读取附加进模型上下文。
   * thinkingEffort 为本条消息的思考档位快照（GLOSSARY「思考档位」）：
   * 缺省按 auto 处理；主进程只接受五档枚举，非法值以中文异常抛回。
   * 任务忙时（回复进行中 / 等待用户回应）不再报错，而是入队该任务的
   * 输入队列（含发送参数快照，票 01），回复结束后由主进程自动逐条发出。
   * Profile 不存在 / 引用路径不合法等启动失败仍以异常抛回。
   */
  send(
    taskId: string,
    text: string,
    providerProfileId?: string,
    mentionPaths?: string[],
    thinkingEffort?: ThinkingEffort,
    approvalMode?: ApprovalMode,
    /** 本条消息使用的具体模型（票 02 二元组）；缺省回退 Profile 列表第一项 */
    model?: string
  ): Promise<void>;
  /**
   * 打断指定任务运行中的本轮（停止按钮）：
   * 流式输出立即中断（已生成部分保留）、工具执行中终止子进程。
   * 排队消息存在时队列原样保留并进入队列暂停（票 02）。
   * 排队中的任务即使空闲也中断：立即出队回空闲、已发消息保留（票 04
   * / ADR 0022）——返回 true；完全空闲且不在排队时幂等返回 false。
   */
  interrupt(taskId: string): Promise<boolean>;
  /**
   * 输入队列手动恢复（票 02）：清除队列暂停标志并立即从队首继续逐条消费；
   * 返回操作生效后的队列快照与暂停标志（未暂停时幂等无副作用）。
   */
  queueResume(taskId: string): Promise<QueueOperationResult>;
  /**
   * 输入队列清空（票 02）：作废删除全部排队消息并清除暂停标志（无残留）；
   * 返回操作生效后的队列快照与暂停标志。
   */
  queueClear(taskId: string): Promise<QueueOperationResult>;
  /** 立即作废指定排队消息；已发出或跨任务条目拒绝修改。 */
  queueRemove(taskId: string, itemId: string): Promise<QueueOperationResult>;
  /**
   * 原地编辑排队消息（票 03）：内容更新、位置与参数快照不变。
   * expectedText 为取回编辑时的原文（CAS）：他窗口先改或条目已取出发送则拒绝。
   */
  queueUpdate(
    taskId: string,
    itemId: string,
    text: string,
    expectedText: string,
    mentionPaths?: string[]
  ): Promise<QueueOperationResult>;
  /** 拖拽重排（票 03）：orderedIds 须为仍在排队条目的完整排列。 */
  queueReorder(
    taskId: string,
    orderedIds: string[]
  ): Promise<QueueOperationResult>;
  /** 重命名（/rename 与侧栏等效 UI 操作共用）；任务不存在返回 null */
  rename(taskId: string, title: string): Promise<TaskRecord | null>;
  /** 归档（/archive 与侧栏等效 UI 操作共用）；archived=false 取消归档 */
  archive(taskId: string, archived: boolean): Promise<TaskRecord | null>;
  /** /status 数据；任务不存在返回 null */
  status(taskId: string): Promise<TaskStatusInfo | null>;
  /** 只返回资源元数据与加载记录，不返回全部技能正文。 */
  resources(taskId: string): Promise<TaskResourcesView | null>;
  /**
   * draft 态（首条消息前无任务记录）按工作区路径预览规范与技能：
   * 与 tasks.resources 的 preview 同构（active/last 恒空），只返回元数据。
   */
  draftResources(workspacePath: string): Promise<TaskResourcesView>;
  /**
   * /compact：用所选 Provider Profile 的模型压缩历史为摘要（保留最近 3 轮）。
   * model 为压缩所用具体模型（票 02 二元组）；缺省回退 Profile 列表第一项。
   * 压缩失败（模型错误 / 历史过短 / 任务正忙）以异常抛回，原历史不受损，可重试。
   */
  compact(
    taskId: string,
    providerProfileId: string,
    model?: string
  ): Promise<{ compactedMessages: number }>;
  /** @引用 菜单候选（工作区文件相对路径，POSIX 分隔符） */
  workspaceFiles(taskId: string): Promise<string[]>;
  /**
   * 工具调用截图（browser_screenshot）的图片数据：`data:image/png;base64,…`。
   * 文件不存在（其它数据目录 / 已清理 / 非截图调用）返回 null。
   */
  toolImage(taskId: string, toolCallId: string): Promise<string | null>;
  /** 仅撤销持久任务授权；启用只能来自有效的执行审批响应。 */
  revokeAutoApprove(taskId: string): Promise<TaskRecord>;
  /** 切换审批模式（ask / assist / full-access），只对下一次发送生效；任务不存在返回 null */
  setApprovalMode(
    taskId: string,
    mode: ApprovalMode
  ): Promise<TaskRecord | null>;
  /**
   * 兼容旧审批响应（always 与 approve 同义，仅批准本次）；
   * 转发统一交互，没有等待中的请求或 id 不匹配时返回 false。
   */
  respondApproval(
    taskId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<boolean>;
  /** 当前等待审批的请求（UI 切回任务时恢复审批卡片）；无等待或任务不存在返回 null */
  pendingApproval(taskId: string): Promise<ApprovalRequest | null>;
  /** 全部等待审批的请求（含子代理并行等待，工单 13）；无等待返回空数组 */
  pendingApprovals(taskId: string): Promise<ApprovalRequest[]>;
  /** 全部待处理交互；切回任务时与实时事件合并，已结束请求不重新激活。 */
  pendingInteractions(taskId: string): Promise<InteractionRecord[]>;
  /** false 表示请求已结束或不存在；校验失败抛错且不消耗请求。 */
  respondInteraction(
    taskId: string,
    requestId: string,
    response: InteractionResponse
  ): Promise<boolean>;
  /**
   * /goal 设定目标（ADR 0035，GLOSSARY「目标」）：目标落库为「进行中」，原文
   * 作为首条用户消息发出（首轮，事件经 onTaskEvent 推送），返回目标记录。
   * 一任务同时至多一个未结束的目标；空目标 / 超长 / 任务已归档 / 任务正在
   * 执行 / 已有未结束的目标以中文异常抛回。首轮启动失败时目标回滚（不落库）。
   */
  goalSet(
    taskId: string,
    text: string,
    options?: GoalSendOptions
  ): Promise<GoalRecord>;
  /**
   * 恢复目标（ADR 0035 控制面，GLOSSARY「目标」）：已暂停 / 预算受限 / 未达成的
   * 目标转回「进行中」，宿主随即以内部输入从暂停点发起下一轮（不产生用户气泡），
   * 累计时长与逐轮验证记录延续。返回恢复后的目标记录（进行中）。
   * 任务有在途回合 / 等待用户交互 / 任务排队中、任务已归档、目标不在可恢复的
   * 状态（越界转换由状态机以中文错误拒绝）均抛错且不改目标状态；下一轮没能
   * 发起时目标回到已暂停，原因随状态快照下发（进度行的暂停原因）并抛回。
   */
  goalResume(taskId: string): Promise<GoalRecord>;
  /**
   * 编辑目标文本（ADR 0035 控制面，GLOSSARY「目标」）：原地更新当前目标的文本
   * （首尾去空白；非空且不超过长度上限），返回更新后的目标记录。目标状态、累计
   * 时长与逐轮验证记录都不动；下一次完成判定按新文本发起。
   * 只在可编辑的状态下允许（已暂停 / 预算受限 / 未达成）——进行中、已完成、
   * 已清除、无目标、任务已归档、空文本、超长均以中文异常抛回且原文不变。
   */
  goalEdit(taskId: string, text: string): Promise<GoalRecord>;
  /**
   * 清除目标（ADR 0035 控制面，GLOSSARY「目标」）：目标转「已清除」并下发完整
   * 快照，任务回到普通对话形态——输入队列恢复自动消费、并发名额让出；逐轮
   * 验证记录仍随任务留痕。返回已清除的目标记录。
   * 进行中清除时循环立即收场：在途回合或完成判定一并中断，不判定、不续跑。
   * 无目标、任务已归档、目标已清除（重复清除）以中文异常抛回且无副作用。
   */
  goalClear(taskId: string): Promise<GoalRecord>;
  /**
   * 设定 / 调整当前目标的 token 预算（ADR 0035「护栏」，票 05）：返回更新后的目标
   * 记录，同时下发 goal-changed 快照。只对未结束的目标生效（进行中 / 已暂停 /
   * 预算受限 / 未达成）；预算须为正整数（tokens），任务不存在 / 无目标 /
   * 目标已结束以中文异常抛回。预算受限的目标加预算后不自动恢复——恢复经
   * 控制面（goalResume）。
   */
  goalSetBudget(taskId: string, tokens: number): Promise<GoalRecord>;
}

/** `window.codexlike` 的完整 API 形状（续：任务域之外的设置与事件面） */
export interface CodexLikeApi {
  searchSettings: {
    /** 当前搜索源设置（apiKey 已解密，仅存在于渲染进程内存；'' 表示未配置） */
    get(): Promise<SearchSettings>;
    /** 保存搜索源 API key（空字符串清除）；safeStorage 不可用时以异常抛回 */
    set(input: { apiKey: string }): Promise<SearchSettings>;
  };
  subagentSettings: {
    /** 当前子代理全局设置（模型引用 null = 同主模型；并发上限默认 3） */
    get(): Promise<SubagentSettings>;
    /**
     * 保存子代理设置（providerProfileId 不存在或 null 时以异常抛回——引用必须有效）；
     * 改动对后续任务/下一次委派生效。
     */
    set(input: SubagentSettings): Promise<SubagentSettings>;
  };
  agentSettings: {
    /**
     * 当前执行设置（GLOSSARY「执行设置」，ADR 0017）：主任务/子代理工具轮次
     * 上限（默认 200）、压缩保留对话轮数（默认 3）、上下文告警阈值百分比
     * （默认 80）、MCP 工具调用超时（默认 30 秒）与连接超时（默认 15 秒）、
     * 任务并发上限（默认 3，GLOSSARY「任务并发上限」，desktop 主进程发送
     * 闸门消费、不经 agent-core）——七项中前六项默认值与现状一致。
     */
    get(): Promise<AgentSettings>;
    /**
     * 保存执行设置（七项各自范围与整数校验：轮次 10–1000、保留轮数 1–10、
     * 阈值 50–95、MCP 调用超时 5–300 秒与连接超时 5–120 秒、任务并发上限
     * 1–8，非法值以中文异常抛回——UI 侧非法输入先回退默认再保存）；轮次上限
     * 对下一个回合/委派生效（开始时快照），保留轮数对下一次 /compact 生效、
     * 告警阈值即时生效、MCP 超时对下一次连接/工具调用生效（均逐次读取，
     * ADR 0017），任务并发上限对队列即时生效。
     */
    set(input: AgentSettings): Promise<AgentSettings>;
  };
  terminalSettings: {
    /**
     * 已保存的终端设置（shell 偏好 + 命令超时两项，执行设置票04）；
     * shell 为 null 表示未配置（此时 CODEXLIKE_SHELL 环境变量兜底），超时为默认值。
     */
    get(): Promise<TerminalSettings>;
    /**
     * 保存终端设置（shell 枚举 + 命令超时 5-600s + 最大命令超时 10-1800s，
     * 且命令超时 ≤ 最大命令超时），对下一次终端命令即时生效；非法输入以中文异常抛回。
     */
    set(settings: TerminalSettings): Promise<TerminalSettings>;
  };
  themeSettings: {
    /** 已保存的外观主题；未配置返回 null（UI 以浅色兜底，ADR 0006） */
    get(): Promise<ThemeName | null>;
    /** 保存主题偏好（light / dark），立即生效并同步原生窗口底色 */
    set(theme: ThemeName): Promise<ThemeName>;
  };
  traySettings: {
    /**
     * 当前托盘设置（GLOSSARY「开机启动」默认关、驻留气泡只提示一次）；
     * residencyHintShown 为内部标志，set 通道不接受它。
     */
    get(): Promise<TraySettings>;
    /**
     * 保存开机启动开关；主进程同步登录项（app.setLoginItemSettings，
     * 开发模式跳过）与托盘菜单勾选态。
     */
    set(input: { launchAtLogin: boolean }): Promise<TraySettings>;
    /** 订阅开关变更（托盘菜单切换时已打开的设置页实时刷新）；返回取消订阅函数 */
    onLaunchAtLoginChanged(listener: (enabled: boolean) => void): () => void;
  };
  launchState: {
    /** 启动现场（无文件/损坏返回 null）；冷启动恢复工作台目标与视图初始值 */
    get(): Promise<LaunchState | null>;
    /** 上报工作台目标变更（切换任务 / 进出新建草稿），与窗口现场合并落盘 */
    setWorkbenchTarget(target: WorkbenchTarget): Promise<LaunchState>;
    /** 上报顶层视图变更（工作区 / 设置），与目标、窗口现场合并落盘 */
    setView(view: LaunchView): Promise<LaunchState>;
  };
  mcp: {
    /** 全部 MCP server：配置 + 连接状态 + 发现到的工具（含启停） */
    overview(): Promise<{ servers: McpServerView[] }>;
    /** 添加 server（保存配置并立即连接）；输入不合法以中文异常抛回 */
    addServer(input: McpServerInput): Promise<McpServerView>;
    /** 删除 server（断开连接）；不存在返回 false */
    removeServer(id: string): Promise<boolean>;
    /** 手动重连（崩溃/启动失败后的显式重连入口） */
    reconnect(id: string): Promise<McpServerView>;
    /** 工具启停：对后续任务消息即时生效 */
    setToolEnabled(toolName: string, enabled: boolean): Promise<void>;
  };
  /** 订阅任务事件流（task:events channel）；返回取消订阅函数 */
  onTaskEvent(listener: (envelope: TaskEventEnvelope) => void): () => void;
  /** 终端会话操作面（ADR 0033 票03）：字节流专用订阅 + 生命周期 + 操作 */
  terminals: TerminalApi;
  /** 剪贴板读桥（终端粘贴用，ClipboardApi 注释） */
  clipboard: ClipboardApi;
  /** 改动面板 + git 集成（工单 05） */
  git: {
    /** 工作区 git 状态；非 git 工作区返回 isGitRepo=false（面板显示降级提示） */
    status(taskId: string): Promise<GitStatus>;
    /** 单文件改动（新旧两侧全文）；oldPath 为重命名场景的原路径 */
    diff(taskId: string, path: string, oldPath?: string): Promise<GitFileDiff>;
    /** 创建（或切换到已存在的）任务分支 */
    createBranch(taskId: string): Promise<GitBranchResult>;
    /** 模型按任务内容生成提交消息草稿（可编辑后提交）；失败抛中文异常 */
    generateCommitMessage(
      taskId: string,
      providerProfileId: string
    ): Promise<string>;
    /** 提交当前全部变更；无变更时 committed=false */
    commit(taskId: string, message: string): Promise<GitCommitResult>;
  };
  openers: {
    /** 候选打开器（仅本机探测到的，资源管理器恒在）与当前生效默认 */
    list(): Promise<OpenerListResult>;
    /**
     * 打开工作区目录（GLOSSARY「工作区打开器」）：不带 openerId 用生效默认
     * （主按钮）；携带时以它打开并记为默认（点选即设置，打开失败不改默认）。
     * 目录不存在 / 未检测到所选程序 / 启动失败以中文异常抛回。
     */
    open(input: OpenerOpenInput): Promise<OpenerOpenResult>;
  };
}
