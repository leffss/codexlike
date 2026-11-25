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
  isGoalToolActivity,
  parseThinkingEffort,
  workbenchKey,
  type AgentResourceSnapshot,
  type ApprovalMode,
  type BrowserTaskManager,
  type MentionAttachment,
  type ProviderProfile,
  type TaskManager,
  type TaskRecord,
  type TerminalSessionManager,
  type WorktreeService,
} from "@codexlike/agent-core/node";

import type { ProfileStore } from "../profiles/profile-store";
import type { TaskExitRuntime } from "../lifecycle/application-exit";
import { normalizeModelInput } from "../shared/model-value";
import { closeTaskSessions } from "../terminal/terminal-lifecycle";
import { createInterruptRegistry } from "./interrupt-registry";
import {
  createGoalOrchestrator,
  type GoalBoundaryResult,
} from "./goal-orchestrator";
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
  type GoalSendOptions,
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
  /**
   * 终端会话注册表（ADR 0033 票07）：任务归档的「先杀后归档」挂点注入——
   * 归档确认已由渲染端完成（任务有存活会话时提示后关闭），handler 在写入
   * 归档前终止该任务全部存活会话并等待 exit。缺省未注入时归档不触终端
   * （单测装配既有行为不变）。
   */
  terminalSessions?: TerminalSessionManager;
}): TaskExitRuntime & {
  startInputQueues(): void;
  pumpTaskQueue(): void;
  /** 任务级事件下发（终端生命周期 / 目标状态）：main.ts 装配桥接与 goal 控制面共用。 */
  pushTaskEvent(taskId: string, event: TaskEventEnvelope["event"]): void;
} {
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
    terminalSessions,
  } = options;
  let exiting = false;
  let stopping = false;
  const deferredStarts = new Set<() => void>();
  // 每条运行中的消息流登记一个 AbortController：停止按钮（tasks:interrupt）→
  // abort 贯穿流式输出与工具执行（长命令子进程树终止）
  const interrupts = createInterruptRegistry();
  const executions = new Map<string, string>();
  // goal 编排器（ADR 0035）：回合结束的 idle 边界衔接续跑循环（落位先例 = 输入
  // 队列——跨回合编排住 desktop）。「目标循环在进行」是宿主执行态的来源之一
  // （判定在途与两轮之间没有执行登记，任务仍视为持续执行），故先于管理规则创建。
  const goals = createGoalOrchestrator({
    manager,
    // apiKey 只在主进程解密：按任务上次发送所用的 Provider Profile 解析判定模型
    profileFor: async (profileId) =>
      (await profiles.list()).find((item) => item.id === profileId),
    emit: pushTaskEvent,
    isStopping: () => stopping,
    // 续跑轮走发送主路径的内部入口（不产生用户气泡，见 deliverMessage 的 goal 来源）
    startTurn: (taskId, text) =>
      deliverMessage({ source: "goal", taskId, text }),
  });
  const management = createTaskManagement(manager, executions, {
    isGoalRunning: goals.isRunning,
  });
  const membership = createTaskMembership(manager, management);
  const starts = new Map<string, Promise<TaskRecord>>();
  const workbench = registerWorkbenchHandlers(manager, profiles);
  const liveTasks = createLiveTasks(manager);
  const tasks = new Set<Promise<unknown>>();
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
    start: (entry, signal) => track(sendInternal(entry.taskId, entry, signal)),
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

  /**
   * 活动态单点取数（票 02）：执行/查看状态叠加应用级排队标志。
   * 目标模式（ADR 0035，规格故事 19「目标任务与普通执行中任务一致的运行口径」）：
   * 目标循环在进行时任务一律呈现为执行中——完成判定在途时回合已经收尾
   * （终态事件已把 running 置假）、两轮之间没有执行登记，若照搬执行现场的
   * 活动态，侧栏会在这两个窗口里显示空闲。判定在途另带「验证中」副状态
   * （goalPhase），进度行据此显示「验证中」而非「进行中」。
   */
  function activityOf(taskId: string) {
    const verifying = goals.phase(taskId) === "verifying";
    return {
      ...liveTasks.activity(taskId),
      queued: taskQueue.isQueued(taskId),
      ...(goals.isRunning(taskId)
        ? {
            running: true,
            ...(verifying ? { goalPhase: "verifying" as const } : {}),
          }
        : {}),
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
    // 目标循环在进行（ADR 0035「暂停阀门」）：互锁点在这里写成显式条件——
    // 判定在途与两轮之间没有执行登记，任务仍是目标的地盘，排队消息不自动
    // 消费；目标转为已暂停或离开进行中后恢复。上面的「真实执行」故意不含
    // 目标循环（管理规则的执行态另把它算作执行中）：互锁不依赖登记持有。
    isBusy: (taskId) =>
      exiting ||
      (management.execution(taskId, true)?.running ?? false) ||
      taskQueue.isQueued(taskId) ||
      goals.isRunning(taskId),
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

  /**
   * 宿主原子占位，第二次 send 不得覆盖第一轮的中断通道。
   * forGoalLoop：目标循环自己发起的续跑轮——「目标循环在进行」正是它要接续
   * 的状态，不构成阻碍；且不占新席（任务本就占着一席，满员判定会把它自己
   * 算进去），否则续跑轮永远发不出去。
   */
  function beginExecution(
    taskId: string,
    options: { forGoalLoop?: boolean } = {}
  ) {
    const forGoalLoop = options.forGoalLoop === true;
    management.assertCanExecute(taskId, { forGoalLoop });
    if (!forGoalLoop && taskQueue.isFull())
      throw new Error("任务并发已满，请等待空位后重试");
    const executionId = randomUUID();
    executions.set(taskId, executionId);
    const rollbackLive = liveTasks.begin(taskId, executionId);
    const controller = interrupts.begin(taskId);
    return {
      executionId,
      controller,
      rollbackLive,
      end({ advanceTaskQueue = true } = {}) {
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
          if (advanceTaskQueue) runQueuePump();
        }
      },
    };
  }

  /**
   * 消息流结束后的收尾（完成 / 出错 / 用户中断）：先过目标模式的 idle 边界
   * ——进行中的目标在此完成判定，再注销执行登记。判定期间执行登记仍在，
   * 任务继续占任务并发一席、输入队列不消费（GLOSSARY「目标模式」）。
   * 判定未过 / 判定不可用时，注销上一轮的执行登记后由 goal 编排器发起续跑轮
   * （两次独立的宿主执行；两轮之间目标循环仍在进行，输入队列的显式守卫接管
   * 互锁）。toolActivity：本轮是否出现过实质工具活动（空转计数的输入：只认
   * 实际执行了的工具调用）。
   */
  async function settleAfterStream(
    taskId: string,
    signal: AbortSignal,
    end: () => void,
    toolActivity: boolean
  ): Promise<void> {
    let result: GoalBoundaryResult = { action: "none" };
    try {
      // 终态事件已全部下发（流已排空）：宿主活动态的 outcome 即本轮结局
      result = await goals.afterTurn(taskId, {
        signal,
        outcome: liveTasks.activity(taskId).outcome,
        toolActivity,
      });
    } catch (error) {
      // 编排异常不得让执行登记泄漏：记录后照常收尾（目标侧兜底见 abandonGoal）
      console.error("[tasks] 目标 idle 边界编排异常", error);
      abandonGoal(taskId);
    } finally {
      end();
    }
    if (result.action === "continue") {
      // 返回的 Promise 挂在本轮的收尾上：退出屏障的排空会等到续跑轮发起落定
      // （续跑轮自己的事件流另行跟踪）。续跑轮启动失败在编排器内处置，不抛出。
      try {
        await goals.continueTurn(taskId, {
          kind: "verification",
          verification: result.verification,
        });
      } catch (error) {
        console.error("[tasks] 目标续跑轮编排异常", error);
        abandonGoal(taskId);
      }
      // 续跑轮没能发起（启动失败转已暂停 / 轮间窗口里被停止）：循环是在执行
      // 收尾之后才结束的，补一次唤醒——输入队列恢复消费、并发名额让出
      if (!goals.isRunning(taskId)) wakeAfterLoopEnd(taskId);
    }
  }

  /**
   * 编排异常的目标侧兜底：结束循环，进行中的目标转已暂停——不得把目标留在
   * 「进行中却没有循环在推进」的状态（任务会一直显示运行中、输入队列不消费）。
   */
  function abandonGoal(taskId: string) {
    try {
      goals.abandon(taskId);
    } catch (nested) {
      console.error("[tasks] 目标编排异常兜底失败", nested);
    }
  }

  /**
   * 目标循环在不经执行收尾（end）的路径上结束时补的唤醒：与 end() 的收尾
   * 同一组动作（输入队列、各任务输入队列重泵、任务排队推进）。
   */
  function wakeAfterLoopEnd(taskId: string) {
    if (stopping) return;
    queues.onIdle(taskId);
    continueInputQueues();
    runQueuePump();
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
    if (
      previous &&
      (manager.messages(previous.id).length || taskQueue.isQueued(previous.id))
    ) {
      const task = (async () => {
        const draft = manager.readWorkbench(
          workbenchKey({ kind: "new", projectId: request.projectId })
        );
        if (draft?.value.requestId === request.requestId) {
          // 已发首条或持久排队快照均是已接受意图。消费落盘失败只补偿，不重发。
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
              .find((message) => message.role === "user")?.content ??
              taskQueue.snapshot().find((entry) => entry.taskId === previous.id)
                ?.text
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
        // 已持久排队与已发消息同样代表接受；草稿消费失败不能撤销意图。
        // 删除记录也会让历史为空；已成功的意图墓碑绝不能误当成创建失败并回收磁盘。
        if (
          !manager.isRemovedCreationRequest(request.requestId) &&
          !manager.messages(id).length &&
          !taskQueue.isQueued(id)
        ) {
          manager.removeUnstarted(id);
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
   * - goal：目标模式的续跑轮（ADR 0035，由 goal 编排器在 idle 边界发起）。text
   *   是续跑指令而非用户发言——不入队、不算插话、不占新席，以内部输入进入任务
   *   （消息流不产生用户气泡）；发送参数取任务当前的发送偏好。
   */
  async function deliverMessage(input: {
    source: "user" | "queue" | "goal";
    taskId: unknown;
    text: unknown;
    profileId?: unknown;
    model?: unknown;
    mentionPaths?: unknown;
    thinkingEffort?: unknown;
    approvalMode?: unknown;
    /** 任务排队的准备意图；执行占位后改由 interrupts 接管取消。 */
    preparationSignal?: AbortSignal;
  }) {
    const { source, taskId, text } = input;
    const fromUser = source === "user";
    const fromGoalLoop = source === "goal";
    if (fromGoalLoop) {
      // 续跑轮是已被接受的意图：退出确认期间（冻结）暂停等待、取消退出后继续，
      // 不像用户直发那样直接拒绝；确认退出时在 resumeAcceptedStart 落定，
      // 由 goal 编排器按「应用退出」处置（目标状态原样）
      await resumeAcceptedStart();
    } else {
      assertOpen();
    }
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
    // 归一后的具体模型名（null = 未选具体模型，解析时回退 Profile 列表
    // 第一项）；与子代理设置保存、compact 的 IPC 边界共用同一口径
    const modelName = normalizeModelInput(model);
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
          model: modelName,
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
    // 准备期间的停止/归档/移除已经撤销这次意图；必须与占位在同一同步段复查。
    input.preparationSignal?.throwIfAborted();
    if (fromGoalLoop) {
      // 轮间窗口里目标可能已被停止 / 暂停 / 清除：循环不在进行就不再发起续跑轮
      // （目标已离开进行中，队列与并发名额由调用方在循环结束后唤醒）
      if (!goals.isRunning(taskId)) return;
    } else if (fromUser) {
      // 全局任务并发闸门（任务并发上限票 02，ADR 0022）：任何执行开始前判定，
      // 与下方 beginExecution 占坑在同一同步段（无交错窗口，判定后立即占坑）。
      // 用户直发满员：连同参数快照入任务排队静默返回（排队而非拒绝），
      // 名额空出后由协调器按 FIFO 以内部消费路径重放；内部消费（输入队列
      // 消费/排队开跑）撞满员：抛错使条目保留（输入队列条目或排队条目不丢），
      // 名额释放点（end）会重泵。
      const gated = taskQueue.gate(taskId, {
        text,
        mentionPaths: mentionPaths ?? [],
        providerProfileId: profile.id,
        model: modelName,
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
    const { executionId, controller, rollbackLive, end } = beginExecution(
      taskId,
      { forGoalLoop: fromGoalLoop }
    );
    // 插话（票 02）：暂停期间的直发消息已开始执行——回复结束（完成/出错/
    // 中断）时自动清除暂停标志并恢复队列消费（协调器 onIdle 兑现）。
    if (fromUser && queues.isPaused(taskId)) {
      queues.beginInterjection(taskId);
    }
    // 本轮是否出现过实质工具活动：目标模式空转计数的输入（idle 边界带给编排器；
    // 只认实际执行了的调用、只改计划不算，见 isGoalToolActivity）
    let toolActivity = false;
    try {
      // 先 await 第一个事件（user-message / goal-continuation）：任务并发拒绝等
      // 启动错误在这里以异常抛回渲染进程；之后的事件异步推送。
      // 先落中间变量再取 [Symbol.asyncIterator]()：对象字面量后直接
      // 换行接 [ 会被读成索引访问（ASI 陷阱），也触发 no-unexpected-multiline。
      const execution = task.sendMessage({
        text,
        profile,
        model: modelName ?? undefined,
        mentions,
        thinkingEffort: effortSnapshot,
        approvalMode: approvalSnapshot as ApprovalMode,
        // 续跑轮是内部输入：不发 user-message（不产生用户气泡）
        goalContinuation: fromGoalLoop ? true : undefined,
        signal: controller.signal,
      });
      const iterator = execution[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done !== true) {
        manager.markUsed(taskId);
        // 目标进行中：循环自此在本进程存活——终态事件下发时任务不会呈现为空闲
        goals.turnStarted(taskId);
        emit({ taskId, executionId, event: first.value });
      }
      track(
        (async () => {
          for (
            let head = await iterator.next();
            !head.done;
            head = await iterator.next()
          ) {
            // 实质工具活动只认实际执行了的调用（isGoalToolActivity）：按 tool-result
            // 事件判别——agent-core 在结果事件上如实标注了是否执行。被用户拒绝、
            // 参数无效、工具不存在的调用同样发过 tool-call 事件，但什么都没做
            if (
              head.value.type === "tool-result" &&
              isGoalToolActivity(head.value.call.toolName, head.value.executed)
            ) {
              toolActivity = true;
            }
            emit({ taskId, executionId, event: head.value });
          }
        })()
          .catch((error: unknown) => {
            // 防御：流中途的意外异常不应成为未处理 rejection
            console.error("[tasks] 事件流意外终止", error);
          })
          .finally(() => {
            // 流结束（完成 / 出错 / 用户中断）：目标模式的 idle 边界先行
            // （完成判定），编排收尾后注销登记——停止按钮回到无效态。
            // 返回收尾 Promise：退出屏障的排空会等在途判定落定。
            return settleAfterStream(
              taskId,
              controller.signal,
              end,
              toolActivity
            );
          })
      );
    } catch (error) {
      // 启动失败：注销中断登记后再抛回渲染进程
      rollbackLive();
      // 排队启动失败由当前 pump 保留队首，不能把自己的回滚当成新唤醒反复重试。
      end({ advanceTaskQueue: input.preparationSignal === undefined });
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
    >,
    preparationSignal?: AbortSignal
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
      preparationSignal,
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
      // 目标模式的两轮之间（ADR 0035）：上一轮已收尾、续跑轮尚未发起，此刻
      // 没有在途回合可中断——停止 = 暂停直接落位，待发起的续跑轮据此作废
      const goalPaused = !interrupted && goals.pause(taskId) !== null;
      if (removed) {
        // 首条补落只补「从未真正发出」的（无活跃流 = user message 未落库）；
        // 活跃流中断（含开跑窗口的复查出队）首条已随 sendMessage 落库，不补
        if (entry !== undefined && !interrupted) {
          backfillQueuedStart(taskId, entry.text, entry.mentionPaths);
        }
        runQueuePump();
      }
      if (interrupted || removed || goalPaused) {
        // 停止路径（票 02）：排队消息存在时置队列暂停——队列原样保留、
        // 中断落定后的空闲不消费，等待恢复/清空/插话三个出口。中断排队
        // 任务同理：排队期间追加的输入队列消息不因其他任务释放名额而
        // 自动发出，由用户重新发消息（插话语义）或手动恢复触发。
        queues.pause(taskId);
      }
      // 目标在两轮之间被停止：循环是在执行收尾之外结束的，补一次唤醒（并发
      // 名额让出、各任务输入队列重泵）。放在上面的停止规则之后——排队消息
      // 已进入「队列暂停」，这次唤醒不会取走队首，与在途回合被停止时一致。
      if (goalPaused) wakeAfterLoopEnd(taskId);
      return interrupted || removed || goalPaused;
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
    async (_e: IpcMainInvokeEvent, taskId: unknown, archived: unknown) => {
      if (typeof taskId !== "string" || typeof archived !== "boolean") {
        throw new Error("archive：参数不合法");
      }
      // 先杀后归档（ADR 0033 票07）：归档确认已由渲染端完成（任务有存活
      // 会话时提示后关闭），这里终止该任务全部存活会话并等待 exit——
      // terminal-exited 事件在归档写入前推进，执行现场完整（闭合 03 票
      // 「任务移除后事件无现场静默丢弃」的未决口）。无存活会话时立即返回。
      if (archived && terminalSessions !== undefined) {
        await closeTaskSessions(terminalSessions, taskId);
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
              // 归一口径与 send/子代理设置保存共用（review 修复 2）；
              // compact 缺省形态落 undefined（sendMessage/compact 各自的
              // 可选参语义，归一后同为「回退 Profile 列表第一项」）
              model: normalizeModelInput(model) ?? undefined,
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

  /**
   * 目标可设定的任务侧前置（GLOSSARY「目标」，ADR 0035）：与下方的设定落库
   * 之间不得 await——检查通过到目标落库必须是同一同步段。
   */
  function assertGoalSettable(taskId: string): void {
    assertOpen();
    const record = manager.list().find((item) => item.id === taskId);
    if (!record) throw new Error("任务不存在或已移除");
    if (record.archivedAt !== null)
      throw new Error("任务已归档，请先恢复再设定目标");
    const executionState = management.execution(taskId);
    if (executionState?.waitingForUser)
      throw new Error("任务正在等待审批或问答，请先回应后再设定目标");
    if (executionState?.running)
      throw new Error("任务正在执行，请等回复结束后再设定目标");
    if (taskQueue.isQueued(taskId))
      throw new Error("任务排队中，请等待开跑后再设定目标");
  }

  /**
   * /goal 设定目标（ADR 0035）：设定与首轮是同一个意图——目标先落库为
   * 「进行中」（回合结束的 idle 边界才会进入完成判定），随即以目标原文作为
   * 首条用户消息发出首轮（走用户发送主路径：满员照旧进任务排队）。
   * 首轮启动失败即回滚目标，不留「进行中却没有回合」的半成品。
   * 一任务同时至多一个未结束的目标（重复设定由 agent-core 拒绝）。
   */
  ipcMain.handle(
    IPC.tasks.goalSet,
    (
      _e: IpcMainInvokeEvent,
      taskId: unknown,
      text: unknown,
      options: unknown
    ) =>
      track(
        (async () => {
          if (typeof taskId !== "string" || typeof text !== "string")
            throw new Error("设定目标：参数不合法");
          if (
            options !== undefined &&
            (options === null || typeof options !== "object")
          )
            throw new Error("设定目标：发送参数不合法");
          const sendOptions = options as GoalSendOptions | undefined;
          // 首个 await 之前是同一同步段：检查通过到目标落库之间无交错窗口
          assertGoalSettable(taskId);
          const goal = manager.setGoal(taskId, text);
          pushTaskEvent(taskId, { type: "goal-changed", goal });
          try {
            await send(
              taskId,
              text,
              sendOptions?.providerProfileId,
              undefined,
              sendOptions?.thinkingEffort,
              sendOptions?.approvalMode,
              sendOptions?.model
            );
          } catch (error) {
            manager.discardGoal(taskId);
            pushTaskEvent(taskId, { type: "goal-changed", goal: null });
            throw error;
          }
          return manager.goal(taskId)!;
        })()
      )
  );

  /**
   * 设定 / 调整当前目标的 token 预算（ADR 0035「护栏」，票 05）：进度行上预算
   * 显示与设置的入口。调整预算不是状态机转换——目标状态与循环存活状态都不动
   * （进行中的目标即刻按新预算在下一次判定后对账；预算受限的目标加预算后仍需
   * 经控制面恢复）。更新后的快照经 goal-changed 下发。全程无 await。
   */
  ipcMain.handle(
    IPC.tasks.goalSetBudget,
    (_e: IpcMainInvokeEvent, taskId: unknown, tokens: unknown) => {
      assertOpen();
      if (typeof taskId !== "string" || !taskId.trim())
        throw new Error("设定预算：参数不合法");
      // IPC 边界不信任渲染进程：预算只接受正整数（tokens）
      if (
        typeof tokens !== "number" ||
        !Number.isSafeInteger(tokens) ||
        tokens <= 0
      )
        throw new Error("token 预算必须是正整数");
      const goal = manager.setGoalBudget(taskId, tokens);
      pushTaskEvent(taskId, { type: "goal-changed", goal });
      return goal;
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

  /**
   * 执行现场之外的任务级事件下发（终端生命周期，ADR 0033 票03；目标状态与
   * 完成判定，ADR 0035）：宿主级常驻、在消息循环之外启停，经 ensureExecution
   * 延续任务水位（与 acceptQueue 同构，空闲/终态任务的信封照常可挂），全部
   * 工作台窗口收到同一权威信封。任务已移除（无现场可建）时静默丢弃——
   * 视图已随任务撤下，无消费方。
   */
  function pushTaskEvent(
    taskId: string,
    event: TaskEventEnvelope["event"]
  ): void {
    const executionId = liveTasks.ensureExecution(taskId);
    if (executionId === null) return;
    const envelope = liveTasks.accept(taskId, executionId, event);
    if (!envelope) return;
    envelope.activity = activityOf(taskId);
    for (const window of getWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.taskEvents, envelope);
      }
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
    /** 终端生命周期事件下发（ADR 0033 票03）：main.ts 装配桥接 manager.onEvent。 */
    pushTaskEvent,
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
      // 冻结期间已自然结束的轮次没有后续空闲事件，取消退出需重泵两个队列。
      continueInputQueues();
      runQueuePump();
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
