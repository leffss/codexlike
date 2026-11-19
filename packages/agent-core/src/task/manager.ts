import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";

import type { LanguageModel } from "ai";

import type {
  AgentResourceSnapshot,
  TaskResourceState,
} from "../context/resource-types";
import {
  createLanguageModelFromProfile,
  type ThinkingEffort,
} from "../provider/language-model";
import type { ProviderProfile } from "../provider/provider-profile";
import type { ToolDefinition } from "../tools/types";

import { createAgentTask, type AgentTask } from "./agent-task";
import type { ApprovalMode } from "./approval";
import type { TaskPersistence } from "./persistence";
import type { TaskSearchResult } from "./search";
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
    return item.kind === "message"
      ? item.message.createdAt
      : item.kind === "interaction"
        ? item.interaction.request.createdAt
        : item.call.createdAt;
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
  };
}
