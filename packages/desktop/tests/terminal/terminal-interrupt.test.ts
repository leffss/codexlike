import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  createTerminalSessionManager,
  type PtyExitEvent,
  type PtyPort,
  type PtyProcess,
  type PtySpawnRequest,
} from "@codexlike/agent-core/node";

import { createInterruptRegistry } from "../../src/tasks/interrupt-registry";

/**
 * 任务中断不杀终端会话（ADR 0033 核心取舍，GLOSSARY「终端会话」）：
 * 任务级中断的唯一通道是 InterruptRegistry 的 AbortController（tasks:interrupt
 * IPC → interrupt → abort 贯穿 streamText 与工具子进程），子代理随 abort 共存亡；
 * 终端会话是宿主级常驻实体——长命令躲开任务中断正是功能存在理由，中断路径
 * 不得触达终端注册表。agent-core 层的对照证据见
 * agent-core/tests/terminal/terminal-sessions-task.test.ts「中断不杀会话」用例
 * （terminal_read 等待中被 abort：工具调用即断、会话仍 running、进程未杀）；
 * 本文件在 desktop 层验证中断注册表与终端管理器两个宿主件之间无耦合，
 * 且任务中断后会话照常收发（fake pty 驱动，绝不触 node-pty 真件）。
 */

/** fake PtyPort：记录每次 spawn，产出可控 fake 进程（与 terminal-session-ipc 测试同款） */
function createFakePort() {
  interface FakePtyRecord {
    request: PtySpawnRequest;
    written: string[];
    killed: boolean;
    emitData(text: string): void;
    exit(event?: { exitCode: number; signal?: number }): void;
  }
  const records: FakePtyRecord[] = [];
  const port: PtyPort = {
    spawn(request) {
      const dataListeners: ((data: string) => void)[] = [];
      const exitListeners: ((event: PtyExitEvent) => void)[] = [];
      const record: FakePtyRecord = {
        request,
        written: [],
        killed: false,
        emitData(text) {
          for (const listener of [...dataListeners]) listener(text);
        },
        exit(event = { exitCode: 0 }) {
          for (const listener of [...exitListeners]) listener(event);
        },
      };
      records.push(record);
      const process: PtyProcess = {
        pid: 4000 + records.length,
        write(data) {
          record.written.push(data);
        },
        resize() {},
        kill() {
          record.killed = true;
        },
        onData(listener) {
          dataListeners.push(listener);
          return () => {
            const index = dataListeners.indexOf(listener);
            if (index >= 0) dataListeners.splice(index, 1);
          };
        },
        onExit(listener) {
          exitListeners.push(listener);
          return () => {
            const index = exitListeners.indexOf(listener);
            if (index >= 0) exitListeners.splice(index, 1);
          };
        },
      };
      return process;
    },
  };
  return { port, records };
}

function spawnUserSession(
  manager: ReturnType<typeof createTerminalSessionManager>,
  taskId: string
) {
  const outcome = manager.spawn({
    taskId,
    shell: "git-bash",
    origin: "user",
    cwd: "C:\\work\\demo",
  });
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.sessionId;
}

it("任务中断不杀终端会话：interrupt abort 后会话仍 running、进程未被终止", () => {
  const registry = createInterruptRegistry();
  const { port, records } = createFakePort();
  const manager = createTerminalSessionManager({ port });

  // 任务消息流登记（tasks:send 路径）与用户手开终端会话并存
  const controller = registry.begin("task-1");
  const sessionId = spawnUserSession(manager, "task-1");
  expect(manager.session(sessionId)?.status).toBe("running");

  // 用户点停止：abort 贯穿任务执行，但不得触达终端注册表
  expect(registry.interrupt("task-1")).toBe(true);
  expect(controller.signal.aborted).toBe(true);

  expect(manager.session(sessionId)?.status).toBe("running");
  expect(records[0]!.killed).toBe(false);
});

it("中断后输出继续产生：abort 后 fake pty 输出照常到达实时监听与读取水位", async () => {
  const registry = createInterruptRegistry();
  const { port, records } = createFakePort();
  const manager = createTerminalSessionManager({ port });

  registry.begin("task-1");
  const sessionId = spawnUserSession(manager, "task-1");

  registry.interrupt("task-1");

  // 实时监听（xterm 直写通道）照常收数
  const streamed: string[] = [];
  const unsubscribe = manager.onSessionData(sessionId, (data) =>
    streamed.push(data)
  );
  records[0]!.emitData("build output after abort\r\n");
  expect(streamed).toEqual(["build output after abort\r\n"]);
  unsubscribe();

  // 读取水位照常推进（terminal_read / 详情页回看的数据源）
  const result = await manager.read(sessionId);
  expect(result).toMatchObject({
    data: "build output after abort\r\n",
    status: "running",
  });
});

it("中断路径不触达终端注册表：中断注册表本体无终端管理器引用（形状守卫）", () => {
  // InterruptRegistry 本体不得引用终端会话管理器——未来的意外接线在这里报警。
  // task-ipc.ts 的归档路径（terminalSessions 先杀后归档）是本票的合法触达，
  // 其 tasks:interrupt handler 只经 registry.interrupt 走 abort（行为级保证
  // 由上方两个用例覆盖：abort 后会话仍 running 且输出继续）。
  const source = readFileSync(
    join(__dirname, "..", "..", "src/tasks/interrupt-registry.ts"),
    "utf-8"
  );
  expect(source).not.toMatch(
    /terminalSessions|TerminalSessionManager|terminal-session/
  );
});
