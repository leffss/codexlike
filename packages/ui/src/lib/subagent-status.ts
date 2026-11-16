import type { SubagentSegment } from "./task-view";

/**
 * 子代理状态口径（纯函数，票 04 抽到 lib 供组件与导出共用）：
 * 状态徽章/状态点/导出头的同一文案来源——queued 灰、running 黄脉冲、
 * interrupted 黄静态（运行中被中断，ADR 0021 留痕终态）、done 绿/红。
 */
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
