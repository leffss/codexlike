import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";

import type {
  TerminalSessionManager,
  TerminalShell,
} from "@codexlike/agent-core/node";
import type { TaskEvent } from "@codexlike/agent-core";

import { IPC, type TerminalSessionDataPayload } from "../shared/ipc";
import { filterSessionEnv } from "./session-env";

/**
 * 终端会话 IPC（ADR 0033 票03）：宿主级 TerminalSessionManager（main.ts
 * 装配的单例）的渲染端操作面，独立 terminals namespace，对齐 tasks 三段式——
 *
 * - 快照段：session / listFor（单会话记录与任务内清单）
 * - 订阅段：subscribe（携会话记录与缓冲全量回放，不推读取水位）
 * - 事件段：sessionData 专用通道实时直写渲染端（高频字节流，绝不进
 *   React 状态）；生命周期 terminal-* 事件并入 taskEvents（pushTaskEvent
 *   桥接，live-tasks 白名单放行 terminal 类）。
 *
 * 会话创建强制 cwd = 任务工作区（workspaceFor 单一来源，不接受任意 cwd
 * 参数——ADR 0004）、shell 跟随执行设置（resolver 逐次解析）、origin 固定
 * user（agent 侧 spawn 走 05 票工具层，同用 main.ts 装配的同一单例）。
 * kill 注册表即管理器本身（按 sessionId 的注册表、状态机与进程树 kill，
 * 02 票适配器保证死透）——不建平行 Map（02 票 Comments 设计依据）。
 */
export function registerTerminalSessionHandlers(options: {
  /** 终端会话管理器（宿主级单例，main.ts 装配 createTerminalSessionManager） */
  sessions: TerminalSessionManager;
  /**
   * 任务 → 工作区路径（会话 cwd 单一来源）；任务不存在返回 null。
   * main.ts 注入 manager.get(taskId)?.record.workspacePath。
   */
  workspaceFor: (taskId: string) => string | null;
  /** shell 逐次解析（执行设置缓存，设置保存后对下一次创建即时生效） */
  shell: () => TerminalShell;
  /** 宿主环境变量（白名单过滤后进 spawn 请求）；缺省 process.env */
  env?: Record<string, string | undefined>;
  /** 主窗口（sessionData 专用通道接收方） */
  getWindow: () => BrowserWindow | null;
  /** 终端生命周期 → taskEvents 通道的桥（task-ipc 装配返回的 pushTaskEvent） */
  pushTaskEvent: (taskId: string, event: TaskEvent) => void;
}): void {
  const { sessions, workspaceFor, shell, env, getWindow, pushTaskEvent } =
    options;
  /**
   * 字节流转发订阅（按 sessionId）：订阅幂等登记——同会话重复 subscribe
   * 不叠加监听（叠加会让 xterm 收到重复字节）。退订函数持有在 Map，
   * unsubscribe 时归还管理器。
   */
  const subscriptions = new Map<string, () => void>();

  // 生命周期事件桥：manager.onEvent → terminal-* TaskEvent（record 为事件
  // 时刻完整副本）。字节流不走本桥（双通道纪律：数据与状态分离）。
  sessions.onEvent((event) => {
    if (event.kind === "terminal-started") {
      pushTaskEvent(event.record.taskId, {
        type: "terminal-started",
        record: event.record,
      });
    } else {
      pushTaskEvent(event.record.taskId, {
        type: "terminal-exited",
        record: event.record,
      });
    }
  });

  ipcMain.handle(IPC.terminals.create, (_e: IpcMainInvokeEvent, input) => {
    if (!input || typeof input !== "object") {
      throw new Error("创建终端会话：参数不合法");
    }
    const { taskId, initialCommand } = input as Record<string, unknown>;
    if (typeof taskId !== "string" || taskId.trim() === "") {
      throw new Error("创建终端会话：taskId 必须是非空字符串");
    }
    if (
      initialCommand !== undefined &&
      (typeof initialCommand !== "string" || initialCommand.trim() === "")
    ) {
      throw new Error("创建终端会话：initialCommand 必须是非空字符串");
    }
    const workspace = workspaceFor(taskId);
    if (workspace === null) {
      throw new Error("任务不存在或已移除，无法创建终端会话");
    }
    // origin 固定 user：IPC 面只服务用户手开（agent 侧走工具层，05 票）
    return sessions.spawn({
      taskId,
      shell: shell(),
      origin: "user",
      cwd: workspace,
      env: filterSessionEnv(env ?? process.env),
      ...(initialCommand !== undefined ? { initialCommand } : {}),
    });
  });

  ipcMain.handle(
    IPC.terminals.write,
    (_e: IpcMainInvokeEvent, sessionId: unknown, data: unknown) => {
      if (typeof sessionId !== "string" || sessionId.trim() === "") {
        throw new Error("终端写入：sessionId 必须是非空字符串");
      }
      if (typeof data !== "string") {
        throw new Error("终端写入：输入内容必须是字符串");
      }
      return sessions.write(sessionId, data);
    }
  );

  ipcMain.handle(
    IPC.terminals.resize,
    (_e: IpcMainInvokeEvent, sessionId: unknown, size: unknown) => {
      if (typeof sessionId !== "string" || sessionId.trim() === "") {
        throw new Error("resize：sessionId 必须是非空字符串");
      }
      if (!size || typeof size !== "object") {
        throw new Error("resize：尺寸参数不合法");
      }
      const { cols, rows } = size as Record<string, unknown>;
      if (
        typeof cols !== "number" ||
        typeof rows !== "number" ||
        !Number.isFinite(cols) ||
        !Number.isFinite(rows)
      ) {
        throw new Error("resize：cols 与 rows 必须是数字");
      }
      // 会话不存在 / 已退出静默忽略（01 票口径，渲染端无需防御）
      sessions.resize(sessionId, { cols, rows });
    }
  );

  ipcMain.handle(
    IPC.terminals.kill,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string" || sessionId.trim() === "") {
        throw new Error("终止终端：sessionId 必须是非空字符串");
      }
      return sessions.kill(sessionId);
    }
  );

  ipcMain.handle(
    IPC.terminals.subscribe,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string" || sessionId.trim() === "") {
        throw new Error("订阅终端输出：sessionId 必须是非空字符串");
      }
      const record = sessions.session(sessionId);
      if (record === undefined) {
        return { ok: false, reason: `终端会话不存在：${sessionId}` };
      }
      if (!subscriptions.has(sessionId)) {
        subscriptions.set(
          sessionId,
          sessions.onSessionData(sessionId, (data) => {
            const win = getWindow();
            if (win === null || win.isDestroyed()) return;
            win.webContents.send(IPC.terminals.sessionData, {
              sessionId,
              data,
            } satisfies TerminalSessionDataPayload);
          })
        );
      }
      // 初始回放：当前缓冲全量（不推读取水位——05 票工具 read 的水位语义不受影响）
      return {
        ok: true,
        sessionId,
        record,
        buffered: sessions.bufferedOutput(sessionId) ?? "",
      };
    }
  );

  ipcMain.handle(
    IPC.terminals.unsubscribe,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string" || sessionId.trim() === "") {
        throw new Error("退订终端输出：sessionId 必须是非空字符串");
      }
      const release = subscriptions.get(sessionId);
      if (release !== undefined) {
        release();
        subscriptions.delete(sessionId);
      }
    }
  );

  ipcMain.handle(
    IPC.terminals.session,
    (_e: IpcMainInvokeEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string") {
        throw new Error("session：sessionId 必须是字符串");
      }
      return sessions.session(sessionId) ?? null;
    }
  );

  ipcMain.handle(
    IPC.terminals.listFor,
    (_e: IpcMainInvokeEvent, taskId: unknown) => {
      if (typeof taskId !== "string" || taskId.trim() === "") {
        throw new Error("listFor：taskId 必须是非空字符串");
      }
      return sessions.sessionsFor(taskId);
    }
  );
}
