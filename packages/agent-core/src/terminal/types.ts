/**
 * 终端会话域类型（GLOSSARY「终端会话」）：记录、事件与操作结果。
 * 全部可 JSON 序列化（后续经 TaskEvent / IPC / 落库共用，先例 SubagentRecord）；
 * 本文件浏览器安全，manager 实现（依赖 PtyPort 端口注入）从 ./node 出口导出。
 */
import type { PtySize } from "./pty-port";
import type { TerminalShell } from "../tools/terminal";

/** 会话来源：用户手开 or agent 工具启动（所有权边界的判定依据，ADR 0033） */
export type TerminalSessionOrigin = "user" | "agent";

/** 会话状态机：running → exited（终态由进程 exit 事件驱动，kill 不直接置终态） */
export type TerminalSessionStatus = "running" | "exited";

/**
 * 标题来源：auto = shell OSC 0/2 序列动态写入（跟随 shell/cwd/前台程序）；
 * user = 用户手动改名（改名后 auto 更新不再覆盖，手动命名优先）。
 */
export type TerminalTitleSource = "auto" | "user";

/** 终端会话记录（rail 列表 / 详情 / 落库共用形状） */
export interface TerminalSessionRecord {
  sessionId: string;
  /** 归属任务（会话按任务组织，ADR 0033：拒绝宿主级按工作区组织） */
  taskId: string;
  /** 默认名「shell 类型 · 任务内序号」（稳定标识，不随标题变化） */
  name: string;
  shell: TerminalShell;
  origin: TerminalSessionOrigin;
  status: TerminalSessionStatus;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601；running 时缺省 */
  exitedAt?: string;
  /** 进程退出码；running 时缺省 */
  exitCode?: number;
  /** 终止信号编号（正常退出缺省） */
  signal?: number;
  /**
   * 展示标题（v1 的「不做重命名」在标题功能轮放开）：缺省回退 name 呈现；
   * OSC 0/2 动态写入（source=auto）或用户改名（source=user）后携带。
   */
  title?: string;
  /** 标题来源；title 携带时必有 */
  titleSource?: TerminalTitleSource;
  /**
   * 终态快照：最后 64KB 输出文本（spec「输出不全量落库」，08 票落库供回看）。
   * 仅 exited 会话携带；running 时 undefined。
   */
  snapshot?: string;
}

/**
 * 会话生命周期事件（低频）：desktop 侧转 terminal-* TaskEvent（03 票接
 * live-tasks 白名单）。record 为当时的完整副本，消费方不必回查管理器；
 * PTY 字节流不走本通道（spec：专用 IPC 通道直写 xterm.js，见 onSessionData）。
 */
export type TerminalSessionEvent =
  | { kind: "terminal-started"; record: TerminalSessionRecord }
  | { kind: "terminal-exited"; record: TerminalSessionRecord }
  | { kind: "terminal-title-changed"; record: TerminalSessionRecord };

/** spawn 请求：来源与归属由调用方（工具层 / 面板）给定 */
export interface TerminalSpawnRequest {
  taskId: string;
  shell: TerminalShell;
  origin: TerminalSessionOrigin;
  /** 任务工作区（会话起始目录，ADR 0004） */
  cwd: string;
  /** 宿主白名单过滤后的环境变量 */
  env?: Record<string, string>;
  /** 初始终端尺寸；缺省 80 × 24 */
  size?: PtySize;
  /** agent 侧可带初始命令；用户手开为空 */
  initialCommand?: string;
}

/** 操作失败结果：reason 为中文，可直接回给模型 / 展示给用户 */
export interface TerminalActionFailure {
  ok: false;
  reason: string;
}

/** 单会话环形缓冲字节上限（spec：1MB，超限淘汰最旧内容） */
export const DEFAULT_TERMINAL_BUFFER_MAX_BYTES = 1024 * 1024;

/** 终态快照字节上限（spec / ADR 0033：会话终止时保留最后 64KB 供回看，08 票落库） */
export const TERMINAL_SNAPSHOT_BYTES = 64 * 1024;

/** 读取结果：data 为自水位以来的新增输出（可能为空串） */
export interface TerminalReadResult {
  data: string;
  /** 读取时的会话状态（exited 时调用方不再等待） */
  status: TerminalSessionStatus;
  /** 本次读取前有未读输出被 1MB 上限淘汰（data 起点之前的内容缺失） */
  truncated?: boolean;
}

/**
 * 每任务同时存活会话上限默认值（spec / ADR 0033：agent spawn 超限拒绝并说明、
 * 用户创建超限提示）。设置值经 TerminalSessionManagerOptions.maxAlivePerTask 覆盖。
 */
export const DEFAULT_TERMINAL_MAX_ALIVE_PER_TASK = 5;

/** 展示标题字符上限（OSC 动态值与用户改名同一口径，rail 富行截断呈现） */
export const TERMINAL_TITLE_MAX_CHARS = 100;
