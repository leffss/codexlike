/**
 * PtyPort：PTY 进程的宿主端口（ADR 0033 的唯一新缝隙）。
 *
 * agent-core 只依赖本接口；node-pty 及其 ABI 敏感的原生实现隔离在 desktop
 * 适配器（02 票）里。形状与 node-pty 的 IPty 最小子集对齐，让适配器保持最薄。
 */
import type { TerminalShell } from "../tools/terminal";

/** PTY 尺寸（列 × 行；与 xterm.js / node-pty 对齐） */
export interface PtySize {
  cols: number;
  rows: number;
}

/**
 * PtyPort.spawn 的请求：会话环境（工作区 / env 白名单 / 尺寸 / 初始命令）由
 * 管理器组装，shell 命令行如何拼装是端口实现方的事。
 */
export interface PtySpawnRequest {
  /** shell 类型（GLOSSARY「执行设置」）：跟随宿主执行设置 */
  shell: TerminalShell;
  /** 会话起始目录：一律为任务工作区（ADR 0004 边界，无 cwd 参数开口子） */
  cwd: string;
  /** 已经过宿主白名单过滤的环境变量 */
  env: Record<string, string>;
  /** 初始终端尺寸 */
  size: PtySize;
  /**
   * agent 侧 spawn_terminal 可带的初始命令（spec 用户故事 14）；用户手开为空
   * （直接落在交互提示符）。如何让 shell 执行它由端口实现方决定。
   */
  initialCommand?: string;
}

/** 进程退出事件载荷（node-pty 的 (exitCode, signal) 两参归一为对象） */
export interface PtyExitEvent {
  exitCode: number;
  /** 终止信号编号（node-pty 第二参）；正常退出缺省 */
  signal?: number;
}

/** 一次 PTY 进程实例：由 spawn 产出，会话终止前持续可用 */
export interface PtyProcess {
  /** 进程 PID（desktop 侧按 sessionId 的 kill 注册表要用，ADR 0033）；未知时 undefined */
  readonly pid: number | undefined;
  /** 向 PTY 写入输入（用户键入 / agent terminal_write） */
  write(data: string): void;
  /** 调整 PTY 尺寸（UI resize） */
  resize(size: PtySize): void;
  /**
   * 终止进程。Windows 子进程树覆盖（taskkill /T /F 思路）由端口实现方负责；
   * 进程随之退出时端口实现方须触发 onExit（会话终态与快照由管理器据 exit 生成）。
   */
  kill(): void;
  /** 订阅 PTY 输出字节流（已解码文本）；返回退订函数 */
  onData(listener: (data: string) => void): () => void;
  /** 订阅进程退出事件；返回退订函数 */
  onExit(listener: (event: PtyExitEvent) => void): () => void;
}

export interface PtyPort {
  /** 启动一个 PTY 进程；shell 不可用等启动失败以异常抛出（管理器转拒绝结果） */
  spawn(request: PtySpawnRequest): PtyProcess;
}
