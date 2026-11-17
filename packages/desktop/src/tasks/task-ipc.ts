import { existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";

import {
  APPROVAL_MODES,
  DEFAULT_TASK_CONCURRENCY_LIMIT,
  parseThinkingEffort,
  workbenchKey,
  type AgentResourceSnapshot,
  type ApprovalMode,
  type BrowserTaskManager,
  type MentionAttachment,
  type ProviderProfile,
  type TaskManager,
  type TaskRecord,
  type WorktreeService,
} from "@codexlike/agent-core/node";

import type { ProfileStore } from "../profiles/profile-store";
import type { TaskExitRuntime } from "../lifecycle/application-exit";
import { createInterruptRegistry } from "./interrupt-registry";
import {
  createMemoryInputQueueStore,
  createTaskInputQueues,
  type InputQueueStore,
  type QueuedMessage,
} from "./input-queue";
import { registerWorkbenchHandlers } from "./workbench-ipc";
import { createLiveTasks } from "./live-tasks";
import {
  createMemoryTaskQueueStore,
  createTaskQueueCoordinator,
  type TaskQueueStore,
} from "./task-queue";
import { createTaskManagement } from "./task-management";
import { createTaskMembership } from "./task-membership";
import { readMentionAttachments } from "./mentions";
import { screenshotPathFor } from "./screenshots";
import { buildTaskStatus } from "./status";
import { listWorkspaceFiles } from "./workspace-files";
import { prepareTaskWorkspace } from "./worktree-flow";
import { canonicalWorkspacePath, workspaceSharing } from "./workspace-sharing";
import {
  IPC,
  type QueueOperationResult,
  type QueueSnapshot,
  type TaskEventEnvelope,
  type StartTaskInput,
  type WorkspaceSharingTarget,
} from "../shared/ipc";

/** 注册任务相关 IPC 指令；事件流经 task:events 推送给主窗口 */
export function registerTaskHandlers(options: {
  manager: TaskManager;
  profiles: ProfileStore;
  getWindow: () => BrowserWindow | null;
  /** 队列状态属于任务：所有工作台窗口都接收同一权威事件。 */
  getWindows?: () => BrowserWindow[];
  /** 应用数据目录（截图读回的路径约定；工单 11） */
  dataDir: string;
  /** 浏览器任务管理器（任务归档时释放其浏览器 context；工单 11） */
  browserManager?: BrowserTaskManager;
  /** 托管 Worktree 服务：首次发送创建隔离副本，不按数量清理。 */
  worktreeService: WorktreeService;
  /** 与真实发送共用的发现工厂；预览不会替换运行中的快照。 */
  /** 只用 workspacePath 发现快照；draft 预览传 { workspacePath } 即可复用同一实现。 */
  resourcesFor: (record: { workspacePath: string }) => AgentResourceSnapshot;
  /** 输入队列持久化（票 01 / ADR 0013）：同一 SQLite 库的独立连接；缺省内存（单测装配）。 */
  queueStore?: InputQueueStore;
  /**
   * 任务并发上限 resolver（任务并发上限票 02，ADR 0022）：读主进程执行设置
   * 内存缓存，逐次调用取最新值（调大即时生效）。缺省默认值 3——生产装配
   * （main.ts）注入真实 resolver，未注入的既有单测装配按默认口径（并发
   * 不超过 3 的既有用例行为不变）。
   */
  concurrencyLimit?: () => number;
  /** 任务排队持久化（票 02 内存态；票 05 换真实实现）：缺省内存（单测装配）。 */
  taskQueueStore?: TaskQueueStore;
}): TaskExitRuntime & { startInputQueues(): void; pumpTaskQueue(): void } {
  const {
    manager,
    profiles,
    getWindow,
    getWindows = () => {
      const window = getWindow();
      return window ? [window] : [];
    },
    dataDir,
    browserManager,
    worktreeService,
    resourcesFor,
    queueStore = createMemoryInputQueueStore(),
    concurrencyLimit = () => DEFAULT_TASK_CONCURRENCY_LIMIT,
    taskQueueStore = createMemoryTaskQueueStore(),
  } = options;
  // 每条运行中的消息流登记一个 AbortController：停止按钮（tasks:interrupt）→
  // abort 贯穿流式输出与工具执行（长命令子进程树终止）
  const interrupts = createInterruptRegistry();
  const executions = new Map<string, string>();
  const management = createTaskManagement(manager, executions);
  const membership = createTaskMembership(manager, management);
  const starts = new Map<string, Promise<TaskRecord>>();
  const workbench = registerWorkbenchHandlers(manager, profiles);
  const liveTasks = createLiveTasks(manager);
  const tasks = new Set<Promise<unknown>>();
  let exiting = false;
  let stopping = false;
  const deferredStarts = new Set<() => void>();
  function assertOpen() {
    if (exiting) throw new Error("应用正在退出，请取消退出后再操作");
  }
  async function resumeAcceptedStart() {
    // 已接收但尚未占位的操作暂停而非提前取消；取消退出后继续原意图。
    while (exiting && !stopping)
      await new Promise<void>((resolve) => deferredStarts.add(resolve));
    assertOpen();
  }
  function releaseDeferredStarts() {
    for (const resume of deferredStarts) resume();
    deferredStarts.clear();
  }
  function track<T>(task: Promise<T>): Promise<T> {
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {});
    return task;
  }

  function emit(
    input: Pick<TaskEventEnvelope, "taskId" | "executionId" | "event">
  ): void {
    const envelope = liveTasks.accept(
      input.taskId,
      input.executionId,
      input.event
    );
    if (!envelope) return;
    // 任务排队态（票 02）不属于执行现场：信封活动态统一走 activityOf 单点
    // 取数叠加 queued（review 修复 F5：live-tasks 不感知应用级排队）。
    envelope.activity = activityOf(input.taskId);
    const win = getWindow();
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(IPC.taskEvents, envelope);
    }
  }

  // 任务排队协调器（任务并发上限票 02，ADR 0022）：执行中任务数（含等待
  // 用户交互）达到上限时，空闲任务的发送入队，名额释放后 FIFO 自动开跑。
  // 占坑口径单一真相 = management.execution 的 running 判定（executions
  // 登记 + 任务状态 + 待回应交互三源或，waiting-user 期间不释放）。
  const taskQueue = createTaskQueueCoordinator({
    store: taskQueueStore,
    limit: concurrencyLimit,
    executingTaskIds: () =>
      manager
        .list()
        .filter((record) => management.execution(record.id)?.running ?? false)
        .map((record) => record.id),
    // 开跑排队任务：走发送主路径的内部消费（跳过用户路径检查与闸门入队，
    // 满员竞态由 deliverMessage 复查兜底），参数取入队时的快照。
    start: (entry) => sendInternal(entry.taskId, entry),
    onChange: (taskId, reason, queue) => {
      // 排队变更经任务事件信封推送（空闲任务无执行现场也延续水位，与
      // 输入队列 queue-changed 同构），所有工作台窗口收到同一权威快照。
      const envelope = liveTasks.acceptQueue(taskId, {
        type: "task-queue-changed",
        reason,
        queue,
      });
      if (!envelope) return;
      // 活动态含 queued 单点取数（review 修复 F5）：与 emit/list/view 同源
      envelope.activity = activityOf(taskId);
      for (const window of getWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC.taskEvents, envelope);
        }
      }
    },
  });

  /** 活动态单点取数（票 02）：执行/查看状态叠加应用级排队标志。 */
  function activityOf(taskId: string) {
    return {
      ...liveTasks.activity(taskId),
      queued: taskQueue.isQueued(taskId),
    };
  }

  /**
   * 推进任务排队（review 修复 F3）：pump 的出队落库失败（存储故障）会
   * 上抛——这里显式记录，保证「开跑成功才出队落库」的意图不被静默吞掉
   * （条目残留待下轮重复开跑同一首条），也不让触发点变成 unhandled
   * rejection。
   */
  function runQueuePump() {
    taskQueue.pump().catch((error: unknown) => {
      console.error("[tasks] 任务排队出队落库失败", error);
    });
  }

  // 输入队列（票 01 / ADR 0013）：任务忙时 send 入队，执行结束或入队时空闲
  // 则由主进程逐条消费。等待「本轮流结束」的消费循环经 streamWaiters 挂起，
  // 在流的 end() 钩子中释放（发一条、等其回复完成、再发下一条）。
  const streamWaiters = new Map<string, Set<() => void>>();
  function releaseStreamWaiters(taskId: string) {
    const waiters = streamWaiters.get(taskId);
    if (!waiters) return;
    for (const release of waiters) release();
    waiters.clear();
  }
  const queues = createTaskInputQueues({
    store: queueStore,
    // 退出冻结是宿主门控，不是用户暂停；不落盘，也不取下一条。
    // 排队任务视同忙（票 04 / ADR 0022）：排队期间入队的消息不消费——
    // 否则名额释放的瞬间（end 先重泵输入队列后推进任务排队）输入队列
    // 消息会抢在 FIFO 开跑之前执行；开跑（出队且 running）后自然放行。
    isBusy: (taskId) =>
      exiting ||
      (management.execution(taskId)?.running ?? false) ||
      taskQueue.isQueued(taskId),
    // 队首还在读取凭据/准备发送时也算在途工作，退出需等它复查闸门后排空。
    dispatch: (taskId, entry, onSettled) =>
      track(dispatchQueued(taskId, entry, onSettled)),
    onChange: (taskId, reason, queue, paused, sendingId) => {
      // 队列变更经任务事件信封推送（空闲修改也有信封可挂，票 03 acceptQueue），
      // 所有工作台窗口收到同一权威快照。
      const envelope = liveTasks.acceptQueue(taskId, {
        type: "queue-changed",
        reason,
        queue,
        paused,
        sendingId,
      });
      if (!envelope) return;
      for (const window of getWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC.taskEvents, envelope);
        }
      }
    },
  });

  /** 队列消费的发送：走发送主路径；启动成功即返回，流结束经 onSettled 回调。 */
  async function dispatchQueued(
    taskId: string,
    entry: QueuedMessage,
    onSettled: () => void
  ) {
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      onSettled();
    };
    const waiters = streamWaiters.get(taskId) ?? new Set();
    waiters.add(release);
    streamWaiters.set(taskId, waiters);
    try {
      await sendInternal(taskId, entry);
    } catch (error) {
      // 启动失败：注销等待（end() 可能已提前释放），条目由协调器保留
      waiters.delete(release);
      throw error;
    }
  }

  // 消息与Compact共用占位、现场起点及中断清理，避免两套运行状态分叉。
  function beginExecution(taskId: string) {
    management.assertCanExecute(taskId);
    const executionId = randomUUID();
    executions.set(taskId, executionId);
    const rollbackLive = liveTasks.begin(taskId, executionId);
    const controller = interrupts.begin(taskId);
    return {
      executionId,
      controller,
      rollbackLive,
      end() {
        interrupts.end(taskId, controller);
        if (executions.get(taskId) === executionId) executions.delete(taskId);
        // 流结束（完成/出错/中断）：唤醒等待本轮的消费循环并尝试取队首（票 01）
        releaseStreamWaiters(taskId);
        // 应用退出中断不等于插话完成：保留用户暂停，不在收尾时触发下一轮。
        if (!stopping) {
          queues.onIdle(taskId);
          // 名额释放（票 02 / ADR 0022）：任务排队按 FIFO 推进；同时重泵
          // 各任务输入队列——此前被满员拦下的内部消费（条目保留）在此重试。
          continueInputQueues();
          runQueuePump();
        }
      },
    };
  }

  ipcMain.handle(IPC.projects.list, () => manager.projects());
  ipcMain.handle(IPC.projects.add, (_e: IpcMainInvokeEvent, path: unknown) => {
    if (typeof path !== "string" || !path.trim())
      throw new Error("请选择项目目录");
    return manager.addProject(path);
  });
  ipcMain.handle(IPC.projects.remove, (_e, id: unknown, confirmed: unknown) => {
    if (typeof id !== "string" || typeof confirmed !== "boolean")
      throw new Error("移除项目：需要项目标识和明确确认");
    const result = membership.removeProject(id, confirmed);
    for (const taskId of result?.taskIds ?? []) {
      liveTasks.forget(taskId);
      queueStore.clear(taskId);
      // 项目移除出队（票 02）：排队条目随之清除，避免开跑重试堵住 FIFO 队列
      taskQueue.remove(taskId);
      void browserManager?.closeTask(taskId).catch(() => {});
    }
    return result;
  });
  ipcMain.handle(
    IPC.tasks.setProject,
    (_e, id: unknown, projectId: unknown) => {
      if (
        typeof id !== "string" ||
        (projectId !== null && typeof projectId !== "string")
      )
        throw new Error("调整归属：参数不合法");
      return membership.setProject(id, projectId);
    }
  );
  ipcMain.handle(IPC.tasks.list, () =>
    manager.list().map((record) => ({
      ...record,
      // 活动态含任务排队标志（票 02）：侧栏「排队中」徽章的数据来源
      activity: activityOf(record.id),
    }))
  );
  ipcMain.handle(IPC.tasks.view, (_e, taskId: unknown) => {
    if (typeof taskId !== "string")
      throw new Error("view：taskId 必须是字符串");
    const view = liveTasks.view(taskId);
    // 输入队列快照（票 01/02，review 重构收拢三元组）：切回任务时队列条原样恢复
    return view === null
      ? null
      : {
          ...view,
          // 活动态含任务排队标志（票 02）：任务内排队状态条的数据来源（票 03）
          activity: activityOf(taskId),
          queueState: queueSnapshot(taskId),
          // 排队首条快照（review 修复 F2）：重启后仍排队任务无信封可重放，
          // 排队首条回显与状态条由此恢复（不在队为 null）
          queuedStart:
            taskQueue.snapshot().find((entry) => entry.taskId === taskId)
              ?.text ?? null,
        };
  });
  ipcMain.handle(
    IPC.tasks.markViewed,
    (_e, taskId: unknown, sequence: unknown) => {
      if (typeof taskId !== "string" || typeof sequence !== "number")
        throw new Error("查看水位参数不合法");
      liveTasks.markViewed(taskId, sequence);
    }
  );
  ipcMain.handle(
    IPC.projects.setCollapsed,
    (_e, id: unknown, collapsed: unknown) => {
      if (typeof id !== "string" || typeof collapsed !== "boolean")
        throw new Error("setCollapsed：参数不合法");
      return manager.setProjectCollapsed(id, collapsed);
    }
  );
  ipcMain.handle(IPC.projects.setPinned, (_e, id: unknown, pinned: unknown) => {
    if (typeof id !== "string" || !id.trim() || typeof pinned !== "boolean")
      throw new Error("项目 setPinned：参数不合法");
    return manager.setProjectPinned(id, pinned);
  });
  ipcMain.handle(IPC.tasks.setPinned, (_e, id: unknown, pinned: unknown) => {
    if (typeof id !== "string" || typeof pinned !== "boolean")
      throw new Error("setPinned：参数不合法");
    return manager.setPinned(id, pinned);
  });
  ipcMain.handle(IPC.tasks.markUsed, (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("markUsed：参数不合法");
    return manager.markUsed(id);
  });
  ipcMain.handle(
    IPC.tasks.workspaceSharing,
    (_e, target: WorkspaceSharingTarget) =>
      workspaceSharing(
        target,
        manager,
        (id) => management.execution(id)?.running ?? false
      )
  );
  ipcMain.handle(
    IPC.tasks.search,
    (_e, query: unknown, includeArchived: unknown = false) => {
      if (typeof query !== "string" || typeof includeArchived !== "boolean")
        throw new Error("search：查询必须是字符串，归档选项必须是布尔值");
      return manager.search(query, includeArchived);
    }
  );
  ipcMain.handle(IPC.tasks.execution, (_e, taskId: unknown) => {
    if (typeof taskId !== "string")
      throw new Error("execution：taskId 必须是字符串");
    return management.execution(taskId);
  });

  ipcMain.handle(IPC.tasks.start, (_e, input: unknown) => {
    assertOpen();
    if (!input || typeof input !== "object")
      throw new Error("首次发送参数不合法");
    const request = input as StartTaskInput;
    if (
      typeof request.requestId !== "string" ||
      !request.requestId.trim() ||
      request.requestId.length > 200 ||
      (request.projectId !== null &&
        (typeof request.projectId !== "string" || !request.projectId)) ||
      typeof request.text !== "string" ||
      !request.text.trim()
    )
      throw new Error("首次发送需要草稿标识、项目归属和消息内容");
    if (manager.isRemovedCreationRequest(request.requestId))
      return Promise.reject(new Error("原任务已移除，请新建任务后发送"));
    const pending = starts.get(request.requestId);
    if (pending)
      return pending.then((record) => {
        const current = manager.list().find((item) => item.id === record.id);
        if (!current) throw new Error("原任务已移除，请新建任务后发送");
        return current;
      });
    const previous = manager
      .list()
      .find((task) => task.creationRequestId === request.requestId);
    if (previous && manager.messages(previous.id).length) {
      const task = (async () => {
        const draft = manager.readWorkbench(
          workbenchKey({ kind: "new", projectId: request.projectId })
        );
        if (draft?.value.requestId === request.requestId) {
          // 首条消息是已接受意图的凭证。消费落盘失败可以补偿，绝不再发首条。
          const available = await profiles.list();
          await resumeAcceptedStart();
          const saved = manager.readWorkbench(
            workbenchKey({ kind: "task", taskId: previous.id })
          );
          workbench.started(
            request.projectId,
            request.requestId,
            previous.id,
            saved?.value.preferences ?? draft.value.preferences,
            available[0]?.id ?? "",
            manager
              .messages(previous.id)
              .find((message) => message.role === "user")?.content
          );
        }
        const current = manager.list().find((item) => item.id === previous.id);
        if (!current) throw new Error("原任务已移除，请新建任务后发送");
        return current;
      })();
      starts.set(request.requestId, task);
      void task.finally(() => starts.delete(request.requestId)).catch(() => {});
      return task;
    }
    if (previous) manager.removeUnstarted(previous.id);
    const task = (async () => {
      const effort = parseThinkingEffort(request.thinkingEffort);
      const approval = request.approvalMode ?? "ask";
      if (!(APPROVAL_MODES as readonly unknown[]).includes(approval))
        throw new Error("审批模式不合法");
      if (
        request.workspaceMode !== undefined &&
        request.workspaceMode !== "local" &&
        request.workspaceMode !== "worktree"
      )
        throw new Error("工作区模式必须是 local 或 worktree");
      if (request.projectId === null && request.workspaceMode === "worktree")
        throw new Error("独立任务入口不支持直接创建 Worktree，请在项目内新建");
      const available = await profiles.list();
      await resumeAcceptedStart();
      assertOpen();
      const profile =
        request.providerProfileId === undefined
          ? available[0]
          : available.find((item) => item.id === request.providerProfileId);
      if (!profile) throw new Error("请先选择有效模型（Provider Profile）");
      const project =
        request.projectId === null
          ? null
          : manager.projects().find((item) => item.id === request.projectId);
      if (request.projectId !== null && !project)
        throw new Error("项目不存在，请重新选择");
      if (project && request.workspacePath !== undefined)
        throw new Error("项目任务使用项目目录，不能更换工作区");
      const id = randomUUID();
      let workspacePath = project?.workspacePath ?? request.workspacePath;
      if (workspacePath !== undefined) {
        if (typeof workspacePath !== "string")
          throw new Error("工作区路径不合法");
        workspacePath = canonicalWorkspacePath(workspacePath);
      } else {
        workspacePath = join(dataDir, "tasks", id, "workspace");
        try {
          mkdirSync(workspacePath, { recursive: true });
        } catch {
          throw new Error(
            "无法创建独立任务专用目录，请检查应用数据目录权限后重试"
          );
        }
      }
      let rollbackWorkspace: (() => Promise<boolean>) | undefined;
      let preparedPath: string | undefined;
      try {
        const { rollback, ...workspace } = await prepareTaskWorkspace({
          id,
          workspacePath,
          workspaceMode: request.workspaceMode,
          worktreeService,
        });
        rollbackWorkspace = rollback;
        preparedPath = workspace.workspacePath;
        await resumeAcceptedStart();
        assertOpen();
        // 异步准备期间项目可能已被移除；复查与创建之间不得 await。
        if (
          project &&
          !manager.projects().some((item) => item.id === project.id)
        )
          throw new Error("项目不存在或已移除，请重新选择");
        const task = manager.create({
          id,
          projectId: request.projectId,
          creationRequestId: request.requestId,
          ...workspace,
          title: request.text.trim().split(/\r?\n/)[0]!.slice(0, 60),
          approvalMode: approval,
        });
        await send(
          task.id,
          request.text,
          profile.id,
          request.mentionPaths,
          effort,
          undefined,
          request.model
        );
        workbench.started(
          request.projectId,
          request.requestId,
          task.id,
          {
            providerProfileId: profile.id,
            model: request.model,
            thinkingEffort: effort,
            approvalMode: approval,
          },
          available[0]?.id ?? ""
        );
        const current = manager.list().find((item) => item.id === task.id);
        if (!current) throw new Error("原任务已移除，请新建任务后发送");
        return current;
      } catch (error) {
        // 删除记录也会让历史为空；已成功的意图墓碑绝不能误当成创建失败并回收磁盘。
        if (
          !manager.isRemovedCreationRequest(request.requestId) &&
          !manager.messages(id).length
        ) {
          manager.removeUnstarted(id);
          // 回收未开始的任务时同步出队（票 02）：满员入队后的后续步骤失败
          // 也会走到这里，残留条目会在开跑重试时永远失败堵住 FIFO 队列。
          taskQueue.remove(id);
          if (rollbackWorkspace && !(await rollbackWorkspace())) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}；无法确认副本可安全回收，已保留目录：${preparedPath}（未创建正式任务，可重试）`,
              { cause: error }
            );
          }
          if (!project && request.workspacePath === undefined) {
            // 非递归 rmdir：只撤销本次分配且仍为空的目录，有任何成果就保留。
            try {
              rmdirSync(workspacePath);
              rmdirSync(join(dataDir, "tasks", id));
            } catch {
              /* 非空或不可访问时保留。 */
            }
          }
        }
        throw error;
      }
    })();
    starts.set(request.requestId, task);
    void task.finally(() => starts.delete(request.requestId)).catch(() => {});
    return task;
  });

  ipcMain.handle(IPC.tasks.selectWorkspace, async () => {
    // E2E 钩子：Playwright 无法操作原生目录对话框，自动化环境固定返回该目录
    const pinned = process.env.CODEXLIKE_TEST_WORKSPACE;
    if (pinned !== undefined && pinned !== "") {
      return pinned;
    }
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(
    IPC.tasks.messages,
    (_e: IpcMainInvokeEvent, taskId: unknown) => {
      if (typeof taskId !== "string") {
        throw new Error("messages：taskId 必须是字符串");
      }
      return manager.transcript(taskId);
    }
  );

  /**
   * 发送核心（review 重构拆分）：用户直发与队列消费共用——参数校验、参数快照、
   * 占位、流式事件泵。来源以具名 source 区分（取代 fromQueue 布尔尾参）：
   * - user：渲染层直发。任务忙时改为入队（票 01）；等待用户交互时明确拒绝；
   *   暂停期间的直发登记为插话（票 02）。满员时经任务并发闸门改入任务
   *   排队静默返回（任务并发上限票 02）。
   * - queue：内部消费发送（输入队列消费与任务排队开跑共用，票 02）。不再
   *   入队（避免自我吞掉），也不算插话；参数取入队时的快照。竞态以启动
   *   失败保留条目（含撞满员闸门）。
   */
  async function deliverMessage(input: {
    source: "user" | "queue";
    taskId: unknown;
    text: unknown;
    profileId?: unknown;
    model?: unknown;
    mentionPaths?: unknown;
    thinkingEffort?: unknown;
    approvalMode?: unknown;
  }) {
    const { source, taskId, text } = input;
    const fromUser = source === "user";
    assertOpen();
    if (typeof taskId !== "string" || typeof text !== "string") {
      throw new Error("send：参数不合法");
    }
    if (text.trim() === "") {
      throw new Error("消息内容不能为空");
    }
    const saved = manager.readWorkbench(workbenchKey({ kind: "task", taskId }));
    const { approvalMode } = input;
    let profileId = input.profileId;
    let model = input.model;
    let thinkingEffort = input.thinkingEffort;
    profileId ??= saved?.value.preferences.providerProfileId;
    model ??= saved?.value.preferences.model ?? null;
    thinkingEffort ??= saved?.value.preferences.thinkingEffort;
    if (typeof profileId !== "string" || profileId === "") {
      throw new Error("请先选择模型（Provider Profile）");
    }
    if (model !== null && model !== undefined && typeof model !== "string") {
      throw new Error("send：model 必须是字符串");
    }
    const modelId =
      model === null || model === undefined || model === "" ? null : model;
    if (
      input.mentionPaths !== undefined &&
      (!Array.isArray(input.mentionPaths) ||
        input.mentionPaths.some((path) => typeof path !== "string"))
    ) {
      throw new Error("send：@引用 路径列表不合法");
    }
    const mentionPaths = input.mentionPaths as string[] | undefined;
    // 思考档位（GLOSSARY「思考档位」）：IPC 边界不信任渲染进程，只接受五档枚举；
    // 校验走 agent-core 统一入口（未传等价 auto，非法值以中文异常抛回渲染进程；
    // agent-core 发送入口同样校验，双保险）
    const effortSnapshot = parseThinkingEffort(thinkingEffort);
    const task = manager.get(taskId);
    if (task === null) {
      throw new Error("任务不存在或已损坏");
    }
    const approvalSnapshot =
      approvalMode ??
      saved?.value.preferences.approvalMode ??
      task.record.approvalMode;
    if (!(APPROVAL_MODES as readonly unknown[]).includes(approvalSnapshot))
      throw new Error("审批模式不合法");
    const profile = (await profiles.list()).find(
      (candidate: ProviderProfile) => candidate.id === profileId
    );
    if (profile === undefined) {
      throw new Error("所选 Provider Profile 不存在，请重新选择模型");
    }

    // 输入队列（票 01）：任务忙时不再报错，而是入队（主进程单一真相）。
    // 入队即快照发送参数（Profile / 思考档位 / 审批模式 / @引用），消费按快照发。
    if (fromUser) {
      const executionState = management.execution(taskId);
      // 等待用户交互（审批/问答，spec 用户故事 17 / Out of Scope）：UI 已禁用，
      // 直调 IPC 绕过 UI 的发送一律拒绝——明确中文报错，不入队也不触发消费
      //（排队消息会卡在无法消费的时机）。
      if (executionState?.waitingForUser) {
        throw new Error("任务正在等待审批或问答，请先回应后再发送");
      }
      // 排队任务在输入队列语义上视同忙（票 04 / ADR 0022）：排队期间再发的
      // 消息进入该任务输入队列，开跑后的轮末按序自动发出——防排队期间消息丢失。
      if ((executionState?.running ?? false) || taskQueue.isQueued(taskId)) {
        queues.enqueue(taskId, {
          text,
          mentionPaths: mentionPaths ?? [],
          providerProfileId: profile.id,
          model: modelId,
          thinkingEffort: effortSnapshot,
          approvalMode: approvalSnapshot as ApprovalMode,
        });
        return;
      }
    }

    // @引用 内容在主进程读取（路径限制在工作区内），失败以中文异常抛回
    const mentions = readMentionAttachments(
      task.record.workspacePath,
      mentionPaths ?? []
    );

    // await 后复查退出闸门；已到达的异步发送不能在 flush 期间偷启动。
    await resumeAcceptedStart();
    assertOpen();
    // 全局任务并发闸门（任务并发上限票 02，ADR 0022）：任何执行开始前判定，
    // 与下方 beginExecution 占坑在同一同步段（无交错窗口，判定后立即占坑）。
    // 用户直发满员：连同参数快照入任务排队静默返回（排队而非拒绝），
    // 名额空出后由协调器按 FIFO 以内部消费路径重放；内部消费（输入队列
    // 消费/排队开跑）撞满员：抛错使条目保留（输入队列条目或排队条目不丢），
    // 名额释放点（end）会重泵。
    if (fromUser) {
      const gated = taskQueue.gate(taskId, {
        text,
        mentionPaths: mentionPaths ?? [],
        providerProfileId: profile.id,
        model: modelId,
        thinkingEffort: effortSnapshot,
        approvalMode: approvalSnapshot as ApprovalMode,
      });
      if (gated === "queued") {
        // 暂停期间的直发被任务排队（票 04：中断排队后的重发等场景）：
        // 开跑走内部消费路径不经过 beginInterjection，插话意图在此登记，
        // 开跑轮末经 onIdle 恢复队列消费——与不满员时的直发插话语义一致。
        if (queues.isPaused(taskId)) queues.beginInterjection(taskId);
        return;
      }
    } else if (taskQueue.isFull()) {
      throw new Error("任务并发已满，等待空位后自动重试");
    }
    // 宿主原子占位，第二次 send 不得覆盖第一轮的中断通道。
    const { executionId, controller, rollbackLive, end } =
      beginExecution(taskId);
    // 插话（票 02）：暂停期间的直发消息已开始执行——回复结束（完成/出错/
    // 中断）时自动清除暂停标志并恢复队列消费（协调器 onIdle 兑现）。
    if (fromUser && queues.isPaused(taskId)) {
      queues.beginInterjection(taskId);
    }
    try {
      // 先 await 第一个事件（user-message）：任务并发拒绝等启动错误
      // 在这里以异常抛回渲染进程；之后的事件异步推送。
      // 先落中间变量再取 [Symbol.asyncIterator]()：对象字面量后直接
      // 换行接 [ 会被读成索引访问（ASI 陷阱），也触发 no-unexpected-multiline。
      const execution = task.sendMessage({
        text,
        profile,
        model: modelId ?? undefined,
        mentions,
        thinkingEffort: effortSnapshot,
        approvalMode: approvalSnapshot as ApprovalMode,
        signal: controller.signal,
      });
      const iterator = execution[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done !== true) {
        manager.markUsed(taskId);
        emit({ taskId, executionId, event: first.value });
      }
      track(
        (async () => {
          for (
            let head = await iterator.next();
            !head.done;
            head = await iterator.next()
          ) {
            emit({ taskId, executionId, event: head.value });
          }
        })()
          .catch((error: unknown) => {
            // 防御：流中途的意外异常不应成为未处理 rejection
            console.error("[tasks] 事件流意外终止", error);
          })
          .finally(() => {
            // 流结束（完成 / 出错 / 用户中断）后注销登记，停止按钮回到无效态
            end();
          })
      );
    } catch (error) {
      // 启动失败：注销中断登记后再抛回渲染进程
      rollbackLive();
      end();
      throw error;
    }
  }

  /** 渲染层发送入口（tasks.send IPC）：忙时入队、等待用户交互时拒绝、空闲直发。 */
  async function send(
    taskId: unknown,
    text: unknown,
    profileId?: unknown,
    mentionPaths?: unknown,
    thinkingEffort?: unknown,
    approvalMode?: unknown,
    model?: unknown
  ) {
    await deliverMessage({
      source: "user",
      taskId,
      text,
      profileId,
      model,
      mentionPaths,
      thinkingEffort,
      approvalMode,
    });
  }

  /**
   * 内部消费的发送（review 重构，票 02 扩展共用）：输入队列消费与任务排队
   * 开跑共用——参数取入队时快照，跳过用户路径的入队与插话登记；满员竞态
   * 由闸门的内部消费分支兜底（抛错保留条目）。字段显式映射：快照的
   * providerProfileId 对应入参 profileId，不能用展开（键名不同会静默
   * 回退 workbench 保存的偏好）。
   */
  function sendInternal(
    taskId: string,
    snapshot: Pick<
      QueuedMessage,
      | "text"
      | "mentionPaths"
      | "providerProfileId"
      | "model"
      | "thinkingEffort"
      | "approvalMode"
    >
  ): Promise<void> {
    return deliverMessage({
      source: "queue",
      taskId,
      text: snapshot.text,
      profileId: snapshot.providerProfileId,
      model: snapshot.model,
      mentionPaths: snapshot.mentionPaths,
      thinkingEffort: snapshot.thinkingEffort,
      approvalMode: snapshot.approvalMode,
    });
  }
  ipcMain.handle(IPC.tasks.send, (_e, ...args: Parameters<typeof send>) =>
    track(send(...args))
  );

  /**
   * 中断排队出队的首条补落（review 修复 F1 / spec 用户故事 8、ADR 0022
   * 「中断排队出队回空闲，已发消息保留」）：满员入队不落 transcript，
   * 中断出队时把首条快照补记为已发送未回复的 user message——与中断
   * 运行任务「已发消息保留」语义对齐（GLOSSARY「排队任务」：首条消息
   * 已在消息流可见）。不触发执行（不占名额、不发模型请求），重发才触发。
   */
  function backfillQueuedStart(
    taskId: string,
    text: string,
    mentionPaths: string[]
  ) {
    const record = manager.list().find((item) => item.id === taskId);
    if (!record) return;
    let mentions: MentionAttachment[] | undefined;
    try {
      mentions = readMentionAttachments(record.workspacePath, mentionPaths);
    } catch {
      // 引用文件已不可读（删除/移走）：降级补落纯文本，不阻塞出队
    }
    const stored = manager.appendUserMessage(taskId, {
      content: text,
      mentions,
    });
    if (!stored) return;
    // 补落消息经 user-message 事件推送（排在 remove 信封之后到达：
    // 显示层先撤下排队回显，再由真实消息段接管——无双重呈现窗口）
    const executionId = liveTasks.ensureExecution(taskId);
    if (executionId !== null) {
      emit({
        taskId,
        executionId,
        event: { type: "user-message", message: stored },
      });
    }
  }

  ipcMain.handle(
    IPC.tasks.interrupt,
    (_e: IpcMainInvokeEvent, taskId: unknown) => {
      if (typeof taskId !== "string") {
        throw new Error("interrupt：taskId 必须是字符串");
      }
      // 有活跃流则打断（abort 贯穿流式层与工具层）；空闲任务幂等返回 false
      const interrupted = interrupts.interrupt(taskId);
      if (interrupted) {
        liveTasks.stop(taskId);
      }
      // 中断排队任务（票 04 / ADR 0022）：立即出队回空闲——已发消息保留，
      // 名额让给后续排队任务（remove 推送事件链，空位仍由释放点推进）。
      // 有活跃流时也复查出队：开跑的 await 窗口内任务已执行但尚未出队，
      // 此时中断必须一并出队，否则下一次 pump 会把刚被中断的任务重跑。
      const entry = taskQueue.snapshot().find((item) => item.taskId === taskId);
      const removed = taskQueue.remove(taskId);
      if (removed) {
        // 首条补落只补「从未真正发出」的（无活跃流 = user message 未落库）；
        // 活跃流中断（含开跑窗口的复查出队）首条已随 sendMessage 落库，不补
        if (entry !== undefined && !interrupted) {
          backfillQueuedStart(taskId, entry.text, entry.mentionPaths);
        }
        runQueuePump();
      }
      if (interrupted || removed) {
        // 停止路径（票 02）：排队消息存在时置队列暂停——队列原样保留、
        // 中断落定后的空闲不消费，等待恢复/清空/插话三个出口。中断排队
        // 任务同理：排队期间追加的输入队列消息不因其他任务释放名额而
        // 自动发出，由用户重新发消息（插话语义）或手动恢复触发。
        queues.pause(taskId);
      }
      return interrupted || removed;
    }
  );

  function assertQueueTask(taskId: unknown): asserts taskId is string {
    assertOpen();
    if (typeof taskId !== "string" || !taskId.trim())
      throw new Error("队列操作：任务标识不合法");
    const record = manager.list().find((item) => item.id === taskId);
    if (!record) throw new Error("任务不存在或已移除");
    if (record.archivedAt !== null)
      throw new Error("任务已归档，请先恢复再操作队列");
  }
  function assertQueueItemId(id: unknown): asserts id is string {
    if (typeof id !== "string" || !id.trim())
      throw new Error("队列操作：条目标识不合法");
  }
  /** 队列状态快照（review 重构）：queue / paused / sendingId 三元组单点取数。 */
  function queueSnapshot(taskId: string): QueueSnapshot {
    return {
      queue: queues.snapshot(taskId),
      paused: queues.isPaused(taskId),
      sendingId: queues.sendingItem(taskId),
    };
  }
  function queueResult(taskId: string): QueueOperationResult {
    return {
      taskId,
      sequence: liveTasks.view(taskId)?.sequence ?? 0,
      ...queueSnapshot(taskId),
    };
  }
  ipcMain.handle(IPC.tasks.queueRemove, (_e, taskId: unknown, id: unknown) => {
    assertQueueTask(taskId);
    assertQueueItemId(id);
    queues.remove(taskId, id);
    return queueResult(taskId);
  });
  ipcMain.handle(
    IPC.tasks.queueUpdate,
    (
      _e,
      taskId: unknown,
      id: unknown,
      text: unknown,
      expectedText: unknown,
      mentionPaths: unknown
    ) => {
      assertQueueTask(taskId);
      assertQueueItemId(id);
      if (typeof text !== "string" || text.trim() === "")
        throw new Error("消息内容不能为空");
      if (typeof expectedText !== "string")
        throw new Error("编辑保存：缺少原文校验值");
      if (
        mentionPaths !== undefined &&
        (!Array.isArray(mentionPaths) ||
          mentionPaths.some((path) => typeof path !== "string"))
      )
        throw new Error("queueUpdate：@引用 路径列表不合法");
      queues.update(
        taskId,
        id,
        { text, mentionPaths: (mentionPaths as string[] | undefined) ?? [] },
        expectedText
      );
      return queueResult(taskId);
    }
  );
  ipcMain.handle(
    IPC.tasks.queueReorder,
    (_e, taskId: unknown, orderedIds: unknown) => {
      assertQueueTask(taskId);
      if (
        !Array.isArray(orderedIds) ||
        orderedIds.some((id) => typeof id !== "string" || !id.trim()) ||
        new Set(orderedIds).size !== orderedIds.length
      )
        throw new Error("重排：条目顺序清单不合法");
      queues.reorder(taskId, orderedIds as string[]);
      return queueResult(taskId);
    }
  );

  ipcMain.handle(
    IPC.tasks.queueResume,
    (_e: IpcMainInvokeEvent, taskId: unknown) => {
      // 参数与任务校验统一走 assertQueueTask（review 重构），与其余队列操作一致
      assertQueueTask(taskId);
      queues.resume(taskId);
      return queueResult(taskId);
    }
  );

  ipcMain.handle(
    IPC.tasks.queueClear,
    (_e: IpcMainInvokeEvent, taskId: unknown) => {
      assertQueueTask(taskId);
      queues.clearQueue(taskId);
      return queueResult(taskId);
    }
  );

  ipcMain.handle(
    IPC.tasks.rename,
    (_e: IpcMainInvokeEvent, taskId: unknown, title: unknown) => {
      if (typeof taskId !== "string" || typeof title !== "string") {
        throw new Error("rename：参数不合法");
      }
      return manager.rename(taskId, title);
    }
  );

  ipcMain.handle(
    IPC.tasks.archive,
    (_e: IpcMainInvokeEvent, taskId: unknown, archived: unknown) => {
      if (typeof taskId !== "string" || typeof archived !== "boolean") {
        throw new Error("archive：参数不合法");
      }
      // 先在同一同步操作点检查活动状态并写入；拒绝时不释放浏览器或中断任务。
      const result = management.archive(taskId, archived);
      if (archived && result) {
        // 归档出队（票 02）：排队中的任务一并移出，否则开跑重试会因
        // assertCanExecute 拒绝已归档而堵住整条 FIFO 队列。
        taskQueue.remove(taskId);
        void browserManager?.closeTask(taskId).catch(() => {});
      }
      // 归档只整理记录，不触发磁盘回收（包括新模型隔离保留的旧 Worktree）。
      return result;
    }
  );

  ipcMain.handle(
    IPC.tasks.toolImage,
    (_e: IpcMainInvokeEvent, taskId: unknown, toolCallId: unknown) => {
      if (typeof taskId !== "string" || typeof toolCallId !== "string") {
        throw new Error("toolImage：参数不合法");
      }
      const path = screenshotPathFor(dataDir, taskId, toolCallId);
      if (!existsSync(path)) {
        return null;
      }
      return `data:image/png;base64,${readFileSync(path).toString("base64")}`;
    }
  );

  ipcMain.handle(
    IPC.tasks.status,
    async (_e: IpcMainInvokeEvent, taskId: unknown) => {
      if (typeof taskId !== "string") {
        throw new Error("status：taskId 必须是字符串");
      }
      const record = manager
        .list()
        .find((candidate: TaskRecord) => candidate.id === taskId);
      if (record === undefined) {
        return null;
      }
      const profile =
        record.providerProfileId === null
          ? undefined
          : (await profiles.list()).find(
              (candidate: ProviderProfile) =>
                candidate.id === record.providerProfileId
            );
      const { active, last } = manager.resourceState(taskId);
      return buildTaskStatus({
        record,
        messages: manager.messages(taskId),
        resources: active ?? resourcesFor(record).summary(),
        resourcePhase: active === null ? "preview" : "active",
        lastResources: last,
        providerProfileName: profile?.name ?? null,
        // 上下文告警阈值 = Profile 可配的上下文窗口 × 80%（未配置走 agent-core 默认 128k）
        contextWindowTokens: profile?.contextWindowTokens ?? null,
        latestCompact: manager.latestCompact(taskId),
      });
    }
  );

  ipcMain.handle(
    IPC.tasks.resources,
    (_e: IpcMainInvokeEvent, taskId: unknown) => {
      if (typeof taskId !== "string") {
        throw new Error("resources：taskId 必须是字符串");
      }
      const record = manager
        .list()
        .find((candidate) => candidate.id === taskId);
      if (record === undefined) {
        return null;
      }
      return {
        ...manager.resourceState(taskId),
        preview: resourcesFor(record).summary(),
      };
    }
  );

  // draft 态（首条消息前无任务记录）按工作区路径预览：与 tasks.resources 的
  // preview 同构（active/last 恒空），只返回元数据；worktree 模式的草稿用
  // 源工作区路径预览（worktree 在首条消息后才创建，内容一致）。
  ipcMain.handle(
    IPC.tasks.draftResources,
    (_e: IpcMainInvokeEvent, workspacePath: unknown) => {
      if (typeof workspacePath !== "string" || workspacePath.trim() === "") {
        throw new Error("draftResources：workspacePath 必须是非空字符串");
      }
      return {
        active: null,
        last: null,
        preview: resourcesFor({ workspacePath }).summary(),
      };
    }
  );

  ipcMain.handle(
    IPC.tasks.compact,
    (
      _e: IpcMainInvokeEvent,
      taskId: unknown,
      profileId: unknown,
      model?: unknown
    ) =>
      track(
        (async () => {
          assertOpen();
          if (typeof taskId !== "string" || typeof profileId !== "string") {
            throw new Error("compact：参数不合法");
          }
          if (profileId === "") {
            throw new Error("请先选择模型（Provider Profile）");
          }
          if (
            model !== null &&
            model !== undefined &&
            typeof model !== "string"
          ) {
            throw new Error("compact：model 必须是字符串");
          }
          const task = manager.get(taskId);
          if (task === null) {
            throw new Error("任务不存在或已损坏");
          }
          const profile = (await profiles.list()).find(
            (candidate: ProviderProfile) => candidate.id === profileId
          );
          if (profile === undefined) {
            throw new Error("所选 Provider Profile 不存在，请重新选择模型");
          }
          await resumeAcceptedStart();
          assertOpen();
          const { executionId, controller, end } = beginExecution(taskId);
          emit({ taskId, executionId, event: { type: "compact-start" } });
          try {
            const result = await task.compact({
              profile,
              model:
                model === null || model === undefined || model === ""
                  ? undefined
                  : model,
              signal: controller.signal,
            });
            emit({
              taskId,
              executionId,
              event: {
                type: "compact-finished",
                outcome: "completed",
                history: manager.transcript(taskId),
              },
            });
            return { compactedMessages: result.compactedMessages };
          } catch (error) {
            emit({
              taskId,
              executionId,
              event: {
                type: "compact-finished",
                outcome: controller.signal.aborted ? "interrupted" : "failed",
                history: manager.transcript(taskId),
                error: error instanceof Error ? error.message : String(error),
              },
            });
            throw error;
          } finally {
            end();
          }
        })()
      )
  );

  ipcMain.handle(
    IPC.tasks.workspaceFiles,
    (_e: IpcMainInvokeEvent, taskId: unknown) => {
      if (typeof taskId !== "string") {
        throw new Error("workspaceFiles：taskId 必须是字符串");
      }
      const record = manager
        .list()
        .find((candidate: TaskRecord) => candidate.id === taskId);
      if (record === undefined) {
        throw new Error("任务不存在或已损坏");
      }
      return listWorkspaceFiles(record.workspacePath);
    }
  );

  ipcMain.handle(IPC.tasks.revokeAutoApprove, (_e, taskId: unknown) => {
    if (typeof taskId !== "string" || !taskId.trim())
      throw new Error("revokeAutoApprove：参数不合法");
    return manager.revokeAutoApprove(taskId);
  });

  ipcMain.handle(
    IPC.tasks.setApprovalMode,
    (_e: IpcMainInvokeEvent, taskId: unknown, mode: unknown) => {
      if (typeof taskId !== "string") {
        throw new Error("setApprovalMode：taskId 必须是字符串");
      }
      // IPC 边界不信任渲染进程：只接受三档枚举（ask / assist / full-access）
      if (
        typeof mode !== "string" ||
        !(APPROVAL_MODES as readonly string[]).includes(mode)
      ) {
        throw new Error(
          "setApprovalMode：mode 必须是 ask / assist / full-access"
        );
      }
      const key = workbenchKey({ kind: "task", taskId });
      const saved = manager.readWorkbench(key);
      if (saved)
        manager.writeWorkbench(key, {
          revision: saved.revision + 1,
          value: {
            ...saved.value,
            preferences: {
              ...saved.value.preferences,
              approvalMode: mode as ApprovalMode,
            },
          },
        });
      return manager.setApprovalMode(taskId, mode as ApprovalMode);
    }
  );

  ipcMain.handle(
    IPC.tasks.pendingInteractions,
    (_e: IpcMainInvokeEvent, taskId: unknown) => {
      if (typeof taskId !== "string" || taskId.trim() === "") {
        throw new Error("pendingInteractions：taskId 必须是非空字符串");
      }
      return manager.get(taskId)?.pendingInteractions ?? [];
    }
  );

  ipcMain.handle(
    IPC.tasks.respondInteraction,
    (
      _e: IpcMainInvokeEvent,
      taskId: unknown,
      requestId: unknown,
      response: unknown
    ) => {
      if (
        typeof taskId !== "string" ||
        taskId.trim() === "" ||
        typeof requestId !== "string" ||
        requestId.trim() === ""
      ) {
        throw new Error("respondInteraction：参数不合法");
      }
      const task = manager.get(taskId);
      if (task === null) {
        throw new Error("任务不存在或已损坏");
      }
      assertOpen();
      // Core 以自身持有的请求校验响应，不能信任渲染层提供的题目、来源或授权范围。
      return task.respondInteraction(requestId, response);
    }
  );

  ipcMain.handle(
    IPC.tasks.respondApproval,
    (
      _e: IpcMainInvokeEvent,
      taskId: unknown,
      requestId: unknown,
      decision: unknown
    ) => {
      if (typeof taskId !== "string" || typeof requestId !== "string") {
        throw new Error("respondApproval：参数不合法");
      }
      if (
        decision !== "approve" &&
        decision !== "reject" &&
        decision !== "always"
      ) {
        throw new Error(
          "respondApproval：decision 必须是 approve / reject / always"
        );
      }
      const task = manager.get(taskId);
      if (task === null) {
        throw new Error("任务不存在或已损坏");
      }
      assertOpen();
      return task.respondApproval(requestId, decision);
    }
  );

  ipcMain.handle(
    IPC.tasks.pendingApproval,
    (_e: IpcMainInvokeEvent, taskId: unknown) => {
      if (typeof taskId !== "string") {
        throw new Error("pendingApproval：taskId 必须是字符串");
      }
      const task = manager.get(taskId);
      // 任务不存在与无等待统一返回 null（切回任务时 UI 不渲染审批卡片）
      return task?.pendingApproval ?? null;
    }
  );

  ipcMain.handle(
    IPC.tasks.pendingApprovals,
    (_e: IpcMainInvokeEvent, taskId: unknown) => {
      if (typeof taskId !== "string") {
        throw new Error("pendingApprovals：taskId 必须是字符串");
      }
      const task = manager.get(taskId);
      // 主任务与子代理可能并行等待审批（工单 13），全部返回供 UI 恢复多张审批卡片
      return task?.pendingApprovals ?? [];
    }
  );

  function continueInputQueues() {
    for (const record of manager.list()) {
      // 跳过执行中的任务：此时 onIdle 会把在途插话误判为已完成而提前
      // 解除暂停；它们的轮次落定时由 end() 自然触发恢复。
      if (
        record.archivedAt === null &&
        !(management.execution(record.id)?.running ?? false)
      )
        queues.onIdle(record.id);
    }
  }

  return {
    /** 主进程服务装配完成后启用恢复；不依赖窗口、view 或渲染层加载。 */
    startInputQueues: continueInputQueues,
    /**
     * 任务排队推进通道（票 02）：设置保存回调（main.ts 装配）在上限调大后
     * 调用——排队任务立即补位开跑；调小时 pump 自然无事可做（只拦新）。
     */
    pumpTaskQueue: runQueuePump,
    hasWork: () =>
      starts.size > 0 ||
      tasks.size > 0 ||
      executions.size > 0 ||
      manager.list().some((record) => management.execution(record.id)?.running),
    freeze: () => {
      exiting = true;
    },
    thaw: () => {
      exiting = false;
      stopping = false;
      releaseDeferredStarts();
      // 冻结期间已自然结束的轮次没有后续空闲事件，取消退出需重新触发。
      continueInputQueues();
    },
    async stopAndDrain() {
      stopping = true;
      releaseDeferredStarts();
      for (const id of executions.keys()) {
        interrupts.interrupt(id);
        liveTasks.stop(id);
      }
      // 首次发送/异步profile查询也必须排空；它们复查退出闸门后拒绝启动。
      while (starts.size || tasks.size)
        await Promise.allSettled([...starts.values(), ...tasks]);
      manager.cancelInteractions("应用已退出");
    },
  };
}
