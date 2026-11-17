import { APICallError, RetryError } from "ai";

import { DEFAULT_MODEL_MAX_RETRIES } from "./execution-settings";

/**
 * 把模型请求错误转成用户可读的中文提示（保留原始报错原文）；主任务与子代理共用。
 * maxRetries 为本次执行的模型请求重试次数配置值（GLOSSARY「执行设置」，ADR 0024）：
 * RetryError 耗尽文案中的重试次数来自它（重试耗尽时实际重试次数恰为配置值）；
 * 配置为 0 时不再声称「已重试」（未传回退默认 2，与设置层默认一致）。
 */
export function describeModelError(
  error: unknown,
  maxRetries: number = DEFAULT_MODEL_MAX_RETRIES
): string {
  if (error instanceof APICallError) {
    const where =
      error.statusCode === undefined ? "网络错误" : `HTTP ${error.statusCode}`;
    return `模型请求失败（${where}）：${error.message}`;
  }
  if (error instanceof RetryError) {
    if (maxRetries <= 0) {
      return `模型请求失败：${describeModelError(error.lastError)}`;
    }
    return `模型请求失败（已重试 ${maxRetries} 次）：${describeModelError(error.lastError)}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `模型请求失败：${message}`;
}

/** 判定错误是否为中断（signal 已 abort 或 AbortError） */
export function isAbortLike(
  error: unknown,
  signal: AbortSignal | undefined
): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError")
  );
}
