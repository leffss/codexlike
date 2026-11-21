import { describe, expect, it } from "vitest";

import { createTerminalSessionManager } from "../../src/terminal/manager";
import type {
  PtyExitEvent,
  PtyPort,
  PtyProcess,
  PtySize,
  PtySpawnRequest,
} from "../../src/terminal/pty-port";
import type { TerminalSessionManager } from "../../src/terminal/manager";

/** 一次 PTY 进程实例的 fake：测试用它向管理器注入输出与退出事件 */
class FakePtyProcess implements PtyProcess {
  readonly pid: number | undefined;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: PtyExitEvent) => void>();
  written: string[] = [];
  resized: PtySize[] = [];
  killed = false;

  constructor(
    readonly request: PtySpawnRequest,
    pid: number
  ) {
    this.pid = pid;
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(size: PtySize): void {
    this.resized.push(size);
  }

  kill(): void {
    this.killed = true;
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** 测试辅助：模拟 shell 输出到达 */
  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  /** 测试辅助：模拟进程退出 */
  emitExit(event: PtyExitEvent = { exitCode: 0 }): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

/** PtyPort 的 fake：记录 spawn 请求并产出可控的 fake 进程 */
class FakePtyPort implements PtyPort {
  spawned: FakePtyProcess[] = [];
  private nextPid = 1000;

  spawn(request: PtySpawnRequest): PtyProcess {
    const process = new FakePtyProcess(request, this.nextPid++);
    this.spawned.push(process);
    return process;
  }
}

/** spawn 请求的默认参数（会话注册语义测试只关心差异字段） */
function spawnArgs(taskId: string) {
  return {
    taskId,
    shell: "powershell" as const,
    origin: "user" as const,
    cwd: "C:\\work",
  };
}

describe("TerminalSessionManager 会话注册（fake PtyPort 驱动）", () => {
  it("spawn 注册会话并转发请求给端口：记录任务归属、来源、shell、初始 running", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });

    const outcome = manager.spawn({
      taskId: "task-1",
      shell: "powershell",
      origin: "agent",
      cwd: "C:\\work\\demo",
      initialCommand: "pnpm build",
    });

    expect(outcome).toEqual({ ok: true, sessionId: expect.any(String) });
    if (!outcome.ok) throw new Error("spawn 应成功");
    const record = manager.session(outcome.sessionId);
    expect(record).toMatchObject({
      sessionId: outcome.sessionId,
      taskId: "task-1",
      shell: "powershell",
      origin: "agent",
      status: "running",
      createdAt: expect.any(String),
    });
    expect(record?.exitCode).toBeUndefined();
    expect(record?.exitedAt).toBeUndefined();
    expect(record?.snapshot).toBeUndefined();
    // 端口收到组装好的请求：工作区边界（ADR 0004）与初始命令原样转发
    expect(port.spawned).toHaveLength(1);
    expect(port.spawned[0]!.request).toEqual({
      shell: "powershell",
      cwd: "C:\\work\\demo",
      env: {},
      size: { cols: 80, rows: 24 },
      initialCommand: "pnpm build",
    });
  });

  it("默认名「shell · 任务内序号」：任务内递增、跨任务独立、跨 shell 类型共用计数", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });

    const first = manager.spawn({
      taskId: "task-1",
      shell: "git-bash",
      origin: "user",
      cwd: "C:\\work",
    });
    const second = manager.spawn({
      taskId: "task-1",
      shell: "powershell",
      origin: "user",
      cwd: "C:\\work",
    });
    const otherTask = manager.spawn({
      taskId: "task-2",
      shell: "cmd",
      origin: "user",
      cwd: "C:\\work",
    });

    expect(first.ok && second.ok && otherTask.ok).toBe(true);
    if (!first.ok || !second.ok || !otherTask.ok)
      throw new Error("spawn 应成功");
    expect(manager.session(first.sessionId)?.name).toBe("git-bash · 1");
    expect(manager.session(second.sessionId)?.name).toBe("powershell · 2");
    expect(manager.session(otherTask.sessionId)?.name).toBe("cmd · 1");
  });

  it("每任务存活上限拒绝：超限返回明确中文原因，其他任务不受影响", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({
      port,
      maxAlivePerTask: 2,
    });

    const first = manager.spawn(spawnArgs("task-1"));
    const second = manager.spawn(spawnArgs("task-1"));
    const third = manager.spawn(spawnArgs("task-1"));
    const otherTask = manager.spawn(spawnArgs("task-2"));

    expect(first.ok && second.ok).toBe(true);
    expect(third).toMatchObject({
      ok: false,
      reason: expect.stringContaining("上限"),
    });
    expect(third.ok === false && third.reason).toContain("2");
    // 其他任务名额独立计算
    expect(otherTask.ok).toBe(true);
    // 被拒绝的调用不产生端口进程
    expect(port.spawned).toHaveLength(3);
  });

  it("默认存活上限为 5（DEFAULT_TERMINAL_MAX_ALIVE_PER_TASK）", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });

    const outcomes = Array.from({ length: 6 }, () =>
      manager.spawn(spawnArgs("task-1"))
    );

    expect(outcomes.slice(0, 5).every((outcome) => outcome.ok)).toBe(true);
    expect(outcomes[5]).toMatchObject({ ok: false });
  });

  it("write 转发到端口进程；会话不存在返回明确拒绝", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");

    const outcome = manager.write(spawned.sessionId, "ls\r");
    expect(outcome).toEqual({ ok: true });
    expect(port.spawned[0]!.written).toEqual(["ls\r"]);

    const missing = manager.write("no-such-session", "x");
    expect(missing).toMatchObject({
      ok: false,
      reason: expect.stringContaining("不存在"),
    });
    expect(port.spawned[0]!.written).toEqual(["ls\r"]);
  });

  it("resize 转发到端口进程；会话不存在静默忽略", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");

    manager.resize(spawned.sessionId, { cols: 120, rows: 40 });
    expect(port.spawned[0]!.resized).toEqual([{ cols: 120, rows: 40 }]);

    expect(() =>
      manager.resize("no-such-session", { cols: 80, rows: 24 })
    ).not.toThrow();
    expect(port.spawned[0]!.resized).toHaveLength(1);
  });

  it("read 增量水位：返回自上次读取以来的新增输出，无新输出为空串", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");
    const session = port.spawned[0]!;

    session.emitData("hello");
    expect(await manager.read(spawned.sessionId)).toEqual({
      data: "hello",
      status: "running",
    });

    // 水位推进：刚读过的内容不再重复返回
    expect(await manager.read(spawned.sessionId)).toEqual({
      data: "",
      status: "running",
    });

    session.emitData(" world");
    session.emitData("\r\n");
    expect(await manager.read(spawned.sessionId)).toEqual({
      data: " world\r\n",
      status: "running",
    });
  });

  it("read 无新输出且带 waitMs 时阻塞等待，期间新输出立即返回", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");
    const session = port.spawned[0]!;

    const started = Date.now();
    const pending = manager.read(spawned.sessionId, { waitMs: 400 });
    // 等待期间输出到达：立即唤醒（远早于 400ms 超时）
    setTimeout(() => session.emitData("late output"), 20);
    const result = await pending;
    const elapsed = Date.now() - started;
    expect(result).toEqual({ data: "late output", status: "running" });
    expect(elapsed).toBeLessThan(300);
  });

  it("read wait 超时返回空增量，不抛错", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");

    const started = Date.now();
    const result = await manager.read(spawned.sessionId, { waitMs: 40 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(result).toEqual({ data: "", status: "running" });
    // 超时唤醒后缓冲语义完好：此后的增量读取正常
    port.spawned[0]!.emitData("after");
    expect(await manager.read(spawned.sessionId)).toEqual({
      data: "after",
      status: "running",
    });
  });

  it("缓冲超上限淘汰最旧内容：未读输出被淘汰时 read 以 truncated 标记", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port, maxBufferBytes: 10 });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");
    const session = port.spawned[0]!;

    // 累计 15 字节 > 10 上限：最旧 5 字节被淘汰，且从未被读过
    session.emitData("12345");
    session.emitData("abcdefghij");
    const result = await manager.read(spawned.sessionId);
    expect(result?.data).toBe("abcdefghij");
    expect(result?.truncated).toBe(true);
  });

  it("已读内容被淘汰不算丢失：read 只报新输出且不带 truncated", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port, maxBufferBytes: 10 });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");
    const session = port.spawned[0]!;

    session.emitData("12345");
    await manager.read(spawned.sessionId); // 水位推到 12345
    session.emitData("abcdefghij"); // 淘汰的 12345 已读过
    const result = await manager.read(spawned.sessionId);
    expect(result).toEqual({ data: "abcdefghij", status: "running" });
    expect(result?.truncated).toBeUndefined();
  });

  it("默认环形缓冲 1MB：超限只保留最后 1MB 并标记 truncated", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");

    port.spawned[0]!.emitData("x".repeat(1024 * 1024 + 77));
    const result = await manager.read(spawned.sessionId);
    expect(result?.data).toHaveLength(1024 * 1024);
    expect(result?.data.endsWith("x".repeat(10))).toBe(true);
    expect(result?.truncated).toBe(true);
  });

  it("exit 置终态：status/exitedAt/exitCode/signal 记录，退出码字段 running 时缺省", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");

    port.spawned[0]!.emitExit({ exitCode: 1, signal: 15 });
    const record = manager.session(spawned.sessionId);
    expect(record?.status).toBe("exited");
    expect(record?.exitCode).toBe(1);
    expect(record?.signal).toBe(15);
    expect(record?.exitedAt).toEqual(expect.any(String));
    expect(record?.createdAt).toEqual(expect.any(String));
  });

  it("退出释放存活名额：满额任务退出一个会话后可再次 spawn，序号不复用", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({
      port,
      maxAlivePerTask: 2,
    });

    const first = manager.spawn(spawnArgs("task-1"));
    const second = manager.spawn(spawnArgs("task-1"));
    const blocked = manager.spawn(spawnArgs("task-1"));
    expect(blocked.ok).toBe(false);
    if (!first.ok || !second.ok) throw new Error("spawn 应成功");

    port.spawned[0]!.emitExit({ exitCode: 0 });
    const after = manager.spawn(spawnArgs("task-1"));
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("spawn 应成功");
    // 名字序号按实际创建总数递增（被拒绝的调用不消耗序号）：第 3 个会话，
    // 退出不复用已释放的序号 1
    expect(manager.session(after.sessionId)?.name).toBe("powershell · 3");
    // 其余会话存活状态不受影响
    expect(manager.session(second.sessionId)?.status).toBe("running");
  });

  it("退出后 write 拒绝、resize 静默忽略、read 立即返回终态", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");
    const session = port.spawned[0]!;

    session.emitExit({ exitCode: 0 });
    expect(manager.write(spawned.sessionId, "x")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("已退出"),
    });
    expect(() =>
      manager.resize(spawned.sessionId, { cols: 100, rows: 30 })
    ).not.toThrow();
    expect(session.resized).toHaveLength(0);
    expect(await manager.read(spawned.sessionId)).toEqual({
      data: "",
      status: "exited",
    });
  });

  it("read wait 等待中进程退出：立即返回（不等满超时）且状态为 exited", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");
    const session = port.spawned[0]!;

    const started = Date.now();
    const pending = manager.read(spawned.sessionId, { waitMs: 5000 });
    setTimeout(() => session.emitExit({ exitCode: 0 }), 20);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(300);
    expect(result).toEqual({ data: "", status: "exited" });
  });

  it("终止时生成最后 64KB 快照：缓冲不超限时为全部输出", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");

    port.spawned[0]!.emitData("构建输出…\r\n失败于 tests/foo.ts\r\n");
    port.spawned[0]!.emitExit({ exitCode: 1 });
    expect(manager.session(spawned.sessionId)?.snapshot).toBe(
      "构建输出…\r\n失败于 tests/foo.ts\r\n"
    );
  });

  it("快照超 64KB 时只保留尾部，且不切断多字节字符", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");

    // 每个汉字 3 字节：总量远超 64KB
    const output = "终".repeat(40_000) + "崩溃前最后一行";
    port.spawned[0]!.emitData(output);
    port.spawned[0]!.emitExit({ exitCode: 0 });

    const snapshot = manager.session(spawned.sessionId)?.snapshot ?? "";
    expect(new TextEncoder().encode(snapshot).length).toBeLessThanOrEqual(
      64 * 1024
    );
    expect(snapshot.endsWith("崩溃前最后一行")).toBe(true);
    expect(snapshot).not.toContain("\uFFFD");
  });

  it("快照在终止时刻定格：exit 后到达的残留输出不进入快照", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");

    port.spawned[0]!.emitData("before");
    port.spawned[0]!.emitExit({ exitCode: 0 });
    port.spawned[0]!.emitData("残留");
    expect(manager.session(spawned.sessionId)?.snapshot).toBe("before");
  });

  it("kill 转发端口终止进程，exit 到达后置终态并生成快照", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");
    const session = port.spawned[0]!;

    session.emitData("即将被终止的输出");
    const outcome = manager.kill(spawned.sessionId);
    expect(outcome).toEqual({ ok: true });
    expect(session.killed).toBe(true);
    // kill 本身不置终态：状态机由 exit 事件驱动（端口保证 kill 后触发 exit）
    expect(manager.session(spawned.sessionId)?.status).toBe("running");
    session.emitExit({ exitCode: 1 });
    expect(manager.session(spawned.sessionId)?.status).toBe("exited");
    expect(manager.session(spawned.sessionId)?.snapshot).toBe(
      "即将被终止的输出"
    );
  });

  it("kill 不存在与已退出的会话返回明确拒绝，不再调端口", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");

    expect(manager.kill("no-such-session")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("不存在"),
    });

    port.spawned[0]!.emitExit({ exitCode: 0 });
    expect(manager.kill(spawned.sessionId)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("已退出"),
    });
    expect(port.spawned[0]!.killed).toBe(false);
  });

  it("sessionsFor 按任务过滤且含已退出会话，顺序为创建顺序", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const a1 = manager.spawn(spawnArgs("task-1"));
    const a2 = manager.spawn(spawnArgs("task-1"));
    manager.spawn(spawnArgs("task-2"));
    if (!a1.ok || !a2.ok) throw new Error("spawn 应成功");

    port.spawned[1]!.emitExit({ exitCode: 0 }); // task-1 的第二个会话退出
    const records = manager.sessionsFor("task-1");
    expect(records.map((record) => record.name)).toEqual([
      "powershell · 1",
      "powershell · 2",
    ]);
    expect(records.map((record) => record.status)).toEqual([
      "running",
      "exited",
    ]);
    expect(manager.sessionsFor("task-3")).toEqual([]);
  });

  it("discard 移除已退出会话；存活会话与未知 ID 不移除", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const running = manager.spawn(spawnArgs("task-1"));
    const exited = manager.spawn(spawnArgs("task-1"));
    if (!running.ok || !exited.ok) throw new Error("spawn 应成功");
    port.spawned[1]!.emitExit({ exitCode: 0 });

    expect(manager.discard(exited.sessionId)).toBe(true);
    expect(manager.session(exited.sessionId)).toBeUndefined();
    expect(manager.discard(running.sessionId)).toBe(false);
    expect(manager.session(running.sessionId)).toBeDefined();
    expect(manager.discard("no-such-session")).toBe(false);
  });

  it("onEvent 生命周期事件：started 携带创建副本，exited 携带终态副本含快照", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const events: string[] = [];
    manager.onEvent((event) => events.push(event.kind));

    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");
    expect(events).toEqual(["terminal-started"]);

    port.spawned[0]!.emitData("输出");
    port.spawned[0]!.emitExit({ exitCode: 0 });
    expect(events).toEqual(["terminal-started", "terminal-exited"]);
    // 终态事件副本可独立使用：含快照与退出码
    const record = manager.session(spawned.sessionId);
    expect(record?.snapshot).toBe("输出");
    expect(record?.exitCode).toBe(0);
  });

  it("onEvent 返回退订函数，退订后不再接收", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const events: string[] = [];
    const unsubscribe = manager.onEvent((event) => events.push(event.kind));
    unsubscribe();

    manager.spawn(spawnArgs("task-1"));
    expect(events).toEqual([]);
  });

  it("onSessionData 实时转发字节流（不回放订阅前的缓冲），退订生效", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");
    const session = port.spawned[0]!;

    session.emitData("订阅前");
    const received: string[] = [];
    const unsubscribe = manager.onSessionData(spawned.sessionId, (data) =>
      received.push(data)
    );
    session.emitData("订阅后一");
    session.emitData("订阅后二");
    expect(received).toEqual(["订阅后一", "订阅后二"]);
    unsubscribe();
    session.emitData("退订后");
    expect(received).toEqual(["订阅后一", "订阅后二"]);
  });

  it("bufferedOutput 返回当前缓冲全量且不推进读取水位（UI 初始回放口）", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const spawned = manager.spawn(spawnArgs("task-1"));
    if (!spawned.ok) throw new Error("spawn 应成功");
    const session = port.spawned[0]!;

    session.emitData("第一段");
    expect(manager.bufferedOutput(spawned.sessionId)).toBe("第一段");
    session.emitData("第二段");
    expect(manager.bufferedOutput(spawned.sessionId)).toBe("第一段第二段");
    // 不推进水位：工具层 read 仍拿到完整增量
    expect(await manager.read(spawned.sessionId)).toEqual({
      data: "第一段第二段",
      status: "running",
    });
    expect(manager.bufferedOutput("no-such-session")).toBeUndefined();
  });

  it("端口 spawn 抛异常返回明确中文拒绝，不注册会话", () => {
    const failingPort: PtyPort = {
      spawn() {
        throw new Error("shell 不存在");
      },
    };
    const manager = createTerminalSessionManager({ port: failingPort });

    const outcome = manager.spawn(spawnArgs("task-1"));
    expect(outcome).toMatchObject({
      ok: false,
      reason: expect.stringContaining("启动终端失败"),
    });
    expect(outcome.ok === false && outcome.reason).toContain("shell 不存在");
    expect(manager.sessionsFor("task-1")).toEqual([]);
  });

  it("killAll 终止全部存活会话并等待终态（快照齐全），无存活时立即返回", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });
    const a = manager.spawn(spawnArgs("task-1"));
    const b = manager.spawn(spawnArgs("task-1"));
    if (!a.ok || !b.ok) throw new Error("spawn 应成功");
    port.spawned[0]!.emitData("A 的输出");
    port.spawned[1]!.emitData("B 的输出");

    // 模拟端口在 kill 后异步触发 exit：先拿引用再定时触发
    const killer = port.spawned[0]!;
    const other = port.spawned[1]!;
    setTimeout(() => {
      killer.emitExit({ exitCode: 0 });
      other.emitExit({ exitCode: 1 });
    }, 20);
    const started = Date.now();
    await manager.killAll();

    expect(killer.killed).toBe(true);
    expect(other.killed).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(manager.session(a.sessionId)).toMatchObject({
      status: "exited",
      snapshot: "A 的输出",
    });
    expect(manager.session(b.sessionId)).toMatchObject({
      status: "exited",
      exitCode: 1,
    });
    // 可重复调用：已全部退出，立即返回
    await expect(manager.killAll()).resolves.toBeUndefined();
  });

  it("killAll 兜底：端口始终不发 exit 时超时强制置终态并保留快照", async () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({
      port,
      killAllTimeoutMs: 40,
    });
    const a = manager.spawn(spawnArgs("task-1"));
    if (!a.ok) throw new Error("spawn 应成功");
    port.spawned[0]!.emitData("兜底前输出");

    await manager.killAll();
    const record = manager.session(a.sessionId);
    expect(record?.status).toBe("exited");
    expect(record?.snapshot).toBe("兜底前输出");
    // 兜底拿不到真实退出码：exitCode 缺省（正常路径必有 exit 事件）
    expect(record?.exitCode).toBeUndefined();
  });

  it("read 会话不存在返回 undefined", async () => {
    const manager = createTerminalSessionManager({ port: new FakePtyPort() });
    expect(await manager.read("no-such-session")).toBeUndefined();
  });

  it("来源 origin=user 与 agent 分别标记，互不影响", () => {
    const port = new FakePtyPort();
    const manager = createTerminalSessionManager({ port });

    const user = manager.spawn({
      taskId: "task-1",
      shell: "git-bash",
      origin: "user",
      cwd: "C:\\work",
    });
    const agent = manager.spawn({
      taskId: "task-1",
      shell: "git-bash",
      origin: "agent",
      cwd: "C:\\work",
    });

    expect(user.ok && agent.ok).toBe(true);
    if (!user.ok || !agent.ok) throw new Error("spawn 应成功");
    expect(manager.session(user.sessionId)?.origin).toBe("user");
    expect(manager.session(agent.sessionId)?.origin).toBe("agent");
  });
});
