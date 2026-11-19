import type { LanguageModelUsage } from "ai";

import type { TaskUsageDelta } from "./types";

/**
 * 任务用量的尽力而为入账（GLOSSARY「任务用量」，ADR 0029）：
 * 单次模型调用结束后把真实 usage 记进任务账——报多少记多少，没报记 0。
 * usage 未结算（中断/失败）或入账本身出错都不抛出：账目失败不得拖垮
 * 正在进行的生成（compact / commit 消息等辅助调用尤其如此）。
 *
 * @param usage streamText 的 result.usage（PromiseLike）或 generateText 的
 *              已结算 usage（await 兼容两者）
 * @param bank  入账回调（持久层 addTaskUsage 或其经 TaskManager 的门面）
 * @param scope 计入主任务列还是子代理列（与主任务分账，ADR 0029）
 */
export async function settleTaskUsage(
  usage: LanguageModelUsage | PromiseLike<LanguageModelUsage>,
  bank: (delta: TaskUsageDelta) => void,
  scope: "main" | "subagent"
): Promise<void> {
  try {
    const { inputTokens, outputTokens } = await usage;
    bank(
      scope === "main"
        ? {
            mainInputTokens: inputTokens ?? 0,
            mainOutputTokens: outputTokens ?? 0,
          }
        : {
            subagentInputTokens: inputTokens ?? 0,
            subagentOutputTokens: outputTokens ?? 0,
          }
    );
  } catch {
    // usage 未结算（中断/失败的调用）或入账写入失败：不入账，不影响生成
  }
}
