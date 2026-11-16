import type { SubagentRecord } from "@codexlike/agent-core";

import type { SubagentSegment } from "./task-view";

/**
 * 子代理状态口径（纯函数，票 04 抽到 lib 供组件与导出共用）：
 * 状态徽章/状态点/导出头的同一文案来源——queued 灰、running 黄脉冲、
 * interrupted 黄静态（运行中被中断，ADR 0021 留痕终态）、done 绿/红。
 *
 * review 修复（Repeated Switches）：SubagentStatus → 呈现语义的全部映射
 * 收拢到本文件单一来源——段 state 推导（subagentSegmentState）、终态判定
 * （isTerminalSubagentState）、状态点配色（statusDotClassName / statusPulses）、
 * 导出终态时刻标签（terminalTimeLabel）与文案/配色（statusText / statusClass）
 * 都在这里；组件与恢复重建不得再各写一套 state 级联。
 */

/** 持久层骨架 status → 段 state（恢复重建 subagentFromSnapshot 的唯一映射） */
export function subagentSegmentState(
  status: SubagentRecord["status"]
): SubagentSegment["state"] {
  return status === "interrupted"
    ? "interrupted"
    : status === "queued"
      ? "queued"
      : status === "running"
        ? "running"
        : "done";
}

/** 终态判定（done / interrupted）：已用时定格、终态后不再跳动的口径 */
export function isTerminalSubagentState(
  state: SubagentSegment["state"]
): boolean {
  return state === "done" || state === "interrupted";
}

export function statusText(subagent: SubagentSegment): string {
  return subagent.state === "queued"
    ? "排队中"
    : subagent.state === "running"
      ? "运行中"
      : subagent.state === "interrupted"
        ? "运行中被中断"
        : subagent.ok === false
          ? "失败"
          : "完成";
}

export function statusClass(subagent: SubagentSegment): string {
  return subagent.state === "done"
    ? subagent.ok === false
      ? "text-danger-fg"
      : "text-ok-fg"
    : "text-warn-fg";
}

/** 状态点配色（StatusDot 消费）：done 绿/红、running 与 interrupted 黄、queued 灰 */
export function statusDotClassName(subagent: SubagentSegment): string {
  return subagent.state === "done"
    ? subagent.ok === false
      ? "bg-danger-fg"
      : "bg-ok-fg"
    : subagent.state === "running" || subagent.state === "interrupted"
      ? "bg-warn-fg"
      : "bg-fg-subtle";
}

/** 状态点是否脉冲：仅 running（interrupted 是静态黄点） */
export function statusPulses(subagent: SubagentSegment): boolean {
  return subagent.state === "running";
}

/** 终态时刻行的标签（导出 Markdown「完成/中断：时间」） */
export function terminalTimeLabel(subagent: SubagentSegment): string {
  return subagent.state === "interrupted" ? "中断" : "完成";
}
