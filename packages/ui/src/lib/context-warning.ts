import { evaluateContextWarning } from "@codexlike/agent-core";
import type { CodexLikeApi } from "@codexlike/desktop/ipc";

/**
 * 上下文告警的阈值消费（执行设置票 03，ADR 0017，GLOSSARY「执行设置」）：
 * WorkspacePage 的告警评估改读执行设置——每次刷新逐次读取（IPC get，
 * 无快照语义，设置页保存后下一次评估即生效），整数百分比换算为占比传给
 * agent-core 的 evaluateContextWarning。阈值是占比，与 Provider Profile 的
 * 逐模型 contextWindowTokens（随 /status 到达，未配置按默认 128k）叠加：
 * 告警线 = 窗口 × 阈值，叠加关系与现状一致。
 * 设置读取失败按默认阈值评估（告警查询本身「失败静默不打扰」，不因设置
 * 读取失败额外改变行为）。
 */

/** /status 中告警评估所需字段（WorkspacePage 消费的形状） */
export type ContextWarningStatus = {
  estimatedContextTokens: number;
  contextWindowTokens: number | null;
};

export async function contextWarningMessage(
  api: Pick<CodexLikeApi, "agentSettings">,
  status: ContextWarningStatus
): Promise<string | null> {
  let thresholdPercent: number | undefined;
  try {
    thresholdPercent = (await api.agentSettings.get())
      .contextWarningThresholdPercent;
  } catch {
    thresholdPercent = undefined;
  }
  return (
    evaluateContextWarning(
      status.estimatedContextTokens,
      status.contextWindowTokens ?? undefined,
      thresholdPercent === undefined ? undefined : thresholdPercent / 100
    )?.message ?? null
  );
}
