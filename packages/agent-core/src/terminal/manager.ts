/**
 * TerminalSessionManager：终端会话注册表与生命周期核心（ADR 0033）。
 *
 * 纯逻辑：会话注册表（按任务归属 + 来源标记）、环形缓冲、读取水位、
 * 终态快照。PTY 进程能力经 PtyPort 端口注入（node-pty 隔离在 desktop），
 * 测试用 fake 端口驱动（先例：browser-manager 的 fake installer）。
 * 管理器是宿主级常驻实体——不挂消息循环、任务中断不杀会话（ADR 0033）。
 */
import type { PtyPort, PtySize } from "./pty-port";
import { createOscTitleScanner, type OscTitleScanner } from "./osc-title";
import {
  DEFAULT_TERMINAL_BUFFER_MAX_BYTES,
  DEFAULT_TERMINAL_MAX_ALIVE_PER_TASK,
  TERMINAL_SNAPSHOT_BYTES,
  TERMINAL_TITLE_MAX_CHARS,
  type TerminalActionFailure,
  type TerminalReadResult,
  type TerminalSessionEvent,
  type TerminalSessionRecord,
  type TerminalSpawnRequest,
  type TerminalTitleSource,
} from "./types";

export interface TerminalSessionManagerOptions {
  /** PTY 端口（desktop 注入 node-pty 适配器，测试注入 fake） */
  port: PtyPort;
  /** 每任务同时存活会话上限；缺省 DEFAULT_TERMINAL_MAX_ALIVE_PER_TASK（5） */
  maxAlivePerTask?: number;
  /** 单会话环形缓冲字节上限；缺省 DEFAULT_TERMINAL_BUFFER_MAX_BYTES（1MB） */
  maxBufferBytes?: number;
  /**
   * killAll 等待 exit 事件的兜底超时毫秒数；缺省 2000。正常端口实现
   * （node-pty）kill 后必然触发 exit，该兜底只在适配器异常时保证应用
   * 退出流程不挂死（flush 快照语义：尽力而为）。
   */
  killAllTimeoutMs?: number;
  /** 会话 ID 生成器；缺省 crypto.randomUUID */
  generateId?: () => string;
  /** ISO 时间来源（record.createdAt / exitedAt）；缺省系统时钟 */
  now?: () => string;
}

export interface TerminalSessionManager {
  /**
   * 启动新会话并注册：记录任务归属、来源与 shell。超上限 / 端口启动失败
   * 返回 ok:false（中文 reason 可直接回给模型 / 展示给用户）。
   */
  spawn(
    request: TerminalSpawnRequest
  ): { ok: true; sessionId: string } | TerminalActionFailure;
  /** 向会话写入输入（用户键入 / agent terminal_write 交互应答） */
  write(sessionId: string, data: string): { ok: true } | TerminalActionFailure;
  /** 调整 PTY 尺寸（UI resize）；会话不存在或已退出静默忽略 */
  resize(sessionId: string, size: PtySize): void;
  /**
   * 终止会话：调用端口 kill（Windows 子进程树覆盖在端口实现方）；终态与快照
   * 由随后的 exit 事件生成。重复 kill 已退出会话返回明确拒绝（非幂等 ok，
   * 模型侧需要分辨「已终止」与「本次操作生效」）。
   */
  kill(sessionId: string): { ok: true } | TerminalActionFailure;
  /**
   * 用户改名（标题功能轮）：设置展示标题（source=user），此后 OSC 动态更新
   * 不再覆盖（手动命名优先）。已退出会话只读回看拒绝改名（记录已在库行，
   * 改内存不一致）；title 经 trim，空串 / 超长拒绝。
   */
  rename(
    sessionId: string,
    title: string
  ): { ok: true } | TerminalActionFailure;
  /**
   * 应用退出 flush（ADR 0033 退出屏障）：kill 全部存活会话并等待各自 exit
   * 事件（终态与快照在 exit 时机生成）；端口实现异常不发 exit 时经兜底超时
   * 强制置终态（exitCode 缺省）。可重复调用；无存活会话时立即返回。
   */
  killAll(): Promise<void>;
  /**
   * 读取自上次水位以来的新增输出（GLOSSARY「读取水位」）。waitMs 缺省 0：
   * 无新输出立即返回空串。会话不存在返回 undefined。
   */
  read(
    sessionId: string,
    options?: { waitMs?: number }
  ): Promise<TerminalReadResult | undefined>;
  /** 单会话记录；不存在返回 undefined */
  session(sessionId: string): TerminalSessionRecord | undefined;
  /** 任务内会话记录（rail 列表页数据）：按创建顺序，含已退出会话 */
  sessionsFor(taskId: string): TerminalSessionRecord[];
  /**
   * 从注册表移除会话（任务归档 / 重启收尾用，spec「重启后不恢复」）：
   * 仅移除已退出会话；存活会话先经 kill 流程走完终态再清理。
   */
  discard(sessionId: string): boolean;
  /**
   * 订阅会话生命周期事件（低频；desktop 转 terminal-* TaskEvent，03 票接
   * live-tasks 白名单）。返回退订函数。
   */
  onEvent(listener: (event: TerminalSessionEvent) => void): () => void;
  /**
   * 订阅会话实时字节流（spec「PTY 字节流走专用 IPC 通道直写 xterm.js」）：
   * 只转发订阅之后的输出，不回放订阅前的缓冲（初始回放走 bufferedOutput）。
   * 会话不存在返回空退订函数。
   */
  onSessionData(
    sessionId: string,
    listener: (data: string) => void
  ): () => void;
  /**
   * 会话当前缓冲全量（不推进读取水位）：UI 打开详情页时对 xterm.js 的
   * 初始回放数据源；工具层的 read 水位语义不受影响。不存在返回 undefined。
   */
  bufferedOutput(sessionId: string): string | undefined;
}

export function createTerminalSessionManager(
  options: TerminalSessionManagerOptions
): TerminalSessionManager {
  const port = options.port;
  const maxAlivePerTask =
    options.maxAlivePerTask ?? DEFAULT_TERMINAL_MAX_ALIVE_PER_TASK;
  const maxBufferBytes =
    options.maxBufferBytes ?? DEFAULT_TERMINAL_BUFFER_MAX_BYTES;
  const killAllTimeoutMs = options.killAllTimeoutMs ?? 2000;
  const generateId = options.generateId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  /** 字节数按 UTF-8 计量（快照与缓冲上限的口径，TextEncoder 浏览器安全） */
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const byteLength = (text: string): number => encoder.encode(text).length;

  /**
   * 取 text 的尾部子串，UTF-8 字节数不超过 maxBytes；丢弃头部时推进到
   * UTF-8 code point 边界，不产生替换字符（缓冲截断与终态快照共用）。
   */
  function tailWithinBytes(text: string, maxBytes: number): string {
    const encoded = encoder.encode(text);
    if (encoded.length <= maxBytes) return text;
    let cut = encoded.length - maxBytes;
    while (cut < encoded.length && (encoded[cut]! & 0xc0) === 0x80) cut += 1;
    return decoder.decode(encoded.subarray(cut));
  }

  /** 环形缓冲分片：seq 为会话内全局写入序号（读取水位的推进单位） */
  interface BufferChunk {
    seq: number;
    text: string;
    bytes: number;
  }

  /** 会话内部状态：record 是对外形状，其余是缓冲与水位 */
  interface SessionEntry {
    record: TerminalSessionRecord;
    process: ReturnType<PtyPort["spawn"]>;
    chunks: BufferChunk[];
    lastSeq: number;
    /** 读取水位：已读到的最后写入序号 */
    readSeq: number;
    totalBytes: number;
    /** 未读内容被缓冲上限淘汰（下次 read 以 truncated 标记） */
    lostUnread: boolean;
    /** 等待新输出的 waiter（read 带 waitMs 时挂起，写入/退出时唤醒） */
    waiters: Set<() => void>;
    /** 字节流转发订阅（desktop 直写 xterm.js 专用 IPC 通道） */
    dataListeners: Set<(data: string) => void>;
    /** OSC 0/2 标题扫描（跨 chunk 有状态；与缓冲/转发互不干扰） */
    titleScanner: OscTitleScanner;
    /** 当前 PTY 尺寸（同尺寸 resize 去重基准） */
    size: PtySize;
  }

  const sessions = new Map<string, SessionEntry>();
  /** 任务内会话计数（默认名序号来源）：按历史创建总数递增，退出不复用 */
  const nameCounters = new Map<string, number>();
  const eventListeners = new Set<(event: TerminalSessionEvent) => void>();

  function emitEvent(event: TerminalSessionEvent): void {
    for (const listener of eventListeners) listener(event);
  }

  /** 内部订阅（onEvent 方法与 killAll 的 exit 消账共用） */
  function subscribeEvents(
    listener: (event: TerminalSessionEvent) => void
  ): () => void {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  }

  /** 追加输出进环形缓冲；超上限从最旧分片开始淘汰（单块超限则截尾保留） */
  function appendBuffer(entry: SessionEntry, text: string): void {
    const bytes = byteLength(text);
    entry.chunks.push({ seq: entry.lastSeq + 1, text, bytes });
    entry.lastSeq += 1;
    entry.totalBytes += bytes;
    while (entry.totalBytes > maxBufferBytes) {
      const oldest = entry.chunks[0]!;
      if (entry.chunks.length > 1) {
        entry.chunks.shift();
        entry.totalBytes -= oldest.bytes;
      } else {
        // 单条输出即超上限（如一条几 MB 的日志）：整条保留会突破上限，
        // 截尾保留最后 maxBufferBytes 字节
        const trimmed = tailWithinBytes(oldest.text, maxBufferBytes);
        const dropped = oldest.bytes - byteLength(trimmed);
        oldest.text = trimmed;
        oldest.bytes -= dropped;
        entry.totalBytes -= dropped;
      }
      // 淘汰了读取水位之后的未读内容：下一次 read 须提示调用方有丢失
      if (oldest.seq > entry.readSeq) entry.lostUnread = true;
    }
  }

  /** 取出自水位以来的新增输出并推进水位 */
  function drainBuffer(entry: SessionEntry): TerminalReadResult {
    let data = "";
    for (const chunk of entry.chunks) {
      if (chunk.seq > entry.readSeq) data += chunk.text;
    }
    entry.readSeq = entry.lastSeq;
    const truncated = entry.lostUnread && data.length > 0;
    if (truncated) entry.lostUnread = false;
    return truncated
      ? { data, status: entry.record.status, truncated: true }
      : { data, status: entry.record.status };
  }

  /** 任务内当前存活（running）会话数 */
  function aliveCountOf(taskId: string): number {
    let count = 0;
    for (const entry of sessions.values()) {
      if (entry.record.taskId === taskId && entry.record.status === "running") {
        count += 1;
      }
    }
    return count;
  }

  /**
   * 设置展示标题并广播（OSC 动态写入与用户改名共用）：同值静默（shell 每
   * 提示符刷一次标题，重复事件是噪音）；user 来源后 auto 不再覆盖。
   */
  function setTitle(
    entry: SessionEntry,
    title: string,
    source: TerminalTitleSource
  ): void {
    if (entry.record.title === title) return;
    entry.record = {
      ...entry.record,
      title,
      titleSource: source,
    };
    emitEvent({ kind: "terminal-title-changed", record: { ...entry.record } });
  }

  /**
   * 进程退出：置终态 + 在终止时刻定格尾部 64KB 快照 + 唤醒等待者。
   * 状态机 running → exited 仅由 exit 事件驱动（kill 只调端口），幂等；
   * 快照三条路径（正常退出 / 被 kill / 应用退出前 flush）都收敛到本函数。
   * exit 信息均缺省时为 killAll 兜底路径（端口实现异常不发 exit），此时
   * 无真实退出码（exitCode 缺省）——正常路径必有 exit 事件。
   */
  function finishSession(
    entry: SessionEntry,
    exit: { exitCode?: number; signal?: number }
  ): void {
    if (entry.record.status !== "running") return;
    // 终止时刻定格快照（此后到达的残留输出不再进入）；终态快照与
    // terminal-exited 事件消费方据此回看（08 票落库）
    const buffered = entry.chunks.map((chunk) => chunk.text).join("");
    entry.record = {
      ...entry.record,
      status: "exited",
      exitedAt: now(),
      ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
      ...(exit.signal === undefined ? {} : { signal: exit.signal }),
      snapshot: tailWithinBytes(buffered, TERMINAL_SNAPSHOT_BYTES),
    };
    for (const wake of entry.waiters) wake();
    entry.waiters.clear();
    emitEvent({ kind: "terminal-exited", record: { ...entry.record } });
  }

  return {
    spawn(request) {
      if (aliveCountOf(request.taskId) >= maxAlivePerTask) {
        return {
          ok: false,
          reason:
            `该任务同时存活的终端会话已达上限 ${maxAlivePerTask}，` +
            "请等待现有会话退出，或先终止不再需要的会话再试。",
        };
      }
      const sessionId = generateId();
      const seq = (nameCounters.get(request.taskId) ?? 0) + 1;
      nameCounters.set(request.taskId, seq);
      const record: TerminalSessionRecord = {
        sessionId,
        taskId: request.taskId,
        name: `${request.shell} · ${seq}`,
        shell: request.shell,
        origin: request.origin,
        status: "running",
        createdAt: now(),
      };
      let process: ReturnType<PtyPort["spawn"]>;
      try {
        process = port.spawn({
          shell: request.shell,
          cwd: request.cwd,
          env: request.env ?? {},
          size: request.size ?? { cols: 80, rows: 24 },
          initialCommand: request.initialCommand,
        });
      } catch (error) {
        return {
          ok: false,
          reason: `启动终端失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const entry: SessionEntry = {
        record,
        process,
        chunks: [],
        lastSeq: 0,
        readSeq: 0,
        totalBytes: 0,
        lostUnread: false,
        waiters: new Set(),
        dataListeners: new Set(),
        titleScanner: createOscTitleScanner(),
        size: request.size ?? { cols: 80, rows: 24 },
      };
      sessions.set(sessionId, entry);
      // PTY 输出统一进缓冲（水位读取与快照的数据源）+ 高频字节流转发
      process.onData((data) => {
        appendBuffer(entry, data);
        // OSC 0/2 标题动态写入（用户改名后 source=user 不被覆盖）；同值
        // 在 setTitle 内静默（shell 每提示符刷新是常态）
        if (entry.record.titleSource !== "user") {
          const title = entry.titleScanner.feed(data);
          if (title !== null) setTitle(entry, title, "auto");
        }
        for (const listener of entry.dataListeners) listener(data);
        for (const wake of entry.waiters) wake();
      });
      // 状态机 running → exited 只由进程 exit 事件驱动
      process.onExit((event) =>
        finishSession(entry, { exitCode: event.exitCode, signal: event.signal })
      );
      emitEvent({ kind: "terminal-started", record: { ...record } });
      return { ok: true, sessionId };
    },

    write(sessionId, data) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) {
        return { ok: false, reason: `终端会话不存在：${sessionId}` };
      }
      if (entry.record.status !== "running") {
        return {
          ok: false,
          reason: `终端会话已退出，无法写入：${entry.record.name}`,
        };
      }
      entry.process.write(data);
      return { ok: true };
    },

    resize(sessionId, size) {
      const entry = sessions.get(sessionId);
      // resize 的调用时机（UI 视口变化）可能晚于会话退出，静默忽略即可
      if (entry === undefined || entry.record.status !== "running") return;
      // 同尺寸去重（2026-11-22 首屏垃圾行修复）：UI 的 ResizeObserver 初始
      // fire 与 fit 会以相同尺寸重复上报，而 conpty 对每次 resize 都做全屏
      // 重绘——重复 resize 产生的多轮重绘字节与 xterm DOM 渲染器 diff 交错，
      // 正是首屏「单字形平铺整行」渲染垃圾的触发窗（回放实验实证）。尺寸没
      // 变就不动 PTY。
      if (entry.size.cols === size.cols && entry.size.rows === size.rows) {
        return;
      }
      entry.size = size;
      entry.process.resize(size);
    },

    kill(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) {
        return { ok: false, reason: `终端会话不存在：${sessionId}` };
      }
      if (entry.record.status !== "running") {
        return {
          ok: false,
          reason: `终端会话已退出，无需终止：${entry.record.name}`,
        };
      }
      entry.process.kill();
      return { ok: true };
    },

    rename(sessionId, title) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) {
        return { ok: false, reason: `终端会话不存在：${sessionId}` };
      }
      if (entry.record.status !== "running") {
        return {
          ok: false,
          reason: `终端会话已退出，无法改名：${entry.record.name}`,
        };
      }
      const trimmed = title.trim();
      if (trimmed === "") {
        return { ok: false, reason: "标题不能为空" };
      }
      if (trimmed.length > TERMINAL_TITLE_MAX_CHARS) {
        return {
          ok: false,
          reason: `标题过长（上限 ${TERMINAL_TITLE_MAX_CHARS} 字符）`,
        };
      }
      setTitle(entry, trimmed, "user");
      return { ok: true };
    },

    async killAll() {
      const alive = [...sessions.values()].filter(
        (entry) => entry.record.status === "running"
      );
      if (alive.length === 0) return;
      await new Promise<void>((resolve) => {
        const pending = new Set(alive.map((entry) => entry.record.sessionId));
        // 订阅先于 kill（exit 事件不丢）；terminal-exited 事件逐个消账
        const unsubscribe = subscribeEvents((event) => {
          if (event.kind !== "terminal-exited") return;
          pending.delete(event.record.sessionId);
          if (pending.size === 0) {
            unsubscribe();
            clearTimeout(fallback);
            resolve();
          }
        });
        const fallback = setTimeout(() => {
          unsubscribe();
          for (const entry of alive) finishSession(entry, {});
          resolve();
        }, killAllTimeoutMs);
        for (const entry of alive) {
          try {
            entry.process.kill();
          } catch {
            // kill 失败的会话继续等待 exit / 兜底超时，不阻塞其余会话
          }
        }
      });
    },

    async read(sessionId, options) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) return undefined;
      const immediate = drainBuffer(entry);
      const waitMs = options?.waitMs ?? 0;
      // 已有新输出、已退出、或未要求等待：立即返回
      if (
        immediate.data.length > 0 ||
        entry.record.status !== "running" ||
        waitMs <= 0
      ) {
        return immediate;
      }
      return new Promise<TerminalReadResult>((resolve) => {
        // 多个 waiter 共享同一会话水位：先被唤醒者取走全部增量，其余得到
        // 空串（真实调用方——工具层与字节流转发——不会并发 wait 同一会话）
        const finish = () => {
          clearTimeout(timer);
          entry.waiters.delete(wake);
          resolve(drainBuffer(entry));
        };
        const wake = (): void => finish();
        entry.waiters.add(wake);
        const timer = setTimeout(finish, waitMs);
      });
    },

    session(sessionId) {
      const record = sessions.get(sessionId)?.record;
      // 浅拷贝防外部改动内部状态（record 在终态推进时整体替换）
      return record === undefined ? undefined : { ...record };
    },

    sessionsFor(taskId) {
      const records: TerminalSessionRecord[] = [];
      for (const entry of sessions.values()) {
        if (entry.record.taskId === taskId) {
          records.push({ ...entry.record });
        }
      }
      return records;
    },

    discard(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry === undefined || entry.record.status !== "exited") return false;
      sessions.delete(sessionId);
      return true;
    },

    onEvent(listener) {
      return subscribeEvents(listener);
    },

    onSessionData(sessionId, listener) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) return () => {};
      entry.dataListeners.add(listener);
      return () => entry.dataListeners.delete(listener);
    },

    bufferedOutput(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) return undefined;
      return entry.chunks.map((chunk) => chunk.text).join("");
    },
  };
}
