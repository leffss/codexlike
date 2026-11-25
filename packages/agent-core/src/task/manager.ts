import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";

import type { LanguageModel } from "ai";

import type {
  AgentResourceSnapshot,
  TaskResourceState,
} from "../context/resource-types";
import {
  GOAL_TEXT_MAX_LENGTH,
  type GoalRecord,
  type GoalVerdict,
  type GoalVerificationOutcome,
  type GoalVerificationRecord,
} from "../goal/types";
import {
  advanceGoal,
  isGoalOpen,
  type GoalTransition,
} from "../goal/state-machine";
import {
  buildGoalVerificationPrompt,
  requestGoalVerdict,
  unavailableGoalVerdict,
  type GoalVerdictResult,
  type GoalVerificationResult,
} from "../goal/verifier";
import {
  createLanguageModelFromProfile,
  type ThinkingEffort,
} from "../provider/language-model";
import {
  resolveModelOf,
  type ProviderProfile,
} from "../provider/provider-profile";
import type { TerminalSessionRecord } from "../terminal/types";
import type { ToolDefinition } from "../tools/types";

import { createAgentTask, type AgentTask } from "./agent-task";
import type { ApprovalMode } from "./approval";
import { DEFAULT_MODEL_MAX_RETRIES } from "./execution-settings";
import type { TaskPersistence } from "./persistence";
import type { TaskSearchResult } from "./search";
import { settleTaskUsage } from "./usage";
import { workbenchKey } from "./workbench-state";
import type { SubagentsConfig } from "./subagent";
import type {
  CompactRecord,
  MentionAttachment,
  ProjectRecord,
  SubagentSnapshot,
  TaskRecord,
  TaskUsageDelta,
  StoredMessage,
  TranscriptItem,
} from "./types";

export interface CreateTaskManagerOptions {
  persistence: TaskPersistence;
  /**
   * 任务可用的工具（空/缺省 = 纯对话；内置六件工具见 tools/builtin）。
   * 工厂形式让 desktop 装配把 MCP 工具的启停/连接状态逐次解析进每条消息（工单 12）。
   */
  tools?: ToolDefinition[] | (() => ToolDefinition[]);
  /**
   * 子代理编排配置（工单 13）：传入即向任务工具表追加 spawn_subagent。
   * tools 同时作为子代理的完整工具集（编排器剔除 spawn_subagent 防递归）。
   */
  subagents?: SubagentsConfig;
  /**
   * 主任务工具轮次上限的逐次解析取值函数（执行设置 ADR 0017）：原样透传给每个
   * 任务的 createAgentTask，回合开始时快照（GLOSSARY「工具轮次」）；
   * 未注入用默认 200。
   */
  toolRoundsLimit?: () => number;
  /**
   * /compact 保留最近原始对话轮数的逐次解析取值函数（执行设置票 03，ADR 0017）：
   * 原样透传给每个任务的 createAgentTask，compact 执行时读取一次（无回合快照）；
   * 未注入用默认 3。
   */
  compactKeepRounds?: () => number;
  /**
   * 模型请求重试次数的逐次解析取值函数（GLOSSARY「执行设置」，ADR 0024）：
   * 原样透传给每个任务的 createAgentTask（对话回合开始快照，compact 逐次读取）；
   * 未注入用默认 2（与 SDK 默认一致）。
   */
  modelMaxRetries?: () => number;
  /**
   * Provider Profile → 语言模型 的工厂；测试注入 mock，默认 OpenAI 兼容构造。
   * options 携带本条消息的思考档位快照（与 agent-task / subagent 的同名
   * 注入点签名对齐）；少参（0/1 参）工厂仍可注入——不关心档位的调用方不受影响。
   */
  languageModelFor?: (
    profile: ProviderProfile,
    options?: { thinkingEffort?: ThinkingEffort }
  ) => LanguageModel;
  /**
   * 任务系统提示工厂（AGENTS.md 发现 → 组装由宿主注入，agent-core 不依赖 fs）。
   * create 与 get 恢复时各调用一次。
   */
  systemPromptFor?: (record: TaskRecord) => string;
  /** 每条消息开始时刷新规范与技能目录；不会因读取状态而构建。 */
  resourcesFor?: (record: TaskRecord) => AgentResourceSnapshot;
  /** 工具截图是否作为图片附给模型（默认 true；纯文本端点在装配层关掉走降级路径） */
  attachToolImages?: boolean;
  now?: () => string;
  generateId?: () => string;
}

/**
 * 任务管理器：desktop 主进程的装配入口。
 * - `create`：新建任务（绑定工作区）并落库；
 * - `list` / `messages`：直接读持久层（应用启动时渲染侧栏与消息历史）；
 * - `get`：惰性恢复任务对象（读历史重建上下文；残留 streaming 状态重置为 idle）；
 * - `rename` / `setArchived`：/rename、/archive 命令与侧栏等效 UI 操作共用的落点。
 */
export interface TaskManager {
  readWorkbench(key: string): import("./workbench-state").WorkbenchEntry | null;
  writeWorkbench(
    key: string,
    entry: import("./workbench-state").WorkbenchEntry
  ): boolean;
  addProject(workspacePath: string): ProjectRecord;
  projects(): ProjectRecord[];
  removeProject(projectId: string): string[];
  isRemovedCreationRequest(requestId: string): boolean;
  setProjectCollapsed(
    projectId: string,
    collapsed: boolean
  ): ProjectRecord | null;
  setProjectPinned(projectId: string, pinned: boolean): ProjectRecord | null;
  setPinned(taskId: string, pinned: boolean): TaskRecord | null;
  markUsed(taskId: string): TaskRecord | null;
  removeUnstarted(taskId: string): void;
  /** 宿主完成目录与活动检查后，仅同步更改归属。 */
  setProject(taskId: string, projectId: string | null): TaskRecord | null;
  create(options: {
    projectId?: string | null;
    creationRequestId?: string;
    approvalMode?: ApprovalMode;
    workspacePath: string;
    title?: string;
    /** 运行位置（默认 local 本目录直跑；worktree 由宿主先检出副本再传入其路径） */
    workspaceMode?: "local" | "worktree";
    /**
     * worktree 模式：用户所选的原始仓库路径（ADR 0005，侧栏项目聚合键）；
     * local 模式不传（origin 恒为 null，工作区即原始目录）。
     */
    workspaceOriginPath?: string;
    /** 任务 id（默认随机生成）；worktree 模式由宿主传入与副本目录同名的 id */
    id?: string;
  }): AgentTask;
  /** 全部任务记录（含已归档），置顶优先、最近使用倒序。 */
  list(): TaskRecord[];
  search(query: string, includeArchived?: boolean): TaskSearchResult[];
  /** 指定任务的消息历史（读持久层，不实例化任务对象） */
  messages(taskId: string): StoredMessage[];
  /**
   * 任务用量入账（GLOSSARY「任务用量」，ADR 0029）：宿主为任务域辅助调用
   * （如 commit 消息生成）补记真实 usage；不存在任务静默忽略（与持久层同语义）。
   */
  addUsage(taskId: string, delta: TaskUsageDelta): void;
  /**
   * 补记一条已发送未回复的用户消息（任务并发上限 review 修复 / ADR 0022
   * 「中断排队出队回空闲，已发消息保留」）：排队首条被中断出队时由宿主
   * 把快照文本补落进消息流——呈现为已发出、未获回复，不触发执行；后续
   * sendMessage 的上下文组装照常包含它。任务不存在返回 null。
   */
  appendUserMessage(
    taskId: string,
    message: { content: string; mentions?: MentionAttachment[] }
  ): StoredMessage | null;
  /** 持久交互记录不随上下文压缩消失；仅用于历史与草稿归属校验，不恢复等待。 */
  interactions(
    taskId: string
  ): import("../interaction/types").InteractionRecord[];
  /** 指定任务的时间线：消息与工具调用按发生顺序合并（UI 渲染与恢复用） */
  transcript(taskId: string): TranscriptItem[];
  /**
   * 子代理恢复快照（ADR 0021 票 03）：骨架+逐轮消息+工具调用一次读出、
   * 按委派归组（含重启收尾补记的 interrupted 骨架）。恢复数据面经 view
   * 载荷的并行字段发给 UI；模型上下文组装不读这里（与 transcript 分离）。
   */
  subagents(taskId: string): SubagentSnapshot[];
  /**
   * 终端会话恢复快照（ADR 0033 票 08）：任务内会话行一次读出（含重启收尾
   * 置终态的行，快照随行，按创建顺序）。恢复数据面经 view 载荷的并行字段
   * 发给 UI 的「已退出」组；模型上下文组装不读这里——快照不进上下文，
   * 与子代理记录同口径（结构性保证：本方法只有 view 并行字段一个消费者）。
   */
  terminalSessions(taskId: string): TerminalSessionRecord[];
  /** 惰性恢复任务对象；不存在返回 null；同 id 返回缓存实例 */
  get(taskId: string): AgentTask | null;
  /** 只读缓存实例的运行/最近一轮摘要；未实例化任务返回空状态。 */
  resourceState(taskId: string): TaskResourceState;
  /** /rename：更新标题并落库；不存在返回 null */
  rename(taskId: string, title: string): TaskRecord | null;
  /** /archive：archived=true 记归档时间，false 取消归档；不存在返回 null */
  setArchived(taskId: string, archived: boolean): TaskRecord | null;
  /**
   * 审批模式切换（三档）：落库并更新下次发送偏好；当前执行及子代理不受影响。
   * 不改变最近使用时间；不存在返回 null。
   */
  setApprovalMode(taskId: string, mode: ApprovalMode): TaskRecord | null;
  /** 撤销本任务自动批准，立即作用后续审批；未知任务抛错。 */
  revokeAutoApprove(taskId: string): TaskRecord;
  /** 最近一次 compact 记录（/status「已压缩」标记）；从未压缩为 null */
  latestCompact(taskId: string): CompactRecord | null;
  cancelInteractions(reason: string): void;
  /**
   * 设定目标（GLOSSARY「目标」，ADR 0035）：目标原文同时充当首条指令与完成
   * 判定标准，设定即为「进行中」。一任务同时至多一个未结束的目标——上一目标
   * 仍在进行中/已暂停/预算受限时抛错。返回落库后的目标记录。
   */
  setGoal(taskId: string, text: string): GoalRecord;
  /** 当前目标（最近一次设定；从未设定为 null） */
  goal(taskId: string): GoalRecord | null;
  /**
   * 推进当前目标的状态机（六态转换表见 goal/state-machine）：落库并返回
   * 新记录。越界转换、无目标、任务不存在以中文错误拒绝。
   * 累计时长随转换记账：离开进行中闭合当前段，进入进行中另起一段。
   */
  transitionGoal(taskId: string, transition: GoalTransition): GoalRecord;
  /**
   * 撤销尚未执行的目标（宿主在首轮启动失败时的回滚：设定与首轮是一个意图，
   * 首轮没起来就不留「进行中却没有回合」的半成品）。当前目标已有验证记录
   * （首轮已执行）时拒绝——验证历史随任务留痕，不产生悬空记录。无目标时幂等。
   */
  discardGoal(taskId: string): void;
  /**
   * 完成判定（GLOSSARY「完成判定」，ADR 0035）：对「进行中」的目标发起一次
   * 独立模型请求（任务当前模型、不带工具、输入 = 目标文本 + 完整消息历史），
   * 结论落为下一轮验证记录。只落记录与逐轮记账、不改目标状态——通过/未通过
   * 的后续处置由宿主编排器决定（通过 → 完成；未通过 → 续跑）。
   * 必须在回合空闲边界调用（与 sendMessage / compact 不并发）。
   * 目标已不在进行中（如等待期间被暂停）时返回 skipped，不发请求；
   * 判定在途被中断返回 aborted，不留结论。
   * profile 为任务上次发送所用的 Provider Profile（宿主在主进程解密后传入）；
   * 缺省表示任务当前模型不可用，记为「判定不可用」。
   * toolActivity：刚结束的这一轮是否有实质工具活动（宿主按本轮事件统计，
   * 定义见 isGoalToolActivity；缺省按「有」计）——空转计数只对「未过且无
   * 活动」的轮次累加，结果落为目标记录上的 idleStreak / failureStreak。
   */
  verifyGoal(
    taskId: string,
    options?: {
      profile?: ProviderProfile;
      signal?: AbortSignal;
      toolActivity?: boolean;
    }
  ): Promise<GoalVerificationResult>;
  /** 当前目标的逐轮验证记录（按轮次正序）；无目标为空数组 */
  goalVerifications(taskId: string): GoalVerificationRecord[];
}

export function createTaskManager(
  options: CreateTaskManagerOptions
): TaskManager {
  const { persistence } = options;
  const languageModelFor =
    options.languageModelFor ?? createLanguageModelFromProfile;
  const systemPromptFor = options.systemPromptFor;
  const now = options.now ?? (() => new Date().toISOString());
  const generateId = options.generateId ?? randomUUID;

  const cache = new Map<string, AgentTask>();
  // 启动即终结所有残留请求：transcript 可在 get 前读取，绝不重放待执行工具。
  for (const task of persistence.listTasks()) {
    const interactions = persistence.listInteractions(task.id);
    const unfinished =
      task.status !== "idle" ||
      interactions.some((item) => item.status === "pending");
    for (const interaction of interactions) {
      if (interaction.status === "pending")
        persistence.settleInteraction({
          ...interaction,
          status: "cancelled",
          resolvedAt: now(),
          cancelReason: "应用已重启，原执行已结束",
        });
    }
    // 子代理骨架行收尾（ADR 0021，与 pending 交互收尾同款思路）：残留
    // queued/running 的委派随原进程一起消失，补记 interrupted 终态留痕
    // （排队中被杀的委派也有「曾委派过」的事实）；终态行不再改写。
    for (const subagent of persistence.listSubagents(task.id)) {
      if (subagent.status === "queued" || subagent.status === "running") {
        persistence.updateSubagent(subagent.id, {
          status: "interrupted",
          completedAt: now(),
        });
      }
    }
    if (unfinished) {
      // 只恢复历史中断点，不构建模型或重放工具。复用 aborted 消息，二次重开幂等。
      if (!persistence.listMessages(task.id).at(-1)?.aborted)
        persistence.insertMessage({
          id: generateId(),
          taskId: task.id,
          role: "assistant",
          content: "上次执行因应用退出而中断；如需继续，请明确发送新消息。",
          aborted: true,
          createdAt: now(),
        });
      persistence.updateTask(task.id, { status: "idle" });
    }
  }

  function createdAtOf(item: TranscriptItem): string {
    if (item.kind === "message") return item.message.createdAt;
    if (item.kind === "interaction") return item.interaction.request.createdAt;
    if (item.kind === "goal-verification") return item.verification.createdAt;
    return item.call.createdAt;
  }

  function restore(record: TaskRecord): AgentTask {
    const history = persistence.listMessages(record.id);
    // 上次退出时若流式/等待审批中途被杀，库里会残留 streaming / waiting-approval；恢复即视为空闲
    if (record.status === "streaming" || record.status === "waiting-approval") {
      const patched: TaskRecord = { ...record, status: "idle" };
      persistence.updateTask(record.id, { status: "idle" });
      return createCachedTask(patched, history);
    }
    return createCachedTask(record, history);
  }

  function createCachedTask(
    record: TaskRecord,
    history: StoredMessage[]
  ): AgentTask {
    const task = createAgentTask({
      record,
      persistence,
      history,
      tools: options.tools,
      subagents: options.subagents,
      toolRoundsLimit: options.toolRoundsLimit,
      compactKeepRounds: options.compactKeepRounds,
      modelMaxRetries: options.modelMaxRetries,
      systemPrompt: systemPromptFor?.(record) ?? "",
      resources:
        options.resourcesFor === undefined
          ? undefined
          : () => options.resourcesFor!(record),
      attachToolImages: options.attachToolImages,
      languageModelFor,
      approvalMode: record.approvalMode,
      now,
      generateId,
    });
    cache.set(record.id, task);
    return task;
  }

  /** 读取最新记录并应用补丁（rename / setArchived 共用）；同步刷新缓存实例的 record */
  function patchRecord(
    taskId: string,
    patch: Partial<Omit<TaskRecord, "id" | "createdAt">>
  ): TaskRecord | null {
    const current = persistence
      .listTasks()
      .find((candidate) => candidate.id === taskId);
    if (current === undefined) {
      return null;
    }
    persistence.updateTask(taskId, patch);
    const next = { ...current, ...patch };
    const cached = cache.get(taskId);
    if (cached !== undefined) {
      Object.assign(cached.record, next);
    }
    return next;
  }

  /** 当前目标（最近一次设定）的逐轮验证记录，按轮次正序；无目标为空数组 */
  function currentGoalVerifications(taskId: string): GoalVerificationRecord[] {
    const goal = persistence.listGoals(taskId).at(-1);
    if (goal === undefined) return [];
    return persistence
      .listGoalVerifications(taskId)
      .filter((record) => record.goalId === goal.id);
  }

  /** 把一次判定的结局落为下一轮验证记录（轮次 = 该目标已有记录数 + 1） */
  function recordVerification(
    taskId: string,
    goal: GoalRecord,
    verdict: GoalVerdict,
    round: Pick<GoalVerificationRecord, "outcome" | "toolActivity">
  ): GoalVerificationRecord {
    const verification: GoalVerificationRecord = {
      id: generateId(),
      taskId,
      goalId: goal.id,
      round: currentGoalVerifications(taskId).length + 1,
      passed: verdict.passed,
      outcome: round.outcome,
      reason: verdict.reason,
      nextAction: verdict.nextAction,
      toolActivity: round.toolActivity,
      createdAt: now(),
    };
    persistence.insertGoalVerification(verification);
    return verification;
  }

  return {
    readWorkbench: (key) => persistence.readWorkbench(key),
    writeWorkbench: (key, entry) => persistence.writeWorkbench(key, entry),
    addProject(workspacePath) {
      if (!isAbsolute(workspacePath)) throw new Error("项目目录必须是绝对路径");
      let path: string;
      try {
        path = realpathSync.native(workspacePath);
        if (!statSync(path).isDirectory()) throw new Error();
      } catch {
        throw new Error(`项目目录不存在或无法访问：${workspacePath}`);
      }
      const existing = persistence
        .listProjects()
        .find((project) => project.workspacePath === path);
      if (existing) return existing;
      const project = {
        id: generateId(),
        name: basename(path) || path,
        workspacePath: path,
        collapsed: false,
        pinned: false,
        createdAt: now(),
      };
      persistence.insertProject(project);
      return project;
    },
    projects: () => persistence.listProjects(),
    isRemovedCreationRequest: (id) => persistence.isRemovedCreationRequest(id),
    removeProject(projectId) {
      const removed = persistence.removeProject(projectId);
      for (const id of removed) cache.delete(id);
      return removed;
    },
    setProjectCollapsed(projectId, collapsed) {
      persistence.setProjectCollapsed(projectId, collapsed);
      return (
        persistence.listProjects().find((item) => item.id === projectId) ?? null
      );
    },
    setProjectPinned(projectId, pinned) {
      persistence.setProjectPinned(projectId, pinned);
      return (
        persistence.listProjects().find((item) => item.id === projectId) ?? null
      );
    },
    setProject(taskId, projectId) {
      return patchRecord(taskId, { projectId });
    },
    setPinned(taskId, pinned) {
      return patchRecord(taskId, { pinned });
    },
    markUsed(taskId) {
      return patchRecord(taskId, { lastUsedAt: now() });
    },
    cancelInteractions(reason) {
      for (const task of cache.values()) task.cancelInteractions(reason);
    },
    removeUnstarted(taskId) {
      if (persistence.listMessages(taskId).length)
        throw new Error("不能回滚已有历史的任务");
      persistence.removeUnstartedTask(taskId);
      cache.delete(taskId);
    },
    create({
      projectId = null,
      creationRequestId = null,
      approvalMode = "assist",
      workspacePath,
      title,
      workspaceMode = "local",
      id,
      workspaceOriginPath = null,
    }) {
      const timestamp = now();
      const record: TaskRecord = {
        // worktree 模式：宿主先检出托管 Worktree、以同一任务 id 落库（目录名 = 任务 id）
        id: id ?? generateId(),
        projectId,
        creationRequestId,
        title: title ?? (basename(workspacePath) || workspacePath),
        workspacePath,
        workspaceMode,
        workspaceOriginPath,
        providerProfileId: null,
        model: null,
        status: "idle",
        // 新建任务默认「帮我批准」（assist：写入与联网自动放行，仅危险命令审批）
        approvalMode,
        autoApprove: false,
        archivedAt: null,
        pinned: false,
        lastUsedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      persistence.insertTask(record);
      return createCachedTask(record, []);
    },

    list() {
      return persistence.listTasks();
    },
    search: (query, includeArchived) =>
      persistence.searchTasks(query, includeArchived),

    messages(taskId) {
      return persistence.listMessages(taskId);
    },

    addUsage(taskId, delta) {
      persistence.addTaskUsage(taskId, delta);
    },

    appendUserMessage(taskId, message) {
      const record = persistence
        .listTasks()
        .find((candidate) => candidate.id === taskId);
      if (record === undefined) return null;
      const stored: StoredMessage = {
        id: generateId(),
        taskId,
        role: "user",
        content: message.content,
        mentions:
          message.mentions !== undefined && message.mentions.length > 0
            ? message.mentions
            : undefined,
        createdAt: now(),
      };
      persistence.insertMessage(stored);
      // 缓存任务对象的上下文一次性构建于创建/恢复时：空闲任务（本接口的
      // 调用契约——中断排队出队场景恒空闲）丢弃缓存让下一次 get 从持久层
      // 重建，补记消息随之进入后续执行的模型上下文（与重启恢复同构）；
      // 非空闲属调用方违约，只落库不动缓存。
      if (cache.has(taskId) && record.status === "idle") cache.delete(taskId);
      return stored;
    },

    interactions: (taskId) => persistence.listInteractions(taskId),

    transcript(taskId) {
      const messages = persistence.listMessages(taskId);
      const turnIds = new Set(messages.map((message) => message.id));
      const savedDrafts =
        persistence.readWorkbench(
          workbenchKey({ kind: "task", taskId: taskId })
        )?.value.questionDrafts ?? {};
      const items: TranscriptItem[] = [
        ...persistence
          .listMessages(taskId)
          .map((message): TranscriptItem => ({ kind: "message", message })),
        ...persistence
          .listToolCalls(taskId)
          .map((call): TranscriptItem => ({ kind: "tool-call", call })),
        ...persistence
          .listInteractions(taskId)
          // 压缩只裁模型上下文；有未提交文本的终态问答仍供用户只读查看。
          .filter(
            (interaction) =>
              turnIds.has(interaction.request.turnId) ||
              (interaction.status === "cancelled" &&
                Object.hasOwn(savedDrafts, interaction.request.id))
          )
          .map((interaction): TranscriptItem => ({
            kind: "interaction",
            interaction,
          })),
        // 目标模式的逐轮完成判定（ADR 0035）：按判定时刻并入时间线——
        // 历次目标的记录都留痕（已清除/已完成目标的标记行仍可回看）
        ...persistence
          .listGoalVerifications(taskId)
          .map((verification): TranscriptItem => ({
            kind: "goal-verification",
            verification,
          })),
      ];
      // stable sort：同 createdAt 保持 messages 在前的插入顺序
      items.sort((a, b) =>
        createdAtOf(a) < createdAtOf(b)
          ? -1
          : createdAtOf(a) > createdAtOf(b)
            ? 1
            : 0
      );
      return items;
    },

    subagents(taskId) {
      const records = persistence.listSubagents(taskId);
      if (records.length === 0) return [];
      // 三表一次读出后按委派归组：骨架定序（排队时间正序），
      // 消息/工具行按写入序落进各自委派（双归属列 task_id + subagent_id）
      const messages = persistence.listSubagentMessages(taskId);
      const toolCalls = persistence.listSubagentToolCalls(taskId);
      return records.map((record) => ({
        record,
        messages: messages.filter((row) => row.subagentId === record.id),
        toolCalls: toolCalls.filter((row) => row.subagentId === record.id),
      }));
    },

    terminalSessions(taskId) {
      return persistence.listTerminalSessions(taskId);
    },

    get(taskId) {
      const cached = cache.get(taskId);
      if (cached !== undefined) {
        return cached;
      }
      const record = persistence
        .listTasks()
        .find((candidate) => candidate.id === taskId);
      if (record === undefined) {
        return null;
      }
      return restore(record);
    },

    resourceState(taskId) {
      return cache.get(taskId)?.resourceState ?? { active: null, last: null };
    },

    rename(taskId, title) {
      const trimmed = title.trim();
      if (trimmed === "") {
        throw new Error("任务名称不能为空");
      }
      return patchRecord(taskId, { title: trimmed, updatedAt: now() });
    },

    setArchived(taskId, archived) {
      return patchRecord(taskId, {
        archivedAt: archived ? now() : null,
        updatedAt: now(),
      });
    },

    /**
     * 审批模式切换：落库并更新缓存的下次发送偏好，不更改正在执行的快照。
     * 档位实际变更时自动撤销任务自动批准（反馈1：换档即收权），
     * 同档重复设置（每次发送都会同步偏好）不动授权状态。
     */
    setApprovalMode(taskId, mode) {
      const cached = cache.get(taskId);
      const current =
        cached?.record ??
        persistence.listTasks().find((candidate) => candidate.id === taskId);
      if (current === undefined) {
        return null;
      }
      if (current.approvalMode !== mode && current.autoApprove === true) {
        if (cached) {
          cached.setApprovalMode(mode);
          cached.revokeAutoApprove();
          return { ...cached.record };
        }
        return patchRecord(taskId, { approvalMode: mode, autoApprove: false });
      }
      const next = patchRecord(taskId, {
        approvalMode: mode,
      });
      if (next !== null) {
        cache.get(taskId)?.setApprovalMode(mode);
      }
      return next;
    },

    revokeAutoApprove(taskId) {
      const cached = cache.get(taskId);
      if (cached) {
        cached.revokeAutoApprove();
        return { ...cached.record };
      }
      const next = patchRecord(taskId, { autoApprove: false });
      if (!next) throw new Error(`任务不存在：${taskId}`);
      return next;
    },

    latestCompact(taskId) {
      const compacts = persistence.listCompacts(taskId);
      return compacts.length === 0 ? null : compacts[compacts.length - 1]!;
    },

    setGoal(taskId, text) {
      if (!persistence.listTasks().some((task) => task.id === taskId))
        throw new Error(`任务不存在：${taskId}`);
      const trimmed = text.trim();
      if (trimmed === "") throw new Error("目标不能为空");
      if (trimmed.length > GOAL_TEXT_MAX_LENGTH)
        throw new Error(`目标文本过长（最多 ${GOAL_TEXT_MAX_LENGTH} 字符）`);
      const current = persistence.listGoals(taskId).at(-1);
      if (current !== undefined && isGoalOpen(current.status))
        throw new Error("任务已有未结束的目标，请先清除当前目标");
      const timestamp = now();
      const goal: GoalRecord = {
        id: generateId(),
        taskId,
        text: trimmed,
        status: "active",
        activeMs: 0,
        activeSince: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        idleStreak: 0,
        failureStreak: 0,
      };
      persistence.insertGoal(goal);
      return { ...goal };
    },

    goal(taskId) {
      return persistence.listGoals(taskId).at(-1) ?? null;
    },

    transitionGoal(taskId, transition) {
      if (!persistence.listTasks().some((task) => task.id === taskId))
        throw new Error(`任务不存在：${taskId}`);
      const goal = persistence.listGoals(taskId).at(-1);
      if (goal === undefined) throw new Error("任务尚未设定目标");
      const next = advanceGoal(goal, transition, now());
      persistence.updateGoal(goal.id, {
        status: next.status,
        activeMs: next.activeMs,
        activeSince: next.activeSince,
        idleStreak: next.idleStreak,
        failureStreak: next.failureStreak,
        updatedAt: next.updatedAt,
      });
      return next;
    },

    /** 当前目标的验证记录（goalVerifications 与 verifyGoal 的轮次计数共用） */
    goalVerifications: currentGoalVerifications,

    discardGoal(taskId) {
      const goal = persistence.listGoals(taskId).at(-1);
      if (goal === undefined) return;
      if (currentGoalVerifications(taskId).length > 0)
        throw new Error("目标已开始执行，不能撤销");
      persistence.deleteGoal(goal.id);
    },

    async verifyGoal(taskId, { profile, signal, toolActivity = true } = {}) {
      const goal = persistence.listGoals(taskId).at(-1);
      if (goal === undefined || goal.status !== "active")
        return { kind: "skipped" };
      // 中断先于请求：不发请求（Stop / 应用退出时不留判定在途）
      if (signal?.aborted) return { kind: "aborted" };
      // 任务当前模型不可用（宿主解析不到任务上次所用 Provider Profile，
      // 如已被删除）：没有可用的判定模型，与请求故障同样记为判定不可用
      const settled: GoalVerdictResult | null =
        profile === undefined
          ? {
              kind: "unavailable",
              cause: "任务的 Provider Profile 不存在，请重新选择模型",
            }
          : await requestVerification(taskId, goal, profile, signal);
      if (settled === null) return { kind: "aborted" };
      // 结论种类与逐轮记账（票 03）：
      // - passed：通过；连续计数清零
      // - unpassed：判定正常给出未过；无实质工具活动则空转计数 +1，有则清零；
      //   连续故障计数清零
      // - unavailable：判定自身故障——没有结论，既不算通过也不算未达成；
      //   空转计数保持原值（故障轮不参与空转判定），连续故障计数 +1
      const outcome: GoalVerificationOutcome =
        settled.kind === "unavailable"
          ? "unavailable"
          : settled.verdict.passed
            ? "passed"
            : "unpassed";
      const idleStreak =
        outcome === "unavailable"
          ? goal.idleStreak
          : outcome === "unpassed" && !toolActivity
            ? goal.idleStreak + 1
            : 0;
      const failureStreak =
        outcome === "unavailable" ? goal.failureStreak + 1 : 0;
      // 连续计数是逐轮记账而非状态推进：不动 updatedAt（目标记录的更新时间
      // 只随状态机转换变化）
      persistence.updateGoal(goal.id, { idleStreak, failureStreak });
      const verdict =
        settled.kind === "unavailable"
          ? unavailableGoalVerdict(settled.cause)
          : settled.verdict;
      return {
        kind: "verified",
        verification: recordVerification(taskId, goal, verdict, {
          outcome,
          toolActivity,
        }),
      };
    },
  };

  /**
   * 发起一次判定请求并取回结局（不落库、不改目标状态）。返回 null 表示请求
   * 被中断（没有结论，也不落验证记录）。
   */
  async function requestVerification(
    taskId: string,
    goal: GoalRecord,
    profile: ProviderProfile,
    signal: AbortSignal | undefined
  ): Promise<GoalVerdictResult | null> {
    const { system, prompt } = buildGoalVerificationPrompt(goal, {
      messages: persistence.listMessages(taskId),
      toolCalls: persistence.listToolCalls(taskId),
    });
    // 模型请求重试次数逐次读取（GLOSSARY「执行设置」：与 compact 辅助调用同口径）
    const modelMaxRetries =
      options.modelMaxRetries?.() ?? DEFAULT_MODEL_MAX_RETRIES;
    const record = persistence.listTasks().find((task) => task.id === taskId);
    const { outcome, usage } = await requestGoalVerdict({
      // 任务当前模型（上一回合落库的具体模型；未发过消息回退 Profile 列表第一项）
      languageModel: languageModelFor(profile, {
        model: resolveModelOf(profile, record?.model ?? undefined),
      }),
      system,
      prompt,
      signal,
      maxRetries: modelMaxRetries,
    });
    // 任务用量（GLOSSARY「任务用量」，ADR 0029）：判定是任务内模型调用，
    // usage 入主任务列（已花的 token 照记；未结算不记，入账失败不影响判定）
    if (usage !== undefined) {
      await settleTaskUsage(
        usage,
        (delta) => persistence.addTaskUsage(taskId, delta),
        "main"
      );
    }
    return outcome;
  }
}
