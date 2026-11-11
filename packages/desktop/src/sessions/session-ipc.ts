import { existsSync, readFileSync, statSync } from "node:fs";

import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";

import {
  APPROVAL_MODES,
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
import { createSessionWithMode } from "./worktree-flow";
import { IPC, type SessionEventEnvelope } from "../shared/ipc";

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

  function emit(envelope: SessionEventEnvelope): void {
    const win = getWindow();
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(IPC.sessionEvents, envelope);
    }
  }

  ipcMain.handle(IPC.sessions.list, () => manager.list());

  ipcMain.handle(
    IPC.sessions.create,
    (
      _e: IpcMainInvokeEvent,
      workspacePath: unknown,
      workspaceMode: unknown
    ) => {
      if (typeof workspacePath !== "string" || workspacePath.trim() === "") {
        throw new Error("新建会话需要选择一个工作区目录");
      }
      // IPC 边界不信任渲染进程：目录必须真实存在
      let isDirectory = false;
      try {
        isDirectory = statSync(workspacePath).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (!isDirectory) {
        throw new Error(`工作区目录不存在：${workspacePath}`);
      }
      // 运行位置枚举校验（默认本目录直跑）；worktree 失败以中文异常抛回且会话不落库
      if (
        workspaceMode !== undefined &&
        workspaceMode !== "local" &&
        workspaceMode !== "worktree"
      ) {
        throw new Error("新建会话：运行位置必须是 local / worktree");
      }
      // 返回可结构化克隆的记录快照（AgentSession 含闭包，不可跨 IPC）
      return createSessionWithMode({
        manager,
        worktreeService,
        workspacePath,
        workspaceMode: workspaceMode ?? "local",
      });
    }
  );

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

  ipcMain.handle(
    IPC.sessions.send,
    async (
      _e: IpcMainInvokeEvent,
      sessionId: unknown,
      text: unknown,
      profileId: unknown,
      mentionPaths: unknown
    ) => {
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
            signal: controller.signal,
          })
          [Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done !== true) {
          emit({ sessionId, event: first.value });
        }
        void (async () => {
          for (
            let head = await iterator.next();
            !head.done;
            head = await iterator.next()
          ) {
            emit({ sessionId, event: head.value });
          }
        })()
          .catch((error: unknown) => {
            // 防御：流中途的意外异常不应成为未处理 rejection
            console.error("[sessions] 事件流意外终止", error);
          })
          .finally(() => {
            // 流结束（完成 / 出错 / 用户中断）后注销登记，停止按钮回到无效态
            interrupts.end(sessionId, controller);
          });
      } catch (error) {
        // 启动失败：注销中断登记后再抛回渲染进程
        interrupts.end(sessionId, controller);
        throw error;
      }
    }
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
      // 归档后触发一次 LRU 清理（一切非运行中的托管 Worktree 按量回收；
      // 运行中的永不清理；后台执行不阻塞归档反馈）
      void worktreeService
        .cleanup({ sessions: manager.list() })
        .catch((error: unknown) => {
          console.error("[sessions] worktree 清理失败", error);
        });
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
