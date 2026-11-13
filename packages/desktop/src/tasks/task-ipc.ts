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
  parseThinkingEffort,
  workbenchKey,
  type AgentResourceSnapshot,
  type ApprovalMode,
  type BrowserTaskManager,
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

/** 注册任务相关 IPC 指令；事件流经 task:events / session:events 双发推送给主窗口 */
export function registerTaskHandlers(options: {
  manager: TaskManager;
  profiles: ProfileStore;
  getWindow: () => BrowserWindow | null;
  /** 队列状态属于会话：所有工作台窗口都接收同一权威事件。 */
  getWindows?: () => BrowserWindow[];
  /** 应用数据目录（截图读回的路径约定；工单 11） */
  dataDir: string;
  /** 浏览器会话管理器（会话归档时释放其浏览器 context；工单 11） */
  browserManager?: BrowserTaskManager;
  /** 托管 Worktree 服务：首次发送创建隔离副本，不按数量清理。 */
  worktreeService: WorktreeService;
  /** 与真实发送共用的发现工厂；预览不会替换运行中的快照。 */
  resourcesFor: (record: TaskRecord) => AgentResourceSnapshot;
  /** 输入队列持久化（票 01 / ADR 0013）：同一 SQLite 库的独立连接；缺省内存（单测装配）。 */
  queueStore?: InputQueueStore;
}): TaskExitRuntime & { startInputQueues(): void } {
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
  } = options;
  // 每条运行中的消息流登记一个 AbortController：停止按钮（sessions:interrupt）→
  // abort 贯穿流式输出与工具执行（长命令子进程树终止）
  const interrupts = createInterruptRegistry();
  const executions = new Map<string, string>();
  const management = createTaskManagement(manager, executions);
  const membership = createTaskMembership(manager, management);
  const starts = new Map<string, Promise<TaskRecord>>();
  const workbench = registerWorkbenchHandlers(manager, profiles);
  const liveSessions = createLiveTasks(manager);
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

  /**
   * 会话→任务改名（票 03）expand 兼容：同一 handler 同时挂正式 tasks:* 与
   * 旧 sessions:* 两个 channel 名，现有 UI 调用与 e2e 不改仍绿；票 06 删旧注册。
   */
  function dualHandle<Args extends unknown[]>(
    taskChannel: string,
    sessionChannel: string,
    handler: (event: IpcMainInvokeEvent, ...args: Args) => unknown
  ): void {
    ipcMain.handle(taskChannel, handler);
    ipcMain.handle(sessionChannel, handler);
  }

  function emit(
    input: Pick<TaskEventEnvelope, "sessionId" | "executionId" | "event">
  ): void {
    const envelope = liveSessions.accept(
      input.sessionId,
      input.executionId,
      input.event
    );
    if (!envelope) return;
    const win = getWindow();
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(IPC.taskEvents, envelope);
      win.webContents.send(IPC.sessionEvents, envelope);
    }
  }

  // 输入队列（票 01 / ADR 0013）：会话忙时 send 入队，执行结束或入队时空闲
  // 则由主进程逐条消费。等待「本轮流结束」的消费循环经 streamWaiters 挂起，
  // 在流的 end() 钩子中释放（发一条、等其回复完成、再发下一条）。
  const streamWaiters = new Map<string, Set<() => void>>();
  function releaseStreamWaiters(sessionId: string) {
    const waiters = streamWaiters.get(sessionId);
    if (!waiters) return;
    for (const release of waiters) release();
    waiters.clear();
  }
  const queues = createTaskInputQueues({
    store: queueStore,
    // 退出冻结是宿主门控，不是用户暂停；不落盘，也不取下一条。
    isBusy: (sessionId) =>
      exiting || (management.execution(sessionId)?.running ?? false),
    // 队首还在读取凭据/准备发送时也算在途工作，退出需等它复查闸门后排空。
    dispatch: (sessionId, entry, onSettled) =>
      track(dispatchQueued(sessionId, entry, onSettled)),
    onChange: (sessionId, reason, queue, paused, sendingId) => {
      // 队列变更经会话事件信封推送（空闲修改也有信封可挂，票 03 acceptQueue），
      // 所有工作台窗口收到同一权威快照。
      const envelope = liveSessions.acceptQueue(sessionId, {
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
          window.webContents.send(IPC.sessionEvents, envelope);
        }
      }
    },
  });

  /** 队列消费的发送：走发送主路径；启动成功即返回，流结束经 onSettled 回调。 */
  async function dispatchQueued(
    sessionId: string,
    entry: QueuedMessage,
    onSettled: () => void
  ) {
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      onSettled();
    };
    const waiters = streamWaiters.get(sessionId) ?? new Set();
    waiters.add(release);
    streamWaiters.set(sessionId, waiters);
    try {
      await sendQueued(sessionId, entry);
    } catch (error) {
      // 启动失败：注销等待（end() 可能已提前释放），条目由协调器保留
      waiters.delete(release);
      throw error;
    }
  }

  // 消息与Compact共用占位、现场起点及中断清理，避免两套运行状态分叉。
  function beginExecution(sessionId: string) {
    management.assertCanExecute(sessionId);
    const executionId = randomUUID();
    executions.set(sessionId, executionId);
    const rollbackLive = liveSessions.begin(sessionId, executionId);
    const controller = interrupts.begin(sessionId);
    return {
      executionId,
      controller,
      rollbackLive,
      end() {
        interrupts.end(sessionId, controller);
        if (executions.get(sessionId) === executionId)
          executions.delete(sessionId);
        // 流结束（完成/出错/中断）：唤醒等待本轮的消费循环并尝试取队首（票 01）
        releaseStreamWaiters(sessionId);
        // 应用退出中断不等于插话完成：保留用户暂停，不在收尾时触发下一轮。
        if (!stopping) queues.onIdle(sessionId);
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
    for (const sessionId of result?.sessionIds ?? []) {
      liveSessions.forget(sessionId);
      queueStore.clear(sessionId);
      void browserManager?.closeTask(sessionId).catch(() => {});
    }
    return result;
  });
  dualHandle(
    IPC.tasks.setProject,
    IPC.sessions.setProject,
    (_e, id: unknown, projectId: unknown) => {
      if (
        typeof id !== "string" ||
        (projectId !== null && typeof projectId !== "string")
      )
        throw new Error("调整归属：参数不合法");
      return membership.setProject(id, projectId);
    }
  );
  dualHandle(IPC.tasks.list, IPC.sessions.list, () =>
    manager.list().map((record) => ({
      ...record,
      activity: liveSessions.activity(record.id),
    }))
  );
  dualHandle(IPC.tasks.view, IPC.sessions.view, (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string")
      throw new Error("view：sessionId 必须是字符串");
    const view = liveSessions.view(sessionId);
    // 输入队列快照（票 01/02，review 重构收拢三元组）：切回会话时队列条原样恢复
    return view === null
      ? null
      : { ...view, queueState: queueSnapshot(sessionId) };
  });
  dualHandle(
    IPC.tasks.markViewed,
    IPC.sessions.markViewed,
    (_e, sessionId: unknown, sequence: unknown) => {
      if (typeof sessionId !== "string" || typeof sequence !== "number")
        throw new Error("查看水位参数不合法");
      liveSessions.markViewed(sessionId, sequence);
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
  dualHandle(
    IPC.tasks.setPinned,
    IPC.sessions.setPinned,
    (_e, id: unknown, pinned: unknown) => {
      if (typeof id !== "string" || typeof pinned !== "boolean")
        throw new Error("setPinned：参数不合法");
      return manager.setPinned(id, pinned);
    }
  );
  dualHandle(IPC.tasks.markUsed, IPC.sessions.markUsed, (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("markUsed：参数不合法");
    return manager.markUsed(id);
  });
  dualHandle(
    IPC.tasks.workspaceSharing,
    IPC.sessions.workspaceSharing,
    (_e, target: WorkspaceSharingTarget) =>
      workspaceSharing(
        target,
        manager,
        (id) => management.execution(id)?.running ?? false
      )
  );
  dualHandle(
    IPC.tasks.search,
    IPC.sessions.search,
    (_e, query: unknown, includeArchived: unknown = false) => {
      if (typeof query !== "string" || typeof includeArchived !== "boolean")
        throw new Error("search：查询必须是字符串，归档选项必须是布尔值");
      return manager.search(query, includeArchived);
    }
  );
  dualHandle(
    IPC.tasks.execution,
    IPC.sessions.execution,
    (_e, sessionId: unknown) => {
      if (typeof sessionId !== "string")
        throw new Error("execution：sessionId 必须是字符串");
      return management.execution(sessionId);
    }
  );

  dualHandle(IPC.tasks.start, IPC.sessions.start, (_e, input: unknown) => {
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
      return Promise.reject(new Error("原会话已移除，请新建会话后发送"));
    const pending = starts.get(request.requestId);
    if (pending)
      return pending.then((record) => {
        const current = manager.list().find((item) => item.id === record.id);
        if (!current) throw new Error("原会话已移除，请新建会话后发送");
        return current;
      });
    const previous = manager
      .list()
      .find((session) => session.creationRequestId === request.requestId);
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
            workbenchKey({ kind: "session", sessionId: previous.id })
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
        if (!current) throw new Error("原会话已移除，请新建会话后发送");
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
        throw new Error("独立会话入口不支持直接创建 Worktree，请在项目内新建");
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
        throw new Error("项目会话使用项目目录，不能更换工作区");
      const id = randomUUID();
      let workspacePath = project?.workspacePath ?? request.workspacePath;
      if (workspacePath !== undefined) {
        if (typeof workspacePath !== "string")
          throw new Error("工作区路径不合法");
        workspacePath = canonicalWorkspacePath(workspacePath);
      } else {
        workspacePath = join(dataDir, "sessions", id, "workspace");
        try {
          mkdirSync(workspacePath, { recursive: true });
        } catch {
          throw new Error(
            "无法创建独立会话专用目录，请检查应用数据目录权限后重试"
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
        const session = manager.create({
          id,
          projectId: request.projectId,
          creationRequestId: request.requestId,
          ...workspace,
          title: request.text.trim().split(/\r?\n/)[0]!.slice(0, 60),
          approvalMode: approval,
        });
        await send(
          session.id,
          request.text,
          profile.id,
          request.mentionPaths,
          effort
        );
        workbench.started(
          request.projectId,
          request.requestId,
          session.id,
          {
            providerProfileId: profile.id,
            thinkingEffort: effort,
            approvalMode: approval,
          },
          available[0]?.id ?? ""
        );
        const current = manager.list().find((item) => item.id === session.id);
        if (!current) throw new Error("原会话已移除，请新建会话后发送");
        return current;
      } catch (error) {
        // 删除记录也会让历史为空；已成功的意图墓碑绝不能误当成创建失败并回收磁盘。
        if (
          !manager.isRemovedCreationRequest(request.requestId) &&
          !manager.messages(id).length
        ) {
          manager.removeUnstarted(id);
          if (rollbackWorkspace && !(await rollbackWorkspace())) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}；无法确认副本可安全回收，已保留目录：${preparedPath}（未创建正式会话，可重试）`,
              { cause: error }
            );
          }
          if (!project && request.workspacePath === undefined) {
            // 非递归 rmdir：只撤销本次分配且仍为空的目录，有任何成果就保留。
            try {
              rmdirSync(workspacePath);
              rmdirSync(join(dataDir, "sessions", id));
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

  dualHandle(
    IPC.tasks.selectWorkspace,
    IPC.sessions.selectWorkspace,
    async () => {
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
    }
  );

  dualHandle(
    IPC.tasks.messages,
    IPC.sessions.messages,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("messages：sessionId 必须是字符串");
      }
      return manager.transcript(sessionId);
    }
  );

  /**
   * 发送核心（review 重构拆分）：用户直发与队列消费共用——参数校验、参数快照、
   * 占位、流式事件泵。来源以具名 source 区分（取代 fromQueue 布尔尾参）：
   * - user：渲染层直发。会话忙时改为入队（票 01）；等待用户交互时明确拒绝；
   *   暂停期间的直发登记为插话（票 02）。
   * - queue：队列消费内部发送。不再入队（避免自我吞掉），也不算插话；
   *   参数取入队时的快照。竞态以启动失败保留条目。
   */
  async function deliverMessage(input: {
    source: "user" | "queue";
    sessionId: unknown;
    text: unknown;
    profileId?: unknown;
    mentionPaths?: unknown;
    thinkingEffort?: unknown;
    approvalMode?: unknown;
  }) {
    const { source, sessionId, text } = input;
    const fromUser = source === "user";
    assertOpen();
    if (typeof sessionId !== "string" || typeof text !== "string") {
      throw new Error("send：参数不合法");
    }
    if (text.trim() === "") {
      throw new Error("消息内容不能为空");
    }
    const saved = manager.readWorkbench(
      workbenchKey({ kind: "session", sessionId })
    );
    const { approvalMode } = input;
    let profileId = input.profileId;
    let thinkingEffort = input.thinkingEffort;
    profileId ??= saved?.value.preferences.providerProfileId;
    thinkingEffort ??= saved?.value.preferences.thinkingEffort;
    if (typeof profileId !== "string" || profileId === "") {
      throw new Error("请先选择模型（Provider Profile）");
    }
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
    const session = manager.get(sessionId);
    if (session === null) {
      throw new Error("会话不存在或已损坏");
    }
    const approvalSnapshot =
      approvalMode ??
      saved?.value.preferences.approvalMode ??
      session.record.approvalMode;
    if (!(APPROVAL_MODES as readonly unknown[]).includes(approvalSnapshot))
      throw new Error("审批模式不合法");
    const profile = (await profiles.list()).find(
      (candidate: ProviderProfile) => candidate.id === profileId
    );
    if (profile === undefined) {
      throw new Error("所选 Provider Profile 不存在，请重新选择模型");
    }

    // 输入队列（票 01）：会话忙时不再报错，而是入队（主进程单一真相）。
    // 入队即快照发送参数（Profile / 思考档位 / 审批模式 / @引用），消费按快照发。
    if (fromUser) {
      const executionState = management.execution(sessionId);
      // 等待用户交互（审批/问答，spec 用户故事 17 / Out of Scope）：UI 已禁用，
      // 直调 IPC 绕过 UI 的发送一律拒绝——明确中文报错，不入队也不触发消费
      //（排队消息会卡在无法消费的时机）。
      if (executionState?.waitingForUser) {
        throw new Error("会话正在等待审批或问答，请先回应后再发送");
      }
      if (executionState?.running ?? false) {
        queues.enqueue(sessionId, {
          text,
          mentionPaths: mentionPaths ?? [],
          providerProfileId: profile.id,
          thinkingEffort: effortSnapshot,
          approvalMode: approvalSnapshot as ApprovalMode,
        });
        return;
      }
    }

    // @引用 内容在主进程读取（路径限制在工作区内），失败以中文异常抛回
    const mentions = readMentionAttachments(
      session.record.workspacePath,
      mentionPaths ?? []
    );

    // await 后复查退出闸门；已到达的异步发送不能在 flush 期间偷启动。
    await resumeAcceptedStart();
    assertOpen();
    // 宿主原子占位，第二次 send 不得覆盖第一轮的中断通道。
    const { executionId, controller, rollbackLive, end } =
      beginExecution(sessionId);
    // 插话（票 02）：暂停期间的直发消息已开始执行——回复结束（完成/出错/
    // 中断）时自动清除暂停标志并恢复队列消费（协调器 onIdle 兑现）。
    if (fromUser && queues.isPaused(sessionId)) {
      queues.beginInterjection(sessionId);
    }
    try {
      // 先 await 第一个事件（user-message）：会话并发拒绝等启动错误
      // 在这里以异常抛回渲染进程；之后的事件异步推送。
      // 先落中间变量再取 [Symbol.asyncIterator]()：对象字面量后直接
      // 换行接 [ 会被读成索引访问（ASI 陷阱），也触发 no-unexpected-multiline。
      const execution = session.sendMessage({
        text,
        profile,
        mentions,
        thinkingEffort: effortSnapshot,
        approvalMode: approvalSnapshot as ApprovalMode,
        signal: controller.signal,
      });
      const iterator = execution[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done !== true) {
        manager.markUsed(sessionId);
        emit({ sessionId, executionId, event: first.value });
      }
      track(
        (async () => {
          for (
            let head = await iterator.next();
            !head.done;
            head = await iterator.next()
          ) {
            emit({ sessionId, executionId, event: head.value });
          }
        })()
          .catch((error: unknown) => {
            // 防御：流中途的意外异常不应成为未处理 rejection
            console.error("[sessions] 事件流意外终止", error);
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

  /** 渲染层发送入口（sessions.send IPC）：忙时入队、等待用户交互时拒绝、空闲直发。 */
  async function send(
    sessionId: unknown,
    text: unknown,
    profileId?: unknown,
    mentionPaths?: unknown,
    thinkingEffort?: unknown,
    approvalMode?: unknown
  ) {
    await deliverMessage({
      source: "user",
      sessionId,
      text,
      profileId,
      mentionPaths,
      thinkingEffort,
      approvalMode,
    });
  }

  /** 队列消费的内部发送（review 重构）：参数取入队时快照，跳过入队与插话登记。 */
  function sendQueued(sessionId: string, entry: QueuedMessage): Promise<void> {
    return deliverMessage({
      source: "queue",
      sessionId,
      text: entry.text,
      profileId: entry.providerProfileId,
      mentionPaths: entry.mentionPaths,
      thinkingEffort: entry.thinkingEffort,
      approvalMode: entry.approvalMode,
    });
  }
  dualHandle(
    IPC.tasks.send,
    IPC.sessions.send,
    (_e, ...args: Parameters<typeof send>) => track(send(...args))
  );

  dualHandle(
    IPC.tasks.interrupt,
    IPC.sessions.interrupt,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("interrupt：sessionId 必须是字符串");
      }
      // 有活跃流则打断（abort 贯穿流式层与工具层）；空闲会话幂等返回 false
      const interrupted = interrupts.interrupt(sessionId);
      if (interrupted) {
        liveSessions.stop(sessionId);
        // 停止路径（票 02）：排队消息存在时置队列暂停——队列原样保留、
        // 中断落定后的空闲不消费，等待恢复/清空/插话三个出口。
        queues.pause(sessionId);
      }
      return interrupted;
    }
  );

  function assertQueueSession(sessionId: unknown): asserts sessionId is string {
    assertOpen();
    if (typeof sessionId !== "string" || !sessionId.trim())
      throw new Error("队列操作：会话标识不合法");
    const record = manager.list().find((item) => item.id === sessionId);
    if (!record) throw new Error("会话不存在或已移除");
    if (record.archivedAt !== null)
      throw new Error("会话已归档，请先恢复再操作队列");
  }
  function assertQueueItemId(id: unknown): asserts id is string {
    if (typeof id !== "string" || !id.trim())
      throw new Error("队列操作：条目标识不合法");
  }
  /** 队列状态快照（review 重构）：queue / paused / sendingId 三元组单点取数。 */
  function queueSnapshot(sessionId: string): QueueSnapshot {
    return {
      queue: queues.snapshot(sessionId),
      paused: queues.isPaused(sessionId),
      sendingId: queues.sendingItem(sessionId),
    };
  }
  function queueResult(sessionId: string): QueueOperationResult {
    return {
      sessionId,
      sequence: liveSessions.view(sessionId)?.sequence ?? 0,
      ...queueSnapshot(sessionId),
    };
  }
  dualHandle(
    IPC.tasks.queueRemove,
    IPC.sessions.queueRemove,
    (_e, sessionId: unknown, id: unknown) => {
      assertQueueSession(sessionId);
      assertQueueItemId(id);
      queues.remove(sessionId, id);
      return queueResult(sessionId);
    }
  );
  dualHandle(
    IPC.tasks.queueUpdate,
    IPC.sessions.queueUpdate,
    (
      _e,
      sessionId: unknown,
      id: unknown,
      text: unknown,
      expectedText: unknown,
      mentionPaths: unknown
    ) => {
      assertQueueSession(sessionId);
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
        sessionId,
        id,
        { text, mentionPaths: (mentionPaths as string[] | undefined) ?? [] },
        expectedText
      );
      return queueResult(sessionId);
    }
  );
  dualHandle(
    IPC.tasks.queueReorder,
    IPC.sessions.queueReorder,
    (_e, sessionId: unknown, orderedIds: unknown) => {
      assertQueueSession(sessionId);
      if (
        !Array.isArray(orderedIds) ||
        orderedIds.some((id) => typeof id !== "string" || !id.trim()) ||
        new Set(orderedIds).size !== orderedIds.length
      )
        throw new Error("重排：条目顺序清单不合法");
      queues.reorder(sessionId, orderedIds as string[]);
      return queueResult(sessionId);
    }
  );

  dualHandle(
    IPC.tasks.queueResume,
    IPC.sessions.queueResume,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      // 参数与会话校验统一走 assertQueueSession（review 重构），与其余队列操作一致
      assertQueueSession(sessionId);
      queues.resume(sessionId);
      return queueResult(sessionId);
    }
  );

  dualHandle(
    IPC.tasks.queueClear,
    IPC.sessions.queueClear,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      assertQueueSession(sessionId);
      queues.clearQueue(sessionId);
      return queueResult(sessionId);
    }
  );

  dualHandle(
    IPC.tasks.rename,
    IPC.sessions.rename,
    (_e: IpcMainInvokeEvent, sessionId: unknown, title: unknown) => {
      if (typeof sessionId !== "string" || typeof title !== "string") {
        throw new Error("rename：参数不合法");
      }
      return manager.rename(sessionId, title);
    }
  );

  dualHandle(
    IPC.tasks.archive,
    IPC.sessions.archive,
    (_e: IpcMainInvokeEvent, sessionId: unknown, archived: unknown) => {
      if (typeof sessionId !== "string" || typeof archived !== "boolean") {
        throw new Error("archive：参数不合法");
      }
      // 先在同一同步操作点检查活动状态并写入；拒绝时不释放浏览器或中断任务。
      const result = management.archive(sessionId, archived);
      if (archived && result) {
        void browserManager?.closeTask(sessionId).catch(() => {});
      }
      // 归档只整理记录，不触发磁盘回收（包括新模型隔离保留的旧 Worktree）。
      return result;
    }
  );

  dualHandle(
    IPC.tasks.toolImage,
    IPC.sessions.toolImage,
    (_e: IpcMainInvokeEvent, sessionId: unknown, toolCallId: unknown) => {
      if (typeof sessionId !== "string" || typeof toolCallId !== "string") {
        throw new Error("toolImage：参数不合法");
      }
      const path = screenshotPathFor(dataDir, sessionId, toolCallId);
      if (!existsSync(path)) {
        return null;
      }
      return `data:image/png;base64,${readFileSync(path).toString("base64")}`;
    }
  );

  dualHandle(
    IPC.tasks.status,
    IPC.sessions.status,
    async (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("status：sessionId 必须是字符串");
      }
      const record = manager
        .list()
        .find((candidate: TaskRecord) => candidate.id === sessionId);
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
      const { active, last } = manager.resourceState(sessionId);
      return buildTaskStatus({
        record,
        messages: manager.messages(sessionId),
        resources: active ?? resourcesFor(record).summary(),
        resourcePhase: active === null ? "preview" : "active",
        lastResources: last,
        providerProfileName: profile?.name ?? null,
        // 上下文告警阈值 = Profile 可配的上下文窗口 × 80%（未配置走 agent-core 默认 128k）
        contextWindowTokens: profile?.contextWindowTokens ?? null,
        latestCompact: manager.latestCompact(sessionId),
      });
    }
  );

  dualHandle(
    IPC.tasks.resources,
    IPC.sessions.resources,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("resources：sessionId 必须是字符串");
      }
      const record = manager
        .list()
        .find((candidate) => candidate.id === sessionId);
      if (record === undefined) {
        return null;
      }
      return {
        ...manager.resourceState(sessionId),
        preview: resourcesFor(record).summary(),
      };
    }
  );

  dualHandle(
    IPC.tasks.compact,
    IPC.sessions.compact,
    (_e: IpcMainInvokeEvent, sessionId: unknown, profileId: unknown) =>
      track(
        (async () => {
          assertOpen();
          if (typeof sessionId !== "string" || typeof profileId !== "string") {
            throw new Error("compact：参数不合法");
          }
          if (profileId === "") {
            throw new Error("请先选择模型（Provider Profile）");
          }
          const session = manager.get(sessionId);
          if (session === null) {
            throw new Error("会话不存在或已损坏");
          }
          const profile = (await profiles.list()).find(
            (candidate: ProviderProfile) => candidate.id === profileId
          );
          if (profile === undefined) {
            throw new Error("所选 Provider Profile 不存在，请重新选择模型");
          }
          await resumeAcceptedStart();
          assertOpen();
          const { executionId, controller, end } = beginExecution(sessionId);
          emit({ sessionId, executionId, event: { type: "compact-start" } });
          try {
            const result = await session.compact({
              profile,
              signal: controller.signal,
            });
            emit({
              sessionId,
              executionId,
              event: {
                type: "compact-finished",
                outcome: "completed",
                history: manager.transcript(sessionId),
              },
            });
            return { compactedMessages: result.compactedMessages };
          } catch (error) {
            emit({
              sessionId,
              executionId,
              event: {
                type: "compact-finished",
                outcome: controller.signal.aborted ? "interrupted" : "failed",
                history: manager.transcript(sessionId),
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

  dualHandle(
    IPC.tasks.workspaceFiles,
    IPC.sessions.workspaceFiles,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("workspaceFiles：sessionId 必须是字符串");
      }
      const record = manager
        .list()
        .find((candidate: TaskRecord) => candidate.id === sessionId);
      if (record === undefined) {
        throw new Error("会话不存在或已损坏");
      }
      return listWorkspaceFiles(record.workspacePath);
    }
  );

  dualHandle(
    IPC.tasks.revokeAutoApprove,
    IPC.sessions.revokeAutoApprove,
    (_e, sessionId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim())
        throw new Error("revokeAutoApprove：参数不合法");
      return manager.revokeAutoApprove(sessionId);
    }
  );

  dualHandle(
    IPC.tasks.setApprovalMode,
    IPC.sessions.setApprovalMode,
    (_e: IpcMainInvokeEvent, sessionId: unknown, mode: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("setApprovalMode：sessionId 必须是字符串");
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
      const key = workbenchKey({ kind: "session", sessionId });
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
      return manager.setApprovalMode(sessionId, mode as ApprovalMode);
    }
  );

  dualHandle(
    IPC.tasks.pendingInteractions,
    IPC.sessions.pendingInteractions,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string" || sessionId.trim() === "") {
        throw new Error("pendingInteractions：sessionId 必须是非空字符串");
      }
      return manager.get(sessionId)?.pendingInteractions ?? [];
    }
  );

  dualHandle(
    IPC.tasks.respondInteraction,
    IPC.sessions.respondInteraction,
    (
      _e: IpcMainInvokeEvent,
      sessionId: unknown,
      requestId: unknown,
      response: unknown
    ) => {
      if (
        typeof sessionId !== "string" ||
        sessionId.trim() === "" ||
        typeof requestId !== "string" ||
        requestId.trim() === ""
      ) {
        throw new Error("respondInteraction：参数不合法");
      }
      const session = manager.get(sessionId);
      if (session === null) {
        throw new Error("会话不存在或已损坏");
      }
      assertOpen();
      // Core 以自身持有的请求校验响应，不能信任渲染层提供的题目、来源或授权范围。
      return session.respondInteraction(requestId, response);
    }
  );

  dualHandle(
    IPC.tasks.respondApproval,
    IPC.sessions.respondApproval,
    (
      _e: IpcMainInvokeEvent,
      sessionId: unknown,
      requestId: unknown,
      decision: unknown
    ) => {
      if (typeof sessionId !== "string" || typeof requestId !== "string") {
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
      const session = manager.get(sessionId);
      if (session === null) {
        throw new Error("会话不存在或已损坏");
      }
      assertOpen();
      return session.respondApproval(requestId, decision);
    }
  );

  dualHandle(
    IPC.tasks.pendingApproval,
    IPC.sessions.pendingApproval,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("pendingApproval：sessionId 必须是字符串");
      }
      const session = manager.get(sessionId);
      // 会话不存在与无等待统一返回 null（切回会话时 UI 不渲染审批卡片）
      return session?.pendingApproval ?? null;
    }
  );

  dualHandle(
    IPC.tasks.pendingApprovals,
    IPC.sessions.pendingApprovals,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("pendingApprovals：sessionId 必须是字符串");
      }
      const session = manager.get(sessionId);
      // 主会话与子代理可能并行等待审批（工单 13），全部返回供 UI 恢复多张审批卡片
      return session?.pendingApprovals ?? [];
    }
  );

  function continueInputQueues() {
    for (const record of manager.list()) {
      // 跳过执行中的会话：此时 onIdle 会把在途插话误判为已完成而提前
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
        liveSessions.stop(id);
      }
      // 首次发送/异步profile查询也必须排空；它们复查退出闸门后拒绝启动。
      while (starts.size || tasks.size)
        await Promise.allSettled([...starts.values(), ...tasks]);
      manager.cancelInteractions("应用已退出");
    },
  };
}
