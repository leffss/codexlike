import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
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
  type AgentResourceSnapshot,
  type ApprovalMode,
  type BrowserSessionManager,
  type ProviderProfile,
  type SessionManager,
  type SessionRecord,
  type WorktreeService,
} from "@codexlike/agent-core/node";

import type { ProfileStore } from "../profiles/profile-store";
import { createInterruptRegistry } from "./interrupt-registry";
import { readMentionAttachments } from "./mentions";
import { screenshotPathFor } from "./screenshots";
import { buildSessionStatus } from "./status";
import { listWorkspaceFiles } from "./workspace-files";
import {
  IPC,
  type SessionEventEnvelope,
  type StartSessionInput,
} from "../shared/ipc";

/** 注册会话相关 IPC 指令；事件流经 IPC.sessionEvents 推送给主窗口 */
export function registerSessionHandlers(options: {
  manager: SessionManager;
  profiles: ProfileStore;
  getWindow: () => BrowserWindow | null;
  /** 应用数据目录（截图读回的路径约定；工单 11） */
  dataDir: string;
  /** 浏览器会话管理器（会话归档时释放其浏览器 context；工单 11） */
  browserManager?: BrowserSessionManager;
  /** 托管 Worktree 服务（工单 09）：worktree 模式会话创建与 LRU 清理 */
  worktreeService: WorktreeService;
  /** 与真实发送共用的发现工厂；预览不会替换运行中的快照。 */
  resourcesFor: (record: SessionRecord) => AgentResourceSnapshot;
}): void {
  const {
    manager,
    profiles,
    getWindow,
    dataDir,
    browserManager,
    worktreeService,
    resourcesFor,
  } = options;
  // 每条运行中的消息流登记一个 AbortController：停止按钮（sessions:interrupt）→
  // abort 贯穿流式输出与工具执行（长命令子进程树终止）
  const interrupts = createInterruptRegistry();
  const executions = new Map<string, string>();
  const starts = new Map<string, Promise<SessionRecord>>();

  function emit(envelope: SessionEventEnvelope): void {
    const win = getWindow();
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(IPC.sessionEvents, envelope);
    }
  }

  ipcMain.handle(IPC.projects.list, () => manager.projects());
  ipcMain.handle(IPC.projects.add, (_e: IpcMainInvokeEvent, path: unknown) => {
    if (typeof path !== "string" || !path.trim())
      throw new Error("请选择项目目录");
    return manager.addProject(path);
  });
  ipcMain.handle(IPC.sessions.list, () => manager.list());
  ipcMain.handle(IPC.sessions.execution, (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string")
      throw new Error("execution：sessionId 必须是字符串");
    const record = manager.list().find((session) => session.id === sessionId);
    if (!record) return null;
    const pending = manager.get(sessionId)?.pendingInteractions ?? [];
    return {
      sessionId,
      executionId: executions.get(sessionId) ?? null,
      running:
        executions.has(sessionId) ||
        record.status !== "idle" ||
        pending.length > 0,
      waitingForUser: pending.length > 0,
      pendingInteractionIds: pending.map((item) => item.request.id),
    };
  });

  ipcMain.handle(IPC.sessions.start, (_e, input: unknown) => {
    if (!input || typeof input !== "object")
      throw new Error("首次发送参数不合法");
    const request = input as StartSessionInput;
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
    const pending = starts.get(request.requestId);
    if (pending) return pending;
    const previous = manager
      .list()
      .find((session) => session.creationRequestId === request.requestId);
    if (previous && manager.messages(previous.id).length) return previous;
    if (previous) manager.removeUnstarted(previous.id);
    const task = (async () => {
      const effort = parseThinkingEffort(request.thinkingEffort);
      const approval = request.approvalMode ?? "ask";
      if (!(APPROVAL_MODES as readonly unknown[]).includes(approval))
        throw new Error("审批模式不合法");
      if (
        request.workspaceMode !== undefined &&
        request.workspaceMode !== "local"
      )
        throw new Error("当前新建入口仅支持本地工作区");
      const available = await profiles.list();
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
        if (typeof workspacePath !== "string" || !isAbsolute(workspacePath))
          throw new Error("工作区必须是已有目录的绝对路径");
        try {
          workspacePath = realpathSync.native(workspacePath);
          if (!statSync(workspacePath).isDirectory()) throw new Error();
        } catch {
          throw new Error("工作区目录不存在或无法访问，请重新选择目录后重试");
        }
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
      try {
        const session = manager.create({
          id,
          projectId: request.projectId,
          creationRequestId: request.requestId,
          workspacePath,
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
        return manager.list().find((item) => item.id === session.id)!;
      } catch (error) {
        // 只回滚无历史记录；绝不递归删除用户目录或失败期间可能出现的成果。
        if (!manager.messages(id).length) {
          manager.removeUnstarted(id);
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

  ipcMain.handle(IPC.sessions.selectWorkspace, async () => {
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
    IPC.sessions.messages,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("messages：sessionId 必须是字符串");
      }
      return manager.transcript(sessionId);
    }
  );

  async function send(
    sessionId: unknown,
    text: unknown,
    profileId: unknown,
    mentionPaths: unknown,
    thinkingEffort: unknown
  ) {
    if (typeof sessionId !== "string" || typeof text !== "string") {
      throw new Error("send：参数不合法");
    }
    if (text.trim() === "") {
      throw new Error("消息内容不能为空");
    }
    if (typeof profileId !== "string" || profileId === "") {
      throw new Error("请先选择模型（Provider Profile）");
    }
    if (
      mentionPaths !== undefined &&
      (!Array.isArray(mentionPaths) ||
        mentionPaths.some((path) => typeof path !== "string"))
    ) {
      throw new Error("send：@引用 路径列表不合法");
    }
    // 思考档位（GLOSSARY「思考档位」）：IPC 边界不信任渲染进程，只接受五档枚举；
    // 校验走 agent-core 统一入口（未传等价 auto，非法值以中文异常抛回渲染进程；
    // agent-core 发送入口同样校验，双保险）
    const effortSnapshot = parseThinkingEffort(thinkingEffort);
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

    // @引用 内容在主进程读取（路径限制在工作区内），失败以中文异常抛回
    const mentions = readMentionAttachments(
      session.record.workspacePath,
      (mentionPaths as string[] | undefined) ?? []
    );

    // 宿主原子占位，第二次 send 不得覆盖第一轮的中断通道。
    if (executions.has(sessionId))
      throw new Error("会话正在执行或等待用户回应");
    const executionId = randomUUID();
    executions.set(sessionId, executionId);
    // 本条消息流的中断通道：停止按钮经 sessions:interrupt 打断
    const controller = interrupts.begin(sessionId);
    try {
      // 先 await 第一个事件（user-message）：会话并发拒绝等启动错误
      // 在这里以异常抛回渲染进程；之后的事件异步推送。
      const iterator = session
        .sendMessage({
          text,
          profile,
          mentions,
          thinkingEffort: effortSnapshot,
          signal: controller.signal,
        })
        [Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done !== true) {
        emit({ sessionId, executionId, event: first.value });
      }
      void (async () => {
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
          interrupts.end(sessionId, controller);
          if (executions.get(sessionId) === executionId)
            executions.delete(sessionId);
        });
    } catch (error) {
      // 启动失败：注销中断登记后再抛回渲染进程
      interrupts.end(sessionId, controller);
      if (executions.get(sessionId) === executionId)
        executions.delete(sessionId);
      throw error;
    }
  }
  ipcMain.handle(IPC.sessions.send, (_e, ...args: Parameters<typeof send>) =>
    send(...args)
  );

  ipcMain.handle(
    IPC.sessions.interrupt,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("interrupt：sessionId 必须是字符串");
      }
      // 有活跃流则打断（abort 贯穿流式层与工具层）；空闲会话幂等返回 false
      return interrupts.interrupt(sessionId);
    }
  );

  ipcMain.handle(
    IPC.sessions.rename,
    (_e: IpcMainInvokeEvent, sessionId: unknown, title: unknown) => {
      if (typeof sessionId !== "string" || typeof title !== "string") {
        throw new Error("rename：参数不合法");
      }
      return manager.rename(sessionId, title);
    }
  );

  ipcMain.handle(
    IPC.sessions.archive,
    (_e: IpcMainInvokeEvent, sessionId: unknown, archived: unknown) => {
      if (typeof sessionId !== "string" || typeof archived !== "boolean") {
        throw new Error("archive：参数不合法");
      }
      // 会话结束（归档）：释放其浏览器 context（Cookie 等随之清理；工单 11）
      if (archived) {
        void browserManager?.closeSession(sessionId).catch(() => {});
      }
      const result = manager.setArchived(sessionId, archived);
      // 归档只整理记录，不触发磁盘回收（包括新模型隔离保留的旧 Worktree）。
      return result;
    }
  );

  ipcMain.handle(
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

  ipcMain.handle(
    IPC.sessions.status,
    async (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("status：sessionId 必须是字符串");
      }
      const record = manager
        .list()
        .find((candidate: SessionRecord) => candidate.id === sessionId);
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
      return buildSessionStatus({
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

  ipcMain.handle(
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

  ipcMain.handle(
    IPC.sessions.compact,
    async (_e: IpcMainInvokeEvent, sessionId: unknown, profileId: unknown) => {
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
      // 失败（模型错误/历史过短/会话正忙）以中文异常抛回渲染层；原历史不受损，可重试
      const result = await session.compact({ profile });
      return { compactedMessages: result.compactedMessages };
    }
  );

  ipcMain.handle(
    IPC.sessions.workspaceFiles,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("workspaceFiles：sessionId 必须是字符串");
      }
      const record = manager
        .list()
        .find((candidate: SessionRecord) => candidate.id === sessionId);
      if (record === undefined) {
        throw new Error("会话不存在或已损坏");
      }
      return listWorkspaceFiles(record.workspacePath);
    }
  );

  ipcMain.handle(
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
      return manager.setApprovalMode(sessionId, mode as ApprovalMode);
    }
  );

  ipcMain.handle(
    IPC.sessions.pendingInteractions,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string" || sessionId.trim() === "") {
        throw new Error("pendingInteractions：sessionId 必须是非空字符串");
      }
      return manager.get(sessionId)?.pendingInteractions ?? [];
    }
  );

  ipcMain.handle(
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
      // Core 以自身持有的请求校验响应，不能信任渲染层提供的题目、来源或授权范围。
      return session.respondInteraction(requestId, response);
    }
  );

  ipcMain.handle(
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
      return session.respondApproval(requestId, decision);
    }
  );

  ipcMain.handle(
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

  ipcMain.handle(
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
}
