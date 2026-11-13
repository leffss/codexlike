import { APICallError, RetryError } from "ai";

/** 把模型请求错误转成用户可读的中文提示（保留原始报错原文）；主会话与子代理共用 */
export function describeModelError(error: unknown): string {
  if (error instanceof APICallError) {
    const where =
      error.statusCode === undefined ? "网络错误" : `HTTP ${error.statusCode}`;
    return `模型请求失败（${where}）：${error.message}`;
  }
  if (error instanceof RetryError) {
    return `模型请求失败（已重试 ${error.errors.length} 次）：${describeModelError(error.lastError)}`;
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
