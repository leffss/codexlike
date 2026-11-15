/**
 * 上下文告警（code review 修复 2，spec 验收场景 4「长任务触发上下文告警」）。
 * 在 /status 的 token 估算（./tokens）基础上，超过阈值时给出中文告警——
 * 阈值 = 模型上下文窗口（Provider Profile 可配，默认 128k）× 占比
 * （执行设置可调，默认 80%，见 evaluateContextWarning 第三参）。
 * 纯函数（浏览器安全）：估算 → 是否告警的决策与文案都在这里，UI 只负责展示。
 */

import { DEFAULT_CONTEXT_WARNING_PERCENT } from "../task/execution-settings";

/** 模型上下文窗口默认值（Provider Profile 未配置 contextWindowTokens 时使用） */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * 告警阈值占上下文窗口的比例（≥80% 即告警）：执行设置票 03 起默认值以整数
 * 百分比落 execution-settings.ts 单一来源（用户可调 50–95），此处换算为占比
 * 保持既有口径（0.8）不变。
 */
export const CONTEXT_WARNING_THRESHOLD_RATIO =
  DEFAULT_CONTEXT_WARNING_PERCENT / 100;

export interface ContextUsageWarning {
  /** 触发告警时的上下文用量估算（tokens） */
  estimatedTokens: number;
  /** 生效的上下文窗口大小（tokens） */
  contextWindowTokens: number;
  /** 用量占窗口的比例（0-1，≥阈值） */
  ratio: number;
  /** 中文告警文案（含用量与建议） */
  message: string;
}

/**
 * 评估上下文用量是否触发告警：
 * - estimatedTokens 达到窗口 × 阈值时返回告警（含「建议执行 /compact」），否则返回 null；
 * - contextWindowTokens 缺省或非法（≤0）时按默认 128k 处理；
 * - thresholdRatio（执行设置票 03，ADR 0017）：调用方每次评估传入当时设置的
 *   占比（设置以整数百分比存储，UI 侧换算后传入）——逐次读取，无快照语义；
 *   缺省或非法（非有限/≤0）回退默认 0.8。与窗口叠加：告警线 = 窗口 × 阈值。
 */
export function evaluateContextWarning(
  estimatedTokens: number,
  contextWindowTokens?: number,
  thresholdRatio?: number
): ContextUsageWarning | null {
  const windowTokens =
    contextWindowTokens !== undefined &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const threshold =
    thresholdRatio !== undefined &&
    Number.isFinite(thresholdRatio) &&
    thresholdRatio > 0
      ? thresholdRatio
      : CONTEXT_WARNING_THRESHOLD_RATIO;
  const ratio = estimatedTokens / windowTokens;
  if (ratio < threshold) {
    return null;
  }
  const percent = Math.round(ratio * 100);
  return {
    estimatedTokens,
    contextWindowTokens: windowTokens,
    ratio,
    message:
      `上下文即将耗尽：约 ${estimatedTokens} / ${windowTokens} tokens（${percent}%），` +
      "建议执行 /compact 压缩历史后继续",
  };
}
