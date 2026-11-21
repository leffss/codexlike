import type { TerminalSessionStatus } from "@codexlike/agent-core";

import type { TerminalSegment } from "./task-view";

/**
 * 终端会话状态口径（纯函数，票 04 建单一来源，先例 subagent-status.ts）：
 * rail 列表富行 / 详情顶栏 / tab 徽章的同一文案与配色来源。
 *
 * 状态语义比子代理简单（ADR 0033：running → exited 两态，无排队/中断），
 * 终态健康度按退出方式三分——exitCode 0 正常退出（绿）、非零退出码异常
 * （红）、signal 终止（黄：kill/taskkill 是用户或系统的主动行为，不算
 * 失败）。全部映射收拢本文件，组件不得再各写一套 state 级联。
 */

/** 终态判定：详情页只读回看与 kill 按钮显隐的依据 */
export function isExitedTerminalStatus(status: TerminalSessionStatus): boolean {
  return status === "exited";
}

/** 状态文案：running「运行中」；exited 按退出方式三分（见文件头注释） */
export function statusText(session: TerminalSegment): string {
  if (session.status === "running") return "运行中";
  if (session.signal !== undefined) return `已终止（信号 ${session.signal}）`;
  if (session.exitCode === undefined) return "已退出";
  return session.exitCode === 0 ? "已退出" : `退出码 ${session.exitCode}`;
}

/** 状态文字配色（富行元信息 / 详情顶栏共用） */
export function terminalStatusClass(session: TerminalSegment): string {
  if (session.status === "running") return "text-warn-fg";
  if (session.signal !== undefined) return "text-warn-fg";
  if (session.exitCode === undefined || session.exitCode === 0)
    return "text-ok-fg";
  return "text-danger-fg";
}

/** 状态点配色（TerminalStatusDot 消费） */
export function statusDotClassName(session: TerminalSegment): string {
  if (session.status === "running") return "bg-warn-fg";
  if (session.signal !== undefined) return "bg-warn-fg";
  return session.exitCode === undefined || session.exitCode === 0
    ? "bg-ok-fg"
    : "bg-danger-fg";
}

/** 状态点是否脉冲：仅 running（exited 全为静态点） */
export function statusPulses(session: TerminalSegment): boolean {
  return session.status === "running";
}

/** 来源标注（列表富行）：用户手开 / agent 工具启动（ADR 0033 所有权边界） */
export function originLabel(origin: TerminalSegment["origin"]): string {
  return origin === "agent" ? "agent" : "用户";
}

/**
 * 已用时（mm:ss，先例 formatElapsed）：running 以传入 now 实时计算，
 * exited 以 exitedAt 定格；跨小时按累计分钟显示（跑一夜的长命令不换
 * 格式，分钟数自然增长）。缺时间数据（防御）不显示数字。
 */
export function terminalElapsed(
  session: TerminalSegment,
  now: number
): string | null {
  const started = Date.parse(session.createdAt);
  if (Number.isNaN(started)) return null;
  const end =
    session.status === "exited"
      ? session.exitedAt !== undefined
        ? Date.parse(session.exitedAt)
        : NaN
      : now;
  if (Number.isNaN(end)) return null;
  const seconds = Math.max(0, Math.floor((end - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
